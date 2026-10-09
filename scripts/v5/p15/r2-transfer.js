#!/usr/bin/env node
'use strict';

/**
 * P15 R2 operator-only transfer of PRE-ENCRYPTED PostgreSQL archives.
 * Two separate scoped AWS CLI profiles (writer + independent reader).
 * PutObject uses If-None-Match:* to refuse overwrites, and independent
 * GET re-hashes both ciphertext and immutable source manifest. No DELETE,
 * repository init, retention prune, private key or plain-text dump.
 *
 * NO actual R2 access is attempted in PR CI. Tests inject a fake runner
 * explicitly labeled MOCK_NOT_PROVIDER_PROOF. The owner-operated mode
 * requires a mode-0600 AWS credentials file and a separate scoped bucket.
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {inspectPair}=require('./archive-manifest.js');
const {digestFile}=require('./sealed-archive.js');
const {assertTarget,plan}=require('./r2-contract.js');
const {checkFile,privateDirectory}=require('./direct-target.js');

const SOURCE=/^[a-f0-9]{40}$/;
const WRITER='mega-xo-v5-backup-writer',READER='mega-xo-v5-recovery-reader';
function refuse(msg){throw Error('P15_R2_TRANSFER_REFUSED: '+msg);}
function protectedAwsEnv(env,profile){
 if(![WRITER,READER].includes(profile)||
    env.P15_OWNER_APPROVE_R2_TRANSFER!=='1'||
    env.P15_OWNER_CONFIRMS_V5_ONLY_BUCKET!=='1'||
    !SOURCE.test(env.P15_SOURCE_SHA||'')) {
  refuse('operator-scoped V5-only R2 scope must be confirmed');
 }
 for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','AWS_ENDPOINT_URL']) {
  if(env[key])refuse('ambient AWS secrets/provider endpoint overrides prohibited');
 }
 checkFile(env.P15_AWS_SHARED_CREDENTIALS_FILE,{secret:true});
 return {
  PATH:env.PATH||'/usr/bin:/bin',HOME:env.HOME||'/',
  LANG:'C',LC_ALL:'C',
  AWS_SHARED_CREDENTIALS_FILE:env.P15_AWS_SHARED_CREDENTIALS_FILE,
  AWS_PROFILE:profile,AWS_DEFAULT_REGION:'auto',
  AWS_PAGER:'',AWS_CLI_AUTO_PROMPT:'off',
  AWS_EC2_METADATA_DISABLED:'true'
 };
}
function awsVersion(runner=spawnSync,env=process.env){
 const p=runner('aws',['--version'],{encoding:'utf8',
  timeout:6000,env:{PATH:env.PATH||'/usr/bin:/bin',HOME:env.HOME||'/'}});
 const raw=(p.stdout||'')+' '+(p.stderr||'');
 if(p.status!==0||!/aws-cli\/2\.\d+/.test(raw))refuse('reviewed AWS CLI v2 required');
}
function readTarget(filename){
 if(typeof filename!=='string'||!path.isAbsolute(filename))refuse('absolute nonsecret R2 target config required');
 checkFile(filename);
 if(fs.statSync(filename).size>4096)refuse('R2 config too large');
 let doc;try{doc=JSON.parse(fs.readFileSync(filename,'utf8'));}catch{refuse('bad R2 target JSON');}
 return assertTarget(doc);
}
function callAws(runner,args,env,profile){
 const result=runner('aws',args,{env:protectedAwsEnv(env,profile),
  cwd:'/',encoding:'utf8',timeout:900000,maxBuffer:1024*1024});
 if(!result||result.status!==0)refuse('R2 API call rejected (no object rollback or retry performed)');
 if(!result.stdout)return {};
 try{return JSON.parse(result.stdout);}catch{refuse('R2 CLI result not valid JSON');}
}
function sharedFlags(t){
 return ['--endpoint-url',t.endpoint,'--region','auto','--bucket',t.bucket];
}
async function transfer({r2,manifestPath,archivePath,env=process.env,
 runner=spawnSync}){
 const target=assertTarget(r2);
 const inspected=await inspectPair(manifestPath,archivePath,env.P15_SOURCE_SHA);
 const manifest=inspected.manifest;
 if(manifest.sourceKind!=='nonserving-staging-source'||
   manifest.sourceEnvironment!=='staging'||
   manifest.backupRunClass!=='REAL_DIRECT_PG16_DUMP'){
  refuse('operator R2 upload requires a real reviewed nonserving V5 staging dump');
 }
 privateDirectory(path.dirname(archivePath));
 protectedAwsEnv(env,WRITER);
 protectedAwsEnv(env,READER);
 awsVersion(runner,env);
 const keys=plan(target,manifest);
 const common=sharedFlags(target);
 let tempCipher=null,tempManifest=null;
 try {
  const put=(key,file,mime,metadata)=>
   callAws(runner,['s3api','put-object',...common,
    '--key',key,'--body',file,'--if-none-match','*',
    '--content-type',mime,'--metadata',metadata,
    '--output','json'],env,WRITER);
  // If the manifest put fails, the already stored ciphertext is intentionally
  // left immutable. An owner can inspect the orphaned encrypted object.
  // NEVER delete a possibly recoverable copy as a "cleanup" response.
  put(keys.ciphertextKey,archivePath,'application/octet-stream',
   'sha256='+manifest.ciphertextSha256);
  const expectedManifestSha=await digestFile(manifestPath);
  put(keys.manifestKey,manifestPath,'application/json','sha256='+expectedManifestSha);

  const head=callAws(runner,['s3api','head-object',...common,
   '--key',keys.ciphertextKey,'--output','json'],env,READER);
  if(Number(head.ContentLength)!==manifest.ciphertextBytes||
    head.Metadata?.sha256!==manifest.ciphertextSha256) {
   refuse('R2 object length or encrypted checksum metadata mismatch');
  }
  const random=crypto.randomBytes(8).toString('hex');
  tempCipher=path.join(path.dirname(archivePath),'.p15-r2-cipher-'+random+'.partial');
  tempManifest=path.join(path.dirname(archivePath),'.p15-r2-manifest-'+random+'.partial');
  if(fs.existsSync(tempCipher)||fs.existsSync(tempManifest))refuse('readback scratch name collision');
  callAws(runner,['s3api','get-object',...common,
   '--key',keys.ciphertextKey,tempCipher,'--output','json'],env,READER);
  callAws(runner,['s3api','get-object',...common,
   '--key',keys.manifestKey,tempManifest,'--output','json'],env,READER);
  const stat=fs.lstatSync(tempCipher);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==manifest.ciphertextBytes||
    await digestFile(tempCipher)!==manifest.ciphertextSha256||
    await digestFile(tempManifest)!==expectedManifestSha) {
   refuse('retrieved R2 ciphertext/manifest bytes differ from upload');
  }
  const providerObserved=runner===spawnSync;
  return {
   format:'mega-v5-p15-r2-upload-readback/v1',
   backupId:manifest.backupId,sourceSha:manifest.sourceSha,
   r2Bucket:target.bucket,r2AccountId:target.accountId,
   objectKey:keys.ciphertextKey,manifestObjectKey:keys.manifestKey,
   ciphertextSha256:manifest.ciphertextSha256,
   ciphertextBytes:manifest.ciphertextBytes,
   uploadUsedWriteOncePrecondition:true,
   separateWriterReaderProfilesUsed:true,
   ciphertextAndManifestReadbackMatching:true,
   realProviderUploadAndIndependentReadbackObserved:providerObserved,
   mockedCallsOnly:!providerObserved,
   decryptionAndRestoreFromR2Completed:false,
   providerIamIndependentlyAudited:false,
   productionRetentionApproved:false,g15Accepted:false
  };
 }catch(e){
  if(e.message&&e.message.startsWith('P15_R2_TRANSFER_REFUSED:'))throw e;
  refuse('R2 transfer/readback failed; immutable objects require owner review');
 }finally{
  for(const f of [tempCipher,tempManifest])if(f)try{fs.unlinkSync(f);}catch{}
 }
}
async function run(args,env=process.env){
 if(args.length!==9||args[0]!=='--target'||args[2]!=='--manifest'||
   args[4]!=='--archive'||args[6]!=='--receipt'||
   args[8]!=='--confirm-owner-scoped-v5-r2') {
  refuse('usage: --target R2.json --manifest BACKUP.manifest.json --archive BACKUP.mxb --receipt PRIVATE.json --confirm-owner-scoped-v5-r2');
 }
 const t=readTarget(args[1]);
 const result=await transfer({r2:t,manifestPath:args[3],archivePath:args[5],env});
 const receipt=args[7];
 if(typeof receipt!=='string'||!path.isAbsolute(receipt)||
   path.dirname(receipt)!==path.dirname(args[5])||
   !/\.r2-receipt\.json$/.test(receipt))refuse('private receipt must be adjacent to archive');
 const fd=fs.openSync(receipt,fs.constants.O_WRONLY|fs.constants.O_CREAT|
  fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,JSON.stringify(result,null,2)+'\n');fs.fsyncSync(fd);}
 finally{fs.closeSync(fd);}
 return result;
}
if(require.main===module){
 run(process.argv.slice(2)).then(x=>{
  process.stdout.write(JSON.stringify({format:x.format,
   realR2ReadbackObserved:x.realProviderUploadAndIndependentReadbackObserved,
   ciphertextSha256:x.ciphertextSha256,
   isolatedRestoreCompleted:false,g15Accepted:false})+'\n');
 },e=>{process.stderr.write(e.message&&e.message.startsWith('P15_')?e.message:
   'P15_R2_TRANSFER_REFUSED: R2 transfer failed');process.stderr.write('\n');process.exitCode=2;});
}
module.exports={WRITER,READER,protectedAwsEnv,awsVersion,readTarget,
 callAws,sharedFlags,transfer,run};
