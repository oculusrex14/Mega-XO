'use strict';
/* tests/v5-p07-queue.test.js - V5 P07 task V5-07-02 distributed queue operations (V5-07-02).
 *
 * WHAT THIS PROVES. `createQueueService` (packages/services/queue.js) is exercised against a REAL
 * owned PostgreSQL 16 lab (tests/v5-pg-lab.js: checksummed migration chain, guarded role pools,
 * synthetic actors) and a REAL loopback Redis ephemera adapter (packages/services/ephemera.js).
 * There is no mock, no fake Redis, no copied service logic: every assertion reads a real Redis key,
 * a real PostgreSQL row, or a real service response.
 *
 *  1. Join is VERSIONED and DEDUPLICATED across devices. A repeated `opKey` returns the SAME cached
 *     response (byte-for-byte), including from a SECOND service instance on the same namespace (a
 *     genuinely separate adapter client, i.e. another device); a device that rejoins the same mode
 *     with a new op key keeps its original `joinedAt` and creates exactly one index member; a join
 *     while queued in the other mode fails `ALREADY_QUEUED`.
 *  2. INELIGIBILITY is decided from durable PostgreSQL (`identity.eligibility`, `core.actor_occupancy`):
 *     unverified, suspended, security-hold and occupied actors all fail `INELIGIBLE` and leave no
 *     candidate behind, while an eligible actor still joins.
 *  3. CANCELLATION RACES: cancel-before-match cancels cleanly and is idempotent by op key; cancel of
 *     an OFFERED match really runs the Core `decline` command (the durable row becomes DECLINED); a
 *     PLAYING match is reported `playing` and is NEVER declined by a queue cancel.
 *  4. HEARTBEAT AND LEASE RECOVERY: an active heartbeat keeps the ticket `searching` across more than
 *     one lease window and never rewrites `joinedAt`; when the heartbeat stops, `heartbeat` reports
 *     `disconnected` and drops the index member; `expireAbandoned` reclaims a dead candidate; a dead
 *     client never becomes a phantom `match.participants` row or `core.actor_occupancy` row.
 *  5. CLAIM AND RELEASE: two CONCURRENT matchers claim a disjoint union (each candidate exactly once,
 *     distinct claimIds); a failed match releases its claim and the entrant is re-claimable with its
 *     ORIGINAL FIFO `joinedAt` (not re-appended at the tail); `requeue:false` removes the entrant.
 *  6. BOUNDED INDICES: the `maxTickets` cap refuses a new entrant with `QUEUE_FULL`, the index never
 *     exceeds the cap, and an abandoned candidate's reclaimed slot admits a new entrant.
 *
 * GATING (the repo convention): these need BOTH the owned loopback Redis (`REDIS_URL`, or
 * `V5_REDIS_REQUIRED=1` to fail instead of skip) and the owned PostgreSQL lab (`V5_PG_URL`, or
 * `V5_PG_REQUIRED=1`). Absent either, the suite skips; the CI job supplies both and enforces zero
 * skips there. Cleanup is the lab's `installCleanup` (guarded pools closed, owned databases dropped)
 * plus a per-test wipe of the test's OWN ephemera `keyVersion` namespace - never another
 * environment's, never a sibling's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const P = require('../packages/domain/matchmaking.js');

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
 * from an assertion; the returned ORDER is still the index order (ascending score = FIFO fairness),
 * which is exactly what the FIFO claims assert. */
const INDEX_WINDOW_MS = 315_360_000_000;
const index = async (ephemera, mode) => (await ephemera.peekCandidates(mode, { windowMs: INDEX_WINDOW_MS })).candidates;

/* A sync-safe refusal check: the service raises `Error(code)` from an async method, but wrapping the
 * call in a thunk catches a synchronous validation throw just as well. */
const expectCode = (run, code) => lab.throwsCode(Promise.resolve().then(run), code);

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

