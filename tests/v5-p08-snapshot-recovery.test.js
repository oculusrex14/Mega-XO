'use strict';
/* tests/v5-p08-snapshot-recovery.test.js - V5 P08 task V5-08-04 snapshot/delta recovery and the
 * ordinary HTTP snapshot fallback.
 *
 * SCOPE. Drives the `resume` operation of `packages/services/realtime-transport.js`
 * (`createRealtimeTransport`) and the HTTP fallback mounted on the SAME server, over a REAL owned
 * PostgreSQL 16 lab (`tests/v5-pg-lab.js`) and a REAL loopback Redis ephemera adapter
 * (`packages/services/ephemera.js`). PostgreSQL is the durable authority: every frame the transport
 * emits is compared against an INDEPENDENT `core.readMatch` oracle read with no transport in the
 * loop, and the durable revision is never re-typed - it is read from the committed aggregate.
 *
 * WIRE CONTRACT (the recovery half of the frozen `packages/contracts/realtime.js` envelope):
 *   client -> server  {protocol:'realtime/v1',operation:'resume',match_id,ack_revision}
 *   server -> client  ack      {protocol,operation:'ack',match_id,ack_revision}
 *                     delta    {protocol,operation:'delta',match_id,expected_revision,
 *                               delta:{from,to,moves},server_now}
 *                     snapshot {protocol,operation:'snapshot',match_id,expected_revision,
 *                               snapshot,server_now}
 *   plain HTTP        GET /realtime/v1/snapshot?match_id=..&actor=..   -> application/json snapshot
 *                     GET /realtime/v1/match/:id?actor=..             -> application/json snapshot
 *
 * WHAT THIS SUITE PROVES (the parent ticket's five cases):
 *   1. RESUME AT THE CURRENT REVISION answers `ack` carrying the durable revision - the client is
 *      already synchronized, so no snapshot and no delta frame is sent for it.
 *   2. RESUME AFTER A MISSED COMMIT. A subscriber socket is closed while the match is at revision 0;
 *      the opponent then commits a REAL move to revision 1 (a genuine pubsub miss). A fresh
 *      connection redeems a fresh ticket and resumes at ack_revision 0: it receives the bounded
 *      delta (from 0 to 1, carrying exactly the one missed move) AND the authoritative snapshot at
 *      revision 1. The snapshot is byte-equal to the independent oracle, so the recovered client is
 *      synchronized WITHOUT reapplying the move.
 *   3. CORRUPTED / FUTURE ack_revision. ack_revision 99 (ahead of the true revision) is never trusted:
 *      the server answers the FULL current snapshot at the true revision and sends no delta.
 *   4. HTTP FALLBACK. A plain GET to the snapshot route returns the current durable match view as
 *      application/json, byte-equal to the oracle - the same authority the socket serves.
 *   5. TEARDOWN. Closing the sockets and the transport releases every advisory Redis route, removes
 *      the upgrade listener and leaves the registry empty. `lab.installCleanup` drops the guarded
 *      pools and owned databases; every service closes naturally - no force-exit.
 *
 * GATING (the repo convention): needs BOTH the owned loopback Redis (`REDIS_URL`, or
 * `V5_REDIS_REQUIRED=1` to fail instead of skip) and the owned PostgreSQL lab (`V5_PG_URL`, or
 * `V5_PG_REQUIRED=1` to fail instead of skip). Absent either, the whole suite skips.
 *
 * CLOCK AND ADMISSION. The authority clock starts at the lab's frozen CLOCK; the ticket issuer and
 * the transport redeem against a mutable copy that only moves FORWARD, so each test retires the
 * tickets an earlier test left open (past the 10 s durable TTL) and the per-actor outstanding/live
 * admission caps stay deterministic. The Core service keeps the frozen clock, so a fixture match's
 * turn deadline never elapses while a test runs.
 *
 *   env V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
 *       REDIS_URL=redis://127.0.0.1:50710 \
 *       node --test --test-concurrency=1 tests/v5-p08-snapshot-recovery.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createTicketIssuer } = require('../packages/services/tickets.js');
const { PROTOCOL } = require('../packages/contracts/realtime.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_REDIS && HAVE_PG ? false : (!HAVE_REDIS ? 'no REDIS_URL' : 'no V5_PG_URL');

const KEY_VERSION = 'rtp08r';
const INGRESS = '/realtime/v1';
const SNAPSHOT_PATH = `${INGRESS}/snapshot`;
const MATCH_PREFIX = `${INGRESS}/match/`;
/* One disjoint actor pair per test, so no two tests contend for the same rated pair limits or the
 * per-actor ticket admission budget. */
