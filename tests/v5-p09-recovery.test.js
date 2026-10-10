'use strict';
/* tests/v5-p09-recovery.test.js - V5 P09 task V5-09-05 (Prove full multi-worker tournament recovery).
 *
 * SCOPE. Drives the durable tournament surface of `packages/services/tournaments.js`
 * (`createTournamentService({ pool, core, now })` -> `run(principal, key, command)` / `view` /
 * `getRoom` / `activeRooms` / `settle`) against the REAL owned PostgreSQL 16 lab
 * (`tests/v5-pg-lab.js`: the checksummed migration chain, guarded `core_runtime`/`api_runtime`/
 * `worker_runtime` pools, synthetic actors) and the REAL Core service
 * (`packages/services/core.js` `createCoreService`) over the same core pool. No mock, no SQLite, no
 * in-memory authority: every assertion reads a committed PostgreSQL row or a delivered DTO that the
 * committed row produced. PostgreSQL is the durable authority; Redis is not borrowed at all, because
 * a tournament room command is a PostgreSQL transaction and nothing in the recovery path may depend
 * on ephemeral coordination.
 *
 * WHAT THIS SUITE PROVES (V5-09-05 verification: "No lost escrow, duplicate prize, unexpected host
 * handover or restart-caused user leave"):
 *
 *   1. TEN-PLAYER PUBLIC TABLE ACROSS A WORKER RESTART. Ten in-cohort players open one public low
 *      table, ready it, and the tenth ready seat starts it AUTOMATICALLY with ten committed escrow
 *      contributions and the whole 1000-coin pool reserved. The live service instance is CLOSED and a
 *      BRAND-NEW instance is booted over the same pool and database (exactly what a restarted worker
 *      is). The room is still RUNNING at the same revision, all ten players are seated, the escrow is
 *      still 1000 and the fixture graph is byte-identical. The fresh worker then plays the whole
 *      tournament out through the command surface, delivering EVERY command TWICE under the same
 *      (actor, key): the second delivery returns the stored response verbatim and advances no durable
 *      state. The table completes with payouts paid once, the burn recorded once, the escrow zeroed,
 *      zero lost escrow (payouts + burn == pool) and zero duplicate prizes.
 *
 *   2. PRIVATE ROOM SURVIVES A RESTART WITHOUT A RESTART-CAUSED LEAVE OR HOST HANDOVER. A host creates
 *      a private room, three guests join, the host configures the format and clocks, everyone readies
 *      and the host starts it. After a service restart the room is STILL RUNNING (never CANCELLED),
 *      ownership is STILL the original host (no unexpected handover), every player is still seated,
 *      the revision, start instant and deadline are unchanged, and the room is still in the active
 *      set - so a restart is provably not treated as a member leaving. A guest then readies its FIRST
 *      fixture on the fresh worker, proving the recovered room is live.
 *
 *   3. NO LOST ESCROW ON A VOID. A running public table is played part-way through and then voided by
 *      the operator mid-tournament. The refund is applied in the same transaction as the VOID: 100% of
 *      every entry fee returns, the escrow is zeroed, nothing burns and no placement record is written.
 *      A restart then reads the SAME committed refund; a same-key replay returns the stored response,
 *      a new-key retry is refused with EVENT_FINISHED, and the standalone `settle()` worker on the
 *      fresh instance observes the committed receipt and pays nothing a second time.
 *
 *   4. DUPLICATE DELIVERY OF EVERY PARTY COMMAND. create / join / configure / ready / start /
 *      matchReady / move / resign are each delivered twice under one key: the replay returns the
 *      stored response verbatim, the committed revision does not move, no second row appears in
 *      `tournament.command_outcomes`, and a DIFFERENT command under a used key is a hard conflict -
 *      never a second business effect.
 *
 * CLOCK. The service clock is injected (`options.now`), so each test owns time exactly: `h.now()`
 * reads it and `h.at(ms)` sets it. Nothing here waits on wall time or on a timer - each due fixture is
 * parked on its own `opens` instant before it is played.
 *
 * GATING (the repo convention): needs the owned PostgreSQL lab (`V5_PG_URL`, or `V5_PG_REQUIRED=1` to
 * fail instead of skip). Absent it, every test skips - a gate, never a fake pass. Teardown is the
 * lab's `installCleanup` (guarded pools closed, owned databases dropped) plus a per-test `t.after`
 * that closes every service instance and the Core service; the process exits naturally - no
 * `process.exit`, no force-exit.
 *
 *   env V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
 *       node --test --test-concurrency=1 tests/v5-p09-recovery.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');

/* Close every guarded pool and drop every owned database, AFTER this suite's own `t.after` closes the
 * service instances. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

const CLOCK = lab.CLOCK;

/* The tournament service and Core are loaded lazily, so a checkout without the P09 module skips
 * (rather than throws at require time) when the gate is unset. */
let tournamentFactory = null;
function loadTournamentFactory() {
 if (!tournamentFactory) {
  const mod = require('../packages/services/tournaments.js');
  assert.equal(typeof mod.createTournamentService, 'function',
   'packages/services/tournaments.js must export createTournamentService');
  tournamentFactory = mod.createTournamentService;
 }
 return tournamentFactory;
}

/* Ten distinct players, the exact ten seats `T.prize('low').seats` admits. Every test owns its own
 * database, so the same roster is reused across tests without cross-test contamination. */
