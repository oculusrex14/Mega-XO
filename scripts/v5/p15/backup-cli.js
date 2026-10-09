#!/usr/bin/env node
'use strict';

/**
 * P15-02 operator/CI direct PostgreSQL16 pg_dump -> authenticated encrypted
 * archive, with no unencrypted temporary file and no live provider calls.
 * A staging backup requires owner approval plus an exact checked-in target
 * binding. Production activation is intentionally not yet permitted.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {sealStream}=require('./sealed-archive.js');
const {readTarget,assertTarget,privateDirectory,buildPgEnv,fingerprint,checkFile}=require('./direct-target.js');
const ROOT=path.join(__dirname,'../../..');
const SCHEMA_FILE=path.join(ROOT,'packages/migrations/manifest.json');
const REQUIRED_VERSION=/^pg_dump \(PostgreSQL\) 16\.\d+/;
function refuse(why){throw Error('P15_BACKUP_REFUSED: '+why);}
function version(bin='pg_dump',env=process.env){
 const result=spawnSync(bin,['--version'],{encoding:'utf8',timeout:5000,
  env:{PATH:env.PATH||'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}});
 if(result.status!==0||!REQUIRED_VERSION.test((result.stdout||'').trim())) {
  refuse('compatible PostgreSQL16 pg_dump binary required');
 }
 return 16;
}
function outputName(now=new Date()){
 if(!(now instanceof Date)||!Number.isFinite(now.valueOf()))refuse('valid UTC instant required');
 return 'v5-p15-'+now.toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(8).toString('hex');
}
function readPublicPem(file){
 checkFile(file);
 const stat=fs.statSync(file);
 if(stat.size<400||stat.size>10000)refuse('recovery public key file size invalid');
 return fs.readFileSync(file,'utf8');
}
function requireSource(source,env){
 const config=assertTarget(source,'backup',env);
 if(config.sourceSha!==env.P15_SOURCE_SHA)refuse('backup source SHA must be the checked-out exact commit');
 return config;
}
async function backup({source,recipientPublicPem,outputDirectory,env=process.env,
 command='pg_dump',spawnCommand=spawn,versionCheck=version,now=new Date()}){
 const target=requireSource(source,env);
 privateDirectory(outputDirectory);
 if(typeof recipientPublicPem!=='string'||recipientPublicPem.length>12000)refuse('valid public recovery recipient required');
 if(command!=='pg_dump')refuse('only pg_dump binary may produce the sealed archive');
 const observed=versionCheck(command,env);
 if(observed!==16)refuse('source pg_dump must be compatible PostgreSQL16');
 const schemaBytes=fs.readFileSync(SCHEMA_FILE);
 const schemaSha=crypto.createHash('sha256').update(schemaBytes).digest('hex');
 const name=outputName(now),partial=path.join(outputDirectory,name+'.mxb.partial');
 const sealedFile=path.join(outputDirectory,name+'.mxb');
 const manifestFile=path.join(outputDirectory,name+'.manifest.json');
 const pgEnv=buildPgEnv(target,env);
 const child=spawnCommand(command,[
  '--format=custom','--no-owner','--no-acl','--compress=6',
  '--lock-wait-timeout=10s'
 ],{cwd:ROOT,env:pgEnv,stdio:['ignore','pipe','ignore']});
 if(!child||!child.stdout||typeof child.once!=='function'||typeof child.kill!=='function') {
  refuse('streaming pg_dump process required');
 }
 const exit=new Promise((resolve,reject)=>{
  child.once('error',()=>reject(Error('PG_DUMP_PROCESS_FAILED')));
  child.once('close',code=>code===0?resolve():reject(Error('PG_DUMP_FAILED')));
 });
 // A failing pg_dump can close before the asynchronous encryption pipeline
 // has drained. Attach rejection handling immediately; await below still fails.
 exit.catch(()=>{});
 let finalCreated=false;
 try{
  const sealed=await sealStream(child.stdout,recipientPublicPem,partial,{
   createdAtUtc:now.toISOString(),sourceFingerprint:fingerprint(target),
   schemaManifestSha256:schemaSha,sourceSha:target.sourceSha
  });
  await exit;
  if(fs.existsSync(sealedFile)||fs.existsSync(manifestFile))refuse('random archive name collision');
  // Link is EXCLUSIVE (unlike rename's overwrite behavior); same private
  // directory/filesystem ensures immutable authenticated archive bytes.
  fs.linkSync(partial,sealedFile);finalCreated=true;
  fs.unlinkSync(partial);
  const manifest={
   format:'mega-v5-p15-backup-manifest/v1',
   backupId:name,createdAtUtc:now.toISOString(),
   sourceId:target.sourceId,sourceKind:target.kind,sourceEnvironment:target.environment,
   sourceFingerprint:fingerprint(target),sourceSha:target.sourceSha,
   migrationManifestSha256:schemaSha,pgMajor:16,
   ciphertextFile:path.basename(sealedFile),ciphertextBytes:sealed.bytes,
   ciphertextSha256:sealed.sha256,
   cryptoFormat:sealed.archiveFormat,recipientSpkiSha256:sealed.recipientSpkiSha256,
   plaintextTemporaryFileCreated:false,
   includesClusterGlobalRolesOrSecrets:false,
   remoteStorageVerified:false,independentRestoreVerified:false,
   backupRunClass:spawnCommand===spawn?'REAL_DIRECT_PG16_DUMP':'UNIT_STUB_NOT_DB_PROOF',
   g15Accepted:false
  };
  const fd=fs.openSync(manifestFile,fs.constants.O_WRONLY|fs.constants.O_CREAT|
   fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{
   fs.writeFileSync(fd,JSON.stringify(manifest,null,2)+'\n');
   fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  const encryptedFd=fs.openSync(sealedFile,'r');
  try{fs.fsyncSync(encryptedFd);}finally{fs.closeSync(encryptedFd);}
  return {manifest,manifestFile,sealedFile};
 }catch(e){
  try{child.kill('SIGTERM');}catch{}
  try{fs.unlinkSync(partial);}catch{}
  if(finalCreated)try{fs.unlinkSync(sealedFile);}catch{}
  try{fs.unlinkSync(manifestFile);}catch{}
  if(e.message&&e.message.startsWith('P15_BACKUP_REFUSED:'))throw e;
  refuse('backup aborted; no completed archive is published');
 }
}
async function run(argv,env=process.env){
 if(argv.length!==7||argv[0]!=='--source'||argv[2]!=='--recipient'||
  argv[4]!=='--out'||!['--confirm-owned-backup','--confirm-nonserving-staging-backup'].includes(argv[6])) {
  refuse('usage: --source TARGET.json --recipient PUBLIC.pem --out PRIVATE_DIR --confirm-owned-backup');
 }
 const source=readTarget(argv[1],'backup',env);
 if(source.kind==='nonserving-staging-source'&&argv[6]!=='--confirm-nonserving-staging-backup') {
  refuse('staging requires distinct owner confirmation');
 }
 if(source.kind==='disposable-source'&&argv[6]!=='--confirm-owned-backup') {
  refuse('owned disposable confirmation required');
 }
 return backup({source,recipientPublicPem:readPublicPem(argv[3]),
  outputDirectory:argv[5],env});
}
if(require.main===module){
 run(process.argv.slice(2)).then(({manifest})=>{
  process.stdout.write(JSON.stringify({format:manifest.format,backupId:manifest.backupId,
   ciphertextBytes:manifest.ciphertextBytes,ciphertextSha256:manifest.ciphertextSha256,
   realSourceDump:manifest.backupRunClass==='REAL_DIRECT_PG16_DUMP',
   independentRestoreVerified:false,g15Accepted:false})+'\n');
 },e=>{process.stderr.write(e.message&&e.message.startsWith('P15_')?e.message:
   'P15_BACKUP_REFUSED: backup failed without exposing source details');process.stderr.write('\n');process.exitCode=2;});
}
module.exports={version,outputName,readPublicPem,requireSource,backup,run};
