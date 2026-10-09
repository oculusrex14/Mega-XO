'use strict';
/* tests/v5-p10-provider.test.js - V5 P10 task V5-10-03 (extract provider notification and
 * finalization work).
 *
 * SCOPE. Exercises `packages/services/provider-workflows.js`
 * (`createProviderWorkflow({ pool, now, defaultLeaseMs, maxAttempts, backoffBaseMs })`) against a REAL
 * owned PostgreSQL 16 database built by the REAL checksummed migration chain (`tests/v5-pg-lab.js`).
 * The workflow drains `monetization.store_notifications` (the durable provider-callback dedupe state
 * machine, migration 0015), `monetization.store_finalize` (the Google consume/acknowledge retry
 * machine, 0015) and records `monetization.store_revocations`; every assertion reads the COMMITTED
 * PostgreSQL row back through a superuser probe. No SQLite, no mock, no fake provider, no in-memory
 * mirror.
 *
 * WHAT IS PROVEN (the five behaviours the task requires):
 *
 *   1. INGEST DEDUPE. A provider callback is persisted once per `(store, notification_id)`; a
 *      redelivery returns `{ ingested: false }`, leaves exactly one row and never re-arms the attempt
 *      counter - including after the first copy was already applied.
 *   2. FINALIZE ONLY AFTER THE DURABLE GRANT. `completeFinalization` verifies the committed
 *      `monetization.receipts` row FIRST: with no grant it calls the provider ZERO times and backs the
 *      row off (or abandons it past 24h); once the grant row exists the very next claim invokes the
 *      provider exactly once and lands `state='done'` with the `purchase_token` sealed to ''.
 *   3. NEVER REMINT. `handlePurchaseNotification` dedupes against the committed receipt, so a
 *      duplicate or out-of-order/retried purchase callback for an already-granted transaction returns
 *      `duplicate` and never invokes `grantFn` a second time.
 *   4. REFUND / REVOCATION. `handleRefundNotification` writes the permanent tombstone in
 *      `monetization.store_revocations` and drives the Core refund seam (`revokeFn`), which flags
 *      `monetization.receipts.refunded`; a refunded receipt then blocks a consume/ack provider call.
 *   5. RECOVERABLE PENDING FINALIZATION. A finalizer that dies mid-lease leaves a `pending` row that is
 *      VISIBLE (`listPendingFinalizations`) and is reclaimed by a peer only after the lease lapses,
 *      with a HIGHER fence, and then completes.
 *
 * Plus the notification lease machine itself (claim -> applied / retry) with the same fence rule: a
 * stale owner cannot apply a callback a newer worker has taken over, and a failed callback returns to
 * `retry` with a bounded (<= 280 char) sanitized error and a growing backoff.
 *
 * CLOCK. The service clock is injected (`now: () => clock`); every due/lease/backoff comparison binds
 * that instant, so advancing the clock IS the lease expiring and IS the backoff elapsing. Nothing here
 * waits on wall time.
 *
 * GATING (the repo convention): needs the owned PostgreSQL lab (`V5_PG_URL`, or `V5_PG_REQUIRED=1` to
 * fail instead of skip). Absent it every test skips. Teardown is `lab.installCleanup` (guarded pools
 * closed, owned databases dropped) plus a per-test `t.after` that closes the workflow; the process
 * exits naturally - no force-exit, no `process.exit`.
 *
 * Run: node --test --test-concurrency=1 tests/v5-p10-provider.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');

/* Close every guarded pool and drop every owned database, AFTER this suite's own `t.after` closes the
 * workflow instances. Natural process exit: no forceExit, no explicit process.exit. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

const CLOCK = lab.CLOCK;
const DAY = lab.DAY;

const STORE = 'google';
const OTHER_STORE = 'apple';
const ALICE = 'svc_alice';
const PRODUCT = 'crowns_100';
/* Two workers with genuinely different identities: a fence is only meaningful between distinct owners. */
const WORKER_A = 'worker:provider-a';
const WORKER_B = 'worker:provider-b';

/* The provider-workflows module is loaded lazily, so a checkout without the P10 module skips (rather
 * than throwing at require time) when the gate is unset. */
let providerFactory = null;
function loadFactory() {
 if (!providerFactory) {
  const mod = require('../packages/services/provider-workflows.js');
  assert.equal(typeof mod.createProviderWorkflow, 'function',
   'packages/services/provider-workflows.js must export createProviderWorkflow');
  providerFactory = mod.createProviderWorkflow;
 }
 return providerFactory;
}

/* Every entry point the suite drives must exist and be a function before a gated case may run: an
 * absent method is a hard failure on a gated checkout, never a silently passing skip. */
const METHODS = Object.freeze(['ingestNotification', 'claimDueNotifications', 'completeNotification',
 'failNotification', 'enqueueFinalization', 'claimDueFinalizations', 'completeFinalization',
 'handlePurchaseNotification', 'handleRefundNotification', 'listPendingFinalizations', 'close']);
function requireMethods(service) {
 const bound = {};
 for (const name of METHODS) {
  assert.equal(typeof service[name], 'function', `the provider workflow must expose ${name}()`);
  bound[name] = service[name].bind(service);
 }
 return bound;
}

/* A `timestamptz` read back from PostgreSQL surfaces as a Date; a service return may hand back an ISO
 * string or an epoch number. All three name ONE instant, so it is normalized to epoch milliseconds. */
