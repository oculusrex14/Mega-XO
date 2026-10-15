'use strict';

// Loopback PG16 and real HTTP through cookie/Origin authentication -> signed
// ingress -> the existing Core-owned tournament transaction. Synthetic actors
// only; no provider, staging account or production database is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const lab = require('./v5-pg-lab');
const T = require('../src/tournament');
const G = require('../src/game');
const { createApiHandler } = require('../apps/api/index.js');
const { createTournamentService } = require('../packages/services/tournaments');
const { createCoreGateway, createCoreServiceIngress, signRequest } = require('../packages/services/core-gateway');
const { tournamentCommand } = require('../packages/services/tournament-http-contract');
const { createTournamentTimer } = require('../packages/services/tournament-timer');
lab.installCleanup(test);
const SECRET = 'synthetic-tournament-http-secret-20261015';
const roster = Array.from({ length: 11 }, (_, index) => `svc_webt${index}`);

async function listen(handler) {
 const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end('{}'); }));
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 return { server, origin: `http://127.0.0.1:${server.address().port}`,
  async close() { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } };
}

test('website tournament contract rejects privileged and malformed input before signing', () => {
 for (const command of [null, [], { type: 'create' }, { type: 'cancel', id: 'room' },
  { type: 'publicJoin', table: 'low', actor: 'victim' }, { type: 'publicJoin', table: 'low', scope: 'operator' },
  { type: 'publicJoin', table: 'low', name: 'forged' }, { type: 'publicJoin', table: 'low', opKey: 'forged' },
  { type: 'publicJoin', table: '__proto__' }, { type: 'ready', id: '../room', value: true, rulesVersion: 1 },
  { type: 'ready', id: 'room', value: 'true', rulesVersion: 1 },
  { type: 'move', id: 'room', fixture: 'g1', revision: 0, move: { b: 4, c: 9 } },
  { type: 'move', id: 'room', fixture: 'g1', revision: 0, move: { b: 4, c: 4, actor: 'victim' } }]) {
  assert.throws(() => tournamentCommand(command), /INVALID_TOURNAMENT_COMMAND/);
 }
 const command = { type: 'move', id: 'room', fixture: 'g1', revision: 0, move: { b: 4, c: 4 } };
 const projected = tournamentCommand(command);
 command.move.c = 3;
 assert.equal(projected.move.c, 4, 'the signed projection does not share the caller move object');
});

test('tournament timer coalesces ticks, reports failures, and waits for the active sweep on stop', async () => {
 let release, calls = 0;
 const deferred = new Promise(resolve => { release = resolve; });
 const timer = createTournamentTimer({ owner: 'test-timer', tournaments: { sweepTimers: async input => {
  calls++; assert.deepEqual(input, { owner: 'test-timer', limit: 16, leaseMs: 5000 }); await deferred; return { scanned: 1 };
 } } });
 const first = timer.tick();
 assert.equal(timer.tick(), first);
 let stopped = false; const closing = timer.stop().then(() => { stopped = true; });
 await Promise.resolve(); assert.equal(stopped, false);
 release(); await closing; assert.equal(calls, 1); assert.equal(timer.tick(), null);
 const seen = [];
 const failed = createTournamentTimer({ owner: 'failed-timer', tournaments: { sweepTimers: async () => { throw Error('DATABASE_UNAVAILABLE'); } }, onError: error => seen.push(error.message) });
 assert.equal(await failed.tick(), null); assert.deepEqual(seen, ['DATABASE_UNAVAILABLE']); await failed.stop();
});

test('an ambiguous Core network failure is retryable with the same tournament operation key', async () => {
 let observed;
 const gateway = createCoreGateway({ secret: SECRET, fetcher: async (_url, init) => { observed = JSON.parse(init.body); throw TypeError('fetch failed'); } });
 await assert.rejects(gateway.tournamentCommand({ actor: 'synthetic-player', opKey: 'durable-client-key', command: { type: 'publicJoin', table: 'low' } }),
  error => error.status === 503 && error.message === 'SERVICE_UNAVAILABLE');
 assert.equal(observed.opKey, 'durable-client-key');
});

