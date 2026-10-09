'use strict';
/* tests/v5-p08-restart-recovery.test.js - V5 P08 task V5-08-05 remove memory-authoritative restart
 * recovery; add drain, slow-client handling and multi-process routing.
 *
 * SCOPE. Exercises `packages/services/realtime-transport.js` (`createRealtimeTransport`) against a REAL
 * owned PostgreSQL 16 lab (`tests/v5-pg-lab.js`: the checksummed migration chain, guarded role pools,
 * synthetic actors), the REAL Core service (`packages/services/core.js`) and the REAL loopback Redis
 * ephemera adapter (`packages/services/ephemera.js`). No mocks, no stub core, no fake socket: every
 * assertion reads a real committed `match.matches`/`match.move_outcomes`/`economy.command_outcomes`/
 * `ops.outbox` row, a real socket frame or a real Redis subscription. `core.readMatch` is the
 * INDEPENDENT oracle for the committed view on every recovery path.
 *
 * WHAT THIS SUITE PROVES (the parent ticket's six cases; G08: acknowledged moves survive process
 * death and resume from a surviving process, with no reset deadline, duplicate effect or split match):
 *
 *   1. RESTART NEVER VOIDS AN ACTIVE MATCH. A PLAYING direct match committed at revision 1 with a
 *      live deadline and escrow survives a Core shutdown; a BRAND-NEW Core service over the same
 *      database (and a fresh transport serving a fresh client) loads it with status PLAYING, the same
 *      revision, the same absolute deadline and the same escrow, and the raw durable row is
 *      byte-identical. No row is ever written to VOID - the V4 startup void loop is gone.
 *   2. KILL CORE BEFORE COMMIT. A forced mid-transaction abort (the P06/P04 rollback-gate precedent)
 *      rolls the whole move command back: revision unchanged, state_json unchanged, no move outcome,
 *      no operation outcome and no outbox event. The surviving/new Core resumes the match at the
 *      PREVIOUS revision and the identical `operation_id` then commits exactly once.
 *   3. KILL CORE AFTER COMMIT, BEFORE RESPONSE. A move commits durably and then the owning Core dies
 *      before the client sees the result. A surviving Core receives the SAME `operation_id` retry and
 *      returns the PRIOR result idempotently: revision stays N+1, the move outcome / operation outcome
 *      / outbox event each exist exactly once and the stored response is unchanged.
 *   4. SLOW-CLIENT BACKPRESSURE. A client that stops reading lets the transport's outbound buffer
 *      exceed the bounded `maxBufferBytes`; the transport closes that socket with RFC 6455 policy code
 *      1008 instead of buffering unbounded frames. The client reconnects, `resume`s the match and
 *      recovers the latest committed state as an authoritative snapshot.
 *   5. MULTI-PROCESS ROUTING. Core A commits a move; a client subscribed on a DIFFERENT transport
 *      ("Core B") receives the updated committed snapshot driven only by the Redis `core-match` hint
 *      (B re-reads PostgreSQL; it never trusts the hint). Killing Core A (beginDrain/close) leaves Core
 *      B's client connected and still receiving subsequent commits.
 *   6. GRACEFUL DRAIN + CLEAN TEARDOWN. `beginDrain()` stops accepting new upgrades, answers every
 *      live socket with a normal 1000 close, releases the transport's OWN `core-match` subscription and
 *      removes its listeners; `close()` is idempotent and empties the registry. `lab.installCleanup`
 *      drops the guarded pools and owned databases and every service closes naturally - no force-exit.
 *
 * BOUNDS CONTRACT. `maxBufferBytes` is a bounded option exactly like `maxEnvelopeBytes`: a caller may
 * tighten it below `DEFAULT_MAX_BUFFER_BYTES` (65536) but never raise it above it.
 *
 * GATING (the repo convention): needs BOTH the owned loopback Redis (`REDIS_URL`, or
 * `V5_REDIS_REQUIRED=1` to fail instead of skip) and the owned PostgreSQL lab (`V5_PG_URL`, or
 * `V5_PG_REQUIRED=1` to fail instead of skip). Absent either, the whole suite skips. Teardown is the
 * lab's `installCleanup` (guarded pools closed, owned databases dropped) plus a per-suite wipe of this
 * suite's OWN ephemera `keyVersion` namespace - never another environment's, never a sibling's.
 *
 * CLOCK AND ADMISSION. Every actor in this file is used by exactly ONE test and receives at most two
 * one-use tickets, so the per-actor admission caps (outstanding 3 / live 4) are never approached and
 * no clock advance is needed to retire an earlier ticket. The authority clock therefore stays at the
 * lab's frozen CLOCK: the issuer stamps `expires_at` and the transport redeems at the same instant,
 * and a fixture match's 30 s turn deadline never elapses while a test runs. Nothing here waits on wall
 * time for correctness - the one bounded wait is for the CPU-bound slow-client flood (case 4) and the
 * assertion it guards is the real RFC 6455 close code, never the wait itself.
 *
 *   env V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
 *       REDIS_URL=redis://127.0.0.1:50710 \
 *       node --test --test-concurrency=1 tests/v5-p08-restart-recovery.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createTicketIssuer } = require('../packages/services/tickets.js');
const { PROTOCOL, PUBLIC_CODES } = require('../packages/contracts/realtime.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_REDIS && HAVE_PG ? false : (!HAVE_REDIS ? 'no REDIS_URL' : 'no V5_PG_URL');

const KEY_VERSION = 'rtp08s';
const INGRESS = '/realtime/v1';
/* The ONE match-change channel Core publishes to and every Core subscribes to (packages/services/core.js
 * `MATCH_CHANNEL`). Re-declared here as the frozen wire fact the multi-process case depends on. */