function msOf(value, what) {
 const ms = value instanceof Date ? value.getTime()
  : typeof value === 'number' ? value
   : typeof value === 'string' ? Date.parse(value) : NaN;
 assert.ok(Number.isFinite(ms), `expected a real millisecond ${what} (saw ${String(value)})`);
 return ms;
}
const numOrNull = (value) => (value === undefined || value === null ? null : Number(value));
/* The durable ROW is asserted with exact column names; a value the service RETURNS may name the same
 * fact in camelCase or snake_case, so a returned field is read tolerantly and never invented. */
function pick(row, ...names) {
 if (!row || typeof row !== 'object') return undefined;
 for (const name of names) if (row[name] !== undefined && row[name] !== null) return row[name];
 return undefined;
}

/* One owned database, its guarded worker/core pools, one live workflow bound to the worker pool and a
 * controllable clock. `t.after` closes the service; the pool is caller-owned and outlives it (the lab
 * closes every borrowed pool only after this suite's own teardown). */
let dbSeq = 0;
async function open(t) {
 if (!(await lab.boot(t))) return null;
 const create = loadFactory();
 const database = await lab.createDatabase(`p10p${dbSeq++}`);
 const pools = lab.poolsFor(database);
 let clock = CLOCK;
 const now = () => clock;
 const service = create({ pool: pools.worker, now });
 t.after(async () => { try { await service.close(); } catch { /* best effort */ } });
 const methods = requireMethods(service);
 /* A superuser statement for harness-only durable probes and fixture writes; nothing a runtime role
  * does. The receipt a grant COMMITTED is written by the Core seam, and the probes read the same rows. */
 const exec = async (text, params = []) => {
  const client = await lab.adminClient(database);
  try { return await client.query(text, params); } finally { await client.end(); }
 };
 const one = async (text, params) => (await exec(text, params)).rows[0] ?? null;
 return {
  database, pools, ...methods, exec, now,
  advance: (ms) => { clock += ms; return clock; },
  notification: (store, id) => one('SELECT store, notification_id, received_at, state, attempts,'
   + ' next_at, processed_at, last_error, lease_owner, lease_token, lease_until'
   + ' FROM monetization.store_notifications WHERE store = $1 AND notification_id = $2', [store, id]),
  finalize: (store, tx) => one('SELECT store, transaction_id, product_id, purchase_token, kind, state,'
   + ' attempts, next_at, created_at, updated_at, lease_owner, lease_token, lease_until'
   + ' FROM monetization.store_finalize WHERE store = $1 AND transaction_id = $2', [store, tx]),
  receipt: (store, tx) => one('SELECT store, transaction_id, actor_id, product_id, crowns, refunded,'
   + ' purchased_at FROM monetization.receipts WHERE store = $1 AND transaction_id = $2', [store, tx]),
  revocation: (store, tx) => one('SELECT store, transaction_id, product_id, occurred_at, reason'
   + ' FROM monetization.store_revocations WHERE store = $1 AND transaction_id = $2', [store, tx]),
  count: async (text, params) => Number((await one(text, params)).n),
  /* A durable Core grant, exactly the row the Core purchase command commits. */
  grant: (store, tx, actor = ALICE, product = PRODUCT, crowns = 100, refunded = false, at = CLOCK) =>
   exec('INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns,'
    + ' refunded, purchased_at) VALUES ($1, $2, $3, $4, $5, $6, $7)'
    + ' ON CONFLICT (store, transaction_id) DO NOTHING',
    [store, tx, actor, product, crowns, refunded, new Date(at)]),
 };
}

/* A recording provider edge: the consume/acknowledge HTTP call the worker would make, replaced by the
 * exact argument object the contract names. Every call is kept so the test can assert the call did NOT
 * happen (the whole point of "finalize only after durable grant"). */
function recordingProvider() {
 const calls = [];
 const finalize = async (request) => { calls.push(request); return { ok: true }; };
 finalize.calls = calls;
 return finalize;
}
const txOf = (row) => pick(row, 'transactionId', 'transaction_id');
const idOf = (row) => pick(row, 'notificationId', 'notification_id', 'id');
const fenceOf = (row) => numOrNull(pick(row, 'fence', 'leaseToken', 'lease_token'));

/* ============ 1. ingest dedupe: one row per (store, notification_id) ============ */

