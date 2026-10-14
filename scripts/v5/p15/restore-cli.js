#!/usr/bin/env node
'use strict';

/**
 * P15-03 independently quarantined restore from authenticated ciphertext.
 *
 * NO --clean/--create and NO arbitrary restore host. Verify manifest SHA and
 * full AES-GCM tag BEFORE starting pg_restore. Stream decryption directly into
 * one --single-transaction pg_restore in a newly provisioned DB on a DIFFERENT
 * disposable PG16 instance, with no plaintext file.
 *
 * TWO RESTORE PATHS
 * -----------------
 * (a) `disposable-source` -> `disposable-restore` (and any future staging pair)
 *     keeps its exact previous behaviour: the archive carries schema AND data,
 *     pg_restore loads both into an empty database, no `--data-only`.
 * (b) `nonserving-production-source` -> `nonproduction-restore` runs
 *     SCHEMA FROM THE IMMUTABLE MIGRATION CHAIN + DATA FROM THE ARCHIVE. The
 *     production archive is taken with `--exclude-schema=learning`, while
 *     migration 0044 installs CONSTRAINT TRIGGERs on match.matches,
 *     tournament.fixtures, tournament.rooms and privacy.requests that call
 *     `learning.*` functions. A whole-archive restore therefore cannot work:
 *     the archived schema section has no `learning` schema, so those CREATE
 *     CONSTRAINT TRIGGER statements fail, and pre-applying the chain instead
 *     makes every CREATE collide with the objects the chain already made.
 *     The quarantined `nonproduction-restore` target is therefore brought to
 *     the sealed schema head by the trusted runner applying the immutable
 *     migration chain, and pg_restore then loads DATA ONLY:
 *
 *       pg_restore --data-only --disable-triggers --single-transaction ...
 *
 *     `--data-only` skips the conflicting CREATE statements; the schema
 *     (including `learning` and its capture functions) is the chain's.
 *     `--disable-triggers` stops the capture CONSTRAINT TRIGGERs from firing
 *     mid-load, which is required because the restore is a loopback
 *     superuser target in the quarantined lab - the only place this kind of
 *     load is permitted. `--single-transaction` keeps the load atomic.
 *
 *     restore-cli VERIFIES that pre-state (it never builds the schema itself):
 *     `meta.migrations` max id must equal the schema head of the pinned
 *     migration manifest and schema `learning` must exist, both refused with
 *     a precise code otherwise.
 *
 *     The immutable chain mints four bootstrap rows of its own
 *     (`meta.migrations`, `economy.system_burns`, `season.league_week`,
 *     `runtime.controls`) and the production archive carries the authoritative
 *     production copies of all four, so those exact rows are cleared after the
 *     head is verified and before pg_restore runs; everything else must already
 *     be empty, so no durable value is lost and no half-used target can be
 *     scribbled over. `learning.*` is chain-owned and never present in a
 *     production capture, so it is preserved untouched.
 *
 * No permission to enable jobs, deliver mail, replay payments or route
 * customers. A restore never automatically becomes live authority.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {readTarget,assertTarget,checkFile,buildPgEnv,fingerprint}=require('./direct-target.js');
const {inspectPair,sourceKindMatchesEnvironment}=require('./archive-manifest.js');
const {authenticateArchive,decryptToWritable}=require('./sealed-archive.js');
const {connectSnapshot}=require('./data-integrity.js');
const ROOT=path.join(__dirname,'../../..');
// The sealed manifest's migrationManifestSha256 pins this exact immutable pack,
// so its last id IS the sealed schema head the quarantined target must hold.
const MIGRATION_PACK=require('../../../packages/migrations/manifest.json').migrations;
function refuse(why){throw Error('P15_RESTORE_REFUSED: '+why);}
function version(binary='pg_restore',env=process.env){
 const r=spawnSync(binary,['--version'],{encoding:'utf8',timeout:5000,
  env:{PATH:env.PATH||'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
 if(r.status!==0||!/^pg_restore \(PostgreSQL\) 16\.\d+/.test((r.stdout||'').trim())){
  refuse('compatible PostgreSQL16 pg_restore binary required');
 }
 return 16;
}
function readPrivateKey(filepath){
 checkFile(filepath,{secret:true});
 const st=fs.statSync(filepath);
 if(st.size<1500||st.size>15000)refuse('off-host recovery private key format/size invalid');
 const pem=fs.readFileSync(filepath,'utf8');
 if(!pem.includes('PRIVATE KEY'))refuse('recovery private identity required');
 return pem;
}
// Which quarantine targets each source kind may be restored into. A
// non-serving PRODUCTION archive is only ever restorable into the
// `nonproduction-restore` kind (loopback disposable PG16, quarantined), never
// into any other target. The disposable flow keeps its existing target.
const RESTORE_TARGETS=Object.freeze({
 'disposable-source':['disposable-restore'],
 'nonserving-production-source':['nonproduction-restore']
});
function requireRestore(target,manifest,env=process.env){
 const checked=assertTarget(target,'restore',env);
 // assertTarget above already pinned the target itself (both restore kinds are
 // loopback disposable PG16 with the quarantine gates); this second check binds
 // the manifest identity to the target kind, so a production archive can never
 // be pointed at anything but `nonproduction-restore`. Unknown kinds and
 // staging sources are still refused outright.
 const permitted=RESTORE_TARGETS[manifest&&manifest.sourceKind]||[];
 if(checked.sourceSha!==env.P15_SOURCE_SHA||
    manifest.sourceSha!==checked.sourceSha||
    !permitted.includes(checked.kind)||
    !sourceKindMatchesEnvironment(manifest.sourceKind,manifest.sourceEnvironment)||
    manifest.backupRunClass!=='REAL_DIRECT_PG16_DUMP'||
    env.P15_RESTORE_JOBS_DISABLED!=='1'||
    env.P15_RESTORE_PROVIDER_CALLBACKS_DISABLED!=='1') {
   refuse('isolated source/target revision and quarantine confirmations required');
 }
 return checked;
}
function restoreArgs(db,{dataOnly=false}={}){
 if(typeof db!=='string'||!/^v5_p15_restore_[a-z0-9_]{6,48}$/.test(db)) {
  refuse('pg_restore can only target a uniquely provisioned recovery database');
 }
 const args=['--dbname='+db,'--format=custom','--no-owner','--no-acl',
  '--no-tablespaces'];
 // `schema from the immutable migration chain + data from the archive`: the
 // quarantined production target is already migrated to the sealed head, so
 // only data may be loaded. `--disable-triggers` is required because the
 // capture CONSTRAINT TRIGGERs on match.matches, tournament.fixtures,
 // tournament.rooms and privacy.requests call `learning.*` functions that must
 // not fire while the capture tables are (deliberately) absent from the
 // production archive; it is permitted only on this loopback superuser lab
 // target. `--single-transaction` keeps the whole load atomic. The disposable
 // and staging paths keep their exact previous argument vector.
 if(dataOnly)args.push('--data-only','--disable-triggers');
 args.push('--single-transaction','--exit-on-error');
 return args;
}
// The immutable chain has no data of its own apart from four bootstrap rows it
// mints on the way to the head: migration 0024 seeds the three singletons and
// the ledger records itself. A sealed production archive carries the
// authoritative production copies of all four, so the data load must REPLACE
// these rows rather than merge into them (production's own season.league_week,
// runtime.controls and economy.system_burns values are real durable state).
const CHAIN_BOOTSTRAP_TABLES=Object.freeze([
 'meta.migrations','economy.system_burns','season.league_week','runtime.controls']);
function pgClient(target){
 const {Client}=require('pg');
 return new Client({host:target.host,port:target.port,database:target.database,
  user:target.user,ssl:false,connectionTimeoutMillis:5000});
}
async function ensureEmpty(target,{connect=pgClient}={}){
 const c=await connect(target);
 await c.connect();
 try{
  const r=await c.query(
   "SELECT count(*)::int AS n FROM pg_catalog.pg_class c "+
   "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "+
   "WHERE c.relkind IN ('r','p','m','v','S') AND "+
   "n.nspname NOT IN ('pg_catalog','information_schema') AND "+
   "n.nspname NOT LIKE 'pg_toast%'");
  if(r.rows[0].n!==0)refuse('quarantined target contains application objects (no overwrite allowed)');
  const version=await c.query("SELECT current_setting('server_version_num') AS version");
  if(Math.floor(Number(version.rows[0].version)/10000)!==16)refuse('recovery target is not PostgreSQL16');
 }finally{await c.end();}
}
// Production path pre-flight. Building the schema is the trusted runner's job
// (it applied the immutable chain); this VERIFIES that pre-state and refuses
// with a precise code when it does not hold. It then removes exactly the
// chain's own bootstrap rows so the archive's authoritative copies can load and
// refuses any other pre-existing application row, so a half-used target can
// never be silently scribbled over. `learning` is chain-owned and never present
// in a production capture, so it is preserved untouched and not required empty.
async function prepareProductionTarget(target,{connect=pgClient}={}){
 const c=await connect(target);
 let begun=false;
 try{
  const server=await c.query("SELECT current_setting('server_version_num') AS version");
  if(Math.floor(Number(server.rows[0]?.version)/10000)!==16)refuse('recovery target is not PostgreSQL16');
  const rows=(await c.query(
   'SELECT id,name,checksum FROM meta.migrations WHERE id>0 ORDER BY id')).rows;
  const head=MIGRATION_PACK[MIGRATION_PACK.length-1].id;
  if(rows.length!==MIGRATION_PACK.length||
     rows.some((r,i)=>Number(r.id)!==MIGRATION_PACK[i].id||r.name!==MIGRATION_PACK[i].name||
      r.checksum!==MIGRATION_PACK[i].sha256)||
     Number(rows[rows.length-1].id)!==head) {
   refuse('quarantined production target is not at the sealed migration schema head '+head);
  }
  const learning=(await c.query(
   "SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname='learning'")).rows[0].n;
  if(learning!==1)refuse('quarantined production target is missing the learning schema');
  const relations=(await c.query(
   "SELECT n.nspname AS schema, c.relname AS name FROM pg_catalog.pg_class c "+
   "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "+
   "WHERE c.relkind IN ('r','p','m') AND "+
   "n.nspname NOT IN ('pg_catalog','information_schema','learning') AND "+
   "n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname")).rows;
  await c.query('BEGIN');
  begun=true;
  for(const entry of relations){
   const id=entry.schema+'.'+entry.name;
   if(CHAIN_BOOTSTRAP_TABLES.includes(id))continue;
   const count=(await c.query('SELECT count(*)::int AS n FROM "'+entry.schema+'"."'+entry.name+'"')).rows[0].n;
   if(count!==0)refuse('quarantined production target already holds application rows in '+id);
  }
  const cleared={};
  for(const table of CHAIN_BOOTSTRAP_TABLES){
   cleared[table]=(await c.query('DELETE FROM '+table)).rowCount;
  }
  await c.query('COMMIT');
  begun=false;
  return {schemaHead:head,learningSchemaPresent:true,chainBootstrapRowsReplaced:cleared};
 }catch(e){
  if(begun)try{await c.query('ROLLBACK');}catch{}
  throw e;
 }finally{await c.end();}
}
async function restore({manifestPath,archivePath,privatePem,target,
 env=process.env,spawnCommand=spawn,versionCheck=version,
 connect=pgClient,snapshot=connectSnapshot}){
 const inspected=await inspectPair(manifestPath,archivePath,env.P15_SOURCE_SHA);
 const config=requireRestore(target,inspected.manifest,env);
 if(versionCheck('pg_restore',env)!==16)refuse('pg_restore major mismatch');
 const schemaSha=crypto.createHash('sha256').update(
  fs.readFileSync(path.join(ROOT,'packages/migrations/manifest.json'))).digest('hex');
 if(schemaSha!==inspected.manifest.migrationManifestSha256) {
  refuse('recovery code/schema manifest differs from sealed source');
 }
 // Two passes deliberately: the first validates the ENTIRE tag without
 // exposing plaintext to pg_restore, then the second re-verifies while
 // streaming. No plaintext file ever lands on disk.
 await authenticateArchive(archivePath,privatePem);
 // The production path loads data only, into a target the trusted runner already
 // migrated; the disposable path restores the whole archive into an empty DB.
 const dataOnly=config.kind==='nonproduction-restore';
 let production;
 if(dataOnly){
  production=await prepareProductionTarget(config,{connect});
 }else{
  await ensureEmpty(config,{connect});
 }
 const child=spawnCommand('pg_restore',restoreArgs(config.database,{dataOnly}),{
  cwd:ROOT,env:buildPgEnv(config,env),stdio:['pipe','ignore','ignore']
 });
 if(!child||!child.stdin||typeof child.kill!=='function'||typeof child.once!=='function'){
  refuse('bounded streaming pg_restore process required');
 }
 const exit=new Promise((resolve,reject)=>{
  child.once('error',()=>reject(Error('PG_RESTORE_PROCESS_FAILED')));
  child.once('close',code=>code===0?resolve():reject(Error('PG_RESTORE_FAILED')));
 });
 exit.catch(()=>{});
 try{
  await decryptToWritable(archivePath,privatePem,child.stdin);
  child.stdin.end();
  await exit;
 }catch(e){
  try{child.kill('SIGTERM');}catch{}
  // NO automated DROP/TRUNCATE: an incomplete owned target is quarantined
  // for caller-specific cleanup, never reactivated or mistaken for success.
  refuse('restore failed; target remains quarantined and untrusted');
 }
 const snapshotResult=await snapshot(config);
 return {
  format:'mega-v5-p15-owned-restore-result/v1',
  sourceSha:config.sourceSha,
  backupId:inspected.manifest.backupId,
  encryptedBytes:inspected.manifest.ciphertextBytes,
  ciphertextSha256:inspected.manifest.ciphertextSha256,
  restoredTargetFingerprint:fingerprint(config),
  physicalTargetKind:'SECOND_SEPARATE_POSTGRESQL16_INSTANCE',
  manifestAndCiphertextHashVerified:true,
  preRestoreGcmAuthenticationVerified:true,
  singleTransactionRestoreCommitted:true,
  dataOnlyProductionRestore:dataOnly,
  productionSchemaHeadVerified:production?production.schemaHead:null,
  productionLearningSchemaVerified:production?production.learningSchemaPresent:false,
  productionChainBootstrapRowsReplaced:production?production.chainBootstrapRowsReplaced:null,
  restoreTargetDisableTriggersUsed:dataOnly,
  applicationTables:snapshotResult.tableCount,
  applicationRows:snapshotResult.totalRows,
  completeDataDigest:snapshotResult.canonicalDigest,
  actualSourceAndTargetDataComparisonPerformed:false,
  roleGrantsAndGlobalSecretsReconstructed:false,
  providerPitrObserved:false,encryptedR2DownloadObserved:false,
  outboundReenablementAuthorized:false,remoteProductionRestore:false,
  g15Accepted:false
 };
}
async function run(argv,env=process.env){
 if(argv.length!==9||argv[0]!=='--target'||argv[2]!=='--manifest'||
   argv[4]!=='--archive'||argv[6]!=='--private-key'||
   argv[8]!=='--confirm-quarantined-disposable-restore'){
  refuse('usage: --target TARGET.json --manifest MANIFEST.json --archive ARCHIVE.mxb --private-key PRIVATE.pem --confirm-quarantined-disposable-restore');
 }
 const target=readTarget(argv[1],'restore',env);
 return restore({target,manifestPath:argv[3],archivePath:argv[5],
  privatePem:readPrivateKey(argv[7]),env});
}
if(require.main===module){
 run(process.argv.slice(2)).then(r=>process.stdout.write(JSON.stringify(r,null,2)+'\n'),
 e=>{process.stderr.write(e.message&&e.message.startsWith('P15_')?e.message:
   'P15_RESTORE_REFUSED: quarantined restore failed');process.stderr.write('\n');process.exitCode=2;});
}
module.exports={version,readPrivateKey,RESTORE_TARGETS,CHAIN_BOOTSTRAP_TABLES,
 requireRestore,restoreArgs,ensureEmpty,prepareProductionTarget,restore,run};
