/* packages/services/timers.js - V5 P08 durable clocks and scheduled expiry (V5-08-03).
 *
 *   const timers = createTimerService({ pool, core, ephemera, now, clockToleranceMs });
 *   await timers.scheduleTimeout(matchId, revision, deadlineMs);   // advisory Redis registration
 *   await timers.checkTimeouts({ now: clock, limit: 16 });         // due PLAYING deadlines -> timeout
 *   await timers.reapDueRooms({ now: clock, limit: 16 });          // lapsed OFFERED offers -> expire
 *   await timers.clockStatus();                                    // measured clock skew / latency
 *   await timers.close();                                          // closes NOTHING borrowed
 *
 * The V5 successor of the V4 maintenance scan (`server/jobs.js:11-12`, `server/community-http.js:50-51`
 * and the read-time writes on `GET /api/v1/match/:id`): the full-state in-process sweep becomes a
 * bounded, indexed PostgreSQL query, and the two commands it issues keep their EXACT legacy identity.
 *
 * DURABLE AUTHORITY. PostgreSQL is the only clock of record and the only scheduler: every deadline is
 * an ABSOLUTE epoch-millisecond instant persisted in `match.matches.deadline` / `.expires_at`, and
 * `checkTimeouts`/`reapDueRooms` select work from those committed columns alone. Redis holds ONE
 * rebuildable registration set and nothing else, so a wiped, expired or never-written ZSET can only
 * DELAY a sweep by one interval; it can never lose a timeout, extend a turn or resurrect a match
 * (design p06 I4: `due:*` is derived from committed deadlines and repopulated from PostgreSQL).
 *
 * THE CLOCK CONVENTION (spec 03 section 4: "persisted absolute deadlines and a tested database/server
 * clock convention"). A timer worker NEVER adjudicates time:
 *   - the caller's clock (`now`, or the per-call `now`) only PROPOSES candidates, because the sweep is
 *     an indexed read the planner can serve from the partial indexes
 *     `matches_playing_deadline_idx` / `matches_offered_expires_idx`;
 *   - the DECISION belongs to the Core transaction, whose every instant comes from the clock injected
 *     into `createCoreService`/the unit of work. `Authority.timeout` re-derives `now` there and refuses
 *     with `NOT_TIMED_OUT` unless the persisted deadline has actually elapsed; `Authority.move`
 *     re-derives it and refuses with `TIMER_EXPIRED`. So a worker whose clock runs ahead of the Core's
 *     can only produce a refused proposal, never an early settlement, and a worker whose clock runs
 *     behind can only make the Core refuse too - in both directions the approved turn rule is applied
 *     by the same transaction that owns the deadline.
 *   - `clockToleranceMs` is therefore a MEASUREMENT bound, not a rule: `clockStatus()` reports the
 *     observed skew between the worker's clock and PostgreSQL's own `now()` and the read round-trip,
 *     and flags whether the skew stayed inside the bound. It never widens or narrows a deadline.
 *
 * REVISION-BOUND IDENTITY. A scheduled timeout is claimed with the deterministic operation key
 * `timeout:<matchId>:<revision>` and the payload `{type:'timeout', id:matchId}` - the legacy identity
 * verbatim. Because the key names the revision, a timer armed for revision N cannot settle revision
 * N+1: the later revision is a DIFFERENT operation, and if the same revision is somehow replayed
 * against a newer turn the domain refuses it (deadline is in the future for the new turn), the
 * transaction rolls back and nothing is written. The same revision claimed by two workers is one
 * operation: the operation-identity mutex serializes them and the loser replays the winner's stored
 * response, so a duplicate expired-timer claim does nothing (P06 risk table: duplicate timeout).
 *
 * FAIL CLOSED ON READS, DEGRADE ON REDIS. A sweep whose due query cannot be answered must not report
 * "nothing is due" - the read fault PROPAGATES, exactly as a matcher must not mistake a dead database
 * for an empty queue. Redis is the opposite: an unreachable adapter is a documented conservative
 * `{registered:false, available:false}` and never a business verdict.
 *
 * OWNERSHIP. This service owns no connection: the `pool`, the `core` and the borrowed `ephemera`
 * adapter stay caller-owned and are never created, reconfigured or closed here. `close()` only stops
 * accepting new work. No timer is left behind by any method.
 */
'use strict';

/* The durable identity grammar of a match id (`matches_match_id_grammar_ck`, 0012_match.sql; the same
 * bound `src/authority.js` validId applies). A scheduled operation key is built from it, so it is
 * validated BEFORE it can reach the Core boundary or a Redis key. */
const MATCH_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
/* A bounded sweep: one tick can never scan unbounded work. */
const DEFAULT_LIMIT = 16;
const MAX_LIMIT = 256;
/* One Redis operation, one deadline - the same budget the borrowed adapter applies to its own ops. */
const REDIS_DEADLINE_MS = 2000;
/* The due-set key lives until its own deadline has passed plus this grace: long enough that a running
 * sweep always observes the member, short enough that no key outlives its usefulness. */
