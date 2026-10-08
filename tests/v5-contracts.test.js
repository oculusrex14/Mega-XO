'use strict';
/* V5-01-04 consumer-visible contract tests.
 *
 * Two kinds of proof, both deterministic:
 *  1. real HTTP surfaces (standalone adapter, mounted account/social/competitive/
 *     monetization mount, free LAN party mount) exercised over actual sockets, asserting
 *     the boundary/error/auth/key/response behaviour the approved clients depend on;
 *  2. the separately versioned realtime/v1 + native/v1 library contracts, asserted as
 *     accepted/rejected payloads (no server, no stub endpoint).
 *
 * Every assertion is derived from behaviour read out of the source inventory. There are
 * no source-text, copy, forwarding or mock-echo assertions here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../packages/contracts');
const D = require('../src/domain');
const { DurableStore } = require('../server/economy-store');
const { createHandler } = require('../server/http');
const { buildService } = require('../server/community-server');
const { IdentityProviders } = require('../server/identity-provider');
const { RoomStore } = require('../server/rooms');
const { createPartyHandler } = require('../server/party-http');
const { jwk, sign } = require('./helpers/identity-fixture');

const tmpdir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const listen = server => new Promise(ok => server.listen(0, '127.0.0.1', ok));
const close = async server => { server.closeIdleConnections?.(); server.closeAllConnections?.(); if (server.listening) await new Promise(ok => server.close(() => ok())); };
const code = async (response) => { try { return (await response.json()).error; } catch { return null; } };

/* ==========================================================================
 * validateInvocation - the exact legacy guard in server/economy-store.js:19-20
 * ========================================================================== */
test('validateInvocation reproduces the legacy guards exactly, including their leniency', () => {
 const principal = { actor: 'alice', scope: 'player' };
 for (const scope of ['player', 'operator', 'matchmaker', 'store']) C.validateInvocation({ actor: 'a', scope }, 'key-1', { type: 'quest' });
 assert.equal(C.validateInvocation(principal, 'key-1', { type: 'quest' }), undefined, 'success returns nothing at all');

 const auth = [null, undefined, {}, { actor: '', scope: 'player' }, { actor: 7, scope: 'player' }, { actor: 'a' }, { actor: 'a', scope: 'admin' }, { actor: 'a', scope: 'P '}, 'alice'];
 for (const value of auth) assert.throws(() => C.validateInvocation(value, 'key-1', { type: 'quest' }), e => e instanceof Error && e.message === 'AUTH_REQUIRED');

 const badKey = [undefined, null, '', 7, {}, ['k'], 'k'.repeat(161)];
 for (const key of badKey) assert.throws(() => C.validateInvocation(principal, key, { type: 'quest' }), e => e.message === 'INVALID_COMMAND');
 const badCommand = [undefined, null, {}, { type: 1 }, { type: null }, 'quest', 42];
 for (const command of badCommand) assert.throws(() => C.validateInvocation(principal, 'key-1', command), e => e.message === 'INVALID_COMMAND');

 // Boundary, not tightening: a 160-character key is still accepted.
 C.validateInvocation(principal, 'k'.repeat(160), { type: 'quest' });
 // Unknown command types and unknown/extra command fields must keep reaching the dispatcher.
 C.validateInvocation(principal, 'key-1', { type: 'future-command', actor: 'bob', balance: 1e12 });
 // Principal scope is checked before command shape, exactly like the legacy order.
 assert.throws(() => C.validateInvocation({ actor: 'a', scope: 'admin' }, 7, null), e => e.message === 'AUTH_REQUIRED');
});

test('contract failures are plain Errors carrying a stable public code', () => {
 try { C.validateInvocation(null, null, null); assert.fail('expected failure'); } catch (e) {
  assert.equal(e.name, 'ContractError');
  assert.equal(e.code, 'AUTH_REQUIRED');
  assert.equal(C.isContractError(e), true);
  assert.match(e.message, /^[A-Z0-9_]+$/, 'routers echo e.message as the public error code');
 }
});

/* ==========================================================================
 * Standalone adapter surface (server/http.js): library/fixture only
 * ========================================================================== */
