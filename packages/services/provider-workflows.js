/* packages/services/provider-workflows.js - V5 P10 task V5-10-03 (provider notification and
 * finalization work).
 *
 *   const provider = createProviderWorkflow({ pool, now, defaultLeaseMs, maxAttempts, backoffBaseMs });
 *   await provider.ingestNotification({ store, notificationId, receivedAt });     // durable dedupe
 *   const batch = await provider.claimDueNotifications({ workerId, limit });     // fenced lease
 *   await provider.completeNotification({ store, notificationId, workerId, fence });
 *   await provider.failNotification({ store, notificationId, workerId, fence, error });
 *   await provider.enqueueFinalization({ store, transactionId, productId, purchaseToken, kind }, tx);
 *   const due = await provider.claimDueFinalizations({ workerId, limit });
 *   await provider.completeFinalization({ store, transactionId, workerId, fence, finalizeProvider });
 *   await provider.handlePurchaseNotification({ store, notificationId, transactionId, actorId, productId, grantFn });
 *   await provider.handleRefundNotification({ store, transactionId, productId, reason, revokeFn });
 *   await provider.listPendingFinalizations({ limit });
 *   await provider.close();
 *
 * WHAT MOVES OUT OF THE GAME PROCESS. The V4 store integration ran INSIDE the game process:
 * `server/google-play-billing.js` verified a receipt, wrote `v41_store_finalize`, and swept
 * `processDue()` by calling Google consume/acknowledge on the game's event loop; the RTDN handlers
 * (`server/google-play-notifications.js`, `server/apple-store-notifications.js`) deduped callbacks in
 * `v41_store_notifications` and invoked the in-process refund. This module is that work in the worker
 * process, on top of the durable P02 store tables (`packages/migrations/migrations/0015_monetization_store.sql`):
 *
 *   * `monetization.store_notifications` is the DURABLE callback dedupe state machine
 *     (`pending -> processing -> applied | retry`) keyed by `(store, notification_id)`. A redelivered
 *     callback replays through the primary key and is a structural no-op (`ingestNotification`); a
 *     claimed batch is fenced by `(lease_owner, lease_token)` and a stale owner can never mark a newer
 *     claim applied.
 *   * `monetization.store_finalize` is the provider consume/acknowledge machine. A row is only
 *     contacted AFTER a durable grant exists: `completeFinalization` reads `monetization.receipts`
 *     FIRST and never calls the provider for a transaction this database never granted. A row whose
 *     grant never arrives backs off and is finally ABANDONED (the V5 terminal state that replaces the
 *     legacy DELETE-on-abandon, so `worker_runtime` needs no DELETE).
 *   * DEDUPE IS BY PROVIDER IDENTITY, and it protects the ECONOMY: `handlePurchaseNotification`
 *     consults the durable `monetization.receipts` row (and the permanent `monetization.store_revocations`
 *     tombstone) BEFORE invoking the Core-owned `grantFn`. A duplicate, out-of-order or retried
 *     callback therefore never re-mints a consumable. A refund notification writes the revocation
 *     tombstone itself (that is the worker-owned durable fact a later purchase fails
 *     `RECEIPT_REFUNDED` against) and delegates the Core-owned receipt freeze to the injected
 *     `revokeFn`.
 *
 * ROLE. This workflow runs on a caller-owned `worker_runtime` pool (0022 plus the P10 additions in
 * 0043: SELECT on `monetization.receipts` and INSERT on `monetization.store_revocations`). It NEVER
 * writes `economy.*` and NEVER writes `monetization.receipts`: the grant and the refund are Core-owned
 * effects invoked through the injected `grantFn`/`revokeFn`, exactly like the mail/security worker
 * invokes its transport. Every statement binds the INJECTED clock as a parameter - no SQL `now()` -
 * so a test (or an operator) can advance time past a lease without sleeping.
 */
'use strict';
const { PgGuardError } = require('../db/pg/guards.js');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');

/* The durable provider state belongs to the worker identity (0022); no other role may claim it. */
const WORKER_ROLE = 'worker_runtime';

const DEFAULT_LEASE_MS = 30000;
const MAX_LEASE_MS = 3600000;
/* The declared attempt ceiling. It bounds the exponential backoff exponent so a pathological row
 * cannot push `next_at` past the representable window; it is NOT a dead-letter budget, because the
 * notification machine's only terminal state is `applied`. */
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1000;
/* `Math.min(3600000, ...)` is the legacy cap (google-play-billing.js:69): one hour. */
const MAX_BACKOFF_MS = 3600000;
/* The legacy abandonment horizon: a finalization whose grant never arrived is DELETED after one hour
 * in V4 (`processDue`); V5 replaces that with the terminal `abandoned` UPDATE after a conservative
 * 24 h, so a slow Core grant is given the full day before the purchase is written off. */
const ABANDON_AFTER_MS = 86400000;