const FIXTURES = Object.freeze({
  current: ['svc_p08r01', 'svc_p08r02'],
  delta: ['svc_p08r03', 'svc_p08r04'],
  ahead: ['svc_p08r05', 'svc_p08r06'],
  http: ['svc_p08r07', 'svc_p08r08'],
  teardown: ['svc_p08r09', 'svc_p08r10'],
});
const SEEDS = Object.values(FIXTURES).flat()
  .map((actor) => ({ actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* A bounded poll for a fire-and-forget side effect (the advisory Redis route record). */
const until = async (probe, { timeoutMs = 4000, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
};

/* --------------------------------------------------------------- shared lab -- */

/* `packages/services/realtime-transport.js` is loaded lazily so a checkout without the P08 module
 * skips (rather than throws at require time) when the gates are unset. */
let transportFactory = null;
const loadTransportFactory = () => {
  if (!transportFactory) {
    const mod = require('../packages/services/realtime-transport.js');
    assert.equal(typeof mod.createRealtimeTransport, 'function', 'packages/services/realtime-transport.js must export createRealtimeTransport');
    transportFactory = mod.createRealtimeTransport;
  }
  return transportFactory;
};

const ephemeraOptions = () => ({
  url: REDIS_URL,
  environment: 'test',
  keyVersion: KEY_VERSION,
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
});

/* One owned database / pool set / Core / issuer / Redis adapter for the whole file: every test is an
 * isolated socket scenario against the SAME durable authority, exactly as a running Core would be. */
let sessionPromise = null;
async function session(t) {
  if (!(await lab.boot(t))) return null;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const database = await lab.createDatabase('p08rec');
      await lab.seedActors(database, SEEDS);
      const pools = lab.poolsFor(database);
      const core = await lab.coreFor(database);
      const issuer = await createTicketIssuer(pools.api, { now: () => clock, environment: 'stg', audience: 'mega-core' });
      const ephemera = await createEphemeraService(ephemeraOptions());
      assert.equal(await ephemera.healthy(), true, 'the owned Redis must answer PING');
      return { database, pools, core, issuer, ephemera };
    })();
  }
  return sessionPromise;
}

/* The mutable authority clock: the issuer stamps `expires_at` from it and the transport redeems
 * with it, so ticket expiry is decided by real millisecond arithmetic, not by a sleep. It only ever
 * moves FORWARD (a backward step would un-expire a durable ticket), and advancing past the 10 s TTL
 * retires the tickets of earlier tests so the per-actor admission caps stay deterministic. The Core
 * service keeps the lab's frozen CLOCK, so no fixture deadline is affected. */
let clock = lab.CLOCK;
const tick = (ms) => { clock += ms; };

/* The REAL route keys this suite's adapter writes; read through the same borrowed adapter the
 * transport uses. The namespace is this suite's own (`mx:test:rtp08r:route:*`). */
const routeKeys = (ephemera) => ephemera.client.keys(`mx:test:${KEY_VERSION}:route:*`);

/* Core commits a real PLAYING direct match for the pair, then (optionally) one real move so the
 * durable revision is non-zero. The returned DTO is ALWAYS a `core.readMatch` document, so every
 * caller (and the independent oracle below) compares the identical shape. */
async function playMatch(h, id, playerA, playerB, { move = false } = {}) {
  const offer = await h.core.run({ actor: playerA, scope: 'player' }, `offer:${id}`, {
    type: 'offer', id, opponent: playerB, terms: { kind: 'leaderboard', amount: 40 },
  });
  assert.equal(offer.status, 'OFFERED', 'the fixture offer is committed OFFERED');
  const accepted = await h.core.run({ actor: playerB, scope: 'player' }, `accept:${id}`, {
    type: 'accept', id, termsHash: offer.termsHash,
  });
  assert.equal(accepted.status, 'PLAYING', 'the fixture match is committed PLAYING');
  let view = await h.core.readMatch(playerA, id);
  assert.equal(view.revision, 0, 'the fixture match is committed at revision 0');
  if (move) {
    const mover = view.symbols.X;
    await h.core.run({ actor: mover, scope: 'player' }, `move:${id}:1`, {
      type: 'move', id, revision: view.revision, move: { b: 0, c: 0 },
    });
    view = await h.core.readMatch(playerA, id);
    assert.equal(view.revision, 1, 'the fixture move commits revision 1');
  }
  return view;
}

/* Issue one ticket after advancing the clock past the 10 s durable TTL, so a ticket left open by an
 * earlier test can never consume this test's per-actor outstanding/live admission budget. */
async function issue(h, request) {
  tick(15000);
  return h.issuer.issue(request);
}

const sessionIdFor = (actor, matchId) => crypto.createHash('sha256').update(`${actor}:${matchId}`).digest('hex').slice(0, 24);
const binding = (extra = {}) => ({
  actor: 'svc_p08r01', sessionId: 'a'.repeat(24), generation: 1,
  connectionClass: 'game', matchScope: null, ipHash: null, ...extra,
});
/* The independent Core oracle for a match DTO: no transport is involved. */
const oracle = (h, actor, matchId) => h.core.readMatch(actor, matchId);

/* ------------------------------------------------------------- test harness -- */

/* The paths the transport's HTTP snapshot fallback owns. Everything else on this server stays the
 * test's own 404. */
const isSnapshotPath = (target) => {
  const cut = String(target).split('?')[0].split('#')[0];
  const path = cut.length > 1 && cut.endsWith('/') ? cut.slice(0, -1) : cut;
  return path === SNAPSHOT_PATH || path.startsWith(MATCH_PREFIX);
};

/* A dedicated HTTP server with the transport attached. The transport may serve the snapshot
 * fallback either from its OWN 'request' listener (it registers one during construction - it is
 * then allowed to answer the snapshot routes alone) or by exposing a request handler the host
 * mounts. Both shapes are supported here so the test proves the contract, not one implementation
 * detail:
 *   - `ownsRequests`: the transport registered a 'request' listener; this server's handler then
 *     yields the snapshot paths to it (and stays out of the way of anything already answered).
 *   - `handler`: the transport exports a (req,res) function; this server's handler calls it for the
 *     snapshot paths.
 * Everything else is a plain 404 from this test's own handler. */
async function serve(h, t) {
  /* In a real deployment the API verifies the actual cookie/bearer, including
   * revocation. This disposable host models that boundary with opaque test-only
   * bearer credentials; neither actor query nor X-Actor is authority. */
  const httpTokens = new Map();
  const server = http.createServer((req, res) => {
    if (res.headersSent || res.writableEnded) return;
    if (isSnapshotPath(req.url)) {
      if (handler && !ownsRequests) { handler(req, res); return; }
      if (ownsRequests) return; /* the transport's own listener answers the snapshot routes */
    }
    res.writeHead(404); res.end('nope');
  });
  const beforeRequest = server.listenerCount('request');
  const transport = loadTransportFactory()({
    server, pool: h.pools.core, core: h.core, ephemera: h.ephemera, now: () => clock,
    authenticateHttp: async (req) => {
      const actor = httpTokens.get(req.headers.authorization);
      return actor ? { actor } : null;
    },
  });
  assert.equal(transport.ingressPath, INGRESS, 'the transport answers exactly the staged ingress');
  const ownsRequests = server.listenerCount('request') > beforeRequest;
  const handler = ['handleSnapshot', 'handleHttp', 'handleRequest', 'httpHandler']
    .map((key) => transport[key]).find((fn) => typeof fn === 'function');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const close = async () => {
    try { await transport.close(); } catch { /* best effort */ }
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return {
    server, transport, port, close, url: (path) => `ws://127.0.0.1:${port}${path}`,
    authorization(actor) {
      const secret = 'Bearer ' + crypto.randomBytes(32).toString('hex');
      httpTokens.set(secret, actor);
      return secret;
    },
  };
}

/* One plain HTTP GET, decoded as JSON when the body is JSON. Bounded so a fallback that never
 * answers fails the assertion instead of hanging the suite. */
function httpGet(port, path, authorization = null) {
  return new Promise((resolve, reject) => {
    const headers = authorization === null ? {} : { authorization };
    const req = http.get({ host: '127.0.0.1', port, path, headers, timeout: 6000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* a non-JSON body is reported as-is */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`http get timeout: ${path}`)); });
    req.on('error', reject);
  });
}
/* The HTTP fallback may answer with the bare durable view or with the snapshot envelope; both name
 * the same authority. This extracts the view without weakening the assertion. */
