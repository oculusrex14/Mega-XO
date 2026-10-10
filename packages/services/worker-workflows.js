/* packages/services/worker-workflows.js - V5 P10 task V5-10-02 (email/security/privacy work).
 *
 *   const mail = createMailWorker({ jobService, transport, secret, dailyLimit, monthlyLimit, log, now });
 *   await mail.tick();                                // claim -> open -> deliver -> complete/fail
 *
 *   const privacy = createPrivacyWorkflow({ pool, jobService, now });
 *   await privacy.cancelActorOutbox(actor);           // supersede one actor's undelivered mail
 *   await privacy.purgeExpiredRetention();            // terminal outbox rows older than 7 days
 *   await privacy.purgeExpiredRateBuckets();          // lapsed rate buckets
 *
 *   const worker = createWorkerApp({ pool, redis, secret, transport, now, intervalMs });
 *   worker.start(); await worker.tick(); await worker.stop();
 *
 * WHAT MOVES OUT OF THE GAME CORE. `server/production/mail-outbox.js` runs the sealed email outbox
 * INSIDE the game process: it derives the key, seals the body, claims the oldest due row, sends it and
 * runs the retention sweep - all on the game's event loop and connection budget. This module is that
 * work in the worker process, on top of the P10 durable primitives (`packages/services/jobs.js`):
 *
 *   * the QUEUE OF RECORD is PostgreSQL `ops.outbox`. The mail worker never keeps a mirror: it claims a
 *     fenced batch, dispatches it, and completes or fails each row through the job service. A process
 *     killed between claim and completion leaves a `sending` row whose lease lapses, so a restarted (or
 *     peer) worker reclaims it with a HIGHER fence - a restarted Core/worker drops no job.
 *   * the BODY stays sealed at rest. Producers write the base64url `iv.tag.data` AES-256-GCM string
 *     produced by `sealMessage(secret, message)` (or `mail.seal(message)`); the worker opens it in
 *     memory only, dispatches, and the completion SEALS THE ROW (`payload = NULL`) in the same UPDATE.
 *     Nothing unsealed ever reaches `ops.outbox`.
 *   * ENCRYPTION IS BYTE-COMPATIBLE with the legacy outbox: a 256-bit key derived by HKDF-SHA256 over
 *     the operator secret with an EMPTY salt and the info string `mega-xo-v4-mail`, AES-256-GCM with a
 *     fresh 12-byte IV, the 16-byte auth tag, and the payload joined as `iv.tag.data` in base64url. A
 *     row sealed by the legacy sender opens here, and vice versa.
 *   * LOGS ARE SANITIZED. The only things this module ever logs are the event name, the outbox id, the
 *     job kind and a BOUNDED ERROR CODE. An OTP code, a password, an auth token, a recipient address,
 *     a subject/body or the sealed ciphertext is NEVER a log field - see `logEvent`/`faultCode` below,
 *     which build the record from primitives rather than passing a caller- or transport-supplied object
 *     through, and `fields` in `tick()`, which is `{ id, kind }` and nothing more.
 *
 * WHAT STAYS DURABLE. `cancelActorOutbox` supersedes work that has NOT been delivered (a deletion or an
 * email change invalidates the mail already queued for that actor) by driving the ONE job state machine
 * (`cancelJob`), so the payload is sealed by the same CHECK constraint as every other terminal row.
 * Retention (`purgeExpiredRetention`) removes only rows that are terminal - `queued`/`sending` work is
 * never deleted, because a row that is still claimable is still somebody's obligation. `ops.rate_buckets`
 * rows with a lapsed `expires_at` are the ephemeral half of that table and are swept separately.
 *
 * WHAT THIS MODULE DOES NOT OWN. The durable `mail-budget:<period>` spend rows (P02 R12) remain the
 * producer's record: `createMailWorker` receives no database handle, so its `dailyLimit`/`monthlyLimit`
 * are an IN-PROCESS burst guard (documented at `budgetRemaining`/`budgetReserve`), never a claim of
 * durable authority.
 *
 * ROLE. Both workflows run on caller-owned pools. `ops.outbox` belongs to `worker_runtime` (0022); the
 * rate-bucket DELETE grant belongs to `api_runtime` (0020; 0037 deliberately withholds it from the
 * worker), which is why `purgeExpiredRateBuckets` takes the connection to run on. Every statement binds
 * the INJECTED clock as a parameter - no SQL `now()` - so a test (or an operator) can advance time.
 */