const MATCH_CHANNEL = 'core-match';
/* The RFC 6455 close code this transport sends when a peer cannot keep up (CLOSE_POLICY). */
const CLOSE_POLICY = 1008;
/* One disjoint actor pair per case, so no two cases contend for the same rated-pair limits or the
 * per-actor ticket admission budget. */
const FIXTURES = Object.freeze({
  restart: ['svc_p08s01', 'svc_p08s02'],
  before: ['svc_p08s03', 'svc_p08s04'],
  after: ['svc_p08s05', 'svc_p08s06'],
  slow: ['svc_p08s07', 'svc_p08s08'],
  routing: ['svc_p08s09', 'svc_p08s10'],
  teardown: ['svc_p08s11', 'svc_p08s12'],
});
const SEEDS = Object.values(FIXTURES).flat()
  .map((actor) => ({ actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* A bounded poll for a fire-and-forget side effect (an advisory Redis subscription/route record, the
 * drain of the connection registry). Never a poll for wall-clock correctness. */
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
 * skips (rather than throws at require time) when the gates are unset. The bound itself is part of the
 * contract, so it is read from the module rather than re-typed. */
let transportModule = null;
const loadTransport = () => {
  if (!transportModule) {
    transportModule = require('../packages/services/realtime-transport.js');
    assert.equal(typeof transportModule.createRealtimeTransport, 'function', 'packages/services/realtime-transport.js must export createRealtimeTransport');
    assert.equal(typeof transportModule.DEFAULT_MAX_BUFFER_BYTES, 'number', 'the slow-client bound must be exported as DEFAULT_MAX_BUFFER_BYTES');
  }
  return transportModule;
};

const ephemeraOptions = () => ({
  url: REDIS_URL,
  environment: 'test',
  keyVersion: KEY_VERSION,
  allowPlaintext: !REDIS_URL.startsWith('rediss://'),
  socket: { connectTimeout: 3000 },
});

/* One owned database / pool set / Core / issuer / Redis adapter for the whole file: every test is an
 * isolated socket scenario against the SAME durable authority, exactly as a running deployment is. */
let sessionPromise = null;
async function session(t) {
  if (!(await lab.boot(t))) return null;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const database = await lab.createDatabase('p08restart');
      await lab.seedActors(database, SEEDS);
      const pools = lab.poolsFor(database);
      /* The session-level Core publishes NO hints (no ephemera adapter): a test that needs the
       * `core-match` fan-out constructs its OWN hint-publishing Core through `coreFor`. */
      const core = await lab.coreFor(database);
      const issuer = await createTicketIssuer(pools.api, { now: () => clock, environment: 'stg', audience: 'mega-core' });
      const ephemera = await createEphemeraService(ephemeraOptions());
      assert.equal(await ephemera.healthy(), true, 'the owned Redis must answer PING');
      return { database, pools, core, issuer, ephemera };
    })();
  }
  return sessionPromise;
}

/* The authority clock stays at the lab's frozen CLOCK: disjoint actors keep the ticket admission caps
 * away, and a 30 s turn deadline never elapses while a test runs. */
const clock = lab.CLOCK;

/* A NEW Core service over the shared pool - exactly a restarted process as far as durable truth is
 * concerned. With `ephemera` it also publishes `core-match` hints after a commit (the multi-process
 * producer); without it, it is a quiet reader. The service is caller-owned and closed in `t.after`. */
async function coreFor(h, t, { ephemera = null } = {}) {
  const core = await lab.coreFor(h.database, { clock: () => clock, ...(ephemera ? { ephemera } : {}) });
  t.after(() => { try { core.close(); } catch { /* service-owned teardown */ } });
  return core;
}

/* Issue one one-use ticket for a match scope (or unscoped when matchScope is null). */
const binding = (extra = {}) => ({
  actor: FIXTURES.restart[0], sessionId: 'a'.repeat(24), generation: 1,
  connectionClass: 'game', matchScope: null, ipHash: null, ...extra,
});
const issue = (h, request) => h.issuer.issue(request);

/* The independent Core oracle for a match DTO: no transport is involved. */
const oracle = (core, actor, matchId) => core.readMatch(actor, matchId);

/* Core commits a real PLAYING direct match for the pair, then (optionally) one real move so the
 * durable revision is non-zero. The returned DTO is ALWAYS a `core.readMatch` document. */
async function playMatch(core, id, playerA, playerB, { move = false } = {}) {
  const offer = await core.run({ actor: playerA, scope: 'player' }, `offer:${id}`, {
    type: 'offer', id, opponent: playerB, terms: { kind: 'leaderboard', amount: 40 },
  });
  assert.equal(offer.status, 'OFFERED', 'the fixture offer is committed OFFERED');
  const accepted = await core.run({ actor: playerB, scope: 'player' }, `accept:${id}`, {
    type: 'accept', id, termsHash: offer.termsHash,
  });
  assert.equal(accepted.status, 'PLAYING', 'the fixture match is committed PLAYING');
  let view = await core.readMatch(playerA, id);
  assert.equal(view.revision, 0, 'the fixture match is committed at revision 0');
  if (move) {
    const mover = view.symbols.X;
    await core.run({ actor: mover, scope: 'player' }, `move:${id}:1`, {
      type: 'move', id, revision: view.revision, move: { b: 0, c: 0 },
    });
    view = await core.readMatch(playerA, id);
    assert.equal(view.revision, 1, 'the fixture move commits revision 1');
  }
  return view;
}

