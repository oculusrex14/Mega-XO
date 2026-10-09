'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {check,readReceipt,run}=require('../scripts/v5/p15/backup-watch.js');
const sha='a'.repeat(40);
const clock='2026-10-09T05:00:00.000Z';
function receipt(){
 return {format:'mega-v5-p15-r2-upload-readback/v1',
  backupId:'v5-p15-2026-10-09T04-55-00-000Z-1234567890abcdef',
  sourceSha:sha,ciphertextSha256:'b'.repeat(64),ciphertextBytes:3000,
  backupCreatedAtUtc:'2026-10-09T04:55:00.000Z',
  readbackCheckedAtUtc:'2026-10-09T04:56:00.000Z',
  realProviderUploadAndIndependentReadbackObserved:true,
  mockedCallsOnly:false,ciphertextAndManifestReadbackMatching:true,
  uploadUsedWriteOncePrecondition:true,separateWriterReaderProfilesUsed:true,
  decryptionAndRestoreFromR2Completed:false,g15Accepted:false};
}
test('real first-party readback proves only a PROPOSED age, never G15 or provider IAM',()=>{
 const observed=check(receipt(),{sourceSha:sha,checkedAtUtc:clock,ownerConfirmsScope:true});
 assert.equal(observed.measuredCandidateAgeMinutes,5);
 assert.equal(observed.status,'CANDIDATE_AGE_WITHIN_RANGE');
 assert.equal(observed.alertRequired,false);
 assert.equal(observed.productionThresholdOwnerApproved,false);
 assert.equal(observed.realAlertDeliveryObserved,false);
 assert.equal(observed.independentlyAuthenticatedProviderIam,false);
 assert.equal(observed.g15Accepted,false);
 const stale=check(receipt(),{sourceSha:sha,checkedAtUtc:'2026-10-09T06:00:00.000Z',ownerConfirmsScope:true});
 assert.equal(stale.alertRequired,true);
 assert.equal(stale.status,'CANDIDATE_AGE_BREACHED');
});
test('mocked receipts, missing owner attestation, wrong source, forged readback or future clocks are refused',()=>{
 for(const mutation of [
  x=>{x.mockedCallsOnly=true;},
  x=>{x.realProviderUploadAndIndependentReadbackObserved=false;},
  x=>{x.ciphertextAndManifestReadbackMatching=false;},
  x=>{x.g15Accepted=true;},
  x=>{x.backupCreatedAtUtc='2026-10-09T05:30:00.000Z';},
  x=>{x.sourceSha='f'.repeat(40);},
  x=>{x.uploadUsedWriteOncePrecondition=false;},
  x=>{x.readbackCheckedAtUtc='bad';}
 ]){
  const raw=receipt();mutation(raw);
  assert.throws(()=>check(raw,{sourceSha:sha,checkedAtUtc:clock,ownerConfirmsScope:true}),/P15_FRESHNESS_REFUSED|P15_DRILL_REFUSED/);
 }
 assert.throws(()=>check(receipt(),{sourceSha:sha,checkedAtUtc:clock}),/P15_FRESHNESS_REFUSED/);
});
test('receipt is private mode-0600 in a mode-0700 real directory',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p15-watch-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'p15.r2-receipt.json');
 fs.writeFileSync(file,JSON.stringify(receipt()),{mode:0o600});
 assert.equal(readReceipt(file).format,'mega-v5-p15-r2-upload-readback/v1');
 const report=run(['--receipt',file,'--sha',sha,'--now',clock],
  {P15_OWNER_CONFIRMS_R2_RECEIPT_SCOPE:'1'});
 assert.equal(report.alertRequired,false);
 assert.throws(()=>run(['--receipt',file,'--sha',sha,'--now',clock],{}),/P15_FRESHNESS_REFUSED/);
 fs.chmodSync(file,0o644);
 assert.throws(()=>readReceipt(file),/P15_FRESHNESS_REFUSED/);
});