const ROSTER = Object.freeze(['svc_r01', 'svc_r02', 'svc_r03', 'svc_r04', 'svc_r05',
 'svc_r06', 'svc_r07', 'svc_r08', 'svc_r09', 'svc_r10']);
const SEEDS = ROSTER.map((actor) => ({
 actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends',
}));
/* The low table's approved numbers: 100 coins entry, 1000 coin pool, 100 burn, ten seats. */
const ENTRY = 100;
const POOL = 1000;
const BURN = 100;

const principal = (actor, scope = 'player') => ({ actor, scope, name: actor });
const send = (h, actor, key, command, scope = 'player') => h.service.run(principal(actor, scope), key, command);
const ids = (players) => players.map((p) => p.id);
/* The stored outcome is the JSON TEXT of the response, so a replay is compared against the response
 * as it was serialized - the exact bytes the outcome row holds. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/* One owned database, its guarded core pool, one live Core service, one live tournament service and a
 * controllable clock. `restart()` is a REAL worker restart: the current tournament instance is closed
 * and a brand-new one is booted over the SAME pool and database (the pool is caller-owned and outlives
 * a service, which is exactly what lets a fresh process boot over it). `t.after` closes every instance. */
let dbSeq = 0;
async function open(t) {
 if (!(await lab.boot(t))) return null;
 const create = loadTournamentFactory();
 const database = await lab.createDatabase(`p09r${dbSeq++}`);
 await lab.seedActors(database, SEEDS);
 const pools = lab.poolsFor(database);
 let clock = CLOCK;
 const now = () => clock;
 const core = await lab.coreFor(database, { clock: now });
 const services = [];
 let active = null;
 const boot = () => { const instance = create({ pool: pools.core, core, now }); services.push(instance); active = instance; return instance; };
 boot();
 t.after(async () => {
  for (const instance of services) { try { await instance.close(); } catch { /* best effort */ } }
  try { await core.close(); } catch { /* best effort */ }
 });
 const rows = async (text, params = []) => (await pools.core.query(text, params)).rows;
 const row = async (text, params = []) => (await rows(text, params))[0] ?? null;
 return {
  database, pools, core, rows, row,
  now, at: (ms) => { clock = ms; return clock; },
  get service() { return active; },
  restart() { try { active.close(); } catch { /* best effort */ } return boot(); },
 };
}

/* ---------------------------------------------------------------- durable probes */

const revisionOf = async (h, roomId) => Number((await h.row('SELECT revision FROM tournament.rooms WHERE room_id = $1', [roomId])).revision);
const roomRow = (h, roomId) => h.row('SELECT status, owner_id, escrow, settled, settled_at, revision, receipt_json, ranking,'
 + ' (SELECT count(*) FROM tournament.room_players p WHERE p.room_id = r.room_id)::int AS seated'
 + ' FROM tournament.rooms r WHERE room_id = $1', [roomId]);
const contributionsOf = (h, roomId) => h.rows('SELECT actor_id, amount FROM tournament.escrow_contributions WHERE room_id = $1 ORDER BY actor_id', [roomId]);
const walletsOf = (h) => h.rows('SELECT actor_id, coins, reserved_coins FROM economy.wallets WHERE actor_id = ANY($1::text[]) ORDER BY actor_id', [ROSTER]);
const walletMap = async (h) => new Map((await walletsOf(h)).map((r) => [r.actor_id, r]));
const ledgerOf = (h, roomId, kind) => h.rows('SELECT entry_id, actor_id, currency, amount FROM economy.ledger'
 + ' WHERE entry_id LIKE $1 ORDER BY entry_id', [`${roomId}:${kind}:%`]);
const occupancyOf = (h, roomId) => h.rows("SELECT actor_id FROM core.actor_occupancy WHERE kind = 'tournament' AND ref_id = $1 ORDER BY actor_id", [roomId]);
const burnsOf = async (h) => (await h.row('SELECT coins, crowns FROM economy.system_burns WHERE id = 1')) || { coins: 0, crowns: 0 };
const recordsOf = (h) => h.rows('SELECT actor_id, entered, wins, runner_up, top3, top5, best_finish, finish_sum'
 + ' FROM economy.tournament_records ORDER BY actor_id');
/* Outbox is worker-owned, not readable through the core_runtime role. Probe it
 * with this test-owned admin client, never by expanding Core privileges. */
const settlementEvent = async (h, roomId) => {
 const c = await lab.adminClient(h.database);
 try {
  const q = await c.query('SELECT outbox_id, kind, state, payload FROM ops.outbox WHERE outbox_id = $1',
   ['tournament.settle:' + roomId]);
  return q.rows[0] ?? null;
 } finally { await c.end(); }
};
const outcomeCount = async (h, actor, key) => Number((await h.row('SELECT count(*)::int AS n FROM tournament.command_outcomes WHERE actor_id = $1 AND "key" = $2',
 [actor, JSON.stringify(key)])).n);
/* The committed outcome row for one (actor, key): the durable record a replay is answered from. The
 * stored key is the canonical JSON text of the logical key (0034), so it is encoded on read. */
const storedOutcome = async (h, actor, key) => {
 const row = await h.row('SELECT fingerprint, response FROM tournament.command_outcomes WHERE actor_id = $1 AND "key" = $2',
  [actor, JSON.stringify(key)]);
 assert.ok(row, `the outcome row for (${actor}, ${key}) is committed`);
 return { fingerprint: row.fingerprint, response: JSON.parse(row.response) };
};

