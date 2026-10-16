'use strict';

/* SEC-V52-SSV-UNLIMITED-DOS fix: the actor-free provider-callback lanes admit by canonical source
 * IP (600/min per provider) BEFORE any signature work or Core round-trip, through the deployment
 * edge only. No database: the counter is the same ops.rate_buckets upsert the LR12 limiter uses,
 * asserted against a recording fake pool. The route wiring is proven with the REAL route handler
 * and a fake lane: a refused callback is a 429 with Retry-After and no-store, the gateway is
 * never invoked, and the signed SSV query bytes pass through unchanged. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderCallbackLimiter, createCallbackSourceIp, canonicalIpBytes, DEFAULT_LIMIT, PROVIDERS } = require('../packages/services/provider-callback-limit.js');
const { handleMonetizationRoute } = require('../apps/api/routes/monetization.js');

function fakePool() {
  const counters = new Map();
  return {
    healthy: true,
    async query(sql, params) {
      if (!this.healthy) throw Error('CONNECTION_REFUSED');
      if (!sql.includes('ops.rate_buckets')) throw Error('UNEXPECTED_SQL');
      const id = params[0];
      const next = (counters.get(id) || 0) + 1;
      counters.set(id, next);
      return { rows: [{ hits: next }] };
    },
  };
}

const PROXY_SECRET = 'unit-test-proxy-secret-0123456789abcdef';
const TRUSTED = '10.0.0.0/8,127.0.0.1/32';

function edgeRequest({ ip = '10.1.2.3', key = PROXY_SECRET, clientIp = '203.0.113.7', headers = {} } = {}) {
  return { socket: { remoteAddress: ip }, headers: { 'x-mega-client-ip': clientIp, 'x-mega-proxy-key': key, ...headers } };
}

test('callback limiter: 600 admissions pass per provider, the 601st refuses 429 with a retry-after', async () => {
  const pool = fakePool();
  const limiter = createProviderCallbackLimiter({ pool });
  const source = createCallbackSourceIp({ proxySecret: PROXY_SECRET, trustedProxies: TRUSTED });
  const key = source.resolve(edgeRequest());
  const now = Date.parse('2026-10-16T12:00:00Z');
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) assert.equal((await limiter.check('admob', key, now)).allowed, true);
  await assert.rejects(() => limiter.check('admob', key, now), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.ok(Number.isFinite(error.retryAfter) && error.retryAfter >= 1 && error.retryAfter <= 60);
    return true;
  });
});

test('callback limiter: provider budgets and source identities are independent', async () => {
  const pool = fakePool();
  const limiter = createProviderCallbackLimiter({ pool });
  const source = createCallbackSourceIp({ proxySecret: PROXY_SECRET, trustedProxies: TRUSTED });
  const key = source.resolve(edgeRequest());
  const now = Date.parse('2026-10-16T12:01:00Z');
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) await limiter.check('cashfree', key, now);
  await assert.rejects(() => limiter.check('cashfree', key, now), /RATE_LIMITED/);
  /* A different provider lane for the SAME source still admits, and so does a second source. */
  assert.equal((await limiter.check('polar', key, now)).allowed, true);
  const otherKey = source.resolve(edgeRequest({ clientIp: '198.51.100.9' }));
  assert.notEqual(key, otherKey);
  assert.equal((await limiter.check('cashfree', otherKey, now)).allowed, true);
});

test('callback limiter: two instances on one pool enforce one aggregate budget', async () => {
  const pool = fakePool();
  const a = createProviderCallbackLimiter({ pool });
  const b = createProviderCallbackLimiter({ pool });
  const source = createCallbackSourceIp({ proxySecret: PROXY_SECRET, trustedProxies: TRUSTED });
  const key = source.resolve(edgeRequest());
  const now = Date.parse('2026-10-16T12:02:00Z');
  for (let i = 0; i < DEFAULT_LIMIT; i += 1) await (i % 2 ? a : b).check('polar', key, now);
  await assert.rejects(() => a.check('polar', key, now), /RATE_LIMITED/);
  await assert.rejects(() => b.check('polar', key, now), /RATE_LIMITED/);
});

test('callback limiter: a storage failure fails CLOSED with 503', async () => {
  const pool = fakePool();
  pool.healthy = false;
  const limiter = createProviderCallbackLimiter({ pool });
  const source = createCallbackSourceIp({ proxySecret: PROXY_SECRET, trustedProxies: TRUSTED });
  const key = source.resolve(edgeRequest());
  await assert.rejects(() => limiter.check('admob', key), (error) => error.code === 'RATE_LIMIT_UNAVAILABLE' && error.status === 503);
});