'use strict';
const crypto = require('node:crypto');
const { createJobService } = require('./jobs.js');

/* ---------------------------------------------------------------- constants */

/* The mail job kinds this worker services. `ops.outbox` also carries `core.command`, `commerce.command`,
 * `account.provision`, `account.deletion`, ... - work for OTHER workers - so the claim is KIND-SCOPED:
 * a job this worker cannot decrypt must never be claimed, or it would be failed and eventually
 * dead-lettered by a worker that had no business touching it. */
const MAIL_KINDS = Object.freeze(['otp', 'changed', 'security', 'mail']);
/* The transport method each kind dispatches to. `otp`/`changed`/`security` are the three named
 * notifications the transport MUST implement; `mail` is the general transactional sender and is only
 * required when a `mail` job is actually delivered. */
const MAIL_TRANSPORT_METHODS = Object.freeze({
 otp: 'sendOtp',
 changed: 'sendPasswordChanged',
 security: 'sendSecurityNotice',
 mail: 'sendMail',
});
const REQUIRED_TRANSPORT_METHODS = Object.freeze(['sendOtp', 'sendPasswordChanged', 'sendSecurityNotice']);

/* The legacy provider idempotency key is `mega-xo/v4/<outbox id>`, derived from the DURABLE outbox id so
 * that a retry of one job presents the provider the same key. It rides INSIDE the sealed body - the
 * producer stamps it at seal time, exactly where the legacy outbox put it - and this worker is a
 * courier: it opens the body, delivers it unchanged and settles the row. No key is ever invented here.
 */

const DEFAULT_WORKER_ID = 'mail-worker';
const WORKER_ID_MAX = 128;
/* A worker id reaches a log line and a `text` column, so it is a bounded, printable identifier. */
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DEFAULT_MAIL_LIMIT = 16;
const MAX_MAIL_LIMIT = 64;
/* The operator secret is the HKDF input, so a trivially short one is refused (the P05 lab's synthetic
 * secret is 26 characters). */
const MIN_SECRET_LENGTH = 16;

const HKDF_HASH = 'sha256';
const HKDF_SALT = Buffer.alloc(0);
const HKDF_INFO = 'mega-xo-v4-mail';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const DAY_MS = 86400000;
/* The legacy cleanup window: terminal outbox rows leave after 7 days (mail-outbox.js:82). */
const DEFAULT_RETENTION_MS = 7 * DAY_MS;
/* One deletion can leave at most this many undelivered mail rows behind; the sweep is bounded so a
 * pathological actor cannot turn a privacy request into an unbounded transaction. */
const CANCEL_SCAN_LIMIT = 256;
/* Each iteration takes one bounded scan; an exceptionally large/deleted actor is
 * explicitly escalated instead of silently leaving undelivered mail after row 256. */
const CANCEL_MAX_BATCHES = 64;
const IDENT_MAX = 200;
/* Control characters (including NUL) never belong in an identifier or a log line. */
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
/* A fault code is REPORTED, never trusted: only an uppercase-underscore token of bounded length is a
 * code; anything else (a provider sentence, an address, a token that leaked into an error message)
 * collapses to a fixed string. This is the second line of defence behind "never log the message". */
const FAULT_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/* One mail attempt, one bounded dispatch window. The lease the worker claims must outlive its own
 * send, or a slow provider would let a peer reclaim a message this worker is still delivering. */
const DISPATCH_TIMEOUT_MS = 30000;

/* A bare code, exactly as every other boundary in this repository throws. */
const fail = (code, detail) => { throw Error(detail === undefined ? code : code + ': ' + JSON.stringify(detail)); };

/* --------------------------------------------------------------- validation */

function requireText(value, code, max = IDENT_MAX) {
 if (typeof value !== 'string' || value.length === 0 || value.length > max) fail(code);
 if (CONTROL_CHAR.test(value)) fail(code);
 return value;
}
const requireOutboxId = (value) => requireText(value, 'INVALID_OUTBOX_ID');
/* An actor id is a durable identifier, not a free-form string: it is interpolated into a LIKE pattern,
 * so it is bounded and validated BEFORE it can reach SQL or a log line. */
