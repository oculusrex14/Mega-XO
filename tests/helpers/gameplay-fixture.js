'use strict';
const G = require('../../src/game.js');
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