/* ------------------------------------------------------------- test harness -- */

/* A dedicated HTTP server with ONE transport attached. The transport, the server, the pool and the
 * services stay caller-owned; `close` drains the transport's sockets and then closes the server
 * naturally (no `process.exit`). */
async function serve(h, t, { core = h.core, ephemera = h.ephemera } = {}) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const transport = loadTransport().createRealtimeTransport({
    server, pool: h.pools.core, core, ephemera, now: () => clock,
  });
  assert.equal(transport.ingressPath, INGRESS, 'the transport answers exactly the staged ingress');
  /* The transport opens its OWN `core-match` subscription in the constructor; awaiting `ready` makes
   * the multi-process hint channel deterministic (it resolves `false` when hints are off). */
  assert.ok(transport.ready && typeof transport.ready.then === 'function', 'the transport exposes a `ready` promise for its hint channel');
  const ready = await transport.ready;

  const close = async () => {
    try { await transport.close(); } catch { /* best effort */ }
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { server, transport, port, ready, close, url: (path) => `ws://127.0.0.1:${port}${path}` };
}

/* -------------------------------------------------------- browser-grade client - */

/* The Node global `WebSocket` (RFC 6455 conformant) drives the authenticated scenarios: a real
 * handshake, real masked frames and a real close event, with no test-owned framing. `idle(ms)` proves
 * a frame did NOT arrive (and keeps it queued if it did, so nothing is silently swallowed). */
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
const commandMove = (matchId, key, revision, move) => ({
  protocol: PROTOCOL, operation: 'command', operation_id: key, match_id: matchId, expected_revision: revision,
  command: { type: 'move', move },
});

/* Redeem one one-use ticket scoped to the match, then (by default) subscribe: the returned snapshot is
 * the committed document the subscription answered with. */
async function connect(h, s, actor, matchId, { subscribe = true } = {}) {
  const { ticket } = await issue(h, binding({ actor, sessionId: `${actor}:${matchId}`, matchScope: matchId }));
  const client = wsClient(s.url(INGRESS));
  await client.open();
  client.send(redeemFrame(ticket));
  assert.deepEqual(await client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 0 },
    'the redeemed ticket binds the connection to its actor and match scope');
  if (!subscribe) return { client, snapshot: null };
  client.send(subscribeFrame(matchId));
  const snapshot = await client.next();
  assert.equal(snapshot.operation, 'snapshot', 'the subscription answers with the committed snapshot');
  assert.equal(snapshot.match_id, matchId);
  return { client, snapshot };
}

/* Redeem an UNSCOPED ticket (so the ack names the `auth` scope) and leave the connection
 * UNSUBSCRIBED: `resume` must then prove membership itself. Returns the client and its auth ack. */
async function connectUnscoped(h, s, actor, sessionId) {
  const { ticket } = await issue(h, binding({ actor, sessionId, matchScope: null }));
  const client = wsClient(s.url(INGRESS));
  await client.open();
  client.send(redeemFrame(ticket));
  const ack = await client.next();
  assert.deepEqual(ack, { protocol: PROTOCOL, operation: 'ack', match_id: 'auth', ack_revision: 0 },
    'an unscoped ticket acks the auth scope');
  return client;
}

const closeAll = async (clients) => {
  for (const client of clients) { try { client.ws.close(1000); } catch { /* already gone */ } }
  await Promise.allSettled(clients.map((client) => client.waitClose()));
};

/* ---------------------------------------------------- RFC 6455 raw client ---- */

/* A client data frame is ALWAYS masked (RFC 6455 §5.1). Only the frames this suite needs are built:
 * an authenticated TEXT envelope and a control PING with a payload. */
function clientFrame(opcode, payload) {
  const body = Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) { header = Buffer.allocUnsafe(2); header[1] = length; }
  else if (length < 65536) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.allocUnsafe(10); header[1] = 127; header.writeUInt32BE(Math.floor(length / 4294967296), 2); header.writeUInt32BE(length >>> 0, 6); }
  header[0] = 0x80 | opcode;
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = body[i] ^ key[i & 3];
  header[1] |= 0x80;
  return Buffer.concat([header, key, masked]);
}
const clientKey = () => Buffer.from(crypto.randomBytes(16)).toString('base64');
/* A server frame is never masked; its payload is returned verbatim. The decoder buffers every frame
 * it completes so the close code can be read once the socket goes away. */
function decodeServerFrames(state) {
  for (;;) {
    if (state.buffer.length < 2) return;
    const first = state.buffer[0];
    const second = state.buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) { if (state.buffer.length < 4) return; length = state.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (state.buffer.length < 10) return; length = Number(state.buffer.readBigUInt64BE(2)); offset = 10; }
    if (state.buffer.length < offset + length) return;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    state.buffer = state.buffer.subarray(offset + length);
    state.frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
  }
}
/* A raw net client that can pause reading (to stall its socket and let the server's outbound buffer
 * fill) and resume. `end()` resolves on the socket's own close and reports the close code a server
 * close frame carried, if one was delivered. */
