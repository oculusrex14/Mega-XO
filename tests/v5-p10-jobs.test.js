'use strict';
/* tests/v5-p10-jobs.test.js - V5 P10 task V5-10-01 (Implement durable job and outbox primitives).
 *
 * SCOPE. Exercises `packages/services/jobs.js` (`createJobService({ pool, now, maxAttempts,
 * backoffBaseMs, defaultLeaseMs })`) against a REAL owned PostgreSQL 16 database built by the
 * REAL checksummed migration chain (`tests/v5-pg-lab.js`). The service owns `ops.outbox` under the
 * `worker_runtime` role (SELECT, INSERT, UPDATE, DELETE - migration 0022), so every assertion here
 * reads the committed durable row back, never an in-memory mirror. No SQLite, no mock, no fake
 * provider.
 *
 * WHAT IS PROVEN (the five behaviours the task requires plus the transactional-producer seam):
 *
 *   1. ROUND TRIP. A typed/versioned envelope (`{version, payload, businessKey}`) is written with
 *      `state='queued'`, `attempts=0`, a 1970 lease and the 24h default expiry; `claimJobs` hands
 *      back the decoded payload, version, businessKey, post-increment attempt count and a fence;
 *      `completeJob` seals the payload (`payload = NULL`, `state='sent'`).
 *   2. TRANSACTIONAL PRODUCER. `enqueueJob(spec, tx)` writes the row on the CALLER's connection, so
 *      a producer that aborts its business transaction leaves NO job behind (no partial enqueue),
 *      while a committed producer does.
 *   3. CRASH DURING I/O. A worker that claims and dies is reclaimed by a peer only AFTER the lease
 *      expires; nothing is claimable while the lease is live, the reclaim advances the attempt
 *      count and carries a newer fence.
 *   4. STALE WORKER REJECTED. After a lease takeover the superseded owner cannot complete the job
 *      with its old fence (nor by borrowing the new one); only the current owner+fence commits.
 *   5. EXPONENTIAL BACKOFF + DEAD LETTER. Failures retry with `base * 2^(attempts-1)` delay and are
 *      not claimable before that delay elapses; the attempt that reaches `maxAttempts` moves the
 *      job to `state='failed'` with its payload destroyed, and it is never claimed again.
 *   6. OPERATOR INSPECTION + RETRY. `listDeadLetters` returns the failed jobs newest-first,
 *      `retryDeadLetter` resets one to `queued` (attempts 0, due now, no lease) and a worker can
 *      then claim and complete it.
 *
 * CLOCK. The service clock is injected (`now: () => clock`); every due/expiry/lease/backoff
 * comparison binds that instant as a parameter, so advancing the clock IS the lease expiring and
 * IS the backoff elapsing. Nothing here waits on wall time.
 *
 * GATING (the repo convention): needs the owned PostgreSQL lab (`V5_PG_URL`, or `V5_PG_REQUIRED=1`
 * to fail instead of skip). Absent it every test skips. Teardown is `lab.installCleanup` (guarded
 * pools closed, owned databases dropped) plus a per-test `t.after` that closes the service; the
 * process exits naturally - no force-exit, no `process.exit`.
 *
 * Run: node --test --test-concurrency=1 tests/v5-p10-jobs.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');

/* Close every guarded pool and drop every owned database, AFTER this suite's own `t.after` closes
 * the service instances. Natural process exit: no forceExit, no explicit process.exit. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

const CLOCK = lab.CLOCK;
const DAY = lab.DAY;
const EPOCH = Date.parse('1970-01-01T00:00:00Z');

/* The job service is loaded lazily, so a checkout without the P10 module skips (rather than throws
 * at require time) when the gate is unset. */
let jobFactory = null;
function loadJobFactory() {
 if (!jobFactory) {
  const mod = require('../packages/services/jobs.js');
  assert.equal(typeof mod.createJobService, 'function',
   'packages/services/jobs.js must export createJobService');
  jobFactory = mod.createJobService;
 }
 return jobFactory;
}

/* Two workers with genuinely different identities: a fence is only meaningful between distinct
 * owners, so the tests never reuse one worker string for both sides. */
const WORKER_A = 'worker:jobs-a';
const WORKER_B = 'worker:jobs-b';

/* Every service entry point the suite drives must exist and be a function before a gated case may
 * run: an absent method is a hard failure on a gated checkout, never a silently passing skip. */
const JOB_METHODS = Object.freeze(['enqueueJob', 'claimJobs', 'completeJob', 'failJob',
 'listDeadLetters', 'retryDeadLetter', 'cancelJob', 'expireDueJobs', 'close']);
