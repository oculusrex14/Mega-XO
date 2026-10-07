/* V5 P01 - real unit-of-work / repository boundary behavior.
 *
 * These are deterministic behavior tests over an actual temporary node:sqlite
 * database with the existing migrations, real domain objects and real repository
 * methods. They prove transactional atomicity of multi-repository monetary
 * operations, failure rollback, idempotent outcome replay, nested borrowing on one
 * connection and that repository calls cannot leak outside a live unit of work;
 * they assert durable rows and balances, not commit-spy wiring or source text.
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {DurableStore} = require('../server/economy-store.js');
const {RoomStore} = require('../server/rooms.js');
const {CommunityStore} = require('../server/community-store.js');
const {createSqliteUnitOfWork, currentScope} = require('../packages/db');
const {COMMANDS, V35_COMMANDS} = require('../packages/db/scopes');
const {migrate} = require('../server/production/migrations.js');
const {MonetizationStore} = require('../server/monetization-store.js');
const D = require('../src/domain.js');
const M = require('../src/monetization.js');
const AD_UNIT = 'ca-app-pub-1234567890123456/1234567890';

function fixture(t, options = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-uow-'));
 const file = path.join(dir, 'ledger.sqlite');
 let now = Date.parse('2026-10-08T12:00:00Z');
 const store = new DurableStore(file, {now: () => now, random: () => 0, ...options});
 const operator = {actor: 'operator', scope: 'operator'};
 store.run(operator, 'provision:alice', {type: 'provision', account: 'alice', options: {coins: 1000, crowns: 100, rating: 1500, games: 30, verified: true}});
 store.run(operator, 'provision:bob', {type: 'provision', account: 'bob', options: {coins: 1000, crowns: 100, rating: 1500, games: 30, verified: true}});
 t.after(() => { store.close(); fs.rmSync(dir, {recursive: true, force: true}); });
 return {store, file, dir, now: () => now, advance: (ms) => (now += ms)};
}

test('repository methods require a live unit of work and cannot mutate after it closes', (t) => {
 const {store} = fixture(t);
 const repositories = store.repositories();
 assert.equal(repositories.accounts.has('alice'), true);
 assert.throws(() => repositories.commitDomain(), /TRANSACTION_REQUIRED/);
 assert.throws(() => repositories.tournaments.save({id: 'r', code: 'C'}), /TRANSACTION_REQUIRED/);
 assert.throws(() => repositories.outcomes.save(COMMANDS, 'id', 'actor', 'fp', '{}'), /TRANSACTION_REQUIRED/);
 const unit = createSqliteUnitOfWork(store.db, {});
 const result = unit.run(tx => {
  assert.ok(currentScope(store.db));
  const graph = tx.repositories.domain();
  graph.authority.account('alice').coins -= 5;
  tx.repositories.commitDomain();
  return tx.repositories.wallets.for('alice').coins;
 });
 assert.equal(result, 995);
 // The released context cannot mutate afterwards: same connection, no live scope.
 assert.throws(() => store.repositories().commitDomain(), /TRANSACTION_REQUIRED/);
 assert.equal(JSON.parse(store.db.prepare('SELECT json FROM state WHERE id=1').get().json).accounts.find(([id]) => id === 'alice')[1].coins, 995);
});

test('one economic command writes its graph, balance and durable outcome atomically', (t) => {
 const {store} = fixture(t);
 const player = {actor: 'alice', scope: 'player'};
 const result = store.run(player, 'convert-1', {type: 'convert', from: 'coins', amount: 100});
 assert.deepEqual(result, {from: 'coins', to: 'crowns', debit: 100, credit: 10, id: 'convert-1'});
 const account = store.read().account('alice');
 assert.equal(account.coins, 900);
 assert.equal(account.crowns, 110);
 // Outcome row and state row are both present in the same database file.
 const row = store.db.prepare('SELECT actor,fingerprint,response FROM commands WHERE id=?').get(JSON.stringify(['alice', 'convert-1']));
 assert.equal(row.actor, 'alice');
 assert.deepEqual(JSON.parse(row.response), result);
 const replay = store.run(player, 'convert-1', {type: 'convert', from: 'coins', amount: 100});
 assert.deepEqual(replay, result);
 assert.equal(store.read().account('alice').coins, 900);
 assert.throws(() => store.run(player, 'convert-1', {type: 'convert', from: 'coins', amount: 200}), /IDEMPOTENCY_CONFLICT/);
 assert.equal(store.read().account('alice').coins, 900);
});

test('a failed multi-repository operation rolls back graph, outcome and room state together', (t) => {
 const {store, file} = fixture(t);
 // Real rooms schema through the real constructor (same file, separate connection
 // exactly like community-server.js), then closed so the failing unit owns the file.
 new RoomStore(file, {lanOnly: false}).close();
 const before = JSON.stringify(store.read().export());
 const unit = createSqliteUnitOfWork(store.db, {});
 assert.throws(() => unit.run(tx => {
  const graph = tx.repositories.domain();
  graph.authority.account('alice').coins -= 100;
  graph.authority.account('alice').crowns += 10;
  tx.repositories.commitDomain();
  tx.repositories.tournaments.save({id: 'room-1', code: 'ROOM01', status: 'LOBBY', revision: 0, players: []});
  tx.repositories.outcomes.save(COMMANDS, JSON.stringify(['alice', 'atomic']), 'alice', 'fp', '{}');
  throw Error('FORCED_FAILURE');
 }), /FORCED_FAILURE/);
 assert.equal(JSON.stringify(store.read().export()), before);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM commands WHERE id=?').get(JSON.stringify(['alice', 'atomic'])).n, 0);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM party_rooms').get().n, 0);
});

test('nested repository calls on one connection borrow the shared unit of work', (t) => {
 const {store} = fixture(t);
 const unit = createSqliteUnitOfWork(store.db, {});
 const observations = unit.run(outer => {
  const nested = unit.run(inner => {
   // The nested callback sees the SAME scope, the same repositories and the same
   // cached domain graph; nothing is committed by the nested call.
   assert.equal(inner, outer);
   assert.equal(inner.repositories.domain(), outer.repositories.domain());
   assert.equal(inner.clock, outer.clock);
   inner.repositories.domain().authority.account('alice').coins += 7;
   return inner.repositories.wallets.for('alice').coins;
  });
  assert.equal(store.read().account('alice').coins, 1000);
  outer.repositories.commitDomain();
  return nested;
 });
 assert.equal(observations, 1007);
 assert.equal(store.read().account('alice').coins, 1007);
});

test('nested failure inside a borrowed scope rolls the whole unit back', (t) => {
 const {store} = fixture(t);
 const unit = createSqliteUnitOfWork(store.db, {});
 assert.throws(() => unit.run(tx => {
  tx.repositories.domain().authority.account('alice').coins += 50;
  unit.run(() => { throw Error('NESTED_FAILURE'); });
 }), /NESTED_FAILURE/);
 assert.equal(store.read().account('alice').coins, 1000);
});

test('async callbacks are rejected and leave no transaction open or committed', (t) => {
 const {store} = fixture(t);
 const unit = createSqliteUnitOfWork(store.db, {});
 assert.throws(() => unit.run(async () => 1), /ASYNC_CALLBACK_UNSUPPORTED/);
 assert.equal(store.db.isTransaction, false);
 assert.equal(store.read().account('alice').coins, 1000);
});

test('room reserve/settle/outcome and the economic graph share one real transaction', (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-uow-room-'));
 const file = path.join(dir, 'party.sqlite');
 let now = 100000;
 const rooms = new RoomStore(file, {lanOnly: false, now: () => now});
 const accounts = Array.from({length: 10}, (_, i) => ['p' + i, {id: 'p' + i, name: 'p' + i, coins: 10000, crowns: 100, reservedCoins: 0, reservedCrowns: 0, rating: 1200 + i, games: 20, verified: true, suspended: false, hold: false, blocked: [], activeMatch: null}]);
 rooms.db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');
 rooms.db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify({accounts, matches: [], burned: {coins: 0, crowns: 0}, journal: []}));
 t.after(() => { rooms.close(); fs.rmSync(dir, {recursive: true, force: true}); });
 const principal = id => ({actor: id, name: id, scope: 'player'});
 let op = 0;
 const cmd = (id, command, key) => rooms.run(principal(id), key || 'op' + (++op), command);
 let room;
 for (let i = 0; i < 10; i++) room = cmd('p' + i, {type: 'publicJoin', table: 'low'});
 for (let i = 0; i < 9; i++) room = cmd('p' + i, {type: 'ready', id: room.id, value: true, rulesVersion: room.rulesVersion});
 // A rejected late entry inside the same transaction boundary leaves every
 // reservation and the committed room untouched.
 const drained = rooms.economy();
 drained.accounts.find(([id]) => id === 'p9')[1].coins = 0;
 rooms.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(drained));
 assert.throws(() => cmd('p9', {type: 'ready', id: room.id, value: true, rulesVersion: room.rulesVersion}), /INSUFFICIENT_COINS/);
 assert.equal(rooms.economy().accounts.find(([id]) => id === 'p1')[1].reservedCoins, 0);
 assert.equal(rooms.get(room.id).status, 'LOBBY');
 assert.equal(rooms.db.prepare('SELECT count(*) AS n FROM party_commands').get().n, 19);
 const restored = rooms.economy();
 restored.accounts.find(([id]) => id === 'p9')[1].coins = 10000;
 rooms.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(restored));
 const committed = cmd('p9', {type: 'ready', id: room.id, value: true, rulesVersion: room.rulesVersion});
 assert.equal(committed.status, 'RUNNING');
 assert.equal(committed.escrow, 1000);
 const economy = rooms.economy();
 for (let i = 0; i < 10; i++) {
  const account = economy.accounts.find(([id]) => id === 'p' + i)[1];
  assert.equal(account.coins, 9900);
  assert.equal(account.reservedCoins, 100);
  assert.equal(account.activeMatch, 'tournament:' + room.id);
 }
 // Reserve committed room JSON, economy row and party_command outcome together.
 assert.ok(rooms.db.prepare('SELECT 1 FROM party_rooms WHERE id=?').get(room.id));
 assert.equal(rooms.db.prepare('SELECT count(*) AS n FROM party_commands').get().n, 20);
 // A rejected command on a running room changes neither economy nor room rows.
 const player = {actor: 'p0', name: 'p0', scope: 'player'};
 assert.throws(() => rooms.run(player, 'bad-move', {type: 'move', id: room.id, fixture: 'nope', revision: 0, move: 0}), /UNKNOWN|INVALID|NOT_/);
 const after = rooms.economy().accounts.find(([id]) => id === 'p1')[1];
 assert.equal(after.coins, 9900);
 assert.equal(after.reservedCoins, 100);
 assert.equal(rooms.get(room.id).status, 'RUNNING');
 assert.equal(rooms.db.prepare('SELECT count(*) AS n FROM party_commands').get().n, 20);
});

test('room recovery refunds contributors and commits the room and economy once', (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-uow-recover-'));
 const file = path.join(dir, 'party.sqlite');
 let now = 100000;
 const rooms = new RoomStore(file, {lanOnly: false, now: () => now});
 const accounts = Array.from({length: 10}, (_, i) => ['p' + i, {id: 'p' + i, name: 'p' + i, coins: 10000, crowns: 100, reservedCoins: 0, reservedCrowns: 0, rating: 1200 + i, games: 20, verified: true, suspended: false, hold: false, blocked: [], activeMatch: null}]);
 rooms.db.exec('CREATE TABLE state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');
 rooms.db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify({accounts, matches: [], burned: {coins: 0, crowns: 0}, journal: []}));
 t.after(() => { rooms.close(); fs.rmSync(dir, {recursive: true, force: true}); });
 const principal = id => ({actor: id, name: id, scope: 'player'});
 let op = 0;
 const cmd = (id, command) => rooms.run(principal(id), 'op' + (++op), command);
 let room;
 for (let i = 0; i < 10; i++) room = cmd('p' + i, {type: 'publicJoin', table: 'low'});
 for (const player of room.players) room = cmd(player.id, {type: 'ready', id: room.id, value: true, rulesVersion: room.rulesVersion});
 assert.equal(room.status, 'RUNNING');
 const second = new RoomStore(file, {lanOnly: false, now: () => now});
 second.recover();
 const refunded = second.economy();
 for (let i = 0; i < 10; i++) {
  const account = refunded.accounts.find(([id]) => id === 'p' + i)[1];
  assert.equal(account.coins, 10000);
  assert.equal(account.reservedCoins, 0);
  assert.equal(account.activeMatch, null);
 }
 assert.equal(second.get(room.id).status, 'VOID');
 assert.equal(second.get(room.id).receipt.refunded, true);
 second.close();
});

test('account signup through the community boundary writes identity, graph and profile once', (t) => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-uow-signup-'));
 const file = path.join(dir, 'db.sqlite');
 let now = Date.parse('2026-10-08T12:00:00Z');
 const store = new DurableStore(file, {now: () => now});
 const community = new CommunityStore({store, origin: 'https://mega.example', now: () => now});
 t.after(() => { store.close(); fs.rmSync(dir, {recursive: true, force: true}); });
 // The community transaction seam is a real scope on the store connection.
 const actor = 'u_signup';
 const issued = community.tx(() => {
  const authority = community.read();
  authority.addAccount(actor, {verified: true, createdAt: now});
  community.ensureProfile(actor, authority);
  community.write(authority);
  return 'ok';
 });
 assert.equal(issued, 'ok');
 assert.equal(store.db.isTransaction, false);
 const created = store.read().account(actor);
 assert.equal(created.coins, D.POLICY.startingCoins);
 assert.ok(community.profileRow(actor));
 assert.ok(store.db.prepare('SELECT actor FROM profiles WHERE actor=?').get(actor));
 // A community transaction that fails leaves no profile and no account.
 assert.throws(() => community.tx(() => { community.db.prepare('INSERT INTO profiles(actor,tag,username,display_name,created) VALUES(?,?,?,?,?)').run('u_bad', 'MEGA-BAD', 'bad', 'bad', now); throw Error('ABORT_SIGNUP'); }), /ABORT_SIGNUP/);
 assert.equal(store.db.prepare('SELECT actor FROM profiles WHERE actor=?').get('u_bad'), undefined);
 assert.equal(store.read().accounts.has('u_bad'), false);
});

test('rewarded-ad credit grant and its v35 outcome share one unit of work', async (t) => {
 const at = Date.parse('2026-10-08T12:00:00Z');
 const {store} = fixture(t);
 const monetization = new MonetizationStore(store, {
  now: () => at,
  eligible: () => true,
  adMode: 'rewarded',
  adUnits: {android: {rewarded: AD_UNIT, interstitial: ''}},
  verifyAd: async (raw) => raw,
 });
 const event = {actor: 'alice', ticket: '', adUnit: AD_UNIT, rewardItem: 'cosmetic_reward', amount: 1, timestamp: at, transactionId: 'admob-tx-1'};
 const ticket = monetization.ticket('alice', 'grant-ticket', 'credits', 'android');
 assert.equal(ticket.rewardAmount, 1);
 assert.equal(store.db.isTransaction, false);
 event.ticket = ticket.ticket;
 // The signed provider event settles credits and the durable v35 outcome in one scope.
 const granted = await monetization.callback(event);
 assert.equal(granted.granted, 'credits');
 assert.equal(granted.credits, M.POLICY.rewardCredits);
 assert.equal(store.read().account('alice').monetization.credits, M.POLICY.rewardCredits);
 const digest = crypto.createHash('sha256').update('admob-tx-1').digest('hex');
 const outcome = store.db.prepare(V35_COMMANDS.find).get('alice', 'ssv:' + digest);
 assert.ok(outcome);
 assert.deepEqual(JSON.parse(outcome.response), granted);
 assert.equal(store.db.prepare('SELECT settled,transaction_id FROM v35_tickets WHERE id=?').get(ticket.ticket).settled, 1);
 // Replay of the same provider transaction is idempotent and never re-grants.
 assert.deepEqual(await monetization.callback(event), granted);
 assert.equal(store.read().account('alice').monetization.credits, M.POLICY.rewardCredits);
 // A failed grant (unknown ticket) rolls back: no credits, no outcome row.
 const orphan = await monetization.callback({...event, ticket: 'missing', transactionId: 'admob-tx-2'}).then(() => null, (error) => error);
 assert.ok(orphan instanceof Error);
 assert.match(orphan.message, /INVALID_AD_TICKET/);
 assert.equal(store.read().account('alice').monetization.credits, M.POLICY.rewardCredits);
 assert.equal(store.db.prepare(V35_COMMANDS.find).get('alice', 'ssv:' + crypto.createHash('sha256').update('admob-tx-2').digest('hex')), undefined);
 // Same key with a different payload conflicts instead of double-granting.
 assert.throws(() => monetization.ticket('alice', 'grant-ticket', 'boost', 'android'), /IDEMPOTENCY_CONFLICT/);
 assert.equal(store.read().account('alice').monetization.credits, M.POLICY.rewardCredits);
});

test('existing external transaction compatibility: db.tx is the shared unit of work', (t) => {
 const {store} = fixture(t);
 const unit = createSqliteUnitOfWork(store.db, {});
 assert.equal(store.db.tx.unitOfWork, unit);
 let sawScope = false;
 const value = store.db.tx(() => { sawScope = !!currentScope(store.db); return 4; });
 assert.equal(value, 4);
 assert.equal(sawScope, true);
 assert.equal(store.db.isTransaction, false);
 // A nested store command inside an open tx borrows it instead of committing early.
 const player = {actor: 'alice', scope: 'player'};
 const combined = store.db.tx(() => {
  store.run(player, 'nested-convert', {type: 'convert', from: 'coins', amount: 10});
  assert.equal(store.db.isTransaction, true);
  return store.db.isTransaction;
 });
 assert.equal(combined, true);
 assert.equal(store.read().account('alice').coins, 990);
 assert.equal(store.db.isTransaction, false);
 // A nested command inside an outer transaction that later fails leaves no
 // balance change and no outcome row: it never committed independently.
 assert.throws(() => store.db.tx(() => {
  store.run(player, 'rolled-back-nested', {type: 'convert', from: 'coins', amount: 10});
  throw Error('OUTER_ROLLBACK');
 }), /OUTER_ROLLBACK/);
 assert.equal(store.read().account('alice').coins, 990);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM commands WHERE id=?').get(JSON.stringify(['alice', 'rolled-back-nested'])).n, 0);
 const journal = unit.repositories().ledger.recent('alice', null).map(entry => entry.id);
 assert.ok(journal.includes('nested-convert:out'));
 assert.ok(journal.includes('nested-convert:in'));
 assert.equal(journal.some(id => id.startsWith('rolled-back-nested')), false);
});