const SEED = (actor) => ({ actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' });
const DEFAULT_SEEDS = ['svc_alice', 'svc_bob', 'svc_carol'].map(SEED);
const EXTRA_SEEDS = ['svc_dave', 'svc_erin'].map(SEED);
/* The durable account the service hydrates for these seeds (economy.ratings casual_rating = rating),
 * used as the INDEPENDENT oracle for the window the frozen policy publishes. */
const ORACLE = Object.freeze({ games: 30, rating: 1500, casualRating: 1500 });

let dbSeq = 0;
/* A per-test fixture: its own owned database, its own ephemera namespace (`keyVersion`), its own
 * guarded pools, a real Core service and a controllable injected clock. Teardown is registered with
 * `t.after` so a failed assertion still closes the services and wipes only this namespace. */
async function harness(t, { keyVersion, seeds = DEFAULT_SEEDS, maxTickets, leaseMs, claimTtlMs } = {}) {
  /* The lab's boot guard bootstraps the owned loopback cluster (or honours an explicit V5_PG_URL);
   * when it cannot, the test is already marked skipped and the harness reports that by returning
   * null. It runs BEFORE any database is created. */
  if (!(await lab.boot(t))) return null;
  const create = loadQueueFactory();
  let clock = lab.CLOCK;
  const now = () => clock;
  const advance = (ms) => { clock += ms; };

  const database = await lab.createDatabase(`p07q${dbSeq++}`);
  if (seeds.length) await lab.seedActors(database, seeds);
  const pools = lab.poolsFor(database);
  const core = await lab.coreFor(database);
  const ephemera = await ephemeraFor(keyVersion);

  /* The queue service reads durable eligibility/occupancy/match facts, so it is bound to the
   * `core_runtime` pool - the ONE runtime identity that may read `core.actor_occupancy` and
   * `match.matches`. `core` provides the transactional `decline` path; neither the pool nor the
   * adapter is owned by the service. */
  const attach = (adapter = ephemera) => create({ ephemera: adapter, core, pool: pools.core, now, maxTickets, leaseMs, claimTtlMs });
  const queue = await attach();
  const closers = [() => queue.close()];

  t.after(async () => {
    for (const close of closers) { try { await close(); } catch { /* best effort */ } }
    try { await core.close(); } catch { /* best effort */ }
    try { await ephemera.wipeNamespace(); } catch { /* only this namespace */ }
    try { await ephemera.close(); } catch { /* best effort */ }
  });

  /* A genuinely separate adapter client against the same Redis namespace: the second device. */
  const attachDevice = async () => {
    const adapter = await ephemeraFor(keyVersion);
    const device = await attach(adapter);
    closers.push(() => device.close());
    closers.push(() => adapter.close());
    return { adapter, device };
  };

  return { database, pools, core, ephemera, queue, attachDevice, now, advance, clock: () => clock };
}

/* ---------------------------------------------------------------- 1. versioned dedupe */

test('V5-07-02 queue: a repeated op key is deduplicated across devices and conflicting modes are refused', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'q702a' });
  if (!h) return;
  const { queue, ephemera, pools } = h;

  const at = h.clock();
  const first = await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'op-d1', region: 'iad', latencyMs: 40 });
  assert.equal(first.state, 'searching');
  assert.equal(first.mode, 'ranked');
  assert.equal(first.joinedAt, at, 'joinedAt is taken from the injected clock');
  assert.equal(first.waitSeconds, 0);
  assert.equal(first.window, P.searchWindow('ranked', 0, ORACLE), 'the frozen policy window is reused, not re-implemented');

  const replay = await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'op-d1', region: 'iad', latencyMs: 40 });
  assert.deepEqual(replay, first, 'the same op key returns the cached response byte-for-byte');

  /* A SECOND service instance on the same namespace is another device: it must read the same
   * committed operation and the same ticket, never create a second one. */
  const { device: otherDevice } = await h.attachDevice();
  const cached = await otherDevice.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'op-d1', region: 'iad', latencyMs: 40 });
  assert.deepEqual(cached, first, 'a second device sees the cached join for the same op key');
  const seenElsewhere = await otherDevice.status('svc_alice');
  assert.equal(seenElsewhere.state, 'searching', 'the second device sees the same live ticket');
  assert.equal(seenElsewhere.joinedAt, first.joinedAt);

  /* Time passes between the two devices' joins: a rejoin MUST keep the ORIGINAL join time (and
   * recompute the wait from it), never re-append the entrant at the tail. */
  h.advance(5000);
  const rejoin = await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'op-d2', region: 'iad', latencyMs: 80 });
  assert.equal(rejoin.state, 'searching', 'the same mode with a new op key is an idempotent rejoin');
  assert.equal(rejoin.joinedAt, first.joinedAt, 'a rejoin preserves the original join time (FIFO fairness)');
  assert.equal(rejoin.waitSeconds, 5, 'the wait is recomputed from the ORIGINAL join time, not the rejoin instant');

  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice'], 'exactly one index member per actor, however many joins arrive');

  await expectCode(
    () => queue.join({ actor: 'svc_alice', mode: 'casual', opKey: 'op-d3', region: 'iad', latencyMs: 40 }),
    'ALREADY_QUEUED',
  );

  const bob = await queue.join({ actor: 'svc_bob', mode: 'casual', opKey: 'op-d4', region: 'iad', latencyMs: 40 });
  assert.equal(bob.state, 'searching');
  assert.equal(bob.mode, 'casual');
  assert.equal(bob.window, P.searchWindow('casual', 0, ORACLE), 'the casual window also comes from the frozen policy');
  assert.deepEqual(await index(ephemera, 'casual'), ['svc_bob'], 'each mode keeps its own index');

  /* Contract validation happens before any Redis write. */
  await assert.rejects(() => queue.join({ actor: 'svc_carol', mode: 'bogus', opKey: 'op-x', region: 'iad', latencyMs: 1 }), (e) => /INVALID/.test(e.message));
  await assert.rejects(() => queue.join({ actor: 'svc_carol', mode: 'ranked', opKey: '', region: 'iad', latencyMs: 1 }), (e) => /INVALID/.test(e.message));
  assert.equal((await index(ephemera, 'ranked')).includes('svc_carol'), false, 'a refused join never enters the index');

  /* `close()` releases only what the service owns. */
  await queue.close();
  assert.equal(await ephemera.healthy(), true, 'close() never closes the borrowed ephemera adapter');
  const stillOpen = await pools.core.query('SELECT 1 AS ok');
  assert.equal(stillOpen.rows[0].ok, 1, 'close() never closes the borrowed pool');
});

