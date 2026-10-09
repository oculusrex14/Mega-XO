'use strict';
/* tests/v5-p07-match.test.js - V5 P07 task V5-07-03 commit assignments transactionally (V5-07-03).
 *
 * SCOPE. Exercises `queue.matchTick` from `packages/services/queue.js` against the REAL owned
 * PostgreSQL 16 lab (`tests/v5-pg-lab.js`) and the REAL loopback Redis ephemera adapter
 * (`packages/services/ephemera.js`). The assignment itself is committed by the REAL Core service
 * (`packages/services/core.js`) through `match.matches` / `match.participants` / `ops.outbox`, and
 * every expected amount is DERIVED from the frozen policy oracle (`src/domain.js`) - never re-typed.
 *
 * What the suite proves (G07: multiple matchers cannot double-assign, double-charge or lose
 * committed entrants; current matching and charge timing remain unchanged):
 *
 *   1. TRANSACTIONAL ASSIGNMENT. Two queued players are paired by `matchTick`; the match is committed
 *      in PostgreSQL as OFFERED (queue source, kind ranked/casual, turnSeconds 30/60, accepted_count
 *      0, NOTHING charged), the durable outbox event exists, both candidates are removed from the
 *      candidate index and `status()` reports `matched` from durable truth.
 *   2. RACING MATCHERS. Two matchers race the same actors concurrently; at most ONE assignment per
 *      actor pair and exactly one durable effect per committed match, no actor double-assigned and
 *      no entrant lost or duplicated.
 *   3. OCCUPANCY COLLISION (forced database race). Core's aggregate IDENTITY mutex is held by the
 *      test (taken through the production `lockTransactionIdentity`), parking the assignment after
 *      the pair is chosen but before Core re-derives it; the opponent then becomes durably occupied.
 *      The command fails with ALREADY_IN_MATCH, the transaction rolls back with zero phantom rows and
 *      zero outbox events, the occupied actor leaves the queue (requeue:false) and the innocent
 *      partner is requeued verbatim.
 *   4. RANKED COIN REQUIREMENT. A player who cannot fund the ranked quote fee is never paired.
 *   5. FIFO FAIRNESS. The older candidate is selected over a newer compatible one.
 *   6. UNPAIRED CANDIDATES KEEP THEIR ORIGINAL FIFO SCORE after a release, and `limit` claims the
 *      oldest candidates only.
 *
 * GATING (repo convention): needs BOTH the owned loopback Redis (`REDIS_URL`, or
 * `V5_REDIS_REQUIRED=1` to fail instead of skip) and the owned PostgreSQL lab (`V5_PG_URL`, or
 * `V5_PG_REQUIRED=1`). Absent either, the suite skips. Teardown is the lab's `installCleanup`
 * (guarded pools closed, owned databases dropped) plus a per-test wipe of this test's OWN ephemera
 * `keyVersion` namespace - never another environment's, never a sibling's. Services close naturally;
 * there is no force-exit.
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
let queueFactory = null;
const loadQueueFactory = () => {
  if (!queueFactory) {
    const mod = require('../packages/services/queue.js');
    assert.equal(typeof mod.createQueueService, 'function', 'packages/services/queue.js must export createQueueService');
    queueFactory = mod.createQueueService;
  }
  return queueFactory;
};

/* ---------------------------------------------------------------- oracle */

/* The frozen policy recomputed INDEPENDENTLY of the service: 1500 rating is the 'gold' tier
 * (fee 12), so a ranked queue pair funds 12 Coins each into a 24-Coin pot and nothing is charged
 * before the second acceptance. The casual queue is the unranked (free) shape. */
const TIER = D.basicTier(1500).id;
const RANKED = D.quote({ mode: 'ranked', from: TIER, to: TIER });
const CASUAL = D.quote({ mode: 'casual' });
assert.equal(RANKED.currency, 'coins', 'the ranked oracle is a Coins quote');
assert.ok(RANKED.fee > 0, 'the ranked oracle has a positive entry fee');

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

  const database = await lab.createDatabase(`p07m${dbSeq++}`);
  if (seeds.length) await lab.seedActors(database, seeds);
  const pools = lab.poolsFor(database);
  /* Core is bound to the SAME injected clock the queue service uses, so a match committed by
   * `matchTick` carries the caller's instant (`created_at`) rather than the lab's fixed CLOCK. */
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

