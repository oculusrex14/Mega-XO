'use strict';
/* tests/v5-p09-lifecycle.test.js - V5 P09 task V5-09-02 (Preserve user lifecycle behavior).
 *
 * SCOPE. Drives the durable lifecycle command surface of `packages/services/tournaments.js`
 * (`createTournamentService({ pool, now })` -> `run(principal, key, command)` / `view(roomId, actor)`)
 * against the REAL owned PostgreSQL 16 lab (`tests/v5-pg-lab.js`) over the REAL checksummed migration
 * chain. Every command travels the SAME durable transaction boundary the persistence layer uses
 * (`uow.run` -> `tournament.rooms`/`room_players`/`escrow_contributions`/`fixtures`/
 * `command_outcomes` plus the economy entities an approved public table owns). No mock, no SQLite, no
 * in-memory fake, no invented rule: each transition is the frozen `src/tournament.js` one, and the
 * assertions read the committed PostgreSQL rows back.
 *
 * What the suite proves (the approved V4 `RoomStore` behavior, preserved):
 *
 *   1. HOST-LEAVE CANCELS A LOBBY, GUEST-LEAVE DOES NOT. The host leaving a LOBBY room transitions it
 *      to CANCELLED; a guest leaving is simply removed from the roster and the room stays LOBBY.
 *      Asserted on both the delivered `T.view` DTO and the committed `tournament.rooms` row.
 *   2. TRANSFER MOVES OWNERSHIP INSIDE THE LOBBY. The host hands `owner` to a seated player; the new
 *      owner is durable, the old host REMAINS a player, the revision advances, and every non-host or
 *      non-member transfer is HOST_ONLY.
 *   3. PAUSE FREEZES THE CLOCKS AND RESUME UNFREEZES THEM WITHOUT A TIME GIFT. A RUNNING private room
 *      pauses to PAUSED with a real PLAYING fixture whose remaining clock does not move while wall
 *      time passes; resume returns to RUNNING with the SAME remaining clock (the pause is credited
 *      back, nothing is gifted) and the clock then runs down again.
 *   4. PUBLIC TABLE RULES. A public table holds ten seats, needs exactly ten ready players to start,
 *      starts AUTOMATICALLY (a manual `start` is AUTOMATIC_START_ONLY), enforces the 200-Elo cohort
 *      cap at matchmaking selection AND again at reserve time (SKILL_WINDOW_CHANGED, with a complete
 *      rollback), and reserves one entry per seat into escrow.
 *   5. NORMAL-ELO INDEPENDENCE. Playing a public tournament to COMPLETE through the command surface
 *      writes `economy.tournament_records` (entered / wins / finishSum), pays the approved pool, burns
 *      the approved burn - and leaves every `economy.ratings` row byte-identical: rating, peak,
 *      casual_rating, games, casual_games, tier and both instants are 100% unchanged.
 *
 * CLOCK. The service clock is injected, so every test controls time exactly: `h.at(ms)` moves it,
 * `h.now()` reads it. Nothing here waits on wall time or on a timer to become correct.
 *
 * GATING (the repo convention): needs the owned PostgreSQL lab (`V5_PG_URL`, or `V5_PG_REQUIRED=1` to
 * fail instead of skip). Absent it, every test skips. Teardown is the lab's `installCleanup` (guarded
 * pools closed, owned databases dropped) plus a per-test `t.after` that closes the service instance;
 * services close naturally and there is no force-exit.
 *
 *   env V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
 *       node --test --test-concurrency=1 tests/v5-p09-lifecycle.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');

/* Closes every borrowed pool and drops every owned database, after the suite's own `t.after` closes
 * the service instances. */
lab.installCleanup(test);

const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_PG ? false : 'no V5_PG_URL';

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

/* One distinct actor per seat. Every test owns its database (a fresh `createDatabase` per `open`), so
 * the same roster is reused across tests without any cross-test contamination. */
const ROSTER = Object.freeze(Array.from({ length: 10 }, (_, i) => `svc_l09${String(i + 1).padStart(2, '0')}`));
const OUTSIDER = 'svc_l0911';

/* The account seed the lab writes: verified, ten-plus games, affordable entry. `rating` is the only
 * dimension a test ever varies. */
const seedsFor = (actors, ratings = {}) => actors.map((actor) => ({
 actor, coins: 1000, crowns: 100, rating: ratings[actor] === undefined ? 1500 : ratings[actor], games: 30, stats: 'friends',
}));
/* The player principal the authentication layer hands the command boundary. */
const principal = (actor) => ({ actor, scope: 'player', name: actor });
const send = (h, actor, key, command) => h.service.run(principal(actor), key, command);
const ids = (players) => players.map((p) => p.id);

/* One owned database, its guarded core pool, one live tournament service and a controllable clock.
 * `t.after` closes the service; the pool is caller-owned and outlives it. */
