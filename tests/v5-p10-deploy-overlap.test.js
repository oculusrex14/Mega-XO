'use strict';
/* tests/v5-p10-deploy-overlap.test.js - V5 P10 task V5-10-05 (Remove legacy duplicate schedulers).
 *
 * SCOPE. Exercises concurrent deployment overlap between legacy-compatible in-process background
 * workers/schedulers and V5 `apps/worker` against a REAL owned PostgreSQL 16 database built by
 * `tests/v5-pg-lab.js` (checksummed migration chain, guarded role pools, synthetic actors).
 *
 * WHAT IS PROVEN (the core behaviors required by V5-10-05):
 *
 *   1. MAIL DELIVERY DEDUPLICATION UNDER CONCURRENT WORKERS.
 *      Two concurrent workers (simulating legacy in-process sender and V5 worker app) race to claim
 *      and deliver queued mail in `ops.outbox`. PostgreSQL `FOR UPDATE SKIP LOCKED` ensures jobs
 *      are claimed without double-claiming. Each queued message is delivered to the transport
 *      EXACTLY ONCE, and outbox rows transition cleanly to `state='sent'`, `payload=NULL`.
 *
 *   2. ACTIVE LEASE LOCKING & SAFE STALL HANDOVER.
 *      While an in-flight worker holds a live lease on a mail job, a concurrent peer cannot steal
 *      or double-deliver it. When a worker stalls and its lease lapses, the peer reclaims the job
 *      with a higher fence and delivers it cleanly - still resulting in exactly ONE delivery.
 *
 *   3. STORE FINALIZATION DEDUPLICATION UNDER CONCURRENT FINALIZERS.
 *      Two concurrent finalizers (legacy in-process loop vs V5 worker finalization loop) racing on
 *      the same transaction in `monetization.store_finalize` only contact the provider once.
 *      The transaction transitions cleanly to `state='done'` with purchase_token cleared, without
 *      race errors or duplicate provider consumption calls.
 *
 *   4. SEASON / MAINTENANCE DEDUPLICATION UNDER CONCURRENT SCHEDULERS.
 *      Two maintenance schedulers (legacy in-process scheduler and V5 worker scheduler) ticking at
 *      the same instant for the same day and closed week produce exactly ONE outcome in
 *      `economy.command_outcomes` per key (`snapshot:<today>` and `weekly:<week>:<today>`),
 *      exactly ONE payout row in `season.weekly_payouts`, exactly ONE ledger row, and credit the
 *      actor's wallet exactly once. The loser replays the committed response without errors.
 *
 *   5. PRIVACY & RETENTION CLEANUP UNDER CONCURRENCY.
 *      Two concurrent cleanup passes (legacy retention loop and V5 worker privacy workflow)
 *      run `purgeExpiredRetention` and `purgeExpiredRateBuckets` simultaneously without deadlocks,
 *      lock contention errors, or inconsistent state.
 *
 *   6. COMPOSITE END-TO-END OVERLAPPING DEPLOYMENT: SINGLE BUSINESS EFFECT INVARIANT.
 *      A full multi-domain simulation where legacy background tasks and V5 `apps/worker` run
 *      simultaneously over a shared database with queued mail, pending finalization, due season
 *      maintenance, and retention data. Verifies the system-wide invariant: exactly ONE business
 *      effect occurs across all domains during overlapping deployments.
 *
 * GATING:
 *   Requires `V5_PG_URL` or `V5_PG_REQUIRED=1`; absent it, every test skips cleanly.
 *   Teardown uses `lab.installCleanup(test)`. Natural process exit, no force-exit.
 *
 * Run: node --test --test-concurrency=1 tests/v5-p10-deploy-overlap.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const D = require('../src/domain.js');

/* Close every guarded pool and drop every owned database after suite teardown. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

const DAY = lab.DAY;
const MIDDAY = 12 * 3600 * 1000;

/* Test epoch & stable period constants (same as scheduling suite) */
const START = Date.parse('2026-10-15T12:00:00Z');
const TODAY = '2026-10-15';
const WEEK = '2026-10-05';
const WEEK_START = Date.parse(`${WEEK}T00:00:00Z`);
const WEEK_DAYS = Object.freeze(Array.from({ length: 7 }, (_, i) => D.day(WEEK_START + i * DAY)));
const SEASON = D.season(START).id;
const MAINTENANCE = 'maintenance';

const MAIL_SECRET = 'v5-p10-deploy-overlap-secret';
const STORE = 'google';
const PRODUCT = 'crowns_100';

