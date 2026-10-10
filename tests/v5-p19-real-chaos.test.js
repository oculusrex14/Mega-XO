'use strict';

/**
 * P19 fault testing against owned disposable PostgreSQL/Redis only.
 * The first 4 scenarios actually execute. Core multi-process death, whole-PG
 * failover, WebSockets, provider callbacks and worker catch-up are explicit
 * NOT_EXECUTED fixtures awaiting the integrated P18 staging platform.
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const lab=require('./v5-pg-lab.js');
const {createEphemeraService}=require('../packages/services/ephemera.js');
const {checkEnvironment}=require('../scripts/v5/p19/disposable-adapters.js');
const {SCENARIOS,assess}=require('../scripts/v5/p19/chaos-contract.js');
lab.installCleanup(test);

const DURABLE_TABLES=[
  'identity.actors','identity.sessions','economy.wallets','economy.ratings',
  'economy.ledger','economy.wallet_operations','economy.command_outcomes',
  'ops.outbox','monetization.receipts','monetization.reward_events'
];
async function truthDigest(db) {
 const client=await lab.adminClient(db);
 try {
  const grouped={};
  for(const table of DURABLE_TABLES){
   const rows=(await client.query('SELECT * FROM '+table)).rows;
   grouped[table]=rows.map(row=>JSON.stringify(row)).sort();
  }
  return crypto.createHash('sha256').update(JSON.stringify(grouped)).digest('hex');
 }finally{await client.end();}
}
function record(rows,id,before,after,start) {
 const duration=performance.now()-start;
 assert.ok(Number.isFinite(duration)&&duration>=0&&duration<60000);
 assert.equal(before,after,'PG canonical rows changed during failure scenario '+id);
 const scenario=rows.find(x=>x.scenario===id);
 assert.ok(scenario,'P19 scenario must be specified in the phase contract');
 scenario.status='LOCAL_MEASURED';
 scenario.durationMs=Number(duration.toFixed(3));
 scenario.beforeDigest=before;
 scenario.afterDigest=after;
}
test('P19 actual disposable Redis wipe, Core reopen/idempotent retry and bounded PG stall preserve durable truth',
 {timeout:240000},async t=>{
 if(process.env.V5_P19_DISPOSABLE!=='1'){
  t.skip('run controlled fault injection only with P19 disposable CI markers');
  return;
 }
 checkEnvironment(process.env);
 assert.equal(await lab.boot(t),true);
 const db=await lab.createDatabase('p19_chaos');
 await lab.seedActors(db,lab.seedFor(['svc_alice','svc_bob']));
 let core=await lab.coreFor(db);
 const redis=await createEphemeraService({
  url:process.env.REDIS_URL,environment:'test',allowPlaintext:true,
  socket:{connectTimeout:1500,reconnectStrategy:false}
 });
 try {
  assert.equal(await redis.healthy(),true);
  const principal={actor:'svc_alice',scope:'player'};
  const key='p19-chaos-once';
  const command={type:'convert',from:'coins',amount:100};
  const first=await core.run(principal,key,command);
  assert.equal(first.debit,100);
  assert.equal(first.credit,10);

  const rows=SCENARIOS.map(spec=>({
   scenario:spec.id,status:'NOT_EXECUTED',durationMs:null,beforeDigest:null,afterDigest:null
  }));

  // Redis wipe: real commands + atomic namespace removal from the owned
  // temporary Redis container. Immutable PG authority must not move.
  await redis.presenceTouch('svc_alice','session-synthetic',true,60000);
  await redis.cacheSet('cache','p19-fault','synthetic',60000);
  const beforeWipe=await truthDigest(db),startWipe=performance.now();
  const wiped=await redis.wipeNamespace();
  assert.equal(wiped.available,true);
  assert.ok(wiped.deleted>=2,'real test fixtures must actually be erased by Redis wipe');
  const absent=await redis.presenceRead('svc_alice');
  assert.equal(absent.available,true);
  assert.deepEqual(absent.sessions,[],'ephemeral presence disappears; durable actor does not');
  record(rows,'redis_namespace_wipe',beforeWipe,await truthDigest(db),startWipe);

  // A Core service reopened with the same guarded PG pool reconstructs the
  // already-recorded outcome from durable truth, not an in-memory cache.
  const beforeRestart=await truthDigest(db),startRestart=performance.now();
  core.close();
  core=await lab.coreFor(db);
  assert.deepEqual(await core.run(principal,key,command),first);
  record(rows,'core_service_reopen_and_command_replay',beforeRestart,
   await truthDigest(db),startRestart);

  // Duplicate concurrent clients and a dropped-response retry must not mint
  // a second Crown conversion or append a duplicate outbox/ledger result.
  const beforeReplay=await truthDigest(db),startReplay=performance.now();
  const replies=await Promise.all(Array.from({length:3},()=>core.run(principal,key,command)));
  assert.equal(replies.length,3);
  for(const value of replies)assert.deepEqual(value,first);
  record(rows,'duplicate_economic_command',beforeReplay,await truthDigest(db),startReplay);

  // This is a *bounded read stall*, NOT a simulated total PostgreSQL outage:
  // deliberately sleep on a test-owned PG connection for 75 ms, then prove
  // the canonical durable state is unmodified. No production writer stalls.
  const beforeStall=await truthDigest(db),startStall=performance.now();
  const admin=await lab.adminClient(db);
  try {
   await admin.query('SELECT pg_sleep(0.075)');
  }finally{await admin.end();}
  record(rows,'postgres_bounded_read_stall',beforeStall,await truthDigest(db),startStall);

  const sha=process.env.P19_SOURCE_SHA;
  assert.match(sha,/^[a-f0-9]{40}$/,'real chaos evidence must use exact checked-out source SHA');
  const reviewed=assess({sourceSha:sha,observations:rows});
  assert.equal(reviewed.localScenarioCount,4);
  assert.equal(reviewed.unexecutedScenarioCount,5);
  assert.equal(reviewed.g19Accepted,false);
  assert.equal(reviewed.independentlyObservedOnRealStaging,false);
  const evidence={
   ...reviewed,
   runClass:'REAL_OWNED_LOOPBACK_PG16_REDIS7_SMALL_FIXTURE',
   scenarioMeasurements:rows,
   auditedDurableTables:DURABLE_TABLES,
   actorFixtures:2,
   sourceProvisioning:'SYNTHETIC_ONLY',
   initialConversionDebit:100,
   initialConversionCredit:10,
   warning:'PG bounded stall and Core service reopening are not process/host failover',
   publishedCapacityClaim:false
  };
  if(process.env.P19_CHAOS_EVIDENCE_OUTPUT){
   assert.equal(process.env.P19_CHAOS_EVIDENCE_OUTPUT,'.artifacts/p19-chaos-disposable.json');
   fs.mkdirSync('.artifacts',{recursive:true});
   fs.writeFileSync(process.env.P19_CHAOS_EVIDENCE_OUTPUT,
    JSON.stringify(evidence,null,2)+'\n',{mode:0o600,flag:'wx'});
  }
  const sanitized=JSON.stringify(evidence);
  assert.ok(!sanitized.includes('svc_alice')&&!sanitized.includes('svc_bob'));
  assert.ok(!sanitized.includes('redis://')&&!sanitized.includes('postgres://'));
 }finally{
  await redis.close();
  core.close();
  await lab.closeDatabasePools(db);
 }
});
