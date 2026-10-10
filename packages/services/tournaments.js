/* packages/services/tournaments.js - V5 P09 durable tournament room persistence (V5-09-01), the
 * durable party/tournament command surface (V5-09-02) and fenced timer/progression claims
 * (V5-09-03).
 *
 * The PostgreSQL successor of `server/rooms.js` (RoomStore). The room STATE MACHINE stays where it
 * already is: the frozen pure `src/tournament.js` decides every transition (`create`, `join`,
 * `ready`, `configure`, `start`, `leave`, `move`, `resign`, `tick`, `pause`, `resume`, `view`), the
 * matchmaking policy stays in `packages/domain/matchmaking.js` (cohort choice and seeding), the
 * escrow/settlement arithmetic stays verbatim in `reserveRoom`/`settleRoom` below, and this layer
 * owns only the two things V4 put in `RoomStore`: the transaction boundary (one room, its roster,
 * its escrow and its outcome in ONE transaction - spec 03 section 5) and the durable projection.
 *
 *   const tournaments = createTournamentService({ pool, core, ephemera, now });
 *   await tournaments.createRoom(room);          // room + roster + contributions + fixtures, ONE tx
 *   const room2 = await tournaments.getRoom(id); // complete committed state, or null
 *   await tournaments.saveRoom(room2);
 *   await tournaments.listRooms();               // every room
 *   await tournaments.activeRooms();             // LOBBY/RUNNING/PAUSED/REVIEW only
 *   await tournaments.run(principal, key, cmd);  // the durable lifecycle command (one effect)
 *   await tournaments.view(roomId, actor);      // the same T.view DTO, read-only
 *   await tournaments.settle(roomId, { reason }); // indivisible payout/refund, ONE locked tx
 *   await tournaments.claimTimerLease(roomId, { owner, leaseMs, epoch }); // round/clock sweep lease
 *   await tournaments.releaseTimerLease(roomId, { owner });               // hand the sweep back
 *   await tournaments.claimFixture(roomId, fixtureId, { owner, leaseMs }); // progression lease
 *   await tournaments.completeFixture(roomId, fixtureId, { owner, epoch }); // fenced completion
 *   tournaments.close();                         // releases this service, NOT the borrowed pool
 *
 * THE COMMAND SURFACE IS THE APPROVED LIFECYCLE, NOT A NEW ONE. `run` accepts the fifteen commands
 * the party UI and rule fixtures already exercise - create / publicJoin / join / ready / configure /
 * leave / kick / transfer / start / matchReady / move / resign / pause / resume / cancel - and
 * delegates every transition to the frozen rules, so the approved behavior is preserved by
 * construction: a HOST leaving a LOBBY room transitions it to CANCELLED (a guest is simply removed
 * and the room stays LOBBY), transfer hands `owner` to a seated player inside LOBBY, pause freezes
 * the clocks and resume unfreezes them WITHOUT a time gift, a public table requires ten players,
 * enforces the 200-Elo cohort spread both when matchmaking selects the table and again at reserve
 * time, starts automatically (a manual `start` is refused with AUTOMATIC_START_ONLY), and private
 * rooms are the only ones with a manual start. Replays are answered from
 * `tournament.command_outcomes` under the SAME `(actor, key)` identity and fingerprint the V4
 * `party_commands` table used, exactly like `RoomStore.run`.
 *
 * NORMAL ELO IS UNTOUCHED BY TOURNAMENTS. A tournament placement writes `economy.tournament_records`
 * (entered / wins / runnerUp / top3 / top5 / bestFinish / finishSum / premiumWins) and nothing else:
 * no code path here writes `economy.ratings`, so a tournament settlement cannot move `rating`,
 * `peak`, `games` or the season of any participant - the approved normal-Elo independence.
 *
 * SETTLEMENT IS INDIVISIBLE AND ORDERED (V5-09-04). `settle(roomId, {reason, actor, key})` applies the
 * SAME approved arithmetic the command surface uses, but as a standalone entry point, in ONE
 * transaction under the frozen global lock order: the room aggregate row (`FOR UPDATE`) first, then
 * the affected actors through `wallets.lock` (occupancy then wallets, sorted), then the dependent rows
 * (the room document, `economy.ledger`, `economy.tournament_records`, the occupancy release and
 * `ops.outbox`). The room row is what serializes two competing settlers, so the loser observes
 * `room.settled === true` and hands back the committed receipt instead of paying a second time. A
 * lifecycle command that names an existing room takes that same room row first, so a settlement and a
 * command on one room are mutually exclusive; the coarse room-set identity is reserved for the
 * creates, which name no row yet.
 *
 * ONE WRITER, ONE READER. `createRoom` and `saveRoom` are the same validated full-document upsert
 * (`tx.repositories.tournaments.save`), so a room created and a room re-saved take the identical
 * path and cannot drift apart; the repository owns the entity projection - `tournament.rooms` plus
 * its `room_players` / `escrow_contributions` / `fixtures` rows, replaced wholesale inside the ONE
 * borrowed transaction, because 0028's UNIQUE (room_id, ordinal) makes positional updates unsafe.
 * `getRoom`/`listRooms`/`activeRooms` are the repository's hydrated aggregate reads, which already
 * carry every room column, the roster in join order (ready / withdrawn / ordinal), the escrow
 * contributions and each fixture's state, mini board, clock banks, deadlines, move timings, history
 * and lease. No second projection and no second convention is created here. Those reads are BOUNDED,
 * and a bounded decision input that overflows makes the aggregate undecidable rather than partial:
 * `state.write` then fails the whole command closed with STATE_TRUNCATED, so a room set too large to
 * read completely can never be written from an incomplete view.
 *
 * NO MINTING, NO SCHEMA. The constructor creates no table, no row, no code, no default and no
 * balance. It verifies the live migration chain read-only (`verifyRuntimeSchema`) and refuses to run
 * against anything else.
 *
 * SYNC FACTORY, ASYNC METHODS. The factory returns immediately so a boot path can construct the
 * service and start serving; the schema gate is a promise (`ready`) that EVERY method awaits before
 * it borrows a transaction, so a chain mismatch surfaces as a failed call rather than as a silently
 * unchecked boot.
 *
 * PostgreSQL IS THE AUTHORITY. Persistence touches PostgreSQL only. The `core` and `ephemera`
 * dependencies are accepted and type-checked when present, but are never constructed, reconfigured,
 * awaited, read as truth or closed here: the command surface below borrows neither, because a room
 * command is a PostgreSQL transaction and nothing in it is ephemeral coordination yet.
 * `close()` releases this service's unit of work only: the pool carries a cluster-wide
 * connection-budget claim and outlives one service, which is exactly what lets a fresh instance boot
 * over the same pool after a restart.
 */
'use strict';
const crypto = require('node:crypto');
const { createPgUnitOfWork } = require('../db/pg/uow.js');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');
const { PgGuardError } = require('../db/pg/guards.js');
const { lockTransactionIdentity } = require('../db/pg/locks.js');
const { PARTY_COMMANDS } = require('../db/scopes');
/* The frozen approved rules. Imported from their single definition (`src/tournament.js` re-exported
 * through `packages/domain/index.js`), never re-implemented here: a lifecycle transition this
 * service cannot delegate does not exist. */
const T = require('../domain/index.js').tournament;
const MM = require('../domain/matchmaking.js');
const ABUSE = require('../domain/abuse.js');

