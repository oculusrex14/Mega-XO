'use strict';
/* P06 ephemera verification on a REAL Redis: namespaced bounded primitives, cross-PROCESS
 * consistency from genuinely separate OS processes, conservative total-loss fallbacks and the wipe
 * contract (V5-06-02/03/04).
 *
 * Redis-path tests require REDIS_URL (default is the owned loopback instance) and are skipped when
 * absent - CI supplies a real Redis service container and enforces zero skips there. The PostgreSQL
 * "truth survives" assertions require the owned PG lab and are skipped with it.
 *
 * The former "two processes" test used two clients inside ONE process; that proves nothing about
 * cross-process coordination. Here two/three REAL Node processes (distinct PIDs, distinct event
 * loops, a private IPC channel) drive the same service against the same Redis. Wallet/rank/
 * purchase/ticket truth is NEVER written to Redis, and the wipe tests assert the durable rows are
 * content-identical (canonical digests) across a namespace wipe and a total loss - not merely that
 * a count did not change.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createTicketIssuer, redeemRealtimeTicket } = require('../packages/services/tickets.js');
const { createRefreshService } = require('../packages/services/refresh.js');
const { createCommerceService } = require('../packages/services/commerce.js');
const { launchEphemeraProcess } = require('./helpers/v5-ephemera-process.js');

lab.installCleanup(test);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
/* The owned loopback convenience URL is plaintext; a managed endpoint is `rediss://`. The service
 * refuses an un-opted-in plaintext URL, so these tests opt in exactly as the application must. */
const redisOptions = (environment, extra = {}) => ({
  url: REDIS_URL,
  environment,
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
  ...extra,
});
const serviceFor = async (environment, extra = {}) => {
  const service = await createEphemeraService(redisOptions(environment, extra));
  assert.equal(await service.healthy(), true, 'the owned Redis must answer PING');
  return service;
};
const childOptions = () => ({ allowPlaintext: !REDIS_URL.startsWith('rediss://'), socket: { connectTimeout: 3000 } });

const children = [];
const launch = async (extra = {}) => {
  const proc = await launchEphemeraProcess({ url: REDIS_URL, environment: 'test', options: childOptions(), ...extra });
  children.push(proc);
  return proc;
};

test.after(async () => {
  for (const proc of children) if (!proc.exited) proc.kill();
  /* Only clean a namespace we actually own (an explicit REDIS_URL). The default loopback URL is a
   * local convenience, not an owned fixture. */
  if (!process.env.REDIS_URL) return;
  try {
    const service = await createEphemeraService(redisOptions('test'));
    await service.wipeNamespace();
    await service.close();
  } catch { /* no Redis: nothing to clean */ }
});

/* Content snapshot of every durable table the wipe may never disturb, read as canonical rows so
 * the comparison is by content, not by count. */
const DURABLE_TABLES = [
  'economy.wallets', 'economy.ratings', 'economy.ledger',
  'monetization.receipts', 'monetization.reward_tickets', 'monetization.reward_events', 'monetization.casual_rewards',
  'identity.refresh_families', 'identity.refresh_tokens', 'identity.realtime_tickets',
];
const durableSnapshot = async (database) => {
  const admin = await lab.adminClient(database);
  try {
    const snapshot = {};
    for (const table of DURABLE_TABLES) {
      const result = await admin.query(`SELECT row_to_json(t) AS record FROM ${table} t ORDER BY row_to_json(t)::text COLLATE "C"`);
      snapshot[table] = result.rows.map((row) => row.record);
    }
    return snapshot;
  } finally { await admin.end(); }
};
const digestOf = (snapshot) => crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