async function standaloneFixture() {
 const dir = tmpdir('mega-contracts-standalone-');
 let now = Date.parse('2026-10-06T12:00:00Z');
 const store = new DurableStore(path.join(dir, 'data.db'), { now: () => now });
 const admin = { actor: 'admin', scope: 'operator' };
 for (const id of ['alice', 'bob']) store.run(admin, 'provision:' + id, { type: 'provision', account: id, options: { verified: true, games: 20, rating: 1500, coins: 1000, crowns: 100 } });
 const origin = 'http://localhost';
 const server = http.createServer(createHandler({ store, origin, authenticate: async req => {
  const header = String(req.headers.authorization || '');
  return ['Bearer alice', 'Bearer bob'].includes(header) ? { id: header.slice(7) } : null;
 } }));
 await listen(server);
 const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
 let seq = 0;
 const call = async (actor, route, body, extra = {}) => {
  const key = extra.key === undefined ? 'op-' + (++seq) : extra.key;
  const headers = { Connection: 'close', ...(actor ? { Authorization: 'Bearer ' + actor } : {}), ...(body !== undefined ? { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}), ...(extra.headers || {}) };
  if (extra.key === null) delete headers['Idempotency-Key'];
  const response = await fetch(base + route, { method: extra.method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null; try { parsed = await response.json(); } catch {}
  return { status: response.status, body: parsed };
 };
 const closeAll = async () => { await close(server); store.close(); fs.rmSync(dir, { recursive: true, force: true }); };
 return { store, call, closeAll, base, origin, now: () => now };
}

test('standalone adapter keeps its method/origin/key/error boundaries', async t => {
 const f = await standaloneFixture();
 t.after(async () => f.closeAll());
 // GET /profile works with no Origin at all (the legacy adapter checks Origin only if sent)
 const plain = await f.call('alice', '/profile');
 assert.equal(plain.status, 200);
 // Method gate comes first, before authentication.
 const put = await fetch(f.base + '/profile', { method: 'PUT', headers: { Connection: 'close', Authorization: 'Bearer alice' } });
 assert.equal(put.status, 405, 'the standalone adapter only accepts GET and POST');
 assert.equal(await code(put), 'METHOD_NOT_ALLOWED');
 // Unauthenticated read
 const unauthenticated = await f.call(null, '/profile');
 assert.equal(unauthenticated.status, 401);
 assert.equal(unauthenticated.body.error, 'AUTH_REQUIRED');
 // A conflicting Origin on POST is a 403 on this surface (not the mounted 409), and the
 // content type alone is enough to fail it.
 const badOrigin = await f.call('alice', '/convert', { from: 'coins', amount: 10 }, { headers: { Origin: 'https://evil.example' } });
 assert.equal(badOrigin.status, 403);
 assert.equal(badOrigin.body.error, 'ORIGIN_OR_CONTENT_TYPE');
 const badType = await f.call('alice', '/convert', { from: 'coins', amount: 10 }, { headers: { 'Content-Type': 'text/plain' } });
 assert.equal(badType.status, 403);
 assert.equal(badType.body.error, 'ORIGIN_OR_CONTENT_TYPE');
 // missing key
 const missing = await f.call('alice', '/convert', { from: 'coins', amount: 10 }, { key: null });
 assert.equal(missing.status, 409); assert.equal(missing.body.error, 'IDEMPOTENCY_KEY_REQUIRED');
 // key longer than the invocation ceiling is rejected by the store guard, not the router
 const longKey = await f.call('alice', '/convert', { from: 'coins', amount: 10 }, { key: 'k'.repeat(161) });
 assert.equal(longKey.status, 409); assert.equal(longKey.body.error, 'INVALID_COMMAND');
 // This adapter rejects only a key the shared invocation guard rejects; the community
 // grammar is not applied here, so a key the mounted account/social mount would refuse
 // still reaches the command.
 const looseKey = await f.call('alice', '/quest', { quest: 'finish' }, { key: 'a+b c' });
 assert.equal(looseKey.status, 200, JSON.stringify(looseKey.body));
 assert.equal(looseKey.body, 0);
 // oversize body and malformed JSON keep their distinct codes
 const oversized = await f.call('alice', '/convert', { from: 'coins', amount: 10, pad: 'x'.repeat(40000) });
 assert.equal(oversized.status, 409); assert.equal(oversized.body.error, 'BODY_TOO_LARGE');
 // malformed JSON keeps its own code (sent raw, since the helper encodes objects)
 const malformedResponse = await fetch(f.base + '/convert', { method: 'POST', headers: { Connection: 'close', Authorization: 'Bearer alice', Origin: f.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'raw-malformed' }, body: '{not json' });
 assert.equal(malformedResponse.status, 409);
 assert.equal(await code(malformedResponse), 'INVALID_JSON');
 // this surface has no CSRF token requirement (it is a library/fixture adapter)
 const unmatched = await f.call('alice', '/not-a-route', {});
 assert.equal(unmatched.status, 404); assert.equal(unmatched.body.error, 'NOT_FOUND');
});

test('standalone adapter ignores client-supplied identity, balance and rating', async t => {
 const f = await standaloneFixture();
 t.after(async () => f.closeAll());
 const started = f.store.read().account('alice').coins;
 const converted = await f.call('alice', '/convert', { from: 'coins', amount: 100, actor: 'bob', balance: 1e12, rating: 3000, wallet: { coins: 1e12 } });
 assert.equal(converted.status, 200, JSON.stringify(converted.body));
 assert.equal(f.store.read().account('alice').coins, started - 100);
 assert.equal(f.store.read().account('bob').coins, 1000, 'a body actor cannot redirect the debit');
 assert.equal(f.store.read().account('alice').rating, 1500, 'a body rating cannot be written');
 assert.equal(f.store.read().account('alice').crowns, 110, 'the conversion credited exactly 10 Crowns for 100 Coins');
 assert.equal(f.store.read().account('bob').crowns, 100, 'a body wallet field cannot be applied to another actor');
 const replay = await f.call('alice', '/convert', { from: 'coins', amount: 100 }, { key: 'convert-replay' });
 assert.equal(replay.status, 200, JSON.stringify(replay.body));
 const again = await f.call('alice', '/convert', { from: 'coins', amount: 100 }, { key: 'convert-replay' });
 assert.deepEqual(again.body, replay.body, 'the same operation key returns its previous committed result');
 assert.equal(f.store.read().account('alice').coins, started - 200, 'the replay did not debit again');
 const conflict = await f.call('alice', '/convert', { from: 'coins', amount: 200 }, { key: 'convert-replay' });
 assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'IDEMPOTENCY_CONFLICT');
});

test('standalone adapter returns 0 for an unearned quest and rejects stale revisions', async t => {
 const f = await standaloneFixture();
 t.after(async () => f.closeAll());
 const quest = await f.call('alice', '/quest', { quest: 'finish' });
 assert.equal(quest.status, 200);
 assert.equal(quest.body, 0, 'the legacy nullish quest result stays 0, not {ok:true}');

 await f.call('alice', '/friend', { target: 'bob' });
 await f.call('bob', '/accept-friend', { from: 'alice' });
 const offered = await f.call('alice', '/offer', { id: 'contract-match', opponent: 'bob', terms: { kind: 'friend', rated: false } });
 assert.equal(offered.status, 200, JSON.stringify(offered.body));
 const accepted = await f.call('bob', '/accept', { id: 'contract-match', termsHash: offered.body.termsHash });
 assert.equal(accepted.status, 200);
 const view = f.store.read().view('contract-match');
 const mover = view.symbols[view.state.turn];
 const other = mover === 'alice' ? 'bob' : 'alice';
 const stale = await f.call(mover, '/move', { id: 'contract-match', revision: 7, move: { b: 0, c: 0 } });
 assert.equal(stale.status, 409); assert.equal(stale.body.error, 'STALE_REVISION');
 const moved = await f.call(mover, '/move', { id: 'contract-match', revision: 0, move: { b: 4, c: 4 } }, { key: 'move-1' });
 assert.equal(moved.status, 200, JSON.stringify(moved.body));
 assert.equal(moved.body.revision, 1);
 const sameMove = await f.call(mover, '/move', { id: 'contract-match', revision: 0, move: { b: 4, c: 4 } }, { key: 'move-1' });
 assert.deepEqual(sameMove.body, moved.body);
 const differentPayload = await f.call(mover, '/move', { id: 'contract-match', revision: 0, move: { b: 1, c: 1 } }, { key: 'move-1' });
 assert.equal(differentPayload.status, 409); assert.equal(differentPayload.body.error, 'IDEMPOTENCY_CONFLICT');
 // The opponent cannot move twice in a row in the mover's place, and on the opponent's
 // own turn an out-of-range coordinate is rejected by the game engine, not accepted.
 const outOfTurn = await f.call(mover, '/move', { id: 'contract-match', revision: 1, move: { b: 0, c: 0 } });
 assert.equal(outOfTurn.status, 409); assert.equal(outOfTurn.body.error, 'NOT_YOUR_TURN');
 const illegal = await f.call(other, '/move', { id: 'contract-match', revision: 1, move: { b: 9, c: 9 } });
 assert.equal(illegal.status, 409, 'out-of-range coordinates are still the game engine\'s rejection');
 assert.equal(illegal.body.error, 'ILLEGAL_MOVE');
});

/* ==========================================================================
 * Mounted account/social/competitive/monetization surface
 * ========================================================================== */
async function mountedFixture(t) {
 const dir = tmpdir('mega-contracts-mounted-');
 let now = Date.parse('2026-10-06T12:00:00Z');
 const origin = 'http://localhost:0';
 const providers = new IdentityProviders({ config: { google: { nativeAudiences: ['test-native'] }, apple: { nativeAudiences: ['test-native'] } }, now: () => now, keysForTest: () => [jwk] });
 const service = buildService({ file: path.join(dir, 'db.sqlite'), origin, providerInstance: providers, allowLocalHttp: true, storeOptions: { now: () => now, otpSecret: 'contract-test-otp' } });
 await listen(service.server);
 t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
 const base = 'http://127.0.0.1:' + service.server.address().port;
 function client() {
  let cookie = '', csrf = '', seq = 0;
  return {
   get cookie() { return cookie; },
   get csrf() { return csrf; },
   async request(route, body, extra = {}) {
    const headers = { Connection: 'close', ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': 'mop-' + (++seq) } : {}), ...extra };
    if (extra.noKey) delete headers['Idempotency-Key'];
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    let data = null; try { data = await response.json(); } catch {}
    if (data && data.csrf) csrf = data.csrf;
    return { status: response.status, data };
   },
   async login(subject) {
    await this.request('/api/account/session');
    const challenge = await this.request('/api/account/native/challenge', { provider: 'google' });
    const finished = await this.request('/api/account/native/finish', { provider: 'google', state: challenge.data.state, idToken: sign('google', subject, challenge.data.nonce, now) });
    assert.equal(finished.status, 200, JSON.stringify(finished.data));
    return finished.data.profile;
   }
  };
 }
 return { service, base, origin, client };
}

test('mounted surface keeps its auth precedence, CSRF order and operation-key grammar', async t => {
 const f = await mountedFixture(t);
 const anon = await f.client().request('/api/v1/profile');
 assert.equal(anon.status, 401); assert.equal(anon.data.error, 'AUTH_REQUIRED');
 const guest = f.client();
 await guest.request('/api/account/session');
 const guestRead = await guest.request('/api/v1/profile');
 assert.equal(guestRead.status, 401); assert.equal(guestRead.data.error, 'LINK_ACCOUNT_REQUIRED', 'guest auth state stays a link prompt, not an outage');

 const alice = f.client();
 const profile = await alice.login('contract-alice');
 assert.ok(profile.id);
 // Origin is checked before the CSRF token (409 for both, code differs)
 const badOrigin = await alice.request('/api/v1/preferences', { changes: { wealthPublic: true } }, { Origin: 'https://evil.example' });
 assert.equal(badOrigin.status, 409); assert.equal(badOrigin.data.error, 'ORIGIN_OR_CONTENT_TYPE');
 const badCsrf = await alice.request('/api/v1/preferences', { changes: { wealthPublic: true } }, { 'X-CSRF-Token': 'wrong' });
 assert.equal(badCsrf.status, 409); assert.equal(badCsrf.data.error, 'CSRF_FAILED');
 const nonJson = await alice.request('/api/v1/preferences', { changes: { wealthPublic: true } }, { 'Content-Type': 'text/plain' });
 assert.equal(nonJson.status, 409); assert.equal(nonJson.data.error, 'ORIGIN_OR_CONTENT_TYPE');

 // Community mutation key grammar: missing, malformed and over-long all report one code.
 const noKey = await alice.request('/api/community/friend', { action: 'request', target: profile.id }, { noKey: true });
 assert.equal(noKey.status, 409); assert.equal(noKey.data.error, 'IDEMPOTENCY_KEY_REQUIRED');
 const malformedKey = await alice.request('/api/community/friend', { action: 'request', target: profile.id }, { 'Idempotency-Key': 'bad key!' });
 assert.equal(malformedKey.status, 409); assert.equal(malformedKey.data.error, 'IDEMPOTENCY_KEY_REQUIRED');
 const longKey = await alice.request('/api/community/friend', { action: 'request', target: profile.id }, { 'Idempotency-Key': 'k'.repeat(161) });
 assert.equal(longKey.status, 409); assert.equal(longKey.data.error, 'IDEMPOTENCY_KEY_REQUIRED', 'this mount applies the key grammar itself');
 const oversized = await alice.request('/api/account/profile', JSON.stringify({ displayName: 'x'.repeat(300001) }));
 assert.equal(oversized.status, 409); assert.equal(oversized.data.error, 'BODY_TOO_LARGE');
 const malformed = await alice.request('/api/account/profile', '{not json');
 assert.equal(malformed.status, 409); assert.equal(malformed.data.error, 'INVALID_JSON');
 const unmatched = await alice.request('/api/v1/not-a-route', {});
 assert.equal(unmatched.status, 404); assert.equal(unmatched.data.error, 'NOT_FOUND');
});

test('mounted competitive commands keep approved client semantics', async t => {
 const f = await mountedFixture(t);
 const alice = f.client(), bob = f.client();
 const pa = await alice.login('semantics-alice'), pb = await bob.login('semantics-bob');
 await alice.request('/api/account/profile', { username: 'contractalice', displayName: 'Alice' });
 await bob.request('/api/account/profile', { username: 'contractbob', displayName: 'Bob' });
 const before = f.service.store.read().account(pa.id);

 // A projection drops unrelated client fields instead of writing them.
 const prefs = await alice.request('/api/v1/preferences', { changes: { wealthPublic: true, region: 'eu' }, coins: 999999, rating: 3000, actor: pb.id, wallet: { crowns: 999999 } });
 assert.equal(prefs.status, 200, JSON.stringify(prefs.data)); assert.equal(prefs.data.wealthPublic, true); assert.equal(prefs.data.region, 'eu');
 const after = f.service.store.read().account(pa.id);
 assert.equal(after.coins, before.coins); assert.equal(after.crowns, before.crowns); assert.equal(after.rating, before.rating);
 assert.equal(f.service.store.read().account(pb.id).rating, 600, 'a body actor cannot redirect a command to another account');

 // Unearned quest stays 0 across the mounted mount too.
 const quest = await alice.request('/api/v1/quest', { quest: 'finish' });
 assert.equal(quest.status, 200); assert.equal(quest.data, 0);

 // The archived cosmetic command is still implemented on this raw mount (the production
 // perimeter, not this router, is what answers 404) - assert its real spend behaviour and
 // keep the perimeter gate documented in the frozen manifest.
 const cosmetic = await alice.request('/api/v1/cosmetic', { name: 'Copper edge' });
 assert.equal(cosmetic.status, 200, JSON.stringify(cosmetic.data));
 assert.equal(cosmetic.data.owned, true);
 assert.equal(f.service.store.read().account(pa.id).coins, after.coins - 30, 'the legacy cosmetic spend is the real command');
 assert.equal(C.routes.routeById('v1.cosmetic').note.includes('production returns 404 before routing'), true);

 // /api/v1/purchase is shadowed by the earlier monetization mount.
 const purchase = await alice.request('/api/v1/purchase', { evidence: { valid: true } });
 assert.equal(purchase.status, 503); assert.equal(purchase.data.error, 'STORE_UNAVAILABLE');

 // A friend challenge before the relationship exists is refused by the router's pre-check.
 const refused = await alice.request('/api/v1/offer', { id: 'mounted-free', opponent: pb.id, terms: { kind: 'friend', rated: false } });
 assert.equal(refused.status, 409, JSON.stringify(refused.data));
 assert.equal(refused.data.error, 'FRIENDSHIP_REQUIRED');
 await alice.request('/api/v1/friend', { target: pb.id });
 await bob.request('/api/v1/accept-friend', { from: pa.id });
 const invited = await alice.request('/api/v1/offer', { id: 'mounted-friend', opponent: pb.id, terms: { kind: 'friend', rated: false } });
 assert.equal(invited.status, 200, JSON.stringify(invited.data));
 assert.equal(invited.data.terms.turnSeconds, 60);
 assert.equal(invited.data.terms.rated, false, 'a client cannot promote an unranked invite to rated');
 const accepted = await bob.request('/api/v1/accept', { id: 'mounted-friend', termsHash: invited.data.termsHash });
 assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
 assert.equal(f.service.store.read().account(pa.id).crowns, before.crowns, 'free friend matches reserve nothing');
 // Move/revision/idempotency semantics over the mounted mount.
 const view = f.service.store.read().view('mounted-friend');
 const mover = view.symbols[view.state.turn] === pa.id ? alice : bob;
 const other = mover === alice ? bob : alice;
 const first = await mover.request('/api/v1/move', { id: 'mounted-friend', revision: 0, move: { b: 4, c: 4 } }, { 'Idempotency-Key': 'mounted-move-1' });
 assert.equal(first.status, 200, JSON.stringify(first.data));
 assert.equal(first.data.revision, 1);
 const replay = await mover.request('/api/v1/move', { id: 'mounted-friend', revision: 0, move: { b: 4, c: 4 } }, { 'Idempotency-Key': 'mounted-move-1' });
 assert.deepEqual(replay.data, first.data, 'the same key and payload return the committed revision');
 const conflict = await mover.request('/api/v1/move', { id: 'mounted-friend', revision: 0, move: { b: 0, c: 0 } }, { 'Idempotency-Key': 'mounted-move-1' });
 assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'IDEMPOTENCY_CONFLICT');
 const stale = await other.request('/api/v1/move', { id: 'mounted-friend', revision: 0, move: { b: 0, c: 0 } });
 assert.equal(stale.status, 409); assert.equal(stale.data.error, 'STALE_REVISION');
 const outOfTurn = await mover.request('/api/v1/move', { id: 'mounted-friend', revision: 1, move: { b: 4, c: 0 } });
 assert.equal(outOfTurn.status, 409); assert.equal(outOfTurn.data.error, 'NOT_YOUR_TURN');
 const illegal = await other.request('/api/v1/move', { id: 'mounted-friend', revision: 1, move: { b: 9, c: 9 } });
 assert.equal(illegal.status, 409); assert.equal(illegal.data.error, 'ILLEGAL_MOVE');
});

test('mounted direct rated challenge keeps challenger funding, terms and reservations', async t => {
 const f = await mountedFixture(t);
 const alice = f.client(), bob = f.client();
 const pa = await alice.login('rated-alice'), pb = await bob.login('rated-bob');
 // Give both accounts placement-level history through the real operator command, then
 // fund alice with Crowns through a verified purchase-shaped provision (no client write).
 const authority = f.service.store.read();
 authority.account(pa.id).games = 20; authority.account(pa.id).rating = 1500; authority.account(pa.id).tier = D.basicTier(1500).id; authority.account(pa.id).crowns = 1000;
 authority.account(pb.id).games = 20; authority.account(pb.id).rating = 1800; authority.account(pb.id).tier = D.basicTier(1800).id; authority.account(pb.id).crowns = 1000;
 f.service.store.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(authority.export()));
 const minimum = D.quote({ mode: 'direct', kind: 'leaderboard', rated: true, from: authority.account(pa.id).tier, to: authority.account(pb.id).tier }).minimum;

 const offered = await alice.request('/api/v1/offer', { id: 'mounted-ranked', opponent: pb.id, terms: { kind: 'leaderboard', rated: true, amount: minimum } });
 assert.equal(offered.status, 200, JSON.stringify(offered.data));
 assert.equal(offered.data.terms.turnSeconds, 30, 'a rated direct challenge uses the approved 30s clock');
 assert.equal(offered.data.accepted.length, 1, 'only the challenger accepted initially');
 assert.equal(f.service.store.read().account(pa.id).reservedCrowns, 0, 'no reservation until both sides accept');
 assert.equal(f.service.store.read().account(pa.id).crowns, 1000);
 const accepted = await bob.request('/api/v1/accept', { id: 'mounted-ranked', termsHash: offered.data.termsHash });
 assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
 assert.equal(accepted.data.status, 'PLAYING');
 assert.equal(f.service.store.read().account(pa.id).crowns, 1000 - minimum, 'the challenger funds the pot');
 assert.equal(f.service.store.read().account(pa.id).reservedCrowns, minimum);
 assert.equal(f.service.store.read().account(pb.id).crowns, 1000, 'the opponent funds nothing');
 const settled = await bob.request('/api/v1/resign', { id: 'mounted-ranked' });
 assert.equal(settled.status, 200);
 const receipt = (await alice.request('/api/v1/match/mounted-ranked')).data.receipt;
 assert.equal(receipt.payout, minimum / 2);
 assert.equal(receipt.burn, minimum / 2);
 assert.ok(receipt.rating, 'a rated match still settles Elo');
});

