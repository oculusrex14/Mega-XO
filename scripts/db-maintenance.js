'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {storageSnapshot}=require('../server/production/storage-health');

const positive=(env,key,fallback)=>{const raw=env[key]??String(fallback);if(!/^[0-9]+$/.test(raw))throw Error('INVALID_'+key);const n=Number(raw);if(!Number.isSafeInteger(n)||n<1)throw Error('INVALID_'+key);return n;};
const tableExists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function limits(env){return {dbWarnBytes:positive(env,'MEGA_DB_WARN_BYTES',1073741824),walWarnBytes:positive(env,'MEGA_WAL_WARN_BYTES',134217728),stateWarnBytes:positive(env,'MEGA_STATE_WARN_BYTES',67108864)};}
function activeWork(db){
 let matches=0,rooms=0;
 if(tableExists(db,'state')){
  const row=db.prepare('SELECT json FROM state WHERE id=1').get();
  if(row){
   const state=JSON.parse(row.json),list=Array.isArray(state.matches)?state.matches:[];
   matches=list.filter(x=>x&&x[1]&&['PLAYING','OFFERED'].includes(x[1].status)).length;
  }
 }
 if(tableExists(db,'party_rooms'))rooms=Number(db.prepare("SELECT count(*) AS n FROM party_rooms WHERE json_extract(json,'$.status') IN ('LOBBY','RUNNING','PAUSED')").get().n||0);
 return {matches,rooms,total:matches+rooms};
}
function requireMaintenance(db,args){
 if(!args.includes('--confirm-maintenance'))throw Error('CONFIRM_MAINTENANCE_REQUIRED');
 if(!tableExists(db,'v4_controls')||db.prepare('SELECT maintenance FROM v4_controls WHERE id=1').get()?.maintenance!==1)throw Error('MAINTENANCE_REQUIRED');
 const active=activeWork(db);if(active.total)throw Error('ACTIVE_WORK_PRESENT');return active;
}
function integrity(db){
 const quick=db.prepare('PRAGMA quick_check').all().map(row=>row.quick_check);
 if(quick.length!==1||quick[0]!=='ok')throw Error('DATABASE_INTEGRITY_FAILED');
 const foreign=db.prepare('PRAGMA foreign_key_check').all();
 if(foreign.length)throw Error('FOREIGN_KEY_INTEGRITY_FAILED');
 return {ok:true,quickCheck:'ok',foreignKeyViolations:0};
}
async function main(args=process.argv.slice(2),env=process.env){
 const command=args[0]||'status',file=env.MEGA_DB||'/data/mega.sqlite';
 if(!path.isAbsolute(file)||!fs.existsSync(file))throw Error('DATABASE_FILE_REQUIRED');
 const write=['checkpoint','optimize'].includes(command),db=new DatabaseSync(file,{readOnly:!write});
 try{
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  if(command==='status')return storageSnapshot(db,file,limits(env));
  if(command==='check')return {...integrity(db),storage:storageSnapshot(db,file,limits(env))};
  if(command==='checkpoint'){
   const active=requireMaintenance(db,args),before=storageSnapshot(db,file,limits(env)),row=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
   if(Number(row.busy||0)!==0)throw Error('WAL_CHECKPOINT_BUSY');
   return {ok:true,command,active,before,checkpoint:{busy:Number(row.busy||0),logFrames:Number(row.log||0),checkpointedFrames:Number(row.checkpointed||0)},after:storageSnapshot(db,file,limits(env))};
  }
  if(command==='optimize'){
   const active=requireMaintenance(db,args),before=storageSnapshot(db,file,limits(env));
   db.exec('PRAGMA optimize;');
   return {ok:true,command,active,before,after:storageSnapshot(db,file,limits(env))};
  }
  throw Error('UNKNOWN_DATABASE_COMMAND');
 }finally{db.close();}
}
if(require.main===module)main().then(x=>process.stdout.write(JSON.stringify(x)+'\n')).catch(error=>{console.error('DATABASE_MAINTENANCE_FAILED: '+error.message);process.exitCode=1;});
module.exports={main,integrity,activeWork,requireMaintenance};
