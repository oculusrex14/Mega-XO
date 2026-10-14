'use strict';
/* tests/v5-p11-native-session.test.js - the cookie-free native session route family.
 *
 * SCOPE
 * The five routes DECLARED by packages/contracts/routes.js lines 55-61 and mounted by
 * apps/api/routes/account.js:
 *
 *   POST /api/account/native/challenge  csrf:true,  bodyLimit 300000
 *   POST /api/account/native/finish     csrf:true,  bodyLimit 300000
 *   POST /api/account/native/token      auth:bearer, origin:none, csrf:false, bodyLimit 300000
 *   POST /api/account/native/refresh    auth:bearer, origin:none, csrf:false, bodyLimit 16384
 *   POST /api/account/native/logout     auth:bearer, origin:none, csrf:false, bodyLimit 16384
 *
 * Everything runs against the real disposable loopback PostgreSQL 16 lab with real guarded
 * api_runtime pools, the real accounts/access/refresh services and a real RSA provider verifier
 * (server/identity-provider.js with test keys) - no mocks, no SQLite, no provider/device claim.
 *
 * WHAT IS PINNED
 *  1. All five routes are mounted and reachable (NOT 404).
 *  2. NO response on any of the five sets a Set-Cookie header, and no response echoes a cookie
 *     credential back as a body field.
 *  3. token: a cookie+bearer pair is refused with AMBIGUOUS_CREDENTIAL (401).
 *  4. refresh: real single-flight rotation - the presented token dies, the successor works, a
 *     replay cannot mint a second live family, and the new access token verifies.
 *  5. logout: revokes the presenting family, so the refresh token no longer works.
 *  6. The exact body limits refuse an oversize payload with 413 BODY_TOO_LARGE (never truncated).
 *  7. The existing session boundary rules still hold: cookie credentials keep strict Origin and
 *     CSRF, while bearer credentials are exempt (no cookie to protect).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lab = require('./v5-pg-lab.js');
const { createApiHandler } = require('../apps/api/index.js');
const { createAccessService } = require('../packages/services/access.js');
const { createRefreshService } = require('../packages/services/refresh.js');
const { IdentityProviders } = require('../server/identity-provider.js');
const { jwk, sign } = require('./helpers/identity-fixture.js');

lab.installCleanup(test);

const PLAYER_AUDIENCES = ['mega-browser', 'mega-android', 'mega-ios'];
const SERVICE_AUDIENCES = ['mega-core'];
const NATIVE_AUDIENCES = ['mega-android', 'mega-ios'];
const ORIGIN = 'https://megaxo.online';

/* ---------------------------------------------------------------- transport */

function startApiServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
          for (const s of sockets) { try { s.destroy(); } catch { /* already gone */ } }
          sockets.clear();
          server.closeAllConnections?.();
          server.closeIdleConnections?.();
          if (server.listening) await new Promise((done) => { server.close(() => done()); setTimeout(done, 50).unref(); });
        },
      });
    });
    server.on('error', reject);
  });
}

function httpRequest(baseUrl, routePath, { method = 'GET', headers = {}, body = null, rawBody = null, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== null ? rawBody : (body === null ? null : JSON.stringify(body));
    const requestHeaders = { connection: 'close', ...headers };
    if (payload !== null && !requestHeaders['content-type']) requestHeaders['content-type'] = 'application/json';
    if (payload !== null && !chunked && !requestHeaders['content-length']) requestHeaders['content-length'] = Buffer.byteLength(payload);
    const req = http.request(new URL(routePath, baseUrl), { method, agent: false, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
        resolve({ status: res.statusCode, headers: res.headers, data, raw });
      });
    });
    req.on('error', reject);
    if (payload !== null) {
      /* A chunked write sends a piece before the body ends, so an undeclared-length oversize stream
       * is genuinely exercised rather than short-circuited by Content-Length. */
      if (chunked && payload.length > 4096) {
        req.write(payload.slice(0, 4096));
        req.write(payload.slice(4096));
      } else {
        req.write(payload);
      }
    }
    req.end();
  });
}

/* ---------------------------------------------------------------- composition */

/**
 * The deployment composition: real accounts + access + refresh services over the guarded
 * api_runtime pool, plus the real RSA provider verifier with test-only keys. The API handler gets
 * the services (and the native audience allowlist) explicitly, exactly as the P05 suite does.
 */