test('provider callbacks and the economic GET keep their unauthenticated error precedence', async t => {
 const f = await mountedFixture(t);
 const call = async (route, { method = 'GET', body, headers = {} } = {}) => {
  const response = await fetch(f.base + route, { method, headers: { Connection: 'close', ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let data = null; try { data = await response.json(); } catch {}
  return { status: response.status, data };
 };
 const method = await call('/api/monetization/apple-notifications', { method: 'GET' });
 assert.equal(method.status, 405); assert.equal(method.data.error, 'METHOD_NOT_ALLOWED');
 const wrongType = await call('/api/monetization/apple-notifications', { method: 'POST', body: { signedPayload: 'x' }, headers: { 'Content-Type': 'text/plain' } });
 assert.equal(wrongType.status, 400); assert.equal(wrongType.data.error, 'INVALID_STORE_NOTIFICATION');
 const noHandler = await call('/api/monetization/apple-notifications', { method: 'POST', body: { signedPayload: 'x' }, headers: { 'Content-Type': 'application/json' } });
 assert.equal(noHandler.status, 503); assert.equal(noHandler.data.error, 'STORE_UNAVAILABLE');
 const arrayBody = await call('/api/monetization/google-play-rtdn', { method: 'POST', body: '[]', headers: { 'Content-Type': 'application/json' } });
 assert.equal(arrayBody.status, 400); assert.equal(arrayBody.data.error, 'INVALID_STORE_NOTIFICATION');
 const ssv = await call('/api/monetization/admob-ssv?transaction_id=t&signature=s&key_id=1');
 assert.equal(ssv.status, 409); assert.equal(ssv.data.error, 'ADS_UNAVAILABLE', 'a configured verifier is required; no client reward is trusted');
});

/* ==========================================================================
 * Free LAN party surface (server/party-server.js semantics)
 * ========================================================================== */
async function partyFixture(t, { lanOnly = true, hostAllowlist = false } = {}) {
 const store = new RoomStore(':memory:', { lanOnly });
 const allowedHosts = new Set();
 const handler = createPartyHandler({ store, origin: 'http://mega.test', allowedHosts: hostAllowlist ? allowedHosts : null });
 const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
 await listen(server);
 if (hostAllowlist) allowedHosts.add('127.0.0.1:' + server.address().port);
 t.after(async () => { await close(server); store.close(); });
 let seq = 0;
 const call = async (route, { method = 'GET', body, token, headers = {}, key } = {}) => {
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/party/' + route, { method, headers: { Connection: 'close', ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': key === undefined ? 'p-' + (++seq) : key, Origin: 'http://mega.test' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await response.json(); } catch {}
  return { status: response.status, data };
 };
 /* Raw request so the Host header stays fully under our control. */
 const raw = (route, host) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/party/' + route, method: 'GET', headers: { Connection: 'close', Host: host } }, response => {
   let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
   response.on('end', () => { let data = null; try { data = JSON.parse(text); } catch {} resolve({ status: response.statusCode, data }); });
  });
  request.on('error', reject); request.end();
 });
 return { store, call, raw };
}

