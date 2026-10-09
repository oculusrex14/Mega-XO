'use strict';
/* tests/v5-p08-timers.test.js - V5 P08 task V5-08-03 durable clocks and scheduled expiry.
 *
 * SCOPE. Exercises `createTimerService` from `packages/services/timers.js` against the REAL owned
 * PostgreSQL 16 lab (`tests/v5-pg-lab.js`) and the REAL loopback Redis ephemera adapter
 * (`packages/services/ephemera.js`). The match itself is committed and settled by the REAL Core
 * service (`packages/services/core.js`) through `match.matches` / `match.participants` /
 * `economy.command_outcomes` / `ops.outbox`, and every expected amount is DERIVED from the frozen
 * policy/quote oracle (`src/domain.js`, `src/authority.js`) - never re-typed.
 *
 * WHAT THE SUITE PROVES (G08: acknowledged moves survive process death and resume from committed
 * state; no reset deadline, no duplicate effect, no split match - for clocks):
 *
 *   1. ABSOLUTE DEADLINE PERSISTENCE. A live match carries ONE absolute epoch-ms deadline in
 *      `match.matches.deadline` equal to the accept instant plus one whole turn, and `core.readMatch`
 *      returns exactly that instant. Half a turn later a reconnect, a re-read and a NEW Core service
 *      over the same database all report the SAME absolute deadline: the remaining time only shrinks,
 *      and neither a reconnect nor a restart ever grants a fresh 30 s turn. The scheduled
 *      registration (and the real Redis due member, when one exists) names that absolute instant.
 *   2. PREMATURE TIMEOUT. Before the deadline the durable scan finds nothing due and a direct
 *      revision-bound `timeout` claim is `NOT_TIMED_OUT`; the whole row is byte-identical afterwards
 *      (no state_json/revision/escrow/receipt change, no outcome row, no outbox event).
 *   3. DUE SETTLEMENT (+ REDIS LOSS). Past the deadline `checkTimeouts` settles the match through the
 *      deterministic `timeout:<matchId>:<revision>` operation identity: the winner is the opponent of
 *      the player on turn, the receipt is durable, exactly ONE outcome row and ONE outbox event exist,
 *      the escrow is released and the frozen payout lands. Wiping the whole advisory Redis namespace
 *      first - every due key included, whichever family the service chose - proves PostgreSQL, not
 *      Redis, is what decides the timeout, so a Redis loss cannot lose a turn. A reconnect AFTER the
 *      settlement observes the timed-out state immediately from committed truth.
 *   4. MOVE-VS-TIMEOUT SERIALIZATION. (4a) A move that commits just inside the deadline advances the
 *      revision and resets the deadline; the stale `timeout:<matchId>:0` claim for the previous
 *      revision is then rejected and writes nothing, the new revision stands unsettled and a later
 *      claim for the new revision is still premature. (4b) A TRUE CONCURRENT race - one Core whose
 *      clock sits on the boundary committing the move while the timeout worker's clock is already due
 *      - commits exactly one of the two business effects under the aggregate lock: never both, never
 *      neither, never a split match.
 *   5. IDEMPOTENT REPLAY. Re-sending the identical revision-bound timeout key returns the STORED
 *      settlement receipt without a second payout, outcome row, outbox event or receipt rewrite.
 *   6. OFFER EXPIRY. `reapDueRooms` expires an OFFERED match that is past its frozen policy offer
 *      window through the `expire` command - a real recorded outbox change - and a second sweep is a
 *      no-op.
 *
 * CLOCK CONVENTION. Every service takes an injected `now` returning an integer epoch-ms instant, so
 * the suite is deterministic and waits on NO wall time for any clock-dependent correctness. The lab's
 * frozen `CLOCK` is the accept instant; each test owns its own mutable clock and moves it by exact
 * millisecond deltas; the ONE bounded wall-time poll (`until`) only awaits the adapter's own
 * fire-and-forget Redis write, never a turn. A timer service is constructed with
 * `clockToleranceMs: 0`, so the clock convention under test is the raw comparison `now >= deadline`
 * that `src/authority.js` already implements.
 *
 * GATING (the repo convention): these need BOTH the owned loopback Redis (`REDIS_URL`, or
 * `V5_REDIS_REQUIRED=1` to fail instead of skip) and the owned PostgreSQL lab (`V5_PG_URL`, or
 * `V5_PG_REQUIRED=1` to fail instead of skip). Absent either, the suite skips. Teardown is the lab's
 * `installCleanup` (guarded pools closed, owned databases dropped) plus a per-suite wipe of this
 * suite's OWN ephemera `keyVersion` namespace - never another environment's, never a sibling's.
 * Services close naturally; there is no force-exit.
 *
 *   env V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
 *       REDIS_URL=redis://127.0.0.1:50710 \
 *       node --test --test-concurrency=1 tests/v5-p08-timers.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const D = require('../src/domain.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_REDIS && HAVE_PG ? false : (!HAVE_REDIS ? 'no REDIS_URL' : 'no V5_PG_URL');

const KEY_VERSION = 'tmp08';
const TURN_SECONDS = 30;
const TURN_MS = TURN_SECONDS * 1000;
const START = lab.CLOCK;
/* The trusted worker principal the contract names for the scheduled timeout. */
const WORKER = Object.freeze({ actor: 'timeout-worker', scope: 'matchmaker' });
/* One disjoint actor pair per scenario, so no two tests contend for the same rated-pair limits. */
const FIXTURES = Object.freeze({
  reconnect: ['svc_p08t01', 'svc_p08t02'],
  premature: ['svc_p08t03', 'svc_p08t04'],
  due: ['svc_p08t05', 'svc_p08t06'],
  race: ['svc_p08t07', 'svc_p08t08'],
  raceConcurrent: ['svc_p08t09', 'svc_p08t10'],
  replay: ['svc_p08t11', 'svc_p08t12'],
  reap: ['svc_p08t13', 'svc_p08t14'],
});
const SEEDS = Object.values(FIXTURES).flat()
  .map((actor) => ({ actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' }));

/* A mutable injected clock: an integer epoch-ms instant every service reads through `now`. */
function makeClock(start = START) {
  let value = start;
  const now = () => value;
  now.set = (next) => { value = next; };
  return now;
}

const ephemeraOptions = () => ({
  url: REDIS_URL,
  environment: 'test',
  keyVersion: KEY_VERSION,
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* A bounded poll for a fire-and-forget side effect (the advisory Redis due member). */
const until = async (probe, { timeoutMs = 4000, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
};

/* --------------------------------------------------------------- shared lab -- */

/* `packages/services/timers.js` is loaded lazily so a checkout without the P08 module skips (rather
 * than throws at require time) when the gates are unset. */
let timerFactory = null;
const loadTimerFactory = () => {
  if (!timerFactory) {
    const mod = require('../packages/services/timers.js');
    assert.equal(typeof mod.createTimerService, 'function', 'packages/services/timers.js must export createTimerService');
    timerFactory = mod.createTimerService;
  }
  return timerFactory;
};

/* One owned database / pool set / ephemera adapter for the whole file: every test is an isolated
 * clock scenario against the SAME durable authority, exactly as a running deployment is. */
let sessionPromise = null;
async function session(t) {
  if (!(await lab.boot(t))) return null;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const database = await lab.createDatabase('p08timer');
      await lab.seedActors(database, SEEDS);
      const pools = lab.poolsFor(database);
      const ephemera = await createEphemeraService(ephemeraOptions());
      assert.equal(await ephemera.healthy(), true, 'the owned Redis must answer PING');
      return { database, pools, ephemera };
    })();
  }
  return sessionPromise;
}

/* A fresh Core service over the shared pool with the caller's clock: a NEW Core is exactly a
 * restarted process as far as durable truth is concerned. */
async function coreFor(h, clock, t) {
  const core = await lab.coreFor(h.database, { clock });
  t.after(() => { try { core.close(); } catch { /* service-owned teardown */ } });
  return core;
}

/* The timer service under test, wired to the caller's Core and clock. */
async function timersFor(h, { core, clock }, t) {
  const timers = await loadTimerFactory()(
    { pool: h.pools.core, core, ephemera: h.ephemera, now: clock, clockToleranceMs: 0 });
  assert.equal(typeof timers.scheduleTimeout, 'function', 'the timer service exposes scheduleTimeout');
  assert.equal(typeof timers.checkTimeouts, 'function', 'the timer service exposes checkTimeouts');
  assert.equal(typeof timers.reapDueRooms, 'function', 'the timer service exposes reapDueRooms');
  t.after(() => { try { if (typeof timers.close === 'function') timers.close(); } catch { /* best effort */ } });
  return timers;
}

/* The revision-bound operation identity for the scheduled timeout, derived here exactly as the
 * contract states it - never copied from a fixture. */
const timeoutKey = (matchId, revision) => `timeout:${matchId}:${revision}`;

/* The opponent of whoever is on turn right now: the winner of a timeout settlement. */
const opponentOfTurn = (view) => view.symbols[view.state.turn === 'X' ? 'O' : 'X'];

/* Commit a real PLAYING match through Core with the frozen 30 s ranked clock. */
async function createPlaying(h, core, matchId, playerA, playerB) {
  const offer = await core.run({ actor: playerA, scope: 'player' }, `offer:${matchId}`, {
    type: 'offer', id: matchId, opponent: playerB, terms: { kind: 'leaderboard', amount: 40 },
  });
  assert.equal(offer.status, 'OFFERED', 'the fixture offer is committed OFFERED');
  const view = await core.run({ actor: playerB, scope: 'player' }, `accept:${matchId}`, {
    type: 'accept', id: matchId, termsHash: offer.termsHash,
  });
  assert.equal(view.status, 'PLAYING', 'the fixture match is committed PLAYING');
  assert.equal(view.terms.turnSeconds, TURN_SECONDS, 'the fixture match runs the frozen 30 s turn');
  assert.equal(view.revision, 0, 'the fixture match starts at revision 0');
  assert.ok(['coins', 'crowns'].includes(view.quote.currency), 'the match settles in one of the two frozen currencies');
  assert.ok(Number.isSafeInteger(view.deadline), 'a playing match carries an absolute epoch-ms deadline');
  assert.equal(view.deadline - view.started, TURN_MS, 'the first deadline is the accept instant plus one whole turn');
  return view;
}

/* ------------------------------------------------------------- durable probes -- */

async function rowsOf(h, text, params = []) {
  const client = await lab.adminClient(h.database);
  try { return (await client.query(text, params)).rows; } finally { await client.end(); }
}
const scalar = async (h, text, params = []) => {
  const rows = await rowsOf(h, text, params);
  return rows[0] ? Object.values(rows[0])[0] : null;
};
const int = async (h, text, params = []) => Number(await scalar(h, text, params));
/* The WHOLE durable row as canonical JSON text: one comparison covers status, revision, state_json,
 * escrow, settled, deadline, receipt_* and every side column a rollback must leave untouched. */
const durableRow = (h, matchId) => scalar(h, 'SELECT to_jsonb(m)::text FROM match.matches m WHERE match_id = $1', [matchId]);
const deadlineOf = (h, matchId) => scalar(h,
  'SELECT (extract(epoch from deadline) * 1000)::bigint::text FROM match.matches WHERE match_id = $1', [matchId])
  .then((value) => (value === null ? null : Number(value)));
const expiresOf = (h, matchId) => scalar(h,
  'SELECT (extract(epoch from expires_at) * 1000)::bigint::text FROM match.matches WHERE match_id = $1', [matchId])
  .then((value) => (value === null ? null : Number(value)));
const statusOf = (h, matchId) => scalar(h, 'SELECT status FROM match.matches WHERE match_id = $1', [matchId]);
const receiptDoc = (h, matchId) => scalar(h,
  'SELECT receipt_json::text FROM match.matches WHERE match_id = $1', [matchId]);
/* A direct offer settles in CROWNS, a queue match in COINS, so every balance probe takes the match's
 * own settlement currency: the column names come from this fixed map, never from input. */
const walletColumn = (currency) => (currency === 'crowns' ? 'crowns' : 'coins');
const reservedColumn = (currency) => (currency === 'crowns' ? 'reserved_crowns' : 'reserved_coins');
async function wallets(h, actors, column) {
  const rows = await rowsOf(h, `SELECT actor_id, ${walletColumn(column)} AS balance FROM economy.wallets WHERE actor_id = ANY($1::text[])`, [actors]);
  return Object.fromEntries(rows.map((row) => [row.actor_id, Number(row.balance)]));
}
const heldEscrow = (h, actors, currency) => int(h,
  `SELECT COALESCE(sum(${reservedColumn(currency)}), 0)::int FROM economy.wallets WHERE actor_id = ANY($1::text[])`, [actors]);
/* `economy.command_outcomes."key"` holds the CANONICAL JSON string of the operation key, so the
 * lookup compares against `to_json($2::text)::text` - the same encoding the outcome repository uses. */
const OUTCOME_KEY = '"key" = to_json($2::text)::text';
const outcomeCount = (h, actor, key) => int(h,
  `SELECT count(*)::int FROM economy.command_outcomes WHERE actor_id = $1 AND ${OUTCOME_KEY}`, [actor, key]);
const outboxCount = (h, id) => int(h, 'SELECT count(*)::int FROM ops.outbox WHERE outbox_id = $1', [id]);
const outboxId = (actor, key) => `core.command:${actor}:${key}`;

/* The REAL due members this suite's adapter holds for one match, read through the borrowed client.
 * The key FAMILY is an implementation detail (the durable deadline is not), so the scan is tolerant
 * about the key and strict about the score. */
async function dueMembers(ephemera, matchId) {
  const keys = await ephemera.client.keys(`mx:test:${KEY_VERSION}:*`);
  const hits = [];
  for (const key of keys) {
    if ((await ephemera.client.type(key)) !== 'zset') continue;
    for (const entry of await ephemera.client.zRangeWithScores(key, 0, -1)) {
      if (String(entry.value).includes(matchId)) hits.push({ key, member: String(entry.value), score: Number(entry.score) });
    }
  }
  return hits;
}
/* Wipe EVERY key of this suite's own namespace, whichever family the timer service chose. Nothing
 * in this file needs Redis for correctness, so this is the strongest Redis-loss proof available: the
 * deadline must still be found and fired from PostgreSQL alone. */
const wipeSuiteKeys = async (ephemera) => {
  const result = await ephemera.wipeNamespace();
  assert.equal(result.available, true, 'the owned Redis answered the namespace wipe');
  assert.ok(result.deleted >= 0, 'the wipe reports a bounded count');
  return result.deleted;
};

/* `core.run` rejects with a business code; the timeout paths legitimately race, so a claim may be
 * refused either as premature (NOT_TIMED_OUT) or because the aggregate already moved (MATCH_CLOSED).
 * Both are complete rollbacks and the contract allows either. */
async function rejectsWith(promise, codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `expected ${list.join('|')} but the call resolved`);
  assert.ok(list.includes(caught.message), `expected ${list.join('|')}, observed ${caught.message}`);
  return caught.message;
}
const TIMEOUT_REFUSALS = ['NOT_TIMED_OUT', 'MATCH_CLOSED'];

/* One durable authority carries the matches of every scenario in this file, so a sweep at a shared
 * absolute deadline may legitimately settle a SIBLING test's still-live match as well. Every sweep
 * assertion is therefore scoped to THIS test's match: the contract under test is per-match, and
 * asserting global emptiness would be asserting an accident of test ordering. */
const settledFor = (result, matchId) => (result.settled || []).filter((entry) => entry.matchId === matchId);
const entryFor = (result, matchId) => settledFor(result, matchId)[0];
const errorsFor = (result, matchId) => (result.errors || []).filter((error) => (error.matchId ?? error.match_id) === matchId);
/* `reapDueRooms` reports its own `expired` list (it is not a settlement), so the expiry sweep is
 * asserted on that list - a `settled`-based check would be vacuously empty. */
const expiredFor = (result, matchId) => (result.expired || []).filter((entry) => entry.matchId === matchId);

/* ======================================== 1. absolute deadline persistence ===== */

test('V5-08-03 timers: an absolute deadline survives reconnect and restart without granting a fresh turn', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const [playerA, playerB] = FIXTURES.reconnect;
  const matchId = 'match:p08t-deadline';
  const clock = makeClock();
  const core = await coreFor(h, clock, t);
  const timers = await timersFor(h, { core, clock }, t);

  const created = await createPlaying(h, core, matchId, playerA, playerB);
  const deadline = created.deadline;
  assert.equal(await deadlineOf(h, matchId), deadline, 'the durable column holds exactly the DTO deadline');

  /* Time passes: 12 s of the 30 s turn elapse. The deadline must NOT move. */
  const elapsed = 12000;
  clock.set(START + elapsed);

  const reconnected = await core.readMatch(playerA, matchId);
  assert.equal(reconnected.deadline, deadline, 'a reconnect re-reads the ORIGINAL absolute deadline');
  assert.equal(await deadlineOf(h, matchId), deadline, 'reading the match never rewrites the durable deadline');
  assert.equal(reconnected.deadline - clock(), TURN_MS - elapsed, 'remaining time only SHRINKS; no fresh turn was granted');

  /* A simulated restart: a brand-new Core service over the same committed database. */
  const restarted = await coreFor(h, clock, t);
  const afterRestart = await restarted.readMatch(playerB, matchId);
  assert.deepEqual(afterRestart, reconnected, 'a restarted Core loads the identical committed match document');
  assert.equal(afterRestart.deadline - clock(), TURN_MS - elapsed, 'a restart grants no fresh turn duration');

  /* The scheduled registration names the SAME absolute instant, and the real Redis due member (when
   * the adapter holds one) scores it - never a rebased "now + 30 s". */
  const registered = await timers.scheduleTimeout(matchId, afterRestart.revision, afterRestart.deadline);
  assert.ok(registered && typeof registered === 'object', 'scheduleTimeout returns a registration');
  const flag = registered.scheduled ?? registered.registered;
  if (flag !== undefined) assert.equal(flag, true, 'the registration reports itself scheduled against a live Redis');
  const reported = registered.deadlineMs ?? registered.deadline;
  if (reported !== undefined) assert.equal(reported, deadline, 'the registration names the absolute deadline');
  const members = await until(async () => {
    const hits = await dueMembers(h.ephemera, matchId);
    return hits.length ? hits : null;
  });
  assert.ok(members, 'the scheduled timeout is a real Redis due member');
  for (const member of members) assert.equal(member.score, deadline, `the due member in ${member.key} scores the ABSOLUTE deadline`);

  /* The turn still expires at the ORIGINAL instant and the registration did not push the match out
   * of due-ness: the durable deadline is untouched and the match is still live. */
  const stillDue = await timers.checkTimeouts({ now: clock, limit: 16 });
  assert.deepEqual(settledFor(stillDue, matchId), [], 'twelve seconds in, the match is not yet due');
  assert.equal(await deadlineOf(h, matchId), deadline, 'the sweep never rewrote the absolute deadline');
  assert.equal(await statusOf(h, matchId), 'PLAYING', 'and it is still the committed, live match');
});

/* =========================================== 2. premature timeout ============= */

test('V5-08-03 timers: a timeout before the deadline is NOT_TIMED_OUT and rolls back completely', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const [playerA, playerB] = FIXTURES.premature;
  const matchId = 'match:p08t-premature';
  const clock = makeClock();
  const core = await coreFor(h, clock, t);
  const timers = await timersFor(h, { core, clock }, t);

  const created = await createPlaying(h, core, matchId, playerA, playerB);
  const key = timeoutKey(matchId, created.revision);
  await timers.scheduleTimeout(matchId, created.revision, created.deadline);
  const before = await durableRow(h, matchId);

  /* The durable scan is deadline-driven: nothing is due while the clock is still before it. */
  const scan = await timers.checkTimeouts({ now: clock, limit: 16 });
  assert.deepEqual(settledFor(scan, matchId), [], 'no match is due before its absolute deadline');
  assert.deepEqual(errorsFor(scan, matchId), [], 'and the scan reported no error for this match');

  /* The direct revision-bound claim is refused and unwinds the whole transaction. */
  await rejectsWith(core.run(WORKER, key, { type: 'timeout', id: matchId }), 'NOT_TIMED_OUT');

  assert.equal(await durableRow(h, matchId), before, 'the refused timeout left the committed row byte-identical');
  assert.equal(await statusOf(h, matchId), 'PLAYING', 'the match is still live');
  assert.equal(await deadlineOf(h, matchId), created.deadline, 'the deadline was not reset by the refusal');
  assert.equal(await outcomeCount(h, WORKER.actor, key), 0, 'a refused timeout stores NO outcome row');
  assert.equal(await outboxCount(h, outboxId(WORKER.actor, key)), 0, 'a refused timeout enqueues NO outbox event');

  /* A second scan at the same instant is still clean. */
  assert.deepEqual(settledFor(await timers.checkTimeouts({ now: clock, limit: 16 }), matchId), [],
    'the refusal changed nothing to be due');
});

