'use strict';
/* Read-only provider counters. These requests do not connect to PostgreSQL.
 * Compute-unit seconds and wall-clock uptime are distinct measurements.
 * Usage: node scripts/v5/neon-usage-snapshot.cjs --project ID --key-file /private/key [--output report.json]
 * NEON_API_KEY may be supplied instead of --key-file. Never logs credentials.
 */
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
async function main(){
 const projectId=arg('--project');
 if(!/^[a-z0-9-]{4,80}$/.test(projectId||''))throw Error('PROJECT_ID_REQUIRED');
 const keyFile=arg('--key-file');
 let key=process.env.NEON_API_KEY;
 if(keyFile){
  const st=fs.lstatSync(keyFile);
  if(!path.isAbsolute(keyFile)||!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw Error('PRIVATE_KEY_FILE_REQUIRED');
  key=fs.readFileSync(keyFile,'utf8').trim();
 }
 if(!key)throw Error('NEON_API_KEY_REQUIRED');
 const get=async suffix=>{
  const response=await fetch('https://console.neon.tech/api/v2/projects/'+projectId+suffix,
   {headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('NEON_READ_FAILED_'+response.status);
  return response.json();
 };
 const before=(await get('')).project;
 const usage=await get('/consumption');
 const after=(await get('')).project;
 if(before.id!==projectId||after.id!==projectId||!before.consumption_period_start||
    before.consumption_period_start!==after.consumption_period_start)throw Error('BILLING_PERIOD_CHANGED');
 const counters={activeTimeSeconds:after.active_time_seconds,
  computeTimeSeconds:usage.compute_time_seconds,dataTransferBytes:usage.data_transfer_bytes};
 if(Object.values(counters).some(v=>!Number.isSafeInteger(v)||v<0))throw Error('PROVIDER_COUNTER_UNAVAILABLE');
 const snapshot={format:'mega-v5-neon-usage-snapshot/v2',sampledAtUtc:new Date().toISOString(),
  projectId,consumptionPeriodStart:after.consumption_period_start,...counters,
  metricSources:{activeTimeSeconds:'project.active_time_seconds',computeTimeSeconds:'consumption.compute_time_seconds',
   dataTransferBytes:'consumption.data_transfer_bytes'}};
 const encoded=JSON.stringify(snapshot,null,2)+'\n',output=arg('--output');
 if(output){fs.writeFileSync(output,encoded,{flag:'wx',mode:0o644});}
 process.stdout.write(encoded);
}
if(require.main===module)main().catch(()=>{process.stderr.write('NEON_SNAPSHOT_FAILED (no credentials or provider body logged)\n');process.exitCode=2;});
