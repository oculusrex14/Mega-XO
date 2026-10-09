'use strict';
/* tests/v5-p07-recovery.test.js - V5 P07 task V5-07-04 distributed recovery (V5-07-04).
 *
 * PostgreSQL is the durable authority; Redis holds only ephemeral candidate indices, heartbeat
 * leases, per-actor claim locks and rebuildable match hints. This suite exercises the four crash/race
 * windows the distributed queue must survive, on a REAL owned loopback PostgreSQL 16 (the full
 * checksummed migration chain) and a REAL loopback Redis, and then asserts the recovery invariant.
 *
 *   1. A matcher dies BETWEEN the Redis claim and the database commit. The abandoned claim locks the
 *      candidates for exactly its lease; no durable row, reservation or event exists while it lapses;
 *      the clients keep heartbeating and stay searching; and once the lease lapses a second matcher
 *      re-claims the survivors and commits the pairing cleanly, charging nobody at offer time and
 *      exactly once per player on acceptance.
 *   2. Redis is wiped AFTER an assignment. The durable match, seats, terms hash, expiry and outbox
 *      event are byte-identical; both clients reconstruct `{state:'matched',...}` from PostgreSQL
 *      alone; and acceptance still transitions the match to PLAYING and funds the pot exactly once.
 *   3. A direct invitation accepted UNDER a parked queue assignment makes Core's `queue` command fail
 *      ALREADY_IN_MATCH. The assignment rolls back with zero match/participant/outbox rows, the
 *      direct match is preserved whole, and the innocent partner is requeued with its ORIGINAL
 *      joinedAt.
 *   4. The same race against a TOURNAMENT occupancy: the rollback leaves the occupancy and the room
 *      untouched and requeues the innocent partner.
 *   5. The recovery invariant: every actor is recoverably queued, assigned or explicitly cancelled,
 *      with zero ghost participants, ghost occupancy, torn seat sets or double-held reservations.
 *
 * Every Redis key lives in the fixture's OWN `keyVersion` namespace, so a wipe can never touch
 * another environment's or a sibling test's keys. Teardown closes the services and wipes only that
 * namespace; the lab drops the owned databases. Services close naturally; there is no force-exit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const D = require('../src/domain.js');
const { lockTransactionIdentity } = require('../packages/db/pg/locks.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_REDIS && HAVE_PG ? false : (!HAVE_REDIS ? 'no REDIS_URL' : 'no V5_PG_URL');

/* The owned loopback convenience URL is plaintext; a managed endpoint is `rediss://`. The adapter
 * refuses an un-opted-in plaintext URL, so this opts in exactly as the application must. */
const ephemeraOptions = (keyVersion) => ({
  url: REDIS_URL,
  environment: 'test',
  keyVersion,
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
});
const ephemeraFor = async (keyVersion) => {
  const service = await createEphemeraService(ephemeraOptions(keyVersion));
  assert.equal(await service.healthy(), true, 'the owned Redis must answer PING');
  return service;
};
/* Reads the candidate index through the SAME borrowed adapter the service uses. The window is
 * widened to ten years so a fixture clock that differs from the host clock can never hide a member
 * from an assertion; the returned ORDER is the index order (ascending score = FIFO position). */
const INDEX_WINDOW_MS = 315_360_000_000;
const index = async (ephemera, mode) => (await ephemera.peekCandidates(mode, { windowMs: INDEX_WINDOW_MS })).candidates;

/* `packages/services/queue.js` is loaded lazily so an environment with no gates set skips without
 * importing a module that may not exist yet in that checkout. */
let queueFacility = null;
const loadQueueFactory = () => {
  if (!queueFacility) {
    const mod = require('../packages/services/queue.js');
    assert.equal(typeof mod.createQueueService, 'function', 'packages/services/queue.js must export createQueueService');
    queueFacility = mod.createQueueService;
  }
  return queueFacility;
};

/* ---------------------------------------------------------------- oracle */

/* The frozen policy recomputed INDEPENDENTLY of the service: 1500 rating is the 'gold' tier (fee 12),
 * so a ranked queue pair funds 12 Coins each into a 24-Coin pot and nothing is charged before the
 * second acceptance. */
const TIER = D.basicTier(1500).id;
const RANKED = D.quote({ mode: 'ranked', from: TIER, to: TIER });
assert.equal(RANKED.currency, 'coins', 'the ranked oracle is a Coins quote');
assert.ok(RANKED.fee > 0, 'the ranked oracle has a positive entry fee');
/* A direct challenge is a Crowns aggregate: 40 Crowns from the challenger only. */
const DIRECT_AMOUNT = 40;

/* ---------------------------------------------------------------- fixtures */

