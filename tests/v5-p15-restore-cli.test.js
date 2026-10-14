'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {requireRestore,restoreArgs,readPrivateKey,RESTORE_TARGETS}=require('../scripts/v5/p15/restore-cli.js');
const SOURCE='a'.repeat(40);
const env=()=>({
 P15_SOURCE_SHA:SOURCE,V5_P15_DISPOSABLE:'1',
 V5_P15_QUARANTINE:'1',P15_RESTORE_JOBS_DISABLED:'1',
 P15_RESTORE_PROVIDER_CALLBACKS_DISABLED:'1'
});
const target=()=>({
 format:'mega-v5-p15-direct-pg-target/v1',kind:'disposable-restore',
 environment:'test',sourceSha:SOURCE,sourceId:'p15-owned-restore-fixture',
 projectId:'disposable-restore-pg16',host:'127.0.0.1',
 port:5433,database:'v5_p15_restore_fixture01',
 user:'postgres',sslMode:'disable',pgMajor:16
});
const manifest=()=>({sourceSha:SOURCE,sourceKind:'disposable-source',
 sourceEnvironment:'test',backupRunClass:'REAL_DIRECT_PG16_DUMP'});
test('pg_restore writes only to a separate quarantined DB in one transaction, without clean/create',()=>{
 const t=requireRestore(target(),manifest(),env());
 assert.equal(t.port,5433);
 const args=restoreArgs(t.database);
 assert.ok(args.includes('--single-transaction'));
 assert.ok(args.includes('--exit-on-error'));
 assert.ok(args.includes('--no-owner'));
 assert.ok(args.includes('--no-acl'));
 assert.ok(args.includes('--dbname='+t.database));
 for(const disallowed of ['--clean','--create','--disable-triggers']) {
  assert.ok(!args.includes(disallowed));
 }
});
test('wrong source, successful-looking mock or active provider jobs cannot activate a restore',()=>{
 for(const attack of [
  (t,m,e)=>{t.port=5432;},
  (t,m,e)=>{t.projectId='disposable-source-pg16';},
  (t,m,e)=>{t.database='mega_xo_production';},
  (t,m,e)=>{m.sourceSha='b'.repeat(40);},
  (t,m,e)=>{m.backupRunClass='UNIT_STUB_NOT_DB_PROOF';},
  (t,m,e)=>{m.sourceEnvironment='production';},
  (t,m,e)=>{e.P15_RESTORE_JOBS_DISABLED='0';},
  (t,m,e)=>{e.P15_RESTORE_PROVIDER_CALLBACKS_DISABLED='0';},
  (t,m,e)=>{e.P15_SOURCE_SHA='b'.repeat(40);}
 ]){
  const t=target(),m=manifest(),e=env();attack(t,m,e);
  assert.throws(()=>requireRestore(t,m,e),/P15_RESTORE_REFUSED|P15_TARGET_REFUSED/);
 }
 for(const name of ['production','public','v5_test_p15_source_in_same_database','v5_p15_restore_../../']){
  assert.throws(()=>restoreArgs(name),/P15_RESTORE_REFUSED/);
 }
});
test('a production-source manifest restores only into the quarantined nonproduction-restore target',()=>{
 assert.deepEqual(RESTORE_TARGETS,{'disposable-source':['disposable-restore'],
  'nonserving-production-source':['nonproduction-restore']});
 const production={...manifest(),sourceKind:'nonserving-production-source',
  sourceEnvironment:'production'};
 const quarantine={...target(),kind:'nonproduction-restore',port:5432,
  sourceId:'p15-prodchain-quarantine-target'};
 const checked=requireRestore(quarantine,production,env());
 assert.equal(checked.kind,'nonproduction-restore');
 for(const [label,t,m] of [
  ['production manifest at a disposable-restore target',target(),production],
  ['disposable manifest at a nonproduction-restore target',quarantine,manifest()],
  ['staging manifest at a quarantined target',quarantine,
   {...manifest(),sourceKind:'nonserving-staging-source',sourceEnvironment:'staging'}],
  ['unlisted source kind',quarantine,
   {...manifest(),sourceKind:'nonserving-production-backup',sourceEnvironment:'production'}],
  ['production kind with a mismatched environment',quarantine,
   {...production,sourceEnvironment:'test'}]
 ]){
  assert.throws(()=>requireRestore(t,m,env()),/P15_RESTORE_REFUSED|P15_TARGET_REFUSED/,label);
 }
});
test('private recovery material must stay in 0600 file, never accept a symlink or public mode',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-keymode-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=path.join(dir,'identity.pem');
 fs.writeFileSync(f,'-----BEGIN PRIVATE KEY-----\n'+('x'.repeat(2000))+'\n-----END PRIVATE KEY-----\n',{mode:0o600});
 assert.ok(readPrivateKey(f).includes('PRIVATE KEY'));
 fs.chmodSync(f,0o644);
 assert.throws(()=>readPrivateKey(f),/P15_TARGET_REFUSED/);
 const alias=path.join(dir,'link.pem');
 fs.symlinkSync(f,alias);
 assert.throws(()=>readPrivateKey(alias),/P15_TARGET_REFUSED/);
});