let dbSeq = 0;
async function open(t, actors = ROSTER, ratings = {}) {
 if (!(await lab.boot(t))) return null;
 const create = loadTournamentFactory();
 const database = await lab.createDatabase(`p09l${dbSeq++}`);
 await lab.seedActors(database, seedsFor(actors, ratings));
 const pools = lab.poolsFor(database);
 let clock = CLOCK;
 const service = create({ pool: pools.core, now: () => clock });
 t.after(async () => { try { await service.close(); } catch { /* best effort */ } });
 const rows = async (text, params = []) => (await pools.core.query(text, params)).rows;
 const row = async (text, params = []) => (await rows(text, params))[0] ?? null;
 return {
  database, pools, service, rows, row,
  now: () => clock,
  /* Absolute and relative clock control; the injected clock is the ONLY time source. */
  at: (ms) => { clock = ms; return clock; },
  advance: (ms) => { clock += ms; return clock; },
 };
}

/* A private room seated with `actors` (the host first) and fully ready - the shape `create` + `join`
 * + `ready` produces, driven only through the approved command surface. */
async function seatPrivateRoom(h, actors, command, keyBase) {
 const host = actors[0];
 const created = await send(h, host, `${keyBase}-create`, { ...command, type: 'create' });
 assert.equal(created.status, 'LOBBY', 'a created room starts in the lobby');
 assert.deepEqual(ids(created.players), [host], 'the host is the only initial member');
 const rulesVersion = created.rulesVersion;
 let view = created;
 for (const actor of actors.slice(1)) {
  view = await send(h, actor, `${keyBase}-join-${actor}`, { type: 'join', id: created.id });
 }
 assert.deepEqual(ids(view.players), actors, `all ${actors.length} players are seated in join order`);
 for (const actor of actors) {
  view = await send(h, actor, `${keyBase}-ready-${actor}`, { type: 'ready', value: true, rulesVersion, id: created.id });
 }
 assert.ok(view.players.every((p) => p.ready === true), 'every seated player is ready');
 return { view, roomId: created.id, rulesVersion };
}

/* Play a RUNNING public table to its terminal state through the command surface only. The frozen
 * rules accept a resign on a READY fixture, so ONE command finishes each fixture - no game engine, no
 * synthetic room document. The clock is advanced to each due fixture's own `opens` instant, and a
 * fresh idempotency key is used per command. The LAST command is returned verbatim so a test can
 * replay it (same principal, same key, same payload) against the committed outcome. */
async function playOut(h, view, { guard = 200 } = {}) {
 let state = view;
 let steps = 0;
 let last = null;
 while (state.status === 'RUNNING' && steps < guard) {
  const ready = state.fixtures.filter((f) => f.status === 'READY');
  if (!ready.length) break;
  const due = ready.reduce((a, b) => (a.opens <= b.opens ? a : b));
  h.at(Math.max(h.now(), due.opens));
  steps += 1;
  const actor = due.players[0];
  const command = { type: 'resign', id: String(state.id), fixture: due.id };
  const key = `ko-${steps}`;
  state = await send(h, actor, key, command);
  last = { actor, key, command, fixtureId: due.id };
 }
 return { view: state, steps, last };
}

/* ================================= 1. host-leave cancels / guest-leave does not == */

test('V5-09-02: the host leaving a LOBBY room cancels it; a guest leaving is removed and the room stays LOBBY', { skip: GATE }, async (t) => {
 const h = await open(t, ROSTER.slice(0, 3));
 if (!h) return;
 const [host, guest, other] = ROSTER;

 const created = await send(h, host, 'c1', { type: 'create', name: 'Lifecycle Cup', format: 'mixed' });
 assert.equal(created.status, 'LOBBY');
 assert.equal(created.owner, host, 'the creator owns the room');
 assert.equal(typeof created.id, 'string');
 assert.ok(created.code && created.code.length > 0, 'a join code is minted');
 assert.ok(created.expires > created.created, 'the lobby carries its approved expiry (30 minutes private)');

 /* A guest joins, then leaves: the roster loses the guest and the room is STILL a lobby. */
 const joined = await send(h, guest, 'c2', { type: 'join', id: created.id });
 assert.deepEqual(ids(joined.players), [host, guest], 'the guest is seated');
 const guestLeft = await send(h, guest, 'c3', { type: 'leave', id: created.id });
 assert.equal(guestLeft.status, 'LOBBY', 'a guest leaving does NOT cancel the room');
 assert.deepEqual(ids(guestLeft.players), [host], 'the leaving guest is removed from the roster');
 assert.equal(guestLeft.owner, host, 'ownership is untouched by a guest departure');
 assert.ok(guestLeft.revision > joined.revision, 'the departure advances the room revision');
 const guestDurable = await h.service.getRoom(created.id);
 assert.equal(guestDurable.status, 'LOBBY', 'the committed row is still a lobby');
 assert.deepEqual(ids(guestDurable.players), [host], 'the committed roster dropped the guest');

 /* A third player joins so the host is provably not the last member; the host leaving still cancels. */
 const joined2 = await send(h, other, 'c4', { type: 'join', id: created.id });
 assert.deepEqual(ids(joined2.players), [host, other]);

 const hostLeft = await send(h, host, 'c5', { type: 'leave', id: created.id });
 assert.equal(hostLeft.status, 'CANCELLED', 'the host leaving a LOBBY room transitions it to CANCELLED');
 assert.deepEqual(ids(hostLeft.players), [other], 'the departing host is removed');
 assert.ok(hostLeft.reason == null, 'the frozen leave rule records no reason for a voluntary host departure');

 const stored = await h.row('SELECT status, reason, owner_id FROM tournament.rooms WHERE room_id = $1', [created.id]);
 assert.equal(stored.status, 'CANCELLED', 'the committed room status is CANCELLED');
 assert.equal(stored.owner_id, host, 'the committed owner is still the departed host');
 const active = await h.service.activeRooms();
 assert.ok(!active.some((r) => r.id === created.id), 'a cancelled room is no longer active');

 /* The same command surface still answers a delivered view to the member who stayed. */
 const view = await h.service.view(created.id, other);
 assert.equal(view.status, 'CANCELLED', 'the read-only view agrees with the committed status');
});