const viewOf = (payload) => {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), 'the snapshot response body is a JSON object');
  if (payload.operation === 'snapshot' && payload.snapshot && typeof payload.snapshot === 'object') return payload.snapshot;
  return payload;
};

/* -------------------------------------------------------- browser-grade client - */

/* The Node global `WebSocket` (RFC 6455 conformant) drives the authenticated scenarios: a real
 * handshake, real masked frames and a real close event, with no test-owned framing. `idle(ms)`
 * proves a frame did NOT arrive (and keeps it queued if it did, so nothing is silently swallowed). */
function wsClient(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let closeInfo = null;
  const closeWaiters = [];
  ws.addEventListener('error', () => { /* the close event carries the outcome */ });
  ws.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(frame); else queue.push(frame);
  });
  ws.addEventListener('close', (event) => {
    closeInfo = { code: event.code, reason: event.reason, wasClean: event.wasClean };
    while (closeWaiters.length) closeWaiters.shift()(closeInfo);
  });
  const timebox = (promise, label) => Promise.race([
    promise,
    sleep(6000).then(() => { throw new Error(`ws client timeout: ${label}`); }),
  ]);
  return {
    ws,
    open: () => timebox(new Promise((resolve, reject) => {
      if (closeInfo) return reject(new Error(`closed ${closeInfo.code} before open`));
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('close', (e) => reject(new Error(`closed ${e.code} before open`)), { once: true });
    }), 'open'),
    send: (value) => ws.send(JSON.stringify(value)),
    next: () => timebox(new Promise((resolve) => {
      if (queue.length) return resolve(queue.shift());
      waiters.push(resolve);
    }), 'frame'),
    idle: (ms) => timebox(new Promise((resolve) => {
      if (queue.length) return resolve(false);
      const waiter = (frame) => { clearTimeout(timer); queue.unshift(frame); resolve(false); };
      const timer = setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at !== -1) waiters.splice(at, 1);
        resolve(true);
      }, ms);
      waiters.push(waiter);
    }), 'idle'),
    closed: () => closeInfo,
    waitClose: () => timebox(new Promise((resolve) => {
      if (closeInfo) return resolve(closeInfo);
      closeWaiters.push(resolve);
    }), 'close'),
  };
}
const redeemFrame = (ticket) => ({ protocol: PROTOCOL, operation: 'ticket.redeem', ticket });
const subscribeFrame = (matchId) => ({ protocol: PROTOCOL, operation: 'subscribe', match_id: matchId });
const resumeFrame = (matchId, ackRevision) => ({ protocol: PROTOCOL, operation: 'resume', match_id: matchId, ack_revision: ackRevision });