const DEFAULT_CLAIM_LIMIT = 16;
const MAX_CLAIM_LIMIT = 256;
const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 500;

/* Bounded identifiers: a notification id / transaction id / product id is a key, an actor id is a
 * durable reference, a worker id is a lease owner and a reason is a short label. All are bounded so
 * none can become an unbounded index entry, a log line or a bind the driver must echo whole. */
const NOTIFICATION_ID_MAX = 200;
const TRANSACTION_ID_MAX = 200;
const PRODUCT_ID_MAX = 200;
const ACTOR_ID_MAX = 200;
const REASON_MAX = 64;
const WORKER_ID_MAX = 128;
/* A provider purchase token is opaque and long, but it is never whitespace-bearing or multi-line. */
const PURCHASE_TOKEN_MAX = 4096;
/* `last_error` carries the schema CHECK `length(last_error) <= 280`. */
const LAST_ERROR_MAX = 280;
/* Control characters (including NUL) never belong in an identifier, a tombstone reason or a log line. */
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

const STORES = Object.freeze(['google', 'apple']);
/* `store_finalize`'s CHECK admits Google only (0015): the Apple finish is a client-side step and has
 * no server consume/acknowledge call. The service validates this rather than letting the schema refuse
 * a call with a raw 23514. */
const FINALIZE_STORES = Object.freeze(['google']);
const FINALIZE_KINDS = Object.freeze(['consume', 'acknowledge']);
const UNKNOWN_FAULT = 'UNKNOWN_FAULT';

/* A bare code, exactly as every other boundary in this repository throws. */
const fail = (code, detail) => { throw new PgGuardError(code, detail); };

/* --------------------------------------------------------------- validation */

function requireText(value, code, max) {
 if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL_CHAR.test(value)) fail(code);
 return value;
}
const requireNotificationId = (value) => requireText(value, 'INVALID_NOTIFICATION_ID', NOTIFICATION_ID_MAX);
const requireTransactionId = (value) => requireText(value, 'INVALID_TRANSACTION_ID', TRANSACTION_ID_MAX);
const requireProductId = (value) => requireText(value, 'INVALID_PRODUCT_ID', PRODUCT_ID_MAX);
const requireActorId = (value) => requireText(value, 'INVALID_ACTOR', ACTOR_ID_MAX);
const requireReason = (value) => requireText(value, 'INVALID_REASON', REASON_MAX);
const requireWorkerId = (value) => requireText(value, 'INVALID_WORKER_ID', WORKER_ID_MAX);
function requireStore(value) { if (!STORES.includes(value)) fail('INVALID_STORE'); return value; }
function requireFinalizeStore(value) { if (!FINALIZE_STORES.includes(value)) fail('INVALID_STORE'); return value; }
function requireKind(value) { if (!FINALIZE_KINDS.includes(value)) fail('INVALID_KIND'); return value; }
function requirePurchaseToken(value) {
 if (typeof value !== 'string' || value.length === 0 || value.length > PURCHASE_TOKEN_MAX
     || CONTROL_CHAR.test(value) || /\s/.test(value)) fail('INVALID_PURCHASE_TOKEN');
 return value;
}
/* `lease_token` is a BIGINT; the driver hands it back as a string, so the fence is normalized to a JS
 * number on the way out and accepted in either form on the way in. */
const FENCE_MAX = Number.MAX_SAFE_INTEGER;
function requireFence(value) {
 const n = typeof value === 'string' && value.length > 0 ? Number(value) : value;
 if (!Number.isSafeInteger(n) || n < 0 || n > FENCE_MAX) fail('INVALID_FENCE');
 return n;
}
function requireBoundedLimit(value, dflt, max, code) {
 if (value === undefined || value === null) return dflt;
 if (!Number.isInteger(value) || value < 1 || value > max) fail(code);
 return value;
}
function requireLeaseMs(value) {
 if (!Number.isInteger(value) || value < 1 || value > MAX_LEASE_MS) fail('INVALID_LEASE');
 return value;
}
/* The attempt ceiling bounds the backoff exponent (`2 ** (attempts - 1)`), so it is a small positive
 * integer: `Math.pow(2, 1000)` is Infinity, and a ceiling that large would overflow the backoff
 * instead of capping it. */
const MAX_ATTEMPT_CEILING = 64;
function requireAttemptCeiling(value) {
 if (!Number.isInteger(value) || value < 1 || value > MAX_ATTEMPT_CEILING) fail('INVALID_MAX_ATTEMPTS');
 return value;
}
function requireFn(value, code) { if (typeof value !== 'function') fail(code); return value; }
/* Epoch milliseconds out of a `timestamptz` the driver may hand back as a Date (default type parser) or
 * as a string (a custom parser). The conversion is done here, not in SQL, so every instant this
 * service reports is the same number the caller bound. */
