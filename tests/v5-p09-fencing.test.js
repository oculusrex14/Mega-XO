'use strict';
/* tests/v5-p09-fencing.test.js - V5 P09 task V5-09-03 (Implement fenced timer and progression
 * claims).
 *
 * The durable authority for a tournament's progression is PostgreSQL: a worker that sweeps a due
 * fixture (or a room's round/clock) must first take a FENCED lease row in `tournament.rooms` /
 * `tournament.fixtures`, and every later mutation must still carry that fence. A worker whose lease
 * was stolen - or whose fence is older than the room's current revision - is refused, so a stale
 * worker can never act after a newer owner has progressed the tournament (ARCHITECTURE persistence
 * point 5).
 *
 * This suite drives the four public claim methods on a REAL owned PG16 database, through the
 * service's own `core_runtime` pool:
 *
 *   claimTimerLease(roomId, {owner, leaseMs, epoch})  -> {owner, epoch, until} | null
 *   releaseTimerLease(roomId, {owner})                -> boolean
 *   claimFixture(roomId, fixtureId, {owner, leaseMs}) -> {owner, epoch, until} | null
 *   completeFixture(roomId, fixtureId, {owner, epoch})-> boolean
 *
 * Every lease deadline is taken from the INJECTED clock (`options.now`), because the suite freezes
 * that clock: a lease computed from a SQL `now()` would never expire on command and expiry could
 * only be observed by sleeping. The clock advance below IS the passage of time.
 *
 * Case map (V5-09-03 verification: "A stale worker cannot act after a new owner has progressed the
 * tournament"):
 *   1. claim / refusal / expiry: A claims; B (different owner) is refused while A's lease is alive;
 *      after the lease expires B claims the same fixture successfully.
 *   2. stale-worker rejection: A claims at epoch N; the room revision advances to N+1; A's
 *      completeFixture(epoch N) returns false and leaves the fixture untouched; B claims fresh at
 *      epoch N+1 and completes it.
 *   3. room timer lease: A claims the round/clock sweep; B is refused while it is alive; B claims
 *      after expiry; the old owner cannot release the new owner's lease.
 *
 * Run: node --test --test-concurrency=1 tests/v5-p09-fencing.test.js
 * Skipped entirely without V5_PG_URL (or V5_PG_REQUIRED=1); the gate is a `skip`, never a fake pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');

/* Close every guarded pool and drop every owned database, AFTER this suite's own `t.after` closes
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

/* Two workers with genuinely different identities, and the room's owning player. A fence is only
 * meaningful between distinct owners, so the tests never reuse one worker string for both sides. */
const ROSTER = Object.freeze(['svc_f01', 'svc_f02', 'svc_f03', 'svc_f04', 'svc_f05', 'svc_f06', 'svc_f07', 'svc_f08']);
const WORKER_A = 'worker:fence-a';
const WORKER_B = 'worker:fence-b';

const SEEDS = ROSTER.map((actor) => ({
 actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends',
}));
const principal = (actor) => ({ actor, scope: 'player', name: actor });
const send = (h, actor, key, command) => h.service.run(principal(actor), key, command);

/* The four claim entry points must exist and be functions before a case may exercise them: an
 * absent method is a hard failure on a gated checkout, never a silently passing skip. */
function fencingMethods(service) {
 const methods = {};
 for (const name of ['claimTimerLease', 'releaseTimerLease', 'claimFixture', 'completeFixture']) {
  assert.equal(typeof service[name], 'function', `the tournament service must expose ${name}() for fenced claims`);
  methods[name] = service[name].bind(service);
 }
 return methods;
}

/* A `timestamptz` read back from PostgreSQL may surface as a Date, and a driver-free service may
 * hand back an ISO string; both name ONE instant, so the deadline is normalized to epoch
 * milliseconds before it is judged. Anything that is not a real instant is a failure. */
function msOf(value, what) {
 const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
 assert.ok(Number.isFinite(ms), `the claim must carry a real millisecond ${what} (saw ${String(value)})`);
 return ms;
}