/* ---------------------------------------------------------------- 2. ineligibility */

test('V5-07-02 queue: unverified, suspended, security-hold and occupied actors are refused INELIGIBLE from durable state', { skip: GATE }, async (t) => {
  const seeds = [...DEFAULT_SEEDS, SEED('svc_unver'), SEED('svc_susp'), SEED('svc_hold'), SEED('svc_occ')];
  const h = await harness(t, { keyVersion: 'q702b', seeds });
  if (!h) return;
  const { queue, core, ephemera, database } = h;

  /* The three flag refusals come from the columns the schema owns. The OCCUPIED case is a REAL
   * active aggregate, not a hand-written row: the trusted matchmaker opens a casual queue offer and
   * both players accept it, so `core.actor_occupancy` holds a genuine PLAYING claim. */
  await lab.installSql(database, [
    "UPDATE identity.eligibility SET verified = false WHERE actor_id = 'svc_unver'",
    "UPDATE identity.eligibility SET suspended = true WHERE actor_id = 'svc_susp'",
    "UPDATE identity.eligibility SET security_hold = true WHERE actor_id = 'svc_hold'",
  ]);
  const occupied = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'occ-offer', { type: 'queue', id: 'match-occ', a: 'svc_occ', b: 'svc_carol', mode: 'casual' });
  await core.run({ actor: 'svc_occ', scope: 'player' }, 'occ-acc-a', { type: 'accept', id: 'match-occ', termsHash: occupied.termsHash });
  const playing = await core.run({ actor: 'svc_carol', scope: 'player' }, 'occ-acc-b', { type: 'accept', id: 'match-occ', termsHash: occupied.termsHash });
  assert.equal(playing.status, 'PLAYING', 'the occupied actor really holds an active aggregate');
  assert.equal(await lab.scalar(database, "SELECT kind FROM core.actor_occupancy WHERE actor_id = 'svc_occ'"), 'match', 'the occupancy row is the durable single-active-aggregate claim');

  await expectCode(() => queue.join({ actor: 'svc_unver', mode: 'ranked', opKey: 'in-1', region: 'iad', latencyMs: 40 }), 'INELIGIBLE');
  await expectCode(() => queue.join({ actor: 'svc_susp', mode: 'ranked', opKey: 'in-2', region: 'iad', latencyMs: 40 }), 'INELIGIBLE');
  await expectCode(() => queue.join({ actor: 'svc_hold', mode: 'ranked', opKey: 'in-3', region: 'iad', latencyMs: 40 }), 'INELIGIBLE');
  await expectCode(() => queue.join({ actor: 'svc_occ', mode: 'ranked', opKey: 'in-4', region: 'iad', latencyMs: 40 }), 'INELIGIBLE');
  /* The refusal is a durable fact, not a join-time guess: the same actors are refused in both modes. */
  await expectCode(() => queue.join({ actor: 'svc_susp', mode: 'casual', opKey: 'in-5', region: 'iad', latencyMs: 40 }), 'INELIGIBLE');
  await expectCode(() => queue.join({ actor: 'svc_occ', mode: 'casual', opKey: 'in-6', region: 'iad', latencyMs: 40 }), 'INELIGIBLE');

  assert.deepEqual(await index(ephemera, 'ranked'), [], 'no refused actor leaves a candidate behind');
  assert.deepEqual(await index(ephemera, 'casual'), [], 'nor in the other mode');
  for (const actor of ['svc_unver', 'svc_susp', 'svc_hold']) {
    assert.equal((await queue.status(actor)).state, 'idle', `${actor} has no queue state`);
  }
  /* The occupied actor is refused a join yet still reports its durable match, never a queue wait. */
  const occState = await queue.status('svc_occ');
  assert.equal(occState.state, 'matched');
  assert.equal(occState.matchId, 'match-occ');

  /* Control: the check is real, not a blanket refusal. */
  const ok = await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'in-ok', region: 'iad', latencyMs: 40 });
  assert.equal(ok.state, 'searching', 'an eligible actor still joins');
});

