'use strict';
/* tests/v5-p08-transport.test.js - V5 P08 task V5-08-01 authenticated WSS transport.
 *
 * SCOPE. Exercises `createRealtimeTransport` (packages/services/realtime-transport.js) against a REAL
 * owned PostgreSQL 16 lab (tests/v5-pg-lab.js: the checksummed migration chain, guarded role pools,
 * synthetic actors), the REAL one-use ticket issuer/redeemer (packages/services/tickets.js), the REAL
 * Core service (packages/services/core.js) and the REAL loopback Redis ephemera adapter
 * (packages/services/ephemera.js). No mocks, no stub server, no copied protocol logic: every
 * assertion reads a real socket, a real PostgreSQL row, a real Redis key or a real service response.
 *
 * WHAT THIS PROVES (V5-08-01: expose staging realtime through nonconflicting ingress, redeem one-use
 * tickets, enforce subscription membership, message bounds and safe errors):
 *
 *   1. HANDSHAKE + NONCONFLICTING INGRESS. A raw RFC 6455 client gets exactly one 101 with the
 *      computed `Sec-WebSocket-Accept` (including the RFC 6455 §1.3 canonical vector);
 *      `/realtime/v1?x=1` and `/realtime/v1/` address the same ingress; an ordinary HTTP request is
 *      served by the normal request handler; a co-hosted upgrade listener keeps every other path it
 *      answers; when NO listener owns an upgrade path the transport drains the peer with a 404
 *      instead of hanging it; and an addressed-but-invalid handshake is a 400.
 *   2. UNAUTHORIZED SUBSCRIPTION. `subscribe` before any redemption is refused `AUTH_REQUIRED` and
 *      the socket stays OPEN (the caller may still redeem).
 *   3. EXPIRED TICKET. A ticket redeemed past its TTL is refused `TICKET_EXPIRED`, the connection is
 *      closed 1008, and the durable row stays UNREDEEMED.
 *   4. REPLAYED TICKET. A second redemption of a spent ticket is refused `TICKET_REDEEMED`, the
 *      connection is closed 1008, and exactly one durable redemption exists.
 *   5. MESSAGE BOUNDS + PROTOCOL FAULTS. A frame declaring > 8192 bytes is closed 1009 immediately
 *      (before the payload is buffered) with no partial parse; an unmasked client frame, a reserved
 *      bit, a non-minimal length and a fragmented control frame are protocol errors 1002; `ping`
 *      is answered `pong`. Each fault leaves ZERO tracked connections.
 *   6. CROSS-ACTOR SUBSCRIPTION. Alice, authenticated for her own scope, cannot subscribe to a match
 *      she is not seated in (`NOT_PARTICIPANT`), cannot widen a scoped ticket to another match
 *      (`FORBIDDEN`), and gets `UNKNOWN_MATCH` for a match that does not exist - all as bare
 *      `PUBLIC_CODES` with no leaked internal code.
 *   7. VALID FLOW. A valid ticket is redeemed (`ack`), the participant subscribes and receives the
 *      committed snapshot whose `expected_revision` equals the durable `view.revision` - byte-equal
 *      to an independent `core.readMatch` oracle - and the advisory Redis route record is written.
 *   8. LIFECYCLE / NO LEAKS. `close()` drains every socket (1000), removes the upgrade listener,
 *      releases the Redis route records, is idempotent, and leaves the server closeable; an
 *      unauthenticated socket that never redeems is closed `AUTH_REQUIRED` at the auth deadline.
 *
 * GATING (the repo convention): these need BOTH the owned loopback Redis (`REDIS_URL`, or
 * `V5_REDIS_REQUIRED=1` to fail instead of skip) and the owned PostgreSQL lab (`V5_PG_URL`, or
 * `V5_PG_REQUIRED=1`). Absent either, the suite skips. Teardown is the lab's `installCleanup`
 * (guarded pools closed, owned databases dropped) plus a per-test wipe of this suite's OWN ephemera
 * `keyVersion` namespace - never another environment's, never a sibling's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createTicketIssuer } = require('../packages/services/tickets.js');
const { MAX_ENVELOPE_BYTES, PUBLIC_CODES } = require('../packages/contracts/realtime.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_REDIS && HAVE_PG ? false : (!HAVE_REDIS ? 'no REDIS_URL' : 'no V5_PG_URL');

const KEY_VERSION = 'rtp08';
const INGRESS = '/realtime/v1';
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SEEDS = ['svc_alice', 'svc_bob', 'svc_carol', 'svc_dave']
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
      const database = await lab.createDatabase('p08rt');
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

/* The mutable authority clock: the issuer stamps `expires_at` from it and the transport redeems with
 * it, so ticket expiry is decided by real elapsed milliseconds, not by a sleep. It only ever moves
 * FORWARD (a backward step would un-expire a durable ticket), and advancing past the 10 s TTL retires
 * the tickets of earlier tests so the per-actor outstanding/live admission caps stay deterministic. */