function msOf(value) {
 if (value === null || value === undefined) return null;
 if (value instanceof Date) return value.getTime();
 const n = Date.parse(value);
 if (!Number.isFinite(n)) fail('INVALID_TIMESTAMP');
 return n;
}
const atMs = (ms) => new Date(ms);

/* Provider exceptions can quote receipt IDs, bearer tokens and purchase tokens.
 * Persist only recognized, identifier-free categories, never raw error messages. */
const SAFE_PROVIDER_ERRORS = new Set([
 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMITED',
 'PROVIDER_AUTH_FAILED', 'SIGNATURE_INVALID', 'UPSTREAM_429',
 'UPSTREAM_5XX', 'UNKNOWN_FAULT',
]);
function sanitizeError(value) {
 const category = value && typeof value === 'object' ? value.code : null;
 return typeof category === 'string' && SAFE_PROVIDER_ERRORS.has(category)
  ? category : UNKNOWN_FAULT;
}

/* Exponential backoff, deterministic (the repository convention - `jobs.js` does the same), capped by
 * the declared attempt ceiling and then by the legacy one-hour wall. */
function backoffMs(attempts, base, maxAttempts) {
 const exponent = Math.min(Math.max(attempts - 1, 0), Math.max(maxAttempts - 1, 0));
 return Math.min(MAX_BACKOFF_MS, base * (2 ** exponent));
}

/* ------------------------------------------------------------------- SQL */

/* Ingest is create-only: a redelivered callback for a `(store, notification_id)` already in the
 * machine is a structural no-op and replays through the primary key, exactly like every other
 * idempotent writer in this repository. */
const INGEST_SQL = 'INSERT INTO monetization.store_notifications'
 + ' (store, notification_id, received_at, state, attempts, next_at)'
 + " VALUES ($1, $2, $3, 'pending', 0, $3)"
 + ' ON CONFLICT (store, notification_id) DO NOTHING';

/* The due notification set, locked. `FOR UPDATE SKIP LOCKED` means a worker takes the rows nobody else
 * is holding and never waits behind another worker's batch; the oldest callback breaks every tie, so
 * two workers scanning the same backlog take from the same end. A row qualifies while it is unapplied
 * and due, or while it carries a lease that has lapsed (a worker died mid-callback). */
const CLAIM_NOTIFICATIONS_KEYS_SQL = 'SELECT store, notification_id FROM monetization.store_notifications'
 + " WHERE (state IN ('pending', 'retry') AND next_at <= $1)"
 + " OR (state = 'processing' AND lease_until <= $1)"
 + ' ORDER BY received_at, store, notification_id'
 + ' LIMIT $2'
 + ' FOR UPDATE SKIP LOCKED';

/* Advance exactly the rows the statement above locked. `COALESCE(lease_token, 0) + 1` is computed
 * against a row this transaction holds the lock on, so the token is strictly monotonic per row and no
 * other worker can race the increment. `RETURNING` reads back the fence and the post-increment attempt
 * count the caller must present to `completeNotification`/`failNotification`. */
const CLAIM_NOTIFICATIONS_TAKE_SQL = 'UPDATE monetization.store_notifications'
 + " SET state = 'processing', lease_owner = $2, lease_token = COALESCE(lease_token, 0) + 1,"
 + ' lease_until = $3, attempts = attempts + 1'
 + ' WHERE (store, notification_id) IN (SELECT * FROM unnest($1::text[], $4::text[]))'
 + ' RETURNING store, notification_id, received_at, attempts, lease_token, last_error';

/* Completion is FENCED and PROVEN: it matches only the exact live lease (owner AND token) while the
 * row is still `processing`, and it stamps the `processed_at` the `store_notifications_processed_ck`
 * CHECK requires in the SAME statement. A stolen, expired or already-applied lease matches zero rows,
 * which is the whole point of the fence. */
const COMPLETE_NOTIFICATION_SQL = 'UPDATE monetization.store_notifications'
 + " SET state = 'applied', processed_at = $5, last_error = NULL,"
 + ' lease_owner = NULL, lease_token = NULL, lease_until = NULL'
 + ' WHERE store = $1 AND notification_id = $2 AND lease_owner = $3 AND lease_token = $4'
 + " AND state = 'processing'";

/* The CURRENT attempt count of a still-owned lease, read under the same fence as the mutation it
 * guards, so the retry backoff is derived from the committed row and never from a caller's memory. */
const NOTIFICATION_ATTEMPTS_SQL = 'SELECT attempts FROM monetization.store_notifications'
 + ' WHERE store = $1 AND notification_id = $2 AND lease_owner = $3 AND lease_token = $4'
 + " AND state = 'processing'"
 + ' FOR UPDATE';

/* Retry: the callback returns to the durable machine with an exponential backoff, its lease released
 * and its sanitized diagnostic recorded. `applied` is the only terminal state, so a callback keeps
 * retrying (bounded in backoff) rather than being silently dropped. */
