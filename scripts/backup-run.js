'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const {snapshot,verify}=require('../server/production/backup');
const {secret}=require('../server/production/config');
function environment(source=process.env) {
 const env={...source};
 for(const name of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY'])env[name]=secret(source,name,true);
 if(!env.RESTIC_PASSWORD_FILE||!fs.statSync(env.RESTIC_PASSWORD_FILE).isFile())throw Error('BACKUP_PASSWORD_REQUIRED');
 if(!env.RESTIC_REPOSITORY?.startsWith('s3:https://'))throw Error('HTTPS_S3_REPOSITORY_REQUIRED');
 if(!/^\d+$/.test(env.MEGA_BACKUP_BUDGET_BYTES||''))throw Error('EXPLICIT_BACKUP_BUDGET_REQUIRED');
 return env;
}
async function restic(args,env) {return run('restic',[...args],{env,timeout:180000,maxBuffer:4*1024*1024});}
async function main(args=process.argv.slice(2)) {
 const env=environment(),command=args[0]||'once',work='/work',file=path.join(work,'mega.sqlite');
 fs.mkdirSync(work,{recursive:true,mode:0o700});
 if(command==='init') {
  if(args[1]!=='--confirm-new-repository')throw Error('INIT_CONFIRMATION_REQUIRED');
  await restic(['init','--repository-version','2'],env);return {event:'backup_repository_initialized'};
 }
 if(command==='check'){await restic(['check','--read-data-subset=10%'],env);return {event:'backup_repository_checked'};}
 if(command==='prune') {
  if(args[1]!=='--confirm-retention')throw Error('RETENTION_CONFIRMATION_REQUIRED');
  await restic(['forget','--tag','mega-xo-v4','--keep-within','24h','--keep-daily','7','--keep-weekly','4','--prune'],env);
  return {event:'backup_retention_applied'};
 }
 if(command==='retrieve') {
  if(!/^[a-f0-9]{64}$/.test(args[1]||''))throw Error('EXPLICIT_SNAPSHOT_ID_REQUIRED');
  const target=path.join(work,'recovery-'+args[1].slice(0,12));if(fs.existsSync(target))throw Error('RESTORE_TARGET_EXISTS');
  await restic(['restore',args[1],'--target',target],env);
  await verify(path.join(target,'work','mega.sqlite'));return {event:'backup_retrieved_and_verified',target};
 }
 if(command!=='once')throw Error('UNKNOWN_BACKUP_COMMAND');
 const stats=JSON.parse((await restic(['stats','--mode','raw-data','--json'],env)).stdout);
 if(!Number.isFinite(stats.total_size))throw Error('INVALID_REPOSITORY_STATS');
 const manifest=await snapshot(env.MEGA_DB||'/data/mega.sqlite',file);
 // Conservative reserve for a full new snapshot plus metadata. This is not a
 // cloud billing hard cap; use a free-only account and monitor provider usage.
 const budget=Number(env.MEGA_BACKUP_BUDGET_BYTES);
 if(stats.total_size+manifest.bytes*2+32*1024*1024>budget)throw Error('BACKUP_BUDGET_EXCEEDED');
 const host=env.MEGA_BACKUP_HOST||'mega-xo-production';if(!/^[a-z0-9-]{1,64}$/.test(host))throw Error('INVALID_BACKUP_HOST');
 const result=await restic(['backup','--json','--host',host,'--tag','mega-xo-v4',file,file+'.json'],env);
 const records=result.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const summary=records.findLast(x=>x.message_type==='summary');if(!summary?.snapshot_id)throw Error('BACKUP_RECEIPT_MISSING');
 const status={completedAt:Date.now(),snapshotId:summary.snapshot_id,bytes:manifest.bytes,sha256:manifest.sha256};
 const statusFile=env.MEGA_BACKUP_STATUS||'/backup-status/last-success.json';
 fs.writeFileSync(statusFile+'.tmp',JSON.stringify(status)+'\n',{mode:0o600});fs.renameSync(statusFile+'.tmp',statusFile);
 return {event:'offbox_backup_completed',snapshotId:status.snapshotId,bytes:status.bytes};
}
if(require.main===module)main().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(JSON.stringify({event:'backup_failed',code:/^[A-Z_]+$/.test(error.message)?error.message:'BACKUP_TRANSPORT_FAILED'}));process.exitCode=1;});
module.exports={main,environment};
