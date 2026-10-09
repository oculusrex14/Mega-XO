'use strict';
/* tests/v5-p11-account-social.test.js - V5 Phase 11 Task V5-11-02.
 *
 * SCOPE & CONTRACT:
 * Validates the V5 API control plane account and social endpoints
 * (`apps/api/routes/account.js`, `apps/api/routes/social.js`, `apps/api/index.js`)
 * on real loopback PostgreSQL 16 using the guarded `api_runtime` pool from `tests/v5-pg-lab.js`.
 *
 * VERIFICATION TARGETS:
 * 1. Profile view & edit:
 *    - GET /api/account/profile returns caller profile (tag, username, displayName, avatar, etc.).
 *    - POST /api/account/profile persists updates to PostgreSQL identity.profiles.
 *    - Updated profile state is immediately and consistently visible to Core and API.
 * 2. Practice cloud save:
 *    - GET /api/account/save returns cloud save state.
 *    - POST /api/account/save enforces monotonic CAS revisions in profile.profile_saves.
 *    - Survives round-trips and rejects stale revisions with 409 SAVE_CONFLICT.
 * 3. Privacy-aware visibility:
 *    - Self lookup: caller === target sees full profile and stats even if stats_visibility is private.
 *    - Public profile: stranger sees public stats.
 *    - Friends-only profile: non-friend sees hidden stats (stats === null); accepted friend sees full stats.
 *    - Private profile: non-friend sees hidden stats (stats === null).
 *    - Blocked player: lookup returns 404 / PROFILE_NOT_FOUND.
 * 4. Friend graph & relationships:
 *    - POST /api/community/friend (action: 'request') creates entry in social.friend_requests.
 *    - POST /api/community/friend (action: 'accept') forms friendship in social.friendships and clears request.
 *    - GET /api/community/friends lists accepted friends symmetrically.
 *    - GET /api/community/search searches by exact MEGA-* tag or username prefix (min 3 chars).
 *    - POST /api/community/friend (action: 'remove') cleans up friendship.
 * 5. Cross-service consistency & database grant boundaries:
 *    - Core service and API observe identical database rows for profiles and friends.
 *    - api_runtime role strictly enforces least privilege: direct writes to economy.wallets or
 *      economy.ledger are rejected with PostgreSQL 42501 permission denied.
 * 6. Account export, deletion status, deletion workflow, and unlink safety:
 *    - GET /api/account/export exports caller data.
 *    - GET /api/account/deletion returns deletion policy status.
 *    - POST /api/account/delete enforces tag confirmation check.
 *    - POST /api/account/unlink rejects removing the last authentication method (409 LAST_LOGIN_METHOD).
 * 7. Clean teardown with lab.installCleanup: no lingering handles or open sockets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const lab = require('./v5-pg-lab.js');
const { createApiHandler } = require('../apps/api/index.js');

/* Register top-level cleanup of synthetic PG16 databases and guarded connection pools */
lab.installCleanup(test);

/* ---------------------------------------------------------------- Test Actors */

const ACTORS = Object.freeze([
  { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
  { actor: 'svc_bob', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
  { actor: 'svc_carol', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'private' },
  { actor: 'svc_dave', coins: 800, crowns: 50, rating: 1400, games: 20, stats: 'public' },
]);

/* ---------------------------------------------------------------- Fixture Helpers */

async function setupApiServer(database, options = {}) {
  const pools = lab.poolsFor(database);
  const accounts = await lab.accountsFor(database, {
    deletionPolicy: { enabled: true, policyVersion: 'v5-p11-test-policy' },
    ...options,
  });
  const core = await lab.coreFor(database, { ...options });

  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    ...options,
  });

  async function close() {
    if (core && core.close) {
      try { await core.close(); } catch {}
    }
    await lab.closeDatabasePools(database);
  }

  const harness = { handler, accounts, core, pools, close };
  harness.baseUrl = harness;
  return harness;
}

