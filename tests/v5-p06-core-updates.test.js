'use strict';
/* P06 Core match-update consumption: the ACTUAL Core factories (`packages/services/core.js`) driven
 * from independent OS processes on one owned PostgreSQL and one real local Redis.
 *
 * SCOPE. This suite exercises the FUNCTIONAL P06 Core coordination slice as implemented today:
 * post-commit bounded match-change hints on `core-match` and the durable `readMatch`/`watchMatch`
 * surfaces that reread PostgreSQL. It does NOT accept, and makes no claim about, the full G07/G08
 * realtime TRANSPORT (websocket/socket fan-out, `realtime/v1` resume/snapshot/delta) or the managed
 * provider DEPLOYMENT (staging/production placement); those remain unaccepted. Nothing here asserts
 * that no functionality exists - it asserts that the tested functional path works end to end.
 *
 * What the suite proves:
 *
 *   - a real, COMMITTED match-change hint published post-commit (`core-match`, `{matchId}` only)
 *     reaches a DIFFERENT Core process's `watchMatch`, which rereads PostgreSQL (never the hint) and
 *     delivers the committed transition;
 *   - the committed contributions match the APPROVED domain policy independently recomputed from
 *     `src/domain.js` (the oracle), and nothing is charged before the second acceptance;
 *   - PostgreSQL stays the sole authority: an absent/dead adapter commits and acknowledges exactly as
 *     before, `refresh()` is always a strong current read, and a namespace wipe or a brand-new Core
 *     process preserves paid occupancy / wallet / escrow / revision / deadline;
 *   - membership is enforced on EVERY read and subscribe: an unknown match is `UNKNOWN_MATCH`, an
 *     unseated actor is `NOT_PARTICIPANT`;
 *   - a malformed or spoofed hint can never fabricate a snapshot or invent state;
 *   - a ROLLED-BACK command publishes no hint and leaves no durable (or economic) effect, while a
 *     retry afterwards commits exactly once and notifies;
 *   - a deferred (slow) asynchronous listener coalesces a burst of committed changes into ONE
 *     follow-up delivery carrying the LATEST revision, and `unsubscribe` during a deferred listener
 *     suppresses later callbacks without waiting for it.
 *
 * Every child is a REAL Node process opening the REAL factories; IPC only drives real consumer
 * methods. No mocked Redis, no adapter echo, no fake Core. Children close naturally (no force-exit)
 * and the parent asserts the natural exit as the leak proof for their owned subscriptions. The
 * deferred-listener gate only delays the child's acknowledgement of real PostgreSQL-derived
 * snapshots; it mocks nothing.
 *
 * PostgreSQL is required (owned lab; skipped without V5_PG_URL); hints default to the owned loopback
 * Redis and skip when REDIS_URL is absent, exactly like the other P06 consumer suites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const D = require('../src/domain.js');
const { startPresenceChild, DEAD_URL } = require('./helpers/v5-presence-service-process.js');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
/* A private keyVersion per test gives each a dedicated namespace, so a wipe is deterministic and no
 * hint from a sibling test can ever be delivered to this one. The adapter's canonical option. */
const redisOptions = (keyVersion) => ({
  url: REDIS_URL,
  environment: 'test',
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  keyVersion,
  socket: { connectTimeout: 3000 },
});

const children = [];
const startChild = async (opts) => { const proc = await startPresenceChild(opts); children.push(proc); return proc; };
test.after(async () => { for (const proc of children) if (!proc.exited) proc.kill(); });

lab.installCleanup(test);

/* Assert that NO post-initial notification arrives for `watchId` within `ms`, by draining the
 * parent-side waiter. A queued real update would resolve (and fail the assertion) instead. */
const expectNoUpdate = async (child, watchId, ms = 900) => {
  await assert.rejects(child.nextMatchUpdate(watchId, ms), /PRESENCE_CHILD_NO_MATCH_UPDATE/, 'no post-initial notification is delivered');
};

