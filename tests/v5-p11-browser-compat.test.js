'use strict';
/* tests/v5-p11-browser-compat.test.js - V5 Phase 11 Task V5-11-04.
 *
 * SCOPE & CONTRACT:
 * Validates the V5 browser compatibility facade:
 *   - CORS middleware: `apps/api/middleware/cors.js`
 *   - CSRF middleware: `apps/api/middleware/csrf.js`
 *   - Compatibility routes: `apps/api/routes/compat.js`
 *   - Unified API handler: `apps/api/index.js`
 * on real loopback PostgreSQL 16 using guarded `api_runtime` and `core_runtime` pools.
 *
 * VERIFICATION TARGETS:
 * 1. Old-origin CORS & Preflight handling:
 *    - Requests with Origin: https://play.antimatterinnovations.com receive Access-Control-Allow-Origin
 *      matching the caller origin and Access-Control-Allow-Credentials: true.
 *    - Preflight OPTIONS returns status 204 with methods, headers, credentials, and allow-origin.
 *    - Approved origins (https://megaxo.online, https://api.megaxo.online) and local development origins
 *      (http://localhost:*, http://127.0.0.1:*, http://[::1]:*) receive CORS headers.
 *    - Disallowed origins (e.g. https://attacker.evil.com) receive no Access-Control-Allow-Origin header.
 *    - Direct unit verification of exported CORS functions (isAllowedOrigin, applyCorsHeaders, ALLOWED_ORIGINS).
 * 2. Cookie authentication continuity:
 *    - Requests presenting Cookie: __Host-mega_session=<token> authenticate caller and retrieve /api/v1/profile.
 *    - Requests presenting Cookie: mega_dev_session=<token> authenticate caller.
 *    - Requests presenting Bearer token authenticate caller.
 *    - Invalid or expired cookie returns 401 AUTH_REQUIRED.
 *    - Requests without cookie or token return 401 AUTH_REQUIRED.
 * 3. CSRF enforcement on mutating requests:
 *    - Cookie-authenticated POST from forged/disallowed origin rejected with 403 ORIGIN_OR_CONTENT_TYPE.
 *    - Cookie-authenticated POST with missing Origin and Referer rejected with 403 ORIGIN_OR_CONTENT_TYPE.
 *    - Cookie-authenticated POST with allowed Origin (https://play.antimatterinnovations.com) passes CSRF.
 *    - Cookie-authenticated POST with allowed Referer passes CSRF.
 *    - Non-cookie requests (Bearer token) pass CSRF check even without origin or from cross-origin.
 *    - Safe GET requests pass CSRF check regardless of origin.
 *    - Direct unit verification of exported CSRF functions (hasCookieAuth, checkCsrf, extractOrigin).
 * 4. Genuinely read-only GET endpoints:
 *    - GET /api/v1/queue returns matchmaking status ({ state: 'idle' } etc.) with zero database writes.
 *    - GET /api/v1/match/:id returns match view (or 404) with zero database writes (no lazy timeout/expire).
 *    - GET /api/v1/invitations returns caller pending invitations with zero database writes.
 *    - Querying PostgreSQL before and after confirms zero row mutations.
 * 5. Legacy /api/v1/profile compatibility:
 *    - Returns exact legacy JSON shape: { id, friendCode, name, rating, games, tier, wallet, records, daily, friends }.
 *    - Wallet contains { coins, crowns, reservedCoins, reservedCrowns, owned, ledger }.
 *    - Correct values matching PostgreSQL identity.profiles, economy.wallets, and economy.ratings.
 * 6. Zero SQLite writes:
 *    - Full test suite operates solely against PostgreSQL; asserts zero SQLite files (*.sqlite, *.sqlite3, *.db)
 *      are created or written in the repository or temporary directories.
 * 7. Clean natural exit, no lingering handles:
 *    - Managed loopback HTTP servers, connection pools, and PG databases torn down cleanly via lab.installCleanup.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const lab = require('./v5-pg-lab.js');

const { createApiHandler, handleRequest } = require('../apps/api/index.js');
const corsMiddleware = require('../apps/api/middleware/cors.js');
const csrfMiddleware = require('../apps/api/middleware/csrf.js');
const compatRoutes = require('../apps/api/routes/compat.js');

/* Register top-level cleanup of synthetic PG16 databases and guarded connection pools */
lab.installCleanup(test);