const requireActorId = (value) => requireText(value, 'INVALID_ACTOR');

function requireSecret(value) {
 if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) {
  fail('INVALID_SECRET', { min: MIN_SECRET_LENGTH });
 }
 return value;
}
function requireClock(value) {
 if (typeof value !== 'function') fail('CLOCK_REQUIRED');
 const ms = value();
 if (!Number.isFinite(ms)) fail('CLOCK_REQUIRED');
 return ms;
}
/* The injected clock, with the repository's convention: a `now` that is present but not a function is
 * a misconfiguration and is REFUSED, never silently replaced by `Date.now()` (which would quietly move
 * every retention window and lease off the clock the caller believes it controls). */
function resolveClock(options) {
 if (options.now !== undefined && options.now !== null && typeof options.now !== 'function') fail('CLOCK_REQUIRED');
 return typeof options.now === 'function' ? options.now : Date.now;
}
function requireWorkerId(value) {
 if (typeof value !== 'string' || value.length > WORKER_ID_MAX || !WORKER_ID_PATTERN.test(value)) {
  fail('INVALID_WORKER_ID');
 }
 return value;
}
function requireJobService(value) {
 if (!value || typeof value.claimJobs !== 'function' || typeof value.completeJob !== 'function'
     || typeof value.failJob !== 'function' || typeof value.cancelJob !== 'function') {
  fail('JOB_SERVICE_REQUIRED');
 }
 return value;
}
function requireTransport(value) {
 if (!value || typeof value !== 'object') fail('TRANSPORT_REQUIRED');
 for (const method of REQUIRED_TRANSPORT_METHODS) {
  if (typeof value[method] !== 'function') fail('TRANSPORT_METHOD_REQUIRED', { method });
 }
 return value;
}
function requirePool(value) {
 if (!value || typeof value.query !== 'function') fail('PG_POOL_REQUIRED');
 return value;
}
/* A log sink is optional; when given it must be callable, and a logger that throws must never break a
 * delivery (see `logEvent`). */
function requireLog(value) {
 if (value === undefined || value === null) return () => {};
 if (typeof value !== 'function') fail('LOG_REQUIRED');
 return value;
}
function requireBoundedLimit(value, code, max) {
 if (value === undefined || value === null) return DEFAULT_MAIL_LIMIT;
 if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code, { max });
 return value;
}
/* A spend bound admits only a positive integer: `dailyLimit: 0` would permanently mute the transport,
 * which is a deployment switch, not a limit, and is refused rather than silently obeyed. */
function requireLimit(value, code) {
 if (!Number.isSafeInteger(value) || value < 1) fail(code);
 return value;
}
function requireRetention(value) {
 if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RETENTION_MS');
 return value;
}
function requireInterval(value) {
 if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INTERVAL_MS');
 return value;
}

/* --------------------------------------------------- encryption (legacy-exact) */

/* The key: HKDF-SHA256 over the operator secret, EMPTY salt, info `mega-xo-v4-mail`, 256 bits. */
const keyFromSecret = (secret) => Buffer.from(
 crypto.hkdfSync(HKDF_HASH, Buffer.from(secret), HKDF_SALT, HKDF_INFO, KEY_BYTES));

/* Seal: a fresh 12-byte IV per message, AES-256-GCM, auth tag appended, joined `iv.tag.data` in
 * base64url - byte-identical to the legacy `MailOutbox.seal`. */
function sealWithKey(key, value) {
 const iv = crypto.randomBytes(IV_BYTES);
 const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
 const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
 return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

/* Open: the EXACT inverse. A malformed shape, a wrong key or a tampered byte all fail closed with a
 * bare code - a body that cannot be authenticated is never partially delivered. */
function openWithKey(key, text) {
 if (typeof text !== 'string') fail('INVALID_SEALED_MESSAGE');
 const parts = text.split('.');
 if (parts.length !== 3) fail('INVALID_SEALED_MESSAGE');
 const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url'));
 /* The two fixed-width halves are checked before they reach the cipher: a short/long IV or tag is a
  * malformed envelope, not a message. The body itself may be any length (a degenerate payload of zero
  * bytes is still a legitimate empty body - the GCM tag is what proves the whole thing). */
 if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) fail('INVALID_SEALED_MESSAGE');
 const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
 decipher.setAuthTag(tag);
 try {
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
 } catch { fail('INVALID_SEALED_MESSAGE'); }
}

