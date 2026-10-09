'use strict';

/**
 * P11 HTTP principal regression: these are intentionally database-free checks
 * so a registry outage cannot mask an exposed Core actor impersonation defect.
 * Real PG16 token expiry/revocation semantics remain covered by P05 and P11 suites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApiHandler } = require('../apps/api/index.js');

function fixture() {
  const forwarded = [];
  const profileReads = [];
  const live = new Map([
    ['alice-session', 'svc_alice'],
    ['bob-session', 'svc_bob'],
  ]);
  const accounts = {
    async requireLinked(token) {
      const actor = live.get(token);
      if (!actor) throw new Error('AUTH_REQUIRED');
      return { actor };
    },
    async self(actor) {
      profileReads.push(actor);
      return { id: actor, name: actor, tag: 'MEGA-TEST', walletReady: true };
    },
  };
  const coreGateway = {
    async forwardCommand(request) {
      forwarded.push(request);
      return { ok: true, actor: request.actor };
    },
  };
  return { handler: createApiHandler({ accounts, coreGateway }), forwarded, profileReads, live };
}

async function request(handler, {
  method = 'POST', url = '/api/v1/convert', headers = {}, body = { amount: 100 },
  actor, user, token, sessionToken,
} = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers, body, actor, user, token, sessionToken });
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      end(text = '') {
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: this.statusCode, data, headers: this.headers });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('P11: never accept request actor, user, or spoofed HTTP headers as Core principals', async () => {
  const { handler, forwarded, profileReads } = fixture();
  const attacks = [
    { headers: { 'x-actor-id': 'svc_alice' } },
    { headers: { 'x-test-actor': 'svc_alice' } },
    { actor: 'svc_alice' },
    { user: { id: 'svc_alice', actor: 'svc_alice' } },
    { headers: { 'x-actor-id': 'svc_alice', authorization: 'Bearer fake-session' } },
  ];
  for (const attack of attacks) {
    const core = await request(handler, attack);
    assert.equal(core.status, 401);
    assert.equal(core.data.error, 'AUTH_REQUIRED');
    const account = await request(handler, {
      ...attack, method: 'GET', url: '/api/account/profile',
    });
    assert.equal(account.status, 401);
    assert.equal(account.data.error, 'AUTH_REQUIRED');
  }
  assert.equal(forwarded.length, 0);
  assert.equal(profileReads.length, 0);
});

test('P11: linked bearer token wins over forged actor headers for profile and Core', async () => {
  const { handler, forwarded, profileReads } = fixture();
  const headers = {
    authorization: 'Bearer alice-session',
    'x-actor-id': 'svc_bob',
    'x-test-actor': 'svc_bob',
  };
  const res = await request(handler, { headers: { ...headers, 'idempotency-key': 'p11-actor-verified' }, actor: 'svc_bob', user: { id: 'svc_bob' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.actor, 'svc_alice');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].actor, 'svc_alice');
  const account = await request(handler, { method: 'GET', url: '/api/account/profile', headers });
  assert.equal(account.status, 200);
  assert.equal(account.data.id, 'svc_alice');
  assert.deepEqual(profileReads, ['svc_alice']);
});

test('P11: old-origin cookie sessions work, revoked sessions never forward', async () => {
  const { handler, forwarded, live } = fixture();
  const headers = {
    origin: 'https://play.antimatterinnovations.com',
    cookie: '__Host-mega_session=bob-session',
    'x-actor-id': 'svc_alice',
  };
  const good = await request(handler, { headers: { ...headers, 'idempotency-key': 'p11-cookie-success' } });
  assert.equal(good.status, 200);
  assert.equal(good.data.actor, 'svc_bob');
  live.delete('bob-session');
  const revoked = await request(handler, { headers });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.data.error, 'AUTH_REQUIRED');
  assert.equal(forwarded.length, 1);

  const missingOrigin = await request(handler, {
    headers: { cookie: '__Host-mega_session=alice-session' },
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.data.error, 'ORIGIN_OR_CONTENT_TYPE');
});

test('P11: API will not boot OTP or Core gateway using default public secrets', async () => {
  const { resolveService } = require('../apps/api/routes/helpers.js');
  const { resolveGateway } = require('../apps/api/routes/competitive.js');
  const names = [
    'MEGA_OTP_SECRET', 'OTP_SECRET', 'CORE_SECRET', 'SERVICE_SECRET',
    'MEGA_CORE_URL', 'CORE_SERVICE_URL', 'CORE_URL', 'GAME_CORE_URL',
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    await assert.rejects(
      resolveService({ pool: {} }),
      (error) => error.message === 'OTP_SECRET_REQUIRED' && error.status === 503,
    );
    assert.throws(
      () => resolveGateway({}),
      (error) => error.message === 'CORE_URL_REQUIRED' && error.status === 503,
    );
    assert.throws(
      () => resolveGateway({ coreUrl: 'https://core.example.org' }),
      (error) => error.message === 'GATEWAY_SECRET_REQUIRED' && error.status === 503,
    );
    const explicitlyConfigured = resolveGateway({
      coreUrl: 'https://core.example.org',
      coreSecret: 'unique-test-secret-do-not-deploy',
    });
    assert.equal(explicitlyConfigured.baseUrl, 'https://core.example.org');
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('P12 privacy: cached completed match never bypasses fresh participant access', async () => {
  const { createReadCache, CATEGORIES } = require('../packages/services/read-cache.js');
  const readCache = createReadCache();
  readCache.set('match:m-private', {
    id: 'm-private',
    status: 'COMPLETED',
    players: ['svc_alice', 'svc_bob'],
    personalSecret: 'must-not-leak',
  }, { category: CATEGORIES.PUBLIC_PROJECTED, ttlMs: 300000 });

  const checked = [];
  const handler = createApiHandler({
    readCache,
    accounts: {
      async requireLinked(token) {
        if (token === 'alice-session') return { actor: 'svc_alice' };
        if (token === 'bob-session') return { actor: 'svc_bob' };
        throw Error('AUTH_REQUIRED');
      },
    },
    core: {
      async readMatch(actor) {
        checked.push(actor);
        if (actor === 'svc_bob') throw Error('NOT_PARTICIPANT');
        return {
          id: 'm-private',
          status: 'COMPLETED',
          players: ['svc_alice', 'svc_bob'],
          terms: { kind: 'standard' },
        };
      },
    },
  });
  const bob = await request(handler, {
    method: 'GET', url: '/api/v1/match/m-private',
    headers: { authorization: 'Bearer bob-session' },
  });
  assert.equal(bob.status, 403, 'rejected viewer cannot see a stale shared snapshot');
  assert.equal(bob.data.error, 'NOT_PARTICIPANT');

  const alice = await request(handler, {
    method: 'GET', url: '/api/v1/match/m-private',
    headers: { authorization: 'Bearer alice-session' },
  });
  assert.equal(alice.status, 200);
  assert.equal(alice.headers['cache-control'], 'private, no-store',
    'participant-scoped results must never be public CDN cacheable');
  assert.equal(alice.data.personalSecret, undefined);
  assert.deepEqual(checked, ['svc_bob', 'svc_alice']);
});

test('P11/P12: private friends always re-read authority after external block, ignoring stale cache', async () => {
  const { createReadCache, CATEGORIES } = require('../packages/services/read-cache.js');
  const readCache = createReadCache();
  // Preload an older API worker's snapshot; invalidation is not broadcast
  // across processes. This should never authorize stale social visibility.
  readCache.set('friends:svc_alice', { friends: [{ id: 'svc_bob' }] }, {
    category: CATEGORIES.PRIVATE_NO_CACHE,
    shared: false,
    ttlMs: 30000,
  });
  let blocked = false;
  let reads = 0;
  const accounts = {
    async requireLinked(token) {
      if (token !== 'alice-session') throw new Error('AUTH_REQUIRED');
      return { actor: 'svc_alice' };
    },
    async friends(actor) {
      assert.equal(actor, 'svc_alice');
      reads++;
      return { friends: blocked ? [] : [{ id: 'svc_bob' }], incoming: [], outgoing: [], blocked: [] };
    },
  };
  const handler = createApiHandler({ accounts, readCache });
  const opts = { method: 'GET', url: '/api/community/friends',
    headers: { authorization: 'Bearer alice-session' } };
  const first = await request(handler, opts);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.friends.map(x => x.id), ['svc_bob']);
  blocked = true; // A separate process committed a durable block.
  const second = await request(handler, opts);
  assert.equal(second.status, 200);
  assert.deepEqual(second.data.friends, []);
  assert.equal(reads, 2, 'never trust cross-worker stale friend lists');
});

test('P12: viewer-specific search results never become public CDN cache entries', async () => {
  const queried = [];
  const accounts = {
    async requireLinked(token) {
      const actor = { alice: 'svc_alice', bob: 'svc_bob' }[token];
      if (!actor) throw new Error('AUTH_REQUIRED');
      return { actor };
    },
    async search(actor, query) {
      queried.push([actor, query]);
      return actor === 'svc_alice' ? [{ id: 'svc_carol' }] : [];
    },
  };
  const handler = createApiHandler({ accounts });
  for (const [token, expected] of [['alice', ['svc_carol']], ['bob', []]]) {
    const res = await request(handler, {
      method: 'GET', url: '/api/community/search?q=car',
      headers: { authorization: 'Bearer ' + token },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.deepEqual(res.data.map(x => x.id), expected);
  }
  const empty = await request(handler, {
    method: 'GET', url: '/api/community/search',
    headers: { authorization: 'Bearer alice' },
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers['cache-control'], 'private, no-store');
  assert.deepEqual(queried, [['svc_alice', 'car'], ['svc_bob', 'car']]);
});

test('P13: forged X-Forwarded-Origin cannot authorize cookie spending or CORS', async () => {
  const { handler, forwarded } = fixture();
  const forged = await request(handler, {
    method: 'POST', url: '/api/v1/convert',
    headers: {
      cookie: '__Host-mega_session=alice-session',
      'x-forwarded-origin': 'https://play.antimatterinnovations.com',
    },
    body: { from: 'coins', amount: 100 },
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.data.error, 'ORIGIN_OR_CONTENT_TYPE');
  assert.equal(forged.headers['access-control-allow-origin'], undefined);
  assert.equal(forwarded.length, 0, 'spoofed headers cannot authorize economic mutation');

  const accepted = await request(handler, {
    method: 'POST', url: '/api/v1/convert',
    headers: {
      cookie: '__Host-mega_session=alice-session',
      origin: 'https://play.antimatterinnovations.com',
      'x-forwarded-origin': 'https://attacker.invalid',
      'idempotency-key': 'p13-real-origin',
    },
    body: { from: 'coins', amount: 100 },
  });
  assert.equal(accepted.status, 200, 'approved actual legacy Origin remains functional');
  assert.equal(forwarded.length, 1);
});
test('P11 money safety: missing or malformed operation keys never forward economic commands', async () => {
  const { handler, forwarded } = fixture();
  const auth = { authorization: 'Bearer alice-session' };
  const missing = await request(handler, { headers: auth, body: { from: 'coins', amount: 100 } });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error, 'IDEMPOTENCY_KEY_REQUIRED');

  for (const key of ['invalid key with spaces', 'x'.repeat(201)]) {
    const response = await request(handler, {
      headers: { ...auth, 'idempotency-key': key },
      body: { from: 'coins', amount: 100 },
    });
    assert.equal(response.status, 400);
    assert.equal(response.data.error, 'INVALID_IDEMPOTENCY_KEY');
  }
  assert.equal(forwarded.length, 0, 'invalid operations must not reach Core');

  const valid = await request(handler, {
    headers: { ...auth, 'idempotency-key': 'stable-client-operation-001' },
    body: { from: 'coins', amount: 100 },
  });
  assert.equal(valid.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].opKey, 'stable-client-operation-001');
});
