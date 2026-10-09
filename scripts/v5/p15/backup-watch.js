#!/usr/bin/env node
'use strict';

/**
 * P15-04 non-mutating monitoring input. Reads ONLY an operator-held private
 * R2 transfer receipt produced by the first-party encrypted uploader, not a
 * dump, S3 credentials, a provider callback or arbitrary remote URL.
 *
 * Exit 0 = recent against a PROPOSED age only; exit 2 = missing, stale,
 * untrusted/invalid or future-dated backup. Neither exit proves a live alert
 * was delivered, owner approved a 15-minute target, R2 IAM, Neon PITR,
 * full service restore or G15. This script does not schedule/send alerts.
 */
const fs=require('node:fs');
const path=require('node:path');
const {checkFile,privateDirectory}=require('./direct-target.js');
const {freshness}=require('./drill-readiness.js');
const SHA=/^[a-f0-9]{40}$/,HEX=/^[a-f0-9]{64}$/;
function refuse(msg){throw Error('P15_FRESHNESS_REFUSED: '+msg);}
function validatedReceipt(value,sourceSha){
 if(!value||typeof value!=='object'||Array.isArray(value)||
    value.format!=='mega-v5-p15-r2-upload-readback/v1'||
    value.sourceSha!==sourceSha||!HEX.test(value.ciphertextSha256)||
    !Number.isSafeInteger(value.ciphertextBytes)||value.ciphertextBytes<300||
    typeof value.backupId!=='string'||
    !/^v5-p15-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{16}$/.test(value.backupId)||
    typeof value.backupCreatedAtUtc!=='string'||
    typeof value.readbackCheckedAtUtc!=='string'||
    value.realProviderUploadAndIndependentReadbackObserved!==true||
    value.mockedCallsOnly!==false||
    value.ciphertextAndManifestReadbackMatching!==true||
    value.uploadUsedWriteOncePrecondition!==true||
    value.separateWriterReaderProfilesUsed!==true||
    value.decryptionAndRestoreFromR2Completed!==false||
    value.g15Accepted!==false) {
  refuse('no trustworthy first-party real write-once R2 readback receipt');
 }
 return value;
}
function check(value,{sourceSha,checkedAtUtc,ownerConfirmsScope=false}){
 if(!SHA.test(sourceSha)||ownerConfirmsScope!==true){
  refuse('owner-protected source commit and receipt scope are required');
 }
 const receipt=validatedReceipt(value,sourceSha);
 const inspected=freshness({checkedAtUtc,
  lastRealBackupUtc:receipt.backupCreatedAtUtc,realR2ReaderProof:true});
 const ageAtReadback=freshness({checkedAtUtc:receipt.readbackCheckedAtUtc,
  lastRealBackupUtc:receipt.backupCreatedAtUtc,realR2ReaderProof:true});
 if(ageAtReadback.alertRequired && ageAtReadback.status!=='CANDIDATE_AGE_BREACHED'){
  refuse('provider readback had impossible chronology');
 }
 return {
  format:'mega-v5-p15-private-backup-age-watch/v1',
  sourceSha,
  checkedAtUtc,
  candidateMaxAgeMinutes:inspected.candidateMaxAgeMinutes,
  measuredCandidateAgeMinutes:inspected.measuredBackupAgeMinutes,
  status:inspected.status,
  alertRequired:inspected.alertRequired,
  realR2EncryptedObjectAndManifestReadbackRecorded:true,
  independentlyAuthenticatedProviderIam:false,
  actualIndependentR2RestoreCompleted:false,
  productionThresholdOwnerApproved:false,
  realAlertDeliveryObserved:false,
  g15Accepted:false
 };
}
function readReceipt(filename){
 if(typeof filename!=='string'||!path.isAbsolute(filename)){
  refuse('absolute operator-held receipt file required');
 }
 try{
  privateDirectory(path.dirname(filename));
  checkFile(filename,{secret:true});
  if(fs.statSync(filename).size<100||fs.statSync(filename).size>15000){
   refuse('bounded receipt file required');
  }
  const data=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(!data||typeof data!=='object'||Array.isArray(data))refuse('invalid private receipt JSON');
  return data;
 }catch(e){
  if(e.message?.startsWith('P15_FRESHNESS_REFUSED:'))throw e;
  refuse('operator R2 receipt unavailable');
 }
}
function run(args,env=process.env){
 if(args.length!==6||args[0]!=='--receipt'||args[2]!=='--sha'||args[4]!=='--now'){
  refuse('usage: --receipt /private/p15.r2-receipt.json --sha EXACT_COMMIT --now ISO_UTC');
 }
 const report=check(readReceipt(args[1]),{
  sourceSha:args[3],checkedAtUtc:args[5],
  ownerConfirmsScope:env.P15_OWNER_CONFIRMS_R2_RECEIPT_SCOPE==='1'
 });
 return report;
}
if(require.main===module){
 try{
  const report=run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(report.alertRequired)process.exitCode=2;
 }catch(e){
  process.stderr.write(e.message+'\n');
  process.exitCode=2;
 }
}
module.exports={validatedReceipt,check,readReceipt,run};