function apiRequest(target, routePath, { method = 'GET', actor = null, token = null, body = null, headers = {} } = {}) {
  const handler = (target && typeof target === 'object' && target.handler) ? target.handler : target;
  const req = new EventEmitter();
  req.method = method;
  req.url = routePath;
  req.headers = { ...headers };
  if (actor) req.headers['x-actor-id'] = actor;
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
 * 1. Profile View & Edit (Persists to identity.profiles and visible to Core)
 * ========================================================================== */

test('1. Profile view & edit: updating profile through API persists to PostgreSQL and is visible to Core', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_profile');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiServer(db);
  t.after(async () => { await harness.close(); });

  // 1.1 GET /api/account/profile returns caller profile
  const initial = await apiRequest(harness.baseUrl, '/api/account/profile', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(initial.status, 200, 'GET /api/account/profile returns 200');
  assert.equal(initial.data.tag, lab.tagFor('svc_alice'), 'Tag matches canonical actor tag');
  assert.equal(initial.data.displayName, 'svc_alice', 'Display name initially matches seed');
  assert.equal(initial.data.statsVisibility, 'friends', 'Initial stats visibility matches seed');

  // 1.2 POST /api/account/profile updates display name, avatar, and statsVisibility
  const updateRes = await apiRequest(harness.baseUrl, '/api/account/profile', {
    method: 'POST',
    actor: 'svc_alice',
    body: {
      displayName: 'Alice In Wonderland',
      avatar: 'star',
      statsVisibility: 'public',
    },
  });
  assert.equal(updateRes.status, 200, 'POST /api/account/profile returns 200');
  assert.equal(updateRes.data.displayName, 'Alice In Wonderland', 'Updated display name returned in response');
  assert.equal(updateRes.data.avatar, 'star', 'Updated avatar returned in response');
  assert.equal(updateRes.data.statsVisibility, 'public', 'Updated stats visibility returned in response');

  // 1.3 Verify direct persistence in PostgreSQL identity.profiles
  const admin = await lab.adminClient(db);
  try {
    const row = (await admin.query(
      'SELECT display_name, avatar, stats_visibility FROM identity.profiles WHERE actor_id = $1',
      ['svc_alice']
    )).rows[0];
    assert.ok(row, 'Row exists in identity.profiles');
    assert.equal(row.display_name, 'Alice In Wonderland', 'display_name durably persisted in database');
    assert.equal(row.avatar, 'star', 'avatar durably persisted in database');
    assert.equal(row.stats_visibility, 'public', 'stats_visibility durably persisted in database');
  } finally {
    await admin.end();
  }

  // 1.4 Verify Core service sees identical updated profile state
  const coreView = await harness.core.read(async (tx) => {
    const res = await tx.query(
      'SELECT display_name, avatar, stats_visibility FROM identity.profiles WHERE actor_id = $1',
      ['svc_alice']
    );
    return res.rows[0];
  });
  assert.ok(coreView, 'Core transaction reads profile row');
  assert.equal(coreView.display_name, 'Alice In Wonderland', 'Core sees identical display_name');
  assert.equal(coreView.avatar, 'star', 'Core sees identical avatar');
  assert.equal(coreView.stats_visibility, 'public', 'Core sees identical stats_visibility');

  // 1.5 Subsequent GET /api/account/profile returns updated fields
  const refetched = await apiRequest(harness.baseUrl, '/api/account/profile', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(refetched.status, 200);
  assert.equal(refetched.data.displayName, 'Alice In Wonderland');
  assert.equal(refetched.data.avatar, 'star');
  assert.equal(refetched.data.statsVisibility, 'public');
});

/* ==========================================================================
 * 2. Practice Cloud Save (profile.profile_saves CAS & Monotonicity)
 * ========================================================================== */

test('2. Practice cloud save: monotonic save revisions through API persist to profile.profile_saves and survive round-trips', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_saves');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiServer(db);
  t.after(async () => { await harness.close(); });

  // 2.1 Initial GET /api/account/save returns revision 0 and null practice
  const initial = await apiRequest(harness.baseUrl, '/api/account/save', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(initial.status, 200, 'GET /api/account/save returns 200');
  assert.equal(initial.data.revision, 0, 'Initial revision is 0');
  assert.equal(initial.data.practice, null, 'Initial practice is null');

  // 2.2 First save at expected revision 0
  const practiceRev1 = lab.practicePayload('svc_alice', { theme: 'midnight', coins: 150 });
  const save1 = await apiRequest(harness.baseUrl, '/api/account/save', {
    method: 'POST',
    actor: 'svc_alice',
    body: {
      revision: 0,
      practice: practiceRev1,
    },
  });
  assert.equal(save1.status, 200, 'POST /api/account/save at rev 0 succeeds');
  assert.equal(save1.data.revision, 1, 'Save advances revision monotonically to 1');

  // 2.3 Verify durability in PostgreSQL profile.profile_saves
  const admin = await lab.adminClient(db);
  try {
    const saveRow = (await admin.query(
      'SELECT revision, payload_text FROM profile.profile_saves WHERE actor_id = $1',
      ['svc_alice']
    )).rows[0];
    assert.ok(saveRow, 'profile_saves row exists in PostgreSQL');
    assert.equal(Number(saveRow.revision), 1, 'Persisted revision is 1');
    const parsed = JSON.parse(saveRow.payload_text);
    assert.equal(parsed.settings.theme, 'midnight', 'Saved practice settings theme matches payload');
    assert.equal(parsed.wallet.coins, 150, 'Saved practice wallet coins matches payload');
  } finally {
    await admin.end();
  }

  // 2.4 Round-trip GET /api/account/save retrieves saved payload
  const restored = await apiRequest(harness.baseUrl, '/api/account/save', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(restored.status, 200, 'GET /api/account/save round-trip returns 200');
  assert.equal(restored.data.revision, 1, 'Retrieved revision is 1');
  assert.ok(restored.data.practice, 'Retrieved practice is non-null');
  assert.equal(restored.data.practice.settings.theme, 'midnight', 'Retrieved theme matches saved state');

  // 2.5 Conflict: attempting save with stale revision 0 is rejected with 409 SAVE_CONFLICT
  const conflict = await apiRequest(harness.baseUrl, '/api/account/save', {
    method: 'POST',
    actor: 'svc_alice',
    body: {
      revision: 0,
      practice: lab.practicePayload('svc_alice', { theme: 'vector' }),
    },
  });
  assert.equal(conflict.status, 409, 'Stale revision CAS write returns 409');
  assert.equal(conflict.data.error, 'SAVE_CONFLICT', 'Error code is SAVE_CONFLICT');

  // 2.6 Advance to revision 2 with current revision 1
  const practiceRev2 = lab.practicePayload('svc_alice', { theme: 'paperclub', coins: 200 });
  const save2 = await apiRequest(harness.baseUrl, '/api/account/save', {
    method: 'POST',
    actor: 'svc_alice',
    body: {
      revision: 1,
      practice: practiceRev2,
    },
  });
  assert.equal(save2.status, 200, 'POST /api/account/save at rev 1 succeeds');
  assert.equal(save2.data.revision, 2, 'Revision advances monotonically to 2');

  // 2.7 Verify updated round-trip
  const restored2 = await apiRequest(harness.baseUrl, '/api/account/save', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(restored2.data.revision, 2);
  assert.equal(restored2.data.practice.settings.theme, 'paperclub');
});

/* ==========================================================================
 * 3. Privacy-Aware Visibility (Public vs Friends vs Private vs Blocked)
 * ========================================================================== */

test('3. Privacy-aware visibility: public vs friends vs private profiles hide/show stats appropriately', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_privacy');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiServer(db);
  t.after(async () => { await harness.close(); });

  // 3.1 Self lookup: caller === target sees full profile and stats even for a private profile
  const selfCarol = await apiRequest(harness.baseUrl, '/api/community/profile/svc_carol', {
    method: 'GET',
    actor: 'svc_carol',
  });
  assert.equal(selfCarol.status, 200, 'Self lookup returns 200');
  assert.equal(selfCarol.data.tag, lab.tagFor('svc_carol'));
  assert.ok(selfCarol.data.stats, 'Owner sees full stats for private profile');

  // 3.2 Public profile lookup: stranger (Alice) viewing public player (Dave)
  const publicDave = await apiRequest(harness.baseUrl, '/api/community/profile/svc_dave', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(publicDave.status, 200, 'Public profile lookup returns 200');
  assert.ok(publicDave.data.stats, 'Stranger sees stats on public profile');
  assert.ok(publicDave.data.stats.ranked, 'Ranked stats are visible on public profile');

  // 3.3 Friends-only profile lookup when NOT friends: Alice viewing Bob
  const nonFriendBob = await apiRequest(harness.baseUrl, '/api/community/profile/svc_bob', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(nonFriendBob.status, 200, 'Friends-only profile lookup returns 200');
  assert.equal(nonFriendBob.data.stats, null, 'Non-friend sees stats as null for friends-visibility profile');

  // 3.4 Private profile lookup when NOT friends: Alice viewing Carol
  const nonFriendCarol = await apiRequest(harness.baseUrl, '/api/community/profile/svc_carol', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(nonFriendCarol.status, 200, 'Private profile lookup returns 200');
  assert.equal(nonFriendCarol.data.stats, null, 'Non-friend sees stats as null for private profile');

  // 3.5 Befriend Alice and Bob, then Bob becomes friends-visible to Alice
  const reqRes = await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_alice',
    body: { action: 'request', target: 'svc_bob' },
  });
  assert.equal(reqRes.status, 200);

  const accRes = await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_bob',
    body: { action: 'accept', target: 'svc_alice' },
  });
  assert.equal(accRes.status, 200);

  // Now Alice views Bob again: stats are visible because relation is 'friend'
  const friendBob = await apiRequest(harness.baseUrl, '/api/community/profile/svc_bob', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(friendBob.status, 200);
  assert.ok(friendBob.data.stats, 'Accepted friend sees stats on friends-visibility profile');
  assert.equal(friendBob.data.relation, 'friend', 'Relation field indicates friend');

  // 3.6 Block: Carol blocks Alice -> Alice viewing Carol returns 404 / PROFILE_NOT_FOUND
  const blockRes = await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_carol',
    body: { action: 'block', target: 'svc_alice' },
  });
  assert.equal(blockRes.status, 200);

  const blockedCarol = await apiRequest(harness.baseUrl, '/api/community/profile/svc_carol', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(blockedCarol.status, 404, 'Blocked player lookup returns 404');
  assert.equal(blockedCarol.data.error, 'PROFILE_NOT_FOUND', 'Error is PROFILE_NOT_FOUND');
});

/* ==========================================================================
 * 4. Friend Graph & Relationships (social.friendships, requests, blocks)
 * ========================================================================== */

test('4. Friend graph: friend request, accept, search, and list friends work correctly in PostgreSQL social tables', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_social');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiServer(db);
  t.after(async () => { await harness.close(); });

  // 4.1 Friend Request: Alice sends request to Bob
  const req = await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_alice',
    body: { action: 'request', target: 'svc_bob' },
  });
  assert.equal(req.status, 200, 'POST /api/community/friend request returns 200');

  // Verify social.friend_requests table in PostgreSQL
  const admin = await lab.adminClient(db);
  try {
    const fReq = (await admin.query(
      'SELECT from_id, to_id FROM social.friend_requests WHERE from_id = $1 AND to_id = $2',
      ['svc_alice', 'svc_bob']
    )).rows;
    assert.equal(fReq.length, 1, '1 row exists in social.friend_requests');
  } finally {
    await admin.end();
  }

  // 4.2 Friend Accept: Bob accepts request from Alice
  const accept = await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_bob',
    body: { action: 'accept', target: 'svc_alice' },
  });
  assert.equal(accept.status, 200, 'POST /api/community/friend accept returns 200');

  // Verify social.friendships table in PostgreSQL and removal from requests
  const admin2 = await lab.adminClient(db);
  try {
    const friendships = (await admin2.query(
      'SELECT actor_a, actor_b FROM social.friendships WHERE (actor_a = $1 AND actor_b = $2) OR (actor_a = $2 AND actor_b = $1)',
      ['svc_alice', 'svc_bob']
    )).rows;
    assert.equal(friendships.length, 1, 'Friendship row exists in social.friendships');

    const pending = (await admin2.query(
      'SELECT count(*)::int AS count FROM social.friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)',
      ['svc_alice', 'svc_bob']
    )).rows[0].count;
    assert.equal(pending, 0, 'Pending friend request was consumed and removed');
  } finally {
    await admin2.end();
  }

  // 4.3 List Friends: GET /api/community/friends for Alice and Bob
  const aliceFriends = await apiRequest(harness.baseUrl, '/api/community/friends', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(aliceFriends.status, 200);
  const aliceFriendIds = (aliceFriends.data.friends || []).map((f) => f.id);
  assert.ok(aliceFriendIds.includes('svc_bob'), 'Bob is in Alice\'s friends list');

  const bobFriends = await apiRequest(harness.baseUrl, '/api/community/friends', {
    method: 'GET',
    actor: 'svc_bob',
  });
  assert.equal(bobFriends.status, 200);
  const bobFriendIds = (bobFriends.data.friends || []).map((f) => f.id);
  assert.ok(bobFriendIds.includes('svc_alice'), 'Alice is in Bob\'s friends list (symmetric)');

  // 4.4 Player Search: exact tag search and username prefix search
  const tagSearch = await apiRequest(harness.baseUrl, `/api/community/search?q=${lab.tagFor('svc_bob')}`, {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(tagSearch.status, 200);
  assert.ok(Array.isArray(tagSearch.data), 'Search returns array of results');
  assert.ok(tagSearch.data.some((p) => p.id === 'svc_bob'), 'Exact tag search finds Bob');

  const prefixSearch = await apiRequest(harness.baseUrl, '/api/community/search?q=player_bob', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(prefixSearch.status, 200);
  assert.ok(prefixSearch.data.some((p) => p.id === 'svc_bob'), 'Username prefix search finds Bob');

  // 4.5 Remove Friend: Alice removes Bob
  const removeRes = await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_alice',
    body: { action: 'remove', target: 'svc_bob' },
  });
  assert.equal(removeRes.status, 200, 'POST /api/community/friend remove returns 200');

  // Verify social.friendships row is deleted
  const admin3 = await lab.adminClient(db);
  try {
    const remaining = (await admin3.query(
      'SELECT count(*)::int AS count FROM social.friendships WHERE (actor_a = $1 AND actor_b = $2) OR (actor_a = $2 AND actor_b = $1)',
      ['svc_alice', 'svc_bob']
    )).rows[0].count;
    assert.equal(remaining, 0, 'Friendship row was removed from social.friendships');
  } finally {
    await admin3.end();
  }
});

