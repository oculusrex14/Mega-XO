/* packages/services/jobs.js - V5 P10 task V5-10-01 (durable job and outbox primitives).
 *
 *   const jobs = createJobService({ pool, now, maxAttempts, backoffBaseMs, defaultLeaseMs });
 *   await jobs.enqueueJob({ id, kind, payload, version, expiresAt, nextAt, businessKey }, clientOrTx?);
 *   await jobs.claimJobs({ workerId, limit, leaseMs });   // FENCED batch claim
 *   await jobs.completeJob({ id, workerId, fence });      // seals the payload
 *   await jobs.failJob({ id, workerId, fence, error });   // backoff, then dead-letter
 *   await jobs.listDeadLetters({ limit });                // restricted operator inspection
 *   await jobs.retryDeadLetter({ id });                   // operator requeue
 *   await jobs.cancelJob({ id });                         // supersede an undelivered job
 *   await jobs.expireDueJobs();                           // lapsed work leaves the queue
 *   await jobs.close();                                   // releases NOTHING borrowed
 *
 * The V5 successor of `server/production/mail-outbox.js` and the in-process `server/jobs.js` scan. It
 * keeps the legacy outbox's exact state machine (claim/update/lease, `attempts < 3`, backoff, payload
 * NULL on every terminal transition) and adds the three things the legacy outbox lacked: a TYPED and
 * VERSIONED payload, a business idempotency key, and a monotonic LEASE FENCE that makes a stale owner
 * structurally unable to finish a job a newer worker has taken over.
 *
 * DURABLE AUTHORITY. PostgreSQL `ops.outbox` is the only queue of record. Every fact a worker needs -
 * state, `next_at`, `expires_at`, `attempts`, `lease_owner`, `lease_token` - lives in the row, so a
 * worker process is disposable: it can be killed at any point without losing, duplicating or
 * mis-attributing a job. Redis is never consulted (P06 owns the ephemeral accelerator tier), so a
 * Redis wipe cannot change a single claim.
 *
 * ENVELOPE. The `payload` column carries a versioned envelope so the transport shape and the business
 * body never mix:
 *     JSON.stringify({ version, payload, businessKey })
 * `payload` may be an object, an array, a string, a number, true or false; `businessKey` is the
 * caller's stable business identity (may be null). A row written by an older producer that never used
 * the envelope (an event body straight into `payload`) is decoded conservatively as `{payload: <row
 * body>, version: 1, businessKey: null}` rather than being refused, so the primitives can drain the
 * rows the P04-P09 producers already write. 0018's `outbox_sealed_payload_ck` is what makes the
 * terminal transitions structural: a row may carry a payload ONLY while it is `queued` or `sending`,
 * so `sent`/`failed`/`expired`/`cancelled` must null it in the SAME UPDATE.
 *
 * CLAIM AND FENCE. `claimJobs` claims a bounded, deterministic batch in ONE transaction: the due set
 * is selected `FOR UPDATE SKIP LOCKED` (so two workers racing for the same rows each take a disjoint
 * subset instead of blocking or double-claiming) and the rows that scan locked are advanced in the same
 * transaction, so the locks are held across both statements. The fence is `COALESCE(lease_token, 0) + 1`,
 * evaluated under those locks, so the token is strictly monotonic per row and never reset by
 * completion, failure, cancellation or requeue. A worker that dies mid-delivery leaves `state='sending'`
 * with a lapsed `lease_until`; the next claim observes it as due, increments `attempts` and issues a
 * HIGHER fence, so the dead worker's late `completeJob`/`failJob` matches zero rows and is refused - a
 * stale owner can never finish, and never fail, a job a newer worker owns.
 *
 * CLOCKS. Every comparison binds the caller's `now()` as a parameter and never SQL `now()`. That is
 * what makes the lease-expiry, backoff and dead-letter transitions observable on command: a caller
 * that advances its injected clock really does advance the queue, and a worker whose clock is skewed
 * cannot be silently corrected by the database. `next_at`/`expires_at`/`lease_until` are absolute
 * instants, so a restart (or a database failover) resumes exactly where the durable row says.
 *
 * BACKOFF AND DEAD LETTER. A failed attempt is retried with the legacy exponential backoff
 * `nextAt = now + backoffBaseMs * 2^(attempts - 1)` against the ATTEMPTS AFTER THE CLAIM'S INCREMENT,
 * so the first failure waits one base interval and each retry doubles it. Once `attempts` has reached
 * `maxAttempts` the job leaves the queue: it is moved to the `failed` (dead-letter) state, its payload
 * is sealed to NULL and it becomes visible to the restricted operator surface (`listDeadLetters`)
 * and re-enterable with `retryDeadLetter`, which resets the attempt budget instead of editing history.
 * The seal is ONE WAY by design: a dead-lettered row's old body is gone, so an operator must
 * provide a NEW explicit payload for requeue. A payload-free retry would silently lose real mail. Keeping
 * a readable copy on a terminal row would mean either widening `outbox_sealed_payload_ck` or stashing
 * the body in a side table, and both re-create exactly the retention the sealed-payload rule exists to
 * prevent.
 *
 * BOUNDED. Every read is `LIMIT`ed and every batch is capped (`MAX_CLAIM_LIMIT`,
 * `MAX_DEAD_LETTER_LIMIT`), so no worker tick can scan or return unbounded work, and no payload bound
 * is imposed on the caller's business body - the job service transports it, it does not interpret it.
 *
 * ROLE. `ops.outbox` is worker-owned: 0022 grants `worker_runtime` full DML on it, 0038 grants
 * `api_runtime`/`core_runtime` INSERT only (producers), and 0018's trigger-free CHECK enforces the
 * sealed-payload invariant for every writer. The factory therefore requires a `worker_runtime` pool
 * and verifies the live migration chain read-only before any method touches a row. `enqueueJob`
 * additionally accepts a caller-owned transaction or client (the producer path inside a business
 * unit of work over a `core_runtime`/`api_runtime` pool): when one is supplied the INSERT runs on THAT
 * connection only, so the job commits or rolls back with the business effect it belongs to.
 */