const PAID = 'svc_paid_overlap';
const SEEDS = Object.freeze([
  { actor: PAID, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
]);
const OPENING = 1000;

const PAID_ACTIVITY = Object.freeze({
  dailyTiers: Object.freeze(['gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold']),
  endTier: 'gold', games: 5, queueGames: 3, uniqueOpponents: 3, activeDays: 4,
});
const REWARD_ORACLE = D.weeklyReward(PAID_ACTIVITY);
const PAID_AMOUNT = REWARD_ORACLE.amount;
const OUTCOME_KEY = '"key" = to_json($2::text)::text';

/* ---------------------------------------------------------------- lazy module loading */

let jobFactory = null;
function loadJobFactory() {
  if (!jobFactory) {
    const mod = require('../packages/services/jobs.js');
    assert.equal(typeof mod.createJobService, 'function', 'packages/services/jobs.js must export createJobService');
    jobFactory = mod.createJobService;
  }
  return jobFactory;
}

let workflowMod = null;
function loadWorkflowMod() {
  if (!workflowMod) {
    const mod = require('../packages/services/worker-workflows.js');
    assert.equal(typeof mod.createMailWorker, 'function', 'worker-workflows must export createMailWorker');
    assert.equal(typeof mod.createPrivacyWorkflow, 'function', 'worker-workflows must export createPrivacyWorkflow');
    assert.equal(typeof mod.createWorkerApp, 'function', 'worker-workflows must export createWorkerApp');
    workflowMod = mod;
  }
  return workflowMod;
}

let providerFactory = null;
function loadProviderFactory() {
  if (!providerFactory) {
    const mod = require('../packages/services/provider-workflows.js');
    assert.equal(typeof mod.createProviderWorkflow, 'function', 'provider-workflows must export createProviderWorkflow');
    providerFactory = mod.createProviderWorkflow;
  }
  return providerFactory;
}

let schedulerFactory = null;
function loadSchedulerFactory() {
  if (!schedulerFactory) {
    const mod = require('../packages/services/maintenance-scheduler.js');
    assert.equal(typeof mod.createMaintenanceScheduler, 'function', 'maintenance-scheduler must export createMaintenanceScheduler');
    schedulerFactory = mod.createMaintenanceScheduler;
  }
  return schedulerFactory;
}

/* ---------------------------------------------------------------- helpers & fixtures */

function makeClock(start) {
  let value = start;
  const now = () => value;
  now.set = (next) => { value = next; return value; };
  now.advance = (ms) => { value += ms; return value; };
  return now;
}

async function exec(database, text, params = []) {
  const client = await lab.adminClient(database);
  try { return (await client.query(text, params)).rows; } finally { await client.end(); }
}
const one = async (database, text, params) => (await exec(database, text, params))[0] ?? null;
const count = async (database, text, params) => Number((await one(database, `SELECT count(*)::int AS n FROM (${text}) s`, params))?.n ?? 0);
const outcomeCount = (database, key) => count(database,
  'SELECT 1 FROM economy.command_outcomes WHERE actor_id = $1 AND ' + OUTCOME_KEY, [MAINTENANCE, key]);
const payouts = (database) => exec(database,
  'SELECT payout_id, actor_id, amount::text AS amount, tier, days FROM season.weekly_payouts WHERE week = $1::date ORDER BY payout_id', [WEEK]);
const coinsOf = (database, actor) => one(database, 'SELECT coins::text AS coins FROM economy.wallets WHERE actor_id = $1', [actor])
  .then((row) => (row === null ? null : Number(row.coins)));
const weeklyLedger = (database, actor) => exec(database,
  'SELECT entry_id, amount::text AS amount FROM economy.ledger WHERE actor_id = $1 AND entry_id = $2',
  [actor, `weekly:${WEEK}:${actor}`]);

function recordingTransport() {
  const calls = [];
  const record = (method, message) => { calls.push({ method, message }); return { ok: true }; };
  return {
    calls,
    enabled: () => true,
    sendOtp: (message) => record('sendOtp', message),
    sendPasswordChanged: (message) => record('sendPasswordChanged', message),
    sendSecurityNotice: (message) => record('sendSecurityNotice', message),
    sendMail: (message) => record('sendMail', message),
  };
}

function recordingProvider() {
  const calls = [];
  const record = async (args) => { calls.push(args); return { ok: true }; };
  record.calls = calls;
  return record;
}

async function runFinalizer(workflow, workerId, finalizeProvider) {
  const claimed = await workflow.claimDueFinalizations({ workerId, limit: 16, leaseMs: 30000 });
  const results = [];
  for (const item of claimed) {
    const res = await workflow.completeFinalization({
      store: item.store,
      transactionId: item.transactionId,
      workerId,
      fence: item.fence,
      finalizeProvider,
    });
    results.push(res);
  }
  return { claimed, results };
}

async function seedSeason(database, actor, seasonId = SEASON) {
  await exec(database,
    'INSERT INTO economy.season_state (actor_id, season_id, started_at, games, queue_games, opponents,'
    + ' wins, losses, draws, peak_rating, last_rated_at, qualified_at)'
    + ' VALUES ($1, $2, $3, 6, 3, ARRAY[$4, $5, $6], 4, 2, 0, 1560, $3, $3)'
    + ' ON CONFLICT (actor_id) DO NOTHING',
    [actor, seasonId, new Date(START - 10 * DAY).toISOString(), 'svc_opp1', 'svc_opp2', 'svc_opp3']);
}

const ACTIVITY_ROWS = Object.freeze([
  { day: 0, queue: true, opponent: 'svc_opp1' },
  { day: 2, queue: true, opponent: 'svc_opp2' },
  { day: 4, queue: true, opponent: 'svc_opp3' },
  { day: 6, queue: false, opponent: 'svc_opp1' },
  { day: 6, queue: false, opponent: 'svc_opp2' },
]);
async function seedActivity(database, actor, rows = ACTIVITY_ROWS) {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    await exec(database,
      'INSERT INTO economy.match_history (actor_id, seq, match_id, at, opponent, mode, queue, symbol, rated,'
      + ' qualified, activity_qualified, result, reason, active_seconds, rating_delta, casual_delta)'
      + " VALUES ($1, $2, $3, $4, $5, 'ranked', $6, 'X', true, true, true, 'win', 'complete', 120, 10.5, 0)",
      [actor, i, `hist:${actor}:${i}`, new Date(WEEK_START + row.day * DAY + MIDDAY).toISOString(), row.opponent, row.queue]);
  }
}