/* ====================================== 2. host transfer inside the lobby == */

test('V5-09-02: host transfer hands ownership to a seated player while the old host remains a player', { skip: GATE }, async (t) => {
 const h = await open(t, ROSTER.slice(0, 3));
 if (!h) return;
 const [host, target, bystander] = ROSTER;

 const created = await send(h, host, 't1', { type: 'create', name: 'Transfer Cup', format: 'mixed' });
 let view = await send(h, target, 't2', { type: 'join', id: created.id });
 view = await send(h, bystander, 't3', { type: 'join', id: created.id });
 const before = view.revision;

 /* A non-host cannot transfer, and even the host cannot transfer to a non-member. */
 await lab.throwsCode(send(h, target, 't4', { type: 'transfer', id: created.id, target: host }), 'HOST_ONLY');
 await lab.throwsCode(send(h, host, 't5', { type: 'transfer', id: created.id, target: 'svc_absent' }), 'HOST_ONLY');
 assert.equal((await h.service.getRoom(created.id)).owner, host, 'a refused transfer changes nothing');

 const transferred = await send(h, host, 't6', { type: 'transfer', id: created.id, target });
 assert.equal(transferred.owner, target, 'the target becomes the owner');
 assert.deepEqual(ids(transferred.players), [host, target, bystander], 'the roster is unchanged by a transfer');
 assert.ok(ids(transferred.players).includes(host), 'the old host REMAINS a player');
 assert.equal(transferred.revision, before + 1, 'the transfer advances the revision exactly once');

 const stored = await h.row('SELECT owner_id FROM tournament.rooms WHERE room_id = $1', [created.id]);
 assert.equal(stored.owner_id, target, 'the new owner is durable');
 const durablePlayers = await h.rows('SELECT actor_id FROM tournament.room_players WHERE room_id = $1 ORDER BY ordinal', [created.id]);
 assert.deepEqual(durablePlayers.map((p) => p.actor_id), [host, target, bystander], 'the durable roster keeps every player');

 /* The NEW owner can transfer back; the old host (now a plain player) can receive it. */
 const back = await send(h, target, 't7', { type: 'transfer', id: created.id, target: host });
 assert.equal(back.owner, host, 'the new owner may hand ownership back');
 assert.ok(ids(back.players).includes(target), 'the handing owner stays a player');
 assert.equal((await h.service.getRoom(created.id)).owner, host);
});

/* ============================ 3. pause freezes, resume unfreezes without a gift == */

