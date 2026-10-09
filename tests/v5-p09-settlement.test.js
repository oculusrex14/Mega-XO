'use strict';
/* tests/v5-p09-settlement.test.js - V5 P09 task V5-09-04 (Make settlement/refund indivisible).
 *
 * The durable authority for a tournament's money is ONE PostgreSQL transaction. Settling (or
 * refunding) a public table must take the global locks in the documented order - the room aggregate
 * first, then every affected actor in sorted id order (`wallets.lock`, which itself orders
 * occupancy before wallets) - and then commit the room row, the ledger entries, the
 * `economy.tournament_records` rows, the occupancy release and the durable outbox event together.
 * A crash anywhere inside that unit of work rolls the WHOLE thing back: zero wallets touched, zero
 * ledger rows written. A replay of an already-settled room returns the committed receipt WITHOUT a
 * second financial effect.
 *
 * This suite drives `service.settle(roomId, {reason, actor, key})` on a REAL owned PG16 database
 * through the service's own `core_runtime` pool and asserts the indivisibility on the durable
 * tables themselves:
 *
 *   1. completion payout  : room + wallets + 10 ledger entries + tournament_records + occupancy
 *                           release + outbox all commit in ONE transaction; the second call
 *                           replays the same receipt with NO further effect.
 *   2. cancellation refund: all ten entrants are refunded atomically, the escrow is zeroed, the
 *                           occupancy is released and NO payout record is written.
 *   3. racing workers     : two concurrent settlements (Promise.all) behind a held room lock
 *                           produce exactly ONE financial effect.
 *   4. forced crash       : a statement failure mid-transaction rolls back completely; the retry
 *                           after the fault is removed commits exactly once.
 *
 * The pre-settlement room is a COMPLETE (or VOID) ten-player public table whose terminal fields are
 * the exact ones the frozen `src/tournament.js` `advance`/`tick` write, persisted through the
 * service's own `createRoom`; the reserved wallets and the occupancy claims that a real `reserve`
 * would have produced are established directly, because this suite is about the settlement seam,
 * not the matchmaking choice that precedes it.
 *
 * Run: node --test --test-concurrency=1 tests/v5-p09-settlement.test.js
 * Skipped entirely without V5_PG_URL (or V5_PG_REQUIRED=1); the gate is a `skip`, never a fake pass.
 *
 * Teardown is `lab.installCleanup` (drop every owned database, close every guarded pool) plus a
 * per-test `t.after` that closes the service; the process exits naturally - no `process.exit`, no
 * force-exit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const T = require('../src/tournament.js');

/* Close every guarded pool and drop every owned database AFTER this suite's own `t.after` closes
 * the service instances. Natural process exit: no forceExit, no explicit process.exit. */
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

/* Ten distinct players. A settlement is only meaningful across a full table, so the roster is
 * exactly the ten seats `T.prize('low').seats` admits. */
const ROSTER = Object.freeze(['svc_s01', 'svc_s02', 'svc_s03', 'svc_s04', 'svc_s05',
 'svc_s06', 'svc_s07', 'svc_s08', 'svc_s09', 'svc_s10']);
const SEEDS = ROSTER.map((actor) => ({
 actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends',
}));
/* The pre-settlement wallet state a committed reservation leaves behind: the entry debited from the
 * available balance and held on the reserved side. */
const SEED_COINS = 1000;
/* A public table's owner is the service itself (server/rooms.js publicJoin creates it that way), so
 * the default settle actor and the room owner name the same principal. */
const OWNER = 'service';

/* `settle` must exist and be a function before a gated case may run: an absent method is a hard
 * failure on a gated checkout, never a silently passing skip. */
function settlementMethods(service) {
 for (const name of ['settle']) {
  assert.equal(typeof service[name], 'function', `the tournament service must expose ${name}() for indivisible settlement`);
 }
 return { settle: service.settle.bind(service) };
}

/* One owned database, its guarded core pool, one live tournament service bound to that pool and a
 * frozen clock. `t.after` closes the service; the pool is caller-owned and outlives it (the lab
 * closes every borrowed pool only after this suite's own teardown). No Redis is borrowed: settling a
 * room must never depend on ephemeral coordination. */