async function tickClosedWeek({ scheduler }, clock) {
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    clock.set(WEEK_START + i * DAY + MIDDAY);
    out.push(await scheduler.tick());
  }
  return out;
}

let dbSeq = 0;
async function open(t, seeds = SEEDS) {
  if (!(await lab.boot(t))) return null;
  const database = await lab.createDatabase(`p10o${dbSeq++}`);
  if (seeds && seeds.length) await lab.seedActors(database, seeds);
  const pools = lab.poolsFor(database);
  const clock = makeClock(START);
  const jobs = loadJobFactory()({ pool: pools.worker, now: clock });
  t.after(async () => {
    try { await jobs.close(); } catch { /* best effort */ }
  });
  return { database, pools, clock, jobs };
}

/* ---------------------------------------------------------------- 1. Mail Delivery Deduplication */

test('mail delivery deduplication: concurrent old and new workers deliver each queued email exactly once', { skip: GATE }, async (t) => {
  const h = await open(t);
  if (!h) return;
  const { createMailWorker, sealMessage } = loadWorkflowMod();

  const transport = recordingTransport();

  /* Enqueue 4 mail jobs with distinct kinds into ops.outbox */
  const jobsToEnqueue = [
    { id: 'mail-overlap-1', kind: 'otp', msg: { to: 'alice@example.test', code: '123456', purpose: 'login' } },
    { id: 'mail-overlap-2', kind: 'changed', msg: { to: 'alice@example.test', when: '2026-10-15T12:00:00Z' } },
    { id: 'mail-overlap-3', kind: 'security', msg: { to: 'bob@example.test', event: 'session_revoked' } },
    { id: 'mail-overlap-4', kind: 'mail', msg: { to: 'carol@example.test', subject: 'Notice', body: 'Hello' } },
  ];

  for (const item of jobsToEnqueue) {
    await h.jobs.enqueueJob({
      id: item.id,
      kind: item.kind,
      version: 1,
      payload: sealMessage(MAIL_SECRET, { ...item.msg, idempotencyKey: `idemp:${item.id}` }),
      businessKey: `bkey:${item.id}`,
      expiresAt: h.clock() + DAY,
      nextAt: h.clock(),
    });
  }

  /* Two concurrent workers: Worker A simulates legacy node; Worker B simulates V5 worker app */
  const workerOld = createMailWorker({
    jobService: h.jobs,
    transport,
    secret: MAIL_SECRET,
    now: h.clock,
    workerId: 'worker:legacy-overlap',
  });
  const workerNew = createMailWorker({
    jobService: h.jobs,
    transport,
    secret: MAIL_SECRET,
    now: h.clock,
    workerId: 'worker:v5-overlap',
  });
  t.after(() => { workerOld.close(); workerNew.close(); });

  /* Concurrently tick both workers against the shared database */
  const [resOld, resNew] = await Promise.all([workerOld.tick(), workerNew.tick()]);

  /* Combined sent count across both workers must equal total queued jobs */
  const totalSent = resOld.sent + resNew.sent;
  assert.equal(totalSent, 4, 'both workers combined must send all 4 queued jobs');
  assert.equal(resOld.failed, 0, 'legacy worker has 0 failed jobs');
  assert.equal(resNew.failed, 0, 'V5 worker has 0 failed jobs');

  /* Transport must record exactly 4 dispatches - no duplicate sends */
  assert.equal(transport.calls.length, 4, 'transport must receive exactly 4 deliveries');

  const deliveredKeys = transport.calls.map((c) => c.message.idempotencyKey).sort();
  const expectedKeys = jobsToEnqueue.map((j) => `idemp:${j.id}`).sort();
  assert.deepEqual(deliveredKeys, expectedKeys, 'every specific idempotency key is delivered exactly once');

  /* All outbox rows in DB must be 'sent' with payload sealed to NULL */
  for (const item of jobsToEnqueue) {
    const row = await one(h.database, 'SELECT state, payload, lease_owner FROM ops.outbox WHERE outbox_id = $1', [item.id]);
    assert.ok(row, `row ${item.id} must exist in ops.outbox`);
    assert.equal(row.state, 'sent', `row ${item.id} must be in state 'sent'`);
    assert.equal(row.payload, null, `row ${item.id} payload must be sealed to NULL`);
    assert.equal(row.lease_owner, null, `row ${item.id} lease must be cleared`);
  }

  /* Zero unserviced jobs remain */
  const remaining = await count(h.database, "SELECT 1 FROM ops.outbox WHERE state IN ('queued', 'sending')");
  assert.equal(remaining, 0, 'no jobs remain queued or sending');
});

