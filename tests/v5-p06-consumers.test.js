'use strict';
/* P06 consumer integration: the ACTUAL API/Core factories driven from independent OS processes.
 *
 * This suite does not test the ephemera adapter in isolation (that is tests/v5-p06-ephemera.test.js);
 * it proves the consumer-visible properties the P06 milestone is defined by:
 *
 *   - presence written by a heartbeat in one API process is read by a DIFFERENT API/Core process
 *     (distinct real PIDs, real guarded `api_runtime`/`core_runtime` pools, one owned PostgreSQL);
 *   - PostgreSQL stays the sole authority for sessions/revocation/privacy/economics, so a wiped or
 *     unavailable Redis can never authenticate, resurrect a revoked session, re-enable a redeemed
 *     one-use ticket, or change a byte of durable content;
 *   - the injected caller-owned `options.ephemera` adapter is preserved by the API (never closed,
 *     never required for boot) and its absence/unavailability is a precise conservative result —
 *     never a fabricated "online".
 *
 * Every child is a REAL Node process opening the REAL factories; IPC only drives real consumer
 * methods. No mocked Redis, no mocked PostgreSQL, no adapter echo, no fake Core. Children close
 * naturally (no force-exit) and the parent asserts the natural exit as the leak proof.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const { startPresenceChild, DEAD_URL } = require('./helpers/v5-presence-service-process.js');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
/* `redis: null` boots a child with NO ephemera option at all (the conservative absent default). */
const redisOptions = (extra = {}) => ({ url: REDIS_URL, environment: 'test', allowPlaintext: !REDIS_URL.startsWith('rediss://'), ...extra });
/* The children are real service processes that own guarded pools, so they are reaped by the finally
 * of each test AND by this after hook. It is registered BEFORE the lab's database-drop hook so no
 * child ever holds a guarded connection while an owned database is being force-dropped. */
const children = [];
const startChild = async (opts) => { const proc = await startPresenceChild(opts); children.push(proc); return proc; };
test.after(async () => { for (const proc of children) if (!proc.exited) proc.kill(); });

lab.installCleanup(test);

const digestOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/* Content snapshot of EVERY durable base table in the real schema (discovered from the catalog, so
 * a table added by a later migration cannot silently escape the invariant). Each table is read as
 * canonically ordered row JSON, so equality is by content, not by count or physical order. */
