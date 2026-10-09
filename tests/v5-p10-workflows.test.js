'use strict';
/* tests/v5-p10-workflows.test.js - V5 P10 task V5-10-02 (Extract email/security/privacy work).
 *
 * SCOPE. Exercises the extracted worker surface - `packages/services/worker-workflows.js`
 * (`createMailWorker`, `createPrivacyWorkflow`) and `apps/worker/index.js` (`createWorkerApp`) - against
 * the REAL owned loopback PostgreSQL 16 lab (`tests/v5-pg-lab.js`: the checksummed migration chain,
 * guarded role pools, synthetic actors). No SQLite, no in-memory fake queue, no stub job service: every
 * assertion reads the committed `ops.outbox` / `ops.rate_buckets` rows back through a superuser probe
 * client, exactly as the P10 job suite does. The only doubles are the two edges the real system also
 * injects: a recording TRANSPORT (the provider network is not reachable from a unit test) and a
 * recording LOGGER (the thing under test is what it writes).
 *
 * WHAT THIS SUITE PROVES (the parent ticket's six cases; G10: unrelated jobs survive restarts and
 * restricted payloads/OTP values never leak into logs):
 *
 *   1. ENCRYPTED EMAIL DELIVERY AND SEALED COMPLETION. A producer enqueues an OTP job whose
 *      `payload.payload` is the base64url `iv.tag.data` AES-256-GCM envelope keyed by
 *      HKDF(sha256, secret, salt='', info='mega-xo-v4-mail', 32). The worker claims the batch, decrypts
 *      it, delivers the exact `{to, code, purpose, idempotencyKey}` message to the transport's
 *      `sendOtp`, and completes the row: `state='sent'`, `payload IS NULL`, lease released. The same
 *      case proves the envelope in BOTH directions through the worker's own `seal`/`open`.
 *   1b. KIND ROUTING. Every documented kind reaches its transport edge - `otp` -> `sendOtp`, `changed`
 *      -> `sendPasswordChanged`, `security` -> `sendSecurityNotice` - delivering the exact decrypted
 *      body of each, and every terminal row is sealed. The generic `mail` kind is asserted only to
 *      reach SOME transport method, because the frozen contract pins no method for it.
 *   2. SANITIZED LOGGING. The recording logger captures every entry the worker emits. The OTP code, the
 *      recipient address, the mail secret and the raw ciphertext appear in NONE of them; the only mail
 *      event is the sanitized `{event, id, kind}` record.
 *   3. CORE RESTART DOES NOT DROP JOBS. A job durably enqueued before a "restart" (worker instance #1
 *      built and never ticked, then discarded) is still `queued` in PostgreSQL and is claimed, opened
 *      and delivered by the FRESH worker instance #2 over the same database.
 *   4. PRIVACY/DELETION CANCELLATION. `cancelActorOutbox(actor)` moves every queued/sending outbox row
 *      whose durable identity carries the deleting actor's prefix to the terminal `cancelled` state
 *      with its payload sealed to NULL, while a control actor's identically shaped rows are untouched.
 *   5. RETENTION AND CLEANUP. `purgeExpiredRetention()` removes terminal outbox rows created before the
 *      7-day window and preserves recent terminal rows AND every active (`queued`/`sending`) row, even
 *      once the clock crosses the window; `purgeExpiredRateBuckets()` deletes expired buckets and
 *      preserves live and non-expiring ones.
 *   6. CLEAN LIFECYCLE AND TEARDOWN. `createWorkerApp.start()` arms a real periodic interval (proved by
 *      draining a job with no explicit tick) which `stop()` synchronously disarms (proved by a fresh job
 *      that stays `queued` across many interval periods); `tick()` reports its mail/expiry/retention
 *      summary; and `lab.installCleanup` then drops the guarded pools and owned databases - natural
 *      process exit, no force-exit.
 *
 * GATING (the repo convention): needs the owned PostgreSQL lab (`V5_PG_URL`, or `V5_PG_REQUIRED=1` to
 * fail instead of skip). Absent it, every test skips; the modules are loaded lazily so a checkout
 * without the P10 workflow files skips rather than throwing at require time.
 *
 *   env V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
 *       node --test --test-concurrency=1 tests/v5-p10-workflows.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');

/* Close every guarded pool (worker/api) and drop every owned database, AFTER this suite's own
 * `t.after` stops the worker apps. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

const CLOCK = lab.CLOCK;
const DAY = lab.DAY;

/* A stable synthetic mail secret (the same shape the account service uses) and the actor/recipient
 * fixtures. `svc_alice` is the deleting actor; `svc_bob` is the untouched control. */
