'use strict';
/* tests/v5-p09-persistence.test.js - V5 P09 task V5-09-01 (Persist complete room and fixture state).
 *
 * PostgreSQL is the durable authority for a tournament room: ownership, join code, roster and
 * readiness, rules lineage, the whole fixture graph (state/mini/clocks/banks/deadlines/revisions/
 * move timings), ranking, revisions, the quote, the per-actor escrow contributions and the
 * settlement receipt. This suite proves that a COMPLETE ten-player room survives a real service
 * restart with zero missing state: it builds a full room with the frozen pure rules
 * (`src/tournament.js`), persists it through `createTournamentService` onto a REAL owned loopback
 * PostgreSQL 16 migrated by the real checksummed chain, tears the service instance down, boots a
 * FRESH instance over the same durable database, and deep-compares the whole room document read
 * back against the snapshot captured before the restart.
 *
 * Four cases, each on its own owned database and its own service instance pair:
 *   1. a complete ten-player room (quote/entry/pool/burn/clock/increment/capacity/rulesVersion/
 *      format/table, full roster with readiness and ordinals, one escrow contribution per player
 *      matching entry/pool, and a twenty-fixture mixed graph) is written to PostgreSQL, asserted
 *      row-by-row on the durable tables;
 *   2. the FULL room snapshot read back after a restart is 100% deep-equal to the pre-restart
 *      snapshot - ownership, code, roster, readiness, rules, ranking, revisions, quote,
 *      contributions and receipt all survive;
 *   3. individual fixture state, mini boards, move timings and clock banks survive the restart
 *      intact (a fifteen-fixture knockout played to COMPLETE, every fixture carrying its own
 *      state/clock/bank/revision/timing history);
 *   4. escrow contributions and quote details survive the restart intact (per-actor amounts equal
 *      to the entry, their sum the pool, and the committed settlement receipt round-trips).
 *
 * The room/fixture builders below are DETERMINISTIC: the same source document is produced on every
 * run, so a pre/post-restart difference can only be a persistence defect, never fixture drift. The
 * moves are driven by a seeded LCG through the frozen Game rules, and gameplay never relies on the
 * host clock.
 *
 * Teardown is `lab.installCleanup` (drops the owned databases and closes the borrowed pools) plus a
 * per-test close of the service instances; Redis is not used by this task and none is borrowed. No
 * `process.exit`, no force-exit: the suite ends when its natural async work and its cleanup finish.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const T = require('../src/tournament.js');
const G = require('../src/game.js');

/* Closes every borrowed pool and drops every owned database, after the suites' own `t.after` closes
 * the service instances. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

/* --------------------------------------------------------------- environment */

const CLOCK = lab.CLOCK;

/* The tournament service is loaded lazily, so a checkout without the P09 module skips (rather than
 * throws at require time) when the gate is unset. */
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

const ROSTER = Object.freeze(['svc_p01', 'svc_p02', 'svc_p03', 'svc_p04', 'svc_p05',
 'svc_p06', 'svc_p07', 'svc_p08', 'svc_p09', 'svc_p10']);