/* The producer-side pair, exported so a producer (or a test) can seal a body exactly the way the
 * worker will open it without constructing a worker. */
const sealMessage = (secret, value) => sealWithKey(keyFromSecret(requireSecret(secret)), value);
const openMessage = (secret, text) => openWithKey(keyFromSecret(requireSecret(secret)), text);

/* --------------------------------------------------------------- logging */

/* The message a fault carries is BOUNDED before it is reported: an uppercase-underscore token keeps its
 * name (so an operator can alarm on `EMAIL_DELIVERY_FAILED`), and every other string - a provider
 * sentence that may quote the recipient, a driver message that may quote a bind - becomes
 * `UNKNOWN_FAULT`. The raw message is never propagated, stored or logged. */
function faultCode(error) {
 const message = error && typeof error.message === 'string' ? error.message : '';
 const head = message.split(':')[0].trim();
 return FAULT_CODE.test(head) ? head : 'UNKNOWN_FAULT';
}

/* --------------------------------------------------------------- LIKE safety */

/* `_` matches any one character and `%` matches any run, so an actor id containing either would widen a
 * cancellation pattern into other actors' mail. Both are escaped and the SQL declares `ESCAPE '\'`. */
const escapeLike = (value) => value.replace(/([\\%_])/g, '\\$1');

/* ------------------------------------------------------------- mail worker */

/* The in-process burst guard. UTC day/month windows, exactly the periods the durable
 * `mail-budget:<day>|<month>` rows name. The allowance is RESERVED against the batch about to be
 * claimed, before anything is delivered, because that is the conservative direction: a crash between
 * the reservation and the send cannot hand the allowance back (the legacy `budget()` counted the
 * request, not the success, for the same reason). It is ADVISORY: it bounds one process's own send
 * rate, and the durable spend record stays the producer's (`createMailWorker` receives no database
 * handle and must not pretend to own a spend row it cannot write). */
function budgetState() { return { day: null, month: null, dayCount: 0, monthCount: 0 }; }
/* Roll the UTC day/month windows over and report the allowance left in the tighter of the two. */
function budgetRemaining(state, at, dailyLimit, monthlyLimit) {
 const day = new Date(at).toISOString().slice(0, 10);
 const month = day.slice(0, 7);
 if (state.day !== day) { state.day = day; state.dayCount = 0; }
 if (state.month !== month) { state.month = month; state.monthCount = 0; }
 return Math.min(dailyLimit - state.dayCount, monthlyLimit - state.monthCount);
}
function budgetReserve(state, count) {
 state.dayCount += count;
 state.monthCount += count;
}

