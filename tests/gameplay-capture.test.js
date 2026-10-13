'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const G = require('../src/game.js'), C = require('../packages/learning/capture.js');
const provenance = {sourceCommit:'a'.repeat(40),environment:'test',population:'test-fixture'};
function source(seed = 1, reason = 'line', max = 81) {
 let n=seed>>>0; const rng=()=>((n=(Math.imul(n,1664525)+1013904223)>>>0)/4294967296);
 let s=G.create(); while(!s.winner && s.moves.length<max){const ms=G.legal(s);s=G.apply(s,ms[Math.floor(rng()*ms.length)]);}
 if (s.winner) reason=s.winner==='DRAW'?'draw':'line';
 const outcome = ['line','draw'].includes(reason)?s.winner : reason==='void'?null:(s.turn==='X'?'O':'X');
 const state=structuredClone(s);if(['resign','timeout'].includes(reason))state.winner=outcome;
 return {kind:'match',id:'synthetic_'+seed,attempt:0,revision:s.moves.length,status:reason==='void'?'VOID':'FINISHED',settled:true,
  mode:'casual',rated:false,clockSeconds:30,incrementSeconds:0,players:['test_alice','test_bob'],symbols:{X:'test_alice',O:'test_bob'},moves:s.moves,state,
  timings:s.moves.map(m=>({actor:m.player==='X'?'test_alice':'test_bob',ms:100})),winnerActor:outcome==='X'?'test_alice':outcome==='O'?'test_bob':null,
  reason,startedAt:1000,endedAt:1000+s.moves.length*100+100,lastMoveAt:1000+s.moves.length*100,riskFlags:[],historyOnly:false};
}
module.exports={source,provenance};
test('200 complete canonical games replay every observed decision and correct value perspective',()=>{
 let draws=0;for(let i=1;i<=200;i++){const s=source(i),r=C.seal(s,provenance);const v=C.validate(r.payload,r.sha256);assert.equal(v.plies,s.revision);assert.equal(v.terminalValueEligible,true);draws+=v.boardWinner==='DRAW';
  for(const p of C.positions(r.payload)){assert.equal(p.legalMask[p.observedAction],1);assert.equal(p.observedAction,p.playedMove.b*9+p.playedMove.c);assert.equal(p.valueTarget,s.reason==='draw'?0:(p.player===v.boardWinner?1:-1));assert.equal(p.searchPolicy,null);}
 }assert.ok(draws>0,'real legal draw trajectories, not fabricated states');
});
for(const reason of ['resign','timeout','void'])test(reason+' is not a terminal-board value label',()=>{const s=source(1,reason,5),r=C.seal(s,provenance);assert.equal(r.payload.game.boardWinner,null);for(const p of C.positions(r.payload))assert.equal(p.valueTarget,null);assert.equal(r.payload.game.reason,reason);});
test('both actor/symbol seat assignments preserved without identifiers in the gameplay payload',()=>{const s=source(1);s.players.reverse();const r=C.seal(s,provenance);assert.deepEqual(r.payload.game.seatSymbols,['O','X']);assert.deepEqual(r.subjects.map(p=>p.actorId),s.players);assert.ok(!C.stable(r.payload).includes('test_alice'));assert.ok(!C.stable(r.payload).includes('test_bob'));});
test('stable checksum independent of object property insertion order, and tampering detected',()=>{const r=C.seal(source(2),provenance);assert.equal(C.sha256(r.payload),C.sha256(Object.fromEntries(Object.entries(r.payload).reverse())));r.payload.moves[0].thinkMs++;assert.throws(()=>C.validate(r.payload,r.sha256),/CAPTURE_HASH/);});
test('missing history metadata remains unknown, never fabricated',()=>{const s=source(3);s.kind='fixture';s.id='["room","g1"]';s.attempt=1;s.mode='tournament';s.historyOnly=true;s.state=null;s.timings=null;s.startedAt=null;s.endedAt=null;s.lastMoveAt=null;const r=C.seal(s,provenance);assert.ok(r.payload.qualityFlags.includes('HISTORY_ONLY'));assert.equal(r.payload.moves[0].thinkMs,null);});
const bad = [
 ['wrong revision',s=>s.revision++],['wrong player',s=>s.moves[1].player='X'],['out of bounds',s=>s.moves[0].c=9],['fraction',s=>s.moves[0].b=.5],
 ['repeat occupied',s=>s.moves[1]={...s.moves[0],player:'O'}],['wrong board',s=>s.state.board[0][0]=s.state.board[0][0]==='O'?'X':'O'],['wrong mini',s=>s.state.mini[0]=s.state.mini[0]==='O'?'X':'O'],
 ['bad routing',s=>s.state.required=99],['missing ply',s=>s.moves.splice(2,1)],['bad timing actor',s=>s.timings[0].actor='attacker'],
 ['negative timing',s=>s.timings[0].ms=-1],['missing timing',s=>s.timings.pop()],['false draw',s=>s.reason='draw'],['wrong winner',s=>s.winnerActor='outsider'],
 ['unfinished',s=>s.settled=false],['bad source',s=>s.kind='utttai'],['personal field',s=>s.email='secret@example.invalid'],['excess moves',s=>s.moves=Array(82).fill(s.moves[0])],
 ['invalid dates',s=>s.endedAt=0],['symbol collision',s=>s.symbols.O=s.symbols.X],['raw risk text',s=>s.riskFlags=['user email = secret']],
 ['o first from online',s=>{s.moves[0].player='O';}],['source state moves differ',s=>s.state.moves=[]],
];
for(const [name,mutate] of bad)test('reject corruption: '+name,()=>{const s=source(3);mutate(s);assert.throws(()=>C.seal(s,provenance),/CAPTURE_/);});
test('bounded payload disallows unknown/private exported fields and malformed labels',()=>{for(const fn of [p=>p.password='secret',p=>p.moves[0].email='secret',p=>p.provenance.population='human',p=>p.game.adjudicatedWinner=null,p=>p.final.line=[8,8,8],p=>p.source.sha256='forged']){const r=C.seal(source(3),provenance);fn(r.payload);assert.throws(()=>C.validate(r.payload),/CAPTURE_/);}});
