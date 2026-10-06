'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {setTimeout:sleep}=require('node:timers/promises');
const {buildService}=require('../community-server');
const {maintenance}=require('../jobs');
const {config:loadConfig}=require('./config');
const {preflight,migrate,control,inspect}=require('./migrations');
const {storageSnapshot}=require('./storage-health');
const {Passwords}=require('./passwords');
const {ReadContext}=require('./read-context');
const {MailOutbox}=require('./mail-outbox');
const {EmailAuth}=require('./email-auth');
const {createPerimeter,Telemetry,json}=require('./perimeter');
const {OperatorService}=require('./operator-service');
const {GooglePlayBilling}=require('../google-play-billing');
const {GooglePushAuth}=require('../google-push-auth');
const {GooglePlayNotifications}=require('../google-play-notifications');
const {AppleStoreKit}=require('../apple-storekit');
const {AppleStoreNotifications}=require('../apple-store-notifications');
const {StorePurchaseProvider}=require('../store-purchase-provider');
const {createAdMobVerifier}=require('../admob-ssv');
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
 const storeConfigured=!!(config.purchases.googlePlay||config.purchases.appleStore);
 const purchaseProviderFactory=storeConfigured?(store)=>{
  const google=config.purchases.googlePlay?new GooglePlayBilling(store.db,config.purchases.googlePlay):null,apple=config.purchases.appleStore?new AppleStoreKit(store.db,config.purchases.appleStore):null;
  return new StorePurchaseProvider({google,apple});
 }:null;
 const notificationFactory=storeConfigured?({store,monetization,purchaseProvider})=>({
  google:purchaseProvider.google?new GooglePlayNotifications(store.db,{billing:purchaseProvider.google,auth:new GooglePushAuth({audience:config.purchases.googlePlay.pubsubAudience,email:config.purchases.googlePlay.pubsubServiceAccount}),monetization,packageName:config.purchases.googlePlay.packageName}):null,
  apple:purchaseProvider.apple?new AppleStoreNotifications(store.db,{storeKit:purchaseProvider.apple,monetization}):null
 }):null;
 const verifyAd=config.ads?.mode&&config.ads.mode!=='off'?createAdMobVerifier():null;
 const service=buildService({file:config.file,origin:config.origin,providers:config.providers,storeOptions:{otpSecret:config.otpSecret,paidEntryEnabled:false},communityOptions:{deletionPolicy:{enabled:config.privacy.deletionEnabled,policyVersion:config.privacy.policyVersion}},emailInstance:{enabled:()=>false},monetizationOptions:{adMode:config.ads?.mode||'off',adUnits:config.ads?.platforms||{},rewardItem:'cosmetic_reward',verifyAd,purchasesEnabled:config.purchases.enabled,eligible:()=>true,purchaseProviderFactory,notificationFactory}});
 let telemetry,passwords,outbox,metrics,timer,slowTimer,reads,closed=false;
 try {
  migrate(service.store.db);service.rooms.db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
  recover(service);
  service.matchmaker.maxTickets=config.maxQueued||200;
  reads=new ReadContext(service.store);
  telemetry=new Telemetry(log,service.store.db);passwords=new Passwords({concurrency:config.authWorkers});
  outbox=new MailOutbox(service.community,{secret:config.otpSecret,daily:config.mailDaily,monthly:config.mailMonthly,email:config.email,transport,log:value=>telemetry.event(value)});
  const emailAuth=new EmailAuth(service.community,{passwords,outbox,secret:config.otpSecret});
  const operatorService=new OperatorService(service,{secret:config.proxySecret});
  service.community.securityNotify=(actor,event,details={})=>{
   const to=service.community.emailAddress(actor);if(!to)return;
   const provider=typeof details.provider==='string'?details.provider:'',count=Number.isInteger(details.count)?details.count:null;
   const detail=event==='provider_linked'?'A '+provider+' sign-in method was linked.':event==='provider_unlinked'?'The '+provider+' sign-in method was removed.':event==='other_sessions_revoked'?(count===null?'Other sessions were signed out.':count+' other session'+(count===1?' was':'s were')+' signed out.'):'A signed-in session was revoked.';
   try{outbox.enqueue('security-'+crypto.randomUUID(),{to,event,detail},Date.now()+86400000,'security');}catch{telemetry?.event?.({event:'security_notice_not_queued'});}
  };
  let lastWorker=Date.now(),workerError=false,maintenanceError=false;
  const state={ready:false,draining:false,maintenance:()=>control(service.store.db),operational:()=>false,healthy:()=>{
   try {return state.ready&&!state.draining&&!state.maintenance()&&!workerError&&!maintenanceError&&Date.now()-lastWorker<30000&&service.store.db.prepare('SELECT 1 AS ok').get().ok===1;}catch{return false;}
  }};
  const fast=()=>{try{if(!state.maintenance())service.matchmaker.tick();service.rooms.tick();lastWorker=Date.now();workerError=false;}catch{workerError=true;telemetry.event({event:'game_worker_failed'});}outbox.tick();service.monetization.processPurchaseFinalizations().catch(()=>telemetry.event({event:'purchase_finalization_retry'}));};
  const slow=()=>{try{maintenance(service.store);service.community.cleanup();outbox.cleanup();service.store.db.prepare("DELETE FROM v4_limits WHERE id LIKE 'abuse:%' AND expires<?").run(Date.now());service.store.db.prepare('DELETE FROM v4_email_versions WHERE challenge NOT IN (SELECT id FROM email_challenges)').run();service.store.db.prepare('DELETE FROM v41_support_events WHERE at<?').run(Date.now()-7*86400000);maintenanceError=false;}catch{maintenanceError=true;telemetry.event({event:'maintenance_failed'});}};
  slow();fast();timer=setInterval(fast,1000);timer.unref();slowTimer=setInterval(slow,15000);slowTimer.unref();
  const handler=createPerimeter({service,config,emailAuth,telemetry,state});
  service.server.removeAllListeners('request');service.server.on('request',(req,res)=>reads.run(()=>handler(req,res)));
  Object.assign(service.server,{requestTimeout:10000,headersTimeout:10000,keepAliveTimeout:5000,maxRequestsPerSocket:250,maxHeadersCount:100,maxConnections:config.maxConnections});
  service.server.setTimeout(30000,socket=>socket.destroy());
  const backupStatus=()=>{
   try{const stat=fs.statSync(config.backupStatus);if(stat.size>8192)throw Error();const b=JSON.parse(fs.readFileSync(config.backupStatus,'utf8'));const age=Date.now()-b.completedAt;return {fresh:Number.isFinite(age)&&age>=0&&age<1800000,ageSeconds:Math.floor(age/1000)};}catch{return {fresh:false,ageSeconds:null};}
  };
  const diskStatus=()=>{try{const d=fs.statfsSync(path.dirname(config.file)),free=d.bavail*d.bsize,total=d.blocks*d.bsize,usedFraction=total>0?1-free/total:1;return {healthy:free>=1024*1024*1024&&usedFraction<0.9,freeBytes:free,usedFraction};}catch{return {healthy:false,freeBytes:null,usedFraction:null};}};
  state.operational=()=>state.healthy()&&backupStatus().fresh&&diskStatus().healthy;
  const snapshot=()=>({ok:state.healthy(),operational:state.operational(),maintenance:state.maintenance(),release:config.release,schema:inspect(service.store.db).length,uptimeSeconds:Math.floor(process.uptime()),...telemetry.snapshot(),requestReads:{reused:reads.hits,loaded:reads.misses},queued:service.matchmaker.tickets.size,backup:backupStatus(),disk:diskStatus(),storage:storageSnapshot(service.store.db,config.file,config.storage),mail:service.store.db.prepare('SELECT state,count(*) AS count FROM v4_outbox GROUP BY state').all()});
  // Never proxied by Caddy; Docker publishes this port to host loopback only.
  metrics=http.createServer(async(req,res)=>{
   try{
    if(req.method==='GET'&&req.url==='/status')return json(res,200,snapshot());
    if(req.method==='POST'&&req.url==='/operator'){
     if(!operatorService.authenticate(String(req.headers['x-mega-operator-key']||'')))return json(res,403,{error:'FORBIDDEN'});
     let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>8192)throw Error('BODY_TOO_LARGE');}
     let body;try{body=JSON.parse(text||'{}');}catch{throw Error('BAD_REQUEST');}
     return json(res,200,operatorService.command(body));
    }
    return json(res,req.method==='GET'||req.method==='POST'?404:405,{error:req.method==='GET'||req.method==='POST'?'NOT_FOUND':'METHOD_NOT_ALLOWED'});
   }catch(error){
    const code=/^[A-Z0-9_]+$/.test(error.message)?error.message:'OPERATOR_FAILED';
    return json(res,['PLAYER_NOT_FOUND','SUPPORT_EVENT_NOT_FOUND'].includes(code)?404:['INVALID_SUPPORT_ID','INVALID_OPERATOR','INVALID_REASON','INVALID_LOOKUP','INVALID_LIMIT','INVALID_OPERATOR_ACTION','INVALID_OPERATOR_REQUEST','BODY_TOO_LARGE','BAD_REQUEST'].includes(code)?400:409,{error:code});
   }
  });
  await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(config.port,config.host,resolve);});
  await new Promise((resolve,reject)=>{metrics.once('error',reject);metrics.listen(config.adminPort,config.host,resolve);});
  state.ready=true;telemetry.event({event:'service_ready'});
  return {service,state,telemetry,passwords,outbox,emailAuth,operatorService,metrics,snapshot,async close(){
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
  let runtime=null,stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;if(runtime){await runtime.close();process.exit(0);}};
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
  runtime=await createRuntime(config,{log});
  if(stopping){await runtime.close();process.exit(0);}
 })().catch(error=>{log({event:'startup_failed',code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'STARTUP_FAILED'});process.exitCode=1;});
}
module.exports={createRuntime,recover};
