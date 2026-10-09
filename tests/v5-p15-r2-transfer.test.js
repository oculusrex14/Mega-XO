'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {sealStream}=require('../scripts/v5/p15/sealed-archive.js');
const {transfer,protectedAwsEnv,WRITER,READER}=require('../scripts/v5/p15/r2-transfer.js');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const pub=keys.publicKey.export({type:'spki',format:'pem'});
const sha='a'.repeat(40);
const R2={
 format:'mega-v5-p15-r2-isolated-target/v1',
 accountId:'b'.repeat(32),endpoint:'https://'+'b'.repeat(32)+'.r2.cloudflarestorage.com',
 bucket:'mega-xo-v5-dr-fixture-only',
 prefix:'megaxo/v5/pg16-encrypted/v1/',scope:'V5_ENCRYPTED_ARCHIVES_ONLY',
 allowDeletion:false,independentReaderRequired:true
};
const id='v5-p15-2026-10-09T04-00-00-000Z-1234567890abcdef';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'p15-r2-fake-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const archive=path.join(dir,id+'.mxb');
 const sealed=await sealStream(Readable.from([Buffer.from('PGDMP SYNTHETIC ENCRYPTED')]),
   pub,archive+'.partial',
   {sourceSha:sha,createdAtUtc:'2026-10-09T04:00:00.000Z',
    sourceFingerprint:'c'.repeat(64),schemaManifestSha256:'d'.repeat(64)});
 fs.renameSync(archive+'.partial',archive);
 const manifest={
  format:'mega-v5-p15-backup-manifest/v1',backupId:id,
  createdAtUtc:'2026-10-09T04:00:00.000Z',sourceId:'p15-staging-synthetic',
  sourceKind:'nonserving-staging-source',sourceEnvironment:'staging',
  sourceFingerprint:'c'.repeat(64),sourceSha:sha,
  migrationManifestSha256:'d'.repeat(64),pgMajor:16,
  ciphertextFile:id+'.mxb',ciphertextBytes:sealed.bytes,
  ciphertextSha256:sealed.sha256,
  cryptoFormat:sealed.archiveFormat,
  recipientSpkiSha256:sealed.recipientSpkiSha256,
  plaintextTemporaryFileCreated:false,
  includesClusterGlobalRolesOrSecrets:false,
  remoteStorageVerified:false,independentRestoreVerified:false,
  backupRunClass:'REAL_DIRECT_PG16_DUMP',g15Accepted:false
 };
 const file=path.join(dir,id+'.manifest.json');
 fs.writeFileSync(file,JSON.stringify(manifest),{mode:0o600});
 const auth=path.join(dir,'aws-credentials');
 fs.writeFileSync(auth,'synthetic nonsecret fake runner credentials',{mode:0o600});
 const env={P15_OWNER_APPROVE_R2_TRANSFER:'1',
  P15_OWNER_CONFIRMS_V5_ONLY_BUCKET:'1',P15_SOURCE_SHA:sha,
  P15_AWS_SHARED_CREDENTIALS_FILE:auth,PATH:'/usr/bin:/bin',HOME:dir};
 return {dir,archive,manifestPath:file,env};
}
function fakeS3(){
 const remote=new Map(),records=[];
 function runner(bin,args,options){
  assert.equal(bin,'aws');
  if(args[0]==='--version')return {status:0,stdout:'aws-cli/2.18.0 Python/3.12'};
  const command=args[1],arg=name=>args[args.indexOf(name)+1];
  const key=arg('--key');
  records.push({command,key,profile:options.env.AWS_PROFILE,args:[...args]});
  if(command==='put-object'){
   assert.ok(args.includes('--if-none-match')&&args.includes('*'));
   assert.equal(options.env.AWS_PROFILE,WRITER);
   assert.equal(remote.has(key),false);
   remote.set(key,{bytes:fs.readFileSync(arg('--body')),meta:arg('--metadata').split('=')[1]});
   return {status:0,stdout:'{}'};
  }
  const obj=remote.get(key);assert.ok(obj);
  assert.equal(options.env.AWS_PROFILE,READER);
  if(command==='head-object')return {status:0,
    stdout:JSON.stringify({ContentLength:obj.bytes.length,Metadata:{sha256:obj.meta}})};
  if(command==='get-object'){
   fs.writeFileSync(args.at(-3),obj.bytes,{mode:0o600});
   return {status:0,stdout:'{}'};
  }
  throw Error('unexpected mock operation '+command);
 }
 return {runner,records};
}
test('P15 R2 uploads sealed bytes conditionally and verifies independent-read-profile retrieval',async t=>{
 const f=await fixture(t),mock=fakeS3();
 const result=await transfer({r2:R2,manifestPath:f.manifestPath,
  archivePath:f.archive,env:f.env,runner:mock.runner});
 assert.equal(result.mockedCallsOnly,true);
 assert.equal(result.realProviderUploadAndIndependentReadbackObserved,false);
 assert.equal(result.ciphertextAndManifestReadbackMatching,true);
 assert.equal(result.backupCreatedAtUtc,'2026-10-09T04:00:00.000Z');
 assert.match(result.readbackCheckedAtUtc,/^\d{4}-\d\d-\d\dT/);
 assert.equal(result.g15Accepted,false);
 assert.equal(result.separateWriterReaderProfilesUsed,true);
 assert.equal(mock.records.filter(r=>r.command==='put-object').length,2);
 assert.equal(mock.records.filter(r=>r.command==='get-object').length,2);
 assert.equal(fs.readdirSync(f.dir).filter(x=>x.endsWith('.partial')).length,0);
 assert.ok(mock.records.every(r=>r.key.startsWith(R2.prefix)));
});
test('writer and reader credentials are scoped, and missing approvals never contact R2',async t=>{
 const f=await fixture(t);
 const e=protectedAwsEnv(f.env,WRITER);
 assert.equal(e.AWS_PROFILE,WRITER);
 assert.equal(e.AWS_ACCESS_KEY_ID,undefined);
 for(const mutation of [
  env=>{env.P15_OWNER_APPROVE_R2_TRANSFER='0';},
  env=>{env.AWS_ACCESS_KEY_ID='secret';},
  env=>{env.P15_SOURCE_SHA='HEAD';},
  env=>{env.AWS_SHARED_CREDENTIALS_FILE=f.env.P15_AWS_SHARED_CREDENTIALS_FILE;
   env.P15_AWS_SHARED_CREDENTIALS_FILE=undefined;}
 ]){
  const copy={...f.env};mutation(copy);
  assert.throws(()=>protectedAwsEnv(copy,READER),/P15_R2_TRANSFER_REFUSED|P15_TARGET_REFUSED/);
 }
});