function rawClient(port) {
  const socket = net.connect(port, '127.0.0.1');
  const state = { buffer: Buffer.alloc(0), head: null, frames: [], ended: null, endWaiters: [] };
  socket.on('error', () => { /* an abrupt destroy is an expected path */ });
  socket.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (state.head === null) {
      const idx = state.buffer.indexOf('\r\n\r\n');
      if (idx !== -1) { state.head = state.buffer.subarray(0, idx + 4).toString('latin1'); state.buffer = state.buffer.subarray(idx + 4); }
    }
    if (state.head !== null) decodeServerFrames(state);
  });
  const finish = () => {
    state.ended = { closeCode: null, bytesReceived: 0 };
    const close = state.frames.find((f) => f.opcode === 0x8);
    if (close && close.payload.length >= 2) state.ended.closeCode = close.payload.readUInt16BE(0);
    for (const frame of state.frames) state.ended.bytesReceived += frame.payload.length;
    while (state.endWaiters.length) state.endWaiters.shift()(state.ended);
  };
  socket.on('close', finish);
  const timebox = (promise, label) => Promise.race([
    promise,
    sleep(8000).then(() => { throw new Error(`raw client timeout: ${label}`); }),
  ]);
  return {
    socket,
    text: (value) => socket.write(clientFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'))),
    ping: (payload) => socket.write(clientFrame(0x9, payload)),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    handshake: async () => {
      socket.write([`GET ${INGRESS} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade',
        'Upgrade: websocket', `Sec-WebSocket-Key: ${clientKey()}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
      await timebox(new Promise((resolve) => {
        const poll = () => (state.head !== null ? resolve() : setTimeout(poll, 5));
        poll();
      }), 'head');
      return state.head;
    },
    end: () => timebox(new Promise((resolve) => {
      if (state.ended) return resolve(state.ended);
      state.endWaiters.push(resolve);
    }), 'end'),
    destroy: () => socket.destroy(),
  };
}
/* A bounded, leak-free WS-upgrade probe for a DRAINING transport: it opens a raw socket, sends a real
 * upgrade request and resolves 'accepted' only if a 101 arrives, 'refused' if the peer is answered
 * anything else, 'closed' if the socket is drained, or 'timeout' if nothing happens. No polling loop,
 * so a draining ingress cannot keep the event loop alive. */
function upgradeProbe(port, ms = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), ms);
    socket.on('error', () => finish('closed'));
    socket.on('close', () => finish('closed'));
    socket.on('data', (chunk) => finish(/HTTP\/1\.1 101/.test(chunk.toString('latin1')) ? 'accepted' : 'refused'));
    socket.on('connect', () => {
      socket.write([`GET ${INGRESS} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade',
        'Upgrade: websocket', `Sec-WebSocket-Key: ${clientKey()}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
    });
  });
}

/* ------------------------------------------------------------- durable probes -- */

const scalar = (h, text, params = []) => lab.scalar(h.database, text, params);
const int = async (h, text, params = []) => Number(await scalar(h, text, params));
/* The WHOLE durable row as canonical JSON text: one comparison covers status, revision, state_json,
 * escrow, settled, deadline, receipt_* and every side column a restart must leave untouched. */
const rowOf = (h, matchId) => scalar(h, 'SELECT to_jsonb(m)::text FROM match.matches m WHERE match_id = $1', [matchId]);
const statusOf = (h, matchId) => scalar(h, 'SELECT status FROM match.matches WHERE match_id = $1', [matchId]);
const revisionOf = (h, matchId) => int(h, 'SELECT revision::int FROM match.matches WHERE match_id = $1', [matchId]);
const escrowOf = (h, matchId) => int(h, 'SELECT escrow::int FROM match.matches WHERE match_id = $1', [matchId]);
const deadlineOf = (h, matchId) => scalar(h,
  'SELECT (extract(epoch from deadline) * 1000)::bigint::text FROM match.matches WHERE match_id = $1', [matchId])
  .then((value) => (value === null ? null : Number(value)));
const voidCount = (h) => int(h, "SELECT count(*)::int FROM match.matches WHERE status = 'VOID'");
const moveOutcomes = (h, matchId) => int(h, 'SELECT count(*)::int FROM match.move_outcomes WHERE match_id = $1', [matchId]);
/* `economy.command_outcomes."key"` holds the CANONICAL JSON string of the operation key, so the lookup
 * compares against `to_json($2::text)::text` - the same encoding the outcome repository uses. */
const OUTCOME_KEY = '"key" = to_json($2::text)::text';
const outcomesOf = (h, actor, key) => int(h, `SELECT count(*)::int FROM economy.command_outcomes WHERE actor_id = $1 AND ${OUTCOME_KEY}`, [actor, key]);
const operationOf = (h, actor, key, column) => scalar(h, `SELECT ${column} FROM economy.command_outcomes WHERE actor_id = $1 AND ${OUTCOME_KEY}`, [actor, key]);
const outboxOf = (h, id) => int(h, 'SELECT count(*)::int FROM ops.outbox WHERE outbox_id = $1', [id]);
const outboxId = (actor, key) => `core.command:${actor}:${key}`;

/* ================================================ 1. restart never voids ===== */

