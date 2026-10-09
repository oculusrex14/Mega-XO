'use strict';
/* tests/v5-p08-commands.test.js - V5 P08 task V5-08-02 revision command transactions.
 *
 * SCOPE. Drives the `command` operation of `packages/services/realtime-transport.js`
 * (`createRealtimeTransport`) over REAL WebSocket connections against the REAL owned PostgreSQL 16
 * lab (`tests/v5-pg-lab.js`) and the REAL loopback Redis ephemera adapter
 * (`packages/services/ephemera.js`). Every command travels the SAME durable transaction boundary the
 * HTTP fallback uses (`core.run` in `packages/services/core.js`), so the wire assertions and the
 * durable probes together prove the parent contract:
 *
 *   {protocol:'realtime/v1', operation:'command', operation_id, match_id, expected_revision,
 *    command:{type:'move',move:{b,c}}|{type:'resign'}, [actor]}
 *
 * What the suite proves:
 *
 *   1. VALID MOVE. `ack` reaches the sender FIRST with `ack_revision` = the DURABLE committed revision
 *      read back from PostgreSQL (`core.readMatch` after the transaction committed), then the same
 *      committed view is broadcast as a `snapshot` to every socket subscribed to `match_id` - and to
 *      no socket subscribed to another match. The broadcast view is byte-equal to an independent Core
 *      read, one durable move outcome, one operation outcome and one `ops.outbox` event exist.
 *   2. LOST-RESPONSE RETRY. Re-sending the IDENTICAL envelope (same `operation_id`, same payload, same
 *      `expected_revision`) returns the PRIOR ack and the PRIOR snapshot with no STALE_REVISION and no
 *      new commit: the durable revision, the move outcome, the operation outcome fingerprint/response/
 *      committed_at, the outbox row and the committed state are all unchanged.
 *   3. ALTERED-PAYLOAD REUSE. A DIFFERENT payload under the same `operation_id` is
 *      `IDEMPOTENCY_CONFLICT` (never STALE_REVISION: the operation outcome is deduped BEFORE the
 *      stale-revision comparison), nothing is broadcast and the rollback is complete - state_json,
 *      revision, move outcomes, operation outcome and outbox are byte-identical to the committed
 *      pre-attempt truth.
 *   4. STALE REVISION. A NEW `operation_id` at a stale `expected_revision` is `STALE_REVISION`, writes
 *      nothing (no outcome row is left to poison the key) and broadcasts nothing; re-sending the SAME
 *      `operation_id` at the true revision then commits exactly once.
 *   5. TURN ORDER. A move from the player who is not to move is `NOT_YOUR_TURN`, with no revision,
 *      outcome or broadcast effect.
 *   6. ILLEGAL MOVE. An occupied cell is `INVALID_MOVE` (the engine's internal `ILLEGAL_MOVE`
 *      normalized to the contract code, answered in the command context); an out-of-range or
 *      non-integer coordinate or a `move` command with no coordinates is refused by the frozen
 *      envelope contract as a bare `INVALID_MOVE`; an unsupported command kind is `INVALID_COMMAND`.
 *      None commits or broadcasts.
 *   7. RESIGN. A resign settles the match: the sender is acked with the committed revision, every
 *      subscriber receives the terminal snapshot (status FINISHED, settled, receipt with reason
 *      `resign`, the surviving player as winner, the frozen quote payout/burn and the escrow fully
 *      released), one durable outbox event exists and a later move is `MATCH_CLOSED`.
 *   8. TEARDOWN. Closing the sockets empties the transport registry; `close()` is idempotent, releases
 *      every advisory Redis route record and removes its upgrade listener.
 *
 * CLOCK AND ADMISSION. Every actor in this file is used by exactly ONE test, so the per-actor ticket
 * admission caps (outstanding 3 / live 4) are never approached and no clock advance is needed to
 * retire an earlier ticket. The authority clock therefore stays at the lab's CLOCK: the issuer stamps
 * `expires_at` and the transport redeems against the same instant, and the turn deadline the fixture
 * match was accepted with has not elapsed when the commands below run. Nothing here waits on wall
 * time for correctness.
 *
 * GATING (the repo convention): these need BOTH the owned loopback Redis (`REDIS_URL`, or
 * `V5_REDIS_REQUIRED=1` to fail instead of skip) and the owned PostgreSQL lab (`V5_PG_URL`, or
 * `V5_PG_REQUIRED=1` to fail instead of skip). Absent either, the suite skips. Teardown is the lab's
 * `installCleanup` (guarded pools closed, owned databases dropped) plus a per-suite wipe of this
 * suite's OWN ephemera `keyVersion` namespace - never another environment's, never a sibling's.
 * Services close naturally; there is no force-exit.
 *
 *   env V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
 *       REDIS_URL=redis://127.0.0.1:50710 \
 *       node --test --test-concurrency=1 tests/v5-p08-commands.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createTicketIssuer } = require('../packages/services/tickets.js');
const { PROTOCOL, PUBLIC_CODES, MAX_ENVELOPE_BYTES } = require('../packages/contracts/realtime.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_REDIS && HAVE_PG ? false : (!HAVE_REDIS ? 'no REDIS_URL' : 'no V5_PG_URL');

const KEY_VERSION = 'rtp08c';
const INGRESS = '/realtime/v1';
/* One disjoint actor pair per test (and one extra pair for the unrelated subscription in test 1), so
 * no two tests contend for the same rated pair limits or ticket admission budget. */