function createMailWorker(options = {}) {
 if (!options || typeof options !== 'object') fail('OPTIONS_REQUIRED');
 const jobService = requireJobService(options.jobService);
 const transport = requireTransport(options.transport);
 const key = keyFromSecret(requireSecret(options.secret));
 const log = requireLog(options.log);
 const now = resolveClock(options);
 const workerId = options.workerId === undefined ? DEFAULT_WORKER_ID : requireWorkerId(options.workerId);
 const limit = requireBoundedLimit(options.limit, 'INVALID_LIMIT', MAX_MAIL_LIMIT);
 const dailyLimit = options.dailyLimit === undefined ? 80 : requireLimit(options.dailyLimit, 'INVALID_DAILY_LIMIT');
 const monthlyLimit = options.monthlyLimit === undefined ? 2400 : requireLimit(options.monthlyLimit, 'INVALID_MONTHLY_LIMIT');
 /* The dispatch lease must outlive this worker's own send, or a slow provider could let a peer reclaim
  * a message that is still in flight; the job service's own default lease (30 s) is exactly that. */
 const leaseMs = DISPATCH_TIMEOUT_MS;

 const budget = budgetState();
 let closed = false;

 /* A transport that declares a capability reports it; one that does not is assumed configured, exactly
  * as the legacy `MailOutbox.enabled()` treated a transport without the probe. */
 const transportEnabled = () => (typeof transport.enabled === 'function' ? transport.enabled() === true : true);

 /* The one sanitized log line. The record is BUILT here from primitives, never handed through from a
  * caller or a transport, so an unexpected field cannot ride along. */
 const logEvent = (event, fields) => {
  try { log(Object.freeze({ event, ...fields })); } catch { /* a logger must never break a delivery */ }
 };
 /* `stopped`/`deferred` means NOTHING was claimed, so no attempt was spent. */
 const defer = (reason) => { logEvent('mail_deferred', { reason }); return { sent: 0, failed: 0, deferred: true }; };

 /* Dispatch one opened message. The method comes from a FROZEN internal map (never from the caller or
  * the job), so an unrecognized kind cannot reach a transport member it was not routed to, and the body
  * the transport receives is exactly the one the producer sealed. */
 async function dispatch(kind, message) {
  const method = MAIL_TRANSPORT_METHODS[kind];
  if (typeof method !== 'string' || typeof transport[method] !== 'function') fail('UNSUPPORTED_TRANSPORT_METHOD');
  await transport[method](message);
 }

 return Object.freeze({
  workerId,
  kinds: MAIL_KINDS,
  /* Seal/open with THIS worker's key, for a producer that shares its configuration. */
  seal(value) { return sealWithKey(key, value); },
  open(text) { return openWithKey(key, text); },

  /* One bounded tick: claim the mail kinds this worker services, open each sealed body, dispatch it and
  * settle the row. A job whose body cannot be opened is FAILED (and eventually dead-lettered) rather
  * than redelivered forever - an unreadable row is a producer fault, and the durable `failed` state is
  * what makes it visible to an operator. A transport failure is retried by the job service's backoff. */
  async tick() {
   if (closed) return defer('stopped');
   if (!transportEnabled()) return defer('transport_disabled');
   /* The spend guard is consulted BEFORE the claim, so a process with no allowance left does not take a
    * lease on work it will not deliver (that would only park the row until the lease lapsed). */
   const remaining = budgetRemaining(budget, requireClock(now), dailyLimit, monthlyLimit);
   if (remaining < 1) return defer('budget');
   /* The claim itself must fit the remaining UTC allowance: checking for a positive
    * balance but taking an entire batch could exceed the daily/monthly cap. */
   const claimed = await jobService.claimJobs({
    workerId, kinds: MAIL_KINDS, limit: Math.min(limit, remaining), leaseMs,
   });
   /* Reserve the whole batch up front: the allowance is charged against the work this tick is about to
    * deliver, and the batch size then caps out naturally once the day's (or month's) spend is reached.
    * A reservation that a crash never delivers stays charged - conservative, exactly as the legacy
    * `budget()` counted requests rather than successes. */
   budgetReserve(budget, claimed.length);
   /* The sanitized record names the event and the durable job - id and kind, nothing else about the
    * message. The attempt count lives in the durable row (an operator reads it there), so it is not
    * copied into a log line that must stay minimal. */
   let sent = 0;
   let failed = 0;
   for (const job of claimed) {
    const fields = { id: String(job.id), kind: String(job.kind) };
    let message;
    try {
     message = openWithKey(key, job.payload);
     if (message === null || typeof message !== 'object' || Array.isArray(message)) fail('INVALID_SEALED_MESSAGE');
    } catch (error) {
     /* An unreadable body is a producer fault, and the durable `failed` state is what makes it visible.
      * A failure of the SETTLE itself (a lost fence, a lost connection) is reported and skipped: one
      * bad row must never abort the rest of the batch, which would leave the remaining jobs leased
      * until their lease lapsed. */
     const code = faultCode(error);
     try {
      const outcome = await jobService.failJob({ id: job.id, workerId, fence: job.fence, error: code });
      failed += 1;
      logEvent('mail_failed', { ...fields, code, terminal: outcome.deadLetter === true });
     } catch (settleError) {
      logEvent('mail_settle_failed', { ...fields, code: faultCode(settleError) });
     }
     continue;
    }
    /* The body the transport receives is EXACTLY the one the producer sealed: this worker is a courier,
     * not an editor. The provider idempotency key (`mega-xo/v4/<outbox id>`) belongs to the sealed body
     * - exactly where the legacy outbox put it, at seal time - so a redelivery of one job presents the
     * provider the same key without this layer rewriting the caller's business body. */
    try {
     await dispatch(job.kind, message);
    } catch (error) {
     const code = faultCode(error);
     let outcome = { deadLetter: false };
     try {
      outcome = await jobService.failJob({ id: job.id, workerId, fence: job.fence, error: code });
     } catch (settleError) {
      logEvent('mail_settle_failed', { ...fields, code: faultCode(settleError) });
      continue;
     }
     failed += 1;
     logEvent('mail_failed', { ...fields, code, terminal: outcome.deadLetter === true });
     continue;
    }
    /* The completion is FENCED: a worker whose lease was taken over mid-send cannot complete the new
      * owner's job, and the row's payload is sealed to NULL in the same UPDATE. */
    try {
     const completed = await jobService.completeJob({ id: job.id, workerId, fence: job.fence });
     if (completed === true) {
      sent += 1;
      logEvent('mail_sent', fields);
     } else {
      logEvent('mail_settle_failed', { ...fields, code: 'LEASE_LOST' });
     }
    } catch (error) {
     logEvent('mail_settle_failed', { ...fields, code: faultCode(error) });
    }
   }
   return { sent, failed, deferred: false };
  },

  /* Stop accepting new work. Nothing borrowed is closed and no timer is left behind (this worker has
  * none); an in-flight tick finishes on the caller's await. */
  close() { closed = true; },
 });
}