/* Redeem one one-use ticket (unscoped, so the redemption `ack` names the `auth` scope and can never
 * be confused with a match `ack`). The connection is left UNSUBSCRIPTED: `resume` must therefore
 * prove membership itself, which is exactly the path under test. */
async function connect(h, s, actor, matchId) {
  const { ticket } = await issue(h, binding({ actor, sessionId: sessionIdFor(actor, matchId), matchScope: null }));
  const client = wsClient(s.url(INGRESS));
  await client.open();
  client.send(redeemFrame(ticket));
  assert.deepEqual(await client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: 'auth', ack_revision: 0 },
    'the redeemed unscoped ticket acks the auth scope');
  return client;
}

const closeAll = async (clients) => {
  for (const client of clients) { try { client.ws.close(1000); } catch { /* already gone */ } }
  await Promise.allSettled(clients.map((client) => client.waitClose()));
};

/* ======================================================= 1. resume in sync ==== */

test('V5-08-04 recovery: resume at the current revision is answered ack with the durable revision', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08r-current';
  const [playerA] = FIXTURES.current;
  const view = await playMatch(h, matchId, ...FIXTURES.current);
  assert.equal(view.revision, 0, 'the fixture match is committed at revision 0');

  const client = await connect(h, s, playerA, matchId);
  /* The client was away briefly but missed nothing: it resumes at the revision the authority holds. */
  client.send(resumeFrame(matchId, view.revision));
  const ack = await client.next();
  assert.deepEqual(ack, { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: view.revision },
    'a client already at the durable head is acked with that head');

  /* Independent oracle: the ack revision is the committed aggregate's revision, not a transport
   * invention and not the client's claim. */
  const durable = await oracle(h, playerA, matchId);
  assert.ok(Number.isSafeInteger(durable.revision), 'the oracle reports a safe-integer revision');
  assert.equal(ack.ack_revision, durable.revision, 'the ack names the durable revision read back from PostgreSQL');

  /* In sync: NO snapshot and NO delta is warranted, so none is sent (and none is queued). */
  assert.equal(await client.idle(400), true, 'no snapshot or delta follows an in-sync resume');

  /* The resume also established the subscription (and the advisory route) for this fresh socket. */
  assert.equal(s.transport.stats().subscriptions, 1, 'resume subscribed the connection to the match');
  assert.equal(await until(async () => (await routeKeys(h.ephemera)).length > 0), true, 'resume registered the advisory Redis route');

  await closeAll([client]);
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the resume client closed cleanly');
});