const MAIL_SECRET = 'v5-p10-workflows-otp-secret';
const ALICE = 'svc_alice';
const BOB = 'svc_bob';
const ALICE_TO = 'alice@example.test';

/* --------------------------------------------------------------- modules */

/* Both worker modules are loaded lazily: an absent P10 file must SKIP (gate unset), never throw. */
let workflowFactory = null;
function loadWorkflowFactory() {
 if (!workflowFactory) {
  const mod = require('../packages/services/worker-workflows.js');
  assert.equal(typeof mod.createMailWorker, 'function',
   'packages/services/worker-workflows.js must export createMailWorker');
  assert.equal(typeof mod.createPrivacyWorkflow, 'function',
   'packages/services/worker-workflows.js must export createPrivacyWorkflow');
  workflowFactory = mod;
 }
 return workflowFactory;
}

let appFactory = null;
function loadAppFactory() {
 if (!appFactory) {
  const mod = require('../apps/worker/index.js');
  assert.equal(typeof mod.createWorkerApp, 'function', 'apps/worker/index.js must export createWorkerApp');
  appFactory = mod.createWorkerApp;
 }
 return appFactory;
}

/* Every entry point the suite drives must exist and be a function before a gated case may run: an
 * absent method is a hard failure on a gated checkout, never a silently passing skip. */
function requireMethods(subject, names, what) {
 const bound = {};
 for (const name of names) {
  assert.equal(typeof subject[name], 'function', `${what} must expose ${name}()`);
  bound[name] = subject[name].bind(subject);
 }
 return bound;
}

/* --------------------------------------------------------------- sealing */

/* The frozen envelope, reimplemented INDEPENDENTLY in the test: HKDF-SHA256 (salt '', info
 * 'mega-xo-v4-mail', 32 bytes) -> AES-256-GCM, 12-byte IV, tag and ciphertext, joined as
 * `iv.tag.data` and base64url encoded. Because the test mints this string itself, a passing case
 * proves the worker opens the documented format and not merely its own. */