const RETRY_NOTIFICATION_SQL = 'UPDATE monetization.store_notifications'
 + " SET state = 'retry', next_at = $5, last_error = $6,"
 + ' lease_owner = NULL, lease_token = NULL, lease_until = NULL'
 + ' WHERE store = $1 AND notification_id = $2 AND lease_owner = $3 AND lease_token = $4'
 + " AND state = 'processing'";

/* A duplicate provider callback must never reset the lease of an in-flight finalizer.
 * In particular, resetting lease_owner/token while the first worker calls Google
 * allows a second worker to claim and double-contact the external provider.
 * Keep *all* fields unchanged for done rows and for unexpired leases. An
 * unleased/expired/abandoned row may be refreshed for recovery. */
const FINALIZE_PROTECTED_SQL = "(monetization.store_finalize.state = 'done' OR "
 + "(monetization.store_finalize.lease_owner IS NOT NULL "
 + "AND monetization.store_finalize.lease_until > EXCLUDED.updated_at))";
const finalizeSet = (column, otherwise) => ' ' + column + ' = CASE WHEN ' + FINALIZE_PROTECTED_SQL
 + ' THEN monetization.store_finalize.' + column + ' ELSE ' + otherwise + ' END';
const ENQUEUE_FINALIZE_SQL = 'INSERT INTO monetization.store_finalize'
 + ' (store, transaction_id, product_id, purchase_token, kind, state, attempts, next_at, created_at, updated_at)'
 + " VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $6, $6)"
 + ' ON CONFLICT (store, transaction_id) DO UPDATE SET'
 + [
  finalizeSet('product_id', 'EXCLUDED.product_id'),
  finalizeSet('purchase_token', 'EXCLUDED.purchase_token'),
  finalizeSet('kind', 'EXCLUDED.kind'),
  finalizeSet('state', "'pending'"),
  finalizeSet('attempts', '0'),
  finalizeSet('next_at', 'EXCLUDED.next_at'),
  finalizeSet('lease_owner', 'NULL'),
  finalizeSet('lease_token', 'NULL'),
  finalizeSet('lease_until', 'NULL'),
  finalizeSet('updated_at', 'EXCLUDED.updated_at'),
 ].join(',')
 + ' RETURNING (xmax = 0) AS inserted, state';

/* The due finalization set, locked. UNLIKE the notification machine, a finalization row keeps
 * `state = 'pending'` while it is leased, so `next_at <= now` is NOT sufficient grounds to claim: doing
 * so would steal a live lease out from under a worker that is inside its provider call, advance the
 * fence behind it and double-contact the provider. A row therefore qualifies in exactly two disjoint
 * cases: it is UNLEASED and due by `next_at`, or it is LEASED and its lease has lapsed - the
 * recoverable-pending case, where a worker killed between claim and completion leaves the row leased
 * and a peer reclaims it with a higher fence once (and only once) the lease expires. */
const CLAIM_FINALIZE_KEYS_SQL = 'SELECT store, transaction_id FROM monetization.store_finalize'
 + " WHERE state = 'pending'"
 + ' AND ((lease_owner IS NULL AND next_at <= $1) OR (lease_owner IS NOT NULL AND lease_until <= $1))'
 + ' ORDER BY created_at, transaction_id'
 + ' LIMIT $2'
 + ' FOR UPDATE SKIP LOCKED';

const CLAIM_FINALIZE_TAKE_SQL = 'UPDATE monetization.store_finalize'
 + ' SET lease_owner = $2, lease_token = COALESCE(lease_token, 0) + 1, lease_until = $3,'
 + ' attempts = attempts + 1, updated_at = $4'
 + ' WHERE (store, transaction_id) IN (SELECT * FROM unnest($1::text[], $5::text[]))'
 + ' RETURNING store, transaction_id, product_id, purchase_token, kind, attempts, lease_token, created_at';

/* The GRANT GATE. A finalization is only ever contacted against a DURABLE GRANT: the receipt row must
 * exist and must not be refunded. The lookup is a LEFT JOIN against the locked finalize row so the
 * decision and the fence it was taken under are read from ONE consistent snapshot, and it reads the
 * receipt's OWN row (never a capped hydration) exactly as `commerce.purchase` does. */
const FINALIZE_STATE_SQL = 'SELECT f.product_id, f.purchase_token, f.kind, f.created_at, f.attempts,'
 + ' r.refunded AS receipt_refunded, r.transaction_id AS receipt_present,'
 + ' rv.transaction_id AS revocation_present'
 + ' FROM monetization.store_finalize f'
 + ' LEFT JOIN monetization.receipts r'
 + ' ON r.store = f.store AND r.transaction_id = f.transaction_id'
 + ' LEFT JOIN monetization.store_revocations rv'
 + ' ON rv.store = f.store AND rv.transaction_id = f.transaction_id'
 + " WHERE f.store = $1 AND f.transaction_id = $2 AND f.state = 'pending'"
 + ' AND f.lease_owner = $3 AND f.lease_token = $4 AND f.lease_until > $5'
 + ' FOR UPDATE OF f';