const DUE_GRACE_MS = 60000;
const DUE_MIN_TTL_MS = 1000;
/* The ONE frozen timer-worker principal (parent contract V5-08-03). `expire` and `timeout` share it:
 * the operation KEY namespaces the job (`timeout:<id>:<rev>` / `expire:<id>`), the principal is the
 * single authenticated worker identity, exactly like the queue service's one matchmaker principal. */
const TIMER_WORKER = Object.freeze({ actor: 'timeout-worker', scope: 'matchmaker' });
/* The due registration set: `mx:<env>:<version>:due:timeout`, the PLANNED ephemera family from the
 * p06 key matrix. The borrowed adapter's allowlist owns the namespace vocabulary and now carries
 * `due`, so this service spends the frozen vocabulary rather than inventing a second one. */
const DUE_FAMILY = 'due';
const DUE_PARTS = Object.freeze(['timeout']);
/* The codes a race legitimately produces: the timer lost to a committed move, a concurrent worker, a
 * settlement, a deleted match, or (for expiry) an offer that was accepted/declined/cancelled before
 * the sweep's own command ran. They are observations, never faults - the transaction rolled back with
 * zero effect. Anything else is reported as a fault so a worker loop can alarm on it. */
const RACE_CODES = Object.freeze(['NOT_TIMED_OUT', 'MATCH_CLOSED', 'NOT_EXPIRED', 'NOT_OPEN', 'UNKNOWN_MATCH']);
/* ZADD the member at the deadline score and PEXPIRE the whole key in ONE script, so a crash between
 * the add and the TTL is impossible and a due key can never become an immortal sorted set. */
/* One sorted set contains MANY matches. Replacing its TTL with a nearer
 * deadline can drop later due hints prematurely. Atomically keep the maximum
 * remaining TTL instead; PostgreSQL remains the deadline authority either way. */
const SCHEDULE_LUA = "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]); "
 + "local ttl = redis.call('PTTL', KEYS[1]); "
 + "if ttl < 0 or ttl < tonumber(ARGV[3]) then redis.call('PEXPIRE', KEYS[1], ARGV[3]); end; "
 + "return 1;";

/* Bounded, indexed reads. Both predicates repeat the EXACT partial-index predicate
 * (`matches_playing_deadline_idx`, `matches_offered_expires_idx`) so the sweep is served by the index
 * and never degrades into a sequential scan of the match aggregate. */
const DUE_TIMEOUTS_SQL = 'SELECT m.match_id, m.revision'
 + ' FROM match.matches m'
 + " WHERE m.status = 'PLAYING' AND m.settled = false AND m.deadline IS NOT NULL AND m.deadline <= $1"
 + ' ORDER BY m.deadline, m.match_id LIMIT $2';
const DUE_OFFERS_SQL = 'SELECT m.match_id'
 + ' FROM match.matches m'
 + " WHERE m.status = 'OFFERED' AND m.expires_at <= $1"
 + ' ORDER BY m.expires_at, m.match_id LIMIT $2';
const DB_CLOCK_SQL = 'SELECT (extract(epoch from now()) * 1000)::bigint AS db_now_ms';

const fail = (code) => { throw Error(code); };
function positiveInt(value, code, max = Number.MAX_SAFE_INTEGER) {
 if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code);
 return value;
}
/* A measurement bound admits zero: `clockToleranceMs: 0` means "measure exactly, tolerate no skew",
 * which is a legitimate (strictest) configuration, not an invalid one. */
function nonNegativeInt(value, code) {
 if (!Number.isSafeInteger(value) || value < 0) fail(code);
 return value;
}
/* Stable observation code for a thrown value. Core and the domain throw bare codes (their `message`),
 * exactly like every other boundary in this repository; an opaque fault keeps its own name. */
const codeOf = (error) => (error && typeof error.message === 'string' && error.message ? error.message : 'UNKNOWN_FAULT');

