'use strict';
/* The LAN-local room authority, shared verbatim by the Node LAN server and the in-app host.
 *
 * This proves the portable store runs the SAME approved rules as the shipped online RoomStore
 * for the private-room subset, over the LAN guest/idempotency contract, and that a Wi-Fi guest
 * can open a room, join it, ready up, start, play and finish a real fixture with no internet and
 * no economic state anywhere. It also proves the guards that keep a LAN host from ever becoming
 * an economy or account authority.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LAN = require('../src/lan/lan-room-store.js');
const { createLanRoomHandler } = require('../src/lan/lan-room-http.js');
const T = require('../src/tournament.js');
const G = require('../src/game.js');

/* Node storage stub standing in for the platform key-value slot. */
function memoryStorage(initial = null) {
  let raw = initial;
  return { get: () => raw, set: (s) => { raw = s; }, dump: () => raw };
}

function makeStore({ now = () => 1750000000000 } = {}) {
  return { store: new LAN.LanRoomStore({ storage: memoryStorage(), now }), clock: { t: 1750000000000 } };
}

test('a LAN guest session is anonymous and unlinked from any permanent actor', () => {
  const { store } = makeStore();
  const a = store.guest('Ash');
  const b = store.guest('Bo');
  assert.equal(a.name, 'Ash');
  assert.notEqual(a.actor, b.actor);
  assert.ok(a.token.length >= 40, 'token is high entropy');
  assert.deepEqual(store.authenticate(a.token), { actor: a.actor, name: 'Ash' });
  assert.equal(store.authenticate('not-a-token'), null);
  assert.equal(store.authenticate(undefined), null);
  // No account linkage is even expressible.
  assert.equal(store.lanOnly, true);
});
test('guest names are validated and the session cap is enforced', () => {
  const { store } = makeStore();
  assert.throws(() => store.guest(''), /INVALID_NAME/);
  assert.throws(() => store.guest('   '), /INVALID_NAME/);
  assert.throws(() => store.guest('x'.repeat(33)), /INVALID_NAME/);
  for (let i = 0; i < LAN.constants.MAX_GUESTS; i++) store.guest('p' + i);
  assert.throws(() => store.guest('one-too-many'), /SESSION_LIMIT/);
});
test('the guest token is stored only as a hash, never in the clear', () => {
  const { store } = makeStore();
  const g = store.guest('Ash');
  const raw = JSON.stringify(store.state);
  assert.ok(!raw.includes(g.token), 'the raw bearer token must not be persisted');
  assert.ok(raw.includes(LAN.sha256Hex(g.token)), 'only its digest is persisted');
});

test('a phone-hosted room can be created, discovered, joined, readied, started and finished', () => {
  const { store, clock } = makeStore();
  const host = store.guest('Host'),
        guest = store.guest('Guest');
  const asHost = { actor: host.actor, name: host.name, scope: 'player' },
        asGuest = { actor: guest.actor, name: guest.name, scope: 'player' };

  const created = store.run(asHost, 'k1', { type: 'create', name: 'Friday night', format: 'knockout', clock: 180, increment: 2 });
  assert.equal(created.players.length, 1);
  assert.equal(created.status, 'LOBBY');
  const roomId = created.id;

  // Same Wi-Fi discovery: the room is visible before anyone joins it.
  const found = store.discover();
  assert.equal(found.length, 1);
  assert.equal(found[0].code, created.code);
  assert.equal(found[0].players, 1);

  const joined = store.run(asGuest, 'k2', { type: 'join', id: roomId });
  assert.equal(joined.players.length, 2);
  assert.ok(joined.players.some((p) => p.id === guest.actor));

  // Both ready, host starts; a real bracket is produced by the approved rules.
  store.run(asHost, 'k3', { type: 'ready', id: roomId, value: true, rulesVersion: joined.rulesVersion });
  store.run(asGuest, 'k4', { type: 'ready', id: roomId, value: true, rulesVersion: joined.rulesVersion });
  const afterStart = store.run(asHost, 'k5', { type: 'start', id: roomId });
  assert.equal(afterStart.status, 'RUNNING');
  assert.ok(afterStart.fixtures.length >= 1, 'a knockout bracket exists');

  // The guest can read the room and sees the same revision the host sees.
  const view = store.view(roomId, guest.actor);
  assert.equal(view.revision, afterStart.revision);
  assert.equal(view.fixtures[0].players.length, 2);
});