/* ---------------------------------------------------------------- 3. cancellation races */

test('V5-07-02 queue: cancel races a match cleanly, declines an OFFERED match and never touches a PLAYING one', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'q702c' });
  if (!h) return;
  const { queue, core, ephemera, database } = h;

  /* (a) cancel before any match. The cancel carries its OWN operation key (a client's cancel is a
   * distinct operation from its join, exactly as the legacy `cancel(actor, key)` default does), so
   * it can never be confused with the cached join response. */
  await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'cq-join', region: 'iad', latencyMs: 40 });
  const cancelled = await queue.cancel({ actor: 'svc_alice', opKey: 'cq-cancel' });
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(await index(ephemera, 'ranked'), [], 'a cancelled candidate leaves the index');
  assert.equal((await queue.status('svc_alice')).state, 'idle', 'a cancelled actor reads idle');
  assert.equal((await queue.cancel({ actor: 'svc_alice', opKey: 'cq-cancel' })).state, 'cancelled', 'cancel is idempotent by op key');
  assert.equal((await queue.cancel({ actor: 'svc_alice', opKey: 'cq-fresh' })).state, 'idle', 'a fresh cancel with nothing queued reads idle');

  /* (b) an OFFERED match really exists in PostgreSQL, created through the trusted Core path. */
  const offer = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'cq-offer', { type: 'queue', id: 'match-cq', a: 'svc_alice', b: 'svc_bob', mode: 'ranked' });
  assert.equal(offer.status, 'OFFERED', 'a real OFFERED match was committed');
  const matched = await queue.status('svc_alice');
  assert.equal(matched.state, 'matched', 'status reads the durable offer before Redis');
  assert.equal(matched.matchId, 'match-cq');
  assert.equal(matched.mode, 'ranked');
  assert.equal(matched.termsHash, offer.termsHash);
  assert.equal(matched.expires, offer.expires);

  const declined = await queue.cancel({ actor: 'svc_alice', opKey: 'cq-offer' });
  assert.equal(declined.state, 'cancelled');
  assert.equal(await lab.scalar(database, "SELECT status FROM match.matches WHERE match_id = 'match-cq'"), 'DECLINED', 'an OFFERED match is declined through the Core command path');
  assert.equal((await queue.status('svc_alice')).state, 'idle', 'the declined offer is no longer reported matched');

  /* (c) a PLAYING match is reported playing and is never declined. */
  const offer2 = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'cq-offer2', { type: 'queue', id: 'match-cp', a: 'svc_alice', b: 'svc_bob', mode: 'ranked' });
  await core.run({ actor: 'svc_alice', scope: 'player' }, 'cq-acc-a', { type: 'accept', id: 'match-cp', termsHash: offer2.termsHash });
  const playing = await core.run({ actor: 'svc_bob', scope: 'player' }, 'cq-acc-b', { type: 'accept', id: 'match-cp', termsHash: offer2.termsHash });
  assert.equal(playing.status, 'PLAYING', 'the second acceptance commits the running match');

  const reported = await queue.cancel({ actor: 'svc_alice', opKey: 'cq-play' });
  assert.equal(reported.state, 'playing');
  assert.equal(reported.matchId, 'match-cp');
  assert.equal(await lab.scalar(database, "SELECT status FROM match.matches WHERE match_id = 'match-cp'"), 'PLAYING', 'a queue cancel never declines or cancels a running match');
});