/* ---------------------------------------------------------------- matchTick surface */

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
/* The advisory identity key Core takes for the aggregate of a match command is NOT re-derived here:
 * the collision test takes it through the production function `lockTransactionIdentity` itself, so
 * the gate can never drift from the vocabulary Core actually uses. */

const join = (queue, actor, mode, opKey) => queue.join({ actor, mode, opKey, region: 'iad', latencyMs: 40 });

/* ---------------------------------------------------------------- 1. transactional assignment */

test('V5-07-03 match: two queued players are paired into a committed OFFERED match with a durable outbox event and no charge', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'm703a' });
  if (!h) return;
  const { queue, ephemera, core } = h;

  const alice = await join(queue, 'svc_alice', 'ranked', 'ma-1');
  h.advance(1000);
  const bob = await join(queue, 'svc_bob', 'ranked', 'ma-2');
  assert.equal(alice.state, 'searching');
  assert.equal(bob.state, 'searching');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_bob'], 'both players are queued in FIFO order');

  const result = await tick(queue, 'ranked', { now: h.now });
  assert.equal(result.matched, 1, 'exactly one assignment is committed');
  assert.equal(result.pairings.length, 1);
  const pairing = result.pairings[0];
  assert.deepEqual(pairingActors(pairing), ['svc_alice', 'svc_bob'], 'the pairing names the two claimed actors');
  const matchId = pairingMatchId(pairing);
  assert.ok(matchId, 'the pairing carries the queue match id');
  assert.ok(matchId.startsWith('queue:'), 'a queue assignment id is namespaced by `queue:`');

  /* DURABLE ASSIGNMENT: one OFFERED queue match, both seats, accepted_count 0. */
  const match = await h.row('SELECT status, source, kind, mode, rated, currency, turn_seconds, pool, contribution_a, contribution_b, accepted_count, escrow, terms_hash, created_at, expires_at FROM match.matches WHERE match_id = $1', [matchId]);
  assert.ok(match, 'the match row is committed in PostgreSQL');
  assert.equal(match.status, 'OFFERED', 'the assignment is an OFFERED match, not a started one');
  assert.equal(match.source, 'queue');
  assert.equal(match.kind, 'ranked', 'a ranked queue assignment carries kind ranked');
  assert.equal(match.rated, true);
  assert.equal(match.turn_seconds, 30, 'ranked queue matches use the 30 s turn timer');
  assert.equal(Number(match.accepted_count), 0, 'no seat has accepted yet');
  assert.equal(Number(match.escrow), 0, 'the assignment holds no escrow');
  assert.equal(match.currency, RANKED.currency, 'the quote currency comes from the frozen policy');
  assert.equal(Number(match.pool), RANKED.pool, 'the pot is the approved equal-contribution pot');
  assert.deepEqual([Number(match.contribution_a), Number(match.contribution_b)], RANKED.contributions, 'both seats fund the approved equal contribution');
  const seats = await h.rows('SELECT actor_id FROM match.participants WHERE match_id = $1 ORDER BY seat', [matchId]);
  assert.deepEqual(seats.map((s) => s.actor_id), ['svc_alice', 'svc_bob'], 'both players are seated in claim order');

  /* DURABLE EVENT: one outbox row for the matchmaker pairing command, keyed by the match id. */
  const outboxId = `core.command:matchmaker:pair:${matchId}`;
  assert.equal(await h.admin('SELECT kind FROM ops.outbox WHERE outbox_id = $1', [outboxId]), 'core.command', 'the committed assignment emits one durable outbox event');
  assert.equal(await h.admin('SELECT state FROM ops.outbox WHERE outbox_id = $1', [outboxId]), 'queued', 'the event is enqueued for delivery');
  assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox')), 1, 'the assignment emits exactly one event');

  /* NOTHING CHARGED: the contribution is reserved only on the second acceptance. */
  assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match'"), 0, 'the assignment charges nobody');
  for (const actor of ['svc_alice', 'svc_bob']) {
    const wallet = await h.row('SELECT coins, reserved_coins FROM economy.wallets WHERE actor_id = $1', [actor]);
    assert.equal(Number(wallet.coins), 1000, `${actor} keeps its balance at offer time`);
    assert.equal(Number(wallet.reserved_coins), 0, `${actor} has no reservation before accepting`);
  }

  /* CANDIDATES REMOVED: the assignment consumes both index members (requeue:false). */
  assert.deepEqual(await index(ephemera, 'ranked'), [], 'both assigned candidates leave the candidate index');

  /* CLIENTS NOTIFIED: `status()` reads the committed match, not the (now empty) queue. */
  const seen = await queue.status('svc_alice');
  assert.equal(seen.state, 'matched', 'the assigned player immediately reads matched');
  assert.equal(seen.matchId, matchId);
  assert.equal(seen.termsHash, match.terms_hash, 'the client receives the durable terms hash');
  assert.equal(seen.expires, new Date(match.expires_at).getTime(), 'the client receives the durable offer expiry');

  /* Idempotence of the tick: an emptied queue assigns nothing more. */
  const again = await tick(queue, 'ranked', { now: h.now });
  assert.equal(again.matched, 0, 'a second tick finds no candidates');
  assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox')), 1, 'no second event is emitted');

  /* CASUAL: the same transactional shape with the unranked quote and the 60 s turn timer. */
  await join(queue, 'svc_carol', 'casual', 'ma-3');
  h.advance(1000);
  await join(queue, 'svc_dave', 'casual', 'ma-4');
  const casual = await tick(queue, 'casual', { now: h.now });
  assert.equal(casual.matched, 1, 'the casual queue assigns too');
  const casualId = pairingMatchId(casual.pairings[0]);
  assert.deepEqual(pairingActors(casual.pairings[0]), ['svc_carol', 'svc_dave']);
  const casualMatch = await h.row('SELECT source, kind, rated, currency, turn_seconds, pool, escrow FROM match.matches WHERE match_id = $1', [casualId]);
  assert.equal(casualMatch.source, 'queue');
  assert.equal(casualMatch.kind, 'casual', 'a casual queue assignment carries kind casual');
  assert.equal(casualMatch.rated, CASUAL.rated, 'the casual assignment is unranked');
  assert.equal(casualMatch.currency, CASUAL.currency, 'the casual assignment carries no currency');
  assert.equal(Number(casualMatch.pool), CASUAL.pool, 'the casual assignment has the free pot');
  assert.equal(casualMatch.turn_seconds, 60, 'casual queue matches use the 60 s turn timer');
  assert.deepEqual(await index(ephemera, 'casual'), [], 'the casual candidates are removed as well');
  assert.equal(await h.count('SELECT count(*) AS n FROM match.matches WHERE source = $1', ['queue']), 2, 'exactly the two committed queue assignments exist');

  /* `close()` releases only what the service owns. */
  await queue.close();
  assert.equal(await ephemera.healthy(), true, 'close() never closes the borrowed ephemera adapter');
  assert.equal(await core.readMatch('svc_alice', matchId).then(() => true), true, 'close() never closes the borrowed Core service');
});