const MAIL_KEY = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(MAIL_SECRET), Buffer.alloc(0), 'mega-xo-v4-mail', 32));
function sealMail(value) {
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', MAIL_KEY, iv);
 const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
 return [iv, cipher.getAuthTag(), data].map((x) => x.toString('base64url')).join('.');
}
function openMail(text) {
 const [iv, tag, data] = String(text).split('.').map((x) => Buffer.from(x, 'base64url'));
 const decipher = crypto.createDecipheriv('aes-256-gcm', MAIL_KEY, iv);
 decipher.setAuthTag(tag);
 return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

/* --------------------------------------------------------------- harness */

/* A recording transport: the real provider edge, replaced by the exact method surface the legacy
 * `TransactionalEmail` exposes. `enabled()` reports true so a worker that (like the legacy MailOutbox)
 * gates on transport availability dispatches. Every call is kept so the test can assert the EXACT
 * decrypted message reached the right method. */
function recordingTransport() {
 const calls = [];
 const record = (method, message) => { calls.push({ method, message }); return { ok: true }; };
 return {
  calls,
  enabled: () => true,
  sendOtp: (message) => record('sendOtp', message),
  sendPasswordChanged: (message) => record('sendPasswordChanged', message),
  sendSecurityNotice: (message) => record('sendSecurityNotice', message),
  /* A generic bulk-mail edge. The contract pins no transport method for the generic `'mail'` kind, so
   * this method gives that kind a real destination; the case that drives it asserts only that the job
   * reached SOME enabled transport method, never a specific name. */
  sendMail: (message) => record('sendMail', message),
 };
}

/* The delivered message must carry every field the transport contract needs, with the exact decrypted
 * value. A worker MAY attach extra routing metadata (the real `TransactionalEmail.sendOtp` destructures
 * only `{to, code, purpose, idempotencyKey}` and ignores the rest), so the check is per-field rather
 * than a brittle whole-object equality. */
function assertMessage(actual, expected, what) {
 assert.ok(actual && typeof actual === 'object', `${what}: a message object must be delivered`);
 for (const [key, value] of Object.entries(expected)) {
  assert.deepEqual(actual[key], value, `${what}: the delivered message must carry the exact ${key}`);
 }
}

/* A recording logger: the sanitized-logging assertions are made against the JSON serialization of
 * exactly these entries. */
function recordingLogger() {
 const entries = [];
 const log = (entry) => { entries.push(entry); };
 log.entries = entries;
 log.text = () => JSON.stringify(entries);
 return log;
}

/* One owned database with its guarded worker/api pools, a controllable clock, the real job service
 * (`createJobService` over the worker pool - the producer/claim seam the workflow uses), and a
 * superuser probe client for durable reads and fixture writes. `t.after` closes the services; the lab
 * closes every borrowed pool only after this suite's teardown. */
let dbSeq = 0;
async function open(t) {
 if (!(await lab.boot(t))) return null;
 const database = await lab.createDatabase(`p10w${dbSeq++}`);
 const pools = lab.poolsFor(database);
 let clock = CLOCK;
 const now = () => clock;
 const jobs = require('../packages/services/jobs.js').createJobService({ pool: pools.worker, now });
 t.after(async () => { try { await jobs.close(); } catch { /* best effort */ } });
 const exec = async (text, params = []) => {
  const client = await lab.adminClient(database);
  try { return await client.query(text, params); } finally { await client.end(); }
 };
 const raw = async (id) => (await exec('SELECT outbox_id, payload, kind, state, attempts, lease_owner,'
  + ' lease_token, created_at, expires_at, next_at, lease_until FROM ops.outbox WHERE outbox_id = $1', [id])).rows[0] ?? null;
 return {
  database, pools, jobs, exec, raw, now, clock: () => clock,
  advance: (ms) => { clock += ms; return clock; },
  /* A mail job with the frozen sealed payload, enqueued through the REAL producer seam. */
  enqueueSealed: (id, kind, message, over = {}) => jobs.enqueueJob({
   id, kind, version: 1, payload: sealMail(message), businessKey: null,
   expiresAt: clock + DAY, nextAt: clock, ...over,
  }),
 };
}

/* Build one mail worker over the harness database. `t.after` tears it down if it owns a stop hook. */
function mailWorkerFor(h, t, { transport, log } = {}) {
 const { createMailWorker } = loadWorkflowFactory();
 const worker = createMailWorker({ jobService: h.jobs, transport, secret: MAIL_SECRET, now: h.now, log });
 for (const name of ['seal', 'open', 'tick']) {
  assert.equal(typeof worker[name], 'function', `the mail worker must expose ${name}()`);
 }
 if (t) t.after(async () => {
  for (const name of ['stop', 'close']) {
   if (typeof worker[name] === 'function') { try { await worker[name](); } catch { /* best effort */ } }
  }
 });
 return worker;
}

/* Build one privacy workflow over the harness database; `t.after` closes it. */
function privacyFor(h, t) {
 const { createPrivacyWorkflow } = loadWorkflowFactory();
 const privacy = createPrivacyWorkflow({ pool: h.pools.worker, jobService: h.jobs, now: h.now });
 if (t && typeof privacy.close === 'function') {
  t.after(async () => { try { await privacy.close(); } catch { /* best effort */ } });
 }
 return { privacy, methods: requireMethods(privacy,
  ['cancelActorOutbox', 'purgeExpiredRetention', 'purgeExpiredRateBuckets'], 'the privacy workflow') };
}

/* ============ 1. encrypted delivery, exact message, sealed completion ============ */

test('V5-10-02 mail: a sealed OTP job is claimed, opened and delivered, then completed with its payload sealed', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = `mail:${ALICE}:otp:challenge-1`;
 const message = { to: ALICE_TO, code: '483920', purpose: 'reset', idempotencyKey: 'mega-xo/reset/challenge-1' };
 await h.enqueueSealed(id, 'otp', message);

 /* The producer's row is durably queued and carries the ciphertext, not the message. */
 const queued = await h.raw(id);
 assert.ok(queued, 'the producer writes a durable ops.outbox row');
 assert.equal(queued.state, 'queued', 'a fresh mail job is queued');
 assert.equal(queued.kind, 'otp', 'the kind is stored verbatim');
 assert.deepEqual(openMail(JSON.parse(queued.payload).payload), message,
  'the stored payload is the AES-256-GCM sealed envelope of the real message');

 const transport = recordingTransport();
 const log = recordingLogger();
 const worker = mailWorkerFor(h, t, { transport, log });

 /* The frozen envelope, proven in BOTH directions: the test opens a string the WORKER sealed, and the
  * worker opens a string the TEST sealed (the durable row above). A drift in the key derivation, the IV
  * length or the `iv.tag.data` layout is caught here rather than only in production. */
 const probe = { to: ALICE_TO, code: '000111', purpose: 'reset', idempotencyKey: 'mega-xo/reset/probe' };
 const workerSealed = worker.seal(probe);
 assert.equal(workerSealed.split('.').length, 3, 'a sealed envelope is `iv.tag.data`');
 assert.equal(Buffer.from(workerSealed.split('.')[0], 'base64url').length, 12, 'the IV is 12 bytes');
 assert.deepEqual(openMail(workerSealed), probe, "the worker's seal is the frozen AES-256-GCM envelope");
 assert.deepEqual(worker.open(sealMail(probe)), probe, 'the worker opens the frozen envelope the test minted');

 const ticked = await worker.tick();
 assert.equal(ticked.sent, 1, 'tick() reports the one delivered job');
 assert.equal(ticked.failed, 0, 'tick() reports no failure');
 assert.equal(ticked.deferred, false, 'a run with due work and an enabled transport is not deferred');

 assert.equal(transport.calls.length, 1, 'exactly one delivery is attempted');
 assert.equal(transport.calls[0].method, 'sendOtp', "an 'otp' job dispatches to transport.sendOtp()");
 assertMessage(transport.calls[0].message, message,
  'the worker delivers the EXACT decrypted message - recipient, code, purpose and idempotency key');

 const done = await h.raw(id);
 assert.equal(done.state, 'sent', 'a delivered job is terminal');
 assert.equal(done.payload, null, 'completion seals the payload to NULL');
 assert.equal(done.lease_owner, null, 'completion releases the lease owner');
 assert.equal(Number(done.attempts), 1, 'the delivery attempted the job exactly once');
});