/* =============================================== 3. due settlement ============ */

test('V5-08-03 timers: a due timeout settles under the revision-bound key, pays the opponent and survives Redis loss', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const [playerA, playerB] = FIXTURES.due;
  const matchId = 'match:p08t-due';
  const clock = makeClock();
  const core = await coreFor(h, clock, t);
  const timers = await timersFor(h, { core, clock }, t);

  const created = await createPlaying(h, core, matchId, playerA, playerB);
  await timers.scheduleTimeout(matchId, created.revision, created.deadline);
  const winner = opponentOfTurn(created);
  const loser = created.symbols[created.state.turn];
  const key = timeoutKey(matchId, created.revision);
  const currency = created.quote.currency;
  const balancesBefore = await wallets(h, [playerA, playerB], currency);
  const escrowBefore = await heldEscrow(h, [playerA, playerB], currency);

  /* REDIS LOSS: the whole advisory namespace is wiped (every due key included, whichever family the
   * service chose). PostgreSQL is the durable authority, so the deadline must still be found. */
  await wipeSuiteKeys(h.ephemera);
  assert.equal((await dueMembers(h.ephemera, matchId)).length, 0, 'the advisory due members were dropped');

  clock.set(created.deadline);
  const result = await timers.checkTimeouts({ now: clock, limit: 16 });
  assert.deepEqual(errorsFor(result, matchId), [], 'the due scan reported no error for this match');
  const entry = entryFor(result, matchId);
  assert.ok(entry, 'this due match settled');
  assert.equal(entry.matchId, matchId, 'the settled entry names the match');
  assert.equal(entry.revision, created.revision, 'the settled entry names the revision the deadline belonged to');
  assert.equal(entry.reason, 'timeout', 'the settlement reason is the scheduled timeout');
  assert.equal(entry.winner, winner, 'the winner is the opponent of the player who was on turn');

  /* DURABLE TRUTH. The settlement is one committed effect under the deterministic identity. */
  const committed = await core.readMatch(playerA, matchId);
  assert.equal(committed.status, 'FINISHED', 'the match is terminal');
  assert.equal(committed.settled, true, 'the match is settled');
  assert.equal(committed.receipt.reason, 'timeout', 'the durable receipt names the timeout reason');
  assert.equal(committed.receipt.winner, winner, 'the durable receipt names the opponent as winner');
  assert.equal(committed.receipt.payout, committed.quote.payout, 'the payout is the frozen quote payout');
  assert.equal(committed.receipt.burn, committed.quote.burn, 'the burn is the frozen quote burn');
  assert.equal(await outcomeCount(h, WORKER.actor, key), 1, `the settlement stored exactly one outcome under ${key}`);
  assert.equal(await outboxCount(h, outboxId(WORKER.actor, key)), 1, 'the settlement enqueued exactly one durable outbox event');

  /* The escrow is released and the frozen payout landed. On a timed-out (non-draw) settlement
   * `_release` only CLEARS each seat's reservation - the contribution was already taken from
   * spendable at accept and is not restored - so the winner's balance moves by exactly the frozen
   * receipt payout and the loser's by nothing at all. Both amounts come from the committed
   * receipt/quote, never re-typed. */
  const balancesAfter = await wallets(h, [playerA, playerB], currency);
  assert.equal(balancesAfter[winner] - balancesBefore[winner], committed.receipt.payout,
    'the winner received exactly the frozen payout and nothing else');
  assert.equal(balancesAfter[loser] - balancesBefore[loser], 0,
    'the loser received no refund: a timeout is not a draw');
  assert.equal(await heldEscrow(h, [playerA, playerB], currency), 0, 'the entire reservation was released');
  assert.equal(escrowBefore > 0, true, 'the fixture match really held an escrow before settlement');

  /* A terminal match is never due again. */
  assert.deepEqual(settledFor(await timers.checkTimeouts({ now: clock, limit: 16 }), matchId), [],
    'a settled match is never re-scanned as due');

  /* RECONNECT AFTER EXPIRY observes the timed-out state immediately, from committed truth: a fresh
   * Core process reads the terminal receipt with no fresh turn and no restart-void. */
  assert.equal(await deadlineOf(h, matchId), created.deadline, 'settlement preserves the absolute deadline it fired on');
  const reconnected = await coreFor(h, clock, t);
  const observed = await reconnected.readMatch(playerB, matchId);
  assert.equal(observed.status, 'FINISHED', 'a reconnected process immediately observes the timed-out state');
  assert.equal(observed.settled, true, 'the reconnected process sees the settled flag');
  assert.equal(observed.receipt.reason, 'timeout', 'and the timeout receipt, not a fresh PLAYING turn');
  assert.equal(observed.receipt.winner, winner, 'with the same committed winner');
});

