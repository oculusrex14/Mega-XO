'use strict';
/* V5-01-03 pure-domain boundary regression: packages/domain.
 *
 * These tests exercise the extracted public domain surface with real values: the economic command
 * dispatch/role gates, the approved matchmaking policy and the injected clock/randomness seams.
 * They assert frozen product behavior and privilege boundaries, never source text, forwarding
 * equality or default-table echoes. Each file is run by `node --test` in its own process.
 */
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),{execFileSync}=require('node:child_process');
const D=require('../packages/domain');
const {Authority,executeCommand,game,policy,matchmaking,abuse}=D;

const REPO_ROOT=path.resolve(__dirname,'..');
const PKG_ENTRY=path.join(REPO_ROOT,'packages','domain','index.js');
const NOW=Date.parse('2026-10-05T12:00:00Z');

function authority(extra={}){const a=new Authority({now:()=>NOW,random:()=>0,...extra});
 a.addAccount('alice',{coins:1000,crowns:1000,rating:1500,games:30,verified:true});
 a.addAccount('bob',{coins:1000,crowns:1000,rating:1500,games:30,verified:true});
 return a;}
const player=actor=>({actor,scope:'player'});

test('packages/domain exposes real approved behavior on its public surface',()=>{
 assert.equal(policy.coinsPerCrown,10);
 assert.equal(game.legal(game.create()).length,81);
 assert.equal(game.LEVELS.length,5);
 assert.equal(D.tournament.prize('low').pool,1000);
 assert.equal(D.monetization.packInfo('crowns_100').coinEquivalent,1000);
 // One definition, not a copy: consumers of the package and the shipped client must see the same
 // frozen policy object and Authority class, otherwise a policy/constant set has been duplicated.
 assert.equal(policy,require('../src/domain.js').POLICY);
 assert.equal(Authority,require('../src/authority.js').Authority);
});

test('pure package graph loads without HTTP, SQLite or socket modules',()=>{
 // Spawned child so the module graph is loaded fresh under a trapping loader. This catches a
 // future server/SQLite/socket import leaking into the HTTP-free domain package.
 const probe=`const M=require('node:module'),load=M._load,bad=[];
  M._load=function(request){if(/^(node:)?(sqlite|http|https|net|dgram|tls)$/.test(String(request)))bad.push(String(request));return load.apply(this,arguments);};
  require(${JSON.stringify(PKG_ENTRY)});
  process.stdout.write(JSON.stringify(bad));`;
 const bad=JSON.parse(execFileSync(process.execPath,['-e',probe],{encoding:'utf8'}));
 assert.deepEqual(bad,[]);
});

test('economic command roles match the frozen legacy switch and are enforced before mutation',()=>{
 // Independently recorded from the pre-existing switch in server/economy-store.js:28-50.
 const gated={provision:['operator'],queue:['matchmaker'],timeout:['operator','matchmaker'],expire:['operator','matchmaker'],void:['operator'],snapshot:['operator'],weekly:['operator'],refund:['store']};
 assert.deepEqual(Object.fromEntries(Object.entries(D.COMMAND_ROLES).map(([k,v])=>[k,[...v]])),gated);
 const scopes=['player','operator','matchmaker','store'];
 const calls=[];
 const stub=new Proxy({},{get:()=>(...args)=>{calls.push(args);return undefined;}});
 for(const [type,roles] of Object.entries(gated))for(const scope of scopes){
  const cmd={type,id:'m',account:'x',week:'2026-09-28',store:'apple',transactionId:'t'};
  if(roles.includes(scope))assert.deepEqual(executeCommand(stub,{actor:'a',scope},'k',cmd),{ok:true});
  else assert.throws(()=>executeCommand(stub,{actor:'a',scope},'k',cmd),/FORBIDDEN/);
 }
 assert.equal(calls.length,Object.entries(gated).reduce((n,[,roles])=>n+roles.length,0));
 // The legacy switch only gates the eight commands above: every other command stays available to
 // any validated principal scope, and the executor must not tighten that on its own.
 const ungated={preferences:['wealthPublic','region'],cosmetic:['Copper edge']};
 for(const scope of scopes)for(const [type,names] of Object.entries(ungated)){
  const before=calls.length;
  const cmd=type==='preferences'?{type,changes:{wealthPublic:true}}:{type,name:names[0]};
  assert.deepEqual(executeCommand(stub,{actor:'a',scope},'k',cmd),{ok:true});
  assert.equal(calls.length,before+1);
 }
 expectScopesAreFrozen();
 function expectScopesAreFrozen(){assert.deepEqual([...D.PRINCIPAL_SCOPES],['player','operator','matchmaker','store']);}
});

