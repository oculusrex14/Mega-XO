'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {REAL_TIERS}=require('../scripts/v5/p19/disposable-adapters.js');
const {SCENARIOS}=require('../scripts/v5/p19/chaos-contract.js');
const {evaluate,LABELS}=require('../scripts/v5/p19/capacity-report.js');
const SHA='a'.repeat(40),DIGEST='b'.repeat(64);
function fixture(){
 return {
  format:'mega-v5-p19-real-disposable-measurement/v1',
  sourceSha:SHA,g19Accepted:false,
  runClass:'REAL_POSTGRESQL_AND_REDIS_SMALL_SYNTHETIC_FIXTURE',
  actors:3,profileDataIsSynthetic:true,
  limits:{measuredHttp:false,measuredWebSockets:false,measuredCoreAB:false,
   measuredWorker:false,measuredVercel:false,measuredOracleHost:false,
   measuredNeon:false,representativeHistory:false,launchEnvelopeKnown:false},
  auditedEffects:{uniqueConversions:20,ledgerRows:40,operationRows:20,
   outboxRows:20,commandOutcomeRows:20,lostResponseReplayHadAdditionalEffects:false},
  tiers:REAL_TIERS.map(t=>({
   tier:t.name,requestedConcurrency:t.clients,executedOperations:t.offeredOps,
   completedSuccessfully:t.offeredOps,failedOperations:0,
   elapsedMs:125.5,attemptedPerSec:t.offeredOps/0.1255,
   successfulPerSec:t.offeredOps/0.1255,
   maxInFlight:t.clients,launchEnvelopeProven:false,g19Accepted:false,
   fixtureHistory:'MINIMAL_THREE_ACTOR_HISTORY',
   processHeadroomObservation:{rssAfterBytes:50000000},
   latency:{samples:t.offeredOps,minMs:1,p50Ms:2,p95Ms:4,p99Ms:5,maxMs:6,meanMs:3}
  }))
 };
}
function chaos(){
 return {format:'mega-v5-p19-chaos-assessment/v1',sourceSha:SHA,g19Accepted:false,
  independentlyObservedOnRealStaging:false,fullServiceFailureRecoveryMeasured:false,
  localScenarioCount:4,unexecutedScenarioCount:5,
  scenarioMeasurements:SCENARIOS.map((s,i)=>({
   scenario:s.id,status:i<4?'LOCAL_MEASURED':'NOT_EXECUTED',
   durationMs:i<4?25:null,beforeDigest:i<4?DIGEST:null,afterDigest:i<4?DIGEST:null
  }))
 };
}
test('reports real disposable samples while refusing invented launch envelope or alert thresholds',()=>{
 const report=evaluate(fixture(),chaos(),SHA);
 assert.equal(report.g19Accepted,false);
 assert.equal(report.sustainableLaunchPlayerLimit,null);
 assert.equal(report.saturationPointObserved,false);
 assert.equal(report.realStagingCapacityMeasured,false);
 assert.equal(report.totalObservedLocalCalls,80);
 assert.equal(report.successfulLocalCalls,80);
 assert.equal(report.worstObservedLocalP99Ms,5);
 assert.equal(report.disposablePgPoolReservation.unallocated,2);
 assert.equal(report.pendingMonitorSignals.length,LABELS.length);
 assert.ok(report.pendingMonitorSignals.every(x=>x.threshold===null&&!x.deliveryVerified));
 assert.ok(report.blockers.some(x=>x.includes('Oracle')));
});
test('cannot call a source-only, fake, skipped or failing tier actual capacity',()=>{
 const attacks=[
  x=>{x.g19Accepted=true;},
  x=>{x.limits.launchEnvelopeKnown=true;},
  x=>{x.limits.measuredVercel=true;},
  x=>{x.tiers[0].failedOperations=1;},
  x=>{x.tiers[0].latency.p95Ms=999;},
  x=>{x.tiers[1].executedOperations=0;},
  x=>{x.tiers[3].fixtureHistory='MIGRATED_PRODUCTION';},
  x=>{x.auditedEffects.outboxRows=19;},
  x=>{x.auditedEffects.uniqueConversions=19;},
  x=>{x.tiers.pop();},
 ];
 for(const attack of attacks){
  const x=fixture();attack(x);
  assert.throws(()=>evaluate(x,chaos(),SHA),/P19_CAPACITY_REFUSED/);
 }
});
test('does not turn fabricated chaos or source mismatch into an accepted result',()=>{
 for(const mutation of [
  c=>{c.localScenarioCount=9;},
  c=>{c.unexecutedScenarioCount=0;},
  c=>{c.g19Accepted=true;},
  c=>{c.scenarioMeasurements[2].afterDigest='d'.repeat(64);},
  c=>{c.scenarioMeasurements[5].status='LOCAL_MEASURED';},
 ]){
  const c=chaos();mutation(c);
  assert.throws(()=>evaluate(fixture(),c,SHA),/P19_CAPACITY_REFUSED/);
 }
 assert.throws(()=>evaluate(fixture(),chaos(),'f'.repeat(40)),/P19_CAPACITY_REFUSED/);
});