test('V5-10-03 ingest: a provider callback is persisted once per (store, notification_id) and a redelivery dedupes', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = 'rtdn:msg-1';

 const first = await h.ingestNotification({ store: STORE, notificationId: id });
 assert.equal(first.ingested, true, 'the first callback is ingested');
 assert.equal(idOf(first), id, 'the ingest reports the notification id it persisted');
 const row = await h.notification(STORE, id);
 assert.ok(row, 'ingestNotification writes the durable store_notifications row');
 assert.equal(row.state, 'pending', 'a fresh callback is pending');
 assert.equal(Number(row.attempts), 0, 'a fresh callback has no attempts');
 assert.equal(row.lease_owner, null, 'a fresh callback holds no lease');
 assert.equal(row.processed_at, null, 'a fresh callback is not processed');
 assert.equal(msOf(row.received_at, 'received_at'), CLOCK, 'the injected clock stamps received_at');
 assert.equal(msOf(row.next_at, 'next_at'), CLOCK, 'a fresh callback is due immediately');

 const again = await h.ingestNotification({ store: STORE, notificationId: id });
 assert.equal(again.ingested, false, 'a redelivered callback is NOT ingested a second time');
 assert.equal(idOf(again), id, 'the dedupe still names the notification id');
 assert.equal(await h.count('SELECT count(*)::int n FROM monetization.store_notifications'
  + ' WHERE store = $1 AND notification_id = $2', [STORE, id]), 1,
  'ON CONFLICT (store, notification_id) DO NOTHING leaves exactly one row');
 assert.equal(Number((await h.notification(STORE, id)).attempts), 0, 'a redelivery never re-arms attempts');

 /* Once the callback has been APPLIED, a replay must neither re-ingest nor reset the applied row. The
  * claim below is asserted BEFORE the neighbouring fixtures exist, so the only due row is this one and
  * 'exactly one' is a deterministic statement about the claim, not about the batch order. */
 const claimed = await h.claimDueNotifications({ workerId: WORKER_A, limit: 16, leaseMs: 1000 });
 assert.equal(claimed.length, 1, 'only the due callback is claimed');
 assert.equal(idOf(claimed[0]), id, 'the claim names the callback under test');
 await h.completeNotification({ store: STORE, notificationId: id, workerId: WORKER_A, fence: fenceOf(claimed[0]) });
 const applied = await h.notification(STORE, id);
 assert.equal(applied.state, 'applied', 'the claimed callback was applied');
 const replay = await h.ingestNotification({ store: STORE, notificationId: id });
 assert.equal(replay.ingested, false, 'a redelivery after the callback was applied is still deduped');
 const after = await h.notification(STORE, id);
 assert.equal(after.state, 'applied', 'the deduped replay never resets an applied row');
 assert.equal(Number(after.attempts), 1, 'the deduped replay never resets the attempt history');

 /* The provider identity is (store, notification_id): the same message id from the other store is a
  * DIFFERENT callback and must be stored on its own. */
 const otherStore = await h.ingestNotification({ store: OTHER_STORE, notificationId: id });
 assert.equal(otherStore.ingested, true, 'the dedupe key includes the store');
 assert.equal(await h.count('SELECT count(*)::int n FROM monetization.store_notifications'
  + ' WHERE notification_id = $1', [id]), 2, 'both stores hold their own notification row');

 /* An explicit received_at (a delayed provider delivery) is stored verbatim, not replaced by now. */
 const delayed = await h.ingestNotification({ store: STORE, notificationId: 'rtdn:msg-late', receivedAt: CLOCK - 5000 });
 assert.equal(delayed.ingested, true);
 assert.equal(msOf((await h.notification(STORE, 'rtdn:msg-late')).received_at, 'received_at'), CLOCK - 5000,
  'an explicit receivedAt is stored as given');
});

/* ============ 2. the notification lease machine: claim, fence, apply, retry ============ */

test('V5-10-03 notifications: a claimed callback is leased, a stale owner cannot apply it, and a failure retries with a bounded error', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = 'rtdn:msg-claim';
 await h.ingestNotification({ store: STORE, notificationId: id });

 const first = await h.claimDueNotifications({ workerId: WORKER_A, limit: 16, leaseMs: 1000 });
 assert.equal(first.length, 1, 'the due callback is claimed');
 assert.equal(idOf(first[0]), id, 'the claim names the notification id');
 assert.equal(Number(pick(first[0], 'attempts')), 1, 'claiming counts the first attempt');
 const firstFence = fenceOf(first[0]);
 assert.ok(firstFence >= 1, 'the first claim mints a fence');
 const leased = await h.notification(STORE, id);
 assert.equal(leased.state, 'processing', 'a claimed callback is in flight');
 assert.equal(leased.lease_owner, WORKER_A, 'the lease is owned by the claiming worker');
 assert.equal(Number(leased.lease_token), firstFence, 'the durable row records the fence the claim returned');
 assert.equal(msOf(leased.lease_until, 'lease_until'), CLOCK + 1000, 'the requested lease window is honoured');

 assert.equal((await h.claimDueNotifications({ workerId: WORKER_B, limit: 16, leaseMs: 1000 })).length, 0,
  'a live lease cannot be stolen before it expires');

 /* Worker A dies mid-processing: nothing applies, and the peer reclaims only AFTER the lease lapses,
  * with a strictly higher fence. */
 h.advance(1001);
 const second = await h.claimDueNotifications({ workerId: WORKER_B, limit: 16, leaseMs: 1000 });
 assert.equal(second.length, 1, 'the peer reclaims the callback after the lease expires');
 assert.equal(Number(pick(second[0], 'attempts')), 2, 'the crashed attempt is counted');
 assert.ok(fenceOf(second[0]) > firstFence, 'the reclaim mints a newer fence');

 assert.equal(await h.completeNotification({ store: STORE, notificationId: id, workerId: WORKER_A, fence: firstFence }), false,
  "the dead worker's stale fence is rejected");
 const still = await h.notification(STORE, id);
 assert.equal(still.state, 'processing', 'the rejected stale completion changes nothing');
 assert.equal(still.lease_owner, WORKER_B, 'the lease still belongs to the new owner');

 assert.equal(await h.completeNotification({ store: STORE, notificationId: id, workerId: WORKER_B, fence: fenceOf(second[0]) }), true,
  'the current owner with the current fence applies the callback');
 const applied = await h.notification(STORE, id);
 assert.equal(applied.state, 'applied', 'the applied state is durable');
 assert.equal(msOf(applied.processed_at, 'processed_at'), h.now(), 'an applied callback carries its processed_at');
 assert.equal(applied.lease_owner, null, 'application releases the lease owner');
 assert.equal(applied.lease_token, null, 'application clears the fence');

 /* A failed callback returns to `retry` with the lease cleared, a bounded sanitized error and a growing
  * backoff; it is not claimable before the backoff elapses. */
 const failing = 'rtdn:msg-fail';
 await h.ingestNotification({ store: STORE, notificationId: failing });
 const c1 = await h.claimDueNotifications({ workerId: WORKER_A, limit: 16, leaseMs: 1000 });
 assert.equal(c1.length, 1);
 assert.equal(idOf(c1[0]), failing);
 const failAt1 = h.now();
 await h.failNotification({
  store: STORE, notificationId: failing, workerId: WORKER_A, fence: fenceOf(c1[0]),
  error: 'google rtdn 503 ' + 'x'.repeat(400),
 });
 const r1 = await h.notification(STORE, failing);
 assert.equal(r1.state, 'retry', 'a failed callback returns to the retry state');
 assert.equal(r1.lease_owner, null, 'a failed callback releases its lease owner');
 assert.equal(r1.lease_token, null, 'a failed callback clears its fence');
 assert.equal(typeof r1.last_error, 'string', 'the failure records a sanitized diagnostic');
 assert.ok(r1.last_error.length <= 280, `the diagnostic is bounded to 280 characters (saw ${r1.last_error.length})`);
 const backoff1 = msOf(r1.next_at, 'next_at') - failAt1;
 assert.ok(backoff1 >= 1000, `the first retry waits at least one base interval (saw ${backoff1})`);
 assert.equal((await h.claimDueNotifications({ workerId: WORKER_B, limit: 16, leaseMs: 1000 })).length, 0,
  'a retry is not claimable before its backoff elapses');

 h.advance(backoff1 + 1);
 const c2 = await h.claimDueNotifications({ workerId: WORKER_B, limit: 16, leaseMs: 1000 });
 assert.equal(c2.length, 1, 'the retry is claimable once its backoff elapses');
 assert.equal(Number(pick(c2[0], 'attempts')), 2, 'the retry consumes a second attempt');
 const failAt2 = h.now();
 await h.failNotification({ store: STORE, notificationId: failing, workerId: WORKER_B, fence: fenceOf(c2[0]), error: 'again' });
 const backoff2 = msOf((await h.notification(STORE, failing)).next_at, 'next_at') - failAt2;
 assert.ok(backoff2 >= backoff1, `the retry delay never shrinks as attempts grow (${backoff1} -> ${backoff2})`);
});

