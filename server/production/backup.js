'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const {inspect}=require('./migrations');
async function digest(file) {const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function syncFile(file){const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncDirectory(directory){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function check(file) {
 const db=new DatabaseSync(file,{readOnly:true});
 try {
  const rows=db.prepare('PRAGMA integrity_check').all();if(rows.length!==1||rows[0].integrity_check!=='ok')throw Error('BACKUP_INTEGRITY_FAILED');
  const state=db.prepare('SELECT json FROM state WHERE id=1').get();if(!state)throw Error('BACKUP_STATE_MISSING');
  const parsed=JSON.parse(state.json);if(!Array.isArray(parsed.accounts)||!Array.isArray(parsed.receipts)||!Array.isArray(parsed.matches))throw Error('BACKUP_STATE_INVALID');
  return {schema:inspect(db).length,accounts:parsed.accounts.length};
 } finally {db.close();}
}
async function snapshot(source,target) {
 source=path.resolve(source);target=path.resolve(target);
 if(source===target||!fs.existsSync(source))throw Error('INVALID_BACKUP_PATH');
 const dir=path.dirname(target);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const free=fs.statfsSync(dir);if(free.bavail*free.bsize<fs.statSync(source).size*2+64*1024*1024)throw Error('INSUFFICIENT_BACKUP_DISK');
 const tmp=target+'.tmp-'+crypto.randomUUID(),db=new DatabaseSync(source,{readOnly:true});
 try {
  await backup(db,tmp);fs.chmodSync(tmp,0o600);const status=check(tmp);
  const manifest={version:1,createdAt:Date.now(),sha256:await digest(tmp),bytes:fs.statSync(tmp).size,schema:status.schema};
  syncFile(tmp);fs.renameSync(tmp,target);
  fs.writeFileSync(target+'.json.tmp',JSON.stringify(manifest)+'\n',{mode:0o600});syncFile(target+'.json.tmp');fs.renameSync(target+'.json.tmp',target+'.json');syncDirectory(dir);
  return manifest;
 } finally {db.close();if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
async function verify(file) {
 const text=fs.readFileSync(file+'.json','utf8');if(text.length>8192)throw Error('INVALID_BACKUP_MANIFEST');const manifest=JSON.parse(text);
 if(manifest.version!==1||!Number.isSafeInteger(manifest.createdAt)||!Number.isSafeInteger(manifest.bytes)||manifest.bytes!==fs.statSync(file).size||manifest.sha256!==await digest(file))throw Error('BACKUP_CHECKSUM_MISMATCH');
 const status=check(file);if(manifest.schema!==status.schema)throw Error('BACKUP_SCHEMA_MISMATCH');return manifest;
}
// Call ONLY under the same exclusive coordinator lock as the runtime launcher.
// Stop the app first. No online rollback silently rewinds the financial database.
async function restore(source,target,{confirm=false}={}) {
 source=path.resolve(source);target=path.resolve(target);
 if(!confirm||source===target)throw Error('RESTORE_CONFIRMATION_REQUIRED');
 await verify(source);const dir=path.dirname(target);fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const prior=path.join(dir,'pre-restore-'+Date.now()+'.sqlite');if(fs.existsSync(target))await snapshot(target,prior);
 const candidate=target+'.restore-'+crypto.randomUUID();fs.copyFileSync(source,candidate,fs.constants.COPYFILE_EXCL);fs.chmodSync(candidate,0o600);check(candidate);syncFile(candidate);
 for(const suffix of ['-wal','-shm'])if(fs.existsSync(target+suffix))fs.renameSync(target+suffix,prior+suffix);
 fs.renameSync(candidate,target);syncDirectory(dir);return {restored:true,previousSnapshot:fs.existsSync(prior)?prior:null};
}
if(require.main===module) {
 const [command,source,target,confirmation]=process.argv.slice(2);
 (async()=>{
  if(command==='snapshot')return snapshot(source,target);
  if(command==='verify')return verify(source);
  if(command==='restore'){
   if(process.env.MEGA_COORDINATOR_LOCKED!=='1')throw Error('RESTORE_LOCK_REQUIRED');
   return restore(source,target,{confirm:confirmation==='--confirm-replace'});
  }
  throw Error('USE_SNAPSHOT_VERIFY_OR_RESTORE');
 })().then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'BACKUP_OPERATION_FAILED');process.exitCode=1;});
}
module.exports={snapshot,verify,restore,digest,check};
