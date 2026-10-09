'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {OPERATIONS,TIERS,MAX_CLIENTS,enumerate,plan}=require('../scripts/v5/p19/workload-profile.js');

test('load plan covers API/auth, socket, queue, matches, tournaments, workers and provider fixtures',()=>{
 const result=plan();
 assert.equal(result.sourceTrafficForecast,'UNKNOWN');
 assert.equal(result.status,'UNEXECUTED_PROFILE_NOT_CAPACITY');
 assert.equal(result.g19Accepted,false);
 assert.equal(result.executionPermitted,false);
 assert.equal(result.tiers.length,4);
 assert.ok(result.unimplementedRealTransports.some(x=>x.includes('WebSocket')));
 assert.ok(result.operations.some(x=>x.name==='game_move'&&x.consumer==='Core'));
 assert.ok(result.operations.some(x=>x.name==='store_callback'&&x.status==='SANDBOX_FIXTURE_ONLY'));
 assert.equal(OPERATIONS.reduce((sum,x)=>sum+x.weight,0),100);
 for(const tier of result.tiers){
   assert.equal(tier.offeredOps,Object.values(tier.operations).reduce((a,b)=>a+b,0));
   assert.ok(tier.clients<=MAX_CLIENTS);
   assert.equal(tier.executed,false);
 }
});

test('bounded workload allocation is exactly repeatable for fixed seeds and varies with seed',()=>{
 for(const n of [1,2,17,80,120]){
   const first=enumerate(n,1919);
   assert.equal(first.length,n);
   assert.deepEqual(first,enumerate(n,1919));
   assert.ok(first.every(op=>OPERATIONS.some(x=>x.name===op)));
 }
 assert.notDeepEqual(enumerate(120,1919),enumerate(120,1920));
});

test('invalid concurrency, phase order and unbounded work are refused before any test',()=>{
 for(const tiers of [
   [{name:'smoke',clients:999,offeredOps:1}],
   [{name:'smoke',clients:1,offeredOps:9999}],
   [{name:'unreviewed',clients:1,offeredOps:5}],
   [TIERS[1],TIERS[0]],
   [{...TIERS[0],networkTarget:'https://production.example'}],
   []
 ])assert.throws(()=>plan({tiers}),/P19_WORKLOAD_REFUSED/);
 for(const ops of [0,-1,121,Infinity,1.2])assert.throws(()=>enumerate(ops),/P19_WORKLOAD_REFUSED/);
 for(const seed of [0,-1,2147483648])assert.throws(()=>enumerate(10,seed),/P19_WORKLOAD_REFUSED/);
});
