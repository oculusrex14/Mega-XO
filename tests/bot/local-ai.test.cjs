'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const G=require('../../src/game.js'),D=require('../../src/domain.js'),L=require('../../src/bot/local-ai.js'),C=require('../../src/bot/contracts.js');
const hash='a'.repeat(64),pin={ruleset:C.RULESET,encodingVersion:'planes8-v1',modelHash:hash,packVersion:'fixture'},catalog=[{...pin,version:pin.packVersion,sha256:hash,deploymentStatus:'APPROVED'}];
function match(){return L.create({id:'local-fixture',pin,seed:33},catalog);}
test('unavailable model restore retains every human move and never relabels Impossible',()=>{let m=match();m=L.accept(m,{gameId:m.id,revision:0,move:{b:0,c:4},diagnostics:{modelHash:hash}});const saved=L.snapshot(m),resumed=L.restore(saved,[]);assert.equal(resumed.status,'pack-unavailable');assert.equal(resumed.difficulty,'Impossible');assert.deepEqual(resumed.state,m.state);assert.throws(()=>L.accept(resumed,{}),/NOT_READY/);assert.throws(()=>L.expertFallback(resumed),/CONFIRMATION/);const fallback=L.expertFallback(resumed,{confirmed:true});assert.equal(fallback.difficulty,'Expert');assert.equal(fallback.resultClass,L.RESULT_CLASS);assert.deepEqual(fallback.state,m.state);assert.equal(L.restore(L.snapshot(fallback),[]).engine,'legacy');});
test('tampered model, move player, revision and unsupported result classes fail closed',()=>{const m=match();assert.throws(()=>L.create({id:'x',pin}));assert.throws(()=>L.accept(m,{gameId:m.id,revision:0,move:{b:0,c:4},diagnostics:{modelHash:'b'.repeat(64)}}),/MODEL_CHANGED/);let saved=L.snapshot(m);assert.throws(()=>L.restore({...saved,revision:1},catalog));assert.throws(()=>L.restore({...saved,moves:[{b:0,c:0,player:'O'}],revision:1},catalog));assert.throws(()=>L.restore({...saved,resultClass:'ranked'},catalog));});
test('local completed records are separate, idempotent and leave economy and normal stats untouched',()=>{let m=match();const rng=C.seeded(5);while(!m.state.winner){const moves=G.legal(m.state),move=moves[Math.floor(rng()*moves.length)];m=L.accept(m,{gameId:m.id,revision:m.state.moves.length,move,diagnostics:{modelHash:hash}});}const data=D.fresh(),before=structuredClone(data);assert.equal(L.record(data,m),true);assert.equal(L.record(data,m),false);assert.equal(L.stats(data).games,1);assert.deepEqual(data.wallet,before.wallet);assert.deepEqual(data.records,before.records);assert.deepEqual(data.daily,before.daily);assert.deepEqual(data.processed,before.processed);});
test('client Impossible and explicit Expert recovery cannot feed normal rewards or quest progress',()=>{for(const record of [{difficulty:'Impossible'},{difficulty:'Expert',resultClass:L.RESULT_CLASS}]){const data=D.fresh(),before=structuredClone(data);assert.equal(D.complete(data,{id:'local-no-reward',mode:'bot',result:'win',reason:'line',moves:60,activeSeconds:600,claimed:5,...record}),0);assert.deepEqual(data.wallet,before.wallet);assert.deepEqual(data.daily,before.daily);assert.deepEqual(data.records,before.records);}assert.deepEqual(D.BOT_PAY,{Beginner:1,Easy:1,Medium:2,Hard:4,Expert:6});});

test('expert fallback preserves original model fingerprint through snapshot and restore',()=>{
 let m=match();m=L.accept(m,{gameId:m.id,revision:0,move:{b:0,c:4},diagnostics:{modelHash:hash}});
 const fallback=L.expertFallback(m,{confirmed:true});
 assert.equal(fallback.fallbackFrom,hash);
 const saved=L.snapshot(fallback);
 assert.equal(saved.fallbackFrom,hash);
 const restored=L.restore(saved,[]);
 assert.equal(restored.fallbackFrom,hash);
 assert.equal(restored.engine,'legacy');
 assert.equal(restored.difficulty,'Expert');
 assert.equal(restored.resultClass,L.RESULT_CLASS);
 assert.throws(()=>L.restore({...saved,fallbackFrom:'not-a-valid-hex'},[]),/INVALID_LOCAL_AI_SAVE/);
 assert.throws(()=>L.restore({...saved,engine:'neural',difficulty:'Impossible',fallbackFrom:hash},catalog),/INVALID_LOCAL_AI_SAVE/);
});

test('model hash or pack version drift fails closed with pack-unavailable and retains state',()=>{
 let m=match();m=L.accept(m,{gameId:m.id,revision:0,move:{b:0,c:4},diagnostics:{modelHash:hash}});
 const saved=L.snapshot(m);
 const driftedCatalog=[{...pin,version:'v2',sha256:'b'.repeat(64),deploymentStatus:'APPROVED'}];
 const restored=L.restore(saved,driftedCatalog);
 assert.equal(restored.status,'pack-unavailable');
 assert.equal(restored.difficulty,'Impossible');
 assert.equal(restored.pin.modelHash,hash);
 assert.deepEqual(restored.state,m.state);
});

test('unfinished match recording fails closed and finished match recording is idempotent',()=>{
 const m=match();
 const data=D.fresh();
 assert.throws(()=>L.record(data,m),/LOCAL_AI_RESULT_NOT_FINISHED/);
});