/* ---------------------------------------------------------------- 4. heartbeat + dead leases */

test('V5-07-02 queue: heartbeats hold the lease and an abandoned client is reclaimed without a phantom entry', { skip: GATE }, async (t) => {
  /* leaseMs 400 ms. A LIVE candidate's heartbeat refreshes the index key's own TTL (2x lease), so
   * `carol` acts as the keeper that holds the index open while the dead candidates are probed - the
   * assertions below then test the DEAD LEASE path, never an index-key expiry race. */
  const h = await harness(t, { keyVersion: 'q702d', leaseMs: 400 });
  if (!h) return;
  const { queue, ephemera, database, advance } = h;

  const alice = await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'hb-1', region: 'iad', latencyMs: 40 });
  const bob = await queue.join({ actor: 'svc_bob', mode: 'ranked', opKey: 'hb-2', region: 'iad', latencyMs: 40 });
  const carol = await queue.join({ actor: 'svc_carol', mode: 'ranked', opKey: 'hb-3', region: 'iad', latencyMs: 40 });
  assert.equal(alice.state, 'searching');
  assert.equal(bob.state, 'searching');
  assert.equal(carol.state, 'searching');

  /* ACTIVE HEARTBEATS. Alice refreshes well inside the 400 ms lease window, so her ticket survives
   * far past one lease; the FIFO join time is never rewritten by a beat. Carol is the keeper: she
   * beats on the same cadence so the index key stays alive while the abandons are probed. */
  for (let i = 0; i < 3; i += 1) {
    await lab.sleep(150);
    advance(150);
    const beat = await queue.heartbeat({ actor: 'svc_alice', mode: 'ranked' });
    assert.equal(beat.state, 'searching', 'an active heartbeat keeps the ticket searching');
    assert.equal(beat.joinedAt, alice.joinedAt, 'a heartbeat never rewrites the FIFO join time');
    assert.equal((await queue.heartbeat({ actor: 'svc_carol', mode: 'ranked' })).state, 'searching', 'the keeper is held by its own heartbeat');
  }

  /* ABANDONED CLIENT. Bob stopped at join time, so his 400 ms lease has lapsed while the keeper keeps
   * the index alive: the sweep reclaims exactly the dead candidate and leaves the live ones. */
  const reclaimed = await queue.expireAbandoned({ mode: 'ranked', now: h.now() });
  assert.equal(reclaimed, 1, 'expireAbandoned reclaims exactly the abandoned candidate');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice', 'svc_carol'], 'the dead candidate is gone from the index, the live ones remain');
  assert.notEqual((await queue.status('svc_bob')).state, 'searching', 'a reclaimed client never keeps searching');
  assert.notEqual((await queue.status('svc_bob')).state, 'matched', 'a dead client is never a matched player');

  /* NO PHANTOM ENTRY. A dead client leaves no durable trace at all. */
  assert.equal(Number(await lab.scalar(database, "SELECT count(*) FROM match.participants WHERE actor_id = 'svc_bob'")), 0, 'a dead client never becomes a match participant');
  assert.equal(Number(await lab.scalar(database, "SELECT count(*) FROM core.actor_occupancy WHERE actor_id = 'svc_bob'")), 0, 'a dead client never occupies the actor');

  /* LEASE-ABSENT TICKET. Alice now stops too; the keeper keeps beating, so the index key survives
   * while Alice's own lease lapses. A read of her dead ticket must report `disconnected` and drop
   * the stale member rather than pretend she is still searching. */
  await lab.sleep(300); advance(300);
  assert.equal((await queue.heartbeat({ actor: 'svc_carol', mode: 'ranked' })).state, 'searching', 'the keeper is still alive');
  await lab.sleep(300); advance(300);
  assert.equal((await queue.heartbeat({ actor: 'svc_carol', mode: 'ranked' })).state, 'searching', 'the keeper is still alive');

  const dead = await queue.heartbeat({ actor: 'svc_alice', mode: 'ranked' });
  assert.equal(dead.state, 'disconnected', 'a lapsed lease with a stale index member reads disconnected');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_carol'], 'the stale index member is removed, the keeper remains');
  assert.notEqual((await queue.status('svc_alice')).state, 'searching', 'a disconnected actor never keeps searching');
});