test('source resolver: the edge header is trusted only from a trusted peer with the proxy key', () => {
  const source = createCallbackSourceIp({ proxySecret: PROXY_SECRET, trustedProxies: TRUSTED });
  /* A trusted edge presenting the right key: the asserted client IP is the source. */
  const trusted = source.resolve(edgeRequest());
  assert.match(trusted, /^[0-9a-f]{64}$/);
  /* A NON-proxy peer asserting the header is refused outright. */
  assert.throws(() => source.resolve(edgeRequest({ ip: '203.0.113.7', clientIp: '203.0.113.7' })), (e) => e.code === 'UNTRUSTED_PROXY_ASSERTION' && e.status === 403);
  /* A trusted peer with a WRONG key is refused. */
  assert.throws(() => source.resolve(edgeRequest({ key: 'wrong-wrong-wrong-wrong-wrong' })), (e) => e.code === 'UNTRUSTED_PROXY_ASSERTION' && e.status === 403);
  /* A direct client that sends no edge headers uses its own address; spoofed forwarded headers are ignored. */
  const direct = source.resolve({ socket: { remoteAddress: '198.51.100.9' }, headers: { 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4' } });
  assert.match(direct, /^[0-9a-f]{64}$/);
  assert.notEqual(direct, trusted);
  /* A direct client that FORGES the proxy key from an untrusted peer is still refused. */
  assert.throws(() => source.resolve({ socket: { remoteAddress: '198.51.100.9' }, headers: { 'x-mega-client-ip': '1.2.3.4', 'x-mega-proxy-key': PROXY_SECRET } }), (e) => e.code === 'UNTRUSTED_PROXY_ASSERTION');
});

test('source resolver: equivalent IP spellings hash to one bucket key', () => {
  const source = createCallbackSourceIp({ proxySecret: PROXY_SECRET, trustedProxies: TRUSTED });
  const a = source.resolve(edgeRequest({ clientIp: '2001:0db8:0000:0000:0000:0000:0000:0001' }));
  const b = source.resolve(edgeRequest({ clientIp: '2001:db8::1' }));
  assert.equal(a, b);
  const v4 = source.resolve(edgeRequest({ clientIp: '192.0.2.1' }));
  const mapped = source.resolve(edgeRequest({ clientIp: '::ffff:192.0.2.1' }));
  assert.equal(v4, mapped);
  assert.throws(() => source.resolve(edgeRequest({ clientIp: 'not-an-ip' })), (e) => e.code === 'INVALID_SOURCE_IP' && e.status === 400);
});

test('canonicalIpBytes: ipv4, mapped, compressed and expanded ipv6 agree on bytes', () => {
  assert.deepEqual(canonicalIpBytes('192.0.2.1'), Buffer.from([192, 0, 2, 1]));
  assert.deepEqual(canonicalIpBytes('::ffff:192.0.2.1'), Buffer.from([192, 0, 2, 1]));
  assert.deepEqual(canonicalIpBytes('2001:db8::1'), canonicalIpBytes('2001:0db8:0000:0000:0000:0000:0000:0001'));
  assert.equal(canonicalIpBytes('1.2.3.4.5'), null);
  assert.equal(canonicalIpBytes('1.2.3.256'), null);
  assert.equal(canonicalIpBytes('2001:db8:::1'), null);
  assert.equal(canonicalIpBytes('abc'), null);
});

test('route: a refused callback answers 429 with Retry-After and never reaches the gateway', async () => {
  const resCalls = [];
  const res = {
    statusCode: 0, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader() { return null; }, end(b) { resCalls.push({ status: this.statusCode, body: b }); },
  };
  let gatewayCalls = 0;
  const ctx = { monetization: {
    command: async () => ({ ok: 1 }),
    ssv: async () => { gatewayCalls += 1; return { ok: true }; },
    checkCallback: async () => { const error = Error('RATE_LIMITED'); error.code = 'RATE_LIMITED'; error.status = 429; error.retryAfter = 42; throw error; },
  } };
  const req = { method: 'GET', url: '/api/monetization/admob-ssv?signature=abc', headers: {} };
  assert.equal(await handleMonetizationRoute(ctx, req, res), true);
  assert.equal(resCalls.length, 1);
  assert.equal(resCalls[0].status, 429);
  assert.match(String(resCalls[0].body), /RATE_LIMITED/);
  assert.equal(res.headers['Retry-After'], '42');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(gatewayCalls, 0, 'a refused callback never invokes the gateway');
});

test('route: an exhausted budget refuses before the provider signature work, and raw SSV bytes pass through unchanged', async () => {
  let ssvRaw = null;
  let admitted = null;
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, getHeader() { return null; }, end(b) { this.body = b; } };
  const ctx = { monetization: {
    command: async () => ({ ok: 1 }),
    ssv: async (raw) => { ssvRaw = raw; return { ok: true, raw }; },
    checkCallback: async (req, provider) => { admitted = provider; },
  } };
  const RAW = 'a=1&b=%20two&c=three&signature=ab%2Bcd%3D';
  const req = { method: 'GET', url: '/api/monetization/admob-ssv?' + RAW, headers: {} };
  assert.equal(await handleMonetizationRoute(ctx, req, res), true);
  assert.equal(admitted, 'admob');
  assert.equal(ssvRaw, RAW, 'the signed query string is forwarded byte-for-byte after admission');
  assert.equal(res.statusCode, 200);
});

test('route: missing admission protection is a fail-closed 503', async () => {
  const res = { statusCode: 0, headers: {}, setHeader() {}, getHeader() { return null; }, end(b) { this.body = b; } };
  const ctx = { monetization: { command: async () => ({ ok: 1 }), ssv: async () => ({ ok: true }) } };
  const req = { method: 'GET', url: '/api/monetization/admob-ssv?x=1', headers: {} };
  assert.equal(await handleMonetizationRoute(ctx, req, res), true);
  assert.equal(res.statusCode, 503);
  assert.match(String(res.body), /CALLBACK_ADMISSION_UNAVAILABLE/);
});

test('every provider lane is covered by the shared limiter', () => {
  assert.deepEqual(PROVIDERS, ['admob', 'cashfree', 'polar']);
});