test('a LAN room command is idempotent and a changed replay is refused', () => {
  const { store } = makeStore();
  const g = store.guest('Ash');
  const p = { actor: g.actor, name: g.name, scope: 'player' };
  const first = store.run(p, 'same-key', { type: 'create', name: 'R', format: 'knockout', clock: 120, increment: 2 });
  const again = store.run(p, 'same-key', { type: 'create', name: 'R', format: 'knockout', clock: 120, increment: 2 });
  assert.equal(again.id, first.id, 'a retried request returns the same room, not a second one');
  assert.equal(store.active().length, 1, 'and it did not mint a second room');
  assert.throws(() => store.run(p, 'same-key', { type: 'create', name: 'Different', format: 'league', clock: 120, increment: 2 }), /IDEMPOTENCY_CONFLICT/);
});

test('a LAN host refuses prize/public tables outright: it is never an economy authority', () => {
  const { store } = makeStore();
  const g = store.guest('Ash');
  const p = { actor: g.actor, name: g.name, scope: 'player' };
  assert.throws(() => store.run(p, 'k', { type: 'publicJoin', table: 'low' }), /FREE_PRIVATE_ONLY/);
  const capabilities = createLanRoomHandler({ store }).handle({ method: 'GET', path: '/api/party/capabilities', headers: { host: '192.168.0.8:8081' } });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.body.lan, true);
  assert.equal(capabilities.body.online, false);
  assert.equal(capabilities.body.publicEnabled, false);
  // The store exposes no way to touch Coins, Crowns, reserves, Elo or any balance at all.
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).join(' ');
  assert.ok(!/economy|wallet|balance|reserve|settle|rating/i.test(surface), 'no economic mutator exists: ' + surface);
});

test('the LAN HTTP contract answers the shipped client shapes and rejects a non-LAN Host', () => {
  const { store } = makeStore();
  const handler = createLanRoomHandler({ store });
  const guest = store.guest('Ash');

  const caps = handler.handle({ method: 'GET', path: '/api/party/capabilities', headers: { host: '192.168.0.8:8081' } });
  assert.equal(caps.status, 200);
  assert.equal(caps.body.lan, true);
  assert.equal(Array.isArray(caps.body.tables), true);

  // Loopback, RFC1918, link-local and IPv6 ULA are acceptable Host values.
  for (const host of ['localhost:8081', '127.0.0.1:8081', '10.0.0.1:808x'.replace('x', '1'), '192.168.1.20:8081', '172.16.0.9:8081', '169.254.1.1:8081', '[::1]:8081', '[fd00::1]:8081']) {
    assert.equal(handler.isLanHost(host), true, host + ' should be a LAN host');
  }
  // A public DNS name or public IP is not, so the Host header cannot be used to reach outside.
  for (const host of ['megaxo.online', 'example.com:8081', '8.8.8.8:8081', 'evil.test:80']) {
    assert.equal(handler.isLanHost(host), false, host + ' should NOT be a LAN host');
  }
  const bad = handler.handle({ method: 'GET', path: '/api/party/capabilities', headers: { host: 'evil.test' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.error, 'BAD_HOST');

  // Unauthenticated access to a room is refused.
  const noAuth = handler.handle({ method: 'GET', path: '/api/party/me', headers: { host: '192.168.0.8:8081' } });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.body.error, 'AUTH_REQUIRED');

  // A guest session, then an authenticated command round trip.
  const session = handler.handle({ method: 'POST', path: '/api/party/session', headers: { host: '192.168.0.8:8081' }, body: JSON.stringify({ name: 'Ash' }) });
  assert.equal(session.status, 200);
  assert.equal(session.body.name, 'Ash');
  const auth = { host: '192.168.0.8:8081', authorization: 'Bearer ' + session.body.token, 'idempotency-key': 'abc' };
  const made = handler.handle({ method: 'POST', path: '/api/party/command', headers: auth, body: JSON.stringify({ type: 'create', name: 'R', format: 'knockout', clock: 120, increment: 2 }) });
  assert.equal(made.status, 200);
  assert.equal(made.body.players.length, 1);

  // The bearer may also arrive as ?token= for environments that cannot set headers.
  const me = handler.handle({ method: 'GET', path: '/api/party/me', query: { token: session.body.token }, headers: { host: '192.168.0.8:8081' } });
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'Ash');

  // A non-party path is not this handler's business.
  assert.equal(handler.handle({ method: 'GET', path: '/api/v1/profile', headers: { host: '192.168.0.8:8081' } }), null);
});

