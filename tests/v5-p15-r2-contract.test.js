'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PREFIX,assertTarget,objectKeys,plan}=require('../scripts/v5/p15/r2-contract.js');
const m={
 format:'mega-v5-p15-backup-manifest/v1',
 backupId:'v5-p15-2026-10-09T04-00-00-000Z-1234567890abcdef',
 createdAtUtc:'2026-10-09T04:00:00.000Z',sourceId:'p15-stage-pgsource',
 sourceKind:'nonserving-staging-source',sourceEnvironment:'staging',
 sourceFingerprint:'a'.repeat(64),sourceSha:'b'.repeat(40),
 migrationManifestSha256:'c'.repeat(64),pgMajor:16,
 ciphertextFile:'v5-p15-2026-10-09T04-00-00-000Z-1234567890abcdef.mxb',
 ciphertextBytes:123456,ciphertextSha256:'d'.repeat(64),
 cryptoFormat:'mega-v5-p15-sealed-archive/v1',
 recipientSpkiSha256:'e'.repeat(64),
 plaintextTemporaryFileCreated:false,includesClusterGlobalRolesOrSecrets:false,
 remoteStorageVerified:false,independentRestoreVerified:false,
 backupRunClass:'REAL_DIRECT_PG16_DUMP',g15Accepted:false
};
const target=()=>({
 format:'mega-v5-p15-r2-isolated-target/v1',
 accountId:'f'.repeat(32),endpoint:'https://'+'f'.repeat(32)+'.r2.cloudflarestorage.com',
 bucket:'mega-xo-v5-dr-disposable-fixture',prefix:PREFIX,
 scope:'V5_ENCRYPTED_ARCHIVES_ONLY',allowDeletion:false,
 independentReaderRequired:true
});
test('R2-only destination and deterministic encrypted object keys leave V4 Restic untouched',()=>{
 const t=assertTarget(target());
 const p=plan(t,m);
 assert.equal(p.remoteRequestsExecuted,false);
 assert.equal(p.g15Accepted,false);
 assert.equal(p.retentionDeletionApproved,false);
 assert.ok(p.ciphertextKey.startsWith(PREFIX));
 assert.equal(p.expectedCiphertextSha256,m.ciphertextSha256);
 assert.ok(!p.ciphertextKey.includes('v4/'));
});
test('rejects old Restic prefix, wildcard endpoint, insecure host, deletion and replaced objects',()=>{
 const mutations=[
  t=>{t.prefix='v4/restic/';},
  t=>{t.prefix='megaxo/v5/pg16-encrypted/v1/../v4/';},
  t=>{t.bucket='megaxo-v4-backup';},
  t=>{t.endpoint='http://'+t.accountId+'.r2.cloudflarestorage.com';},
  t=>{t.endpoint='https://another-account.r2.cloudflarestorage.com';},
  t=>{t.allowDeletion=true;},
  t=>{t.independentReaderRequired=false;},
  t=>{t.privateKey='no';}
 ];
 for(const mutate of mutations){
  const x=target();mutate(x);
  assert.throws(()=>assertTarget(x),/P15_R2_REFUSED/);
 }
 assert.throws(()=>objectKeys(target(),{...m,backupRunClass:'UNIT_STUB_NOT_DB_PROOF'}),/P15_R2_REFUSED/);
});
