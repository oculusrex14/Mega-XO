'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {DurableStore}=require('../server/economy-store');
const {config}=require('../server/production/config');
const {createRuntime}=require('../server/production/main');
const ROOT=path.resolve(__dirname,'..');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
test('production restart refunds unresolved escrow exactly once and preserves identity data',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-recovery-')),file=path.join(dir,'db');
 const old=new DurableStore(file,{paidEntryEnabled:true,eligibility:()=>true});let a=old.read();
 a.addAccount('alice',{verified:true,games:50,rating:1500,coins:500});a.addAccount('bob',{verified:true,games:50,rating:1500,coins:500});
 const offer=a.offerQueue('interrupted','alice','bob','ranked');a.accept('interrupted','alice',offer.termsHash);a.accept('interrupted','bob',offer.termsHash);
 old.db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(a.export()));assert(a.account('alice').reservedCoins>0);old.close();
 const cfg={...config({MEGA_ORIGIN:'https://game.test',MEGA_OTP_SECRET:'a'.repeat(64),MEGA_PROXY_SECRET:'b'.repeat(64)}),file,host:'127.0.0.1',port:0,adminPort:0};
 let runtime=await createRuntime(cfg);a=runtime.service.store.read();assert.equal(a.account('alice').coins,500);assert.equal(a.account('alice').reservedCoins,0);assert.equal(a.account('alice').rating,1500);assert.equal(a.view('interrupted').status,'VOID');
 const refunded=a.journal.filter(x=>x.reason==='Match refund').length;assert.equal(refunded,2);await runtime.close();
 runtime=await createRuntime(cfg);assert.equal(runtime.service.store.read().journal.filter(x=>x.reason==='Match refund').length,refunded);await runtime.close();
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
});
test('Linux production launcher rejects a second coordinator and releases lock after shutdown',{skip:process.platform!=='linux',timeout:20000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v4-lock-')),children=[];
 t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});});
 const env={...process.env,MEGA_ENV:'staging',MEGA_ORIGIN:'https://game.test',MEGA_DB:path.join(dir,'db'),MEGA_OTP_SECRET:'a'.repeat(64),MEGA_PROXY_SECRET:'b'.repeat(64),MEGA_BIND:'127.0.0.1',PORT:String(await port()),MEGA_METRICS_PORT:String(await port()),RESEND_API_KEY:''};
 async function start(){const child=spawn('sh',['deploy/run.sh'],{cwd:ROOT,env});children.push(child);let output='';await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('STARTUP_TIMEOUT')),8000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('service_ready')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);if(!output.includes('service_ready'))reject(Error('STARTUP_EXIT_'+code));});});return child;}
 const first=await start(),second=spawn('sh',['deploy/run.sh'],{cwd:ROOT,env});children.push(second);const [code]=await once(second,'exit');assert.equal(code,73);
 const exit=once(first,'exit');first.kill('SIGTERM');assert.equal((await exit)[0],0);
 const restarted=await start(),done=once(restarted,'exit');restarted.kill('SIGTERM');assert.equal((await done)[0],0);
});