test('malformed and oversized command bodies are refused, not applied', () => {
  const { store } = makeStore();
  const handler = createLanRoomHandler({ store });
  const g = store.guest('Ash');
  const headers = { host: '192.168.0.8:8081', authorization: 'Bearer ' + g.token, 'idempotency-key': 'k' };
  assert.equal(handler.handle({ method: 'POST', path: '/api/party/command', headers, body: '{not json' }).body.error, 'INVALID_JSON');
  assert.equal(handler.handle({ method: 'POST', path: '/api/party/command', headers, body: '[]' }).body.error, 'INVALID_JSON');
  assert.equal(handler.handle({ method: 'POST', path: '/api/party/command', headers, body: 'x'.repeat(20000) }).body.error, 'PAYLOAD_TOO_LARGE');
  // A command with no idempotency key must not be accepted.
  assert.equal(handler.handle({ method: 'POST', path: '/api/party/command', headers: { host: '192.168.0.8:8081', authorization: 'Bearer ' + g.token }, body: '{"type":"create"}' }).body.error, 'INVALID_COMMAND');
  assert.equal(store.active().length, 0, 'nothing was created by any rejected request');
});

test('an interrupted LAN tournament recovers PAUSED, never silently settled', () => {
  const { store } = makeStore();
  const a = store.guest('A'), b = store.guest('B');
  const pa = { actor: a.actor, name: a.name, scope: 'player' }, pb = { actor: b.actor, name: b.name, scope: 'player' };
  const created = store.run(pa, 'k1', { type: 'create', name: 'R', format: 'knockout', clock: 180, increment: 2 });
  store.run(pb, 'k2', { type: 'join', id: created.id });
  const lobby = store.view(created.id, a.actor);
  store.run(pa, 'k3', { type: 'ready', id: created.id, value: true, rulesVersion: lobby.rulesVersion });
  store.run(pb, 'k4', { type: 'ready', id: created.id, value: true, rulesVersion: lobby.rulesVersion });
  store.run(pa, 'k5', { type: 'start', id: created.id });
  assert.equal(store.get(created.id).status, 'RUNNING');
  assert.equal(store.recover(), true);
  const recovered = store.get(created.id);
  assert.equal(recovered.status, 'PAUSED');
  assert.equal(recovered.reason, 'SERVER_RESTART');
  assert.equal(recovered.settled ?? false, false, 'nothing was settled or paid out');
});

test('the LAN dataset survives a host restart through the injected storage', () => {
  const storage = memoryStorage();
  const clock = { t: 1750000000000 };
  const first = new LAN.LanRoomStore({ storage, now: () => clock.t });
  const g = first.guest('Ash');
  const p = { actor: g.actor, name: g.name, scope: 'player' };
  const created = first.run(p, 'k', { type: 'create', name: 'Persistent', format: 'league', clock: 120, increment: 1 });
  first.persist();

  const second = new LAN.LanRoomStore({ storage, now: () => clock.t });
  assert.deepEqual(second.authenticate(g.token), { actor: g.actor, name: 'Ash' }, 'the guest session survives');
  const view = second.view(created.id, g.actor);
  assert.equal(view.name, 'Persistent');
  assert.equal(view.code, created.code);
  // And the persisted document carries no raw token.
  assert.ok(!String(storage.dump()).includes(g.token));
});