/* ==========================================================================
 * 5. Cross-Service Consistency Between API and Core & DB Grant Boundaries
 * ========================================================================== */

test('5. Cross-service consistency between API and Core: same actor ID queries identical database state and api_runtime respects grants', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_consistency');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiServer(db);
  t.after(async () => { await harness.close(); });

  // 5.1 Update Alice profile through API
  const updateRes = await apiRequest(harness.baseUrl, '/api/account/profile', {
    method: 'POST',
    actor: 'svc_alice',
    body: {
      displayName: 'Alice CrossService',
      avatar: 'ring',
      statsVisibility: 'public',
    },
  });
  assert.equal(updateRes.status, 200);

  // 5.2 Core service reads identity.profiles directly with core_runtime pool
  const coreProfile = await harness.core.read(async (tx) => {
    const r = await tx.query('SELECT display_name, avatar, stats_visibility FROM identity.profiles WHERE actor_id = $1', ['svc_alice']);
    return r.rows[0];
  });
  assert.equal(coreProfile.display_name, 'Alice CrossService', 'Core reads identical display_name updated via API');
  assert.equal(coreProfile.avatar, 'ring', 'Core reads identical avatar updated via API');
  assert.equal(coreProfile.stats_visibility, 'public', 'Core reads identical stats_visibility updated via API');

  // 5.3 Form friendship through API and confirm Core sees identical social.friendships row
  await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_alice',
    body: { action: 'request', target: 'svc_dave' },
  });
  await apiRequest(harness.baseUrl, '/api/community/friend', {
    method: 'POST',
    actor: 'svc_dave',
    body: { action: 'accept', target: 'svc_alice' },
  });

  const coreFriendship = await harness.core.read(async (tx) => {
    const r = await tx.query(
      'SELECT actor_a, actor_b FROM social.friendships WHERE (actor_a = $1 AND actor_b = $2) OR (actor_a = $2 AND actor_b = $1)',
      ['svc_alice', 'svc_dave']
    );
    return r.rows[0];
  });
  assert.ok(coreFriendship, 'Core observes friendship created via API');

  // 5.4 Database Least-Privilege Grant Boundary:
  // api_runtime pool MUST NOT be able to write directly to economy.wallets or economy.ledger
  await assert.rejects(
    harness.pools.api.query("UPDATE economy.wallets SET coins = 99999 WHERE actor_id = 'svc_alice'"),
    /permission denied/i,
    'api_runtime pool cannot directly update economy.wallets (violates grant boundary)'
  );
  await assert.rejects(
    harness.pools.api.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ('bad:entry', 'svc_alice', 'coins', 1000, 'test', 'api', now())"),
    /permission denied/i,
    'api_runtime pool cannot directly insert into economy.ledger (violates grant boundary)'
  );
});

