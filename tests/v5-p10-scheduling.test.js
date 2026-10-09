'use strict';
/* tests/v5-p10-scheduling.test.js - V5 P10 task V5-10-04 (extract season/leaderboard/maintenance
 * scheduling).
 *
 * SCOPE. Exercises `packages/services/maintenance-scheduler.js`
 * (`createMaintenanceScheduler({ corePool, coreClient, now, domain })`) against a REAL owned
 * PostgreSQL 16 database built by the REAL checksummed migration chain (`tests/v5-pg-lab.js`). The
 * scheduler issues the frozen legacy competitive identities through the REAL Core transaction
 * boundary (`packages/services/core.js`), so every assertion reads the COMMITTED
 * `economy.command_outcomes` / `season.day_snapshots` / `season.weekly_payouts` / `economy.ledger`
 * rows back through a superuser probe. No SQLite, no mock, no in-memory mirror.
 *
 * WHAT IS PROVEN (the four behaviours the task requires, plus teardown):
 *
 *   1. STABLE UTC PERIOD IDENTITIES. `tick()` issues the daily snapshot under
 *      `snapshot:<domain.day(now())>` and the closed-week settlement under
 *      `weekly:<weekMonday>:<today>` - the exact legacy key grammar - for the trusted
 *      `{actor:'maintenance', scope:'operator'}` principal, and `getSeason(ms)` publishes the frozen
 *      `domain.season(ms)`. A second tick replays the SAME identities: no new outcome row, no second
 *      payout, no second snapshot.
 *   2. TWO CONCURRENT WORKERS -> EXACTLY ONE BUSINESS EFFECT. Two scheduler instances tick at the
 *      same instant for the same day and the same closed week. Core's operation-identity mutex +
 *      `economy.command_outcomes` dedupe them: exactly ONE outcome row per key, ONE payout row, ONE
 *      weekly ledger entry and ONE coin credit; the loser receives the stored response unchanged.
 *   3. DOWNTIME CATCH-UP IN CHRONOLOGICAL ORDER. After a live week and a multi-day outage across a
 *      week boundary, `catchUp` reports the elapsed UTC days ascending, issues `snapshot:<day>` for
 *      each MISSED day (and never re-issues a day already completed while live), and settles the week
 *      whose Monday closure fell inside the outage - from the day snapshots the domain actually
 *      observed before the outage.
 *   4. NO FABRICATED REWARDS. A season-qualified but weekly-ineligible account and an unplaced account
 *      receive ZERO weekly rewards: no `season.weekly_payouts` row, no ledger entry, no coin movement
 *      (the eligible control account is paid from the derived `domain.weeklyReward` oracle, so the
 *      test cannot pass vacuously).
 *   5. TEARDOWN. `lab.installCleanup` drops the owned databases after the suite's own `t.after` closes
 *      each scheduler; `close()` is idempotent and never closes a caller-supplied Core (borrowed).
 *
 * CLOCK. The clock is injected everywhere (`now` into the scheduler, the same instant into the Core
 * the scheduler drives), so a snapshot is written for whichever UTC day Core's own clock names - the
 * scheduler NEVER backdates a snapshot. Nothing here waits on wall time.
 *
 * GATING (the repo convention): needs the owned PostgreSQL lab (`V5_PG_URL`, or `V5_PG_REQUIRED=1` to
 * fail instead of skip). Absent it every test skips. The process exits naturally - no force-exit.
 *
 * Run: node --test --test-concurrency=1 tests/v5-p10-scheduling.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const D = require('../src/domain.js');

/* Close every guarded pool and drop every owned database, AFTER this suite's own `t.after` closes the
 * schedulers. Natural process exit: no forceExit, no explicit process.exit. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

const DAY = lab.DAY;
const MIDDAY = 12 * 3600 * 1000;

/* ONE fixed "now": 2026-10-15T12:00Z. Its own week (2026-10-12) is still OPEN; the previous week
 * (2026-10-05 .. 2026-10-11) is CLOSED and lies wholly inside season 2026-Q4, so the snapshot-based
 * payout can only ever be computed from real observed days - never by rolling a season backwards. */