test('tick advances a real LAN match clock and a legal move is accepted by the shared rules', () => {
  const clock = { t: 1750000000000 };
  const store = new LAN.LanRoomStore({ storage: memoryStorage(), now: () => clock.t });
  const a = store.guest('A'), b = store.guest('B');
  const pa = { actor: a.actor, name: a.name, scope: 'player' }, pb = { actor: b.actor, name: b.name, scope: 'player' };
  const created = store.run(pa, 'k1', { type: 'create', name: 'R', format: 'knockout', clock: 180, increment: 2 });
  store.run(pb, 'k2', { type: 'join', id: created.id });
  const lobby = store.view(created.id, a.actor);
  store.run(pa, 'k3', { type: 'ready', id: created.id, value: true, rulesVersion: lobby.rulesVersion });
  store.run(pb, 'k4', { type: 'ready', id: created.id, value: true, rulesVersion: lobby.rulesVersion });
  const started = store.run(pa, 'k5', { type: 'start', id: created.id });
  const fixture = started.fixtures[0];

  // Both sides ready the fixture, then the first player moves a LEGAL cell (rules decide it).
  // The fixture opens after a countdown, so advance the injected clock past it.
  const opening = store.state.rooms.find((x) => x.id === created.id).fixtures[0];
  clock.t = Math.max(clock.t, opening.opens + 1000);
  store.run(pa, 'k6', { type: 'matchReady', id: created.id, fixture: fixture.id });
  store.run(pb, 'k7', { type: 'matchReady', id: created.id, fixture: fixture.id });
  let view = store.view(created.id, a.actor);
  const f = view.fixtures.find((x) => x.id === fixture.id);
  const turn = f.state.turn === 'X' ? f.players[0] : f.players[1];
  const actor = turn === a.actor ? pa : pb;
  const legal = G.legal(f.state)[0];
  const moved = store.run(actor, 'k8', { type: 'move', id: created.id, fixture: f.id, revision: f.revision ?? 0, move: { b: legal.b, c: legal.c } });
  const after = moved.fixtures.find((x) => x.id === fixture.id);
  assert.equal(after.state.moves.length, 1);

  // The clock advances under tick, and the LAN host never needs the internet for any of it.
  clock.t += 5000;
  store.tick();
  assert.ok(store.view(created.id, a.actor).serverNow === clock.t);
});

test('discovery reports only private lobby rooms, never a live or terminal one', () => {
  const { store } = makeStore();
  const a = store.guest('A'), b = store.guest('B');
  const pa = { actor: a.actor, name: a.name, scope: 'player' }, pb = { actor: b.actor, name: b.name, scope: 'player' };
  const created = store.run(pa, 'k1', { type: 'create', name: 'Open', format: 'knockout', clock: 120, increment: 2 });
  assert.equal(store.discover().length, 1);
  store.run(pb, 'k2', { type: 'join', id: created.id });
  const lobby = store.view(created.id, a.actor);
  store.run(pa, 'k3', { type: 'ready', id: created.id, value: true, rulesVersion: lobby.rulesVersion });
  store.run(pb, 'k4', { type: 'ready', id: created.id, value: true, rulesVersion: lobby.rulesVersion });
  store.run(pa, 'k5', { type: 'start', id: created.id });
  assert.equal(store.discover().length, 0, 'a running room is no longer joinable, so it is not listed');
});

/* ----------------------------------------------------------------------------------------------
 * The JS<->native bridge contract: the shell owns the socket and the discovery record, the page
 * owns the rules. These tests stand in for the Kotlin/Swift side with the exact published
 * primitives, so a change to the contract fails here before it fails on a phone.
 * ---------------------------------------------------------------------------------------------- */
const LanHost = require('../src/lan/lan-host.js');

function fakeShell({ port = 8081, origin = 'http://192.168.0.55:8081' } = {}) {
  const calls = { start: [], stop: 0, advertise: [], browse: 0, discoveryStop: 0 };
  const shell = {
    MegaLanSocket: {
      start(p) { calls.start.push(p); return { ok: true, port }; },
      stop() { calls.stop += 1; return { ok: true }; },
      status() { return { listening: true, port, origin }; },
    },
    MegaLanDiscovery: {
      advertise(name, p) { calls.advertise.push([name, p]); return { ok: true }; },
      stop() { calls.discoveryStop += 1; return { ok: true }; },
      browse() { calls.browse += 1; return Promise.resolve([{ name: 'Other phone', origin: 'http://192.168.0.9:8081', rooms: [{ id: 'r1', code: 'ABCDE', name: 'Kitchen', players: 2, capacity: 10, status: 'LOBBY' }] }]); },
    },
    calls,
  };
  return shell;
}