/* ============ 1b. every documented kind routes to its own transport method ============ */

test('V5-10-02 mail: each documented kind routes to its transport method and terminal rows are sealed', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const cases = [
  ['otp', 'sendOtp', { to: ALICE_TO, code: '111222', purpose: 'signup', idempotencyKey: 'mega-xo/signup/c-otp' }],
  ['changed', 'sendPasswordChanged', { to: ALICE_TO, idempotencyKey: 'mega-xo/changed/c-changed' }],
  ['security', 'sendSecurityNotice', { to: ALICE_TO, event: 'email_changed', detail: '', idempotencyKey: 'mega-xo/security/c-security' }],
  /* `mail` is the generic kind; the contract pins no transport method for it, so the test only requires
   * that its decrypted body reaches SOME transport edge (asserted below). */
  ['mail', null, { to: ALICE_TO, subject: 'Mega XO account notice', text: 'A change was made to your account.', idempotencyKey: 'mega-xo/mail/c-mail' }],
 ];
 for (const [kind, , message] of cases) await h.enqueueSealed(`mail:${ALICE}:${kind}:${kind}`, kind, message);
 const transport = recordingTransport();
 const worker = mailWorkerFor(h, t, { transport, log: recordingLogger() });

 /* One tick per due job: the batch bound is the worker's, so drain deterministically. */
 for (let i = 0; i < cases.length; i += 1) {
  await worker.tick();
  if (transport.calls.length === cases.length) break;
 }
 assert.equal(transport.calls.length, cases.length, 'every due kind is delivered');
 for (const [kind, method, message] of cases) {
  const call = transport.calls.find((c) => c.message.idempotencyKey === message.idempotencyKey);
  assert.ok(call, `${kind} is dispatched to the transport with its decrypted message`);
  if (method !== null) assert.equal(call.method, method, `${kind} dispatches to transport.${method}()`);
 }
 for (const [kind] of cases) {
  const row = await h.raw(`mail:${ALICE}:${kind}:${kind}`);
  assert.equal(row.state, 'sent', `${kind}: a delivered job is terminal`);
  assert.equal(row.payload, null, `${kind}: completion seals the payload`);
 }
});

/* ============ 2. sanitized logging: zero OTP / secret / payload leakage ============ */