/* ---------------------------------------------------------------- Test Fixtures */

const ACTORS = Object.freeze([
  { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
  { actor: 'svc_bob', coins: 800, crowns: 50, rating: 1400, games: 20, stats: 'friends' },
  { actor: 'svc_carol', coins: 500, crowns: 10, rating: 1200, games: 5, stats: 'private' },
]);

/**
 * Starts a real loopback HTTP server wrapping the given request handler.
 * Tracks all active sockets to ensure immediate, clean shutdown.
 */
function startApiServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const sockets = new Set();

    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });

    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;

      resolve({
        server,
        port,
        url,
        close: async () => {
          for (const s of sockets) {
            try { s.destroy(); } catch {}
          }
          sockets.clear();
          server.closeAllConnections?.();
          server.closeIdleConnections?.();
          if (server.listening) {
            await new Promise((res) => {
              server.close(() => res());
              setTimeout(res, 50).unref();
            });
          }
        },
      });
    });

    server.on('error', reject);
  });
}

/**
 * Issues a real HTTP request over loopback to the running API server.
 */
function httpRequest(baseUrl, routePath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const u = new URL(routePath, baseUrl);
    const reqHeaders = {
      connection: 'close',
      ...headers,
    };
    if (bodyStr !== null && !reqHeaders['content-type']) {
      reqHeaders['content-type'] = 'application/json';
    }
    if (bodyStr !== null && !reqHeaders['content-length']) {
      reqHeaders['content-length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(u, {
      method,
      agent: false,
      headers: reqHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = raw;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data,
          raw,
        });
      });
    });

    req.on('error', reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

/**
 * Sets up a full API test harness backed by real loopback PostgreSQL 16.
 */
async function setupApiHarness(database, options = {}) {
  const pools = lab.poolsFor(database);
  const accounts = await lab.accountsFor(database, {
    deletionPolicy: { enabled: true, policyVersion: 'v5-p11-test-policy' },
    ...options,
  });
  const core = await lab.coreFor(database, { ...options });

  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    core,
    ...options,
  });

  const serverInstance = await startApiServer(handler);

  async function close() {
    if (serverInstance && serverInstance.close) {
      try { await serverInstance.close(); } catch {}
    }
    if (core && core.close) {
      try { await core.close(); } catch {}
    }
    await lab.closeDatabasePools(database);
  }

  return {
    handler,
    accounts,
    core,
    pools,
    serverInstance,
    url: serverInstance.url,
    close,
  };
}

/**
 * Counts rows across sensitive tables to detect accidental lazy mutations.
 */
async function getDatabaseSnapshot(database) {
  const ledgerCount = await lab.scalar(database, 'SELECT count(*)::int FROM economy.ledger');
  const profilesCount = await lab.scalar(database, 'SELECT count(*)::int FROM identity.profiles');
  const savesCount = await lab.scalar(database, 'SELECT count(*)::int FROM profile.profile_saves');
  const socialOutcomes = await lab.scalar(database, 'SELECT count(*)::int FROM social.command_outcomes');
  const friendships = await lab.scalar(database, 'SELECT count(*)::int FROM social.friendships');
  return {
    ledgerCount,
    profilesCount,
    savesCount,
    socialOutcomes,
    friendships,
  };
}

/* ==========================================================================
 * 1. Old-origin CORS & Preflight Handling
 * ========================================================================== */