// ---------------------------------------------------------------------------
// Production path: `schema from the immutable migration chain + data from the
// archive`. The trusted runner migrates the quarantined target; restore-cli
// VERIFIES that pre-state (head + `learning`) and then loads data only.
// ---------------------------------------------------------------------------
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {Readable,Writable}=require('node:stream');
const {sealStream}=require('../scripts/v5/p15/sealed-archive.js');
const {restore,prepareProductionTarget,CHAIN_BOOTSTRAP_TABLES}=
 require('../scripts/v5/p15/restore-cli.js');
const PACK=require('../packages/migrations/manifest.json').migrations;
const HEAD=PACK[PACK.length-1].id;
const SCHEMA_SHA=crypto.createHash('sha256').update(
 fs.readFileSync(path.join(__dirname,'../packages/migrations/manifest.json'))).digest('hex');

const labTarget=()=>({format:'mega-v5-p15-direct-pg-target/v1',
 kind:'nonproduction-restore',environment:'test',sourceSha:SOURCE,
 sourceId:'p15-production-lab-target',projectId:'disposable-restore-pg16',
 host:'127.0.0.1',port:5432,database:'v5_p15_restore_lab0001',user:'postgres',
 sslMode:'disable',pgMajor:16});
const productionManifest=()=>({...manifest(),
 sourceKind:'nonserving-production-source',sourceEnvironment:'production'});

// A chain-migrated quarantined lab target: exactly the pinned checksummed pack
// at the head, `learning` present from migration 0044, the chain's own four
// bootstrap rows present, and no other application rows. Nothing here is a real
// database; every statement is answered in-process.
function fakeLab({version='160000',head='full',learning=true,extraRows={}}={}){
 const statements=[];
 let migrations=PACK.map((m,i)=>i===PACK.length-1&&head==='short'?{...m,id:m.id-1}:m);
 if(head==='count')migrations=migrations.slice(0,-1);
 if(head==='drift')migrations=[{...PACK[0],sha256:'0'.repeat(64)},...PACK.slice(1)];
 if(head==='empty')migrations=[];
 const relations=[['identity','actors'],...CHAIN_BOOTSTRAP_TABLES.map(t=>t.split('.'))];
 const bootstrapCounts={'meta.migrations':PACK.length,'economy.system_burns':1,
  'season.league_week':1,'runtime.controls':1};
 const client={
  async query(sql,...rest){
   const params=rest[0]||[];
   statements.push([sql,...params]);
   if(sql==='ROLLBACK'||sql==='BEGIN'||sql==='COMMIT')return {rows:[],rowCount:0};
   if(sql.includes("current_setting('server_version_num')"))return {rows:[{version}]};
   // The DELETE must be recognised before the ledger SELECT, whose own text
   // (`FROM meta.migrations`) is a substring of the DELETE statement.
   const del=/^DELETE FROM (\S+)$/.exec(sql);
   if(del)return {rows:[],rowCount:bootstrapCounts[del[1]]??0};
   if(/^SELECT count\(\*\)::int AS n FROM /.test(sql)){
    const count=/^SELECT count\(\*\)::int AS n FROM "([^"]+)"\."([^"]+)"$/.exec(sql);
    if(count){
     const id=count[1]+'.'+count[2];
     return {rows:[{n:extraRows[id]??bootstrapCounts[id]??0}]};
    }
   }
   if(sql.includes('FROM meta.migrations'))return {rows:migrations.map(m=>({id:m.id,name:m.name,checksum:m.sha256}))};
   if(sql.includes("nspname='learning'"))return {rows:[{n:learning?1:0}]};
   if(sql.includes("relkind IN ('r','p','m')"))return {rows:relations.map(([schema,name])=>({schema,name}))};
   throw Error('unexpected lab statement: '+sql);
  },
  async end(){statements.push(['END']);}
 };
 return {connect:async()=>client,statements};
}