/* The one runtime identity that may own the tournament.* writes this service performs. */
const CORE_ROLE = 'core_runtime';
/* The durable room identity grammar (`tournament.rooms.rooms_room_id_grammar_ck`, 0013): validated
 * BEFORE the id can reach a statement, so a malformed id is this service's own stable code rather
 * than a raw 23514 raised mid-transaction. */
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
/* A lookup accepts the room id OR the join code, exactly like the repository's
 * `WHERE room_id = $1 OR code = $1` (0013 `rooms_code_grammar_ck` allows the same charset). */
const ROOM_LOOKUP = /^[A-Za-z0-9:_-]{1,160}$/;
/* Every status the migration admits (`rooms_status_..._ck`); anything else is refused here instead
 * of being rejected by the schema after the roster and fixture writes have already run. */
const ROOM_STATUS = Object.freeze(new Set(['LOBBY', 'RUNNING', 'PAUSED', 'REVIEW', 'COMPLETE', 'VOID', 'CANCELLED']));

const fail = (code) => { throw Error(code); };

/* A room document is persisted as ONE authority. code / owner_id / status are NOT NULL and the id is
 * the primary key, so a structurally incomplete document is refused with a stable code before a
 * statement is built. Ownership, roster, readiness, rules, clocks, quote, contributions, fixtures,
 * ranking and the settlement record are carried by the document itself - nothing is defaulted. */
function requireRoom(room) {
 if (!room || typeof room !== 'object' || Array.isArray(room)) fail('INVALID_ROOM');
 if (typeof room.id !== 'string' || !ROOM_ID.test(room.id)) fail('INVALID_ROOM_ID');
 if (typeof room.code !== 'string' || room.code.length === 0) fail('INVALID_ROOM_CODE');
 if (typeof room.owner !== 'string' || room.owner.length === 0) fail('INVALID_ROOM_OWNER');
 if (typeof room.status !== 'string' || !ROOM_STATUS.has(room.status)) fail('INVALID_ROOM_STATUS');
 return room;
}
function requireRoomLookup(id) {
 if (typeof id !== 'string' || !ROOM_LOOKUP.test(id)) fail('INVALID_ROOM_ID');
 return id;
}

/* --------------------------------------------------------- fenced claim vocabulary (V5-09-03) */

/* A claim names ONE durable identity, so the room-id grammar here is the exact
 * `rooms_room_id_grammar_ck` one - never ROOM_LOOKUP: a lease is taken against a room, never against
 * a join code, and a code that merely looks like an id must not reach a claim statement. */
function requireRoomClaimId(roomId) {
 if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) fail('INVALID_ROOM_ID');
 return roomId;
}
/* `fixtures.fixture_id` is unbounded TEXT in 0013 with a PRIMARY KEY (room_id, fixture_id); the
 * service's own grammar keeps a caller-supplied key bounded and non-empty. */
function requireFixtureId(fixtureId) {
 if (typeof fixtureId !== 'string' || fixtureId.length === 0 || fixtureId.length > 200) fail('INVALID_FIXTURE_ID');
 return fixtureId;
}
/* A lease owner is an opaque worker identity (`timer_lease_owner` / `fixtures.lease_owner` are
 * unbounded TEXT). Bounded here so a hostile or buggy caller cannot store an unbounded identity. */
const LEASE_OWNER_MAX = 160;
function requireLeaseOwner(owner) {
 if (typeof owner !== 'string' || owner.length === 0 || owner.length > LEASE_OWNER_MAX) fail('INVALID_LEASE_OWNER');
 return owner;
}
/* `leaseMs` is a DURATION relative to the caller's clock, never an absolute instant: every lease
 * deadline is computed as `tx.clock() + leaseMs`, so the injected service clock is the only time
 * source (never SQL `now()`) and a frozen clock drives expiry deterministically. */
function requireLeaseMs(leaseMs) {
 const ms = Number(leaseMs);
 if (!Number.isSafeInteger(ms) || ms <= 0) fail('INVALID_LEASE');
 return ms;
}
/* Fence normalization: the epoch is a monotonic BIGINT that the driver hands back as a string, so
 * every epoch LEAVING this service is a JS number and either form is accepted coming in. */
function requireEpoch(epoch) {
 const n = typeof epoch === 'string' && /^[0-9]+$/.test(epoch) ? Number(epoch) : epoch;
 if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) fail('INVALID_EPOCH');
 return n;
}
/* The instant a claim's deadline is written as (pg binds a Date as a timestamptz). */
const atMs = (ms) => new Date(ms);

/* --------------------------------------------------------- settlement identity (V5-09-04) */

/* THE ONE GLOBAL LOCK ORDER every settlement in this repo follows (design 3.7 / spec 01 section 3,
 * the same order `core.js` documents and `wallets.lock` enforces):
 *
 *   1. the room AGGREGATE row  - `SELECT 1 FROM tournament.rooms WHERE room_id = $1 FOR UPDATE`,
 *   2. the affected actors      - `wallets.lock(actors, { aggregate })`, which itself takes
 *                                 `core.actor_occupancy` and then `economy.wallets` in sorted actor
 *                                 order,
 *   3. the dependent rows       - the room document, `economy.ledger`, `economy.tournament_records`,
 *                                 the occupancy release and the `ops.outbox` event.
 *
 * The room row is FIRST because it is the row every competing settlement and every room command
 * must serialize on, and because it is the row that decides whether a settlement may exist at all.
 * A caller-supplied order is never trusted: the wallet step sorts internally and the actor set is
 * derived from the durable rows, so two settlements - and a settlement racing a room command -
 * cannot form a cycle. */

/* A settlement addresses a room by ID ALONE (never a join code) - see `requireRoomClaimId`. The room
 * COMMAND surface addresses a room by id OR code, the same lookup domain the repository's
 * `WHERE room_id = $1 OR code = $1` spans, so its guard matches ROOM_LOOKUP; a malformed address is
 * refused here rather than reaching a statement that would lock nothing. */
function requireRoomCommandId(id) {
 if (typeof id !== 'string' || !ROOM_LOOKUP.test(id)) fail('INVALID_ROOM_ID');
 return id;
}

/* Take the ROOM AGGREGATE row lock - the first lock of the global order. `lookup` accepts the room
 * id OR the join code, exactly like `repositories.tournaments.room`, so a command addressed either
 * way serializes on the SAME durable row; one statement both resolves the address and locks the
 * row, so the document is never read before its lock.
 *
 * Zero rows is legal: a command that CREATES a room (`create`/`publicJoin`) may name a fresh id, and
 * the create itself is serialized by the room-set identity. */
async function lockRoomRow(tx, lookup) {
 if (typeof lookup !== 'string' || !ROOM_LOOKUP.test(lookup)) return false;
 const rows = (await tx.query('SELECT 1 FROM tournament.rooms WHERE room_id = $1 OR code = $1 FOR UPDATE', [lookup])).rows;
 return rows.length > 0;
}

/* Durable settlement event (design 2.6/5.5): ONE row per room, enqueued INSIDE the settlement's own
 * transaction, so the event and the financial effect commit or roll back together. The ID is derived
 * from the business identity (`tournament.settle:<roomId>`) rather than a fresh UUID, and
 * `ON CONFLICT DO NOTHING` makes a replay structurally unable to enqueue a second event. The payload
 * carries routing facts only - never a balance or a receipt body: the authoritative data already
 * lives in `tournament.rooms`. */