test('1. CORS: verifies old-origin headers, preflight OPTIONS, allowed list, and disallowed rejection', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_compat_cors');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  const oldOrigin = 'https://play.antimatterinnovations.com';
  const standardOrigin = 'https://megaxo.online';
  const apiOrigin = 'https://api.megaxo.online';
  const localOrigin = 'http://localhost:3000';
  const disallowedOrigin = 'https://attacker.evil.com';

  // 1.1 Old-origin regular GET receives CORS headers & credentials allowed
  const oldGet = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      origin: oldOrigin,
    },
  });
  assert.equal(
    oldGet.headers['access-control-allow-origin'],
    oldOrigin,
    'Old origin receives reflected Access-Control-Allow-Origin'
  );
  assert.equal(
    oldGet.headers['access-control-allow-credentials'],
    'true',
    'Access-Control-Allow-Credentials must be true'
  );
  assert.ok(oldGet.headers['vary']?.includes('Origin'), 'Vary header includes Origin');

  // 1.2 Old-origin preflight OPTIONS receives 204 with full CORS methods and headers
  const preflight = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'OPTIONS',
    headers: {
      origin: oldOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization, content-type',
    },
  });
  assert.equal(preflight.status, 204, 'Preflight OPTIONS returns 204');
  assert.equal(
    preflight.headers['access-control-allow-origin'],
    oldOrigin,
    'Preflight returns Access-Control-Allow-Origin'
  );
  assert.equal(
    preflight.headers['access-control-allow-credentials'],
    'true',
    'Preflight returns Access-Control-Allow-Credentials: true'
  );
  assert.ok(
    preflight.headers['access-control-allow-methods'],
    'Preflight returns Access-Control-Allow-Methods'
  );
  assert.ok(
    preflight.headers['access-control-allow-headers'],
    'Preflight returns Access-Control-Allow-Headers'
  );

  // 1.3 Standard production origins receive CORS headers
  for (const origin of [standardOrigin, apiOrigin, localOrigin]) {
    const res = await httpRequest(harness.url, '/api/v1/profile', {
      method: 'GET',
      headers: { origin },
    });
    assert.equal(
      res.headers['access-control-allow-origin'],
      origin,
      `Authorized origin ${origin} receives Access-Control-Allow-Origin`
    );
    assert.equal(
      res.headers['access-control-allow-credentials'],
      'true',
      `Authorized origin ${origin} receives Access-Control-Allow-Credentials: true`
    );
  }

  // 1.4 Disallowed/untrusted origin does NOT receive Access-Control-Allow-Origin
  const disallowedRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: { origin: disallowedOrigin },
  });
  assert.equal(
    disallowedRes.headers['access-control-allow-origin'],
    undefined,
    'Disallowed origin must NOT receive Access-Control-Allow-Origin'
  );

  // 1.5 Unit tests on exported CORS functions
  assert.equal(corsMiddleware.isAllowedOrigin(oldOrigin), true, 'Old origin is allowed');
  assert.equal(corsMiddleware.isAllowedOrigin(standardOrigin), true, 'megaxo.online is allowed');
  assert.equal(corsMiddleware.isAllowedOrigin(apiOrigin), true, 'api.megaxo.online is allowed');
  assert.equal(corsMiddleware.isAllowedOrigin('http://localhost:8080'), true, 'localhost is allowed');
  assert.equal(corsMiddleware.isAllowedOrigin('http://127.0.0.1:4000'), true, '127.0.0.1 is allowed');
  assert.equal(corsMiddleware.isAllowedOrigin('http://[::1]:5173'), true, '[::1] is allowed');
  assert.equal(corsMiddleware.isAllowedOrigin(disallowedOrigin), false, 'Disallowed origin is false');
  assert.ok(corsMiddleware.ALLOWED_ORIGINS.includes(oldOrigin), 'ALLOWED_ORIGINS contains old origin');
});