function jobMethods(service) {
 const bound = {};
 for (const name of JOB_METHODS) {
  assert.equal(typeof service[name], 'function', `the job service must expose ${name}()`);
  bound[name] = service[name].bind(service);
 }
 return bound;
}

/* A `timestamptz` read back from PostgreSQL surfaces as a Date, while a service return may hand
 * back an ISO string or an epoch number; all three name ONE instant, so it is normalized to epoch
 * milliseconds before it is judged. Anything that is not a real instant is a failure. */
function msOf(value, what) {
 const ms = value instanceof Date ? value.getTime()
  : typeof value === 'number' ? value
   : typeof value === 'string' ? Date.parse(value) : NaN;
 assert.ok(Number.isFinite(ms), `expected a real millisecond ${what} (saw ${String(value)})`);
 return ms;
}

/* One owned database, its guarded worker pool, one live job service bound to that pool and a
 * controllable clock. `t.after` closes the service; the pool is caller-owned and outlives it (the
 * lab closes every borrowed pool only after this suite's own teardown). */
let dbSeq = 0;
async function open(t) {
 if (!(await lab.boot(t))) return null;
 const create = loadJobFactory();
 const database = await lab.createDatabase(`p10j${dbSeq++}`);
 const pools = lab.poolsFor(database);
 let clock = CLOCK;
 const now = () => clock;
 const service = create({ pool: pools.worker, now });
 t.after(async () => { try { await service.close(); } catch { /* best effort */ } });
 const methods = jobMethods(service);
 /* A superuser statement for harness-only durable probes; nothing a runtime role does. */
 const exec = async (text, params = []) => {
  const client = await lab.adminClient(database);
  try { return await client.query(text, params); } finally { await client.end(); }
 };
 /* The committed `ops.outbox` row for one id - the durable authority every assertion reads. */
 const raw = async (id) => (await exec('SELECT outbox_id, payload, kind, state, attempts, lease_owner,'
  + ' lease_token, created_at, expires_at, next_at, lease_until FROM ops.outbox WHERE outbox_id = $1', [id])).rows[0] ?? null;
 return { ...methods, pools, raw, now, advance: (ms) => { clock += ms; return clock; } };
}

/* A generic typed job spec; callers override only the fields that matter to their case. */
const specFor = (id, over = {}) => ({
 id, kind: 'test.job', version: 1, payload: { task: 'noop' }, businessKey: null, ...over,
});

/* Drive one job to the dead-letter state through the public surface: claim/fail exactly
 * `maxAttempts` times, waiting out each backoff. Returns the committed failed row. */
async function driveDead(h, id, maxAttempts = 3) {
 for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const claimed = await h.claimJobs({ workerId: WORKER_A, limit: 1, leaseMs: 1000 });
  assert.equal(claimed.length, 1, `attempt ${attempt} claims the due job`);
  assert.equal(claimed[0].id, id, `attempt ${attempt} claims exactly the job under test`);
  assert.equal(Number(claimed[0].attempts), attempt);
  const failed = await h.failJob({ id, workerId: WORKER_A, fence: claimed[0].fence, error: `attempt ${attempt} failed` });
  assert.equal(failed.deadLetter, attempt === maxAttempts,
   `attempt ${attempt} of ${maxAttempts} ${attempt === maxAttempts ? 'dead-letters' : 'retries'} the job`);
  if (attempt < maxAttempts) h.advance(1000 * 2 ** (attempt - 1) + 1);
 }
 const dead = await h.raw(id);
 assert.equal(dead.state, 'failed');
 return dead;
}

/* ============ 1. enqueue -> claim -> complete, versioned envelope, sealed payload ============ */