const SETTLEMENT_KIND = 'tournament.settle';
const SETTLEMENT_EXPIRY_MS = 7 * 86400000;
async function emitSettlement(tx, roomId, event, now) {
 await tx.query(
  'INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at, lease_until, attempts)'
  + " VALUES ($1, $2, $3, 'queued', $4, $5, $4, '1970-01-01T00:00:00+00:00', 0)"
  + ' ON CONFLICT (outbox_id) DO NOTHING',
  [`${SETTLEMENT_KIND}:${roomId}`, JSON.stringify(event), SETTLEMENT_KIND, atMs(now), atMs(now + SETTLEMENT_EXPIRY_MS)]);
 return `${SETTLEMENT_KIND}:${roomId}`;
}
/* The settlement input, validated before a statement is built: an opaque service actor (the V4
 * default is the literal `'service'` that owns a public table), an optional bounded reason and an
 * optional bounded idempotency key for the emitted event. */
const SETTLE_ACTOR_MAX = 160;
const SETTLE_KEY_MAX = 160;
const SETTLE_REASON_MAX = 200;
function requireSettleInput(input) {
 if (input === undefined || input === null) return { actor: 'service', reason: null, key: null };
 if (typeof input !== 'object' || Array.isArray(input)) fail('INVALID_SETTLE');
 const actor = input.actor === undefined ? 'service' : input.actor;
 if (typeof actor !== 'string' || actor.length === 0 || actor.length > SETTLE_ACTOR_MAX) fail('INVALID_SETTLE_ACTOR');
 const reason = input.reason === undefined ? null : input.reason;
 if (reason !== null && (typeof reason !== 'string' || reason.length === 0 || reason.length > SETTLE_REASON_MAX)) fail('INVALID_SETTLE_REASON');
 const key = input.key === undefined ? null : input.key;
 if (key !== null && (typeof key !== 'string' || key.length === 0 || key.length > SETTLE_KEY_MAX)) fail('INVALID_SETTLE_KEY');
 return { actor, reason, key };
}

/* The room's CURRENT revision - the fence every claim taken now is issued against. Read inside the
 * caller's transaction, so the claim and the state it was decided from see one snapshot. `null` when
 * no such room exists, so each caller can answer absence with its own stable code. */
async function roomRevision(tx, roomId) {
 const rows = (await tx.query('SELECT revision FROM tournament.rooms WHERE room_id = $1', [roomId])).rows;
 return rows.length ? Number(rows[0].revision) : null;
}
/* The room/fixture existence gate a progression claim needs before its statement runs: the claim's
 * epoch sub-select would find no room for a missing one and violate `fixtures_lease_tuple_ck`
 * (owner set, epoch NULL), so absence fails closed with a stable code. */
async function requireFixtureRow(tx, roomId, fixtureId) {
 const rows = (await tx.query(
  'SELECT f.fixture_id FROM tournament.rooms r LEFT JOIN tournament.fixtures f'
  + ' ON f.room_id = r.room_id AND f.fixture_id = $2 WHERE r.room_id = $1', [roomId, fixtureId])).rows;
 if (!rows.length) fail('ROOM_NOT_FOUND');
 if (rows[0].fixture_id === null) fail('FIXTURE_NOT_FOUND');
}

/* --------------------------------------------------------- command vocabulary */

/* The fifteen approved room commands (V4 `RoomStore.run` switch). An unknown type is refused
 * before any lock or read, exactly like V4's default branch. */
const ROOM_COMMANDS = Object.freeze(new Set(['create', 'publicJoin', 'join', 'ready', 'configure', 'leave',
 'kick', 'transfer', 'start', 'matchReady', 'move', 'resign', 'pause', 'resume', 'cancel']));
/* The same owned-active-room bound V4 enforced (`active.filter(r => r.owner === actor).length >= 3`):
 * a durable fact read from `tournament.rooms`, never a counter. */
const ROOM_LIMIT = 3;

const clone = (value) => structuredClone(value);
/* The V4 fingerprint: sha256 over the JSON of the cloned command, hex - the exact grammar
 * `tournament.command_outcomes.fingerprint CHAR(64) CHECK (~'^[0-9a-f]{64}$')` admits. */
const fingerprintOf = (command) => crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');

/* --------------------------------------------------------- escrow arithmetic (V5-09-02) */
/* MOVED VERBATIM from `server/rooms.js` RoomStore.reserve/settle. The numbers, the journal entry
 * ids (`<room>:reserve|payout|refund:<actor>`), the refund-on-non-COMPLETE rule, the review
 * hand-off, the `economy.burned` burn and the per-placement tournament record are the approved
 * financial behavior; only the storage seam under them changed. `settle` writes NO normal-Elo
 * field: `recordTournament` touches `tournamentRecord` alone, which the aggregate projects into
 * `economy.tournament_records` - never into `economy.ratings`. */