/* ---------------------------------------------------------------- 5. claim + release */

test('V5-07-02 queue: concurrent matchers claim atomically and a released claim preserves FIFO position', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'q702e' });
  if (!h) return;
  const { queue, ephemera, advance } = h;

  const a = await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'cl-1', region: 'iad', latencyMs: 40 });
  const b = await queue.join({ actor: 'svc_bob', mode: 'ranked', opKey: 'cl-2', region: 'iad', latencyMs: 40 });
  assert.equal(b.joinedAt, a.joinedAt);
  advance(1000);
  const c = await queue.join({ actor: 'svc_carol', mode: 'ranked', opKey: 'cl-3', region: 'iad', latencyMs: 40 });
  assert.equal(c.joinedAt, a.joinedAt + 1000, 'the third entrant is strictly newer in the FIFO index');

  /* Two claims issued together: the union is exactly the queue, with NO overlap - the atomicity
   * proof. A generously sized limit means neither matcher starves the other by ordering. */
  const [first, second] = await Promise.all([
    queue.claimCandidates({ mode: 'ranked', limit: 16, matcherId: 'matcher-1', leaseMs: 30000 }),
    queue.claimCandidates({ mode: 'ranked', limit: 16, matcherId: 'matcher-2', leaseMs: 30000 }),
  ]);
  const claimed = [...first, ...second];
  const byActor = claimed.map((cand) => cand.actor);
  assert.deepEqual([...byActor].sort(), ['svc_alice', 'svc_bob', 'svc_carol'], 'every candidate is claimed exactly once');
  assert.equal(new Set(byActor).size, byActor.length, 'two concurrent matchers never claim the same candidate');
  assert.equal(new Set(claimed.map((cand) => cand.claimId)).size, claimed.length, 'each claim carries its own claimId');
  for (const cand of claimed) {
    assert.equal(typeof cand.claimId, 'string');
    assert.ok(cand.claimId.length > 0, 'a claim id is a non-empty opaque string');
    assert.equal(cand.joinedAt, cand.actor === 'svc_carol' ? c.joinedAt : a.joinedAt, 'a claim carries the entrant FIFO join time');
  }

  /* A failed match releases its claim: the entrant returns, is re-claimable, and keeps its ORIGINAL
   * FIFO score rather than being appended at the tail. */
  await queue.releaseClaim({ mode: 'ranked', actor: 'svc_alice', claimId: claimed.find((c) => c.actor === 'svc_alice').claimId, requeue: true });
  assert.equal((await index(ephemera, 'ranked'))[0], 'svc_alice', 'the requeued entrant keeps its FIFO head position');

  const reclaimed = await queue.claimCandidates({ mode: 'ranked', limit: 1, matcherId: 'matcher-3', leaseMs: 30000 });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].actor, 'svc_alice', 'the released candidate is claimable again');
  assert.equal(reclaimed[0].joinedAt, a.joinedAt, 'the original join time survives the release/claim cycle');

  /* `requeue:false` drops the entrant entirely. */
  await queue.releaseClaim({ mode: 'ranked', actor: 'svc_alice', claimId: reclaimed[0].claimId, requeue: false });
  assert.equal((await index(ephemera, 'ranked')).includes('svc_alice'), false, 'requeue:false removes the candidate from the index');
  const after = await queue.claimCandidates({ mode: 'ranked', limit: 16, matcherId: 'matcher-4', leaseMs: 30000 });
  assert.equal(after.some((cand) => cand.actor === 'svc_alice'), false, 'a dropped candidate is never re-claimable');
});