test('V5-10-01: a queued job is claimed with a worker fence and completed with its payload sealed', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = 'job:round-trip';
 const payload = { recipient: 'svc_alice@example.test', template: 'verify', nonce: 'N-1' };
 const businessKey = 'verify:svc_alice';
 await h.enqueueJob(specFor(id, { kind: 'mail.verification', payload, version: 2, businessKey }));

 const queued = await h.raw(id);
 assert.ok(queued, 'enqueueJob writes the durable ops.outbox row');
 assert.equal(queued.state, 'queued', 'a new job is queued');
 assert.equal(queued.attempts, 0, 'a new job has no attempts');
 assert.equal(queued.kind, 'mail.verification', 'the kind is stored verbatim');
 assert.equal(msOf(queued.lease_until, 'lease_until'), EPOCH, 'an unclaimed row carries the 1970 lease, not a live one');
 assert.equal(msOf(queued.next_at, 'next_at'), CLOCK, 'a fresh job is due immediately');
 assert.equal(msOf(queued.expires_at, 'expires_at'), CLOCK + DAY, 'the default expiry is 24h from now');
 const envelope = JSON.parse(queued.payload);
 assert.equal(envelope.version, 2, 'the envelope carries the payload version');
 assert.equal(envelope.businessKey, businessKey, 'the envelope carries the business idempotency key');
 assert.deepEqual(envelope.payload, payload, 'the envelope carries the typed payload verbatim');

 const claimed = await h.claimJobs({ workerId: WORKER_A, limit: 16 });
 assert.equal(claimed.length, 1, 'exactly the one due job is claimed');
 const job = claimed[0];
 assert.equal(job.id, id, 'the claimed job names its outbox id');
 assert.equal(job.kind, 'mail.verification');
 assert.equal(job.version, 2, 'the claim exposes the envelope version');
 assert.equal(job.businessKey, businessKey, 'the claim exposes the business key');
 assert.deepEqual(job.payload, payload, 'the claim exposes the decoded typed payload');
 assert.equal(Number(job.attempts), 1, 'claiming counts the first attempt');
 assert.equal(Number(job.fence), 1, 'the first claim mints fence 1');
 assert.equal(msOf(job.expiresAt, 'expiresAt'), CLOCK + DAY, 'the claim echoes the durable expiry');

 const sending = await h.raw(id);
 assert.equal(sending.state, 'sending', 'a claimed job is in flight');
 assert.equal(sending.lease_owner, WORKER_A, 'the lease is owned by the claiming worker');
 assert.equal(Number(sending.lease_token), 1, 'the durable row records the fence');
 assert.equal(msOf(sending.lease_until, 'lease_until'), CLOCK + 30000, 'the default lease window is honoured');

 assert.equal(await h.completeJob({ id, workerId: WORKER_A, fence: job.fence }), true, 'the current owner completes the job');
 const done = await h.raw(id);
 assert.equal(done.state, 'sent', 'completion is terminal');
 assert.equal(done.payload, null, 'completion seals the payload to NULL');
 assert.equal(done.lease_owner, null, 'completion releases the lease owner');
 assert.equal(msOf(done.lease_until, 'lease_until'), EPOCH, 'completion resets the lease window');
 assert.equal(Number(done.attempts), 1, 'completion preserves the attempt count as history');
 assert.equal(Number(done.lease_token), 1, 'completion never rewrites the fence');
});

/* ===================== 2. producer enqueues inside its business transaction ===================== */

test('V5-10-01: a producer enqueues on its own transaction; an aborted business transaction leaves no job', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = 'job:tx-producer';
 const spec = specFor(id, { kind: 'purchase.finalize', payload: { purchase: 'p-1' }, businessKey: 'purchase:p-1' });

 /* The producer writes the outbox row on the SAME connection as its business work, then aborts. */
 await assert.rejects(
  h.pools.worker.withTransaction(async (tx) => {
   await h.enqueueJob(spec, tx);
   const inside = await tx.query('SELECT state FROM ops.outbox WHERE outbox_id = $1', [id]);
   assert.equal(inside.rows.length, 1, 'the outbox row is visible inside the producer transaction');
   assert.equal(inside.rows[0].state, 'queued');
   throw new Error('producer aborts');
  }),
  /producer aborts/);
 assert.equal(await h.raw(id), null, 'the aborted business transaction leaves NO job behind');

 /* The committed producer is durable. */
 await h.pools.worker.withTransaction(async (tx) => { await h.enqueueJob(spec, tx); });
 const committed = await h.raw(id);
 assert.equal(committed.state, 'queued', 'the committed producer row survives');
 assert.equal(JSON.parse(committed.payload).businessKey, 'purchase:p-1');
});

/* ==================== 3. crash during I/O: lease expiry then recovery ==================== */

