'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {sealStream}=require('../scripts/v5/p15/sealed-archive.js');
const {validate,readManifest,inspectPair}=require('../scripts/v5/p15/archive-manifest.js');
const SHA='d'.repeat(40);
const KEYS=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const PUBLIC=KEYS.publicKey.export({format:'pem',type:'spki'});
const ID='v5-p15-2026-10-09T04-00-00-000Z-1234567890abcdef';
function sample(){
 return {
  format:'mega-v5-p15-backup-manifest/v1',backupId:ID,
  createdAtUtc:'2026-10-09T04:00:00.000Z',sourceId:'p15-owned-source01',
  sourceKind:'disposable-source',sourceEnvironment:'test',
  sourceFingerprint:'a'.repeat(64),sourceSha:SHA,migrationManifestSha256:'b'.repeat(64),
  pgMajor:16,ciphertextFile:ID+'.mxb',ciphertextBytes:1234,
  ciphertextSha256:'c'.repeat(64),
  cryptoFormat:'mega-v5-p15-sealed-archive/v1',
  recipientSpkiSha256:'e'.repeat(64),plaintextTemporaryFileCreated:false,
  includesClusterGlobalRolesOrSecrets:false,remoteStorageVerified:false,
  independentRestoreVerified:false,backupRunClass:'REAL_DIRECT_PG16_DUMP',g15Accepted:false
 };
}
test('public manifest has no secret content and never confuses local checksum with full G15',()=>{
 const m=validate(sample());
 assert.equal(m.g15Accepted,false);
 assert.equal(m.remoteStorageVerified,false);
 assert.equal(m.independentRestoreVerified,false);
});
test('rejects path injection, old manifest, false acceptance or altered provider assertions',()=>{
 const mutations=[
  m=>{m.ciphertextFile='../stolen.mxb';},
  m=>{m.ciphertextFile='v4-backups/backup.mxb';},
  m=>{m.remoteStorageVerified=true;},
  m=>{m.independentRestoreVerified=true;},
  m=>{m.g15Accepted=true;},
  m=>{m.ciphertextBytes=-1;},
  m=>{m.sourceSha='untracked';},
  m=>{m.extra='buyer_secret';}
 ];
 for(const mutation of mutations){
  const m=sample();mutation(m);
  assert.throws(()=>validate(m),/P15_MANIFEST_REFUSED/);
 }
});
test('a real sealed test artifact is hash-/context-bound before key authentication',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-manifest-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 const file=path.join(dir,ID+'.mxb');
 const partial=file+'.partial';
 const sealed=await sealStream(Readable.from([Buffer.from('PGDMP REAL PRIVATE RECORD')]),
  PUBLIC,partial,{sourceSha:SHA,createdAtUtc:'2026-10-09T04:00:00.000Z',
   sourceFingerprint:'a'.repeat(64),schemaManifestSha256:'b'.repeat(64)});
 fs.renameSync(partial,file);
 const meta={...sample(),ciphertextBytes:sealed.bytes,ciphertextSha256:sealed.sha256,
  recipientSpkiSha256:sealed.recipientSpkiSha256};
 const pathMeta=path.join(dir,ID+'.manifest.json');
 fs.writeFileSync(pathMeta,JSON.stringify(meta),{mode:0o600});
 const inspected=await inspectPair(pathMeta,file,SHA);
 assert.equal(inspected.ciphertextVerified,true);
 assert.equal(inspected.authenticationTagVerified,false,'SHA256 is not a GCM tag check');
 assert.equal(inspected.g15Accepted,false);
 fs.appendFileSync(file,'bad');
 await assert.rejects(()=>inspectPair(pathMeta,file,SHA),/P15_MANIFEST_REFUSED/);
});
