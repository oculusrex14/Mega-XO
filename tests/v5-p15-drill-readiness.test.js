'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {SPEC,assessDrills,freshness}=require('../scripts/v5/p15/drill-readiness.js');
const sha='a'.repeat(40);
function drill(id='1',hash='b'){
 return {
  format:'mega-v5-p15-disposable-restore-evidence/v1',
  sourceSha:sha,
  backupId:'v5-p15-2026-10-09T05-00-00-000Z-'+id.repeat(16),
  backupCiphertextSha256:hash.repeat(64),
  sourceKind:'ACTUAL_PG16_DISPOSABLE_INSTANCE',
  restoreKind:'SECOND_INDEPENDENT_PG16_DISPOSABLE_INSTANCE',
  syntheticOnly:true,quarantineAndNoProviderEffectsDeclared:true,
  sourceAndRestoredDigestEqual:true,actualEncryptedArchiveVerified:true,
  recoveryTargetCleaned:true,nonemptyAssetAndTombstoneFixtures:true,
  sourceAndRestoredRows:212,sourceAndRestoredTables:69,migrationsVerified:42,
  localBackupDurationMs:124.2,localRecoveryDurationMs:208.5,
  archiveRetrievedFromR2:false,roleAndExternalSecretsReconstructed:false,
  neonPitrObserved:false,actualRpoMeasured:false,actualRtoMeasured:false,
  localBackupCompletedAtUtc:'2026-10-09T05:00:00.000Z',
  restoredAtUtc:'2026-10-09T05:00:02.000Z',g15Accepted:false
 };
}
test('two distinct actual synthetic full restores never imply weekly scheduling or G15',()=>{
 const result=assessDrills([drill('1','b'),drill('2','c')],sha);
 assert.equal(result.executedFullRoundtripCount,2);
 assert.equal(result.actualEncryptedCopyAndFullDataEquality,true);
 assert.equal(result.recurringScheduleInstalledAndObserved,false);
 assert.equal(result.realAlertDeliveryVerified,false);
 assert.equal(result.actualNeonPitr,false);
 assert.equal(result.productionRtoMeasured,false);
 assert.equal(result.g15Accepted,false);
 assert.equal(SPEC.productionTargetsApproved,false);
});
test('same ciphertext, duplicate backup ID, incomplete proof and fake G15 fail closed',()=>{
 const changes=[
  x=>{x.backupId=drill('1','b').backupId;},
  x=>{x.backupCiphertextSha256=drill('1','b').backupCiphertextSha256;},
  x=>{x.sourceAndRestoredDigestEqual=false;},
  x=>{x.recoveryTargetCleaned=false;},
  x=>{x.archiveRetrievedFromR2=true;},
  x=>{x.g15Accepted=true;},
  x=>{x.actualRtoMeasured=true;},
  x=>{x.sourceSha='f'.repeat(40);},
  x=>{x.localRecoveryDurationMs=-1;},
  x=>{x.sourceAndRestoredRows=0;},
  x=>{x.restoredAtUtc='2026-10-08T00:00:00.000Z';}
 ];
 for(const change of changes){
  const second=drill('2','c');change(second);
  assert.throws(()=>assessDrills([drill('1','b'),second],sha),/P15_DRILL_REFUSED/);
 }
 assert.throws(()=>assessDrills([drill('1','b')],sha),/P15_DRILL_REFUSED/);
});
test('missing/stale backups require alerts; a fresh declared age never certifies delivery',()=>{
 const now='2026-10-09T05:00:00.000Z';
 const missing=freshness({checkedAtUtc:now,lastRealBackupUtc:null});
 assert.equal(missing.alertRequired,true);
 assert.equal(missing.status,'NO_VERIFIED_INDEPENDENT_BACKUP');
 const declared=freshness({checkedAtUtc:now,
  lastRealBackupUtc:'2026-10-09T04:55:00.000Z',realR2ReaderProof:true});
 assert.equal(declared.measuredBackupAgeMinutes,5);
 assert.equal(declared.alertRequired,false);
 assert.equal(declared.thresholdOwnerApproved,false);
 assert.equal(declared.alertDeliveryObserved,false);
 const stale=freshness({checkedAtUtc:now,
  lastRealBackupUtc:'2026-10-09T04:30:00.000Z',realR2ReaderProof:true});
 assert.equal(stale.measuredBackupAgeMinutes,30);
 assert.equal(stale.alertRequired,true);
 assert.equal(stale.status,'CANDIDATE_AGE_BREACHED');
 const unverified=freshness({checkedAtUtc:now,
  lastRealBackupUtc:'2026-10-09T04:55:00.000Z',realR2ReaderProof:false});
 assert.equal(unverified.alertRequired,true);
 assert.equal(unverified.measuredBackupAgeMinutes,null);
 assert.throws(()=>freshness({checkedAtUtc:now,
  lastRealBackupUtc:'2026-10-09T05:20:00.000Z',realR2ReaderProof:true}),/P15_DRILL_REFUSED/);
});
