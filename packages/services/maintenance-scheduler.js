/* packages/services/maintenance-scheduler.js - V5 P10 task V5-10-04 (season/leaderboard/maintenance
 * scheduling).
 *
 *   const scheduler = createMaintenanceScheduler({ corePool, coreClient, now, domain });
 *   await scheduler.tick();                             // one UTC day of maintenance
 *   await scheduler.catchUp({ sinceMs, untilMs });     // drain an outage gap
 *   scheduler.getSeason();                             // the approved quarter descriptor
 *   await scheduler.close();                           // release ONLY what this factory built
 *
 * WHAT MOVES OUT OF THE GAME PROCESS. `server/jobs.js:4-13` runs `maintenance(store, now)` on the
 * GAME's event loop: it takes `today = D.day(now)`, issues `snapshot:<today>`, derives the finished
 * weeks from the published snapshot keys, issues `weekly:<week>:<today>` for each week whose Monday
 * closes at or before `now`, and then sweeps due match expirations/timeouts. It is driven by a 15 s
 * `setInterval` inside the server process (`startMaintenance`), which is why neither a payment nor a
 * snapshot can be produced while the game process is down, and why two overlapping processes would
 * race the same work. This module is that scan in the WORKER process, on top of the durable Core
 * command transaction (`packages/services/core.js`) and the P08 durable clock sweeps
 * (`packages/services/timers.js`). It re-implements no rule: `snapshot` and `weekly` are the same
 * operator-gated Core-owned commands, dispatched by the same frozen `executeCommand`.
 *
 * STABLE UTC PERIOD IDENTITIES. Every scheduled operation key is derived from its business period and
 * nothing else - no fresh UUID, no attempt counter, no host name (spec 03 section 1/6):
 *   - daily snapshot   `snapshot:<YYYY-MM-DD>`                  (parent contract, legacy `jobs.js`)
 *   - weekly payout    `weekly:<weekStartYYYY-MM-DD>:<today>`  (parent contract, legacy `jobs.js`)
 *   - season rollover  the quarterly transition has no dedicated command in the frozen dispatcher
 *     (packages/domain/commands.js has no 'season' case); season rollover is an automatic effect of
 *     Core hydration (`restore` calls `_season(now)`, archiving the prior quarter into
 *     `economy.season_history` and initializing the new quarter in `economy.season_state`), and the
 *     daily snapshot command re-runs `publishLeagues()` which publishes the new quarter's tiers.
 *     `getSeason()` exposes the approved quarter descriptor (`domain.season`), and the stable period
 *     identity `season:<YYYY-QN>` is the period identity the scheduler reports in its season surface.
 * `today = domain.day(now())` and `week = domain.week(dayOfThatWeek)`; a month, a deployment or a
 * worker restart does not change them. The identity reaches Core as the operation key of the
 * maintenance principal, so `economy.command_outcomes` holds ONE row per period and the Core
 * operation-identity mutex plus the replay path make a repeat a structural no-op.
 *
 * SINGLETON BUSINESS EFFECT (the reason two workers are safe). `core.run` locks the operation
 * identity, then re-reads the outcome; the loser of a race replays the winner's committed response
 * instead of applying a second business effect. `snapshot`/`weekly` are GLOBAL commands in Core, so
 * each also locks EVERY actor row: two schedulers that tick the same UTC day (or two that recover the
 * same outage) serialize on the aggregate and produce exactly ONE snapshot map and ONE set of weekly
 * payments. The domain is the second line of defence: `snapshotDay` returns the existing map for a
 * date it already published, and `payoutWeek` returns the existing payment for every
 * `(week, actor)` already paid (`season.weekly_payouts` is the durable `weeklyPaid` record).
 *
 * NO FABRICATED PERIODS. This factory never invents an observation the approved rules never made:
 *   - the snapshot date is chosen by CORE's clock (`Authority.snapshotDay`), never by the worker.
 *     Issuing `snapshot:<a past UTC day>` therefore records that the day's work unit was evaluated;
 *     it can NEVER backdate a snapshot row (the domain has no such path and `payoutWeek` refuses to
 *     pay a week whose seventh-day snapshot is missing).
 *   - catch-up does not "backfill" missed snapshots or rewards. It re-issues the missing day work
 *     units in chronological order, skips the days the durable `season.day_snapshots` table already
 *     holds (already completed work), and settles each closed week through the same idempotent
 *     `weekly` command - so an unplaced, unqualified, suspended or inactive actor is paid 0, exactly
 *     as `D.weeklyReward` decides.
 *
 * CATCH-UP. `catchUp({ sinceMs, untilMs = now })` walks every UTC day from `domain.day(sinceMs)` to
 * `domain.day(untilMs)` inclusive and issues its `snapshot:<day>` identity in chronological order,
 * then settles the closed weeks, mirroring `maintenance()`'s own week derivation: the set of weeks is
 * taken from the PUBLISHED snapshot days (each published day's UTC Monday) restricted to the weeks
 * whose Monday-plus-seven-days has elapsed at `untilMs`. A week with no published day is never
 * attempted, because `payoutWeek` requires the week's seventh-day snapshot - the same reason the
 * legacy scan could not pay it either. The walk is bounded (`MAX_CATCHUP_DAYS`, `MAX_PUBLISHED_DAYS`)
 * and a read that cannot prove the published set fails closed (`STATE_TRUNCATED`) instead of
 * silently reporting that nothing is owed.
 *
 * ROLE. Every economic effect is a Core-owned command issued by the frozen maintenance principal
 * `{ actor: 'maintenance', scope: 'operator' }` through `core.run`; this module writes NO economic
 * row of its own. The optional published-day read uses the caller's `core_runtime` pool
 * (`SELECT` on `season.day_snapshots` only, 0021), or falls back to the Core service's own
 * strong-current aggregate read when only a `coreClient` was supplied. The optional match sweep
 * delegates to a caller-owned P08 timer service, which owns the `timeout`/`expire` commands and the
 * Redis registrations.
 *
 * BOOT CONTRACT.
 *  - `corePool` MUST be the `core_runtime` pool; a pool that logged in as another identity is refused
 *    with `PgGuardError('ROLE_MISMATCH')` before any statement. `verifyRuntimeSchema(pool)` is
 *    awaited by every method, so no statement runs against an unverified chain. The factory itself is
 *    synchronous (the same shape as `createJobService`/`createTimerService`) and mints nothing.
 *  - `coreClient` is an ALREADY-BOOTED Core service (the caller may share one instance between
 *    schedulers). When it is supplied it is used as-is and NEVER closed here; `corePool` is only
 *    needed for the bounded published-day read. With no `coreClient`, the factory builds and OWNS one
 *    `createCoreService(pool, { now })` - lazily, on first use - and `close()` closes exactly that.
 *  - `timers` is OPTIONAL and caller-owned: a P08 timer service exposes `checkTimeouts`/`reapDueRooms`
 *    and `tick()` then reports their summaries in `timeouts`/`expirations`. Without it both keys are
 *    `null` and no match sweep is attempted (the legacy scan's expire/timeout half stays with the
 *    service that owns the deadlines).
 *  - `now` is the injected clock. It only PROPOSES periods and candidates; the decision belongs to the
 *    Core transaction, which re-derives its own `now` from the clock injected into Core.
 *  - `close()` releases this factory's own Core client and marks the scheduler closed. The pool, a
 *    caller's Core service, the timer service and the domain module stay caller-owned. No timer is
 *    ever armed here.
 */