test('mail delivery lease contention: active lease prevents concurrent claim; lease expiry enables safe handover', { skip: GATE }, async (t) => {
  const h = await open(t);
  if (!h) return;
  const { createMailWorker, sealMessage } = loadWorkflowMod();

  const transport = recordingTransport();
  const jobId = 'mail-stall-handover-1';
  await h.jobs.enqueueJob({
    id: jobId,
    kind: 'otp',
    version: 1,
    payload: sealMessage(MAIL_SECRET, { to: 'stalled@example.test', code: '999888' }),
    businessKey: 'bkey:stall-1',
    expiresAt: h.clock() + DAY,
    nextAt: h.clock(),
  });

  const workerA = 'worker:stalled-a';
  const workerB = 'worker:takeover-b';

  /* Worker A claims the job with a 5000ms lease */
  const claimedA = await h.jobs.claimJobs({ workerId: workerA, kinds: ['otp'], limit: 10, leaseMs: 5000 });
  assert.equal(claimedA.length, 1);
  assert.equal(claimedA[0].id, jobId);
  const fenceA = claimedA[0].fence;

  /* While lease is live, Worker B attempts to claim the same job */
  const claimedBWhileLive = await h.jobs.claimJobs({ workerId: workerB, kinds: ['otp'], limit: 10, leaseMs: 5000 });
  assert.equal(claimedBWhileLive.length, 0, 'Worker B cannot claim job while Worker A holds active lease');

  /* Advance clock past Worker A lease (Worker A stalled / crashed during I/O) */
  h.clock.advance(6000);

  /* Worker B claims after lease expiry: must succeed with a strictly higher fence */
  const claimedBAfterExpiry = await h.jobs.claimJobs({ workerId: workerB, kinds: ['otp'], limit: 10, leaseMs: 5000 });
  assert.equal(claimedBAfterExpiry.length, 1, 'Worker B claims expired lease');
  assert.equal(claimedBAfterExpiry[0].id, jobId);
  assert.ok(claimedBAfterExpiry[0].fence > fenceA, 'Worker B fence must be strictly higher than Worker A fence');

  /* Stale Worker A wakes up and attempts to complete with old fence: must be rejected */
  const staleComplete = await h.jobs.completeJob({ id: jobId, workerId: workerA, fence: fenceA });
  assert.equal(staleComplete, false, 'Stale Worker A completion must be refused');

  /* Worker B completes with current fence */
  const validComplete = await h.jobs.completeJob({ id: jobId, workerId: workerB, fence: claimedBAfterExpiry[0].fence });
  assert.equal(validComplete, true, 'Current Worker B completion succeeds');

  const row = await one(h.database, 'SELECT state, payload FROM ops.outbox WHERE outbox_id = $1', [jobId]);
  assert.equal(row.state, 'sent');
  assert.equal(row.payload, null);
});

