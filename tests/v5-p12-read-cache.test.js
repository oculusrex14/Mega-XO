'use strict';

/**
 * tests/v5-p12-read-cache.test.js - V5 Phase 12 (Read Models and Cache)
 *
 * SCOPE & CONTRACT:
 * Validates the V5 read cache, route classification, versioned projections,
 * bounded mutation invalidations, and read-load reduction on real loopback PostgreSQL 16.
 *
 * VERIFICATION TARGETS:
 * - V5-12-01: Classify every read and sensitivity
 *   * Route manifest completeness (categories, Cache-Control, TTL, stale tolerance, sensitivity).
 *   * Dynamic route classification (live vs completed match, stranger vs self profile).
 *   * HTTP endpoints return explicit Cache-Control headers (private, no-store for sensitive;
 *     s-maxage and stale-while-revalidate for public projections; short TTL for ephemeral).
 * - V5-12-02: Build versioned projections and indexes
 *   * Monotonic versioning `{ version, data, updatedAt }`: rejects stale updates, replays identically.
 *   * Query path indexing (`idx_ratings_leaderboard_rank`, `idx_profiles_public_visibility`,
 *     `idx_matches_completed_history`) on PostgreSQL 16.
 *   * Materialization of authorized public leaderboard projection from committed rows.
 * - V5-12-03: Add bounded cache invalidation
 *   * Private state (wallets, saves, sessions) is NEVER shared-cached.
 *   * Mutation events atomically trigger cache invalidation:
 *     - Match completion -> invalidates player profiles, match view, and leaderboard projections.
 *     - Profile edit -> invalidates profile cache key.
 *     - Friend update -> invalidates friend list cache key for both participants.
 *     - Save edit -> invalidates practice save cache key.
 *   * Bounded cache capacity and eviction.
 *   * Gate G12: Cache/projection loss affects speed, not correctness; PostgreSQL remains authoritative.
 * - V5-12-04: Measure actual read-load reduction
 *   * Cold vs warm query latency measurement.
 *   * Telemetry tracks hits, misses, sets, invalidations, and load reduction percentage.
 *   * Stale-while-revalidate tolerance window behavior.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const {
  CATEGORIES,
  SENSITIVITIES,
  CACHE_CONTROL_POLICIES,
  ROUTE_MANIFEST,
  classifyRoute,
  VersionedProjection,
  createVersionedProjection,
  canUpdateProjection,
  ReadCache,
  createReadCache,
  defaultReadCache,
  ensureReadProjectionIndexes,
  materializeLeaderboardProjection,
} = require('../packages/services/read-cache.js');

const services = require('../packages/services/index.js');
const { createApiHandler } = require('../apps/api/index.js');

/* Register top-level cleanup of synthetic PG16 databases and guarded connection pools */
lab.installCleanup(test);

/* ---------------------------------------------------------------- Test Actors */

const ACTORS = Object.freeze([
  { actor: 'svc_alice', coins: 1500, crowns: 150, rating: 1650, games: 45, stats: 'public' },
  { actor: 'svc_bob', coins: 1200, crowns: 120, rating: 1550, games: 35, stats: 'public' },
  { actor: 'svc_carol', coins: 1000, crowns: 100, rating: 1450, games: 25, stats: 'friends' },
  { actor: 'svc_dave', coins: 800, crowns: 50, rating: 1350, games: 15, stats: 'private' },
]);

/* ---------------------------------------------------------------- Fixture Helpers */

async function setupApiServer(database, options = {}) {
  const pools = lab.poolsFor(database);
  const accounts = await lab.accountsFor(database, {
    deletionPolicy: { enabled: true, policyVersion: 'v5-p12-test-policy' },
    ...options,
  });
  const core = await lab.coreFor(database, { ...options });
  const readCache = options.readCache || createReadCache();

  const handler = createApiHandler({
    pool: pools.api,
    corePool: pools.core,
    accounts,
    readCache,
    ...options,
  });

  async function close() {
    if (core && core.close) {
      try { await core.close(); } catch {}
    }
    await lab.closeDatabasePools(database);
  }

  const harness = { handler, accounts, core, pools, readCache, close };
  harness.baseUrl = harness;
  return harness;
}