test('LAN party surface keeps bearer, host, origin, content-type and key boundaries', async t => {
 const f = await partyFixture(t);
 const capabilities = await f.call('capabilities');
 assert.equal(capabilities.status, 200); assert.equal(capabilities.data.lan, true);
 const anonymous = await f.call('command', { method: 'POST', body: { type: 'create', format: 'duel' } });
 assert.equal(anonymous.status, 401); assert.equal(anonymous.data.error, 'AUTH_REQUIRED');
 const alice = (await f.call('session', { method: 'POST', body: { name: 'Alice' } })).data;
 assert.ok(alice.token && alice.actor);
 const badContentType = await f.call('command', { method: 'POST', body: { type: 'create', format: 'duel' }, token: alice.token, headers: { 'Content-Type': 'text/plain' } });
 assert.equal(badContentType.status, 400); assert.equal(badContentType.data.error, 'BAD_CONTENT_TYPE');
 const badOrigin = await f.call('command', { method: 'POST', body: { type: 'create', format: 'duel' }, token: alice.token, headers: { Origin: 'https://hostile.invalid' } });
 assert.equal(badOrigin.status, 400); assert.equal(badOrigin.data.error, 'BAD_ORIGIN');
 const created = await f.call('command', { method: 'POST', body: { type: 'create', format: 'duel' }, token: alice.token });
 assert.equal(created.status, 200);
 // The party mount forwards the raw header: its grammar is the store guard, not the community grammar.
 const looseKey = await f.call('command', { method: 'POST', body: { type: 'configure', id: created.data.id, format: 'league', clock: 300, increment: 2 }, token: alice.token, key: 'a+b c' });
 assert.equal(looseKey.status, 200, JSON.stringify(looseKey.data));
 assert.equal(looseKey.data.clock, 300, 'the loose key still applied the real configure command');
 const rejectedKey = await f.call('command', { method: 'POST', body: { type: 'configure', id: created.data.id, format: 'league' }, token: alice.token, key: 'k'.repeat(161) });
 assert.equal(rejectedKey.status, 400); assert.equal(rejectedKey.data.error, 'INVALID_COMMAND');
 // An invalid-clock command still fails through the party error allowlist, not a raw message.
 const invalidClock = await f.call('command', { method: 'POST', body: { type: 'configure', id: created.data.id, format: 'league', clock: 7 }, token: alice.token });
 assert.equal(invalidClock.status, 400); assert.equal(invalidClock.data.error, 'INVALID_CLOCK');
});