const SEED = (actor, extra = {}) => ({ actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends', ...extra });
const ACTORS = ['svc_alice', 'svc_bob', 'svc_carol', 'svc_dave', 'svc_erin', 'svc_frank', 'svc_grace', 'svc_heidi'];
const DEFAULT_SEEDS = ACTORS.map((actor) => SEED(actor));

let dbSeq = 0;
/* A per-test fixture: its own owned database, its own ephemera namespace (`keyVersion`), its own
 * guarded pools, a real Core service and a controllable injected clock. Teardown is registered with
 * `t.after` so a failed assertion still closes the services and wipes only this namespace. */
async function harness(t, { keyVersion, seeds = DEFAULT_SEEDS } = {}) {
  if (!(await lab.boot(t))) return null;
  const create = loadQueueFactory();
  let clock = lab.CLOCK;
  const now = () => clock;
  const advance = (ms) => { clock += ms; };

  const database = await lab.createDatabase(`p07r${dbSeq++}`);
  if (seeds.length) await lab.seedActors(database, seeds);
  const pools = lab.poolsFor(database);
  /* Core is bound to the SAME injected clock the queue service uses, so a match committed by
   * `matchTick` carries the caller's instant rather than the lab's fixed CLOCK. */
  const core = await lab.coreFor(database, { clock: now });
  const ephemera = await ephemeraFor(keyVersion);

  /* The queue service reads durable eligibility/occupancy/match facts, so it is bound to the
   * `core_runtime` pool - the ONE runtime identity that may read `core.actor_occupancy` and
   * `match.matches`. Neither the pool nor the adapter is owned by the service. */
  const queue = create({ ephemera, core, pool: pools.core, now });
  const closers = [() => queue.close()];

  t.after(async () => {
    for (const close of closers) { try { await close(); } catch { /* best effort */ } }
    try { await core.close(); } catch { /* best effort */ }
    try { await ephemera.wipeNamespace(); } catch { /* only this namespace */ }
    try { await ephemera.close(); } catch { /* best effort */ }
  });

  /* A genuinely separate matcher process shape: its own adapter client and its own service instance
   * against the same namespace, as a second matcher deployment would be. */
  const attachMatcher = async () => {
    const adapter = await ephemeraFor(keyVersion);
    const matcher = create({ ephemera: adapter, core, pool: pools.core, now });
    closers.push(() => matcher.close());
    closers.push(() => adapter.close());
    return matcher;
  };

  /* Durable probes. `core_runtime` may read every table asserted here. */
  const rows = async (text, params = []) => (await pools.core.query(text, params)).rows;
  const row = async (text, params = []) => (await rows(text, params))[0] ?? null;
  const count = async (text, params = []) => {
    const found = await row(text, params);
    return found ? Number(Object.values(found)[0]) : 0;
  };
  /* `ops.outbox` is NOT readable by core_runtime beyond `outbox_id`, so outbox truth is read
   * through the lab's administrative connection - the same connection that owns the database. */
  const admin = (text, params = []) => lab.scalar(database, text, params);

  return { database, pools, core, ephemera, queue, attachMatcher, now, advance, rows, row, count, admin };
}

/* ---------------------------------------------------------------- service surfaces */

/* The pairing entry shape is read tolerantly: the durable assertions below are the contract, and a
 * pairing may carry either the candidate objects or their actor ids. */
const actorOf = (value) => (value && typeof value === 'object' ? (value.actor ?? value.id ?? null) : value ?? null);
const pairingActors = (pairing) => {
  const list = Array.isArray(pairing.players) ? pairing.players
    : Array.isArray(pairing.candidates) ? pairing.candidates : null;
  if (list) return list.map(actorOf).sort();
  return [actorOf(pairing.a ?? pairing.actorA), actorOf(pairing.b ?? pairing.actorB)].sort();
};
const pairingMatchId = (pairing) => {
  for (const candidate of [pairing.matchId, pairing.match_id, pairing.match?.id, pairing.id]) {
    if (typeof candidate === 'string' && candidate.startsWith('queue:')) return candidate;
  }
  return null;
};
const tick = (queue, mode, extra = {}) => {
  assert.equal(typeof queue.matchTick, 'function', 'packages/services/queue.js must expose matchTick (V5-07-03)');
  return queue.matchTick({ mode, matcherId: 'matcher-1', limit: 16, ...extra });
};
const join = (queue, actor, mode, opKey) => queue.join({ actor, mode, opKey, region: 'iad', latencyMs: 40 });

/* A sync-safe refusal check: the service raises `Error(code)` from an async method, but wrapping the
 * call in a thunk catches a synchronous validation throw just as well. */
const expectCode = (run, code) => lab.throwsCode(Promise.resolve().then(run), code);

/* Full rows through the lab's owning connection, for the content comparisons a wipe must not disturb
 * (core_runtime cannot read `ops.outbox` beyond its id). */
const adminRows = async (database, text, params = []) => {
  const client = await lab.adminClient(database);
  try { return (await client.query(text, params)).rows; } finally { await client.end(); }
};

/* The durable identity of a queue match, in one row: the columns a wipe must leave byte-identical. */
const MATCH_ROW = 'SELECT match_id, status, source, kind, mode, rated, currency, pool, contribution_a,'
  + ' contribution_b, accepted_count, escrow, terms_hash, created_at, expires_at'
  + ' FROM match.matches WHERE match_id = $1';

/* ============================================================ 1. matcher crash between claim and commit */

test('V5-07-04 recovery: a matcher that dies between the Redis claim and the database commit leaves no durable effect, and once the claim lease lapses a second matcher pairs the survivors cleanly', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'r704a' });
  if (!h) return;
  const { queue, ephemera } = h;

  /* The crashed matcher is a SEPARATE deployment: its own adapter, its own service instance. */
  const crashed = await h.attachMatcher();

  const alice = await join(queue, 'svc_alice', 'ranked', 'ra-1');
  h.advance(1000);
  const bob = await join(queue, 'svc_bob', 'ranked', 'ra-2');
  assert.equal(alice.state, 'searching');
  assert.equal(bob.state, 'searching');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_bob'], 'both players are queued in FIFO order');

  /* THE CRASH WINDOW: the matcher claims BOTH candidates with a 1 s claim lease... */
  const claims = await crashed.claimCandidates({ mode: 'ranked', limit: 16, matcherId: 'crashed-worker', leaseMs: 1000 });
  assert.deepEqual(claims.map((candidate) => candidate.actor).sort(), ['svc_alice', 'svc_bob'], 'the crashed matcher claimed both candidates');
  assert.equal(new Set(claims.map((candidate) => candidate.claimId)).size, 2, 'each claim carries its own claim id');
  assert.equal(claims.every((candidate) => candidate.joinedAt === alice.joinedAt || candidate.joinedAt === bob.joinedAt), true, 'a claim carries the entrant FIFO join time');

  /* ...and DIES: it never calls core.run and never releases. Nothing durable may exist. */
  assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 0, 'a killed matcher commits no match row');
  assert.equal(await h.count('SELECT count(*) AS n FROM match.participants'), 0, 'a killed matcher commits no seat');
  assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox')), 0, 'a killed matcher emits no durable event');
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match'"), 0, 'a killed matcher charges no ledger entry');
  assert.equal(Number((await h.row('SELECT coalesce(sum(reserved_coins), 0) + coalesce(sum(reserved_crowns), 0) AS n FROM economy.wallets')).n), 0, 'a killed matcher reserves no funds');
  assert.equal(await h.count("SELECT count(*) AS n FROM core.actor_occupancy WHERE actor_id IN ('svc_alice', 'svc_bob')"), 0, 'a killed matcher occupies nobody');

  /* The abandoned claim still holds the per-actor claim lock: no other matcher is handed these actors. */
  assert.deepEqual(await queue.claimCandidates({ mode: 'ranked', limit: 16, matcherId: 'matcher-live', leaseMs: 30000 }), [], 'a live (abandoned) claim is never handed to a second matcher');

  /* The CLIENTS never died: they keep heartbeating and keep searching, off the crash entirely. */
  const beat = await queue.heartbeat({ actor: 'svc_alice', mode: 'ranked' });
  assert.equal(beat.state, 'searching', 'an unassigned client recovers by heartbeating');
  assert.equal(beat.joinedAt, alice.joinedAt, 'the heartbeat never rewrites the FIFO join time');
  assert.equal((await queue.status('svc_bob')).state, 'searching', 'the unassigned partner still reads searching');

  /* THE LEASE LAPSES IN REAL TIME (it is the adapter's own Redis TTL, not the injected clock). */
  await lab.sleep(1200);
  assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 0, 'a lapsed claim alone commits nothing');

  /* A SECOND MATCHER re-claims the survivors and commits the pairing cleanly. */
  const recovered = await tick(queue, 'ranked', { now: h.now, makeId: () => 'r1' });
  assert.equal(recovered.matched, 1, 'the second matcher re-claims the survivors and commits exactly one pairing');
  const matchId = pairingMatchId(recovered.pairings[0]);
  assert.equal(matchId, 'queue:r1');
  assert.deepEqual(pairingActors(recovered.pairings[0]), ['svc_alice', 'svc_bob'], 'the recovered pairing names the two survivors');

  const match = await h.row(MATCH_ROW, [matchId]);
  assert.equal(match.status, 'OFFERED', 'the recovered assignment is an OFFERED match');
  assert.equal(match.source, 'queue');
  assert.equal(Number(match.accepted_count), 0);
  assert.equal(Number(match.escrow), 0, 'the recovered assignment holds no escrow');
  assert.equal(Number(match.pool), RANKED.pool);
  assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox WHERE outbox_id = $1', [`core.command:matchmaker:pair:${matchId}`])), 1, 'the recovered assignment emits exactly one durable event');
  assert.deepEqual(await index(ephemera, 'ranked'), [], 'the recovered pairing consumes both candidates');
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match'"), 0, 'the recovered assignment still charges nobody at offer time');

  /* NO DOUBLE CHARGE: both players accept the recovered match; each is funded exactly once. */
  await h.core.run({ actor: 'svc_alice', scope: 'player' }, 'ra-acc-a', { type: 'accept', id: matchId, termsHash: match.terms_hash });
  const playing = await h.core.run({ actor: 'svc_bob', scope: 'player' }, 'ra-acc-b', { type: 'accept', id: matchId, termsHash: match.terms_hash });
  assert.equal(playing.status, 'PLAYING', 'the recovered match runs normally');
  const wallets = await h.rows("SELECT actor_id, reserved_coins FROM economy.wallets WHERE actor_id IN ('svc_alice', 'svc_bob') ORDER BY actor_id");
  assert.deepEqual(wallets.map((wallet) => Number(wallet.reserved_coins)), [RANKED.contributions[0], RANKED.contributions[1]], 'each player funds exactly the approved contribution');
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match'"), 2, 'exactly one reservation per player, never two');
  assert.equal(Number((await h.row("SELECT reserved_coins FROM economy.wallets WHERE actor_id = 'svc_alice'")).reserved_coins), RANKED.contributions[0], 'a single reservation survives the whole crash-recovery cycle');
});