/* ============ 3. finalize only after the durable grant ============ */

test('V5-10-03 finalize: Google consume/acknowledge runs only once the granted receipt is committed', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const tx = 'tx-grant';
 const token = 'purchase-token-grant';

 await h.enqueueFinalization({ store: STORE, transactionId: tx, productId: PRODUCT, purchaseToken: token, kind: 'consume' });
 const queued = await h.finalize(STORE, tx);
 assert.ok(queued, 'enqueueFinalization writes the durable store_finalize row');
 assert.equal(queued.state, 'pending', 'a fresh finalization is pending');
 assert.equal(Number(queued.attempts), 0, 'a fresh finalization has no attempts');
 assert.equal(queued.product_id, PRODUCT, 'the product id is stored verbatim');
 assert.equal(queued.purchase_token, token, 'the purchase token is stored for the provider call');
 assert.equal(queued.kind, 'consume', 'the finalize kind is stored verbatim');
 assert.equal(queued.lease_owner, null, 'a fresh finalization holds no lease');
 assert.equal(msOf(queued.next_at, 'next_at'), CLOCK, 'a fresh finalization is due immediately');
 assert.equal(msOf(queued.created_at, 'created_at'), CLOCK, 'the injected clock stamps created_at');

 /* Enqueue is an upsert keyed on (store, transaction_id): a replayed verify never duplicates the row.
  * The service reports a genuine INSERT; a refresh of the existing non-done row reports `enqueued:false`. */
 const replayEnqueue = await h.enqueueFinalization({ store: STORE, transactionId: tx, productId: PRODUCT, purchaseToken: token, kind: 'consume' });
 assert.equal(replayEnqueue.enqueued, false, 'a replayed verification refreshes the row and inserts nothing');
 assert.equal(replayEnqueue.state, 'pending', 'the refreshed row is still pending');
 assert.equal(await h.count('SELECT count(*)::int n FROM monetization.store_finalize WHERE store = $1 AND transaction_id = $2', [STORE, tx]), 1,
  'a replayed enqueue leaves exactly one finalization row');

 const first = await h.claimDueFinalizations({ workerId: WORKER_A, limit: 16, leaseMs: 1000 });
 assert.equal(first.length, 1, 'the due finalization is claimed');
 assert.equal(txOf(first[0]), tx, 'the claim names the transaction');
 assert.equal(Number(pick(first[0], 'attempts')), 1, 'claiming counts the first attempt');
 assert.ok(fenceOf(first[0]) >= 1, 'the first claim mints a fence');
 const leased = await h.finalize(STORE, tx);
 assert.equal(leased.lease_owner, WORKER_A, 'the lease is owned by the claiming worker');
 assert.equal(Number(leased.lease_token), fenceOf(first[0]), 'the durable row records the fence the claim returned');
 assert.notEqual(leased.state, 'done', 'claiming alone never finalizes');

 /* NO durable grant yet: the provider MUST NOT be called. */
 const provider = recordingProvider();
 const pending = await h.completeFinalization({ store: STORE, transactionId: tx, workerId: WORKER_A, fence: fenceOf(first[0]), finalizeProvider: provider });
 assert.equal(pending.completed, false, 'finalization without a granted receipt does not complete');
 assert.equal(pending.pendingGrant, true, 'it reports the missing durable grant');
 assert.equal(provider.calls.length, 0, 'the provider is NEVER called before the grant is committed');
 const backed = await h.finalize(STORE, tx);
 assert.notEqual(backed.state, 'done', 'a grant-less finalization never reaches done');
 assert.equal(backed.purchase_token, token, 'the token is retained for the later attempt');
 assert.ok(msOf(backed.next_at, 'next_at') >= CLOCK, 'the grant-less attempt is backed off, not retried in a hot loop');
 assert.equal((await h.claimDueFinalizations({ workerId: WORKER_B, limit: 16, leaseMs: 1000 })).length, 0,
  'a backed-off finalization is not claimable before its next_at');

 /* The Core grant commits (exactly the row monetization.receipts holds), and now the retry finalizes.
  * The advance clears any sane grant-less backoff (the legacy finalizer caps at 1h) while staying
  * strictly INSIDE the 24h abandonment window, so the retry path - not the abandonment path - is the
  * one exercised here. */
 h.advance(23 * 3600000);
 await h.grant(STORE, tx);
 const second = await h.claimDueFinalizations({ workerId: WORKER_B, limit: 16, leaseMs: 1000 });
 assert.equal(second.length, 1, 'the finalization is claimable once its backoff elapses');
 assert.equal(txOf(second[0]), tx);
 /* The grant-less attempt released the lease tuple, so this retry re-mints the token (the fence is a
  * lease-generation counter, not a per-row monotonic id: it only has to differ between CONCURRENT
  * owners). The durable row must carry the fence the claim returned. */
 assert.equal(Number((await h.finalize(STORE, tx)).lease_token), fenceOf(second[0]), 'the durable row records the retry fence');
 assert.equal(Number(pick(second[0], 'attempts')), 2, 'the retry consumes a second attempt');

 const done = await h.completeFinalization({ store: STORE, transactionId: tx, workerId: WORKER_B, fence: fenceOf(second[0]), finalizeProvider: provider });
 assert.equal(done.completed, true, 'a granted purchase finalizes');
 assert.equal(provider.calls.length, 1, 'the provider is invoked exactly once');
 const request = provider.calls[0];
 assert.equal(pick(request, 'store'), STORE, 'the provider call names the store');
 assert.equal(txOf(request), tx, 'the provider call names the transaction');
 assert.equal(pick(request, 'productId', 'product_id'), PRODUCT, 'the provider call names the product');
 assert.equal(pick(request, 'purchaseToken', 'purchase_token'), token, 'the provider call carries the purchase token');
 assert.equal(pick(request, 'kind'), 'consume', 'the provider call carries the consume kind');

 const finished = await h.finalize(STORE, tx);
 assert.equal(finished.state, 'done', 'a finalized row is done');
 assert.equal(finished.purchase_token, '', 'completion seals the purchase token to the empty string');
 assert.equal(finished.lease_owner, null, 'completion releases the lease owner');
 assert.equal(finished.lease_token, null, 'completion clears the fence');

 /* A second completion of the SAME fenced lease cannot run the provider again: the row is done, so the
  * guarded UPDATE matches nothing and the consume/acknowledge call is never repeated. */
 const again = await h.completeFinalization({ store: STORE, transactionId: tx, workerId: WORKER_B, fence: fenceOf(second[0]), finalizeProvider: provider });
 assert.equal(again.completed, false, 'a second completion of a done row does not report success');
 assert.equal(again.fenceLost, true, 'the second completion reports the lost fence rather than pretending');
 assert.equal(provider.calls.length, 1, 'the provider is invoked exactly once, even for a repeated completion');

 /* A `done` row is TERMINAL: a replayed verification must not reopen it, or the provider would be
  * presented a second consume. The upsert keeps the state and the sealed token, and reports done. */
 const reopen = await h.enqueueFinalization({ store: STORE, transactionId: tx, productId: PRODUCT, purchaseToken: 'late-token', kind: 'consume' });
 assert.equal(reopen.enqueued, false, 're-enqueueing a done finalization inserts nothing');
 assert.equal(reopen.state, 'done', 'the replayed verification keeps the terminal done state');
 const terminal = await h.finalize(STORE, tx);
 assert.equal(terminal.state, 'done', 'a done finalization is never reopened to pending');
 assert.equal(terminal.purchase_token, '', 'the sealed purchase token is never restored');
 assert.equal((await h.claimDueFinalizations({ workerId: WORKER_A, limit: 16, leaseMs: 1000 })).length, 0,
  'a done finalization is never claimable again');

 /* A grant-less finalization that has been pending past 24h is ABANDONED, not retried forever. */
 const stale = 'tx-abandoned';
 await h.enqueueFinalization({ store: STORE, transactionId: stale, productId: PRODUCT, purchaseToken: 'tok-abandon', kind: 'consume' });
 const c3 = await h.claimDueFinalizations({ workerId: WORKER_A, limit: 16, leaseMs: 1000 });
 assert.equal(c3.length, 1);
 assert.equal(txOf(c3[0]), stale);
 h.advance(DAY + 1);
 const c4 = await h.claimDueFinalizations({ workerId: WORKER_A, limit: 16, leaseMs: 3600000 });
 assert.equal(c4.length, 1, 'the abandoned candidate is reclaimed after its lease lapses');
 const abandoned = await h.completeFinalization({ store: STORE, transactionId: stale, workerId: WORKER_A, fence: fenceOf(c4[0]), finalizeProvider: provider });
 assert.equal(abandoned.completed, false, 'a 24h grant-less finalization does not complete');
 assert.equal(abandoned.pendingGrant, true, 'it is still reported as a pending grant');
 assert.equal(provider.calls.length, 1, 'the abandoned attempt never called the provider');
 assert.equal((await h.finalize(STORE, stale)).state, 'abandoned', 'past 24h the finalization is terminally abandoned');
});