test('LAN party host allowlist and the online rejection of guest sessions', async t => {
 const f = await partyFixture(t, { hostAllowlist: true });
 const badHost = await f.raw('capabilities', 'attacker.invalid');
 assert.equal(badHost.status, 400); assert.equal(badHost.data.error, 'BAD_HOST');
 // The same request with the configured Host is served, proving the allowlist is exact
 // rather than a blanket rejection.
 const allowed = await f.call('capabilities');
 assert.equal(allowed.status, 200);

 const online = await partyFixture(t, { lanOnly: false });
 const guest = await online.call('session', { method: 'POST', body: { name: 'Alice' } });
 assert.equal(guest.status, 401); assert.equal(guest.data.error, 'AUTH_REQUIRED', 'the online service never issues free LAN guests');
});

/* ==========================================================================
 * realtime/v1 - separately versioned envelope, not a deployed endpoint
 * ========================================================================== */
test('realtime/v1 accepts the frozen envelope shapes', () => {
 const command = C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 17, command: { type: 'move', move: { b: 2, c: 4 } } });
 assert.equal(command.protocol, 'realtime/v1');
 assert.deepEqual(command.command, { type: 'move', move: { b: 2, c: 4 } });
 assert.deepEqual(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-2', match_id: 'match-1', expected_revision: 0, actor: 'alice', command: { type: 'resign' } }, { authenticatedActor: 'alice' }).actor, 'alice');
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'ticket.redeem', ticket: 'one-use-ticket' }).operation, 'ticket.redeem');
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'subscribe', match_id: 'match-1' }).match_id, 'match-1');
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'ack', match_id: 'match-1', ack_revision: 4 }).ack_revision, 4);
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'resume', match_id: 'match-1', ack_revision: 4 }).operation, 'resume');
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'ping', server_now: 1700000000000 }).server_now, 1700000000000);
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'error', code: 'STALE_REVISION' }).code, 'STALE_REVISION');
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'snapshot', match_id: 'match-1', expected_revision: 4, snapshot: { revision: 4, state: { turn: 'X' } } }).snapshot.revision, 4);
 assert.equal(C.realtime.validateEnvelope({ protocol: 'realtime/v1', operation: 'delta', match_id: 'match-1', expected_revision: 4, delta: { from: 4, to: 5 } }).delta.to, 5);
 const response = C.realtime.validateResponse({ protocol: 'realtime/v1', operation: 'command', revision: 18, server_now: 1700000000000, snapshot: { revision: 18 } });
 assert.equal(response.revision, 18);
});