const SEEDS = ROSTER.map((actor) => ({ actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' }));

/* A deterministic PRNG, so a played-out fixture graph is byte-identical on every run. */
function lcg(seed) {
 let s = seed >>> 0;
 return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s % 0x7fffffff) / 0x7fffffff; };
}
/* Deep copy of the source document, so a mutation by the service can never edit the local oracle. */
const clone = (value) => JSON.parse(JSON.stringify(value));
const roomIdOf = (value) => {
 if (typeof value === 'string') return value;
 if (!value || typeof value !== 'object') return null;
 return value.id ?? value.roomId ?? value.room_id ?? null;
};
/* The delivered room view. `getRoom` may hand back the room document directly or a thin envelope;
 * both name the same authority, so the test reads it without weakening the assertion. */
const roomView = (value) => (value && typeof value === 'object' && value.room && typeof value.room === 'object'
 && (value.room.id !== undefined || value.room.room_id !== undefined) ? value.room : value);
const idOf = (room) => String(room.id ?? room.room_id);

/* ---------------------------------------------------------------- builders */

/* The canonical ten-player MIXED room: the low table (quote/entry 100/pool 1000/burn 100), a
 * 120 s clock with a 1 s increment, capacity 10 and rules version 1, a full ready roster in join
 * order, and the twenty group fixtures the frozen round-robin schedule produces. One group fixture
 * is played into a genuine PLAYING state and one is finished, so the persisted graph carries
 * BLOCKED, READY, PLAYING and DONE fixtures. `fixture.revision` is set to the fixture's own move
 * count, proving a NON-ZERO per-fixture revision round-trips. */
function buildMixedRoom({ settled = false, id = 'room:p09mixed' } = {}) {
 const quote = T.prize('low');
 const room = T.create({ id, code: 'PERSISTM', owner: ROSTER[0], name: 'Persistence Cup',
  format: 'mixed', table: 'low', now: CLOCK });
 ROSTER.forEach((actor, i) => T.join(room, actor, `Player ${i + 1}`, CLOCK + i + 1));
 ROSTER.forEach((actor) => T.ready(room, actor, true, room.rulesVersion, CLOCK + 100));
 T.start(room, ROSTER[0], ROSTER.slice(), CLOCK + 200);

 const clock = { t: CLOCK + 20000 };
 const random = lcg(0x5eed01);
 /* Drive the first two READY fixtures: finish the first (resign after a real move sequence) and
  * leave the second mid-game, so both a DONE and a PLAYING fixture exist. */
 const playable = room.fixtures.filter((f) => f.status === 'READY').sort((a, b) => a.opens - b.opens);
 for (let n = 0; n < 2 && n < playable.length; n += 1) {
  const fixture = playable[n];
  if (clock.t < fixture.opens) clock.t = fixture.opens;
  T.readyGame(room, fixture.id, fixture.players[0], clock.t); clock.t += 250;
  T.readyGame(room, fixture.id, fixture.players[1], clock.t); clock.t += 250;
  const moves = n === 0 ? 4 : 2;
  for (let i = 0; i < moves; i += 1) {
   const actor = fixture.players[fixture.state.turn === 'X' ? 0 : 1];
   const legal = G.legal(fixture.state);
   T.move(room, fixture.id, actor, fixture.state.moves.length, legal[Math.floor(random() * legal.length)], clock.t);
   clock.t += 1500;
  }
  if (n === 0) {
   T.resign(room, fixture.id, fixture.players[fixture.state.turn === 'X' ? 0 : 1], clock.t);
   clock.t += 250;
  }
 }
 /* A genuine per-fixture revision: the fixture revision IS its move count (spec: fixture revision =
  * state.moves.length). Persisting a non-zero value proves the column round-trips. */
 for (const fixture of room.fixtures) fixture.revision = fixture.state ? fixture.state.moves.length : 0;

 /* One escrow contribution per player, each exactly the entry; the sum is the pool. */
 room.contributions = ROSTER.map((actor) => ({ id: actor, amount: quote.entry }));
 room.escrow = quote.pool;

 if (settled) {
  room.ranking = ROSTER.slice();
  room.settled = true;
  room.settledAt = clock.t;
  room.receipt = {
   currency: quote.currency, pool: quote.pool, burn: quote.burn, refunded: false,
   payouts: ROSTER.map((actor, i) => ({ id: actor, amount: Math.round((quote.pool * T.SHARES[i]) / 100) })),
  };
 }
 return room;
}

/* The canonical ten-player KNOCKOUT room: the high table (quote 1200/pool 12000/burn 1200), played
 * to COMPLETE through the frozen rules. Every one of the fifteen bracket fixtures carries its own
 * state, mini board, clock bank, move timings and a DISTINCT revision, and the room carries the
 * final ranking and settlement receipt. */
function buildKnockoutRoom({ id = 'room:p09ko' } = {}) {
 const quote = T.prize('high');
 const room = T.create({ id, code: 'PERSISTK', owner: ROSTER[0], name: 'Settled Knockout',
  format: 'knockout', clock: 120, increment: 3, now: CLOCK });
 ROSTER.forEach((actor, i) => T.join(room, actor, `Player ${i + 1}`, CLOCK + i + 1));
 ROSTER.forEach((actor) => T.ready(room, actor, true, room.rulesVersion, CLOCK + 100));
 T.start(room, ROSTER[0], ROSTER.slice(), CLOCK + 200);

 const clock = { t: CLOCK + 20000 };
 const random = lcg(0x5eed02);
 let guard = 0;
 while (room.status === 'RUNNING' && guard < 500) {
  guard += 1;
  const due = room.fixtures
   .filter((f) => f.status === 'READY' && clock.t >= f.opens && clock.t < f.expires)
   .sort((a, b) => a.opens - b.opens)[0];
  if (!due) {
   const next = room.fixtures.filter((f) => f.status === 'READY').sort((a, b) => a.opens - b.opens)[0];
   if (!next) break;
   clock.t = next.opens;
   continue;
  }
  T.readyGame(room, due.id, due.players[0], clock.t); clock.t += 100;
  T.readyGame(room, due.id, due.players[1], clock.t); clock.t += 100;
  /* A short, draw-free burst, then resign: the bracket advances deterministically without ever
   * risking the three-draw PAUSE/VOID branch. */
  const burst = 2 + (guard % 5);
  for (let i = 0; i < burst; i += 1) {
   const actor = due.players[due.state.turn === 'X' ? 0 : 1];
   const legal = G.legal(due.state);
   T.move(room, due.id, actor, due.state.moves.length, legal[Math.floor(random() * legal.length)], clock.t);
   clock.t += 700;
  }
  if (due.status === 'PLAYING') {
   T.resign(room, due.id, due.players[due.state.turn === 'X' ? 0 : 1], clock.t);
   clock.t += 100;
  }
 }
 for (const fixture of room.fixtures) fixture.revision = fixture.state ? fixture.state.moves.length : 0;

 room.contributions = ROSTER.map((actor) => ({ id: actor, amount: quote.entry }));
 room.escrow = quote.pool;
 room.ranking = room.ranking || ROSTER.slice();
 room.settled = true;
 room.settledAt = clock.t;
 room.receipt = {
  currency: quote.currency, pool: quote.pool, burn: quote.burn, refunded: false,
  payouts: room.ranking.map((actor, i) => ({ id: actor, amount: Math.round((quote.pool * T.SHARES[i]) / 100) })),
 };
 return room;
}

/* One owned database, its guarded pools, a real Core service, one live tournament service bound to
 * the core_runtime pool, and a controllable (frozen) clock. `t.after` closes the service; the SAME
 * pool survives a restart, because the service never owns it. No Redis is borrowed: persisting a
 * room must never depend on ephemeral coordination. */
let dbSeq = 0;
async function open(t) {
 if (!(await lab.boot(t))) return null;
 const create = loadTournamentFactory();
 const database = await lab.createDatabase(`p09p${dbSeq++}`);
 await lab.seedActors(database, SEEDS);
 const pools = lab.poolsFor(database);
 const now = () => CLOCK;
 const core = await lab.coreFor(database, { clock: now });
 const service = create({ pool: pools.core, core, now });
 const services = [service];
 t.after(async () => {
  for (const instance of services) { try { await instance.close(); } catch { /* best effort */ } }
  try { await core.close(); } catch { /* best effort */ }
 });
 const rows = async (text, params = []) => (await pools.core.query(text, params)).rows;
 const row = async (text, params = []) => (await rows(text, params))[0] ?? null;
 /* A fresh instance over the SAME durable database, exactly what a restarted process is. */
 const restart = () => { const instance = create({ pool: pools.core, core, now }); services.push(instance); return instance; };
 return { database, pools, core, service, restart, now, rows, row };
}

/* Persist the complete room document: createRoom establishes the room identity, saveRoom commits the
 * room row together with its roster, escrow contributions and fixtures. */
async function persist(h, room) {
 const created = roomView(await h.service.createRoom(room));
 const createdId = roomIdOf(created);
 if (createdId !== null) assert.equal(String(createdId), room.id, 'createRoom returns the id it created');
 const saved = roomView(await h.service.saveRoom(room));
 const savedId = roomIdOf(saved);
 if (savedId !== null) assert.equal(String(savedId), room.id, 'saveRoom returns the id it saved');
 return room.id;
}

/* ================================================= 1. complete room persisted == */

test('V5-09-01: a complete ten-player room (quote, roster, contributions, twenty fixtures) is persisted to PostgreSQL', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const room = buildMixedRoom();
 await persist(h, room);

 /* ROOM ROW: ownership, code, name, format, table, rules and every clock/capacity/quote fact. */
 const stored = await h.row(
  'SELECT room_id, code, owner_id, name, format, table_kind, sequential, entry, pool, burn,'
  + ' clock_seconds, increment_seconds, capacity, rules_version, status, revision, quote_json,'
  + ' quote_currency, escrow, settled FROM tournament.rooms WHERE room_id = $1', [room.id]);
 assert.ok(stored, 'the room row is committed');
 assert.equal(stored.code, 'PERSISTM');
 assert.equal(stored.owner_id, ROSTER[0]);
 assert.equal(stored.name, room.name);
 assert.equal(stored.format, 'mixed');
 assert.equal(stored.table_kind, 'low');
 assert.equal(stored.sequential, false);
 assert.equal(Number(stored.entry), room.quote.entry, 'the entry is persisted');
 assert.equal(Number(stored.pool), room.quote.pool, 'the pool is persisted');
 assert.equal(Number(stored.burn), room.quote.burn, 'the burn is persisted');
 assert.equal(Number(stored.clock_seconds), room.clock, 'the clock is persisted');
 assert.equal(Number(stored.increment_seconds), room.increment, 'the increment is persisted');
 assert.equal(Number(stored.capacity), room.capacity, 'the capacity is persisted');
 assert.equal(Number(stored.rules_version), room.rulesVersion, 'the rules version is persisted');
 assert.equal(stored.status, room.status, 'the room status is persisted');
 assert.equal(Number(stored.revision), room.revision, 'the room revision is persisted');
 assert.equal(stored.quote_currency, room.quote.currency);
 assert.deepEqual(stored.quote_json, room.quote, 'the whole quote document is persisted verbatim');
 assert.equal(Number(stored.escrow), room.escrow, 'the escrow total is persisted');
 assert.equal(stored.settled, false);

 /* ROSTER: ten players, readiness true, in join order (ordinal). */
 const players = await h.rows('SELECT actor_id, name, ready, withdrawn, ordinal FROM tournament.room_players WHERE room_id = $1 ORDER BY ordinal', [room.id]);
 assert.equal(players.length, 10, 'all ten players are persisted');
 assert.deepEqual(players.map((p) => p.actor_id), ROSTER, 'the roster order (ordinal) is preserved');
 assert.deepEqual(players.map((p) => p.ordinal), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
 assert.ok(players.every((p) => p.ready === true && p.withdrawn === false), 'every player is ready and none withdrawn');
 assert.deepEqual(players.map((p) => p.name), room.players.map((p) => p.name));

 /* CONTRIBUTIONS: one per player, each the entry, summing to the pool. */
 const contributions = await h.rows('SELECT actor_id, amount FROM tournament.escrow_contributions WHERE room_id = $1 ORDER BY actor_id', [room.id]);
 assert.equal(contributions.length, 10, 'all ten escrow contributions are persisted');
 assert.ok(contributions.every((c) => Number(c.amount) === room.quote.entry), 'each contribution equals the entry');
 assert.equal(contributions.reduce((sum, c) => sum + Number(c.amount), 0), room.escrow, 'the contributions sum to the escrow/pool');

 /* FIXTURES: the whole twenty-fixture mixed graph, with a non-zero per-fixture revision. */
 const fixtures = await h.rows('SELECT fixture_id, status, revision FROM tournament.fixtures WHERE room_id = $1 ORDER BY fixture_id', [room.id]);
 assert.equal(fixtures.length, 20, 'all twenty mixed fixtures are persisted');
 assert.equal(fixtures.filter((f) => f.status === 'DONE').length, 1, 'the finished fixture is DONE');
 assert.equal(fixtures.filter((f) => f.status === 'PLAYING').length, 1, 'the in-progress fixture is PLAYING');
 assert.ok(fixtures.some((f) => f.status === 'READY') && fixtures.some((f) => f.status === 'BLOCKED'), 'both READY and BLOCKED fixtures are persisted');
 assert.ok(fixtures.some((f) => Number(f.revision) > 0), 'at least one fixture carries a non-zero revision');
});

/* ============================================ 2. full snapshot survives restart == */

test('V5-09-01: the FULL room snapshot read back after a service restart is deep-equal to the pre-restart snapshot', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const room = buildMixedRoom({ id: 'room:p09restart' });
 await persist(h, room);

 const before = clone(roomView(await h.service.getRoom(room.id)));
 assert.ok(before && before.id, 'the committed room reads back before the restart');
 assert.equal(idOf(before), room.id);

 /* The delivered view already carries the WHOLE source document: ownership, code, roster with
  * readiness, rules, quote, contributions and the twenty-fixture graph. */
 assert.equal(before.owner, room.owner, 'ownership is present before the restart');
 assert.equal(before.code, room.code, 'the join code is present before the restart');
 assert.deepEqual(before.players, room.players, 'the full roster is present before the restart');
 assert.deepEqual(before.contributions, room.contributions, 'the contributions are present before the restart');
 assert.deepEqual(before.quote, room.quote, 'the quote is present before the restart');
 assert.equal(before.fixtures.length, 20, 'the whole fixture graph is present before the restart');

 /* RESTART: close the live instance and boot a fresh one over the same database. */
 await h.service.close();
 const rebooted = h.restart();
 const after = clone(roomView(await rebooted.getRoom(room.id)));

 /* 100% deep-equal: every room field, the roster, the contributions and all twenty fixtures. */
 assert.deepEqual(after, before, 'the room snapshot is byte-identical across the restart');

 /* Targeted assertions on the named dimensions, so a failure names WHAT was lost. */
 assert.equal(after.owner, room.owner, 'ownership survives');
 assert.equal(after.code, room.code, 'the join code survives');
 assert.equal(after.name, room.name, 'the room name survives');
 assert.equal(after.format, room.format, 'the format survives');
 assert.equal(after.table, room.table, 'the table survives');
 assert.equal(after.rulesVersion, room.rulesVersion, 'the rules version survives');
 assert.equal(after.revision, room.revision, 'the room revision survives');
 assert.equal(after.capacity, room.capacity, 'the capacity survives');
 assert.equal(after.clock, room.clock, 'the clock survives');
 assert.equal(after.increment, room.increment, 'the increment survives');
 assert.equal(after.status, room.status, 'the room status survives');
 assert.deepEqual(after.players, room.players, 'the full roster (with readiness) survives');
 assert.equal(after.players.length, 10, 'no player is lost across the restart');
 assert.deepEqual(after.contributions, room.contributions, 'the contributions survive');
 assert.deepEqual(after.quote, room.quote, 'the quote survives');
 assert.deepEqual(after.fixtures, before.fixtures, 'the fixture graph survives the restart');
 assert.equal(after.fixtures.length, 20, 'no fixture is lost across the restart');
});

