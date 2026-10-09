'use strict';
/* P06 API presence consumer verification: the REAL account service (packages/services/accounts.js)
 * driven through the caller-owned ephemera adapter (packages/services/ephemera.js) against real
 * PostgreSQL and a real Redis.
 *
 * What this proves (the API half of V5-06-03):
 *  - heartbeat(token,foreground) writes per-session presence OUTSIDE the transaction, is bounded by
 *    the durable PostgreSQL rate bucket, and returns the caller's own live projection;
 *  - view/self/friends decorate the approved projection with the SAME pair-visibility rule the legacy
 *    store used (self / public / friend), so a hidden or non-friend viewer never learns liveness;
 *  - multi-session semantics: a background heartbeat never hides a still-foreground sibling, and
 *    logging out the background device leaves the actor online while logging out the last session
 *    (or all devices) drops it; a revoked/expired bearer cannot resurrect presence;
 *  - the conservative defaults: an ABSENT adapter keeps the frozen hidden projection and heartbeat
 *    reports offline without writing; an UNAVAILABLE adapter (present, unreachable) reports offline
 *    for a visible viewer and hidden for a denied one - never a fabricated online;
 *  - PostgreSQL (sessions) remains the sole authentication/revocation authority: a wiped or down
 *    Redis cannot authenticate, resurrect or mint anything;
 *  - the presence TOUCH itself is ONE atomic server-side script, so a lost response or a socket cut
 *    right after the mutation can never leave a member-carrying sorted set without a TTL.
 *
 * PostgreSQL is required (owned lab, skipped without V5_PG_URL); the Redis paths default to the
 * owned loopback instance and skip when REDIS_URL is absent, exactly like tests/v5-p06-ephemera.js.
 * No Core routing/matchmaking/realtime behaviour is exercised or claimed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createAccountService } = require('../packages/services/accounts.js');

lab.installCleanup(test);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const DEAD_URL = 'redis://127.0.0.1:59999';
const redisOptions = (environment, extra = {}) => ({
  url: REDIS_URL,
  environment,
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
  ...extra,
});

/* Every ephemera service this file creates is closed in the teardown; the account service never
 * closes a caller-owned adapter, so this file owns the lifetime. */
const openAdapters = [];
const adapter = async (extra = {}) => {
  const service = await createEphemeraService(redisOptions('test', extra));
  openAdapters.push(service);
  return service;
};
test.after(async () => {
  for (const service of openAdapters) {
    try { await service.wipeNamespace(); } catch { /* nothing to clean */ }
    try { await service.close(); } catch { /* best effort */ }
  }
});

const accountsFor = (database, options = {}) => createAccountService(lab.poolsFor(database).api, {
  now: () => lab.CLOCK, otpSecret: lab.OTP_SECRET, ...options,
});

/* A fresh migrated database seeded with the three approved synthetic actors. */
const harness = async (family, options = {}) => {
  const database = await lab.createDatabase(family);
  await lab.seedActors(database);
  const accounts = await accountsFor(database, options);
  return { database, accounts };
};

/* ------------------------------------------------------------ core behaviour */