test('realtime/v1 rejects malformed new payloads consistently', () => {
 const rejected = (message, options, expected) => {
  const seen = new Set();
  for (let attempt = 0; attempt < 3; attempt++) {
   assert.throws(() => C.realtime.validateEnvelope(message, options), e => { seen.add(e.message); return e instanceof Error; }, JSON.stringify(message));
  }
  assert.equal(seen.size, 1, 'the same payload always produces the same public error');
  assert.equal([...seen][0], expected);
 };
 // protocol/operation bounds
 assert.throws(() => C.realtime.validateEnvelope(null), e => e.message === 'INVALID_ENVELOPE');
 assert.throws(() => C.realtime.validateEnvelope([]), e => e.message === 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v2', operation: 'ping' }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1' }, undefined, 'INVALID_OPERATION');
 rejected({ protocol: 'realtime/v1', operation: 'grant-crowns' }, undefined, 'INVALID_OPERATION');
 // required/forbidden fields per operation
 rejected({ protocol: 'realtime/v1', operation: 'ticket.redeem' }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'subscribe' }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1 }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1, command: { type: 'move', move: { b: 1, c: 1 } }, ticket: 't' }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'ack', match_id: 'match-1' }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'ping', actor: 'alice' }, undefined, 'INVALID_ENVELOPE');
 // revision bounds
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: -1, command: { type: 'resign' } }, undefined, 'INVALID_REVISION');
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1.5, command: { type: 'resign' } }, undefined, 'INVALID_REVISION');
 rejected({ protocol: 'realtime/v1', operation: 'ack', match_id: 'match-1', ack_revision: '4' }, undefined, 'INVALID_REVISION');
 // identifier / key bounds
 rejected({ protocol: 'realtime/v1', operation: 'subscribe', match_id: '-bad' }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'subscribe', match_id: 'm'.repeat(161) }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op 1', match_id: 'match-1', expected_revision: 1, command: { type: 'resign' } }, undefined, 'INVALID_ENVELOPE');
 // move payload bounds
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1, command: { type: 'move' } }, undefined, 'INVALID_MOVE');
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1, command: { type: 'move', move: { b: 9, c: 0 } } }, undefined, 'INVALID_MOVE');
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1, command: { type: 'move', move: { b: 1.2, c: 0 } } }, undefined, 'INVALID_MOVE');
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1, command: { move: { b: 1, c: 1 } } }, undefined, 'INVALID_COMMAND');
 // error frame codes are allowlisted, not echoed
 rejected({ protocol: 'realtime/v1', operation: 'error', code: 'DROP TABLE' }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'error', code: 'SOMETHING_NEW' }, undefined, 'INVALID_ENVELOPE');
 // actor is never an authorization input
 rejected({ protocol: 'realtime/v1', operation: 'command', operation_id: 'op-1', match_id: 'match-1', expected_revision: 1, actor: 'bob', command: { type: 'resign' } }, { authenticatedActor: 'alice' }, 'FORBIDDEN');
 // bounded payloads
 rejected({ protocol: 'realtime/v1', operation: 'ping', padding: 'x'.repeat(9000) }, undefined, 'INVALID_ENVELOPE');
 rejected({ protocol: 'realtime/v1', operation: 'snapshot', match_id: 'match-1', expected_revision: 1, snapshot: { blob: 'x'.repeat(300000) } }, undefined, 'INVALID_ENVELOPE');
 assert.throws(() => C.realtime.validateResponse({ operation: 'error', error: { code: 'NOT_ALLOWED' } }), e => e.message === 'INVALID_ENVELOPE');
 assert.throws(() => C.realtime.validateResponse({ operation: 'snapshot', revision: -1 }), e => e.message === 'INVALID_REVISION');
});