/* ============================================================ 2. Redis wipe after assignment */

test('V5-07-04 recovery: a total Redis wipe after assignment leaves the durable match, seats and outbox intact, both clients reconstruct matched from PostgreSQL and acceptance funds the pot exactly once', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'r704b' });
  if (!h) return;
  const { queue, ephemera, database } = h;

  await join(queue, 'svc_alice', 'ranked', 'rb-1');
  h.advance(1000);
  await join(queue, 'svc_bob', 'ranked', 'rb-2');
  const paired = await tick(queue, 'ranked', { now: h.now, makeId: () => 'w2' });
  assert.equal(paired.matched, 1, 'the two players are paired into an OFFERED match');
  const matchId = pairingMatchId(paired.pairings[0]);
  assert.equal(matchId, 'queue:w2');

  const before = await h.row(MATCH_ROW, [matchId]);
  assert.equal(before.status, 'OFFERED');
  const seatsBefore = await h.rows('SELECT seat, actor_id FROM match.participants WHERE match_id = $1 ORDER BY seat', [matchId]);
  assert.deepEqual(seatsBefore.map((seat) => seat.actor_id), ['svc_alice', 'svc_bob'], 'both players are seated in PostgreSQL');
  const outboxBefore = await adminRows(database, 'SELECT outbox_id, kind, state FROM ops.outbox ORDER BY outbox_id');
  assert.equal(outboxBefore.length, 1, 'the assignment emitted one durable outbox event');
  assert.equal(outboxBefore[0].outbox_id, `core.command:matchmaker:pair:${matchId}`);

  /* WIPE EVERY KEY IN THIS NAMESPACE through the service's own adapter. */
  const wiped = await ephemera.wipeNamespace();
  assert.equal(wiped.available, true, 'the owned adapter wiped its namespace');
  assert.ok(wiped.deleted >= 1, 'the namespace really held keys before the wipe');
  assert.deepEqual(await index(ephemera, 'ranked'), [], 'the candidate index is empty after the wipe');
  assert.deepEqual(await index(ephemera, 'casual'), [], 'no other index survives either');

  /* DURABLE POSTGRESQL ROWS 100% INTACT. */
  assert.deepEqual(await h.row(MATCH_ROW, [matchId]), before, 'the committed match row is byte-identical after the wipe');
  assert.deepEqual(await h.rows('SELECT seat, actor_id FROM match.participants WHERE match_id = $1 ORDER BY seat', [matchId]), seatsBefore, 'the seats are byte-identical after the wipe');
  assert.deepEqual(await adminRows(database, 'SELECT outbox_id, kind, state FROM ops.outbox ORDER BY outbox_id'), outboxBefore, 'the durable outbox event is byte-identical after the wipe');

  /* BOTH CLIENTS RECONSTRUCT `matched` FROM POSTGRESQL WITH AN EMPTY REDIS. */
  for (const actor of ['svc_alice', 'svc_bob']) {
    const seen = await queue.status(actor);
    assert.equal(seen.state, 'matched', `${actor} reads matched with no Redis at all`);
    assert.equal(seen.mode, 'ranked', 'the queue mode is reconstructed from the durable kind');
    assert.equal(seen.matchId, matchId);
    assert.equal(seen.termsHash, before.terms_hash, `${actor} receives the durable terms hash`);
    assert.equal(seen.expires, new Date(before.expires_at).getTime(), `${actor} receives the durable offer expiry`);
  }

  /* ACCEPTANCE PROCEEDS NORMALLY: OFFERED -> PLAYING, funds reserved exactly once, no stranded player. */
  const opened = await h.core.run({ actor: 'svc_alice', scope: 'player' }, 'rb-acc-a', { type: 'accept', id: matchId, termsHash: before.terms_hash });
  assert.equal(opened.status, 'OFFERED', 'the first acceptance only opens the seat');
  const playing = await h.core.run({ actor: 'svc_bob', scope: 'player' }, 'rb-acc-b', { type: 'accept', id: matchId, termsHash: before.terms_hash });
  assert.equal(playing.status, 'PLAYING', 'the second acceptance runs the match after the wipe');

  const committed = await h.row('SELECT status, accepted_count, escrow FROM match.matches WHERE match_id = $1', [matchId]);
  assert.equal(committed.status, 'PLAYING');
  assert.equal(Number(committed.accepted_count), 2);
  assert.equal(Number(committed.escrow), RANKED.pool, 'the pot is funded from the durable quote, not from Redis');

  const wallets = await h.rows("SELECT actor_id, coins, reserved_coins FROM economy.wallets WHERE actor_id IN ('svc_alice', 'svc_bob') ORDER BY actor_id");
  assert.deepEqual(wallets.map((wallet) => [Number(wallet.coins), Number(wallet.reserved_coins)]), [
    [1000 - RANKED.contributions[0], RANKED.contributions[0]],
    [1000 - RANKED.contributions[1], RANKED.contributions[1]],
  ], 'each player pays the approved contribution exactly once');
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match'"), 2, 'two reservations, one per player');

  /* NO DOUBLE CHARGE: the replayed acceptance changes nothing. */
  await h.core.run({ actor: 'svc_alice', scope: 'player' }, 'rb-acc-a', { type: 'accept', id: matchId, termsHash: before.terms_hash });
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE actor_id = 'svc_alice' AND reason = 'Reserved for match'"), 1, 'a replayed acceptance never charges twice');
  const after = await h.rows("SELECT reserved_coins FROM economy.wallets WHERE actor_id IN ('svc_alice', 'svc_bob') ORDER BY actor_id");
  assert.deepEqual(after.map((wallet) => Number(wallet.reserved_coins)), [RANKED.contributions[0], RANKED.contributions[1]], 'the reservations are unchanged by the replay');

  /* STILL DURABLE-ONLY: both players read the running match with Redis still empty. */
  for (const actor of ['svc_alice', 'svc_bob']) {
    const seen = await queue.status(actor);
    assert.equal(seen.state, 'matched');
    assert.equal(seen.matchId, matchId);
  }
  assert.deepEqual(await index(ephemera, 'ranked'), [], 'a status read never rebuilds the candidate index');
});

