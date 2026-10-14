'use strict';

/**
 * P15 production-chain coverage: a REAL non-serving production-source archive
 * must travel validate -> operator R2 upload (write-once) -> independent reader
 * retrieval -> authenticated AES-GCM decrypt -> quarantined restore gate on a
 * `nonproduction-restore` (loopback disposable PG16) target.
 *
 * No provider, network, backup, restore or upload is exercised here: the R2
 * runner is an explicitly labelled fake and every assertion about production
 * data remaining unreachable by the PR verifier is a refusal assertion.
 */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable,Writable}=require('node:stream');
const {sealStream,digestFile,authenticateArchive,decryptToWritable}=
 require('../scripts/v5/p15/sealed-archive.js');
const {validate,readManifest,SOURCE_KIND_ENVIRONMENT}=
 require('../scripts/v5/p15/archive-manifest.js');
const {transfer,WRITER,READER}=require('../scripts/v5/p15/r2-transfer.js');
const {RESTORE_TARGETS,requireRestore,restoreArgs}=require('../scripts/v5/p15/restore-cli.js');
const {comparison,REQUIRED}=require('../scripts/v5/p15/data-integrity.js');
const repoManifest=require('../packages/migrations/manifest.json');

const SHA='a'.repeat(40);
const PRODUCTION_ID='v5-p15-2026-10-14T01-27-22-897Z-095e8b1a48571638';
const PLAINTEXT='PGDMP synthetic production-chain payload for a quarantined restore';
const CREATED='2026-10-14T01:27:22.897Z';
const FINGERPRINT='c'.repeat(64);
const SCHEMA_SHA='d'.repeat(64);
const KEYS=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
const PUBLIC=KEYS.publicKey.export({format:'pem',type:'spki'});
const PRIVATE=KEYS.privateKey.export({format:'pem',type:'pkcs8'});
const OTHER_PRIVATE=crypto.generateKeyPairSync('rsa',{modulusLength:3072})
 .privateKey.export({format:'pem',type:'pkcs8'});
const R2_TARGET={
 format:'mega-v5-p15-r2-isolated-target/v1',
 accountId:'b'.repeat(32),
 endpoint:'https://'+'b'.repeat(32)+'.r2.cloudflarestorage.com',
 bucket:'mega-xo-v5-dr-production-chain',
 prefix:'megaxo/v5/pg16-encrypted/v1/',
 scope:'V5_ENCRYPTED_ARCHIVES_ONLY',allowDeletion:false,
 independentReaderRequired:true
};

function productionManifest(overrides={}){
 return {
  format:'mega-v5-p15-backup-manifest/v1',backupId:PRODUCTION_ID,
  createdAtUtc:CREATED,sourceId:'p15-production-pgsource',
  sourceKind:'nonserving-production-source',sourceEnvironment:'production',
  sourceFingerprint:FINGERPRINT,sourceSha:SHA,
  migrationManifestSha256:SCHEMA_SHA,pgMajor:16,
  ciphertextFile:PRODUCTION_ID+'.mxb',ciphertextBytes:1234,
  ciphertextSha256:'e'.repeat(64),
  cryptoFormat:'mega-v5-p15-sealed-archive/v1',
  recipientSpkiSha256:'f'.repeat(64),plaintextTemporaryFileCreated:false,
  includesClusterGlobalRolesOrSecrets:false,remoteStorageVerified:false,
  independentRestoreVerified:false,backupRunClass:'REAL_DIRECT_PG16_DUMP',
  g15Accepted:false,...overrides
 };
}
function stagingManifest(overrides={}){
 return productionManifest({sourceKind:'nonserving-staging-source',
  sourceEnvironment:'staging',...overrides});
}
function disposableManifest(overrides={}){
 return productionManifest({sourceKind:'disposable-source',
  sourceEnvironment:'test',...overrides});
}