/* ---------------------------------------------------------------- room flows */

/* Seat ten in-cohort players at ONE public low table through the approved command surface. Every
 * in-cohort player is 1500 Elo, so the frozen matchmaking policy (`packages/domain/matchmaking.js`
 * `selectTournamentRoom`, 200-Elo cohort cap, ten-seat cap) selects the SAME table for all ten; the
 * tenth ready seat starts it automatically. Returns the delivered RUNNING view and the room id. */
async function seatPublicTable(h, { table = 'low' } = {}) {
 let view = await send(h, ROSTER[0], 'pub-join-0', { type: 'publicJoin', table });
 const roomId = String(view.id);
 assert.equal(view.owner, 'service', 'a public table is owned by the service');
 assert.equal(view.capacity, 10, 'a public table holds ten seats');
 view = await send(h, ROSTER[0], 'pub-ready-0', { type: 'ready', value: true, rulesVersion: view.rulesVersion, id: roomId });
 assert.equal(view.status, 'LOBBY', 'one ready seat does not start a public table');
 for (const actor of ROSTER.slice(1)) {
  view = await send(h, actor, `pub-join-${actor}`, { type: 'publicJoin', table });
  assert.equal(String(view.id), roomId, 'every in-cohort player joins the SAME public table');
  view = await send(h, actor, `pub-ready-${actor}`, { type: 'ready', value: true, rulesVersion: view.rulesVersion, id: roomId });
 }
 assert.equal(view.status, 'RUNNING', 'ten ready in-cohort players start the table AUTOMATICALLY');
 assert.equal(view.escrow, POOL, 'the whole pool is reserved into escrow');
 assert.equal(view.contributions.length, 10, 'one committed contribution per seat');
 assert.ok(view.contributions.every((c) => c.amount === ENTRY), 'every contribution is the entry fee');
 assert.equal(view.seed.length, 10, 'the automatic start seeded all ten players');
 return { view, roomId };
}

/* Play a RUNNING public table to its terminal state through the command surface only, delivering
 * EVERY command TWICE under the same (actor, key). The frozen rules accept a resign on a READY
 * fixture, so one command finishes each fixture - no game engine, no synthetic room document. The
 * clock is parked on each due fixture's own `opens` instant, so nothing sleeps. Each replay must
 * return the stored response verbatim and leave the committed revision untouched. The LAST command is
 * returned verbatim so a test can replay it after the settlement. */
async function playOut(h, view, { guard = 400, max = Infinity } = {}) {
 let state = view;
 let steps = 0;
 let replays = 0;
 let last = null;
 while (state.status === 'RUNNING' && steps < guard && steps < max) {
  const ready = state.fixtures.filter((f) => f.status === 'READY');
  if (!ready.length) break;
  const due = ready.reduce((a, b) => (a.opens <= b.opens ? a : b));
  h.at(Math.max(h.now(), due.opens));
  steps += 1;
  const actor = due.players[0];
  const key = `play-${steps}`;
  const command = { type: 'resign', id: String(state.id), fixture: due.id };
  const first = await send(h, actor, key, command);
  const committed = await revisionOf(h, String(state.id));
  assert.equal(committed, first.revision, `resign #${steps}: the delivered revision is the committed one`);
  const replay = await send(h, actor, key, command);
  assert.deepEqual(replay, plain(first), `resign #${steps}: a duplicate delivery returns the stored response verbatim`);
  assert.equal(await revisionOf(h, String(state.id)), committed, `resign #${steps}: the duplicate delivery advances no durable state`);
  replays += 1;
  last = { actor, key, command, fixtureId: due.id };
  state = first;
 }
 return { view: state, steps, replays, last };
}

/* A private room seated with `actors` (the host first) and fully ready - the shape create + join +
 * configure + ready produces, driven only through the approved command surface. */
async function seatPrivateRoom(h, actors, command, keyBase) {
 const host = actors[0];
 const created = await send(h, host, `${keyBase}-create`, { type: 'create', ...command });
 assert.equal(created.status, 'LOBBY', 'a created room starts in the lobby');
 assert.deepEqual(ids(created.players), [host], 'the host is the only initial member');
 let view = created;
 for (const actor of actors.slice(1)) {
  view = await send(h, actor, `${keyBase}-join-${actor}`, { type: 'join', id: created.id });
 }
 assert.deepEqual(ids(view.players), actors, `all ${actors.length} players are seated in join order`);
 return { view, roomId: String(created.id), rulesVersion: view.rulesVersion };
}

/* ============ 1. ten-player public table across a worker restart, with duplicate delivery ============ */