const FIXTURES = Object.freeze({
  move: ['svc_p08c01', 'svc_p08c02'],
  other: ['svc_p08c03', 'svc_p08c04'],
  retry: ['svc_p08c05', 'svc_p08c06'],
  conflict: ['svc_p08c07', 'svc_p08c08'],
  stale: ['svc_p08c09', 'svc_p08c10'],
  turn: ['svc_p08c11', 'svc_p08c12'],
  illegal: ['svc_p08c13', 'svc_p08c14'],
  resign: ['svc_p08c15', 'svc_p08c16'],
  teardown: ['svc_p08c17', 'svc_p08c18'],
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
 * isolated socket scenario against the SAME durable authority, exactly as a running Core would be.
 * The authority clock is the lab's frozen CLOCK for every service, so what the transport redeems is
 * what the issuer stamped and the fixture match's deadline stays far in the future. */
const clock = lab.CLOCK;
let sessionPromise = null;
async function session(t) {
  if (!(await lab.boot(t))) return null;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const database = await lab.createDatabase('p08cmd');
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

/* The REAL route keys this suite's adapter writes; read through the same borrowed adapter the
 * transport uses. The namespace is this suite's own (`mx:test:rtp08c:route:*`). */
const routeKeys = (ephemera) => ephemera.client.keys(`mx:test:${KEY_VERSION}:route:*`);

/* Core commits a real PLAYING match for the pair, then (optionally) one real move so the durable
 * revision is non-zero. Every value is derived from the frozen domain, never re-typed. */
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
    const played = await h.core.run({ actor: mover, scope: 'player' }, `move:${id}:1`, {
      type: 'move', id, revision: view.revision, move: { b: 0, c: 0 },
    });
    assert.equal(played.revision, 1, 'the fixture move commits revision 1');
    /* The move response is the command result, not a match view: re-read the committed document so
     * this helper ALWAYS returns the same DTO shape `readMatch` produces. */
    view = await h.core.readMatch(playerA, id);
    assert.equal(view.revision, 1, 'the committed view carries the fixture move');
  }
  return view;
}

const binding = (extra = {}) => ({
  actor: 'svc_p08c01', sessionId: 'a'.repeat(24), generation: 1,
  connectionClass: 'game', matchScope: null, ipHash: null, ...extra,
});
/* The independent Core oracle for a match DTO: no transport is involved. */
const oracle = (h, actor, matchId) => h.core.readMatch(actor, matchId);

/* ------------------------------------------------------------- test harness -- */

/* A dedicated HTTP server with the transport attached to its 'upgrade' event. The transport, the
 * server, the pool and the services stay caller-owned; `close` drains sockets and then closes the
 * server naturally (no `process.exit`). */
async function serve(h, t) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const transport = loadTransportFactory()({
    server, pool: h.pools.core, core: h.core, ephemera: h.ephemera, now: () => clock,
  });
  assert.equal(transport.ingressPath, INGRESS, 'the transport answers exactly the staged ingress');

  const close = async () => {
    try { await transport.close(); } catch { /* best effort */ }
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { server, transport, port, close, url: (path) => `ws://127.0.0.1:${port}${path}` };
}

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
const commandMove = (matchId, key, revision, move) => ({
  protocol: PROTOCOL, operation: 'command', operation_id: key, match_id: matchId, expected_revision: revision,
  command: { type: 'move', move },
});
const commandResign = (matchId, key, revision) => ({
  protocol: PROTOCOL, operation: 'command', operation_id: key, match_id: matchId, expected_revision: revision,
  command: { type: 'resign' },
});

/* Redeem one one-use ticket scoped to the match, then (by default) subscribe: the returned snapshot
 * is the committed document the subscription answered with. */
async function connect(h, s, actor, matchId, { subscribe = true } = {}) {
  const { ticket } = await h.issuer.issue(binding({ actor, sessionId: `${actor}:${matchId}`, matchScope: matchId }));
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

const closeAll = async (clients) => {
  for (const client of clients) { try { client.ws.close(1000); } catch { /* already gone */ } }
  await Promise.allSettled(clients.map((client) => client.waitClose()));
};

/* ------------------------------------------------------------- durable probes -- */

/* Administrative reads through the connection that owns the database: `core_runtime` may read
 * match/economy truth, but only `outbox_id` of `ops.outbox` - so outbox truth is read here. */
const scalar = (h, text, params = []) => lab.scalar(h.database, text, params);
const int = async (h, text, params = []) => Number(await scalar(h, text, params));
const revisionOf = (h, matchId) => int(h, 'SELECT revision::int FROM match.matches WHERE match_id = $1', [matchId]);
const stateOf = (h, matchId) => scalar(h, 'SELECT state_json FROM match.matches WHERE match_id = $1', [matchId]);
const moveOutcomes = (h, matchId) => int(h, 'SELECT count(*)::int FROM match.move_outcomes WHERE match_id = $1', [matchId]);
/* `economy.command_outcomes."key"` holds the CANONICAL JSON string of the operation key (migration
 * 0034 re-encoded it), so the lookup compares against `to_json(text)::text` - the same encoding the
 * outcome repository writes and reads back through `keyIn`. */
const OUTCOME_KEY = '"key" = to_json($2::text)::text';
const outcomesOf = (h, actor, key) => int(h, `SELECT count(*)::int FROM economy.command_outcomes WHERE actor_id = $1 AND ${OUTCOME_KEY}`, [actor, key]);
const operationOf = (h, actor, key, column) => scalar(h, `SELECT ${column} FROM economy.command_outcomes WHERE actor_id = $1 AND ${OUTCOME_KEY}`, [actor, key]);
const outboxOf = (h, id) => int(h, 'SELECT count(*)::int FROM ops.outbox WHERE outbox_id = $1', [id]);

/* ======================================================= 1. valid move ========= */

test('V5-08-02 commands: a valid move acks the sender and broadcasts the committed snapshot to every subscriber', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-move';
  const otherMatch = 'match:p08c-other';
  const created = await playMatch(h, matchId, ...FIXTURES.move);
  assert.equal(created.revision, 0, 'the fixture match is committed at revision 0');
  const mover = created.symbols.X;
  const opponent = created.symbols.O;
  const move = { b: 1, c: 1 };
  const key = `move:${matchId}:1`;

  /* A second, unrelated match with its own subscribed socket: fan-out must reach this match's
   * subscribers and nobody else. */
  await playMatch(h, otherMatch, ...FIXTURES.other);
  const outsider = await connect(h, s, FIXTURES.other[0], otherMatch);
  const moverSeat = await connect(h, s, mover, matchId, { subscribe: false });
  const opponentSeat = await connect(h, s, opponent, matchId);

  /* AUTHORITY ORDER: without a subscription the command is refused before any transaction. */
  moverSeat.client.send(commandMove(matchId, key, 0, move));
  assert.deepEqual(await moverSeat.client.next(), {
    protocol: PROTOCOL, operation: 'error', code: 'NOT_PARTICIPANT', match_id: matchId, expected_revision: 0,
  }, 'an unsubscribed connection cannot command a match');

  /* A ticket scoped to one match can never be widened to another match, before any database read. */
  moverSeat.client.send(commandMove(otherMatch, key, 0, move));
  assert.deepEqual(await moverSeat.client.next(), {
    protocol: PROTOCOL, operation: 'error', code: 'FORBIDDEN', match_id: otherMatch, expected_revision: 0,
  }, 'the redeemed match scope bounds every command');
  assert.ok(PUBLIC_CODES.includes('NOT_PARTICIPANT') && PUBLIC_CODES.includes('FORBIDDEN'), 'both refusals are contract codes');

  moverSeat.client.send(subscribeFrame(matchId));
  const subscribed = await moverSeat.client.next();
  assert.equal(subscribed.operation, 'snapshot');
  assert.equal(subscribed.expected_revision, 0, 'the subscription names the committed revision');
  assert.equal(s.transport.stats().subscriptions, 3, 'three sockets are subscribed: two to this match, one to another');

  /* THE COMMAND: ack first (with the committed revision), then the broadcast to every subscriber. */
  moverSeat.client.send(commandMove(matchId, key, 0, move));
  assert.deepEqual(await moverSeat.client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 1 },
    'the sender is acknowledged FIRST with the durable committed revision');
  const [own, peer] = await Promise.all([moverSeat.client.next(), opponentSeat.client.next()]);
  const committed = await oracle(h, mover, matchId);
  for (const frame of [own, peer]) {
    assert.equal(frame.protocol, PROTOCOL);
    assert.equal(frame.operation, 'snapshot');
    assert.equal(frame.match_id, matchId);
    assert.equal(frame.expected_revision, 1, 'the broadcast names the committed revision');
    assert.deepEqual(frame.snapshot, committed, 'the broadcast is byte-equal to an independent Core read');
  }
  assert.equal(own.snapshot.revision, 1, 'the committed revision reached the client');
  assert.equal(own.snapshot.state.moves.length, 1, 'the committed move reached the board');
  const played = own.snapshot.state.moves[0];
  assert.deepEqual({ b: played.b, c: played.c }, move, 'the delivered move is the committed move');
  assert.equal(own.snapshot.symbols[played.player], mover, 'the played symbol belongs to the mover');
  assert.equal(own.snapshot.state.board[move.b][move.c], played.player, 'the board cell carries the mover symbol');
  assert.equal(await outsider.client.idle(300), true, 'a socket subscribed to another match receives no snapshot');
  assert.equal(await moverSeat.client.idle(300), true, 'the sender receives exactly one ack and one snapshot');

  /* DURABLE TRUTH: one move outcome, one operation outcome and one outbox event exist for the move. */
  assert.equal(await revisionOf(h, matchId), 1, 'the move committed durably');
  assert.equal(await moveOutcomes(h, matchId), 1, 'exactly one durable move outcome');
  assert.equal(await outcomesOf(h, mover, key), 1, 'exactly one durable operation outcome');
  assert.equal(await int(h, "SELECT count(*)::int FROM ops.outbox WHERE outbox_id = $1 AND kind = 'core.command' AND state = 'queued'",
    [`core.command:${mover}:${key}`]), 1, 'the committed move enqueued exactly one durable outbox event');

  await closeAll([moverSeat.client, opponentSeat.client, outsider.client]);
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'the closed sockets left the registry');
  await s.close();
});

