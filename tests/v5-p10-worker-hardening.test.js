'use strict';
/* P10 standalone lifecycle/budget regressions. No database, provider credentials or
 * network are needed: these tests check the worker orchestration boundary directly.
 * Real PostgreSQL lease, retry and economy proofs remain in the five P10 suites. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailWorker, createWorkerApp, sealMessage } = require('../packages/services/worker-workflows.js');

const SECRET = 'mega-xo-p10-hardening-synthetic-secret';
const AT = Date.parse('2026-10-09T12:00:00Z');
const message = (id) => ({ to: 'test@example.invalid', code: String(id), purpose: 'test', idempotencyKey: 'test:' + id });
const makeJob = (id) => ({ id: 'mail:test:otp:' + id, kind: 'otp', payload: sealMessage(SECRET, message(id)), fence: 1, attempts: 1 });

test('P10 daily/monthly mail caps bound the claim itself, not only whether a claim starts', async () => {
 const pending = [makeJob(1), makeJob(2), makeJob(3)];
 const limits = [];
 const sent = [];
 const jobs = {
  async claimJobs(options) { limits.push(options.limit); return pending.splice(0, options.limit); },
  async completeJob() { return true; },
  async failJob() { throw Error('UNEXPECTED_FAILURE'); },
  async cancelJob() { return false; },
 };
 const transport = {
  async sendOtp(m) { sent.push(m); },
  async sendPasswordChanged() {},
  async sendSecurityNotice() {},
 };
 const worker = createMailWorker({
  jobService: jobs, transport, secret: SECRET, now: () => AT,
  dailyLimit: 2, monthlyLimit: 2, limit: 16, workerId: 'worker:budget-cap',
 });
 const first = await worker.tick();
 assert.deepEqual(limits, [2], 'the claim must not exceed the two remaining mail credits');
 assert.equal(first.sent, 2);
 assert.equal(sent.length, 2);
 assert.equal(pending.length, 1, 'the third job remains queued, not leased then abandoned');
 const second = await worker.tick();
 assert.equal(second.deferred, true, 'a spent daily/monthly budget stops claiming');
 assert.deepEqual(limits, [2], 'there must not be another claim after the cap is reached');
 worker.close();
});

test('P10 stop waits for a delivery already in progress before acknowledging shutdown', async () => {
 let announce;
 let release;
 const deliveryStarted = new Promise((resolve) => { announce = resolve; });
 const deliveryGate = new Promise((resolve) => { release = resolve; });
 let sent = 0;
 let completed = 0;
 const pending = [makeJob('drain')];
 const jobs = {
  async expireDueJobs() { return 0; },
  async claimJobs({ limit }) { return pending.splice(0, limit); },
  async completeJob() { completed += 1; return true; },
  async failJob() { throw Error('UNEXPECTED_FAILURE'); },
  async cancelJob() { return false; },
 };
 const transport = {
  async sendOtp() { announce(); await deliveryGate; sent += 1; },
  async sendPasswordChanged() {},
  async sendSecurityNotice() {},
 };
 const pool = { async query() { return { rowCount: 0, rows: [] }; } };
 const app = createWorkerApp({
  pool, jobService: jobs, transport, secret: SECRET, intervalMs: 0,
  now: () => AT, workerId: 'worker:shutdown-drain', limit: 1,
 });
 const tick = app.tick();
 let stop;
 try {
  await deliveryStarted;
  let stopped = false;
  stop = app.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'stop must not resolve during the outstanding provider operation');
  assert.equal(completed, 0, 'the outbox is not yet durably settled');
  release();
  await Promise.all([tick, stop]);
  assert.equal(stopped, true);
  assert.equal(sent, 1);
  assert.equal(completed, 1, 'stop resolves only after the already-claimed job has settled');
  assert.equal(app.started, false);
  await assert.rejects(async () => app.tick(), /WORKER_CLOSED/);
 } finally {
  release();
  if (stop) await stop;
 }
});