/* Terminal completion: the provider op succeeded, so the purchase token is CLEARED in the same UPDATE
 * (the row no longer needs, or holds, a credential) and the lease is released under the fence. */
const COMPLETE_FINALIZE_SQL = 'UPDATE monetization.store_finalize'
 + " SET state = 'done', purchase_token = '', updated_at = $5,"
 + ' lease_owner = NULL, lease_token = NULL, lease_until = NULL'
 + ' WHERE store = $1 AND transaction_id = $2 AND lease_owner = $3 AND lease_token = $4'
 + " AND state = 'pending'";

/* The grant never arrived (or arrived refunded): the provider is NOT contacted. The row backs off and
 * stays `pending` - visible through `listPendingFinalizations` and recoverable by the next sweep. */
const BACKOFF_FINALIZE_SQL = 'UPDATE monetization.store_finalize'
 + ' SET next_at = $5, updated_at = $6, lease_owner = NULL, lease_token = NULL, lease_until = NULL'
 + ' WHERE store = $1 AND transaction_id = $2 AND lease_owner = $3 AND lease_token = $4'
 + " AND state = 'pending'";

/* The terminal write-off: 24 h after the row was created with no durable grant, the finalization is
 * ABANDONED (0015: the V4 DELETE-on-abandon is replaced by this UPDATE, so `worker_runtime` needs no
 * DELETE grant on a permanent table). */
const ABANDON_FINALIZE_SQL = 'UPDATE monetization.store_finalize'
 + " SET state = 'abandoned', updated_at = $5,"
 + ' lease_owner = NULL, lease_token = NULL, lease_until = NULL'
 + ' WHERE store = $1 AND transaction_id = $2 AND lease_owner = $3 AND lease_token = $4'
 + " AND state = 'pending'";

/* The permanent revocation tombstone. It is written even when no receipt exists - the provider charged
 * and refunded a transaction this database never granted - and it is what a LATER purchase of the same
 * store transaction fails `RECEIPT_REFUNDED` against, so an out-of-order refund can never be undone by
 * a replayed purchase callback. */
const INSERT_REVOCATION_SQL = 'INSERT INTO monetization.store_revocations'
 + ' (store, transaction_id, product_id, occurred_at, reason)'
 + ' VALUES ($1, $2, $3, $4, $5)'
 + ' ON CONFLICT (store, transaction_id) DO NOTHING';

/* The grant dedupe probe. ONE row, the receipt's OWN identity, and its refund flag: this is the
 * difference between "already granted" (never mint again) and "not yet granted" (invoke the Core
 * grant). */
const RECEIPT_SQL = 'SELECT refunded FROM monetization.receipts'
 + ' WHERE store = $1 AND transaction_id = $2';

/* The refund-tombstone probe. A refund of a store transaction this database never granted leaves NO
 * receipt, so the receipt probe alone cannot see it; without this check an out-of-order or replayed
 * purchase callback would mint the consumable the provider already refunded. */
const REVOCATION_SQL = 'SELECT 1 AS present FROM monetization.store_revocations'
 + ' WHERE store = $1 AND transaction_id = $2';

const PENDING_FINALIZATIONS_SQL = 'SELECT store, transaction_id, product_id, kind, state,'
 + " (purchase_token IS NOT NULL AND purchase_token <> '') AS has_purchase_token,"
 + ' attempts, next_at, created_at, updated_at, lease_owner, lease_token, lease_until'
 + ' FROM monetization.store_finalize'
 + " WHERE state = 'pending'"
 + ' ORDER BY next_at, created_at, transaction_id'
 + ' LIMIT $1';

/* --------------------------------------------------------------- factory */