/* ============ 4. duplicate and out-of-order purchase notifications never remint ============ */

test('V5-10-03 remint: a duplicate or retried purchase callback for an already-granted transaction never grants again', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const granted = 'tx-already-granted';
 const fresh = 'tx-first-grant';
 /* A transaction the Core already granted (its receipt is committed). */
 await h.grant(STORE, granted);

 const grants = [];
 /* The Core grant seam: exactly the durable effect the Core purchase command owns - the receipt row. */
 const grantFn = async () => {
  grants.push(grants.length + 1);
  await h.grant(STORE, fresh);
  return { granted: true };
 };

 const duplicate = await h.handlePurchaseNotification({
  store: STORE, notificationId: 'n-dup', transactionId: granted, actorId: ALICE, productId: PRODUCT, grantFn,
 });
 assert.equal(duplicate.duplicate, true, 'a purchase callback for an already-granted transaction is a duplicate');
 assert.equal(duplicate.reminted, false, 'the duplicate explicitly reports that nothing was reminted');
 assert.equal(duplicate.granted, null, 'a duplicate never reports a grant result, because grantFn never ran');
 assert.equal(grants.length, 0, 'grantFn is NEVER invoked for an already-granted transaction');
 assert.equal(await h.count('SELECT count(*)::int n FROM monetization.receipts WHERE store = $1 AND transaction_id = $2', [STORE, granted]), 1,
  'no second receipt is minted');

 /* A first callback for an unknown transaction grants exactly once. */
 const first = await h.handlePurchaseNotification({
  store: STORE, notificationId: 'n-fresh-1', transactionId: fresh, actorId: ALICE, productId: PRODUCT, grantFn,
 });
 assert.notEqual(first.duplicate, true, 'the first callback for an unknown transaction is not a duplicate');
 assert.equal(grants.length, 1, 'the first callback grants exactly once');
 assert.deepEqual(first.granted, { granted: true }, 'the first callback reports the Core grant result');
 assert.equal(first.ingested, true, 'the callback itself is persisted, so a crash before the grant is replayable');
 assert.equal((await h.notification(STORE, 'n-fresh-1')).state, 'pending', 'the persisted callback waits to be applied');
 assert.equal((await h.receipt(STORE, fresh)).refunded, false, 'the committed grant is a live receipt');

 /* Out-of-order / retried redelivery: the SAME transaction under a NEW provider notification id. The
  * receipt now exists, so the redelivery dedupes and the actor is never granted twice. */
 const retried = await h.handlePurchaseNotification({
  store: STORE, notificationId: 'n-fresh-2', transactionId: fresh, actorId: ALICE, productId: PRODUCT, grantFn,
 });
 assert.equal(retried.duplicate, true, 'a retried callback for a granted transaction is a duplicate');
 assert.equal(retried.reminted, false, 'the retried callback remints nothing');
 assert.equal(grants.length, 1, 'grantFn was invoked exactly once across every delivery');
 assert.equal(await h.count('SELECT count(*)::int n FROM monetization.receipts WHERE store = $1 AND transaction_id = $2', [STORE, fresh]), 1,
  'the granted transaction holds exactly one receipt');

 /* An out-of-order replay of the ORIGINAL notification id is deduped at ingest, and still grants nothing. */
 const replay = await h.ingestNotification({ store: STORE, notificationId: 'n-fresh-1' });
 assert.equal(replay.ingested, false, 'the original callback id is already durably recorded');
 const afterReplay = await h.handlePurchaseNotification({
  store: STORE, notificationId: 'n-fresh-1', transactionId: fresh, actorId: ALICE, productId: PRODUCT, grantFn,
 });
 assert.equal(afterReplay.duplicate, true, 'the replayed notification is a duplicate at the receipt too');
 assert.equal(grants.length, 1, 'no delivery path ever re-grants');

 /* Out-of-order: the provider REFUNDED this transaction before the purchase callback arrived, so a
  * revocation tombstone exists and no receipt does. Granting here would mint the refunded consumable. */
 const outOfOrder = 'tx-refunded-first';
 await h.handleRefundNotification({ store: STORE, transactionId: outOfOrder, productId: PRODUCT, reason: 'refund' });
 const late = await h.handlePurchaseNotification({
  store: STORE, notificationId: 'n-late', transactionId: outOfOrder, actorId: ALICE, productId: PRODUCT, grantFn,
 });
 assert.equal(late.revoked, true, 'a purchase callback for a revoked transaction reports the revocation');
 assert.equal(late.reminted, false, 'the revoked callback remints nothing');
 assert.equal(grants.length, 1, 'grantFn is NEVER invoked for a revoked transaction');
 assert.equal(await h.receipt(STORE, outOfOrder), null, 'no receipt is minted for a revoked transaction');
});