test('V5-10-01: a worker that dies mid-I/O is reclaimed only after its lease expires, and the attempt advances', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = 'job:crash';
 await h.enqueueJob(specFor(id, { kind: 'mail.notification', payload: { to: 'svc_alice' } }));

 const first = await h.claimJobs({ workerId: WORKER_A, limit: 1, leaseMs: 1000 });
 assert.equal(first.length, 1, 'worker A claims the job at t=0');
 assert.equal(Number(first[0].attempts), 1);
 assert.equal(Number(first[0].fence), 1);

 /* Worker A dies during its I/O: nothing completes, nothing is released. */
 const whileLeased = await h.claimJobs({ workerId: WORKER_B, limit: 1, leaseMs: 1000 });
 assert.deepEqual(whileLeased, [], 'a live lease cannot be stolen before it expires');

 h.advance(1001);
 const second = await h.claimJobs({ workerId: WORKER_B, limit: 1, leaseMs: 1000 });
 assert.equal(second.length, 1, 'worker B reclaims the job after the lease expires');
 assert.equal(second[0].id, id, 'the reclaim is the SAME job, not a copy');
 assert.equal(Number(second[0].attempts), 2, 'the crashed attempt is counted');
 assert.equal(Number(second[0].fence), 2, 'the reclaim mints a newer fence');
 assert.deepEqual(second[0].payload, { to: 'svc_alice' }, 'the reclaim carries the same payload');

 assert.equal(await h.completeJob({ id, workerId: WORKER_B, fence: second[0].fence }), true, 'worker B completes the recovered job');
 const done = await h.raw(id);
 assert.equal(done.state, 'sent');
 assert.equal(done.payload, null, 'recovery ends with a sealed job');
 assert.equal(Number(done.attempts), 2, 'the durable attempt history shows the crash');
});

/* ==================== 4. stale worker rejected after a fence takeover ==================== */

test('V5-10-01: a stale owner whose fence was superseded cannot complete the new claim', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = 'job:stale';
 await h.enqueueJob(specFor(id));

 const a = await h.claimJobs({ workerId: WORKER_A, limit: 1, leaseMs: 1000 });
 assert.equal(a.length, 1);
 assert.equal(Number(a[0].fence), 1, 'worker A holds fence 1');

 h.advance(1001);
 const b = await h.claimJobs({ workerId: WORKER_B, limit: 1, leaseMs: 1000 });
 assert.equal(b.length, 1);
 assert.equal(Number(b[0].fence), 2, 'worker B takes over with fence 2');

 assert.equal(await h.completeJob({ id, workerId: WORKER_A, fence: a[0].fence }), false,
  'the superseded owner is rejected with its old fence');
 const still = await h.raw(id);
 assert.equal(still.state, 'sending', 'the rejected call changes nothing');
 assert.equal(still.lease_owner, WORKER_B, 'the lease still belongs to the new owner');
 assert.equal(Number(still.lease_token), 2, 'the durable fence is still the new one');

 assert.equal(await h.completeJob({ id, workerId: WORKER_A, fence: b[0].fence }), false,
  'the old owner also cannot borrow the new fence: the owner is checked too');
 assert.equal(await h.completeJob({ id, workerId: WORKER_B, fence: b[0].fence }), true,
  'only the current owner with the current fence completes');
 assert.equal((await h.raw(id)).state, 'sent');
});

/* ================= 5. exponential backoff and the dead-letter transition ================= */