function createProviderWorkflow(options = {}) {
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
 const defaultLeaseMs = options.defaultLeaseMs === undefined
  ? DEFAULT_LEASE_MS : requireLeaseMs(options.defaultLeaseMs);
 const maxAttempts = options.maxAttempts === undefined
  ? DEFAULT_MAX_ATTEMPTS : requireAttemptCeiling(options.maxAttempts);
 const backoffBaseMs = options.backoffBaseMs === undefined
  ? DEFAULT_BACKOFF_BASE_MS : requireLeaseMs(options.backoffBaseMs);

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

 /* One statement, one pinned transaction on the borrowed pool. */
 const oneShot = (text, params) => pool.query(text, params);
 /* Two or more statements that MUST observe the same row locks and commit together (the due scan and
  * the claim it authorizes) run inside ONE borrowed transaction. */
 const inTransaction = (fn) => pool.withTransaction((tx) => fn((text, params) => tx.query(text, params)));
 /* The producer path: an explicit transaction/client means the INSERT rides the caller's unit of work
  * and MUST NOT open a second connection or a nested transaction. */
 const runOn = (clientOrTx, text, params) => {
  if (clientOrTx === undefined || clientOrTx === null) return pool.query(text, params);
  if (typeof clientOrTx.query !== 'function') fail('CLIENT_REQUIRED');
  return clientOrTx.query(text, params);
 };

 return Object.freeze({
  /* Persist a verified callback. A redelivery of the same `(store, notification_id)` is a structural
   * no-op, so `ingested` is false and nothing is overwritten. */
  async ingestNotification(input = {}, clientOrTx = null) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_INGEST');
   const store = requireStore(input.store);
   const notificationId = requireNotificationId(input.notificationId);
   const receivedAt = input.receivedAt === undefined ? clock()
    : (typeof input.receivedAt === 'number' && Number.isFinite(input.receivedAt)
     ? input.receivedAt : fail('INVALID_RECEIVED_AT'));
   await gate;
   const rowCount = (await runOn(clientOrTx, INGEST_SQL, [store, notificationId, atMs(receivedAt)])).rowCount;
   return { ingested: rowCount === 1, notificationId };
  },

  /* Claim a bounded, fenced batch of due callbacks for one worker. Every returned row carries the
    * fence its completion and failure MUST present back. */
  async claimDueNotifications(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_CLAIM');
   const workerId = requireWorkerId(input.workerId);
   const limit = requireBoundedLimit(input.limit, DEFAULT_CLAIM_LIMIT, MAX_CLAIM_LIMIT, 'INVALID_LIMIT');
   const leaseMs = input.leaseMs === undefined ? defaultLeaseMs : requireLeaseMs(input.leaseMs);
   const at = clock();
   const until = at + leaseMs;
   await gate;
   return inTransaction(async (q) => {
    const due = (await q(CLAIM_NOTIFICATIONS_KEYS_SQL, [atMs(at), limit])).rows;
    if (due.length === 0) return [];
    const stores = due.map((row) => String(row.store));
    const ids = due.map((row) => String(row.notification_id));
    const claimed = (await q(CLAIM_NOTIFICATIONS_TAKE_SQL, [stores, workerId, atMs(until), ids])).rows;
    return claimed.map((row) => ({
     store: row.store,
     notificationId: String(row.notification_id),
     receivedAt: msOf(row.received_at),
     attempts: Number(row.attempts),
     fence: Number(row.lease_token),
     lastError: row.last_error,
    }));
   });
  },

  /* Mark an applied callback. `true` only when THIS worker still holds THIS fence while the row is
    * `processing`; a stale owner whose lease was stolen matches zero rows and is refused. */
  async completeNotification(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_COMPLETION');
   const store = requireStore(input.store);
   const notificationId = requireNotificationId(input.notificationId);
   const workerId = requireWorkerId(input.workerId);
   const fence = requireFence(input.fence);
   const at = clock();
   await gate;
   const rowCount = (await oneShot(COMPLETE_NOTIFICATION_SQL,
    [store, notificationId, workerId, fence, atMs(at)])).rowCount;
   return rowCount === 1;
  },

  /* Record a failed callback. The retry backoff is derived from the COMMITTED attempt count read under
    * the same fence, so a caller cannot inflate or reset it; the diagnostic is sanitized to one bounded
    * line. Returns `{ retried: false, attempts: null }` when the fence is no longer held, because no
    * committed row exists for this owner to report on. */
  async failNotification(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_FAILURE');
   const store = requireStore(input.store);
   const notificationId = requireNotificationId(input.notificationId);
   const workerId = requireWorkerId(input.workerId);
   const fence = requireFence(input.fence);
   const error = sanitizeError(input.error);
   const at = clock();
   await gate;
   return inTransaction(async (q) => {
    const rows = (await q(NOTIFICATION_ATTEMPTS_SQL, [store, notificationId, workerId, fence])).rows;
    if (rows.length !== 1) return { retried: false, attempts: null, nextAt: null };
    const attempts = Number(rows[0].attempts);
    const nextAt = at + backoffMs(attempts, backoffBaseMs, maxAttempts);
    const rowCount = (await q(RETRY_NOTIFICATION_SQL,
     [store, notificationId, workerId, fence, atMs(nextAt), error])).rowCount;
    return { retried: rowCount === 1, attempts, nextAt };
   });
  },

  /* Enqueue the provider finalization for a verified purchase. The upsert is keyed by the durable
    * `(store, transaction_id)` identity, so a re-verification never creates a second row, and a `done`
    * row is terminal. Inside a caller's transaction it rides that unit of work. */
  async enqueueFinalization(input = {}, clientOrTx = null) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_FINALIZATION');
   const store = requireFinalizeStore(input.store);
   const transactionId = requireTransactionId(input.transactionId);
   const productId = requireProductId(input.productId);
   const purchaseToken = requirePurchaseToken(input.purchaseToken);
   const kind = requireKind(input.kind);
   const at = clock();
   await gate;
   const result = await runOn(clientOrTx, ENQUEUE_FINALIZE_SQL,
    [store, transactionId, productId, purchaseToken, kind, atMs(at)]);
   if (result.rows.length !== 1) fail('FINALIZATION_NOT_ENQUEUED');
   return {
    enqueued: result.rows[0].inserted === true, store, transactionId, kind, state: result.rows[0].state,
   };
  },

  /* Claim a bounded, fenced batch of due finalizations. A `pending` row whose lease has lapsed is
    * reclaimed here - the recoverable-pending case the task requires to be visible and recoverable. */
  async claimDueFinalizations(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_CLAIM');
   const workerId = requireWorkerId(input.workerId);
   const limit = requireBoundedLimit(input.limit, DEFAULT_CLAIM_LIMIT, MAX_CLAIM_LIMIT, 'INVALID_LIMIT');
   const leaseMs = input.leaseMs === undefined ? defaultLeaseMs : requireLeaseMs(input.leaseMs);
   const at = clock();
   const until = at + leaseMs;
   await gate;
   return inTransaction(async (q) => {
    const due = (await q(CLAIM_FINALIZE_KEYS_SQL, [atMs(at), limit])).rows;
    if (due.length === 0) return [];
    const stores = due.map((row) => String(row.store));
    const ids = due.map((row) => String(row.transaction_id));
    const claimed = (await q(CLAIM_FINALIZE_TAKE_SQL, [stores, workerId, atMs(until), atMs(at), ids])).rows;
    return claimed.map((row) => ({
     store: row.store,
     transactionId: String(row.transaction_id),
     productId: row.product_id,
     purchaseToken: row.purchase_token,
     kind: row.kind,
     attempts: Number(row.attempts),
     fence: Number(row.lease_token),
     createdAt: msOf(row.created_at),
    }));
   });
  },

  /* The grant gate, then the provider op, then the fenced completion.
    *
    * ORDER IS THE CONTRACT: the durable receipt is read FIRST, under the fence. If it is absent (or
    * refunded) the provider is NEVER contacted - an unconsumed purchase is a pending fact, not a
    * reason to consume against a grant that does not exist. Only a live grant proceeds to
    * `finalizeProvider`, which is awaited OUTSIDE any transaction (no connection, and certainly no
    * wallet lock, spans a provider round trip). The completion is a separate fenced UPDATE: if the
    * lease lapsed during the provider call a peer has taken over with a higher fence, this UPDATE
    * matches nothing and reports `completed: false` rather than pretending the op was settled. */
  async completeFinalization(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_COMPLETION');
   const store = requireFinalizeStore(input.store);
   const transactionId = requireTransactionId(input.transactionId);
   const workerId = requireWorkerId(input.workerId);
   const fence = requireFence(input.fence);
   const finalizeProvider = requireFn(input.finalizeProvider, 'FINALIZE_PROVIDER_REQUIRED');
   const at = clock();
   await gate;
   const rows = (await oneShot(FINALIZE_STATE_SQL, [store, transactionId, workerId, fence, atMs(at)])).rows;
   if (rows.length !== 1) return { completed: false, pendingGrant: false, fenceLost: true };
   const row = rows[0];
   const refunded = row.receipt_refunded === true
    || (row.revocation_present !== null && row.revocation_present !== undefined);
   const granted = row.receipt_present !== null && row.receipt_present !== undefined && !refunded;
   if (!granted) {
    /* No durable grant: the provider is not contacted. After the abandonment horizon the row becomes
      * terminal (`abandoned`); before it, the row backs off to a fresh due time and stays visible. */
    const age = at - msOf(row.created_at);
    let abandoned = false;
    if (age > ABANDON_AFTER_MS) {
     abandoned = (await oneShot(ABANDON_FINALIZE_SQL, [store, transactionId, workerId, fence, atMs(at)])).rowCount === 1;
    } else {
     const nextAt = at + backoffMs(Number(row.attempts), backoffBaseMs, maxAttempts);
     await oneShot(BACKOFF_FINALIZE_SQL, [store, transactionId, workerId, fence, atMs(nextAt), atMs(at)]);
    }
    return { completed: false, pendingGrant: true, refunded, abandoned };
   }
   /* The provider op. Acknowledge is for a non-consumable entitlement (`remove_ads`), consume for a
    * consumable Crown pack; the caller's `finalizeProvider` owns the provider protocol and its own
    * idempotency key. */
   await finalizeProvider({
    store, transactionId, productId: row.product_id, purchaseToken: row.purchase_token, kind: row.kind,
   });
   const done = (await oneShot(COMPLETE_FINALIZE_SQL, [store, transactionId, workerId, fence, atMs(at)])).rowCount === 1;
   return { completed: done, pendingGrant: false, fenceLost: !done };
  },

  /* A purchase callback: verify the durable grant state BEFORE any Core grant is invoked.
    *
    *   * a receipt already exists -> the purchase was granted once; report the duplicate and NEVER call
    *     `grantFn`, which is exactly the "never remint" rule;
    *   * a revocation tombstone exists with no receipt -> the provider refunded a transaction this
    *     database never granted (an out-of-order refund); calling `grantFn` here would mint the
    *     refunded consumable, so `grantFn` is refused;
    *   * otherwise the Core grant is invoked, and its result is reported.
    *
    * The callback itself is persisted first, so a worker that dies before the grant leaves a durable
    * notification row its redelivery replays against. */
  async handlePurchaseNotification(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_PURCHASE_NOTIFICATION');
   const store = requireStore(input.store);
   const notificationId = requireNotificationId(input.notificationId);
   const transactionId = requireTransactionId(input.transactionId);
   const actorId = requireActorId(input.actorId);
   const productId = requireProductId(input.productId);
   const grantFn = requireFn(input.grantFn, 'GRANT_REQUIRED');
   await gate;
   const ingested = (await oneShot(INGEST_SQL, [store, notificationId, atMs(clock())])).rowCount === 1;
   const receipt = (await oneShot(RECEIPT_SQL, [store, transactionId])).rows;
   if (receipt.length > 0) {
    return { duplicate: true, reminted: false, revoked: false, ingested, granted: null };
   }
   const revocation = (await oneShot(REVOCATION_SQL, [store, transactionId])).rows;
   if (revocation.length > 0) {
    return { duplicate: false, reminted: false, revoked: true, ingested, granted: null };
   }
   const granted = await grantFn({ store, notificationId, transactionId, actorId, productId });
   return { duplicate: false, reminted: false, revoked: false, ingested, granted };
  },

  /* A refund/void callback. The worker writes the PERMANENT revocation tombstone - the durable fact a
    * later purchase of this store transaction fails `RECEIPT_REFUNDED` against - even when no receipt
    * exists, exactly as the Core `commerce.refund` path does. The receipt freeze and any account hold
    * are Core-owned economic effects, so they are delegated to the injected `revokeFn`; this service
    * holds no write on `monetization.receipts`. */
  async handleRefundNotification(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_REFUND_NOTIFICATION');
   const store = requireStore(input.store);
   const transactionId = requireTransactionId(input.transactionId);
   const productId = input.productId === undefined || input.productId === null
    ? null : requireProductId(input.productId);
   const reason = input.reason === undefined ? 'refund' : requireReason(input.reason);
   const at = clock();
   await gate;
   const invoked = typeof input.revokeFn === 'function';
   /* An already-granted purchase needs a Core-owned receipt freeze and wallet
    * adjustment. Never report a recorded refund with no Core seam available
    * while the granted asset would remain untouched. Unknown transactions may
    * still be tombstoned first, preventing an out-of-order future mint. */
   const existing = (await oneShot(RECEIPT_SQL, [store, transactionId])).rows;
   if (existing.length > 0 && !invoked) fail('REFUND_CORE_SEAM_REQUIRED');
   const recorded = (await oneShot(INSERT_REVOCATION_SQL,
    [store, transactionId, productId, atMs(at), reason])).rowCount === 1;
   const refund = invoked ? await input.revokeFn({ store, transactionId, productId, reason }) : null;
   return { recorded, duplicate: !recorded, invoked, refund };
  },

  /* The restricted operator surface: the finalizations still waiting on a grant, soonest first,
    * returns only a boolean token-presence hint, never the purchase credential itself.
    * bounded. A row here is a purchase that is granted-or-waiting but not yet consumed/acknowledged -
    * the "pending finalization is visible" half of the task's verification. */
  async listPendingFinalizations(input = {}) {
   requireOpen();
   if (!input || typeof input !== 'object') fail('INVALID_LIST');
   const limit = requireBoundedLimit(input.limit, DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT, 'INVALID_LIMIT');
   await gate;
   const rows = (await oneShot(PENDING_FINALIZATIONS_SQL, [limit])).rows;
   return rows.map((row) => ({
    store: row.store,
    transactionId: String(row.transaction_id),
    productId: row.product_id,
    hasPurchaseToken: row.has_purchase_token === true,
    kind: row.kind,
    state: row.state,
    attempts: Number(row.attempts),
    nextAt: msOf(row.next_at),
    createdAt: msOf(row.created_at),
    updatedAt: msOf(row.updated_at),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token === null || row.lease_token === undefined ? null : Number(row.lease_token),
    leaseUntil: msOf(row.lease_until),
   }));
  },

  /* Stops accepting new work. The pool is caller-owned - it may be shared with other services - so
    * nothing borrowed is closed here and no timer is left behind by any method above. */
  async close() { closed = true; },
 });
}

module.exports = { createProviderWorkflow, WORKER_ROLE };