test('V5-10-02 logging: no OTP, secret, address or ciphertext ever reaches the log', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = `mail:${ALICE}:otp:challenge-log`;
 const code = '773311';
 const message = { to: ALICE_TO, code, purpose: 'signup', idempotencyKey: 'mega-xo/signup/challenge-log' };
 await h.enqueueSealed(id, 'otp', message);
 const sealed = JSON.parse((await h.raw(id)).payload).payload;

 const transport = recordingTransport();
 const log = recordingLogger();
 const worker = mailWorkerFor(h, t, { transport, log });
 await worker.tick();
 assert.equal(transport.calls.length, 1, 'the clean run really delivered, so the log path was exercised');

 const text = log.text();
 for (const [what, secret] of [['the OTP code', code], ['the recipient address', ALICE_TO],
  ['the mail secret', MAIL_SECRET], ['the sealed ciphertext', sealed]]) {
  assert.equal(text.includes(secret), false, `${what} MUST NOT appear in any log entry`);
 }
 /* The one sanctioned record names the event and the job, and nothing else about the message. */
 const sent = log.entries.filter((e) => e && e.event === 'mail_sent');
 assert.equal(sent.length, 1, 'a successful delivery logs exactly one sanitized mail_sent event');
 assert.equal(sent[0].id, id, 'the event names the durable job id only');
 assert.equal(sent[0].kind, 'otp', 'the event names the kind only');
 assert.deepEqual(Object.keys(sent[0]).sort(), ['event', 'id', 'kind'],
  'no other field is attached to the sanitized event');
});

/* ============ 3. restart does not drop jobs ============ */

test('V5-10-02 restart: a job enqueued before a restart is claimed and delivered by the new worker', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const id = `mail:${ALICE}:otp:restart`;
 const message = { to: ALICE_TO, code: '909090', purpose: 'reset', idempotencyKey: 'mega-xo/reset/restart' };
 await h.enqueueSealed(id, 'otp', message);

 /* Worker instance #1 is built and discarded WITHOUT a tick - the process death that must not lose
  * the job. The durable row is the proof it survived. */
 const deadTransport = recordingTransport();
 mailWorkerFor(h, t, { transport: deadTransport, log: recordingLogger() });
 const survived = await h.raw(id);
 assert.equal(survived.state, 'queued', 'the enqueued job is still queued after the first worker dies');
 assert.equal(deadTransport.calls.length, 0, 'the dead worker delivered nothing');

 /* Worker instance #2 is a genuinely fresh instance over the same database. */
 const transport = recordingTransport();
 const log = recordingLogger();
 const worker = mailWorkerFor(h, t, { transport, log });
 await worker.tick();
 assert.equal(transport.calls.length, 1, 'the new worker claims the surviving job');
 assertMessage(transport.calls[0].message, message, 'the new worker opens and delivers the exact message');
 const done = await h.raw(id);
 assert.equal(done.state, 'sent', 'the surviving job reaches a terminal delivered state');
 assert.equal(done.payload, null, 'the surviving job is sealed on completion');
});

/* ============ 4. privacy/deletion cancellation ============ */

test('V5-10-02 privacy: cancellation supersedes the deleting actor\'s jobs and seals them', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const aliceQueued = `mail:${ALICE}:otp:del-1`;
 const aliceSending = `mail:${ALICE}:security:del-2`;
 const bobQueued = `mail:${BOB}:otp:keep-1`;
 const bobSending = `mail:${BOB}:security:keep-2`;
 const { methods } = privacyFor(h, t);

 /* A mail row's durable identity (`mail:<actor>:<kind>:<ref>`) is what associates it with an actor; the
  * envelope's business key is set to the same actor for realism. The control actor's rows have an
  * identically shaped identity under a different actor prefix, so only a correct predicate spares them. */
 await h.enqueueSealed(aliceQueued, 'otp', { to: ALICE_TO, code: '123456', purpose: 'reset', idempotencyKey: 'mega-xo/reset/del-1' }, { businessKey: ALICE });
 await h.enqueueSealed(aliceSending, 'security', { to: ALICE_TO, event: 'email_changed', detail: '', idempotencyKey: 'mega-xo/security/del-2' }, { businessKey: ALICE });
 await h.enqueueSealed(bobQueued, 'otp', { to: 'bob@example.test', code: '654321', purpose: 'reset', idempotencyKey: 'mega-xo/reset/keep-1' }, { businessKey: BOB });
 await h.enqueueSealed(bobSending, 'security', { to: 'bob@example.test', event: 'email_changed', detail: '', idempotencyKey: 'mega-xo/security/keep-2' }, { businessKey: BOB });
 /* Put in-flight jobs into the real `sending` state with a live lease. */
 await h.exec("UPDATE ops.outbox SET state = 'sending', lease_owner = 'worker:crashed', lease_token = 1,"
  + ' lease_until = $2 WHERE outbox_id IN ($1, $3)', [aliceSending, new Date(h.clock() + 30000), bobSending]);

 const cancelled = await methods.cancelActorOutbox(ALICE);
 assert.equal(cancelled, 2, "cancelActorOutbox reports the deleting actor's two superseded jobs");
 for (const id of [aliceQueued, aliceSending]) {
  const row = await h.raw(id);
  assert.equal(row.state, 'cancelled', `${id} is superseded for good`);
  assert.equal(row.payload, null, `${id} is sealed to NULL on cancellation`);
 }
 for (const id of [bobQueued, bobSending]) {
  const row = await h.raw(id);
  assert.notEqual(row.state, 'cancelled', `${id} belongs to another actor and MUST NOT be cancelled`);
  assert.notEqual(row.payload, null, `${id} keeps its payload`);
 }
 assert.equal((await h.raw(bobQueued)).state, 'queued', "the control actor's queued work is untouched");
 assert.equal((await h.raw(bobSending)).state, 'sending', "the control actor's in-flight work is untouched");
});