test('unknown commands are rejected for every principal scope',()=>{
 const a=authority(),stub=new Proxy({},{get:()=>()=>undefined});
 for(const scope of ['player','operator','matchmaker','store'])assert.throws(()=>executeCommand(stub,{actor:'a',scope},'k',{type:'nope'}),/UNKNOWN_COMMAND/);
 for(const scope of ['player','operator','matchmaker','store'])assert.throws(()=>executeCommand(a,{actor:'alice',scope},'k',{type:'nope'}),/UNKNOWN_COMMAND/);
});

test('an unmet quest claim keeps its legacy falsy 0, not an {ok:true} envelope',()=>{
 const a=authority();
 assert.equal(executeCommand(a,player('alice'),'quest:ranked',{type:'quest',quest:'ranked'}),0);
 assert.equal(executeCommand(a,player('alice'),'quest:unknown',{type:'quest',quest:'missing'}),0);
 a.account('alice').suspended=true;
 assert.throws(()=>executeCommand(a,player('alice'),'quest:held',{type:'quest',quest:'finish'}),/ACCOUNT_HELD/);
});

test('the command key is passed through to legacy idempotent operations',()=>{
 const a=authority();
 const first=executeCommand(a,player('alice'),'convert-op',{type:'convert',from:'coins',amount:100});
 assert.equal(first.duplicate,undefined);
 assert.equal(a.account('alice').crowns,1010);
 const replay=executeCommand(a,player('alice'),'convert-op',{type:'convert',from:'coins',amount:100});
 assert.equal(replay.duplicate,true);
 assert.equal(a.account('alice').crowns,1010);
 assert.throws(()=>executeCommand(a,player('alice'),'convert-op',{type:'convert',from:'coins',amount:200}),/IDEMPOTENCY_CONFLICT/);
});

test('matchmaker-scope queueing still creates one hidden OFFERED match and keeps client scope out',()=>{
 const a=authority();
 assert.throws(()=>executeCommand(a,player('alice'),'pair:1',{type:'queue',id:'queue:1',a:'alice',b:'bob'}),/FORBIDDEN/);
 const view=executeCommand(a,{actor:'matchmaker',scope:'matchmaker'},'pair:1',{type:'queue',id:'queue:1',a:'alice',b:'bob',mode:'ranked',turnSeconds:30});
 assert.equal(view.status,'OFFERED');
 assert.equal(view.id,'queue:1');
 assert.deepEqual(view.players,['alice','bob']);
 assert.equal(view.terms.rated,true);
 assert.equal(view.terms.currency,'coins');
 assert.equal(view.terms.turnSeconds,30);
 // The matchmaker principal may not silently recreate an existing match id.
 assert.throws(()=>executeCommand(a,{actor:'matchmaker',scope:'matchmaker'},'pair:1',{type:'queue',id:'queue:1',a:'alice',b:'bob'}),/DUPLICATE_OR_INVALID_MATCH/);
});