/* ----------------------------------------------------------- privacy workflow */

/* The actor's undelivered mail rows, oldest first, under the SAME id convention the producers use:
 * `mail:<actor>:<kind>:<nonce>`. The predicate reads an ID PREFIX only - the payload is sealed
 * ciphertext and is never inspected or matched. */
const ACTOR_OUTBOX_SQL = 'SELECT outbox_id FROM ops.outbox'
 + " WHERE outbox_id LIKE $1 ESCAPE '\\' AND state IN ('queued', 'sending')"
 + ' ORDER BY created_at, outbox_id LIMIT $2';
/* Retention: only TERMINAL rows leave. A `queued`/`sending` row is still somebody's obligation, whatever
 * its age, so the sweep can never delete undelivered work (the legacy cleanup predicate, verbatim). */
const RETENTION_SQL = 'DELETE FROM ops.outbox'
 + " WHERE created_at < $1 AND state NOT IN ('queued', 'sending')";
/* Ephemeral rate buckets whose window has closed. A NULL `expires_at` is the legacy non-expiring shape
 * and is preserved: those rows are the DURABLE spend records (P02 R12), never disposable cache. */
const RATE_BUCKET_SQL = 'DELETE FROM ops.rate_buckets'
 + ' WHERE expires_at IS NOT NULL AND expires_at < $1';

/* A row count, or a refusal: a statement that reports no count proves nothing about a sweep. */
function countOf(result, code) {
 const n = result ? result.rowCount : null;
 if (!Number.isSafeInteger(n) || n < 0) fail(code);
 return n;
}