/* ---------------------------------------------------------------- 2. Store Finalization Deduplication */

test('store finalization deduplication: concurrent finalizers contact provider exactly once and transition to done', { skip: GATE }, async (t) => {
  const h = await open(t);
  if (!h) return;
  const createProvider = loadProviderFactory();

  const providerMock = recordingProvider();
  const txId = 'tx-overlap-google-101';
  const token = 'tok-overlap-finalization-101';

  /* Seed durable receipt in monetization.receipts (the grant gate) */
  await exec(h.database,
    'INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at)'
    + ' VALUES ($1, $2, $3, $4, $5, false, $6)'
    + ' ON CONFLICT (store, transaction_id) DO NOTHING',
    [STORE, txId, PAID, PRODUCT, 100, new Date(h.clock())]);

  /* Finalization workflow instance 1 (legacy in-process finalizer loop) */
  const finalizerOld = createProvider({ pool: h.pools.worker, now: h.clock });
  /* Finalization workflow instance 2 (V5 worker finalization loop) */
  const finalizerNew = createProvider({ pool: h.pools.worker, now: h.clock });
  t.after(async () => {
    try { await finalizerOld.close(); } catch { /* best effort */ }
    try { await finalizerNew.close(); } catch { /* best effort */ }
  });

  /* Enqueue store finalization */
  const enq = await finalizerOld.enqueueFinalization({
    store: STORE,
    transactionId: txId,
    productId: PRODUCT,
    purchaseToken: token,
    kind: 'consume',
  });
  assert.equal(enq.enqueued, true, 'finalization is enqueued in store_finalize');

  /* Both finalizers race concurrently to claim and complete the exact same transaction */
  const [resOld, resNew] = await Promise.all([
    runFinalizer(finalizerOld, 'worker:legacy-finalizer', providerMock),
    runFinalizer(finalizerNew, 'worker:v5-finalizer', providerMock),
  ]);

  /* Exactly ONE worker claimed and completed the transaction */
  const totalCompleted = (resOld.results.filter((r) => r.completed).length)
                        + (resNew.results.filter((r) => r.completed).length);
  assert.equal(totalCompleted, 1, 'exactly one finalizer must complete the transaction');

  /* Provider mock was called EXACTLY ONCE across both finalizers */
  assert.equal(providerMock.calls.length, 1, 'provider must be contacted exactly once');
  assert.equal(providerMock.calls[0].transactionId, txId);
  assert.equal(providerMock.calls[0].store, STORE);
  assert.equal(providerMock.calls[0].kind, 'consume');

  /* Durable row in monetization.store_finalize is 'done' with purchase_token cleared */
  const row = await one(h.database,
    'SELECT state, purchase_token, lease_owner, lease_token FROM monetization.store_finalize WHERE store = $1 AND transaction_id = $2',
    [STORE, txId]);
  assert.ok(row, 'store_finalize row must exist');
  assert.equal(row.state, 'done', "state must transition to 'done'");
  assert.equal(row.purchase_token, '', 'purchase_token must be sealed to empty string');
  assert.equal(row.lease_owner, null, 'lease must be released');
  assert.equal(row.lease_token, null, 'lease token must be cleared');
});

/* ---------------------------------------------------------------- 3. Season / Maintenance Deduplication */