/* ---------------------------------------------------------------- 2. racing matchers */

test('V5-07-03 match: two matchers racing the same actors can never double-assign or double-charge', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'm703b' });
  if (!h) return;
  const { queue, ephemera } = h;
  const other = await h.attachMatcher();
  const pairs = [['svc_alice', 'svc_bob'], ['svc_carol', 'svc_dave'], ['svc_erin', 'svc_frank']];
  const reported = new Set();
  let events = 0;

  for (const [round, players] of pairs.entries()) {
    /* The contended pair from the previous round was consumed by exactly one matcher, so the queue
     * starts each round empty - the proof that contention never loses or duplicates an entrant. */
    assert.deepEqual(await index(ephemera, 'ranked'), [], `round ${round}: the previous round consumed its contended pair`);
    for (const [i, actor] of players.entries()) {
      const state = await join(queue, actor, 'ranked', `mr-${round}-${i}`);
      assert.equal(state.state, 'searching');
      h.advance(1000);
    }
    assert.deepEqual(await index(ephemera, 'ranked'), players.slice().sort(), `round ${round}: both actors are queued`);

    /* The TWO matchers tick at the same instant for the SAME actors. The per-actor SET NX claim is
     * the serialization point: one matcher receives both candidates, the other receives none, so
     * EXACTLY one compatible assignment is created for the contended pair - never two, never none. */
    const [left, right] = await Promise.all([
      tick(queue, 'ranked', { now: h.now }),
      tick(other, 'ranked', { now: h.now, matcherId: 'matcher-2' }),
    ]);
    assert.equal(left.matched + right.matched, 1, `round ${round}: exactly one assignment for the contended pair (got ${left.matched} + ${right.matched})`);
    assert.equal((left.matched === 1) !== (right.matched === 1), true, `round ${round}: only the matcher that won the claim reports the pairing`);

    const named = [...left.pairings, ...right.pairings];
    for (const pairing of named) {
      assert.deepEqual(pairingActors(pairing), players.slice().sort(), `round ${round}: a pairing only ever names the contended pair`);
      const id = pairingMatchId(pairing);
      assert.ok(id, `round ${round}: the pairing carries its match id`);
      assert.equal(reported.has(id), false, `round ${round}: a match is never reported twice`);
      reported.add(id);
      /* The reported assignment is committed exactly once and has exactly one durable event. */
      assert.equal(await h.count('SELECT count(*) AS n FROM match.matches WHERE match_id = $1', [id]), 1, `round ${round}: the reported assignment is committed exactly once`);
      assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox WHERE outbox_id = $1', [`core.command:matchmaker:pair:${id}`])), 1, `round ${round}: the committed assignment emits exactly one durable event`);
      events += 1;
    }

    /* NO DOUBLE ASSIGNMENT for THIS pair, and no assignment the matchers did not report. */
    const scoped = await h.count("SELECT count(DISTINCT m.match_id) AS n FROM match.matches m JOIN match.participants p ON p.match_id = m.match_id WHERE m.source = 'queue' AND p.actor_id = ANY($1::text[])", [players]);
    assert.equal(scoped, named.length, `round ${round}: every committed match for the pair is one a matcher reported`);
    /* NO DOUBLE SEAT anywhere: an actor is a participant of at most one offered/playing match. */
    const doubly = await h.count("SELECT count(*) AS n FROM (SELECT p.actor_id FROM match.participants p JOIN match.matches m ON m.match_id = p.match_id WHERE m.status IN ('OFFERED', 'PLAYING') GROUP BY p.actor_id HAVING count(*) > 1) AS dup");
    assert.equal(doubly, 0, `round ${round}: no actor is seated in two live matches`);

    /* ONE FINANCIAL EFFECT: no reservation and no ledger row until the second acceptance. */
    assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE reason = 'Reserved for match'"), 0, `round ${round}: nothing is charged before the second acceptance`);
    assert.equal(Number((await h.row('SELECT coalesce(sum(reserved_coins), 0) AS n FROM economy.wallets')).n), 0, `round ${round}: no contribution is reserved by the assignment`);
    assert.equal((await h.rows('SELECT actor_id, coins FROM economy.wallets WHERE actor_id = ANY($1::text[]) ORDER BY actor_id', [players])).every((w) => Number(w.coins) === 1000), true, `round ${round}: no balance moves at offer time`);

    /* NO LOST ENTRANT: every actor is either assigned (and off the index) or still queued once. */
    const queued = await index(ephemera, 'ranked');
    assert.equal(new Set(queued).size, queued.length, `round ${round}: an actor is never queued twice`);
    const seated = await h.rows("SELECT DISTINCT p.actor_id FROM match.participants p JOIN match.matches m ON m.match_id = p.match_id WHERE m.status = 'OFFERED' AND p.actor_id = ANY($1::text[])", [players]);
    const assigned = new Set(seated.map((s) => s.actor_id));
    for (const actor of players) {
      const isAssigned = assigned.has(actor);
      const isQueued = queued.includes(actor);
      assert.equal(isAssigned && isQueued, false, `round ${round}: ${actor} is never both assigned and queued`);
      assert.ok(isAssigned || isQueued, `round ${round}: ${actor} is never lost`);
    }
  }

  /* ACROSS ALL ROUNDS: each committed assignment has exactly one event and one match row, and no
   * matcher produced an unreported row. */
  assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox')), events, 'one durable event per committed assignment, no more');
  assert.equal(await h.count("SELECT count(*) AS n FROM match.matches WHERE source = 'queue'"), reported.size, 'every committed queue match was reported by exactly one matcher');
  assert.equal(await h.count('SELECT count(*) AS n FROM match.participants'), reported.size * 2, 'every committed assignment seats exactly two players');
});

