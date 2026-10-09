'use strict';
/* P06 ephemera lifecycle/TTL regression cases: refusal semantics that must be decided BEFORE any
 * I/O, positive-finite-TTL invariants (rate window, lock lease, queue key TTL), bounded
 * conservative behaviour when Redis is unavailable, verified-TLS construction, and a real worker
 * that closes with an active subscription / unavailable connection and exits naturally.
 *
 * This file is Redis-only: it never needs PostgreSQL, so `V5_PG_URL` is not required. Every
 * Redis-path test skips when REDIS_URL is absent, exactly like the main P06 suite. No test claims
 * a provider TLS handshake: the `rediss://` cases assert only the service's own construction
 * contract (verification is enabled, never weakened), and the parent smoke-tests a real TLS Redis.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createEphemeraService } = require('../packages/services/ephemera.js');
const { launchEphemeraProcess, DEAD_URL } = require('./helpers/v5-ephemera-process.js');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const plaintext = !REDIS_URL.startsWith('rediss://');
const optionsFor = (environment, extra = {}) => ({ url: REDIS_URL, environment, allowPlaintext: plaintext, socket: { connectTimeout: 3000 }, ...extra });
/* An isolated keyVersion gives each case a private namespace: no cross-case contention and a
 * deterministic wipeNamespace()/close() cleanup. */
const isolated = async (t, keyVersion) => {
  const service = await createEphemeraService(optionsFor('test', { keyVersion }));
  assert.equal(await service.healthy(), true, 'the owned Redis must answer PING');
  t.after(async () => { await service.wipeNamespace().catch(() => {}); await service.close().catch(() => {}); });
  return service;
};

const children = [];
const launch = async (extra = {}) => {
  const proc = await launchEphemeraProcess({ url: REDIS_URL, environment: 'test', options: { allowPlaintext: plaintext, socket: { connectTimeout: 3000 } }, ...extra });
  children.push(proc);
  return proc;
};
test.after(() => { for (const proc of children) if (!proc.exited) proc.kill(); });

const elapsed = async (fn) => { const started = Date.now(); const value = await fn(); return { value, ms: Date.now() - started }; };

/* ---------------------------------------------------------------- refusals before I/O */

test('P06 ephemera lifecycle: TTL/window/limit refusals are decided before any I/O', async () => {
  /* An unreachable endpoint: if any refusal were decided only after a Redis round-trip, these calls
   * would resolve to a conservative fallback instead of throwing. They must throw synchronously. */
  const lost = await createEphemeraService({ url: DEAD_URL, environment: 'test', allowPlaintext: true, socket: { connectTimeout: 300, reconnectStrategy: () => 60000 } });
  try {
    await assert.rejects(() => lost.rateHit('bucket', 5, 0), (e) => e.message === 'INVALID_WINDOW');
    await assert.rejects(() => lost.rateHit('bucket', 5, -1), (e) => e.message === 'INVALID_WINDOW');
    await assert.rejects(() => lost.rateHit('bucket', 5, 1.5), (e) => e.message === 'INVALID_WINDOW');
    await assert.rejects(() => lost.rateHit('bucket', 5, Number.NaN), (e) => e.message === 'INVALID_WINDOW');
    await assert.rejects(() => lost.rateHit('bucket', 0, 1000), (e) => e.message === 'INVALID_LIMIT');
    await assert.rejects(() => lost.rateHit('bucket', -2, 1000), (e) => e.message === 'INVALID_LIMIT');
    await assert.rejects(() => lost.acquireLock('name', 0), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => lost.acquireLock('name', -5), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => lost.acquireLock('name', 1.5), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => lost.enqueueCandidate('casual', 'ticket', 0, { windowMs: 0 }), (e) => e.message === 'INVALID_WINDOW');
    await assert.rejects(() => lost.enqueueCandidate('casual', 'ticket', 0, { keyTtlMs: 0 }), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => lost.enqueueCandidate('casual', 'ticket', 0, { keyTtlMs: -1 }), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => lost.enqueueCandidate('casual', 'ticket', Number.POSITIVE_INFINITY), (e) => e.message === 'INVALID_WEIGHT');
    await assert.rejects(() => lost.peekCandidates('casual', { max: 0 }), (e) => e.message === 'INVALID_LIMIT');
    await assert.rejects(() => lost.peekCandidates('casual', { max: 4, windowMs: 0 }), (e) => e.message === 'INVALID_WINDOW');
    await assert.rejects(() => lost.cacheSet('cache', 'k', 'v', 0), (e) => e.message === 'TTL_REQUIRED');
  } finally { await lost.close(); }
});

/* ---------------------------------------------------------------- verified TLS construction */

test('P06 ephemera lifecycle: TLS is required and never weakened', async () => {
  const env = { environment: 'test' };
  await assert.rejects(() => createEphemeraService({ url: 'http://127.0.0.1:50710', ...env, allowPlaintext: true }), (e) => e.message === 'REDIS_URL_REQUIRED');
  await assert.rejects(() => createEphemeraService({ url: 'not a url', ...env }), (e) => e.message === 'REDIS_URL_REQUIRED');
  await assert.rejects(() => createEphemeraService({ url: 42, ...env }), (e) => e.message === 'REDIS_URL_REQUIRED');
  /* Plaintext is opt-in: a bare redis:// URL is refused, and socket.tls=false cannot force it on. */
  await assert.rejects(() => createEphemeraService({ url: 'redis://127.0.0.1:50710', ...env }), (e) => e.message === 'INSECURE_REDIS_URL');
  await assert.rejects(() => createEphemeraService({ url: 'redis://127.0.0.1:50710', ...env, socket: { tls: false } }), (e) => e.message === 'INSECURE_REDIS_URL');
  /* A verified TLS URL (rediss) may never have its verification weakened. */
  await assert.rejects(() => createEphemeraService({ url: 'rediss://127.0.0.1:50710', ...env, socket: { rejectUnauthorized: false } }), (e) => e.message === 'INSECURE_TLS_OPTION');
  await assert.rejects(() => createEphemeraService({ url: 'rediss://127.0.0.1:50710', ...env, socket: { checkServerIdentity: () => undefined } }), (e) => e.message === 'INSECURE_TLS_OPTION');
  await assert.rejects(() => createEphemeraService({ url: 'rediss://127.0.0.1:50710', ...env, socket: { tls: false } }), (e) => e.message === 'INSECURE_TLS_OPTION');
  await assert.rejects(() => createEphemeraService({ url: 'rediss://127.0.0.1:50710', ...env, ca: 123 }), (e) => e.message === 'INVALID_CA');
});