/* ============================================ 2. lost-response retry =========== */

test('V5-08-02 commands: a lost-response retry returns the prior ack and commits nothing new', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-retry';
  const created = await playMatch(h, matchId, ...FIXTURES.retry);
  const mover = created.symbols.X;
  const opponent = created.symbols.O;
  const key = `move:${matchId}:1`;
  const move = { b: 2, c: 3 };
  const moverSeat = await connect(h, s, mover, matchId);
  const opponentSeat = await connect(h, s, opponent, matchId);

  moverSeat.client.send(commandMove(matchId, key, 0, move));
  const firstAck = await moverSeat.client.next();
  assert.deepEqual(firstAck, { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 1 });
  const firstOwn = await moverSeat.client.next();
  const firstPeer = await opponentSeat.client.next();
  assert.equal(firstOwn.operation, 'snapshot');
  assert.equal(firstPeer.operation, 'snapshot');

  const committedAt = await operationOf(h, mover, key, 'committed_at');
  const response = await operationOf(h, mover, key, 'response');
  const before = await stateOf(h, matchId);

  /* THE LOST-RESPONSE RETRY: the byte-identical envelope is resent (as a client that never saw the
   * ack would). The operation outcome is deduped BEFORE any revision comparison, so no
   * STALE_REVISION may be produced and no second effect may commit. */
  moverSeat.client.send(commandMove(matchId, key, 0, move));
  assert.deepEqual(await moverSeat.client.next(), firstAck, 'the retry is acked with the PRIOR revision - never STALE_REVISION');
  assert.deepEqual(await moverSeat.client.next(), firstOwn, 'the retry broadcasts the prior committed snapshot');
  assert.deepEqual(await opponentSeat.client.next(), firstPeer, 'the peer sees the same prior committed snapshot');
  assert.equal(await moverSeat.client.idle(300), true, 'the retry emits no further frame');
  assert.equal(await opponentSeat.client.idle(300), true, 'the retry emits no error frame to the peer');

  assert.equal(await revisionOf(h, matchId), 1, 'the retry left the revision at 1');
  assert.deepEqual(await stateOf(h, matchId), before, 'the retry changed no committed state');
  assert.equal(await moveOutcomes(h, matchId), 1, 'the retry inserted no second move outcome');
  assert.equal(await outcomesOf(h, mover, key), 1, 'the retry inserted no second operation outcome');
  assert.deepEqual(await operationOf(h, mover, key, 'committed_at'), committedAt, 'the retry did not recommit the prior outcome');
  assert.deepEqual(await operationOf(h, mover, key, 'response'), response, 'the retry returned the stored response unchanged');
  assert.equal(await outboxOf(h, `core.command:${mover}:${key}`), 1, 'the retry enqueued no second outbox event');

  await closeAll([moverSeat.client, opponentSeat.client]);
  await s.close();
});

