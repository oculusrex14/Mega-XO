'use strict';
/* Real PostgreSQL regressions for the A4 idle-compute work (Sol C3 post-commit visibility and
 * Sol R5-3 deadline scoping). Only an owned v5-pg-lab database is used. The worker, guarded
 * pool, transaction boundary and outbox are real; external mail delivery is a recording
 * callback. Run in the promotion-postgres CI job. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lab = require('./v5-pg-lab.js');
const { createPgPool } = require('../packages/db/pg/pool.js');
const { createWorkerApp } = require('../packages/services/worker-workflows.js');
const { createIdleMaintenance, createWriteWakeHooks, DEFAULT_IDLE_PULSE_MS } = require('../scripts/v51/v5-production-server.cjs');

lab.installCleanup(test);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test('a producer held open past the former debounce is delivered by its post-commit wake', { timeout: 180000 }, async (t) => {
  if (!(await lab.boot(t))) return;
  const database = await lab.createDatabase('idle_commit');
  const backend = await lab.ensureBackend();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-idle-commit-'));
  const releaseProducer = deferred(), inserted = deferred(), settled = deferred();
  const errors = [], deliveries = [];
  let maintenance = null, producerCommits = 0, passes = 0, emptyDeadlines = 0, transaction = null;
  const hooks = createWriteWakeHooks({
    wakeWorker: () => maintenance?.wakeWorker(),
    wakeCommerce: () => maintenance?.wakeCommerce(),
    armBackup: () => maintenance?.armBackup(),
  });
  const makePool = (role, onCommit) => createPgPool({
    host: backend.host, port: backend.port, database, user: role, role, label: 'test',
    service: 'v6-idle-commit', revision: 'r3', allowLocalNoTls: true, budget: lab.BUDGET,
    pool: { max: 1, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 },
    statementTimeoutMs: 30000, lockTimeoutMs: 20000, idleInTransactionTimeoutMs: 30000,
    onCommit,
  });
  const producer = makePool('api_runtime', () => { producerCommits++; hooks.onCommit(); });
  const pool = makePool('worker_runtime', hooks.onCommit);
  const app = createWorkerApp({
    pool, redis: null, secret: 'synthetic-a4-commit-test-secret', intervalMs: 0, slowIntervalMs: DEFAULT_IDLE_PULSE_MS,
    transport: {
      async sendOtp(message) { deliveries.push(message); },
      async sendPasswordChanged() {}, async sendSecurityNotice() {},
    },
    log: () => {},
  });
  const worker = {
    start: () => app.start(),
    async tick(options) {
      const result = await app.tick(options);
      // Count COMPLETED passes: an invocation (e.g. armed by an unrelated read lease's
      // advisory wake) can be in flight across the producer commit, so an invocation
      // counter would credit the delivery to a pass captured before beforeCommit.
      passes++;
      if (result.mail.sent === 1) settled.resolve();
      return result;
    },
    async nextWakeAt() {
      const due = await app.nextWakeAt();
      if (due === null) emptyDeadlines++;
      return due;
    },
  };
  t.after(async () => {
    releaseProducer.resolve();
    try { if (transaction) await transaction; } catch {}
    try { await maintenance?.stop(); } finally {
      await app.stop();
      await Promise.allSettled([producer.end(), pool.end()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const id = 'a4-held-producer';
  const message = { to: 'synthetic@example.test', purpose: 'commit-visibility', marker: id };
  transaction = producer.withTransaction(async (tx) => {
    const job = { id, kind: 'otp', payload: app.mailWorker.seal(message) };
    await app.jobService.enqueueJob(job, tx);
    await app.jobService.enqueueJob(job, tx); // two write statements, one successful lease/notification
    inserted.resolve();
    await releaseProducer.promise;
  });
  transaction.catch(() => {}); // awaited below; do not lose an early rejection behind the barrier
  await within(Promise.race([inserted.promise, transaction]), 10000, 'producer did not insert');
  await lab.sleep(1100); // The former one-second pre-send wake could already have been consumed.
  assert.equal(producerCommits, 0);
  maintenance = createIdleMaintenance({ worker, pool, observationFile: path.join(dir, 'worker-observation.json'),
    intervalMs: DEFAULT_IDLE_PULSE_MS, backup: async () => {}, onError: (lane, error) => errors.push([lane, error.message]) });
  await maintenance.start();
  assert.ok(emptyDeadlines > 0, 'the real worker deadline read saw an empty committed queue');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM ops.outbox')).rows[0].n, 0);
  assert.equal(deliveries.length, 0);
  const beforeCommit = passes;
  releaseProducer.resolve();
  await transaction;
  assert.equal(producerCommits, 1, 'the guarded pool must thread onCommit and fire once after commit');
  await within(settled.promise, 5000, 'committed mail was not delivered promptly without a pulse');
  await maintenance.stop();
  assert.equal(maintenance.pulseCount, 0);
  assert.ok(passes > beforeCommit);
  assert.deepEqual(deliveries, [message]);
  assert.equal((await pool.query('SELECT state FROM ops.outbox WHERE outbox_id=$1', [id])).rows[0].state, 'sent');
  assert.deepEqual(errors, []);

  // Lease contract: a rolled-back lease never fires; EVERY successful lease fires exactly once,
  // read-only included - the backup unit's 0070 clock probe, not the hook, decides write-ness.
  await assert.rejects(producer.withTransaction(async (tx) => {
    await app.jobService.enqueueJob({ id: 'a4-rolled-back', kind: 'otp', payload: app.mailWorker.seal(message) }, tx);
    throw Error('intentional rollback');
  }), /intentional rollback/);
  assert.equal(producerCommits, 1, 'a rolled-back lease must not fire');
  await producer.query('SELECT 1');
  assert.equal(producerCommits, 2, 'every successful lease fires once, read-only included');
});

/* Contract-level driver: a due deadline re-arms at now+1000 exactly like the composition's
 * worker lane, parked deadlines sleep out the window, and every pass is counted. No lane, wake
 * or backup internals are asserted, so the R5-2 covered/bare-pass split stays orthogonal. */