/* =================================== 4. move-vs-timeout serialization ========= */

test('V5-08-03 timers: a move near the deadline advances the revision and the stale timeout claim cannot settle it', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const [playerA, playerB] = FIXTURES.race;
  const matchId = 'match:p08t-race';
  const clock = makeClock();
  const core = await coreFor(h, clock, t);
  const timers = await timersFor(h, { core, clock }, t);

  const created = await createPlaying(h, core, matchId, playerA, playerB);
  const staleKey = timeoutKey(matchId, created.revision);
  await timers.scheduleTimeout(matchId, created.revision, created.deadline);

  /* The player on turn moves one millisecond INSIDE the deadline: the last instant at which the
   * frozen rule `now >= deadline` still admits a legal move. */
  const mover = created.symbols[created.state.turn];
  const moveKey = `move:${matchId}:1`;
  clock.set(created.deadline - 1);
  const moved = await core.run({ actor: mover, scope: 'player' }, moveKey, {
    type: 'move', id: matchId, revision: created.revision, move: { b: 0, c: 0 },
  });
  assert.equal(moved.revision, 1, 'the boundary move committed revision 1');

  /* Now the timer for the PREVIOUS revision fires at its own due instant. */
  clock.set(created.deadline);
  await rejectsWith(core.run(WORKER, staleKey, { type: 'timeout', id: matchId }), TIMEOUT_REFUSALS);

  const after = await core.readMatch(playerA, matchId);
  assert.equal(after.revision, 1, 'the move revision still stands: the stale timer could not touch it');
  assert.equal(after.status, 'PLAYING', 'the match was not settled by the stale timer');
  assert.equal(after.settled, false, 'the match is not settled');
  assert.equal(after.deadline, (created.deadline - 1) + TURN_MS, 'the new turn carries its OWN fresh absolute deadline');
  assert.ok(after.deadline > clock(), 'the new deadline is still in the future for the new turn');
  assert.equal(await outcomeCount(h, WORKER.actor, staleKey), 0, 'the losing timer claim stored NO outcome');
  assert.equal(await outboxCount(h, outboxId(WORKER.actor, staleKey)), 0, 'the losing timer claim enqueued NO outbox event');

  /* The durable scan cannot resurrect the old deadline either: the committed deadline moved. */
  assert.deepEqual(settledFor(await timers.checkTimeouts({ now: clock, limit: 16 }), matchId), [],
    'the durable scan finds nothing due once the deadline was reset');

  /* And a claim bound to the NEW revision is premature against the new deadline - the old timer can
   * neither settle the old nor the new revision. */
  await rejectsWith(core.run(WORKER, timeoutKey(matchId, after.revision), { type: 'timeout', id: matchId }), TIMEOUT_REFUSALS);
  assert.equal(await statusOf(h, matchId), 'PLAYING', 'the match is still live after both timer attempts');
  assert.equal(await outcomeCount(h, WORKER.actor, timeoutKey(matchId, after.revision)), 0, 'the future-revision claim stored no outcome either');
});