/* ============================================================ 3. direct invitation races a queue join */

test('V5-07-04 recovery: a direct challenge accepted under a parked queue assignment fails ALREADY_IN_MATCH, rolls back with zero rows and requeues the innocent partner with its original join time', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'r704c' });
  if (!h) return;
  const { queue, ephemera, core, database } = h;

  const alice = await join(queue, 'svc_alice', 'ranked', 'rc-1');
  h.advance(1000);
  const bob = await join(queue, 'svc_bob', 'ranked', 'rc-2');
  assert.equal(alice.state, 'searching');
  assert.equal(bob.state, 'searching');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_bob'], 'both players are queued');

  /* THE FORCED DATABASE RACE. Core's FIRST aggregate act on a match command is the IDENTITY mutex
   * (`lockTransactionIdentity(tx, 'aggregate', ['match', id])`); this test takes that EXACT lock
   * through the production function, so the gate can never drift from Core's vocabulary. The
   * assignment therefore parks AFTER the service has chosen its pair but BEFORE Core re-derives the
   * decision: the only window in which an actor can legitimately become occupied. The parked
   * transaction holds NO row lock yet, so a competing Core command can commit underneath it. */
  const gateClient = await lab.adminClient(database);
  await gateClient.query('BEGIN');
  await lockTransactionIdentity(gateClient, 'aggregate', ['match', 'queue:t3']);
  let gated = true;
  const releaseGate = async () => {
    if (!gated) return;
    gated = false;
    try { await gateClient.query('ROLLBACK'); } catch { /* best effort */ }
    try { await gateClient.end(); } catch { /* best effort */ }
  };
  const admin = await lab.adminClient(database);
  try {
    const ticked = tick(queue, 'ranked', { now: h.now, makeId: () => 't3' });
    ticked.catch(() => { /* observed below; an early refusal must not be an unhandled rejection */ });
    assert.equal(await lab.waitForLockWaiter(admin, 8000), true, 'matchTick blocks on the queue match aggregate identity lock Core takes');

    /* CONCURRENTLY alice accepts a DIRECT invitation on a DIFFERENT aggregate identity, occupying her. */
    const offer = await core.run({ actor: 'svc_alice', scope: 'player' }, 'rc-direct', { type: 'offer', id: 'match-t3', opponent: 'svc_carol', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } });
    const playing = await core.run({ actor: 'svc_carol', scope: 'player' }, 'rc-accept', { type: 'accept', id: 'match-t3', termsHash: offer.termsHash });
    assert.equal(playing.status, 'PLAYING', 'the direct challenge runs while the queue assignment is parked');
    assert.deepEqual(await h.rows("SELECT actor_id, kind, ref_id FROM core.actor_occupancy WHERE kind = 'match' ORDER BY actor_id"), [
      { actor_id: 'svc_alice', kind: 'match', ref_id: 'match-t3' },
      { actor_id: 'svc_carol', kind: 'match', ref_id: 'match-t3' },
    ], 'the direct match durably occupies exactly its two players');

    await releaseGate();
    const settled = await Promise.allSettled([ticked]);
    /* The parent contract: the assignment fails with ALREADY_IN_MATCH. A service that handles it
     * inline reports no pairing; one that surfaces it reports the code. Either way nothing commits. */
    if (settled[0].status === 'rejected') {
      assert.equal(settled[0].reason.message, 'ALREADY_IN_MATCH', 'the occupied actor is refused with ALREADY_IN_MATCH');
    } else {
      assert.equal(settled[0].value.matched, 0, 'the refused assignment reports no pairing');
      assert.deepEqual(settled[0].value.pairings, []);
    }

    /* ZERO ROWS FOR THE QUEUE MATCH - the transaction rolled back whole. */
    assert.equal(await h.count('SELECT count(*) AS n FROM match.matches WHERE match_id = $1', ['queue:t3']), 0, 'the rolled-back assignment leaves no match row');
    assert.equal(await h.count('SELECT count(*) AS n FROM match.participants WHERE match_id = $1', ['queue:t3']), 0, 'the rolled-back assignment leaves no seat');
    assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox WHERE outbox_id = $1', ['core.command:matchmaker:pair:queue:t3'])), 0, 'no outbox event survives the rollback');
    assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 1, 'the ONLY committed match is the competing invitation');

    /* THE DIRECT MATCH IS PRESERVED WHOLE. */
    const direct = await h.row('SELECT status, source, mode, terms_hash, escrow, accepted_count FROM match.matches WHERE match_id = $1', ['match-t3']);
    assert.equal(direct.status, 'PLAYING');
    assert.equal(direct.source, 'direct');
    assert.equal(direct.mode, 'direct');
    assert.equal(direct.terms_hash, offer.termsHash, 'the committed terms hash is untouched');
    assert.equal(Number(direct.escrow), DIRECT_AMOUNT, 'the direct pot is funded');
    assert.equal(Number(direct.accepted_count), 2);
    const aliceWallet = await h.row('SELECT coins, reserved_coins, reserved_crowns FROM economy.wallets WHERE actor_id = $1', ['svc_alice']);
    assert.deepEqual([Number(aliceWallet.coins), Number(aliceWallet.reserved_coins), Number(aliceWallet.reserved_crowns)], [1000, 0, DIRECT_AMOUNT], 'alice holds only the direct reservation');
    assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE actor_id = 'svc_bob' AND reason = 'Reserved for match'"), 0, 'the innocent partner is charged nothing at all');

    /* THE INNOCENT PARTNER IS REQUEUED WITH ITS ORIGINAL JOIN TIME. */
    assert.deepEqual(await index(ephemera, 'ranked'), ['svc_bob'], 'the occupied actor leaves the queue, the innocent partner stays');
    const reclaimed = await queue.claimCandidates({ mode: 'ranked', limit: 4, matcherId: 'rc-verify', leaseMs: 30000 });
    assert.deepEqual(reclaimed.map((candidate) => candidate.actor), ['svc_bob'], 'the requeued partner is claimable again with a released claim');
    assert.equal(reclaimed[0].joinedAt, bob.joinedAt, 'the partner keeps its ORIGINAL FIFO join time');
    await queue.releaseClaim({ mode: 'ranked', actor: 'svc_bob', requeue: true });
    assert.deepEqual(await index(ephemera, 'ranked'), ['svc_bob'], 'the partner survives the release');

    /* THE CODE ITSELF: replaying the exact command proves the cause while alice stays occupied. */
    await assert.rejects(
      () => core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'pair:queue:t3', { type: 'queue', id: 'queue:t3', a: 'svc_alice', b: 'svc_bob', mode: 'ranked', turnSeconds: 30 }),
      (error) => error.message === 'ALREADY_IN_MATCH',
      'the queue assignment command fails with ALREADY_IN_MATCH while an actor is occupied',
    );
    assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 1, 'the failed replay commits no second match');
    assert.equal(await h.count('SELECT count(*) AS n FROM match.participants WHERE match_id = $1', ['queue:t3']), 0, 'the failed replay commits no seat');
    assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox WHERE outbox_id = $1', ['core.command:matchmaker:pair:queue:t3'])), 0, 'the failed replay emits no event');

    /* The occupied actor is recoverable too: it is refused a re-join from durable truth and reports
     * its real, committed match rather than a queue wait. */
    await expectCode(() => join(queue, 'svc_alice', 'ranked', 'rc-3'), 'INELIGIBLE');
    const occupied = await queue.status('svc_alice');
    assert.equal(occupied.state, 'matched');
    assert.equal(occupied.matchId, 'match-t3', 'the occupied actor reads its committed match, never a queue wait');
  } finally {
    await releaseGate();
    try { await admin.end(); } catch { /* best effort */ }
  }
});

