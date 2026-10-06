'use strict';
const fs=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const {inspect}=require('../server/production/migrations');
async function main(args=process.argv.slice(2)) {
 const file=process.env.MEGA_DB||'/data/mega.sqlite',command=args[0];
 if(command==='status'||command==='health') {
  const response=await fetch('http://127.0.0.1:'+(process.env.MEGA_METRICS_PORT||9091)+'/status',{signal:AbortSignal.timeout(3000)});
  if(!response.ok)throw Error('SERVICE_UNAVAILABLE');const value=await response.json();
  const disk=fs.statfsSync(file);value.diskUsedFraction=1-disk.bavail/disk.blocks;
  if(command==='health'&&(!value.ok||value.diskUsedFraction>0.8||(args.includes('--require-backup')&&!value.backup.fresh)))process.exitCode=2;
  return value;
 }
 const db=new DatabaseSync(file,{readOnly:command!=='maintenance'});
 try {
  inspect(db);db.exec('PRAGMA busy_timeout=1000');
  if(command==='maintenance') {
   if(!['on','off'].includes(args[1]))throw Error('USE_MAINTENANCE_ON_OR_OFF');
   db.prepare('UPDATE v4_controls SET maintenance=? WHERE id=1').run(args[1]==='on'?1:0);return {maintenance:args[1]==='on'};
  }
  if(command==='active') {
   const state=JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json);
   const matches=state.matches.filter(([,m])=>m.status==='PLAYING').length;
   const rooms=db.prepare("SELECT count(*) n FROM party_rooms WHERE json_extract(json,'$.status')='RUNNING'").get().n;
   return matches+rooms;
  }
  throw Error('UNKNOWN_OPERATOR_COMMAND');
 } finally {db.close();}
}
if(require.main===module)main().then(x=>console.log(JSON.stringify(x))).catch(()=>{console.error('OPERATION_FAILED');process.exitCode=1;});
module.exports={main};