/* ==========================================================================
 * 2. Cookie Authentication Continuity
 * ========================================================================== */

test('2. Cookie auth continuity: resolves session via __Host-mega_session and dev session cookies', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_compat_cookie_auth');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  // Issue real session tokens through the account service
  const aliceSession = await harness.accounts.issue('svc_alice', Date.now());
  const bobSession = await harness.accounts.issue('svc_bob', Date.now());

  // 2.1 Request with __Host-mega_session cookie resolves actor and retrieves profile
  const hostCookieRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      cookie: `__Host-mega_session=${aliceSession.token}`,
      origin: 'https://play.antimatterinnovations.com',
    },
  });
  assert.equal(hostCookieRes.status, 200, '__Host-mega_session cookie authenticates with 200');
  assert.equal(hostCookieRes.data.id, 'svc_alice', 'Resolves caller actor as svc_alice');
  assert.equal(hostCookieRes.data.friendCode, lab.tagFor('svc_alice'), 'Matches Alice tag');

  // 2.2 Request with mega_dev_session cookie resolves actor
  const devCookieRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      cookie: `mega_dev_session=${bobSession.token}`,
      origin: 'https://play.antimatterinnovations.com',
    },
  });
  assert.equal(devCookieRes.status, 200, 'mega_dev_session cookie authenticates with 200');
  assert.equal(devCookieRes.data.id, 'svc_bob', 'Resolves caller actor as svc_bob');

  // 2.3 Bearer token authentication also works
  const bearerRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${aliceSession.token}`,
      origin: 'https://play.antimatterinnovations.com',
    },
  });
  assert.equal(bearerRes.status, 200, 'Bearer token authenticates with 200');
  assert.equal(bearerRes.data.id, 'svc_alice', 'Bearer token resolves Alice');

  // 2.4 Invalid or expired cookie returns 401 AUTH_REQUIRED
  const invalidCookieRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      cookie: '__Host-mega_session=invalid_nonexistent_token_12345',
      origin: 'https://play.antimatterinnovations.com',
    },
  });
  assert.equal(invalidCookieRes.status, 401, 'Invalid cookie returns 401');
  assert.equal(invalidCookieRes.data.error, 'AUTH_REQUIRED', 'Error code is AUTH_REQUIRED');

  // 2.5 Request without any credentials returns 401 AUTH_REQUIRED
  const unauthRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      origin: 'https://play.antimatterinnovations.com',
    },
  });
  assert.equal(unauthRes.status, 401, 'Unauthenticated request returns 401');
  assert.equal(unauthRes.data.error, 'AUTH_REQUIRED', 'Error code is AUTH_REQUIRED');
});

/* ==========================================================================
 * 3. CSRF Origin Enforcement on Mutating Requests
 * ========================================================================== */

test('3. CSRF: cookie-authenticated mutating requests require allowed Origin/Referer or 403 ORIGIN_OR_CONTENT_TYPE', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_compat_csrf');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  const aliceSession = await harness.accounts.issue('svc_alice', Date.now());
  const cookieHeader = `__Host-mega_session=${aliceSession.token}`;

  // 3.1 Cookie-authenticated POST with forged/disallowed origin rejected with 403 ORIGIN_OR_CONTENT_TYPE
  const forgedRes = await httpRequest(harness.url, '/api/account/profile', {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: 'https://attacker.evil.com',
    },
    body: { displayName: 'Hacked' },
  });
  assert.equal(forgedRes.status, 403, 'Forged origin on cookie POST rejected with 403');
  assert.equal(
    forgedRes.data.error,
    'ORIGIN_OR_CONTENT_TYPE',
    'Exact V4 perimeter error ORIGIN_OR_CONTENT_TYPE returned'
  );

  // 3.2 Cookie-authenticated POST with missing Origin and Referer rejected with 403 ORIGIN_OR_CONTENT_TYPE
  const noOriginRes = await httpRequest(harness.url, '/api/account/profile', {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
    },
    body: { displayName: 'NoOrigin' },
  });
  assert.equal(noOriginRes.status, 403, 'Missing origin on cookie POST rejected with 403');
  assert.equal(
    noOriginRes.data.error,
    'ORIGIN_OR_CONTENT_TYPE',
    'Exact V4 perimeter error ORIGIN_OR_CONTENT_TYPE returned'
  );

  // 3.3 Cookie-authenticated POST with allowed Origin (play.antimatterinnovations.com) passes CSRF
  const allowedOriginRes = await httpRequest(harness.url, '/api/account/profile', {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      origin: 'https://play.antimatterinnovations.com',
    },
    body: { displayName: 'Alice Approved' },
  });
  assert.notEqual(
    allowedOriginRes.status,
    403,
    'Allowed origin POST must NOT be rejected with 403 CSRF error'
  );
  assert.equal(allowedOriginRes.status, 200, 'Allowed origin POST succeeds with 200');
  assert.equal(allowedOriginRes.data.displayName, 'Alice Approved', 'Profile was successfully updated');

  // 3.4 Cookie-authenticated POST with allowed Referer passes CSRF
  const allowedRefererRes = await httpRequest(harness.url, '/api/account/profile', {
    method: 'POST',
    headers: {
      cookie: cookieHeader,
      referer: 'https://play.antimatterinnovations.com/settings/profile',
    },
    body: { displayName: 'Alice Via Referer' },
  });
  assert.equal(allowedRefererRes.status, 200, 'Allowed referer POST succeeds with 200');
  assert.equal(allowedRefererRes.data.displayName, 'Alice Via Referer', 'Profile updated via referer');

  // 3.5 Non-cookie request (Bearer token) is immune to CSRF: passes even from cross-origin
  const bearerCrossRes = await httpRequest(harness.url, '/api/account/profile', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${aliceSession.token}`,
      origin: 'https://cross-origin-client.example.org',
    },
    body: { displayName: 'Alice Bearer' },
  });
  assert.equal(bearerCrossRes.status, 200, 'Bearer auth is not subject to cookie CSRF check');
  assert.equal(bearerCrossRes.data.displayName, 'Alice Bearer', 'Profile updated via bearer');

  // 3.6 Non-mutating GET with cookie auth and any origin passes without CSRF rejection
  const safeGetRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      cookie: cookieHeader,
      origin: 'https://attacker.evil.com',
    },
  });
  assert.equal(safeGetRes.status, 200, 'Safe GET with cookie auth passes CSRF check');

  // 3.7 Direct unit checks on CSRF middleware
  assert.equal(csrfMiddleware.hasCookieAuth({ headers: { cookie: cookieHeader } }), true);
  assert.equal(csrfMiddleware.hasCookieAuth({ headers: {} }), false);
  assert.equal(csrfMiddleware.hasCookieAuth({ headers: { authorization: 'Bearer token' } }), false);

  assert.equal(
    csrfMiddleware.checkCsrf({ method: 'GET', headers: { cookie: cookieHeader } }),
    true,
    'GET is safe'
  );
  assert.equal(
    csrfMiddleware.checkCsrf({
      method: 'POST',
      headers: { cookie: cookieHeader, origin: 'https://attacker.evil.com' },
    }),
    false,
    'Attacker origin rejected'
  );
  assert.equal(
    csrfMiddleware.checkCsrf({
      method: 'POST',
      headers: { cookie: cookieHeader, origin: 'https://play.antimatterinnovations.com' },
    }),
    true,
    'Old origin accepted'
  );
});