test('P06 presence: heartbeat, multi-session foreground/background, privacy and logout', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const ephemera = await adapter({ keyVersion: 'pcore' });
  assert.equal(await ephemera.healthy(), true, 'the owned Redis must answer PING');
  const { database, accounts } = await harness('presence_core', { ephemera });
  try {
    /* Two independent sessions for one actor (two devices). `issue` returns a real linked bearer. */
    const first = await accounts.issue('svc_alice', lab.CLOCK);
    const second = await accounts.issue('svc_alice', lab.CLOCK);
    assert.equal(first.actor, 'svc_alice');

    /* A fresh anonymous actor has NO live session: self view is offline, never hidden, and is not
     * fabricated online. */
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'offline', online: false });

    /* Foreground heartbeat on the first device -> online, returned as the caller's own view. */
    assert.deepEqual(await accounts.heartbeat(first.token, true), { state: 'online', online: true });
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'online', online: true });

    /* The approved legacy `in-match` state: a foreground session in a COMMITTED match reads
     * `in-match` (account_state.competitive.activeMatch, the API-derivable projection). */
    const admin = await lab.adminClient(database);
    try {
      await admin.query("INSERT INTO core.actor_occupancy (actor_id, kind, ref_id, claimed_at) VALUES ('svc_alice','match','match_live_1', now())");
    } finally { await admin.end(); }
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'in-match', online: true });
    const cleanup = await lab.adminClient(database);
    try { await cleanup.query("DELETE FROM core.actor_occupancy WHERE actor_id = 'svc_alice'"); } finally { await cleanup.end(); }
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'online', online: true }, 'leaving the match returns to online');

    /* The second device heartbeats in the BACKGROUND: it must not disturb the still-foreground
     * first session, so the actor stays online (multi-session, foreground wins). */
    assert.deepEqual(await accounts.heartbeat(second.token, false), { state: 'online', online: true });
    assert.deepEqual((await accounts.self('svc_alice')).presence, { state: 'online', online: true });

    /* Logging out the BACKGROUND device leaves the foreground sibling online. */
    await accounts.logout(second.token);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'online', online: true });

    /* A background-only actor (heartbeat false with no foreground session) reads away, not online. */
    const third = await accounts.issue('svc_bob', lab.CLOCK);
    assert.deepEqual(await accounts.heartbeat(third.token, false), { state: 'away', online: false });

    /* Logging out the LAST foreground session drops the actor to offline. */
    await accounts.logout(first.token);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'offline', online: false });

    /* PRIVACY. A stranger viewing a `friends`-visibility actor who is online sees hidden; a friend
     * sees the live state; the actor's own view is always visible. */
    const carol = await accounts.issue('svc_carol', lab.CLOCK);
    await accounts.heartbeat(carol.token, true);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_carol')).presence, { state: 'hidden', online: false }, 'presence_visibility friends hides a non-friend');
    await accounts.social('svc_alice', 'core-req', 'request', 'svc_carol');
    await accounts.social('svc_carol', 'core-acc', 'accept', 'svc_alice');
    assert.deepEqual((await accounts.view('svc_alice', 'svc_carol')).presence, { state: 'online', online: true }, 'a friend sees the live presence');
    /* A `hidden` presence_visibility hides even a friend. */
    await accounts.edit('svc_carol', { presenceVisibility: 'hidden' });
    assert.deepEqual((await accounts.view('svc_alice', 'svc_carol')).presence, { state: 'hidden', online: false });
    assert.deepEqual((await accounts.view('svc_carol', 'svc_carol')).presence, { state: 'online', online: true }, 'the owner always sees its own presence');

    /* friends(actor) decorates each friend with the same presence object and sorts online first. */
    const friends = await accounts.friends('svc_alice');
    const carolEntry = friends.friends.find((f) => f.id === 'svc_carol');
    assert.ok(carolEntry, 'the accepted friend is listed');
    assert.deepEqual(carolEntry.presence, { state: 'hidden', online: false }, 'a hidden friend presence is hidden in the list too');

    /* The presence keys hold ONLY the derived session reference (never the bearer) and every key is
     * bounded by a TTL. */
    const audit = await ephemera.auditUnboundedKeys();
    assert.equal(audit.available, true);
    assert.deepEqual(audit.unbounded, [], 'no presence key may be immortal');
  } finally {
    await accounts.close();
    await lab.closeDatabasePools(database);
  }
});

/* --------------------------------------------- revocation and the durable authority */