/* ============ 5. retention and rate-bucket cleanup ============ */

test('V5-10-02 retention: old terminal rows and expired buckets are purged, active and recent rows survive', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const { methods } = privacyFor(h, t);

 /* Fixture rows written as the schema owner: terminal outbox rows (payload NULL is what 0018's
  * sealed-payload CHECK permits once a row is terminal) and durable rate buckets. */
 const ins = (id, state, createdMs, payload = null) => h.exec('INSERT INTO ops.outbox (outbox_id, payload, kind,'
  + " state, created_at, expires_at, next_at, lease_until, attempts) VALUES ($1, $2, 'mail', $3, $4, $5, $6,"
  + " '1970-01-01T00:00:00+00:00', 1)",
  [id, payload, state, new Date(createdMs), new Date(createdMs + 8 * DAY), new Date(createdMs)]);
 const oldSent = `mail:${ALICE}:sent:old`;
 const oldFailed = `mail:${ALICE}:failed:old`;
 const recentSent = `mail:${ALICE}:sent:recent`;
 const activeQueued = `mail:${ALICE}:otp:active-old`;
 const activeSending = `mail:${ALICE}:security:active-old`;
 await ins(oldSent, 'sent', CLOCK - 8 * DAY);
 await ins(oldFailed, 'failed', CLOCK - 9 * DAY);
 await ins(recentSent, 'sent', CLOCK - 3600000);
 /* An 8-day-old but still ACTIVE row: only its payload is real, and it must never be purged. */
 await h.exec('INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at,'
  + " lease_until, attempts) VALUES ($1, $2, 'otp', 'queued', $3, $4, $5, '1970-01-01T00:00:00+00:00', 0)",
  [activeQueued, JSON.stringify({ version: 1, payload: sealMail({ to: ALICE_TO, code: '424242', purpose: 'reset', idempotencyKey: 'mega-xo/reset/active' }), businessKey: null }),
   new Date(CLOCK - 8 * DAY), new Date(CLOCK + DAY), new Date(CLOCK)]);
 await h.exec('INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at,'
  + " lease_until, lease_owner, lease_token, attempts) VALUES ($1, $2, 'security', 'sending', $3, $4, $5, $6, 'worker:x', 1, 1)",
  [activeSending, JSON.stringify({ version: 1, payload: sealMail({ to: ALICE_TO, event: 'email_changed', detail: '', idempotencyKey: 'mega-xo/security/active' }), businessKey: null }),
   new Date(CLOCK - 8 * DAY), new Date(CLOCK + DAY), new Date(CLOCK), new Date(CLOCK + 30000)]);

 const buckets = [
  /* The expired bucket is purged; the live one is stamped far enough ahead that it is still live after
   * the outbox clock advance below, and the NULL-expiry row is the legacy non-expiring shape. */
  ['mail-budget:expired', CLOCK - DAY],
  ['mail-budget:live', CLOCK + 30 * DAY],
  ['abuse:never', null],
 ];
 for (const [bucket, expires] of buckets) {
  await h.exec('INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at) VALUES ($1, 1, $2)',
   [bucket, expires === null ? null : new Date(expires)]);
 }

 const purged = await methods.purgeExpiredRetention();
 assert.equal(purged, 2, 'the default 7-day retention purges exactly the two out-of-window terminal jobs');
 for (const [id, state] of [[oldSent, null], [oldFailed, null], [recentSent, 'sent'],
  [activeQueued, 'queued'], [activeSending, 'sending']]) {
  const row = await h.raw(id);
  if (state === null) assert.equal(row, null, `${id} (terminal, older than the window) is purged`);
  else {
   assert.ok(row, `${id} survives the sweep`);
   assert.equal(row.state, state, `${id} keeps its state`);
  }
 }

 /* The window is time-relative: once the clock crosses it, the recent terminal row is eligible and
  * the still-active rows are not. This exercises the 7-day boundary without passing an unusual
  * argument, and proves a single `state NOT IN ('queued','sending')` predicate governs the sweep. */
 h.advance(8 * DAY);
 await methods.purgeExpiredRetention();
 assert.equal(await h.raw(recentSent), null, 'the recently terminal row is purged once the window catches it');
 assert.ok(await h.raw(activeQueued), 'an active row is never purged, however old');
 assert.equal((await h.raw(activeSending)).state, 'sending', 'an in-flight row survives every sweep');

 const deleted = await methods.purgeExpiredRateBuckets(h.pools.api);
 assert.equal(deleted, 1, 'exactly the expired rate bucket is deleted');
 const remaining = (await h.exec('SELECT bucket_id FROM ops.rate_buckets ORDER BY bucket_id')).rows.map((r) => r.bucket_id);
 assert.deepEqual(remaining, ['abuse:never', 'mail-budget:live'],
  'live and non-expiring durable buckets are preserved');
});