test('V5-08-05 restart: a PLAYING match survives Core shutdown and a brand-new Core loads it unvoided', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;

  const matchId = 'match:p08s-restart';
  const [playerA, playerB] = FIXTURES.restart;
  /* The Core process that owns the match, with its realtime ingress. */
  const coreA = await coreFor(h, t);
  const serveA = await serve(h, t, { core: coreA });

  const committed = await playMatch(coreA, matchId, playerA, playerB, { move: true });
  assert.equal(committed.status, 'PLAYING', 'the fixture match is live');
  assert.equal(committed.revision, 1, 'the fixture match carries one committed move');
  assert.ok(Number.isSafeInteger(committed.deadline), 'a live match carries an absolute epoch-ms deadline');
  assert.ok(committed.escrow > 0, 'a LIVE match with a stake holds an escrow');

  const before = await rowOf(h, matchId);
  const deadline = await deadlineOf(h, matchId);
  const escrow = await escrowOf(h, matchId);
  assert.equal(deadline, committed.deadline, 'the durable column holds exactly the DTO deadline');
  assert.equal(escrow, committed.escrow, 'the durable column holds exactly the DTO escrow');
  const view = await oracle(coreA, playerA, matchId);
  assert.deepEqual(view, committed, 'the oracle agrees with the committed document before the restart');

  /* A client is live on this Core, then the Core is SHUT DOWN: the ingress drains and the process
   * (its Core service) goes away. Nothing in a durable authority is touched by a process dying. */
  const { client } = await connect(h, serveA, playerA, matchId);
  assert.equal(serveA.transport.stats().connections, 1, 'one live client is on the dying Core');
  await serveA.transport.close();
  assert.equal((await client.waitClose()).code, 1000, 'drain closes the live socket normally');
  assert.equal(await until(() => serveA.transport.stats().connections === 0), true, 'the dying Core drained its registry');
  assert.equal(serveA.transport.stats().closed, true, 'the dying Core reports itself closed');
  coreA.close();

  /* A BRAND-NEW Core process over the same database: the committed match must load ACTIVE - the V4
   * startup void loop is gone, so no row is ever rewritten to VOID and the live state stands. */
  const coreB = await coreFor(h, t);
  const reloaded = await oracle(coreB, playerA, matchId);
  assert.equal(reloaded.status, 'PLAYING', 'the restarted Core loads the match PLAYING, never voided');
  assert.equal(reloaded.settled, false, 'the restarted Core does not treat the live match as settled');
  assert.equal(reloaded.revision, 1, 'the revision survives the restart unchanged');
  assert.deepEqual(reloaded, view, 'the restarted Core loads the IDENTICAL committed document');
  assert.equal(await deadlineOf(h, matchId), deadline, 'the absolute deadline survives the restart unchanged');
  assert.equal(await escrowOf(h, matchId), escrow, 'the escrow survives the restart unchanged');
  assert.equal(await rowOf(h, matchId), before, 'no startup pass rewrote a single durable column');
  assert.equal(await voidCount(h), 0, 'nothing in the durable authority was ever voided by a restart');

  /* And a FRESH transport on the restarted Core serves the same live match to a fresh client: the new
   * process reads PostgreSQL and returns it, rather than waiting for a void-and-recreate. */
  const serveB = await serve(h, t, { core: coreB });
  const recovered = await connect(h, serveB, playerB, matchId);
  assert.equal(recovered.snapshot.operation, 'snapshot', 'the restarted Core answers a subscription with a snapshot');
  assert.equal(recovered.snapshot.expected_revision, 1, 'the fresh client is served the committed revision');
  assert.deepEqual(recovered.snapshot.snapshot, view, 'the served snapshot is byte-equal to the committed document');
  assert.equal(recovered.snapshot.snapshot.status, 'PLAYING', 'the fresh client is seated in a LIVE match, not a voided one');
  assert.equal(recovered.snapshot.snapshot.settled, false, 'and not a settled one');

  await closeAll([recovered.client]);
});

/* ========================================= 2. kill Core before commit ========= */