test('V5-08-03 timers: a genuinely concurrent move and timeout commit exactly one effect and never split the match', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const [playerA, playerB] = FIXTURES.raceConcurrent;
  const matchId = 'match:p08t-race-concurrent';
  /* Two processes with clocks one millisecond apart: the Core that owns the turn sees the boundary
   * instant, the timeout worker is already at its due instant. Whichever wins is decided by the
   * aggregate lock, not by the test. */
  const coreClock = makeClock(START);
  const workerClock = makeClock(START);
  const core = await coreFor(h, coreClock, t);
  const worker = await coreFor(h, workerClock, t);
  const timers = await timersFor(h, { core: worker, clock: workerClock }, t);

  const created = await createPlaying(h, core, matchId, playerA, playerB);
  await timers.scheduleTimeout(matchId, created.revision, created.deadline);
  const staleKey = timeoutKey(matchId, created.revision);
  const moveKey = `move:${matchId}:1`;
  const mover = created.symbols[created.state.turn];
  const winner = opponentOfTurn(created);

  coreClock.set(created.deadline - 1);
  workerClock.set(created.deadline);
  const [moveLanded, timerLanded] = await Promise.allSettled([
    core.run({ actor: mover, scope: 'player' }, moveKey, {
      type: 'move', id: matchId, revision: created.revision, move: { b: 0, c: 0 },
    }),
    timers.checkTimeouts({ now: workerClock, limit: 16 }),
  ]);

  const committed = await core.readMatch(playerA, matchId);
  const timerSettled = timerLanded.status === 'fulfilled'
    ? timerLanded.value.settled.filter((entry) => entry.matchId === matchId).length : 0;
  const moveCommitted = moveLanded.status === 'fulfilled' && moveLanded.value.revision === 1;
  const moveRefused = moveLanded.status === 'rejected'
    && ['MATCH_CLOSED', 'TIMER_EXPIRED', 'STALE_REVISION'].includes(moveLanded.value.message);
  const moveOutcomes = await int(h, 'SELECT count(*)::int FROM match.move_outcomes WHERE match_id = $1', [matchId]);

  if (committed.settled) {
    /* The timeout won the lock: it settled the OLD revision and the move changed nothing. */
    assert.equal(timerSettled, 1, 'the timeout settled the due match');
    assert.equal(moveRefused, true, `the racing move was refused, observed ${moveLanded.status === 'rejected' ? moveLanded.value.message : 'a commit'}`);
    assert.equal(committed.status, 'FINISHED', 'the settled match is terminal');
    assert.equal(committed.receipt.reason, 'timeout', 'the receipt names the scheduled timeout');
    assert.equal(committed.receipt.winner, winner, 'the winner is the opponent of the player on turn');
    assert.equal(await outcomeCount(h, WORKER.actor, staleKey), 1, 'exactly one timeout outcome exists');
    assert.equal(moveOutcomes, 0, 'the refused move wrote no move outcome');
  } else {
    /* The move won the lock: the stale timeout claim was refused and settled nothing. */
    assert.equal(moveCommitted, true, 'the move committed the new revision');
    assert.equal(timerSettled, 0, 'no timeout settlement raced the committed move');
    assert.equal(committed.revision, 1, 'the revision advanced exactly once');
    assert.equal(committed.status, 'PLAYING', 'the match is still live');
    assert.equal(committed.deadline, (created.deadline - 1) + TURN_MS, 'the move reset the deadline');
    assert.equal(await outcomeCount(h, WORKER.actor, staleKey), 0, 'the refused stale claim stored no outcome');
    assert.equal(moveOutcomes, 1, 'the committed move wrote exactly one move outcome');
  }

  /* EITHER WAY: no split match, exactly one revision bump at most, and one committed effect - the
   * timeout settlement or the move, never both and never neither. */
  assert.ok(committed.revision === 0 || committed.revision === 1, 'the revision advanced by at most one');
  assert.ok(timerSettled + moveOutcomes === 1, 'exactly one of the two business effects committed');
  assert.equal(await int(h, 'SELECT count(*)::int FROM match.participants WHERE match_id = $1', [matchId]), 2,
    'the match still has exactly its two participants');
  assert.equal(await int(h, 'SELECT count(*)::int FROM match.matches WHERE match_id = $1', [matchId]), 1,
    'and exactly one committed match row');
  /* The loser of the race cannot be settled by a later scan at the same due instant. */
  assert.deepEqual(settledFor(await timers.checkTimeouts({ now: workerClock, limit: 16 }), matchId), [],
    'a follow-up sweep settles nothing further');
});