/* ============ 6. worker app lifecycle and clean teardown ============ */

test('V5-10-02 worker app: start arms a real interval, tick drains the extracted work, stop() silences it', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const createWorkerApp = loadAppFactory();
 const transport = recordingTransport();
 const log = recordingLogger();
 /* `redis: null` is the documented ephemeral tier being absent: mail/privacy work must not need Redis to
  * run. `privacyPool` is the API pool because the rate-bucket DELETE is api_runtime's only (0037
  * deliberately withholds DELETE on ops.rate_buckets from worker_runtime); the worker pool is the app's
  * job pool. `t.after` stops every app this test builds. */
 const build = (intervalMs) => {
  const app = createWorkerApp({
   pool: h.pools.worker, redis: null, secret: MAIL_SECRET, transport, log, now: h.now, intervalMs,
   privacyPool: h.pools.api,
  });
  t.after(async () => { try { await app.stop(); } catch { /* already stopped */ } });
  return app;
 };

 /* ---- phase 1: lifecycle + delivery. A long interval so the periodic timer cannot race the explicit
  * tick; the explicit call is the only tick that runs before the app is stopped. ---- */
 const first = `mail:${ALICE}:otp:app-1`;
 const message = { to: ALICE_TO, code: '556677', purpose: 'reset', idempotencyKey: 'mega-xo/reset/app-1' };
 await h.enqueueSealed(first, 'otp', message);
 const app = build(60000);
 const methods = requireMethods(app, ['start', 'tick', 'stop'], 'the worker app');
 assert.equal(app.started, false, 'a freshly built app has not armed its interval');
 await methods.start();
 assert.equal(app.started, true, 'start() arms the periodic tick');
 const ticked = await methods.tick();
 assert.equal(ticked.mail.sent, 1, 'the app tick delivers the extracted mail work');
 assert.equal(ticked.mail.failed, 0, 'nothing failed');
 assert.equal(ticked.mail.deferred, false, 'the app is not deferred: the transport is enabled');
 assert.ok(Number.isInteger(ticked.expired) && ticked.expired >= 0, 'the app sweeps durable job expiry');
 assert.ok(Number.isInteger(ticked.retentionPurged) && ticked.retentionPurged >= 0,
  'the app runs the privacy retention sweep');
 assert.ok(Number.isInteger(ticked.rateBucketsPurged), 'with the API pool the app purges expired rate buckets');
 await methods.stop();
 assert.equal(app.started, false, 'stop() disarms the interval synchronously');
 /* stop() is idempotent: a second call must not throw or re-arm anything. */
 await methods.stop();
 assert.equal(app.started, false, 'a repeated stop() leaves the app stopped');

 assert.equal(transport.calls.length, 1, 'the app tick delivered the mail through the extracted worker');
 assertMessage(transport.calls[0].message, message, 'the app delivers the exact decrypted message');
 const done = await h.raw(first);
 assert.equal(done.state, 'sent', 'the app completes the job durably');
 assert.equal(done.payload, null, 'the app seals the payload on completion');
 const text = log.text();
 assert.equal(text.includes('556677'), false, 'the app never logs the OTP code');
 assert.equal(text.includes(ALICE_TO), false, 'the app never logs the recipient address');

 /* ---- phase 2: the armed interval really fires, and stop() really silences it. A short interval and a
  * bounded wait make a LEAKED timer observable instead of silently idling. ---- */
 const intervalMs = 20;
 const second = `mail:${ALICE}:otp:app-2`;
 await h.enqueueSealed(second, 'otp', { to: ALICE_TO, code: '889900', purpose: 'reset', idempotencyKey: 'mega-xo/reset/app-2' });
 const periodic = build(intervalMs);
 await periodic.start();
 const firedBy = Date.now() + 4000;
 while (transport.calls.length < 2 && Date.now() < firedBy) await lab.sleep(25);
 assert.equal(transport.calls.length, 2, 'start() schedules real periodic work: the queued job is drained with no explicit tick');

 // A transport call is observed BEFORE its fenced PostgreSQL completion commits.
 // stop() is the production drain barrier: it clears the timer and awaits that
 // in-flight tick. Only after it settles can we assert durable delivery.
 await periodic.stop();
 const periodicDone = await h.raw(second);
 assert.equal(periodicDone.state, 'sent', 'stop() waits for the periodic tick to complete the job durably');
 assert.equal(periodicDone.payload, null, 'the periodic delivery seals the payload before shutdown');
 /* Let any tick that was already scheduled settle BEFORE the post-stop job exists, so nothing is
  * in flight when the new row appears: the only thing that could drain it is an interval that outlived
  * `stop()`. */
 await lab.sleep(3 * intervalMs + 30);
 const callsAtStop = transport.calls.length;
 const third = `mail:${ALICE}:otp:app-3`;
 await h.enqueueSealed(third, 'otp', { to: ALICE_TO, code: '223344', purpose: 'reset', idempotencyKey: 'mega-xo/reset/app-3' });
 await lab.sleep(8 * intervalMs + 60);
 assert.equal(transport.calls.length, callsAtStop, 'no delivery happens after stop(): the interval is no longer firing');
 const parked = await h.raw(third);
 assert.equal(parked.state, 'queued', 'the post-stop job stays durably queued for the next deployment');
 assert.notEqual(parked.payload, null, 'and it keeps its sealed payload, ready to be drained later');
});