'use strict';
const { PgGuardError } = require('../db/pg/guards.js');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');
const { createCoreService } = require('./core.js');
/* The canonical pure product domain (`src/domain.js` is the single definition every consumer
 * publishes; see packages/domain/index.js). Only the UTC calendar helpers are used here - `day`,
 * `week`, `weekStart`, `season`, `DAY` - so no second calendar convention can drift from the one the
 * domain, the API projections and the payout rule already share. */
const DEFAULT_DOMAIN = require('../../src/domain.js');

/* The one runtime identity that owns `season.*` / `economy.*` writes. */
const CORE_ROLE = 'core_runtime';
/* The ONE frozen maintenance principal (parent contract V5-10-04). `snapshot` and `weekly` are
 * `operator`-gated in packages/domain/commands.js; this actor has no account row - it is a trusted
 * service principal, exactly like the P08 `timeout-worker`. */
const MAINTENANCE = Object.freeze({ actor: 'maintenance', scope: 'operator' });

/* Core's own operation-key grammar (`economy.command_outcomes_key_check`, 0009; the JS bound is 160
 * units, packages/contracts/invocation.js): a scheduled key is validated BEFORE it can reach Core so a
 * malformed period is a local `INVALID_OPERATION` and never a mid-transaction failure. */
const OPERATION_KEY = /^[A-Za-z0-9:_-]{1,160}$/;
const DAY_LABEL = /^\d{4}-\d{2}-\d{2}$/;

