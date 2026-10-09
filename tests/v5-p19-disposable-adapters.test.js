'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {REAL_TIERS,TEST_ACTORS,checkEnvironment,realWork,measuredAdapterTier,describe}=require('../scripts/v5/p19/disposable-adapters.js');
const {REAL_DISPOSABLE_OPERATIONS}=require('../scripts/v5/p19/metrics.js');
function owned(){return {V5_TARGET:'test',V5_PG_DISPOSABLE:'1',V5_PG_REQUIRED:'1',
  V5_REDIS_DISPOSABLE:'1',V5_REDIS_REQUIRED:'1',V5_P19_DISPOSABLE:'1',
  V5_MIGRATE_ALLOW_INSECURE_LOOPBACK:'1',
  V5_PG_URL:'postgres://postgres@127.0.0.1:5432/postgres',
  REDIS_URL:'redis://127.0.0.1:6379'};}
test('owned test target and tiny checked fixture tiers are explicit and bounded',()=>{
 assert.equal(checkEnvironment(owned()).mode,'DISPOSABLE_LOOPBACK_ONLY');
 assert.equal(TEST_ACTORS.length,3);
 const plan=describe();
 assert.equal(plan.status,'NOT_EXECUTED');
 assert.equal(plan.g19Accepted,false);
 assert.ok(plan.notTested.some(x=>x.includes('WebSocket')));
 for(const tier of REAL_TIERS){
   const work=realWork(tier);
   assert.equal(work.length,tier.offeredOps);
   assert.ok(work.every(x=>REAL_DISPOSABLE_OPERATIONS.includes(x)));
 }
});
test('production-like endpoints, credentials and unset ownership flags fail before network use',()=>{
 const attacks=[
  e=>{e.V5_PG_URL='postgres://postgres@db.prod.internal/postgres';},
  e=>{e.V5_PG_URL='postgres://postgres@127.0.0.1:5432/mega_xo_prod';},
  e=>{e.V5_PG_URL='postgres://postgres:secret@127.0.0.1:5432/postgres';},
  e=>{e.REDIS_URL='rediss://redis.example.net:6379';},
  e=>{e.REDIS_URL='redis://127.0.0.1:6379/1';},
  e=>{e.REDIS_URL='redis://127.0.0.1:6379?database=2';},
  e=>{e.V5_P19_DISPOSABLE='0';},
  e=>{e.V5_PG_REQUIRED='0';},
  e=>{e.DATABASE_URL='postgres://prod';},
  e=>{e.VERCEL_TOKEN='opaque';},
  e=>{e.REDIS_PRODUCTION_URL='redis://other';}
 ];
 for(const attack of attacks){
  const env=owned();attack(env);
  assert.throws(()=>checkEnvironment(env),/P19_TARGET_REFUSED/);
 }
});
test('synthetic callbacks cannot claim actual launch scale and measure bounded tier concurrency',async()=>{
 const counts={};
 const adapters=Object.fromEntries(REAL_DISPOSABLE_OPERATIONS.map(name=>[name,async()=>{
  counts[name]=(counts[name]||0)+1;
 }]));
 const result=await measuredAdapterTier(REAL_TIERS[0],adapters);
 assert.equal(result.executedOperations,8);
 assert.equal(result.failedOperations,0);
 assert.equal(result.liveStagingExercised,false);
 assert.equal(result.realHttpAndWebSocketsExercised,false);
 assert.equal(result.capacityEnvelopeKnown,false);
 assert.equal(result.g19Accepted,false);
 assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),8);
 await assert.rejects(()=>measuredAdapterTier(REAL_TIERS[0],{
   ...adapters,redis_presence:async()=>{throw Error('fail');}
 }),/P19_TARGET_REFUSED/);
});
test('unreviewed tier sizes and adapter omissions never run',async()=>{
 assert.throws(()=>realWork({...REAL_TIERS[0],offeredOps:10000}),/P19_TARGET_REFUSED/);
 await assert.rejects(()=>measuredAdapterTier(REAL_TIERS[0],{}),/P19_TARGET_REFUSED/);
});
