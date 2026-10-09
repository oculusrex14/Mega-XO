'use strict';

/*
 * P24-03. READ-ONLY scale decision support. A perfect packet is still a
 * CLAIM pending independent operator verification, never permission to
 * change Oracle, Neon, Redis, Vercel, routes or financial write topology.
 *
 * Requirements:
 * - accepted G23 with G00-G20+G22 accepted (P21 intentionally deferred);
 * - complete real-production baseline and current source-owned telemetry;
 * - configured, costed, reversible, owner-reviewed trigger;
 * - >=3 adjacent complete fresh windows continuously above threshold.
 */
const {SHA,METRICS,MAP,ENVIRONMENTS,epoch,isRef,exact,rowAudit,assessBaseline}=require('./capacity-baseline');
const {assessPolicy}=require('./scale-policy');
const {hasAcceptedGate}=require('../p23/retirement-readiness');
const MAX_WINDOWS=288;
function refuse(why){throw Error('P24_SCALE_REFUSED:'+why);}
function inspectIntervals(intervals,sourceSha,nowMs){
 if(!Array.isArray(intervals)||intervals.length>MAX_WINDOWS)refuse('BOUNDED_WINDOWS_REQUIRED');
 const rows=[];let lastEnd=null;
 for(const packet of intervals){
  try{exact(packet,[
   'format','sourceSha','environment','startUtc','endUtc','complete',
   'collectionEvidenceRef','metrics',
  ],'INTERVAL');}catch{refuse('FIELDS_INTERVAL');}
  if(packet.format!=='mega-v5-p24-scale-interval/v1'||
    packet.sourceSha!==sourceSha||
    !ENVIRONMENTS.includes(packet.environment)||
    typeof packet.complete!=='boolean'||!isRef(packet.collectionEvidenceRef))
    refuse('INTERVAL_SOURCE');
  const start=epoch(packet.startUtc),end=epoch(packet.endUtc);
  if(end<=start||end-start<60000||end-start>30*60000||
     end>nowMs || (lastEnd!==null&&start<lastEnd))refuse('INTERVAL_TIME_OR_OVERLAP');
  lastEnd=end;
  const data=rowAudit(packet.metrics);
  rows.push({
   start,end,environment:packet.environment,
   complete:packet.complete&&data.gaps.length===0,
   metrics:new Map(packet.metrics.map(x=>[x.signal,x])),
   collectionEvidenceRef:packet.collectionEvidenceRef,
  });
 }
 return rows;
}
function sustained(rows,signal,threshold,minutes,nowMs){
 let end=null,total=0,count=0,latestValue=null;
 for(let i=rows.length-1;i>=0;i--){
  const w=rows[i],m=w.metrics.get(signal);
  if(w.environment!=='REAL_PRODUCTION'||!w.complete||!m||
     m.value===null||m.value<threshold||m.sampleCount<20||!m.fullyObserved)break;
  if(end===null) {
   if(nowMs-w.end>15*60000)break;
   latestValue=m.value;
  }else if(w.end!==end)break; // missing intervals are not proof of a sustained threshold
  total+=(w.end-w.start)/60000;
  end=w.start;count++;
 }
 return count>=3 && total>=minutes
  ? {sustainedMinutes:total,windows:count,reportedObservedValueUnverified:latestValue}
  : null;
}
function reviewScale({ledger,sourceSha,nowUtc,baseline=null,policy=null,intervals=[]}={}){
 if(!SHA.test(sourceSha))refuse('SOURCE_SHA');
 const now=epoch(nowUtc);
 if(!hasAcceptedGate(ledger,'G23'))return Object.freeze({
  format:'mega-v5-p24-scale-review/v1',sourceSha,
  status:'BLOCKED_G23_NOT_ACCEPTED',acceptedG23:false,
  reason:'P23_RETIREMENT_AND_POSTCUTOVER_MEASUREMENTS_REQUIRED',
  reviewCandidates:[],ownerApprovalPending:[],
  baselineIndependentlyVerified:false,telemetryIndependentlyVerified:false,
  actualScaleApplied:false,productionMutationAuthorized:false,
  independentHostHAProven:false,g24Accepted:false,
 });
 const observed=assessBaseline(baseline,sourceSha);
 const rules=assessPolicy(policy,sourceSha);
 const windows=inspectIntervals(intervals,sourceSha,now);
 const empty={format:'mega-v5-p24-scale-review/v1',sourceSha,acceptedG23:true,
  reviewCandidates:[],ownerApprovalPending:[],
  baselineIndependentlyVerified:false,telemetryIndependentlyVerified:false,
  actualScaleApplied:false,productionMutationAuthorized:false,
  independentHostHAProven:false,g24Accepted:false,
 };
 if(observed.status!=='PRODUCTION_CLAIM_NEEDS_INDEPENDENT_VERIFICATION') {
  return Object.freeze({...empty,status:'NOT_TRIGGERED_NO_VERIFIED_PRODUCTION_BASELINE',
   baselineStatus:observed.status,windowsObserved:windows.length});
 }
 if(rules.configuredTriggers===0)return Object.freeze({
  ...empty,status:'NOT_TRIGGERED_NO_APPROVED_THRESHOLDS',windowsObserved:windows.length,
 });
 if(windows.length===0)return Object.freeze({
  ...empty,status:'NOT_TRIGGERED_NO_CURRENT_TELEMETRY',windowsObserved:0,
 });
 const candidates=[],approvalMissing=[],notTriggered=[];
 for(const entry of policy.entries){
  if(entry.threshold===null)continue;
  const proof=sustained(windows,entry.signal,entry.threshold,entry.sustainMinutes,now);
  if(!proof){notTriggered.push(entry.signal);continue;}
  const row={
   signal:entry.signal,action:MAP.get(entry.signal).action,threshold:entry.threshold,
   ...proof,estimatedAdditionalMonthlyUsd:entry.estimatedAdditionalMonthlyUsd,
   recommendedNextStep:'INDEPENDENT_REVIEW_ONLY',
  };
  if(entry.operatorApproved)candidates.push(row);
  else approvalMissing.push(row);
 }
 return Object.freeze({
  ...empty,
  status:candidates.length?'DECLARED_TRIGGER_REQUIRES_INDEPENDENT_APPROVAL_AND_DEPLOYMENT':
    approvalMissing.length?'THRESHOLD_CLAIM_AWAITS_OWNER_APPROVAL':
    'NOT_TRIGGERED_OR_INCOMPLETE_CONTINUOUS_EVIDENCE',
  windowsObserved:windows.length,
  reviewCandidates:candidates,ownerApprovalPending:approvalMissing,
  notTriggeredSignals:notTriggered,
 });
}
module.exports={MAX_WINDOWS,inspectIntervals,sustained,reviewScale};
