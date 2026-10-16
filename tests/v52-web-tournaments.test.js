'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/tournament.js');
const G = require('../src/game.js');
const modulePromise = import('../apps/web/tournaments.js');
const viewPromise = import('../apps/web/tournaments-view.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const caps = () => ({lan:false,online:true,publicEnabled:true,tables:Object.keys(T.TABLES).map(T.prize)});
function lobby(actor='actor-one') {
 const room=T.create({id:'room-one',owner:'service',table:'low',now:1000});T.join(room,actor,'Sample Player',1000);return T.view(room,1000);
}
function running(){
 const room=T.create({id:'room-one',owner:'service',table:'low',now:1000});
 for(let i=0;i<10;i++){const actor=i?'actor-'+(i+1):'actor-one';T.join(room,actor,'Player '+i,1000);T.ready(room,actor,true,room.rulesVersion);}
 // The first seed has a first-round bye in the retained five-player group.
 // Put actor-one in a playing seed so the ready/move cases exercise a real
 // fixture instead of assuming that every seated actor has one immediately.
 const seed=room.players.map(player=>player.id);T.start(room,'service',[...seed.slice(1),seed[0]],1000);return room;
}
async function fixture(request,options={}){
 const {createTournamentsController}=await modulePromise;
 const context={sessionStatus:'linked',profile:{id:'actor-one',wallet:{coins:1234,crowns:20}}};
 const calls=[],changes=[],auth=[];let count=0,active=true;
 const storage=new Map();
 const controller=createTournamentsController({context,
  request:async(path,body,key)=>{calls.push({path,body:structuredClone(body),key});return request(path,body,key);},
  read:async path=>{calls.push({path});return caps();},changed:()=>changes.push(structuredClone(context.tournaments)),
  active:()=>active,onAuthRequired:error=>auth.push(error.message),operationKey:()=>`tournament-operation-${++count}`,
  storage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},...options});
 return {context,controller,calls,changes,auth,storage,leaveRoute(){active=false;controller.sync();}};
}
async function enter(f,roomId){f.controller.sync({roomId});for(let i=0;i<3;i++)await flush();}

test('the spectator projection serves seated members watching a foreign fixture only',async()=>{
 const {tournamentSpectatorMatch}=await modulePromise;
 const room=running();
 const foreign=(room.fixtures||[]).find(f=>f.players&&!f.players.includes('actor-one')&&f.status==='READY');
 assert.ok(foreign,'the seed has a foreign READY fixture');
 for(const actor of foreign.players)T.readyGame(room,foreign.id,actor,foreign.opens);
 assert.equal(foreign.status,'PLAYING');assert.ok(foreign.state);
 const spectate=tournamentSpectatorMatch(room,'actor-one',foreign.id);
 assert.ok(spectate,'a seated member can project a foreign fixture');
 assert.ok(spectate.id.endsWith(':spectate'),'the spectator identity can never collide with a participation board');
 assert.equal(spectate.terms.spectate,true);
 assert.equal(spectate.status,'PLAYING');
 assert.deepEqual(spectate.players,foreign.players);
 assert.equal(spectate.revision,foreign.state.moves.length);
 assert.equal(tournamentSpectatorMatch({players:[{id:'someone-else'}]},'actor-one',foreign.id),null,'an outsider never gets a projection');
 assert.equal(tournamentSpectatorMatch(room,'actor-one','../escape'),null,'an unsafe fixture id is refused');
 const ownReady=(room.fixtures||[]).find(f=>f.players&&f.players.includes('actor-one')&&f.status==='READY');
 assert.ok(ownReady);
 assert.equal(tournamentSpectatorMatch(room,'actor-one',ownReady.id),null,'a READY fixture never projects a game');
 const done=structuredClone(room);done.status='COMPLETE';
 const doneView=tournamentSpectatorMatch(done,'actor-one',foreign.id);
 assert.ok(doneView===null||doneView.status==='FINISHED','a complete room settles the projection to FINISHED or drops it');
});