let dbSeq = 0;
async function open(t) {
 if (!(await lab.boot(t))) return null;
 const create = loadTournamentFactory();
 const database = await lab.createDatabase(`p09s${dbSeq++}`);
 await lab.seedActors(database, SEEDS);
 const pools = lab.poolsFor(database);
 const now = () => CLOCK;
 const service = create({ pool: pools.core, now });
 t.after(async () => { try { await service.close(); } catch { /* best effort */ } });
 const rows = async (text, params = []) => (await pools.core.query(text, params)).rows;
 const row = async (text, params = []) => (await rows(text, params))[0] ?? null;
 /* A superuser statement for harness-only fixtures (wallet/occupancy preconditions, the fault
  * injection). Nothing here is part of the behavior under test. */
 const exec = async (text, params = []) => {
  const client = await lab.adminClient(database);
  try { return await client.query(text, params); } finally { await client.end(); }
 };
 return { database, pools, service, settle: settlementMethods(service).settle, rows, row, exec };
}

/* ---------------------------------------------------------------- fixtures */

/* `createRoom` may hand back the id it created or a thin view of it; both name the same authority,
 * so the id is read without weakening the assertion. */
const roomIdOf = (value) => {
 if (typeof value === 'string') return value;
 if (!value || typeof value !== 'object') return null;
 return value.id ?? value.roomId ?? value.room_id ?? null;
};

/* A ten-player public table in its terminal state, persisted through the service. `status` names the
 * settlement branch: COMPLETE pays the frozen `T.prize` shares out of the escrow, VOID refunds every
 * contribution. The reserved wallets and the occupancy claims a real `reserve` would have produced
 * are written afterwards, so the settlement under test has real escrow to release. */
async function stageTerminal(h, { id, table = 'low', status = 'COMPLETE' }) {
 const quote = T.prize(table);
 const room = T.create({ id, code: id.toUpperCase(), owner: OWNER, name: 'Settlement Cup', table, now: CLOCK });
 ROSTER.forEach((actor, i) => T.join(room, actor, `Player ${i + 1}`, CLOCK + i + 1));
 room.status = status;
 room.ranking = status === 'COMPLETE' ? ROSTER.slice() : [];
 room.reason = status === 'COMPLETE' ? null : 'CANCELLED';
 room.escrow = quote.pool;
 room.contributions = ROSTER.map((actor) => ({ id: actor, amount: quote.entry }));
 room.settled = false;
 const created = roomIdOf(await h.service.createRoom(room));
 if (created !== null) assert.equal(String(created), id, 'the terminal room is persisted under its own id');
 await h.exec('UPDATE economy.wallets SET coins = $1, reserved_coins = $2 WHERE actor_id = ANY($3::text[])',
  [SEED_COINS - quote.entry, quote.entry, ROSTER]);
 await h.exec("INSERT INTO core.actor_occupancy (actor_id, kind, ref_id, claimed_at)"
  + ' SELECT a, \'tournament\', $1, $2 FROM unnest($3::text[]) AS a',
  [id, new Date(CLOCK).toISOString(), ROSTER]);
 return { quote };
}

/* The persisted room row's settlement facts. */
const roomFacts = (h, roomId) => h.row(
 'SELECT settled, escrow, receipt_json FROM tournament.rooms WHERE room_id = $1', [roomId]);
/* Every ledger entry this settlement produced, in a stable order. */
const ledgerOf = (h, roomId) => h.rows(
 'SELECT entry_id, actor_id, currency, amount, reason, source FROM economy.ledger WHERE entry_id LIKE $1 ORDER BY entry_id',
 [roomId + ':%']);
const occupancyOf = (h, roomId) => h.rows(
 "SELECT actor_id FROM core.actor_occupancy WHERE kind = 'tournament' AND ref_id = $1 ORDER BY actor_id", [roomId]);
const outboxOf = async (h, roomId) => (await h.exec(
 'SELECT outbox_id, kind, state FROM ops.outbox WHERE outbox_id = $1', ['tournament.settle:' + roomId])).rows[0] ?? null;
const walletsOf = (h) => h.rows(
 'SELECT actor_id, coins, reserved_coins FROM economy.wallets ORDER BY actor_id');
