#!/usr/bin/env node
'use strict';

/**
 * P15-04: fail-closed evidence assessment, NEVER a scheduler or alarm sender.
 *
 * Two independently created, full-source-hash and data-digest-verified
 * disposable restorations are the minimum regression drill. Consecutive
 * executions in ONE CI run do NOT prove a recurring production schedule.
 * Backup freshness vs a 15-min and DR time vs a 60-min objective are still
 * PROPOSED, not accepted production SLOs. A drifted/stale/missing report
 * records ALERT_REQUIRED; an untested alert delivery NEVER becomes green.
 */
const fs=require('node:fs');
const path=require('node:path');
const SHA40=/^[a-f0-9]{40}$/,SHA64=/^[a-f0-9]{64}$/;
const ARCHIVE=/^v5-p15-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{16}$/;
const SPEC=Object.freeze({candidateBackupMaxAgeMinutes:15,
 candidateRestoreMaxMinutes:60,candidateRestoreDrillCadence:'WEEKLY',
 productionTargetsApproved:false,deliveryVerificationRequired:true});
function refuse(why){throw Error('P15_DRILL_REFUSED: '+why);}
function clock(s){
 if(typeof s!=='string'||!(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s))||
   !Number.isFinite(Date.parse(s)))refuse('valid RFC3339 UTC timestamp required');
 return Date.parse(s);
}
function checkDrill(record,sourceSha){
 if(!record||typeof record!=='object'||Array.isArray(record)||
    record.format!=='mega-v5-p15-disposable-restore-evidence/v1'||
    record.sourceSha!==sourceSha||!ARCHIVE.test(record.backupId)||
    !SHA64.test(record.backupCiphertextSha256)||
    record.sourceKind!=='ACTUAL_PG16_DISPOSABLE_INSTANCE'||
    record.restoreKind!=='SECOND_INDEPENDENT_PG16_DISPOSABLE_INSTANCE'||
    record.syntheticOnly!==true||record.quarantineAndNoProviderEffectsDeclared!==true||
    record.sourceAndRestoredDigestEqual!==true||
    record.actualEncryptedArchiveVerified!==true||
    record.recoveryTargetCleaned!==true||
    record.nonemptyAssetAndTombstoneFixtures!==true||
    !Number.isSafeInteger(record.sourceAndRestoredRows)||record.sourceAndRestoredRows<42||
    !Number.isSafeInteger(record.sourceAndRestoredTables)||record.sourceAndRestoredTables<19||
    !Number.isInteger(record.migrationsVerified)||record.migrationsVerified<42||
    !Number.isFinite(record.localBackupDurationMs)||record.localBackupDurationMs<0||
    !Number.isFinite(record.localRecoveryDurationMs)||record.localRecoveryDurationMs<0||
    record.archiveRetrievedFromR2!==false||
    record.roleAndExternalSecretsReconstructed!==false||
    record.neonPitrObserved!==false||
    record.actualRpoMeasured!==false||record.actualRtoMeasured!==false||
    record.g15Accepted!==false){
  refuse('disposable drill evidence missing, forged or falsely accepted');
 }
 clock(record.restoredAtUtc);
 clock(record.localBackupCompletedAtUtc);
 if(Date.parse(record.restoredAtUtc)<Date.parse(record.localBackupCompletedAtUtc)){
  refuse('negative elapsed timestamps');
 }
 return record;
}
function assessDrills(records,sourceSha){
 if(!SHA40.test(sourceSha)||!Array.isArray(records)||records.length!==2){
  refuse('two distinct exact-source disposable drills required');
 }
 const first=checkDrill(records[0],sourceSha);
 const second=checkDrill(records[1],sourceSha);
 if(first.backupId===second.backupId||
    first.backupCiphertextSha256===second.backupCiphertextSha256){
  refuse('fresh encrypted archive and new per-drill key required');
 }
 return {
  format:'mega-v5-p15-repeated-drill-assessment/v1',
  sourceSha,
  executedFullRoundtripCount:2,
  actualEncryptedCopyAndFullDataEquality:true,
  sourceAndRestoreSeparatedIntoTwoPgClusters:true,
  recreatedTargetDatabaseEachRun:true,
  allOwnedTargetsCleaned:true,
  distinctSealedArchivesVerified:true,
  localMaxBackupDurationMs:Math.max(first.localBackupDurationMs,second.localBackupDurationMs),
  localMaxRestoreDurationMs:Math.max(first.localRecoveryDurationMs,second.localRecoveryDurationMs),
  actualIndependentR2Restore:false,actualNeonPitr:false,
  recurringScheduleInstalledAndObserved:false,
  restoreSourceIsRealCustomerData:false,
  productionRpoMeasured:false,productionRtoMeasured:false,
  realAlertDeliveryVerified:false,
  productionTargetApproval:false,
  result:'TWO_REAL_SYNTHETIC_ROUNDTRIPS_NOT_SCHEDULED_PRODUCTION_DRILL',
  g15Accepted:false
 };
}
function freshness({lastRealBackupUtc,checkedAtUtc,realR2ReaderProof}={}){
 const checked=clock(checkedAtUtc);
 if(lastRealBackupUtc===null||lastRealBackupUtc===undefined){
  return {format:'mega-v5-p15-freshness-evaluation/v1',
   measuredBackupAgeMinutes:null,candidateMaxAgeMinutes:SPEC.candidateBackupMaxAgeMinutes,
   status:'NO_VERIFIED_INDEPENDENT_BACKUP',alertRequired:true,
   alertDeliveryObserved:false,thresholdOwnerApproved:false,g15Accepted:false};
 }
 const backedUp=clock(lastRealBackupUtc);
 const delta=(checked-backedUp)/60000;
 if(delta < -2 || delta > 525600)refuse('backup observation too far in future or cannot be trusted');
 if(realR2ReaderProof!==true){
  return {format:'mega-v5-p15-freshness-evaluation/v1',
   measuredBackupAgeMinutes:null,candidateMaxAgeMinutes:SPEC.candidateBackupMaxAgeMinutes,
   status:'NO_VERIFIED_INDEPENDENT_BACKUP',alertRequired:true,
   alertDeliveryObserved:false,thresholdOwnerApproved:false,g15Accepted:false};
 }
 return {format:'mega-v5-p15-freshness-evaluation/v1',
   measuredBackupAgeMinutes:Number(Math.max(0,delta).toFixed(3)),
   candidateMaxAgeMinutes:SPEC.candidateBackupMaxAgeMinutes,
   status:delta>SPEC.candidateBackupMaxAgeMinutes?'CANDIDATE_AGE_BREACHED':'CANDIDATE_AGE_WITHIN_RANGE',
   alertRequired:delta>SPEC.candidateBackupMaxAgeMinutes,
   alertDeliveryObserved:false,thresholdOwnerApproved:false,g15Accepted:false};
}
function readSanitized(root,relative){
 if(typeof relative!=='string'||!/^\.artifacts\/p15-disposable-restore-[12]\.json$/.test(relative)) {
  refuse('only explicit nonsecret owned-drill artifacts are accepted');
 }
 const base=path.resolve(root),file=path.resolve(base,relative);
 if(!file.startsWith(base+path.sep))refuse('path escapes working tree');
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<100||stat.size>20000)refuse('bad drill evidence file');
 let doc;try{doc=JSON.parse(fs.readFileSync(file,'utf8'));}catch{refuse('bad drill evidence JSON');}
 return doc;
}
function run(args,root=process.cwd()){
 if(args.length!==6||args[0]!=='--first'||args[2]!=='--second'||args[4]!=='--sha') {
  refuse('usage: --first .artifacts/p15-disposable-restore-1.json --second .artifacts/p15-disposable-restore-2.json --sha EXACT_SOURCE_SHA');
 }
 if(args[1]!=='.artifacts/p15-disposable-restore-1.json'||
    args[3]!=='.artifacts/p15-disposable-restore-2.json'){
  refuse('only two independent ordered owned-drill artifacts are supported');
 }
 return assessDrills([readSanitized(root,args[1]),readSanitized(root,args[3])],args[5]);
}
if(require.main===module){
 try{const r=run(process.argv.slice(2));process.stdout.write(JSON.stringify(r,null,2)+'\n');}
 catch(err){process.stderr.write(err.message+'\n');process.exitCode=2;}
}
module.exports={SPEC,clock,checkDrill,assessDrills,freshness,readSanitized,run};