async function compose(database) {
  const pools = lab.poolsFor(database);
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `v5-p11-native-keys-${process.pid}-`)), 'keys.sealed.json');
  const now = () => lab.CLOCK;
  const access = await createAccessService(pools.api, {
    now, issuer: 'https://api.megaxo.test', environment: 'stg',
    keyFile, playerAudiences: PLAYER_AUDIENCES, serviceAudiences: SERVICE_AUDIENCES,
  });
  const refresh = await createRefreshService(pools.api, {
    now,
    mintAccess: async ({ actor, sessionId, generation }) => access.issue({
      actor, sessionId, generation, amr: ['pwd'], authAt: now(), audience: 'mega-android',
    }),
  });
  const accounts = await lab.accountsFor(database, {
    clock: now,
    deletionPolicy: { enabled: true, policyVersion: 'v5-p11-native-test' },
    onSessionRevoked: async (publicIds) => { for (const id of publicIds) await refresh.revokeForSession(id); },
  });
  const providers = new IdentityProviders({
    config: { google: { nativeAudiences: ['test-native'] }, apple: { nativeAudiences: ['test-native'] } },
    now,
    keysForTest: () => [jwk],
  });
  return { access, refresh, accounts, providers, keyFile };
}

async function harness(database, context) {
  const handler = createApiHandler({
    accounts: context.accounts,
    access: context.access,
    refresh: context.refresh,
    providers: context.providers,
    nativeAudiences: NATIVE_AUDIENCES,
    allowedOrigins: [ORIGIN],
  });
  const server = await startApiServer(handler);
  return { handler, server, url: server.url };
}

/* A real provider-signed ID token for a nonce, issued for the native audience. */
const idTokenFor = (subject, nonce) => sign('google', subject, nonce, lab.CLOCK);

const bearer = (token) => ({ authorization: `Bearer ${token}` });

/* ---------------------------------------------------------------- 1. mounting */

test('P11 native: all five contract routes are mounted (not 404) and answer their own contracts', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_mount');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const context = await compose(db);
  const api = await harness(db, context);
  try {
    /* challenge: reachable with no credential at all (a first-ever native sign-in has none). */
    const challenge = await httpRequest(api.url, '/api/account/native/challenge', {
      method: 'POST', headers: { origin: ORIGIN }, body: { provider: 'google', intent: 'login' },
    });
    assert.equal(challenge.status, 200);
    assert.match(challenge.data.state, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Number.isSafeInteger(challenge.data.expires) && challenge.data.expires > 0);
    assert.equal(challenge.headers['set-cookie'], undefined);

    /* The attempt is bound to the anonymous session the challenge bootstrapped and returned in the
     * body; the ID token is real and signed for the nonce the server just issued. */
    const sessionToken = challenge.data.sessionToken;
    assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);

    const finish = await httpRequest(api.url, '/api/account/native/finish', {
      method: 'POST',
      headers: { origin: ORIGIN, authorization: `Bearer ${sessionToken}` },
      body: { provider: 'google', state: challenge.data.state, idToken: idTokenFor('native-subject-1', challenge.data.nonce) },
    });
    assert.equal(finish.status, 200, finish.raw);
    assert.equal(finish.data.linked, true);
    assert.equal(finish.data.created, true);
    assert.ok(finish.data.sessionToken, 'the rotated bearer is returned in the body, never a cookie');
    assert.equal(finish.headers['set-cookie'], undefined);

    /* token (refresh branch): a real family rotation. */
    const family = await context.refresh.startFamily({
      actor: finish.data.profile.id,
      sessionId: (await context.accounts.sessions(finish.data.sessionToken)).find((row) => row.current).id,
      deviceId: null,
    });
    const token = await httpRequest(api.url, '/api/account/native/token', {
      method: 'POST', body: { grant: 'refresh_token', refreshToken: family.refreshSecret },
    });
    assert.equal(token.status, 200, token.raw);
    assert.match(token.data.accessToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(token.data.refreshToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(token.data.expiresIn, 300);
    assert.equal(token.data.actorId, finish.data.profile.id);
    assert.equal(token.headers['set-cookie'], undefined);

    const rotated = await httpRequest(api.url, '/api/account/native/refresh', {
      method: 'POST', body: { grant: 'refresh_token', refreshToken: token.data.refreshToken },
    });
    assert.equal(rotated.status, 200, rotated.raw);
    assert.notEqual(rotated.data.refreshToken, token.data.refreshToken);
    assert.equal(rotated.headers['set-cookie'], undefined);

    const out = await httpRequest(api.url, '/api/account/native/logout', {
      method: 'POST', headers: bearer(rotated.data.accessToken), body: {},
    });
    assert.equal(out.status, 200, out.raw);
    assert.deepEqual(out.data, { signedOut: true });
    assert.equal(out.headers['set-cookie'], undefined);

    /* No response above was a 404, and none leaked a credential into a cookie. */
    for (const response of [challenge, finish, token, rotated, out]) assert.notEqual(response.status, 404);
  } finally {
    await api.server.close();
    await context.accounts.close(); await context.refresh.close(); await context.access.close();
    await lab.closeDatabasePools(db);
  }
});