function createTimerService(options = {}) {
 if (!options.core || typeof options.core.run !== 'function') fail('CORE_REQUIRED');
 if (!options.pool || typeof options.pool.withTransaction !== 'function') fail('PG_POOL_REQUIRED');
 if (options.now !== undefined && typeof options.now !== 'function') fail('CLOCK_REQUIRED');
 const now = typeof options.now === 'function' ? options.now : Date.now;
 const clockToleranceMs = options.clockToleranceMs === undefined
  ? 1000 : nonNegativeInt(options.clockToleranceMs, 'INVALID_TOLERANCE');
 /* The borrowed adapter is caller-owned and OPTIONAL: a partial object is not a working adapter, so
  * the capability check keeps it from being mistaken for one. Without it, registrations are
  * unavailable and the sweep still runs from committed PostgreSQL truth. */
 const ephemera = options.ephemera
  && typeof options.ephemera.key === 'function'
  && options.ephemera.client !== undefined
  ? options.ephemera : null;
 const core = options.core;
 const pool = options.pool;

 let closed = false;

 /* One Redis operation, one deadline. `{ok:false}` is the ONLY failure shape, so an unreachable or
  * never-configured Redis is never a business verdict: the caller decides which conservative answer
  * it means. A rejection (socket gone, offline queue disabled) resolves identically to a timeout. */
 async function callRedis(fn) {
  if (!ephemera) return { ok: false };
  let timer;
  try {
   const work = (async () => {
    /* The adapter's own bounded connect promise: a command issued during the connect window waits for
     * it instead of failing on a spurious "offline queue disabled" rejection. */
    const connected = ephemera.connected;
    if (connected && typeof connected.then === 'function') await connected;
    return fn(ephemera.client);
   })();
   const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false }), REDIS_DEADLINE_MS); });
   try {
    return await Promise.race([work.then((value) => ({ ok: true, value }), () => ({ ok: false })), deadline]);
   } finally { clearTimeout(timer); }
  } catch { return { ok: false }; }
 }

 /* The due registration key, or null when no adapter is available. `key()` can only fail on a bad
  * part, and both parts are frozen constants. */
 function dueKey() {
  try { return ephemera.key(DUE_FAMILY, ...DUE_PARTS); } catch { return null; }
 }

 /* The deterministic scheduled-timeout member: `<matchId>:<revision>`. */
 const dueMember = (matchId, revision) => `${matchId}:${revision}`;
 /* The deterministic operation identity (parent contract section 2). */
 const timeoutKey = (matchId, revision) => `timeout:${matchId}:${revision}`;
 /* The legacy expire identity, byte-identical to `server/jobs.js:11` / `server/community-http.js:50`. */
 const expireKey = (matchId) => `expire:${matchId}`;

 const requireMatchId = (matchId) => {
  if (typeof matchId !== 'string' || !MATCH_ID.test(matchId)) fail('INVALID_MATCH');
  return matchId;
 };
 /* An absolute epoch-millisecond instant: the shape every deadline the authority writes has
  * (`started + turnSeconds * 1000`). */
 const requireDeadline = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_DEADLINE');
  return value;
 };
 const requireClock = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_CLOCK');
  return value;
 };
 const requireOpen = () => { if (closed) fail('TIMER_CLOSED'); };

 /* The sweep clock: an explicit `input.now` (an instant OR a clock function, exactly the shape the
  * factory accepts), else the injected clock. It is only ever used to SELECT candidates - every
  * decision is re-derived by the Core transaction. */
 const resolveInstant = (value) => requireClock(typeof value === 'function' ? value() : value);
 const sweepClock = (input) => (input.now === undefined ? requireClock(now()) : resolveInstant(input.now));
 const sweepLimit = (input) => (input.limit === undefined ? DEFAULT_LIMIT : positiveInt(input.limit, 'INVALID_LIMIT', MAX_LIMIT));

 /* The bounded due read. A failure PROPAGATES: a sweep that cannot prove what is due must not answer
  * "nothing", or a database outage would silently stop every turn timer. */
 async function readDue(sql, at, limit) {
  return pool.withTransaction(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query(sql, [new Date(at), limit])).rows;
  });
 }

 return Object.freeze({
  /* Register a timeout for one committed revision. This is an ACCELERATOR, never a schedule of
   * record: the member is scored at the absolute deadline and the whole key is TTL-bounded to the
   * deadline plus one grace interval, so nothing here is immortal and nothing here is authoritative.
   * The member is revision-bound, so a new turn arms a new member and can never overwrite an elder
   * one's identity. No PostgreSQL read or write is performed. */
  async scheduleTimeout(matchId, revision, deadlineMs) {
   requireOpen();
   requireMatchId(matchId);
   if (!Number.isSafeInteger(revision) || revision < 0) fail('INVALID_REVISION');
   requireDeadline(deadlineMs);
   const member = dueMember(matchId, revision);
   const key = dueKey();
   const base = { matchId, revision, deadlineMs, member, key };
   if (key === null) return { ...base, registered: false, available: false, conservative: true };
   const ttlMs = Math.max(DUE_MIN_TTL_MS, Math.ceil(deadlineMs - now()) + DUE_GRACE_MS);
   const result = await callRedis((client) => client.sendCommand(
    ['EVAL', SCHEDULE_LUA, '1', key, String(deadlineMs), member, String(ttlMs)]));
   if (!result.ok) return { ...base, registered: false, available: false, conservative: true };
   return { ...base, registered: true, available: true, conservative: false };
  },

  /* Settle every PLAYING match whose persisted absolute deadline has elapsed, in one bounded batch.
   * Each due match is claimed with the deterministic revision-bound identity, so two workers (or two
   * sweeps) produce ONE settlement: the operation-identity mutex serializes them and the loser replays
   * the winner's committed receipt. A match that raced a winning move, settled or reset its deadline
   * rolls back with zero effect and is reported under `errors`, never under `settled`. */
  async checkTimeouts(input = {}) {
   requireOpen();
   const at = sweepClock(input);
   const limit = sweepLimit(input);
   const rows = await readDue(DUE_TIMEOUTS_SQL, at, limit);
   const settled = [], errors = [];
   for (const row of rows) {
    const matchId = String(row.match_id);
    const revision = Number(row.revision);
    const key = timeoutKey(matchId, revision);
    try {
     const receipt = await core.run(TIMER_WORKER, key, { type: 'timeout', id: matchId });
     /* The timeout command answers with the settlement receipt; a response that is not one is a
      * boundary fault, not a settlement, so it is reported honestly instead of being reshaped. */
     if (!receipt || typeof receipt !== 'object' || typeof receipt.reason !== 'string') {
      errors.push({ matchId, revision, code: 'UNEXPECTED_RESPONSE' });
      continue;
     }
     settled.push({ matchId, revision, winner: receipt.winner === undefined ? null : receipt.winner, reason: receipt.reason });
    } catch (error) {
     /* A LOST RACE IS NOT A FAULT: the move won, the match settled, the deadline was reset or the
      * match is gone - the transaction rolled back with zero effect and settled nothing. Reporting it
      * as an error would make a healthy timer worker alarm on normal racing, so only an UNEXPECTED
      * code is surfaced; the expected ones are observable as "absent from `settled`". */
     const code = codeOf(error);
     if (!RACE_CODES.includes(code)) errors.push({ matchId, revision, code });
    }
   }
   return { settled, errors };
  },

  /* Expire every OFFERED match whose offer window has lapsed, in one bounded batch, through the
   * legacy `expire` command and its legacy identity `expire:<id>`. The domain re-checks the committed
   * status and expiry inside the transaction, so an offer that was accepted, declined, cancelled or
   * expired by another writer rolls back with zero effect and lands under `errors`. */
  async reapDueRooms(input = {}) {
   requireOpen();
   const at = sweepClock(input);
   const limit = sweepLimit(input);
   const rows = await readDue(DUE_OFFERS_SQL, at, limit);
   const expired = [], errors = [];
   for (const row of rows) {
    const matchId = String(row.match_id);
    try {
     const view = await core.run(TIMER_WORKER, expireKey(matchId), { type: 'expire', id: matchId });
     /* `expire` answers with the committed match view (the legacy `Authority.view` DTO). */
     if (!view || typeof view !== 'object' || typeof view.status !== 'string') {
      errors.push({ matchId, revision: null, code: 'UNEXPECTED_RESPONSE' });
      continue;
     }
     expired.push({ matchId, revision: Number(view.revision), status: view.status });
    } catch (error) {
     /* Same rule as `checkTimeouts`: an offer that was accepted, declined, cancelled or already
      * expired (NOT_EXPIRED) or whose row is gone (UNKNOWN_MATCH) is a lost race, not a fault. */
     const code = codeOf(error);
     if (!RACE_CODES.includes(code)) errors.push({ matchId, revision: null, code });
    }
   }
   return { expired, errors };
  },

  /* MEASURE, never adjudicate: one read-only round trip against PostgreSQL reports the database's own
   * clock, the worker's clock, the observed skew and the read latency, and flags whether the skew
   * stayed inside `clockToleranceMs`. A fault resolves to the conservative `available:false` shape
   * instead of throwing, because a measurement must never become a control path. */
  async clockStatus() {
   if (closed) return { available: false, conservative: true };
   const startedAt = Date.now();
   try {
    const databaseNowMs = await pool.withTransaction(async (tx) => {
     await tx.query('SET TRANSACTION READ ONLY');
     return Number((await tx.query(DB_CLOCK_SQL)).rows[0].db_now_ms);
    });
    const latencyMs = Date.now() - startedAt;
    const clockMs = now();
    const skewMs = databaseNowMs - clockMs;
    return {
     available: true, conservative: false,
     databaseNowMs, clockMs, skewMs, latencyMs,
     toleranceMs: clockToleranceMs, withinTolerance: Math.abs(skewMs) <= clockToleranceMs,
    };
   } catch { return { available: false, conservative: true, latencyMs: Date.now() - startedAt }; }
  },

  /* Stops accepting new work. The pool, the Core service and the borrowed adapter stay caller-owned -
   * they may be shared with other services - and no timer is left behind by any method above. */
  async close() { closed = true; },
 });
}

module.exports = { createTimerService };