test('P10 hardening: actor deletion cancels the entire mail backlog beyond one 256-row scan', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const { methods } = privacyFor(h, t);
 const total = 257;
 /* Use the owned disposable database to seed a deterministic 257-row backlog in
  * one statement. Delivery is not under test; no provider is contacted. */
 await h.exec(
  "INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at, lease_until, attempts)"
  + " SELECT 'mail:' || $1::text || ':otp:bulk:' || n::text, $2::text, 'otp', 'queued',"
  + " $3::timestamptz, $4::timestamptz, $3::timestamptz, '1970-01-01'::timestamptz, 0"
  + " FROM generate_series(1, 257) n",
  [ALICE, 'synthetic-sealed-body', new Date(h.clock()), new Date(h.clock() + DAY)],
 );
 const bob = `mail:${BOB}:otp:keep-after-sweep`;
 await h.enqueueSealed(bob, 'otp', { to: 'bob@example.test', code: '0000', purpose: 'test', idempotencyKey: 'bob:untouched' });
 assert.equal(await methods.cancelActorOutbox(ALICE), total,
  'a deletion must not silently stop after the first 256 undelivered jobs');
 const counts = (await h.exec(
  "SELECT state, count(*)::int AS n FROM ops.outbox WHERE outbox_id LIKE 'mail:svc_alice:otp:bulk:%' GROUP BY state",
 )).rows;
 assert.deepEqual(counts.map(({ state, n }) => ({ state, n: Number(n) })),
  [{ state: 'cancelled', n: total }], 'all 257 rows were cancelled and their payloads sealed');
 const leaked = await h.exec(
  "SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id LIKE 'mail:svc_alice:otp:bulk:%' AND payload IS NOT NULL",
 );
 assert.equal(Number(leaked.rows[0].n), 0, 'not one actor payload remains after cancellation');
 assert.equal((await h.raw(bob)).state, 'queued', 'a different actor retains their queued work');
 assert.equal(await methods.cancelActorOutbox(ALICE), 0, 'a repeat deletion is idempotent');
});