/* ==========================================================================
 * 6. Account Export, Deletion Status, Deletion Workflow & Unlink Safety
 * ========================================================================== */

test('6. Account export, deletion status, deletion tag check, and unlink last-method safety', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_account_ops');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiServer(db);
  t.after(async () => { await harness.close(); });

  // 6.1 GET /api/account/export returns caller export data
  const exported = await apiRequest(harness.baseUrl, '/api/account/export', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(exported.status, 200, 'GET /api/account/export returns 200');
  assert.ok(exported.data.profile, 'Export contains profile');
  assert.equal(exported.data.profile.tag, lab.tagFor('svc_alice'));

  // 6.2 GET /api/account/deletion returns deletion policy availability
  const deletion = await apiRequest(harness.baseUrl, '/api/account/deletion', {
    method: 'GET',
    actor: 'svc_alice',
  });
  assert.equal(deletion.status, 200, 'GET /api/account/deletion returns 200');
  assert.equal(deletion.data.available, true, 'Deletion policy is available');
  assert.equal(deletion.data.policyVersion, 'v5-p11-test-policy', 'Policy version matches configuration');

  // 6.3 POST /api/account/delete rejects with invalid tag confirmation
  const badDelete = await apiRequest(harness.baseUrl, '/api/account/delete', {
    method: 'POST',
    actor: 'svc_alice',
    body: { confirmation: 'WRONG-TAG' },
  });
  assert.ok([400, 409].includes(badDelete.status), 'Mismatched confirmation tag is rejected');
  assert.equal(badDelete.data.error, 'DELETE_CONFIRMATION_REQUIRED', 'Error code is DELETE_CONFIRMATION_REQUIRED');

  // 6.4 POST /api/account/unlink rejects unlinking when only one identity exists (LAST_LOGIN_METHOD)
  // Seed one identity for Carol
  const admin = await lab.adminClient(db);
  try {
    await admin.query(
      "INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google', 'carol-google-sub', 'svc_carol', now())"
    );
  } finally {
    await admin.end();
  }

  const unlink = await apiRequest(harness.baseUrl, '/api/account/unlink', {
    method: 'POST',
    actor: 'svc_carol',
    body: { provider: 'google' },
  });
  assert.equal(unlink.status, 409, 'Unlinking sole login method returns 409');
  assert.equal(unlink.data.error, 'LAST_LOGIN_METHOD', 'Error code is LAST_LOGIN_METHOD');
});