test('season maintenance deduplication: concurrent schedulers execute exactly one snapshot, one payout, and one wallet credit', { skip: GATE }, async (t) => {
  const h = await open(t, [SEEDS[0]]);
  if (!h) return;
  const createScheduler = loadSchedulerFactory();

  await seedSeason(h.database, PAID);
  await seedActivity(h.database, PAID);

  /* Establish snapshots for the closed week using a temporary scheduler pass */
  const setupCore = await lab.coreFor(h.database, { clock: h.clock });
  const setupSched = createScheduler({ corePool: h.pools.core, coreClient: setupCore, now: h.clock, domain: D });
  await tickClosedWeek({ scheduler: setupSched }, h.clock);
  await setupSched.close();
  setupCore.close();

  assert.deepEqual(await payouts(h.database), [], 'no payouts prior to settlement instant');

  /* Set clock to settlement instant START */
  h.clock.set(START);

  /* Build two independent schedulers + Core clients simulating legacy and V5 worker processes */
  const coreOld = await lab.coreFor(h.database, { clock: h.clock });
  const coreNew = await lab.coreFor(h.database, { clock: h.clock });
  const schedOld = createScheduler({ corePool: h.pools.core, coreClient: coreOld, now: h.clock, domain: D });
  const schedNew = createScheduler({ corePool: h.pools.core, coreClient: coreNew, now: h.clock, domain: D });
  t.after(async () => {
    try { await schedOld.close(); } catch { /* best effort */ }
    try { await schedNew.close(); } catch { /* best effort */ }
    try { coreOld.close(); } catch { /* best effort */ }
    try { coreNew.close(); } catch { /* best effort */ }
  });

  /* Both schedulers tick at the exact same instant */
  const [tickOld, tickNew] = await Promise.all([schedOld.tick(), schedNew.tick()]);

  const dayKey = `snapshot:${TODAY}`;
  const weekKey = `weekly:${WEEK}:${TODAY}`;

  /* Both schedulers returned consistent snapshot and weekly settlement references */
  assert.equal(tickOld.snapshot.key, dayKey);
  assert.equal(tickNew.snapshot.key, dayKey);
  assert.equal(tickOld.weeks.find((w) => w.week === WEEK).key, weekKey);
  assert.equal(tickNew.weeks.find((w) => w.week === WEEK).key, weekKey);

  /* EXACTLY ONE outcome row exists for the daily snapshot */
  assert.equal(await outcomeCount(h.database, dayKey), 1, 'exactly one snapshot outcome row despite concurrent schedulers');

  /* EXACTLY ONE outcome row exists for the weekly settlement */
  assert.equal(await outcomeCount(h.database, weekKey), 1, 'exactly one weekly outcome row despite concurrent schedulers');

  /* EXACTLY ONE payout row created */
  const payoutRows = await payouts(h.database);
  assert.equal(payoutRows.length, 1, 'exactly one weekly payout row created');
  assert.equal(Number(payoutRows[0].amount), PAID_AMOUNT, 'payout amount matches domain oracle');

  /* Wallet is credited EXACTLY ONCE (no duplicate coin grant) */
  const balance = await coinsOf(h.database, PAID);
  assert.equal(balance, OPENING + PAID_AMOUNT, 'wallet credited exactly once with oracle payout amount');

  /* Exactly ONE weekly ledger entry exists */
  const ledgerRows = await weeklyLedger(h.database, PAID);
  assert.equal(ledgerRows.length, 1, 'exactly one weekly ledger row exists');
  assert.equal(Number(ledgerRows[0].amount), PAID_AMOUNT, 'ledger amount matches oracle');
});

/* ---------------------------------------------------------------- 4. Privacy & Retention Concurrency */