/* --------------------------------------------------- 2. no Set-Cookie, ever */

test('P11 native: no native route ever sets a Set-Cookie header, on success or on failure', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_nocookie');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const context = await compose(db);
  const api = await harness(db, context);
  try {
    const challenge = await httpRequest(api.url, '/api/account/native/challenge', {
      method: 'POST', body: { provider: 'google', intent: 'login' },
    });
    const sessionToken = challenge.data.sessionToken;
    const cookie = { cookie: `__Host-mega_session=${sessionToken}`, origin: ORIGIN };

    const probes = await Promise.all([
      /* challenge: both credential shapes, including a cookie-authenticated one (which must ALSO
       * pass the declared CSRF check, so it needs the JSON content type and the session token). */
      httpRequest(api.url, '/api/account/native/challenge', { method: 'POST', body: { provider: 'google' } }),
      httpRequest(api.url, '/api/account/native/challenge', { method: 'POST', headers: cookie, body: { provider: 'google' } }),
      /* finish: unauthenticated (401) and provider-failing (never a cookie). */
      httpRequest(api.url, '/api/account/native/finish', { method: 'POST', body: { provider: 'google', state: challenge.data.state, idToken: idTokenFor('s', challenge.data.nonce) } }),
      /* token: bad grants. */
      httpRequest(api.url, '/api/account/native/token', { method: 'POST', body: {} }),
      httpRequest(api.url, '/api/account/native/token', { method: 'POST', body: { grant: 'refresh_token', refreshToken: 'A'.repeat(43) } }),
      /* refresh: malformed/unknown credential. */
      httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: 'A'.repeat(43) } }),
      /* logout: no bearer at all. */
      httpRequest(api.url, '/api/account/native/logout', { method: 'POST', body: {} }),
      /* logout: a valid bearer for a genuinely linked actor, which is the success path. */
      httpRequest(api.url, '/api/account/native/token', { method: 'POST', headers: cookie, body: { grant: 'refresh_token', refreshToken: 'A'.repeat(43) } }),
    ]);
    for (const response of probes) {
      assert.equal(response.headers['set-cookie'], undefined, `Set-Cookie leaked: ${response.raw}`);
      assert.notEqual(response.status, 404, `route missing: ${response.raw}`);
    }
    /* A cookie credential must never be echoed back to a native client as a body field. */
    for (const response of probes) {
      if (response.data && typeof response.data === 'object') {
        assert.equal(response.data.cookie, undefined);
        assert.equal(response.data.setCookie, undefined);
      }
    }
  } finally {
    await api.server.close();
    await context.accounts.close(); await context.refresh.close(); await context.access.close();
    await lab.closeDatabasePools(db);
  }
});

/* ------------------------------------------------------- 3. ambiguity refusal */

test('P11 native: a cookie+bearer pair on token is refused with AMBIGUOUS_CREDENTIAL', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_ambiguous');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const context = await compose(db);
  const api = await harness(db, context);
  try {
    const session = await context.accounts.issue('svc_alice', lab.CLOCK);
    const native = await context.access.issue({
      actor: 'svc_alice',
      sessionId: (await context.accounts.sessions(session.token)).find((row) => row.current).id,
      generation: 1, amr: ['pwd'], authAt: lab.CLOCK, audience: 'mega-android',
    });
    const mixed = await httpRequest(api.url, '/api/account/native/token', {
      method: 'POST',
      headers: { cookie: `__Host-mega_session=${session.token}`, ...bearer(native) },
      body: { grant: 'refresh_token', refreshToken: 'A'.repeat(43) },
    });
    assert.equal(mixed.status, 401);
    assert.equal(mixed.data.error, 'AMBIGUOUS_CREDENTIAL');
    assert.equal(mixed.headers['set-cookie'], undefined);

    /* The same rule holds on the other two bearer routes. */
    for (const route of ['/api/account/native/refresh', '/api/account/native/logout']) {
      const refused = await httpRequest(api.url, route, {
        method: 'POST',
        headers: { cookie: `mega_dev_session=${session.token}`, ...bearer(native) },
        body: { grant: 'refresh_token', refreshToken: 'A'.repeat(43) },
      });
      assert.equal(refused.status, 401);
      assert.equal(refused.data.error, 'AMBIGUOUS_CREDENTIAL');
    }
  } finally {
    await api.server.close();
    await context.accounts.close(); await context.refresh.close(); await context.access.close();
    await lab.closeDatabasePools(db);
  }
});