let clock = lab.CLOCK;
const tick = (ms) => { clock += ms; };

/* The REAL route keys this suite's adapter writes; read through the same borrowed adapter the
 * transport uses. The namespace is this suite's own (`mx:test:rtp08:route:*`). */
const routeKeys = (ephemera) => ephemera.client.keys(`mx:test:${KEY_VERSION}:route:*`);

/* Core commits a real PLAYING direct match for the pair, then (optionally) one real move so the
 * durable revision is non-zero. Every value is derived from the frozen domain, never re-typed. */
async function playMatch(h, id, playerA, playerB, { move = false } = {}) {
  const offer = await h.core.run({ actor: playerA, scope: 'player' }, `offer:${id}`, {
    type: 'offer', id, opponent: playerB, terms: { kind: 'leaderboard', amount: 40 },
  });
  assert.equal(offer.status, 'OFFERED', 'the fixture offer is committed OFFERED');
  let view = await h.core.run({ actor: playerB, scope: 'player' }, `accept:${id}`, {
    type: 'accept', id, termsHash: offer.termsHash,
  });
  assert.equal(view.status, 'PLAYING', 'the fixture match is committed PLAYING');
  if (move) {
    const mover = view.symbols.X;
    view = await h.core.run({ actor: mover, scope: 'player' }, `move:${id}:1`, {
      type: 'move', id, revision: view.revision, move: { b: 0, c: 0 },
    });
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

const binding = (extra = {}) => ({
  actor: 'svc_alice', sessionId: 'a'.repeat(24), generation: 1,
  connectionClass: 'game', matchScope: null, ipHash: null, ...extra,
});
/* The independent Core oracle for a match DTO: no transport is involved. */
const oracle = (h, actor, matchId) => h.core.readMatch(actor, matchId);

/* ------------------------------------------------------------- test harness -- */

/* A dedicated HTTP server + attached transport per test.
 *
 * `coHosted` (default true) registers an ordinary second upgrade listener on a path the transport
 * does NOT own; the transport must leave that listener's socket alone and it answers for itself.
 * `coHosted:false` registers no such listener, so a non-ingress upgrade reaches NO writer at all -
 * the transport must then drain that socket itself (404 + close) rather than leave the peer hanging. */
async function serve(h, t, { authTimeoutMs, coHosted = true } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404); res.end('nope');
  });
  if (coHosted) {
    /* Node calls EVERY 'upgrade' listener for every upgrade, so a co-hosted listener must leave the
     * ingress the realtime transport owns alone. This replicates the transport's own path rule and
     * answers every OTHER path, proving the two coexist without interference. */
    const ownsIngress = (url) => {
      const cut = String(url).split('?')[0].split('#')[0];
      const path = cut.length > 1 && cut.endsWith('/') ? cut.slice(0, -1) : cut;
      return path === INGRESS;
    };
    server.on('upgrade', (req, socket) => {
      if (ownsIngress(req.url)) return;
      seen.push(req.url);
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    });
  }
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const create = loadTransportFactory();
  const transport = create({
    server, pool: h.pools.core, core: h.core, ephemera: h.ephemera, now: () => clock,
    ...(authTimeoutMs === undefined ? {} : { authTimeoutMs }),
  });
  assert.equal(transport.ingressPath, INGRESS, 'the transport answers exactly the staged ingress');

  const close = async () => {
    try { await transport.close(); } catch { /* best effort */ }
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { server, transport, port, seen, close, url: (path) => `ws://127.0.0.1:${port}${path}` };
}