function createPrivacyWorkflow(options = {}) {
 if (!options || typeof options !== 'object') fail('OPTIONS_REQUIRED');
 const pool = requirePool(options.pool);
 const jobService = requireJobService(options.jobService);
 const now = resolveClock(options);
 let closed = false;
 const requireOpen = () => { if (closed) fail('SERVICE_CLOSED'); };

 /* Run a SWEEP on the caller's transaction/client when one is given (so a retention pass can be folded
  * into a caller's unit of work), else on this workflow's own pool. The GRANTS still decide: `ops.outbox`
  * is worker-owned (so both connections work there), while the rate-bucket DELETE is API-owned, which is
  * exactly why `purgeExpiredRateBuckets` demands the API connection rather than defaulting to the
  * worker's. (A cancellation takes a different path - see `cancelActorOutbox`.) */
 const runner = (clientOrPool) => {
  if (clientOrPool === undefined || clientOrPool === null) return (text, params) => pool.query(text, params);
  if (typeof clientOrPool.query !== 'function') fail('CLIENT_REQUIRED');
  return (text, params) => clientOrPool.query(text, params);
 };

 return Object.freeze({
  /* Supersede every undelivered mail row belonging to a leaving/changing actor. The SCAN runs on the
   * caller's connection when one is given (so a deletion's unit of work sees its own rows), while each
   * row is cancelled THROUGH the job service - the one writer of that state machine - so the state
   * transition, the fence and the payload seal (`payload = NULL` beside the new state, which 0018's
   * `outbox_sealed_payload_ck` requires) are never re-implemented here. The consequence, stated plainly:
   * a cancellation COMMITS on the job service's connection, not the caller's, so it survives a later
   * rollback of a caller transaction. That is the conservative direction for a deletion - mail on its
   * way to a departing actor is dropped, and an aborted deletion re-creates only the challenge it still
   * needs. A row another worker claimed after the scan loses the race against the `state IN
   * ('queued','sending')` guard and is not counted: the returned count is what this call actually
   * cancelled. */
  async cancelActorOutbox(actor, clientOrPool = null) {
   requireOpen();
   const id = requireActorId(actor);
   const pattern = 'mail:' + escapeLike(id) + ':%';
   const scan = runner(clientOrPool);
   let cancelled = 0;
   for (let batch = 0; batch < CANCEL_MAX_BATCHES; batch += 1) {
    const rows = (await scan(ACTOR_OUTBOX_SQL, [pattern, CANCEL_SCAN_LIMIT])).rows;
    if (rows.length === 0) return cancelled;
    for (const row of rows) {
     const outboxId = requireOutboxId(String(row.outbox_id));
     if (await jobService.cancelJob({ id: outboxId })) cancelled += 1;
    }
    if (rows.length < CANCEL_SCAN_LIMIT) return cancelled;
   }
   /* Never present a partial privacy sweep as a completed cancellation. A
    * caller can retry idempotently after reviewing the unusually large backlog. */
   fail('ACTOR_CANCEL_LIMIT_REACHED', { batches: CANCEL_MAX_BATCHES, batchLimit: CANCEL_SCAN_LIMIT });
  },

  /* Delete terminal outbox rows that are older than the retention window. Delivered, failed, expired
   * and cancelled rows are all terminal: their meaning is already recorded in the state and (for a
   * deletion) in the permanent receipt, so the body is gone and the row is history. */
  async purgeExpiredRetention(retentionMs = DEFAULT_RETENTION_MS, clientOrPool = null) {
   requireOpen();
   const window = requireRetention(retentionMs);
   const at = requireClock(now);
   const result = await runner(clientOrPool)(RETENTION_SQL, [new Date(at - window)]);
   return countOf(result, 'UNEXPECTED_RESULT');
  },

  /* Delete the lapsed EPHEMERAL rate buckets. Runs on the connection the caller supplies (the API's,
  * whose role holds the DELETE); this workflow's own default pool is the worker's, which deliberately
  * does not. Passing nothing therefore fails loudly with 42501 rather than silently doing nothing. */
  async purgeExpiredRateBuckets(clientOrPool = null) {
   requireOpen();
   const at = requireClock(now);
   const result = await runner(clientOrPool)(RATE_BUCKET_SQL, [new Date(at)]);
   return countOf(result, 'UNEXPECTED_RESULT');
  },

  /* Stops accepting new work. Nothing borrowed is closed: the pool and the job service are caller-owned
  * and may be shared with the rest of the worker. */
  close() { closed = true; },
 });
}

/* ------------------------------------------------------------- worker app */

