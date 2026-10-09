'use strict';

/**
 * Validate encrypted P15 archive + manifest as an EXACT pair before
 * decryption or isolated PostgreSQL target work. A SHA256 alone authenticates
 * neither publisher nor G15; actual AES-GCM tag verification is separate.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {openArchive,digestFile}=require('./sealed-archive.js');
const SHA40=/^[a-f0-9]{40}$/,SHA64=/^[a-f0-9]{64}$/;
const NAME=/^v5-p15-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{16}$/;
function refuse(reason){throw Error('P15_MANIFEST_REFUSED: '+reason);}
function validate(manifest){
 const expected=[
  'format','backupId','createdAtUtc','sourceId','sourceKind',
  'sourceEnvironment','sourceFingerprint','sourceSha',
  'migrationManifestSha256','pgMajor','ciphertextFile','ciphertextBytes',
  'ciphertextSha256','cryptoFormat','recipientSpkiSha256',
  'plaintextTemporaryFileCreated','includesClusterGlobalRolesOrSecrets',
  'remoteStorageVerified','independentRestoreVerified','backupRunClass','g15Accepted'
 ];
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||
    Object.keys(manifest).sort().join('\0')!==expected.sort().join('\0')||
    manifest.format!=='mega-v5-p15-backup-manifest/v1'||
    typeof manifest.backupId!=='string'||!NAME.test(manifest.backupId)||
    manifest.ciphertextFile!==manifest.backupId+'.mxb'||
    typeof manifest.sourceId!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{6,95}$/.test(manifest.sourceId)||
    !['disposable-source','nonserving-staging-source'].includes(manifest.sourceKind)||
    !['test','staging'].includes(manifest.sourceEnvironment)||
    !SHA64.test(manifest.sourceFingerprint)||!SHA40.test(manifest.sourceSha)||
    !SHA64.test(manifest.migrationManifestSha256)||
    !SHA64.test(manifest.recipientSpkiSha256)||
    !SHA64.test(manifest.ciphertextSha256)||
    !Number.isSafeInteger(manifest.ciphertextBytes)||manifest.ciphertextBytes<300||
    manifest.pgMajor!==16 ||
    manifest.cryptoFormat!=='mega-v5-p15-sealed-archive/v1'||
    !['REAL_DIRECT_PG16_DUMP','UNIT_STUB_NOT_DB_PROOF'].includes(manifest.backupRunClass)||
    manifest.plaintextTemporaryFileCreated!==false||
    manifest.includesClusterGlobalRolesOrSecrets!==false||
    manifest.remoteStorageVerified!==false||
    manifest.independentRestoreVerified!==false||manifest.g15Accepted!==false||
    typeof manifest.createdAtUtc!=='string'||
    !Number.isFinite(Date.parse(manifest.createdAtUtc))) {
  refuse('invalid, incomplete or falsely approved sealed manifest');
 }
 return manifest;
}
function readManifest(filename){
 if(typeof filename!=='string'||!path.isAbsolute(filename))refuse('absolute manifest filename required');
 const stat=fs.lstatSync(filename);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size<100||stat.size>10000||
    (stat.mode&0o077)!==0)refuse('manifest must be private bounded regular file');
 let data;try{data=JSON.parse(fs.readFileSync(filename,'utf8'));}catch{refuse('manifest JSON invalid');}
 validate(data);
 if(path.basename(filename)!==data.backupId+'.manifest.json')refuse('manifest filename/ID mismatch');
 return data;
}
async function inspectPair(manifestPath,archivePath,expectedSourceSha){
 const manifest=readManifest(manifestPath);
 if(!SHA40.test(expectedSourceSha)||manifest.sourceSha!==expectedSourceSha){
  refuse('exact checked-out code revision required');
 }
 if(typeof archivePath!=='string'||!path.isAbsolute(archivePath)||
    path.dirname(archivePath)!==path.dirname(manifestPath)||
    path.basename(archivePath)!==manifest.ciphertextFile)refuse('archive not bound to private manifest');
 const stat=fs.lstatSync(archivePath);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
    stat.size!==manifest.ciphertextBytes)refuse('archive bytes/permissions mismatch');
 const sha=await digestFile(archivePath);
 if(sha!==manifest.ciphertextSha256)refuse('encrypted bytes do not match immutable manifest');
 const opened=openArchive(archivePath);
 try{
  const h=opened.header;
  if(h.sourceSha!==manifest.sourceSha ||
     h.sourceFingerprint!==manifest.sourceFingerprint ||
     h.schemaManifestSha256!==manifest.migrationManifestSha256 ||
     h.createdAtUtc!==manifest.createdAtUtc ||
     h.recipientSpkiSha256!==manifest.recipientSpkiSha256) {
    refuse('authenticated envelope/manifest source identity mismatch');
  }
 }finally{fs.closeSync(opened.fd);}
 return {manifest,archivePath,ciphertextVerified:true,
  authenticationTagVerified:false,sourceSha:manifest.sourceSha,g15Accepted:false};
}
module.exports={NAME,validate,readManifest,inspectPair};