'use strict';
const { PgGuardError } = require('../db/pg/guards.js');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');

/* `ops.outbox` is worker-owned (0022); producers hold INSERT only (0038), so the queue is drained from
 * the worker pool and nowhere else. */
const WORKER_ROLE = 'worker_runtime';
/* The sealed-payload epoch. A job that was never claimed carries this deadline, exactly as the 0018
 * DDL default does, so "unclaimed" is a durable fact and not a NULL to be interpreted. */
const LEASE_EPOCH = '1970-01-01T00:00:00+00:00';
/* The legacy `MailOutbox` attempt budget and lease: three attempts, 15 s lease. The V5 default lease
 * is longer because a worker tick here may cross a provider round trip the legacy in-process sender
 * never had. */
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_LEASE_MS = 30000;
/* 24 h: the caller's default retention for a queued job. */
const DEFAULT_EXPIRY_MS = 86400000;
const DEFAULT_CLAIM_LIMIT = 16;
const MAX_CLAIM_LIMIT = 256;
const MAX_ATTEMPTS_LIMIT = 64;
const DEFAULT_DEAD_LETTER_LIMIT = 50;
const MAX_DEAD_LETTER_LIMIT = 500;
/* The envelope's baseline version. A job without an explicit version is version 1; the field exists so
 * a future payload shape can be migrated without guessing at what a row contains. */
const ENVELOPE_VERSION = 1;
/* Bounded identifiers: an outbox id is a primary key, a kind is a routing label, a business key is a
 * caller's stable identity and a worker id is a lease owner. All four must fit comfortably in a
 * bounded log line and a bounded index entry. */