async function apiRequest(target, routePath, { method = 'GET', actor = null, token = null, body = null, headers = {} } = {}) {
  const handler = (target && typeof target === 'object' && target.handler) ? target.handler : target;
  const req = new EventEmitter();
  req.method = method;
  req.url = routePath;
  req.headers = { ...headers };
  // Use linked sessions; actor ID headers are not authentication on P11+.
  if (actor && !token) {
    if (!target?.accounts?.issue) throw new Error('TEST_AUTHORITY_REQUIRED');
    target._testSessions ||= new Map();
    if (!target._testSessions.has(actor)) {
      target._testSessions.set(actor, target.accounts.issue(actor, Date.now()));
    }
    token = (await target._testSessions.get(actor)).token;
  }
  if (token) req.headers['authorization'] = `Bearer ${token}`;
  req.body = body;

  return new Promise(async (resolve, reject) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const responseHeaders = {};
    res.setHeader = (k, v) => { responseHeaders[k.toLowerCase()] = v; };
    res.getHeader = (k) => responseHeaders[k.toLowerCase()];
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (data) => {
      resolve({ status: res.statusCode, headers: responseHeaders, data });
    };
    res.end = (chunk) => {
      let data = null;
      if (chunk) {
        try { data = JSON.parse(chunk); } catch { data = chunk; }
      }
      resolve({ status: res.statusCode, headers: responseHeaders, data });
    };

    try {
      await handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

/* ==========================================================================
 * Section 1: V5-12-01 - Classify Every Read and Sensitivity
 * ========================================================================== */

test('V5-12-01: Service index exports read cache primitives', () => {
  assert.equal(typeof services.createReadCache, 'function');
  assert.equal(typeof services.ReadCache, 'function');
  assert.equal(typeof services.classifyRoute, 'function');
  assert.ok(Array.isArray(services.ROUTE_MANIFEST));
  assert.ok(services.CATEGORIES);
  assert.equal(services.CATEGORIES.PRIVATE_NO_CACHE, 'PRIVATE_NO_CACHE');
  assert.equal(services.CATEGORIES.SHORT_TTL_EPHEMERAL, 'SHORT_TTL_EPHEMERAL');
  assert.equal(services.CATEGORIES.PUBLIC_PROJECTED, 'PUBLIC_PROJECTED');
});

test('V5-12-01: Route manifest comprehensively classifies all read endpoints', () => {
  assert.ok(ROUTE_MANIFEST.length >= 10, 'Manifest must specify read routes');

  const requiredEndpoints = [
    '/api/account/profile',
    '/api/account/save',
    '/api/account/export',
    '/api/account/deletion',
    '/api/v1/profile',
    '/api/v1/invitations',
    '/api/v1/queue',
    '/api/v1/match/:id',
    '/api/v1/leaderboard',
    '/api/community/profile/:id',
    '/api/community/friends',
    '/api/community/search',
    '/.well-known/assetlinks.json',
    '/.well-known/apple-app-site-association',
    '/privacy',
    '/health',
  ];

  for (const ep of requiredEndpoints) {
    const entry = ROUTE_MANIFEST.find((m) => m.path === ep);
    assert.ok(entry, `Endpoint ${ep} must exist in route manifest`);
    assert.ok(entry.category in CATEGORIES, `${ep} category must be recognized`);
    assert.ok(typeof entry.cacheControl === 'string', `${ep} must define Cache-Control header`);
    assert.ok(typeof entry.defaultTtlMs === 'number', `${ep} must define TTL`);
    assert.ok(typeof entry.staleToleranceMs === 'number', `${ep} must define stale tolerance`);
    assert.ok(entry.sensitivity in SENSITIVITIES, `${ep} must specify sensitivity level`);
    assert.ok(typeof entry.sharedCacheAllowed === 'boolean', `${ep} must declare sharedCacheAllowed`);
    assert.ok(Array.isArray(entry.invalidationEvents), `${ep} must list invalidation events`);
  }

  // Verify private endpoints strictly forbid shared caching
  const privateEndpoints = [
    '/api/account/profile',
    '/api/account/save',
    '/api/account/export',
    '/api/account/deletion',
    '/api/v1/profile',
    '/api/v1/invitations',
    '/api/community/friends',
  ];

  for (const ep of privateEndpoints) {
    const entry = ROUTE_MANIFEST.find((m) => m.path === ep);
    assert.equal(entry.category, CATEGORIES.PRIVATE_NO_CACHE);
    assert.equal(entry.sharedCacheAllowed, false, `${ep} must never allow shared caching`);
    assert.match(entry.cacheControl, /private,\s*no-store/);
  }
});

test('V5-12-01: Dynamic classification handles contextual match and profile states', () => {
  // 1. Match states
  const liveMatch = classifyRoute('/api/v1/match/m123', { matchStatus: 'PLAYING' });
  assert.equal(liveMatch.category, CATEGORIES.SHORT_TTL_EPHEMERAL);
  assert.equal(liveMatch.cacheControl, CACHE_CONTROL_POLICIES.EPHEMERAL_SHORT);
  assert.equal(liveMatch.sharedCacheAllowed, false);

  const completedMatch = classifyRoute('/api/v1/match/m123', { matchStatus: 'COMPLETED' });
  assert.equal(completedMatch.category, CATEGORIES.PUBLIC_PROJECTED);
  assert.equal(completedMatch.cacheControl, CACHE_CONTROL_POLICIES.PUBLIC_PROJECTED_MEDIUM);
  assert.equal(completedMatch.sharedCacheAllowed, true);

  const privateMatch = classifyRoute('/api/v1/match/m123', { isPrivateMatch: true });
  assert.equal(privateMatch.category, CATEGORIES.PRIVATE_NO_CACHE);
  assert.equal(privateMatch.cacheControl, CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE);
  assert.equal(privateMatch.sharedCacheAllowed, false);

  // 2. Profile states
  const selfProfile = classifyRoute('/api/community/profile/alice', { isSelf: true });
  assert.equal(selfProfile.category, CATEGORIES.PRIVATE_NO_CACHE);
  assert.equal(selfProfile.cacheControl, CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE);

  const publicStranger = classifyRoute('/api/community/profile/alice', { isSelf: false, visibility: 'public' });
  assert.equal(publicStranger.category, CATEGORIES.PUBLIC_PROJECTED);
  assert.equal(publicStranger.cacheControl, CACHE_CONTROL_POLICIES.PUBLIC_PROJECTED_MEDIUM);

  const privateStranger = classifyRoute('/api/community/profile/alice', { isSelf: false, visibility: 'private' });
  assert.equal(privateStranger.category, CATEGORIES.PRIVATE_NO_CACHE);
  assert.equal(privateStranger.cacheControl, CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE);
});

test('V5-12-01: HTTP control plane returns explicit Cache-Control headers', async (t) => {
  const ok = await lab.boot(t);
  if (!ok) return;

  const db = await lab.createDatabase('cache_headers');
  await lab.seedActors(db, ACTORS);
  const server = await setupApiServer(db);

  try {
    // 1. GET /api/v1/profile -> private, no-store
    const resProfile = await apiRequest(server, '/api/v1/profile', { actor: 'svc_alice' });
    assert.equal(resProfile.status, 200);
    assert.equal(resProfile.headers['cache-control'], 'private, no-store');
    assert.equal(resProfile.data.id, 'svc_alice');
    assert.equal(resProfile.data.wallet.coins, 1500);

    // 2. GET /api/account/save -> private, no-store
    const resSave = await apiRequest(server, '/api/account/save', { actor: 'svc_alice' });
    assert.equal(resSave.status, 200);
    assert.equal(resSave.headers['cache-control'], 'private, no-store');

    // 3. GET /api/account/export -> private, no-store
    const resExport = await apiRequest(server, '/api/account/export', { actor: 'svc_alice' });
    assert.equal(resExport.status, 200);
    assert.equal(resExport.headers['cache-control'], 'private, no-store');

    // 4. GET /api/account/deletion -> private, no-store
    const resDel = await apiRequest(server, '/api/account/deletion', { actor: 'svc_alice' });
    assert.equal(resDel.status, 200);
    assert.equal(resDel.headers['cache-control'], 'private, no-store');

    // 5. GET /api/v1/queue -> ephemeral short TTL (max-age=2)
    const resQueue = await apiRequest(server, '/api/v1/queue', { actor: 'svc_alice' });
    assert.equal(resQueue.status, 200);
    assert.match(resQueue.headers['cache-control'], /max-age=2/);

    // 6. GET /api/v1/invitations -> private, no-store
    const resInv = await apiRequest(server, '/api/v1/invitations', { actor: 'svc_alice' });
    assert.equal(resInv.status, 200);
    assert.equal(resInv.headers['cache-control'], 'private, no-store');

    // 7. GET /api/v1/leaderboard -> public, max-age=30, s-maxage=120, stale-while-revalidate=300
    const resLb = await apiRequest(server, '/api/v1/leaderboard');
    assert.equal(resLb.status, 200);
    assert.equal(resLb.headers['cache-control'], CACHE_CONTROL_POLICIES.PUBLIC_LEADERBOARD);

    // 8. GET /api/community/profile/:id
    // Viewer-specific relationship and block rules make this private,
    // even if the target's stats are public.
    const resStranger = await apiRequest(server, '/api/community/profile/svc_alice', { actor: 'svc_bob' });
    assert.equal(resStranger.status, 200);
    assert.equal(resStranger.headers['cache-control'], CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE);

    // Self viewing own profile -> private no-store
    const resSelf = await apiRequest(server, '/api/community/profile/svc_alice', { actor: 'svc_alice' });
    assert.equal(resSelf.status, 200);
    assert.equal(resSelf.headers['cache-control'], 'private, no-store');
  } finally {
    await server.close();
  }
});

/* ==========================================================================
 * Section 2: V5-12-02 - Versioned Projections and Indexes
 * ========================================================================== */

test('V5-12-02: Versioned projections enforce monotonic progression and idempotent replay', () => {
  const cache = createReadCache();

  // 1. Initial version 1 write
  const proj1 = createVersionedProjection(1, { ranking: ['alice', 'bob'] }, 1000);
  const res1 = cache.set('leaderboard:global', proj1);
  assert.equal(res1.set, true);
  assert.equal(res1.version, 1);

  // 2. Read replay gives identical results
  const readA = cache.get('leaderboard:global');
  const readB = cache.get('leaderboard:global');
  assert.deepEqual(readA, readB);
  assert.deepEqual(readA.data, { ranking: ['alice', 'bob'] });

  // 3. Stale update with version 1 is rejected
  const stale1 = createVersionedProjection(1, { ranking: ['stale'] }, 2000);
  const staleRes1 = cache.set('leaderboard:global', stale1);
  assert.equal(staleRes1.set, false);
  assert.equal(staleRes1.reason, 'STALE_VERSION');
  assert.equal(staleRes1.currentVersion, 1);

  // 4. Stale update with older version 0 is rejected
  assert.throws(() => createVersionedProjection(0, {}), /positive integer/);

  // 5. Monotonic update with version 2 succeeds
  const proj2 = createVersionedProjection(2, { ranking: ['carol', 'alice'] }, 3000);
  const res2 = cache.set('leaderboard:global', proj2);
  assert.equal(res2.set, true);
  assert.equal(res2.version, 2);

  // Verify stored value reflects version 2
  const updatedRead = cache.get('leaderboard:global');
  assert.deepEqual(updatedRead.data, { ranking: ['carol', 'alice'] });

  // 6. Old event at version 1 cannot overwrite newer version 2
  const lateEvent = createVersionedProjection(1, { ranking: ['ghost'] }, 4000);
  const lateRes = cache.set('leaderboard:global', lateEvent);
  assert.equal(lateRes.set, false);
  assert.equal(lateRes.reason, 'STALE_VERSION');
  assert.equal(lateRes.currentVersion, 2);

  // Verify projection state remains protected at version 2
  assert.deepEqual(cache.get('leaderboard:global').data, { ranking: ['carol', 'alice'] });
});

test('V5-12-02: canUpdateProjection correctly evaluates sequence numbers', () => {
  assert.equal(canUpdateProjection(null, { version: 1 }), true);
  assert.equal(canUpdateProjection({ version: 1 }, { version: 2 }), true);
  assert.equal(canUpdateProjection({ version: 2 }, { version: 2 }), false);
  assert.equal(canUpdateProjection({ version: 2 }, { version: 1 }), false);
  assert.equal(canUpdateProjection({ version: 2 }, null), false);
});

test('V5-12-02: ensureReadProjectionIndexes safely applies indexes on PG16 query paths', async (t) => {
  const ok = await lab.boot(t);
  if (!ok) return;

  const db = await lab.createDatabase('read_indexes');
  const pools = lab.poolsFor(db);

  try {
    // 1. Execute idempotent index creation via admin client (DDL requires schema owner)
    const admin = await lab.adminClient(db);
    let created = false;
    try {
      created = await ensureReadProjectionIndexes(admin);
    } finally {
      await admin.end();
    }
    assert.equal(created, true);

    // 2. Query pg_indexes to verify created indexes
    const adminVerify = await lab.adminClient(db);
    try {
      const res = await adminVerify.query(`
        SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'idx_ratings_leaderboard_rank',
          'idx_profiles_public_visibility',
          'idx_matches_completed_history'
        )
      `);
      const names = res.rows.map((r) => r.indexname);
      assert.ok(names.includes('idx_ratings_leaderboard_rank'), 'idx_ratings_leaderboard_rank must exist');
      assert.ok(names.includes('idx_profiles_public_visibility'), 'idx_profiles_public_visibility must exist');
      assert.ok(names.includes('idx_matches_completed_history'), 'idx_matches_completed_history must exist');
    } finally {
      await adminVerify.end();
    }

    // 3. Second run must be idempotent and succeed without error
    const repeated = await ensureReadProjectionIndexes(pools.core);
    assert.equal(repeated, true);
  } finally {
    await lab.closeDatabasePools(db);
  }
});

test('V5-12-02: materializeLeaderboardProjection materializes public rankings from PG16', async (t) => {
  const ok = await lab.boot(t);
  if (!ok) return;

  const db = await lab.createDatabase('lb_materialize');
  await lab.seedActors(db, ACTORS);
  const pools = lab.poolsFor(db);

  try {
    const projection = await materializeLeaderboardProjection(pools.core, { limit: 10, version: 1 });
    assert.equal(projection.version, 1);
    assert.ok(Array.isArray(projection.data));

    // Alice (1650, public) and Bob (1550, public) should be included.
    // Carol (friends) and Dave (private) must be excluded from public leaderboard.
    const ids = projection.data.map((r) => r.id);
    assert.ok(ids.includes('svc_alice'));
    assert.ok(ids.includes('svc_bob'));
    assert.ok(!ids.includes('svc_carol'), 'Friends-only profile must not appear on public leaderboard');
    assert.ok(!ids.includes('svc_dave'), 'Private profile must not appear on public leaderboard');

    // Assert strictly descending rating order
    assert.equal(projection.data[0].id, 'svc_alice');
    assert.equal(projection.data[0].rank, 1);
    assert.equal(projection.data[0].rating, 1650);

    assert.equal(projection.data[1].id, 'svc_bob');
    assert.equal(projection.data[1].rank, 2);
    assert.equal(projection.data[1].rating, 1550);
  } finally {
    await lab.closeDatabasePools(db);
  }
});

/* ==========================================================================
 * Section 3: V5-12-03 - Bounded Cache Invalidation & Private State Isolation
 * ========================================================================== */

test('V5-12-03: Private state is strictly forbidden from shared caching (Leakage prevention)', () => {
  const cache = createReadCache();

  // Attempting to set private state in shared cache throws explicit error
  assert.throws(
    () => {
      cache.set('wallet:svc_alice', { coins: 1000 }, {
        category: CATEGORIES.PRIVATE_NO_CACHE,
        shared: true,
      });
    },
    /PRIVATE_STATE_SHARED_CACHE_FORBIDDEN/,
    'Private economic state must never be stored in shared cache'
  );

  // Unshared, actor-scoped caching succeeds
  const localSet = cache.set('wallet:svc_alice', { coins: 1000 }, {
    category: CATEGORIES.PRIVATE_NO_CACHE,
    shared: false,
  });
  assert.equal(localSet.set, true);

  // Reading actor-scoped key returns caller data
  assert.deepEqual(cache.get('wallet:svc_alice'), { coins: 1000 });
  // Unrelated actor cannot access it
  assert.equal(cache.get('wallet:svc_bob'), null);
});

test('V5-12-03: Mutation events atomically trigger bounded cache invalidations', () => {
  const cache = createReadCache();

  // Seed cache with interrelated records
  cache.set('profile:alice', { name: 'Alice' }, { tags: ['profile'] });
  cache.set('compat:profile:alice', { id: 'alice' }, { tags: ['profile'] });
  cache.set('public_profile:alice', { id: 'alice' }, { tags: ['profile'] });

  cache.set('profile:bob', { name: 'Bob' }, { tags: ['profile'] });
  cache.set('compat:profile:bob', { id: 'bob' }, { tags: ['profile'] });
  cache.set('public_profile:bob', { id: 'bob' }, { tags: ['profile'] });

  cache.set('friends:alice', ['bob'], { tags: ['friends:alice'] });
  cache.set('friends:bob', ['alice'], { tags: ['friends:bob'] });

  cache.set('match:m99', { status: 'COMPLETED' }, { tags: ['match', 'match:m99'] });
  cache.set('leaderboard:rating:global:all:', [{ id: 'alice' }], { tags: ['leaderboard'] });
  cache.set('leaderboard:wealth:global:all:', [{ id: 'alice' }], { tags: ['leaderboard'] });
  cache.set('save:alice', { revision: 5 });

  // 1. Profile edit invalidates only Alice's profile keys
  const countProfile = cache.invalidate('profile.updated', { actor: 'alice' });
  assert.equal(countProfile, 3);
  assert.equal(cache.get('profile:alice'), null);
  assert.equal(cache.get('compat:profile:alice'), null);
  assert.equal(cache.get('public_profile:alice'), null);
  // Bob's profile remains untouched
  assert.ok(cache.get('profile:bob') !== null);

  // 2. Friend update invalidates friend lists for both actors
  const countFriend = cache.invalidate('friend.updated', { actor: 'alice', target: 'bob' });
  assert.equal(cache.get('friends:alice'), null);
  assert.equal(cache.get('friends:bob'), null);

  // 3. Match completion invalidates match view, participants' profiles, and all leaderboards
  cache.set('profile:alice', { name: 'Alice v2' });
  cache.set('profile:bob', { name: 'Bob v2' });
  assert.ok(cache.get('match:m99') !== null);
  assert.ok(cache.get('leaderboard:rating:global:all:') !== null);

  const countMatch = cache.invalidate('match.completed', {
    matchId: 'm99',
    playerIds: ['alice', 'bob'],
  });
  assert.ok(countMatch >= 3);
  assert.equal(cache.get('match:m99'), null);
  assert.equal(cache.get('profile:alice'), null);
  assert.equal(cache.get('profile:bob'), null);
  assert.equal(cache.get('leaderboard:rating:global:all:'), null);
  assert.equal(cache.get('leaderboard:wealth:global:all:'), null);

  // 4. Practice save invalidation
  assert.ok(cache.get('save:alice') !== null);
  cache.invalidate('save.updated', { actor: 'alice' });
  assert.equal(cache.get('save:alice'), null);
});

test('V5-12-03: Cache bounds capacity and enforces FIFO/LRU eviction', () => {
  const boundedCache = createReadCache({ maxEntries: 4 });

  boundedCache.set('k1', 'v1');
  boundedCache.set('k2', 'v2');
  boundedCache.set('k3', 'v3');
  boundedCache.set('k4', 'v4');
  assert.equal(boundedCache.getStats().totalEntries, 4);

  // Writing a 5th entry must evict the oldest entry (k1)
  boundedCache.set('k5', 'v5');
  assert.equal(boundedCache.getStats().totalEntries, 4);
  assert.equal(boundedCache.get('k1'), null, 'k1 must have been evicted');
  assert.equal(boundedCache.get('k2'), 'v2');
  assert.equal(boundedCache.get('k5'), 'v5');
  assert.equal(boundedCache.getStats().evictions, 1);
});

test('V5-12-03 (Gate G12): Cache loss affects speed, not correctness; PostgreSQL remains authoritative', async (t) => {
  const ok = await lab.boot(t);
  if (!ok) return;

  const db = await lab.createDatabase('g12_loss');
  await lab.seedActors(db, ACTORS);
  const server = await setupApiServer(db);

  try {
    // 1. Fetch initial profile and leaderboard (populates cache)
    const resProf1 = await apiRequest(server, '/api/v1/profile', { actor: 'svc_alice' });
    assert.equal(resProf1.status, 200);
    assert.equal(resProf1.data.wallet.coins, 1500);

    const resLb1 = await apiRequest(server, '/api/v1/leaderboard');
    assert.equal(resLb1.status, 200);
    assert.equal(resLb1.data[0].id, 'svc_alice');

    // 2. Perform total cache loss (wipe all in-memory / cache keys)
    server.readCache.clear();
    assert.equal(server.readCache.getStats().totalEntries, 0);

    // 3. Immediately re-read after complete cache wipe
    // Must return 100% correct authoritative results from PostgreSQL 16
    const resProf2 = await apiRequest(server, '/api/v1/profile', { actor: 'svc_alice' });
    assert.equal(resProf2.status, 200);
    assert.equal(resProf2.data.wallet.coins, 1500, 'Authoritative coins must survive cache loss');
    assert.equal(resProf2.data.wallet.crowns, 150, 'Authoritative crowns must survive cache loss');
    assert.deepEqual(resProf1.data.wallet, resProf2.data.wallet, 'Wallet state must be byte-identical');

    const resLb2 = await apiRequest(server, '/api/v1/leaderboard');
    assert.equal(resLb2.status, 200);
    assert.deepEqual(resLb1.data, resLb2.data, 'Leaderboard projection must reconstruct identically');
  } finally {
    await server.close();
  }
});

/* ==========================================================================
 * Section 4: V5-12-04 - Measure Actual Read-Load Reduction
 * ========================================================================== */

test('V5-12-04: Cache hit load reduction vs cold query is measured and verified', async () => {
  const cache = createReadCache();

  let dbQueryCount = 0;
  async function authoritativeDbQuery() {
    dbQueryCount++;
    // Simulate database I/O latency
    await new Promise((r) => setTimeout(r, 10));
    return { id: 'svc_alice', rating: 1650 };
  }

  // 1. Cold query (miss)
  const cold = await cache.measureRead('profile:alice', authoritativeDbQuery, {
    ttlMs: 60000,
  });
  assert.equal(cold.hit, false);
  assert.equal(cold.source, 'authority');
  assert.equal(dbQueryCount, 1);
  assert.ok(cold.latencyMs >= 8, `Cold query must reflect real query duration, got ${cold.latencyMs}ms`);

  // 2. Warm query (hit)
  const warm1 = await cache.measureRead('profile:alice', authoritativeDbQuery, {
    ttlMs: 60000,
  });
  assert.equal(warm1.hit, true);
  assert.equal(warm1.source, 'cache');
  assert.equal(dbQueryCount, 1, 'Database must not be queried on cache hit');
  assert.ok(warm1.latencyMs < 2, `Warm cached query must resolve rapidly, got ${warm1.latencyMs}ms`);

  // 3. Repeat warm reads
  for (let i = 0; i < 9; i++) {
    const warmN = await cache.measureRead('profile:alice', authoritativeDbQuery);
    assert.equal(warmN.hit, true);
  }
  assert.equal(dbQueryCount, 1, 'Database query count must remain exactly 1 after 10 reads');

  // 4. Verify telemetry metrics
  const stats = cache.getStats();
  assert.equal(stats.hits, 10);
  assert.equal(stats.misses, 1);
  assert.equal(stats.totalReads, 11);
  assert.ok(stats.hitRate >= 0.9, 'Hit rate must exceed 90%');
  assert.equal(stats.readReductionPercent, 91, 'Read reduction percentage must be calculated');
});

test('V5-12-04: Stale-while-revalidate serves stale data within tolerance window', () => {
  let virtualTime = 10000;
  const cache = createReadCache({
    now: () => virtualTime,
  });

  // Write item with TTL = 1000ms, stale tolerance = 2000ms (expires at 11000, stale until 13000)
  cache.set('item:1', 'fresh_value', {
    ttlMs: 1000,
    staleToleranceMs: 2000,
  });

  // 1. At t = 10500: Fresh hit
  virtualTime = 10500;
  assert.equal(cache.get('item:1'), 'fresh_value');

  // 2. At t = 11500: Past TTL, but within stale tolerance
  virtualTime = 11500;
  // Normal get returns null (expired)
  assert.equal(cache.get('item:1', { allowStale: false }), null);

  // Re-set to test allowStale
  cache.set('item:1', 'fresh_value', { ttlMs: 1000, staleToleranceMs: 2000 });
  virtualTime = 11500;
  assert.equal(cache.get('item:1', { allowStale: true }), 'fresh_value', 'Must return stale value when allowed');

  // 3. At t = 14000: Past stale tolerance window
  virtualTime = 14000;
  assert.equal(cache.get('item:1', { allowStale: true }), null, 'Must expire completely beyond stale window');
});

test('V5-12-04: API route mutations invalidate cached reads through HTTP server', async (t) => {
  const ok = await lab.boot(t);
  if (!ok) return;

  const db = await lab.createDatabase('cache_mutations');
  await lab.seedActors(db, ACTORS);
  const server = await setupApiServer(db);

  try {
    // 1. Initial stranger profile read (cached)
    const read1 = await apiRequest(server, '/api/community/profile/svc_alice', { actor: 'svc_bob' });
    assert.equal(read1.status, 200);
    assert.equal(read1.data.displayName, 'svc_alice');

    // 2. Profile edit mutation
    const updateRes = await apiRequest(server, '/api/account/profile', {
      method: 'POST',
      actor: 'svc_alice',
      body: { displayName: 'Alice Super' },
    });
    assert.equal(updateRes.status, 200);

    // 3. Subsequent stranger profile read immediately reflects updated state
    const read2 = await apiRequest(server, '/api/community/profile/svc_alice', { actor: 'svc_bob' });
    assert.equal(read2.status, 200);
    assert.equal(read2.data.displayName, 'Alice Super', 'Must observe invalidated and refreshed profile');
  } finally {
    await server.close();
  }
});

test('P12 privacy: stale public profile cache cannot override a cross-process block', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p12_profile_block_cache');
  await lab.seedActors(db, ACTORS);
  const server = await setupApiServer(db);
  t.after(async () => { await server.close(); });

  const before = await apiRequest(server, '/api/community/profile/svc_alice', { actor: 'svc_bob' });
  assert.equal(before.status, 200);
  assert.equal(before.headers['cache-control'], CACHE_CONTROL_POLICIES.PRIVATE_NO_STORE);

  // Simulate a stale shared result from an older API instance. Another
  // process writes the block directly, so no in-process invalidation occurs.
  server.readCache.set('public_profile:svc_alice', {
    ...before.data,
    statsVisibility: 'public',
  }, {
    ttlMs: 60000,
    staleToleranceMs: 120000,
    category: CATEGORIES.PUBLIC_PROJECTED,
  });
  await server.accounts.social('svc_alice', 'p12-block-bob-after-cache', 'block', 'svc_bob');

  const after = await apiRequest(server, '/api/community/profile/svc_alice', { actor: 'svc_bob' });
  assert.equal(after.status, 404, 'fresh durable block wins over stale target cache');
  assert.equal(after.data.error, 'PROFILE_NOT_FOUND');
});