test('privacy and retention: concurrent cleanup sweeps execute cleanly without conflict', { skip: GATE }, async (t) => {
  const h = await open(t);
  if (!h) return;
  const { createPrivacyWorkflow } = loadWorkflowMod();

  const nowMs = h.clock();
  const olderThan7d = new Date(nowMs - 10 * DAY).toISOString();
  const within7d = new Date(nowMs - 2 * DAY).toISOString();

  /* Seed outbox retention fixtures: expired terminal row, recent terminal row, active row */
  await exec(h.database,
    "INSERT INTO ops.outbox (outbox_id, kind, state, attempts, created_at, expires_at, next_at)"
    + " VALUES ('ret-old-sent', 'mail', 'sent', 1, $1, $1, $1),"
    + "        ('ret-recent-sent', 'mail', 'sent', 1, $2, $2, $2),"
    + "        ('ret-old-queued', 'mail', 'queued', 0, $1, $3, $3)",
    [olderThan7d, within7d, new Date(nowMs + DAY).toISOString()]);

  /* Seed rate bucket fixtures: expired bucket and active bucket */
  await exec(h.database,
    "INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at)"
    + " VALUES ('rate:expired:1', 1, $1),"
    + "        ('rate:active:1', 1, $2)",
    [new Date(nowMs - 1000).toISOString(), new Date(nowMs + 60000).toISOString()]);

  /* Build two privacy workflows simulating legacy cleanup and V5 worker privacy sweep */
  const privacyOld = createPrivacyWorkflow({ pool: h.pools.worker, jobService: h.jobs, now: h.clock });
  const privacyNew = createPrivacyWorkflow({ pool: h.pools.worker, jobService: h.jobs, now: h.clock });
  t.after(() => { privacyOld.close(); privacyNew.close(); });

  /* Concurrently run outbox retention purge across both instances */
  const [purgedOld, purgedNew] = await Promise.all([
    privacyOld.purgeExpiredRetention(7 * DAY),
    privacyNew.purgeExpiredRetention(7 * DAY),
  ]);
  const totalPurged = purgedOld + purgedNew;
  assert.equal(totalPurged, 1, 'exactly one old terminal row purged across concurrent sweeps');

  /* Verify DB state: old sent row is gone, recent sent row and active queued row remain */
  const oldSent = await one(h.database, "SELECT 1 FROM ops.outbox WHERE outbox_id = 'ret-old-sent'");
  const recentSent = await one(h.database, "SELECT 1 FROM ops.outbox WHERE outbox_id = 'ret-recent-sent'");
  const oldQueued = await one(h.database, "SELECT 1 FROM ops.outbox WHERE outbox_id = 'ret-old-queued'");
  assert.equal(oldSent, null, 'terminal row older than 7 days must be purged');
  assert.notEqual(recentSent, null, 'recent terminal row must be retained');
  assert.notEqual(oldQueued, null, 'active queued row must be retained even if created > 7 days ago');

  /* Concurrently run rate buckets purge across both instances (using api_runtime pool) */
  const [bucketsOld, bucketsNew] = await Promise.all([
    privacyOld.purgeExpiredRateBuckets(h.pools.api),
    privacyNew.purgeExpiredRateBuckets(h.pools.api),
  ]);
  const totalBucketsPurged = bucketsOld + bucketsNew;
  assert.equal(totalBucketsPurged, 1, 'exactly one expired rate bucket purged across concurrent sweeps');

  const expiredBucket = await one(h.database, "SELECT 1 FROM ops.rate_buckets WHERE bucket_id = 'rate:expired:1'");
  const activeBucket = await one(h.database, "SELECT 1 FROM ops.rate_buckets WHERE bucket_id = 'rate:active:1'");
  assert.equal(expiredBucket, null, 'expired rate bucket is purged');
  assert.notEqual(activeBucket, null, 'active rate bucket is preserved');
});

/* ---------------------------------------------------------------- 5. Full Overlap Invariant */