test('a production archive requires the quarantined target to already hold the sealed schema head',async()=>{
 const accepted=await prepareProductionTarget(labTarget(),{connect:fakeLab().connect});
 assert.equal(accepted.schemaHead,HEAD);
 assert.equal(accepted.learningSchemaPresent,true);
 assert.deepEqual(accepted.chainBootstrapRowsReplaced,
  {'meta.migrations':PACK.length,'economy.system_burns':1,'season.league_week':1,
   'runtime.controls':1});
 // Every bootstrap delete happens on exactly the four chain-owned tables; the
 // production archive carries the authoritative production copies of all four.
 assert.deepEqual([...CHAIN_BOOTSTRAP_TABLES],
  ['meta.migrations','economy.system_burns','season.league_week','runtime.controls']);

 // A target that is not at the sealed head, is missing `learning`, has drifted
 // checksums, or already holds application rows must be refused precisely.
 for(const [label,options,pattern] of [
  ['behind the head',{head:'short'},/schema head/],
  ['missing a ledger row',{head:'count'},/schema head/],
  ['with a drifted checksum',{head:'drift'},/schema head/],
  ['with an empty ledger',{head:'empty'},/schema head/],
  ['without the learning schema',{learning:false},/learning schema/],
  ['that is not PostgreSQL16',{version:'150000'},/not PostgreSQL16/],
  ['already holding application rows',{extraRows:{'identity.actors':3}},/already holds application rows/]
 ]){
  await assert.rejects(()=>prepareProductionTarget(labTarget(),{connect:fakeLab(options).connect}),
   /P15_RESTORE_REFUSED/,label+' must be refused');
 }
 // A partially-cleared target is rolled back: the head is verified before any
 // delete, and the refusal on existing rows aborts the whole pre-flight.
 const lab=fakeLab({extraRows:{'identity.actors':1}});
 await assert.rejects(()=>prepareProductionTarget(labTarget(),{connect:lab.connect}),
  /P15_RESTORE_REFUSED/);
 const sql=lab.statements.map(s=>s[0]);
 assert.ok(sql.includes('BEGIN')&&sql.includes('ROLLBACK'),
  'a refused production pre-flight rolls back instead of leaving deletes behind');
 assert.equal(sql.indexOf('ROLLBACK'),sql.length-2,'nothing runs after the rollback');
 assert.ok(!sql.some(s=>s.startsWith('DELETE FROM')),
  'no chain bootstrap row is deleted once a foreign row is found');
});