test('P06 presence: a revoked session cannot resurrect presence, and a wiped Redis cannot authenticate', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const ephemera = await adapter({ keyVersion: 'prevoke' });
  const { database, accounts } = await harness('presence_revoke', { ephemera });
  try {
    const session = await accounts.issue('svc_alice', lab.CLOCK);
    const other = await accounts.issue('svc_alice', lab.CLOCK);
    await accounts.heartbeat(session.token, true);
    await accounts.heartbeat(other.token, false);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'online', online: true });

    /* Revoke the FOREGROUND session: its presence is dropped post-commit, so only the background
     * sibling remains and the actor reads away (not online) - and a STALE heartbeat on the revoked
     * bearer is refused (AUTH_REQUIRED) and writes nothing, so the durable row decides. */
    const list = await accounts.sessions(other.token);
    const target = list.find((s) => s.current === false);
    assert.ok(target, 'a sibling session is listed');
    await accounts.revokeSession(other.token, target.id);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'away', online: false }, 'revoking the foreground session leaves only the background sibling');
    await assert.rejects(() => accounts.heartbeat(session.token, true), (e) => e.message === 'AUTH_REQUIRED', 'a revoked bearer cannot heartbeat');

    /* Logout-all clears every session and its presence for good. */
    const fresh1 = await accounts.issue('svc_bob', lab.CLOCK);
    await accounts.issue('svc_bob', lab.CLOCK);
    await accounts.heartbeat(fresh1.token, true);
    assert.deepEqual((await accounts.view('svc_bob', 'svc_bob')).presence, { state: 'online', online: true });
    await accounts.logout(fresh1.token, true);
    assert.deepEqual((await accounts.view('svc_bob', 'svc_bob')).presence, { state: 'offline', online: false });
    await assert.rejects(() => accounts.heartbeat(fresh1.token, true), (e) => e.message === 'AUTH_REQUIRED');

    /* WIPE: losing the whole ephemera namespace can only make the system MORE conservative. The
     * PostgreSQL session remains the authority, so a fresh heartbeat self-heals presence while a
     * revoked bearer stays revoked. */
    const live = await accounts.issue('svc_carol', lab.CLOCK);
    await accounts.heartbeat(live.token, true);
    assert.equal((await ephemera.wipeNamespace()).available, true);
    assert.deepEqual((await accounts.view('svc_carol', 'svc_carol')).presence, { state: 'offline', online: false }, 'after the wipe presence is offline, never invented');
    /* Authentication and minting are unaffected by the wipe: the live bearer still authenticates and
     * a fresh heartbeat restores its presence. */
    await accounts.requireLinked(live.token);
    assert.deepEqual(await accounts.heartbeat(live.token, true), { state: 'online', online: true }, 'presence self-heals on the next heartbeat');
    /* A revoked bearer stays revoked after the wipe (PostgreSQL, not Redis, decided). */
    const doomed = await accounts.issue('svc_carol', lab.CLOCK);
    await accounts.logout(doomed.token);
    await assert.rejects(() => accounts.heartbeat(doomed.token, true), (e) => e.message === 'AUTH_REQUIRED');
  } finally {
    await accounts.close();
    await lab.closeDatabasePools(database);
  }
});

/* --------------------------------------------- the revocation fence (delayed-heartbeat race) */