/* A lease deadline is meaningful only inside the window the caller asked for, measured on the
 * INJECTED clock - not against a SQL `now()` that would ignore the frozen clock and never expire. */
function assertLiveLease(claim, { owner, leaseMs, epoch, now }) {
 assert.ok(Number.isFinite(now), 'the assertion needs the injected clock instant the claim was made at');
 assert.ok(claim && typeof claim === 'object', 'a granted claim is an object, never a bare boolean');
 assert.equal(claim.owner, owner, 'the claim is owned by the worker that asked for it');
 assert.ok(claim.epoch !== undefined && claim.epoch !== null, 'the claim carries a fence epoch');
 if (epoch !== undefined) assert.equal(Number(claim.epoch), Number(epoch), 'the claim carries the fence epoch it was granted at');
 const until = msOf(claim.until, 'deadline');
 assert.ok(until > now, `the deadline ${until} is in the future of the claim clock ${now}`);
 assert.ok(until <= now + leaseMs + 1, `the deadline ${until} is inside the requested window (${now}, ${now + leaseMs}]`);
 return until;
}

/* One owned database, its guarded core pool, one live tournament service bound to that pool and a
 * controllable clock. `t.after` closes the service; the pool is caller-owned and outlives it (the
 * lab closes every borrowed pool only after this suite's own teardown). */
let dbSeq = 0;
async function open(t) {
 if (!(await lab.boot(t))) return null;
 const create = loadTournamentFactory();
 const database = await lab.createDatabase(`p09f${dbSeq++}`);
 await lab.seedActors(database, SEEDS);
 const pools = lab.poolsFor(database);
 let clock = CLOCK;
 const service = create({ pool: pools.core, now: () => clock });
 t.after(async () => { try { await service.close(); } catch { /* best effort */ } });
 const rows = async (text, params = []) => (await pools.core.query(text, params)).rows;
 const row = async (text, params = []) => (await rows(text, params))[0] ?? null;
 return {
  database, pools, service, rows, row,
  claim: fencingMethods(service),
  now: () => clock,
  /* The injected clock is the ONLY time source: advancing it IS the lease expiring. */
  advance: (ms) => { clock += ms; return clock; },
 };
}

/* A seated private LOBBY room with a READY fixture, built through the approved command surface
 * only: create + join, then ready + start. `start` makes every group fixture READY with `opens`
 * set from the room's own round delay, which is exactly the shape a progression worker claims. */
async function seatRoomWithFixture(h, { keyBase = 'fence' } = {}) {
 const host = ROSTER[0];
 const members = ROSTER.slice(0, 4);
 const created = await send(h, host, `${keyBase}-create`, { type: 'create', name: 'Fence Cup', format: 'mixed', clock: 180, increment: 2 });
 assert.equal(created.status, 'LOBBY', 'a created room starts in the lobby');
 for (const actor of members.slice(1)) await send(h, actor, `${keyBase}-join-${actor}`, { type: 'join', id: created.id });
 for (const actor of members) {
  await send(h, actor, `${keyBase}-ready-${actor}`, { type: 'ready', value: true, rulesVersion: created.rulesVersion, id: created.id });
 }
 const started = await send(h, host, `${keyBase}-start`, { type: 'start', id: created.id });
 assert.equal(started.status, 'RUNNING', 'the seated, ready room starts');
 const fixture = started.fixtures.find((f) => f.status === 'READY');
 assert.ok(fixture, 'a started group room exposes at least one READY fixture to claim');
 /* A progression worker claims a fixture that is DUE, so the clock is parked just past the
  * fixture's own `opens` instant: the room's round delay is the only wait between start and the
  * first sweep, and nothing here sleeps for it. */
 const opens = Number(fixture.opens);
 if (Number.isFinite(opens) && opens > h.now()) h.advance(opens - h.now() + 1000);
 const stored = await h.row('SELECT revision, timer_lease_owner, timer_lease_epoch, timer_lease_until FROM tournament.rooms WHERE room_id = $1', [created.id]);
 assert.ok(stored, 'the started room is durably stored before any claim');
 /* No lease may be invented at start time: an unclaimed room carries the NULL lease tuple. */
 assert.equal(stored.timer_lease_owner, null, 'a freshly started room holds no timer lease');
 assert.equal(stored.timer_lease_epoch, null);
 assert.equal(stored.timer_lease_until, null);
 return { roomId: created.id, fixtureId: fixture.id, revision: Number(stored.revision) };
}