test('approved ranked/casual search windows widen exactly as shipped',()=>{
 const ranked={games:30,rating:1500},provisional={games:3,rating:900},elite={games:80,rating:2700};
 assert.equal(matchmaking.searchWindow('ranked',0,ranked),50);
 assert.equal(matchmaking.searchWindow('ranked',9.9,ranked),50);
 assert.equal(matchmaking.searchWindow('ranked',10,ranked),100);
 assert.equal(matchmaking.searchWindow('ranked',25,ranked),150);
 assert.equal(matchmaking.searchWindow('ranked',75,ranked),200);
 assert.equal(matchmaking.searchWindow('ranked',80,elite),250);
 assert.equal(matchmaking.searchWindow('ranked',10,provisional),125);
 assert.equal(matchmaking.searchWindow('ranked',45,provisional),200);
 assert.equal(matchmaking.searchWindow('casual',5,casualAccount()),100);
 assert.equal(matchmaking.searchWindow('casual',20,casualAccount()),250);
 assert.equal(matchmaking.searchWindow('casual',60,casualAccount()),350);
 function casualAccount(){return {games:30,rating:1500,casualRating:1400};}
});

test('approved eligibility boundaries and pairing score are unchanged',()=>{
 const now=1_000_000;
 const ticket=(actor,joinedAt,region='iad',latencyMs=40)=>({actor,mode:'ranked',joinedAt,region,latencyMs});
 const account=(id,rating,extra={})=>({id,rating,games:30,casualRating:rating,verified:true,friends:[],blocked:[],history:[],suspended:false,hold:false,activeMatch:null,...extra});
 const A=account('a',1500),B=account('b',1500);
 const clean=matchmaking.compatibility(A,B,ticket('a',now,'iad',40),ticket('b',now,'iad',40),'ranked',now);
 assert.equal(clean.ok,true);
 assert.equal(clean.gap,0);
 assert.equal(clean.quality,1);
 assert.equal(clean.score,2); // 0 gap + 0 region penalty + (40+40)/40 latency
 assert.deepEqual(clean.skills,[1500,1500]);
 assert.equal(clean.sameRegion,true);
 assert.equal(matchmaking.compatibility(account('a',1500,{friends:['b']}),account('b',1500,{friends:['a']}),ticket('a',now),ticket('b',now),'ranked',now).reason,'FRIEND_QUEUE_BLOCK');
 assert.equal(matchmaking.compatibility(account('a',1500,{blocked:['b']}),B,ticket('a',now),ticket('b',now),'ranked',now).reason,'BLOCKED');
 assert.equal(matchmaking.compatibility(account('a',1500,{activeMatch:'m'}),B,ticket('a',now),ticket('b',now),'ranked',now).reason,'INELIGIBLE');
 assert.equal(matchmaking.compatibility(account('a',1500,{verified:false}),B,ticket('a',now),ticket('b',now),'ranked',now).reason,'INELIGIBLE');
 const rematch=account('a',1500,{history:[{opponent:'b',queue:true,rated:true,at:now-1000}]});
 assert.equal(matchmaking.compatibility(rematch,B,ticket('a',now-10_000),ticket('b',now-10_000),'ranked',now).reason,'RECENT_OPPONENT');
 assert.equal(matchmaking.compatibility(A,B,ticket('a',now-10_000,'iad'),ticket('b',now-10_000,'sin'),'ranked',now).reason,'REGION_WAIT');
 assert.equal(matchmaking.compatibility(A,B,ticket('a',now-40_000,'iad'),ticket('b',now-40_000,'sin'),'ranked',now).ok,true);
 assert.equal(matchmaking.compatibility(A,B,ticket('a',now,'iad',351),ticket('b',now,'iad',40),'ranked',now).reason,'LATENCY_LIMIT');
 assert.equal(matchmaking.compatibility(A,B,ticket('a',now,'iad',350),ticket('b',now,'iad',40),'ranked',now).ok,true);
 assert.equal(matchmaking.compatibility(account('a',700,{games:3}),account('b',720,{games:40}),ticket('a',now-10_000),ticket('b',now-10_000),'ranked',now).reason,'PLACEMENT_POOL');
 assert.equal(matchmaking.compatibility(A,B,ticket('a',now),ticket('b',now),'bogus',now).reason,'INVALID_MODE');
 assert.equal(matchmaking.tournamentWindow(30),150);
 assert.equal(matchmaking.tournamentWindow(90),200);
});

