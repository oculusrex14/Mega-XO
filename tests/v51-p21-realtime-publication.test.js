'use strict';
/* Real owned PostgreSQL/Core/tickets/API HTTP ingress, Redis publication and loopback WebSockets.
 * This suite never targets an existing staging database. The shared lab requires its explicit
 * disposable gate and creates/drops only uniquely named v5_test_p05lab_ databases. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const lab = require('./v5-pg-lab.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');
const { createTicketIssuer } = require('../packages/services/tickets.js');
const { createRealtimeTransport } = require('../packages/services/realtime-transport.js');
const { createCoreGateway, createCoreServiceIngress } = require('../packages/services/core-gateway.js');
const { createApiHandler } = require('../apps/api/index.js');
const { resolveAuth } = require('../apps/api/routes/helpers.js');

const HAVE_REDIS = process.env.REDIS_URL !== undefined;
const GATE = HAVE_REDIS && (process.env.V5_PG_REQUIRED === '1' || process.env.V5_PG_URL) ? false : 'owned disposable PostgreSQL and loopback Redis are required';
const PAIRS = { http: ['svc_pub01', 'svc_pub02'], timeout: ['svc_pub03', 'svc_pub04'], void: ['svc_pub05', 'svc_pub06'], order: ['svc_pub07', 'svc_pub08'], race: ['svc_pub09', 'svc_pub10'] };
const SEEDS = Object.values(PAIRS).flat().map(actor => ({ actor, coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' }));
const PROTOCOL = 'realtime/v1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(probe, timeout = 5000) {
  const end = Date.now() + timeout;
  do { if (await probe()) return; await sleep(10); } while (Date.now() < end);
  assert.fail('owned realtime side effect exceeded its deadline');
}
let clock = lab.CLOCK, sessionPromise, ownedSession;
async function session(t) {
  if (!(await lab.boot(t))) return null;
  if (!sessionPromise) sessionPromise = (async () => {
    const database = await lab.createDatabase('p21pub');
    await lab.seedActors(database, SEEDS);
    const pools = lab.poolsFor(database);
    const ephemera = await createEphemeraService({ url: process.env.REDIS_URL, environment: 'test', keyVersion: 'p' + crypto.randomBytes(3).toString('hex'), allowPlaintext: true, socket: { connectTimeout: 3000 } });
    assert.equal(await ephemera.healthy(), true);
    const core = await lab.coreFor(database, { clock: () => clock, ephemera });
    const accounts = await lab.accountsFor(database, { clock: () => clock });
    const issuer = await createTicketIssuer(pools.api, { now: () => clock, environment: 'stg', audience: 'mega-core' });
    ownedSession = { database, pools, ephemera, core, accounts, issuer };
    return ownedSession;
  })();
  const h = await sessionPromise;
  t.diagnostic('Owned disposable database: ' + h.database + '; Redis namespace mx:test:' + h.ephemera.keyVersion);
  return h;
}
test.after(async () => {
  if (!ownedSession) return;
  for (const service of [ownedSession.core, ownedSession.issuer, ownedSession.accounts]) await service.close();
  await ownedSession.ephemera.wipeNamespace();
  await ownedSession.ephemera.close();
});
lab.installCleanup(test);

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])]));
  return value;
}
async function serve(h, t) {
  let api, ingress, reads = 0, reverse = false, hold = null;
  const clients = [], sessions = new Map(), held = new Set();
  const readerCore = {
    run: h.core.run.bind(h.core),
    async readMatch(actor, id) {
      const view = await h.core.readMatch(actor, id);
      const gate = hold; hold = null;
      if (gate) { gate.started.resolve(view); await gate.release.promise; held.delete(gate); }
      reads++;
      return reverse ? reverseKeys(view) : view;
    },
  };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname.startsWith('/realtime/v1/snapshot') || pathname.startsWith('/realtime/v1/match/')) return;
      if (pathname.startsWith('/ingress/')) return await ingress(req, res);
      return await api(req, res);
    } catch { res.statusCode = 500; res.end(JSON.stringify({ error: 'LAB_REQUEST_FAILED' })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const secret = crypto.randomBytes(32).toString('hex');
  ingress = createCoreServiceIngress({ coreService: h.core, ticketIssuer: h.issuer, secret, now: () => clock });
  const gateway = createCoreGateway({ coreUrl: origin, secret, now: () => clock });
  api = createApiHandler({ pool: h.pools.api, accounts: h.accounts, ticketIssuer: h.issuer, coreGateway: gateway, allowedOrigins: [origin], now: () => clock });
  const transport = createRealtimeTransport({ server, pool: h.pools.core, core: readerCore, ephemera: h.ephemera,
    now: () => clock, environment: 'stg', audience: 'mega-core', authenticateHttp: async req => {
      const { actor } = await resolveAuth({ accounts: h.accounts }, req); if (!actor) throw Error('AUTH_REQUIRED'); return { actor };
    } });
  assert.equal(await transport.ready, true);
  t.after(async () => {
    for (const gate of held) gate.release.resolve();
    await Promise.all(clients.map(client => client.close()));
    await transport.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  async function browser(actor) {
    if (!sessions.has(actor)) sessions.set(actor, await h.accounts.issue(actor, clock));
    return sessions.get(actor);
  }
  async function request(actor, pathname, body, key) {
    const binding = await browser(actor);
    const response = await fetch(origin + pathname, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'mega_dev_session=' + binding.token, Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': binding.csrf, 'Idempotency-Key': key || 'lab:' + crypto.randomBytes(8).toString('hex') }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, 'owned API operation ' + pathname + ' failed with public code ' + value.error);
    return value;
  }
  return { origin, transport, request, reads: () => reads, reverse: value => { reverse = value; },
    holdRead: () => { const gate = { started: deferred(), release: deferred() }; hold = gate; held.add(gate); return gate; },
    async connect(actor, id, subscribe = true) {
      const grant = await request(actor, '/api/v1/ticket', { matchScope: id });
      assert.equal(typeof grant.ticket, 'string');
      const client = socketClient(origin.replace(/^http:/, 'ws:') + '/realtime/v1'); clients.push(client);
      await client.open(); client.send({ operation: 'ticket.redeem', ticket: grant.ticket });
      assert.deepEqual(await client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: id, ack_revision: 0 });
      if (subscribe) { client.send({ operation: 'subscribe', match_id: id }); assert.equal((await client.next()).operation, 'snapshot'); }
      return client;
    },
  };
}
function socketClient(url) {
  const ws = new WebSocket(url), queued = [], waiters = [];
  let closed = false;
  ws.addEventListener('error', () => {});
  ws.addEventListener('message', event => {
    const frame = JSON.parse(event.data), waiting = waiters.shift();
    if (waiting) { clearTimeout(waiting.timer); waiting.resolve(frame); } else queued.push(frame);
  });
  ws.addEventListener('close', () => { closed = true; });
  return {
    ws,
    open: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('owned socket open timed out')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('close', () => { clearTimeout(timer); reject(Error('owned socket closed before open')); }, { once: true });
    }),
    send: frame => ws.send(JSON.stringify({ protocol: PROTOCOL, ...frame })),
    next: () => new Promise((resolve, reject) => {
      if (queued.length) return resolve(queued.shift());
      const waiting = { resolve, timer: null };
      waiting.timer = setTimeout(() => { const index = waiters.indexOf(waiting); if (index >= 0) waiters.splice(index, 1); reject(Error('owned socket frame timed out')); }, 5000);
      waiters.push(waiting);
    }),
    idle: async () => { await sleep(250); return queued.length === 0; },
    close: async () => { if (!closed) ws.close(1000); await until(() => closed); },
  };
}
async function match(h, id, pair, withMove = false) {
  const offered = await h.core.run({ actor: pair[0], scope: 'player' }, 'offer:' + id,
    { type: 'offer', id, opponent: pair[1], terms: { kind: 'leaderboard', amount: 40 } });
  await h.core.run({ actor: pair[1], scope: 'player' }, 'accept:' + id, { type: 'accept', id, termsHash: offered.termsHash });
  let view = await h.core.readMatch(pair[0], id);
  if (withMove) {
    await h.core.run({ actor: view.symbols.X, scope: 'player' }, 'fixture-move:' + id, { type: 'move', id, revision: view.revision, move: { b: 0, c: 4 } });
    view = await h.core.readMatch(pair[0], id);
  }
  return view;
}
async function hint(h, s, id) {
  const before = s.reads();
  await h.ephemera.publish('core-match', JSON.stringify({ matchId: id }), 1000);
  await until(() => s.reads() > before);
}
async function fullResume(client, view) {
  client.send({ operation: 'resume', match_id: view.id, ack_revision: view.revision });
  assert.deepEqual(await client.next(), { protocol: PROTOCOL, operation: 'ack', match_id: view.id, ack_revision: view.revision });
  const snapshot = await client.next(); assert.equal(snapshot.operation, 'snapshot'); assert.equal(snapshot.expected_revision, view.revision);
  assert.deepEqual(snapshot.snapshot, view); assert.equal(snapshot.server_now, clock);
}

test('P21-PUBLISH-HTTP a production API HTTP move reaches its opponent socket, and same-revision HTTP resignation delivers settlement', { skip: GATE }, async t => {
  const h = await session(t); if (!h) return; const s = await serve(h, t);
  const initial = await match(h, 'match:p21pub-http', PAIRS.http);
  const peer = await s.connect(initial.symbols.O, initial.id);
  const moved = await s.request(initial.symbols.X, '/api/v1/move', { id: initial.id, revision: 0, move: { b: 0, c: 4 } }, 'http-move:' + initial.id);
  assert.equal(moved.revision, 1);
  const playing = await peer.next(), oracle = await h.core.readMatch(initial.symbols.O, initial.id);
  assert.equal(playing.operation, 'snapshot'); assert.deepEqual(playing.snapshot, oracle);
  assert.equal(oracle.status, 'PLAYING'); assert.equal(oracle.revision, 1);
  await hint(h, s, initial.id); assert.equal(await peer.idle(), true, 'an unchanged HTTP commit hint is not duplicated');
  await s.request(initial.symbols.X, '/api/v1/resign', { id: initial.id }, 'http-resign:' + initial.id);
  const settled = await peer.next(), terminal = await h.core.readMatch(initial.symbols.O, initial.id);
  assert.equal(terminal.status, 'FINISHED'); assert.equal(terminal.receipt.reason, 'resign'); assert.equal(terminal.revision, oracle.revision);
  assert.deepEqual(settled.snapshot, terminal); assert.equal(settled.expected_revision, oracle.revision);
  await hint(h, s, initial.id); assert.equal(await peer.idle(), true, 'the identical terminal hint is suppressed');
  const fresh = await s.connect(initial.symbols.O, initial.id, false); await fullResume(fresh, terminal);
});

for (const operation of ['timeout', 'void']) test('P21-PUBLISH-' + operation.toUpperCase() + ' Core settlement at the same move revision reaches a subscribed socket and equal resume', { skip: GATE }, async t => {
  const h = await session(t); if (!h) return; const s = await serve(h, t);
  const initial = await match(h, 'match:p21pub-' + operation, PAIRS[operation], true);
  const peer = await s.connect(initial.players[0], initial.id);
  await hint(h, s, initial.id); assert.deepEqual((await peer.next()).snapshot, initial);
  if (operation === 'timeout') clock = initial.deadline + 1;
  await h.core.run({ actor: 'lab_operator', scope: 'operator' }, operation + ':' + initial.id,
    { type: operation, id: initial.id, ...(operation === 'void' ? { reason: 'Owned lab cancellation' } : {}) });
  const delivered = await peer.next(), terminal = await h.core.readMatch(initial.players[0], initial.id);
  assert.equal(terminal.status, operation === 'void' ? 'VOID' : 'FINISHED'); assert.equal(terminal.revision, initial.revision);
  assert.equal(terminal.settled, true); assert.deepEqual(delivered.snapshot, terminal);
  await fullResume(peer, terminal); await hint(h, s, initial.id); assert.equal(await peer.idle(), true);
});

test('P21-PUBLISH-CANONICAL equivalent committed view key ordering does not defeat hint deduplication', { skip: GATE }, async t => {
  const h = await session(t); if (!h) return; const s = await serve(h, t);
  const initial = await match(h, 'match:p21pub-order', PAIRS.order, true), peer = await s.connect(initial.players[0], initial.id);
  await hint(h, s, initial.id); assert.deepEqual((await peer.next()).snapshot, initial);
  s.reverse(true); await hint(h, s, initial.id); assert.equal(await peer.idle(), true);
});

test('P21-PUBLISH-RACE a delayed PLAYING hint read cannot reopen a same-revision terminal view already broadcast by a socket command', { skip: GATE }, async t => {
  const h = await session(t); if (!h) return; const s = await serve(h, t);
  const initial = await match(h, 'match:p21pub-race', PAIRS.race, true), peer = await s.connect(initial.players[0], initial.id);
  await hint(h, s, initial.id); await peer.next();
  const hold = s.holdRead();
  await h.ephemera.publish('core-match', JSON.stringify({ matchId: initial.id }), 1000);
  assert.deepEqual(await hold.started.promise, initial);
  peer.send({ operation: 'command', match_id: initial.id, expected_revision: initial.revision,
    operation_id: 'socket-resign:' + initial.id, command: { type: 'resign' } });
  assert.equal((await peer.next()).operation, 'ack');
  const terminal = await peer.next(); assert.equal(terminal.snapshot.status, 'FINISHED'); assert.equal(terminal.expected_revision, initial.revision);
  const before = s.reads(); hold.release.resolve(); await until(() => s.reads() >= before + 2);
  assert.equal(await peer.idle(), true, 'the old PLAYING read and the identical settlement echo are both suppressed');
});