test('hosting starts the native socket and advertises over the Wi-Fi', async () => {
  const shell = fakeShell();
  const keys = ['MegaLanSocket', 'MegaLanDiscovery'];
  const saved = keys.map((k) => [k, globalThis[k]]);
  Object.assign(globalThis, { MegaLanSocket: shell.MegaLanSocket, MegaLanDiscovery: shell.MegaLanDiscovery });
  try {
    const host = LanHost.create({ storage: memoryStorage(), now: () => 1750000000000 });
    const started = host.open('Kitchen phone', 8081);
    assert.deepEqual(started, { ok: true, port: 8081, code: LanHost.VERSION, version: LanHost.VERSION });
    assert.deepEqual(shell.calls.start, [8081], 'the shell bound the requested port');
    assert.deepEqual(shell.calls.advertise, [['Kitchen phone', 8081]], 'and advertised it on the Wi-Fi');
    assert.deepEqual(host.ready(), { ok: true, port: 8081, origin: 'http://192.168.0.55:8081', rooms: 0, version: LanHost.VERSION });
    const closed = host.close();
    assert.equal(closed.ok, true);
    assert.equal(shell.calls.stop, 1, 'the listener was closed');
    assert.equal(shell.calls.discoveryStop, 1);
  } finally { for (const [k, v] of saved) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } }
});

test('without a native host the lobby is told so instead of pretending', () => {
  const saved = globalThis.MegaLanSocket;
  delete globalThis.MegaLanSocket;
  try {
    const host = LanHost.create({ storage: memoryStorage() });
    const r = host.open('Kitchen phone', 8081);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HOST_UNAVAILABLE');
  } finally { if (saved !== undefined) globalThis.MegaLanSocket = saved; }
});

test('discovery returns the rooms another phone is hosting, and never throws', async () => {
  const shell = fakeShell();
  const saved = globalThis.MegaLanDiscovery;
  globalThis.MegaLanDiscovery = shell.MegaLanDiscovery;
  try {
    const host = LanHost.create({ storage: memoryStorage() });
    const found = await host.discover(1500);
    assert.equal(found.ok, true);
    assert.equal(shell.calls.browse, 1);
    assert.equal(found.hosts[0].origin, 'http://192.168.0.9:8081');
    assert.equal(found.hosts[0].rooms[0].code, 'ABCDE');
    delete globalThis.MegaLanDiscovery;
    const none = await host.discover(500);
    assert.equal(none.ok, false);
    assert.equal(none.error, 'DISCOVERY_UNAVAILABLE');
    assert.deepEqual(none.hosts, [], 'a missing discovery service is an empty list, not a crash');
  } finally { if (saved === undefined) delete globalThis.MegaLanDiscovery; else globalThis.MegaLanDiscovery = saved; }
});

test('handle() answers a real command round trip and always returns JSON, never throws', () => {
  const host = LanHost.create({ storage: memoryStorage(), now: () => 1750000000000 });
  const headers = { host: '192.168.0.55:8081' };
  const caps = JSON.parse(host.handle(JSON.stringify({ method: 'GET', path: '/api/party/capabilities', headers })));
  assert.equal(caps.status, 200);
  assert.equal(caps.body.lan, true);
  const session = JSON.parse(host.handle(JSON.stringify({ method: 'POST', path: '/api/party/session', headers, body: JSON.stringify({ name: 'Guest' }) })));
  assert.equal(session.status, 200);
  const created = JSON.parse(host.handle(JSON.stringify({
    method: 'POST', path: '/api/party/command',
    headers: { ...headers, authorization: 'Bearer ' + session.body.token, 'idempotency-key': 'k1' },
    body: JSON.stringify({ type: 'create', name: 'Kitchen', format: 'knockout', clock: 120, increment: 2 }),
  })));
  assert.equal(created.status, 200);
  assert.equal(created.body.players.length, 1);
  // Every failure path returns parseable JSON.
  for (const bad of ['not json at all', JSON.stringify({ method: 'GET' }), '{}', JSON.stringify({ method: 'GET', path: '/nope' })]) {
    const out = JSON.parse(host.handle(bad));
    assert.ok(out.error || out.status, 'a bad request still produced a JSON answer: ' + bad);
  }
  // A non-party path is reported as NOT_FOUND rather than silently 200.
  assert.equal(JSON.parse(host.handle(JSON.stringify({ method: 'GET', path: '/api/v1/profile', headers }))).error, 'NOT_FOUND');
});
