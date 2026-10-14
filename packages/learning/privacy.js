'use strict';
/* Export a fresh, separately encrypted privacy journal before making a backup usable. An old
 * backup is never authoritative about later deletions. Replay requires an independently supplied
 * latest journal digest/epoch and an explicitly isolated, disabled collection target. */
const fs=require('node:fs').promises;
const path=require('node:path');
const {createWriter,readRecords}=require('./encrypted.js');
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
/* A scheduled journal export runs repeatedly, and publication is deliberately no-replace, so the
 * destination must be unique per run. The base path is operator configuration; the file is
 * `<base minus .mxojournal>-<YYYYMMDDTHHMMSSZ>.mxojournal`. The stamp is UTC and lexicographically
 * sortable, so "newest journal" is the last name and no previous file is ever overwritten or
 * deleted. A rerun inside the same second still fails closed with CAPTURE_JOURNAL_TARGET_EXISTS. */
function journalTarget(base,at=Date.now()){
 if(typeof base!=='string'||!base.length||base.length>1024)fail('CAPTURE_JOURNAL_BASE_REQUIRED');
 // A trailing separator names a directory, not a file: refuse rather than publish a sibling path.
 if(/[\\/]$/.test(base))fail('CAPTURE_JOURNAL_BASE_REQUIRED');
 const dir=path.dirname(base),name=path.basename(base);
 if(!name||name==='.'||name==='..'||dir==='')fail('CAPTURE_JOURNAL_BASE_REQUIRED');
 const stem=name.endsWith('.mxojournal')?name.slice(0,-'.mxojournal'.length):name;
 if(!stem||!/^[A-Za-z0-9._-]{1,160}$/.test(stem))fail('CAPTURE_JOURNAL_BASE_REQUIRED');
 if(!Number.isFinite(at)||at<0)fail('CAPTURE_JOURNAL_CLOCK');
 const stamp=new Date(Math.floor(at/1000)*1000).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
 return path.join(dir,stem+'-'+stamp+'.mxojournal');
}
async function clientFor(db){if(typeof db.connect!=='function')fail('CAPTURE_PINNED_CLIENT_REQUIRED');const client=await db.connect();return client;}
async function exportPrivacyJournal(db,{file,key,keyId}={}){
 const client=await clientFor(db);let writer,published=false,epoch;
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const config=(await client.query('SELECT learning.configuration() AS value')).rows[0].value;epoch=Number(config.privacyEpoch);
  if(!Number.isSafeInteger(epoch)||epoch<0)fail('CAPTURE_PRIVACY_EPOCH');
  writer=await createWriter(file,key,{keyId,kind:'privacy-journal'});
  await writer.write({type:'watermark',format:'privacy-journal/v1',epoch});let suppressions=0,erasures=0;
  for(const kind of ['privacy','erasure']){let after='';for(;;){
   const rows=(await client.query(kind==='privacy'?'SELECT * FROM learning.privacy_page($1,500)':'SELECT * FROM learning.erasure_page($1,500)',[after])).rows;
   if(!rows.length)break;
   for(const r of rows){const id=kind==='privacy'?r.actor_id:r.capture_id;if(id<=after)fail('CAPTURE_PRIVACY_ORDER');after=id;
    if(kind==='privacy'){await writer.write({type:'suppression',actorId:r.actor_id,reason:r.reason,epoch:Number(r.epoch)});suppressions++;}
    else{await writer.write({type:'erasure',captureId:r.capture_id});erasures++;}
   }
  }}
  await client.query('COMMIT');
  // A concurrent change makes this attempt stale; the caller retries a new immutable filename.
  const latest=(await client.query('SELECT learning.configuration() AS value')).rows[0].value;
  if(Number(latest.privacyEpoch)!==epoch)fail('CAPTURE_PRIVACY_SNAPSHOT_CHANGED');
  const receipt=await writer.finish();published=true;return {...receipt,epoch,suppressions,erasures};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});await writer?.abort().catch(()=>{});
  if(published)await fs.unlink(file).catch(()=>{});
  throw mapStorageFailure(e);}
 finally{client.release();}
}
/* A no-replace publication collides when the caller names a fixed file, which is exactly what the
 * scheduled job used to do. Report that as a CAPTURE_-prefixed diagnostic rather than the CLI's
 * generic catch-all, and never remove the existing file. */