test('P06 presence: the revocation fence prevents a delayed heartbeat from resurrecting a revoked session', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const ephemera = await adapter({ keyVersion: 'pfence' });
  const { database, accounts } = await harness('presence_fence', { ephemera });
  try {
    /* A heartbeat that committed its durable read but whose Redis write lands AFTER a revoke must
     * not render the revoked session online. Reproduce the ordering deterministically and, crucially,
     * with the Redis revocation HINT WIPED so only the durable authority can catch it.
     *
     * Setup: one foreground session plus a second live session used to perform the revoke. */
    const session = await accounts.issue('svc_alice', lab.CLOCK);
    const ref = (await accounts.sessions(session.token)).find((s) => s.current).id;
    await accounts.heartbeat(session.token, true);
    const second = await accounts.issue('svc_alice', lab.CLOCK);
    await accounts.heartbeat(second.token, false);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'online', online: true });

    /* Revoke the FOREGROUND session, then log the second session out: NO durable live session for the
     * actor remains, and the revocation hint is written by both revokers. */
    await accounts.revokeSession(second.token, ref);
    await accounts.logout(second.token);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'offline', online: false });

    /* WIPE every hint AND presence member, then perform the raw DELAYED write for the revoked
     * session - exactly the write a raced heartbeat would have made. With the hint gone, only the
     * DURABLE identity.sessions validation can reject it; a resurrected member would show online. */
    assert.equal((await ephemera.wipeNamespace()).available, true, 'the whole namespace (hints + presence) is wiped');
    await ephemera.presenceTouch('svc_alice', ref, true, 60000);
    assert.deepEqual((await ephemera.presenceRead('svc_alice')).sessions.map((s) => s.ref), [ref], 'the raw adapter DOES hold the delayed ghost member');
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'offline', online: false }, 'hint-less delayed write is still rejected by durable session validation');

    /* The API heartbeat on the revoked bearer is refused outright (no write). */
    await assert.rejects(() => accounts.heartbeat(session.token, true), (e) => e.message === 'AUTH_REQUIRED');
  } finally {
    await accounts.close();
    await lab.closeDatabasePools(database);
  }
});

/* --------------------------------------------- the final projection (delayed revoked foreground ghost) */

test('P06 presence: the heartbeat projection rejects a delayed revoked foreground ghost while a background sibling is live', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const ephemera = await adapter({ keyVersion: 'pghost' });
  const { database, accounts } = await harness('presence_ghost', { ephemera });
  try {
    /* Two live sessions for one actor: `fgSession` foreground, `bgSession` background. */
    const fgSession = await accounts.issue('svc_alice', lab.CLOCK);
    const bgSession = await accounts.issue('svc_alice', lab.CLOCK);
    const fgRef = (await accounts.sessions(fgSession.token)).find((s) => s.current).id;
    assert.deepEqual(await accounts.heartbeat(fgSession.token, true), { state: 'online', online: true });
    assert.deepEqual(await accounts.heartbeat(bgSession.token, false), { state: 'online', online: true }, 'the durable foreground sibling keeps the actor online');

    /* Revoke the FOREGROUND session through the background bearer: its presence is dropped post-commit
     * and only the live background sibling remains -> away, never online. */
    await accounts.revokeSession(bgSession.token, fgRef);
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'away', online: false });

    /* WIPE every hint and member, then let the RAW DELAYED write for the revoked foreground ref land -
     * exactly what a raced heartbeat or a lost hint leaves behind. The durable row still validates the
     * live background sibling, so the adapter genuinely holds a foreground ghost (not a mock/hint). */
    assert.equal((await ephemera.wipeNamespace()).available, true, 'hints + presence wiped');
    await ephemera.presenceTouch('svc_alice', fgRef, true, 60000);
    const raw = await ephemera.presenceRead('svc_alice');
    assert.deepEqual(raw.sessions.map((s) => s.ref), [fgRef], 'the raw adapter DOES contain the revoked foreground ghost');
    assert.equal(raw.sessions[0].foreground, true, 'the adapter really marks it foreground');

    /* CONSUMER-VISIBLE REGRESSION: the live BACKGROUND sibling heartbeats; the final projection must
     * filter the ghost through the durable sessions and report away/online:false - NOT online - and the
     * profile view must agree. */
    assert.deepEqual(await accounts.heartbeat(bgSession.token, false), { state: 'away', online: false }, 'the heartbeat projection must not count the delayed revoked foreground ghost');
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'away', online: false }, 'the profile projection agrees');
    /* The live background sibling's own member is present in the adapter, so the ghost is not the only
     * member and the away verdict is not a wiped-Redis artifact. */
    const after = await ephemera.presenceRead('svc_alice');
    assert.ok(after.sessions.some((s) => s.ref !== fgRef), 'the live background sibling member remains in the adapter');
  } finally {
    await accounts.close();
    await lab.closeDatabasePools(database);
  }
});

