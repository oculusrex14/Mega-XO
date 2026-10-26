'use strict';
/* Real PostgreSQL visibility regression for Sol C3. Only an owned v5-pg-lab database is
 * used. The worker, guarded pool, transaction boundary and outbox are real; external mail
 * delivery and systemctl are recording callbacks. Run in the promotion-postgres CI job. */
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