/* ========================================= 3. altered-payload reuse ============ */

test('V5-08-02 commands: an altered payload under the same operation id is IDEMPOTENCY_CONFLICT with a complete rollback', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-conflict';
  const created = await playMatch(h, matchId, ...FIXTURES.conflict);
  const mover = created.symbols.X;
  const opponent = created.symbols.O;
  const key = `move:${matchId}:1`;
  const moverSeat = await connect(h, s, mover, matchId);
  const opponentSeat = await connect(h, s, opponent, matchId);

  moverSeat.client.send(commandMove(matchId, key, 0, { b: 0, c: 0 }));
  assert.equal((await moverSeat.client.next()).ack_revision, 1, 'the first payload commits revision 1');
  await moverSeat.client.next();
  await opponentSeat.client.next();
  const before = await stateOf(h, matchId);
  const committedAt = await operationOf(h, mover, key, 'committed_at');

  /* THE REUSE: the SAME operation id with a DIFFERENT payload (and therefore a different
   * fingerprint) is refused. The revision in this envelope is also stale, which is exactly the
   * point: the operation dedupe runs BEFORE the stale-revision comparison, so the code is the
   * conflict, not STALE_REVISION. */
  moverSeat.client.send(commandMove(matchId, key, 0, { b: 0, c: 1 }));
  const refusal = await moverSeat.client.next();
  assert.deepEqual(refusal, {
    protocol: PROTOCOL, operation: 'error', code: 'IDEMPOTENCY_CONFLICT', match_id: matchId, expected_revision: 0,
  }, 'an altered payload under one operation id conflicts');
  assert.notEqual(refusal.code, 'STALE_REVISION', 'the dedupe precedes the stale-revision check (V5-08-02)');
  assert.ok(PUBLIC_CODES.includes(refusal.code), 'IDEMPOTENCY_CONFLICT is a contract code');

  assert.equal(await moverSeat.client.idle(300), true, 'a rolled-back command never broadcasts');
  assert.equal(await opponentSeat.client.idle(300), true, 'the peer sees no roll-out of a rejected command');
  assert.deepEqual(await stateOf(h, matchId), before, 'the rollback restored the committed board exactly');
  assert.equal(await revisionOf(h, matchId), 1, 'the rollback left the revision at 1');
  assert.equal(await moveOutcomes(h, matchId), 1, 'the rollback left no extra move outcome');
  assert.equal(await outcomesOf(h, mover, key), 1, 'the rollback left exactly one operation outcome');
  assert.deepEqual(await operationOf(h, mover, key, 'committed_at'), committedAt, 'the conflict touched no committed outcome');
  assert.equal(await outboxOf(h, `core.command:${mover}:${key}`), 1, 'the rollback enqueued no second outbox event');

  await closeAll([moverSeat.client, opponentSeat.client]);
  await s.close();
});