test('the stateful matchmaking layer pairs only through the one package policy',()=>{
 const server=require('../server/matchmaking.js');
 assert.equal(server.CONFIG,matchmaking.CONFIG); // one constants set, not a duplicated copy
 const now=1_000_000;
 const accounts=new Map([['a',{id:'a',rating:1500,games:30,casualRating:1500,verified:true,friends:[],blocked:[],history:[],suspended:false,hold:false,activeMatch:null,coins:1000,crowns:1000}],
                          ['b',{id:'b',rating:1500,games:30,casualRating:1500,verified:true,friends:[],blocked:[],history:[],suspended:false,hold:false,activeMatch:null,coins:1000,crowns:1000}]]);
 const auth={account:id=>{const x=accounts.get(id);if(!x)throw Error('UNKNOWN_ACCOUNT');return x;},currentTier:()=>'gold'};
 const writes=[];
 const store={read:()=>({account:auth.account,currentTier:auth.currentTier,view:id=>({id,status:'OFFERED'})}),run:(principal,key,cmd)=>{writes.push({principal,key,cmd});return {id:cmd.id,termsHash:'t',expires:now+15000};}};
 const solo=new server.Matchmaker({store,now:()=>now,makeId:()=>'solo'});
 const searching=solo.enqueue('a','ranked','k1',{region:'iad',latencyMs:30});
 assert.equal(searching.state,'searching');
 // The reported search window is the injected package policy evaluated at the real wait time.
 assert.equal(searching.window,matchmaking.searchWindow('ranked',0,accounts.get('a')));
 assert.equal(searching.window,50);
 const mm=new server.Matchmaker({store,now:()=>now,makeId:()=>'pair'});
 mm.enqueue('a','ranked','k1',{region:'iad',latencyMs:30});
 const matched=mm.enqueue('b','ranked','k2',{region:'iad',latencyMs:30});
 assert.equal(matched.state,'matched');
 assert.equal(matched.matchId,'queue:pair');
 assert.equal(matched.quality,1);
 assert.equal(matched.ratingGap,0);
 assert.equal(writes.length,1);
 assert.equal(writes[0].principal.scope,'matchmaker');
 assert.deepEqual(writes[0].cmd,{type:'queue',id:'queue:pair',a:'a',b:'b',mode:'ranked',turnSeconds:30});
 assert.equal(writes[0].key,'pair:queue:pair');
 const map=new Map([['a',{id:'a',rating:1000,games:5}],['b',{id:'b',rating:1400,games:5}],['c',{id:'c',rating:1200,games:5}]]);
 assert.deepEqual(server.tournamentSeed(['a','b','c'],{accounts:map}),['b','c','a']);
 assert.deepEqual(matchmaking.tournamentSeed(['a','b','c'],{accounts:map}),['b','c','a']);
});

test('review-only abuse signals are exposed once and never punish',()=>{
 const samples=[...Array(10)].map((_,i)=>({actor:'a',ms:i<3?60:180}));
 assert.deepEqual(D.abuse.automationActors(samples),['a']);
 assert.deepEqual(abuse.matchSignals({players:['a','b'],riskFlags:[],quote:{rated:false},_moveTimings:samples},[{id:'a'},{id:'b'}],0).flags,['AUTOMATION_SPEED_REVIEW']);
 const verdict=abuse.tournamentSignals({riskFlags:[],fixtures:[{players:['a','b'],winner:'a',reason:'resign',_moveTimings:[]}]});
 assert.deepEqual(verdict.flags,[]);
 assert.deepEqual(verdict.actors,{});
 assert.deepEqual(require('../server/competitive-abuse.js').automationActors(samples),['a']);
});