const OUTBOX_ID_MAX = 200;
const KIND_MAX = 64;
const BUSINESS_KEY_MAX = 200;
const WORKER_ID_MAX = 128;
/* Control characters (including NUL) never belong in an identifier or a log line. */
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
/* `lease_token` is a BIGINT; the driver hands it back as a string, so the fence is normalized to a JS
 * number on the way out and accepted in either form on the way in. */
const FENCE_MAX = Number.MAX_SAFE_INTEGER;

/* A bare code, exactly as every other boundary in this repository throws. */
const fail = (code, detail) => { throw new PgGuardError(code, detail); };

/* --------------------------------------------------------------- validation */

function requireText(value, code, max) {
 if (typeof value !== 'string') fail(code);
 if (value.length === 0) fail(code);
 if (value.length > max) fail(code, { length: value.length, max });
 if (CONTROL_CHAR.test(value)) fail(code);
 if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) fail(code);
 return value;
}
const requireOutboxId = (value) => requireText(value, 'INVALID_OUTBOX_ID', OUTBOX_ID_MAX);
const requireKind = (value) => requireText(value, 'INVALID_KIND', KIND_MAX);
const requireWorkerId = (value) => requireText(value, 'INVALID_WORKER_ID', WORKER_ID_MAX);
/* A bounded KIND FILTER for a worker that services only some kinds. `undefined`/`null` means "no
 * filter" (the legacy claim, unchanged); an empty array is a legitimate filter that matches nothing. */
const MAX_KINDS = 32;
function requireKinds(value) {
 if (value === undefined || value === null) return null;
 if (!Array.isArray(value) || value.length > MAX_KINDS) {
  fail('INVALID_KINDS', { kinds: Array.isArray(value) ? value.length : String(value), max: MAX_KINDS });
 }
 return value.map(requireKind);
}
function requireBusinessKey(value) {
 if (value === undefined || value === null) return null;
 return requireText(value, 'INVALID_BUSINESS_KEY', BUSINESS_KEY_MAX);
}
/* A versioned envelope: an integer version and a declared payload slot. The payload body itself is
 * opaque to this layer - object, array, string, number, boolean or null all round-trip. */
function requireVersion(value) {
 if (value === undefined || value === null) return ENVELOPE_VERSION;
 if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_VERSION', { version: value });
 return value;
}
function requirePayload(value) {
 if (value === undefined) return null;
 const shape = typeof value;
 if (value === null || shape === 'string' || shape === 'number' || shape === 'boolean'
     || shape === 'object') return value;
 fail('INVALID_PAYLOAD', { type: shape });
}
function requireInstant(value, code) {
 if (value === undefined || value === null) return null;
 if (!Number.isFinite(value)) fail(code, { value: String(value) });
 return value;
}
function requireLeaseMs(value) {
 if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_LEASE_MS', { leaseMs: value });
 return value;
}
function requireFence(value) {
 const n = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
 if (!Number.isSafeInteger(n) || n < 1 || n > FENCE_MAX) fail('INVALID_FENCE', { fence: String(value) });
 return n;
}
function requireBoundedLimit(value, dflt, max, code) {
 if (value === undefined || value === null) return dflt;
 if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code, { limit: String(value), max });
 return value;
}
/* The retry budget a job may spend before it is dead-lettered. One attempt means "never retry", which is
 * a legitimate policy, so the floor is 1 rather than 2. */
function requireAttemptBudget(value) {
 if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ATTEMPTS_LIMIT) {
  fail('INVALID_MAX_ATTEMPTS', { maxAttempts: String(value), max: MAX_ATTEMPTS_LIMIT });
 }
 return value;
}
/* Epoch milliseconds out of a `timestamptz` the driver may hand back as a Date (default type parser) or
 * as a string (a custom parser). The conversion is done here, not in SQL, so every instant this
 * service reports is the same number the caller bound. */