/* ===================================================== 4. stale revision ======== */

test('V5-08-02 commands: a new operation id at a stale revision is STALE_REVISION and writes nothing', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-stale';
  const created = await playMatch(h, matchId, ...FIXTURES.stale);
  const mover = created.symbols.X;
  const opponent = created.symbols.O;
  const key = `move:${matchId}:stale`;
  const move = { b: 3, c: 3 };
  const moverSeat = await connect(h, s, mover, matchId);
  const opponentSeat = await connect(h, s, opponent, matchId);

  /* A NEW operation id whose expected_revision (1) is ahead of the committed revision (0). */
  moverSeat.client.send(commandMove(matchId, key, 1, move));
  assert.deepEqual(await moverSeat.client.next(), {
    protocol: PROTOCOL, operation: 'error', code: 'STALE_REVISION', match_id: matchId, expected_revision: 1,
  }, 'a stale revision is refused with the revision it named');
  assert.equal(await moverSeat.client.idle(300), true, 'a stale command never broadcasts');
  assert.equal(await opponentSeat.client.idle(300), true, 'the peer sees no snapshot for a stale command');
  assert.equal(await revisionOf(h, matchId), 0, 'the stale command committed nothing');
  assert.equal(await moveOutcomes(h, matchId), 0, 'the stale command wrote no move outcome');
  assert.equal(await outcomesOf(h, mover, key), 0, 'the aborted attempt left no outcome row to poison the key');

  /* The SAME operation id at the TRUE revision then commits exactly once: proof the failed attempt
   * left no durable trace and the key is still usable. */
  moverSeat.client.send(commandMove(matchId, key, 0, move));
  assert.deepEqual(await moverSeat.client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: 1 },
    'the corrected retry commits and acks revision 1');
  const [own, peer] = await Promise.all([moverSeat.client.next(), opponentSeat.client.next()]);
  assert.equal(own.operation, 'snapshot');
  assert.equal(peer.operation, 'snapshot');
  assert.deepEqual(own.snapshot, await oracle(h, mover, matchId), 'the committed snapshot is an independent Core read');
  assert.equal(await revisionOf(h, matchId), 1, 'the corrected retry committed revision 1');
  assert.equal(await moveOutcomes(h, matchId), 1, 'the corrected retry wrote exactly one move outcome');
  assert.equal(await outcomesOf(h, mover, key), 1, 'the corrected retry wrote exactly one operation outcome');

  await closeAll([moverSeat.client, opponentSeat.client]);
  await s.close();
});