/* ================================== 3. fixture state, mini, timings, clocks == */

test('V5-09-01: individual fixture state, mini boards, move timings and clock banks survive the restart intact', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const room = buildKnockoutRoom({ id: 'room:p09fixtures' });
 assert.equal(room.status, 'COMPLETE', 'the knockout plays to COMPLETE deterministically');
 assert.equal(room.fixtures.length, 15, 'a ten-player knockout bracket is fifteen fixtures');
 await persist(h, room);

 const before = clone(roomView(await h.service.getRoom(room.id)));
 await h.service.close();
 const after = clone(roomView(await h.restart().getRoom(room.id)));

 /* The fixture ARRAY as a whole is deep-equal ... */
 assert.deepEqual(after.fixtures, before.fixtures, 'the whole fixture array survives the restart');
 assert.equal(after.fixtures.length, 15, 'no fixture is lost');

 /* ... and every individual field the assignment names round-trips, fixture by fixture. */
 const byId = new Map(after.fixtures.map((f) => [f.id, f]));
 for (const fixture of before.fixtures) {
  const got = byId.get(fixture.id);
  assert.ok(got, `fixture ${fixture.id} survives`);
  assert.equal(got.status, fixture.status, `fixture ${fixture.id} status survives`);
  assert.deepEqual(got.state, fixture.state, `fixture ${fixture.id} mini board state survives`);
  assert.deepEqual(got.mini, fixture.mini, `fixture ${fixture.id} mini totals survive`);
  assert.deepEqual(got.banks, fixture.banks, `fixture ${fixture.id} clock banks survive`);
  assert.deepEqual(got._moveTimings, fixture._moveTimings, `fixture ${fixture.id} move timings survive`);
  assert.equal(got._lastMoveAt, fixture._lastMoveAt, `fixture ${fixture.id} last-move instant survives`);
  assert.equal(got.turnAt, fixture.turnAt, `fixture ${fixture.id} turn deadline survives`);
  assert.equal(got.revision, fixture.revision, `fixture ${fixture.id} revision survives`);
  assert.equal(got.opens, fixture.opens, `fixture ${fixture.id} open instant survives`);
  assert.equal(got.expires, fixture.expires, `fixture ${fixture.id} expiry survives`);
  assert.equal(got.finished, fixture.finished, `fixture ${fixture.id} finish instant survives`);
  assert.deepEqual(got.history, fixture.history, `fixture ${fixture.id} history survives`);
 }
 assert.ok(after.fixtures.every((f) => f.status === 'DONE'), 'every knockout fixture finished');
 assert.equal(new Set(after.fixtures.map((f) => f.revision)).size > 1, true, 'the per-fixture revisions are distinct, not a constant');
 assert.ok(after.fixtures.some((f) => Object.keys(f.banks || {}).length === 2), 'at least one fixture carries both players clock banks');
 assert.ok(after.fixtures.some((f) => (f._moveTimings || []).length > 0), 'at least one fixture carries a move-timing record');
});