// Real sealed fixture: the archive really authenticates, so the ordering claim
// below ("tag verified before pg_restore is spawned") is exercised, not simulated.
const ID='v5-p15-2026-10-14T01-33-19-119Z-2d356be745e93677';
const CREATED='2026-10-14T01:33:19.119Z';
// The full immutable-manifest shape validate() accepts, already bound to the
// sealed header below. Only the production pair is used, so the same archive
// also proves the disposable path when the source kind is swapped.
function sealedManifest(sealed,overrides={}){
 return {
  format:'mega-v5-p15-backup-manifest/v1',backupId:ID,createdAtUtc:CREATED,
  sourceId:'p15-production-pgsource',sourceKind:'nonserving-production-source',
  sourceEnvironment:'production',sourceFingerprint:'c'.repeat(64),sourceSha:SOURCE,
  migrationManifestSha256:SCHEMA_SHA,pgMajor:16,ciphertextFile:ID+'.mxb',
  ciphertextBytes:sealed.bytes,ciphertextSha256:sealed.sha256,
  cryptoFormat:'mega-v5-p15-sealed-archive/v1',
  recipientSpkiSha256:sealed.recipientSpkiSha256,plaintextTemporaryFileCreated:false,
  includesClusterGlobalRolesOrSecrets:false,remoteStorageVerified:false,
  independentRestoreVerified:false,backupRunClass:'REAL_DIRECT_PG16_DUMP',
  g15Accepted:false,...overrides
 };
}
async function sealedFixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-path-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const keys=crypto.generateKeyPairSync('rsa',{modulusLength:3072});
 const privatePem=keys.privateKey.export({format:'pem',type:'pkcs8'});
 const archive=path.join(dir,ID+'.mxb');
 const sealed=await sealStream(Readable.from([Buffer.from('PGDMP synthetic lab payload')]),
  keys.publicKey.export({format:'pem',type:'spki'}),archive+'.partial',
  {sourceSha:SOURCE,createdAtUtc:CREATED,sourceFingerprint:'c'.repeat(64),
   schemaManifestSha256:SCHEMA_SHA});
 fs.renameSync(archive+'.partial',archive);
 const manifestPath=path.join(dir,ID+'.manifest.json');
 fs.writeFileSync(manifestPath,JSON.stringify(sealedManifest(sealed)),{mode:0o600});
 return {dir,archive,manifestPath,privatePem,sealed};
}
function recordingProcess(){
 const child=new EventEmitter();
 child.stdin=new Writable({write(_c,_e,cb){cb();}});
 child.stdin.on('finish',()=>process.nextTick(()=>child.emit('close',0)));
 child.kill=()=>{};
 return child;
}
const emptyConnect=async()=>({query:async(sql)=>{
 if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],rowCount:0};
 if(sql.includes("current_setting('server_version_num')"))return {rows:[{version:'160000'}]};
 const del=/^DELETE FROM (\S+)$/.exec(sql);
 if(del)return {rows:[],rowCount:1};
 if(/^SELECT count\(\*\)::int AS n FROM "/.test(sql))return {rows:[{n:1}]};
 if(sql.includes('FROM meta.migrations'))return {rows:PACK.map(m=>({id:m.id,name:m.name,checksum:m.sha256}))};
 if(sql.includes("nspname='learning'"))return {rows:[{n:1}]};
 if(sql.includes("relkind IN ('r','p','m')"))return {rows:CHAIN_BOOTSTRAP_TABLES.map(t=>{
  const [schema,name]=t.split('.');return {schema,name};})};
 if(sql.includes("relkind IN ('r','p','m','v','S')"))return {rows:[{n:0}]};
 throw Error('unexpected statement: '+sql);
},async end(){}});

test('the two restore paths request exactly the specified pg_restore flags',async t=>{
 const f=await sealedFixture(t);
 const env={P15_SOURCE_SHA:SOURCE,V5_P15_DISPOSABLE:'1',V5_P15_QUARANTINE:'1',
  P15_RESTORE_JOBS_DISABLED:'1',P15_RESTORE_PROVIDER_CALLBACKS_DISABLED:'1'};
 const requests=[];
 const spawnCommand=(bin,args)=>{requests.push({bin,args});return recordingProcess();};
 const snapshot=async()=>({tableCount:18,totalRows:99,canonicalDigest:'e'.repeat(64)});

 const production=await restore({manifestPath:f.manifestPath,archivePath:f.archive,
  privatePem:f.privatePem,target:labTarget(),env,spawnCommand,versionCheck:()=>16,
  connect:emptyConnect,snapshot});
 assert.equal(requests.length,1);
 assert.equal(requests[0].bin,'pg_restore');
 const prodArgs=requests[0].args;
 assert.ok(prodArgs.includes('--data-only'),'production restore must load data only');
 assert.ok(prodArgs.includes('--disable-triggers'),
  'production restore must not fire capture CONSTRAINT TRIGGERs mid-load');
 assert.ok(prodArgs.includes('--single-transaction'));
 assert.ok(prodArgs.includes('--exit-on-error'));
 for(const disallowed of ['--clean','--create'])assert.ok(!prodArgs.includes(disallowed));
 assert.equal(production.dataOnlyProductionRestore,true);
 assert.equal(production.productionSchemaHeadVerified,HEAD);
 assert.equal(production.productionLearningSchemaVerified,true);
 assert.equal(production.restoreTargetDisableTriggersUsed,true);
 assert.equal(production.preRestoreGcmAuthenticationVerified,true);
 assert.equal(production.singleTransactionRestoreCommitted,true);

 // The disposable path keeps today's exact full-fidelity argument vector. The
 // manifest identity (source kind, never the sealed header) is what selects the
 // path, so the same archive bytes are re-declared as a disposable capture.
 requests.length=0;
 const disposableDir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-disp-'));
 t.after(()=>fs.rmSync(disposableDir,{recursive:true,force:true}));
 fs.copyFileSync(f.archive,path.join(disposableDir,ID+'.mxb'));
 fs.writeFileSync(path.join(disposableDir,ID+'.manifest.json'),
  JSON.stringify(sealedManifest(f.sealed,{sourceKind:'disposable-source',
   sourceEnvironment:'test',sourceId:'p15-disposable-pgsource'})),{mode:0o600});
 const disposable=await restore({manifestPath:path.join(disposableDir,ID+'.manifest.json'),
  archivePath:path.join(disposableDir,ID+'.mxb'),
  privatePem:f.privatePem,target:{...target(),kind:'disposable-restore',port:5433},
  env,spawnCommand,versionCheck:()=>16,connect:emptyConnect,snapshot});
 const dispArgs=requests[0].args;
 assert.ok(!dispArgs.includes('--data-only'));
 assert.ok(!dispArgs.includes('--disable-triggers'));
 assert.ok(dispArgs.includes('--single-transaction'));
 for(const disallowed of ['--clean','--create'])assert.ok(!dispArgs.includes(disallowed));
 assert.equal(disposable.dataOnlyProductionRestore,false);
 assert.equal(disposable.productionSchemaHeadVerified,null);
 assert.equal(disposable.productionLearningSchemaVerified,false);
 assert.equal(disposable.restoreTargetDisableTriggersUsed,false);
});