function msOf(value) {
 if (value === null || value === undefined) return null;
 if (value instanceof Date) return value.getTime();
 if (typeof value === 'number') return value;
 const ms = Date.parse(String(value));
 return Number.isFinite(ms) ? ms : null;
}
const atMs = (ms) => new Date(ms);

/* The transport envelope, decoded. A row that predates the envelope is handed back as its own body
 * with the baseline version and no business key, so the primitives can drain rows written by producers
 * that never used the envelope. The decode is TOTAL: a body that is not JSON is returned as the raw
 * text it is, never thrown on. A throwing decode would abort a batch AFTER the claim committed, and a
 * payload that no worker can read would then be re-claimed until its attempt budget ran out and parked
 * as an unserviceable `sending` row - a poison row this layer has no business creating. */
function decodeEnvelope(text) {
 if (text === null || text === undefined) return { payload: null, version: ENVELOPE_VERSION, businessKey: null };
 let parsed;
 try {
  parsed = JSON.parse(text);
 } catch {
  return { payload: text, version: ENVELOPE_VERSION, businessKey: null };
 }
 if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
     && Object.prototype.hasOwnProperty.call(parsed, 'payload')
     && Number.isSafeInteger(parsed.version)) {
  return {
   payload: parsed.payload === undefined ? null : parsed.payload,
   version: parsed.version,
   businessKey: parsed.businessKey === undefined ? null : parsed.businessKey,
  };
 }
 return { payload: parsed, version: ENVELOPE_VERSION, businessKey: null };
}

/* ------------------------------------------------------------------- SQL */

/* Enqueue is create-only: a replayed enqueue (the producer retrying the same deterministic id inside
 * its own unit of work) is a structural no-op, exactly like every other idempotent writer in this
 * repository. The lease fields are stamped to their unclaimed values in the same statement so an
 * insert can never leave a half-initialized row. */
const ENQUEUE_SQL = 'INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at, lease_until, lease_token, attempts)'
 + " VALUES ($1, $2, $3, 'queued', $4, $5, $6, '" + LEASE_EPOCH + "', NULL, 0)"
 + ' ON CONFLICT (outbox_id) DO NOTHING';

/* The due set, locked. `FOR UPDATE SKIP LOCKED` means a worker takes the rows nobody else is holding
 * and never waits behind another worker's batch; the legacy oldest-first order is a total order (the id
 * breaks every tie), so two workers scanning the same backlog take from the same end and the batch is
 * deterministic. Only a row still due, still inside its attempt budget and not yet expired qualifies. */
const CLAIM_DUE_SQL = 'SELECT outbox_id FROM ops.outbox'
 + ' WHERE expires_at > $1 AND attempts < $2'
 + " AND ((state = 'queued' AND next_at <= $1) OR (state = 'sending' AND lease_until <= $1))"
 + ' ORDER BY created_at, outbox_id'
 + ' LIMIT $3'
 + ' FOR UPDATE SKIP LOCKED';

/* The SAME locked due-set scan, scoped to a bounded set of job KINDS. A worker that can service only
 * some kinds - the mail worker drains 'otp'/'changed'/'security'/'mail' and nothing else - MUST NOT
 * claim the rest: a claim it cannot deliver would be handed to `failJob` and, after the attempt budget,
 * DEAD-LETTERED, destroying work that belonged to a different worker. The unfiltered statement above
 * stays byte-identical, so a caller that passes no `kinds` binds the same three parameters it always
 * did and takes the same rows. */
const CLAIM_DUE_KINDS_SQL = 'SELECT outbox_id FROM ops.outbox'
 + ' WHERE expires_at > $1 AND attempts < $2 AND kind = ANY($4::text[])'
 + " AND ((state = 'queued' AND next_at <= $1) OR (state = 'sending' AND lease_until <= $1))"
 + ' ORDER BY created_at, outbox_id'
 + ' LIMIT $3'
 + ' FOR UPDATE SKIP LOCKED';