test('V5-08-05 restart: an aborted commit rolls back completely and the surviving Core resumes at the previous revision', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const matchId = 'match:p08s-before';
  const [playerA, playerB] = FIXTURES.before;
  const coreA = await coreFor(h, t);
  const serveA = await serve(h, t, { core: coreA });

  const created = await playMatch(coreA, matchId, playerA, playerB);
  assert.equal(created.revision, 0, 'the fixture match is committed at revision 0');
  const mover = created.symbols.X;
  const key = `move:${matchId}:1`;
  const { client } = await connect(h, serveA, mover, matchId);
  const before = await rowOf(h, matchId);

  /* A BEFORE UPDATE trigger FORCES the move's transaction to fail mid-commit - the exact reachable
   * crash point "Core dies before commit". The whole transaction (match row, move outcome, operation
   * outcome, outbox) must roll back: the transport never sees a revision it did not commit. */
  await lab.installSql(h.database, [
    `CREATE FUNCTION match.p08s_wall() RETURNS trigger LANGUAGE plpgsql AS $fn$
     BEGIN IF NEW.match_id = '${matchId}' THEN RAISE EXCEPTION 'P08S_FORCED_ROLLBACK'; END IF; RETURN NEW; END $fn$`,
    'CREATE TRIGGER p08s_wall_trg BEFORE INSERT OR UPDATE ON match.matches FOR EACH ROW EXECUTE FUNCTION match.p08s_wall()',
  ]);
  client.send(commandMove(matchId, key, 0, { b: 1, c: 1 }));
  const refusal = await client.next();
  assert.equal(refusal.operation, 'error', 'the aborted commit is answered an error, never an ack');
  assert.ok(PUBLIC_CODES.includes(refusal.code), 'the forced internal failure is normalized to a bare public code');
  assert.notEqual(refusal.code, 'P08S_FORCED_ROLLBACK', 'no internal SQL detail ever crosses the wire');
  assert.equal(refusal.match_id, matchId, 'the refusal names the match it refused');

  /* COMPLETE ROLLBACK: the durable row is byte-identical, and no dependent effect exists. */
  assert.equal(await rowOf(h, matchId), before, 'the aborted move left the committed row byte-identical');
  assert.equal(await statusOf(h, matchId), 'PLAYING', 'the match is still live');
  assert.equal(await revisionOf(h, matchId), 0, 'the revision never advanced past the aborted commit');
  assert.equal(await moveOutcomes(h, matchId), 0, 'no move outcome was written');
  assert.equal(await outcomesOf(h, mover, key), 0, 'no operation outcome was written');
  assert.equal(await outboxOf(h, outboxId(mover, key)), 0, 'no outbox event was enqueued');
  await lab.installSql(h.database, ['DROP TRIGGER IF EXISTS p08s_wall_trg ON match.matches', 'DROP FUNCTION IF EXISTS match.p08s_wall()']);

  /* SURVIVING / NEWLY BOOTED CORE resumes at the PREVIOUS revision: a fresh Core over the same
   * database, and a fresh client, both see revision 0 and the same live document. */
  coreA.close();
  await serveA.transport.close();
  const coreB = await coreFor(h, t);
  const resumed = await oracle(coreB, playerA, matchId);
  assert.equal(resumed.status, 'PLAYING', 'the surviving Core sees the still-live match');
  assert.equal(resumed.revision, 0, 'the surviving Core resumes at the previous revision N=0');
  assert.deepEqual(resumed, created, 'the surviving Core loads the identical pre-attempt document');

  /* The SAME operation identity then commits EXACTLY ONCE on the surviving Core: a crash before commit
   * loses the move, and the retry is the first and only commit. */
  const serveB = await serve(h, t, { core: coreB });
  const retry = await connect(h, serveB, mover, matchId);
  retry.client.send(commandMove(matchId, key, 0, { b: 1, c: 1 }));
  assert.deepEqual(await retry.client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 1 },
    'the retry commits and is acked with the durable revision');
  const broadcast = await retry.client.next();
  assert.equal(broadcast.operation, 'snapshot', 'the committed view is broadcast to the sender');
  assert.equal(broadcast.expected_revision, 1, 'the broadcast names the committed revision');
  assert.deepEqual(broadcast.snapshot, await oracle(coreB, playerA, matchId), 'the broadcast is byte-equal to the oracle');
  assert.equal(await revisionOf(h, matchId), 1, 'the retry advanced the revision exactly once');
  assert.equal(await moveOutcomes(h, matchId), 1, 'exactly one move outcome exists after the retry');
  assert.equal(await outcomesOf(h, mover, key), 1, 'exactly one operation outcome exists');
  assert.equal(await outboxOf(h, outboxId(mover, key)), 1, 'exactly one outbox event exists');

  await closeAll([client, retry.client]);
});

/* ========================================== 3. kill Core after commit ========= */

test('V5-08-05 restart: a move committed before the response is retried idempotently on a surviving Core', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const matchId = 'match:p08s-after';
  const [playerA, playerB] = FIXTURES.after;
  const coreA = await coreFor(h, t);
  const serveA = await serve(h, t, { core: coreA });

  const created = await playMatch(coreA, matchId, playerA, playerB);
  assert.equal(created.revision, 0, 'the fixture match is committed at revision 0');
  const mover = created.symbols.X;
  const key = `move:${matchId}:1`;
  const move = { b: 1, c: 1 };

  /* Core A commits the move through the durable boundary and then DIES before the client receives the
   * result ("after commit, before response"): the commit is real, the response is lost. The command
   * carries the SAME shape the transport stamps from the envelope (`key` included, so the operation
   * fingerprint matches the client's later retry exactly). */
  const committed = await coreA.run({ actor: mover, scope: 'player' }, key, { type: 'move', id: matchId, revision: 0, key, move });
  assert.equal(committed.revision, 1, 'the move committed revision 1 before the crash');
  const responseBefore = await operationOf(h, mover, key, 'response');
  assert.equal(await revisionOf(h, matchId), 1, 'the committed revision stands in PostgreSQL');
  coreA.close();
  await serveA.transport.close();

  /* A SURVIVING Core receives the client's retry with the SAME `operation_id`. The revision
   * transaction dedupes the operation BEFORE any stale-revision check, so the retry returns the PRIOR
   * result instead of STALE_REVISION and commits nothing new. */
  const coreB = await coreFor(h, t);
  const serveB = await serve(h, t, { core: coreB });
  const retry = await connect(h, serveB, mover, matchId);
  assert.equal(retry.snapshot.expected_revision, 1, 'the surviving Core served the committed revision on subscribe');
  retry.client.send(commandMove(matchId, key, 0, move));
  const ack = await retry.client.next();
  assert.deepEqual(ack, { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 1 },
    'the retry is acked with the PRIOR revision - never STALE_REVISION');
  const snapshot = await retry.client.next();
  assert.equal(snapshot.operation, 'snapshot', 'the retry broadcasts the prior committed snapshot');
  assert.equal(snapshot.expected_revision, 1, 'the broadcast names the committed revision');
  assert.deepEqual(snapshot.snapshot, await oracle(coreB, playerA, matchId), 'the broadcast is byte-equal to the oracle');
  assert.equal(await retry.client.idle(300), true, 'the retry emits no further frame');

  /* NO DUPLICATE EFFECT: one committed effect, one outcome, one outbox event, the stored response
   * unchanged - the acknowledged move survived the process death exactly once. */
  assert.equal(await revisionOf(h, matchId), 1, 'the retry did not advance the revision again');
  assert.equal(await moveOutcomes(h, matchId), 1, 'the retry wrote no second move outcome');
  assert.equal(await outcomesOf(h, mover, key), 1, 'the retry wrote no second operation outcome');
  assert.equal(await operationOf(h, mover, key, 'response'), responseBefore, 'the stored response is returned unchanged');
  assert.equal(await outboxOf(h, outboxId(mover, key)), 1, 'the retry enqueued no second outbox event');
  assert.equal(await statusOf(h, matchId), 'PLAYING', 'the match is still live after the crash and retry');

  await closeAll([retry.client]);
});