test('V5-09-05: a ten-player public table survives a worker restart and duplicate-delivered commands, then settles with zero lost escrow and zero duplicate prizes', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;

 const { view: started, roomId } = await seatPublicTable(h);
 const revisionAtStart = started.revision;

 /* DURABLE START FACTS: ten seats, ten contributions, 1000 in escrow, every wallet debited once. */
 const startedRow = await roomRow(h, roomId);
 assert.equal(startedRow.status, 'RUNNING');
 assert.equal(Number(startedRow.escrow), POOL, 'the committed escrow is the whole pool');
 assert.equal(startedRow.settled, false);
 assert.equal(startedRow.seated, 10, 'ten players are durably seated');
 assert.equal((await contributionsOf(h, roomId)).length, 10, 'ten committed escrow contributions survive the start');
 const reserves = await ledgerOf(h, roomId, 'reserve');
 assert.equal(reserves.length, 10, 'one reserve journal entry per seat');
 assert.ok(reserves.every((r) => Number(r.amount) === -ENTRY), 'each reserve debits exactly the entry');
 let wallets = await walletMap(h);
 for (const actor of ROSTER) {
  assert.equal(Number(wallets.get(actor).coins), 1000 - ENTRY, `${actor}: the entry is debited to the available balance`);
  assert.equal(Number(wallets.get(actor).reserved_coins), ENTRY, `${actor}: the entry is held in the reserved balance`);
 }
 assert.equal((await occupancyOf(h, roomId)).length, 10, 'every seat claims the tournament occupancy');

 /* WORKER RESTART: close the live instance, boot a brand-new one over the same pool and database. */
 const workerA = h.service;
 const before = plain(await workerA.getRoom(roomId));
 assert.equal(String(before.id), roomId, 'the committed room reads back before the restart');
 h.restart();
 assert.notEqual(h.service, workerA, 'the restart really boots a NEW service instance');
 const after = plain(await h.service.getRoom(roomId));

 /* The room is the SAME room: RUNNING, same revision, same roster, same escrow, same fixtures. */
 assert.deepEqual(after, before, 'the whole room document is byte-identical across the worker restart');
 assert.equal(after.status, 'RUNNING', 'the restarted worker does not cancel or void a running table');
 assert.equal(after.revision, revisionAtStart, 'the room stays at the same revision across the restart');
 assert.deepEqual(ids(after.players), ROSTER, 'all ten players remain seated');
 assert.equal(after.players.length, 10, 'no player is lost across the restart');
 assert.ok(after.players.every((p) => p.ready === true), 'every seat is still ready');
 assert.equal(after.escrow, POOL, 'the escrow is intact at 1000 after the restart');
 assert.deepEqual(after.contributions, before.contributions, 'every contribution survives the restart');
 assert.equal(after.fixtures.length, before.fixtures.length, 'the fixture graph keeps every fixture');
 assert.equal(after.fixtures.length, 20, 'a ten-player mixed table keeps its twenty group fixtures');
 assert.ok(after.fixtures.every((f) => ['BLOCKED', 'READY', 'PLAYING', 'DONE'].includes(f.status)), 'every recovered fixture holds a real status');
 assert.equal(after.settled, false, 'the recovered room is unsettled');
 const afterRow = await roomRow(h, roomId);
 assert.equal(Number(afterRow.escrow), POOL, 'the committed escrow row is still the pool');
 assert.equal(afterRow.seated, 10, 'the committed roster still holds ten seats');

 /* The fresh worker plays the whole tournament out, delivering every command twice. */
 const played = await playOut(h, after);
 assert.equal(played.view.status, 'COMPLETE', `the recovered table plays to COMPLETE (${played.steps} resign commands)`);
 assert.ok(played.steps >= 20, `a ten-player mixed table needs at least its twenty group fixtures (saw ${played.steps})`);
 assert.equal(played.replays, played.steps, 'every single command was duplicate-delivered');
 assert.equal(new Set(played.view.ranking).size, 10, 'the settlement ranks ten distinct players');

 /* ONE settlement: payouts once, burn once, escrow zeroed, nothing lost and nothing duplicated. */
 assert.equal(played.view.settled, true, 'the table is settled');
 assert.equal(played.view.escrow, 0, 'the escrow is fully released');
 const receipt = played.view.receipt;
 assert.equal(receipt.refunded, false, 'a COMPLETE table pays out rather than refunding');
 assert.equal(receipt.pool, POOL, 'the receipt names the whole pool');
 assert.equal(receipt.burn, BURN, 'the receipt names the approved burn');
 assert.equal(receipt.payouts.length, 10, 'the receipt carries one payout line per place');
 assert.equal(new Set(receipt.payouts.map((p) => p.id)).size, 10, 'no prize is paid to the same player twice');
 const paidTotal = receipt.payouts.reduce((sum, p) => sum + p.amount, 0);
 assert.equal(paidTotal + receipt.burn, receipt.pool, 'ZERO LOST ESCROW: payouts plus the burn are the whole pool');
 assert.equal(receipt.payouts.reduce((sum, p) => sum + p.amount, 0), POOL - BURN, 'the frozen shares total exactly the pool minus the burn');

 const settledRow = await roomRow(h, roomId);
 assert.equal(settledRow.status, 'COMPLETE');
 assert.equal(settledRow.settled, true);
 assert.equal(Number(settledRow.escrow), 0, 'the committed escrow is zeroed');
 assert.deepEqual(settledRow.ranking, played.view.ranking, 'the committed ranking is the delivered one');
 assert.deepEqual(plain(settledRow.receipt_json), plain(receipt), 'the committed receipt is the delivered one');
 assert.ok(settledRow.settled_at !== null, 'the settlement instant is durable');
 const notified = await settlementEvent(h, roomId);
 assert.ok(notified,'automatic game completion must atomically enqueue a settlement notification');
 assert.equal(notified.kind,'tournament.settle');
 assert.equal(notified.state,'queued');
 assert.equal(JSON.parse(notified.payload).refunded,false);
 assert.equal(JSON.parse(notified.payload).roomId,roomId);

 /* Exactly one payout ledger entry per player, each the frozen share, each credited once. */
 const payouts = await ledgerOf(h, roomId, 'payout');
 assert.equal(payouts.length, 10, 'exactly one payout entry per placed player');
 const share = new Map(receipt.payouts.map((p) => [p.id, p.amount]));
 assert.equal(new Set(payouts.map((p) => p.entry_id)).size, 10, 'every payout entry id is unique');
 for (const entry of payouts) {
  assert.equal(entry.entry_id, `${roomId}:payout:${entry.actor_id}`, 'the payout entry id names the room and actor');
  assert.equal(Number(entry.amount), share.get(entry.actor_id), `${entry.actor_id}: the ledger amount is the frozen share`);
 }
 assert.equal(payouts.reduce((sum, p) => sum + Number(p.amount), 0), paidTotal, 'the ledger pays the receipt exactly');

 wallets = await walletMap(h);
 for (const actor of ROSTER) {
  assert.equal(Number(wallets.get(actor).reserved_coins), 0, `${actor}: the reservation is released exactly once`);
  assert.equal(Number(wallets.get(actor).coins), 1000 - ENTRY + share.get(actor), `${actor}: credited the approved share exactly once`);
 }
 const walletTotal = [...wallets.values()].reduce((sum, w) => sum + Number(w.coins), 0);
 assert.equal(walletTotal, 10 * (1000 - ENTRY) + paidTotal, 'coins are conserved across the table');
 assert.equal(Number((await burnsOf(h)).coins), BURN, 'the approved burn is recorded exactly once');
 assert.equal((await occupancyOf(h, roomId)).length, 0, 'every occupancy claim is released exactly once');

 /* Tournament placements are recorded once each; normal Elo is never touched by a tournament. */
 const records = await recordsOf(h);
 assert.equal(records.length, 10, 'every ranked player gains one tournament record');
 assert.equal(records.reduce((sum, r) => sum + Number(r.entered), 0), 10, 'each player entered exactly once');
 assert.equal(records.reduce((sum, r) => sum + Number(r.finish_sum), 0), 55, 'the placements are exactly 1..10');

 /* The LAST command, replayed after the settlement, is still the same committed response - and the
  * standalone settlement worker on the fresh instance pays nothing a second time. */
 const replayLast = await send(h, played.last.actor, played.last.key, played.last.command);
 assert.deepEqual(replayLast, plain(played.view), 'the replay of the settling command returns the stored COMPLETE response');
 assert.equal((await ledgerOf(h, roomId, 'payout')).length, 10, 'the replay writes no second payout');
 const committedOutcome = await storedOutcome(h, played.last.actor, played.last.key);
 assert.deepEqual(committedOutcome.response, plain(played.view), 'the stored outcome is the committed COMPLETE response, unchanged by its replay');
 const secondWorker = await h.service.settle(roomId, { reason: 'EVENT_COMPLETE' });
 assert.equal(secondWorker.settled, true, 'a settlement worker on a restarted process observes the committed settlement');
 assert.deepEqual(plain(secondWorker.receipt), plain(receipt), 'it hands back the committed receipt');
 assert.equal((await ledgerOf(h, roomId, 'payout')).length, 10, 'it pays nothing a second time');
 assert.equal(Number((await burnsOf(h)).coins), BURN, 'it burns nothing a second time');
 assert.deepEqual(await settlementEvent(h, roomId),notified,
  'command replay and standalone worker must not duplicate or rewrite the event');
 const finalWallets = await walletMap(h);
 for (const actor of ROSTER) {
  assert.equal(Number(finalWallets.get(actor).coins), 1000 - ENTRY + share.get(actor), `${actor}: still credited exactly once after the second worker`);
 }
});