/* ---------------------------------------------------- RFC 6455 raw client ---- */

/* A client frame is ALWAYS masked (RFC 6455 §5.1); the test can deliberately violate that.
 * `declared16` forces the 16-bit length form with an explicit value - the only way to build the
 * non-minimal encoding the parser must refuse. */
function clientFrame(opcode, payload, { fin = true, mask = true, reserved = 0, declared16 } = {}) {
  const body = Buffer.from(payload);
  const length = body.length;
  let header;
  if (declared16 !== undefined) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(declared16, 2); }
  else if (length < 126) { header = Buffer.allocUnsafe(2); header[1] = length; }
  else if (length < 65536) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.allocUnsafe(10); header[1] = 127; header.writeUInt32BE(Math.floor(length / 4294967296), 2); header.writeUInt32BE(length >>> 0, 6); }
  header[0] = (fin ? 0x80 : 0) | (reserved & 0x70) | opcode;
  if (!mask) return Buffer.concat([header, body]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ key[i & 3];
  header[1] |= 0x80;
  return Buffer.concat([header, key, masked]);
}
const clientKey = () => Buffer.from(crypto.randomBytes(16)).toString('base64');
/* A server frame is never masked; its payload is returned verbatim. */
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
    state.frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, masked: (second & 0x80) !== 0, payload });
    while (state.waiters.length && state.frames.length) state.waiters.shift()(state.frames.shift());
  }
}
function rawClient(port) {
  const socket = net.connect(port, '127.0.0.1');
  const state = { buffer: Buffer.alloc(0), head: null, frames: [], waiters: [], ended: null, endWaiters: [] };
  socket.on('error', () => { /* an abrupt destroy is an expected fault path */ });
  socket.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (state.head === null) {
      const idx = state.buffer.indexOf('\r\n\r\n');
      if (idx !== -1) { state.head = state.buffer.subarray(0, idx + 4).toString('latin1'); state.buffer = state.buffer.subarray(idx + 4); }
    }
    if (state.head !== null) decodeServerFrames(state);
  });
  const finish = () => {
    state.ended = { closeCode: null };
    const close = state.frames.find((f) => f.opcode === 0x8);
    if (close && close.payload.length >= 2) state.ended.closeCode = close.payload.readUInt16BE(0);
    while (state.endWaiters.length) state.endWaiters.shift()(state.ended);
  };
  socket.on('close', finish);
  const timebox = (promise, label) => Promise.race([
    promise,
    sleep(6000).then(() => { throw new Error(`raw client timeout: ${label}`); }),
  ]);
  return {
    socket,
    handshake: async ({ path = INGRESS, version = '13', key = clientKey(), upgrade = 'websocket' } = {}) => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade'];
      if (upgrade) lines.push(`Upgrade: ${upgrade}`);
      lines.push(`Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: ${version}`, '', '');
      socket.write(lines.join('\r\n'));
      await timebox(new Promise((resolve) => {
        const poll = () => (state.head !== null ? resolve() : setTimeout(poll, 10));
        poll();
      }), 'head');
      return { key, head: state.head };
    },
    write: (bytes) => socket.write(bytes),
    frame: () => timebox(new Promise((resolve) => {
      if (state.frames.length) return resolve(state.frames.shift());
      state.waiters.push(resolve);
    }), 'frame'),
    end: () => timebox(new Promise((resolve) => {
      if (state.ended) return resolve(state.ended);
      state.endWaiters.push(resolve);
    }), 'end'),
    destroy: () => socket.destroy(),
  };
}
const statusLine = (head) => head.split('\r\n')[0];
const headerValue = (head, name) => {
  const line = head.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line === undefined ? null : line.slice(line.indexOf(':') + 1).trim();
};

/* -------------------------------------------------------- browser-grade client - */