/* ========================================== 4. slow-client backpressure ====== */

test('V5-08-05 restart: a stalled client is closed 1008 and recovers the latest state by resume', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const matchId = 'match:p08s-slow';
  const [playerA, playerB] = FIXTURES.slow;
  const core = await coreFor(h, t);
  const s = await serve(h, t, { core });

  const created = await playMatch(core, matchId, playerA, playerB, { move: true });
  assert.equal(created.revision, 1, 'the fixture match carries one committed move to recover');

  /* The bound is a bounded option: a caller may tighten it but never raise it past the export. */
  assert.throws(() => loadTransport().createRealtimeTransport({
    server: s.server, pool: h.pools.core, core, ephemera: h.ephemera,
    maxBufferBytes: loadTransport().DEFAULT_MAX_BUFFER_BYTES + 1,
  }), /MAX_BUFFER_BYTES_INVALID/, 'the slow-client bound cannot be loosened');

  /* A real game client: handshake, redeem a ticket and subscribe, then STOP READING. Its socket is
   * paused, so every frame the transport writes is queued on the wire instead of consumed. */
  const slow = rawClient(s.port);
  const head = await slow.handshake();
  assert.equal(head.split('\r\n')[0], 'HTTP/1.1 101 Switching Protocols', 'the stalled client completed a real WS handshake');
  const { ticket } = await issue(h, binding({ actor: playerA, sessionId: `${playerA}:${matchId}`, matchScope: matchId }));
  slow.text(redeemFrame(ticket));
  slow.text(subscribeFrame(matchId));
  assert.equal(await until(() => s.transport.stats().connections === 1), true, 'the stalled client is tracked');
  slow.pause();

  /* Flood the slow client with keepalive pings whose pongs pile up: once the kernel send buffer is
   * full, `socket.bufferSize` exceeds `maxBufferBytes` and the transport must close it 1008 rather
   * than hold unbounded frames in memory. The flood is CPU-bound (no database work), so the trip
   * happens while the client is still paused. */
  const PINGS = 9000;
  const ping = clientFrame(0x9, Buffer.alloc(125, 0x70));
  slow.socket.write(Buffer.concat(Array.from({ length: PINGS }, () => ping)));

  /* Bounded wait for the transport to process the flood and trip the bound. The assertion that
   * matters is the close code below - if the bound were not enforced, no close frame would arrive
   * and `end()` would time out instead of passing. */
  await sleep(1500);
  slow.resume();
  const ended = await slow.end();
  assert.equal(ended.closeCode, CLOSE_POLICY, 'a stalled socket is closed with the policy code 1008');
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the closed slow socket left the registry');

  /* The client RECONNECTS and recovers the latest committed state through `resume`. The slow client
   * never applied the dropped frames, so it resumes from the revision it last held (0) and is served
   * the authoritative snapshot at the committed head. */
  const back = await connectUnscoped(h, s, playerA, `${playerA}:${matchId}:back`);
  back.send(resumeFrame(matchId, 0));
  const frames = [await back.next()];
  if (!(await back.idle(400))) frames.push(await back.next());
  const snapshot = frames.find((frame) => frame.operation === 'snapshot');
  assert.ok(snapshot, 'the recovered client is served a snapshot');
  assert.equal(snapshot.match_id, matchId, 'the snapshot names the match');
  assert.equal(snapshot.expected_revision, 1, 'the snapshot names the committed revision the client missed');
  assert.deepEqual(snapshot.snapshot, await oracle(core, playerA, matchId), 'the recovered snapshot is byte-equal to the oracle');
  assert.equal(snapshot.snapshot.revision, 1, 'the recovered view really is at the committed head');
  assert.equal(s.transport.stats().connections, 1, 'the reconnected client is tracked');

  await closeAll([back]);
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the recovered client closed cleanly');
});

/* ========================================== 5. multi-process routing ========== */

