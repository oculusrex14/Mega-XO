'use strict';

/**
 * P19 executed, measured on ACTUAL guarded PostgreSQL/Core/API and Redis
 * adapters against a uniquely-owned synthetic database on a disposable,
 * externally supplied loopback PG16/Redis7 test cluster.
 *
 * Baseline full Node runs (without V5_P19_DISPOSABLE) SKIP this by design.
 * P19-specific CI sets the explicit ownership markers and MUST assert zero
 * skips and a nonempty measured evidence file.
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const lab=require('./v5-pg-lab.js');
const {createEphemeraService}=require('../packages/services/ephemera.js');
const {REAL_TIERS,TEST_ACTORS,checkEnvironment,realWork,measuredAdapterTier}=require('../scripts/v5/p19/disposable-adapters.js');
lab.installCleanup(test);

async function wallets(db) {
 const c=await lab.adminClient(db);
 try {
  const r=await c.query(
   'SELECT actor_id,coins,crowns FROM economy.wallets WHERE actor_id = ANY($1::text[]) ORDER BY actor_id',
   [TEST_ACTORS]);
  assert.equal(r.rows.length,TEST_ACTORS.length);
  return Object.fromEntries(r.rows.map(row=>[row.actor_id,{
   coins:Number(row.coins),crowns:Number(row.crowns)
  }]));
 }finally{await c.end();}
}
async function economicEffects(db) {
 const c=await lab.adminClient(db);
 try{
  const statements=[
   "SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id LIKE 'p19-%'",
   "SELECT count(*)::int AS n FROM economy.wallet_operations WHERE \"key\" LIKE 'p19-%'",
   "SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id LIKE 'core.command:svc_%:p19-%'",
   "SELECT count(*)::int AS n FROM economy.command_outcomes WHERE \"key\" LIKE '%p19-%'"
  ];
  const values=[];
  for(const sql of statements)values.push(Number((await c.query(sql)).rows[0].n));
  return {ledger:values[0],walletOperations:values[1],outbox:values[2],commandOutcomes:values[3]};
 }finally{await c.end();}
}
test('P19 real disposable load: persistent wallet/Crown effects are exactly once at all four tiny concurrency tiers',
 {timeout:300000},async t=>{
 if(process.env.V5_P19_DISPOSABLE!=='1'){
  t.skip('P19 physical PG/Redis test requires separate owned-loopback CI, not root regression');
  return;
 }
 checkEnvironment(process.env);
 assert.equal(await lab.boot(t),true);
 const db=await lab.createDatabase('p19_capacity');
 await lab.seedActors(db,lab.seedFor(TEST_ACTORS));
 const core=await lab.coreFor(db);
 const accounts=await lab.accountsFor(db);
 const redis=await createEphemeraService({
  url:process.env.REDIS_URL,environment:'test',allowPlaintext:true,
  socket:{connectTimeout:1500,reconnectStrategy:false}
 });
 try{
  assert.equal(await redis.healthy(),true,'owned real Redis must be healthy before measuring');
  const original=await wallets(db);
  const reports=[],expectedDebits=Object.fromEntries(TEST_ACTORS.map(actor=>[actor,0]));
  let expectedOps=0;
  for(const tier of REAL_TIERS){
   const work=realWork(tier);
   const adapters={
    api_account_read:async index=>{
      const actor=TEST_ACTORS[index%TEST_ACTORS.length];
      const profile=await accounts.self(actor);
      assert.ok(profile && typeof profile==='object','real PostgreSQL account profile exists');
    },
    core_currency_conversion:async(index,{tier:phase})=>{
      const actor=TEST_ACTORS[index%TEST_ACTORS.length];
      const key='p19-'+phase+'-'+index;
      const reply=await core.run({actor,scope:'player'},key,
       {type:'convert',from:'coins',amount:10});
      assert.equal(reply.debit,10);
      assert.equal(reply.credit,1);
    },
    redis_presence:async(index,{tier:phase})=>{
      const actor=TEST_ACTORS[index%TEST_ACTORS.length];
      const stored=await redis.heartbeat(actor,'p19-'+phase+'-'+index,60000);
      assert.equal(stored.stored,true,'real Redis owned presence write');
      assert.equal(stored.available,true);
    },
    redis_rate_window:async(_index,{tier:phase})=>{
      const result=await redis.rateHit('p19-'+phase,10000,60000);
      assert.equal(result.allowed,true,'synthetic load must remain below safe ephemeral rate cap');
      assert.equal(result.available,true);
    }
   };
   const report=await measuredAdapterTier(tier,adapters);
   assert.equal(report.failedOperations,0);
   assert.equal(report.executedOperations,tier.offeredOps);
   reports.push(report);
   for(let i=0;i<work.length;i++){
    if(work[i]==='core_currency_conversion'){
     expectedOps++;
     expectedDebits[TEST_ACTORS[i%TEST_ACTORS.length]]++;
    }
   }
   const actual=await wallets(db);
   for(const actor of TEST_ACTORS){
    assert.equal(actual[actor].coins,original[actor].coins-expectedDebits[actor]*10);
    assert.equal(actual[actor].crowns,original[actor].crowns+expectedDebits[actor]);
   }
   const counts=await economicEffects(db);
   assert.equal(counts.ledger,expectedOps*2,'one debit and one credit ledger entry per measured unique command');
   assert.equal(counts.walletOperations,expectedOps,'one economic operation per unique key');
   assert.equal(counts.outbox,expectedOps,'no missing or duplicated transactional outbox effect');
   assert.equal(counts.commandOutcomes,expectedOps,'durable one-outcome-per-identity fence');
  }

  // Re-send a previously committed economic operation as a lost-response
  // retry. It must not change any wallet/ledger/outbox fact.
  const before=await wallets(db),beforeCounts=await economicEffects(db);
  const replay=await core.run({actor:'svc_bob',scope:'player'},'p19-smoke-1',
   {type:'convert',from:'coins',amount:10});
  assert.equal(replay.debit,10);
  assert.equal(replay.credit,1);
  assert.deepEqual(await wallets(db),before,'lost-response retry cannot debit bought/earned assets twice');
  assert.deepEqual(await economicEffects(db),beforeCounts,'replayed command cannot emit a second result or outbox row');

  const evidence={
   format:'mega-v5-p19-real-disposable-measurement/v1',
   sourceSha:/^[a-f0-9]{40}$/.test(process.env.P19_SOURCE_SHA||'')?process.env.P19_SOURCE_SHA:null,
   runClass:'REAL_POSTGRESQL_AND_REDIS_SMALL_SYNTHETIC_FIXTURE',
   nodeVersion:process.versions.node,
   postgresMajor:16,redisMajor:7,
   actors:TEST_ACTORS.length,
   walletHistorySize:'THREE_SYNTHETIC_ACCOUNTS_MINIMAL_HISTORY',
   profileDataIsSynthetic:true,producedAt:new Date().toISOString(),
   tiers:reports,
   auditedEffects:{
    uniqueConversions:expectedOps,
    ledgerRows:beforeCounts.ledger,
    operationRows:beforeCounts.walletOperations,
    outboxRows:beforeCounts.outbox,
    commandOutcomeRows:beforeCounts.commandOutcomes,
    lostResponseReplayHadAdditionalEffects:false
   },
   limits:{
    measuredHttp:false,measuredWebSockets:false,measuredCoreAB:false,measuredWorker:false,
    measuredVercel:false,measuredOracleHost:false,measuredNeon:false,
    representativeHistory:false,launchEnvelopeKnown:false
   },
   g19Accepted:false
  };
  assert.match(evidence.sourceSha,/^[a-f0-9]{40}$/,'source identity must use the exact checked-out PR branch head');
  assert.equal(evidence.auditedEffects.ledgerRows,expectedOps*2);
  assert.equal(evidence.g19Accepted,false);
  if(process.env.P19_EVIDENCE_OUTPUT){
   assert.equal(process.env.P19_EVIDENCE_OUTPUT,'.artifacts/p19-real-disposable.json');
   fs.mkdirSync('.artifacts',{recursive:true});
   fs.writeFileSync(process.env.P19_EVIDENCE_OUTPUT,JSON.stringify(evidence,null,2)+'\n',
     {mode:0o600,flag:'wx'});
  }
  // No actor IDs, wallet values, raw receipts or provider credentials in CI evidence.
  const sanitized=JSON.stringify(evidence);
  for(const id of TEST_ACTORS)assert.ok(!sanitized.includes(id),'actor identifiers must stay out of metrics');
  assert.ok(!sanitized.includes('redis://'),'no URLs or credentials may leak');
 }finally{
  await redis.close();
  await accounts.close();
  core.close();
  await lab.closeDatabasePools(db);
 }
});