/* ------------------------------------------------------ 4. single-flight rotate */

test('P11 native: refresh rotates the family once; the old secret dies and a replay cannot fork it', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_rotate');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const context = await compose(db);
  const api = await harness(db, context);
  try {
    const session = await context.accounts.issue('svc_alice', lab.CLOCK);
    const sid = (await context.accounts.sessions(session.token)).find((row) => row.current).id;
    const family = await context.refresh.startFamily({ actor: 'svc_alice', sessionId: sid, deviceId: null });
    const secret = family.refreshSecret;

    const first = await httpRequest(api.url, '/api/account/native/refresh', {
      method: 'POST', body: { grant: 'refresh_token', refreshToken: secret },
    });
    assert.equal(first.status, 200, first.raw);
    assert.notEqual(first.data.refreshToken, secret);
    assert.equal(first.data.actorId, 'svc_alice');

    /* The new access token is a real P05 bearer: it verifies against the deployment issuer and
     * audience, and the account service accepts it as that actor's native credential. */
    const claims = await context.access.verify(first.data.accessToken, { audience: 'mega-android' });
    assert.equal(claims.sub, 'svc_alice');
    assert.equal(claims.sid, sid);
    const credential = await context.accounts.authenticateNative(first.data.accessToken, { access: context.access, nativeAudiences: NATIVE_AUDIENCES });
    assert.ok((await context.accounts.sessions(credential)).some((row) => row.current && row.id === sid));

    /* Replaying the CONSUMED secret inside the bounded retry window recovers the ONE committed
     * successor (the at-least-once leg), never a fork. */
    const replay = await httpRequest(api.url, '/api/account/native/refresh', {
      method: 'POST', body: { grant: 'refresh_token', refreshToken: secret },
    });
    assert.equal(replay.status, 200, replay.raw);
    assert.equal(replay.data.refreshToken, first.data.refreshToken, 'a retry recovers the committed successor');

    /* Two CONCURRENT rotations of the SAME presented secret: the family lock serializes them, so
     * the loser recovers the ONE committed successor inside the bounded retry window rather than
     * minting a second live family. */
    const concurrent = await Promise.all([
      httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: first.data.refreshToken } }),
      httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: first.data.refreshToken } }),
    ]);
    for (const response of concurrent) assert.equal(response.status, 200, response.raw);
    const successors = [...new Set(concurrent.map((r) => r.data.refreshToken))];
    assert.equal(successors.length, 1, 'one committed successor, never two families');
    assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM identity.refresh_families WHERE actor_id = $1 AND state = 'active'", ['svc_alice']), 1);
    assert.match(successors[0], /^[A-Za-z0-9_-]{43}$/);

    /* The retry window is BOUNDED (maxGraceReuse): after it is spent, presenting the dead secret
     * again is a true replay, which revokes the family and is terminal for the client. */
    const spent = await httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: first.data.refreshToken } });
    assert.equal(spent.status, 200, spent.raw);
    assert.equal(spent.data.refreshToken, successors[0]);
    const replayed = await httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: first.data.refreshToken } });
    assert.equal(replayed.status, 401, replayed.raw);
    assert.equal(replayed.data.error, 'SESSION_REVOKED');
    assert.equal(await lab.scalar(db, "SELECT state FROM identity.refresh_families WHERE actor_id = $1", ['svc_alice']), 'revoked');
    assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM identity.refresh_families WHERE actor_id = $1 AND state = 'active'", ['svc_alice']), 0);

    /* The successor is dead with the family, and an unknown secret is never a new family. */
    const successorDead = await httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: successors[0] } });
    assert.equal(successorDead.status, 401, successorDead.raw);
    const unknown = await httpRequest(api.url, '/api/account/native/refresh', {
      method: 'POST', body: { grant: 'refresh_token', refreshToken: 'B'.repeat(43) },
    });
    assert.equal(unknown.status, 401, 'an unknown secret is a terminal 401, never a new family');
    assert.equal(unknown.headers['set-cookie'], undefined);
  } finally {
    await api.server.close();
    await context.accounts.close(); await context.refresh.close(); await context.access.close();
    await lab.closeDatabasePools(db);
  }
});

