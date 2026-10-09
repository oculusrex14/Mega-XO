#!/usr/bin/env node
'use strict';

/**
 * P19-04 capacity evidence assessment, never a production launch envelope.
 * The inputs are measurements of real but SMALL owned-loopback adapters on a
 * GitHub runner, not API/Core/worker/Neon/Oracle staging. Approval, history,
 * resource budgets and alert thresholds must be measured there after G18.
 */
const fs=require('node:fs');
const path=require('node:path');
const {REAL_TIERS}=require('./disposable-adapters.js');
const {SCENARIOS}=require('./chaos-contract.js');
const SHA=/^[a-f0-9]{40}$/;
const SRC='.artifacts/';
const FILE=/^\.artifacts\/[a-z0-9][a-z0-9._-]{0,100}\.json$/;
const LABELS=Object.freeze([
  'api_p95_p99_and_5xx',
  'core_socket_reconnect_and_revision_lag',
  'matchmaker_queue_wait_and_admission_reject',
  'postgres_pool_lock_duration_and_replication_health',
  'redis_unavailable_latency_and_evictions',
  'worker_oldest_outbox_age_retry_and_dlq',
  'provider_purchase_ssv_reconciliation_lag',
  'backup_age_and_isolated_restore',
  'host_cpu_ram_disk_and_event_loop'
]);
function reject(msg){throw Error('P19_CAPACITY_REFUSED: '+msg);}
function finite(n){return typeof n==='number'&&Number.isFinite(n);}
function checkPercentiles(metric){
 if(!metric||typeof metric!=='object' ||
    !Number.isSafeInteger(metric.samples)||metric.samples<1 ||
    !finite(metric.minMs)||!finite(metric.p50Ms)||!finite(metric.p95Ms)||
    !finite(metric.p99Ms)||!finite(metric.maxMs)||!finite(metric.meanMs)||
    metric.minMs<0||metric.minMs>metric.p50Ms||metric.p50Ms>metric.p95Ms||
    metric.p95Ms>metric.p99Ms||metric.p99Ms>metric.maxMs||
    metric.meanMs<metric.minMs||metric.meanMs>metric.maxMs) {
   reject('invalid or impossible latency observations');
 }
}
function evaluate(load,chaos,sourceSha){
 if(!SHA.test(sourceSha))reject('exact source SHA must be known');
 if(!load||load.format!=='mega-v5-p19-real-disposable-measurement/v1'||
    load.sourceSha!==sourceSha||load.g19Accepted!==false||
    load.runClass!=='REAL_POSTGRESQL_AND_REDIS_SMALL_SYNTHETIC_FIXTURE'||
    load.actors!==3||load.profileDataIsSynthetic!==true||
    !Array.isArray(load.tiers)||load.tiers.length!==REAL_TIERS.length) {
   reject('real disposable load evidence missing, untrusted or wrongly labeled');
 }
 const off=load.limits;
 if(!off||off.launchEnvelopeKnown!==false||Object.keys(off).some(k=>k.startsWith('measured')&&off[k]!==false)||
    off.representativeHistory!==false)reject('claim of unmeasured provider, service, history or launch envelope');
 let total=0,success=0,observedPeak=0,maxP95=0,maxP99=0,maxRss=0,permitted=0;
 for(let i=0;i<load.tiers.length;i++){
  const t=load.tiers[i],expected=REAL_TIERS[i];
  if(!t||t.tier!==expected.name||t.requestedConcurrency!==expected.clients||
     t.executedOperations!==expected.offeredOps||
     t.completedSuccessfully!==expected.offeredOps||t.failedOperations!==0||
     !finite(t.elapsedMs)||t.elapsedMs<=0||
     !finite(t.attemptedPerSec)||t.attemptedPerSec<0||
     !finite(t.successfulPerSec)||t.successfulPerSec<0||
     !Number.isSafeInteger(t.maxInFlight)||t.maxInFlight<1||t.maxInFlight>expected.clients||
     t.launchEnvelopeProven!==false||t.g19Accepted!==false||
     t.fixtureHistory!=='MINIMAL_THREE_ACTOR_HISTORY'||
     !t.processHeadroomObservation||!finite(t.processHeadroomObservation.rssAfterBytes)) {
    reject('tier is incomplete, unmeasured or pretending to be a launch benchmark');
  }
  checkPercentiles(t.latency);
  if(t.latency.samples!==t.executedOperations)reject('latency accounting missing failed/successful attempt');
  total+=t.executedOperations;success+=t.completedSuccessfully;
  maxP95=Math.max(maxP95,t.latency.p95Ms);
  maxP99=Math.max(maxP99,t.latency.p99Ms);
  maxRss=Math.max(maxRss,t.processHeadroomObservation.rssAfterBytes);
  observedPeak=Math.max(observedPeak,t.maxInFlight);
  permitted=Math.max(permitted,t.attemptedPerSec);
 }
 const audit=load.auditedEffects;
 if(!audit||!Number.isSafeInteger(audit.uniqueConversions)||audit.uniqueConversions!==20||
    audit.ledgerRows!==40||audit.operationRows!==20||audit.outboxRows!==20||
    audit.commandOutcomeRows!==20||
    audit.lostResponseReplayHadAdditionalEffects!==false) {
   reject('missing exact-once economic asset/ledger/outbox evidence');
 }
 if(!chaos||chaos.format!=='mega-v5-p19-chaos-assessment/v1'||
    chaos.sourceSha!==sourceSha||chaos.g19Accepted!==false||
    chaos.independentlyObservedOnRealStaging!==false||
    chaos.fullServiceFailureRecoveryMeasured!==false||
    chaos.localScenarioCount!==4||chaos.unexecutedScenarioCount!==5||
    !Array.isArray(chaos.scenarioMeasurements)||chaos.scenarioMeasurements.length!==SCENARIOS.length||
    chaos.scenarioMeasurements.some((s,i)=>s.scenario!==SCENARIOS[i].id ||
      (i<4?(s.status!=='LOCAL_MEASURED'||s.beforeDigest!==s.afterDigest):s.status!=='NOT_EXECUTED'))) {
   reject('chaos evidence absent, corrupt or an unverified success claim');
 }
 return {
  format:'mega-v5-p19-capacity-and-alert-readiness/v1',
  sourceSha,
  status:'DISPOSABLE_MEASUREMENTS_ONLY_NOT_LAUNCH_CAPACITY',
  measurementEnvironment:'SINGLE_GITHUB_RUNNER_OWNED_PG16_REDIS7',
  forecastStatus:'UNKNOWN',
  historyStatus:'THREE_SYNTHETIC_ACTORS_MINIMAL_HISTORY',
  totalObservedLocalCalls:total,
  successfulLocalCalls:success,
  localFailedCalls:total-success,
  observedLocalPeakInFlight:observedPeak,
  observedMaxLocalAttemptedOpsPerSecond:permitted,
  worstObservedLocalP95Ms:maxP95,
  worstObservedLocalP99Ms:maxP99,
  peakRunnerNodeRssBytes:maxRss,
  realStagingCapacityMeasured:false,
  saturationPointObserved:false,
  sustainableLaunchPlayerLimit:null,
  recommendedAdmissionLimit:null,
  productionAlertThresholdsApproved:false,
  productionLoadBudgetApproved:false,
  disposablePgPoolReservation:{
    totalBudget:30,coreRuntime:12,apiRuntime:12,workerRuntime:4,
    unallocated:2,
    basis:'tests/v5-pg-lab.js config only, NOT a Neon/Oracle quota'
  },
  pendingMonitorSignals:LABELS.map(name=>({name,state:'REQUIRES_INTEGRATED_STAGING_BASELINE',
    threshold:null,deliveryVerified:false})),
  localChaosExecuted:4,
  realCoreWorkerNetworkChaosNotExecuted:5,
  economicIntegrityVerifiedLocally:true,
  g19Accepted:false,
  blockers:[
   'P18 staging acceptance and actual API/Core/worker integration still pending',
   'representative migrated player history, season fixtures, socket joins and outbox backlog not benchmarked',
   'Oracle co-host headroom and Neon/Redis provider plans not measured',
   'network fault injection, multi-process failover and alert delivery not executed'
  ]
 };
}
function scopedRead(root,relative){
 if(typeof relative!=='string'||!FILE.test(relative))reject('input must be named bounded .artifacts JSON');
 const file=path.join(root,relative),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<5||stat.size>300000)reject('missing/unsafe artifact');
 return JSON.parse(fs.readFileSync(file,'utf8'));
}
function run(args,root=process.cwd()){
 if(args.length!==8||args[0]!=='--load'||args[2]!=='--chaos'||
    args[4]!=='--sha'||args[6]!=='--output'||!FILE.test(args[7])) {
   reject('usage: --load .artifacts/name.json --chaos .artifacts/name.json --sha COMMIT --output .artifacts/name.json');
 }
 const report=evaluate(scopedRead(root,args[1]),scopedRead(root,args[3]),args[5]);
 const dest=path.join(root,args[7]);
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 fs.writeFileSync(dest,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
 return report;
}
if(require.main===module){
 try{
  const report=run(process.argv.slice(2));
  process.stdout.write('P19_CAPACITY_LOCAL_ONLY '+report.totalObservedLocalCalls+' attempts, G19 OPEN\n');
 }catch(err){process.stderr.write(err.message+'\n');process.exitCode=2;}
}
module.exports={LABELS,checkPercentiles,evaluate,scopedRead,run};