const burnsOf = async (h) => (await h.row('SELECT coins, crowns FROM economy.system_burns WHERE id = 1')) || { coins: 0, crowns: 0 };
const recordsOf = (h) => h.rows(
 'SELECT actor_id, entered, wins, runner_up, top3, top5, best_finish, finish_sum FROM economy.tournament_records ORDER BY actor_id');
const walletMap = async (h) => new Map((await walletsOf(h)).map((r) => [r.actor_id, r]));
/* The receipt as a plain JSON value, so a value read back from `receipt_json` compares equal to the
 * object the service returned. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/* One forced statement failure inside the settlement transaction: any ledger row this room writes
 * raises. Ledger rows are written AFTER the wallets in the same unit of work, so the abort proves
 * the whole transaction - not just the last statement - is atomic. */
async function installLedgerCrash(h, roomId) {
 const literal = "'" + String(roomId).replace(/'/g, "''") + "'";
 await h.exec(`CREATE FUNCTION economy.p09_settlement_crash() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
     IF NEW.entry_id LIKE (${literal} || ':%') THEN
       RAISE EXCEPTION 'FORCED_SETTLEMENT_CRASH';
     END IF;
     RETURN NEW;
   END $fn$`);
 await h.exec('CREATE TRIGGER p09_settlement_crash_trg BEFORE INSERT ON economy.ledger'
  + ' FOR EACH ROW EXECUTE FUNCTION economy.p09_settlement_crash()');
}
async function dropLedgerCrash(h) {
 await h.exec('DROP TRIGGER IF EXISTS p09_settlement_crash_trg ON economy.ledger');
 await h.exec('DROP FUNCTION IF EXISTS economy.p09_settlement_crash()');
}

/* ======================= 1. indivisible COMPLETE settlement payout ======================= */

test('V5-09-04: a COMPLETE table settles in ONE transaction - wallets, ledger, records, occupancy and outbox together - and replays without a second effect', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const roomId = 'room:s09complete';
 const { quote } = await stageTerminal(h, { id: roomId, table: 'low', status: 'COMPLETE' });

 const result = await h.settle(roomId, { reason: 'EVENT_COMPLETE' });
 assert.equal(result.settled, true, 'a terminal COMPLETE table settles');
 assert.ok(result.receipt && typeof result.receipt === 'object', 'a committed settlement hands back its receipt');

 /* The receipt is the frozen payout document: the escrow pool, the burn and one share per place. */
 const expectedPayouts = ROSTER.map((id, i) => ({ id, amount: quote.payouts[i] }));
 assert.equal(result.receipt.currency, quote.currency, 'the receipt names the escrow currency');
 assert.equal(result.receipt.pool, quote.pool, 'the receipt names the whole escrow pool');
 assert.equal(result.receipt.burn, quote.burn, 'the receipt names the burn');
 assert.equal(result.receipt.refunded, false, 'a COMPLETE table pays out, it does not refund');
 assert.deepEqual(plain(result.receipt.payouts), expectedPayouts, 'the receipt pays the frozen shares by place');

 /* The room row carries the committed settlement and an emptied escrow. */
 const facts = await roomFacts(h, roomId);
 assert.equal(facts.settled, true, 'rooms.settled is committed true');
 assert.equal(Number(facts.escrow), 0, 'rooms.escrow is zeroed in the same transaction');
 assert.deepEqual(plain(facts.receipt_json), plain(result.receipt), 'the persisted receipt is the receipt the service returned');

 /* Every wallet moved exactly once: the reservation released and the share credited. */
 const wallets = await walletMap(h);
 for (const [i, actor] of ROSTER.entries()) {
  const wallet = wallets.get(actor);
  assert.ok(wallet, `a wallet row exists for ${actor}`);
  assert.equal(Number(wallet.reserved_coins), 0, `${actor}: the reserved entry is released`);
  assert.equal(Number(wallet.coins), SEED_COINS - quote.entry + quote.payouts[i],
   `${actor}: place ${i + 1} is credited the frozen share ${quote.payouts[i]}`);
 }

 /* Exactly ONE ledger entry per actor, with the settlement's own ids. */
 const ledger = await ledgerOf(h, roomId);
 assert.equal(ledger.length, 10, 'exactly one ledger entry per seated player');
 const byEntry = new Map(ledger.map((r) => [r.entry_id, r]));
 for (const [i, actor] of ROSTER.entries()) {
  const entry = byEntry.get(`${roomId}:payout:${actor}`);
  assert.ok(entry, `${actor}: the payout entry id is <roomId>:payout:<actor>`);
  assert.equal(entry.actor_id, actor);
  assert.equal(entry.currency, quote.currency);
  assert.equal(Number(entry.amount), quote.payouts[i], `${actor}: the ledger amount is the frozen share`);
  assert.equal(entry.source, 'tournament', 'a settlement entry is tournament-sourced');
 }

 /* The burn is committed once, and the economy conserves: debited escrow = payouts + burn. */
 assert.equal(Number((await burnsOf(h)).coins), quote.burn, 'the burn is committed once');
 const total = [...wallets.values()].reduce((sum, w) => sum + Number(w.coins), 0);
 assert.equal(total, ROSTER.length * (SEED_COINS - quote.entry) + expectedPayouts.reduce((s, p) => s + p.amount, 0),
  'coins are conserved across the table');

 /* The placement records are the tournament ones - entered/finish per place - never ratings. */
 const records = await recordsOf(h);
 assert.equal(records.length, 10, 'every ranked player gains a tournament record');
 assert.equal(records.reduce((s, r) => s + Number(r.entered), 0), 10, 'each player is credited one tournament entry');
 assert.equal(records.reduce((s, r) => s + Number(r.finish_sum), 0), 55, 'finish placements 1..10 sum to 55');
 assert.equal(records.reduce((s, r) => s + Number(r.wins), 0), 1, 'exactly one winner');
 assert.equal(records.reduce((s, r) => s + Number(r.runner_up), 0), 1, 'exactly one runner-up');
 assert.equal(records.reduce((s, r) => s + Number(r.top3), 0), 3, 'three top-3 finishes');
 assert.equal(records.reduce((s, r) => s + Number(r.top5), 0), 5, 'five top-5 finishes');
 assert.equal(Math.min(...records.map((r) => Number(r.best_finish))), 1, 'the winner holds the best finish');

 /* The occupancy the table held is released, and the durable outbox event exists exactly once. */
 assert.equal((await occupancyOf(h, roomId)).length, 0, 'no player still claims the settled room');
 const outbox = await outboxOf(h, roomId);
 assert.ok(outbox, 'the settlement enqueued its outbox event');
 assert.equal(outbox.outbox_id, 'tournament.settle:' + roomId);
 assert.equal(outbox.state, 'queued', 'a fresh settlement event is queued');

 /* A replay returns the SAME committed receipt and performs no second financial effect. */
 const replay = await h.settle(roomId, { reason: 'EVENT_COMPLETE' });
 assert.equal(replay.settled, true, 'an already-settled room still answers settled');
 assert.deepEqual(plain(replay.receipt), plain(result.receipt), 'the replay hands back the committed receipt');
 assert.equal((await ledgerOf(h, roomId)).length, 10, 'no ledger entry is written twice');
 assert.equal((await occupancyOf(h, roomId)).length, 0, 'the replay releases nothing further');
 assert.equal(Number((await burnsOf(h)).coins), quote.burn, 'the replay burns nothing further');
 assert.equal((await h.exec('SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = $1', ['tournament.settle:' + roomId])).rows[0].n, 1,
  'the replay enqueues no second event');
 const replayWallets = await walletMap(h);
 for (const [i, actor] of ROSTER.entries()) {
  assert.equal(Number(replayWallets.get(actor).coins), SEED_COINS - quote.entry + quote.payouts[i],
   `${actor}: the replay pays nothing a second time`);
 }
});

