#!/usr/bin/env node
'use strict';

/**
 * V5-15-01: recovery-policy decision intake.
 * Targets in the source specification are PROPOSALS, not owner approvals,
 * observed restore times, verified R2 storage or evidence of Neon PITR.
 * P15-G15 must never be inferred from populated planning fields.
 */
const fs=require('node:fs');
const path=require('node:path');
const SHA=/^[a-f0-9]{40}$/;
const DECISIONS=Object.freeze([
 'neonProductionProjectAndPaidPlanObserved',
 'neonPitrActualRestorePointDemonstrated',
 'independentR2RepositoryScopedAndVerified',
 'privateKeyOffHostCustodyDemonstrated',
 'privacyDeletionRetentionApproved',
 'measuredEncryptedBackupSizeAndCostApproved',
 'productionScheduleAndBackupRoleApproved',
 'sourceAndTargetRolesReconstructedOnIsolation',
 'offsiteRecoveryAlertDeliveryObserved'
]);
function refuse(reason){throw Error('P15_POLICY_REFUSED: '+reason);}
function plan(){
 return {
  format:'mega-v5-p15-recovery-policy/v1',
  status:'PROPOSED_TARGETS_NOT_APPROVED',
  sourceProgram:'V5-15-01/V5-15-04',
  candidateRpoMinutes:15,
  candidateRtoMinutes:60,
  candidateRestorePointIntervalMinutes:15,
  candidateRetention:{shortIntervalDays:1,dailyDays:14,weeklyWeeks:8},
  allTargetsProvisional:true,
  actualProductionRpoMinutes:null,
  actualProductionRtoMinutes:null,
  actualEncryptedR2SizeBytes:null,
  measuredStorageCost:null,
  neonProductionHistoryVerified:false,
  realR2RecoveryVerified:false,
  outboundDuringRestore:'QUARANTINE_DISABLED',
  authorityAfterRollback:'POSTGRESQL_ONLY_AFTER_FIRST_APPLICATION_WRITE',
  decisions:DECISIONS.map(id=>({id,status:'AWAITING_OWNER_OR_PROVIDER_EVIDENCE'})),
  g15Accepted:false
 };
}
function evaluate(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||
    input.format!=='mega-v5-p15-policy-intake/v1'||!SHA.test(input.sourceSha)||
    typeof input.checkedAtUtc!=='string'||!Number.isFinite(Date.parse(input.checkedAtUtc))||
    !Array.isArray(input.decisions)||input.decisions.length!==DECISIONS.length) {
  refuse('signed-off environment/owner decision intake missing');
 }
 const seen=new Set();
 const assessed=[];
 for(const entry of input.decisions){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||
     Object.keys(entry).sort().join(',')!=='evidenceRef,id,status'||
     !DECISIONS.includes(entry.id)||seen.has(entry.id)||
     !['OBSERVED','NOT_VERIFIED','BLOCKED'].includes(entry.status)||
     (entry.status==='OBSERVED' && !(typeof entry.evidenceRef==='string' &&
       /^[a-zA-Z0-9._/-]{8,180}$/.test(entry.evidenceRef) && !entry.evidenceRef.includes('..')))||
     (entry.status!=='OBSERVED'&&entry.evidenceRef!==null)) {
    refuse('unexpected decision, duplicate id or ungrounded approval');
  }
  seen.add(entry.id);
  assessed.push({id:entry.id,status:entry.status});
 }
 const allObserved=assessed.every(row=>row.status==='OBSERVED');
 return {
  format:'mega-v5-p15-policy-readiness/v1',sourceSha:input.sourceSha,
  checkedAtUtc:input.checkedAtUtc,readiness:
    allObserved?'POLICY_DECLARATIONS_PRESENT_NEED_INDEPENDENT_AUDIT':'OWNER_PROVIDER_EVIDENCE_INCOMPLETE',
  declarationCount:assessed.filter(row=>row.status==='OBSERVED').length,
  pending:assessed.filter(row=>row.status!=='OBSERVED').map(row=>row.id),
  actualRestoreObserved:false,
  observedPitrAndR2CrossProviderRestores:false,
  productionEnablementAuthorized:false,
  g15Accepted:false
 };
}
function main(argv){
 if(argv.length!==1||argv[0]!=='--plan')refuse('usage: recovery-policy.js --plan');
 return plan();
}
if(require.main===module){
 try{process.stdout.write(JSON.stringify(main(process.argv.slice(2)),null,2)+'\n');}
 catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={DECISIONS,plan,evaluate,main};