/* ================================================= 2. missed-move recovery ==== */

test('V5-08-04 recovery: resume after a missed committed move returns the bounded delta and the updated snapshot', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08r-delta';
  const [playerA, playerB] = FIXTURES.delta;
  const atZero = await playMatch(h, matchId, playerA, playerB);
  assert.equal(atZero.revision, 0, 'the match starts at revision 0');

  /* The client is live at revision 0: it redeems, subscribes, and receives the committed snapshot. */
  const subscriber = atZero.symbols.O;
  const mover = atZero.symbols.X;
  const first = await connect(h, s, subscriber, matchId);
  first.send(subscribeFrame(matchId));
  const subscribed = await first.next();
  assert.equal(subscribed.operation, 'snapshot', 'the subscription answers the committed snapshot');
  assert.equal(subscribed.expected_revision, 0, 'the subscription snapshot is at revision 0');
  assert.deepEqual(subscribed.snapshot, atZero, 'the subscription snapshot is byte-equal to the oracle');

  /* The socket drops while the match is still at revision 0. Wait until the transport has really
   * torn the connection down, so the upcoming commit is a genuine MISSED pubsub message. */
  first.ws.close(1000);
  await first.waitClose();
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the disconnected client left the registry');
  assert.equal(s.transport.stats().subscriptions, 0, 'the dropped socket holds no subscription');

  /* The opponent (the seat that is NOT this disconnected client) commits a REAL move while the
   * client is gone: revision 0 -> 1. */
  assert.equal(atZero.symbols[atZero.state.turn], mover, 'the mover holds the current turn');
  await h.core.run({ actor: mover, scope: 'player' }, `move:${matchId}:1`, {
    type: 'move', id: matchId, revision: atZero.revision, move: { b: 4, c: 4 },
  });
  const atOne = await oracle(h, subscriber, matchId);
  assert.equal(atOne.revision, 1, 'the missed move committed revision 1');
  assert.equal(atOne.state.moves.length, 1, 'exactly one move is committed');
  assert.equal(atZero.revision, 0, 'the pre-disconnect snapshot the client holds is still revision 0');

  /* The client reconnects: fresh socket, fresh ticket, resume at the revision it last saw (0). */
  const back = await connect(h, s, subscriber, matchId);
  back.send(resumeFrame(matchId, 0));
  const frames = [await back.next()];
  if (!(await back.idle(500))) frames.push(await back.next());
  assert.equal(frames.length, 2, 'a bounded miss delivers BOTH a delta and a snapshot');
  const delta = frames.find((frame) => frame.operation === 'delta');
  const snapshot = frames.find((frame) => frame.operation === 'snapshot');
  assert.ok(delta, 'the bounded delta is delivered for a <= 10 revision miss');
  assert.ok(snapshot, 'the authoritative snapshot accompanies the delta');

  /* The delta spans exactly the missed window and carries exactly the missed moves (the durable
   * aggregate's own suffix - never a re-derived one). */
  assert.equal(delta.protocol, PROTOCOL);
  assert.equal(delta.match_id, matchId);
  assert.equal(delta.expected_revision, atOne.revision, 'the delta names the authoritative revision it brings the client to');
  assert.ok(delta.delta && typeof delta.delta === 'object' && !Array.isArray(delta.delta), 'the delta body is an object');
  assert.equal(delta.delta.from, 0, 'the delta starts where the client stopped');
  assert.equal(delta.delta.to, atOne.revision, 'the delta ends at the authoritative revision');
  assert.deepEqual(delta.delta.moves, atOne.state.moves.slice(0), 'the delta moves are the durable suffix from ack_revision');
  assert.equal(delta.delta.moves.length, 1, 'exactly the one missed move travels in the delta');
  assert.deepEqual(delta.delta.moves[0], atOne.state.moves[0], 'the delta move is the committed one');
  assert.ok(Number.isSafeInteger(delta.server_now) && delta.server_now > 0, 'the delta carries the authority clock');

  /* The snapshot is the FULL authoritative view at the new revision: applying it alone leaves the
   * client synchronized, so the missed move is never reapplied on top of a stale local board. */
  assert.equal(snapshot.protocol, PROTOCOL);
  assert.equal(snapshot.match_id, matchId);
  assert.equal(snapshot.expected_revision, atOne.revision, 'the snapshot names the authoritative revision');
  assert.deepEqual(snapshot.snapshot, atOne, 'the recovered snapshot is byte-equal to the independent oracle');
  assert.equal(snapshot.snapshot.revision, 1, 'the recovered view really is at revision 1');
  assert.deepEqual(snapshot.snapshot.state.moves, atOne.state.moves, 'the recovered state carries the missed move exactly once');
  assert.ok(Number.isSafeInteger(snapshot.server_now) && snapshot.server_now > 0, 'the recovery snapshot carries the authority clock');

  /* The resume subscribed the fresh socket (membership proven from match.participants). */
  assert.equal(s.transport.stats().subscriptions, 1, 'the resumed connection is subscribed once');

  await closeAll([back]);
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the recovered client closed cleanly');
});