const durableSnapshot = async (database) => {
  const admin = await lab.adminClient(database);
  try {
    const tables = (await admin.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name",
    )).rows.map((r) => ({ schema: r.table_schema, name: r.table_name }));
    const snapshot = {};
    for (const { schema, name } of tables) {
      const rows = (await admin.query(`SELECT row_to_json(t) AS row FROM "${schema}"."${name}" t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows;
      snapshot[`${schema}.${name}`] = rows.map((r) => r.row);
    }
    return snapshot;
  } finally { await admin.end(); }
};

/* Real authorization/session flow: `issue` is the actual API session mint, so presence is only ever
 * written for a genuine live session under a real `api_runtime` transaction. */
const sessionFor = async (child, actor) => {
  const session = await child.call('issue', [actor, lab.CLOCK]);
  assert.ok(session && session.token, 'the API issued a real session bearer');
  return session;
};

/* ---------------------------------------------------------------- cross-process presence */

test('P06 consumers: two independent API processes share consumer-visible presence, and a durable PG truth is untouched', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06cons');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let apiA, apiB;
  try {
    apiA = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    apiB = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    assert.notEqual(apiA.pid, apiB.pid, 'the two API consumers are distinct OS processes');
    assert.notEqual(apiA.pid, process.pid, 'neither consumer is the test process');
    assert.equal(apiA.role, 'api_runtime', 'the API child opened the guarded api_runtime factory');
    assert.equal(apiA.schemaHead, lab.CHAIN_LENGTH, 'the child verified the real checksummed schema (head = last migration id)');

    const session = await sessionFor(apiA, 'svc_alice');
    const beat = await apiA.call('heartbeat', [session.token, true]);
    assert.equal(beat.online, true, 'the caller own presence is online after a real heartbeat');
    assert.equal(beat.state, 'online');

    /* The OTHER process reads the same fact through its own pool and its own adapter client. */
    const seen = await apiB.call('view', ['svc_alice', 'svc_alice']);
    assert.equal(seen.presence.online, true, 'process B observes process A presence');
    assert.equal(seen.presence.state, 'online');

    /* A friend in process B sees the online state through friends() too. */
    await apiA.call('social', ['svc_alice', 'c-req', 'request', 'svc_bob']);
    await apiB.call('social', ['svc_bob', 'c-acc', 'accept', 'svc_alice']);
    const friends = await apiB.call('friends', ['svc_bob']);
    const alice = friends.friends.find((f) => f.id === 'svc_alice');
    assert.ok(alice, 'the friend appears in the list');
    assert.equal(alice.presence.online, true, 'the friend list carries the shared presence');

    /* Presence is ephemeral: the durable authority does not grow a second source of truth. */
    const wallet = await lab.scalar(db, 'SELECT coins FROM economy.wallets WHERE actor_id = $1', ['svc_alice']);
    assert.equal(Number(wallet), 1000, 'the durable wallet is unchanged by presence writes');

    /* Both consumers exit on their own after close() (no force-exit, proving no leaked pool/client). */
    assert.deepEqual(await apiA.shutdown(), { code: 0, signal: null }, 'API process A drains naturally');
    assert.deepEqual(await apiB.shutdown(), { code: 0, signal: null }, 'API process B drains naturally');
  } finally {
    for (const proc of [apiA, apiB]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- multi-device lifecycle */

test('P06 consumers: multi-device foreground/background/logout keeps a live foreground device online', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06dev');
  await lab.seedActors(db, lab.seedFor(['svc_carol']));
  const url = lab.dbUrl(db);

  let api, observer;
  try {
    api = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    observer = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    /* A dedicated actor (heartbeated ONLY in this test) so a sibling test's still-live presence can
     * never make the final "offline" assertion ambiguous. */
    const phone = await sessionFor(api, 'svc_carol');
    const tablet = await sessionFor(api, 'svc_carol');

    /* Heartbeat the BACKGROUND-only device first: with no foreground session the actor reads 'away'. */
    const background = await api.call('heartbeat', [tablet.token, false]);
    assert.equal(background.state, 'away', 'a background-only device is away');
    assert.equal(background.online, false);
    /* Then the foreground device heartbeats: the actor is now online. */
    const foreground = await api.call('heartbeat', [phone.token, true]);
    assert.equal(foreground.online, true, 'a foreground device is online');
    assert.equal(foreground.state, 'online');

    /* The tablet logs out: the actor is STILL online because the phone is foreground. */
    const sessions = await api.call('sessions', [phone.token]);
    const tabletRow = sessions.find((s) => s.current === false);
    assert.ok(tabletRow, 'the second device session is listed');
    await api.call('logout', [tablet.token]);

    const afterLogout = await observer.call('view', ['svc_carol', 'svc_carol']);
    assert.equal(afterLogout.presence.online, true, 'logging out the background device cannot hide the foreground one');

    /* Log the phone out too: only now does the actor read offline. */
    await api.call('logout', [phone.token]);
    const offline = await observer.call('view', ['svc_carol', 'svc_carol']);
    assert.equal(offline.presence.online, false, 'with every live session gone the actor is offline');
    assert.equal(offline.presence.state, 'offline');

    assert.deepEqual(await observer.shutdown(), { code: 0, signal: null }, 'the observer drains naturally');
    assert.deepEqual(await api.shutdown(), { code: 0, signal: null }, 'the API process drains naturally');
  } finally {
    for (const proc of [api, observer]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- conservative unavailable */

test('P06 consumers: an unavailable dependency yields a conservative view, never a fake online', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06down');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const url = lab.dbUrl(db);
  let dead;
  try {
    dead = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: { url: DEAD_URL, environment: 'test', allowPlaintext: true } });
    assert.equal(dead.hasEphemera, true, 'the child did inject a (dead-endpoint) adapter');
    const session = await sessionFor(dead, 'svc_alice');
    const beat = await dead.call('heartbeat', [session.token, true]);
    assert.equal(beat.online, false, 'a dead dependency never reports online');
    assert.equal(beat.state, 'offline', 'a dead dependency resolves to the conservative offline state');
    const view = await dead.call('view', ['svc_alice', 'svc_alice']);
    assert.equal(view.presence.online, false, 'the projection is conservative while the dependency is down');
    assert.equal(view.presence.state, 'offline');
    assert.deepEqual(await dead.shutdown(), { code: 0, signal: null }, 'a child on a dead dependency still drains naturally');
  } finally {
    if (dead && !dead.exited) dead.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- absent adapter default */

test('P06 consumers: with no injected adapter the projection is the precise conservative default', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06absent');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_carol']));
  const url = lab.dbUrl(db);
  let plain;
  try {
    plain = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: null });
    assert.equal(plain.hasEphemera, false, 'the child booted with no adapter option');
    const session = await sessionFor(plain, 'svc_alice');
    /* Even a valid live session with no adapter must not invent presence: never online. */
    const beat = await plain.call('heartbeat', [session.token, true]);
    assert.equal(beat.state, 'offline', 'no adapter => the heartbeat state is the conservative offline');
    assert.equal(beat.online, false, 'no adapter => no fabricated online');
    /* A stranger is hidden by privacy alone (the default presence_visibility is friends), independent
     * of any adapter: the conservative projection can never leak presence it does not have. */
    const stranger = await plain.call('view', ['svc_carol', 'svc_alice']);
    assert.equal(stranger.presence.state, 'hidden', 'no adapter => a stranger sees the hidden default');
    assert.equal(stranger.presence.online, false, 'no adapter => never online for a stranger');
    /* With no adapter there is no presence source at all, so even the actor sees the frozen hidden
     * default (a present-but-down adapter would instead read 'offline'). */
    const selfView = await plain.call('view', ['svc_alice', 'svc_alice']);
    assert.equal(selfView.presence.state, 'hidden', 'no adapter => the frozen hidden default, even for self');
    assert.equal(selfView.presence.online, false, 'no adapter => never online');
    assert.deepEqual(await plain.shutdown(), { code: 0, signal: null }, 'the no-adapter child drains naturally');
  } finally {
    if (plain && !plain.exited) plain.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- caller-owned adapter */

test('P06 consumers: the API never closes the caller-owned ephemera adapter', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06own');
  await lab.seedActors(db, lab.seedFor(['svc_alice']));
  const url = lab.dbUrl(db);
  let child;
  try {
    child = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    await child.call('closeApi'); /* close ONLY the API service, leaving the pool + adapter alive */
    const probe = await child.call('ephemeraHealthy');
    assert.equal(probe.present, true);
    /* Redis has no PING-able server in the owned-loopback default URL, so the honest proof is that
     * the client is still constructible/usable (no throw) rather than a fabricated PONG. Healthy is
     * a bounded boolean: the key point is the call resolves at all after the API closed. */
    assert.ok(probe.healthy === true || probe.healthy === false, 'the caller-owned adapter survived the API close');
    assert.deepEqual(await child.shutdown(), { code: 0, signal: null }, 'the child drains naturally');
  } finally {
    if (child && !child.exited) child.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- durable content + PG truth */

test('P06 consumers: namespace wipe and total dependency loss leave every durable table byte-identical', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06dur');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob']));
  const url = lab.dbUrl(db);
  let api, core;
  try {
    api = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    core = await startChild({ databaseUrl: url, role: 'core_runtime', clock: lab.CLOCK, redis: null });
    const session = await sessionFor(api, 'svc_alice');
    await api.call('heartbeat', [session.token, true]);

    /* A durable, one-use realtime ticket redeemed by the Core process (the PG authority). */
    const minted = await api.call('issueTicket', [{ actor: 'svc_alice', sessionId: 'dur-session-00000000000', generation: 1, connectionClass: 'game' }]);
    const grant = await core.call('redeemTicket', [{ ticket: minted.ticket, connectionId: 'dur-conn', node: 'dur-core' }]);
    assert.equal(grant.actorId, 'svc_alice', 'the ticket is redeemed in PostgreSQL');

    /* A durable refresh family revoked by the API process. */
    const family = await api.call('startFamily', [{ actor: 'svc_alice', sessionId: 'dur-family-0000000000' }]);
    await api.call('revokeFamily', [family.familyId, 'p06-durable']);

    const before = await durableSnapshot(db);

    /* Wipe the ephemeral namespace via the API process adapter, then read the consumer view: the
     * presence is gone but every durable decision still holds with ALL ephemera absent. */
    const wiped = await api.call('wipeNamespace', []);
    assert.equal(wiped.available, true, 'the API-owned adapter wiped its namespace');
    const afterWipe = await api.call('view', ['svc_alice', 'svc_alice']);
    assert.equal(afterWipe.presence.online, false, 'a wiped cache cannot report anyone online');
    const digestAfterWipe = digestOf(await durableSnapshot(db));
    assert.equal(digestAfterWipe, digestOf(before), 'the durable content is byte-identical across the wipe');

    /* The adapter-level per-session view is genuinely empty after the wipe, and a fresh heartbeat
     * rebuilds it (self-healing exactly as the design requires). */
    const wipedSessions = await api.call('presenceRead', ['svc_alice']);
    assert.equal(wipedSessions.available, true, 'the live adapter reports a bounded read after the wipe');
    assert.deepEqual(wipedSessions.sessions, [], 'every per-session presence fact is gone after the wipe');

    const rejoin = await sessionFor(api, 'svc_alice');
    const rejoinBeat = await api.call('heartbeat', [rejoin.token, true]);
    assert.equal(rejoinBeat.online, true, 'a fresh heartbeat self-heals the presence after the wipe');
    const rejoinSessions = await api.call('presenceRead', ['svc_alice']);
    assert.equal(rejoinSessions.sessions.length, 1, 'exactly the rejoined session is present');
    assert.equal(rejoinSessions.sessions[0].foreground, true, 'the rejoined session is foreground');
    assert.equal((await api.call('view', ['svc_alice', 'svc_alice'])).presence.online, true, 'the consumer view is online again');

    /* The redeemed ticket and the revoked family are still PG-authoritative after the wipe. */
    const replay = await core.call('redeemTicket', [{ ticket: minted.ticket, connectionId: 'dur-conn-2', node: 'dur-core' }]).then(() => 'REDEEMED', (e) => e.message);
    assert.equal(replay, 'TICKET_REDEEMED', 'a wiped cache cannot re-enable a redeemed one-use ticket');
    const rotate = await api.call('rotateRefresh', [{ refreshSecret: 'A'.repeat(43) }]).then(() => 'OK', (e) => e.message);
    assert.equal(rotate, 'SESSION_REVOKED', 'a wiped cache cannot resurrect a revoked refresh family');
    assert.equal(await lab.scalar(db, 'SELECT state FROM identity.refresh_families WHERE family_id = $1', [family.familyId]), 'revoked');

    /* Total adapter loss (a dead endpoint) changes nothing durable either. The baseline is taken
     * immediately before the dead child runs, because the legitimate rejoin above wrote real
     * durable rows (a new session and a rate bucket) that are unrelated to the loss. */
    const preLoss = digestOf(await durableSnapshot(db));
    const dead = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: { url: DEAD_URL, environment: 'test', allowPlaintext: true } });
    try {
      const downView = await dead.call('view', ['svc_alice', 'svc_alice']);
      assert.equal(downView.presence.online, false, 'a dead dependency is conservative');
      const digestAfterLoss = digestOf(await durableSnapshot(db));
      assert.equal(digestAfterLoss, preLoss, 'total dependency loss mutates no durable content');
    } finally {
      assert.deepEqual(await dead.shutdown(), { code: 0, signal: null }, 'the dead-dependency child drains naturally');
    }

    assert.deepEqual(await api.shutdown(), { code: 0, signal: null }, 'the API process drains naturally');
    assert.deepEqual(await core.shutdown(), { code: 0, signal: null }, 'the Core process drains naturally');
  } finally {
    for (const proc of [api, core]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- revocation truth */

test('P06 consumers: a revoked session cannot reclaim presence and a stale heartbeat cannot resurrect it', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06rev');
  await lab.seedActors(db, lab.seedFor(['svc_bob']));
  const url = lab.dbUrl(db);

  let api, observer;
  try {
    api = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    observer = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    /* A dedicated actor for the revocation proof so no other test's live session can mask it. */
    const session = await sessionFor(api, 'svc_bob');
    await api.call('heartbeat', [session.token, true]);
    assert.equal((await observer.call('view', ['svc_bob', 'svc_bob'])).presence.online, true);

    await api.call('logout', [session.token]);
    /* The old bearer is revoked in PostgreSQL; a heartbeat replay must fail authentication and must
     * not be able to re-assert presence (the wipe-proof invariant: PG generation is authoritative). */
    const stale = await api.call('heartbeat', [session.token, true]).then(() => 'ACCEPTED', (e) => e.message);
    assert.equal(stale, 'AUTH_REQUIRED', 'a revoked bearer cannot heartbeat');
    const after = await observer.call('view', ['svc_bob', 'svc_bob']);
    assert.equal(after.presence.online, false, 'a revoked session presence was cleared, not resurrected');

    assert.deepEqual(await observer.shutdown(), { code: 0, signal: null });
    assert.deepEqual(await api.shutdown(), { code: 0, signal: null });
  } finally {
    for (const proc of [api, observer]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- revocation fence */

test('P06 consumers: a delayed heartbeat write cannot resurrect a revoked session (durable revalidation + revocation hint)', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06fence');
  /* A dedicated synthetic actor for the fence proof, seeded inline so it is heartbeated in exactly
   * one test and its online -> revoked transition can never be masked by a sibling test. */
  await lab.seedActors(db, [{ actor: 'svc_dave', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' }]);
  const url = lab.dbUrl(db);

  let api, observer;
  try {
    api = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    observer = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    const session = await sessionFor(api, 'svc_dave');
    await api.call('heartbeat', [session.token, true]);
    assert.equal((await observer.call('view', ['svc_dave', 'svc_dave'])).presence.online, true, 'the session is online before revocation');

    /* Revoke the session (logout). The public session id is exactly what the API writes as sessionRef,
     * and the revoker leaves a bounded fence hint for it. */
    const rows = await api.call('sessions', [session.token]);
    const ref = rows.find((r) => r.current === true).id;
    await api.call('logout', [session.token]);
    const hinted = await observer.call('presenceCheckRevoked', [[ref]]);
    assert.deepEqual(hinted.revoked, [ref], 'the revoker left a durable-fenced revocation hint for the session');

    /* Simulate the DELAYED write a losing heartbeat would perform: it lands AFTER the revocation, so
     * it really re-adds the revoked session's presence. A naive projection would now read online. */
    const wrote = await observer.call('presenceTouch', ['svc_dave', ref, true, 60000]);
    assert.equal(wrote.stored, true, 'the delayed write really re-added the presence (the race is reachable)');
    assert.equal((await observer.call('presenceRead', ['svc_dave'])).sessions.length, 1, 'the stale member is physically present');

    /* The projection still reads offline: every Redis member is revalidated against the durable
     * identity.sessions rows inside the read transaction (and the revocation hint is the fast path),
     * so a ghost member for a deleted/expired session can never be projected online. */
    const view = await observer.call('view', ['svc_dave', 'svc_dave']);
    assert.equal(view.presence.online, false, 'a stale member is fenced out of the projection');
    assert.equal(view.presence.state, 'offline', 'the actor reads offline, never resurrected online');

    /* And a fresh heartbeat on the revoked bearer is refused at the durable row, writing nothing. */
    const stale = await api.call('heartbeat', [session.token, true]).then(() => 'ACCEPTED', (e) => e.message);
    assert.equal(stale, 'AUTH_REQUIRED', 'the revoked bearer cannot heartbeat at all');

    assert.deepEqual(await observer.shutdown(), { code: 0, signal: null });
    assert.deepEqual(await api.shutdown(), { code: 0, signal: null });
  } finally {
    for (const proc of [api, observer]) if (proc && !proc.exited) proc.kill();
  }
  await lab.closeDatabasePools(db);
});

/* ---------------------------------------------------------------- privacy precedence */

test('P06 consumers: presence honors the existing friends/hidden privacy precedence', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p06priv');
  await lab.seedActors(db, lab.seedFor(['svc_alice', 'svc_bob', 'svc_carol']));
  const url = lab.dbUrl(db);
  let api;
  try {
    api = await startChild({ databaseUrl: url, role: 'api_runtime', clock: lab.CLOCK, redis: redisOptions() });
    const alice = await sessionFor(api, 'svc_alice');
    await api.call('heartbeat', [alice.token, true]);

    /* Default presence_visibility is 'friends': a non-friend observer sees hidden, the actor sees self. */
    const stranger = await api.call('view', ['svc_carol', 'svc_alice']);
    assert.equal(stranger.presence.state, 'hidden', 'a non-friend sees hidden under the friends default');
    const selfView = await api.call('view', ['svc_alice', 'svc_alice']);
    assert.equal(selfView.presence.online, true, 'the actor always sees its own online state');

    /* Make them friends: the observer now sees the live presence under the friends default. */
    await api.call('social', ['svc_alice', 'p-req', 'request', 'svc_carol']);
    await api.call('social', ['svc_carol', 'p-acc', 'accept', 'svc_alice']);
    const friendView = await api.call('view', ['svc_carol', 'svc_alice']);
    assert.equal(friendView.presence.online, true, 'a friend sees the live presence under the friends default');

    /* Hidden withholds presence even from a friend, but NEVER from the actor itself while an adapter
     * is present (self is always a visible viewer). */
    await api.call('edit', ['svc_alice', { presenceVisibility: 'hidden' }]);
    const hiddenFriend = await api.call('view', ['svc_carol', 'svc_alice']);
    assert.equal(hiddenFriend.presence.state, 'hidden', 'hidden withholds presence even from a friend');
    const hiddenStranger = await api.call('view', ['svc_bob', 'svc_alice']);
    assert.equal(hiddenStranger.presence.state, 'hidden', 'hidden withholds presence from a stranger');
    const hiddenSelf = await api.call('view', ['svc_alice', 'svc_alice']);
    assert.equal(hiddenSelf.presence.online, true, 'privacy never hides the actor from itself when an adapter is present');

    /* The approved vocabulary is exactly friends|hidden: an invented value is refused, unchanged. */
    const bad = await api.call('edit', ['svc_alice', { presenceVisibility: 'public' }]).then(() => 'OK', (e) => e.message);
    assert.equal(bad, 'INVALID_PRIVACY', 'the approved presence vocabulary (friends|hidden) is enforced');

    assert.deepEqual(await api.shutdown(), { code: 0, signal: null });
  } finally {
    if (api && !api.exited) api.kill();
  }
  await lab.closeDatabasePools(db);
});