/* ---------------------------------------------------------------- positive finite TTLs */


test('P06 ephemera lifecycle: queue membership is TTL-atomic and expires as a whole', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  const service = await isolated(t, 'l2');
  const mode = 'casual';
  const ticket = 'ticket-' + crypto.randomBytes(3).toString('hex');
  await service.enqueueCandidate(mode, ticket, 0, { windowMs: 5000, keyTtlMs: 300 });
  /* Immediately after the add the sorted set is bounded: the member add and the key PEXPIRE are one
   * atomic unit, so an audit can never observe an immortal queue key. */
  assert.deepEqual((await service.auditUnboundedKeys()).unbounded, [], 'the queue key has a finite TTL from the moment it is written');
  assert.deepEqual((await service.peekCandidates(mode)).candidates, [ticket], 'the queued ticket is visible');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual((await service.peekCandidates(mode)).candidates, [], 'the whole queue key expires with its TTL');
});

/* ---------------------------------------------------------------- bounded conservative unavailable */

test('P06 ephemera lifecycle: every operation on an unavailable Redis is bounded and conservative', async () => {
  const lost = await createEphemeraService({ url: DEAD_URL, environment: 'test', allowPlaintext: true, socket: { connectTimeout: 300, reconnectStrategy: () => 60000 } });
  try {
    const ops = {
      presenceTouch: () => lost.presenceTouch('a', 's', true, 60000),
      presenceRead: () => lost.presenceRead('a'),
      cacheGet: () => lost.cacheGet('cache', 'k'),
      rateHit: () => lost.rateHit('b', 5, 60000),
      acquireLock: () => lost.acquireLock('l', 5000),
      enqueueCandidate: () => lost.enqueueCandidate('casual', 't', 0, { windowMs: 60000, keyTtlMs: 60000 }),
      peekCandidates: () => lost.peekCandidates('casual'),
      wipeNamespace: () => lost.wipeNamespace(),
      auditUnboundedKeys: () => lost.auditUnboundedKeys(),
      subscribe: () => lost.subscribe('bus-dead', () => {}),
    };
    let total = 0;
    const seen = {};
    for (const [name, op] of Object.entries(ops)) {
      const { value, ms } = await elapsed(op);
      seen[name] = value;
      total += ms;
      assert.ok(ms < 3000, `${name} must resolve within its deadline (took ${ms} ms)`);
    }
    assert.ok(total < 6000, `the whole loss surface resolves quickly (took ${total} ms)`);
    assert.equal(seen.presenceTouch.stored, false);
    assert.deepEqual(seen.presenceRead.sessions, []);
    assert.equal(seen.cacheGet.value, null);
    assert.equal(seen.rateHit.allowed, false);
    assert.equal(seen.rateHit.conservative, true);
    assert.equal(seen.acquireLock.acquired, false);
    assert.equal(seen.acquireLock.conservative, true);
    assert.equal(seen.enqueueCandidate.queued, false);
    assert.deepEqual(seen.peekCandidates.candidates, []);
    assert.deepEqual(seen.wipeNamespace, { deleted: 0, available: false });
    assert.deepEqual(seen.auditUnboundedKeys, { unbounded: [], available: false });
    assert.equal(seen.subscribe.available, false);
    assert.equal(typeof seen.subscribe.unsubscribe, 'function');

    /* close() itself must be bounded even against a dead connection. */
    const closed = await elapsed(() => lost.close());
    assert.ok(closed.ms < 4000, `close() against an unavailable Redis is bounded (took ${closed.ms} ms)`);
  } finally { await lost.close().catch(() => {}); }
});

/* ---------------------------------------------------------------- real processes, real exit */

test('P06 ephemera lifecycle: a worker with an active subscription and an unavailable connection exits naturally', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  /* Process 1: a HEALTHY Redis with a live subscription. close() must release the subscription and
   * the process must exit on its own (code 0, no force), proving no subscriber/reconnect leak. */
  const live = await launch({ subscribeChannel: 'bus-live' });
  assert.equal(live.subscribeAvailable, true, 'the live worker subscribed on real Redis');
  assert.deepEqual(await live.shutdown(), { code: 0, signal: null }, 'a worker with an active subscription exits naturally after close');

  /* Process 2: an UNAVAILABLE connection with a conservative subscription handle. close() must
   * release the connection and the process must still exit naturally. */
  const dead = await launchEphemeraProcess({ url: DEAD_URL, environment: 'test', options: { allowPlaintext: true, socket: { connectTimeout: 300, reconnectStrategy: () => 60000 } }, subscribeChannel: 'bus-dead' });
  children.push(dead);
  assert.equal(dead.subscribeAvailable, false, 'the dead worker subscription is conservative');
  assert.deepEqual(await dead.shutdown(), { code: 0, signal: null }, 'a worker with an unavailable connection exits naturally after close');
});