/* The optional match sweep's bounded batch (the P08 timer service's own default is 16). */
const DEFAULT_SWEEP_LIMIT = 16;
const MAX_SWEEP_LIMIT = 256;
/* A catch-up walk is bounded: 400 UTC days and 4096 distinct published days (about eleven years of
 * daily snapshots). Beyond that the caller is draining the wrong range, or a read cannot prove the
 * published set, and the scheduler fails closed instead of reporting nothing owed. */
const MAX_CATCHUP_DAYS = 400;
const MAX_PUBLISHED_DAYS = 4096;

/* `SELECT to_char(day,'YYYY-MM-DD')` is deliberately the same projection the Core repository's
 * aggregate read uses, so a published day label is byte-identical on both paths. */
const PUBLISHED_DAYS_SQL = "SELECT to_char(day, 'YYYY-MM-DD') AS day FROM season.day_snapshots ORDER BY day LIMIT $1";

const fail = (code, detail) => { throw new PgGuardError(code, detail); };
/* Stable observation code for a thrown value. Core and the domain throw bare codes (their `message`),
 * exactly like every other boundary in this repository; an opaque fault keeps its own name. */
const codeOf = (error) => (error && typeof error.message === 'string' && error.message ? error.message : 'UNKNOWN_FAULT');

/* ------------------------------------------------------------- validation */

function requireLimit(value) {
 if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SWEEP_LIMIT) {
  fail('INVALID_LIMIT', { limit: String(value), max: MAX_SWEEP_LIMIT });
 }
 return value;
}
function requireInstant(value, code) {
 if (!Number.isFinite(value)) fail(code, { value: String(value) });
 return value;
}
/* The domain's pure calendar helpers, validated at the boundary: a domain module that cannot answer
 * `day`/`week`/`weekStart`/`season`/`DAY` is not a calendar, and guessing one would fork the UTC
 * convention the whole economy keys on. */
function requireDomain(domain) {
 for (const name of ['day', 'week', 'weekStart', 'season']) {
  if (!domain || typeof domain[name] !== 'function') fail('DOMAIN_REQUIRED', { missing: name });
 }
 if (!Number.isSafeInteger(domain.DAY) || domain.DAY <= 0) fail('DOMAIN_REQUIRED', { missing: 'DAY' });
 return domain;
}
/* The exact payment shape `Authority.payoutWeek` returns (the legacy `weeklyPaid` record). A response
 * the rule did not produce is reported as an empty set rather than being reshaped into one. */
function normalizePayments(value) {
 if (!Array.isArray(value)) return [];
 return value.map((payment) => ({
  id: payment && typeof payment.id === 'string' ? payment.id : null,
  account: payment && typeof payment.account === 'string' ? payment.account : null,
  week: payment && typeof payment.week === 'string' ? payment.week : null,
  amount: payment && Number.isSafeInteger(payment.amount) ? payment.amount : 0,
  tier: payment && typeof payment.tier === 'string' ? payment.tier : null,
  eligible: !!(payment && payment.eligible === true),
  days: payment && Number.isSafeInteger(payment.days) ? payment.days : null,
 }));
}
const sumAmounts = (payments) => payments.reduce((total, payment) => total + payment.amount, 0);

/* --------------------------------------------------------------- factory */

