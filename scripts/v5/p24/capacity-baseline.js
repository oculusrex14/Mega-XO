'use strict';

/*
 * P24-01. Strict, read-only baseline INTAKE, not a production telemetry
 * collector. No fabricated player counts or inferred release capacity.
 * A P19 disposable benchmark may be referenced, never promoted to production.
 */
const SHA=/^[0-9a-f]{40}$/;
const REF=/^artifact:\/\/v5\/p(?:19|24)\/[a-z0-9][a-z0-9._/-]{7,119}$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const METRICS=Object.freeze([
 Object.freeze({signal:'api_p95_ms',unit:'ms',max:600000,component:'API',action:'PROFILE_API_READ_PATH'}),
 Object.freeze({signal:'core_move_p95_ms',unit:'ms',max:600000,component:'CORE',action:'PROFILE_CORE_MOVE_PATH'}),
 Object.freeze({signal:'ws_active_connections',unit:'count',max:10000000,component:'CORE',action:'REVIEW_INDEPENDENT_INGRESS_HOST'}),
 Object.freeze({signal:'queue_wait_p95_ms',unit:'ms',max:600000,component:'CORE',action:'PROFILE_QUEUE_AND_MATCHER'}),
 Object.freeze({signal:'pg_pool_used_pct',unit:'percent',max:100,component:'POSTGRES',action:'REBALANCE_BOUNDED_DB_POOLS'}),
 Object.freeze({signal:'pg_lock_wait_p95_ms',unit:'ms',max:600000,component:'POSTGRES',action:'EXPLAIN_LOCKS_AND_INDEXES'}),
 Object.freeze({signal:'worker_oldest_pending_s',unit:'seconds',max:604800,component:'WORKER',action:'REVIEW_FENCED_WORKER_CAPACITY'}),
 Object.freeze({signal:'redis_memory_used_pct',unit:'percent',max:100,component:'REDIS',action:'AUDIT_REDIS_TTLS_BEFORE_RESIZE'}),
 Object.freeze({signal:'host_cpu_pct',unit:'percent',max:100,component:'ORACLE',action:'MEASURE_HOST_CPU_AND_REBALANCE'}),
 Object.freeze({signal:'host_memory_pct',unit:'percent',max:100,component:'ORACLE',action:'MEASURE_HOST_RSS_AND_REBALANCE'}),
]);
const MAP=new Map(METRICS.map(x=>[x.signal,x]));
const ENVIRONMENTS=Object.freeze(['DISPOSABLE_P19','STAGING_CONTROLLED','REAL_PRODUCTION']);
function refuse(why){throw Error('P24_BASELINE_REFUSED:'+why);}
function exact(o,keys,label){
 if(!o||typeof o!=='object'||Array.isArray(o)||
    Object.keys(o).sort().join('|')!==[...keys].sort().join('|'))refuse('FIELDS_'+label);
}
function isRef(x){return typeof x==='string'&&REF.test(x)&&!x.includes('..')&&!x.includes('//',11);}
function epoch(s) {
 if(typeof s!=='string'||!UTC.test(s))refuse('BAD_UTC');
 const millis=Date.parse(s);
 if(!Number.isFinite(millis)||
    new Date(millis).toISOString().replace(/\.000Z$/,'Z')!==s.replace(/\.000Z$/,'Z'))refuse('BAD_UTC');
 return millis;
}
function rowAudit(rows, {allowUnknown=true}={}) {
 if(!Array.isArray(rows)||rows.length!==METRICS.length)refuse('SIGNAL_COVERAGE');
 const seen=new Set(),measured=[],gaps=[];
 for(const row of rows){
   exact(row,['signal','value','sampleCount','fullyObserved','evidenceRef'],'SIGNAL');
   const spec=MAP.get(row.signal);
   if(!spec||seen.has(row.signal))refuse('UNKNOWN_OR_DUPLICATE_SIGNAL');
   seen.add(row.signal);
   if(typeof row.fullyObserved!=='boolean'||!Number.isSafeInteger(row.sampleCount)||
      row.sampleCount<0||row.sampleCount>10000000)refuse('SAMPLE_COUNT');
   if(row.value===null){
     if(!allowUnknown||row.sampleCount!==0||row.fullyObserved!==false||row.evidenceRef!==null)
       refuse('UNKNOWN_MUST_NOT_CLAIM_DATA');
     gaps.push(row.signal);
   }else{
     if(typeof row.value!=='number'||!Number.isFinite(row.value)||
       row.value<0||row.value>spec.max||row.sampleCount===0||!isRef(row.evidenceRef))
       refuse('VALUE_OR_EVIDENCE');
     measured.push(row.signal);
     if(!row.fullyObserved||row.sampleCount<20)gaps.push(row.signal);
   }
 }
 return {measured, gaps};
}
function baselineTemplate(sourceSha){
 if(!SHA.test(sourceSha))refuse('SOURCE_SHA');
 return Object.freeze({
  format:'mega-v5-p24-capacity-baseline-template/v1',sourceSha,
  status:'NO_MEASURED_BASELINE',sourceTrafficForecast:'UNKNOWN',
  reviewCadence:'WEEKLY_PROPOSED_OWNER_APPROVAL_REQUIRED',
  metrics:METRICS.map(x=>({signal:x.signal,unit:x.unit,component:x.component,
    value:null,sampleCount:0,fullyObserved:false,evidenceRef:null})),
  productionAlertThresholdsApproved:false,liveSourceTelemetryCollected:false,
  g24Accepted:false,
 });
}
function assessBaseline(packet,sourceSha){
 if(!SHA.test(sourceSha))refuse('SOURCE_SHA');
 if(packet===null)return Object.freeze({
  status:'NO_MEASURED_BASELINE',sourceSha,measuredSignals:0,missingOrPartialSignals:METRICS.map(x=>x.signal),
  productionBaselineIndependentlyVerified:false,productionScaleEvidenceEstablished:false,
  launchCapacityProven:false,g24Accepted:false,
 });
 exact(packet,[
  'format','sourceSha','environment','periodStartUtc','periodEndUtc',
  'capturedAtUtc','p19SourceSha','p19EvidenceRef','collectionEvidenceRef','metrics',
 ],'PACKET');
 if(packet.format!=='mega-v5-p24-capacity-baseline/v1'||
    packet.sourceSha!==sourceSha||!ENVIRONMENTS.includes(packet.environment)||
    !SHA.test(packet.p19SourceSha)||!isRef(packet.p19EvidenceRef)||
    !isRef(packet.collectionEvidenceRef))refuse('SCOPE_AND_PROVENANCE');
 const start=epoch(packet.periodStartUtc),end=epoch(packet.periodEndUtc),captured=epoch(packet.capturedAtUtc);
 if(end<=start||end-start<3600000||end-start>30*86400000||
    captured<end||captured-end>7*86400000)refuse('BASELINE_INTERVAL');
 const audited=rowAudit(packet.metrics);
 const claimedProductionComplete=packet.environment==='REAL_PRODUCTION' && audited.gaps.length===0;
 const status=claimedProductionComplete?'PRODUCTION_CLAIM_NEEDS_INDEPENDENT_VERIFICATION':
   packet.environment==='DISPOSABLE_P19'?'DISPOSABLE_REFERENCE_NOT_CAPACITY':
   packet.environment==='STAGING_CONTROLLED'?'STAGING_REFERENCE_NOT_LAUNCH_CAPACITY':
   'PRODUCTION_BASELINE_INCOMPLETE';
 return Object.freeze({
  format:'mega-v5-p24-capacity-intake/v1',sourceSha,environment:packet.environment,
  periodStartUtc:packet.periodStartUtc,periodEndUtc:packet.periodEndUtc,
  status,measuredSignals:audited.measured.length,missingOrPartialSignals:audited.gaps,
  productionClaimComplete:claimedProductionComplete,
  productionBaselineIndependentlyVerified:false,
  productionScaleEvidenceEstablished:false,launchCapacityProven:false,
  currentProductionScaleAuthorization:false,g24Accepted:false,
 });
}
module.exports={SHA,REF,METRICS,MAP,ENVIRONMENTS,epoch,isRef,exact,rowAudit,baselineTemplate,assessBaseline};