/* ======================================================== 5. turn order ========= */

test('V5-08-02 commands: a move out of turn is NOT_YOUR_TURN and commits nothing', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-turn';
  const created = await playMatch(h, matchId, ...FIXTURES.turn, { move: true });
  const firstMover = created.symbols.X;
  const onTurn = created.symbols.O;
  assert.equal(created.state.turn, 'O', 'the fixture move handed the turn to O');
  const key = `move:${matchId}:out-of-turn`;
  const moverSeat = await connect(h, s, firstMover, matchId);
  const onTurnSeat = await connect(h, s, onTurn, matchId);
  const before = await stateOf(h, matchId);

  /* The symbol that just moved tries again while its opponent owns the turn. The turn check runs
   * BEFORE the engine's legality evaluation inside the same transaction, so the refusal is the turn
   * and not INVALID_MOVE - which is exactly the distinction this case must prove. */
  moverSeat.client.send(commandMove(matchId, key, 1, { b: 5, c: 5 }));
  const refusal = await moverSeat.client.next();
  assert.deepEqual(refusal, {
    protocol: PROTOCOL, operation: 'error', code: 'NOT_YOUR_TURN', match_id: matchId, expected_revision: 1,
  }, 'the turn check refuses the move');
  assert.notEqual(refusal.code, 'INVALID_MOVE', 'turn ownership is decided before move legality');
  assert.equal(await moverSeat.client.idle(300), true, 'an out-of-turn move never broadcasts');
  assert.equal(await onTurnSeat.client.idle(300), true, 'the player on turn sees nothing');
  assert.deepEqual(await stateOf(h, matchId), before, 'the out-of-turn move changed no committed state');
  assert.equal(await revisionOf(h, matchId), 1, 'the revision is still the fixture move');
  assert.equal(await moveOutcomes(h, matchId), 1, 'only the fixture move has a durable outcome');
  assert.equal(await outcomesOf(h, firstMover, key), 0, 'the refused move left no operation outcome');

  await closeAll([moverSeat.client, onTurnSeat.client]);
  await s.close();
});

/* ===================================================== 6. illegal moves ========= */

