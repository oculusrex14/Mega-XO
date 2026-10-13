'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../apps/web/friends.js'), 'utf8');
const friendsModule = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const accountSource = fs.readFileSync(path.join(__dirname, '../src/account-client.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
 let resolve, reject;
 const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
 return {promise, resolve, reject};
}
function player(id = 'friend-one', relation = 'friend', extra = {}) {
 return {id, username:'player_' + id.replace(/[^a-z0-9]/g, '').slice(0, 12), name:'Sample Player', displayName:'Sample Player',
  tag:'MEGA-1234ABCD', avatar:'rook', relation, presence:{state:'hidden', online:false}, rating:1200, games:42, tier:'wood', ...extra};
}
function lists(extra = {}) {
 return {friends:[player()], incoming:[player('incoming-one', 'incoming')], outgoing:[player('outgoing-one', 'outgoing')],
  blocked:[{id:'blocked-one', username:'blocked_player'}], truncated:false, ...extra};
}
async function fixture(request, options = {}) {
 const {createFriendsController} = await friendsModule;
 const context = {sessionStatus:'linked', profile:{id:'actor-one', wallet:{coins:123, crowns:4}, rating:900}};
 const changes = [], authLosses = [];
 const controller = createFriendsController({context, request, changed:() => changes.push(context.friends.status),
  active:options.active || (() => true),
  onAuthRequired:(error, operation) => { authLosses.push(operation); options.onAuthRequired?.(error, operation, context, controller); }});
 return {context, controller, changes, authLosses};
}
function assertEmpty(state) {
 for (const key of ['friends', 'incoming', 'outgoing', 'blocked', 'results']) assert.deepEqual(state[key], [], key);
}

test('Friends never bootstraps guests, inactive routes or a destroyed controller', async () => {
 let calls = 0;
 let active = true;
 const f = await fixture(() => { calls++; return lists(); }, {active:() => active});
 for (const status of ['guest', 'loading', 'error']) {
  f.context.sessionStatus = status;
  assert.equal(await f.controller.load(), false);
  assert.equal(await f.controller.search('player'), false);
  assert.equal(await f.controller.action('request', 'friend-one'), false);
  assertEmpty(f.context.friends);
 }
 f.context.sessionStatus = 'linked';active = false;
 assert.equal(await f.controller.load(), false);
 active = true;f.controller.destroy();
 assert.equal(await f.controller.load(), false);
 assert.equal(f.controller.suspend(), false);
 assert.equal(calls, 0);
});

test('protected lists use a safe immutable projection and honestly report partial lists', async () => {
 const secretExtras = {stats:{private:true}, email:'private@example.invalid', wallet:{coins:999999}, season:{raw:true}, csrf:'private'};
 const raw = lists({friends:[player('friend-one', 'friend', secretExtras)], truncated:true});
 const f = await fixture(async url => { assert.equal(url, '/api/community/friends');return raw; });
 const accountBefore = JSON.stringify(f.context.profile);
 assert.equal(await f.controller.load(), true);
 const state = f.context.friends;
 assert.equal(state.status, 'ready');assert.equal(state.busy, false);
 assert.equal(state.truncated, true);assert.match(state.message, /partial/);
 assert.deepEqual(state.blocked, [{id:'blocked-one', username:'blocked_player'}]);
 for (const key of Object.keys(secretExtras)) assert.equal(key in state.friends[0], false, key);
 assert.equal(JSON.stringify(f.context.profile), accountBefore);
 raw.friends[0].name = 'Changed outside';raw.friends[0].presence.online = true;
 assert.equal(state.friends[0].name, 'Sample Player');assert.equal(state.friends[0].presence.online, false);
 assert.throws(() => state.friends.push(player('forged')), TypeError);
 assert.throws(() => { state.friends[0].id = 'forged'; }, TypeError);
 assert.deepEqual(f.controller.allowedActions('forged'), []);
});

test('malformed private responses fail closed without showing a fabricated empty success', async () => {
 const invalidResponses = [
  {}, lists({truncated:undefined}), lists({friends:null}), lists({friends:[{id:'friend-one'}]}),
  lists({friends:[player('actor-one')]}), lists({friends:[player('friend-one', 'none')]}),
  lists({friends:[player(), player()]}), lists({friends:[player('friend-one', 'friend', {presence:{state:'hidden', online:true}})]}),
  lists({friends:[player('friend-one', 'friend', {rating:-1})]}),
  lists({friends:[player('friend-one', 'friend', {rating:Infinity})]}),
  lists({friends:[player('friend-one', 'friend', {games:1.5})]}),
  lists({friends:[player('friend-one', 'friend', {name:'🐉'.repeat(29)})]}),
  lists({blocked:[{id:'friend-one', username:'blocked'}]}),
  lists({friends:Array.from({length:501}, (_, i) => player('p' + i))}),
 ];
 for (const response of invalidResponses) {
  const f = await fixture(async () => response);
  assert.equal(await f.controller.load(), false);
  assert.equal(f.context.friends.status, 'error');assert.equal(f.context.friends.errorCode, 'SERVICE_UNAVAILABLE');
  assert.equal(f.context.friends.busy, false);assertEmpty(f.context.friends);
  assert.deepEqual(f.controller.allowedActions('friend-one'), []);
 }
});

test('the approved projection preserves fractional Elo and valid Unicode display names', async () => {
 const name = '🐉'.repeat(28);
 assert.equal(name.length, 56);
 const f = await fixture(async () => lists({friends:[player('friend-one', 'friend', {name, displayName:name, rating:2700.25})]}));
 assert.equal(await f.controller.load(), true);
 assert.equal(f.context.friends.friends[0].rating, 2700.25);
 assert.equal(f.context.friends.friends[0].name, name);
});

test('latest protected list request wins and a failed latest read has an explicit recovery', async () => {
 const replies = [deferred(), deferred(), deferred()];let reads = 0;
 const f = await fixture(() => replies[reads++].promise);
 const first = f.controller.load();const second = f.controller.reload();
 replies[1].reject(Error('REQUEST_TIMEOUT'));
 assert.equal(await second, false);assert.equal(f.context.friends.status, 'refresh-error');
 replies[0].resolve(lists());
 assert.equal(await first, false);assertEmpty(f.context.friends);
 const retry = f.controller.reload();
 replies[2].resolve(lists({friends:[player('new-friend')]}));
 assert.equal(await retry, true);assert.equal(f.context.friends.friends[0].id, 'new-friend');
 assert.equal(f.context.friends.errorCode, '');assert.equal(reads, 3);
});

test('old-actor auth errors and route departure cannot affect a later account or page', async () => {
 const old = deferred();let reads = 0, active = true;
 const f = await fixture(() => ++reads === 1 ? old.promise : lists({friends:[player('second-friend')]}), {active:() => active});
 const oldLoad = f.controller.load();
 f.context.profile = {id:'actor-two'};
 assert.equal(await f.controller.load(), true);
 old.reject(Error('AUTH_REQUIRED'));
 assert.equal(await oldLoad, false);assert.equal(f.authLosses.length, 0);
 assert.equal(f.context.friends.actorId, 'actor-two');assert.equal(f.context.friends.friends[0].id, 'second-friend');
 const delayed = deferred();
 const other = await fixture(() => delayed.promise, {active:() => active});
 const pending = other.controller.load();active = false;other.controller.deactivate();
 delayed.resolve(lists());
 assert.equal(await pending, false);assert.equal(other.context.friends.status, 'idle');assertEmpty(other.context.friends);
});

test('same-actor session refresh clears private rows, retains only the query and recovers from refresh failure', async () => {
 let reads = 0;
 const f = await fixture(async url => {
  if (url.startsWith('/api/community/search')) return [player('search-one', 'none')];
  if (++reads === 2) throw Error('REQUEST_TIMEOUT');
  return lists();
 });
 await f.controller.load();f.controller.setQuery('player');await f.controller.search();
 f.context.sessionStatus = 'loading';
 assert.equal(f.controller.suspend(), true);assert.equal(f.controller.isSuspended(), true);
 assertEmpty(f.context.friends);assert.equal(f.context.friends.query, 'player');
 assert.equal(f.controller.setQuery('changed'), false);assert.equal(await f.controller.action('unblock', 'blocked-one'), false);
 f.context.sessionStatus = 'linked';
 assert.equal(await f.controller.resume('actor-one'), false);
 assert.equal(f.context.friends.status, 'refresh-error');assert.equal(f.context.friends.query, 'player');
 assertEmpty(f.context.friends);assert.equal(f.context.friends.busy, false);
 assert.equal(await f.controller.reload(), true);assert.equal(f.context.friends.searchStatus, 'idle');
 assert.equal(f.context.friends.query, 'player');
 f.controller.suspend();f.context.profile = {id:'actor-two'};
 assert.equal(await f.controller.resume('actor-two'), true);
 assert.equal(f.context.friends.query, '');assert.equal(f.context.friends.actorId, 'actor-two');
});

test('search happens on explicit submit with the server minimum and exact-tag contract', async () => {
 const calls = [];
 const f = await fixture(async url => { calls.push(url);return url === '/api/community/friends' ? lists() : [player('found-one', 'none', {stats:{private:true}})]; });
 await f.controller.load();const updates = f.changes.length;
 assert.equal(f.controller.setQuery(' @ab '), true);assert.equal(f.changes.length, updates);assert.equal(calls.length, 1);
 assert.equal(await f.controller.search(), false);assert.equal(f.context.friends.searchErrorCode, 'SEARCH_TOO_SHORT');
 assert.equal(calls.length, 1);
 f.controller.setQuery(' MEGA-1234ABCD ');
 assert.equal(await f.controller.search(), true);
 assert.equal(calls.at(-1), '/api/community/search?q=MEGA-1234ABCD');
 assert.equal(f.context.friends.resultQuery, 'MEGA-1234ABCD');
 assert.equal(f.context.friends.results[0].stats, undefined);
 assert.deepEqual(f.controller.allowedActions('found-one'), ['request', 'block']);
 f.controller.setQuery(' @pla ');await f.controller.search();
 assert.equal(calls.at(-1), '/api/community/search?q=%40pla');
 f.controller.setQuery('');assert.equal(await f.controller.search(), false);assert.deepEqual(f.context.friends.results, []);
});

test('query and search revision fences ignore stale results and stale 401s, including same-actor queries', async () => {
 const replies = [deferred(), deferred(), deferred()];let searches = 0;
 const f = await fixture(url => url === '/api/community/friends' ? lists() : replies[searches++].promise);
 await f.controller.load();f.controller.setQuery('alpha');const first = f.controller.search();
 f.controller.setQuery('bravo');const second = f.controller.search();
 replies[0].reject(Error('AUTH_REQUIRED'));
 assert.equal(await first, false);assert.equal(f.authLosses.length, 0);
 replies[1].resolve([player('bravo-result', 'none')]);
 assert.equal(await second, true);assert.equal(f.context.friends.resultQuery, 'bravo');
 f.controller.setQuery('charlie');const third = f.controller.search();
 f.controller.setQuery('delta');replies[2].reject(Error('LINK_ACCOUNT_REQUIRED'));
 assert.equal(await third, false);assert.equal(f.authLosses.length, 0);
 assert.equal(f.context.friends.searchStatus, 'idle');assert.deepEqual(f.context.friends.results, []);
 assert.deepEqual(f.controller.allowedActions('bravo-result'), []);
});

test('search errors remain separate from loaded lists and a new explicit submit can recover', async () => {
 let searches = 0;
 const f = await fixture(async url => {
  if (url === '/api/community/friends') return lists();
  if (++searches === 1) throw Error('REQUEST_TIMEOUT');
  if (searches === 2) return [{id:'incomplete'}];
  return [];
 });
 await f.controller.load();f.controller.setQuery('player');
 assert.equal(await f.controller.search(), false);assert.equal(f.context.friends.searchStatus, 'error');
 assert.equal(f.context.friends.status, 'ready');assert.equal(f.context.friends.friends.length, 1);
 assert.equal(await f.controller.search(), false);assert.equal(f.context.friends.searchErrorCode, 'SERVICE_UNAVAILABLE');
 assert.equal(await f.controller.search(), true);assert.equal(f.context.friends.searchStatus, 'ready');
 assert.deepEqual(f.context.friends.results, []);assert.equal(f.context.friends.resultQuery, 'player');
 assert.equal(f.context.friends.searchMessage, '');assert.equal(searches, 3);
});

test('current auth loss is delivered only after the full operation fence for reads, searches and mutations', async () => {
 for (const failing of ['load', 'search', 'action']) {
  const f = await fixture(async (url, body) => {
   if (failing !== 'load' && url === '/api/community/friends') return lists();
   if (failing === 'action') assert.deepEqual(body, {action:'remove', target:'friend-one'});
   throw Error('AUTH_REQUIRED');
  }, {onAuthRequired:(_error, _operation, context, controller) => {context.sessionStatus = 'guest';context.profile = null;controller.deactivate();}});
  if (failing === 'load') assert.equal(await f.controller.load(), false);
  else {
   await f.controller.load();
   if (failing === 'search') {f.controller.setQuery('player');assert.equal(await f.controller.search(), false);}
   else assert.equal(await f.controller.action('remove', 'friend-one'), false);
  }
  assert.deepEqual(f.authLosses.map(value => value.operation), [failing]);
  assert.equal(f.context.sessionStatus, 'guest');assert.equal(f.context.friends.status, 'idle');assertEmpty(f.context.friends);
 }
});

test('only actions from the current protected source and relation are allowed; forged view rows confer no permission', async () => {
 const calls = [];
 const f = await fixture(async (url, body) => {calls.push({url, body});return body ? {ok:true} : url.startsWith('/api/community/search') ?
  [player('new-player', 'none'), player('found-friend', 'friend'), player('found-incoming', 'incoming'), player('found-outgoing', 'outgoing')] :
  lists({incoming:[player('incoming-one', 'incoming'), player('crossed', 'incoming')], outgoing:[player('outgoing-one', 'outgoing'), player('crossed', 'incoming')]});});
 await f.controller.load();f.controller.setQuery('player');await f.controller.search();
 const expected = {
  'friend-one':['remove', 'block'], 'incoming-one':['accept', 'decline', 'block'], 'outgoing-one':['cancel', 'block'],
  crossed:['accept', 'decline', 'cancel', 'block'], 'blocked-one':['unblock'], 'new-player':['request', 'block'],
  'found-friend':['remove', 'block'], 'found-incoming':['accept', 'decline', 'block'], 'found-outgoing':['cancel', 'block'],
 };
 for (const [target, allowed] of Object.entries(expected)) assert.deepEqual(f.controller.allowedActions(target), allowed, target);
 f.context.friends.results = [player('forged', 'none')];f.context.friends.friends = [player('forged')];
 for (const [name, target] of [['request', 'forged'], ['remove', 'forged'], ['request', 'friend-one'], ['accept', 'outgoing-one'],
  ['unblock', 'friend-one'], ['block', 'blocked-one'], ['request', 'actor-one'], ['challenge', 'friend-one']]) {
  assert.equal(await f.controller.action(name, target), false, name + ':' + target);
 }
 assert.equal(calls.length, 2);
});

test('all seven social commands send only the existing payload and reload canonical lists', async () => {
 for (const [name, target] of [['request', 'new-player'], ['accept', 'incoming-one'], ['decline', 'incoming-one'],
  ['cancel', 'outgoing-one'], ['remove', 'friend-one'], ['block', 'friend-one'], ['unblock', 'blocked-one']]) {
  const calls = [];let reads = 0;
  const f = await fixture(async (url, body) => {
   calls.push({url, body});
   if (body) return {ok:true};
   if (url.startsWith('/api/community/search')) return [player('new-player', 'none')];
   return ++reads === 1 ? lists() : lists({friends:[], incoming:[], outgoing:[], blocked:[]});
  });
  await f.controller.load();f.controller.setQuery('player');await f.controller.search();
  assert.equal(await f.controller.action(name, target), true, name);
  assert.deepEqual(calls.at(-2), {url:'/api/community/friend', body:{action:name, target}});
  assert.deepEqual(calls.at(-1), {url:'/api/community/friends', body:undefined});
  assert.equal(f.context.friends.actionStatus, 'saved');assert.equal(f.context.friends.status, 'ready');
  assert.equal(f.context.friends.busy, false);assertEmpty(f.context.friends);
  assert.equal(f.context.friends.query, 'player');assert.equal(f.context.friends.searchStatus, 'idle');
 }
});

test('mutations are never optimistic and stay busy through the canonical reload', async () => {
 const write = deferred(), reload = deferred();let reads = 0, writes = 0;
 const f = await fixture((url, body) => {
  if (body) {writes++;return write.promise;}
  return ++reads === 1 ? lists() : reload.promise;
 });
 await f.controller.load();const before = f.context.friends.friends;
 const pending = f.controller.action('remove', 'friend-one');
 assert.equal(f.context.friends.friends, before);assert.equal(f.context.friends.busy, true);
 assert.deepEqual(f.context.friends.pendingAction, {action:'remove', target:'friend-one'});
 assert.equal(await f.controller.action('block', 'friend-one'), false);assert.equal(await f.controller.reload(), false);
 assert.equal(await f.controller.search('player'), false);assert.equal(f.controller.setQuery('player'), false);
 write.resolve({ok:true});await tick();
 assertEmpty(f.context.friends);assert.equal(f.context.friends.actionStatus, 'saved');
 assert.equal(f.context.friends.busy, true);assert.equal(f.context.friends.status, 'refreshing');
 reload.resolve(lists({friends:[]}));
 assert.equal(await pending, true);assert.equal(writes, 1);assert.equal(reads, 2);
 assert.deepEqual(f.context.friends.friends, []);assert.equal(f.context.friends.pendingAction, null);
});

test('an accepted mutation with a failed canonical reload is reported honestly and can be recovered', async () => {
 let reads = 0;
 const f = await fixture(async (_url, body) => {
  if (body) return {ok:true};
  if (++reads === 2) throw Error('REQUEST_TIMEOUT');
  return lists({friends:reads === 1 ? [player()] : []});
 });
 await f.controller.load();
 assert.equal(await f.controller.action('remove', 'friend-one'), false);
 assert.equal(f.context.friends.actionStatus, 'saved');assert.equal(f.context.friends.status, 'refresh-error');
 assert.match(f.context.friends.message, /accepted.*could not be loaded/);assertEmpty(f.context.friends);
 assert.equal(f.context.friends.busy, false);assert.equal(await f.controller.action('remove', 'friend-one'), false);
 assert.equal(await f.controller.reload(), true);assert.deepEqual(f.context.friends.friends, []);
});

test('failed or malformed mutation replies never claim success and require a canonical reload', async () => {
 for (const failure of [Error('REQUEST_TIMEOUT'), {}]) {
  let reads = 0;
  const f = await fixture(async (_url, body) => {
   if (!body) {reads++;return lists();}
   if (failure instanceof Error) throw failure;
   return failure;
  });
  await f.controller.load();assert.equal(await f.controller.action('remove', 'friend-one'), false);
  assert.equal(f.context.friends.actionStatus, 'error');assert.equal(f.context.friends.status, 'error');
  assert.equal(f.context.friends.busy, false);assertEmpty(f.context.friends);assert.equal(reads, 1);
  f.controller.clearError();assert.equal(f.context.friends.status, 'error');assert.deepEqual(f.controller.allowedActions('friend-one'), []);
  assert.equal(await f.controller.reload(), true);
 }
});

test('actor changes and suspension fence pending mutations without retiring the new session', async () => {
 for (const change of ['actor', 'suspend', 'route']) {
  const pendingReply = deferred();let active = true;
  const f = await fixture((_url, body) => body ? pendingReply.promise : lists(), {active:() => active});
  await f.controller.load();const pending = f.controller.action('block', 'friend-one');
  if (change === 'actor') {f.context.profile = {id:'actor-two'};await f.controller.load();}
  if (change === 'suspend') {f.context.sessionStatus = 'loading';f.controller.suspend();f.context.sessionStatus = 'linked';await f.controller.resume('actor-one');}
  if (change === 'route') {active = false;f.controller.deactivate();}
  const current = JSON.stringify(f.context.friends);
  pendingReply.reject(Error('AUTH_REQUIRED'));
  assert.equal(await pending, false);assert.equal(f.authLosses.length, 0);
  assert.equal(JSON.stringify(f.context.friends), current);assert.equal(f.context.sessionStatus, 'linked');
 }
});

test('shared client owns POST retries with one idempotency key and Friends never accesses persistent storage', async () => {
 const {createFriendsController} = await friendsModule;
 const calls = [];let writes = 0, storageAccesses = 0;
 const sandbox = {AbortController, Headers, URL, URLSearchParams, location:{href:'https://website.test/friends', origin:'https://website.test'},
  document:{dispatchEvent() {}}, navigator:{onLine:true}, addEventListener() {}, crypto:require('node:crypto'),
  setTimeout, clearTimeout, CustomEvent:class {},
  async fetch(url, options = {}) {
   calls.push({url, ...options});
   let body = url === '/api/account/session' ? {csrf:'synthetic-csrf', linked:true} : lists();
   let status = 200;
   if (url === '/api/community/friend') {
    if (++writes === 1) {body = {error:'SERVICE_UNAVAILABLE'};status = 503;} else body = {ok:true};
   }
   return new Response(JSON.stringify(body), {status});
  },
 };
 for (const name of ['localStorage', 'sessionStorage', 'caches', 'indexedDB']) {
  Object.defineProperty(sandbox, name, {get() {storageAccesses++;throw Error('PRIVATE_PERSISTENCE_FORBIDDEN');}});
 }
 const realm = vm.createContext(sandbox);
 vm.runInContext(accountSource, realm);
 vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.createFriendsController = createFriendsController;', realm);
 // Both the default controller transport and the actual shared client execute in
 // the realm containing storage traps, rather than a test-only HTTP substitute.
 assert.equal(typeof createFriendsController, 'function');
 const context = {sessionStatus:'linked', profile:{id:'actor-one'}};
 const controller = sandbox.createFriendsController({context});
 await controller.load();assert.equal(await controller.action('remove', 'friend-one'), true);
 const posts = calls.filter(call => call.url === '/api/community/friend');
 assert.equal(posts.length, 2);assert.equal(posts[0].method, 'POST');
 assert.equal(posts[0].credentials, 'same-origin');assert.equal(posts[0].headers['X-CSRF-Token'], 'synthetic-csrf');
 assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
 assert.ok(posts[0].headers['Idempotency-Key']);
 assert.deepEqual(JSON.parse(posts[0].body), {action:'remove', target:'friend-one'});
 controller.suspend();controller.deactivate();controller.destroy();
 assert.equal(storageAccesses, 0);
});
