'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const G=require('../../src/game.js'),D=require('../../src/domain.js'),C=require('../../src/bot/contracts.js');
test('bot suggestions must pass canonical legality and exact match/revision fencing',()=>{
 const state=G.create();const move=C.assertMove(state,{b:0,c:4});const next=G.apply(state,move);
 assert.equal(next.required,4);assert.equal(state.moves.length,0);
 assert.deepEqual(C.accept({state,gameId:'a',revision:0},{gameId:'a',revision:0,move}),move);
 for(const result of [{gameId:'b',revision:0,move},{gameId:'a',revision:1,move},{gameId:'a',revision:0,move:{b:99,c:4}}])assert.throws(()=>C.accept({state,gameId:'a',revision:0},result));
 assert.throws(()=>C.assertMove(next,{b:0,c:0}),/ILLEGAL_BOT_MOVE/);
});
test('seeded diagnostics replay without credentials or personal data',()=>{
 const a=C.seeded(15),b=C.seeded(15);for(let i=0;i<100;i++)assert.equal(a(),b());
 assert.deepEqual(Object.keys(C.diagnostics({difficulty:'Expert',seed:15,budgetMs:320})),['version','ruleset','difficulty','modelHash','rngSeed','thinkingBudget']);
});
test('first five rewards and unpaid practice boundary remain unchanged',()=>{
 assert.deepEqual(D.BOT_PAY,{Beginner:1,Easy:1,Medium:2,Hard:4,Expert:6});
 const data=D.fresh(),before=structuredClone(data);
 assert.equal(D.complete(data,{id:'tutorial-test',mode:'bot',difficulty:'Beginner',practice:true,result:'win',reason:'line',moves:60,activeSeconds:600,claimed:5}),0);
 assert.deepEqual(data.wallet,before.wallet);assert.deepEqual(data.records,before.records);assert.deepEqual(data.daily,before.daily);
 assert.throws(()=>D.complete(data,{id:'forged-ranked',mode:'ranked',result:'win',moves:60,activeSeconds:600}),/SERVER_RESULT_REQUIRED/);
});