const START = Date.parse('2026-10-15T12:00:00Z');
const TODAY = '2026-10-15';
const WEEK = '2026-10-05';
const WEEK_START = Date.parse(`${WEEK}T00:00:00Z`);
const WEEK_END = WEEK_START + 7 * DAY;
const WEEK_DAYS = Object.freeze(Array.from({ length: 7 }, (_, i) => D.day(WEEK_START + i * DAY)));
const SEASON = D.season(START).id;
const MAINTENANCE = 'maintenance';

const PAID = 'svc_paid';
const UNQUALIFIED = 'svc_unqual';
const UNPLACED = 'svc_unplaced';
const SEEDS = Object.freeze([
 { actor: PAID, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
 { actor: UNQUALIFIED, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
 { actor: UNPLACED, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
]);
const OPENING = 1000;

/* The weekly activity the fixture writes into `economy.match_history`, and the payout `src/domain.js`
 * authorises for it. Every tier is 'gold' because `basicTier(1500)` is gold, which is also what
 * `Authority.snapshotDay()` persists for a 1500-rated qualified account. The expected amount is DERIVED
 * from the frozen pure oracle - never re-typed from the implementation. */
const PAID_ACTIVITY = Object.freeze({
 dailyTiers: Object.freeze(['gold', 'gold', 'gold', 'gold', 'gold', 'gold', 'gold']),
 endTier: 'gold', games: 5, queueGames: 3, uniqueOpponents: 3, activeDays: 4,
});
const REWARD_ORACLE = D.weeklyReward(PAID_ACTIVITY);
const PAID_AMOUNT = REWARD_ORACLE.amount;
const OUTCOME_KEY = '"key" = to_json($2::text)::text';

/* The scheduler module is loaded lazily, so a checkout without the P10 module skips (rather than
 * throws at require time) when the gate is unset. */
let schedulerFactory = null;
function loadFactory() {
 if (!schedulerFactory) {
  const mod = require('../packages/services/maintenance-scheduler.js');
  assert.equal(typeof mod.createMaintenanceScheduler, 'function',
   'packages/services/maintenance-scheduler.js must export createMaintenanceScheduler');
  schedulerFactory = mod.createMaintenanceScheduler;
 }
 return schedulerFactory;
}

/* Every entry point the suite drives must exist and be a function before a gated case may run: an
 * absent method is a hard failure on a gated checkout, never a silently passing skip. */
const METHODS = Object.freeze(['tick', 'catchUp', 'getSeason', 'close']);
function requireMethods(service) {
 for (const name of METHODS) {
  assert.equal(typeof service[name], 'function', `the maintenance scheduler must expose ${name}()`);
 }
 return service;
}

/* ---------------------------------------------------------------- lab plumbing */

function makeClock(start) {
 let value = start;
 const now = () => value;
 now.set = (next) => { value = next; return value; };
 now.advance = (ms) => { value += ms; return value; };
 return now;
}

async function exec(database, text, params = []) {
 const client = await lab.adminClient(database);
 try { return (await client.query(text, params)).rows; } finally { await client.end(); }
}
const one = async (database, text, params) => (await exec(database, text, params))[0] ?? null;
const count = async (database, text, params) => Number((await one(database, `SELECT count(*)::int AS n FROM (${text}) s`, params))?.n ?? 0);
const outcomeCount = (database, key) => count(database,
 'SELECT 1 FROM economy.command_outcomes WHERE actor_id = $1 AND ' + OUTCOME_KEY, [MAINTENANCE, key]);
const outcomeResponse = (database, key) => one(database,
 'SELECT response FROM economy.command_outcomes WHERE actor_id = $1 AND ' + OUTCOME_KEY, [MAINTENANCE, key])
 .then((row) => (row === null ? null : row.response));
const payouts = (database) => exec(database,
 'SELECT payout_id, actor_id, amount::text AS amount, tier, days FROM season.weekly_payouts'
 + ' WHERE week = $1::date ORDER BY payout_id', [WEEK]);
const snapshotDays = (database, actor) => exec(database,
 "SELECT to_char(day, 'YYYY-MM-DD') AS day, tier FROM season.day_snapshots WHERE actor_id = $1"
 + ' AND day BETWEEN $2::date AND $3::date ORDER BY day', [actor, WEEK_DAYS[0], WEEK_DAYS[6]]);
const coinsOf = (database, actor) => one(database, 'SELECT coins::text AS coins FROM economy.wallets WHERE actor_id = $1', [actor])
 .then((row) => (row === null ? null : Number(row.coins)));
const weeklyLedger = (database, actor) => exec(database,
 'SELECT entry_id, amount::text AS amount FROM economy.ledger WHERE actor_id = $1 AND entry_id = $2',
 [actor, `weekly:${WEEK}:${actor}`]);

/* One owned database with its guarded pool set and a mutable clock shared by the scheduler and the
 * Core service it drives. `mk()` builds a fresh scheduler + its own Core over the same pool (two
 * workers = two processes over one durable authority). `t.after` closes each; the pool and the
 * databases belong to the lab. */
let dbSeq = 0;
async function open(t, seeds = SEEDS) {
 if (!(await lab.boot(t))) return null;
 const create = loadFactory();
 const database = await lab.createDatabase(`p10s${dbSeq++}`);
 if (seeds.length) await lab.seedActors(database, seeds);
 const pools = lab.poolsFor(database);
 const clock = makeClock(START);
 const mk = async () => {
  const core = await lab.coreFor(database, { clock });
  const scheduler = requireMethods(create({ corePool: pools.core, coreClient: core, now: clock, domain: D }));
  t.after(async () => {
   try { await scheduler.close(); } catch { /* service-owned teardown */ }
   try { core.close(); } catch { /* best effort */ }
  });
  return { core, scheduler };
 };
 return { database, pools, clock, mk };
}

/* ---------------------------------------------------------------- fixtures */

/* Season placement state. Every closed-week day is inside 2026-Q4, so the season id is stable across
 * the whole fixture and `Authority._season` never rolls mid-week. */
async function seedSeason(database, actor, seasonId = SEASON) {
 await exec(database,
  'INSERT INTO economy.season_state (actor_id, season_id, started_at, games, queue_games, opponents,'
  + ' wins, losses, draws, peak_rating, last_rated_at, qualified_at)'
  + ' VALUES ($1, $2, $3, 6, 3, ARRAY[$4, $5, $6], 4, 2, 0, 1560, $3, $3)'
  + ' ON CONFLICT (actor_id) DO NOTHING',
  [actor, seasonId, new Date(START - 10 * DAY).toISOString(), 'svc_opp1', 'svc_opp2', 'svc_opp3']);
}

/* Real rated activity INSIDE the closed week. `rows` qualifying rows give the payout its games,
 * queue games, unique opponents and active days; a single row can never clear the weekly thresholds. */
const ACTIVITY_ROWS = Object.freeze([
 { day: 0, queue: true, opponent: 'svc_opp1' },
 { day: 2, queue: true, opponent: 'svc_opp2' },
 { day: 4, queue: true, opponent: 'svc_opp3' },
 { day: 6, queue: false, opponent: 'svc_opp1' },
 { day: 6, queue: false, opponent: 'svc_opp2' },
]);
async function seedActivity(database, actor, rows = ACTIVITY_ROWS) {
 for (let i = 0; i < rows.length; i += 1) {
  const row = rows[i];
  await exec(database,
   'INSERT INTO economy.match_history (actor_id, seq, match_id, at, opponent, mode, queue, symbol, rated,'
   + ' qualified, activity_qualified, result, reason, active_seconds, rating_delta, casual_delta)'
   + " VALUES ($1, $2, $3, $4, $5, 'ranked', $6, 'X', true, true, true, 'win', 'complete', 120, 10.5, 0)",
   [actor, i, `hist:${actor}:${i}`, new Date(WEEK_START + row.day * DAY + MIDDAY).toISOString(), row.opponent, row.queue]);
 }
}

/* Run the scheduler once per UTC day of the closed week with Core's clock set to that day, so the
 * durable `season.day_snapshots` rows carry the real dates the payout must be computed from. */
async function tickClosedWeek({ scheduler }, clock) {
 const out = [];
 for (let i = 0; i < 7; i += 1) {
  clock.set(WEEK_START + i * DAY + MIDDAY);
  out.push(await scheduler.tick());
 }
 return out;
}

/* A scheduler summary's snapshot tiers object (`tiers` on the snapshot step). */
function snapshotTiers(summary) {
 const value = summary?.snapshot?.tiers ?? summary?.snapshot?.result;
 return typeof value === 'string' ? JSON.parse(value) : (value || {});
}

/* ---------------------------------------------------------------- 1. identities */

test('stable UTC period identities: snapshot:<day> and weekly:<week>:<today>', { skip: GATE }, async (t) => {
 const h = await open(t, [SEEDS[0]]);
 const { scheduler, core } = await h.mk();
 await seedSeason(h.database, PAID);
 await seedActivity(h.database, PAID);

 /* The maintenance principal must be the frozen operator-scoped identity. */
 assert.deepEqual(scheduler.principal, { actor: 'maintenance', scope: 'operator' });

 /* The oracle must authorise a real payout, or every payout assertion below would be vacuous. */
 assert.equal(REWARD_ORACLE.eligible, true, 'the fixture activity must clear the frozen weekly thresholds');
 assert.ok(PAID_AMOUNT > 0, 'the frozen weekly reward for the fixture must be a positive amount');
 /* A live week: each daily tick snapshots the UTC day Core's clock names, never a backdated one. */
 const weekTicks = await tickClosedWeek({ scheduler }, h.clock);
 for (let i = 0; i < 7; i += 1) {
  const day = WEEK_DAYS[i];
  assert.equal(weekTicks[i].today, day, 'a daily tick snapshots the UTC day the injected clock names');
  assert.equal(weekTicks[i].snapshot.key, `snapshot:${day}`, 'the daily snapshot identity is snapshot:<YYYY-MM-DD>');
  assert.notEqual(weekTicks[i].snapshot.ok, false, `the live snapshot for ${day} must succeed`);
 }
 const observed = await snapshotDays(h.database, PAID);
 assert.deepEqual(observed.map((r) => r.day), WEEK_DAYS, 'all seven observed days are durably snapshotted');
 assert.ok(observed.every((r) => r.tier === 'gold'), 'each observed day snapshots the real tier');
 assert.deepEqual((await payouts(h.database)), [], 'no payout exists before the week has closed');

 /* Now: the closed week settles and today is snapshotted. */
 h.clock.set(START);
 const first = await scheduler.tick();
 assert.equal(first.at, START, 'the summary reports the instant it ran at');
 assert.equal(first.today, TODAY, 'the summary reports the UTC day it snapshotted');
 assert.equal(first.snapshot.key, `snapshot:${TODAY}`, 'the daily identity is snapshot:<today>');
 assert.match(first.snapshot.key, /^snapshot:\d{4}-\d{2}-\d{2}$/, 'the daily identity is a stable UTC day key');
 assert.notEqual(first.snapshot.ok, false, 'the daily snapshot must succeed');
 assert.equal(snapshotTiers(first)[PAID], 'gold', 'the committed snapshot carries the real tier map');

 const closed = first.weeks.find((w) => w.week === WEEK);
 assert.ok(closed, 'the closed week is reported');
 assert.match(closed.key, /^weekly:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/, 'the weekly identity is weekly:<week>:<today>');
 assert.equal(closed.key, `weekly:${WEEK}:${TODAY}`, 'the weekly identity names the week Monday and today');
 assert.equal(first.weeks.some((w) => w.week === D.week(START)), false, 'the still-open week is never settled');

 /* Durable truth for both identities and the payout. */
 assert.equal(await outcomeCount(h.database, `snapshot:${TODAY}`), 1, 'exactly one outcome for the daily identity');
 assert.equal(await outcomeCount(h.database, closed.key), 1, 'exactly one outcome for the weekly identity');
 const rows = await payouts(h.database);
 assert.equal(rows.length, 1, 'exactly one payout row for the closed week');
 assert.equal(rows[0].actor_id, PAID, 'the eligible account is paid');
 assert.equal(Number(rows[0].amount), PAID_AMOUNT, 'the payout equals the derived oracle amount');
 assert.equal(await coinsOf(h.database, PAID), OPENING + PAID_AMOUNT, 'the credit lands exactly once');

 /* A second tick replays the SAME stable identities and changes no business fact. */
 const second = await scheduler.tick();
 assert.equal(second.snapshot.key, first.snapshot.key, 'the second tick reuses the same daily identity');
 assert.deepEqual(snapshotTiers(second), snapshotTiers(first), 'the replay returns the stored snapshot');
 assert.equal(await outcomeCount(h.database, `snapshot:${TODAY}`), 1, 'the replay adds no outcome row');
 assert.equal(await outcomeCount(h.database, closed.key), 1, 'the replay adds no weekly outcome row');
 assert.equal((await payouts(h.database)).length, 1, 'the replay pays nobody a second time');
 assert.equal(await coinsOf(h.database, PAID), OPENING + PAID_AMOUNT, 'the replay never re-credits');

 /* Season identity is the frozen quarterly rule, in UTC. */
 assert.deepEqual(scheduler.getSeason(), D.season(START), 'getSeason defaults to the injected clock');
 assert.deepEqual(scheduler.getSeason(START + 90 * DAY), D.season(START + 90 * DAY), 'getSeason accepts an explicit instant');
 assert.equal(typeof core.read, 'function', 'the caller-supplied Core is a real service the suite reads back through');
});

/* ---------------------------------------------------------------- 2. concurrency */

test('two concurrent workers produce exactly one business effect per stable key', { skip: GATE }, async (t) => {
 const h = await open(t, [SEEDS[0]]);
 const { scheduler } = await h.mk();
 await seedSeason(h.database, PAID);
 await seedActivity(h.database, PAID);
 await tickClosedWeek({ scheduler }, h.clock);
 assert.deepEqual((await payouts(h.database)), [], 'the week has not closed while it is being observed');

 /* Two independent workers (two Core services over one pool) tick at the SAME instant. */
 h.clock.set(START);
 const w1 = await h.mk();
 const w2 = await h.mk();
 const [a, b] = await Promise.all([w1.scheduler.tick(), w2.scheduler.tick()]);

 const dayKey = `snapshot:${TODAY}`;
 const weekKey = `weekly:${WEEK}:${TODAY}`;
 assert.equal(a.snapshot.key, dayKey);
 assert.equal(b.snapshot.key, dayKey, 'both workers name the same daily identity');
 assert.equal(a.weeks.find((w) => w.week === WEEK).key, weekKey);
 assert.equal(b.weeks.find((w) => w.week === WEEK).key, weekKey, 'both workers name the same weekly identity');
 assert.deepEqual(snapshotTiers(b), snapshotTiers(a), 'the losing worker receives the stored response unchanged');

 assert.equal(await outcomeCount(h.database, dayKey), 1, 'exactly one daily outcome despite two workers');
 assert.equal(await outcomeCount(h.database, weekKey), 1, 'exactly one weekly outcome despite two workers');
 const rows = await payouts(h.database);
 assert.equal(rows.length, 1, 'exactly one payout row despite two workers');
 assert.equal(Number(rows[0].amount), PAID_AMOUNT, 'the single payout equals the derived oracle amount');
 assert.equal(await coinsOf(h.database, PAID), OPENING + PAID_AMOUNT, 'the wallet is credited exactly once');
 assert.equal((await weeklyLedger(h.database, PAID)).length, 1, 'exactly one weekly ledger entry exists');
});

/* ---------------------------------------------------------------- 3. catch-up */

test('downtime catch-up processes elapsed UTC days in order and settles the closed week', { skip: GATE }, async (t) => {
 const h = await open(t, [SEEDS[0]]);
 const { scheduler } = await h.mk();
 await seedSeason(h.database, PAID);
 await seedActivity(h.database, PAID);
 await tickClosedWeek({ scheduler }, h.clock);

 /* The worker dies right after the last live tick (2026-10-11T12:00Z) and comes back at START, so the
  * outage spans three whole days plus the Monday boundary at which 2026-10-05 closes. */
 const downSince = WEEK_END - DAY + MIDDAY; // 2026-10-11T12:00Z
 h.clock.set(START);
 const up = await scheduler.catchUp({ sinceMs: downSince, untilMs: START });

 assert.ok(Array.isArray(up.days) && up.days.length > 0, 'catch-up reports the elapsed UTC days');
 assert.deepEqual([...up.days].sort(), up.days, 'the elapsed days are reported in chronological order');
 assert.equal(new Set(up.days).size, up.days.length, 'no elapsed day is reported twice');
 assert.equal(up.days[up.days.length - 1], TODAY, 'catch-up runs up to the injected instant');
 for (const day of ['2026-10-12', '2026-10-13', '2026-10-14', TODAY]) {
  assert.ok(up.days.includes(day), `the missed day ${day} is covered`);
  const entry = up.snapshots.find((s) => s.day === day);
  assert.ok(entry, `the missed day ${day} is reported as a snapshot step`);
  assert.equal(entry.key, `snapshot:${day}`, 'each catch-up snapshot uses the stable daily identity');
  assert.equal(entry.issued, true, `the missed day ${day} is issued`);
  assert.equal(await outcomeCount(h.database, `snapshot:${day}`), 1, `exactly one outcome exists for ${day}`);
 }
 /* The day already observed while live is NOT re-issued: missed work is distinguished from done work. */
 const already = up.snapshots.find((s) => s.day === '2026-10-11');
 if (already) assert.equal(already.issued, false, 'a day completed while live is never re-issued');
 assert.equal(await outcomeCount(h.database, 'snapshot:2026-10-11'), 1, 'the live day keeps exactly one outcome');

 /* The week whose Monday closure fell inside the outage settles from the observed days. */
 const closed = up.weeks.find((w) => w.week === WEEK);
 assert.ok(closed, 'catch-up settles the week that closed during the outage');
 assert.match(closed.key, /^weekly:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/, 'the catch-up weekly identity is well formed');
 assert.equal(await outcomeCount(h.database, closed.key), 1, 'exactly one outcome for the settled week');
 const rows = await payouts(h.database);
 assert.equal(rows.length, 1, 'exactly one payout row for the settled week');
 assert.equal(rows[0].actor_id, PAID, 'the eligible account is paid once');
 assert.equal(Number(rows[0].amount), PAID_AMOUNT, 'the settled payout equals the derived oracle amount');
 assert.equal(await coinsOf(h.database, PAID), OPENING + PAID_AMOUNT, 'the outage credit lands exactly once');

 /* A second catch-up over the same window fabricates nothing further. */
 const again = await scheduler.catchUp({ sinceMs: downSince, untilMs: START });
 assert.equal((await payouts(h.database)).length, 1, 'a repeated catch-up pays nobody a second time');
 assert.equal(await coinsOf(h.database, PAID), OPENING + PAID_AMOUNT, 'a repeated catch-up re-credits nothing');
 for (const entry of again.snapshots) {
  assert.equal(await outcomeCount(h.database, `snapshot:${entry.day}`), 1, 'a repeated catch-up adds no outcome row');
 }
 /* Both the live-observed day and today (snapshotted in Core) are recorded as ALREADY_SNAPSHOTTED. */
 assert.equal(again.snapshots.find((s) => s.day === '2026-10-11')?.issued, false);
 assert.equal(again.snapshots.find((s) => s.day === TODAY)?.issued, false);
});

/* ---------------------------------------------------------------- 4. no fabrication */

test('unplaced and weekly-ineligible accounts receive zero fabricated rewards', { skip: GATE }, async (t) => {
 const h = await open(t, SEEDS);
 const { scheduler } = await h.mk();
 /* The control account is fully qualified and weekly-active; the second is season-placed but has a
  * single rated game in the week; the third is never placed at all. */
 await seedSeason(h.database, PAID);
 await seedActivity(h.database, PAID);
 await seedSeason(h.database, UNQUALIFIED);
 await seedActivity(h.database, UNQUALIFIED, ACTIVITY_ROWS.slice(0, 1));
 await tickClosedWeek({ scheduler }, h.clock);

 h.clock.set(START);
 await scheduler.tick();

 const rows = await payouts(h.database);
 assert.deepEqual(rows.map((r) => r.actor_id), [PAID], 'only the genuinely eligible account is paid');
 assert.equal(Number(rows[0].amount), PAID_AMOUNT, 'the control payout equals the derived oracle amount');
 assert.equal(await coinsOf(h.database, PAID), OPENING + PAID_AMOUNT, 'the control account is credited once');
 assert.equal((await weeklyLedger(h.database, PAID)).length, 1, 'the control account gets one ledger entry');

 /* The weekly-ineligible but placed account was snapshotted (so it is not merely absent) and still paid 0. */
 assert.equal((await snapshotDays(h.database, UNQUALIFIED)).length, 7, 'the ineligible account was observed but earns nothing');
 assert.equal(await coinsOf(h.database, UNQUALIFIED), OPENING, 'no fabricated reward for an ineligible account');
 assert.equal((await weeklyLedger(h.database, UNQUALIFIED)).length, 0, 'no ledger entry for an ineligible account');
 assert.equal(await outcomeCount(h.database, `weekly:${WEEK}:${UNQUALIFIED}`), 0, 'no per-account weekly identity is minted');

 /* The unplaced account is never snapshotted and receives nothing at all. */
 assert.equal((await snapshotDays(h.database, UNPLACED)).length, 0, 'an unplaced account is never snapshotted');
 assert.equal(await coinsOf(h.database, UNPLACED), OPENING, 'no fabricated reward for an unplaced account');
 assert.equal((await weeklyLedger(h.database, UNPLACED)).length, 0, 'no ledger entry for an unplaced account');
});

/* ---------------------------------------------------------------- 5. teardown */

test('close() is idempotent and never closes the borrowed Core', { skip: GATE }, async (t) => {
 const h = await open(t, []);
 const { scheduler, core } = await h.mk();
 assert.deepEqual(await scheduler.close(), { closed: true });
 assert.deepEqual(await scheduler.close(), { closed: true }, 'close() is idempotent');
 assert.deepEqual(scheduler.getSeason(), D.season(START), 'getSeason remains available after close');
 await assert.rejects(scheduler.tick(), (e) => e.message === 'SCHEDULER_CLOSED', 'tick() refuses after close');
 assert.equal(typeof core.read, 'function', 'the caller-supplied Core survives the scheduler close');
 const state = await core.read();
 assert.ok(state !== null && state !== undefined, 'the borrowed Core still answers a strong read after close');
});
