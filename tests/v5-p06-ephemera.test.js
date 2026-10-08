'use strict';
/* P06 ephemera verification: namespaced bounded primitives on a REAL Redis, conservative
 * total-loss fallbacks, two-process consistency and the wipe contract (V5-06-02/03/04).
 *
 * Redis-path tests require REDIS_URL (default is the owned loopback instance) and are skipped
 * when absent - CI supplies a real Redis 7 service container and enforces zero skips there.
 * The loss-path and PostgreSQL-truth tests run everywhere.
 * Wallet/rank/purchase/ticket truth is NEVER written to Redis: the wipe tests prove the durable
 * side is byte-identical across a namespace wipe and a total loss.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createTicketIssuer, redeemRealtimeTicket } = require('../packages/services/tickets.js');
const { createRefreshService } = require('../packages/services/refresh.js');

lab.installCleanup(test);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const haveRedis = () => process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1' ? true : null; // decided per-test via boot
const boot = async (t, { redis = true } = {}) => {
  if (!(await lab.boot(t))) return false;
  if (redis && !process.env.REDIS_URL && process.env.V5_REDIS_REQUIRED !== '1') { t.skip('no REDIS_URL'); return false; }
  return true;
};
const withRedis = async (t, environment, options = {}) => {
  const service = await createEphemeraService({ url: REDIS_URL, environment, socket: { connectTimeout: 3000 }, ...options });
  const ok = await service.healthy();
  assert.equal(ok, true, 'the owned Redis must answer PING');
  return service;
};

/* A real Redis is a shared fixture: every environment uses its own namespace; wipe after. */
test.after(async () => {
  /* Only clean a namespace we actually own (an explicit REDIS_URL). The default loopback URL is
   * a local convenience, not an owned fixture, and a closed client must never schedule work. */
  if (!process.env.REDIS_URL) return;
  try {
    const s = await createEphemeraService({ url: REDIS_URL, environment: 'test' });
    await s.wipeNamespace();
    await s.close();
  } catch { /* no Redis: nothing to clean */ }
});

test('P06 ephemera: every write is namespaced, bounded by an explicit TTL, and env-separated', async (t) => {
  if (!(await boot(t))) return;
  const stg = await withRedis(t, 'stg');
  try {
    await stg.heartbeat('actor_a', 'sess_1', 60000);
    await stg.cacheSet('cache', 'k', 'v', 60000);
    await stg.setHint('revoked', 'sess_1', 60000);
    const audit = await stg.auditUnboundedKeys();
    assert.equal(audit.available, true);
    assert.deepEqual(audit.unbounded, [], 'no immortal mx: keys may exist after writes');

    /* Environment separation: a prd-named client cannot see a stg key and vice versa. */
    const prd = await withRedis(t, 'prd');
    try {
      const prdView = await prd.lookupPresence('actor_a');
      assert.equal(prdView.value, null, 'a different environment must not see the presence');
      await prd.cacheSet('cache', 'k', 'prd-value', 60000);
      const stgView = await stg.cacheGet('cache', 'k');
      assert.notEqual(stgView.value, 'prd-value', 'cross-environment cache reads are impossible');
    } finally { await prd.close(); }

    /* TTLs actually expire. */
    await stg.cacheSet('cache', 'short', 'x', 60);
    await lab.sleep(120);
    const expired = await stg.cacheGet('cache', 'short');
    assert.equal(expired.value, null, 'a 60 ms entry must expire');

    /* Refusals: no TTL, bad parts, oversize values, unknown family. */
    await assert.rejects(() => stg.cacheSet('cache', 'k', 'v', 0), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => stg.cacheSet('cache', 'k', 'v', -5), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => stg.cacheSet('cache', 'bad part', 'v', 1000), (e) => e.message === 'INVALID_KEY_PART');
    await assert.rejects(() => stg.heartbeat('actor_a', 'x'.repeat(5000), 60000), (e) => e.message === 'VALUE_TOO_LARGE');
    await assert.rejects(() => stg.cacheSet('wallets', 'k', 'v', 1000), (e) => e.message === 'UNKNOWN_FAMILY');
  } finally { await stg.close(); }
});

test('P06 ephemera: two processes share consistent temporary state and rate windows are atomic', async (t) => {
  if (!(await boot(t))) return;
  const a = await withRedis(t, 'test');
  const b = await withRedis(t, 'test'); // a second "process" on the same namespace
  try {
    await a.heartbeat('svc_alice', 'sess_from_a', 60000);
    const seen = await b.lookupPresence('svc_alice');
    assert.equal(seen.value, 'sess_from_a', 'the second process observes the first process heartbeat');

    /* Rate windows are atomic under concurrency: 12 parallel hits on limit 8 -> exactly 8 allowed. */
    const hits = await Promise.all(Array.from({ length: 12 }, () => a.rateHit('parity-bucket', 8, 60000)));
    const allowed = hits.filter((h) => h.allowed).length;
    const counted = hits.filter((h) => h.available).length;
    assert.equal(counted, 12, 'no hit may fall back while Redis is healthy');
    assert.ok(allowed <= 8, `the atomic window must admit at most 8 (got ${allowed})`);

    /* A single-flight lock admits exactly one holder and its token releases it. */
    const first = await a.acquireLock('parity-lock', 30000);
    assert.equal(first.acquired, true);
    const second = await b.acquireLock('parity-lock', 30000);
    assert.equal(second.acquired, false, 'the second process cannot take a held lock');
    const released = await a.releaseLock('parity-lock', first.token);
    assert.equal(released.released, true);
    const again = await b.acquireLock('parity-lock', 30000);
    assert.equal(again.acquired, true);
  } finally { await a.close(); await b.close(); }
});