/* ---------------------------------------------------------------- 3. occupancy collision */

test('V5-07-03 match: an actor occupied mid-tick fails ALREADY_IN_MATCH, rolls back with zero phantom rows and requeues only the innocent partner', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'm703c' });
  if (!h) return;
  const { queue, ephemera, core, database } = h;

  const alice = await join(queue, 'svc_alice', 'ranked', 'mo-1');
  h.advance(1000);
  const bob = await join(queue, 'svc_bob', 'ranked', 'mo-2');
  assert.equal(alice.state, 'searching');
  assert.equal(bob.state, 'searching');

  /* THE FORCED DATABASE RACE. Core's FIRST act on a match command is the aggregate IDENTITY mutex
   * (`lockTransactionIdentity(tx, 'aggregate', ['match', id])`), taken before it hydrates anything.
   * This test takes that EXACT lock through the production function - no hash is re-derived here, so
   * the gate cannot drift from Core's vocabulary. The assignment therefore parks AFTER the service
   * has chosen its pair but BEFORE Core re-derives the decision: the only window in which an actor
   * can legitimately become occupied. The parked transaction holds NO row lock yet, so a genuinely
   * competing Core command can commit underneath it. */
  const gateClient = await lab.adminClient(database);
  await gateClient.query('BEGIN');
  await lockTransactionIdentity(gateClient, 'aggregate', ['match', 'queue:m3']);
  let gated = true;
  const releaseGate = async () => {
    if (!gated) return;
    gated = false;
    try { await gateClient.query('ROLLBACK'); } catch { /* best effort */ }
    try { await gateClient.end(); } catch { /* best effort */ }
  };
  const admin = await lab.adminClient(database);
  try {
    const ticked = tick(queue, 'ranked', { now: h.now, makeId: () => 'm3' });
    ticked.catch(() => { /* observed below; an early refusal must not be an unhandled rejection */ });
    const contended = await lab.waitForLockWaiter(admin, 8000);
    assert.equal(contended, true, 'matchTick blocks on the match aggregate identity lock (the same mutex Core takes)');

    /* While the assignment is parked, the older player really becomes occupied: a committed direct
     * invitation reaches PLAYING through the trusted Core path, on a DIFFERENT aggregate identity. */
    const offer = await core.run({ actor: 'svc_alice', scope: 'player' }, 'mo-direct', { type: 'offer', id: 'match-occ', opponent: 'svc_carol', terms: { kind: 'leaderboard', amount: 40 } });
    const playing = await core.run({ actor: 'svc_carol', scope: 'player' }, 'mo-accept', { type: 'accept', id: 'match-occ', termsHash: offer.termsHash });
    assert.equal(playing.status, 'PLAYING', 'the opponent holds a real active aggregate');
    const occupancy = await h.row('SELECT kind FROM core.actor_occupancy WHERE actor_id = $1', ['svc_alice']);
    assert.equal(occupancy.kind, 'match', 'the occupancy row is the durable single-active-aggregate claim');

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
    assert.equal(await h.count('SELECT count(*) AS n FROM match.matches WHERE match_id = $1', ['queue:m3']), 0, 'the rolled-back assignment leaves no match row');
    assert.equal(await h.count('SELECT count(*) AS n FROM match.participants WHERE match_id = $1', ['queue:m3']), 0, 'the rolled-back assignment leaves no seat');
    assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 1, 'the ONLY committed match is the competing invitation, never a second assignment');
    assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox WHERE outbox_id = $1', ['core.command:matchmaker:pair:queue:m3'])), 0, 'no outbox event survives the rollback');
    /* The ONLY financial effect is the competing invitation's Crowns pot; the rolled-back ranked
     * assignment would have reserved Coins, and the innocent partner is charged nothing at all. */
    assert.equal(await h.count("SELECT count(*) AS n FROM economy.ledger WHERE actor_id = $1 AND reason = 'Reserved for match'", ['svc_bob']), 0, 'the innocent partner is charged no reservation at all');
    const aliceWallet = await h.row('SELECT reserved_coins, reserved_crowns FROM economy.wallets WHERE actor_id = $1', ['svc_alice']);
    assert.equal(Number(aliceWallet.reserved_coins), 0, 'no Coins reservation survives the rollback');
    assert.equal(Number(aliceWallet.reserved_crowns), 40, 'the competing direct invitation is the only reservation alice holds');
    const bobWallet = await h.row('SELECT reserved_coins, reserved_crowns, coins FROM economy.wallets WHERE actor_id = $1', ['svc_bob']);
    assert.deepEqual([Number(bobWallet.reserved_coins), Number(bobWallet.reserved_crowns), Number(bobWallet.coins)], [0, 0, 1000], 'the failed assignment moves nothing in the innocent partner\'s wallet');
  } finally {
    await releaseGate();
    try { await admin.end(); } catch { /* best effort */ }
  }

  /* THE FAILURE CODE ITSELF. `matchTick` consumes the code internally, so the exact command it issues
   * (same deterministic operation key `pair:<matchId>` and aggregate `queue:m3`) is replayed here to
   * prove the cause is ALREADY_IN_MATCH while the actor stays occupied. It aborts, so it must add no
   * durable row and no event. */
  await assert.rejects(
    () => core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'pair:queue:m3', { type: 'queue', id: 'queue:m3', a: 'svc_alice', b: 'svc_bob', mode: 'ranked', turnSeconds: 30 }),
    (e) => e.message === 'ALREADY_IN_MATCH',
    'the assignment command fails with ALREADY_IN_MATCH while an actor is occupied',
  );
  assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 1, 'the failed replay commits no second match');
  assert.equal(await h.count('SELECT count(*) AS n FROM match.participants WHERE match_id = $1', ['queue:m3']), 0, 'the failed replay commits no seat');
  assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox WHERE outbox_id = $1', ['core.command:matchmaker:pair:queue:m3'])), 0, 'the failed replay emits no event');

  /* SAFE PARTNER HANDLING: the occupied actor leaves the queue (requeue:false); the innocent partner
   * is requeued verbatim and immediately claimable again (its claim lock was really dropped). */
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_bob'], 'the occupied actor is dropped, the innocent partner stays queued');
  const reclaimed = await queue.claimCandidates({ mode: 'ranked', limit: 4, matcherId: 'matcher-verify', leaseMs: 30000 });
  assert.deepEqual(reclaimed.map((c) => c.actor), ['svc_bob'], 'the requeued partner is claimable again with a released claim');
  assert.equal(reclaimed[0].joinedAt, bob.joinedAt, 'the partner keeps its ORIGINAL FIFO join time');
  await queue.releaseClaim({ mode: 'ranked', actor: 'svc_bob', requeue: true });
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_bob'], 'the partner survives the release');

  /* The occupied actor is refused a re-join from durable truth, and reports its real match. */
  await assert.rejects(() => join(queue, 'svc_alice', 'ranked', 'mo-3'), (e) => e.message === 'INELIGIBLE');
  const occupied = await queue.status('svc_alice');
  assert.equal(occupied.state, 'matched');
  assert.equal(occupied.matchId, 'match-occ', 'the occupied actor reads its committed match, never a queue wait');
});