/* ============ 5. refund and revocation ============ */

test('V5-10-03 refund: a trusted refund writes the permanent revocation tombstone, flags the receipt, and blocks finalization', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const tx = 'tx-refund';
 await h.grant(STORE, tx);

 const revocations = [];
 /* The Core refund seam: it flags the receipt and holds the account, exactly what commerce.refund does.
  * The worker itself holds NO write on monetization.receipts - it may only record the tombstone and ask
  * Core for the refund, so the receipt flag MUST come from this seam. */
 const revokeFn = async () => {
  revocations.push(tx);
  const result = await h.pools.core.query('UPDATE monetization.receipts SET refunded = true WHERE store = $1 AND transaction_id = $2', [STORE, tx]);
  return { refunded: true, changed: result.rowCount };
 };

 const handled = await h.handleRefundNotification({ store: STORE, transactionId: tx, productId: PRODUCT, reason: 'refund', revokeFn });
 assert.equal(handled.recorded, true, 'the first refund records the tombstone');
 assert.equal(handled.invoked, true, 'the Core refund seam is invoked when one is supplied');
 assert.equal(revocations.length, 1, 'the Core refund seam is invoked exactly once');
 const revocation = await h.revocation(STORE, tx);
 assert.ok(revocation, 'handleRefundNotification writes the durable revocation tombstone');
 assert.equal(revocation.product_id, PRODUCT, 'the tombstone names the product');
 assert.equal(revocation.reason, 'refund', 'the tombstone records the reason');
 assert.equal(msOf(revocation.occurred_at, 'occurred_at'), CLOCK, 'the injected clock stamps occurred_at');
 assert.equal((await h.receipt(STORE, tx)).refunded, true, 'the refunded receipt is flagged through the Core seam');

 /* A refunded transaction is a permanent tombstone: a purchase callback that arrives AFTER the refund
  * must not re-grant it, because the durable receipt exists (refunded) and grants nothing. */
 const regrant = [];
 await h.handlePurchaseNotification({
  store: STORE, notificationId: 'n-after-refund', transactionId: tx, actorId: ALICE, productId: PRODUCT,
  grantFn: async () => { regrant.push(tx); },
 });
 assert.equal(regrant.length, 0, 'a callback for a refunded transaction never re-grants');

 /* Redelivered refund: the tombstone is permanent and exactly one, and the operation is idempotent. */
 const redelivered = await h.handleRefundNotification({ store: STORE, transactionId: tx, productId: PRODUCT, reason: 'refund', revokeFn });
 assert.equal(redelivered.recorded, false, 'a redelivered refund does not record a second tombstone');
 assert.equal(redelivered.duplicate, true, 'the redelivered refund reports the duplicate');
 assert.equal(await h.count('SELECT count(*)::int n FROM monetization.store_revocations WHERE store = $1 AND transaction_id = $2', [STORE, tx]), 1,
  'a redelivered refund leaves exactly one tombstone');

 /* A refunded receipt must NOT be finalized through the provider (the purchase was reversed). */
 await h.enqueueFinalization({ store: STORE, transactionId: tx, productId: PRODUCT, purchaseToken: 'tok-refund', kind: 'consume' });
 const claimed = await h.claimDueFinalizations({ workerId: WORKER_A, limit: 16, leaseMs: 1000 });
 assert.equal(claimed.length, 1, 'the refunded transaction still has a pending finalization row');
 const provider = recordingProvider();
 const outcome = await h.completeFinalization({ store: STORE, transactionId: tx, workerId: WORKER_A, fence: fenceOf(claimed[0]), finalizeProvider: provider });
 assert.equal(provider.calls.length, 0, 'a refunded receipt never reaches the consume/acknowledge provider');
 assert.equal(outcome.completed, false, 'a refunded receipt does not complete');
 assert.equal(outcome.pendingGrant, true, 'a refunded receipt is still awaiting a live durable grant');
 assert.equal(outcome.refunded, true, 'the outcome names the refunded receipt it refused to consume');
 assert.notEqual((await h.finalize(STORE, tx)).state, 'done', 'a refunded receipt is never marked done');

 /* An unknown transaction (the provider charged and refunded a purchase this database never granted)
  * still gets its permanent tombstone: no receipt is invented. */
 const unknown = 'tx-unknown-refund';
 const unknownRefund = await h.handleRefundNotification({ store: STORE, transactionId: unknown, productId: null, reason: 'voided' });
 assert.equal(unknownRefund.recorded, true, 'an unknown transaction is still tombstoned');
 assert.equal(unknownRefund.invoked, false, 'no Core seam is invented when none is supplied');
 assert.equal(unknownRefund.refund, null, 'an absent Core seam yields a null refund result');
 assert.ok(await h.revocation(STORE, unknown), 'the tombstone row is durable');
 assert.equal(await h.receipt(STORE, unknown), null, 'no receipt is fabricated for an unknown refund');
 assert.equal((await h.revocation(STORE, unknown)).reason, 'voided', 'the explicit reason is recorded verbatim');
});