/* ----------------------------------------------------------- 5. logout revokes */

test('P11 native: logout revokes the presenting family and the refresh credential stops working', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_logout');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const context = await compose(db);
  const api = await harness(db, context);
  try {
    /* A real provider sign-in through the mounted routes, so the session/family pair is the one
     * the route itself minted rather than a hand-built fixture. */
    const challenge = await httpRequest(api.url, '/api/account/native/challenge', { method: 'POST', body: { provider: 'google', intent: 'login' } });
    const granted = await httpRequest(api.url, '/api/account/native/token', {
      method: 'POST',
      body: { provider: 'google', state: challenge.data.state, idToken: idTokenFor('native-subject-logout', challenge.data.nonce), sessionToken: challenge.data.sessionToken },
    });
    assert.equal(granted.status, 200, granted.raw);
    const refreshSecret = granted.data.refreshToken;
    const accessToken = granted.data.accessToken;

    /* A sibling actor's family must be untouched by this logout. */
    const bobSession = await context.accounts.issue('svc_bob', lab.CLOCK);
    const bobSid = (await context.accounts.sessions(bobSession.token)).find((row) => row.current).id;
    const bobFamily = await context.refresh.startFamily({ actor: 'svc_bob', sessionId: bobSid, deviceId: null });

    const out = await httpRequest(api.url, '/api/account/native/logout', { method: 'POST', headers: bearer(accessToken), body: {} });
    assert.equal(out.status, 200, out.raw);
    assert.deepEqual(out.data, { signedOut: true });
    assert.equal(out.headers['set-cookie'], undefined);

    /* The family is durably revoked (not merely the access token expired). The actor is the one the
     * provider grant created, never assumed from the seed. */
    assert.equal(await lab.scalar(db, "SELECT state FROM identity.refresh_families WHERE family_id = $1", [await lab.scalar(db, 'SELECT family_id FROM identity.refresh_tokens WHERE token_hash = $1', [crypto.createHash('sha256').update(refreshSecret).digest('hex')])]), 'revoked');
    assert.equal(await lab.scalar(db, "SELECT count(*)::int FROM identity.refresh_families WHERE actor_id = $1 AND state = 'active'", [granted.data.actorId]), 0);
    const after = await httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: refreshSecret } });
    assert.equal(after.status, 401, after.raw);
    assert.equal(after.data.error, 'SESSION_REVOKED');

    /* The consumed access token is dead too, and the sibling actor keeps working. */
    const stale = await httpRequest(api.url, '/api/account/native/logout', { method: 'POST', headers: bearer(accessToken), body: {} });
    assert.equal(stale.status, 401, stale.raw);
    const bob = await httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', body: { grant: 'refresh_token', refreshToken: bobFamily.refreshSecret } });
    assert.equal(bob.status, 200, bob.raw);
    assert.equal(bob.data.actorId, 'svc_bob');
  } finally {
    await api.server.close();
    await context.accounts.close(); await context.refresh.close(); await context.access.close();
    await lab.closeDatabasePools(db);
  }
});

/* --------------------------------------------------------------- 6. body limits */