/* ==================================== 5. idempotent timeout replay ============= */

test('V5-08-03 timers: a replayed timeout key returns the stored settlement with no duplicate payout', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const [playerA, playerB] = FIXTURES.replay;
  const matchId = 'match:p08t-replay';
  const clock = makeClock();
  const core = await coreFor(h, clock, t);
  const timers = await timersFor(h, { core, clock }, t);

  const created = await createPlaying(h, core, matchId, playerA, playerB);
  const key = timeoutKey(matchId, created.revision);
  await timers.scheduleTimeout(matchId, created.revision, created.deadline);
  const winner = opponentOfTurn(created);

  clock.set(created.deadline + 500);
  const first = await core.run(WORKER, key, { type: 'timeout', id: matchId });
  assert.equal(first.reason, 'timeout', 'the first claim is a real timeout settlement');
  assert.equal(first.winner, winner, 'the first claim awards the opponent of the player on turn');
  const currency = created.quote.currency;
  const balancesSettled = await wallets(h, [playerA, playerB], currency);
  const receiptSettled = await receiptDoc(h, matchId);
  const outcomeSettled = await outcomeCount(h, WORKER.actor, key);
  const outboxSettled = await outboxCount(h, outboxId(WORKER.actor, key));

  /* REPLAY the identical revision-bound operation identity. */
  const replay = await core.run(WORKER, key, { type: 'timeout', id: matchId });
  assert.deepEqual(replay, first, 'the replay returns the STORED settlement receipt byte-for-byte');
  assert.deepEqual(await wallets(h, [playerA, playerB], currency), balancesSettled, 'a replay pays NO second time');
  assert.equal(await receiptDoc(h, matchId), receiptSettled, 'the durable receipt document is unchanged');
  assert.equal(await outcomeCount(h, WORKER.actor, key), outcomeSettled, 'no duplicate outcome row');
  assert.equal(outcomeSettled, 1, 'the settlement owns exactly one outcome row');
  assert.equal(await outboxCount(h, outboxId(WORKER.actor, key)), outboxSettled, 'no duplicate outbox event');
  assert.equal(outboxSettled, 1, 'the settlement owns exactly one outbox event');

  /* A service-level sweep at the same instant cannot settle it a second time either. */
  const sweep = await timers.checkTimeouts({ now: clock, limit: 16 });
  assert.deepEqual(settledFor(sweep, matchId), [], 'the settled match is no longer due');
  assert.deepEqual(settledFor(await timers.checkTimeouts({ now: clock, limit: 16 }), matchId), [], 'repeated sweeps stay no-ops');
  assert.deepEqual(await wallets(h, [playerA, playerB], currency), balancesSettled, 'no sweep paid anything');

  /* The timeout could not have been reissued for a later revision of a terminal match. */
  await rejectsWith(core.run(WORKER, timeoutKey(matchId, created.revision + 1), { type: 'timeout', id: matchId }), TIMEOUT_REFUSALS);
  assert.equal(await receiptDoc(h, matchId), receiptSettled, 'the terminal receipt still stands');
});