const observePasses = async (workerApp, windowMs) => {
  let passes = 0;
  let nowAt = Date.now();
  const end = nowAt + windowMs;
  while (nowAt < end) {
    const wake = await workerApp.nextWakeAt();
    nowAt = Date.now();
    if (wake !== null && wake <= nowAt) {
      passes += 1;
      await workerApp.tick({ includeSlow: false });
      nowAt = Date.now();
      if (nowAt >= end) break;
      await lab.sleep(Math.min(1000, end - nowAt));
      nowAt = Date.now();
      continue;
    }
    const parked = wake === null ? end - nowAt : Math.min(wake - nowAt, end - nowAt);
    if (parked > 0) { await lab.sleep(parked); nowAt = Date.now(); }
  }
  return passes;
};
const outboxState = async (pool, id) =>
  (await pool.query('SELECT state FROM ops.outbox WHERE outbox_id = $1', [id])).rows[0]?.state ?? null;

test('deadlines come only from claimable kinds: strangers never poll, owned work delivers', { timeout: 240000 }, async (t) => {
  if (!(await lab.boot(t))) return;
  const database = await lab.createDatabase('idle_r53');
  const backend = await lab.ensureBackend();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v6-idle-r53-'));
  const makePool = (role) => createPgPool({
    host: backend.host, port: backend.port, database, user: role, role, label: 'test',
    service: 'v6-idle-r53', revision: 'r53', allowLocalNoTls: true, budget: lab.BUDGET,
    pool: { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 },
    statementTimeoutMs: 30000, lockTimeoutMs: 20000, idleInTransactionTimeoutMs: 30000,
  });
  const producer = makePool('api_runtime');
  const pool = makePool('worker_runtime');
  const deliveries = [];
  const app = createWorkerApp({
    pool, redis: null, secret: 'synthetic-a4-r53-mail-secret', intervalMs: 0, slowIntervalMs: DEFAULT_IDLE_PULSE_MS,
    transport: { async sendOtp(message) { deliveries.push(message); }, async sendPasswordChanged() {}, async sendSecurityNotice() {} },
    log: () => {},
  });
  t.after(async () => { try { await app.stop(); } finally { await Promise.allSettled([producer.end(), pool.end()]); fs.rmSync(dir, { recursive: true, force: true }); } });

  const admin = await lab.adminClient(database);
  try {
    /* Unrelated kinds, DUE now: other workers' obligations (Sol R5-3's one-second-loop scenario). */
    await admin.query("INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at, attempts) VALUES"
      + " ('r5_commerce_due', '{}', 'commerce.command', 'queued', now(), now() + interval '7 days', now() - interval '5 minutes', 0),"
      + " ('r5_tournament_due', '{}', 'tournament.settle', 'queued', now(), now() + interval '7 days', now() - interval '5 minutes', 0)");
  } finally { await admin.end(); }

  // A transport-disabled worker can never claim mail: with only stranger rows present (one of
  // them past due) its deadline is null, proving mail rows cannot create deadlines unserviceably.
  const disabledApp = createWorkerApp({
    pool, redis: null, secret: 'synthetic-a4-r53-mail-secret', intervalMs: 0, slowIntervalMs: DEFAULT_IDLE_PULSE_MS,
    transport: { enabled: () => false, async sendOtp() {}, async sendPasswordChanged() {}, async sendSecurityNotice() {} },
    log: () => {},
  });
  t.after(() => disabledApp.stop());
  assert.equal(await disabledApp.nextWakeAt(), null, 'an unserviceable mail queue never creates a deadline');

  // Future-dated owned work: the deadline must be the earliest OWNED one, not a past-due stranger.
  const mailFutureAt = Date.now() + 3600000;
  const deletionFutureAt = Date.now() + 7200000;
  await app.jobService.enqueueJob({ id: 'r5_future_mail', kind: 'otp', payload: app.mailWorker.seal({ marker: 'r5-future' }), nextAt: mailFutureAt }, producer);
  await app.jobService.enqueueJob({ id: 'r5_future_deletion', kind: 'account.deletion', payload: '{}', nextAt: deletionFutureAt }, producer);
  const parked = await app.nextWakeAt();
  assert.ok(parked !== null && parked > Date.now() && Math.abs(parked - mailFutureAt) < 60000,
    'the deadline is the earliest claimable row, not a past-due stranger');
  assert.equal(await observePasses(app, 2600), 0, 'no one-second polling while only strangers are due');

  // An owned due deadline delivers promptly - inside the same window strangers would have looped.
  const dueMessage = { marker: 'r5-due', to: 'synthetic@example.test', purpose: 'r53' };
  await app.jobService.enqueueJob({ id: 'r5_due_mail', kind: 'otp', payload: app.mailWorker.seal(dueMessage) }, producer);
  assert.equal(await observePasses(app, 6000), 1, 'exactly one pass: claim+deliver, then park on the future deadline');
  assert.deepEqual(deliveries, [dueMessage]);
  assert.equal(await outboxState(pool, 'r5_due_mail'), 'sent');
  assert.equal(await outboxState(pool, 'r5_commerce_due'), 'queued', 'stranger rows are never claimed');

  // Budget deferral: an exhausted daily allowance parks a DUE mail job at the UTC rollover.
  const budgetDeliveries = [];
  const budgetApp = createWorkerApp({
    pool, redis: null, secret: 'synthetic-a4-r53-budget-secret', intervalMs: 0, slowIntervalMs: DEFAULT_IDLE_PULSE_MS,
    dailyLimit: 1,
    transport: { async sendOtp(message) { budgetDeliveries.push(message); }, async sendPasswordChanged() {}, async sendSecurityNotice() {} },
    log: () => {},
  });
  t.after(() => budgetApp.stop());
  const firstBudgetMessage = { marker: 'r5-budget-1' };
  await budgetApp.jobService.enqueueJob({ id: 'r5_budget_mail_1', kind: 'otp', payload: budgetApp.mailWorker.seal(firstBudgetMessage) }, producer);
  assert.equal(await observePasses(budgetApp, 6000), 1);
  assert.deepEqual(budgetDeliveries, [firstBudgetMessage]);
  await budgetApp.jobService.enqueueJob({ id: 'r5_budget_mail_2', kind: 'otp', payload: budgetApp.mailWorker.seal({ marker: 'r5-budget-2' }) }, producer);
  const parkedByBudget = await budgetApp.nextWakeAt();
  assert.ok(parkedByBudget > Date.now(), 'an exhausted budget parks the due mail deadline instead of arming now+1000');
  assert.ok(parkedByBudget <= Date.now() + 2 * 86400000, 'the park is bounded by the next UTC rollover');
  assert.equal(await observePasses(budgetApp, 2600), 0, 'a budget-deferred due mail job must not poll');
  const deferredTick = await budgetApp.tick({ includeSlow: false });
  assert.equal(deferredTick.mail.sent, 0);
  assert.equal(deferredTick.mail.deferred, true);
});