test('tournament catalog is service-supplied and guest browsing never sends a join or bootstraps a session',async()=>{
 const f=await fixture(()=>{throw Error('UNEXPECTED_MUTATION');});f.context.profile=null;f.context.sessionStatus='guest';
 await enter(f);assert.deepEqual(f.context.tournaments.tables,caps().tables);
 assert.equal(await f.controller.action('join','low'),null);assert.deepEqual(f.calls.map(call=>call.path),['/api/party/capabilities']);
 const {renderTournamentControls}=await viewPromise;assert.match(renderTournamentControls(f.context),/Sign in to join/);f.controller.destroy();
});

test('joining and approving entry are distinct canonical commands; browsing and joining never edit the wallet',async()=>{
 let room=lobby();const f=await fixture((_path,body)=>{
  if(body.type==='publicJoin')return structuredClone(room);
  if(body.type==='ready'){T.ready(room,'actor-one',body.value,body.rulesVersion);return T.view(room,1000);}
 });await enter(f);const wallet=structuredClone(f.context.profile.wallet);
 await f.controller.action('join','low');assert.equal(f.context.tournaments.room.players[0].ready,false);
 assert.deepEqual(f.calls[1].body,{type:'publicJoin',table:'low'});assert.equal(f.calls[1].key,'tournament-operation-1');
 await f.controller.action('ready');assert.deepEqual(f.calls[2].body,{type:'ready',id:'room-one',value:true,rulesVersion:1});
 assert.equal(f.context.tournaments.room.players[0].ready,true);assert.deepEqual(f.context.profile.wallet,wallet);
 const {renderTournamentControls}=await viewPromise;const html=renderTournamentControls(f.context);
 assert.match(html,/Entries are reserved together only when all ten players are ready/);assert.match(html,/Withdraw readiness/);f.controller.destroy();
});

test('an ambiguous join retries the exact operation and refuses a second competing join',async()=>{
 let writes=0;const f=await fixture((_path,body)=>{if(++writes===1)throw Error('REQUEST_TIMEOUT');return lobby();});await enter(f);
 await f.controller.action('join','low');assert.equal(f.context.tournaments.uncertain,true);assert.equal(f.context.tournaments.room,null);
 await f.controller.action('join','medium');assert.equal(writes,1);
 await f.controller.action('retry');const posts=f.calls.filter(call=>call.body);
 assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);assert.deepEqual(posts[0].body,posts[1].body);
 assert.equal(f.context.tournaments.room.id,'room-one');assert.equal(f.context.tournaments.uncertain,false);f.controller.destroy();
});

test('actor changes and route departure fence late private room replies and auth failures',async()=>{
 for(const change of ['actor','route']){
  const reply=deferred();const f=await fixture(()=>reply.promise);await enter(f);
  const action=f.controller.action('join','low');await flush();
  if(change==='actor'){f.context.profile={id:'actor-two'};f.controller.sync();}else f.leaveRoute();
  const before=structuredClone(f.context.tournaments);reply.reject(Error('AUTH_REQUIRED'));await action;await flush();
  assert.equal(f.auth.length,0);assert.equal(f.context.tournaments.room,null);
  if(change==='route')assert.deepEqual(f.context.tournaments,before);f.controller.destroy();
 }
});

test('same-actor refresh suspends a pending entry command and confirms it with the same key after resuming',async()=>{
 const first=deferred();let writes=0;const f=await fixture(()=>++writes===1?first.promise:lobby());await enter(f);
 const action=f.controller.action('join','low');await flush();const key=f.calls.find(call=>call.body).key;
 f.context.sessionStatus='loading';f.controller.sync();await action;
 assert.equal(f.context.tournaments.busy,false);assert.equal(f.context.tournaments.uncertain,true);
 f.context.sessionStatus='linked';await enter(f);await f.controller.action('retry');
 assert.equal(f.calls.filter(call=>call.body).at(-1).key,key);assert.equal(f.context.tournaments.room.id,'room-one');
 first.resolve(lobby());await flush();f.controller.destroy();
});