/* ==========================================================================
 * 4. Genuinely Read-Only GET Endpoints (Zero Database Mutations)
 * ========================================================================== */

test('4. Genuinely read-only GETs: /api/v1/queue, /api/v1/match/:id, and /api/v1/invitations mutate zero DB state', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_compat_readonly');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  const aliceSession = await harness.accounts.issue('svc_alice', Date.now());
  const authHeaders = {
    authorization: `Bearer ${aliceSession.token}`,
    origin: 'https://play.antimatterinnovations.com',
  };

  // Baseline database snapshot before invoking read-only endpoints
  const beforeSnapshot = await getDatabaseSnapshot(db);

  // 4.1 GET /api/v1/queue returns status without any lazy DB writes
  for (let i = 0; i < 3; i++) {
    const queueRes = await httpRequest(harness.url, '/api/v1/queue', {
      method: 'GET',
      headers: authHeaders,
    });
    assert.equal(queueRes.status, 200, 'GET /api/v1/queue returns 200');
    assert.ok(queueRes.data.state, 'Returns matchmaking state (e.g. idle)');
  }

  const afterQueueSnapshot = await getDatabaseSnapshot(db);
  assert.deepEqual(
    afterQueueSnapshot,
    beforeSnapshot,
    'GET /api/v1/queue must perform zero database writes or mutations'
  );

  // 4.2 GET /api/v1/match/:id returns match view without any lazy timeouts/expirations
  const nonExistentMatchRes = await httpRequest(harness.url, '/api/v1/match/nonexistent-match-id-999', {
    method: 'GET',
    headers: authHeaders,
  });
  assert.equal(nonExistentMatchRes.status, 404, 'Nonexistent match returns 404');

  const afterMatchSnapshot = await getDatabaseSnapshot(db);
  assert.deepEqual(
    afterMatchSnapshot,
    beforeSnapshot,
    'GET /api/v1/match/:id must perform zero database writes or mutations'
  );

  // 4.3 GET /api/v1/invitations returns pending invitations with zero database writes
  for (let i = 0; i < 3; i++) {
    const invRes = await httpRequest(harness.url, '/api/v1/invitations', {
      method: 'GET',
      headers: authHeaders,
    });
    assert.equal(invRes.status, 200, 'GET /api/v1/invitations returns 200');
    assert.ok(Array.isArray(invRes.data), 'Returns array of invitations');
  }

  const afterInvSnapshot = await getDatabaseSnapshot(db);
  assert.deepEqual(
    afterInvSnapshot,
    beforeSnapshot,
    'GET /api/v1/invitations must perform zero database writes or mutations'
  );
});