/* The Node global `WebSocket` (RFC 6455 conformant) drives the authenticated scenarios: a real
 * handshake, real masked frames and a real close event, with no test-owned framing. */
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
    closed: () => closeInfo,
    waitClose: () => timebox(new Promise((resolve) => {
      if (closeInfo) return resolve(closeInfo);
      closeWaiters.push(resolve);
    }), 'close'),
  };
}
const redeemFrame = (ticket) => ({ protocol: 'realtime/v1', operation: 'ticket.redeem', ticket });
const subscribeFrame = (matchId) => ({ protocol: 'realtime/v1', operation: 'subscribe', match_id: matchId });

/* ================================================================ 1. handshake */

test('V5-08-01 transport: RFC 6455 handshake on the staged ingress with every other route untouched', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  /* ADDRESSED: a valid WS upgrade gets exactly one 101 and the computed accept header. */
  const client = rawClient(s.port);
  const { key, head } = await client.handshake();
  assert.equal(statusLine(head), 'HTTP/1.1 101 Switching Protocols');
  assert.equal(headerValue(head, 'Upgrade').toLowerCase(), 'websocket');
  assert.equal(headerValue(head, 'Connection').toLowerCase(), 'upgrade');
  const expected = crypto.createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
  assert.equal(headerValue(head, 'Sec-WebSocket-Accept'), expected, 'the accept digest is sha1(key + the RFC 6455 GUID)');
  assert.equal(headerValue(head, 'Sec-WebSocket-Protocol'), null, 'no subprotocol is echoed');
  assert.equal(s.seen.length, 0, 'the addressed upgrade never reached another listener');
  client.destroy();

  /* CANONICAL VECTOR: the RFC 6455 §1.3 sample key has a known accept digest. */
  const sample = rawClient(s.port);
  const vector = await sample.handshake({ key: 'dGhlIHNhbXBsZSBub25jZQ==' });
  assert.equal(headerValue(vector.head, 'Sec-WebSocket-Accept'), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'the RFC 6455 sample handshake is reproduced exactly');
  sample.destroy();

  /* TOLERATED VARIANTS: a query string and one trailing slash address the SAME ingress. */
  for (const path of [`${INGRESS}?token=redacted`, `${INGRESS}/`]) {
    const variant = rawClient(s.port);
    const opened = await variant.handshake({ path });
    assert.equal(statusLine(opened.head), 'HTTP/1.1 101 Switching Protocols', `${path} reaches the ingress`);
    variant.destroy();
  }

  /* NONCONFLICTING (a co-hosted listener exists): the transport must leave the other listener's
   * socket alone; that listener answers for itself. */
  for (const path of ['/realtime/v10', '/other']) {
    const foreign = rawClient(s.port);
    const rejected = await foreign.handshake({ path });
    assert.equal(statusLine(rejected.head), 'HTTP/1.1 401 Unauthorized', `${path} is answered by the co-hosted listener, not the transport`);
    foreign.destroy();
  }
  assert.deepEqual(s.seen, ['/realtime/v10', '/other'], 'every unrelated upgrade reached the co-hosted listener unchanged');

  /* NONCONFLICTING (NO other listener): an upgrade to a path nobody owns must not hang the peer - the
   * transport drains it with a 404 and a close rather than leaving an open half-socket. */
  const bare = await serve(h, t, { coHosted: false });
  for (const path of ['/realtime/v10', '/other']) {
    const unowned = rawClient(bare.port);
    const drained = await unowned.handshake({ path });
    assert.equal(statusLine(drained.head), 'HTTP/1.1 404 Not Found', `${path} with no other listener is drained by the transport`);
    unowned.destroy();
  }
  assert.equal(await until(() => bare.transport.stats().connections === 0), true, 'the transport claimed no connection for an unowned path');
  await bare.close();

  /* ...and an ordinary HTTP request is served by the normal request handler. */
  const health = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/healthz' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.deepEqual(health, { status: 200, body: 'ok' }, 'an ordinary HTTP route is untouched by the WS ingress');

  /* ADDRESSED BUT INVALID: the transport owns the path, so a bad handshake is a 400 with the version. */
  const bad = rawClient(s.port);
  const refused = await bad.handshake({ version: '8' });
  assert.equal(statusLine(refused.head), 'HTTP/1.1 400 Bad Request', 'a stale WS version is refused, not ignored');
  assert.equal(headerValue(refused.head, 'Sec-WebSocket-Version'), '13', 'the refusal advertises the supported version');
  bad.destroy();

  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'a handshake-only connection leaves nothing tracked once destroyed');
});