test('protected reads reject another actor and a newer command wins over an older poll',async()=>{
 let room=lobby(),poll=deferred(),reads=0;
 const f=await fixture((_path,body)=>{
  if(!body)return ++reads===1?structuredClone(room):poll.promise;
  T.ready(room,'actor-one',true,room.rulesVersion);return T.view(room,1000);
 });await enter(f,'room-one');const stale=structuredClone(room),refresh=f.controller.refresh();await flush();
 await f.controller.action('ready');poll.resolve(stale);await refresh;
 assert.equal(f.context.tournaments.room.players[0].ready,true);assert.ok(f.context.tournaments.room.revision>stale.revision);f.controller.destroy();
 const foreign=await fixture(()=>lobby('someone-else'));await enter(foreign,'room-one');
 assert.equal(foreign.context.tournaments.room,null);assert.equal(foreign.context.tournaments.errorCode,'INVALID_TOURNAMENT_RESPONSE');foreign.controller.destroy();
});

test('READY fixtures project no game and ready-up requires canonical opening plus membership',async()=>{
 const {tournamentMatch,tournamentFixture}=await modulePromise;let room=running();const own=tournamentFixture(room,'actor-one');
 assert.ok(own);assert.equal(tournamentMatch(room,'actor-one',own.id),null);
 const foreign=room.fixtures.find(entry=>entry.status==='READY'&&!entry.players.includes('actor-one'));
 assert.equal(tournamentFixture(room,'actor-one',foreign.id),null,'an explicit foreign fixture never falls back to an owned one');
 assert.equal(tournamentFixture(room,'actor-one','not-a-fixture'),null);
 const f=await fixture((_path,body)=>{
  if(!body)return T.view(room,room.serverNow||1000);
  T.readyGame(room,body.fixture,'actor-one',own.opens);return T.view(room,own.opens);
 });await enter(f,'room-one');assert.equal(await f.controller.action('match-ready',own.id),null);
 assert.equal(f.calls.filter(call=>call.body).length,0);
 room.serverNow=own.opens;await f.controller.refresh();await f.controller.action('match-ready',own.id);
 assert.deepEqual(f.calls.find(call=>call.body).body,{type:'matchReady',id:room.id,fixture:own.id});
 assert.equal(own.ready.includes('actor-one'),true);assert.equal(tournamentMatch(room,'outsider',own.id),null);f.controller.destroy();
});

test('fixture moves and resignations preserve board operation keys and use service authority without client actor fields',async()=>{
 const {tournamentFixture,tournamentMatch}=await modulePromise;let room=running();const own=tournamentFixture(room,'actor-one');
 for(const actor of own.players)T.readyGame(room,own.id,actor,own.opens);
 // This seed may assign actor-one O. Use the fixture's current actor as the verified account.
 const owner=own.players[0];const f=await fixture((_path,body)=>{
  if(!body)return T.view(room,own.opens);
  if(body.type==='move')T.move(room,body.fixture,owner,body.revision,body.move,own.opens+1);
  if(body.type==='resign')T.resign(room,body.fixture,owner,own.opens+2);
  return T.view(room,own.opens+2);
 });f.context.profile.id=owner;await enter(f,'room-one');
 let match=tournamentMatch(f.context.tournaments.room,owner,own.id);const move=G.legal(match.state)[0];
 const result=await f.controller.play({id:match.id,revision:0,move,key:'board-move-stable'});
 assert.equal(result.state.moves.length,1);const post=f.calls.find(call=>call.body);
 assert.deepEqual(post.body,{type:'move',id:room.id,fixture:own.id,revision:0,move});assert.equal(post.key,'board-move-stable');
 assert.equal(Object.hasOwn(post.body,'actor'),false);assert.equal(Object.hasOwn(post.body,'scope'),false);
 match=tournamentMatch(f.context.tournaments.room,owner,own.id);
 await f.controller.play({id:match.id,revision:1,key:'board-resign-stable'},true);
 assert.equal(f.calls.at(-1).key,'board-resign-stable');assert.deepEqual(f.calls.at(-1).body,{type:'resign',id:room.id,fixture:own.id});
 assert.equal(own.status,'DONE');f.controller.destroy();
});