/* ================== 1. claim / refusal / expiry / steal for a fixture ================== */

test('V5-09-03: a fixture lease grants to one worker, refuses a concurrent owner, and can be taken over after it expires', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const { roomId, fixtureId } = await seatRoomWithFixture(h, { keyBase: 'fence1' });
 const leaseMs = 30000;

 /* FIRST CLAIM: nobody holds the fixture, so worker A is granted a fenced lease. */
 const first = await h.claim.claimFixture(roomId, fixtureId, { owner: WORKER_A, leaseMs });
 const firstUntil = assertLiveLease(first, { owner: WORKER_A, leaseMs, now: h.now() });
 assert.ok(Number(first.epoch) >= 0, 'the fence epoch is the room revision, a non-negative bigint');

 /* The claim is DURABLE, not an in-memory answer: the row carries the owner, the fence and the
  * identical deadline while the room stays untouched. */
 const held = await h.row('SELECT lease_owner, lease_epoch, lease_until FROM tournament.fixtures WHERE room_id = $1 AND fixture_id = $2', [roomId, fixtureId]);
 assert.equal(held.lease_owner, WORKER_A, 'the lease owner is committed on the fixture row');
 assert.equal(Number(held.lease_epoch), Number(first.epoch), 'the committed fence epoch equals the granted one');
 assert.equal(msOf(held.lease_until, 'deadline'), firstUntil, 'the committed deadline equals the granted one, to the millisecond');

 /* SECOND CONCURRENT CLAIM, DIFFERENT OWNER, LEASE ALIVE: refused with a null answer and no write.
  * Both workers ask for the same leaseMs, so the expiry branch is false while A's lease is alive. */
 const refused = await h.claim.claimFixture(roomId, fixtureId, { owner: WORKER_B, leaseMs });
 assert.equal(refused, null, 'a live lease refuses a different owner instead of stealing it');
 const stillHeld = await h.row('SELECT lease_owner, lease_epoch FROM tournament.fixtures WHERE room_id = $1 AND fixture_id = $2', [roomId, fixtureId]);
 assert.equal(stillHeld.lease_owner, WORKER_A, 'the refusal did not disturb the incumbent owner');
 assert.equal(Number(stillHeld.lease_epoch), Number(first.epoch), 'the refusal did not disturb the fence');

 /* RE-CLAIM BY THE SAME OWNER (the worker retrying its own sweep) is NOT a steal: the owner branch
  * of the claim predicate admits it, and the deadline is renewed. */
 const renewed = await h.claim.claimFixture(roomId, fixtureId, { owner: WORKER_A, leaseMs });
 const renewedUntil = assertLiveLease(renewed, { owner: WORKER_A, leaseMs, now: h.now() });
 assert.ok(renewedUntil >= firstUntil, 'the holder may renew its own lease without stealing it');

 /* EXPIRY: advance the injected clock past the deadline. The lease row is untouched - only time
  * moved - so a claim is now admissible for B. */
 h.advance(leaseMs + 1000);
 const stolen = await h.claim.claimFixture(roomId, fixtureId, { owner: WORKER_B, leaseMs });
 const stolenUntil = assertLiveLease(stolen, { owner: WORKER_B, leaseMs, now: h.now() });
 assert.equal(Number(stolen.epoch), Number(first.epoch), 'the takeover re-fences at the room revision, which no other worker has moved');
 assert.ok(stolenUntil > renewedUntil, 'the new owner holds a deadline freshly derived from the advanced clock');

 const after = await h.row('SELECT lease_owner, lease_epoch, lease_until FROM tournament.fixtures WHERE room_id = $1 AND fixture_id = $2', [roomId, fixtureId]);
 assert.equal(after.lease_owner, WORKER_B, 'the takeover is durable');
 assert.equal(msOf(after.lease_until, 'deadline'), stolenUntil, 'the taken-over deadline is durable');
});