test('a non-serving production capture validates only as its declared production pair',()=>{
 assert.deepEqual(SOURCE_KIND_ENVIRONMENT,{
  'disposable-source':'test','nonserving-staging-source':'staging',
  'nonserving-production-source':'production'
 });
 const m=validate(productionManifest());
 assert.equal(m.sourceKind,'nonserving-production-source');
 assert.equal(m.sourceEnvironment,'production');
 for(const [kind,environment] of [
  ['nonserving-production-source','test'],
  ['nonserving-production-source','staging'],
  ['disposable-source','production'],
  ['nonserving-staging-source','production'],
  ['production-source','production'],
  ['nonserving-production-target','production'],
  ['','production'],
  [undefined,'production']
 ]){
  assert.throws(()=>validate(productionManifest({sourceKind:kind,
   sourceEnvironment:environment})),/P15_MANIFEST_REFUSED/,
  'mismatched or unlisted kind/environment pair must be refused: '+kind+'/'+environment);
 }
 // Pre-existing kinds keep their exact behaviour.
 assert.equal(validate(stagingManifest()).sourceKind,'nonserving-staging-source');
 assert.equal(validate(disposableManifest()).sourceKind,'disposable-source');
 assert.throws(()=>validate(stagingManifest({sourceEnvironment:'production'})),
  /P15_MANIFEST_REFUSED/);
 assert.throws(()=>validate(productionManifest({backupRunClass:'UNIT_STUB_PROOF'})),
  /P15_MANIFEST_REFUSED/);
 assert.throws(()=>validate(productionManifest({remoteStorageVerified:true})),
  /P15_MANIFEST_REFUSED/);
 assert.throws(()=>validate(productionManifest({ciphertextBytes:299})),
  /P15_MANIFEST_REFUSED/);
});

test('readManifest accepts the production manifest from an immutably named private file',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-prodchain-manifest-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,PRODUCTION_ID+'.manifest.json');
 fs.writeFileSync(file,JSON.stringify(productionManifest()),{mode:0o600});
 assert.equal(readManifest(file).sourceKind,'nonserving-production-source');
 fs.chmodSync(file,0o644);
 assert.throws(()=>readManifest(file),/P15_MANIFEST_REFUSED/);
 fs.chmodSync(file,0o600);
 const misnamed=path.join(dir,'v5-p15-2026-10-14T01-27-22-897Z-ffffffffffffffff.manifest.json');
 fs.writeFileSync(misnamed,JSON.stringify(productionManifest()),{mode:0o600});
 assert.throws(()=>readManifest(misnamed),/P15_MANIFEST_REFUSED/);
});

async function chainFixture(t,{manifest=productionManifest()}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-prodchain-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const archive=path.join(dir,PRODUCTION_ID+'.mxb');
 const sealed=await sealStream(Readable.from([Buffer.from(PLAINTEXT)]),PUBLIC,
  archive+'.partial',{sourceSha:SHA,createdAtUtc:CREATED,
   sourceFingerprint:FINGERPRINT,schemaManifestSha256:SCHEMA_SHA});
 fs.renameSync(archive+'.partial',archive);
 const meta={...manifest,ciphertextBytes:sealed.bytes,ciphertextSha256:sealed.sha256,
  recipientSpkiSha256:sealed.recipientSpkiSha256};
 const manifestPath=path.join(dir,PRODUCTION_ID+'.manifest.json');
 fs.writeFileSync(manifestPath,JSON.stringify(meta),{mode:0o600});
 const credentials=path.join(dir,'aws-credentials');
 fs.writeFileSync(credentials,'synthetic nonsecret fake runner credentials',{mode:0o600});
 const env={P15_OWNER_APPROVE_R2_TRANSFER:'1',
  P15_OWNER_CONFIRMS_V5_ONLY_BUCKET:'1',P15_SOURCE_SHA:SHA,
  P15_AWS_SHARED_CREDENTIALS_FILE:credentials,PATH:'/usr/bin:/bin',HOME:dir};
 return {dir,archive,manifest:meta,manifestPath,env,archiveBytes:fs.readFileSync(archive)};
}

function fakeS3(){
 const remote=new Map(),readback=new Map(),records=[];
 function runner(bin,args,options){
  assert.equal(bin,'aws');
  if(args[0]==='--version')return {status:0,stdout:'aws-cli/2.18.0 Python/3.12'};
  const command=args[1],arg=name=>args[args.indexOf(name)+1],key=arg('--key');
  records.push({command,key,profile:options.env.AWS_PROFILE,args:[...args]});
  if(command==='put-object'){
   assert.ok(args.includes('--if-none-match')&&args.includes('*'),
    'an upload without If-None-Match:* is never allowed');
   assert.equal(options.env.AWS_PROFILE,WRITER,
    'ciphertext/manifest must never be written with the reader profile');
   if(remote.has(key)){
    return {status:412,stdout:'',
     stderr:'PreconditionFailed: At least one of the pre-conditions you specified did not hold'};
   }
   remote.set(key,{bytes:fs.readFileSync(arg('--body')),meta:arg('--metadata').split('=')[1]});
   return {status:0,stdout:'{}'};
  }
  const obj=remote.get(key);
  if(!obj)return {status:404,stdout:'',stderr:'NoSuchKey'};
  assert.equal(options.env.AWS_PROFILE,READER,
   'readback must use the separate independent reader profile');
  if(command==='head-object')return {status:0,
   stdout:JSON.stringify({ContentLength:obj.bytes.length,Metadata:{sha256:obj.meta}})};
  if(command==='get-object'){
   readback.set(key,Buffer.from(obj.bytes));
   fs.writeFileSync(args.at(-3),obj.bytes,{mode:0o600});
   return {status:0,stdout:'{}'};
  }
  throw Error('unexpected mock operation '+command);
 }
 return {runner,records,remote,readback};
}