test('V5-09-02: host pause freezes the clocks and host resume unfreezes them with no time gift', { skip: GATE }, async (t) => {
 const h = await open(t, ROSTER.slice(0, 2));
 if (!h) return;
 const [host, guest] = ROSTER;

 const seated = await seatPrivateRoom(h, [host, guest], { name: 'Pause Cup', format: 'duel', clock: 120, increment: 1 }, 'p');
 const roomId = seated.roomId;
 await lab.throwsCode(send(h, guest, 'p-start', { type: 'start', id: roomId }), 'HOST_ONLY');

 const running = await send(h, host, 'p-start2', { type: 'start', id: roomId });
 assert.equal(running.status, 'RUNNING', 'the host starts a private room');
 assert.equal(running.fixtures.length, 1, 'a two-player duel is one fixture');
 const eventDeadline = running.deadline;
 assert.equal(running.serverNow, h.now(), 'the delivered view is stamped with the injected clock');

 /* Both players accept the fixture; the second acceptance puts it in play with a full clock bank. */
 const fixture = running.fixtures[0];
 h.at(Math.max(h.now(), fixture.opens));
 await send(h, fixture.players[0], 'p-ok1', { type: 'matchReady', id: roomId, fixture: fixture.id });
 const play = await send(h, fixture.players[1], 'p-ok2', { type: 'matchReady', id: roomId, fixture: fixture.id });
 const playing = play.fixtures.find((f) => f.id === fixture.id);
 assert.equal(playing.status, 'PLAYING', 'both acceptances put the fixture in play');
 assert.equal(playing.clock, 120, 'the clock bank starts at the room clock');
 const playedAt = h.now();

 /* Only the host may pause. */
 await lab.throwsCode(send(h, guest, 'p-pause-no', { type: 'pause', id: roomId }), 'HOST_ONLY');
 const paused = await send(h, host, 'p-pause', { type: 'pause', id: roomId });
 assert.equal(paused.status, 'PAUSED', 'the host pauses a running private room');
 assert.equal(paused.reason, 'HOST_PAUSED');
 const pausedClock = paused.fixtures.find((f) => f.id === fixture.id).clock;
 assert.ok(pausedClock > 0, `the fixture has a live clock when paused (${pausedClock})`);

 /* Wall time passes; the frozen clock must not move. */
 h.advance(60000);
 const stillPaused = await h.service.view(roomId, host);
 assert.equal(stillPaused.status, 'PAUSED', 'the room stays paused');
 assert.equal(stillPaused.fixtures.find((f) => f.id === fixture.id).clock, pausedClock, 'the clock is FROZEN while paused (+60 s)');
 h.advance(600000);
 const longPaused = await h.service.view(roomId, guest);
 assert.equal(longPaused.fixtures.find((f) => f.id === fixture.id).clock, pausedClock, 'the clock is FROZEN while paused (+660 s)');

 /* Resume credits exactly the paused interval back: the remaining clock is the SAME, and the event
  * deadline moves by exactly that interval - nothing is gifted. */
 const resumed = await send(h, host, 'p-resume', { type: 'resume', id: roomId });
 assert.equal(resumed.status, 'RUNNING', 'the host resumes the room');
 assert.equal(resumed.fixtures.find((f) => f.id === fixture.id).clock, pausedClock, 'NO time gift: the remaining clock is unchanged');
 assert.equal(resumed.deadline - eventDeadline, 660000, 'the event deadline is credited by exactly the paused interval');
 assert.equal(h.now() - playedAt, 660000, 'the test clock really did advance 11 minutes');

 /* The clock runs down again from the credited value. */
 h.advance(30000);
 const running2 = await h.service.view(roomId, host);
 assert.equal(running2.status, 'RUNNING');
 assert.equal(running2.fixtures.find((f) => f.id === fixture.id).clock, pausedClock - 30, 'the clock is unfrozen (+30 s)');

 /* A resumed room is still private and still host-owned: the durable row agrees. */
 const stored = await h.row('SELECT status, paused_at, deadline FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(stored.status, 'RUNNING', 'the committed status is RUNNING');
 assert.ok(stored.paused_at !== null, 'the pause instant is durable');
 assert.equal(new Date(stored.deadline).getTime(), resumed.deadline, 'the committed deadline matches the delivered one');
});

/* ============================== 4a. public table: ten seats, automatic start == */

test('V5-09-02: a public table seats ten, starts automatically with a reserved entry, and refuses a manual start', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const [first] = ROSTER;

 const opened = await send(h, first, 'a1', { type: 'publicJoin', table: 'low' });
 assert.equal(opened.table, 'low', 'the room carries the public table');
 assert.equal(opened.owner, 'service', 'a public table is owned by the service');
 assert.equal(opened.capacity, 10, 'a public table holds ten seats');
 assert.equal(opened.quote.entry, 100, 'the low table entry is the approved 100 coins');
 assert.equal(opened.quote.pool, 1000, 'the low table pool is ten entries');
 assert.equal(opened.quote.currency, 'coins');
 assert.deepEqual(ids(opened.players), [first]);
 const roomId = opened.id;

 /* A public table has no manual start. */
 await lab.throwsCode(send(h, first, 'a2', { type: 'start', id: roomId }), 'AUTOMATIC_START_ONLY');

 /* The opener readies too, so the ten-ready condition below is genuinely reachable. */
 let view = await send(h, first, 'a1r', { type: 'ready', value: true, rulesVersion: opened.rulesVersion, id: opened.id });
 assert.equal(view.status, 'LOBBY', 'the opener readying does not start a one-seat table');

 /* Nine players seated and ready is NOT enough: the room is still an open lobby. */
 for (const actor of ROSTER.slice(1, 9)) {
  view = await send(h, actor, `a-join-${actor}`, { type: 'publicJoin', table: 'low' });
  assert.equal(view.id, roomId, 'every in-cohort player joins the SAME public table');
  view = await send(h, actor, `a-ready-${actor}`, { type: 'ready', value: true, rulesVersion: view.rulesVersion, id: roomId });
 }
 assert.deepEqual(ids(view.players), ROSTER.slice(0, 9), 'nine players are seated');
 assert.equal(view.status, 'LOBBY', 'nine ready players do not start a public table');
 assert.equal((await h.row('SELECT escrow FROM tournament.rooms WHERE room_id = $1', [roomId])).escrow, '0', 'nothing is reserved yet');

 /* The tenth seat readies: the room reserves every entry and starts itself. */
 const tenth = ROSTER[9];
 const seated = await send(h, tenth, 'a10', { type: 'publicJoin', table: 'low' });
 assert.equal(seated.id, roomId, 'the tenth player joins the same table');
 assert.equal(seated.status, 'LOBBY', 'ten seated players who are not all ready still do not start');
 const started = await send(h, tenth, 'a10r', { type: 'ready', value: true, rulesVersion: seated.rulesVersion, id: roomId });
 assert.equal(started.status, 'RUNNING', 'ten ready players start the table AUTOMATICALLY');
 assert.equal(started.escrow, 1000, 'the whole pool is reserved into escrow');
 assert.equal(started.contributions.length, 10, 'one contribution per seat');
 assert.ok(started.contributions.every((c) => c.amount === 100), 'every contribution is the entry fee');
 assert.equal(started.seed.length, 10, 'the automatic start seeded all ten players');
 assert.equal(started.fixtures.filter((f) => f.status !== 'BLOCKED').length > 0, true, 'the first round is open');

 /* DURABLE: room, roster, escrow contributions, wallets, ledger and occupancy all agree. */
 const stored = await h.row('SELECT status, escrow, settled, seed_json, contribution_count FROM ('
  + ' SELECT status, escrow, settled, seed_json, (SELECT count(*) FROM tournament.escrow_contributions c WHERE c.room_id = r.room_id) AS contribution_count'
  + ' FROM tournament.rooms r WHERE room_id = $1) s', [roomId]);
 assert.equal(stored.status, 'RUNNING', 'the committed room is RUNNING');
 assert.equal(Number(stored.escrow), 1000, 'the committed escrow is the pool');
 assert.equal(stored.settled, false, 'the room is not settled while it runs');
 assert.equal(Number(stored.contribution_count), 10, 'ten committed escrow contributions');
 const contributions = await h.rows('SELECT actor_id, amount FROM tournament.escrow_contributions WHERE room_id = $1 ORDER BY actor_id', [roomId]);
 assert.ok(contributions.every((c) => Number(c.amount) === 100), 'each committed contribution is the entry');

 const wallets = await h.rows('SELECT actor_id, coins, reserved_coins FROM economy.wallets WHERE actor_id = ANY($1::text[]) ORDER BY actor_id', [ROSTER]);
 assert.equal(wallets.length, 10);
 assert.ok(wallets.every((w) => Number(w.coins) === 900 && Number(w.reserved_coins) === 100),
  'every seat paid 100 coins into the reserved balance');
 const ledger = await h.rows("SELECT count(*)::int AS n FROM economy.ledger WHERE reason = 'Tournament entry reserved'");
 assert.equal(ledger[0].n, 10, 'one reserve journal entry per seat');
 const occupancy = await h.rows("SELECT actor_id, kind, ref_id FROM core.actor_occupancy WHERE kind = 'tournament' ORDER BY actor_id");
 assert.equal(occupancy.length, 10, 'every seat is claimed against the tournament');
 assert.ok(occupancy.every((o) => o.ref_id === roomId), 'the occupancy names this room');
});