/* ============ 6. a crashed finalizer is visible and recoverable ============ */

test('V5-10-03 recovery: a pending finalization is listed, and a crashed finalizer is reclaimed after its lease and completed', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const tx = 'tx-crash';
 const token = 'purchase-token-crash';
 /* The grant was committed BEFORE the consume retry starts (spec 03 section 6), so finalization here is
  * legitimately authorized; the crash is the worker's, not the grant's. */
 await h.enqueueFinalization({ store: STORE, transactionId: tx, productId: PRODUCT, purchaseToken: token, kind: 'consume' });
 await h.grant(STORE, tx);

 const listed = await h.listPendingFinalizations({ limit: 50 });
 assert.ok(Array.isArray(listed), "listPendingFinalizations returns the pending rows");
 assert.ok(listed.some((r) => txOf(r) === tx), 'the pending finalization is VISIBLE before it is claimed');
 assert.ok(listed.every((r) => r.state === undefined || r.state === 'pending'),
  'only pending finalizations are listed');

 const a = await h.claimDueFinalizations({ workerId: WORKER_A, limit: 16, leaseMs: 1000 });
 assert.equal(a.length, 1, 'worker A claims the pending finalization');
 assert.equal(txOf(a[0]), tx);
 assert.equal(Number(pick(a[0], 'attempts')), 1);
 const fenceA = fenceOf(a[0]);
 assert.ok(fenceA >= 1, 'the first claim mints a fence');

 assert.equal((await h.claimDueFinalizations({ workerId: WORKER_B, limit: 16, leaseMs: 1000 })).length, 0,
  'a live lease cannot be stolen: the peer cannot double-finalize an in-flight row');

 /* Worker A dies between the claim and the provider call. */
 h.advance(1001);
 const b = await h.claimDueFinalizations({ workerId: WORKER_B, limit: 16, leaseMs: 1000 });
 assert.equal(b.length, 1, 'the crashed finalization is reclaimed after the lease expires');
 assert.equal(txOf(b[0]), tx, 'recovery reclaims the SAME transaction, not a copy');
 assert.equal(pick(b[0], 'productId'), PRODUCT, 'the reclaim carries the same product');
 assert.equal(pick(b[0], 'purchaseToken'), token, 'the reclaim carries the same purchase token');
 assert.equal(pick(b[0], 'kind'), 'consume', 'the reclaim carries the same kind');
 assert.ok(fenceOf(b[0]) > fenceA, 'the reclaim mints a strictly newer fence');
 assert.equal(Number(pick(b[0], 'attempts')), 2, 'the crashed attempt is counted');

 const provider = recordingProvider();
 const done = await h.completeFinalization({ store: STORE, transactionId: tx, workerId: WORKER_B, fence: fenceOf(b[0]), finalizeProvider: provider });
 assert.equal(done.completed, true, 'the recovered finalization completes');
 assert.equal(provider.calls.length, 1, 'the provider is invoked exactly once by the recovery');
 assert.equal(pick(provider.calls[0], 'purchaseToken', 'purchase_token'), token, 'the recovered call carries the token');
 const finished = await h.finalize(STORE, tx);
 assert.equal(finished.state, 'done', 'the recovered row is done');
 assert.equal(finished.purchase_token, '', 'recovery seals the purchase token');
 assert.equal(finished.lease_owner, null, 'recovery releases the lease');
 assert.equal(Number(finished.attempts), 2, 'the durable attempt history shows the crash');

 const after = await h.listPendingFinalizations({ limit: 50 });
 assert.equal(after.some((r) => txOf(r) === tx), false, 'a done finalization is no longer pending');
});