/* ---------------------------------------------------------------- 4. ranked coin requirement */

test('V5-07-03 match: a ranked assignment is refused when either player cannot fund the quote fee', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'm703d' });
  if (!h) return;
  const { queue, ephemera } = h;

  /* The broke player is made broke DURABLY (the service reads the wallet, never a stale cache). */
  await lab.installSql(h.database, ["UPDATE economy.wallets SET coins = 0 WHERE actor_id = 'svc_erin'"]);

  const alice = await join(queue, 'svc_alice', 'ranked', 'mc-1');
  h.advance(1000);
  const broke = await join(queue, 'svc_erin', 'ranked', 'mc-2');
  assert.equal(alice.state, 'searching');
  assert.equal(broke.state, 'searching', 'eligibility gating is about flags, not wealth: the broke player may still queue');

  const result = await tick(queue, 'ranked', { now: h.now });
  assert.equal(result.matched, 0, 'no illegal ranked match is created for a player who cannot pay');
  assert.deepEqual(result.pairings, []);
  assert.equal(await h.count('SELECT count(*) AS n FROM match.matches'), 0, 'no match row is created');
  assert.equal(await h.count('SELECT count(*) AS n FROM match.participants'), 0, 'no seat is created');
  assert.equal(Number(await h.admin('SELECT count(*) FROM ops.outbox')), 0, 'no durable event is emitted');
  assert.equal(Number((await h.row('SELECT coins FROM economy.wallets WHERE actor_id = $1', ['svc_erin'])).coins), 0, 'the broke player is never charged');
  assert.equal(Number((await h.row('SELECT reserved_coins FROM economy.wallets WHERE actor_id = $1', ['svc_alice'])).reserved_coins), 0, 'the solvent player is not charged by a refused pairing');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_erin'], 'both candidates stay queued in FIFO order, nothing is lost');

  /* CONTROL: the refusal is the coin gate, not a blanket refusal - fund the player and the very
   * same candidates pair on the next tick. */
  h.advance(1000);
  await lab.installSql(h.database, ["UPDATE economy.wallets SET coins = 1000 WHERE actor_id = 'svc_erin'"]);
  const funded = await tick(queue, 'ranked', { now: h.now });
  assert.equal(funded.matched, 1, 'the same pair assigns once the fee is affordable');
  assert.deepEqual(pairingActors(funded.pairings[0]), ['svc_alice', 'svc_erin']);
  assert.deepEqual(await index(ephemera, 'ranked'), [], 'the assigned candidates leave the index');

  /* CASUAL is free: the coin gate is a ranked-only rule. */
  h.advance(1000);
  await lab.installSql(h.database, ["UPDATE economy.wallets SET coins = 0 WHERE actor_id = 'svc_carol'", "UPDATE economy.wallets SET coins = 0 WHERE actor_id = 'svc_dave'"]);
  await join(queue, 'svc_carol', 'casual', 'mc-3');
  h.advance(1000);
  await join(queue, 'svc_dave', 'casual', 'mc-4');
  const casual = await tick(queue, 'casual', { now: h.now });
  assert.equal(casual.matched, 1, 'the free casual queue assigns broke players');
  assert.deepEqual(pairingActors(casual.pairings[0]), ['svc_carol', 'svc_dave']);
});