test('V5-08-02 commands: illegal coordinates are INVALID_MOVE and unsupported kinds are INVALID_COMMAND', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-illegal';
  const created = await playMatch(h, matchId, ...FIXTURES.illegal, { move: true });
  const onTurn = created.symbols.O;
  const opponent = created.symbols.X;
  const onTurnSeat = await connect(h, s, onTurn, matchId);
  const opponentSeat = await connect(h, s, opponent, matchId);
  const before = await stateOf(h, matchId);

  /* OCCUPIED CELL: the engine's internal ILLEGAL_MOVE is normalized to the contract's INVALID_MOVE
   * and answered in the command context (the cell the first mover took is now taken). */
  onTurnSeat.client.send(commandMove(matchId, `move:${matchId}:occupied`, 1, { b: 0, c: 0 }));
  assert.deepEqual(await onTurnSeat.client.next(), {
    protocol: PROTOCOL, operation: 'error', code: 'INVALID_MOVE', match_id: matchId, expected_revision: 1,
  }, 'an occupied cell is INVALID_MOVE, not a leaked internal code');

  /* MALFORMED MOVE SHAPES: refused by the frozen envelope contract BEFORE any transaction is opened,
   * so the refusal is the bare public code (no match context is echoed for an invalid envelope). */
  const bare = { protocol: PROTOCOL, operation: 'error', code: 'INVALID_MOVE' };
  const malformed = [
    ['an out-of-range board index', commandMove(matchId, `move:${matchId}:range`, 1, { b: 9, c: 0 })],
    ['a negative cell index', commandMove(matchId, `move:${matchId}:negative`, 1, { b: 0, c: -1 })],
    ['a non-integer coordinate', commandMove(matchId, `move:${matchId}:fraction`, 1, { b: 0.5, c: 0 })],
    ['a move command with no coordinates', {
      protocol: PROTOCOL, operation: 'command', operation_id: `move:${matchId}:missing`, match_id: matchId,
      expected_revision: 1, command: { type: 'move' },
    }],
  ];
  for (const [label, frame] of malformed) {
    onTurnSeat.client.send(frame);
    assert.deepEqual(await onTurnSeat.client.next(), bare, `${label} is refused by the envelope contract`);
  }

  /* UNSUPPORTED KIND: only move/resign are forwarded; anything else is INVALID_COMMAND in context. */
  onTurnSeat.client.send({
    protocol: PROTOCOL, operation: 'command', operation_id: `queue:${matchId}`, match_id: matchId, expected_revision: 1,
    command: { type: 'queue' },
  });
  assert.deepEqual(await onTurnSeat.client.next(), {
    protocol: PROTOCOL, operation: 'error', code: 'INVALID_COMMAND', match_id: matchId, expected_revision: 1,
  }, 'a command kind the transport does not forward is INVALID_COMMAND');

  for (const code of ['INVALID_MOVE', 'INVALID_COMMAND']) assert.ok(PUBLIC_CODES.includes(code), `${code} is a contract code`);
  assert.equal(await onTurnSeat.client.idle(300), true, 'every refusal left the sender with no further frame');
  assert.equal(await opponentSeat.client.idle(300), true, 'the peer saw none of the refusals');
  assert.deepEqual(await stateOf(h, matchId), before, 'every refusal left the committed state untouched');
  assert.equal(await revisionOf(h, matchId), 1, 'every refusal left the revision untouched');
  assert.equal(await moveOutcomes(h, matchId), 1, 'every refusal wrote no move outcome');

  await closeAll([onTurnSeat.client, opponentSeat.client]);
  await s.close();
});

/* =========================================================== 7. resign ========== */