test('V5-10-01: failures back off exponentially and the attempt that reaches maxAttempts dead-letters the job', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = 'job:backoff';
 await h.enqueueJob(specFor(id));

 const first = await h.claimJobs({ workerId: WORKER_A, limit: 1, leaseMs: 1000 });
 assert.equal(Number(first[0].attempts), 1);
 const f1 = await h.failJob({ id, workerId: WORKER_A, fence: first[0].fence, error: 'smtp 421 temporary' });
 assert.equal(f1.deadLetter, false, 'the first failure is retryable');
 assert.equal(Number(f1.attempts), 1, 'the failure reports the attempt it consumed');
 assert.equal(msOf(f1.nextAt, 'nextAt'), CLOCK + 1000, 'the first retry waits one base interval');
 const r1 = await h.raw(id);
 assert.equal(r1.state, 'queued', 'a retryable failure returns the job to the queue');
 assert.equal(r1.lease_owner, null, 'the failed lease is released');
 assert.equal(msOf(r1.lease_until, 'lease_until'), EPOCH, 'the failed lease window is reset');
 assert.equal(msOf(r1.next_at, 'next_at'), CLOCK + 1000, 'the retry instant is durable');
 assert.equal(Number(r1.lease_token), 1, 'the fence is not cleared by a failure');

 assert.deepEqual(await h.claimJobs({ workerId: WORKER_A, limit: 1 }), [],
  'the job is not claimable before its backoff elapses');
 h.advance(1000);
 const second = await h.claimJobs({ workerId: WORKER_A, limit: 1, leaseMs: 1000 });
 assert.equal(Number(second[0].attempts), 2);
 const f2 = await h.failJob({ id, workerId: WORKER_A, fence: second[0].fence, error: 'smtp 421 temporary' });
 assert.equal(f2.deadLetter, false, 'the second failure still retries');
 assert.equal(msOf(f2.nextAt, 'nextAt'), h.now() + 2000, 'the second retry doubles the interval');
 assert.equal(msOf((await h.raw(id)).next_at, 'next_at'), h.now() + 2000, 'the doubled instant is durable');

 h.advance(2000);
 const third = await h.claimJobs({ workerId: WORKER_A, limit: 1, leaseMs: 1000 });
 assert.equal(Number(third[0].attempts), 3, 'the final attempt is claimable when maxAttempts is three');
 const f3 = await h.failJob({ id, workerId: WORKER_A, fence: third[0].fence, error: 'smtp 550 permanent' });
 assert.equal(f3.deadLetter, true, 'the attempt that reaches maxAttempts dead-letters the job');
 assert.equal(Number(f3.attempts), 3);
 assert.equal(f3.nextAt, null, 'a dead letter has no next attempt');

 const dead = await h.raw(id);
 assert.equal(dead.state, 'failed', 'the exhausted job lands in the dead-letter state');
 assert.equal(dead.payload, null, 'the sealed payload is destroyed on dead-letter');
 assert.equal(dead.lease_owner, null, 'the dead letter holds no lease');
 assert.equal(msOf(dead.lease_until, 'lease_until'), EPOCH);
 assert.deepEqual(await h.claimJobs({ workerId: WORKER_B, limit: 1 }), [],
  'an exhausted job is never claimed again');
});

/* ==================== 6. operator dead-letter inspection and retry ==================== */

test('V5-10-01: an operator lists dead letters newest-first and retries one to a fresh completion', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const older = 'job:dlq-older';
 const newer = 'job:dlq-newer';

 await h.enqueueJob(specFor(older, { kind: 'mail.notification' }));
 await driveDead(h, older);
 h.advance(5000);
 await h.enqueueJob(specFor(newer, { kind: 'purchase.finalize' }));
 await driveDead(h, newer);

 const list = await h.listDeadLetters({ limit: 50 });
 const ids = list.map((r) => r.outbox_id);
 assert.ok(ids.includes(older), 'the older dead letter is listed');
 assert.ok(ids.includes(newer), 'the newer dead letter is listed');
 assert.equal(ids[0], newer, 'dead letters are listed newest-first');
 for (const r of list) {
  assert.equal(typeof r.outbox_id, 'string', 'a dead letter names its outbox id');
  assert.equal(typeof r.kind, 'string', 'a dead letter names its kind');
  assert.equal(Number(r.attempts), 3, 'a listed dead letter reports its exhausted attempt count');
 }
 const times = list.map((r) => msOf(r.created_at, 'created_at'));
 assert.ok(times.every((v) => Number.isFinite(v)), 'every dead letter carries a real created_at');
 for (let i = 1; i < times.length; i += 1) assert.ok(times[i - 1] >= times[i], 'the listing is ordered by created_at DESC');

 assert.equal(await h.retryDeadLetter({ id: 'job:no-such-id' }), false, 'retrying a job that is not a dead letter is a no-op');
 assert.equal(await h.retryDeadLetter({ id: older }), true, 'the operator retries the dead letter');
 const reset = await h.raw(older);
 assert.equal(reset.state, 'queued', 'a retried job returns to the queue');
 assert.equal(Number(reset.attempts), 0, 'a retried job gets a fresh attempt budget');
 assert.equal(msOf(reset.next_at, 'next_at'), h.now(), 'a retried job is due immediately');
 assert.equal(reset.lease_owner, null, 'a retried job holds no lease');

 const reclaimed = await h.claimJobs({ workerId: WORKER_B, limit: 1, leaseMs: 1000 });
 assert.equal(reclaimed.length, 1, 'the retried job is claimable again');
 assert.equal(reclaimed[0].id, older, 'the operator retried the job under test');
 assert.equal(Number(reclaimed[0].attempts), 1, 'the fresh budget starts at attempt one');
 assert.equal(await h.completeJob({ id: older, workerId: WORKER_B, fence: reclaimed[0].fence }), true,
  'the retried job completes normally');
 assert.equal((await h.raw(older)).state, 'sent');
 assert.equal(await h.retryDeadLetter({ id: newer }), true, 'the other dead letter is independently retryable');
});