/* Advance exactly the rows the statement above locked. `COALESCE(lease_token, 0) + 1` is computed
 * against a row this transaction holds the lock on, so the token is strictly monotonic per row and no
 * other worker can be racing the same increment. The rows are locked and unchanged since the SELECT, so
 * the re-scan needs no predicate beyond the ids it returned; `RETURNING` reads back the fence and the
 * post-increment attempt count the caller must present to `completeJob`/`failJob`. */
const CLAIM_TAKE_SQL = 'UPDATE ops.outbox'
 + " SET state = 'sending', lease_owner = $2, lease_token = COALESCE(lease_token, 0) + 1,"
 + ' lease_until = $3, attempts = attempts + 1'
 + ' WHERE outbox_id = ANY($1::text[])'
 + ' RETURNING outbox_id, kind, payload, attempts, lease_token, expires_at';

/* Completion is FENCED and SEALING: it matches only the exact live lease (owner AND token) and nulls
 * the payload in the same UPDATE the CHECK requires. A stolen, expired or completed lease matches
 * zero rows, which is the whole point of the fence. */
const COMPLETE_SQL = 'UPDATE ops.outbox'
 + " SET state = 'sent', payload = NULL, lease_owner = NULL, lease_until = '" + LEASE_EPOCH + "'"
 + ' WHERE outbox_id = $1 AND lease_owner = $2 AND lease_token = $3'
 + " AND state = 'sending'";

/* Retry: the job returns to the queue with a doubled backoff and its lease released. */
const RETRY_SQL = 'UPDATE ops.outbox'
 + " SET state = 'queued', lease_owner = NULL, lease_until = '" + LEASE_EPOCH + "', next_at = $4"
 + ' WHERE outbox_id = $1 AND lease_owner = $2 AND lease_token = $3'
 + " AND state = 'sending'";

/* Dead letter: the job leaves the queue for good. The payload MUST be nulled here - 0018's
 * `outbox_sealed_payload_ck` admits a payload only while `queued`/`sending`, so a `failed` row that
 * kept one would be refused with 23514. */
const DEAD_LETTER_SQL = 'UPDATE ops.outbox'
 + " SET state = 'failed', payload = NULL, lease_owner = NULL, lease_until = '" + LEASE_EPOCH + "'"
 + ' WHERE outbox_id = $1 AND lease_owner = $2 AND lease_token = $3'
 + " AND state = 'sending'";

/* The CURRENT attempt count of a still-owned lease, read under the same fence as the mutation it
 * guards. `failJob` reads it first so the backoff exponent and the dead-letter decision are both
 * derived from the committed row, never from a caller's memory. */
const ATTEMPTS_SQL = 'SELECT attempts FROM ops.outbox'
 + ' WHERE outbox_id = $1 AND lease_owner = $2 AND lease_token = $3'
 + " AND state = 'sending'"
 + ' FOR UPDATE';

const DEAD_LETTERS_SQL = 'SELECT outbox_id, kind, attempts, created_at, expires_at FROM ops.outbox'
 + " WHERE state = 'failed' ORDER BY created_at DESC, outbox_id DESC LIMIT $1";

/* A failed row is sealed: explicit replacement payload is mandatory to requeue. */
const RETRY_DEAD_SQL = 'UPDATE ops.outbox'
 + " SET state = 'queued', attempts = 0, payload = $3, expires_at = $4,"
 + " next_at = $2, lease_owner = NULL, lease_until = '" + LEASE_EPOCH + "'"
 + " WHERE outbox_id = $1 AND state = 'failed'";

/* Cancel is ownerless and terminal: it supersedes work that has NOT been delivered. A delivered,
 * dead-lettered or already-cancelled job is not "cancellable" and matches nothing. */
