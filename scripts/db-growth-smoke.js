/* Synthetic aggregate growth benchmark. Never use a live database. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {performance}=require('node:perf_hooks');
const {DurableStore}=require('../server/economy-store');
const {migrate}=require('../server/production/migrations');
const {storageSnapshot}=require('../server/production/storage-health');

const integer=(name,fallback,min,max)=>{const raw=process.env[name]??String(fallback);if(!/^[0-9]+$/.test(raw))throw Error('INVALID_'+name);const n=Number(raw);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('INVALID_'+name);return n;};

async function run(){
 const accounts=integer('MEGA_GROWTH_ACCOUNTS',250,10,5000),historyPerAccount=integer('MEGA_GROWTH_HISTORY',200,10,2000);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-growth-')),file=path.join(dir,'growth.sqlite');
 let store=null;
 try{
  store=new DurableStore(file,{paidEntryEnabled:false,eligibility:()=>true});migrate(store.db);
  const authority=store.read(),seedStart=performance.now();
  for(let i=0;i<accounts;i++){
   const id='growth-'+i;authority.addAccount(id,{verified:true,coins:1000,crowns:100,rating:1200+(i%600),games:historyPerAccount});
   const account=authority.account(id);account.history=[];
   for(let n=0;n<historyPerAccount;n++)account.history.push({id:'h-'+i+'-'+n,at:1700000000000+n*60000,mode:n%3===0?'ranked':'casual',rated:n%3===0,queue:true,opponent:'growth-'+((i+n+1)%accounts),result:n%3===0?'win':n%3===1?'loss':'draw',activeSeconds:45+(n%120)});
  }
  const encoded=JSON.stringify(authority.export()),serializeMs=performance.now()-seedStart;
  const writeStart=performance.now();store.db.prepare('UPDATE state SET json=? WHERE id=1').run(encoded);const writeMs=performance.now()-writeStart;
  const reads=[];for(let i=0;i<5;i++){const start=performance.now();store.read();reads.push(performance.now()-start);}
  const quickStart=performance.now(),quick=store.db.prepare('PRAGMA quick_check').get().quick_check,quickCheckMs=performance.now()-quickStart;
  const sorted=reads.slice().sort((a,b)=>a-b),storage=storageSnapshot(store.db,file,{dbWarnBytes:1073741824,walWarnBytes:134217728,stateWarnBytes:67108864});
  const report={qualification:'Disposable synthetic aggregate-growth benchmark; never run against live player data.',generatedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model||null,accounts,historyPerAccount,historyRows:accounts*historyPerAccount,stateJsonBytes:Buffer.byteLength(encoded),serializeMs:Math.round(serializeMs*100)/100,writeMs:Math.round(writeMs*100)/100,readParseMs:reads.map(x=>Math.round(x*100)/100),readP95Ms:Math.round(sorted[Math.floor((sorted.length-1)*.95)]*100)/100,quickCheck:quick,quickCheckMs:Math.round(quickCheckMs*100)/100,storage};
  fs.mkdirSync('.artifacts',{recursive:true});fs.writeFileSync('.artifacts/v4-db-growth.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report,null,2)+'\n');return report;
 }finally{if(store)store.close();fs.rmSync(dir,{recursive:true,force:true});}
}
if(require.main===module)run().catch(error=>{console.error('DB_GROWTH_SMOKE_FAILED: '+error.message);process.exitCode=1;});
module.exports={run};