/* ================== 4b. public table: the 200-Elo cohort cap, selection and reserve == */

test('V5-09-02: the public cohort cap excludes an out-of-window player at selection and aborts the reserve when a rating moved', { skip: GATE }, async (t) => {
 const h = await open(t, [...ROSTER, OUTSIDER], { [OUTSIDER]: 2000 });
 if (!h) return;

 /* Nine in-cohort players (all 1500) fill one low table. */
 let view = await send(h, ROSTER[0], 'b1', { type: 'publicJoin', table: 'low' });
 const roomId = view.id;
 view = await send(h, ROSTER[0], 'b1r', { type: 'ready', value: true, rulesVersion: view.rulesVersion, id: roomId });
 for (const actor of ROSTER.slice(1, 9)) {
  view = await send(h, actor, `b-join-${actor}`, { type: 'publicJoin', table: 'low' });
  view = await send(h, actor, `b-ready-${actor}`, { type: 'ready', value: true, rulesVersion: view.rulesVersion, id: roomId });
 }
 assert.equal(view.id, roomId);
 assert.equal(view.players.length, 9, 'the in-cohort table holds nine players');

 /* A player 500 Elo away is NOT seated at that table: matchmaking refuses the cohort and opens a
  * fresh table for them instead. */
 const far = await send(h, OUTSIDER, 'b-far', { type: 'publicJoin', table: 'low' });
 assert.notEqual(far.id, roomId, 'an out-of-cohort player is NOT seated at the in-cohort table');
 assert.deepEqual(ids(far.players), [OUTSIDER], 'they get their own table');
 const untouched = await h.service.getRoom(roomId);
 assert.equal(untouched.players.length, 9, 'the in-cohort table is unchanged');

 /* RESERVE-TIME RE-CHECK. A tenth in-cohort player joins, then their durable rating moves out of the
  * 200-Elo spread (the exact race the approved `reserve` re-check exists for). */
 const tenth = ROSTER[9];
 const seated = await send(h, tenth, 'b10', { type: 'publicJoin', table: 'low' });
 assert.equal(seated.id, roomId, 'a tenth in-cohort player joins the table');
 assert.equal(seated.players.length, 10, 'all ten seats are taken');
 assert.equal(seated.status, 'LOBBY', 'the table is still a lobby until every seat is ready');
 await h.pools.core.query('UPDATE economy.ratings SET rating = 1900 WHERE actor_id = $1', [tenth]);

 await lab.throwsCode(send(h, tenth, 'b10r', { type: 'ready', value: true, rulesVersion: seated.rulesVersion, id: roomId }), 'SKILL_WINDOW_CHANGED');

 /* COMPLETE ROLLBACK: the ready flag, the revision, the escrow, the wallets, the occupancy and the
  * outcome row are all untouched by the aborted command. */
 const rolled = await h.row('SELECT status, escrow, settled, revision FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(rolled.status, 'LOBBY', 'the aborted reserve left the room in the lobby');
 assert.equal(Number(rolled.escrow), 0, 'nothing was reserved');
 assert.equal(rolled.settled, false);
 assert.equal(Number(rolled.revision), seated.revision, 'the aborted reserve wrote no room state');
 const contributions = await h.row('SELECT count(*)::int AS n FROM tournament.escrow_contributions WHERE room_id = $1', [roomId]);
 assert.equal(contributions.n, 0, 'no escrow contribution survived the rollback');
 const readyRow = await h.row('SELECT ready FROM tournament.room_players WHERE room_id = $1 AND actor_id = $2', [roomId, tenth]);
 assert.equal(readyRow.ready, false, 'the aborted ready write did not commit');
 const wallets = await h.rows('SELECT actor_id, coins, reserved_coins FROM economy.wallets WHERE actor_id = ANY($1::text[]) ORDER BY actor_id', [ROSTER]);
 assert.ok(wallets.every((w) => Number(w.coins) === 1000 && Number(w.reserved_coins) === 0), 'no wallet was charged');
 const occupancy = await h.row('SELECT count(*)::int AS n FROM core.actor_occupancy');
 assert.equal(occupancy.n, 0, 'no occupancy claim survived');
 const outcome = await h.row('SELECT count(*)::int AS n FROM tournament.command_outcomes WHERE actor_id = $1 AND "key" = $2', [tenth, JSON.stringify('b10r')]);
 assert.equal(outcome.n, 0, 'the aborted command left no outcome row to poison its key');

 /* With the rating back inside the cohort the same seat readies cleanly and the table starts. */
 await h.pools.core.query('UPDATE economy.ratings SET rating = 1500 WHERE actor_id = $1', [tenth]);
 const recovered = await send(h, tenth, 'b10r2', { type: 'ready', value: true, rulesVersion: seated.rulesVersion, id: roomId });
 assert.equal(recovered.status, 'RUNNING', 'the in-cohort table starts automatically once every seat is ready');
 assert.equal(recovered.escrow, 1000, 'the reserve then succeeds');
});

/* ========================== 5. settlement records placements, never normal Elo == */

test('V5-09-02: a played-out public tournament settles into tournament_records and leaves economy.ratings byte-identical', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;

 const ratingSql = 'SELECT actor_id, rating, peak, casual_rating, games, casual_games, tier, reached_at, last_rated_at'
  + ' FROM economy.ratings WHERE actor_id = ANY($1::text[]) ORDER BY actor_id';
 const before = await h.rows(ratingSql, [ROSTER]);
 assert.equal(before.length, 10, 'every player has a normal rating row');

 /* Ten in-cohort players open a low table; the tenth ready starts it automatically. */
 let view = await send(h, ROSTER[0], 's1', { type: 'publicJoin', table: 'low' });
 const roomId = view.id;
 view = await send(h, ROSTER[0], 's1r', { type: 'ready', value: true, rulesVersion: view.rulesVersion, id: roomId });
 for (const actor of ROSTER.slice(1)) {
  view = await send(h, actor, `s-join-${actor}`, { type: 'publicJoin', table: 'low' });
  view = await send(h, actor, `s-ready-${actor}`, { type: 'ready', value: true, rulesVersion: view.rulesVersion, id: roomId });
 }
 assert.equal(view.id, roomId, 'a single public table seats the whole cohort');
 assert.equal(view.status, 'RUNNING', 'ten ready players started the table');
 assert.equal(view.seed.length, 10);

 /* Play the whole tournament through the command surface. */
 const played = await playOut(h, view);
 assert.equal(played.view.status, 'COMPLETE', `the table played to COMPLETE (${played.steps} resign commands)`);
 assert.equal(played.view.ranking.length, 10, 'the settlement ranks all ten players');
 assert.equal(new Set(played.view.ranking).size, 10, 'no placement is duplicated');
 assert.equal(played.view.settled, true, 'the room is settled');
 assert.equal(played.view.escrow, 0, 'the escrow is fully released');
 assert.equal(played.view.receipt.payouts.length, 10, 'the receipt carries every payout line');
 assert.equal(played.view.receipt.refunded, false, 'a COMPLETE table pays out rather than refunding');

 /* TOURNAMENT RECORDS: the settlement wrote every placement and nothing else. */
 const records = await h.rows('SELECT actor_id, entered, wins, runner_up, top3, top5, best_finish, finish_sum, premium_wins'
  + ' FROM economy.tournament_records ORDER BY actor_id');
 assert.equal(records.length, 10, 'one tournament record per ranked player');
 assert.ok(records.every((r) => Number(r.entered) === 1), 'every player entered exactly one tournament');
 assert.ok(records.every((r) => Number(r.premium_wins) === 0), 'a low table awards no premium win');
 assert.equal(records.reduce((sum, r) => sum + Number(r.finish_sum), 0), 55, 'the placements are exactly 1..10');
 const champions = records.filter((r) => Number(r.wins) === 1);
 assert.equal(champions.length, 1, 'exactly one champion is recorded');
 assert.equal(champions[0].actor_id, played.view.ranking[0], 'the champion is the top of the final ranking');
 assert.equal(Number(champions[0].best_finish), 1, 'the champion best finish is first');
 assert.equal(Number(records.find((r) => r.actor_id === played.view.ranking[9]).best_finish), 10, 'the last place best finish is tenth');

 /* NORMAL ELO IS 100% UNCHANGED: every ratings row is byte-identical to the pre-tournament read. */
 const after = await h.rows(ratingSql, [ROSTER]);
 assert.deepEqual(after, before, 'tournament play left economy.ratings byte-identical (rating, peak, games, tier, instants)');
 assert.ok(after.every((r) => Number(r.rating) === 1500), 'no normal rating moved');
 assert.ok(after.every((r) => Number(r.games) === 30), 'no tournament game counted as a normal game');
 assert.ok(after.every((r) => new Date(r.last_rated_at ?? 0).getTime() === new Date(before[0].last_rated_at ?? 0).getTime()),
  'the normal last-rated instant did not move');

 /* The approved payout: every seat is charged the entry, the pool is paid by share, the burn retires
  * and the reserved balance is returned to zero. */
 const payouts = new Map(played.view.receipt.payouts.map((p) => [p.id, p.amount]));
 const wallets = await h.rows('SELECT actor_id, coins, reserved_coins FROM economy.wallets WHERE actor_id = ANY($1::text[]) ORDER BY actor_id', [ROSTER]);
 assert.equal(wallets.length, 10);
 for (const wallet of wallets) {
  assert.equal(Number(wallet.reserved_coins), 0, `${wallet.actor_id} kept no reserved coins`);
  assert.equal(Number(wallet.coins), 900 + payouts.get(wallet.actor_id), `${wallet.actor_id} received exactly the approved payout`);
 }
 const burns = await h.row('SELECT coins, crowns FROM economy.system_burns WHERE id = 1');
 assert.equal(Number(burns.coins), 100, 'the approved burn (one tenth of the pool) is retired');
 const occupancy = await h.row('SELECT count(*)::int AS n FROM core.actor_occupancy');
 assert.equal(occupancy.n, 0, 'every occupancy claim was released by the settlement');

 /* The durable room row agrees with the delivered terminal view. */
 const stored = await h.row('SELECT status, settled, escrow, receipt_json, ranking FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(stored.status, 'COMPLETE');
 assert.equal(stored.settled, true);
 assert.equal(Number(stored.escrow), 0);
 assert.deepEqual(stored.ranking, played.view.ranking, 'the committed ranking is the delivered one');
 assert.deepEqual(stored.receipt_json, played.view.receipt, 'the committed receipt is the delivered one');

 /* A replay of the last command returns the committed response and applies no second effect. */
 const recordSnapshot = () => h.rows('SELECT actor_id, entered, wins, finish_sum FROM economy.tournament_records ORDER BY actor_id');
 const recordsBefore = await recordSnapshot();
 const replay = await send(h, played.last.actor, played.last.key, played.last.command);
 assert.equal(replay.status, 'COMPLETE', 'a replayed command returns the committed view');
 assert.deepEqual(replay, played.view, 'the replay is byte-identical to the committed response');
 assert.deepEqual(await recordSnapshot(), recordsBefore, 'a replay applies no second settlement');
 /* A DIFFERENT command under the SAME key is a conflict, never a second effect. */
 await lab.throwsCode(send(h, played.last.actor, played.last.key, { type: 'leave', id: roomId }), 'IDEMPOTENCY_CONFLICT');
});


/* Post-G09 race: publicJoin reads a candidate from the active-room set, but
 * standalone settlement/admin workers do NOT take its coarse room-set mutex.
 * Prove the join waits on the individual row, reloads the latest state and
 * never overwrites a terminal room with its older LOBBY snapshot. */
test('P09 co-dev: concurrent publicJoin never resurrects a terminal room after waiting for its row lock', { skip: GATE, timeout: 60000 }, async t => {
 const h=await open(t,ROSTER.slice(0,2));
 if(!h)return;
 const first=await send(h,ROSTER[0],'post9-race-first',{type:'publicJoin',table:'low'});
 assert.equal(first.status,'LOBBY');
 const admin=await lab.adminClient(h.database);
 let released=false,pending=null;
 try{
  await admin.query('BEGIN');
  await admin.query('SELECT 1 FROM tournament.rooms WHERE room_id = $1 FOR UPDATE',[first.id]);
  pending=send(h,ROSTER[1],'post9-race-second',{type:'publicJoin',table:'low'});
  const waiting=await lab.waitForLockWaiter(admin,12000);
  assert.equal(waiting,true,'a join to an existing public table must acquire its row lock');
  /* Simulate another authorized worker closing the table while the join was
   * awaiting its row. The terminal transition and join must not interleave. */
  await admin.query("UPDATE tournament.rooms SET status = 'VOID', reason = 'CANCELLED', revision = revision + 1 WHERE room_id = $1",[first.id]);
  await admin.query('COMMIT');
  released=true;
  const second=await pending;
  assert.notEqual(second.id,first.id,'the joining player is seated at a new lobby, not a closed table');
  assert.equal(second.status,'LOBBY');
  const original=await h.row('SELECT status, revision FROM tournament.rooms WHERE room_id = $1',[first.id]);
  assert.equal(original.status,'VOID','a stale public lobby snapshot never overwrites a terminal transition');
  const roster=await h.rows('SELECT actor_id FROM tournament.room_players WHERE room_id = $1',[first.id]);
  assert.deepEqual(roster.map(x=>x.actor_id),[ROSTER[0]],'a closing tournament cannot acquire a phantom seat');
 }finally{
  if(!released)await admin.query('ROLLBACK').catch(()=>{});
  await admin.end();
  if(pending)await Promise.allSettled([pending]);
 }
});


test('P09 co-dev: a publicJoin waiting for room/actor locks rechecks the latest wallet before admitting', {skip:GATE,timeout:60000}, async t=>{
 const h=await open(t,ROSTER.slice(0,2));
 if(!h)return;
 const first=await send(h,ROSTER[0],'post9-funds-first',{type:'publicJoin',table:'low'});
 const admin=await lab.adminClient(h.database);
 let released=false,pending=null;
 try{
  await admin.query('BEGIN');
  await admin.query('SET LOCAL statement_timeout = 5000');
  await admin.query('SELECT 1 FROM tournament.rooms WHERE room_id = $1 FOR UPDATE',[first.id]);
  pending=send(h,ROSTER[1],'post9-funds-second',{type:'publicJoin',table:'low'});
  assert.equal(await lab.waitForLockWaiter(admin,12000),true,
   'join is blocked by the tournament aggregate, before acquiring wallet locks');
  await admin.query('UPDATE economy.wallets SET coins = 0 WHERE actor_id = $1',[ROSTER[1]]);
  await admin.query('COMMIT');
  released=true;
  await assert.rejects(pending,e=>e.message==='INSUFFICIENT_COINS',
   'a pre-lock cached 1000-coin balance may not override current zero coins');
  const wallet=await h.row('SELECT coins, reserved_coins FROM economy.wallets WHERE actor_id = $1',[ROSTER[1]]);
  assert.equal(Number(wallet.coins),0,'the concurrent wallet change is preserved');
  assert.equal(Number(wallet.reserved_coins),0,'the unauthorized join reserved no currency');
  const members=await h.rows('SELECT actor_id FROM tournament.room_players WHERE room_id = $1 ORDER BY ordinal',[first.id]);
  assert.deepEqual(members.map(x=>x.actor_id),[ROSTER[0]],
   'the stale join and its operation outcome must roll back completely');
  const result=await h.row('SELECT count(*)::int AS n FROM tournament.command_outcomes WHERE actor_id = $1',[ROSTER[1]]);
  assert.equal(result.n,0);
 }finally{
  if(!released)await admin.query('ROLLBACK').catch(()=>{});
  await admin.end();
  if(pending)await Promise.allSettled([pending]);
 }
});