const CANCEL_SQL = 'UPDATE ops.outbox SET state = \'cancelled\', payload = NULL'
 + " WHERE outbox_id = $1 AND state IN ('queued', 'sending')";

/* Expiry is the ONE queue-wide transition: every lapse that is still claimable leaves the queue and
 * its payload is sealed in the same statement (the same predicate the legacy cleanup used). */
const EXPIRE_SQL = "UPDATE ops.outbox SET state = 'expired', payload = NULL"
 + " WHERE expires_at <= $1 AND state IN ('queued', 'sending')";

/* --------------------------------------------------------------- factory */

function createJobService(options = {}) {
 if (!options || typeof options !== 'object') fail('OPTIONS_REQUIRED');
 const pool = options.pool;
 if (!pool || typeof pool.describe !== 'function' || typeof pool.withTransaction !== 'function'
     || typeof pool.query !== 'function') {
  fail('PG_POOL_REQUIRED');
 }
 const described = pool.describe();
 if (!described || described.role !== WORKER_ROLE) {
  fail('ROLE_MISMATCH', { expected: WORKER_ROLE, observed: described ? described.role : null });
 }
 if (options.now !== undefined && typeof options.now !== 'function') fail('CLOCK_REQUIRED');
 const now = typeof options.now === 'function' ? options.now : Date.now;
 const maxAttempts = options.maxAttempts === undefined
  ? DEFAULT_MAX_ATTEMPTS : requireAttemptBudget(options.maxAttempts);
 const backoffBaseMs = options.backoffBaseMs === undefined
  ? DEFAULT_BACKOFF_BASE_MS : requireLeaseMs(options.backoffBaseMs);
 const defaultLeaseMs = options.defaultLeaseMs === undefined
  ? DEFAULT_LEASE_MS : requireLeaseMs(options.defaultLeaseMs);

 /* Boot gate: the same read-only chain verification every service in this repository performs. It
  * starts here and every method awaits it, so no statement can run against an unverified chain. The
  * absorbing handler only prevents an unhandled-rejection warning; the awaited promise still rejects. */
 const gate = verifyRuntimeSchema(pool);
 gate.catch(() => {});

 let closed = false;
 const requireOpen = () => { if (closed) fail('SERVICE_CLOSED'); };
 const clock = () => {
  const ms = now();
  if (!Number.isFinite(ms)) fail('CLOCK_REQUIRED');
  return ms;
 };

 /* One statement, one pinned transaction on the borrowed pool - the documented one-shot app path. */
 const oneShot = (text, params) => pool.query(text, params);
 /* Two statements that MUST observe the same row lock and commit together (the failure decision and
  * the transition it authorizes) run inside ONE borrowed transaction. */
 const inTransaction = (fn) => pool.withTransaction((tx) => fn((text, params) => tx.query(text, params)));
 /* The producer path: an explicit transaction/client means the INSERT rides the caller's unit of work
  * and MUST NOT open a second connection or a nested transaction. With none, the INSERT is the one
  * statement it always was and goes out on the documented one-shot path. */
 const runOn = (clientOrTx, text, params) => {
  if (clientOrTx === undefined || clientOrTx === null) return pool.query(text, params);
  if (typeof clientOrTx.query !== 'function') fail('CLIENT_REQUIRED');
  return clientOrTx.query(text, params);
 };

 return Object.freeze({
  /* A typed, versioned job in an explicit transaction (or on the service pool when none is given). */
  async enqueueJob(job = {}, clientOrTx = null) {
   requireOpen();
   if (!job || typeof job !== 'object') fail('INVALID_JOB');
   const id = requireOutboxId(job.id);
   const kind = requireKind(job.kind);
   const payload = requirePayload(job.payload);
   const version = requireVersion(job.version);
   const businessKey = requireBusinessKey(job.businessKey);
   const at = clock();
   const expiresAt = requireInstant(job.expiresAt, 'INVALID_EXPIRES_AT');
   const nextAt = requireInstant(job.nextAt, 'INVALID_NEXT_AT');
   const expires = expiresAt === null ? at + DEFAULT_EXPIRY_MS : expiresAt;
   const next = nextAt === null ? at : nextAt;
   const envelope = JSON.stringify({ version, payload, businessKey });
   await gate;
   await runOn(clientOrTx, ENQUEUE_SQL,
    [id, envelope, kind, atMs(at), atMs(expires), atMs(next)]);
   return { id, kind, version, businessKey, expiresAt: expires, nextAt: next };
  },

  /* Claim a bounded, fenced batch of due jobs for one worker. Every returned job carries the fence its
   * completion and failure MUST present back; a job the batch did not take is never touched. */
  async claimJobs(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_CLAIM');
   const workerId = requireWorkerId(input.workerId);
   const limit = requireBoundedLimit(input.limit, DEFAULT_CLAIM_LIMIT, MAX_CLAIM_LIMIT, 'INVALID_LIMIT');
   const leaseMs = input.leaseMs === undefined ? defaultLeaseMs : requireLeaseMs(input.leaseMs);
   /* Absent (or null) -> the unfiltered legacy scan with its three parameters. Present -> the same
    * locked scan restricted to the kinds this worker can actually service. */
   const kinds = requireKinds(input.kinds);
   const at = clock();
   const until = at + leaseMs;
   await gate;
   /* Both statements run in ONE borrowed transaction, so the `FOR UPDATE` locks taken by the due scan
    * are still held when the update advances those rows: no interleaving claim can slip between them. */
   return inTransaction(async (q) => {
    const due = (await q(kinds === null ? CLAIM_DUE_SQL : CLAIM_DUE_KINDS_SQL,
     kinds === null ? [atMs(at), maxAttempts, limit] : [atMs(at), maxAttempts, limit, kinds])).rows;
    if (due.length === 0) return [];
    const ids = due.map((row) => String(row.outbox_id));
    const claimed = (await q(CLAIM_TAKE_SQL, [ids, workerId, atMs(until)])).rows;
    return claimed.map((row) => {
     const decoded = decodeEnvelope(row.payload);
     return {
      id: String(row.outbox_id),
      kind: row.kind,
      payload: decoded.payload,
      version: decoded.version,
      businessKey: decoded.businessKey,
      attempts: Number(row.attempts),
      fence: Number(row.lease_token),
      expiresAt: msOf(row.expires_at),
     };
    });
   });
  },

  /* Seal a delivered job. `true` only when THIS worker still holds THIS fence: a stale owner whose
    * lease was stolen matches zero rows and is refused, and the payload is nulled in the same UPDATE. */
  async completeJob(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_COMPLETION');
   const id = requireOutboxId(input.id);
   const workerId = requireWorkerId(input.workerId);
   const fence = requireFence(input.fence);
   await gate;
   const rowCount = (await oneShot(COMPLETE_SQL, [id, workerId, fence])).rowCount;
   return rowCount === 1;
  },

  /* Record a failed delivery. While attempts remain the job is requeued with the legacy exponential
    * backoff; once the budget is spent it is dead-lettered with its payload sealed. Either transition
    * is fenced, so a stale owner can neither retry nor dead-letter a job a newer worker owns.
    *
    * `error` is the caller's diagnostic for a failure it just observed. The frozen `ops.outbox` schema
    * has no diagnostic column and this layer does not invent one (adding a column means a new migration,
    * a manifest/checksum update and a conformance rewrite - the schema owner's call, not a job
    * primitive's), so the diagnostic is NOT persisted and the durable record of a failure is its
    * `state`, `attempts` and `next_at`. The failing worker is the one holding the delivered body, so it
    * is the right place to log the reason; `listDeadLetters` then hands an operator the durable ids that
    * need a body re-enqueue. */
  async failJob(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_FAILURE');
   const id = requireOutboxId(input.id);
   const workerId = requireWorkerId(input.workerId);
   const fence = requireFence(input.fence);
   const at = clock();
   await gate;
   return inTransaction(async (q) => {
    const rows = (await q(ATTEMPTS_SQL, [id, workerId, fence])).rows;
    if (rows.length !== 1) {
     /* Fence lost, job already terminal, or the row is gone: nothing is mutated, so this attempt was
      * never the owner's. `attempts` and `nextAt` are null because neither exists to report - the
      * committed row belongs to another worker now. */
     return { deadLetter: false, attempts: null, nextAt: null };
    }
    const attempts = Number(rows[0].attempts);
    if (attempts >= maxAttempts) {
     await q(DEAD_LETTER_SQL, [id, workerId, fence]);
     return { deadLetter: true, attempts, nextAt: null };
    }
    const nextAt = at + backoffBaseMs * (2 ** (attempts - 1));
    await q(RETRY_SQL, [id, workerId, fence, atMs(nextAt)]);
    return { deadLetter: false, attempts, nextAt };
   });
  },

  /* The restricted operator surface: the failed jobs, newest first, bounded. */
  async listDeadLetters(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_LIST');
   const limit = requireBoundedLimit(input.limit, DEFAULT_DEAD_LETTER_LIMIT, MAX_DEAD_LETTER_LIMIT, 'INVALID_LIMIT');
   await gate;
   const rows = (await oneShot(DEAD_LETTERS_SQL, [limit])).rows;
   return rows.map((row) => ({
    outbox_id: String(row.outbox_id),
    kind: row.kind,
    attempts: Number(row.attempts),
    created_at: msOf(row.created_at),
    expires_at: msOf(row.expires_at),
   }));
  },

  /* Operator requeue: supply a new payload for a FRESH attempt budget. Only a
    * `failed` row is re-enterable; anything else matches nothing and is refused. */
  async retryDeadLetter(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_RETRY');
   const id = requireOutboxId(input.id);
   if (!Object.prototype.hasOwnProperty.call(input, 'payload') || input.payload === null
       || input.payload === undefined) fail('RETRY_REQUIRES_PAYLOAD');
   const payload = requirePayload(input.payload);
   const version = requireVersion(input.version);
   const businessKey = requireBusinessKey(input.businessKey);
   const at = clock();
   const expiresAt = requireInstant(input.expiresAt, 'INVALID_EXPIRES_AT');
   const expires = expiresAt === null ? at + DEFAULT_EXPIRY_MS : expiresAt;
   if (!Number.isFinite(expires) || expires <= at) fail('INVALID_EXPIRES_AT');
   const envelope = JSON.stringify({ version, payload, businessKey });
   if (typeof envelope !== 'string') fail('INVALID_PAYLOAD');
   await gate;
   const rowCount = (await oneShot(RETRY_DEAD_SQL,
    [id, atMs(at), envelope, atMs(expires)])).rowCount;
   return rowCount === 1;
  },

  /* Supersede an undelivered job. Ownerless and terminal; a job that is already sent, failed, expired
    * or cancelled matches nothing. */
  async cancelJob(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_CANCEL');
   const id = requireOutboxId(input.id);
   await gate;
   const rowCount = (await oneShot(CANCEL_SQL, [id])).rowCount;
   return rowCount === 1;
  },

  /* Take every lapsed job that is still claimable out of the queue, sealing its payload in the same
    * statement. Returns how many rows left the queue. */
  async expireDueJobs() {
   requireOpen();
   const at = clock();
   await gate;
   const rowCount = (await oneShot(EXPIRE_SQL, [atMs(at)])).rowCount;
   return rowCount;
  },

  /* Stops accepting new work. The pool is caller-owned - it may be shared with other services - so
    * nothing borrowed is closed here and no timer is left behind by any method above. */
  async close() { closed = true; },
 });
}

module.exports = { createJobService, WORKER_ROLE };
