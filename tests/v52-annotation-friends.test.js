'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const moduleAt = name => import(pathToFileURL(path.join(__dirname, '../apps/web/', name)).href);
const controllerModule = moduleAt('friends.js');
const viewModule = moduleAt('friends-view.js');
const player = (n, relation = 'friend') => ({id:'player-' + n, username:'player_' + n, name:'Rival ' + n,
 tag:'MEGA-' + String(n).toUpperCase(), avatar:'rook', relation, presence:{state:'offline', online:false}});
const response = (count = 25, extra = {}) => ({friends:Array.from({length:count}, (_, n) => player(n)),
 incoming:[player('incoming', 'incoming')], outgoing:[player('outgoing', 'outgoing')], blocked:[], truncated:false, ...extra});
async function fixture(request = async () => response()) {
 const {createFriendsController} = await controllerModule;
 const context = {sessionStatus:'linked', profile:{id:'self', name:'You', tag:'MEGA-SELF'}};
 const calls = []; let changes = 0;
 const controller = createFriendsController({context, request:(...args) => {calls.push(args); return request(...args);},
  operationKey:() => 'friend-page-operation', changed:() => changes++});
 return {context, controller, calls, changes:() => changes};
}
const friendRows = html => [...html.matchAll(/<li class="pg-friend-row" data-friend-row="friends">/g)].length;

test('annotation17 shows at most ten friends, paginates in place and keeps search above the list', async () => {
 const {renderFriendsPage} = await viewModule;
 const f = await fixture();
 await f.controller.load();
 let html = renderFriendsPage(f.context);
 assert.equal(friendRows(html), 10);
 assert.match(html, /Page 1 of 3/);
 assert.match(html, /data-friend-page="0"[^>]*disabled/);
 assert.match(html, /data-friend-page="2"[^>]*>Next/);
 assert.ok(html.indexOf('data-friends-search') < html.indexOf('id="friend-list"'));
 assert.ok(html.indexOf('id="friend-list"') < html.indexOf('id="friend-requests"'));
 assert.equal(f.controller.setPage(2), true);
 html = renderFriendsPage(f.context);
 assert.equal(friendRows(html), 10);
 assert.match(html, /11–20 of 25/);
 assert.match(html, /data-friend-target="player-10"/);
 assert.doesNotMatch(html, /data-friend-target="player-0"/);
 assert.equal(f.controller.setPage(3), true);
 html = renderFriendsPage(f.context);
 assert.equal(friendRows(html), 5);
 assert.match(html, /21–25 of 25/);
 assert.match(html, /data-friend-page="4"[^>]*disabled/);
 assert.equal(f.calls.length, 1, 'pagination never reauthenticates or mutates the service');
});

test('annotation17 keeps request controls in initially collapsed sections and removes redundant navigation', async () => {
 const {renderFriendsPage} = await viewModule;
 const f = await fixture(); await f.controller.load();
 const html = renderFriendsPage(f.context);
 assert.match(html, /<details class="pg-friend-requests" id="friend-requests"><summary>/);
 assert.match(html, /<details class="pg-friend-requests" id="friend-outgoing"><summary>/);
 assert.doesNotMatch(html, /<details class="pg-friend-requests"[^>]*\bopen\b|pg-nav-panel|Your current connections|Review incoming requests/);
 for (const action of ['accept', 'decline', 'cancel', 'confirm-remove', 'confirm-block']) {
  assert.match(html, new RegExp(`data-friend-action="${action}"`));
 }
 assert.match(html, /id="friend-list-title" tabindex="-1"/);
 assert.match(html, /aria-label="Friends pages"/);
});

test('pagination is actor fenced, rejects malformed pages, and clamps when a refreshed list shrinks', async () => {
 let latest = response();
 const f = await fixture(async (_url, body) => body ? {ok:true} : latest);
 assert.equal(f.controller.setPage(2), false);
 await f.controller.load();
 for (const value of [0, -1, 1.5, NaN, Infinity, '2']) assert.equal(f.controller.setPage(value), false);
 assert.equal(f.controller.setPage(200), true);
 assert.equal(f.context.friends.page, 3);
 latest = response(11);
 await f.controller.action('remove', 'player-24');
 assert.equal(f.context.friends.page, 2);
 latest = response(0);
 await f.controller.reload();
 assert.equal(f.context.friends.page, 1);
 f.context.profile = {id:'other'};
 assert.equal(f.controller.setPage(2), false);
 await f.controller.load();
 assert.equal(f.context.friends.actorId, 'other');
 assert.equal(f.context.friends.page, 1);
 f.context.sessionStatus = 'loading'; f.controller.suspend();
 assert.equal(f.controller.setPage(2), false);
 assert.equal(f.context.friends.page, 1);
 assert.deepEqual(f.context.friends.friends, []);
 f.controller.deactivate();
 assert.equal(f.context.friends.page, 1);
});

test('page changes cannot race a pending write or expose protected rows to another session', async () => {
 const {renderFriendsPage} = await viewModule;
 let finish;
 const f = await fixture(async (_url, body) => body ? new Promise(resolve => {finish = resolve;}) : response());
 await f.controller.load();f.controller.setPage(2);
 const pending = f.controller.action('remove', 'player-10');
 assert.equal(f.controller.setPage(3), false);
 const busy = renderFriendsPage(f.context);
 assert.match(busy, /data-friend-page="3"[^>]*disabled/);
 f.context.sessionStatus = 'guest';
 const guest = renderFriendsPage(f.context);
 assert.doesNotMatch(guest, /data-friend-target|MEGA-SELF|Rival 10|Page 2 of 3/);
 f.controller.deactivate();finish({ok:true});
 assert.equal(await pending, false);
 assert.deepEqual(f.context.friends.friends, []);
});

test('partial service lists are labelled honestly and empty/single pages never offer fake next pages', async () => {
 const {renderFriendsPage} = await viewModule;
 const f = await fixture(async () => response(11, {truncated:true})); await f.controller.load();
 const partial = renderFriendsPage(f.context);
 assert.match(partial, /1–10 of 11\+/);
 assert.match(partial, /service returned a partial list/);
 assert.match(partial, /pages show only the players received/);
 for (const count of [0, 1, 10]) {
  const one = await fixture(async () => response(count));await one.controller.load();
  const html = renderFriendsPage(one.context);
  assert.equal(friendRows(html), count);
  assert.doesNotMatch(html, /data-friend-action="page"/);
 }
});

test('new view keeps escaped names and destructive confirmations scoped to the current actor', async () => {
 const {renderFriendsPage} = await viewModule;
 const f = await fixture(async () => response(1));
 await f.controller.load();
 // The controller rejects this malformed name. Also exercise the view's escaping
 // boundary directly, so unsafe HTML cannot execute if a caller bypasses it.
 f.context.friends = {...f.context.friends, friends:[{...player(0), name:'<img src=x onerror=alert(1)>'}]};
 f.context.friendConfirmation = {actorId:'other', action:'block', name:'Private other actor', target:'player-0'};
 let html = renderFriendsPage(f.context);
 assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.doesNotMatch(html, /<img src=x|Private other actor|friend-confirm-title/);
 f.context.friendConfirmation.actorId = 'self';
 html = renderFriendsPage(f.context);
 assert.match(html, /data-friend-action="confirm"/);
 assert.match(html, /data-friend-action="dismiss-confirm"/);
});