/* ================================================ 3. corrupt / future ack ===== */

test('V5-08-04 recovery: a future ack_revision is corrected with the full current snapshot, never trusted', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08r-ahead';
  const [playerA] = FIXTURES.ahead;
  const committed = await playMatch(h, matchId, ...FIXTURES.ahead, { move: true });
  assert.equal(committed.revision, 1, 'the fixture match is at revision 1');

  const client = await connect(h, s, playerA, matchId);
  /* A corrupted / rolled-forward client claims a revision the authority has never reached. */
  client.send(resumeFrame(matchId, 99));
  const frame = await client.next();
  assert.equal(frame.operation, 'snapshot', 'a client ahead of the authority is corrected with a snapshot, not an ack or a delta');
  assert.equal(frame.protocol, PROTOCOL);
  assert.equal(frame.match_id, matchId);
  assert.equal(frame.expected_revision, committed.revision, 'the correction names the TRUE durable revision, not the client claim');
  assert.deepEqual(frame.snapshot, committed, 'the corrected snapshot is byte-equal to the independent oracle');
  assert.equal(frame.snapshot.revision, 1, 'the corrected view is at the real revision, not 99');

  /* No delta is computed against an impossible window. */
  assert.equal(await client.idle(400), true, 'no delta is sent for an out-of-order ack_revision');

  await closeAll([client]);
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the corrected client closed cleanly');
});

/* ========================================================= 4. HTTP fallback ==== */