/* ============================================= 6. offer expiry sweep ========= */

test('V5-08-03 timers: reapDueRooms expires an OFFERED match past its frozen offer window exactly once', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const [playerA, playerB] = FIXTURES.reap;
  const matchId = 'match:p08t-reap';
  const clock = makeClock();
  const core = await coreFor(h, clock, t);
  const timers = await timersFor(h, { core, clock }, t);

  const offer = await core.run({ actor: playerA, scope: 'player' }, `offer:${matchId}`, {
    type: 'offer', id: matchId, opponent: playerB, terms: { kind: 'leaderboard', amount: 40 },
  });
  assert.equal(offer.status, 'OFFERED', 'the fixture offer is committed OFFERED');
  const expires = await expiresOf(h, matchId);
  assert.equal(expires, START + D.POLICY.offerMinutes * 60000, 'the offer window is the frozen policy window');

  clock.set(expires - 1);
  const early = await timers.reapDueRooms({ now: clock, limit: 16 });
  assert.deepEqual(expiredFor(early, matchId), [], 'no OFFERED match is reaped before its expires instant');
  assert.deepEqual(errorsFor(early, matchId), [], 'the early sweep reported no error for this match');
  assert.equal(await statusOf(h, matchId), 'OFFERED', 'the offer is still open');

  clock.set(expires);
  const reaped = await timers.reapDueRooms({ now: clock, limit: 16 });
  assert.deepEqual(errorsFor(reaped, matchId), [], 'the expiry sweep reported no error for this match');
  assert.equal(expiredFor(reaped, matchId).length, 1, 'the due OFFERED match was expired exactly once');
  assert.equal(await statusOf(h, matchId), 'EXPIRED', 'the due OFFERED match was expired through the expire command');
  const committed = await core.readMatch(playerA, matchId);
  assert.equal(committed.status, 'EXPIRED', 'the committed document reflects the expiry');
  assert.equal(committed.settled, false, 'an expired offer was never a settled match');
  /* The expiry is a real business change, so it was recorded as one: exactly one durable outbox row
   * of type `expire` for the match (the earlier offer's own outbox row is a different type). */
  assert.equal(await int(h, "SELECT count(*)::int FROM ops.outbox WHERE payload::jsonb->>'type' = 'expire' AND payload::jsonb->>'matchId' = $1", [matchId]), 1,
    'the expiry enqueued exactly one durable expire outbox event for the match');
  assert.equal(await outcomeCount(h, WORKER.actor, timeoutKey(matchId, offer.revision)), 0,
    'an expired offer was never settled as a scheduled timeout');
  assert.equal(await outcomeCount(h, WORKER.actor, `expire:${matchId}`), 1,
    'the expiry stored exactly one outcome under the expire identity');

  /* A second sweep is a no-op: the offer is no longer OFFERED. */
  const again = await timers.reapDueRooms({ now: clock, limit: 16 });
  assert.deepEqual(expiredFor(again, matchId), [], 'an expired offer is never reaped twice');
  assert.equal(await statusOf(h, matchId), 'EXPIRED', 'the status is unchanged by the second sweep');
});