test('V5-08-02 commands: resign settles the match, emits the receipt and broadcasts the terminal snapshot', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-resign';
  const created = await playMatch(h, matchId, ...FIXTURES.resign, { move: true });
  const resigner = created.symbols.X;
  const survivor = created.symbols.O;
  const key = `resign:${matchId}`;
  const resignerSeat = await connect(h, s, resigner, matchId);
  const survivorSeat = await connect(h, s, survivor, matchId);

  /* The direct offer's quote is the FROZEN oracle's shape: one contribution per seat, `payout` to the
   * winner and `burn` retired. Nothing here re-types those numbers. */
  const escrowColumn = `reserved_${created.quote.currency}`;
  const escrowHeld = () => int(h, `SELECT COALESCE(sum(${escrowColumn}), 0)::int FROM economy.wallets WHERE actor_id = ANY($1::text[])`, [[resigner, survivor]]);
  assert.equal(created.status, 'PLAYING', 'the fixture match is live before the resign');
  assert.equal(await escrowHeld(), created.quote.pool, 'the live match holds exactly the escrowed pot');

  resignerSeat.client.send(commandResign(matchId, key, created.revision));
  assert.deepEqual(await resignerSeat.client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: matchId, ack_revision: created.revision },
    'the settlement is acked with the durable committed revision');
  const [own, peer] = await Promise.all([resignerSeat.client.next(), survivorSeat.client.next()]);
  const committed = await oracle(h, resigner, matchId);
  for (const frame of [own, peer]) {
    assert.equal(frame.operation, 'snapshot');
    assert.equal(frame.match_id, matchId);
    assert.equal(frame.expected_revision, created.revision, 'the terminal broadcast names the committed revision');
    assert.deepEqual(frame.snapshot, committed, 'the terminal snapshot is byte-equal to an independent Core read');
  }
  assert.equal(committed.status, 'FINISHED', 'the match is terminal');
  assert.equal(committed.settled, true, 'the match is settled');
  assert.equal(committed.receipt.reason, 'resign', 'the receipt names the resign reason');
  assert.equal(committed.receipt.winner, survivor, 'the surviving player wins');
  assert.equal(committed.receipt.payout, created.quote.payout, 'the payout is the frozen quote payout');
  assert.equal(committed.receipt.burn, created.quote.burn, 'the burn is the frozen quote burn');

  /* DURABLE TRUTH: the terminal status, the receipt and the single outbox event are committed, and the
   * escrow is fully released. */
  assert.equal(await scalar(h, 'SELECT status FROM match.matches WHERE match_id = $1', [matchId]), 'FINISHED', 'the terminal status is durable');
  assert.equal(await scalar(h, 'SELECT settled FROM match.matches WHERE match_id = $1', [matchId]), true, 'the settlement is durable');
  assert.equal(await scalar(h, "SELECT receipt_json->>'reason' FROM match.matches WHERE match_id = $1", [matchId]), 'resign');
  assert.equal(await scalar(h, "SELECT receipt_json->>'winner' FROM match.matches WHERE match_id = $1", [matchId]), survivor);
  assert.equal(await int(h, "SELECT count(*)::int FROM ops.outbox WHERE outbox_id = $1 AND kind = 'core.command'",
    [`core.command:${resigner}:${key}`]), 1, 'the settlement enqueued exactly one durable outbox event');
  assert.equal(await escrowHeld(), 0, 'the settlement released the entire escrow');

  /* A terminal match accepts no further move. */
  survivorSeat.client.send(commandMove(matchId, `move:${matchId}:after`, created.revision, { b: 4, c: 4 }));
  assert.deepEqual(await survivorSeat.client.next(), {
    protocol: PROTOCOL, operation: 'error', code: 'MATCH_CLOSED', match_id: matchId, expected_revision: created.revision,
  }, 'a settled match refuses a later move');
  assert.equal(await survivorSeat.client.idle(300), true, 'a closed match broadcasts nothing');

  await closeAll([resignerSeat.client, survivorSeat.client]);
  await s.close();
});

/* ========================================================== 8. teardown ========= */

test('V5-08-02 commands: close() drains a commanding match, releases every advisory route and removes its listener', { skip: GATE }, async (t) => {
  const h = await session(t);
  if (!h) return;
  const s = await serve(h, t);

  const matchId = 'match:p08c-teardown';
  const created = await playMatch(h, matchId, ...FIXTURES.teardown);
  const seats = [
    await connect(h, s, created.symbols.X, matchId),
    await connect(h, s, created.symbols.O, matchId),
  ];
  const key = `move:${matchId}:1`;

  seats[0].client.send(commandMove(matchId, key, 0, { b: 8, c: 8 }));
  assert.equal((await seats[0].client.next()).ack_revision, 1, 'the commanding match committed');
  await Promise.all(seats.map((seat) => seat.client.next()));
  assert.equal(s.transport.stats().connections, 2, 'both commanding sockets are tracked');
  assert.equal(await until(async () => (await routeKeys(h.ephemera)).length > 0), true, 'the subscribed connections registered advisory route records');

  await closeAll(seats.map((seat) => seat.client));
  assert.equal(await until(() => s.transport.stats().connections === 0), true, 'closing the clients left no tracked connection');
  assert.deepEqual(s.transport.stats(), {
    connections: 0, authenticated: 0, subscriptions: 0,
    maxEnvelopeBytes: MAX_ENVELOPE_BYTES, authTimeoutMs: 10000, closed: false,
  }, 'no residual connection state survives the sockets');

  /* close() is the ONE drain path and it is idempotent: the routes are released and the upgrade
   * listener is removed, so the owning server can close naturally. */
  await s.transport.close();
  await s.transport.close();
  assert.equal(await until(async () => (await routeKeys(h.ephemera)).length === 0), true, 'every advisory route record is released');
  assert.equal(s.server.listenerCount('upgrade'), 0, 'the transport removed its upgrade listener');
  assert.equal(s.transport.stats().closed, true, 'the transport reports itself closed');
  await s.close();
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