test('game.choose keeps legacy 3-argument behavior and honours the injected clock',()=>{
 const state=game.create();
 for(const level of game.LEVELS){
  const move=game.choose(state,level);
  assert(game.legal(state).some(x=>x.b===move.b&&x.c===move.c),level);
 }
 // The approved loop reads its time source once for the deadline and again on every node-counted
 // re-check. The open board is deep enough to trip those re-checks, so the injected clock must see
 // several calls; a single read would mean the deadline was never re-evaluated through the seam.
 let ticks=0;
 const medium=game.choose(state,'Medium',()=>0.5,{clock:()=>{ticks++;return 0;}});
 assert(ticks>1);
 assert(game.legal(state).some(x=>x.b===medium.b&&x.c===medium.c));
 // Identical inputs must produce an identical clock call pattern, not just an identical move.
 let again=0;
 game.choose(state,'Medium',()=>0.5,{clock:()=>{again++;return 0;}});
 assert.equal(again,ticks);
 // The legacy 4th-argument-less call still prefers performance.now, while an injected clock replaces
 // every time read: a sandbox whose Date.now/performance.now throw still chooses only via the seam.
 const vm=require('node:vm'),fs=require('node:fs');
 const sandbox={module:{exports:{}},Date:{now:()=>{throw Error('REAL_TIME_USED');}},performance:{now:()=>{throw Error('REAL_TIME_USED');}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/game.js'),'utf8'),sandbox);
 const iso=sandbox.module.exports;
 const isoMove=iso.choose(iso.create(),'Medium',()=>0.5,{clock:()=>0}),realMove=game.choose(game.create(),'Medium',()=>0.5,{clock:()=>0});
 assert.deepEqual({b:isoMove.b,c:isoMove.c},{b:realMove.b,c:realMove.c}); // same choice across realms
 assert.throws(()=>iso.choose(iso.create(),'Medium',()=>0.5),/REAL_TIME_USED/); // default source is still performance.now()
 // Beginner/Easy never consult the search-budget clock, so the injected seam stays minimal.
 let beginnerTicks=0;
 const beginner=game.choose(state,'Beginner',()=>0,{clock:()=>{beginnerTicks++;return 0;}});
 assert.equal(beginnerTicks,0);
 assert(game.legal(state).some(x=>x.b===beginner.b&&x.c===beginner.c));
 // A frozen clock cannot leak real time into the choice: identical inputs stay identical.
 const frozen=()=>1234;
 assert.deepEqual(game.choose(state,'Medium',()=>0.25,{clock:frozen}),game.choose(state,'Medium',()=>0.25,{clock:frozen}));
});

test('approved first-player choice draws exactly once and prefers the unbiased side',()=>{
 const {chooseSymbols}=require('../src/authority.js');
 const biased=(symbols=[])=>({history:symbols.map(symbol=>({queue:true,symbol}))});
 const eightX=biased(['X','X','X','X','X','X','X','X']),none=biased([]);
 // A clear bias resolves without consuming the injected RNG at all.
 assert.equal(chooseSymbols([eightX,none],'queue',()=>{throw Error('MUST_NOT_DRAW');}),true);
 assert.equal(chooseSymbols([none,eightX],'queue',()=>{throw Error('MUST_NOT_DRAW');}),false);
 // An exact tie is the only queue case that draws, and a direct pairing always draws once.
 assert.equal(chooseSymbols([none,none],'queue',()=>1),true);
 assert.equal(chooseSymbols([none,none],'queue',()=>0),false);
 assert.equal(chooseSymbols([none,none],'direct',()=>1),true);
 assert.equal(chooseSymbols([none,none],'direct',()=>0),false);
 let draws=0;
 const counted=()=>{draws++;return 1;};
 chooseSymbols([none,none],'queue',counted);
 assert.equal(draws,1);
});