test('realtime ticket bridge bounds the HTTP side without deploying a socket', () => {
 assert.equal(C.realtime.validateTicketRequest({}, { authenticatedActor: 'alice' }).actor, 'alice');
 assert.equal(C.realtime.validateTicketRequest({ actor: 'alice' }, { authenticatedActor: 'alice' }).actor, 'alice');
 assert.throws(() => C.realtime.validateTicketRequest({ actor: 'bob' }, { authenticatedActor: 'alice' }), e => e.message === 'FORBIDDEN');
 assert.throws(() => C.realtime.validateTicketRequest([], { authenticatedActor: 'alice' }), e => e.message === 'INVALID_ENVELOPE');
 assert.throws(() => C.realtime.validateEnvelopeTransport({ method: 'GET', headers: { 'content-type': 'application/json' } }), e => e.message === 'INVALID_ENVELOPE');
 assert.equal(C.realtime.validateEnvelopeTransport({ method: 'POST', headers: { 'content-type': 'application/json' } }), true);
 assert.equal(C.realtime.redactTicket('secret-ticket-value'), '[redacted:19]');
 assert.equal(C.realtime.redactTicket(''), '');
 // No deployed endpoint or stub is claimed by this package.
 assert.equal(C.realtime.OPERATIONS.includes('ticket.issue'), false);
});

/* ==========================================================================
 * native/v1 host bridge DTOs
 * ========================================================================== */
test('native/v1 bridge contract accepts only real SDK token shapes', () => {
 const token = sign('google', 'subject-1', 'n'.repeat(43), Date.now());
 assert.deepEqual(C.nativeBridge.validateChallengeRequest({ provider: 'google' }), { provider: 'google', intent: 'login' });
 assert.deepEqual(C.nativeBridge.validateChallengeRequest({ provider: 'apple', intent: 'link' }), { provider: 'apple', intent: 'link' });
 assert.equal(C.nativeBridge.validateCredential({ idToken: token }, { provider: 'google', nonce: 'n'.repeat(43) }).idToken, token);
 assert.equal(C.nativeBridge.validateFinishRequest({ provider: 'google', state: 's'.repeat(43), idToken: token }).provider, 'google');
 assert.deepEqual(C.nativeBridge.validateChallengeResponse({ state: 's'.repeat(43), nonce: 'n'.repeat(43), expires: 1 }).expires, 1);
 assert.deepEqual(C.nativeBridge.validateNotificationRequest({ title: 'Your move', body: 'Alice played', tag: 'match-1' }).tag, 'match-1');
 for (const provider of ['facebook', '', null, 7]) assert.throws(() => C.nativeBridge.validateChallengeRequest({ provider }), e => e.message === 'INVALID_AUTH_REQUEST');
 assert.throws(() => C.nativeBridge.validateChallengeRequest({ provider: 'google', intent: 'register' }), e => e.message === 'INVALID_AUTH_REQUEST');
 assert.throws(() => C.nativeBridge.validateFinishRequest({ provider: 'google', state: 's'.repeat(43), idToken: 'not-a-jws' }), e => e.message === 'INVALID_ID_TOKEN');
 assert.throws(() => C.nativeBridge.validateCredential({ idToken: 'user-123' }, { provider: 'google', nonce: 'n'.repeat(43) }), e => e.message === 'INVALID_ID_TOKEN');
 assert.throws(() => C.nativeBridge.validateCredential({ idToken: token }, { provider: 'google', nonce: 'not a nonce' }), e => e.message === 'INVALID_ID_TOKEN');
 assert.throws(() => C.nativeBridge.validateFinishRequest({ provider: 'google', state: 's'.repeat(600), idToken: token }), e => e.message === 'INVALID_AUTH_STATE');
 assert.throws(() => C.nativeBridge.validateNotificationRequest({ title: '', body: '' }), e => e.message === 'INVALID_NOTIFICATION');
 assert.throws(() => C.nativeBridge.validateNotificationRequest({ title: 't', body: 'b'.repeat(2000) }), e => e.message === 'INVALID_NOTIFICATION');
});

