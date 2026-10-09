'use strict';

/**
 * P19: hard target guard and bounded real-adapter fixture schedule.
 * Benchmarks touch only disposable test-owned PostgreSQL and Redis. This is
 * intentionally NOT an HTTP/WebSocket/client-traffic generator.
 */
const {measure,REAL_DISPOSABLE_OPERATIONS}=require('./metrics.js');
const {MAX_CLIENTS,TIERS}=require('./workload-profile.js');
const REAL_TIERS=Object.freeze([
 Object.freeze({name:'smoke',clients:1,offeredOps:8}),
 Object.freeze({name:'warm',clients:2,offeredOps:16}),
 Object.freeze({name:'ramp',clients:4,offeredOps:24}),
 Object.freeze({name:'ceiling_candidate',clients:8,offeredOps:32})
]);
const TEST_ACTORS=Object.freeze(['svc_alice','svc_bob','svc_carol']);
function refuse(reason){throw new Error('P19_TARGET_REFUSED: '+reason);}
function safeUrl(raw,protocol,controlName) {
 let u;
 try {u=new URL(raw);}catch{refuse('missing/invalid owned target URL');}
 if(u.protocol!==protocol||u.hostname!=='127.0.0.1'||u.port==='0'||
   u.username&&protocol==='redis:'||u.password||
   u.search||u.hash||u.port===''||u.username&&protocol==='postgres:'&&u.username!=='postgres') {
   refuse('only loopback disposable targets without embedded secrets are allowed');
 }
 if(protocol==='postgres:' && u.pathname!==controlName)refuse('PostgreSQL control database must be postgres');
 if(protocol==='redis:' && !['','/'].includes(u.pathname))refuse('Redis database selection is prohibited');
 return u;
}
function checkEnvironment(env){
 if(!env||env.V5_TARGET!=='test'||env.V5_PG_DISPOSABLE!=='1'||env.V5_PG_REQUIRED!=='1'||
    env.V5_REDIS_DISPOSABLE!=='1'||env.V5_REDIS_REQUIRED!=='1'||
    env.V5_P19_DISPOSABLE!=='1'||env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK!=='1') {
   refuse('explicit P19 disposable PG/Redis harness contract required');
 }
 for(const key of ['DATABASE_URL','NEON_DATABASE_URL','VERCEL_TOKEN','PRODUCTION_DATABASE_URL',
  'REDIS_PRODUCTION_URL','GOOGLE_APPLICATION_CREDENTIALS','MEGA_ANDROID_RELEASE_KEYSTORE_PATH']) {
   if(env[key])refuse('external provider or production credential environment variable prohibited');
 }
 const pg=safeUrl(env.V5_PG_URL,'postgres:','/postgres');
 const redis=safeUrl(env.REDIS_URL,'redis:','');
 if(pg.port!=='5432'||redis.port!=='6379')refuse('test-owned default GitHub service ports required');
 return {pgEndpoint:'127.0.0.1:5432',redisEndpoint:'127.0.0.1:6379',mode:'DISPOSABLE_LOOPBACK_ONLY'};
}
function realWork(tier){
 if(!tier||Object.keys(tier).sort().join(',')!=='clients,name,offeredOps' ||
    !Number.isSafeInteger(tier.clients)||tier.clients<1||tier.clients>MAX_CLIENTS||
    !Number.isSafeInteger(tier.offeredOps)||tier.offeredOps<1||tier.offeredOps>32) {
   refuse('unknown or unbounded real test tier');
 }
 const expected=REAL_TIERS.find(x=>x.name===tier.name);
 if(!expected||expected.clients!==tier.clients||expected.offeredOps!==tier.offeredOps) {
   refuse('unreviewed load tier');
 }
 return Array.from({length:tier.offeredOps},(_,i)=>REAL_DISPOSABLE_OPERATIONS[i%REAL_DISPOSABLE_OPERATIONS.length]);
}
async function measuredAdapterTier(tier,adapters,{deadlineMs=60000}={}) {
 if(!adapters||typeof adapters!=='object'||
    REAL_DISPOSABLE_OPERATIONS.some(k=>typeof adapters[k]!=='function'))refuse('all four actual service adapters required');
 const work=realWork(tier);
 const result=await measure({work,concurrency:tier.clients,deadlineMs,
   perform:(op,index,signal)=>adapters[op](index,{tier:tier.name,signal})});
 if(result.failedOperations!==0)refuse('real disposable service errors prohibit throughput acceptance');
 return {...result,tier:tier.name,fixtureHistory:'MINIMAL_THREE_ACTOR_HISTORY',
  observedServices:['PostgreSQL account and Core services','Redis ephemera primitives'],
  realHttpAndWebSocketsExercised:false,liveStagingExercised:false,capacityEnvelopeKnown:false};
}
function describe(){
 return {
  format:'mega-v5-p19-owned-adapter-tiers/v1',
  status:'NOT_EXECUTED',g19Accepted:false,
  targets:'OWNED_LOOPBACK_POSTGRESQL_16_AND_REDIS_7',
  actorFixtures:TEST_ACTORS.length,
  tiers:REAL_TIERS.map(t=>({...t,operations:Object.fromEntries(
    REAL_DISPOSABLE_OPERATIONS.map(k=>[k,realWork(t).filter(v=>v===k).length]))})),
  notTested:['HTTP/auth/TLS overhead','actual WebSocket process','Core A/B/worker concurrency',
    'historic population size','provider receipts','host or launch traffic forecast']
 };
}
module.exports={REAL_TIERS,TEST_ACTORS,checkEnvironment,safeUrl,realWork,measuredAdapterTier,describe};