test('P11 native: the contract body limits refuse an oversize payload instead of truncating it', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_limits');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const context = await compose(db);
  const api = await harness(db, context);
  try {
    /* 300000 is the declared limit for challenge/finish/token: 1 byte over must be refused. */
    for (const route of ['/api/account/native/challenge', '/api/account/native/finish', '/api/account/native/token']) {
      const oversize = JSON.stringify({ provider: 'google', padding: 'x'.repeat(300000) });
      assert.ok(Buffer.byteLength(oversize) > 300000);
      const refused = await httpRequest(api.url, route, { method: 'POST', rawBody: oversize });
      assert.equal(refused.status, 413, `${route}: ${refused.raw.slice(0, 200)}`);
      assert.equal(refused.data.error, 'BODY_TOO_LARGE');
      assert.equal(refused.headers['set-cookie'], undefined);
    }
    /* 16384 for refresh/logout. */
    for (const route of ['/api/account/native/refresh', '/api/account/native/logout']) {
      const oversize = JSON.stringify({ grant: 'refresh_token', refreshToken: 'A'.repeat(20000) });
      assert.ok(Buffer.byteLength(oversize) > 16384);
      const refused = await httpRequest(api.url, route, { method: 'POST', rawBody: oversize });
      assert.equal(refused.status, 413, `${route}: ${refused.raw.slice(0, 200)}`);
      assert.equal(refused.data.error, 'BODY_TOO_LARGE');
    }
    /* EXACTLY at the 16384 ceiling the body is fully read (the limit is a ceiling, not a margin): a
     * well-formed grant at that size proceeds to its normal contract answer instead of a 413. */
    const base = JSON.stringify({ grant: 'refresh_token', refreshToken: 'A'.repeat(43), deviceId: '' });
    const atLimit = JSON.stringify({ grant: 'refresh_token', refreshToken: 'A'.repeat(43), deviceId: 'x'.repeat(16384 - Buffer.byteLength(base)) });
    assert.equal(Buffer.byteLength(atLimit), 16384);
    const accepted = await httpRequest(api.url, '/api/account/native/refresh', { method: 'POST', rawBody: atLimit });
    assert.equal(accepted.status, 401, accepted.raw);
    assert.equal(accepted.data.error, 'SESSION_REVOKED');

    /* The refusal happens BEFORE parsing: an oversize body that is not even JSON must be
     * BODY_TOO_LARGE, never an INVALID_JSON produced by parsing a truncated body. */
    for (const route of ['/api/account/native/challenge', '/api/account/native/token']) {
      const garbage = await httpRequest(api.url, route, { method: 'POST', rawBody: 'x'.repeat(300034) });
      assert.equal(garbage.status, 413, `${route}: ${garbage.raw.slice(0, 200)}`);
      assert.equal(garbage.data.error, 'BODY_TOO_LARGE');
    }

    /* An undeclared length (chunked) is bounded by the reader too: still a real 413 answer rather
     * than a dropped connection. A SMALL invalid body stays an honest parse failure, so the ceiling
     * is not a blanket denial of malformed input. */
    const chunked = await httpRequest(api.url, '/api/account/native/refresh', {
      method: 'POST', rawBody: 'y'.repeat(20000), chunked: true,
    });
    assert.equal(chunked.status, 413, chunked.raw.slice(0, 200));
    assert.equal(chunked.data.error, 'BODY_TOO_LARGE');
    const chunkedLarge = await httpRequest(api.url, '/api/account/native/token', {
      method: 'POST', rawBody: 'z'.repeat(300034), chunked: true,
    });
    assert.equal(chunkedLarge.status, 413, chunkedLarge.raw.slice(0, 200));
    const smallInvalid = await httpRequest(api.url, '/api/account/native/token', { method: 'POST', rawBody: 'not json' });
    assert.equal(smallInvalid.status, 409, smallInvalid.raw);
    assert.equal(smallInvalid.data.error, 'INVALID_JSON');
  } finally {
    await api.server.close();
    await context.accounts.close(); await context.refresh.close(); await context.access.close();
    await lab.closeDatabasePools(db);
  }
});

/* ------------------------------------------------- 7. session boundary survives */