/* ==================================================== 2. unauthorized subscription */

test('V5-08-01 transport: subscribe before redemption is refused AUTH_REQUIRED and the socket stays open', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const client = wsClient(s.url(INGRESS));
  await client.open();
  client.send(subscribeFrame('match:p08-unauth'));
  const error = await client.next();
  assert.deepEqual(error, { protocol: 'realtime/v1', operation: 'error', code: 'AUTH_REQUIRED' }, 'the refusal is a bare public code');
  assert.ok(PUBLIC_CODES.includes(error.code), 'AUTH_REQUIRED is a contract code');
  assert.equal(client.closed(), null, 'the unauthenticated socket is NOT closed (the caller may still redeem)');
  assert.equal(s.transport.stats().connections, 1, 'the socket is still tracked');
  assert.equal(s.transport.stats().authenticated, 0, 'it is not authenticated');

  client.ws.close(1000);
  await client.waitClose();
});

/* ============================================================ 3. expired ticket */

test('V5-08-01 transport: an expired ticket is refused TICKET_EXPIRED, closed, and never redeemed', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);
  /* `issue` first retires every ticket earlier tests left open, then mints on the forward clock. */
  const { ticket } = await issue(h, binding({ matchScope: null }));
  /* Redeem past the 10 s durable TTL: real millisecond arithmetic on the stored row, not a sleep. */
  const expiredAt = clock + 20000;
  tick(20000);

  const client = wsClient(s.url(INGRESS));
  await client.open();
  client.send(redeemFrame(ticket));
  const error = await client.next();
  assert.deepEqual(error, { protocol: 'realtime/v1', operation: 'error', code: 'TICKET_EXPIRED' });
  const closed = await client.waitClose();
  assert.equal(closed.code, 1008, 'an authorization refusal is a policy close');

  const hash = crypto.createHash('sha256').update(ticket).digest('hex');
  assert.equal(await lab.scalar(h.database, 'SELECT redeemed_at IS NULL FROM identity.realtime_tickets WHERE ticket_hash = $1', [hash]), true,
    'an expired ticket is NOT consumed by the failed redemption');
  assert.equal(await lab.scalar(h.database, 'SELECT expires_at <= $2 FROM identity.realtime_tickets WHERE ticket_hash = $1', [hash, new Date(expiredAt).toISOString()]), true,
    'the durable row really was expired at redemption time');
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the refused connection is torn down');
});

/* =========================================================== 4. replayed ticket */

test('V5-08-01 transport: a replayed ticket is refused TICKET_REDEEMED and only one redemption exists', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const { ticket } = await issue(h, binding({ matchScope: null }));
  const hash = crypto.createHash('sha256').update(ticket).digest('hex');

  const first = wsClient(s.url(INGRESS));
  await first.open();
  first.send(redeemFrame(ticket));
  assert.deepEqual(await first.next(), { protocol: 'realtime/v1', operation: 'ack', match_id: 'auth', ack_revision: 0 },
    'the first redemption acks; an unscoped ticket acks the auth scope');
  assert.equal(await lab.scalar(h.database, 'SELECT count(*)::int FROM identity.realtime_tickets WHERE ticket_hash = $1 AND redeemed_at IS NOT NULL', [hash]), 1);
  first.ws.close(1000);
  await first.waitClose();

  const second = wsClient(s.url(INGRESS));
  await second.open();
  second.send(redeemFrame(ticket));
  assert.deepEqual(await second.next(), { protocol: 'realtime/v1', operation: 'error', code: 'TICKET_REDEEMED' });
  assert.equal((await second.waitClose()).code, 1008, 'a spent ticket closes the connection');
  assert.equal(await lab.scalar(h.database, 'SELECT count(*)::int FROM identity.realtime_tickets WHERE ticket_hash = $1 AND redeemed_at IS NOT NULL', [hash]), 1,
    'the replayed redemption commits nothing: single-use is durable');
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the replayed connection is torn down');
});

/* ========================================================== 5. bounds + faults */