/* --------------------------------------------- conservative defaults and validation */

test('P06 presence: adapter absent is a precise conservative default; adapter unavailable never fabricates online', async (t) => {
  if (!(await lab.boot(t))) return;
  /* The ABSENT-adapter deployment needs no Redis at all: the frozen projection must be preserved. */
  const { database, accounts } = await harness('presence_absent');
  const gone = HAVE_REDIS ? await adapter({ keyVersion: 'pdown', url: DEAD_URL, allowPlaintext: true, socket: { connectTimeout: 300, reconnectStrategy: () => 60000 } }) : null;
  const { database: downDb, accounts: downAccounts } = HAVE_REDIS ? await harness('presence_down', { ephemera: gone }) : { database: null, accounts: null };
  try {
    const session = await accounts.issue('svc_alice', lab.CLOCK);

    /* Non-boolean foreground is refused before ANY I/O, with or without an adapter. */
    await assert.rejects(() => accounts.heartbeat(session.token, 'yes'), (e) => e.message === 'INVALID_PRESENCE');
    await assert.rejects(() => accounts.heartbeat(session.token, undefined), (e) => e.message === 'INVALID_PRESENCE');

    /* Adapter ABSENT: heartbeat resolves the conservative offline (never throws, never online) and
     * the projection keeps the frozen hidden default - including for the actor's OWN view. */
    assert.deepEqual(await accounts.heartbeat(session.token, true), { state: 'offline', online: false });
    assert.deepEqual((await accounts.view('svc_alice', 'svc_alice')).presence, { state: 'hidden', online: false });
    assert.deepEqual((await accounts.self('svc_alice')).presence, { state: 'hidden', online: false });
    assert.deepEqual((await accounts.view('svc_bob', 'svc_alice')).presence, { state: 'hidden', online: false });
    /* A revoked bearer is still refused with the absent adapter (the durable row decides). */
    await accounts.logout(session.token);
    await assert.rejects(() => accounts.heartbeat(session.token, true), (e) => e.message === 'AUTH_REQUIRED');

    if (HAVE_REDIS && downAccounts) {
      /* Adapter PRESENT but UNREACHABLE (dead URL): every read resolves to the conservative shape.
       * A visible viewer is offline (never hidden, never online); a denied viewer is hidden. */
      const live = await downAccounts.issue('svc_bob', lab.CLOCK);
      assert.deepEqual(await downAccounts.heartbeat(live.token, true), { state: 'offline', online: false }, 'a down adapter reports offline');
      assert.deepEqual((await downAccounts.view('svc_bob', 'svc_bob')).presence, { state: 'offline', online: false }, 'self view of a down adapter is offline');
      assert.deepEqual((await downAccounts.view('svc_alice', 'svc_bob')).presence, { state: 'hidden', online: false }, 'a down adapter still hides from a denied viewer');
      /* Authentication is untouched by the down adapter: the durable session row still authorises. */
      await downAccounts.requireLinked(live.token);
    }
  } finally {
    await accounts.close();
    await lab.closeDatabasePools(database);
    if (downAccounts) await downAccounts.close();
    if (downDb) await lab.closeDatabasePools(downDb);
  }
});

/* --------------------------------------------- atomic touch under lost responses / key expiry */

/* Opens a real TCP forwarder in front of the owned Redis: it relays bytes both ways, but can be told
 * to (a) stop returning replies at the exact moment the server has already applied a presence touch
 * and (b) drop the connection, or (c) cut every connection outright. This is the crash/response-loss
 * boundary for real - the mutation reaches real Redis, the client never sees the reply, and the key
 * state it left behind is observable afterwards from an independent direct connection. */