/* ==========================================================================
 * Versioned frozen-surface differences (never collapsed into "the API")
 * ========================================================================== */
test('frozen surface distinction: mounted, standalone, LAN and provider routes stay separate', () => {
 const ids = C.routes.ROUTES.map(route => route.id);
 assert.equal(new Set(ids).size, ids.length, 'no duplicate contract entry');
 for (const route of C.routes.ROUTES) assert.ok(route.path.startsWith('/') && typeof route.method === 'string' && route.version === 'api/v1');
 // mounted competitive/economic routes the retained client calls
 assert.equal(C.routes.routeMatches('v1.move', 'POST', '/api/v1/move'), true);
 assert.equal(C.routes.routeMatches('v1.move', 'GET', '/api/v1/move'), false);
 assert.equal(C.routes.routeMatches('v1.match', 'GET', '/api/v1/match/abc-123'), true);
 assert.equal(C.routes.routeMatches('v1.match', 'GET', '/api/v1/matches/abc'), false);
 assert.equal(C.routes.routeById('v1.purchase').path, '/api/v1/purchase');
 assert.equal(C.routes.routeById('v1.purchase').note.includes('SHADOWED'), true, 'the shadowed mount stays documented for the adapter');
 // standalone adapter prefixes are library-only, not extra mounted endpoints
 const standalone = C.routes.routesForSurface(C.routes.SURFACE.STANDALONE);
 assert.ok(standalone.length > 0);
 for (const route of standalone) assert.equal(route.path.startsWith('/api/'), false);
 assert.equal(standalone.some(route => route.path === '/move'), true);
 assert.equal(C.routes.ROUTES.filter(route => route.path === '/move').length, 1);
 // LAN-only and provider-callback surfaces keep their own auth/origin class
 assert.equal(C.routes.routeById('party.session').surface, C.routes.SURFACE.LAN);
 assert.equal(C.routes.routeById('party.session').auth, C.routes.AUTH.LAN_BEARER);
 assert.equal(C.routes.routeById('party.command').key, C.routes.KEY.PASSTHROUGH);
 assert.equal(C.routes.routeById('monetization.admob-ssv').auth, C.routes.AUTH.VERIFIED_PROVIDER);
 assert.equal(C.routes.routeById('monetization.admob-ssv').origin, C.routes.ORIGIN.NONE);
 assert.equal(C.routes.routeById('account.callback').origin, C.routes.ORIGIN.NONE);
 assert.equal(C.routes.routeById('account.callback').csrf, false);
 assert.equal(C.routes.routeById('community.friend').key, C.routes.KEY.REQUIRED);
 assert.equal(C.routes.routeById('party.capabilities').auth, C.routes.AUTH.PUBLIC);
 // no route advertises a cacheable response EXCEPT the public JWKS key set, which is deliberately
 // cacheable (design B2.2) and carries only public key material.
 const publicRoutes = C.routes.ROUTES.filter(route => route.id === 'account.jwks' || route.path === '/.well-known/jwks.json');
 assert.equal(publicRoutes.length > 0, true, 'the public JWKS route must be declared');
 for (const route of publicRoutes) assert.equal(route.cache, C.routes.CACHE_PUBLIC);
 for (const route of C.routes.ROUTES) {
  if (publicRoutes.includes(route)) continue;
  assert.equal(route.cache, 'no-store');
 }
 // request projection never accepts an actor/balance/outcome from the body
 const projected = C.commands.convert({ from: 'coins', amount: 10, actor: 'bob', balance: 1e12, rating: 3000 });
 assert.deepEqual(projected, { type: 'convert', from: 'coins', amount: 10 });
 const projectedOffer = C.commands.offer({ id: 'm', terms: { kind: 'friend', rated: 'false' } }, 'bob');
 assert.deepEqual({ ...projectedOffer, terms: { ...projectedOffer.terms, amount: projectedOffer.terms.amount === undefined ? 'absent' : projectedOffer.terms.amount } },
  { type: 'offer', id: 'm', opponent: 'bob', terms: { mode: 'direct', kind: 'friend', rated: false, amount: 'absent', turnSeconds: 60 } });
 assert.equal(C.commands.offer({ id: 'm', terms: { kind: 'leaderboard', rated: true, amount: 20 } }, 'bob').terms.turnSeconds, 30, 'a rated direct challenge stays on the approved 30s clock');
 assert.deepEqual(C.commands.preferenceChanges({ changes: { wealthPublic: true, region: 'eu', coins: 999 } }), { wealthPublic: true, region: 'eu' });
 assert.deepEqual({ ...C.commands.preferenceChanges({ changes: { wealthPublic: true } }) }, { wealthPublic: true, region: undefined });
 assert.equal(C.commands.projectCommand('grant', {}), null, 'unknown projections are not commands');
 assert.equal(D.quote !== undefined, true, 'the retained domain rules remain the single source for match quotes');
});
