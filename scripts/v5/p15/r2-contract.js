'use strict';

/**
 * V5-15-02 R2 isolation and immutable-object naming contract.
 * Does NOT initialize, overwrite, delete, prune or contact Cloudflare.
 * V4 Restic repository and prefixes are never accepted as targets.
 */
const {validate}=require('./archive-manifest.js');
const ACCOUNT=/^[a-f0-9]{32}$/;
const BUCKET=/^mega-xo-v5-dr-[a-z0-9][a-z0-9-]{3,42}$/;
const PREFIX='megaxo/v5/pg16-encrypted/v1/';
function refuse(reason){throw Error('P15_R2_REFUSED: '+reason);}
function assertTarget(t){
 if(!t||typeof t!=='object'||Array.isArray(t)||
   Object.keys(t).sort().join('\0')!==[
    'format','accountId','endpoint','bucket','prefix','scope','allowDeletion',
    'independentReaderRequired'
   ].sort().join('\0')||
   t.format!=='mega-v5-p15-r2-isolated-target/v1'||
   typeof t.accountId!=='string'||!ACCOUNT.test(t.accountId)||
   t.endpoint!=='https://'+t.accountId+'.r2.cloudflarestorage.com'||
   !BUCKET.test(t.bucket)||t.prefix!==PREFIX||
   t.scope!=='V5_ENCRYPTED_ARCHIVES_ONLY'||
   t.allowDeletion!==false||t.independentReaderRequired!==true){
  refuse('target is not a separate exact V5-only R2 bucket/prefix');
 }
 return Object.freeze({...t});
}
function objectKeys(target,manifest){
 const r=assertTarget(target),m=validate(manifest);
 if(m.backupRunClass!=='REAL_DIRECT_PG16_DUMP'){
  refuse('unit mock cannot be published as a real database backup');
 }
 return {
  ciphertextKey:r.prefix+m.ciphertextFile,
  manifestKey:r.prefix+m.backupId+'.manifest.json'
 };
}
function plan(target,manifest){
 const keys=objectKeys(target,manifest);
 return {
  format:'mega-v5-p15-r2-transfer-plan/v1',
  backupId:manifest.backupId,
  sourceSha:manifest.sourceSha,
  bucket:target.bucket,
  accountId:target.accountId,
  ...keys,
  expectedCiphertextBytes:manifest.ciphertextBytes,
  expectedCiphertextSha256:manifest.ciphertextSha256,
  remoteRequestsExecuted:false,uploadAuthorized:false,
  independentReadbackVerified:false,decryptionVerified:false,
  useOnlyWriteOnceIfNoneMatch:true,
  dataPolicy:'ENCRYPTED_ONLY_NO_V4_REPOSITORY_MUTATION',
  retentionDeletionApproved:false,
  g15Accepted:false
 };
}
module.exports={PREFIX,assertTarget,objectKeys,plan};