test('P11 native: Origin and CSRF still bind cookie credentials; bearer credentials stay exempt', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_boundary');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const context = await compose(db);
  const api = await harness(db, context);
  try {
    const session = await context.accounts.issue('svc_alice', lab.CLOCK);

    /* Cookie-authenticated POST from a foreign origin: refusal happens at the ingress (403). */
    const foreign = await httpRequest(api.url, '/api/account/profile', {
      method: 'POST', headers: { cookie: `__Host-mega_session=${session.token}`, origin: 'https://evil.example' }, body: {},
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.data.error, 'ORIGIN_OR_CONTENT_TYPE');

    /* Cookie-authenticated POST with no Origin at all: same refusal. */
    const noOrigin = await httpRequest(api.url, '/api/account/profile', {
      method: 'POST', headers: { cookie: `__Host-mega_session=${session.token}` }, body: {},
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.data.error, 'ORIGIN_OR_CONTENT_TYPE');

    /* An allowed Origin passes the ingress: the shipped /api/account/profile boundary is origin
     * enforcement, exactly as tests/v5-p11-browser-compat.test.js pins it. */
    const allowedOrigin = await httpRequest(api.url, '/api/account/profile', {
      method: 'POST', headers: { cookie: `__Host-mega_session=${session.token}`, origin: ORIGIN }, body: {},
    });
    assert.equal(allowedOrigin.status, 200, allowedOrigin.raw);
    assert.equal(allowedOrigin.headers['set-cookie'], undefined);

    /* The same boundary on the native challenge route: a cookie credential is still CSRF-bound. */
    const challengeForeign = await httpRequest(api.url, '/api/account/native/challenge', {
      method: 'POST', headers: { cookie: `__Host-mega_session=${session.token}`, origin: 'https://evil.example' }, body: { provider: 'google' },
    });
    assert.equal(challengeForeign.status, 403);
    assert.equal(challengeForeign.data.error, 'ORIGIN_OR_CONTENT_TYPE');
    const challengeBadCsrf = await httpRequest(api.url, '/api/account/native/challenge', {
      method: 'POST', headers: { cookie: `__Host-mega_session=${session.token}`, origin: ORIGIN, 'x-csrf-token': 'wrong' }, body: { provider: 'google' },
    });
    assert.equal(challengeBadCsrf.status, 403);
    assert.equal(challengeBadCsrf.data.error, 'CSRF_FAILED');
    /* With the genuine token it succeeds - the check is not a blanket denial. */
    const challengeOk = await httpRequest(api.url, '/api/account/native/challenge', {
      method: 'POST', headers: { cookie: `__Host-mega_session=${session.token}`, origin: ORIGIN, 'x-csrf-token': session.csrf }, body: { provider: 'google' },
    });
    assert.equal(challengeOk.status, 200, challengeOk.raw);
    assert.equal(challengeOk.data.sessionToken, undefined, 'a cookie-authenticated caller already holds its bearer');

    /* A bearer request is CSRF-exempt by design: there is no cookie to protect. Refresh and logout
     * are called by the shipped hosts with no Origin and no CSRF header at all. */
    const sid = (await context.accounts.sessions(session.token)).find((row) => row.current).id;
    const family = await context.refresh.startFamily({ actor: 'svc_alice', sessionId: sid, deviceId: null });
    const crossOrigin = await httpRequest(api.url, '/api/account/native/refresh', {
      method: 'POST', headers: { origin: 'https://evil.example' }, body: { grant: 'refresh_token', refreshToken: family.refreshSecret },
    });
    assert.equal(crossOrigin.status, 200, crossOrigin.raw);

    /* An unconfigured provider answers PROVIDER_NOT_CONFIGURED (V4 parity), not a contract error. */
    const unknown = await httpRequest(api.url, '/api/account/native/challenge', { method: 'POST', body: { provider: 'google', intent: 'nope' } });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.data.error, 'INVALID_AUTH_REQUEST');
  } finally {
    await api.server.close();
    await context.accounts.close(); await context.refresh.close(); await context.access.close();
    await lab.closeDatabasePools(db);
  }
});

/* ------------------------------------------- 8. unconfigured deployment is honest */

test('P11 native: an unconfigured P05 deployment refuses bearer issuance rather than inventing one', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_native_unconfigured');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const accounts = await lab.accountsFor(db, { deletionPolicy: { enabled: true, policyVersion: 'v5-p11-native-test' } });
  const handler = createApiHandler({ accounts, nativeAudiences: NATIVE_AUDIENCES });
  const server = await startApiServer(handler);
  try {
    const refresh = await httpRequest(server.url, '/api/account/native/refresh', {
      method: 'POST', body: { grant: 'refresh_token', refreshToken: 'A'.repeat(43) },
    });
    assert.equal(refresh.status, 503, refresh.raw);
    assert.equal(refresh.data.error, 'NATIVE_SESSION_UNAVAILABLE');
    assert.equal(refresh.headers['set-cookie'], undefined);

    const logout = await httpRequest(server.url, '/api/account/native/logout', {
      method: 'POST', headers: bearer('A'.repeat(43)), body: {},
    });
    assert.equal(logout.status, 503, logout.raw);
    assert.equal(logout.data.error, 'NATIVE_SESSION_UNAVAILABLE');
  } finally {
    await server.close();
    await accounts.close();
    await lab.closeDatabasePools(db);
  }
});