test('the production path still verifies the manifest and full GCM tag before spawning pg_restore',async t=>{
 const f=await sealedFixture(t);
 const env={P15_SOURCE_SHA:SOURCE,V5_P15_DISPOSABLE:'1',V5_P15_QUARANTINE:'1',
  P15_RESTORE_JOBS_DISABLED:'1',P15_RESTORE_PROVIDER_CALLBACKS_DISABLED:'1'};
 const spawnCommand=()=>{throw Error('pg_restore must never start');};
 const snapshot=async()=>({tableCount:1,totalRows:1,canonicalDigest:'e'.repeat(64)});

 // A production ciphertext whose last byte is flipped. The manifest is
 // re-sealed around the tampered bytes so the immutable-file sha256 check
 // PASSES; only the full AES-GCM tag can catch it, which proves the tag - not
 // merely the digest - is verified before pg_restore is ever spawned.
 const bytes=Buffer.from(fs.readFileSync(f.archive));bytes[bytes.length-1]^=0x01;
 // A flipped GCM tag is not necessarily a changed digest, so re-point the
 // manifest at the tampered file under its own immutable name.
 const tamperedDir=fs.mkdtempSync(path.join(os.tmpdir(),'mx-p15-tampered-'));
 t.after(()=>fs.rmSync(tamperedDir,{recursive:true,force:true}));
 const tampered=path.join(tamperedDir,ID+'.mxb');
 fs.writeFileSync(tampered,bytes,{mode:0o600});
 const reparsed=sealedManifest({...f.sealed,
  bytes:bytes.length,
  sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 fs.writeFileSync(path.join(tamperedDir,ID+'.manifest.json'),JSON.stringify(reparsed),
  {mode:0o600});
 await assert.rejects(()=>restore({manifestPath:path.join(tamperedDir,ID+'.manifest.json'),
  archivePath:tampered,privatePem:f.privatePem,target:labTarget(),env,spawnCommand,
  versionCheck:()=>16,connect:emptyConnect,snapshot}),/P15_SEAL_REFUSED/);

 // A mismatched source revision is refused before the tag pass and the spawn.
 await assert.rejects(()=>restore({manifestPath:f.manifestPath,archivePath:f.archive,
  privatePem:f.privatePem,target:labTarget(),env:{...env,P15_SOURCE_SHA:'b'.repeat(40)},
  spawnCommand,versionCheck:()=>16,connect:emptyConnect,snapshot}),/P15_MANIFEST_REFUSED/);
});