test('a production archive uploads write-once and is re-read by the independent reader',async t=>{
 const f=await chainFixture(t),mock=fakeS3();
 const result=await transfer({r2:R2_TARGET,manifestPath:f.manifestPath,
  archivePath:f.archive,env:f.env,runner:mock.runner});
 assert.equal(result.mockedCallsOnly,true);
 assert.equal(result.realProviderUploadAndIndependentReadbackObserved,false);
 assert.equal(result.ciphertextAndManifestReadbackMatching,true);
 assert.equal(result.separateWriterReaderProfilesUsed,true);
 assert.equal(result.uploadUsedWriteOncePrecondition,true);
 assert.equal(result.decryptionAndRestoreFromR2Completed,false);
 assert.equal(result.productionRetentionApproved,false);
 assert.equal(result.g15Accepted,false);
 assert.equal(result.backupId,PRODUCTION_ID);
 assert.equal(result.objectKey,R2_TARGET.prefix+PRODUCTION_ID+'.mxb');
 assert.equal(result.manifestObjectKey,R2_TARGET.prefix+PRODUCTION_ID+'.manifest.json');
 assert.equal(result.ciphertextBytes,f.archiveBytes.length);
 assert.equal(mock.records.filter(r=>r.command==='put-object').length,2);
 assert.equal(mock.records.filter(r=>r.command==='head-object').length,1);
 assert.equal(mock.records.filter(r=>r.command==='get-object').length,2);
 assert.equal(fs.readdirSync(f.dir).filter(x=>x.endsWith('.partial')).length,0,
  'no readback scratch file may survive the transfer');

 // Independent reader retrieval: byte-identical to the sealed archive and to
 // the immutable manifest digest, retrieved under the reader profile only.
 const retrieved=mock.readback.get(result.objectKey);
 assert.ok(retrieved&&retrieved.equals(f.archiveBytes));
 assert.equal(crypto.createHash('sha256').update(retrieved).digest('hex'),
  f.manifest.ciphertextSha256);

 // A repeat upload must be refused by If-None-Match:* and must not silently
 // replace the immutable object or read anything back.
 const before=mock.records.length;
 await assert.rejects(()=>transfer({r2:R2_TARGET,manifestPath:f.manifestPath,
  archivePath:f.archive,env:f.env,runner:mock.runner}),/P15_R2_TRANSFER_REFUSED/);
 const again=mock.records.slice(before);
 assert.ok(again.length>0);
 assert.ok(again.every(r=>r.command==='put-object'&&r.profile===WRITER));
 assert.ok(!again.some(r=>r.command==='get-object'||r.command==='head-object'));
 assert.ok(mock.remote.get(result.objectKey).bytes.equals(f.archiveBytes),
  'the stored ciphertext object must never be overwritten');
 assert.equal(fs.readdirSync(f.dir).filter(x=>x.endsWith('.partial')).length,0);
});

test('the independently retrieved production copy decrypts only with the recovery key',async t=>{
 const f=await chainFixture(t),mock=fakeS3();
 const result=await transfer({r2:R2_TARGET,manifestPath:f.manifestPath,
  archivePath:f.archive,env:f.env,runner:mock.runner});
 const retrieved=mock.readback.get(result.objectKey);
 assert.ok(retrieved);
 const copy=path.join(f.dir,'retrieved-copy.mxb');
 fs.writeFileSync(copy,retrieved,{mode:0o600});
 assert.equal(await digestFile(copy),f.manifest.ciphertextSha256);

 // Full AES-GCM tag verification before any plaintext reaches a restore sink.
 await authenticateArchive(copy,PRIVATE);
 await assert.rejects(()=>authenticateArchive(copy,OTHER_PRIVATE),/P15_SEAL_REFUSED/);

 const tampered=path.join(f.dir,'retrieved-tampered.mxb');
 const bytes=Buffer.from(retrieved);bytes[bytes.length-1]^=0x01;
 fs.writeFileSync(tampered,bytes,{mode:0o600});
 await assert.rejects(()=>authenticateArchive(tampered,PRIVATE),/P15_SEAL_REFUSED/);

 const chunks=[];
 const sink=new Writable({write(chunk,_enc,callback){
  chunks.push(Buffer.from(chunk));callback();}});
 await decryptToWritable(copy,PRIVATE,sink);
 assert.equal(Buffer.concat(chunks).toString('utf8'),PLAINTEXT);
});