test('P06 ephemera: every write is namespaced, bounded by an explicit TTL, and env-separated', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async () => {
  const stg = await serviceFor('stg');
  const prd = await serviceFor('prd');
  try {
    await stg.presenceTouch('actor_a', 'sess_1', true, 60000);
    await stg.cacheSet('cache', 'k', 'v', 60000);
    await stg.setHint('revoked', 'sess_1', 60000);
    await stg.enqueueCandidate('casual', 'ticket_1', 0, { windowMs: 600000, keyTtlMs: 600000 });
    const audit = await stg.auditUnboundedKeys();
    assert.equal(audit.available, true);
    assert.deepEqual(audit.unbounded, [], 'no immortal mx: keys may exist after writes');
    assert.deepEqual((await stg.peekCandidates('casual')).candidates, ['ticket_1']);
    assert.equal((await stg.dropCandidate('casual', 'ticket_1')).dropped, true);

    /* Environment separation: a prd-named client cannot see a stg key and vice versa. */
    await prd.cacheSet('cache', 'survivor', 'prd-keep', 60000);
    const prdView = await prd.presenceRead('actor_a');
    assert.deepEqual(prdView.sessions, [], 'a different environment must not see the presence');
    await prd.cacheSet('cache', 'k', 'prd-value', 60000);
    assert.notEqual((await stg.cacheGet('cache', 'k')).value, 'prd-value', 'cross-environment cache reads are impossible');

    /* TTLs actually expire. */
    await stg.cacheSet('cache', 'short', 'x', 60);
    await lab.sleep(120);
    assert.equal((await stg.cacheGet('cache', 'short')).value, null, 'a 60 ms entry must expire');

    /* A wipe deletes ONLY the caller's namespace: an unrelated environment's key survives. */
    const wiped = await stg.wipeNamespace();
    assert.equal(wiped.available, true, 'the wipe reports its bounded result');
    assert.ok(wiped.deleted >= 1, 'the wipe deleted this environment keys');
    assert.deepEqual((await stg.presenceRead('actor_a')).sessions, [], 'the stg presence is gone');
    assert.equal((await prd.cacheGet('cache', 'survivor')).value, 'prd-keep', 'an unrelated environment namespace is untouched');
    await prd.wipeNamespace();

    /* Refusals: no TTL, bad parts, oversize values, unknown family. A space-bearing part is a VALID
     * durable text id under the P06 key contract; a genuinely invalid part (empty) is used here. */
    await assert.rejects(() => stg.cacheSet('cache', 'k', 'v', 0), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => stg.cacheSet('cache', 'k', 'v', -5), (e) => e.message === 'TTL_REQUIRED');
    await assert.rejects(() => stg.cacheSet('cache', '', 'v', 1000), (e) => e.message === 'INVALID_KEY_PART');
    await assert.rejects(() => stg.cacheSet('cache', 'k', 'x'.repeat(5000), 1000), (e) => e.message === 'VALUE_TOO_LARGE');
    await assert.rejects(() => stg.cacheSet('wallets', 'k', 'v', 1000), (e) => e.message === 'UNKNOWN_FAMILY');
  } finally { await stg.close(); await prd.close(); }
});

test('P06 ephemera: real separate processes share presence/cache/route/pubsub and the rate window admits exactly 8 of 12', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  const a = await launch({ subscribeChannel: 'bus-x' });
  const b = await launch();
  t.after(() => { a.kill(); b.kill(); });

  assert.notEqual(a.pid, b.pid, 'the two workers are distinct OS processes');
  assert.notEqual(a.pid, process.pid, 'the workers are not the test process');
  assert.equal(a.subscribeAvailable, true, 'the subscriber process subscribed on real Redis');
  assert.equal(a.fatal, null);

  /* Cross-process presence, cache and routing: B reads facts A committed. */
  await a.call('presenceTouch', ['proc_alpha', 'sess-A', true, 60000]);
  assert.deepEqual((await b.call('presenceRead', ['proc_alpha'])).sessions.map((s) => s.ref), ['sess-A'], 'process B observes process A presence touch');
  await a.call('cacheSet', ['cache', 'shared', 'v-from-A', 60000]);
  assert.equal((await b.call('cacheGet', ['cache', 'shared'])).value, 'v-from-A', 'process B reads process A cache value');
  await a.call('registerRoute', ['conn-A', '{"node":"n1"}', 30000]);
  assert.equal((await b.call('locateRoute', ['conn-A'])).value, '{"node":"n1"}', 'process B resolves process A route');

  /* Cross-process publish/subscribe on a real subscription. */
  await b.call('publish', ['bus-x', 'hello-from-B', 30000]);
  const event = await a.waitForEvent((e) => e.channel === 'bus-x' && e.message === 'hello-from-B');
  assert.equal(event.message, 'hello-from-B', 'the subscriber process received the publisher process message');

  /* Atomic cross-process rate window: 6 hits in each of two processes, fired at one shared
   * wall-clock instant, on a limit of 8 -> exactly 8 admitted, 4 denied, none falling back. */
  const bucket = 'x-' + crypto.randomBytes(4).toString('hex');
  const startAt = Date.now() + 400;
  const [ra, rb] = await Promise.all([
    a.rateConcurrent({ bucket, limit: 8, windowMs: 60000, count: 6, startAt }),
    b.rateConcurrent({ bucket, limit: 8, windowMs: 60000, count: 6, startAt }),
  ]);
  assert.equal(ra.unavailable + rb.unavailable, 0, 'no hit may fall back while Redis is healthy');
  assert.equal(ra.allowed + rb.allowed, 8, `the atomic window must admit exactly 8 of 12 (got ${ra.allowed + rb.allowed})`);
  assert.equal(ra.denied + rb.denied, 4, 'the remaining 4 hits are denied');

  /* Lock fencing across processes: only one owner, and a STALE owner cannot release a NEW owner's
   * lock after the first lease expired. */
  const first = await a.call('acquireLock', ['fence-lock', 1500]);
  assert.equal(first.acquired, true);
  assert.equal((await b.call('acquireLock', ['fence-lock', 1500])).acquired, false, 'the second process cannot take a held lock');
  await lab.sleep(1800);
  const second = await b.call('acquireLock', ['fence-lock', 60000]);
  assert.equal(second.acquired, true, 'after the lease expires the lock is free again');
  assert.equal((await a.call('releaseLock', ['fence-lock', first.token])).released, false, 'a stale owner cannot release the new owner lock');
  assert.equal((await b.call('acquireLock', ['fence-lock', 60000])).acquired, false, 'the new owner lock is untouched by the stale release');
  assert.equal((await b.call('releaseLock', ['fence-lock', second.token])).released, true, 'the true owner releases its own lock');
  assert.equal((await a.call('acquireLock', ['fence-lock', 60000])).acquired, true, 'the released lock is acquirable again');

  /* Both processes close with live connections (A still owning its subscription) and exit on their
   * own: natural exit is the proof that close() released every socket, subscriber and timer. */
  assert.deepEqual(await a.shutdown(), { code: 0, signal: null }, 'the subscriber process exits naturally after close');
  assert.deepEqual(await b.shutdown(), { code: 0, signal: null }, 'the worker process exits naturally after close');
});