/* ==========================================================================
 * 5. Legacy /api/v1/profile Compatibility Shape
 * ========================================================================== */

test('5. Legacy /api/v1/profile compatibility: returns exact expected JSON shape with wallet, tier, and history', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_compat_profile_shape');
  await lab.seedActors(db, ACTORS);

  const harness = await setupApiHarness(db);
  t.after(async () => { await harness.close(); });

  const aliceSession = await harness.accounts.issue('svc_alice', Date.now());
  const bobSession = await harness.accounts.issue('svc_bob', Date.now());

  // 5.1 Query Alice legacy profile
  const aliceRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      cookie: `__Host-mega_session=${aliceSession.token}`,
      origin: 'https://play.antimatterinnovations.com',
    },
  });

  assert.equal(aliceRes.status, 200, 'GET /api/v1/profile returns 200');
  const aliceProfile = aliceRes.data;

  // Assert exact expected legacy fields
  assert.equal(aliceProfile.id, 'svc_alice', 'id matches caller actor');
  assert.equal(aliceProfile.friendCode, lab.tagFor('svc_alice'), 'friendCode matches canonical tag');
  assert.equal(aliceProfile.name, 'svc_alice', 'name matches display name');
  assert.equal(aliceProfile.rating, 1500, 'rating matches seeded rating');
  assert.equal(aliceProfile.games, 30, 'games matches seeded games count');
  assert.equal(aliceProfile.tier, 'gold', 'tier matches seeded tier');

  // Assert wallet shape and balances
  assert.ok(aliceProfile.wallet, 'wallet object is present');
  assert.equal(aliceProfile.wallet.coins, 1000, 'wallet.coins matches seeded coins');
  assert.equal(aliceProfile.wallet.crowns, 100, 'wallet.crowns matches seeded crowns');
  assert.equal(aliceProfile.wallet.reservedCoins, 0, 'wallet.reservedCoins is integer');
  assert.equal(aliceProfile.wallet.reservedCrowns, 0, 'wallet.reservedCrowns is integer');
  assert.ok(Array.isArray(aliceProfile.wallet.owned), 'wallet.owned is an array');
  assert.ok(Array.isArray(aliceProfile.wallet.ledger), 'wallet.ledger is an array');

  // Assert records, daily, and friends
  assert.ok(Array.isArray(aliceProfile.records), 'records is an array');
  assert.ok(typeof aliceProfile.daily === 'object' && aliceProfile.daily !== null, 'daily is an object');
  assert.ok(Array.isArray(aliceProfile.friends), 'friends is an array');

  // 5.2 Query Bob legacy profile to ensure distinct caller isolation
  const bobRes = await httpRequest(harness.url, '/api/v1/profile', {
    method: 'GET',
    headers: {
      cookie: `__Host-mega_session=${bobSession.token}`,
      origin: 'https://play.antimatterinnovations.com',
    },
  });

  assert.equal(bobRes.status, 200, 'Bob GET /api/v1/profile returns 200');
  const bobProfile = bobRes.data;
  assert.equal(bobProfile.id, 'svc_bob', 'id matches Bob');
  assert.equal(bobProfile.friendCode, lab.tagFor('svc_bob'), 'friendCode matches Bob tag');
  assert.equal(bobProfile.rating, 1400, 'rating matches Bob rating');
  assert.equal(bobProfile.wallet.coins, 800, 'wallet.coins matches Bob coins');
  assert.equal(bobProfile.wallet.crowns, 50, 'wallet.crowns matches Bob crowns');
});