function createWorkerApp(options = {}) {
 if (!options || typeof options !== 'object') fail('OPTIONS_REQUIRED');
 const pool = requirePool(options.pool);
 const now = resolveClock(options);
 const log = requireLog(options.log);
 const intervalMs = options.intervalMs === undefined ? 1000 : requireInterval(options.intervalMs);
 /* The job service is created from the worker pool unless the caller shares one (the same service can
  * drive every worker workflow). `createJobService` verifies the pool's role and the live chain. */
 const jobService = options.jobService === undefined
  ? createJobService({ pool, now })
  : requireJobService(options.jobService);
 /* The rate-bucket sweep needs a connection whose role holds the DELETE (the API's). It is OPTIONAL:
  * without it the sweep is skipped and reported as null, never attempted on the worker's connection. */
 const privacyPool = options.privacyPool === undefined || options.privacyPool === null
  ? null : requirePool(options.privacyPool);
 /* The privacy workflow's OWN pool is the worker pool: `cancelActorOutbox` and `purgeExpiredRetention`
  * act on `ops.outbox`, which only `worker_runtime` may DELETE (0022; 0038 gives the API INSERT and
  * `outbox_id` SELECT alone). The API connection is passed to the ONE sweep that needs it, and only
  * that sweep: the rate-bucket DELETE grant lives with `api_runtime` (0020:55). */
 const privacy = createPrivacyWorkflow({ pool, jobService, now });
 const mailWorker = createMailWorker({ ...options, jobService, now });

 let timer = null;
 let closed = false;
 let inFlight = null;

 const logEvent = (event, fields) => {
  try { log(Object.freeze({ event, ...fields })); } catch { /* telemetry must never break the worker */ }
 };

 /* One pass of the worker's whole responsibility, in the order that keeps the queue honest: lapsed work
  * leaves first, then the retention/privacy sweeps, then delivery. A mail worker never claims a job it
  * cannot service (`kinds`), so the maintenance pass cannot be starved by another worker's backlog. */
 async function runTick() {
  const expired = await jobService.expireDueJobs();
  const retentionPurged = await privacy.purgeExpiredRetention();
  const rateBucketsPurged = privacyPool === null ? null : await privacy.purgeExpiredRateBuckets(privacyPool);
  const mail = await mailWorker.tick();
  if (mail.failed > 0) logEvent('worker_tick_degraded', { failed: mail.failed });
  return { mail, expired, retentionPurged, rateBucketsPurged };
 }

 /* The single-flight entry point: ticks that overlap SHARE the one in-flight pass, so two intervals (or
  * an interval and an operator's manual tick) can never double-claim a batch or run two retention sweeps
  * concurrently. The promise is held in a closure binding, not read off the frozen object, so the
  * scheduled callback and the manual call are provably the same function. */
 function tickOnce() {
  if (closed) fail('WORKER_CLOSED');
  if (inFlight === null) {
   inFlight = runTick().finally(() => { inFlight = null; });
  }
  return inFlight;
 }

 return Object.freeze({
  jobService,
  mailWorker,
  privacy,
  /* Redis is the caller's accelerator handle (P06). This task's workflows touch PostgreSQL only and
   * never invent an ephemeral key, so the handle is carried, not used - a null Redis is legitimate. */
  redis: options.redis === undefined ? null : options.redis,

  get started() { return timer !== null; },

  /* Arm the periodic maintenance tick. The FIRST tick happens on the interval, never inside `start()`:
  * a caller that wants an immediate pass awaits `tick()`, and a test that arms then stops the app
  * observes the timer appear and disappear without a delivery in between. `intervalMs: 0` arms nothing
  * (manual-only mode). */
  start() {
   if (closed) fail('WORKER_CLOSED');
   if (timer === null && intervalMs > 0) {
    timer = setInterval(() => {
     /* A rejected tick must not become an unhandled rejection: the schedule is not a control path. */
     Promise.resolve(tickOnce()).catch((error) => {
      logEvent('worker_tick_failed', { code: faultCode(error) });
     });
    }, intervalMs);
   }
   return { started: timer !== null, intervalMs };
  },

  /* One tick on demand. */
  tick() { return tickOnce(); },

  /* Stop. The interval is cleared SYNCHRONOUSLY, so the moment this promise settles the process holds no
  * worker timer and can exit on its own. The pool and the job service are caller-owned: nothing borrowed
  * is closed. */
  async stop() {
   if (timer !== null) { clearInterval(timer); timer = null; }
   closed = true;
   /* Stop is a drain barrier: an already-claimed delivery must settle before the
    * caller may close the pool or terminate this worker process. */
   try {
    if (inFlight !== null) await inFlight;
   } finally {
    mailWorker.close();
    privacy.close();
   }
   return { stopped: true };
  },
 });
}

module.exports = {
 createMailWorker,
 createPrivacyWorkflow,
 createWorkerApp,
 MAIL_KINDS,
 MAIL_TRANSPORT_METHODS,
 DEFAULT_RETENTION_MS,
 sealMessage,
 openMessage,
};