/* ---------------------------------------------------------------- 5. FIFO fairness */

test('V5-07-03 match: the older candidate is selected over a newer compatible one', { skip: GATE }, async (t) => {
  const h = await harness(t, {
    keyVersion: 'm703e',
    seeds: [SEED('svc_alice'), SEED('svc_bob', { rating: 2200 }), SEED('svc_carol'), SEED('svc_frank'), SEED('svc_grace'), SEED('svc_heidi')],
  });
  if (!h) return;
  const { queue, ephemera } = h;

  /* alice(1500) and carol(1500) are compatible; bob(2200) is 700 rating away and therefore outside
   * alice's frozen search window, so he can never be alice's partner. */
  const alice = await join(queue, 'svc_alice', 'ranked', 'mf-1');
  h.advance(1000);
  const bob = await join(queue, 'svc_bob', 'ranked', 'mf-2');
  h.advance(1000);
  const carol = await join(queue, 'svc_carol', 'ranked', 'mf-3');
  assert.ok(alice.joinedAt < bob.joinedAt && bob.joinedAt < carol.joinedAt, 'the three candidates joined in increasing FIFO order');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_bob', 'svc_carol'], 'the index is in ascending join order');

  const first = await tick(queue, 'ranked', { now: h.now });
  assert.equal(first.matched, 1, 'the oldest candidate finds its partner');
  assert.deepEqual(pairingActors(first.pairings[0]), ['svc_alice', 'svc_carol'], 'the older candidate is the one that pairs, and it pairs the only compatible partner');
  const matchId = pairingMatchId(first.pairings[0]);
  const seats = await h.rows('SELECT seat, actor_id FROM match.participants WHERE match_id = $1 ORDER BY seat', [matchId]);
  assert.deepEqual(seats.map((s) => s.actor_id), ['svc_alice', 'svc_carol'], 'the FIFO head takes the seat the claim gave it');
  assert.equal(Number(seats[0].seat), 0, 'the older candidate holds seat 0');

  /* bob (incompatible with everybody here) is released with its FIFO score intact. */
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_bob'], 'the incompatible candidate is requeued, not dropped');

  /* THREE MUTUALLY COMPATIBLE CANDIDATES: the two oldest pair, the newest waits. */
  for (const [i, actor] of ['svc_frank', 'svc_grace', 'svc_heidi'].entries()) {
    await join(queue, actor, 'casual', `mf-4-${i}`);
    h.advance(1000);
  }
  assert.deepEqual(await index(ephemera, 'casual'), ['svc_frank', 'svc_grace', 'svc_heidi']);
  const at = h.now();
  const casual = await tick(queue, 'casual', { now: h.now });
  assert.equal(casual.matched, 1);
  assert.deepEqual(pairingActors(casual.pairings[0]), ['svc_frank', 'svc_grace'], 'the two OLDEST compatible candidates pair; the newest is never preferred');
  assert.deepEqual(await index(ephemera, 'casual'), ['svc_heidi'], 'the newer candidate waits in place');
  const committed = await h.row('SELECT created_at, kind FROM match.matches WHERE match_id = $1', [pairingMatchId(casual.pairings[0])]);
  assert.equal(committed.kind, 'casual');
  assert.equal(new Date(committed.created_at).getTime(), at, 'the committed row carries the injected service clock, never a fabricated instant');
});