function createMaintenanceScheduler(options = {}) {
 if (!options || typeof options !== 'object') fail('OPTIONS_REQUIRED');
 const domain = requireDomain(options.domain === undefined ? DEFAULT_DOMAIN : options.domain);

 /* The Core command channel: an already-booted service (caller-owned) and/or the `core_runtime` pool
  * this factory may build and own one service from. At least one is required - without either there is
  * no way to issue a Core-owned command at all. */
 const pool = options.corePool === undefined || options.corePool === null ? null : options.corePool;
 const client = options.coreClient === undefined || options.coreClient === null ? null : options.coreClient;
 if (pool === null && client === null) fail('CORE_REQUIRED');
 if (client !== null && typeof client.run !== 'function') fail('CORE_REQUIRED');
 if (pool !== null) {
  if (typeof pool.describe !== 'function' || typeof pool.withTransaction !== 'function') fail('PG_POOL_REQUIRED');
  const described = pool.describe();
  if (!described || described.role !== CORE_ROLE) {
   fail('ROLE_MISMATCH', { expected: CORE_ROLE, observed: described ? described.role : null });
  }
 }
 if (options.now !== undefined && typeof options.now !== 'function') fail('CLOCK_REQUIRED');
 const now = typeof options.now === 'function' ? options.now : Date.now;
 const limit = options.limit === undefined ? DEFAULT_SWEEP_LIMIT : requireLimit(options.limit);

 /* The OPTIONAL, caller-owned P08 timer service. A partial object is not a timer service, so it is
  * treated as ABSENT rather than mistaken for one (the same conservative-shape rule Core applies to
  * its ephemera adapter); `timers` is never constructed or closed here - it owns its own deadlines and
  * Redis registrations. */
 const timers = options.timers
  && typeof options.timers.checkTimeouts === 'function'
  && typeof options.timers.reapDueRooms === 'function'
  ? options.timers : null;

 /* Boot gate: the same read-only chain verification every service in this repository performs. It
  * starts here and every method awaits it, so no statement can run against an unverified chain. The
  * absorbing handler only prevents an unhandled-rejection warning; the awaited promise still rejects.
  * A caller-supplied Core client is already gated; a pool-only caller is gated here as well as by
  * `createCoreService`. */
 const gate = pool === null ? null : verifyRuntimeSchema(pool);
 if (gate !== null) gate.catch(() => {});

 let closed = false;
 /* The Core service this factory OWNS, built lazily on first use so a construction cannot open a
  * connection. The promise is memoized so two overlapping ticks share ONE service; a failed boot
  * clears the slot so the next call retries instead of caching a rejection forever. */
 let ownedCore = null;

 const requireOpen = () => { if (closed) fail('SCHEDULER_CLOSED'); };
 const clock = () => {
  const ms = now();
  if (!Number.isFinite(ms)) fail('CLOCK_REQUIRED');
  return ms;
 };
 /* The calendar wrappers: every label the domain returns is validated against the grammar it is
  * about to be embedded in, so `snapshot:` cannot receive a malformed date. */
 const dayOf = (ms) => {
  const label = domain.day(ms);
  if (typeof label !== 'string' || !DAY_LABEL.test(label)) fail('INVALID_PERIOD', { day: String(label) });
  return label;
 };
 const weekOf = (ms, label) => {
  const week = domain.week(ms);
  if (typeof week !== 'string' || !DAY_LABEL.test(week)) fail('INVALID_PERIOD', { week: String(week), day: String(label) });
  return week;
 };
 const weekStartOf = (week) => {
  const start = domain.weekStart(week);
  if (!Number.isSafeInteger(start) || start <= 0) fail('INVALID_PERIOD', { week: String(week) });
  return start;
 };
 const snapshotKey = (day) => `snapshot:${day}`;
 const weeklyKey = (week, today) => `weekly:${week}:${today}`;

 /* One Core-owned competitive command, with the frozen maintenance principal and a key validated
  * before it can reach the transaction boundary. */
 async function issue(key, command) {
  if (typeof key !== 'string' || !OPERATION_KEY.test(key)) fail('INVALID_OPERATION', { key: String(key) });
  const core = await coreService();
  return core.run(MAINTENANCE, key, command);
 }

 /* The Core service to command: the caller's when supplied (never closed here), else the one this
  * factory owns over the caller's pool. */
 async function coreService() {
  if (client !== null) return client;
  if (ownedCore === null) {
   ownedCore = createCoreService(pool, { now }).catch((error) => { ownedCore = null; throw error; });
  }
  return ownedCore;
 }
/* SQL selectors for published observations and completed operation outcomes. */
const SNAPSHOT_OUTCOMES_SQL = "SELECT \"key\"::text AS key FROM economy.command_outcomes WHERE actor_id = 'maintenance' AND \"key\"::text LIKE '%snapshot:%' LIMIT $1";

/* The PUBLISHED UTC days, the durable record of completed daily work in `season.day_snapshots`.
 * `tick`/`catchUp` key every period decision on it, exactly as the legacy scan derived its finished
 * weeks from the store's snapshot map. A bounded read: a result at the cap cannot prove which day is
 * absent, so it fails closed (`STATE_TRUNCATED`) instead of under-reporting what must be settled.
 * Without a pool the Core service's own strong-current aggregate read answers, in the legacy
 * `store.read()` shape. */
async function publishedDays() {
 if (pool === null) {
  const aggregate = await (await coreService()).read();
  const snapshots = aggregate && Array.isArray(aggregate.snapshots) ? aggregate.snapshots : [];
  if (snapshots.length > MAX_PUBLISHED_DAYS) fail('STATE_TRUNCATED', { publishedDays: snapshots.length, max: MAX_PUBLISHED_DAYS });
  return snapshots.map((entry) => String(entry[0]));
 }
 return pool.withTransaction(async (tx) => {
  await tx.query('SET TRANSACTION READ ONLY');
  const rows = (await tx.query(PUBLISHED_DAYS_SQL, [MAX_PUBLISHED_DAYS + 1])).rows;
  if (rows.length > MAX_PUBLISHED_DAYS) fail('STATE_TRUNCATED', { publishedDays: rows.length, max: MAX_PUBLISHED_DAYS });
  return rows.map((row) => String(row.day));
 });
}

/* The completed daily snapshots: the union of `season.day_snapshots` (observations recorded while
 * live) and `economy.command_outcomes` (past-day identities already evaluated and committed). This
 * is how `catchUp` distinguishes completed work from missed work without fabricating: a day already
 * observed live or already drained by an earlier catch-up is SKIPPED, so a repeated catch-up adds
 * zero outcome rows and never re-issues. */
async function completedSnapshotDays() {
 const set = new Set(await publishedDays());
 const queryOutcomes = async (tx) => {
  const rows = (await tx.query(SNAPSHOT_OUTCOMES_SQL, [MAX_PUBLISHED_DAYS + 1])).rows;
  if (rows.length > MAX_PUBLISHED_DAYS) fail('STATE_TRUNCATED', { outcomes: rows.length, max: MAX_PUBLISHED_DAYS });
  return rows;
 };
 let outcomeRows = [];
 if (pool !== null) {
  outcomeRows = await pool.withTransaction(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return queryOutcomes(tx);
  });
 } else {
  const core = await coreService();
  if (typeof core.read === 'function') {
   outcomeRows = await core.read(async (tx) => queryOutcomes(tx));
  }
 }
 for (const row of outcomeRows) {
  const match = String(row.key).match(/snapshot:(\d{4}-\d{2}-\d{2})/);
  if (match) set.add(match[1]);
 }
 return set;
}
 /* The weeks to settle at `at`, in chronological order: the distinct UTC Monday of every published
  * day, restricted to the weeks whose Monday-plus-seven-days has elapsed. A day that was never
  * published contributes no week - `payoutWeek` needs that week's seventh-day snapshot and this
  * scheduler never fabricates one. */
 function closedWeeks(labels, at) {
  const weeks = new Set();
  for (const label of labels) {
   if (typeof label !== 'string' || !DAY_LABEL.test(label)) continue;
   const dayMs = Date.parse(`${label}T00:00:00Z`);
   if (!Number.isFinite(dayMs)) continue;
   const week = weekOf(dayMs, label);
   if (weekStartOf(week) + 7 * domain.DAY <= at) weeks.add(week);
  }
  return [...weeks].sort();
 }

 /* One weekly settlement, through the legacy identity and the Core-owned `weekly` command. `weekly`
  * is idempotent per `(week, actor)` in the domain AND per operation key in Core, so a repeat pays
  * nothing new; `payments` is the week's payment list as the rule returns it. A refusal (a week that
  * is not finished at Core's clock, a truncated aggregate) is reported, never retried into a second
  * effect. */
 async function settleWeek(week, today) {
  const key = weeklyKey(week, today);
  try {
   const response = await issue(key, { type: 'weekly', week });
   const payments = normalizePayments(response);
   return { week, key, ok: true, code: null, payments, count: payments.length, amount: sumAmounts(payments) };
  } catch (error) {
   const code = codeOf(error);
   return { week, key, ok: false, code, payments: [], count: 0, amount: 0 };
  }
 }

 /* The optional match sweep: delegated wholesale to the caller-owned P08 timer service, which owns
  * the revision-bound `timeout`/`expire` identities and the Redis registrations. Absent a service,
  * both keys are null and nothing is attempted. */
 async function sweep(at) {
  if (timers === null) return { timeouts: null, expirations: null };
  const timeouts = await timers.checkTimeouts({ now: at, limit });
  const expirations = await timers.reapDueRooms({ now: at, limit });
  return { timeouts, expirations };
 }

 return Object.freeze({
  /* The frozen principal every command in this module is issued under. */
  principal: MAINTENANCE,

  /* ONE maintenance pass: the day's snapshot, then the closed weeks, then the optional sweep.
  *
  * `snapshot:<today>` is issued unconditionally (the legacy scan issued it on every tick) and is
  * deduplicated by Core, so a second scheduler ticking the same UTC day receives the committed
  * snapshot instead of publishing a second one. Every failure of an individual operation is reported
  * under `errors` with its stable code and a zero-effect rollback rather than aborting the pass: a
  * week that cannot be settled must not stop the day's snapshot, and vice versa. The pass reports
  * `ok: false` when at least one operation failed. */
  async tick() {
   requireOpen();
   if (gate !== null) await gate;
   const at = clock();
   const today = dayOf(at);
   const summary = {
    at, today, snapshot: null, weeks: [], timeouts: null, expirations: null, errors: [], ok: true,
   };
   /* 1. DAILY SNAPSHOT. `snapshotDay` publishes the league week and writes one day_snapshots row per
    * season-qualified, verified, non-suspended, non-held actor - the approved qualification rule,
    * applied by the domain under the Core transaction. */
   const key = snapshotKey(today);
   try {
    const tiers = await issue(key, { type: 'snapshot' });
    summary.snapshot = {
     key, day: today, ok: true,
     actors: tiers && typeof tiers === 'object' ? Object.keys(tiers).length : 0,
     tiers: tiers && typeof tiers === 'object' ? tiers : {},
     result: tiers && typeof tiers === 'object' ? tiers : {},
    };
   } catch (error) {
    const code = codeOf(error);
    summary.snapshot = { key, day: today, ok: false, code, actors: 0, tiers: {}, result: null };
    summary.errors.push({ op: 'snapshot', key, code });
    summary.ok = false;
   }
   /* 2. WEEKLY SETTLEMENTS for every closed week that carries a published snapshot day. */
   for (const week of closedWeeks(await publishedDays(), at)) {
    const settled = await settleWeek(week, today);
    summary.weeks.push(settled);
    if (!settled.ok) { summary.errors.push({ op: 'weekly', key: settled.key, code: settled.code }); summary.ok = false; }
   }
   /* 3. OPTIONAL MATCH SWEEP. */
   const swept = await sweep(at);
   summary.timeouts = swept.timeouts;
   summary.expirations = swept.expirations;
   return summary;
  },

  /* DOWNTIME CATCH-UP. Walk every UTC day from `domain.day(sinceMs)` to `domain.day(untilMs)`
  * inclusive, oldest first, and issue each missing day's `snapshot:<day>` identity; then settle every
  * closed week the (now extended) published set implies, oldest first. A day the durable
  * `season.day_snapshots` table already holds is SKIPPED and reported with `issued: false` and
  * `code: 'ALREADY_SNAPSHOTTED'` - that is how already-completed work is distinguished from missed
  * work. Nothing is fabricated: a past day's command evaluates Core's TODAY (the snapshot date comes
  * from Core's clock), and a week with no published day is never attempted, so no reward is minted
  * for an observation the approved rules never made. */
  async catchUp(input = {}) {
   requireOpen();
   if (gate !== null) await gate;
   const untilMs = input.untilMs === undefined ? clock() : requireInstant(input.untilMs, 'INVALID_UNTIL');
   const sinceMs = requireInstant(input.sinceMs, 'INVALID_SINCE');
   if (sinceMs > untilMs) fail('INVALID_RANGE', { sinceMs, untilMs });
   const from = Date.parse(`${dayOf(sinceMs)}T00:00:00Z`);
   const to = dayOf(untilMs);
   const span = Math.floor((Date.parse(`${to}T00:00:00Z`) - from) / domain.DAY) + 1;
   if (span > MAX_CATCHUP_DAYS) fail('CATCHUP_TOO_LONG', { days: span, max: MAX_CATCHUP_DAYS });

   const completed = await completedSnapshotDays();
   const days = [], snapshots = [], errors = [];
   for (let index = 0; index < span; index += 1) {
    const label = dayOf(from + index * domain.DAY);
    days.push(label);
    const key = snapshotKey(label);
    if (completed.has(label)) {
     snapshots.push({ day: label, key, issued: false, ok: true, code: 'ALREADY_SNAPSHOTTED', actors: null, result: null });
     continue;
    }
    try {
     const tiers = await issue(key, { type: 'snapshot' });
     snapshots.push({
      day: label, key, issued: true, ok: true, code: null,
      actors: tiers && typeof tiers === 'object' ? Object.keys(tiers).length : 0,
      result: tiers && typeof tiers === 'object' ? tiers : {},
     });
     completed.add(label);
    } catch (error) {
     const code = codeOf(error);
     snapshots.push({ day: label, key, issued: true, ok: false, code, actors: null, result: null });
     errors.push({ op: 'snapshot', key, code });
    }
   }
   /* The weeks are derived from the PUBLISHED days RE-READ after the walk - never from the day labels
    * this pass merely attempted. The snapshot date is Core's own `today`, so a past `snapshot:<day>`
    * identity does not imply a `day_snapshots` row for that label; only the durable read may claim a
    * week is owed. `untilMs` is the pass clock: a week is only closed relative to the recovery point,
    * never relative to a fabricated "now". */
   const weeks = [];
   for (const week of closedWeeks(await publishedDays(), untilMs)) {
    const settled = await settleWeek(week, dayOf(untilMs));
    weeks.push(settled);
    if (!settled.ok) errors.push({ op: 'weekly', key: settled.key, code: settled.code });
   }
   return { from: dayOf(sinceMs), to, sinceMs, untilMs, days, snapshots, weeks, errors, ok: errors.length === 0 };
  },

  /* The approved competitive season descriptor for one instant (`Authority`/`seasonStatusOf` use the
  * same pure helper). `nowMs` defaults to the injected clock. Pure and synchronous - it reads no
  * state and remains available after `close()`. */
  getSeason(nowMs) {
   return domain.season(nowMs === undefined ? clock() : requireInstant(nowMs, 'INVALID_SEASON_DATE'));
  },

  /* Stops accepting new work and closes the ONE Core service this factory built (a caller-supplied
  * `coreClient`, the pool, the timer service and the domain stay caller-owned). No timer was ever
  * armed, so nothing else outlives this call. */
  async close() {
   if (closed) return { closed: true };
   closed = true;
   const owned = ownedCore;
   ownedCore = null;
   if (owned !== null) {
    try { await owned.close(); } catch { /* releasing an owned handle is best-effort */ }
   }
   return { closed: true };
  },
 });
}

module.exports = { createMaintenanceScheduler, MAINTENANCE, CORE_ROLE };