function restoreEnv(){
 return {P15_SOURCE_SHA:SHA,V5_P15_DISPOSABLE:'1',V5_P15_QUARANTINE:'1',
  P15_RESTORE_JOBS_DISABLED:'1',P15_RESTORE_PROVIDER_CALLBACKS_DISABLED:'1'};
}
const nonproductionRestore=()=>({
 format:'mega-v5-p15-direct-pg-target/v1',kind:'nonproduction-restore',
 environment:'test',sourceSha:SHA,sourceId:'p15-prodchain-restore-target',
 projectId:'disposable-restore-pg16',host:'127.0.0.1',port:5432,
 database:'v5_p15_restore_prodchain01',user:'postgres',sslMode:'disable',pgMajor:16});
const disposableRestore=()=>({...nonproductionRestore(),kind:'disposable-restore',
 port:5433,sourceId:'p15-disposable-restore-target'});

test('a production archive restores only into the quarantined nonproduction-restore target',()=>{
 assert.deepEqual(RESTORE_TARGETS,{
  'disposable-source':['disposable-restore'],
  'nonserving-production-source':['nonproduction-restore']
 });
 const checked=requireRestore(nonproductionRestore(),productionManifest(),restoreEnv());
 assert.equal(checked.kind,'nonproduction-restore');
 assert.equal(checked.port,5432);
 const args=restoreArgs(checked.database);
 assert.ok(args.includes('--single-transaction')&&args.includes('--exit-on-error'));
 assert.ok(!args.includes('--clean')&&!args.includes('--create')&&
  !args.includes('--disable-triggers'));

 // A disposable archive keeps its exact previous target kind.
 assert.equal(requireRestore(disposableRestore(),disposableManifest(),restoreEnv()).kind,
  'disposable-restore');

 for(const [label,target,manifest] of [
  ['production archive at a disposable-restore target',disposableRestore(),productionManifest()],
  ['disposable archive at a nonproduction-restore target',nonproductionRestore(),
   disposableManifest()],
  ['staging archive at any quarantined target',nonproductionRestore(),stagingManifest()],
  ['unknown source kind',nonproductionRestore(),
   productionManifest({sourceKind:'nonserving-production-backup'})]
 ]){
  assert.throws(()=>requireRestore(target,manifest,restoreEnv()),
   /P15_RESTORE_REFUSED|P15_TARGET_REFUSED/,label+' must be refused');
 }
 // The production SOURCE kind can never be a restore target in the first place.
 assert.throws(()=>requireRestore({...nonproductionRestore(),
  kind:'nonserving-production-source'},productionManifest(),restoreEnv()),
 /P15_TARGET_REFUSED/);
 // Kind/environment pairing is still enforced on the manifest side.
 assert.throws(()=>requireRestore(nonproductionRestore(),
  productionManifest({sourceEnvironment:'test'}),restoreEnv()),/P15_RESTORE_REFUSED/);
 // Quarantine confirmations are unchanged.
 for(const mutate of [e=>{e.P15_RESTORE_JOBS_DISABLED='0';},
  e=>{e.P15_RESTORE_PROVIDER_CALLBACKS_DISABLED='0';}]){
  const env=restoreEnv();mutate(env);
  assert.throws(()=>requireRestore(nonproductionRestore(),productionManifest(),env),
   /P15_RESTORE_REFUSED/);
 }
});

test('restore-time snapshot comparison works for the production chain fingerprints',()=>{
 const fingerprint=digest=>({format:'mega-v5-p15-data-fingerprint/v1',pgMajor:16,
  canonicalDigest:digest,tableCount:REQUIRED.length,totalRows:100,
  counts:Object.fromEntries(REQUIRED.map(t=>[t,
   t==='meta.migrations'?repoManifest.migrations.length:2]))});
 const matched=comparison(fingerprint('a'.repeat(64)),fingerprint('a'.repeat(64)));
 assert.equal(matched.perActorAndPerTableHashEqual,true);
 assert.equal(matched.g15Accepted,false);
 assert.throws(()=>comparison(fingerprint('a'.repeat(64)),fingerprint('b'.repeat(64))),
  /P15_INTEGRITY_REFUSED/);
});