/* ============================================================ 4. tournament occupancy races a queue join */

test('V5-07-04 recovery: a tournament occupancy taken under a parked queue assignment fails ALREADY_IN_MATCH, preserves the occupancy and requeues the innocent partner', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'r704d' });
  if (!h) return;
  const { queue, ephemera, core, database } = h;

  const alice = await join(queue, 'svc_alice', 'ranked', 'rd-1');
  h.advance(1000);
  const bob = await join(queue, 'svc_bob', 'ranked', 'rd-2');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_bob'], 'both players are queued');

  const gateClient = await lab.adminClient(database);
  await gateClient.query('BEGIN');
  await lockTransactionIdentity(gateClient, 'aggregate', ['match', 'queue:t4']);
  let gated = true;
  const releaseGate = async () => {
    if (!gated) return;
    gated = false;
    try { await gateClient.query('ROLLBACK'); } catch { /* best effort */ }
    try { await gateClient.end(); } catch { /* best effort */ }
  };
  const admin = await lab.adminClient(database);
  try {
    const ticked = tick(queue, 'ranked', { now: h.now, makeId: () => 't4' });
    ticked.catch(() => { /* observed below */ });
    assert.equal(await lab.waitForLockWaiter(admin, 8000), true, 'matchTick blocks on the queue match aggregate identity lock');

    /* CONCURRENTLY alice joins a TOURNAMENT: the durable single-active-aggregate row is taken with
     * kind 'tournament', backed by a real room, exactly as the party/tournament flow claims it. */
    const at = new Date(lab.CLOCK).toISOString();
    await lab.installSql(database, [
      `INSERT INTO tournament.rooms (room_id, code, owner_id, status, created_at) VALUES ('room:t4', 'room-t4', 'svc_alice', 'RUNNING', '${at}')`,
      `INSERT INTO tournament.room_players (room_id, actor_id, ready, withdrawn, ordinal) VALUES ('room:t4', 'svc_alice', true, false, 0)`,
      `INSERT INTO core.actor_occupancy (actor_id, kind, ref_id, claimed_at) VALUES ('svc_alice', 'tournament', 'room:t4', '${at}')`,
    ]);
    assert.deepEqual(await h.row("SELECT kind, ref_id FROM core.actor_occupancy WHERE actor_id = 'svc_alice'"), { kind: 'tournament', ref_id: 'room:t4' }, 'the tournament claim is durable');

    await releaseGate();
    const settled = await Promise.allSettled([ticked]);
    if (settled[0].status === 'rejected') {
      assert.equal(settled[0].reason.message, 'ALREADY_IN_MATCH', 'the tournament-occupied actor is refused with ALREADY_IN_MATCH');
    } else {
      assert.equal(settled[0].value.matched, 0, 'the refused assignment reports no pairing');
      assert.deepEqual(settled[0].value.pairings, []);
    }

    /* ROLLBACK: no queue match row, no seat, no event. The tournament is untouched. */
    assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 0, 'the rolled-back assignment leaves no match row at all');
    assert.equal(await h.count('SELECT count(*) AS n FROM match.participants'), 0, 'the rolled-back assignment leaves no seat');
    assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox WHERE outbox_id = $1', ['core.command:matchmaker:pair:queue:t4'])), 0, 'no outbox event survives the rollback');
    assert.equal(await h.count('SELECT count(*) AS n FROM economy.ledger WHERE reason = \'Reserved for match\''), 0, 'the refused assignment charges nothing');
    assert.deepEqual(await h.row("SELECT kind, ref_id FROM core.actor_occupancy WHERE actor_id = 'svc_alice'"), { kind: 'tournament', ref_id: 'room:t4' }, 'THE TOURNAMENT OCCUPANCY IS PRESERVED');
    assert.equal(await h.count("SELECT count(*) AS n FROM tournament.rooms WHERE room_id = 'room:t4' AND status = 'RUNNING'"), 1, 'the tournament room is preserved');
    assert.equal(await h.count("SELECT count(*) AS n FROM tournament.room_players WHERE room_id = 'room:t4' AND actor_id = 'svc_alice' AND withdrawn = false"), 1, 'alice is still an active room member');

    /* THE INNOCENT PARTNER IS REQUEUED VERBATIM AND IMMEDIATELY CLAIMABLE. */
    assert.deepEqual(await index(ephemera, 'ranked'), ['svc_bob'], 'the tournament-occupied actor is dropped, the innocent partner stays queued');
    const reclaimed = await queue.claimCandidates({ mode: 'ranked', limit: 4, matcherId: 'rd-verify', leaseMs: 30000 });
    assert.deepEqual(reclaimed.map((candidate) => candidate.actor), ['svc_bob'], 'the requeued partner is claimable again');
    assert.equal(reclaimed[0].joinedAt, bob.joinedAt, 'the partner keeps its ORIGINAL FIFO join time');
    await queue.releaseClaim({ mode: 'ranked', actor: 'svc_bob', requeue: true });

    /* The code itself, replayed on the deterministic assignment id. */
    await assert.rejects(
      () => core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'pair:queue:t4', { type: 'queue', id: 'queue:t4', a: 'svc_alice', b: 'svc_bob', mode: 'ranked', turnSeconds: 30 }),
      (error) => error.message === 'ALREADY_IN_MATCH',
      'the queue assignment fails with ALREADY_IN_MATCH while the tournament claim is held',
    );
    assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 0, 'the failed replay commits no match');
    assert.deepEqual(await h.row("SELECT kind, ref_id FROM core.actor_occupancy WHERE actor_id = 'svc_alice'"), { kind: 'tournament', ref_id: 'room:t4' }, 'the failed replay never disturbs the tournament claim');

    /* A tournament occupant cannot re-enter the queue from durable truth either. */
    await expectCode(() => join(queue, 'svc_alice', 'ranked', 'rd-3'), 'INELIGIBLE');
  } finally {
    await releaseGate();
    try { await admin.end(); } catch { /* best effort */ }
  }
});