test('room recovery stores only an actor-bound identifier and never shows a previous account’s seat',async()=>{
 const f=await fixture(()=>lobby());await enter(f);await f.controller.action('join','low');
 const saved=JSON.parse(f.storage.get('mega-web-tournament-room'));assert.deepEqual(saved,{actorId:'actor-one',id:'room-one'});
 f.context.profile={id:'actor-two'};await enter(f);assert.equal(f.context.tournaments.room,null);
 assert.equal(f.calls.filter(call=>call.path.includes('/rooms/')).length,0);f.controller.destroy();
});

test('leaving uses the canonical command; auth expiry and suspended renderers never show stale signed-in actions',async()=>{
 let room=lobby();const f=await fixture((_path,body)=>{if(body.type==='publicJoin')return structuredClone(room);T.leave(room,'actor-one');return T.view(room,1000);});
 await enter(f);await f.controller.action('join','low');await f.controller.action('leave');
 assert.equal(f.context.tournaments.room,null);assert.deepEqual(f.calls.at(-1).body,{type:'leave',id:'room-one'});
 assert.equal(f.storage.size,0);f.controller.destroy();
 const {renderTournamentControls}=await viewPromise;
 const html=renderTournamentControls({sessionStatus:'loading',profile:{id:'actor-one'},tournaments:{status:'ready',tables:caps().tables,room:lobby(),available:true}});
 assert.match(html,/Confirming your account/);assert.doesNotMatch(html,/Sign in|approve entry|data-tournament-action="join"/);
 const expired=await fixture(()=>{throw Error('SESSION_REVOKED');});await enter(expired);await expired.controller.action('join','low');assert.deepEqual(expired.auth,['SESSION_REVOKED']);expired.controller.destroy();
});

test('room refresh is read-only and bounded even when an injected transport never settles',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(()=>new Promise(()=>{}));await enter(f);
 const work=f.controller.load({force:true});await flush(); // no room, only catalog
 await work;f.controller.sync({roomId:'room-one'});await flush();t.mock.timers.tick(8000);await flush();
 assert.equal(f.context.tournaments.errorCode,'REQUEST_TIMEOUT');assert.equal(f.calls.filter(call=>call.body).length,0);f.controller.destroy();
});

test('an opaque session replacement fences old same-actor callbacks and keeps ambiguous requests retryable',async()=>{
 const first=deferred();let identity={csrf:'first'},writes=0;
 const f=await fixture(()=>++writes===1?first.promise:lobby(),{session:()=>identity});await enter(f);
 const action=f.controller.action('join','low');await flush();const key=f.calls.find(call=>call.body).key;
 identity={csrf:'replacement'};first.reject(Error('AUTH_REQUIRED'));await action;
 assert.equal(f.auth.length,0,'an old cookie refusal cannot sign out the replacement');
 await enter(f);assert.equal(f.context.tournaments.busy,false);assert.equal(f.context.tournaments.uncertain,true);
 await f.controller.action('retry');assert.equal(f.calls.filter(call=>call.body).at(-1).key,key);
 assert.equal(f.context.tournaments.room.id,'room-one');assert.equal(f.context.tournaments.uncertain,false);f.controller.destroy();
});

test('a current shared-client revocation clears its cached identity before the refusal is delivered',async()=>{
 let identity={csrf:'first'};const f=await fixture(()=>{identity=null;throw Error('SESSION_REVOKED');},{session:()=>identity});
 await enter(f);await f.controller.action('join','low');assert.deepEqual(f.auth,['SESSION_REVOKED']);f.controller.destroy();
});

test('leaving and returning during an uncertain join never strands busy state or creates a competing operation',async()=>{
 const first=deferred();let writes=0;const f=await fixture(()=>++writes===1?first.promise:lobby());await enter(f);
 const action=f.controller.action('join','low');await flush();const key=f.calls.find(call=>call.body).key;
 f.controller.deactivate();await action;await enter(f);
 assert.equal(f.context.tournaments.busy,false);assert.equal(f.context.tournaments.uncertain,true);
 await f.controller.action('join','medium');assert.equal(writes,1);
 await f.controller.action('retry');assert.equal(f.calls.filter(call=>call.body).at(-1).key,key);assert.equal(writes,2);
 first.resolve(lobby());await flush();f.controller.destroy();
});
