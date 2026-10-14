#!/usr/bin/env node
'use strict';
/* Bounded one-shot jobs for an external supervisor. Does NOT enable collection, create roles,
 * migrate, train, publish, or contact a public endpoint. Secrets are only read from env/files. */
const fs=require('node:fs'),crypto=require('node:crypto');
const {createConnection,readKey}=require('../packages/learning/connection.js');
const {createCaptureWorker}=require('../packages/learning/worker.js');
const MODES=['worker','reconcile','metrics','erase','suppress','retention','withdraw','export','journal','restore-journal','purge-exports','gate'];
async function main(argv=process.argv.slice(2),env=process.env){
 const mode=argv[0];if(!MODES.includes(mode)||argv.length!==1)throw Error('CAPTURE_COMMAND_REQUIRED:'+MODES.join(','));
 const role=['erase','suppress','retention','withdraw','journal','restore-journal'].includes(mode)?'capture_privacy':['export','purge-exports'].includes(mode)?'capture_exporter':'capture_runtime';
 const db=await createConnection(env,role);let key,pseudonymKey;
 const abort=new AbortController(),handler=()=>abort.abort();process.once('SIGTERM',handler);process.once('SIGINT',handler);
 try{
  const worker=createCaptureWorker(db,{workerId:'capture-'+process.pid+'-'+crypto.randomBytes(6).toString('hex'),batchSize:8});
  if(mode==='worker')return await worker.tick();
  if(mode==='metrics')return await worker.metrics();
  if(mode==='reconcile'){
   let scanned=0,repaired=0;for(const kind of ['match','fixture']){let after='';for(let pages=0;pages<10000;pages++){
    if(abort.signal.aborted)throw Error('CAPTURE_COMMAND_ABORTED');
    const r=await worker.reconcile({kind,after,limit:100,audit:env.CAPTURE_AUDIT_SOURCE==='1'});scanned+=r.scanned;repaired+=r.repaired;
    if(r.scanned<100)break;if(r.next===after)throw Error('CAPTURE_CURSOR_STALLED');after=r.next;
    if(pages===9999)throw Error('CAPTURE_RECONCILE_PAGE_BUDGET');
   }}return {scanned,repaired};
  }
  if(mode==='erase')return {erased:(await db.query('SELECT learning.erase(500) AS n')).rows[0].n};
  if(mode==='retention')return await require('../packages/learning/policy.js').runRetention(db,{kind:env.CAPTURE_RETENTION_KIND});
  if(mode==='withdraw'){
   if(!env.CAPTURE_SUBJECT)throw Error('CAPTURE_VERIFIED_SUBJECT_REQUIRED');
   const r=await db.query('SELECT learning.withdraw_research($1,$2) AS epoch',[env.CAPTURE_SUBJECT,'user-choice']);return {withdrawn:true,epoch:r.rows[0].epoch};
  }
  if(mode==='suppress'){
   if(!env.CAPTURE_SUBJECT||!['user-choice','account-deletion'].includes(env.CAPTURE_SUPPRESSION_REASON))throw Error('CAPTURE_VERIFIED_SUBJECT_REQUIRED');
   const r=await db.query('SELECT learning.suppress($1,$2) AS epoch',[env.CAPTURE_SUBJECT,env.CAPTURE_SUPPRESSION_REASON]);return {suppressed:true,epoch:r.rows[0].epoch};
  }
  if(mode==='gate'){
   const {assess}=require('../packages/learning/release-gate.js');
   const receipt=JSON.parse(fs.readFileSync(env.CAPTURE_RELEASE_RECEIPT,'utf8'));
   const configuration=(await db.query('SELECT learning.configuration() AS value')).rows[0].value;
   const report=assess({sourceCommit:env.CAPTURE_SOURCE_COMMIT,configuration,metrics:await worker.metrics(),receipt});
   if(report.result==='BLOCKED')process.exitCode=2;return report;
  }
  if(mode==='purge-exports')return await require('../packages/learning/exporter.js').purgeRevoked(db,env.CAPTURE_EXPORT_DIR);
  key=readKey(env.CAPTURE_KEY_FILE);
  if(mode==='journal'){
   const P=require('../packages/learning/privacy.js');
   /* One fixed path would collide with the no-replace publication on every rerun, so the scheduled
    * job names a BASE and each run publishes a fresh timestamped sibling. */
   const file=P.journalTarget(env.CAPTURE_JOURNAL_FILE,Date.now());
   const receipt=await P.exportPrivacyJournal(db,{file,key,keyId:env.CAPTURE_KEY_ID});
   /* The scheduled publication records which epoch/digest it covers, so the backup-retention
    * obligation (a fresh journal is due before a restore is privacy-current) is a recorded fact. */
   const watermark=await db.query('SELECT learning.record_journal_watermark($1,$2,$3,$4,$5) AS value',
    [receipt.epoch,receipt.cipherSha256,receipt.plainSha256,receipt.records,env.CAPTURE_KEY_ID]);
   return {...receipt,file,watermark:watermark.rows[0].value};
  }
  if(mode==='restore-journal'){
   if(db.environment!=='test'&&!(db.target?.nonserving===true))throw Error('CAPTURE_RESTORE_ISOLATION_REQUIRED');
   return await require('../packages/learning/privacy.js').replayPrivacyJournal(db,{file:env.CAPTURE_JOURNAL_FILE,key,keyId:env.CAPTURE_KEY_ID,
    requiredEpoch:Number(env.CAPTURE_REQUIRED_PRIVACY_EPOCH),cipherSha256:env.CAPTURE_JOURNAL_SHA256,isolatedRestore:env.CAPTURE_ISOLATED_RESTORE==='1'});
  }
  pseudonymKey=readKey(env.CAPTURE_PSEUDONYM_KEY_FILE);
  return await require('../packages/learning/exporter.js').exportDataset(db,{directory:env.CAPTURE_EXPORT_DIR,key,keyId:env.CAPTURE_KEY_ID,pseudonymKey,
   splitSeed:'gameplay-opening6-v1-20261013',privacyEpoch:Number(env.CAPTURE_REQUIRED_PRIVACY_EPOCH),positions:env.CAPTURE_EXPORT_POSITIONS==='1',signal:abort.signal});
 }finally{key?.fill(0);pseudonymKey?.fill(0);process.removeListener('SIGTERM',handler);process.removeListener('SIGINT',handler);await db.end();}
}
if(require.main===module)main().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(/^(CAPTURE_[A-Z0-9_]+)/.exec(e.message||'')?.[1]||'CAPTURE_COMMAND_FAILED');process.exitCode=1;});
module.exports={main};