const net = require('node:net');
function startForwarder(targetHost, targetPort) {
  const sockets = new Set();
  let swallow = false;
  let cutOnReply = false;
  const destroyAll = () => { for (const s of [...sockets]) { try { s.destroy(); } catch { /* already gone */ } } };
  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(targetPort, targetHost);
    sockets.add(upstream);
    upstream.on('data', (chunk) => {
      if (cutOnReply) {
        /* The server has ALREADY produced this reply, so the request (and thus the whole atomic
         * mutation) was fully applied to real Redis. Swallow the reply and kill the connection: the
         * client can never learn that its write landed - the exact lost-response/crash boundary. */
        cutOnReply = false; swallow = true; destroyAll(); return;
      }
      if (swallow) return;
      try { client.write(chunk); } catch { /* client gone */ }
    });
    client.on('data', (chunk) => { try { upstream.write(chunk); } catch { /* upstream gone */ } });
    /* A connection-level error is EXPECTED when a test cuts the socket: never let it throw. */
    for (const s of [client, upstream]) {
      s.on('error', () => {});
      s.on('close', () => { sockets.delete(s); try { s.destroy(); } catch { /* already gone */ } });
    }
  });
  server.on('error', () => {});
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    /* Arm the deterministic cut: the NEXT reply the server produces is swallowed and both sockets
     * are destroyed. Reaches the exact moment AFTER the mutation landed and BEFORE the caller knows. */
    armCutOnReply: () => { swallow = false; cutOnReply = true; },
    dropAll: destroyAll,
    close: () => new Promise((done) => { destroyAll(); server.close(() => done()); }),
  })));
}
const pttlOf = async (service, key) => { const c = service.client; return c.pTTL(key); };

test('P06 presence: a lost touch response cannot leave an immortal session lease', { skip: !HAVE_REDIS ? 'no REDIS_URL' : (REDIS_URL.startsWith('rediss://') ? 'plaintext loopback needed for the TCP forwarder' : false) }, async (t) => {
  if (!(await lab.boot(t))) return;
  const direct = await adapter({ keyVersion: 'patomic' });
  assert.equal(await direct.healthy(), true, 'the direct adapter reaches real Redis');
  const target = new URL(REDIS_URL);
  const proxy = await startForwarder(target.hostname, Number(target.port));
  const viaProxy = await adapter({ keyVersion: 'patomic', url: `redis://127.0.0.1:${proxy.port}`, allowPlaintext: true });
  const ref = 'a'.repeat(24);
  /* The two exact keys a touch writes (the adapter's own namespace). */
  const keys = [direct.key('presence', 'all', 'svc_alice'), direct.key('presence', 'fg', 'svc_alice')];
  try {
    /* CONTROL: a healthy proxy touch is stored and both keys carry a finite, refreshed TTL - the
     * single server-side unit really writes the members AND their expiry together. */
    assert.deepEqual(await viaProxy.presenceTouch('svc_alice', ref, true, 45000), { stored: true, available: true });
    for (const key of keys) assert.ok((await pttlOf(direct, key)) > 0, `${key} carries a positive TTL after one touch`);
    assert.deepEqual((await direct.presenceRead('svc_alice')).sessions.map((s) => s.ref), [ref], 'the atomic touch really wrote the member');

    /* CRASH BOUNDARY: the server applies the touch, the client never receives the reply and the
     * connection dies. The operation reports the conservative fallback (the caller cannot know the
     * write happened) yet the atomic unit left the key fully formed WITH its TTL and its member -
     * never an immortal member-carrying set that no future touch would ever revisit. */
    const lostKeys = [direct.key('presence', 'all', 'svc_bob'), direct.key('presence', 'fg', 'svc_bob')];
    const newRef = 'c'.repeat(24);
    /* Arm the cut, then fire a touch whose reply is swallowed and whose sockets are destroyed the
     * instant the server produces it: the mutation HAS landed (proved by the surviving member and the
     * refreshed TTL) but the caller only ever sees the conservative fallback. */
    proxy.armCutOnReply();
    const lost = await viaProxy.presenceTouch('svc_bob', newRef, true, 60000);
    assert.deepEqual(lost, { stored: false, available: false, conservative: true }, 'a lost response resolves to the conservative fallback, never a positive fact or a hang');
    assert.ok((await direct.presenceRead('svc_bob')).sessions.some((s) => s.ref === newRef && s.foreground), 'the first session lease landed with both memberships despite the lost response');
    const allAfter = await pttlOf(direct, lostKeys[0]);
    const fgAfter = await pttlOf(direct, lostKeys[1]);
    assert.ok(allAfter > 0 && allAfter <= 60000, 'the ALL key is never left without a bounded TTL');
    assert.ok(fgAfter > 0 && fgAfter <= 60000, 'the FG key is never left without a bounded TTL');

    /* A short TTL really expires the whole touch as one unit; the members age off with the key, not
     * before it (the 45 s window and the cap semantics above are untouched by the atomic rewrite). */
    assert.deepEqual(await direct.presenceTouch('svc_alice', ref, true, 300), { stored: true, available: true }, 'a short TTL touch is stored');
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.deepEqual((await direct.presenceRead('svc_alice')).sessions, [], 'the touch and its members expire as a whole with the key TTL');
    assert.equal(await pttlOf(direct, keys[0]), -2, 'the ALL key is gone, not immortal');
  } finally {
    await proxy.close();
    await viaProxy.close();
    await direct.close();
  }
});