/* ---------------------------------------------------------------- 6. bounded indices */

test('V5-07-02 queue: the candidate index is bounded by maxTickets and reclaims expired capacity', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'q702f', seeds: [...DEFAULT_SEEDS, ...EXTRA_SEEDS], maxTickets: 3, leaseMs: 800 });
  if (!h) return;
  const { queue, ephemera, advance } = h;

  const queued = ['svc_alice', 'svc_bob', 'svc_carol'];
  for (const [i, actor] of queued.entries()) {
    const status = await queue.join({ actor, mode: 'ranked', opKey: `bd-${i}`, region: 'iad', latencyMs: 40 });
    assert.equal(status.state, 'searching', `${actor} joins while the queue has room`);
  }
  assert.equal((await index(ephemera, 'ranked')).length, 3, 'the index holds exactly the cap');

  await expectCode(() => queue.join({ actor: 'svc_dave', mode: 'ranked', opKey: 'bd-3', region: 'iad', latencyMs: 40 }), 'QUEUE_FULL');
  assert.equal((await index(ephemera, 'ranked')).includes('svc_dave'), false, 'a refused entrant is not in the index');

  /* Two clients stay alive by heartbeating inside the lease window; the third stops and its lease
   * lapses. `expireAbandoned` must reclaim exactly the abandoned candidate - and the reclaimed seat
   * admits a new entrant, so the cap is a live bound, not a permanent loss. */
  for (let i = 0; i < 6; i += 1) {
    await lab.sleep(300);
    advance(300);
    assert.equal((await queue.heartbeat({ actor: 'svc_alice', mode: 'ranked' })).state, 'searching', 'the first client is still alive');
    assert.equal((await queue.heartbeat({ actor: 'svc_bob', mode: 'ranked' })).state, 'searching', 'the second client is still alive');
  }
  const reclaimed = await queue.expireAbandoned({ mode: 'ranked', now: h.now() });
  assert.equal(reclaimed, 1, 'only the abandoned candidate is reclaimed');
  assert.deepEqual((await index(ephemera, 'ranked')).slice().sort(), ['svc_alice', 'svc_bob'], 'the live candidates remain, the abandoned one is gone');

  const dave = await queue.join({ actor: 'svc_dave', mode: 'ranked', opKey: 'bd-3b', region: 'iad', latencyMs: 40 });
  assert.equal(dave.state, 'searching', 'a reclaimed slot admits a new entrant again');
  assert.equal((await index(ephemera, 'ranked')).length, 3, 'the index is back at the cap, never above it');

  await expectCode(() => queue.join({ actor: 'svc_erin', mode: 'ranked', opKey: 'bd-4', region: 'iad', latencyMs: 40 }), 'QUEUE_FULL');
});


/* Post-gate regression: Redis claim TTL is shorter than a blocked PG transaction.
 * Once the lease lapses, a second matcher can own the SAME queue seat. The old
 * matcher must not delete the new claim or the candidate (even with requeue:false).
 * Real Redis, real adapter, actual Lua compare-and-delete. */