/* ============================================================ 5. the recovery invariant */

test('V5-07-04 recovery: every actor ends recoverably queued, assigned or explicitly cancelled, with zero ghost records and no double-held reservation', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'r704e' });
  if (!h) return;
  const { queue, ephemera, core } = h;

  /* ASSIGNED (OFFERED queue match): alice and bob. */
  await join(queue, 'svc_alice', 'ranked', 're-1');
  h.advance(1000);
  await join(queue, 'svc_bob', 'ranked', 're-2');
  const paired = await tick(queue, 'ranked', { now: h.now, makeId: () => 'e1' });
  assert.equal(paired.matched, 1, 'alice and bob are assigned');
  const queueMatchId = pairingMatchId(paired.pairings[0]);

  /* QUEUED (searching): dave. */
  h.advance(1000);
  const dave = await join(queue, 'svc_dave', 'ranked', 're-3');

  /* EXPLICITLY CANCELLED: carol. */
  h.advance(1000);
  await join(queue, 'svc_carol', 'casual', 're-4');
  assert.equal((await queue.cancel({ actor: 'svc_carol', opKey: 're-5' })).state, 'cancelled');

  /* ASSIGNED (PLAYING direct match, both durably occupied): erin and frank. */
  const offer = await core.run({ actor: 'svc_erin', scope: 'player' }, 're-direct', { type: 'offer', id: 'match-e1', opponent: 'svc_frank', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } });
  assert.equal((await core.run({ actor: 'svc_frank', scope: 'player' }, 're-accept', { type: 'accept', id: 'match-e1', termsHash: offer.termsHash })).status, 'PLAYING');

  /* ---- the durable/ephemeral truth this invariant partitions ---- */
  const live = await h.rows("SELECT m.match_id, m.status, m.pool, m.escrow, m.accepted_count, p.actor_id"
    + ' FROM match.matches m JOIN match.participants p ON p.match_id = m.match_id'
    + " WHERE m.status IN ('OFFERED', 'PLAYING') ORDER BY m.match_id, p.seat");
  const occupancy = await h.rows('SELECT actor_id, kind, ref_id FROM core.actor_occupancy ORDER BY actor_id');
  const queued = [...(await index(ephemera, 'ranked')), ...(await index(ephemera, 'casual'))];

  /* 1. QUEUED AND ASSIGNED ARE DISJOINT, AND NOBODY IS QUEUED TWICE. */
  const assigned = new Map();
  for (const seat of live) assigned.set(seat.actor_id, seat.match_id);
  assert.equal(new Set(queued).size, queued.length, 'no actor is queued twice');
  for (const actor of queued) assert.equal(assigned.has(actor), false, `${actor} is never both queued and assigned`);
  for (const actor of assigned.keys()) assert.equal(queued.includes(actor), false, `${actor} is never both assigned and queued`);

  /* 2. EVERY EXERCISED ACTOR IS EXACTLY ONE OF queued / assigned / explicitly cancelled. */
  assert.equal(queued.includes('svc_dave'), true, 'the searching actor is recoverably queued');
  assert.equal(assigned.get('svc_alice'), queueMatchId, 'alice is assigned the queue match');
  assert.equal(assigned.get('svc_bob'), queueMatchId, 'bob is assigned the queue match');
  assert.equal(assigned.get('svc_erin'), 'match-e1', 'erin is assigned the direct match');
  assert.equal(assigned.get('svc_frank'), 'match-e1', 'frank is assigned the direct match');
  assert.equal(assigned.has('svc_carol'), false, 'the cancelled actor owns no live seat');
  assert.equal(queued.includes('svc_carol'), false, 'the cancelled actor owns no queue entry');
  assert.equal(occupancy.some((row) => row.actor_id === 'svc_carol'), false, 'the cancelled actor owns no occupancy');
  for (const untouched of ['svc_grace', 'svc_heidi']) {
    assert.equal(queued.includes(untouched), false, `${untouched} was never queued`);
    assert.equal(assigned.has(untouched), false, `${untouched} was never assigned`);
    assert.equal(occupancy.some((row) => row.actor_id === untouched), false, `${untouched} was never occupied`);
  }

  /* 3. EVERY LIVE MATCH IS WELL-FORMED: exactly two distinct seats, and a PLAYING one holds the
   *    funded pot plus an occupancy claim for BOTH players (an OFFERED one holds nothing yet). */
  const byMatch = new Map();
  for (const seat of live) {
    if (!byMatch.has(seat.match_id)) byMatch.set(seat.match_id, []);
    byMatch.get(seat.match_id).push(seat);
  }
  assert.equal(byMatch.size, 2, 'exactly two live matches exist');
  for (const [matchId, seats] of byMatch) {
    assert.equal(seats.length, 2, `${matchId} seats exactly two players`);
    assert.equal(new Set(seats.map((seat) => seat.actor_id)).size, 2, `${matchId} seats two distinct players`);
    if (seats[0].status === 'PLAYING') {
      assert.equal(Number(seats[0].accepted_count), 2, `${matchId} has both acceptances`);
      assert.equal(Number(seats[0].escrow), Number(seats[0].pool), `${matchId} holds exactly its funded pot`);
      for (const seat of seats) {
        assert.equal(occupancy.some((row) => row.actor_id === seat.actor_id && row.kind === 'match' && row.ref_id === matchId), true, `${seat.actor_id} holds the occupancy claim for ${matchId}`);
      }
    } else {
      assert.equal(Number(seats[0].accepted_count), 0, `${matchId} is unaccepted`);
      assert.equal(Number(seats[0].escrow), 0, `${matchId} holds no escrow`);
    }
  }

  /* 4. ZERO GHOST RECORDS. */
  assert.equal(await h.count('SELECT count(*) AS n FROM match.participants p LEFT JOIN match.matches m ON m.match_id = p.match_id WHERE m.match_id IS NULL'), 0, 'no participant without a match');
  assert.equal(await h.count("SELECT count(*) AS n FROM core.actor_occupancy o WHERE (o.kind = 'match' AND NOT EXISTS (SELECT 1 FROM match.matches m WHERE m.match_id = o.ref_id)) OR (o.kind = 'tournament' AND NOT EXISTS (SELECT 1 FROM tournament.rooms r WHERE r.room_id = o.ref_id))"), 0, 'no occupancy without a backing aggregate');
  assert.equal(await h.count("SELECT count(*) AS n FROM match.matches m WHERE m.status IN ('OFFERED', 'PLAYING') AND (SELECT count(*) FROM match.participants p WHERE p.match_id = m.match_id) <> 2"), 0, 'no live match with a torn seat set');
  assert.equal(await h.count("SELECT count(*) AS n FROM (SELECT p.actor_id FROM match.participants p JOIN match.matches m ON m.match_id = p.match_id WHERE m.status IN ('OFFERED', 'PLAYING') GROUP BY p.actor_id HAVING count(*) > 1) AS dup"), 0, 'no actor is seated in two live matches');
  assert.equal(await h.count('SELECT count(*) AS n FROM match.matches m WHERE m.status = \'PLAYING\' AND m.escrow <> m.pool'), 0, 'no running match holds a pot other than its quote');

  /* 5. THE EPHEMERAL INDEX AND THE SEARCHING STATE AGREE FOR EVERY ACTOR. */
  for (const actor of ACTORS) {
    const seen = await queue.status(actor);
    const searching = queued.includes(actor);
    assert.equal(seen.state === 'searching', searching, `${actor}: the index and the reported state agree`);
    if (searching) assert.equal(seen.joinedAt, dave.joinedAt, `${actor} keeps its original FIFO join time`);
  }

  /* 6. THE QUEUED SEAT IS RECOVERABLE, AND NO LIVE CLIENT IS EVER REAPED AS A GHOST. */
  const reclaimed = await queue.claimCandidates({ mode: 'ranked', limit: 8, matcherId: 're-verify', leaseMs: 30000 });
  assert.deepEqual(reclaimed.map((candidate) => candidate.actor), ['svc_dave'], 'the still-queued actor is claimable again');
  assert.equal(reclaimed[0].joinedAt, dave.joinedAt, 'the queued actor keeps its original FIFO score');
  assert.equal(new Set(reclaimed.map((candidate) => candidate.claimId)).size, 1, 'the reclaimed seat carries a fresh claim');
  await queue.releaseClaim({ mode: 'ranked', actor: 'svc_dave', requeue: true });
  assert.equal(await queue.expireAbandoned({ mode: 'ranked', now: h.now() }), 0, 'no live client is reclaimed as abandoned');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_dave'], 'the queued actor survives the sweep');

  /* 7. MONEY MATCHES STATE: only the two played seats hold a reservation. */
  const wallets = await h.rows('SELECT actor_id, reserved_coins, reserved_crowns FROM economy.wallets ORDER BY actor_id');
  const held = new Map(wallets.map((wallet) => [wallet.actor_id, [Number(wallet.reserved_coins), Number(wallet.reserved_crowns)]]));
  assert.deepEqual(held.get('svc_alice'), [0, 0], 'an OFFERED queue seat reserves nothing');
  assert.deepEqual(held.get('svc_bob'), [0, 0], 'an OFFERED queue seat reserves nothing');
  assert.deepEqual(held.get('svc_carol'), [0, 0], 'a cancelled actor holds nothing');
  assert.deepEqual(held.get('svc_dave'), [0, 0], 'a queued actor holds nothing');
  assert.deepEqual(held.get('svc_erin'), [0, DIRECT_AMOUNT], 'the direct challenger holds exactly the direct stake');
  assert.deepEqual(held.get('svc_frank'), [0, 0], 'the direct opponent holds nothing');
  assert.deepEqual(held.get('svc_grace'), [0, 0], 'an untouched actor holds nothing');
  assert.deepEqual(held.get('svc_heidi'), [0, 0], 'an untouched actor holds nothing');
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match'"), 2, 'the direct match booked one reservation row per seat (the opponent contributes a zero-amount entry)');
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match' AND actor_id = 'svc_alice'"), 0, 'no reservation was ever booked against the queue pair');
});