/* ====================== 2. indivisible VOID/CANCELLED refund ====================== */

test('V5-09-04: a VOID table refunds all ten entrants atomically - escrow zeroed, one refund entry each, occupancy released, no payout record', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const roomId = 'room:s09void';
 const { quote } = await stageTerminal(h, { id: roomId, table: 'low', status: 'VOID' });

 const result = await h.settle(roomId, { reason: 'CANCELLED' });
 assert.equal(result.settled, true, 'a terminal VOID table settles (by refund)');
 assert.equal(result.receipt.refunded, true, 'the receipt marks the settlement as a refund');
 assert.equal(result.receipt.burn, 0, 'a refund burns nothing');
 assert.equal(result.receipt.pool, quote.pool, 'the receipt names the refunded pool');
 assert.deepEqual(plain(result.receipt.payouts), ROSTER.map((id) => ({ id, amount: quote.entry })),
  'every entrant is handed back exactly the entry fee');

 const facts = await roomFacts(h, roomId);
 assert.equal(facts.settled, true, 'the refund commits rooms.settled');
 assert.equal(Number(facts.escrow), 0, 'the escrow is zeroed by the refund');

 const wallets = await walletMap(h);
 for (const actor of ROSTER) {
  const wallet = wallets.get(actor);
  assert.equal(Number(wallet.reserved_coins), 0, `${actor}: the reservation is released`);
  assert.equal(Number(wallet.coins), SEED_COINS, `${actor}: the entry fee is refunded back`);
 }

 const ledger = await ledgerOf(h, roomId);
 assert.equal(ledger.length, 10, 'exactly one refund entry per entrant');
 for (const actor of ROSTER) {
  const entry = ledger.find((r) => r.entry_id === `${roomId}:refund:${actor}`);
  assert.ok(entry, `${actor}: the refund entry id is <roomId>:refund:<actor>`);
  assert.equal(Number(entry.amount), quote.entry, `${actor}: the entry fee is refunded`);
  assert.equal(entry.currency, quote.currency);
  assert.equal(entry.source, 'tournament');
 }

 assert.equal(Number((await burnsOf(h)).coins), 0, 'a refund never burns');
 assert.equal((await recordsOf(h)).reduce((s, r) => s + Number(r.entered), 0), 0, 'a refund credits no placement record');
 assert.equal((await occupancyOf(h, roomId)).length, 0, 'the occupancy is released by the refund');
 const outbox = await outboxOf(h, roomId);
 assert.ok(outbox, 'the refund enqueued its outbox event');
 assert.equal(outbox.state, 'queued');
});