test('V5-08-01 transport: oversize frames are closed 1009 and protocol faults 1002 without leaking connections', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  /* BOUNDS CAN ONLY TIGHTEN. A caller may never raise the frozen envelope or auth-timeout ceiling. */
  const build = (options) => loadTransportFactory()({ server: s.server, pool: h.pools.core, core: h.core, ...options });
  assert.throws(() => build({ maxEnvelopeBytes: MAX_ENVELOPE_BYTES + 1 }), /MAX_ENVELOPE_BYTES_INVALID/, 'the envelope bound cannot be loosened');
  assert.throws(() => build({ authTimeoutMs: 60001 }), /AUTH_TIMEOUT_INVALID/, 'the auth deadline cannot be loosened past its ceiling');

  /* OVERSIZE REPEATED: a frame declaring more than the frozen envelope bound is refused before it is
   * buffered, and each rejected socket leaves the registry - so a hostile client cannot accrete
   * retained buffers or tracked connections (the bounded-state proof for the memory-leak criterion). */
  for (let round = 0; round < 8; round += 1) {
    const big = rawClient(s.port);
    await big.handshake();
    big.write(clientFrame(0x1, Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x61)));
    assert.equal((await big.end()).closeCode, 1009, 'a > 8192-byte message closes 1009 (Message Too Big)');
    assert.equal(await until(() => s.transport.stats().connections === 0), true, `round ${round}: the oversized connection is dropped, not retained`);
  }

  /* OVERSIZE ON A FRAGMENTED MESSAGE: the ACCUMULATED size is what is bounded. */
  const frag = rawClient(s.port);
  await frag.handshake();
  frag.write(clientFrame(0x1, Buffer.alloc(5000, 0x62), { fin: false }));
  frag.write(clientFrame(0x0, Buffer.alloc(5000, 0x63), { fin: true }));
  assert.equal((await frag.end()).closeCode, 1009, 'the summed fragments exceed the bound');

  /* PROTOCOL FAULTS: every one is 1002 and none is answered with application data. */
  const faults = [
    ['an unmasked client frame', clientFrame(0x1, Buffer.from('{}'), { mask: false })],
    ['a reserved bit', clientFrame(0x1, Buffer.from('{}'), { reserved: 0x40 })],
    ['a non-minimal 126 length', clientFrame(0x1, Buffer.from('{}'), { declared16: 2 })],
    ['a fragmented control frame', clientFrame(0x9, Buffer.from('hi'), { fin: false })],
    ['a continuation with no message', clientFrame(0x0, Buffer.from('x'))],
  ];
  for (const [label, bytes] of faults) {
    const faulty = rawClient(s.port);
    await faulty.handshake();
    faulty.write(bytes);
    assert.equal((await faulty.end()).closeCode, 1002, `${label} is a protocol error 1002`);
  }
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'no faulted socket is left tracked');

  /* KEEPALIVE: a masked ping is answered with a pong echoing the payload, not an error. */
  const alive = rawClient(s.port);
  await alive.handshake();
  alive.write(clientFrame(0x9, Buffer.from('p08')));
  const pong = await alive.frame();
  assert.equal(pong.opcode, 0xa, 'ping is answered with pong');
  assert.equal(pong.payload.toString('utf8'), 'p08', 'the pong echoes the ping payload');
  assert.equal(pong.masked, false, 'a server frame is never masked (RFC 6455 §5.1)');
  alive.destroy();
});

/* ==================================================== 6. cross-actor subscription */