/* P10 post-gate hardening: a repeated purchase notification must not steal a
 * provider call in progress by clearing its lease, and an expired worker must
 * not call Google merely because another worker has not yet reclaimed it. */
test('P10 hardening: duplicate enqueue preserves active finalization and operator listing redacts purchase token', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const tx = 'tx-active-requeue';
 const token = 'opaque-sensitive-purchase-token';
 await h.enqueueFinalization({ store: STORE, transactionId: tx, productId: PRODUCT, purchaseToken: token, kind: 'consume' });
 await h.grant(STORE, tx);
 const listed = await h.listPendingFinalizations({ limit: 10 });
 const row = listed.find((x) => txOf(x) === tx);
 assert.ok(row, 'operator can see the outstanding finalization');
 assert.equal(row.hasPurchaseToken, true, 'operator may see whether a token is present');
 assert.equal(row.purchaseToken, undefined, 'operator must never receive a raw provider purchase token');
 assert.equal(JSON.stringify(row).includes(token), false, 'even serializing the operator response cannot expose the token');

 const first = await h.claimDueFinalizations({ workerId: WORKER_A, limit: 10, leaseMs: 5000 });
 assert.equal(first.length, 1);
 const fence = fenceOf(first[0]);
 const before = await h.finalize(STORE, tx);
 const replay = await h.enqueueFinalization({
  store: STORE, transactionId: tx, productId: PRODUCT,
  purchaseToken: 'forged-replayed-token', kind: 'acknowledge',
 });
 assert.equal(replay.enqueued, false);
 const after = await h.finalize(STORE, tx);
 assert.equal(after.state, 'pending');
 assert.equal(after.lease_owner, WORKER_A, 'replay must not clear live claim ownership');
 assert.equal(Number(after.lease_token), fence, 'replay must not replace the fence');
 assert.equal(msOf(after.lease_until, 'lease_until'), msOf(before.lease_until, 'lease_until'));
 assert.equal(Number(after.attempts), 1, 'replay must not reset live attempt count');
 assert.equal(after.purchase_token, token, 'replay must not replace the in-flight purchase token');
 assert.equal(after.kind, 'consume', 'replay must not change an in-flight provider operation');
 assert.equal((await h.claimDueFinalizations({ workerId: WORKER_B, limit: 10, leaseMs: 5000 })).length, 0,
  'another worker cannot race an ongoing provider call after a replay');

 const finalize = recordingProvider();
 assert.equal((await h.completeFinalization({
  store: STORE, transactionId: tx, workerId: WORKER_A, fence, finalizeProvider: finalize,
 })).completed, true);
 assert.equal(finalize.calls.length, 1);
 assert.equal(finalize.calls[0].purchaseToken, token);
});

test('P10 hardening: a finalizer with an elapsed lease never contacts provider before takeover', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const tx = 'tx-expired-before-provider';
 await h.enqueueFinalization({ store: STORE, transactionId: tx, productId: PRODUCT, purchaseToken: 'tok-expired', kind: 'consume' });
 await h.grant(STORE, tx);
 const first = await h.claimDueFinalizations({ workerId: WORKER_A, limit: 10, leaseMs: 1000 });
 assert.equal(first.length, 1);
 h.advance(1001);
 const provider = recordingProvider();
 const stale = await h.completeFinalization({
  store: STORE, transactionId: tx, workerId: WORKER_A, fence: fenceOf(first[0]), finalizeProvider: provider,
 });
 assert.equal(stale.completed, false);
 assert.equal(stale.fenceLost, true);
 assert.equal(provider.calls.length, 0, 'the provider call must never start after the lease expired');
 const next = await h.claimDueFinalizations({ workerId: WORKER_B, limit: 10, leaseMs: 1000 });
 assert.equal(next.length, 1);
 assert.equal((await h.completeFinalization({
  store: STORE, transactionId: tx, workerId: WORKER_B, fence: fenceOf(next[0]), finalizeProvider: provider,
 })).completed, true);
 assert.equal(provider.calls.length, 1, 'only the live owner contacts the provider');
});