test('P06 presence: the atomic touch preserves GT monotonicity, the foreground/background split and the 16-member cap', { skip: HAVE_REDIS ? false : 'no REDIS_URL' }, async (t) => {
  if (!(await lab.boot(t))) return;
  const service = await adapter({ keyVersion: 'psem' });
  const actor = 'svc_carol';
  try {
    /* GT: a session heartbeating twice keeps its newest score, and a touch that re-arrives with an
     * OLDER score must never move a member backwards in time. The ref is then demoted to background
     * in the same atomic unit (FG member removed, ALL member kept). */
    const stale = 'a'.repeat(24);
    assert.deepEqual(await service.presenceTouch(actor, stale, true, 300000), { stored: true, available: true });
    const future = Date.now() + 5000;
    for (const family of ['all', 'fg']) await service.client.zAdd(service.key('presence', family, actor), { score: future, value: stale });
    assert.deepEqual(await service.presenceTouch(actor, stale, true, 300000), { stored: true, available: true });
    assert.deepEqual(await service.presenceTouch(actor, stale, false, 300000), { stored: true, available: true }, 'the same ref can be demoted to background');
    const rows = (await service.presenceRead(actor)).sessions;
    assert.deepEqual(rows.map((s) => s.ref), [stale]);
    assert.equal(rows[0].foreground, false, 'the background demotion removed the FG member in the same atomic touch');
    assert.equal(rows[0].seen, future, 'an older heartbeat cannot regress the newer stored timestamp');
    await service.presenceDrop(actor, stale);

    /* CAP: add 20 distinct refs; the sorted set keeps at most PRESENCE_CAP (16) NEWEST members. */
    const refs = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(24, '0'));
    for (const r of refs) {
      await service.presenceTouch(actor, r, true, 60000);
      /* Distinct monotonic scores: guarantee the 4 oldest refs are rank-evicted rather than score-tied. */
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const capped = (await service.presenceRead(actor)).sessions;
    assert.equal(capped.length, 16, 'at most PRESENCE_CAP members survive a single actor');
    assert.deepEqual(capped.map((s) => s.ref).sort(), refs.slice(4).sort(), 'the 16 newest members survive and the 4 oldest are rank-evicted');
    const capAudit = await service.auditUnboundedKeys();
    assert.equal(capAudit.available, true);
    assert.deepEqual(capAudit.unbounded, [], 'every presence key still carries a finite TTL');
  } finally {
    await service.close();
  }
});