/* ========================== 3. racing settlement workers ========================== */

test('V5-09-04: two concurrent settlements of the same room produce exactly ONE financial effect', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const roomId = 'room:s09race';
 const { quote } = await stageTerminal(h, { id: roomId, table: 'low', status: 'COMPLETE' });

 /* Hold the room aggregate lock, so BOTH settlements are provably in flight and blocked on the
  * documented first lock of the global order before either may proceed. */
 const blocker = await lab.adminClient(h.database);
 let settled;
 try {
  await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM tournament.rooms WHERE room_id = $1 FOR UPDATE', [roomId]);
  const races = Promise.all([
   h.settle(roomId, { reason: 'EVENT_COMPLETE' }),
   h.settle(roomId, { reason: 'EVENT_COMPLETE' }),
  ]);
  const waiting = await lab.waitForLockWaiter(blocker, 12000, 1);
  assert.ok(waiting, 'a racing settlement must be blocked on the room row lock');
  await blocker.query('COMMIT');
  settled = await races;
 } finally {
  try { await blocker.end(); } catch { /* best effort */ }
 }

 const [a, b] = settled;
 assert.equal(a.settled, true, 'the first worker settles');
 assert.equal(b.settled, true, 'the second worker reads the committed settlement');
 assert.deepEqual(plain(b.receipt), plain(a.receipt), 'both workers observe ONE committed receipt');

 const wallets = await walletMap(h);
 for (const [i, actor] of ROSTER.entries()) {
  assert.equal(Number(wallets.get(actor).coins), SEED_COINS - quote.entry + quote.payouts[i],
   `${actor}: paid exactly once, not twice`);
  assert.equal(Number(wallets.get(actor).reserved_coins), 0, `${actor}: the reservation is released exactly once`);
 }
 assert.equal((await ledgerOf(h, roomId)).length, 10, 'the race writes exactly ten ledger entries');
 assert.equal(Number((await burnsOf(h)).coins), quote.burn, 'the race burns exactly once');
 assert.equal((await occupancyOf(h, roomId)).length, 0, 'the occupancy is released');
 assert.equal((await h.exec('SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = $1', ['tournament.settle:' + roomId])).rows[0].n, 1,
  'the race enqueues exactly one outbox event');
 assert.equal((await recordsOf(h)).reduce((s, r) => s + Number(r.entered), 0), 10,
  'the race credits each tournament record exactly once');
});