const safeAdd = (n) => { if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_BALANCE'); return n; };

/* An account's approved eligibility for the table (V4 `eligible`): verified, not suspended, not on
 * hold, at least ten completed games. */
function eligibleAccount(account) {
 if (!account || account.verified !== true || account.suspended === true || account.hold === true || account.games < 10) fail('INELIGIBLE');
 return account;
}

/* The approved tournament placement record. Purely a `tournamentRecord` mutation. */
function recordTournament(account, place, table) {
 const record = account.tournamentRecord || (account.tournamentRecord = { entered: 0, wins: 0, runnerUp: 0, top3: 0, top5: 0, bestFinish: null, finishSum: 0, premiumWins: 0 });
 record.entered = safeAdd(record.entered + 1);
 record.finishSum = safeAdd(record.finishSum + place);
 if (place === 1) { record.wins = safeAdd(record.wins + 1); if (table === 'premium') record.premiumWins = safeAdd(record.premiumWins + 1); }
 if (place === 2) record.runnerUp = safeAdd(record.runnerUp + 1);
 if (place <= 3) record.top3 = safeAdd(record.top3 + 1);
 if (place <= 5) record.top5 = safeAdd(record.top5 + 1);
 record.bestFinish = record.bestFinish === null || record.bestFinish === undefined ? place : Math.min(record.bestFinish, place);
}

/* Charge every seated player the entry fee and claim their occupancy. The 200-Elo cohort spread is
 * re-checked HERE, after matchmaking chose the table and after every player row is locked, so a
 * rating that moved between the choice and the reserve is refused (SKILL_WINDOW_CHANGED) instead of
 * producing an out-of-cohort table. */
function reserveRoom(room, economy, now) {
 const quote = clone(room.quote);
 const held = quote.currency === 'coins' ? 'reservedCoins' : 'reservedCrowns';
 const players = room.players.map((player) => eligibleAccount(lookupAccount(economy, player.id)));
 if (players.some((player) => player.activeMatch)) fail('ALREADY_IN_MATCH');
 const ratings = players.map((player) => player.rating);
 if (Math.max(...ratings) - Math.min(...ratings) > MM.CONFIG.tournament.hardMax) fail('SKILL_WINDOW_CHANGED');
 for (const player of players) {
  if (player[quote.currency] < quote.entry) fail(`INSUFFICIENT_${quote.currency.toUpperCase()}`);
  safeAdd(player[held] + quote.entry);
 }
 room.escrow = quote.pool;
 room.quote = quote;
 room.settled = false;
 room.contributions = players.map((player) => ({ id: player.id, amount: quote.entry }));
 for (const player of players) {
  player[quote.currency] -= quote.entry;
  player[held] += quote.entry;
  player.activeMatch = `tournament:${room.id}`;
  journal(economy, `${room.id}:reserve:${player.id}`, player.id, quote.currency, -quote.entry, 'Tournament entry reserved', now);
 }
}

/* Pay out (or refund) a committed ten-player public table. Idempotent on `room.settled`, so the one
 * call site per command cannot double-pay even if two commands observe the same terminal status.
 * Returns whether THIS call performed the settlement; the two hand-off branches (`already settled`,
 * a non-terminal room, an empty escrow) and the review hand-off return `false` and mutate nothing. */
function settleRoom(room, economy, now) {
 if (!room.table || room.settled || !['COMPLETE', 'VOID', 'CANCELLED'].includes(room.status) || !room.escrow) return false;
 const quote = room.quote, currency = quote.currency;
 const held = currency === 'coins' ? 'reservedCoins' : 'reservedCrowns';
 const refund = room.status !== 'COMPLETE';
 if (!refund && room.ranking.some((id) => { const a = lookupAccount(economy, id); return a.hold || a.suspended; })) {
  room.status = 'REVIEW'; room.reason = 'ACCOUNT_REVIEW'; return false;
 }
 if (!refund && (room.ranking.length !== 10 || new Set(room.ranking).size !== 10)) fail('INVALID_FINAL_RANKING');
 const payouts = refund ? room.contributions.map((p) => ({ id: p.id, amount: p.amount }))
  : room.ranking.map((id, i) => ({ id, amount: quote.payouts[i] }));
 for (const payout of payouts) safeAdd(lookupAccount(economy, payout.id)[currency] + payout.amount);
 if (!refund) safeAdd(economy.burned[currency] + quote.burn);
 for (const contribution of room.contributions) {
  const account = lookupAccount(economy, contribution.id);
  if (account[held] < contribution.amount) fail('ESCROW_MISMATCH');
  account[held] -= contribution.amount;
  if (account.activeMatch === `tournament:${room.id}`) account.activeMatch = null;
 }
 for (const payout of payouts) {
  const account = lookupAccount(economy, payout.id);
  account[currency] += payout.amount;
  journal(economy, `${room.id}${refund ? ':refund:' : ':payout:'}${payout.id}`, payout.id, currency, payout.amount,
   refund ? 'Tournament entry refunded' : 'Tournament placement payout', now);
 }
 if (!refund) {
  economy.burned[currency] += quote.burn;
  room.ranking.forEach((id, i) => recordTournament(lookupAccount(economy, id), i + 1, room.table));
 }
 room.receipt = { currency, pool: room.escrow, burn: refund ? 0 : quote.burn, payouts, refunded: refund };
 room.escrow = 0;
 room.settled = true;
 /* The durable settlement instant (`rooms.settled_at`), from the SAME injected clock the journal uses
  * - never SQL `now()` and never a hidden default. The room column carried no document field before
  * this task, so a settled room would otherwise be persisted with `settled_at` NULL. */
 room.settledAt = now;
 if (refund) { room.riskFlags = []; delete room._riskActors; }
 else { const abuse = ABUSE.tournamentSignals(room); room.riskFlags = abuse.flags; room._riskActors = abuse.actors; }
 return true;
}

/* The account graph member the aggregate already exposes (`state.read()` returns the exported
 * document with `accounts` as [id, account] pairs). A missing account is ACCOUNT_REQUIRED, never a
 * minted default. */
function lookupAccount(economy, id) {
 const pair = (economy.accounts || []).find(([key]) => key === id);
 if (!pair) fail('ACCOUNT_REQUIRED');
 return pair[1];
}
/* The append-only journal the aggregate projects into `economy.ledger`, with the V4 entry-id
 * convention that makes a replayed settlement collide instead of double-posting. */
function journal(economy, id, actor, currency, amount, reason, now) {
 if (!Array.isArray(economy.journal)) economy.journal = [];
 economy.journal.push({ id, actor, currency, amount, reason, source: 'tournament', at: now });
}

function createTournamentService(options = {}) {
 if (!options || typeof options !== 'object') throw new PgGuardError('OPTIONS_REQUIRED');
 const pool = options.pool;
 if (!pool || typeof pool.describe !== 'function' || typeof pool.withTransaction !== 'function') {
  throw new PgGuardError('PG_POOL_REQUIRED');
 }
 const described = pool.describe();
 if (!described || described.role !== CORE_ROLE) {
  throw new PgGuardError('ROLE_MISMATCH', { expected: CORE_ROLE, observed: described ? described.role : null },
   'the tournament service must run on a core_runtime pool (tournament.* is core-owned)');
 }
 if (options.now !== undefined && typeof options.now !== 'function') throw new PgGuardError('CLOCK_REQUIRED');
 /* The room command surface's borrowed dependencies. Checked only when supplied, so a wiring typo
  * fails at boot instead of being discovered mid-command; this persistence layer touches neither. */
 for (const name of ['core', 'ephemera']) {
  const dependency = options[name];
  if (dependency !== undefined && (dependency === null || typeof dependency !== 'object')) {
   throw new PgGuardError('DEPENDENCY_INVALID', { dependency: name });
  }
 }

 /* Boot gate: read-only chain verification. No DDL, no seeding, no default row. It starts here while
  * the caller keeps booting and every method awaits it. The absorbing handler only prevents an
  * unhandled-rejection warning when a caller constructs the service and never calls a method; the
  * awaited promise itself still rejects, so no method can run against an unverified chain. */
 const gate = verifyRuntimeSchema(pool);
 gate.catch(() => {});
 const uow = createPgUnitOfWork(pool, { role: CORE_ROLE, now: options.now });

 /* The ONE writer path shared by `createRoom` and `saveRoom`: validate, then commit the complete
  * document and every child row in one transaction on the borrowed pool. The repository assigns each
  * player's ordinal from the document's own array order and replaces the contribution and fixture
  * sets wholesale inside that same transaction, so a partial room can never be observed and a
  * crash between room and fixture rows is impossible. The caller's document IS what was written, so
  * its id is returned and nothing fabricated is handed back. */
 async function persistRoom(room) {
  requireRoom(room);
  await gate;
  await uow.run((tx) => tx.repositories.tournaments.save(room));
  return room.id;
 }

 /* Creates a room from a complete document (the shape `src/tournament.js` create()+join()+ready()+
  * start() produces). Same upsert as `saveRoom`, so creation and re-save cannot drift. */
 async function createRoom(params) { return persistRoom(params); }
 /* Persists a complete room document: the room row plus its roster, escrow contributions and
  * fixtures, in ONE transaction. A non-lobby room (RUNNING/COMPLETE/VOID) is persisted verbatim. */
 async function saveRoom(room) { return persistRoom(room); }

 /* The complete committed room: every room column, the roster in join order (ready/withdrawn/
  * ordinal), the escrow contributions and each fixture with its state, mini board, clock banks,
  * deadlines, move timings, history and lease. `null` when neither a room nor a code matches - the
  * repository's own absent answer, so a caller decides whether absence is an error. */
 async function getRoom(id) {
  requireRoomLookup(id);
  await gate;
  return uow.run((tx) => tx.repositories.tournaments.room(id));
 }
 async function listRooms() {
  await gate;
  return uow.run((tx) => tx.repositories.tournaments.rooms());
 }
 async function activeRooms() {
  await gate;
  return uow.run((tx) => tx.repositories.tournaments.activeRooms());
 }

 /* ------------------------------------------------------- command surface (V5-09-02) */

 /* One generated join code, checked against the durable rooms (V4 `RoomStore.code`): 40 bits of
  * uppercase hex, re-drawn while a room already uses it. The UNIQUE constraint on
  * `tournament.rooms.code` remains the authority; this loop only avoids the ordinary collision. */
 async function generateCode(tx) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
   const code = crypto.randomBytes(5).toString('hex').toUpperCase();
   if (!(await tx.repositories.tournaments.codeExists(code))) return code;
  }
  return fail('ROOM_CODE_COLLISION');
 }
 /* The approved manual-start shuffle (V4 `RoomStore.shuffle`, the same Fisher-Yates over the seated
  * ids with an unbounded CSPRNG), so a private room's seed order is the same kind of random. */
 function shuffle(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
 }

 /* The durable lifecycle command. ONE transaction holds the operation identity, the room-set
  * identity, the room document, the economy delta (only for a public table) and the outcome row, so
  * a crash or a concurrent delivery cannot leave a half-applied command behind. Every transition is
  * the frozen `src/tournament.js` one - this function only decides WHICH transition the command
  * names and refuses the ones the approved rules refuse. */
 async function run(principal, key, command) {
  if (!principal || typeof principal.actor !== 'string' || !principal.actor) fail('AUTH_REQUIRED');
  if (typeof key !== 'string' || key.length === 0 || key.length > 160 || !command) fail('INVALID_COMMAND');
  const cmd = clone(command);
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.type !== 'string' || !ROOM_COMMANDS.has(cmd.type)) fail('UNKNOWN_COMMAND');
  const actor = principal.actor;
  /* The V4 `party_commands` key layout: id = JSON.stringify([actor, key]). The repository splits it
   * back into (actor_id, "key") and JSON-encodes the bare key for the column, so the durable
   * uniqueness domain and the legacy key namespace are preserved exactly. */
  const operation = JSON.stringify([actor, key]);
  const fingerprint = fingerprintOf(cmd);
  await gate;
  return uow.run(async (tx) => {
   const repositories = tx.repositories;
   /* OPERATION IDENTITY FIRST and unconditionally (design 3.7): two deliveries of the same
    * (actor, key) serialize here, so the loser re-reads the winner's committed outcome instead of
    * applying a second lifecycle effect. */
   await lockTransactionIdentity(tx, 'operation', ['tournament', actor, key]);
   const previous = await repositories.outcomes.find(PARTY_COMMANDS, operation);
   if (previous) {
    if (previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
    /* The stored response IS the replay: the command is returned as committed and nothing runs
     * again. A member who has since left reads the approved `LEFT` answer instead (V4). */
    const prior = typeof previous.response === 'string' ? JSON.parse(previous.response) : previous.response;
    const current = prior && typeof prior.id === 'string' ? await repositories.tournaments.room(prior.id) : null;
    /* A room is never deleted, so an absent one can only mean a corrupt outcome row: fail closed
     * rather than answer a replay with an invented document. */
    if (!current) fail('ROOM_NOT_FOUND');
    return current.players.some((p) => p.id === actor) ? prior : { id: current.id, status: 'LEFT' };
   }
   /* THE ROOM-SET IDENTITY. `publicJoin` chooses among EVERY lobby table, so its decision spans the
    * room set - exactly the domain the source's single SQLite write transaction serialized. It is
    * the CREATE serialization point (a fresh room has no row to lock yet) and it keeps the
    * hydrate-then-derive read of the active set safe. It is deliberately taken AFTER this command's
    * own operation identity, which a settlement never takes: a settlement that held this coarse
    * identity while waiting on a room row a command already owns would deadlock, so settlement and
    * command are ordered by the ROOM ROW instead (see `lockRoomRow` and `settle`'s plan). */
   await lockTransactionIdentity(tx, 'aggregate', ['tournament', '*']);
   const now = tx.clock();
   const active = await repositories.tournaments.activeRooms();
   let room = null;
   let economy = null;
   if (cmd.type === 'create') {
    /* Private lobby. The approved owned-room bound is read from the durable active set, never kept
     * as a counter. */
    if (active.filter((r) => r.owner === actor).length >= ROOM_LIMIT) fail('ROOM_LIMIT');
    room = T.create({
     id: crypto.randomUUID(), code: await generateCode(tx), owner: actor, name: cmd.name, format: cmd.format,
     clock: cmd.clock === undefined || cmd.clock === null ? 180 : cmd.clock,
     increment: cmd.increment === undefined || cmd.increment === null ? 2 : cmd.increment, now,
    });
    T.join(room, actor, principal.name || actor, now);
   } else if (cmd.type === 'publicJoin') {
    /* Public table. The cohort choice is the frozen matchmaking policy (200-Elo spread, blocked /
    * friend exclusion, ten-seat cap); an entry nobody can afford is refused before the choice so a
    * player is never seated at a table they cannot pay for; a free table is created for them. */
    const quote = T.prize(cmd.table);
    economy = await repositories.state.read();
    const account = eligibleAccount(lookupAccount(economy, actor));
    if (account.activeMatch) fail('ALREADY_IN_MATCH');
    if (active.some((r) => r.table && r.players.some((p) => p.id === actor))) fail('ALREADY_QUEUED');
    if (account[quote.currency] < quote.entry) fail(`INSUFFICIENT_${quote.currency.toUpperCase()}`);
    const candidate = MM.selectTournamentRoom(active, economy, actor, cmd.table, now);
    if (candidate) {
     /* Room-set locking serializes commands, but NOT a standalone settle().
      * Lock the selected room row BEFORE wallets.lock/state.write, exactly
      * like settle(). Re-hydrate the live state under that lock: never save
      * an earlier activeRooms() snapshot over a terminal settlement. */
     await lockRoomRow(tx, candidate.id);
     const latest = await repositories.tournaments.freshRoom(candidate.id);
     if (latest && latest.status === 'LOBBY' && latest.table === cmd.table
      && latest.players.length < latest.capacity) room = latest;
    }
    if (!room) {
     room = T.create({ id: crypto.randomUUID(), code: await generateCode(tx),
      owner: 'service', name: `${quote.name} table`, table: cmd.table, now });
    }
    T.join(room, actor, principal.name || account.id, now);
   } else {
    /* THE ROOM AGGREGATE ROW, FIRST (V5-09-04 global order, design 3.7): every command that names an
     * existing room serializes on that room's own row BEFORE it reads the document, so two commands
     * on one room - and a settlement racing a lifecycle command - cannot interleave their economic
     * effect, and the loser re-reads the winner's committed state. A settlement takes the identical
     * first lock, so the two paths are mutually exclusive. `create`/`publicJoin` name no existing
     * room and therefore take nothing here; their serialization point is the room-set identity. */
    await lockRoomRow(tx, cmd.id);
    requireRoomCommandId(cmd.id);
    /* activeRooms() hydrated the aggregate BEFORE the room-row lock.
     * An independent settlement can finalize the room while this
     * command waits; using room() would return the cached old snapshot
     * even after FOR UPDATE and resurrect completed financial state. */
    room = await repositories.tournaments.freshRoom(cmd.id);
    if (!room) fail('ROOM_NOT_FOUND');
    if (cmd.type === 'join') {
     if (room.table) fail('USE_PUBLIC_QUEUE');
     /* A private room is joinable only when neither side has blocked the other. */
     economy = await repositories.state.read();
     const joining = lookupAccount(economy, actor);
     if (room.players.some((p) => joining.blocked.includes(p.id) || lookupAccount(economy, p.id).blocked.includes(actor))) fail('INELIGIBLE');
     T.join(room, actor, principal.name || actor, now);
    } else {
     if (!room.players.some((p) => p.id === actor) && principal.scope !== 'operator') fail('NOT_IN_ROOM');
     switch (cmd.type) {
      case 'ready': T.ready(room, actor, cmd.value, cmd.rulesVersion); break;
      case 'configure': T.configure(room, actor, { format: cmd.format, clock: cmd.clock, increment: cmd.increment }); break;
      /* HOST DEPARTURE CANCELS A LOBBY. `T.leave` is the approved rule: the host leaving a LOBBY
       * room transitions it to CANCELLED, while a guest is simply removed and the room stays
       * LOBBY. No command here may substitute a different answer. */
      case 'leave': T.leave(room, actor); break;
      case 'kick': if (room.table || room.status !== 'LOBBY' || room.owner !== actor || cmd.target === actor) fail('HOST_ONLY'); T.leave(room, cmd.target); break;
      /* Transfer hands ownership to a seated player inside LOBBY; the old host stays a player. */
      case 'transfer':
       if (room.table || room.status !== 'LOBBY' || room.owner !== actor || !room.players.some((p) => p.id === cmd.target)) fail('HOST_ONLY');
       room.owner = cmd.target; room.revision += 1; break;
      /* A public table starts automatically; a manual start exists for private rooms only. */
      case 'start': if (room.table) fail('AUTOMATIC_START_ONLY'); T.start(room, actor, shuffle(room.players.map((p) => p.id)), now); break;
      case 'matchReady': T.readyGame(room, cmd.fixture, actor, now); break;
      case 'move': T.move(room, cmd.fixture, actor, cmd.revision, cmd.move, now); break;
      case 'resign': T.resign(room, cmd.fixture, actor, now); break;
      /* Pause freezes the clocks; resume unfreezes them with the elapsed pause credited back and no
       * time gift. Both are the frozen rules' own arithmetic. */
      case 'pause': T.pause(room, actor, now); break;
      case 'resume': T.resume(room, actor, now); break;
      case 'cancel':
       if ((room.table && principal.scope !== 'operator') || (!room.table && room.owner !== actor)) fail('HOST_ONLY');
       if (room.settled || room.status === 'COMPLETE') fail('EVENT_FINISHED');
       room.status = 'VOID'; room.reason = 'CANCELLED'; room.revision += 1; break;
      default: fail('UNKNOWN_COMMAND');
     }
    }
   }
   /* The approved public-table financials, in the SAME transaction as the room write (V4 R13):
    * ten ready players reserve the entry and start automatically; any terminal table status settles
    * (payout on COMPLETE, refund otherwise) exactly once. `settleRoom` writes tournament records and
    * never a normal rating, so tournament play cannot move Elo.
    *
    * THE ACTORS ARE LOCKED BEFORE EITHER BRANCH MOVES MONEY (V5-09-04 global order): the players who
    * are about to be charged, and the contributors a settlement would release, are locked - the room
    * row, then occupancy and wallet, sorted - so a second command on this room cannot interleave its
    * own debit behind this one, and the wallet row is what a concurrent settlement serializes on.
    * The set is derived from the DURABLE document read under the room lock (the same rows
    * `settle()` plans from), and it covers both branches - the roster and the contributions. */
   if (room.table) {
    const actors = new Set(room.players.map((p) => p.id));
    for (const contribution of (room.contributions || [])) actors.add(contribution.id);
    if (actors.size > 0) await repositories.wallets.lock([...actors], { aggregate: { kind: 'tournament', id: room.id } });
    /* The pre-lock publicJoin aggregate was only for lobby selection, NEVER
     * an authoritative balance: another transaction could have changed the
     * actor's wallet while this join waited on the room/occupancy locks.
     * Invalidate and rehydrate under wallet locks before any debit or write.
     * Existing-room commands never read economy before these locks. */
    /* Any public command may have hydrated the aggregate before wallets
     * were locked (publicJoin for selection, other room commands through
     * freshRoom). Refresh ALL public command economy views under the
     * acquired wallet locks before debiting/reserving/settling. */
    economy = await repositories.state.refresh();
    if (cmd.type === 'publicJoin') {
     const funded = eligibleAccount(lookupAccount(economy, actor));
     const quote = T.prize(cmd.table);
     if (funded.activeMatch) fail('ALREADY_IN_MATCH');
     if (funded[quote.currency] < quote.entry) fail(`INSUFFICIENT_${quote.currency.toUpperCase()}`);
    }
    if (room.status === 'LOBBY' && room.players.length === 10 && room.players.every((p) => p.ready)) {
     reserveRoom(room, economy, now);
     T.start(room, 'service', MM.tournamentSeed(room.players.map((p) => p.id), economy), now);
    }
    /* A terminal public game normally settles INSIDE this command, not via
     * the separate settle() worker. Publish the SAME deterministic outbox
     * identity as settle() in this very transaction; otherwise a committed
     * payout/refund never notifies P10 consumers, and settle() sees the room
     * already settled so it cannot backfill the missing event. */
    const settledHere = settleRoom(room, economy, now);
    await repositories.state.write(economy);
    if (settledHere) {
     await emitSettlement(tx, room.id, {
      roomId: room.id, table: room.table, refunded: room.receipt.refunded === true,
      actor: 'service', reason: room.reason ?? (room.receipt.refunded ? 'CANCELLED' : 'EVENT_COMPLETE'),
      key: null,
     }, now);
    }
   }
   requireRoom(room);
   await repositories.tournaments.save(room);
   const response = T.view(room, now);
   /* Identity only, so a replay reads the committed room (see above) rather than a stale snapshot. */
   await repositories.outcomes.save(PARTY_COMMANDS, operation, fingerprint, JSON.stringify(response));
   return response;
  });
 }

 /* The settlement PLAN, read from the durable rows while this transaction already holds the room's
  * aggregate row lock. It answers three questions the settlement must not get wrong, and it answers
  * them WITHOUT hydrating the whole economy (an unlocked balance is never read):
  *
  *   - `settled`: has this room already committed a settlement? (`receipt_json` is the committed
  *     document, so the replay answer is returned verbatim.)
  *   - `due`: is a settlement owed right now - a public table, in a terminal status, still holding
  *     escrow?
  *   - `actors`: exactly the actors whose occupancy/wallet rows the settlement will touch: the seated
  *     roster, every escrow contributor and every ranked player, from the durable child rows. A
  *     settlement can therefore never lock fewer actors than it debits or credits.
  *
  * `null` means no such room. The rows are read under the room lock, so the plan cannot be invalidated
  * between this read and the effect. */
 async function lockedRoomSettlement(tx, roomId) {
  const rooms = (await tx.query('SELECT room_id, table_kind, status, escrow, settled, receipt_json FROM tournament.rooms WHERE room_id = $1', [roomId])).rows;
  if (!rooms.length) return null;
  const room = rooms[0];
  const settled = room.settled === true;
  const due = room.table_kind !== null && ['COMPLETE', 'VOID', 'CANCELLED'].includes(room.status)
   && Number(room.escrow) > 0 && !settled;
  /* One UNION ALL over the three places a settlement can touch an actor, de-duplicated: the seated
   * roster, the escrow contributors and the ranked players. The column is named by the first branch,
   * so the set is a single round trip with an unambiguous name. */
  const actors = (await tx.query(
   'SELECT DISTINCT actor_id FROM ('
   + ' SELECT actor_id FROM tournament.room_players WHERE room_id = $1'
   + ' UNION ALL SELECT actor_id FROM tournament.escrow_contributions WHERE room_id = $1'
   + ' UNION ALL SELECT unnest(ranking) AS actor_id FROM tournament.rooms WHERE room_id = $1'
   + ') AS claimed WHERE actor_id IS NOT NULL', [roomId])).rows
   .map((row) => row.actor_id).filter((actor) => typeof actor === 'string' && actor.length > 0);
  return { settled, due, receipt: settled && room.receipt_json !== null ? room.receipt_json : null, actors };
 }

 /* INDIVISIBLE SETTLEMENT (V5-09-04). One durable settlement of one tournament room, in ONE
  * transaction on the core_runtime pool, under the frozen global lock order:
  *
  *   room aggregate row (`FOR UPDATE`)  ->  affected actors (`wallets.lock`: occupancy then wallets,
  *   sorted)  ->  dependent rows (room document, `economy.ledger`, `economy.tournament_records`, the
  *   occupancy release, `ops.outbox`).
  *
  * The room row is taken FIRST and is what serializes two competing settlers: the loser blocks until
  * the winner commits, then re-reads the committed document and observes `settled === true`, so it
  * returns the existing receipt instead of applying a second payout or refund (exactly-once, spec 03
  * section 5). The `settled` guard is checked BEFORE any wallet lock, so a replay is a read, not a
  * lock storm.
  *
  * ONE STATUS, ONE EFFECT. A `COMPLETE` room pays the frozen quote shares and burns the approved
  * burn; a `VOID`/`CANCELLED` room refunds each contribution. A room that is not terminal (or whose
  * escrow was already released, or whose ranking hands off to `REVIEW`) settles nothing and answers
  * `{ settled: false, receipt: null }` - the settlement is not an error, it is simply not due. Only a
  * malformed id or an absent room is refused, with a stable code, before any lock is taken.
  *
  * `settleRoom` is the SAME approved arithmetic the command surface uses - the payout shares, the
  * burn, the per-placement tournament record and the `<roomId>:payout|refund:<actor>` ledger ids -
  * so the standalone settlement and an in-command settlement cannot drift. The occupancy release
  * rides the wallet diff (Core owns `core.actor_occupancy`), the records ride
  * `economy.tournament_records`, and the emitted event rides `ops.outbox`, all in this one unit of
  * work: a failure anywhere rolls back every one of them and the retry commits once (spec 03 section
  * 1). */
 async function settle(roomId, input = {}) {
  requireRoomClaimId(roomId);
  const { actor, reason, key } = requireSettleInput(input);
  await gate;
  return uow.run(async (tx) => {
   const repositories = tx.repositories;
   /* 1. THE ROOM ROW. The whole settlement decision is serialized on it, so the second of two
    *    competing settlers blocks here and can only ever observe the winner's committed document. */
   await lockRoomRow(tx, roomId);
   /* A targeted, LOCKED read of the settlement facts and the affected actor set, derived from the
    * durable child rows exactly like `core.js` derives participants from `match.participants`: the
    * plan comes from the rows, and the financial decision is re-derived from the aggregate under the
    * locks. `null` means no such room; absence is the only refusal before a lock on an actor. */
   const snapshot = await lockedRoomSettlement(tx, roomId);
   if (!snapshot) fail('ROOM_NOT_FOUND');
   /* 2. ALREADY SETTLED: the committed settlement is the answer. No wallet is locked, no row is
    *    written, no event is enqueued - a replay is structurally unable to double-pay. */
   if (snapshot.settled) return { settled: true, receipt: snapshot.receipt };
   /* A settlement is due only for a terminal table that still holds escrow. Anything else is a no-op,
    * and the caller is told so rather than being handed an invented receipt. */
   if (!snapshot.due) return { settled: false, receipt: null };
   /* 3. THE AFFECTED ACTORS, in the sorted order `wallets.lock` enforces, from the durable rows read
    *    under the room lock - never from the caller. The aggregate row is passed so the repository
    *    re-takes this same room row inside its own documented order (idempotent). */
   if (snapshot.actors.length > 0) {
    await repositories.wallets.lock(snapshot.actors, { aggregate: { kind: 'tournament', id: roomId } });
   }
   const now = tx.clock();
   /* 4. THE AGGREGATE, HYDRATED UNDER THE LOCKS. The wallet balances this settlement reads are the
    *    locked ones, so the payout cannot be computed from a value another transaction changed
    *    between planning and locking. */
   const economy = await repositories.state.read();
   const room = await repositories.tournaments.room(roomId);
   if (!room) fail('ROOM_NOT_FOUND');
   /* 5. THE ONE APPROVED EFFECT. `settleRoom` pays out or refunds, releases the reservation, zeroes
    *    the escrow, records the placements and writes the receipt. It returns false for the branches
    *    that pay nothing: an escrow already released (impossible here - the room row is held), or the
    *    approved REVIEW hand-off, where a held/suspended participant moves the table to REVIEW instead
    *    of paying it. That hand-off is a real room transition, so the room document is committed for
    *    it - without it the table would stay COMPLETE with an unreleased escrow and no way to retry. */
   const statusBefore = room.status;
   const settled = settleRoom(room, economy, now);
   if (!settled) {
    if (room.status !== statusBefore) await repositories.tournaments.save(room);
    return { settled: false, receipt: room.receipt ?? null };
   }
   const refunded = room.receipt.refunded === true;
   /* 6. THE DEPENDENT ROWS, all in this transaction: the economy projection (wallet reservation
    *    release, tournament records, the burn, the ledger and the occupancy release diff), the room
    *    document (receipt, escrow, settled, settled_at) and the durable outbox event. */
   await repositories.state.write(economy);
   await repositories.tournaments.save(room);
   await emitSettlement(tx, room.id, { roomId: room.id, table: room.table, refunded, actor, reason: room.reason ?? reason, key }, now);
   return { settled: true, receipt: room.receipt };
  });
 }

 /* The delivered room view for one member - the same `T.view` DTO every command returns, with the
  * review-only abuse metadata stripped. Read-only: it mutates nothing. */
 async function view(roomId, actor) {
  requireRoomLookup(roomId);
  if (typeof actor !== 'string' || actor.length === 0) fail('AUTH_REQUIRED');
  await gate;
  return uow.run(async (tx) => {
   const room = await tx.repositories.tournaments.room(roomId);
   if (!room) fail('ROOM_NOT_FOUND');
   if (!room.players.some((p) => p.id === actor)) fail('NOT_IN_ROOM');
   return T.view(room, tx.clock());
  });
 }

 /* ------------------------------------------------------- fenced claims (V5-09-03) */

 /* THE ROUND/CLOCK SWEEP LEASE. One worker owns a RUNNING/PAUSED room's round and clock sweep at a
  * time; the claim is a compare-and-set on `tournament.rooms.timer_lease_*` that succeeds when the
  * lease is free, expired, or ALREADY THIS OWNER's (re-entrant renewal by the same worker). A
  * competing owner holding a live lease updates zero rows and is refused with `null`, so the sweep a
  * worker is about to run is never duplicated. The deadline is `tx.clock() + leaseMs`; the row's own
  * live lease is compared against that same caller-clock instant, never SQL `now()`. */
 async function claimTimerLease(roomId, input = {}) {
  requireRoomClaimId(roomId);
  if (!input || typeof input !== 'object') fail('INVALID_CLAIM');
  const owner = requireLeaseOwner(input.owner);
  const leaseMs = requireLeaseMs(input.leaseMs);
  /* A requested epoch is a consistency check; only the live room revision is authority. */
  const epoch = input.epoch === undefined ? null : requireEpoch(input.epoch);
  await gate;
  return uow.run(async (tx) => {
   const now = tx.clock();
   const until = now + leaseMs;
   /* Expiry MUST compare against the current clock, not the NEW requested expiry:
    * asking for a longer lease cannot steal a healthy worker's active claim.
    * The fence is always the current durable revision, not an arbitrary epoch. */
   const rows = (await tx.query(
    'UPDATE tournament.rooms SET timer_lease_owner = $1, timer_lease_epoch = revision, timer_lease_until = $2'
    + " WHERE room_id = $3 AND status IN ('RUNNING', 'PAUSED')"
    + ' AND ($4::bigint IS NULL OR revision = $4)'
    + ' AND (timer_lease_owner IS NULL OR timer_lease_until <= $5 OR timer_lease_owner = $1)'
    + ' RETURNING timer_lease_epoch',
    [owner, atMs(until), roomId, epoch, atMs(now)])).rows;
   /* Zero rows means one of two things: a live lease owned by someone else (refused), or no such
    * room. Only the second is an error - a refusal is the normal, expected answer. */
   if (rows.length === 0) {
    if ((await roomRevision(tx, roomId)) === null) fail('ROOM_NOT_FOUND');
    return null;
   }
   return { owner, epoch: Number(rows[0].timer_lease_epoch), until };
  });
 }
 /* Give the sweep back early (a worker shutting down cleanly). Owner-scoped: a worker that lost the
  * lease to a newer owner clears nothing. `false` means the lease was no longer this owner's. */
 async function releaseTimerLease(roomId, input = {}) {
  requireRoomClaimId(roomId);
  if (!input || typeof input !== 'object') fail('INVALID_CLAIM');
  const owner = requireLeaseOwner(input.owner);
  await gate;
  return uow.run(async (tx) => {
   const updated = (await tx.query(
    'UPDATE tournament.rooms SET timer_lease_owner = NULL, timer_lease_epoch = NULL, timer_lease_until = NULL'
    + ' WHERE room_id = $1 AND timer_lease_owner = $2', [roomId, owner])).rowCount;
   return updated === 1;
  });
 }

 /* THE FIXTURE PROGRESSION LEASE. The same compare-and-set shape as the room sweep, on
  * `tournament.fixtures.lease_*`, with the fence epoch stamped from the room's revision NOW - so a
  * claim is a statement about the room state it was taken against. Expiry and same-owner renewal are
  * the same three-way condition as the room lease. */
 async function claimFixture(roomId, fixtureId, input = {}) {
  requireRoomClaimId(roomId);
  requireFixtureId(fixtureId);
  if (!input || typeof input !== 'object') fail('INVALID_CLAIM');
  const owner = requireLeaseOwner(input.owner);
  const leaseMs = requireLeaseMs(input.leaseMs);
  await gate;
  return uow.run(async (tx) => {
   const now = tx.clock();
   const until = now + leaseMs;
   /* `RETURNING lease_epoch` reads back the value the statement itself wrote, so the fence handed to
    * the caller is the room revision this claim was stamped with - never a later read of a room that
    * another worker has since advanced. */
   const rows = (await tx.query(
    /* The stored epoch is the room's CURRENT revision; the claim does not move the room's revision
     * (only an owner advancing the room does), so the returned fence is the instant the claim was
     * decided. */
    'UPDATE tournament.fixtures SET lease_owner = $1,'
    + ' lease_epoch = (SELECT revision FROM tournament.rooms WHERE room_id = $4), lease_until = $2'
    + ' WHERE room_id = $4 AND fixture_id = $3'
    + " AND status IN ('READY', 'PLAYING')"
    + " AND EXISTS (SELECT 1 FROM tournament.rooms r WHERE r.room_id = $4 AND r.status IN ('RUNNING', 'PAUSED'))"
    + ' AND (lease_owner IS NULL OR lease_until <= $5 OR lease_owner = $1)'
    + ' RETURNING lease_epoch',
    [owner, atMs(until), fixtureId, roomId, atMs(now)])).rows;
   if (!rows.length) { await requireFixtureRow(tx, roomId, fixtureId); return null; }
   return { owner, epoch: Number(rows[0].lease_epoch), until };
  });
 }
 /* FENCED COMPLETION. The completion is accepted only by the lease's CURRENT owner AND only while
  * the fixture's fence epoch still equals the room's current revision: a worker whose lease was
  * stolen, or whose epoch predates a newer owner's progression of the room, matches nothing, updates
  * zero rows and is told `false`. The epoch is revalidated against the LIVE room revision in this
  * statement (the join), so an old worker cannot finish after a newer one advanced the room even if
  * its own lease was never re-claimed. On success the fixture becomes DONE, the lease is released and
  * the fixture revision advances by one, so a replay of the same completion finds no leased row and
  * cannot double-advance. */
 async function completeFixture(roomId, fixtureId, input = {}) {
  requireRoomClaimId(roomId);
  requireFixtureId(fixtureId);
  if (!input || typeof input !== 'object') fail('INVALID_CLAIM');
  const owner = requireLeaseOwner(input.owner);
  const epoch = requireEpoch(input.epoch);
  await gate;
  return uow.run(async (tx) => {
   const updated = (await tx.query(
    'UPDATE tournament.fixtures f SET status = \'DONE\', lease_owner = NULL, lease_epoch = NULL,'
    + ' lease_until = NULL, revision = f.revision + 1'
    + ' FROM tournament.rooms r'
    + ' WHERE f.room_id = $1 AND f.fixture_id = $2 AND f.lease_owner = $3 AND f.lease_epoch = $4'
    + ' AND f.lease_epoch = r.revision AND r.room_id = f.room_id'
    + " AND r.status IN ('RUNNING', 'PAUSED') AND f.status IN ('READY', 'PLAYING')"
    + ' AND f.lease_until > $5',
    [roomId, fixtureId, owner, epoch, atMs(tx.clock())])).rowCount;
   return updated === 1;
  });
 }

 return Object.freeze({
  role: CORE_ROLE,
  /* Resolves to the verified schema chain; rejects if this database is not the supported one. */
  ready: gate,
  createRoom,
  getRoom,
  saveRoom,
  listRooms,
  activeRooms,
  /* The durable lifecycle command and its read-only view (V5-09-02). */
  run,
  view,
  /* Indivisible settlement/refund of one room, in ONE locked transaction (V5-09-04). */
  settle,
  /* Fenced timer and progression claims (V5-09-03): the round/clock sweep lease and the per-fixture
   * progression lease, both compare-and-set on the durable lease columns with the room's current
   * revision as the completion fence. */
  claimTimerLease,
  releaseTimerLease,
  claimFixture,
  completeFixture,
  /* Releases this service's unit-of-work state only. The pool is caller-owned (it carries a
   * cluster-wide connection-budget claim that must outlive one service) and is NEVER closed here,
   * and no borrowed core/ephemera dependency is touched - so a fresh service may be constructed over
   * the same pool, which is exactly what a restarted process does. Idempotent. */
  close() { uow.close(); },
 });
}

module.exports = { createTournamentService, CORE_ROLE };