test('P07 co-dev regression: a stale claim cannot release a successor claim or remove its FIFO seat', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'q702-cas' });
  if (!h) return;
  const { queue, ephemera } = h;
  const joined = await queue.join({ actor: 'svc_alice', mode: 'ranked', opKey: 'cas-join', region: 'iad', latencyMs: 40 });
  const prior = await queue.claimCandidates({ mode: 'ranked', limit: 1, matcherId: 'slow-matcher', leaseMs: 250 });
  assert.equal(prior.length, 1);
  assert.equal(prior[0].actor, 'svc_alice');

  await lab.sleep(350); // wait for the Redis claim lock's *real* TTL, not the fixture clock
  const successor = await queue.claimCandidates({ mode: 'ranked', limit: 1, matcherId: 'healthy-matcher', leaseMs: 30000 });
  assert.equal(successor.length, 1);
  assert.notEqual(successor[0].claimId, prior[0].claimId);

  const key = ephemera.key('queue', 'claim', 'svc_alice');
  assert.equal(await ephemera.client.get(key), successor[0].claimId);
  assert.equal(await queue.releaseClaim({ mode: 'ranked', actor: 'svc_alice',
    claimId: prior[0].claimId, requeue: false }), false, 'expired worker cannot drop a successor seat');
  assert.equal(await queue.releaseClaim({ mode: 'ranked', actor: 'svc_alice',
    claimId: prior[0].claimId, requeue: true }), false, 'expired worker cannot touch successor gauge');
  await expectCode(() => queue.releaseClaim({ mode: 'ranked', actor: 'svc_alice', requeue: false }),
    'INVALID_CLAIM_ID');

  assert.equal(await ephemera.client.get(key), successor[0].claimId, 'new lock survives stale deletes');
  assert.deepEqual(await index(ephemera, 'ranked'), ['svc_alice'], 'FIFO seat was not removed');
  assert.equal((await queue.status('svc_alice')).joinedAt, joined.joinedAt);

  assert.equal(await queue.releaseClaim({ mode: 'ranked', actor: 'svc_alice',
    claimId: successor[0].claimId, requeue: true }), true, 'actual owner can release');
  const reclaimed = await queue.claimCandidates({ mode: 'ranked', limit: 1, matcherId: 'next-worker', leaseMs: 30000 });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].joinedAt, joined.joinedAt, 'original FIFO time survives the claim handoff');
  assert.equal(await queue.releaseClaim({ mode: 'ranked', actor: 'svc_alice',
    claimId: reclaimed[0].claimId, requeue: false }), true);
  assert.deepEqual(await index(ephemera, 'ranked'), []);
});


/* A Redis match hint is a cache, not an access grant. This regression writes
 * an actor-mismatched hint straight into the OWN test Redis namespace and
 * proves PostgreSQL participant membership must still authorize the read. */
test('P07 co-dev regression: a poisoned match hint cannot disclose another actor match', { skip: GATE }, async (t) => {
  const h = await harness(t, { keyVersion: 'q702-hint' });
  if (!h) return;
  const { queue, core, ephemera } = h;
  const offer = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'hint-offer', {
    type: 'queue', id: 'match-hint-security', a: 'svc_alice', b: 'svc_bob', mode: 'casual',
  });
  assert.equal(offer.status, 'OFFERED');
  assert.equal((await queue.status('svc_alice')).matchId, 'match-hint-security',
    'a real participant still sees their durable offer');
  assert.equal((await queue.status('svc_bob')).matchId, 'match-hint-security');

  const attackerKey = ephemera.key('queue', 'match', 'svc_carol');
  await ephemera.client.set(attackerKey, JSON.stringify({
    state: 'matched', mode: 'casual', matchId: 'match-hint-security',
    termsHash: offer.termsHash, expires: offer.expires,
  }), { PX: 60000 });
  assert.notEqual(await ephemera.client.get(attackerKey), null, 'fixture inserted a cache hint for a nonparticipant');

  const status = await queue.status('svc_carol');
  assert.equal(status.state, 'idle', 'the unrelated actor cannot resolve or see this match');
  assert.equal(Object.hasOwn(status, 'matchId'), false, 'the protected match id was not returned');
  assert.equal(await ephemera.client.get(attackerKey), null, 'a rejected hint is evicted');
});