/* ==================== 2. private room survives a restart with no leave and no handover ==================== */

test('V5-09-05: a private room survives a worker restart - still RUNNING, still host-owned, everyone still seated, and still live', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;

 const members = ROSTER.slice(0, 4);
 const host = members[0];
 const seated = await seatPrivateRoom(h, members, { name: 'Recovery Cup', format: 'mixed' }, 'private');
 const roomId = seated.roomId;

 /* CONFIGURE the format and clocks (a host-only command), which resets readiness and advances the
  * rules version - so the ready commands below must carry the NEW version. */
 const configured = await send(h, host, 'private-configure', { type: 'configure', id: roomId, format: 'knockout', clock: 120, increment: 1 });
 assert.equal(configured.format, 'knockout', 'the host configures the format');
 assert.equal(configured.clock, 120, 'the host configures the clock');
 assert.equal(configured.increment, 1, 'the host configures the increment');
 assert.equal(configured.rulesVersion, seated.rulesVersion + 1, 'configuring advances the rules version exactly once');
 assert.ok(configured.players.every((p) => p.ready === false), 'configuring resets readiness');

 for (const actor of members) {
  await send(h, actor, `private-ready-${actor}`, { type: 'ready', value: true, rulesVersion: configured.rulesVersion, id: roomId });
 }
 const started = await send(h, host, 'private-start', { type: 'start', id: roomId });
 assert.equal(started.status, 'RUNNING', 'the seated, ready private room starts');
 assert.equal(started.owner, host, 'the host owns the running room');
 assert.equal(started.players.length, 4, 'all four players are seated');
 assert.ok(started.fixtures.length >= 3, 'a four-player knockout exposes its bracket');

 /* WORKER RESTART. */
 const workerA = h.service;
 const before = plain(await workerA.getRoom(roomId));
 h.restart();
 assert.notEqual(h.service, workerA, 'the restart really boots a NEW service instance');
 const after = plain(await h.service.getRoom(roomId));

 /* A RESTART IS NOT A LEAVE: the room is not CANCELLED, ownership did not move and nobody was removed. */
 assert.deepEqual(after, before, 'the whole private room document is byte-identical across the restart');
 assert.equal(after.status, 'RUNNING', 'the restarted worker does NOT cancel a running private room');
 assert.notEqual(after.status, 'CANCELLED', 'a restart is never mistaken for a member leaving');
 assert.equal(after.owner, host, 'ownership remains with the original host - no unexpected handover');
 assert.equal(after.players.length, 4, 'no player is dropped by the restart');
 assert.deepEqual(ids(after.players), members, 'every player remains seated in join order');
 assert.ok(after.players.every((p) => p.ready === true), 'every player is still ready');
 assert.equal(after.revision, before.revision, 'the restart advances no revision');
 assert.equal(after.started, before.started, 'the start instant is unchanged');
 assert.equal(after.deadline, before.deadline, 'the event deadline is unchanged');
 assert.deepEqual(after.fixtures, before.fixtures, 'the bracket survives the restart intact');
 assert.equal(after.format, 'knockout', 'the configured format survives');
 assert.equal(after.clock, 120, 'the configured clock survives');
 assert.equal(after.increment, 1, 'the configured increment survives');

 const durable = await roomRow(h, roomId);
 assert.equal(durable.status, 'RUNNING', 'the committed status is still RUNNING');
 assert.equal(durable.owner_id, host, 'the committed owner is still the original host');
 assert.equal(durable.seated, 4, 'the committed roster still holds every player');
 assert.ok((await h.service.activeRooms()).some((r) => String(r.id) === roomId), 'the recovered room is still active');

 /* The recovered room is LIVE: a guest readies its first fixture on the FRESH worker. */
 const fixture = after.fixtures.find((f) => f.status === 'READY');
 assert.ok(fixture, 'the recovered bracket exposes a READY fixture to play');
 h.at(Math.max(h.now(), fixture.opens));
 const accepted = await send(h, fixture.players[1], 'private-accept', { type: 'matchReady', id: roomId, fixture: fixture.id });
 const ready = accepted.fixtures.find((f) => f.id === fixture.id);
 assert.equal(ready.status, 'READY', 'one acceptance leaves the fixture awaiting its opponent');
 assert.deepEqual(ready.ready, [fixture.players[1]], 'the accepting guest is recorded on the recovered fixture');
 assert.equal(accepted.status, 'RUNNING', 'the recovered room is still running after the guest command');
});