/* ---------------------------------------------------------------- 6. released candidates keep FIFO */

test('V5-07-03 match: unpaired candidates keep their original FIFO score and `limit` claims the oldest only', { skip: GATE }, async (t) => {
  const h = await harness(t, {
    keyVersion: 'm703f',
    seeds: [SEED('svc_alice'), SEED('svc_bob', { rating: 2200 }), SEED('svc_erin', { rating: 1000 }), SEED('svc_frank'), SEED('svc_grace'), SEED('svc_heidi')],
  });
  if (!h) return;
  const { queue, ephemera } = h;

  /* RANKED, ALL MUTUALLY INCOMPATIBLE (1500 / 2200 / 1000 are each outside the other's 50-point
   * window), so the tick assigns nobody and must release every claim with requeue:true. */
  const joined = [];
  for (const [i, actor] of ['svc_alice', 'svc_bob', 'svc_erin'].entries()) {
    joined.push(await join(queue, actor, 'ranked', `mu-${i}`));
    h.advance(1000);
  }
  const empty = await tick(queue, 'ranked', { now: h.now });
  assert.equal(empty.matched, 0, 'no compatible pair exists');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_bob', 'svc_erin'], 'every unpaired candidate keeps its ORIGINAL index position');
  const reclaimed = await queue.claimCandidates({ mode: 'ranked', limit: 8, matcherId: 'matcher-verify', leaseMs: 30000 });
  assert.deepEqual(reclaimed.map((c) => c.actor), ['svc_alice', 'svc_bob', 'svc_erin'], 'the released candidates are claimable again in the same FIFO order');
  assert.deepEqual(reclaimed.map((c) => c.joinedAt), joined.map((j) => j.joinedAt), 'every released candidate kept its ORIGINAL join time as its index score');
  assert.equal(new Set(reclaimed.map((c) => c.claimId)).size, 3, 'each candidate carries its own fresh claim');
  for (const actor of ['svc_alice', 'svc_bob', 'svc_erin']) await queue.releaseClaim({ mode: 'ranked', actor, requeue: true });

  /* LIMIT: a bounded tick claims the OLDEST candidates only; the untouched tail keeps its score. */
  const tail = [];
  for (const [i, actor] of ['svc_frank', 'svc_grace', 'svc_heidi'].entries()) {
    tail.push(await join(queue, actor, 'casual', `mu-4-${i}`));
    h.advance(1000);
  }
  assert.deepEqual(await index(ephemera, 'casual'), ['svc_frank', 'svc_grace', 'svc_heidi']);
  const bounded = await tick(queue, 'casual', { now: h.now, limit: 2 });
  assert.equal(bounded.matched, 1, 'the bounded tick pairs the two candidates it claimed');
  assert.deepEqual(pairingActors(bounded.pairings[0]), ['svc_frank', 'svc_grace'], '`limit` claims the two OLDEST candidates');
  assert.deepEqual(await index(ephemera, 'casual'), ['svc_heidi'], 'the candidate outside the limit is untouched and still queued');
  const untouched = await queue.claimCandidates({ mode: 'casual', limit: 4, matcherId: 'matcher-tail', leaseMs: 30000 });
  assert.deepEqual(untouched.map((c) => c.actor), ['svc_heidi'], 'the untouched tail is still claimable');
  assert.equal(untouched[0].joinedAt, tail[2].joinedAt, 'the untouched candidate kept its ORIGINAL FIFO score');
});