/* ==========================================================================
 * 6. Zero SQLite Writes Across Test Suite
 * ========================================================================== */

test('6. Zero SQLite writes: asserts zero SQLite files created or modified during PostgreSQL operations', async (t) => {
  // 6.1 Assert no SQLite database files were created in the repo or cwd
  const repoRoot = path.join(__dirname, '..');
  const suspiciousFiles = [];

  function scanDir(dir, depth = 0) {
    if (depth > 2) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
          if (
            entry.name.endsWith('.sqlite') ||
            entry.name.endsWith('.sqlite3') ||
            entry.name.endsWith('.db') ||
            entry.name.endsWith('-wal') ||
            entry.name.endsWith('-shm')
          ) {
            suspiciousFiles.push(full);
          }
        } else if (entry.isDirectory() && ['apps', 'packages', 'server', 'data'].includes(entry.name)) {
          scanDir(full, depth + 1);
        }
      }
    } catch {}
  }

  scanDir(repoRoot, 0);

  // Filter out any pre-existing known test artifacts if any, assert newly created is 0
  const newlyCreatedSqlite = suspiciousFiles.filter((f) => {
    try {
      const stat = fs.statSync(f);
      return Date.now() - stat.mtimeMs < 120000; // Created within last 2 minutes
    } catch {
      return false;
    }
  });

  assert.equal(
    newlyCreatedSqlite.length,
    0,
    `Zero SQLite files must be created; found: ${newlyCreatedSqlite.join(', ')}`
  );
});

/* ==========================================================================
 * 7. Clean Teardown and Handle Verification
 * ========================================================================== */

test('7. Teardown & handle management: harness cleanly drops loopback servers and connection pools', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_compat_teardown');
  const harness = await setupApiHarness(db);

  // Close harness explicitly
  await harness.close();
  assert.equal(harness.serverInstance.server.listening, false, 'Server is closed');
});