/* ================= 3. no lost escrow and no duplicate refund on a voided public table ================= */

test('V5-09-05: a public table voided mid-tournament refunds every entry exactly once, across a worker restart and on retry', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;

 const { view: started, roomId } = await seatPublicTable(h);

 /* Genuinely MID-TOURNAMENT: play a few fixtures through the command surface first. */
 const partial = await playOut(h, started, { max: 3 });
 assert.equal(partial.steps, 3, 'three fixtures are played before the void');
 assert.equal(partial.replays, 3, 'each of those commands was duplicate-delivered');
 assert.equal(partial.view.status, 'RUNNING', 'the table is still running when it is voided');
 assert.equal(partial.view.escrow, POOL, 'the whole pool is still in escrow when it is voided');

 /* The operator voids the running public table: the approved VOID + CANCELLED transition. The
  * operator principal is SEATED at the table (a player acting with operator scope), so a same-key
  * replay still finds a member and reads the stored response back verbatim. */
 const OPERATOR = ROSTER[0];
 const voided = await send(h, OPERATOR, 'void-1', { type: 'cancel', id: roomId }, 'operator');
 assert.equal(voided.status, 'VOID', 'the operator voids the running table');
 assert.equal(voided.reason, 'CANCELLED', 'the void records the approved reason');
 assert.equal(voided.settled, true, 'the void is settled in the same transaction');
 assert.equal(voided.escrow, 0, 'the void is settled');
 assert.equal(voided.receipt.refunded, true, 'the settlement is a refund');
 assert.equal(voided.receipt.burn, 0, 'a refund burns nothing');
 assert.equal(voided.receipt.pool, POOL, 'the receipt names the whole refunded pool');
 assert.equal(voided.receipt.payouts.length, 10, 'every entrant is refunded');
 assert.ok(voided.receipt.payouts.every((p) => p.amount === ENTRY), 'every entrant gets back exactly the entry fee');
 assert.equal(voided.receipt.payouts.reduce((sum, p) => sum + p.amount, 0), POOL, '100% of the entry fees are refunded');
 const refundNotice=await settlementEvent(h,roomId);
 assert.ok(refundNotice,'in-command VOID/refund must atomically enqueue a settlement notification');
 assert.equal(refundNotice.kind,'tournament.settle');
 assert.equal(refundNotice.state,'queued');
 assert.equal(JSON.parse(refundNotice.payload).refunded,true);
 assert.equal(JSON.parse(refundNotice.payload).roomId,roomId);

 const refunds = await ledgerOf(h, roomId, 'refund');
 assert.equal(refunds.length, 10, 'exactly one refund entry per entrant');
 assert.equal(new Set(refunds.map((r) => r.entry_id)).size, 10, 'every refund entry id is unique');
 for (const entry of refunds) {
  assert.equal(entry.entry_id, `${roomId}:refund:${entry.actor_id}`, 'the refund entry id names the room and actor');
  assert.equal(Number(entry.amount), ENTRY, `${entry.actor_id}: refunded exactly the entry fee`);
 }
 assert.equal(refunds.reduce((sum, r) => sum + Number(r.amount), 0), POOL, 'ZERO LOST ESCROW: the ledger refunds the whole pool');

 /* WORKER RESTART during the VOID: the committed refund is the recovered truth. */
 const workerA = h.service;
 const before = plain(await workerA.getRoom(roomId));
 h.restart();
 assert.notEqual(h.service, workerA, 'the restart really boots a NEW service instance');
 const after = plain(await h.service.getRoom(roomId));
 assert.deepEqual(after, before, 'the voided room is byte-identical across the restart');
 assert.equal(after.status, 'VOID', 'the recovered room is still voided');
 assert.equal(after.reason, 'CANCELLED', 'the void reason survives');
 assert.equal(after.settled, true, 'the committed settlement survives the restart');
 assert.equal(after.escrow, 0, 'the escrow is still zero after the restart');
 assert.deepEqual(plain(after.receipt), plain(voided.receipt), 'the committed refund receipt survives the restart');

 let wallets = await walletMap(h);
 for (const actor of ROSTER) {
  assert.equal(Number(wallets.get(actor).reserved_coins), 0, `${actor}: the reservation is released`);
  assert.equal(Number(wallets.get(actor).coins), 1000, `${actor}: the entry fee is refunded in full`);
 }
 assert.equal(Number((await burnsOf(h)).coins), 0, 'a refund burns nothing');
 assert.equal((await occupancyOf(h, roomId)).length, 0, 'the refund releases every occupancy claim');
 assert.equal((await recordsOf(h)).reduce((sum, r) => sum + Number(r.entered), 0), 0, 'a refund credits no placement record');
 const voidOutcome = await storedOutcome(h, OPERATOR, 'void-1');
 assert.deepEqual(voidOutcome.response, plain(voided), 'the stored outcome is the committed VOID response');

 /* RETRY, four ways, none of which may refund a second time. */
 const sameKey = await send(h, OPERATOR, 'void-1', { type: 'cancel', id: roomId }, 'operator');
 assert.deepEqual(sameKey, plain(voided), 'a same-key retry returns the stored VOID response verbatim');
 assert.equal(await outcomeCount(h, OPERATOR, 'void-1'), 1, 'the same-key retry writes no second outcome row');
 await lab.throwsCode(send(h, OPERATOR, 'void-2', { type: 'cancel', id: roomId }, 'operator'), 'EVENT_FINISHED');
 const recoveredWorker = await h.service.settle(roomId, { reason: 'CANCELLED' });
 assert.equal(recoveredWorker.settled, true, 'the standalone settlement worker observes the committed refund');
 assert.deepEqual(plain(recoveredWorker.receipt), plain(voided.receipt), 'it hands back the committed refund receipt');
 /* A plain player cannot void a public table at all - the approved rule keeps that operator-only -
  * and the operator's own key still holds exactly one outcome row. */
 await lab.throwsCode(send(h, ROSTER[9], 'void-outsider', { type: 'cancel', id: roomId }), 'HOST_ONLY');

 assert.equal((await ledgerOf(h, roomId, 'refund')).length, 10, 'no retry writes a second refund');
 assert.equal((await ledgerOf(h, roomId, 'payout')).length, 0, 'a refunded table never pays a prize');
 assert.equal(await outcomeCount(h, OPERATOR, 'void-1'), 1, 'no retry writes a second outcome row');
 assert.deepEqual(await settlementEvent(h,roomId),refundNotice,
  'restarted worker and repeated cancel cannot duplicate or rewrite refund delivery');
 wallets = await walletMap(h);
 for (const actor of ROSTER) {
  assert.equal(Number(wallets.get(actor).coins), 1000, `${actor}: still refunded exactly once`);
 }
 assert.equal(wallets.size, 10, 'every entrant keeps a wallet');
});