/* ============================================ 4. escrow, quote and receipt == */

test('V5-09-01: escrow contributions, the quote and the settlement receipt survive the restart intact', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const room = buildMixedRoom({ settled: true, id: 'room:p09escrow' });
 await persist(h, room);

 const before = clone(roomView(await h.service.getRoom(room.id)));
 await h.service.close();
 const after = clone(roomView(await h.restart().getRoom(room.id)));

 /* Escrow total, per-actor contributions and the quote: unchanged and internally consistent. */
 assert.equal(after.escrow, before.escrow, 'the escrow total survives');
 assert.equal(after.escrow, room.quote.pool, 'the escrow total still equals the pool');
 assert.deepEqual(after.contributions, before.contributions, 'every contribution survives, byte-identical');
 assert.equal(after.contributions.length, 10, 'no contribution is lost');
 assert.ok(after.contributions.every((c) => c.amount === room.quote.entry), 'each contribution still equals the entry');
 assert.equal(after.contributions.reduce((sum, c) => sum + c.amount, 0), after.escrow, 'the contributions still sum to the escrow');
 assert.deepEqual(after.quote, before.quote, 'the quote document survives, byte-identical');
 assert.equal(after.quote.currency, room.quote.currency);
 assert.equal(after.quote.entry, room.quote.entry);
 assert.equal(after.quote.pool, room.quote.pool);
 assert.equal(after.quote.burn, room.quote.burn);

 /* The committed settlement record: settled flag and receipt. The settled instant is a durable
  * column the delivered view does not always project, so it is asserted on the row itself below. */
 assert.equal(after.settled, true, 'the settlement flag survives');
 assert.deepEqual(after.receipt, before.receipt, 'the settlement receipt survives, byte-identical');
 assert.deepEqual(after.receipt, room.receipt);
 assert.equal(after.receipt.currency, 'coins');
 assert.equal(after.receipt.pool, room.quote.pool);
 assert.equal(after.receipt.burn, room.quote.burn);
 assert.equal(after.receipt.payouts.length, 10, 'every payout line survives');
 assert.equal(after.receipt.payouts.reduce((sum, p) => sum + p.amount, 0), room.quote.pool - room.quote.burn,
  'the payout lines still sum to pool minus burn');

 /* The durable rows agree with the delivered view, including the settlement instant. */
 const row = await h.row('SELECT escrow, settled, settled_at, receipt_json FROM tournament.rooms WHERE room_id = $1', [room.id]);
 assert.equal(Number(row.escrow), room.escrow);
 assert.equal(row.settled, true);
 assert.equal(new Date(row.settled_at).getTime(), room.settledAt, 'the settlement instant survives');
 assert.deepEqual(row.receipt_json, room.receipt);
 const total = await h.row('SELECT count(*)::int AS n, sum(amount)::bigint AS total FROM tournament.escrow_contributions WHERE room_id = $1', [room.id]);
 assert.equal(Number(total.n), 10);
 assert.equal(Number(total.total), room.escrow);
});