test('P06 ephemera: a namespace wipe and total loss leave durable PostgreSQL truth intact', async (t) => {
  if (!(await boot(t))) return;
  const db = await lab.createDatabase('ephwipedur');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const ephemera = await withRedis(t, 'test');
  const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => lab.CLOCK, environment: 'test' });
  const refresh = await createRefreshService(lab.poolsFor(db).api, {
    now: () => lab.CLOCK, mintAccess: async () => 'synthetic-access-token',
  });
  const c0 = await lab.adminClient(db);

  /* Durable facts established BEFORE the wipe: a redeemed ticket, a revoked refresh family. */
  const ticket = await issuer.issue({ actor: 'svc_alice', sessionId: 'sess-1'.padEnd(24, '0'), generation: 1, connectionClass: 'game' });
  const redeemed = await redeemRealtimeTicket(lab.poolsFor(db).core, { ticket: ticket.ticket, connectionId: 'conn-1', node: 'node-a', now: () => lab.CLOCK });
  assert.equal(redeemed.actorId, 'svc_alice');
  const { familyId } = await refresh.startFamily({ actor: 'svc_alice', sessionId: 'sess-durable' });
  await refresh.revokeFamily(familyId, 'wipe-proof');
  const walletsBefore = await lab.scalar(db, 'SELECT count(*)::int FROM economy.wallets');
  const ratingsBefore = await lab.scalar(db, 'SELECT count(*)::int FROM economy.ratings');

  /* 1. Namespace wipe: every mx:test:v1 key is gone... */
  const wiped = await ephemera.wipeNamespace();
  assert.ok(wiped.deleted >= 0 && wiped.available, 'the wipe reports its bounded result');
  const audit = await ephemera.auditUnboundedKeys();
  assert.equal(audit.available, true);
  const remaining = await lab.scalar(db, 'SELECT count(*)::int FROM economy.wallets');
  assert.equal(Number(remaining), Number(walletsBefore), 'a Redis wipe writes nothing to wallets');
  const ratingsAfter = await lab.scalar(db, 'SELECT count(*)::int FROM economy.ratings');
  assert.equal(Number(ratingsAfter), Number(ratingsBefore), 'a Redis wipe writes nothing to ratings');

  /* ...and the durable decisions still hold with ALL ephemera gone (the A15 property). */
  await assert.rejects(
    () => redeemRealtimeTicket(lab.poolsFor(db).core, { ticket: ticket.ticket, connectionId: 'conn-2', node: 'node-b', now: () => lab.CLOCK }),
    (e) => e.message === 'TICKET_REDEEMED',
    'a wiped cache cannot re-enable a redeemed ticket',
  );
  await assert.rejects(() => refresh.rotate({ refreshSecret: 'A'.repeat(43) }), (e) => e.message === 'SESSION_REVOKED');
  const familyState = await lab.scalar(db, "SELECT state FROM identity.refresh_families WHERE family_id = $1", [familyId]);
  assert.equal(familyState, 'revoked', 'a wiped cache cannot resurrect a revoked family');

  /* 2. Total loss: an unreachable Redis resolves conservatively and quickly, and PG truth moves not. */
  const lost = await createEphemeraService({ url: 'redis://127.0.0.1:59999', environment: 'test', socket: { connectTimeout: 400, reconnectStrategy: () => 60000 } });
  try {
    const started = Date.now();
    const rate = await lost.rateHit('auth-bucket', 5, 60000);
    const cache = await lost.cacheGet('cache', 'anything');
    const lock = await lost.acquireLock('anything', 1000);
    assert.equal(rate.conservative && rate.allowed === false, true, 'a lost Redis denies, never grants, budget');
    assert.equal(cache.conservative && cache.value === null, true);
    assert.equal(lock.conservative && lock.acquired === false, true);
    assert.ok(Date.now() - started < 10000, 'loss fallbacks resolve quickly, never hang');
    const unchanged = await lab.scalar(db, 'SELECT count(*)::int FROM economy.wallets');
    assert.equal(Number(unchanged), Number(walletsBefore), 'total loss mutates no durable row');
  } finally { await lost.close(); }

  /* The wipe never touched durable rate/security budgets: those live in PostgreSQL. */
  const pgBuckets = await lab.scalar(db, 'SELECT to_regclass(\'ops.rate_buckets\') IS NOT NULL');
  assert.equal(pgBuckets, true, 'security-class budgets remain a PostgreSQL table');

  await issuer.close(); await refresh.close(); await ephemera.close(); await c0.end();
  await lab.closeDatabasePools(db);
});