function mapStorageFailure(e){
 const code=e?.code||e?.cause?.code;
 if(code==='EEXIST')return Object.assign(new Error('CAPTURE_JOURNAL_TARGET_EXISTS'),{code:'CAPTURE_JOURNAL_TARGET_EXISTS',cause:e});
 if(code==='ENOENT'||code==='ENOTDIR')return Object.assign(new Error('CAPTURE_JOURNAL_DIRECTORY_MISSING'),{code:'CAPTURE_JOURNAL_DIRECTORY_MISSING',cause:e});
 if(code==='EACCES'||code==='EPERM'||code==='EROFS')return Object.assign(new Error('CAPTURE_JOURNAL_STORAGE_DENIED'),{code:'CAPTURE_JOURNAL_STORAGE_DENIED',cause:e});
 if(code==='ENOSPC'||code==='EDQUOT')return Object.assign(new Error('CAPTURE_JOURNAL_STORAGE_FULL'),{code:'CAPTURE_JOURNAL_STORAGE_FULL',cause:e});
 if(/^CAPTURE_/.test(e?.message||''))return e;
 return Object.assign(new Error('CAPTURE_JOURNAL_FAILED'),{code:'CAPTURE_JOURNAL_FAILED',cause:e});
}
async function replayPrivacyJournal(db,{file,key,keyId,requiredEpoch,cipherSha256,isolatedRestore=false}={}){
 if(isolatedRestore!==true||!Number.isSafeInteger(requiredEpoch)||requiredEpoch<0||!/^[a-f0-9]{64}$/.test(cipherSha256||''))fail('CAPTURE_RESTORE_AUTHORIZATION_REQUIRED');
 const client=await clientFor(db);let entries=0,watermark=false;
 try{
  const config=(await client.query('SELECT learning.configuration() AS value')).rows[0].value;
  if(config.enabled)fail('CAPTURE_RESTORE_TARGET_ENABLED');
  await client.query('BEGIN');
  for await(const r of readRecords(file,key,{keyId,kind:'privacy-journal',cipherSha256})){
   if(!watermark){if(r?.type!=='watermark'||r.format!=='privacy-journal/v1'||r.epoch!==requiredEpoch||Object.keys(r).sort().join(',')!=='epoch,format,type')fail('CAPTURE_RESTORE_STALE_JOURNAL');watermark=true;continue;}
   if(r?.type==='suppression'){
    if(Object.keys(r).sort().join(',')!=='actorId,epoch,reason,type'||typeof r.actorId!=='string'||!r.actorId||r.actorId.length>160||/[\u0000-\u001f]/.test(r.actorId)||!['account-deletion','user-choice'].includes(r.reason)||!Number.isSafeInteger(r.epoch)||r.epoch<=0||r.epoch>requiredEpoch)fail('CAPTURE_PRIVACY_RECORD');
    await client.query('SELECT learning.suppress($1,$2)',[r.actorId,r.reason]);
   }else if(r?.type==='erasure'){
    if(Object.keys(r).sort().join(',')!=='captureId,type'||!/^[a-f0-9]{64}$/.test(r.captureId))fail('CAPTURE_PRIVACY_RECORD');
    await client.query('SELECT learning.replay_erasure($1)',[r.captureId]);
   }else fail('CAPTURE_PRIVACY_RECORD');entries++;
  }
  if(!watermark)fail('CAPTURE_RESTORE_STALE_JOURNAL');
  await client.query('SELECT learning.restore_watermark($1)',[requiredEpoch]);
  for(;;){const n=(await client.query('SELECT learning.erase(500) AS n')).rows[0].n;if(!n)break;}
  const target=(await client.query('SELECT learning.configuration() AS value')).rows[0].value;
  if(target.enabled||Number(target.privacyEpoch)<requiredEpoch)fail('CAPTURE_RESTORE_PRIVACY_FENCE');
  await client.query('COMMIT');return {sourceEpoch:requiredEpoch,targetEpoch:Number(target.privacyEpoch),entries,enabled:false};
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
module.exports={exportPrivacyJournal,replayPrivacyJournal,journalTarget,mapStorageFailure};