test('V5-08-01 transport: cross-actor and out-of-scope subscriptions are refused with bare public codes', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  /* A real match Alice is NOT seated in (Bob and Dave). */
  await playMatch(h, 'match:p08-notpart', 'svc_bob', 'svc_dave');

  /* NOT_PARTICIPANT: authenticated as Alice, subscribing to a match she is not in. */
  const aliceTicket = (await issue(h, binding({ matchScope: null }))).ticket;
  const alice = wsClient(s.url(INGRESS));
  await alice.open();
  alice.send(redeemFrame(aliceTicket));
  assert.deepEqual(await alice.next(), { protocol: 'realtime/v1', operation: 'ack', match_id: 'auth', ack_revision: 0 });
  alice.send(subscribeFrame('match:p08-notpart'));
  assert.deepEqual(await alice.next(), { protocol: 'realtime/v1', operation: 'error', code: 'NOT_PARTICIPANT' },
    'membership is enforced from match.participants for the redeemed actor');
  assert.equal(alice.closed(), null, 'a denied subscription does not close the authenticated socket');

  /* UNKNOWN_MATCH: a match row that does not exist is distinguished from a missing seat. */
  alice.send(subscribeFrame('match:p08-absent'));
  assert.deepEqual(await alice.next(), { protocol: 'realtime/v1', operation: 'error', code: 'UNKNOWN_MATCH' });

  /* FORBIDDEN: a ticket scoped to one match can never be widened to another, before any DB read. */
  const scoped = (await issue(h, binding({ matchScope: 'match-1' }))).ticket;
  const wide = wsClient(s.url(INGRESS));
  await wide.open();
  wide.send(redeemFrame(scoped));
  assert.deepEqual(await wide.next(), { protocol: 'realtime/v1', operation: 'ack', match_id: 'match-1', ack_revision: 0 },
    'a scoped ticket acks its own scope');
  wide.send(subscribeFrame('match-2'));
  assert.deepEqual(await wide.next(), { protocol: 'realtime/v1', operation: 'error', code: 'FORBIDDEN' });

  /* NO RE-BIND: a redeemed connection cannot be re-pointed by a second ticket. */
  const rebind = (await issue(h, binding({ matchScope: null }))).ticket;
  wide.send(redeemFrame(rebind));
  assert.deepEqual(await wide.next(), { protocol: 'realtime/v1', operation: 'error', code: 'INVALID_OPERATION' },
    'an authenticated socket refuses a second ticket.redeem');

  /* No internal code ever crosses the wire: every observed error code is a PUBLIC_CODES member. */
  for (const code of ['NOT_PARTICIPANT', 'UNKNOWN_MATCH', 'FORBIDDEN']) {
    assert.ok(PUBLIC_CODES.includes(code), `${code} is a contract code`);
  }
  assert.equal(s.transport.stats().authenticated, 2, 'both authenticated sockets are tracked');
  alice.ws.close(1000); wide.ws.close(1000);
  await Promise.all([alice.waitClose(), wide.waitClose()]);
});

/* ================================================================ 7. valid flow */

test('V5-08-01 transport: a valid ticket acks and the participant receives the committed snapshot', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08-valid';
  const committed = await playMatch(h, matchId, 'svc_alice', 'svc_carol', { move: true });
  const expectedView = await oracle(h, 'svc_alice', matchId);
  assert.equal(expectedView.revision, 1, 'the oracle sees the committed revision');

  const { ticket } = await issue(h, binding({ actor: 'svc_alice', matchScope: matchId }));
  const client = wsClient(s.url(INGRESS));
  await client.open();
  client.send(redeemFrame(ticket));
  assert.deepEqual(await client.next(), { protocol: 'realtime/v1', operation: 'ack', match_id: matchId, ack_revision: 0 },
    'the redeemed grant binds the connection to its actor and match scope');

  client.send(subscribeFrame(matchId));
  const snapshot = await client.next();
  assert.equal(snapshot.protocol, 'realtime/v1');
  assert.equal(snapshot.operation, 'snapshot');
  assert.equal(snapshot.match_id, matchId);
  assert.equal(snapshot.expected_revision, committed.revision, 'the snapshot names the committed revision');
  assert.deepEqual(snapshot.snapshot, expectedView, 'the snapshot is byte-equal to an independent Core read');
  assert.equal(snapshot.snapshot.revision, 1, 'the revision reached the client');
  assert.deepEqual(snapshot.snapshot.state.moves, [{ b: 0, c: 0, player: 'X' }],
    'the committed move reached the client under the first-mover symbol');

  /* The advisory Redis route record is written for the subscription (and is never authorization). */
  const routed = await until(async () => (await routeKeys(h.ephemera)).length > 0);
  assert.equal(routed, true, 'the connection registered an advisory route record in Redis');
  assert.equal(s.transport.stats().subscriptions, 1, 'the connection is subscribed to exactly one match');

  client.ws.close(1000);
  await client.waitClose();
});

