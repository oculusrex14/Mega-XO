'use strict';

/*
 * P24-02. Operator-configurable scaling trigger REVIEW, not autoscaling.
 * There are deliberately NO numeric production defaults: values need real
 * baselines and explicit cost/rollback approval after P23. Smallest change
 * first: optimize query/index/pool, then consider extra bounded capacity.
 */
const {SHA,METRICS,MAP,isRef,exact}=require('./capacity-baseline');
const ARCHITECTURE=Object.freeze({
 onePostgresWriteAuthority:true,
 v4SqliteCannotResumeWrites:true,
 redisIsEphemeralOnly:true,
 coresOnOneOracleAreNotHostHA:true,
 noGlobalMultiPrimary:true,
 noSpeculativeProvisioning:true,
});
function fail(why){throw Error('P24_POLICY_REFUSED:'+why);}
function template(sourceSha){
 if(!SHA.test(sourceSha))fail('SOURCE_SHA');
 return {
  format:'mega-v5-p24-scale-policy/v1',sourceSha,ownerReviewCadenceDays:7,
  architectureGuards:{...ARCHITECTURE},
  entries:METRICS.map(spec=>({
   signal:spec.signal,action:spec.action,
   threshold:null,sustainMinutes:null,estimatedAdditionalMonthlyUsd:null,
   measurementQueryRef:null,rollbackEvidenceRef:null,
   ownerApprovalEvidenceRef:null,operatorApproved:false,changeTicketRef:null,
  })),
 };
}
function assessPolicy(policy,expectedSha){
 if(!SHA.test(expectedSha))fail('SOURCE_SHA');
 if(policy===null)return Object.freeze({
  status:'NO_APPROVED_SCALE_TRIGGERS',sourceSha:expectedSha,
  configuredTriggers:0,approvedClaims:0,unconfiguredSignals:METRICS.map(x=>x.signal),
  liveInfrastructureChangeAuthorized:false,g24Accepted:false,
 });
 try{exact(policy,['format','sourceSha','ownerReviewCadenceDays','architectureGuards','entries'],'POLICY');}
 catch{fail('FIELDS_POLICY');}
 if(policy.format!=='mega-v5-p24-scale-policy/v1' ||
    policy.sourceSha!==expectedSha ||
    !Number.isSafeInteger(policy.ownerReviewCadenceDays) ||
    policy.ownerReviewCadenceDays<1||policy.ownerReviewCadenceDays>30)fail('POLICY_SOURCE_OR_REVIEW_CADENCE');
 try{exact(policy.architectureGuards,Object.keys(ARCHITECTURE),'ARCHITECTURE');}
 catch{fail('FIELDS_ARCHITECTURE');}
 for(const [k,val] of Object.entries(ARCHITECTURE))
  if(policy.architectureGuards[k]!==val)fail('MULTI_WRITER_OR_UNPROVEN_HA');
 if(!Array.isArray(policy.entries)||policy.entries.length!==METRICS.length)fail('TRIGGER_COVERAGE');
 const seen=new Set(),configured=[],approved=[];
 for(const entry of policy.entries){
  try{exact(entry,[
   'signal','action','threshold','sustainMinutes','estimatedAdditionalMonthlyUsd',
   'measurementQueryRef','rollbackEvidenceRef','ownerApprovalEvidenceRef',
   'operatorApproved','changeTicketRef',
  ],'TRIGGER');}catch{fail('FIELDS_TRIGGER');}
  const spec=MAP.get(entry.signal);
  if(!spec||seen.has(entry.signal)||entry.action!==spec.action||
     typeof entry.operatorApproved!=='boolean')fail('UNKNOWN_OR_INVENTED_ACTION');
  seen.add(entry.signal);
  if(entry.threshold===null){
   if(entry.sustainMinutes!==null||entry.estimatedAdditionalMonthlyUsd!==null||
      entry.measurementQueryRef!==null||entry.rollbackEvidenceRef!==null||
      entry.ownerApprovalEvidenceRef!==null||entry.operatorApproved||
      entry.changeTicketRef!==null)fail('UNCONFIGURED_NO_AUTHORITY');
   continue;
  }
  if(typeof entry.threshold!=='number'||!Number.isFinite(entry.threshold)||
     entry.threshold<=0||entry.threshold>spec.max||
     !Number.isSafeInteger(entry.sustainMinutes)||entry.sustainMinutes<15||
     entry.sustainMinutes>10080||
     typeof entry.estimatedAdditionalMonthlyUsd!=='number'||
     !Number.isFinite(entry.estimatedAdditionalMonthlyUsd)||
     entry.estimatedAdditionalMonthlyUsd<0||
     entry.estimatedAdditionalMonthlyUsd>1000000||
     !isRef(entry.measurementQueryRef)||!isRef(entry.rollbackEvidenceRef))fail('TRIGGER_THRESHOLD_COST_ROLLBACK');
  if(entry.operatorApproved){
   if(!isRef(entry.ownerApprovalEvidenceRef)||!isRef(entry.changeTicketRef))
    fail('APPROVAL_PROOF_REQUIRED');
   approved.push(entry.signal);
  }else if(entry.ownerApprovalEvidenceRef!==null||entry.changeTicketRef!==null){
   fail('APPROVAL_MISMATCH');
  }
  configured.push(entry.signal);
 }
 return Object.freeze({
  format:'mega-v5-p24-scale-policy-review/v1',sourceSha:expectedSha,
  status:configured.length?'CONFIGURED_NOT_EXECUTED':'NO_APPROVED_SCALE_TRIGGERS',
  configuredTriggers:configured.length,
  approvedClaims:approved.length,configuredSignals:configured,
  unconfiguredSignals:METRICS.map(x=>x.signal).filter(x=>!configured.includes(x.signal)),
  operatorEvidenceIndependentlyVerified:false,
  productionBudgetVerified:false,
  liveInfrastructureChangeAuthorized:false,
  globalMultiPrimaryAllowed:false,
  independentHostHAProven:false,
  g24Accepted:false,
 });
}
module.exports={ARCHITECTURE,template,assessPolicy};