/* ==================== 2. stale worker rejected after a newer fence ==================== */

test('V5-09-03: a stale worker whose fence predates the room revision cannot complete the fixture; a fresh owner can', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const { roomId, fixtureId, revision } = await seatRoomWithFixture(h, { keyBase: 'fence2' });
 const leaseMs = 60000;

 /* WORKER A CLAIMS AT EPOCH N (the room's current revision). */
 const claimA = await h.claim.claimFixture(roomId, fixtureId, { owner: WORKER_A, leaseMs });
 assertLiveLease(claimA, { owner: WORKER_A, leaseMs, epoch: revision, now: h.now() });
 const epochN = Number(claimA.epoch);
 assert.equal(epochN, revision, 'the claim epoch IS the room revision at claim time');

 /* THE TOURNAMENT PROGRESSES: the room revision advances to N+1. This is advanced directly on the
  * room row because the revision is the fence domain under test; a lifecycle command would be an
  * equivalent advance but also rewrite the fixture set, which would erase the very lease this case
  * is fencing. */
 await h.pools.core.query('UPDATE tournament.rooms SET revision = revision + 1 WHERE room_id = $1', [roomId]);
 const advanced = await h.row('SELECT revision FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(Number(advanced.revision), epochN + 1, 'the room progressed past the stale worker fence');

 /* STALE COMPLETION IS REFUSED. The passed fence no longer matches the room revision, so the
  * completion returns false and the fixture is left exactly as it was. */
 const staleComplete = await h.claim.completeFixture(roomId, fixtureId, { owner: WORKER_A, epoch: epochN });
 assert.equal(staleComplete, false, 'a worker fenced at N cannot complete after the room reached N+1');
 const untouched = await h.row("SELECT status, lease_owner FROM tournament.fixtures WHERE room_id = $1 AND fixture_id = $2", [roomId, fixtureId]);
 assert.notEqual(untouched.status, 'DONE', 'the refused completion did not mark the fixture DONE');
 assert.equal(untouched.lease_owner, WORKER_A, 'the refused completion left the lease row intact');

 /* A FRESH OWNER CLAIMS AT THE ADVANCED FENCE, and completes. `claimFixture` derives its epoch from
  * the CURRENT room revision, so B holds N+1 while A still holds the stale lease row: the claim
  * predicate admits B once A's lease has expired (the takeover path), which the clock supplies. */
 h.advance(leaseMs + 1000);
 const claimB = await h.claim.claimFixture(roomId, fixtureId, { owner: WORKER_B, leaseMs });
 assertLiveLease(claimB, { owner: WORKER_B, leaseMs, epoch: epochN + 1, now: h.now() });
 const epochNext = Number(claimB.epoch);
 assert.equal(epochNext, epochN + 1, 'the fresh claim carries the advanced fence');

 const freshComplete = await h.claim.completeFixture(roomId, fixtureId, { owner: WORKER_B, epoch: epochNext });
 assert.equal(freshComplete, true, 'the current owner at the current fence completes the fixture');
 const done = await h.row('SELECT status, lease_owner, lease_epoch, lease_until FROM tournament.fixtures WHERE room_id = $1 AND fixture_id = $2', [roomId, fixtureId]);
 assert.equal(done.status, 'DONE', 'the fixture is marked DONE');
 assert.equal(done.lease_owner, null, 'a completed fixture holds no lease');
 assert.equal(done.lease_epoch, null, 'a completed fixture holds no fence');
 assert.equal(done.lease_until, null, 'a completed fixture holds no deadline');

 /* The completion is terminal for the fence: a second completion by the SAME owner at the SAME
  * epoch finds no leased row and returns false, so a retry cannot double-advance. */
 const replay = await h.claim.completeFixture(roomId, fixtureId, { owner: WORKER_B, epoch: epochNext });
 assert.equal(replay, false, 'a completed fixture is no longer claimable, so a replay is refused');
});

