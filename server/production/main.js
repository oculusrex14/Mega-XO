'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {setTimeout:sleep}=require('node:timers/promises');
const {buildService}=require('../community-server');
const {maintenance}=require('../jobs');
const {config:loadConfig}=require('./config');
const {preflight,migrate,control,inspect}=require('./migrations');
const {Passwords}=require('./passwords');
const {ReadContext}=require('./read-context');
const {MailOutbox}=require('./mail-outbox');
const {EmailAuth}=require('./email-auth');
const {createPerimeter,Telemetry,json}=require('./perimeter');
function recover(service) {
 const c=service.community;
 c.tx(()=>{
  // Pre-OTP sessions must not survive the first production rollout. Do not
  // silently trust a legacy account's verified flag as proof of mailbox control.
  c.db.exec('DELETE FROM session_presence WHERE actor IN (SELECT actor FROM email_credentials WHERE verified_at IS NULL); DELETE FROM account_sessions WHERE actor IN (SELECT actor FROM email_credentials WHERE verified_at IS NULL);');
  c.db.exec('UPDATE email_challenges SET consumed=1 WHERE id NOT IN (SELECT challenge FROM v4_email_versions)');
 });
 const authority=service.store.read();
 for(const match of authority.matches.values()) if(['PLAYING','OFFERED'].includes(match.status)) {
  const key='recovery:'+crypto.createHash('sha256').update(match.id).digest('hex');
  service.store.run({actor:'recovery',scope:'operator'},key,{type:'void',id:match.id,reason:'Server restart'});
 }
 service.rooms.recover();
}
async function createRuntime(config,{transport,log=()=>{}}={}) {
 process.umask(0o077);
 fs.mkdirSync(path.dirname(config.file),{recursive:true,mode:0o700});preflight(config.file);
 // Production never exposes the old process's synchronous email handler: the
 // perimeter owns the same email route and delegates to the isolated service.
 const service=buildService({file:config.file,origin:config.origin,providers:config.providers,storeOptions:{otpSecret:config.otpSecret,paidEntryEnabled:false},emailInstance:{enabled:()=>false},monetizationOptions:{adMode:'off',purchasesEnabled:false}});
 let telemetry,passwords,outbox,metrics,timer,slowTimer,reads,closed=false;
 try {
  migrate(service.store.db);service.rooms.db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
  recover(service);
  service.matchmaker.maxTickets=config.maxQueued||200;
  reads=new ReadContext(service.store);
  telemetry=new Telemetry(log);passwords=new Passwords({concurrency:config.authWorkers});
  outbox=new MailOutbox(service.community,{secret:config.otpSecret,daily:config.mailDaily,monthly:config.mailMonthly,email:config.email,transport,log:value=>telemetry.event(value)});
  const emailAuth=new EmailAuth(service.community,{passwords,outbox,secret:config.otpSecret});
  let lastWorker=Date.now(),workerError=false,maintenanceError=false;
  const state={ready:false,draining:false,maintenance:()=>control(service.store.db),healthy:()=>{
   try {return state.ready&&!state.draining&&!state.maintenance()&&!workerError&&!maintenanceError&&Date.now()-lastWorker<30000&&service.store.db.prepare('SELECT 1 AS ok').get().ok===1;}catch{return false;}
  }};
  const fast=()=>{try{if(!state.maintenance())service.matchmaker.tick();service.rooms.tick();lastWorker=Date.now();workerError=false;}catch{workerError=true;telemetry.event({event:'game_worker_failed'});}outbox.tick();};
  const slow=()=>{try{maintenance(service.store);service.community.cleanup();outbox.cleanup();service.store.db.prepare('DELETE FROM v4_email_versions WHERE challenge NOT IN (SELECT id FROM email_challenges)').run();maintenanceError=false;}catch{maintenanceError=true;telemetry.event({event:'maintenance_failed'});}};
  slow();fast();timer=setInterval(fast,1000);timer.unref();slowTimer=setInterval(slow,15000);slowTimer.unref();
  const handler=createPerimeter({service,config,emailAuth,telemetry,state});
  service.server.removeAllListeners('request');service.server.on('request',(req,res)=>reads.run(()=>handler(req,res)));
  Object.assign(service.server,{requestTimeout:10000,headersTimeout:10000,keepAliveTimeout:5000,maxRequestsPerSocket:500,maxHeadersCount:100});
  service.server.setTimeout(30000,socket=>socket.destroy());
  const backupStatus=()=>{
   try{const stat=fs.statSync(config.backupStatus);if(stat.size>8192)throw Error();const b=JSON.parse(fs.readFileSync(config.backupStatus,'utf8'));const age=Date.now()-b.completedAt;return {fresh:Number.isFinite(age)&&age>=0&&age<1800000,ageSeconds:Math.floor(age/1000)};}catch{return {fresh:false,ageSeconds:null};}
  };
  const snapshot=()=>({ok:state.healthy(),maintenance:state.maintenance(),release:config.release,schema:inspect(service.store.db).length,uptimeSeconds:Math.floor(process.uptime()),...telemetry.snapshot(),requestReads:{reused:reads.hits,loaded:reads.misses},queued:service.matchmaker.tickets.size,backup:backupStatus(),mail:service.store.db.prepare('SELECT state,count(*) AS count FROM v4_outbox GROUP BY state').all()});
  // Never proxied by Caddy; Docker publishes this port to host loopback only.
  metrics=http.createServer((req,res)=>{if(req.method!=='GET')return json(res,405,{error:'METHOD_NOT_ALLOWED'});if(req.url!=='/status')return json(res,404,{error:'NOT_FOUND'});return json(res,200,snapshot());});
  await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(config.port,config.host,resolve);});
  await new Promise((resolve,reject)=>{metrics.once('error',reject);metrics.listen(config.adminPort,config.host,resolve);});
  state.ready=true;telemetry.event({event:'service_ready'});
  return {service,state,telemetry,passwords,outbox,emailAuth,metrics,snapshot,async close(){
   if(closed)return;closed=true;state.draining=true;clearInterval(timer);clearInterval(slowTimer);outbox.close();passwords.close();
   service.server.close();service.server.closeIdleConnections?.();metrics.close();metrics.closeIdleConnections?.();
   const until=Date.now()+config.drainMs;
   while((telemetry.inflight||outbox.active||passwords.active)&&Date.now()<until)await sleep(25);
   metrics.closeAllConnections?.();reads.close();await service.close();telemetry.event({event:'service_stopped'});telemetry.close();
  }};
 } catch(error) {
  clearInterval(timer);clearInterval(slowTimer);passwords?.close();outbox?.close();telemetry?.close();metrics?.close();reads?.close();await service.close();throw error;
 }
}
if(require.main===module) {
 const log=value=>process.stdout.write(JSON.stringify({...value,at:new Date().toISOString()})+'\n');
 (async()=>{
  const config=loadConfig();
  if(process.argv.includes('--check-config')){log({event:'config_valid',stage:config.stage,origin:config.origin,emailEnabled:!!config.email.apiKey});return;}
  if(process.env.MEGA_COORDINATOR_LOCKED!=='1')throw Error('USE_PRODUCTION_LAUNCHER');
  const runtime=await createRuntime(config,{log});let stopping=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await runtime.close();process.exit(0);});
 })().catch(error=>{log({event:'startup_failed',code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'STARTUP_FAILED'});process.exitCode=1;});
}
module.exports={createRuntime,recover};