test('PG16 website tournament HTTP, idempotency, actor isolation, canonical clocks and atomic refund', async t => {
 if (!(await lab.boot(t))) return;
 const database = await lab.createDatabase('v52webtournament');
 await lab.seedActors(database, roster.map(actor => ({ actor, coins: 1000, crowns: 1000, rating: 1500, games: 30, stats: 'friends' })));
 const pools = lab.poolsFor(database);
 let clock = lab.CLOCK;
 const tournaments = createTournamentService({ pool: pools.core, now: () => clock });
 const accounts = await lab.accountsFor(database, { clock: () => clock });
 const ingress = createCoreServiceIngress({ tournaments, secret: SECRET, now: () => clock });
 let api;
 const host = await listen((req, res) => req.url.startsWith('/ingress/') ? ingress(req, res) : api(req, res));
 t.after(async () => { await host.close(); tournaments.close(); await accounts.close(); });
 const gateway = createCoreGateway({ coreUrl: host.origin, secret: SECRET, now: () => clock });
 api = createApiHandler({ pool: pools.api, accounts, coreGateway: gateway, allowedOrigins: [host.origin], now: () => clock });
 const sessions = new Map();
 for (const actor of roster) sessions.set(actor, (await accounts.issue(actor, clock)).token);
 async function request(path, { actor, body, key, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(host.origin + path, { method, headers: {
   ...(actor ? { cookie: `mega_dev_session=${sessions.get(actor)}` } : {}),
   ...(body === undefined ? {} : { origin: host.origin, 'content-type': 'application/json' }),
   ...(key ? { 'idempotency-key': key } : {}), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
 }
 let room;
 await t.test('public capabilities advertise exactly the configured canonical tables; unconfigured ingress stays disabled', async () => {
  const caps = await request('/api/party/capabilities');
  assert.equal(caps.status, 200); assert.equal(caps.data.online, true); assert.equal(caps.data.publicEnabled, true);
  assert.deepEqual(caps.data.tables, Object.keys(T.TABLES).map(table => T.prize(table)));
  const disabledHost = await listen(createCoreServiceIngress({ secret: SECRET, now: () => clock }));
  try {
   const disabled = createCoreGateway({ coreUrl: disabledHost.origin, secret: SECRET, now: () => clock });
   assert.deepEqual(await disabled.tournamentCapabilities(), { online: false, publicEnabled: false, tables: [] });
  } finally { await disabledHost.close(); }
 });
 await t.test('anonymous/spoofed actor, cookie cross-origin and privileged commands cannot create a room', async () => {
  const command = { type: 'publicJoin', table: 'low' };
  assert.equal((await request('/api/party/command', { body: command, key: 'anonymous', headers: { 'x-service-actor': roster[0], 'x-actor-id': roster[0] } })).status, 401);
  assert.equal((await request('/api/party/command', { actor: roster[0], body: command, key: 'origin', headers: { origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await request('/api/party/command', { actor: roster[0], body: command })).status, 400);
  for (const input of [{ ...command, actor: roster[1] }, { ...command, scope: 'operator' }, { ...command, name: 'forged' }, { type: 'cancel', id: 'room' }]) {
   assert.equal((await request('/api/party/command', { actor: roster[0], body: input, key: 'invalid' })).status, 400);
  }
  assert.equal((await pools.core.query('SELECT count(*)::int AS n FROM tournament.rooms')).rows[0].n, 0);
 });
 await t.test('join replay seats once; conflicting key refuses; verified stored name and member-only reads', async () => {
  const joined = await request('/api/party/command', { actor: roster[0], key: 'join-0', body: { type: 'publicJoin', table: 'low' } });
  assert.equal(joined.status, 200); room = joined.data;
  assert.equal(room.players[0].name, 'player_webt0'); assert.equal(room.players.length, 1);
  assert.deepEqual((await request('/api/party/command', { actor: roster[0], key: 'join-0', body: { type: 'publicJoin', table: 'low' } })).data, room);
  const conflict = await request('/api/party/command', { actor: roster[0], key: 'join-0', body: { type: 'publicJoin', table: 'medium' } });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await request(`/api/party/rooms/${room.id}`, { actor: roster[10] })).status, 403);
  assert.equal((await request(`/api/party/rooms/${room.id}`)).status, 401);
  assert.equal((await request('/api/party/rooms/room%2Fbad', { actor: roster[0] })).status, 400);
 });
 await t.test('signed ingress rejects raw-body tampering, forged actor and expired signatures without writes', async () => {
  const path = '/ingress/tournaments/command', actor = roster[10], opKey = 'signed';
  const body = JSON.stringify({ actor, opKey, command: { type: 'publicJoin', table: 'low' } });
  const signature = signRequest({ secret: SECRET, timestamp: String(clock), path, actor, opKey, bodyString: body });
  async function raw(payload, actorHeader = actor, timestamp = String(clock), sig = signature) {
   const response = await fetch(host.origin + path, { method: 'POST', body: payload, headers: { 'content-type': 'application/json',
    'x-service-timestamp': timestamp, 'x-service-actor': actorHeader, 'x-service-opkey': opKey, 'x-service-signature': sig } });
   return response.status;
  }
  assert.equal(await raw(body.replace('low', 'high')), 403);
  assert.equal(await raw(body, roster[0]), 403);
  const expired = String(clock - 30001);
  assert.equal(await raw(body, actor, expired, signRequest({ secret: SECRET, timestamp: expired, path, actor, opKey, bodyString: body })), 401);
  const forced = JSON.stringify({ actor, opKey, command: { type: 'cancel', id: room.id } });
  assert.equal(await raw(forced, actor, String(clock), signRequest({ secret: SECRET, timestamp: String(clock), path, actor, opKey, bodyString: forced })), 400);
  assert.equal((await tournaments.view(room.id, roster[0])).players.length, 1);
 });
 await t.test('ten real HTTP seats ready once; entry reservation remains Core-only and API role cannot mutate it', async () => {
  for (const actor of roster.slice(1, 10)) {
   const next = await request('/api/party/command', { actor, key: `join-${actor}`, body: { type: 'publicJoin', table: 'low' } });
   assert.equal(next.status, 200); assert.equal(next.data.id, room.id); room = next.data;
  }
  for (const actor of roster.slice(0, 10)) {
   const next = await request('/api/party/command', { actor, key: `ready-${actor}`, body: { type: 'ready', id: room.id, value: true, rulesVersion: room.rulesVersion } });
   assert.equal(next.status, 200); room = next.data;
  }
  assert.equal(room.status, 'RUNNING'); assert.equal(room.escrow, 1000);
  const wallets = (await pools.core.query('SELECT coins, reserved_coins FROM economy.wallets WHERE actor_id = ANY($1::text[])', [roster.slice(0, 10)])).rows;
  assert.ok(wallets.every(wallet => Number(wallet.coins) === 900 && Number(wallet.reserved_coins) === 100));
  await assert.rejects(pools.api.query("UPDATE economy.wallets SET coins = 999999 WHERE actor_id = $1", [roster[0]]), error => error.code === '42501');
  await assert.rejects(pools.api.query('SELECT * FROM tournament.rooms'), error => error.code === '42501');
 });
 await t.test('both players ready, legal move, opponent read, stale retry and outsider rejection use the canonical fixture', async () => {
  const fixture = room.fixtures.find(entry => entry.status === 'READY');
  clock = fixture.opens;
  for (const actor of fixture.players) {
   const next = await request('/api/party/command', { actor, key: `match-ready-${actor}`, body: { type: 'matchReady', id: room.id, fixture: fixture.id } });
   assert.equal(next.status, 200); room = next.data;
  }
  const playing = room.fixtures.find(entry => entry.id === fixture.id);
  assert.equal(playing.status, 'PLAYING');
  const move = G.legal(playing.state)[0], command = { type: 'move', id: room.id, fixture: fixture.id, revision: 0, move };
  const moved = await request('/api/party/command', { actor: playing.players[0], key: 'first-move', body: command });
  assert.equal(moved.status, 200); room = moved.data;
  const opponent = await request(`/api/party/rooms/${room.id}`, { actor: playing.players[1] });
  assert.equal(opponent.data.fixtures.find(entry => entry.id === fixture.id).state.moves.length, 1);
  assert.deepEqual((await request('/api/party/command', { actor: playing.players[0], key: 'first-move', body: command })).data, moved.data);
  assert.equal((await request('/api/party/command', { actor: playing.players[0], key: 'stale-move', body: command })).data.error, 'STALE_REVISION');
  assert.equal((await request('/api/party/command', { actor: roster[10], key: 'outsider-move', body: { ...command, revision: 1 } })).status, 403);
 });
 await t.test('room lease refuses another owner; due tick atomically voids/refunds once without changing Elo', async () => {
  const beforeRatings = (await pools.core.query('SELECT actor_id, rating, games FROM economy.ratings ORDER BY actor_id')).rows;
  await tournaments.claimTimerLease(room.id, { owner: 'other-worker', leaseMs: 1000 });
  assert.deepEqual(await tournaments.tickTimer(room.id, { owner: 'this-worker' }), { claimed: false, changed: false });
  clock += 1001;
  const early = await tournaments.tickTimer(room.id, { owner: 'this-worker' });
  assert.equal(early.claimed, true); assert.equal(early.changed, false);
  clock = Math.max(...room.fixtures.filter(entry => entry.status === 'READY').map(entry => entry.expires)) + 1;
  await lab.installSql(database, [
   "CREATE FUNCTION ops.web_tournament_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'tournament.settle' THEN RAISE EXCEPTION 'SYNTHETIC_OUTBOX_FAILURE'; END IF; RETURN NEW; END $$",
   'CREATE TRIGGER web_tournament_fail_outbox BEFORE INSERT ON ops.outbox FOR EACH ROW EXECUTE FUNCTION ops.web_tournament_fail_outbox()',
  ]);
  await assert.rejects(tournaments.tickTimer(room.id, { owner: 'rollback-worker' }), /SYNTHETIC_OUTBOX_FAILURE/);
  assert.equal((await tournaments.view(room.id, roster[0])).status, 'RUNNING', 'failed settlement rolls the timer transition back too');
  assert.equal((await pools.core.query('SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id LIKE $1', [`${room.id}:refund:%`])).rows[0].n, 0);
  await lab.installSql(database, ['DROP TRIGGER web_tournament_fail_outbox ON ops.outbox', 'DROP FUNCTION ops.web_tournament_fail_outbox()']);
  const raced = await Promise.all([tournaments.tickTimer(room.id, { owner: 'worker-a' }), tournaments.tickTimer(room.id, { owner: 'worker-b' })]);
  assert.equal(raced.filter(result => result.changed).length, 1);
  const final = await tournaments.view(room.id, roster[0]);
  assert.equal(final.status, 'VOID'); assert.equal(final.settled, true); assert.equal(final.receipt.refunded, true); assert.equal(final.escrow, 0);
  const wallets = (await pools.core.query('SELECT coins, reserved_coins FROM economy.wallets WHERE actor_id = ANY($1::text[])', [roster.slice(0, 10)])).rows;
  assert.ok(wallets.every(wallet => Number(wallet.coins) === 1000 && Number(wallet.reserved_coins) === 0));
  assert.equal((await pools.core.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id LIKE $1", [`${room.id}:refund:%`])).rows[0].n, 10);
  assert.equal((await pools.core.query('SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = $1', [`tournament.settle:${room.id}`])).rows[0].n, 1);
  assert.deepEqual((await pools.core.query('SELECT actor_id, rating, games FROM economy.ratings ORDER BY actor_id')).rows, beforeRatings);
  assert.equal((await tournaments.tickTimer(room.id, { owner: 'worker-retry' })).changed, false);
 });
 await t.test('canonical timeout/no-show/private completion and lobby expiry persist through bounded rotating sweep', async () => {
  let key = 0;
  const run = (actor, command) => tournaments.run({ actor, scope: 'player', name: actor }, `private-${key++}`, command);
  let duel = await run(roster[0], { type: 'create', format: 'duel', clock: 120, increment: 1 });
  await run(roster[1], { type: 'join', id: duel.id });
  for (const actor of roster.slice(0, 2)) duel = await run(actor, { type: 'ready', id: duel.id, value: true, rulesVersion: duel.rulesVersion });
  duel = await run(roster[0], { type: 'start', id: duel.id });
  clock = duel.fixtures[0].opens;
  for (const actor of duel.fixtures[0].players) duel = await run(actor, { type: 'matchReady', id: duel.id, fixture: duel.fixtures[0].id });
  clock += 120001;
  await tournaments.tickTimer(duel.id, { owner: 'clock-worker' });
  const timed = await tournaments.view(duel.id, roster[0]);
  assert.equal(timed.status, 'COMPLETE'); assert.equal(timed.fixtures[0].reason, 'timeout');
  let noShow = await run(roster[0], { type: 'create', format: 'duel' });
  await run(roster[1], { type: 'join', id: noShow.id });
  for (const actor of roster.slice(0, 2)) noShow = await run(actor, { type: 'ready', id: noShow.id, value: true, rulesVersion: noShow.rulesVersion });
  noShow = await run(roster[0], { type: 'start', id: noShow.id }); clock = noShow.fixtures[0].opens;
  noShow = await run(roster[0], { type: 'matchReady', id: noShow.id, fixture: noShow.fixtures[0].id });
  clock += 45000; await tournaments.tickTimer(noShow.id, { owner: 'no-show-worker' });
  assert.equal((await tournaments.view(noShow.id, roster[0])).fixtures[0].reason, 'no-show');
  const lobbies = [];
  for (let i = 0; i < 3; i++) lobbies.push(await run(roster[0], { type: 'create', format: 'duel' }));
  clock = Math.max(...lobbies.map(entry => entry.expires)) + 1;
  for (let i = 0; i < 4; i++) {
   const swept = await tournaments.sweepTimers({ owner: 'rotating-worker', limit: 1 });
   assert.ok(swept.scanned <= 1);
  }
  for (const lobby of lobbies) assert.equal((await tournaments.view(lobby.id, roster[0])).reason, 'LOBBY_EXPIRED');
 });
 await t.test('a complete public table settles its canonical ten-place payout once through HTTP', async () => {
  const beforeRatings = (await pools.core.query('SELECT actor_id, rating, games FROM economy.ratings ORDER BY actor_id')).rows;
  let nextRoom;
  for (const actor of roster.slice(0, 10)) {
   const joined = await request('/api/party/command', { actor, key: `completed-join-${actor}`, body: { type: 'publicJoin', table: 'low' } });
   assert.equal(joined.status, 200); nextRoom = joined.data;
  }
  for (const actor of roster.slice(0, 10)) {
   const ready = await request('/api/party/command', { actor, key: `completed-ready-${actor}`, body: { type: 'ready', id: nextRoom.id, value: true, rulesVersion: nextRoom.rulesVersion } });
   assert.equal(ready.status, 200); nextRoom = ready.data;
  }
  let last, step = 0;
  // Canonical resign is legal for a READY fixture; every round and placement
  // is still selected by T, never assigned by a test or trusted client result.
  while (nextRoom.status === 'RUNNING' && step < 100) {
   const fixture = nextRoom.fixtures.find(entry => entry.status === 'READY');
   assert.ok(fixture, 'the canonical schedule must expose its next fixture');
   clock = Math.max(clock, fixture.opens);
   last = { actor: fixture.players[0], key: `completed-resign-${step++}`, body: { type: 'resign', id: nextRoom.id, fixture: fixture.id } };
   const resigned = await request('/api/party/command', last);
   assert.equal(resigned.status, 200); nextRoom = resigned.data;
  }
  assert.equal(nextRoom.status, 'COMPLETE'); assert.equal(nextRoom.settled, true); assert.equal(nextRoom.receipt.refunded, false);
  assert.deepEqual(nextRoom.receipt.payouts, nextRoom.ranking.map((id, index) => ({ id, amount: T.prize('low').payouts[index] })));
  assert.deepEqual((await request('/api/party/command', last)).data, nextRoom);
  assert.equal((await pools.core.query('SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id LIKE $1', [`${nextRoom.id}:payout:%`])).rows[0].n, 10);
  assert.equal((await pools.core.query('SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = $1', [`tournament.settle:${nextRoom.id}`])).rows[0].n, 1);
  for (let index = 0; index < nextRoom.ranking.length; index++) {
   const wallet = (await pools.core.query('SELECT coins, reserved_coins FROM economy.wallets WHERE actor_id = $1', [nextRoom.ranking[index]])).rows[0];
   assert.equal(Number(wallet.coins), 900 + T.prize('low').payouts[index]); assert.equal(Number(wallet.reserved_coins), 0);
  }
  assert.deepEqual((await pools.core.query('SELECT actor_id, rating, games FROM economy.ratings ORDER BY actor_id')).rows, beforeRatings);
 });
});