/* ================================================= malformed envelopes / errors */

test('V5-08-01 transport: malformed envelopes are refused with bare public codes and the socket stays open', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t, { authTimeoutMs: 3000 });

  /* MALFORMED JSON: a bare public code, and the socket is still usable afterwards. */
  const client = wsClient(s.url(INGRESS));
  await client.open();
  client.ws.send('{not json');
  assert.deepEqual(await client.next(), { protocol: 'realtime/v1', operation: 'error', code: 'INVALID_ENVELOPE' });
  /* A shape that is valid JSON but not a valid envelope is the same code (never a leaked one). */
  client.send({ protocol: 'realtime/v1', operation: 'subscribe' });
  assert.deepEqual(await client.next(), { protocol: 'realtime/v1', operation: 'error', code: 'INVALID_ENVELOPE' });
  /* An operation outside the frozen set is INVALID_OPERATION. */
  client.send({ protocol: 'realtime/v1', operation: 'nope' });
  assert.deepEqual(await client.next(), { protocol: 'realtime/v1', operation: 'error', code: 'INVALID_OPERATION' });
  assert.equal(client.closed(), null, 'an invalid envelope never closes the socket');
  client.ws.close(1000);
  await client.waitClose();
});

test('V5-08-01 transport: an unauthenticated socket that never redeems is closed AUTH_REQUIRED at the deadline', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t, { authTimeoutMs: 80 });
  const idle = wsClient(s.url(INGRESS));
  await idle.open();
  assert.deepEqual(await idle.next(), { protocol: 'realtime/v1', operation: 'error', code: 'AUTH_REQUIRED' }, 'the deadline sends the refusal');
  assert.equal((await idle.waitClose()).code, 1008, 'then the idle socket is closed');
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the auth timer left nothing tracked');
});

/* ================================================================ 8. teardown */

test('V5-08-01 transport: close() drains every socket, releases Redis routes and leaves no listener or timer', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const ticket = (await issue(h, binding({ matchScope: null }))).ticket;
  const authed = wsClient(s.url(INGRESS));
  const idle = wsClient(s.url(INGRESS));
  const idle2 = wsClient(s.url(INGRESS));
  await Promise.all([authed.open(), idle.open(), idle2.open()]);
  authed.send(redeemFrame(ticket));
  await authed.next();
  assert.equal(s.transport.stats().connections, 3, 'three live sockets are tracked');
  assert.equal(s.transport.stats().authenticated, 1, 'exactly one is authenticated');
  assert.equal(await until(async () => (await routeKeys(h.ephemera)).length > 0), true, 'the authenticated connection registered a Redis route record');

  /* close() is the ONE drain path: every socket gets a normal close and the registry empties. */
  await s.transport.close();
  const closes = await Promise.all([authed.waitClose(), idle.waitClose(), idle2.waitClose()]);
  for (const closed of closes) assert.equal(closed.code, 1000, 'close() sends a normal close (1000)');
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'close() empties the live registry');
  assert.deepEqual(s.transport.stats(), {
    connections: 0, authenticated: 0, subscriptions: 0,
    maxEnvelopeBytes: MAX_ENVELOPE_BYTES, authTimeoutMs: 10000, closed: true,
  }, 'close() leaves the transport closed with no residual state');

  /* The advisory Redis route records are released, and the upgrade listener is removed. */
  assert.equal(await until(async () => (await routeKeys(h.ephemera)).length === 0), true, 'every Redis route record is deleted');
  assert.equal(s.server.listenerCount('upgrade'), 1, 'only the server\'s own upgrade listener remains');

  /* Idempotent, and the owning server can then close: no socket, timer or listener is left. */
  await s.transport.close();
  s.server.closeAllConnections();
  await new Promise((resolve, reject) => s.server.close((error) => (error ? reject(error) : resolve())));
  assert.equal(s.transport.stats().closed, true);

  /* The suite's own namespace is empty, so nothing this test wrote outlives it. */
  assert.deepEqual(await routeKeys(h.ephemera), [], 'no route key survives the suite\'s own namespace');
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