/* ======================= 3. room timer lease expiry and release ======================= */

test('V5-09-03: the room timer lease grants once, refuses a second owner, expires into a takeover, and only its holder may release it', { skip: GATE }, async (t) => {
 const h = await open(t);
 if (!h) return;
 const { roomId, revision } = await seatRoomWithFixture(h, { keyBase: 'fence3' });
 const leaseMs = 20000;

 /* FIRST CLAIM: the round/clock sweep is granted to A, fenced at the room revision. */
 const first = await h.claim.claimTimerLease(roomId, { owner: WORKER_A, leaseMs, epoch: revision });
 const firstUntil = assertLiveLease(first, { owner: WORKER_A, leaseMs, epoch: revision, now: h.now() });

 const held = await h.row('SELECT timer_lease_owner, timer_lease_epoch, timer_lease_until FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(held.timer_lease_owner, WORKER_A, 'the timer lease owner is committed on the room row');
 assert.equal(Number(held.timer_lease_epoch), revision, 'the committed timer fence is the requested epoch');
 assert.equal(msOf(held.timer_lease_until, 'deadline'), firstUntil, 'the committed timer deadline equals the granted one');

 /* SECOND CONCURRENT CLAIM, DIFFERENT OWNER, LEASE ALIVE: refused. */
 const refused = await h.claim.claimTimerLease(roomId, { owner: WORKER_B, leaseMs, epoch: revision });
 assert.equal(refused, null, 'a live timer lease refuses a different owner');
 const stillHeld = await h.row('SELECT timer_lease_owner FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(stillHeld.timer_lease_owner, WORKER_A, 'the refusal did not disturb the incumbent timer lease');

 /* A STALE OWNER CANNOT RELEASE A LEASE IT NO LONGER HOLDS. Advance past A's deadline and let B take
  * the sweep over; then A's release finds no row owned by A and clears nothing. */
 h.advance(leaseMs + 1000);
 const takeover = await h.claim.claimTimerLease(roomId, { owner: WORKER_B, leaseMs, epoch: revision });
 const takeoverUntil = assertLiveLease(takeover, { owner: WORKER_B, leaseMs, now: h.now() });
 assert.ok(takeoverUntil > firstUntil, 'the takeover deadline is freshly derived from the advanced clock');

 const staleRelease = await h.claim.releaseTimerLease(roomId, { owner: WORKER_A });
 assert.equal(staleRelease, false, 'the old owner may not release the new owner timer lease');
 const afterStale = await h.row('SELECT timer_lease_owner, timer_lease_until FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(afterStale.timer_lease_owner, WORKER_B, 'the refused release left the new owner in place');
 assert.equal(msOf(afterStale.timer_lease_until, 'deadline'), takeoverUntil, 'the refused release left the deadline in place');

 /* THE HOLDER RELEASES: the whole tuple is cleared, so the room returns to the unclaimed state. */
 const released = await h.claim.releaseTimerLease(roomId, { owner: WORKER_B });
 assert.equal(released, true, 'the holder releases its own timer lease');
 const cleared = await h.row('SELECT timer_lease_owner, timer_lease_epoch, timer_lease_until FROM tournament.rooms WHERE room_id = $1', [roomId]);
 assert.equal(cleared.timer_lease_owner, null, 'the released timer lease clears the owner');
 assert.equal(cleared.timer_lease_epoch, null, 'the released timer lease clears the fence (rooms_timer_lease_tuple_ck)');
 assert.equal(cleared.timer_lease_until, null, 'the released timer lease clears the deadline');

 /* After a clean release a third worker may claim immediately, with no wait for expiry. */
 const afterRelease = await h.claim.claimTimerLease(roomId, { owner: WORKER_A, leaseMs, epoch: revision });
 assertLiveLease(afterRelease, { owner: WORKER_A, leaseMs, now: h.now() });
});