/* Wait until the armed deferred listener has actually ENTERED its first delivery (i.e. the real
 * listener is blocked), so a test can commit further changes while it is held. */
const waitDeferred = async (child, watchId, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = await child.call('deferredState', [watchId]);
    if (state.seen >= 1) return state;
    await lab.sleep(10);
  }
  throw Error('DEFERRED_LISTENER_NOT_ENTERED');
};

/* The approved contributions/pot recomputed from the frozen domain policy (an INDEPENDENT oracle,
 * never the service under test). Both seed actors sit at rating 1500 => the 'gold' tier. */
const TIER = D.basicTier(1500).id;
const RANKED_QUOTE = D.quote({ mode: 'ranked', from: TIER, to: TIER });
const DIRECT_AMOUNT = 40;

test('P06 core updates: a committed queued ranked match reaches another Core process; contributions match the policy oracle', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06corequp');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob', 'svc_carol']));
  const url = lab.dbUrl(db);
  let exec, obs;
  try {
    exec = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuq1') });
    obs = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuq1') });
    /* Two genuine, independent Core processes drive the executor and observer roles: each commits
     * through its own guarded pool and its own adapter client, and neither is the test process (the
     * cross-process state/charge/delivery assertions below are the proof). */

    /* A REAL queued ranked offer created by the trusted matchmaker principal, then TWO actual
     * acceptances (one per player), so the committed PLAYING transition is genuine. */
    const offered = await exec.call('coreRun', [{ actor: 'matchmaker', scope: 'matchmaker' }, 'qu-offer', { type: 'queue', id: 'match-qu', a: 'svc_alice', b: 'svc_bob', mode: 'ranked' }]);
    assert.equal(offered.status, 'OFFERED', 'the matchmaker created an open ranked match');
    assert.deepEqual([...offered.players].sort(), ['svc_alice', 'svc_bob'], 'both players are seated');

    const oneSeat = await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'qu-acc-a', { type: 'accept', id: 'match-qu', termsHash: offered.termsHash }]);
    assert.equal(oneSeat.status, 'OFFERED', 'one acceptance leaves the match open');
    /* NO CHARGE before the second acceptance: the approved contributions are reserved only when the
     * second seat commits. */
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_coins FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), 0, 'no reservation for the first accepter before the second acceptance');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_coins FROM economy.wallets WHERE actor_id=$1', ['svc_bob'])), 0, 'no reservation for the opponent before the second acceptance');
    assert.equal(Number(await lab.scalar(db, 'SELECT coins FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), 1000, 'no coins move before the second acceptance');

    /* The observer subscribes on the existing match (durable initial snapshot, never a callback). */
    const watch = await obs.call('watchMatch', ['svc_alice', 'match-qu']);
    assert.equal(watch.available, true, 'a live hint subscription was opened on the real adapter');
    assert.equal(watch.snapshot.status, 'OFFERED', 'the initial snapshot is the committed OFFERED state');
    assert.equal(Number(watch.snapshot.escrow), 0, 'the initial snapshot carries no escrow');

    /* The SECOND acceptance commits PLAYING in the OTHER process; its post-commit hint reaches the
     * observer, which rereads PostgreSQL and delivers the committed transition. */
    const playing = await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'qu-acc-b', { type: 'accept', id: 'match-qu', termsHash: offered.termsHash }]);
    assert.equal(playing.status, 'PLAYING', 'the match is running in the executor');
    const update = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(update.snapshot.status, 'PLAYING', 'the observed snapshot is the committed PLAYING state');

    /* The observed contributions/escrow equal the INDEPENDENT policy oracle, not a value echoed from
     * the executor: the committed response is PostgreSQL-derived. */
    assert.deepEqual(update.snapshot.quote.contributions, RANKED_QUOTE.contributions, 'the observed contributions equal the policy oracle');
    assert.equal(Number(update.snapshot.escrow), RANKED_QUOTE.pool, 'the observed escrow equals the approved pot');
    const fee = RANKED_QUOTE.contributions[0];
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_coins FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), fee, 'the first accepter reservations equal the approved contribution');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_coins FROM economy.wallets WHERE actor_id=$1', ['svc_bob'])), fee, 'the second accepter reservations equal the approved contribution');
    assert.equal(Number(await lab.scalar(db, 'SELECT coins FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), 1000 - fee, 'the first accepter coins move by exactly the contribution');
    assert.equal(Number(await lab.scalar(db, 'SELECT coins FROM economy.wallets WHERE actor_id=$1', ['svc_bob'])), 1000 - fee, 'the second accepter coins move by exactly the contribution');

    /* `refresh()` is ALWAYS a strong current PostgreSQL read through the live handle. */
    const fresh = await obs.call('watchRefresh', [watch.watchId]);
    assert.equal(fresh.status, 'PLAYING', 'refresh reads committed truth, independent of the hint channel');
    assert.equal(Number(fresh.escrow), RANKED_QUOTE.pool);

    /* An idempotent replay of the SAME acceptance returns the stored response, reserves nothing a
     * second time and publishes no hint. */
    const replay = await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'qu-acc-b', { type: 'accept', id: 'match-qu', termsHash: offered.termsHash }]);
    assert.equal(replay.status, 'PLAYING', 'the replay returns the stored response unchanged');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_coins FROM economy.wallets WHERE actor_id=$1', ['svc_bob'])), fee, 'a replay cannot double-charge the second accepter');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_coins FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), fee, 'a replay cannot double-charge the first accepter');
    await expectNoUpdate(obs, watch.watchId);

    /* Membership is enforced on EVERY path: an unseated actor and an unknown match are denied with
     * the frozen codes (the initial denial cleans any opened subscription inside the service). */
    assert.equal(await obs.call('readMatch', ['svc_carol', 'match-qu']).then(() => 'OK', (e) => e.message), 'NOT_PARTICIPANT', 'an unseated actor cannot read the match');
    assert.equal(await obs.call('readMatch', ['svc_alice', 'match-none']).then(() => 'OK', (e) => e.message), 'UNKNOWN_MATCH', 'an unknown match reads UNKNOWN_MATCH');
    assert.equal(await obs.call('watchMatch', ['svc_carol', 'match-qu']).then(() => 'OK', (e) => e.message), 'NOT_PARTICIPANT', 'an unseated actor cannot subscribe');
    assert.equal(await obs.call('watchMatch', ['svc_alice', 'match-none']).then(() => 'OK', (e) => e.message), 'UNKNOWN_MATCH', 'an unknown match cannot be watched');

    /* unsubscribe() stops callbacks and releases the owned subscription; a later committed transition
     * therefore reaches nobody on this handle. */
    await obs.call('watchUnsubscribe', [watch.watchId]);
    const xActor = fresh.symbols.X;
    const moved = await exec.call('coreRun', [{ actor: xActor, scope: 'player' }, 'qu-move', { type: 'move', id: 'match-qu', revision: fresh.revision, move: { b: 0, c: 0 } }]);
    assert.equal(moved.revision, 1, 'a legal move advances the committed revision');
    await expectNoUpdate(obs, watch.watchId, 500);

    assert.deepEqual(await obs.shutdown(), { code: 0, signal: null }, 'the observer drains naturally');
    assert.deepEqual(await exec.shutdown(), { code: 0, signal: null }, 'the executor drains naturally');
  } finally {
    for (const proc of [exec, obs]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

test('P06 core updates: a direct sponsored acceptance commits the challenger-funded pot and the observer reads it', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06coredirect');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let exec, obs;
  try {
    exec = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cud2') });
    obs = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cud2') });

    /* A direct leaderboard offer: the challenger is pre-seated, so the opponent's acceptance is the
     * committing transition and the challenger funds the asymmetric pot. */
    const offered = await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'di-offer', { type: 'offer', id: 'match-di', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } }]);
    const oracle = D.quote({ mode: 'direct', kind: 'leaderboard', rated: true, from: TIER, to: TIER, amount: DIRECT_AMOUNT });
    assert.deepEqual(oracle.contributions, [DIRECT_AMOUNT, 0], 'the approved direct pot is challenger-funded');
    const watch = await obs.call('watchMatch', ['svc_alice', 'match-di']);
    assert.equal(watch.snapshot.status, 'OFFERED');

    const playing = await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'di-acc', { type: 'accept', id: 'match-di', termsHash: offered.termsHash }]);
    assert.equal(playing.status, 'PLAYING');
    const update = await obs.nextMatchUpdate(watch.watchId);
    assert.deepEqual(update.snapshot.quote.contributions, oracle.contributions, 'the observed contributions equal the direct-policy oracle');
    assert.equal(Number(update.snapshot.escrow), oracle.pool, 'the observed escrow equals the direct pot');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_crowns FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), DIRECT_AMOUNT, 'the challenger funds the pot');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_crowns FROM economy.wallets WHERE actor_id=$1', ['svc_bob'])), 0, 'the opponent contributes nothing in crowns');
    assert.equal(Number(await lab.scalar(db, 'SELECT coins FROM economy.wallets WHERE actor_id=$1', ['svc_bob'])), 1000, 'the opponent coins are untouched');

    assert.deepEqual(await obs.shutdown(), { code: 0, signal: null }, 'the observer drains naturally');
    assert.deepEqual(await exec.shutdown(), { code: 0, signal: null }, 'the executor drains naturally');
  } finally {
    for (const proc of [exec, obs]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

test('P06 core updates: an unavailable (absent or dead) native adapter still commits and acks; refresh reads PG', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06coreloss');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let exec, absent, dead;
  try {
    exec = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cul3') });
    const offered = await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'ls-offer', { type: 'offer', id: 'match-ls', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } }]);
    await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'ls-acc-a', { type: 'accept', id: 'match-ls', termsHash: offered.termsHash }]);

    /* An ABSENT adapter: the conservative shape, but a strong read and a committed write still work. */
    absent = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: null });
    assert.equal(absent.hasEphemera, false, 'the absent child booted with no adapter option');
    const wAbsent = await absent.call('watchMatch', ['svc_alice', 'match-ls']);
    assert.equal(wAbsent.available, false, 'with no adapter the hint channel is unavailable');
    assert.equal(wAbsent.snapshot.status, 'OFFERED', 'the durable initial read still resolves');

    /* A DEAD endpoint: present-but-unreachable is still conservative, never a fake success. */
    dead = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: { url: DEAD_URL, environment: 'test', allowPlaintext: true, keyVersion: 'cul3' } });
    assert.equal(dead.hasEphemera, true, 'the dead-endpoint child did inject an adapter');
    const wDead = await dead.call('watchMatch', ['svc_alice', 'match-ls']);
    assert.equal(wDead.available, false, 'a dead dependency never reports an available channel');

    /* The committed PLAYING transition still commits and acknowledges in the executor (publish is
     * best-effort and cannot turn committed success into failure). */
    const playing = await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'ls-acc-b', { type: 'accept', id: 'match-ls', termsHash: offered.termsHash }]);
    assert.equal(playing.status, 'PLAYING', 'the match commits PLAYING');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_crowns FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), DIRECT_AMOUNT, 'the durable contribution is committed');

    /* With the hint channel down, the observers still read committed truth through refresh(). */
    assert.equal((await absent.call('watchRefresh', [wAbsent.watchId])).status, 'PLAYING', 'the absent-adapter observer refreshes to the committed state');
    assert.equal((await dead.call('watchRefresh', [wDead.watchId])).status, 'PLAYING', 'the dead-adapter observer refreshes to the committed state');
    await expectNoUpdate(absent, wAbsent.watchId, 500);
    await expectNoUpdate(dead, wDead.watchId, 500);

    assert.deepEqual(await dead.shutdown(), { code: 0, signal: null }, 'the dead-dependency child drains naturally');
    assert.deepEqual(await absent.shutdown(), { code: 0, signal: null }, 'the absent child drains naturally');
    assert.deepEqual(await exec.shutdown(), { code: 0, signal: null }, 'the executor drains naturally');
  } finally {
    for (const proc of [exec, absent, dead]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

test('P06 core updates: a malformed or spoofed hint cannot fabricate a snapshot, while a genuine change still does', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06coreforge');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let exec, obs, api;
  try {
    exec = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuf4') });
    obs = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuf4') });
    /* A separate process publishes forged RAW strings on the real channel, so the observer's own
     * adapter never publishes on its own behalf (the filter is on the consumer, not the producer). */
    api = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions('cuf4') });
    const offered = await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'fg-offer', { type: 'offer', id: 'match-fg', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } }]);
    await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'fg-acc-a', { type: 'accept', id: 'match-fg', termsHash: offered.termsHash }]);

    const watch = await obs.call('watchMatch', ['svc_alice', 'match-fg']);
    assert.equal(watch.available, true);
    assert.equal(watch.snapshot.status, 'OFFERED');

    /* Malformed or off-target payloads reach Redis for real, yet none may match the watched id, so
     * none may cause ANY callback at all. */
    const ignored = [
      'not json at all',
      JSON.stringify({ matchId: 'match-other' }),
      JSON.stringify({ something: 'else' }),
      '{"matchId":',
    ];
    for (const text of ignored) {
      const published = await api.call('publishRaw', [text]);
      assert.equal(published.published, true, 'the forged hint really reached the real channel');
    }
    await expectNoUpdate(obs, watch.watchId, 800);

    /* A spoof that DOES carry the watched match id is indistinguishable from a real nudge, so it
     * triggers a PostgreSQL reread - but the delivered snapshot is the COMMITTED document, never the
     * spoofed fields. This is the proof that a hint can carry no state of its own. */
    const spoof = await api.call('publishRaw', [JSON.stringify({ matchId: 'match-fg', status: 'PLAYING', escrow: 999999, revision: 42 })]);
    assert.equal(spoof.published, true, 'the state-spoofing hint reached the real channel');
    const afterSpoof = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(afterSpoof.snapshot.status, 'OFFERED', 'the delivered snapshot is the committed state, not the spoofed PLAYING');
    assert.equal(Number(afterSpoof.snapshot.escrow), 0, 'the spoofed escrow is not invented');
    assert.equal(afterSpoof.snapshot.revision, 0, 'the spoofed revision is not invented');

    /* A GENUINE committed change on the same live channel still reaches the observer, proving the
     * earlier behaviour was the exact-id filter and the durable reread, not a dead subscription. */
    await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'fg-acc-b', { type: 'accept', id: 'match-fg', termsHash: offered.termsHash }]);
    const update = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(update.snapshot.status, 'PLAYING', 'a genuine committed change is delivered after the forged hints');
    assert.equal(Number(update.snapshot.escrow), DIRECT_AMOUNT, 'the delivered snapshot is the real committed document, not the spoof');

    assert.deepEqual(await api.shutdown(), { code: 0, signal: null }, 'the publisher drains naturally');
    assert.deepEqual(await obs.shutdown(), { code: 0, signal: null }, 'the observer drains naturally');
    assert.deepEqual(await exec.shutdown(), { code: 0, signal: null }, 'the executor drains naturally');
  } finally {
    for (const proc of [exec, obs, api]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

test('P06 core updates: a rolled-back match change publishes nothing and reserves nothing; the retry commits once', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06corerb');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let exec, obs;
  /* A BEFORE INSERT/UPDATE trigger that FORCES the acceptance commit to fail, so the whole
   * transaction (match status, participant seats, wallet reservations, ledger, outbox, outcome) rolls
   * back - the exact reachable failure the post-commit publish must never fire for. */
  const installFailGate = () => lab.installSql(db, [
    `CREATE FUNCTION match.p06_rb_gate() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN IF NEW.match_id = 'match-rb' THEN RAISE EXCEPTION 'P06_FORCED_ROLLBACK'; END IF; RETURN NEW; END $fn$`,
    'CREATE TRIGGER p06_rb_gate_trg BEFORE INSERT OR UPDATE ON match.matches FOR EACH ROW EXECUTE FUNCTION match.p06_rb_gate()',
  ]);
  try {
    exec = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cur5') });
    obs = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cur5') });
    const offered = await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'rb-offer', { type: 'offer', id: 'match-rb', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } }]);
    await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'rb-acc-a', { type: 'accept', id: 'match-rb', termsHash: offered.termsHash }]);

    const watch = await obs.call('watchMatch', ['svc_alice', 'match-rb']);
    assert.equal(watch.snapshot.status, 'OFFERED');

    /* The gated acceptance aborts mid-transaction: it must reject, deliver no hint and leave every
     * durable/economic effect untouched. */
    const gated = await installFailGate();
    const aborted = await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'rb-acc-b', { type: 'accept', id: 'match-rb', termsHash: offered.termsHash }]).then(() => 'OK', (e) => e.message);
    assert.match(String(aborted), /P06_FORCED_ROLLBACK/i, 'the forced-failure acceptance rejects with the forced rollback');
    await expectNoUpdate(obs, watch.watchId, 800);
    assert.equal(await lab.scalar(db, "SELECT status FROM match.matches WHERE match_id = 'match-rb'"), 'OFFERED', 'the rolled-back match is still OFFERED');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_crowns FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), 0, 'the rollback reserved nothing');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_crowns FROM economy.wallets WHERE actor_id=$1', ['svc_bob'])), 0, 'the rollback reserved nothing for the opponent');
    assert.equal(Number(await lab.scalar(db, "SELECT count(*)::int FROM ops.outbox WHERE outbox_id LIKE '%rb-acc-b%'")), 0, 'the rollback enqueued no outbox event');
    assert.equal((await obs.call('readMatch', ['svc_alice', 'match-rb'])).status, 'OFFERED', 'the strong read confirms nothing committed');

    /* Drop the gate and retry the SAME key: now it commits exactly once, reserves once and notifies. */
    await lab.installSql(db, ['DROP TRIGGER IF EXISTS p06_rb_gate_trg ON match.matches', 'DROP FUNCTION IF EXISTS match.p06_rb_gate()']);
    const played = await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'rb-acc-b', { type: 'accept', id: 'match-rb', termsHash: offered.termsHash }]);
    assert.equal(played.status, 'PLAYING', 'the retry commits the acceptance');
    const update = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(update.snapshot.status, 'PLAYING', 'the retry publishes the committed change');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_crowns FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), DIRECT_AMOUNT, 'the retry reserves exactly once');

    assert.deepEqual(await obs.shutdown(), { code: 0, signal: null }, 'the observer drains naturally');
    assert.deepEqual(await exec.shutdown(), { code: 0, signal: null }, 'the executor drains naturally');
  } finally {
    for (const proc of [exec, obs]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

test('P06 core updates: a namespace wipe and a brand-new Core preserve escrow/revision/deadline; a resumed change still reaches the watcher', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06corewipe');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let exec, obs, fresh;
  try {
    exec = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuw6') });
    obs = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuw6') });
    const offered = await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'ns-offer', { type: 'offer', id: 'match-ns', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } }]);
    await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'ns-acc-a', { type: 'accept', id: 'match-ns', termsHash: offered.termsHash }]);
    await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'ns-acc-b', { type: 'accept', id: 'match-ns', termsHash: offered.termsHash }]);

    const watch = await obs.call('watchMatch', ['svc_alice', 'match-ns']);
    assert.equal(watch.available, true);
    assert.equal(watch.snapshot.status, 'PLAYING', 'the match is running before the wipe');
    assert.equal(Number(watch.snapshot.escrow), DIRECT_AMOUNT);
    assert.equal(watch.snapshot.revision, 0);
    assert.ok(watch.snapshot.deadline !== null && watch.snapshot.deadline !== undefined, 'a running timed match carries a deadline');

    /* Wipe the whole ephemeral namespace through the observer's OWN adapter. */
    const wiped = await obs.call('wipeNamespace', []);
    assert.equal(wiped.available, true, 'the observer-owned adapter wiped its namespace');

    /* Every durable fact is preserved: paid occupancy, wallet reservations, escrow, revision and the
     * turn deadline all survive a Redis loss because PostgreSQL is the sole authority. */
    assert.equal(await lab.scalar(db, "SELECT status FROM match.matches WHERE match_id = 'match-ns'"), 'PLAYING', 'status survives the wipe');
    assert.equal(Number(await lab.scalar(db, "SELECT escrow FROM match.matches WHERE match_id = 'match-ns'")), DIRECT_AMOUNT, 'escrow survives the wipe');
    assert.equal(Number(await lab.scalar(db, "SELECT revision FROM match.matches WHERE match_id = 'match-ns'")), 0, 'revision survives the wipe');
    assert.equal(Number(await lab.scalar(db, 'SELECT reserved_crowns FROM economy.wallets WHERE actor_id=$1', ['svc_alice'])), DIRECT_AMOUNT, 'the reservation survives the wipe');
    assert.equal(Number(await lab.scalar(db, "SELECT count(*)::int FROM core.actor_occupancy WHERE actor_id IN ('svc_alice','svc_bob')")), 2, 'both occupants survive the wipe');
    const afterWipe = await obs.call('readMatch', ['svc_alice', 'match-ns']);
    assert.equal(afterWipe.status, 'PLAYING', 'the strong read is unaffected by the wipe');
    assert.equal(afterWipe.deadline, watch.snapshot.deadline, 'the deadline is unchanged after the wipe');

    /* A brand-new Core process reads the same committed truth (no cached aggregate, no ephemera). */
    fresh = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuw6') });
    const fromFresh = await fresh.call('readMatch', ['svc_alice', 'match-ns']);
    assert.equal(fromFresh.status, 'PLAYING', 'a new Core process reads the committed match');
    assert.equal(Number(fromFresh.escrow), DIRECT_AMOUNT, 'a new Core process reads the committed escrow');
    assert.equal(fromFresh.revision, watch.snapshot.revision, 'a new Core process reads the committed revision');
    assert.equal(fromFresh.deadline, watch.snapshot.deadline, 'a new Core process reads the committed deadline');

    /* A RESUMED committed change reaches the still-open watcher: the subscription survived the wipe
     * (it is a live client, not a key) and the rebuilt fan-out delivers the new revision. */
    const xActor = fromFresh.symbols.X;
    const moved = await exec.call('coreRun', [{ actor: xActor, scope: 'player' }, 'ns-move', { type: 'move', id: 'match-ns', revision: fromFresh.revision, move: { b: 0, c: 0 } }]);
    assert.equal(moved.revision, 1, 'the resumed move commits a new revision');
    const update = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(update.snapshot.revision, 1, 'the resumed committed change reaches the watcher');

    assert.deepEqual(await fresh.shutdown(), { code: 0, signal: null }, 'the new Core drains naturally');
    assert.deepEqual(await obs.shutdown(), { code: 0, signal: null }, 'the observer drains naturally');
    assert.deepEqual(await exec.shutdown(), { code: 0, signal: null }, 'the executor drains naturally');
  } finally {
    for (const proc of [exec, obs, fresh]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

test('P06 core updates: a deferred async listener coalesces a burst into one follow-up; unsubscribe during it suppresses later callbacks', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06coredefer');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let exec, obs;
  const move = async (actor, key, revision, b, c) => exec.call('coreRun', [{ actor, scope: 'player' }, key, { type: 'move', id: 'match-df', revision, move: { b, c } }]);
  try {
    exec = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuz7') });
    obs = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: redisOptions('cuz7') });
    const offered = await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'df-offer', { type: 'offer', id: 'match-df', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: DIRECT_AMOUNT } }]);
    await exec.call('coreRun', [{ actor: 'svc_alice', scope: 'player' }, 'df-acc-a', { type: 'accept', id: 'match-df', termsHash: offered.termsHash }]);
    await exec.call('coreRun', [{ actor: 'svc_bob', scope: 'player' }, 'df-acc-b', { type: 'accept', id: 'match-df', termsHash: offered.termsHash }]);
    const watch = await obs.call('watchMatch', ['svc_alice', 'match-df']);
    assert.equal(watch.snapshot.status, 'PLAYING');
    const initial = await obs.call('watchRefresh', [watch.watchId]);
    const X = initial.symbols.X, O = initial.symbols.O;

    /* HOLD the listener. Commit three alternating moves while it is blocked; the pump may run only
     * ONE PostgreSQL reread at a time with ONE pending slot, so the burst must coalesce. */
    await obs.call('armDeferredListener', [watch.watchId]);
    const first = await move(X, 'df-m1', 0, 0, 0);
    assert.equal(first.revision, 1);
    await waitDeferred(obs, watch.watchId); /* the FIRST delivery is now blocked inside the listener */
    const second = await move(O, 'df-m2', 1, 0, 1);
    const third = await move(X, 'df-m3', 2, 1, 0);
    assert.equal(third.revision, 3, 'three moves committed while the listener was held');
    /* Let the burst's hints land and coalesce, then release the listener. */
    const released = await obs.call('releaseDeferredListener', [watch.watchId, 400]);
    assert.equal(released.seen, 1, 'the listener was entered exactly once while held');

    /* Exactly two parent-side deliveries: the blocked ONE (the pre-burst revision) and exactly ONE
     * follow-up carrying the LATEST committed revision - the intermediate revision is coalesced away. */
    const blocked = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(blocked.snapshot.revision, 1, 'the blocked delivery carried the pre-burst revision');
    const coalesced = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(coalesced.snapshot.revision, third.revision, 'the single follow-up carries the latest committed revision');
    await expectNoUpdate(obs, watch.watchId, 600);

    /* UNSUBSCRIBE during a deferred listener: the in-flight callback may complete once, but no later
     * callback follows and the release does not wait for the listener. */
    await obs.call('armDeferredListener', [watch.watchId]);
    const fourth = await move(O, 'df-m4', 3, 0, 2);
    assert.equal(fourth.revision, 4);
    await waitDeferred(obs, watch.watchId); /* the next delivery is blocked */
    await obs.call('watchUnsubscribe', [watch.watchId]); /* synchronous stop */
    const fifth = await move(X, 'df-m5', 4, 2, 0);
    assert.equal(fifth.revision, 5, 'a further change commits after the unsubscribe');
    await obs.call('releaseDeferredListener', [watch.watchId, 0]);
    const inFlight = await obs.nextMatchUpdate(watch.watchId);
    assert.equal(inFlight.snapshot.revision, 4, 'only the already-in-flight callback completes once');
    await expectNoUpdate(obs, watch.watchId, 600); /* the post-unsubscribe change is suppressed */

    assert.deepEqual(await obs.shutdown(), { code: 0, signal: null }, 'the observer drains naturally');
    assert.deepEqual(await exec.shutdown(), { code: 0, signal: null }, 'the executor drains naturally');
  } finally {
    for (const proc of [exec, obs]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});
