'use strict';
/* A receipt validator, not deployment permission or an assertion that external checks happened. */
const C=require('./capture.js');
const REQUIRED=['privacyPurpose','retention','encryptedStorage','userChoiceDelivery','workerScheduler',
 'reconcilerScheduler','deletionSweep','exportPurge','restoreJournal','postgresRestart','redisLoss',
 'latencyAndQuota','stagingReplay','zeroMissingEligible','rollback'];
function assess({sourceCommit,configuration,metrics,receipt,now=Date.now()}={}){
 const failures=[];
 if(!/^[a-f0-9]{40}$/.test(sourceCommit||''))failures.push('SOURCE_SHA_REQUIRED');
 if(!configuration?.enabled)failures.push('COLLECTION_DISABLED');
 if(configuration?.sourceCommit!==sourceCommit)failures.push('DEPLOYED_POLICY_SOURCE_MISMATCH');
 if(configuration?.rulesHash!==C.RULES_HASH)failures.push('RULES_HASH_MISMATCH');
 if(!configuration?.policyVersion)failures.push('POLICY_VERSION_REQUIRED');
 if(!['staging','production'].includes(configuration?.environment))failures.push('REAL_TARGET_REQUIRED');
 if(!metrics||['pending','quarantined','expiredUnpurged'].some(k=>!Number.isSafeInteger(metrics[k])||metrics[k]!==0))failures.push('CAPTURE_BACKLOG_OR_UNKNOWN');
 if(!metrics||!Number.isSafeInteger(metrics.sealed)||metrics.sealed<1)failures.push('SEALED_CANARY_REQUIRED');
 if(!receipt||receipt.sourceCommit!==sourceCommit||receipt.rulesHash!==C.RULES_HASH||receipt.policyVersion!==configuration?.policyVersion||receipt.environment!==configuration?.environment)failures.push('RECEIPT_BINDING');
 if(!receipt||!Number.isSafeInteger(receipt.privacyEpoch)||receipt.privacyEpoch!==Number(configuration?.privacyEpoch))failures.push('PRIVACY_EPOCH_MISMATCH');
 const at=Date.parse(receipt?.checkedAt||'');if(!Number.isFinite(at)||at>now||now-at>86400000)failures.push('RECEIPT_STALE');
 for(const key of REQUIRED){const e=receipt?.evidence?.[key];if(!e||e.status!=='PASS'||typeof e.artifact!=='string'||!e.artifact.trim()||e.artifact.length>1000)failures.push('MISSING_'+key);}
 return {gate:'day-one-gameplay-capture/v1',result:failures.length?'BLOCKED':'RECEIPTS_READY_FOR_MAIN_REVIEW',sourceCommit,rulesHash:C.RULES_HASH,failures,productionAuthorized:false,trainingAuthorized:false};
}
module.exports={assess,REQUIRED};