test('V5-08-05 restart: Core A commit routes to a Core B subscriber by Redis hint; Core A death leaves B unaffected', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const matchId = 'match:p08s-routing';
  const [playerA, playerB] = FIXTURES.routing;

  /* Two hint-publishing Core services over the SAME database - two Core processes - each with its own
   * transport. Only A will commit; B must learn of it solely through the `core-match` hint. */
  const coreA = await coreFor(h, t, { ephemera: h.ephemera });
  const coreB = await coreFor(h, t, { ephemera: h.ephemera });
  const serveA = await serve(h, t, { core: coreA });
  const serveB = await serve(h, t, { core: coreB });
  /* Both transports opened their OWN `core-match` subscription deterministically before committing,
   * so the hint cannot race the subscribe. */
  assert.equal(serveA.ready, true, 'Core A\'s transport is subscribed to the core-match channel');
  assert.equal(serveB.ready, true, 'Core B\'s transport is subscribed to the core-match channel');

  const created = await playMatch(coreA, matchId, playerA, playerB);
  assert.equal(created.revision, 0, 'the fixture match is committed at revision 0');
  const mover = created.symbols.X;
  const opponent = created.symbols.O;

  const seatA = await connect(h, serveA, mover, matchId);
  const seatB = await connect(h, serveB, opponent, matchId);
  assert.equal(seatB.snapshot.expected_revision, 0, 'Core B served the revision 0 snapshot to its client');

  /* CORE A COMMITS. Its own subscriber is acked and broadcast the committed view; CORE B's subscriber
   * must receive the SAME committed view driven ONLY by the Redis hint (B re-reads PostgreSQL). */
  const key = `move:${matchId}:1`;
  seatA.client.send(commandMove(matchId, key, 0, { b: 2, c: 2 }));
  assert.deepEqual(await seatA.client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 1 },
    'Core A acks its own sender with the committed revision');
  const committed = await oracle(coreB, playerA, matchId);
  assert.equal(committed.revision, 1, 'the move committed revision 1 in PostgreSQL');
  const onB = await seatB.client.next();
  assert.equal(onB.operation, 'snapshot', 'Core B broadcasts a snapshot from the hint');
  assert.equal(onB.match_id, matchId, 'the routed snapshot names the match');
  assert.equal(onB.expected_revision, 1, 'the routed snapshot names the committed revision');
  assert.deepEqual(onB.snapshot, committed, 'the routed snapshot is byte-equal to the committed document (PostgreSQL, not the hint)');
  /* The hint is not authority: a malformed/foreign channel message cannot fabricate a view, and B
   * delivered the REAL committed document above regardless. */
  assert.equal(MATCH_CHANNEL, 'core-match', 'the coordination channel is the frozen core-match channel');

  /* KILL CORE A (graceful drain). Core B's client must be UNAFFECTED: its socket stays open and it
   * still receives the NEXT commit, which Core B itself now performs. */
  const drained = await serveA.transport.beginDrain();
  assert.equal(drained.draining, true, 'beginDrain reports the drain');
  assert.equal(drained.connections, 1, 'beginDrain reported the one live socket it drained');
  assert.equal((await seatA.client.waitClose()).code, 1000, 'Core A drained its socket with a normal close');
  await serveA.transport.close();
  coreA.close();
  assert.equal(seatB.client.closed(), null, 'Core B\'s client is untouched by Core A\'s death');
  assert.equal(serveB.transport.stats().connections, 1, 'Core B still tracks its live client');

  /* Core B commits the next move: its own subscriber is acked and broadcast, and the client recovers
   * the new revision - the surviving process is fully functional. */
  const key2 = `move:${matchId}:2`;
  seatB.client.send(commandMove(matchId, key2, 1, { b: 2, c: 3 }));
  assert.deepEqual(await seatB.client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 2 },
    'Core B acks its sender with the new committed revision');
  const advanced = await oracle(coreB, playerA, matchId);
  assert.equal(advanced.revision, 2, 'the second move committed revision 2');
  const afterB = await seatB.client.next();
  assert.equal(afterB.operation, 'snapshot', 'Core B broadcasts the new committed view');
  assert.equal(afterB.expected_revision, 2, 'the broadcast names revision 2');
  assert.deepEqual(afterB.snapshot, advanced, 'the broadcast is byte-equal to the oracle');
  assert.equal(await revisionOf(h, matchId), 2, 'the surviving Core advanced the durable revision once more');

  await closeAll([seatB.client]);
});

/* ========================================== 6. graceful drain + teardown ====== */

test('V5-08-05 restart: beginDrain() refuses new sessions, drains live sockets 1000 and releases the core-match subscription', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const matchId = 'match:p08s-teardown';
  const [playerA] = FIXTURES.teardown;
  const core = await coreFor(h, t, { ephemera: h.ephemera });
  const s = await serve(h, t, { core });
  assert.equal(s.ready, true, 'the transport owns a ready core-match subscription');

  const view = await playMatch(core, matchId, ...FIXTURES.teardown);
  const { client } = await connect(h, s, playerA, matchId);
  assert.equal(s.transport.stats().connections, 1, 'one live socket is tracked');

  /* beginDrain(): no new upgrade is answered and every live socket is told to leave (1000). */
  const drained = await s.transport.beginDrain();
  assert.equal(drained.draining, true, 'beginDrain reports draining');
  assert.equal(drained.connections, 1, 'beginDrain reported the live socket count');
  assert.equal((await client.waitClose()).code, 1000, 'the live socket receives the normal 1000 close');
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the drained socket left the registry');

  /* A NEW session is refused: the ingress no longer accepts an upgrade (the peer is drained, not
   * hung), and the owned core-match subscription is released so no more hint work starts. */
  assert.equal(await upgradeProbe(s.port), 'refused', 'a draining transport answers an upgrade with a refusal, never a 101');
  assert.equal(await until(() => h.ephemera.subscriptions.size === 0), true, 'the owned core-match subscription was released');

  /* close() is idempotent and removes the transport's listeners so the owning server can close
   * naturally; the durable match is untouched. */
  await s.transport.close();
  await s.transport.close();
  assert.equal(s.transport.stats().closed, true, 'the transport reports itself closed');
  assert.equal(s.transport.stats().connections, 0, 'no connection survives close()');
  assert.equal(await statusOf(h, matchId), 'PLAYING', 'the drained Core never voided the live match');
  assert.equal(await revisionOf(h, matchId), view.revision, 'the durable revision is unchanged by the drain');

  await closeAll([client]);
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
