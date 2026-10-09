'use strict';

/**
 * P19-03 chaos inventory. Only isolated, directly exercised PG/Redis adapter
 * faults can appear as LOCAL_MEASURED. Unbuilt Core/worker/socket/provider
 * surfaces are explicitly NOT_EXECUTED, never interpreted as zero failures.
 */
const SCENARIOS=Object.freeze([
  Object.freeze({id:'redis_namespace_wipe',class:'DISPOSABLE',invariant:'PG_WALLET_AND_IDENTITY_DIGEST'}),
  Object.freeze({id:'core_service_reopen_and_command_replay',class:'DISPOSABLE',invariant:'EXACTLY_ONCE_LEDGER_AND_OUTBOX'}),
  Object.freeze({id:'duplicate_economic_command',class:'DISPOSABLE',invariant:'ONE_OPERATION_RESPONSE_AND_ONE_EFFECT'}),
  Object.freeze({id:'postgres_bounded_read_stall',class:'DISPOSABLE',invariant:'NO_DURABLE_MUTATION'}),
  Object.freeze({id:'postgres_total_outage',class:'INTEGRATED_STAGING',invariant:'BOUNDED_SAFE_REJECTION'}),
  Object.freeze({id:'core_ab_process_crash_and_socket_reconnect',class:'INTEGRATED_STAGING',invariant:'MATCH_REVISION_AND_DEADLINE_SURVIVE'}),
  Object.freeze({id:'worker_kill_and_catchup',class:'INTEGRATED_STAGING',invariant:'ONE_SETTLEMENT_PER_EVENT'}),
  Object.freeze({id:'reordered_provider_callbacks',class:'INTEGRATED_STAGING',invariant:'ONE_VERIFIED_GRANT_OR_REFUND'}),
  Object.freeze({id:'pubsub_blackhole_and_client_backpressure',class:'INTEGRATED_STAGING',invariant:'REVISION_SNAPSHOT_RECOVERY'})
]);
const SHA=/^[a-f0-9]{40}$/, DIGEST=/^[a-f0-9]{64}$/;
function refuse(msg){throw Error('P19_CHAOS_REFUSED: '+msg);}
function shape(value,keys,label){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join('\0')!==[...keys].sort().join('\0')) {
   refuse('invalid '+label+' fields');
 }
}
function plan(){
 return {
  format:'mega-v5-p19-chaos-plan/v1',
  environment:'DISPOSABLE_PG_REDIS_ONLY',
  status:'PARTIALLY_EXECUTABLE_PRE_G18',
  g19Accepted:false,
  scenarios:SCENARIOS.map(x=>({scenario:x.id,class:x.class,
    invariant:x.invariant,status:'NOT_EXECUTED'}))
 };
}
function assess({sourceSha,observations}){
 if(typeof sourceSha!=='string'||!SHA.test(sourceSha))refuse('immutable source SHA required');
 if(!Array.isArray(observations)||observations.length!==SCENARIOS.length) {
  refuse('all reviewed chaos scenarios must be accounted for');
 }
 const result=[];
 for(let i=0;i<SCENARIOS.length;i++){
  const spec=SCENARIOS[i],row=observations[i];
  shape(row,['scenario','status','durationMs','beforeDigest','afterDigest'],'scenario observation');
  if(row.scenario!==spec.id)refuse('scenario missing/reordered');
  if(spec.class==='INTEGRATED_STAGING'){
   if(row.status!=='NOT_EXECUTED'||row.durationMs!==null||
      row.beforeDigest!==null||row.afterDigest!==null) {
     refuse('unintegrated Core/worker/PG-failover scenarios cannot be claimed executed');
   }
  }else if(row.status==='LOCAL_MEASURED'){
   if(typeof row.durationMs!=='number'||!Number.isFinite(row.durationMs)||
      row.durationMs<0||row.durationMs>60000 ||
      typeof row.beforeDigest!=='string'||!DIGEST.test(row.beforeDigest) ||
      row.beforeDigest!==row.afterDigest) {
     refuse('no verified bounded duration or durable-state equality for local chaos');
   }
  }else if(row.status!=='NOT_EXECUTED' || row.durationMs!==null||
       row.beforeDigest!==null||row.afterDigest!==null) {
    refuse('unexecuted local scenario must not contain measurements');
  }
  result.push({scenario:row.scenario,
    class:spec.class,status:row.status,invariant:spec.invariant,
    durationMs:row.durationMs});
 }
 const local=result.filter(x=>x.status==='LOCAL_MEASURED');
 const notExecuted=result.filter(x=>x.status==='NOT_EXECUTED');
 return {
  format:'mega-v5-p19-chaos-assessment/v1',
  sourceSha,
  status:'PARTIAL_DISPOSABLE_ONLY_NOT_CAPACITY',
  independentlyObservedOnRealStaging:false,
  fullServiceFailureRecoveryMeasured:false,
  localScenarioCount:local.length,
  unexecutedScenarioCount:notExecuted.length,
  observedLocalScenarios:local,
  unexecutedScenarios:notExecuted.map(x=>x.scenario),
  g19Accepted:false,
  notes:'Submitted local measurements require CI execution proof; structured JSON itself cannot authenticate a run'
 };
}
module.exports={SCENARIOS,plan,assess};