test('V5-08-04 recovery: the HTTP snapshot fallback returns the authoritative durable match view as JSON', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08r-http';
  const [playerA, playerB] = FIXTURES.http;
  const committed = await playMatch(h, matchId, playerA, playerB, { move: true });
  assert.equal(committed.revision, 1, 'the HTTP fixture match is at revision 1');

  const query = `match_id=${encodeURIComponent(matchId)}&actor=${encodeURIComponent(playerA)}`;
  const authA = s.authorization(playerA);

  /* A client-chosen actor query without a verified session is NOT a credential. */
  const forged = await httpGet(s.port, `${SNAPSHOT_PATH}?${query}`);
  assert.equal(forged.status, 401, 'query-only actor impersonation cannot read the match');
  const wrongBearer = await httpGet(s.port, `${SNAPSHOT_PATH}?${query}`, 'Bearer forged');
  assert.equal(wrongBearer.status, 401);
  const wrongActor = await httpGet(s.port,
    `${SNAPSHOT_PATH}?match_id=${encodeURIComponent(matchId)}&actor=${encodeURIComponent(playerB)}`, authA);
  assert.equal(wrongActor.status, 403, 'a valid Alice credential cannot borrow Bob query identity');

  /* Historical ?actor= is only a compatibility assertion; actual identity is
   * the authenticated host principal. */
  const primary = await httpGet(s.port, `${SNAPSHOT_PATH}?${query}`, authA);
  assert.equal(primary.status, 200, 'the snapshot route answers 200');
  assert.match(String(primary.headers['content-type'] || ''), /application\/json/, 'the fallback is served as application/json');
  assert.deepEqual(viewOf(primary.json), committed, 'the HTTP snapshot is byte-equal to the independent oracle');

  /* The match-addressed alias: GET /realtime/v1/match/:id?actor=.. */
  const alias = await httpGet(s.port, `${MATCH_PREFIX}${matchId}?actor=${encodeURIComponent(playerA)}`, authA);
  assert.equal(alias.status, 200, 'the /realtime/v1/match/:id alias answers 200');
  assert.match(String(alias.headers['content-type'] || ''), /application\/json/, 'the alias is served as application/json');
  assert.deepEqual(viewOf(alias.json), committed, 'the alias returns the same durable view');

  /* The fallback reads the SAME authority the socket serves: it tracks the committed revision. */
  await h.core.run({ actor: committed.symbols.O, scope: 'player' },
    `move:${matchId}:2`, { type: 'move', id: matchId, revision: committed.revision, move: { b: 0, c: 1 } });
  const advanced = await oracle(h, playerA, matchId);
  assert.equal(advanced.revision, 2, 'a second real move committed revision 2');
  const after = await httpGet(s.port, `${SNAPSHOT_PATH}?${query}`, authA);
  assert.equal(after.status, 200, 'the fallback still answers after a further commit');
  assert.deepEqual(viewOf(after.json), advanced, 'the fallback returns the CURRENT durable view, not a cached one');

  /* A non-participant asking for the same match is refused (never served the state), and the test's
   * own unrelated routes are untouched by the fallback. */
  const foreign = await httpGet(s.port,
    `${SNAPSHOT_PATH}?match_id=${encodeURIComponent(matchId)}&actor=${encodeURIComponent('svc_p08r00')}`,
    s.authorization('svc_p08r00'));
  assert.notEqual(foreign.status, 200, 'a non-participant is not served the match state');
  const unrelated = await httpGet(s.port, '/healthz');
  assert.equal(unrelated.status, 404, 'the fallback does not claim unrelated paths');
});

/* ============================================================= 5. teardown ===== */

test('V5-08-04 recovery: closing a recovered socket and the transport releases every route and listener', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08r-teardown';
  const [playerA] = FIXTURES.teardown;
  const view = await playMatch(h, matchId, ...FIXTURES.teardown);
  const client = await connect(h, s, playerA, matchId);
  client.send(resumeFrame(matchId, view.revision));
  assert.deepEqual(await client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: view.revision });
  assert.equal(s.transport.stats().connections, 1, 'one recovered socket is tracked');
  assert.equal(await until(async () => (await routeKeys(h.ephemera)).length > 0), true, 'the resumed connection registered an advisory route record');

  await closeAll([client]);
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'closing the client left no tracked connection');
  assert.deepEqual({
    connections: s.transport.stats().connections, authenticated: s.transport.stats().authenticated, subscriptions: s.transport.stats().subscriptions,
  }, { connections: 0, authenticated: 0, subscriptions: 0 }, 'no residual connection state survives the socket');

  /* close() is the ONE drain path, idempotent, and it releases routes and its upgrade listener so
   * the owning server can close naturally. */
  await s.transport.close();
  await s.transport.close();
  assert.equal(await until(async () => (await routeKeys(h.ephemera)).length === 0), true, 'every advisory route record is released');
  assert.equal(s.server.listenerCount('upgrade'), 0, 'the transport removed its upgrade listener');
  assert.equal(s.transport.stats().closed, true, 'the transport reports itself closed');
  await s.close();
  assert.deepEqual(await routeKeys(h.ephemera), [], 'no route key survives this suite\'s own namespace');
});

/* ------------------------------------------------ shared-session teardown ----- */

test.after(async () => {
  if (!sessionPromise) return;
  const h = await sessionPromise.catch(() => null);
  if (!h) return;
  try { await h.ephemera.wipeNamespace(); } catch { /* only this suite's namespace */ }
  try { await h.ephemera.close(); } catch { /* best effort */ }
  try { h.issuer.close(); } catch { /* best effort */ }
  try { h.core.close(); } catch { /* best effort */ }
});