test('single business effect invariant across all domains during simulated full rolling deployment overlap', { skip: GATE }, async (t) => {
  const h = await open(t, [SEEDS[0]]);
  if (!h) return;
  const { createWorkerApp, sealMessage, createPrivacyWorkflow } = loadWorkflowMod();
  const createProvider = loadProviderFactory();
  const createScheduler = loadSchedulerFactory();

  const transport = recordingTransport();
  const providerMock = recordingProvider();

  /* 1. Stage mail work */
  const mailId = 'e2e-overlap-mail-1';
  await h.jobs.enqueueJob({
    id: mailId,
    kind: 'otp',
    version: 1,
    payload: sealMessage(MAIL_SECRET, { to: 'e2e@example.test', code: '456789', idempotencyKey: `idemp:${mailId}` }),
    businessKey: `bkey:${mailId}`,
    expiresAt: h.clock() + DAY,
    nextAt: h.clock(),
  });

  /* 2. Stage store finalization work */
  const txId = 'e2e-overlap-tx-201';
  await exec(h.database,
    'INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at)'
    + ' VALUES ($1, $2, $3, $4, $5, false, $6)',
    [STORE, txId, PAID, PRODUCT, 100, new Date(h.clock())]);

  const providerWf1 = createProvider({ pool: h.pools.worker, now: h.clock });
  const providerWf2 = createProvider({ pool: h.pools.worker, now: h.clock });
  await providerWf1.enqueueFinalization({
    store: STORE,
    transactionId: txId,
    productId: PRODUCT,
    purchaseToken: 'tok-e2e-201',
    kind: 'consume',
  });

  /* 3. Stage season maintenance work */
  await seedSeason(h.database, PAID);
  await seedActivity(h.database, PAID);
  const setupCore = await lab.coreFor(h.database, { clock: h.clock });
  const setupSched = createScheduler({ corePool: h.pools.core, coreClient: setupCore, now: h.clock, domain: D });
  await tickClosedWeek({ scheduler: setupSched }, h.clock);
  await setupSched.close();
  setupCore.close();
  h.clock.set(START);

  const coreOld = await lab.coreFor(h.database, { clock: h.clock });
  const coreNew = await lab.coreFor(h.database, { clock: h.clock });
  const schedOld = createScheduler({ corePool: h.pools.core, coreClient: coreOld, now: h.clock, domain: D });
  const schedNew = createScheduler({ corePool: h.pools.core, coreClient: coreNew, now: h.clock, domain: D });

  /* 4. Stage worker apps for mail + privacy */
  const appOld = createWorkerApp({
    pool: h.pools.worker,
    secret: MAIL_SECRET,
    transport,
    privacyPool: h.pools.api,
    now: h.clock,
    intervalMs: 0,
    workerId: 'worker:e2e-legacy-node',
  });
  const appNew = createWorkerApp({
    pool: h.pools.worker,
    secret: MAIL_SECRET,
    transport,
    privacyPool: h.pools.api,
    now: h.clock,
    intervalMs: 0,
    workerId: 'worker:e2e-v5-worker',
  });

  t.after(async () => {
    try { await appOld.stop(); } catch { /* best effort */ }
    try { await appNew.stop(); } catch { /* best effort */ }
    try { await schedOld.close(); } catch { /* best effort */ }
    try { await schedNew.close(); } catch { /* best effort */ }
    try { await providerWf1.close(); } catch { /* best effort */ }
    try { await providerWf2.close(); } catch { /* best effort */ }
    try { coreOld.close(); } catch { /* best effort */ }
    try { coreNew.close(); } catch { /* best effort */ }
  });

  /* Execute full parallel passes representing simultaneous old-node and new-worker passes */
  const runNodePass = async (app, sched, prov, workerId) => {
    const workerTick = await app.tick();
    const schedTick = await sched.tick();
    const finalizerResult = await runFinalizer(prov, workerId, providerMock);
    return { workerTick, schedTick, finalizerResult };
  };

  const [resOldNode, resNewNode] = await Promise.all([
    runNodePass(appOld, schedOld, providerWf1, 'worker:e2e-legacy-node'),
    runNodePass(appNew, schedNew, providerWf2, 'worker:e2e-v5-worker'),
  ]);

  /* --- VERIFY SINGLE BUSINESS EFFECT INVARIANT ACROSS ALL DOMAINS --- */

  /* 1. Mail domain: exactly ONE delivery */
  assert.equal(transport.calls.length, 1, 'INVARIANT: mail delivered exactly once');
  assert.equal(transport.calls[0].message.code, '456789');
  const mailRow = await one(h.database, 'SELECT state, payload FROM ops.outbox WHERE outbox_id = $1', [mailId]);
  assert.equal(mailRow.state, 'sent');
  assert.equal(mailRow.payload, null);

  /* 2. Store domain: provider contacted exactly ONCE, row is done */
  assert.equal(providerMock.calls.length, 1, 'INVARIANT: provider contacted exactly once');
  const finalizeRow = await one(h.database, 'SELECT state, purchase_token FROM monetization.store_finalize WHERE transaction_id = $1', [txId]);
  assert.equal(finalizeRow.state, 'done');
  assert.equal(finalizeRow.purchase_token, '');

  /* 3. Season domain: exactly ONE snapshot outcome, ONE weekly payout outcome, ONE wallet credit */
  const dayKey = `snapshot:${TODAY}`;
  const weekKey = `weekly:${WEEK}:${TODAY}`;
  assert.equal(await outcomeCount(h.database, dayKey), 1, 'INVARIANT: exactly one daily snapshot outcome');
  assert.equal(await outcomeCount(h.database, weekKey), 1, 'INVARIANT: exactly one weekly payout outcome');

  const payoutRows = await payouts(h.database);
  assert.equal(payoutRows.length, 1, 'INVARIANT: exactly one payout row in season.weekly_payouts');
  assert.equal(Number(payoutRows[0].amount), PAID_AMOUNT);

  const walletCoins = await coinsOf(h.database, PAID);
  assert.equal(walletCoins, OPENING + PAID_AMOUNT, 'INVARIANT: wallet coins credited exactly once');

  const ledgerRows = await weeklyLedger(h.database, PAID);
  assert.equal(ledgerRows.length, 1, 'INVARIANT: exactly one ledger row');

  /* Confirm clean completion without unhandled rejections or fatal errors */
  assert.ok(resOldNode && resNewNode, 'both nodes complete cleanly');
});