/* ======================= 4. mid-transaction crash and rollback ======================= */

test('V5-09-04: a failure inside the settlement transaction rolls back completely, and a retry commits exactly once', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const roomId = 'room:s09crash';
 const { quote } = await stageTerminal(h, { id: roomId, table: 'low', status: 'COMPLETE' });

 /* Pre-crash truth, captured before the fault is armed. */
 const before = await walletMap(h);

 await installLedgerCrash(h, roomId);
 let error = null;
 try {
  await h.settle(roomId, { reason: 'EVENT_COMPLETE' });
 } catch (thrown) {
  error = thrown;
 }
 assert.ok(error, 'the forced statement failure must reject the settlement, never resolve it');
 assert.match(String(error.message), /FORCED_SETTLEMENT_CRASH/,
  'the abort is the injected fault, not an unrelated failure');

 /* Nothing survives the aborted unit of work. */
 const afterCrash = await walletMap(h);
 for (const actor of ROSTER) {
  assert.equal(Number(afterCrash.get(actor).coins), Number(before.get(actor).coins), `${actor}: coins unchanged by the crash`);
  assert.equal(Number(afterCrash.get(actor).reserved_coins), quote.entry, `${actor}: the reservation is intact`);
 }
 assert.equal((await ledgerOf(h, roomId)).length, 0, 'the crash wrote no ledger entry');
 const crashedFacts = await roomFacts(h, roomId);
 assert.equal(crashedFacts.settled, false, 'the crash left rooms.settled false');
 assert.equal(Number(crashedFacts.escrow), quote.pool, 'the crash left the escrow intact');
 assert.equal(crashedFacts.receipt_json, null, 'the crash committed no receipt');
 assert.equal((await occupancyOf(h, roomId)).length, 10, 'the crash left every occupancy claim in place');
 assert.equal((await outboxOf(h, roomId)), null, 'the crash enqueued no outbox event');
 assert.equal(Number((await burnsOf(h)).coins), 0, 'the crash burned nothing');
 assert.equal((await recordsOf(h)).length, 0, 'the crash wrote no placement record');

 /* The fault removed, the retry commits the whole settlement exactly once. */
 await dropLedgerCrash(h);
 const retry = await h.settle(roomId, { reason: 'EVENT_COMPLETE' });
 assert.equal(retry.settled, true, 'the retry settles');
 assert.deepEqual(plain(retry.receipt.payouts), ROSTER.map((id, i) => ({ id, amount: quote.payouts[i] })),
  'the retry pays the frozen shares');
 assert.equal((await ledgerOf(h, roomId)).length, 10, 'the retry writes exactly one entry per player');
 const healed = await walletMap(h);
 for (const [i, actor] of ROSTER.entries()) {
  assert.equal(Number(healed.get(actor).coins), SEED_COINS - quote.entry + quote.payouts[i], `${actor}: paid once by the retry`);
  assert.equal(Number(healed.get(actor).reserved_coins), 0, `${actor}: released once by the retry`);
 }
 const healedFacts = await roomFacts(h, roomId);
 assert.equal(healedFacts.settled, true, 'the retry commits rooms.settled');
 assert.equal(Number(healedFacts.escrow), 0, 'the retry zeroes the escrow');
 assert.equal((await occupancyOf(h, roomId)).length, 0, 'the retry releases every occupancy claim');
 assert.equal((await h.exec('SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = $1', ['tournament.settle:' + roomId])).rows[0].n, 1,
  'the retry enqueues exactly one event');
 assert.equal(Number((await burnsOf(h)).coins), quote.burn, 'the retry burns exactly once');
 assert.equal((await recordsOf(h)).reduce((s, r) => s + Number(r.entered), 0), 10, 'the retry credits each record once');
});