/* ========================= 4. duplicate delivery of every party command ========================= */

test('V5-09-05: duplicate delivery of every party command returns the stored outcome without a second side effect', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const [host, guest] = ROSTER;

 /* One command, delivered twice under the same (actor, key). The second delivery must hand back the
  * stored response verbatim, leave the committed revision untouched, and add no second outcome row. */
 const idem = async (actor, scope, key, command, label) => {
  const first = await send(h, actor, key, command, scope);
  const roomId = String(first.id ?? command.id);
  const committed = await revisionOf(h, roomId);
  const replay = await send(h, actor, key, command, scope);
  assert.deepEqual(replay, plain(first), `${label}: the duplicate delivery returns the stored response verbatim`);
  assert.equal(replay.revision, first.revision, `${label}: the duplicate delivery reports the committed revision`);
  assert.equal(await revisionOf(h, roomId), committed, `${label}: the duplicate delivery advances no durable state`);
  assert.equal(await outcomeCount(h, actor, key), 1, `${label}: exactly one outcome row holds the committed response`);
  return first;
 };

 /* create + join */
 const created = await idem(host, 'player', 'cmd-create', { type: 'create', name: 'Idempotent Cup', format: 'duel', clock: 180, increment: 2 }, 'create');
 const roomId = String(created.id);
 assert.equal(created.owner, host, 'the creator owns the room');
 const joined = await idem(guest, 'player', 'cmd-join', { type: 'join', id: roomId }, 'join');
 assert.deepEqual(ids(joined.players), [host, guest], 'both players are seated');

 /* A DIFFERENT command under a used key is a conflict, never a second effect. */
 await lab.throwsCode(send(h, guest, 'cmd-join', { type: 'ready', value: true, rulesVersion: joined.rulesVersion, id: roomId }),
  'IDEMPOTENCY_CONFLICT');
 assert.deepEqual((await h.service.getRoom(roomId)).players.map((p) => p.ready), [false, false],
  'the refused command under the used key changed nothing');

 /* configure + ready */
 const configured = await idem(host, 'player', 'cmd-configure', { type: 'configure', id: roomId, format: 'duel', clock: 120, increment: 1 }, 'configure');
 assert.equal(configured.clock, 120, 'the configured clock is durable');
 assert.equal(configured.increment, 1, 'the configured increment is durable');
 await idem(host, 'player', 'cmd-ready-host', { type: 'ready', value: true, rulesVersion: configured.rulesVersion, id: roomId }, 'ready(host)');
 const readied = await idem(guest, 'player', 'cmd-ready-guest', { type: 'ready', value: true, rulesVersion: configured.rulesVersion, id: roomId }, 'ready(guest)');
 assert.ok(readied.players.every((p) => p.ready === true), 'both players are ready');

 /* start */
 const started = await idem(host, 'player', 'cmd-start', { type: 'start', id: roomId }, 'start');
 assert.equal(started.status, 'RUNNING', 'the host starts the private room');
 assert.equal(started.fixtures.length, 1, 'a two-player duel is one fixture');
 const fixture = started.fixtures[0];
 h.at(Math.max(h.now(), fixture.opens));

 /* matchReady x2 puts the fixture in play */
 await idem(fixture.players[0], 'player', 'cmd-accept-a', { type: 'matchReady', id: roomId, fixture: fixture.id }, 'matchReady(0)');
 const playing = await idem(fixture.players[1], 'player', 'cmd-accept-b', { type: 'matchReady', id: roomId, fixture: fixture.id }, 'matchReady(1)');
 const live = playing.fixtures.find((f) => f.id === fixture.id);
 assert.equal(live.status, 'PLAYING', 'both acceptances put the fixture in play');
 assert.equal(live.state.moves.length, 0, 'the fixture is at the start of the game');

 /* move: a legal opening move by the player on turn, replayed under the same key */
 const mover = live.state.turn === 'X' ? live.players[0] : live.players[1];
 const moved = await idem(mover, 'player', 'cmd-move', { type: 'move', id: roomId, fixture: fixture.id, revision: 0, move: { b: 0, c: 0 } },
  'move');
 const afterMove = moved.fixtures.find((f) => f.id === fixture.id);
 assert.equal(afterMove.state.moves.length, 1, 'exactly ONE move is committed');
 assert.equal(afterMove.state.moves[0].b, 0, 'the committed move is the delivered one');
 assert.equal(afterMove.status, 'PLAYING', 'the opening move does not end the game');

 /* resign, which finishes the duel and completes the private room */
 const quitter = afterMove.players.find((p) => p !== mover);
 const resigned = await idem(quitter, 'player', 'cmd-resign', { type: 'resign', id: roomId, fixture: fixture.id }, 'resign');
 assert.equal(resigned.status, 'COMPLETE', 'resigning finishes the duel');
 assert.deepEqual(resigned.ranking, [mover, quitter], 'the player who did not resign wins and the quitter places second');

 /* The finished fixture holds exactly one move and one history entry - no replay ever added one. */
 const finalRow = await h.row('SELECT state_json, history_json, revision FROM tournament.fixtures WHERE room_id = $1 AND fixture_id = $2',
  [roomId, fixture.id]);
 assert.equal(finalRow.state_json.moves.length, 1, 'the durable fixture holds exactly one committed move');
 assert.equal(finalRow.history_json.length, 1, 'the durable history holds exactly one finished game');

 /* A private room never touches the escrow or the ledger; the replays must not have moved a balance
  * either, and no settlement record is invented for a room that never held escrow. */
 const wallets = await walletMap(h).then((map) => [host, guest].map((actor) => map.get(actor)));
 assert.ok(wallets.every((w) => Number(w.coins) === 1000 && Number(w.reserved_coins) === 0),
  'a private room leaves both wallets untouched');
 assert.equal((await ledgerOf(h, roomId, 'reserve')).length, 0, 'a private room reserves no entry');
 assert.equal((await ledgerOf(h, roomId, 'payout')).length, 0, 'a private room pays no tournament prize');
 const row = await roomRow(h, roomId);
 assert.equal(row.status, 'COMPLETE', 'the durable room is COMPLETE after the resign');
 assert.equal(row.settled, false, 'a private room never settles through the escrow path');
 assert.equal(Number(row.escrow), 0, 'a private room holds no escrow');
 assert.equal(row.receipt_json, null, 'a private room commits no settlement receipt');
 const settledAt = await h.service.view(roomId, host);
 assert.equal(settledAt.status, 'COMPLETE', 'the read-only view agrees with the committed terminal status');
});