test('P06 ephemera: a namespace wipe and total loss leave durable PostgreSQL truth content-identical', { skip: !HAVE_PG ? 'no V5_PG_URL' : (!HAVE_REDIS ? 'no REDIS_URL' : false) }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('ephwipedur');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const ephemera = await serviceFor('test');
  await ephemera.wipeNamespace();
  const issuer = await createTicketIssuer(lab.poolsFor(db).api, { now: () => lab.CLOCK, environment: 'test' });
  const refresh = await createRefreshService(lab.poolsFor(db).api, {
    now: () => lab.CLOCK, mintAccess: async () => 'synthetic-access-token',
  });
  const commerce = await createCommerceService(lab.poolsFor(db).core, {
    now: () => lab.CLOCK, purchasesEnabled: true, eligible: () => true,
    verifyPurchase: async (evidence, actor) => ({
      valid: true, accountId: actor, store: evidence.store, transactionId: evidence.transactionId,
      productId: evidence.productId, refunded: false,
    }),
  });

  /* Durable facts established BEFORE the wipe: a redeemed ticket, a revoked refresh family and a
   * verified store purchase (all authoritative in PostgreSQL, never in Redis). */
  const ticket = await issuer.issue({ actor: 'svc_alice', sessionId: 'sess-1'.padEnd(24, '0'), generation: 1, connectionClass: 'game' });
  const redeemed = await redeemRealtimeTicket(lab.poolsFor(db).core, { ticket: ticket.ticket, connectionId: 'conn-1', node: 'node-a', now: () => lab.CLOCK });
  assert.equal(redeemed.actorId, 'svc_alice');
  const { familyId } = await refresh.startFamily({ actor: 'svc_alice', sessionId: 'sess-durable' });
  await refresh.revokeFamily(familyId, 'wipe-proof');
  const grant = await commerce.purchase('svc_alice', 'p06-buy-1', { store: 'google', productId: 'crowns_100', transactionId: 'p06-tx-1', purchaseToken: 'tok-p06' });
  assert.equal(grant.crowns, 100);

  /* Populate genuine ephemeral state, then prove the wipe actually removed it. */
  await ephemera.presenceTouch('svc_alice', 'sess-ephemeral', true, 60000);
  await ephemera.cacheSet('cache', 'offer', 'ephemeral', 60000);
  await ephemera.setHint('revoked', 'sess-hint', 60000);
  await ephemera.registerRoute('conn-eph', '{"node":"n1"}', 60000);
  await ephemera.enqueueCandidate('ranked', 'ticket-eph', 0, { windowMs: 600000, keyTtlMs: 600000 });
  assert.deepEqual((await ephemera.presenceRead('svc_alice')).sessions.map((s) => s.ref), ['sess-ephemeral']);
  assert.deepEqual((await ephemera.peekCandidates('ranked')).candidates, ['ticket-eph']);

  const before = await durableSnapshot(db);

  /* 1. Namespace wipe: every mx:test:v2 key is gone, the durable content is byte-identical, and the
   * durable decisions still hold with ALL ephemera gone (the A15 property). */
  const wiped = await ephemera.wipeNamespace();
  assert.equal(wiped.available, true, 'the wipe reports its bounded result');
  assert.ok(wiped.deleted >= 1, 'the wipe deleted the populated ephemeral keys');
  const audit = await ephemera.auditUnboundedKeys();
  assert.equal(audit.available, true);
  assert.deepEqual(audit.unbounded, []);
  assert.deepEqual((await ephemera.presenceRead('svc_alice')).sessions, [], 'presence is gone after the wipe');
  assert.equal((await ephemera.cacheGet('cache', 'offer')).value, null, 'cache is gone after the wipe');
  assert.equal((await ephemera.checkHint('revoked', 'sess-hint')).present, false, 'hint is gone after the wipe');
  assert.equal((await ephemera.locateRoute('conn-eph')).value, null, 'route is gone after the wipe');
  assert.deepEqual((await ephemera.peekCandidates('ranked')).candidates, [], 'queue is gone after the wipe');

  const afterWipe = await durableSnapshot(db);
  assert.equal(digestOf(afterWipe), digestOf(before), 'the durable content is byte-identical across the namespace wipe');

  await assert.rejects(
    () => redeemRealtimeTicket(lab.poolsFor(db).core, { ticket: ticket.ticket, connectionId: 'conn-2', node: 'node-b', now: () => lab.CLOCK }),
    (e) => e.message === 'TICKET_REDEEMED',
    'a wiped cache cannot re-enable a redeemed ticket',
  );
  await assert.rejects(() => refresh.rotate({ refreshSecret: 'A'.repeat(43) }), (e) => e.message === 'SESSION_REVOKED');
  assert.equal(await lab.scalar(db, 'SELECT state FROM identity.refresh_families WHERE family_id = $1', [familyId]), 'revoked', 'a wiped cache cannot resurrect a revoked family');
  assert.equal(Number(await lab.scalar(db, "SELECT count(*)::int FROM monetization.receipts WHERE store = 'google' AND transaction_id = 'p06-tx-1'")), 1, 'the purchase receipt survives the wipe');

  /* A wiped client can rejoin: the ephemeral state is rebuildable from a fresh per-session touch/queue join. */
  await ephemera.presenceTouch('svc_alice', 'sess-rejoined', true, 60000);
  await ephemera.enqueueCandidate('ranked', 'ticket-rejoin', 0, { windowMs: 600000, keyTtlMs: 600000 });
  assert.deepEqual((await ephemera.presenceRead('svc_alice')).sessions.map((s) => s.ref), ['sess-rejoined'], 'a client recovers its presence after the wipe');
  assert.deepEqual((await ephemera.peekCandidates('ranked')).candidates, ['ticket-rejoin'], 'a client recovers its queue position after the wipe');

  /* 2. Total loss: an unreachable Redis resolves conservatively and bounded for EVERY operation,
   * and the durable content is still byte-identical. */
  const lost = await createEphemeraService({ url: 'redis://127.0.0.1:59999', environment: 'test', allowPlaintext: true, socket: { connectTimeout: 400, reconnectStrategy: () => 60000 } });
  try {
    const started = Date.now();
    const rate = await lost.rateHit('auth-bucket', 5, 60000);
    const cache = await lost.cacheGet('cache', 'anything');
    const lock = await lost.acquireLock('anything', 1000);
    const wipe = await lost.wipeNamespace();
    const lostAudit = await lost.auditUnboundedKeys();
    const lostSub = await lost.subscribe('bus-z', () => {});
    assert.equal(rate.conservative && rate.allowed === false, true, 'a lost Redis denies, never grants, budget');
    assert.equal(cache.conservative && cache.value === null, true);
    assert.equal(lock.conservative && lock.acquired === false, true);
    assert.deepEqual(wipe, { deleted: 0, available: false }, 'a lost wipe is conservative');
    assert.deepEqual(lostAudit, { unbounded: [], available: false }, 'a lost audit is conservative');
    assert.equal(lostSub.available, false, 'a lost subscription is conservative');
    assert.ok(Date.now() - started < 10000, 'loss fallbacks resolve quickly, never hang');
    const afterLoss = await durableSnapshot(db);
    assert.equal(digestOf(afterLoss), digestOf(before), 'total loss mutates no durable content');
  } finally { await lost.close(); }

  await issuer.close(); await refresh.close(); await ephemera.close();
  await lab.closeDatabasePools(db);
});
