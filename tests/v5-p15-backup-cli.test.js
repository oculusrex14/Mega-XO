'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {EventEmitter}=require('node:events');
const {backup,requireSource}=require('../scripts/v5/p15/backup-cli.js');
const {authenticateArchive}=require('../scripts/v5/p15/sealed-archive.js');
const SHA='b'.repeat(40);
const recipient=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const pub=recipient.publicKey.export({type:'spki',format:'pem'});
const pri=recipient.privateKey.export({type:'pkcs8',format:'pem'});
const source=()=>({format:'mega-v5-p15-direct-pg-target/v1',
  kind:'disposable-source',environment:'test',sourceSha:SHA,
  sourceId:'p15-source-owned-test',projectId:'disposable-source-pg16',
  host:'127.0.0.1',port:5432,database:'v5_test_p15_source_fixture01',
  user:'postgres',sslMode:'disable',pgMajor:16});
const env=()=>({V5_P15_DISPOSABLE:'1',V5_PG_DISPOSABLE:'1',
  P15_SOURCE_SHA:SHA,PATH:'/usr/bin:/bin'});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-backup-'));
 t.after(()=>fs.rmSync(dir,{force:true,recursive:true}));
 return dir;
}
function syntheticProcess(){
 const child=new EventEmitter();
 child.stdout=Readable.from([Buffer.from('PGDMP synthetic actor=private crown=99')]);
 child.kill=()=>{};
 process.nextTick(()=>child.emit('close',0));
 return child;
}
test('P15 stream backup creates no plaintext file, a 0600 encrypted archive and sanitized manifest',async t=>{
 const dir=fixture(t);
 const result=await backup({source:source(),recipientPublicPem:pub,outputDirectory:dir,
  env:env(),now:new Date('2026-10-09T04:00:00.000Z'),
  versionCheck:()=>16,spawnCommand:()=>syntheticProcess()});
 assert.match(result.manifest.ciphertextSha256,/^[0-9a-f]{64}$/);
 assert.equal(result.manifest.backupRunClass,'UNIT_STUB_NOT_DB_PROOF');
 assert.equal(result.manifest.remoteStorageVerified,false);
 assert.equal(result.manifest.independentRestoreVerified,false);
 assert.equal(result.manifest.g15Accepted,false);
 assert.equal(result.manifest.plaintextTemporaryFileCreated,false);
 assert.equal((fs.statSync(result.sealedFile).mode&0o077),0);
 assert.equal((fs.statSync(result.manifestFile).mode&0o077),0);
 assert.deepEqual(fs.readdirSync(dir).sort(),
  [path.basename(result.sealedFile),path.basename(result.manifestFile)].sort());
 const opened=await authenticateArchive(result.sealedFile,pri);
 assert.equal(opened.header.sourceSha,SHA);
 const meta=fs.readFileSync(result.manifestFile,'utf8');
 assert.doesNotMatch(meta,/actor=private|crown=99|PGPASSWORD/);
});
test('a missing source ID, env mismatch or poisoned DB URL fails before spawning a dump',async t=>{
 const dir=fixture(t);
 assert.throws(()=>requireSource(source(),{...env(),P15_SOURCE_SHA:'c'.repeat(40)}),/P15_BACKUP_REFUSED/);
 await assert.rejects(()=>backup({source:source(),recipientPublicPem:pub,
  outputDirectory:dir,env:{...env(),DATABASE_URL:'postgres://production'},
  spawnCommand:()=>{throw Error('should never start');},versionCheck:()=>16}),/P15_TARGET_REFUSED/);
 await assert.rejects(()=>backup({source:source(),recipientPublicPem:pub,
  outputDirectory:dir,env:env(),
  spawnCommand:()=>{throw Error('should never start');},versionCheck:()=>17}),/P15_BACKUP_REFUSED/);
});
test('a failed source process cannot produce a falsely successful sealed restore image',async t=>{
 const dir=fixture(t);
 const faulty=()=>{
  const child=new EventEmitter();
  child.stdout=Readable.from([Buffer.from('PGDMP incomplete')]);
  child.kill=()=>{};
  process.nextTick(()=>child.emit('close',1));
  return child;
 };
 await assert.rejects(()=>backup({source:source(),recipientPublicPem:pub,
  outputDirectory:dir,env:env(),versionCheck:()=>16,spawnCommand:faulty}),
  /P15_BACKUP_REFUSED/);
 assert.deepEqual(fs.readdirSync(dir),[],'no manifest or partial encrypted backup survives failure');
});