/* ------------------------------------------------ shared-session teardown ----- */

test.after(async () => {
  if (!sessionPromise) return;
  const h = await sessionPromise.catch(() => null);
  if (!h) return;
  try { await h.ephemera.wipeNamespace(); } catch { /* only this suite's namespace */ }
  try { await h.ephemera.close(); } catch { /* best effort */ }
});


/* Co-dev post-G08 regression: Redis's due:timeout is a SHARED ZSET. Scheduling
 * a near deadline must not expire the entire set before a different match's
 * much later deadline. This verifies the real Lua PTTL/PEXPIRE monotonicity,
 * not a mocked redis command. PostgreSQL remains the authority if Redis dies. */
test('V5-08 co-dev: nearer timeout registration never shortens an existing later Redis due hint', { skip: GATE }, async (t) => {
  const h=await session(t);
  if(!h)return;
  const ephemera=await createEphemeraService({
    ...ephemeraOptions(),keyVersion:'tmp08monotone',
  });
  t.after(async()=>{
    try { await ephemera.wipeNamespace(); }
    finally { await ephemera.close(); }
  });
  assert.equal(await ephemera.healthy(),true,'owned isolated Redis namespace is ready');
  const timers=loadTimerFactory()({
    pool:h.pools.core,
    core:{run:async()=>{throw Error('NO_TIMER_SETTLEMENT_EXPECTED')}},
    ephemera,now:()=>START,
  });
  t.after(()=>timers.close());
  const key=ephemera.key('due','timeout');
  const distant=await timers.scheduleTimeout('match:p08-later-deadline',0,START+7200000);
  assert.equal(distant.registered,true);
  const longTtl=await ephemera.client.pTTL(key);
  assert.ok(longTtl>7000000,'the distant deadline is initially retained');
  const near=await timers.scheduleTimeout('match:p08-near-deadline',0,START+5000);
  assert.equal(near.registered,true);
  const after=await ephemera.client.pTTL(key);
  assert.ok(after>=longTtl-5000,
    'registering an earlier due member must not destroy later hints on the same key');
  assert.ok(await ephemera.client.zScore(key,distant.member)!==null,
    'the later due identity remains in the Redis index after the near registration');
});
