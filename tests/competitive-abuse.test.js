'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const ABUSE=require('../server/competitive-abuse.js');
const T=require('../src/tournament.js');
const {Authority}=require('../src/authority.js');

test('automation review is conservative and non-blocking',()=>{
 const slow=[...Array(20)].map((_,i)=>({actor:'a',ms:i%2?900:1200}));
 const tooFew=[...Array(9)].map(()=>({actor:'a',ms:50}));
 const fast=[...Array(10)].map((_,i)=>({actor:'a',ms:i<3?80:200}));
 assert.deepEqual(ABUSE.automationActors(slow),[]);
 assert.deepEqual(ABUSE.automationActors(tooFew),[]);
 assert.deepEqual(ABUSE.automationActors(fast),['a']);
});

test('rated repeat and forfeit patterns produce review signals without changing eligibility',()=>{
 const now=Date.parse('2026-10-07T12:00:00Z');
 const players=[
  {id:'a',history:[{id:'old1',at:now-2*86400000,opponent:'b',rated:true,reason:'resign'},{id:'old2',at:now-86400000,opponent:'b',rated:true,reason:'line'}]},
  {id:'b',history:[{id:'old1',at:now-2*86400000,opponent:'a',rated:true,reason:'resign'},{id:'old2',at:now-86400000,opponent:'a',rated:true,reason:'line'}]}
 ];
 const match={id:'current',players:['a','b'],quote:{rated:true},riskFlags:[],receipt:{reason:'resign'},_moveTimings:[]};
 const result=ABUSE.matchSignals(match,players,now);
 assert(result.flags.includes('REPEAT_RATED_PAIR_REVIEW'));
 assert(result.flags.includes('REPEAT_FORFEIT_PAIR_REVIEW'));
});

test('tournament flags concentrated forfeits and fast automated cadence for review',()=>{
 const room={riskFlags:[],fixtures:[
  {players:['a','b'],winner:'a',reason:'resign',_moveTimings:[]},
  {players:['a','c'],winner:'a',reason:'no-show',_moveTimings:[]},
  {players:['a','d'],winner:'a',reason:'timeout',_moveTimings:[...Array(10)].map((_,i)=>({actor:'a',ms:i<3?60:180}))},
  {players:['e','f'],winner:'e',reason:'resign',_moveTimings:[]},
  {players:['g','h'],winner:'g',reason:'resign',_moveTimings:[]}
 ]};
 const result=ABUSE.tournamentSignals(room);
 for(const flag of ['HIGH_FORFEIT_RATE','CONCENTRATED_FORFEITS_REVIEW','AUTOMATION_SPEED_REVIEW'])assert(result.flags.includes(flag));
 assert.deepEqual(result.actors.CONCENTRATED_FORFEITS_REVIEW,['a']);
 assert.deepEqual(result.actors.AUTOMATION_SPEED_REVIEW,['a']);
});

test('private timing evidence never appears in normal match or tournament views',()=>{
 let now=1000;const a=new Authority({now:()=>now,random:()=>0});
 a.addAccount('alice',{crowns:20,rating:1500,games:30,verified:true});a.addAccount('bob',{crowns:20,rating:1500,games:30,verified:true});
 a.account('alice').friends=['bob'];a.account('bob').friends=['alice'];
 const q=a.offer('m','alice','bob',{kind:'friend',amount:2});a.accept('m','bob',q.termsHash);
 const m=a.matches.get('m'),actor=m.symbols[m.state.turn];now+=50;a.move('m',actor,0,'move-1',require('../src/game.js').legal(m.state)[0]);
 assert.equal(m._moveTimings.length,1);assert.equal(m._moveTimings[0].actor,actor);assert.equal(m._moveTimings[0].ms,50);
 const publicMatch=a.view('m');assert.equal(publicMatch._moveTimings,undefined);assert.equal(publicMatch._lastMoveAt,undefined);assert.equal(publicMatch._riskActors,undefined);

 const room={status:'RUNNING',clock:180,groups:[],_riskActors:{AUTOMATION_SPEED_REVIEW:['alice']},fixtures:[{id:'g1',status:'PLAYING',players:['alice','bob'],state:{turn:'X'},banks:{alice:180,bob:180},turnAt:1000,_moveTimings:[{actor:'alice',ms:50}],_lastMoveAt:1050}]};
 const publicRoom=T.view(room,1100);assert.equal(publicRoom._riskActors,undefined);assert.equal(publicRoom.fixtures[0]._moveTimings,undefined);assert.equal(publicRoom.fixtures[0]._lastMoveAt,undefined);
});


test('live match settlement emits automation review signal without changing result',()=>{
 let now=2000;const a=new Authority({now:()=>now,random:()=>0});
 a.addAccount('alice',{crowns:20,rating:1500,games:30,verified:true});a.addAccount('bob',{crowns:20,rating:1500,games:30,verified:true});
 a.account('alice').friends=['bob'];a.account('bob').friends=['alice'];
 const q=a.offer('risk-live','alice','bob',{kind:'friend',amount:2});a.accept('risk-live','bob',q.termsHash);
 const m=a.matches.get('risk-live');m._moveTimings=[...Array(10)].map((_,i)=>({actor:'alice',ms:i<3?60:180}));
 const receipt=a.resign('risk-live','bob'),view=a.view('risk-live');
 assert.equal(receipt.winner,'alice');assert(view.riskFlags.includes('AUTOMATION_SPEED_REVIEW'));
 assert.equal(view._riskActors,undefined);assert.equal(view._moveTimings,undefined);
});
