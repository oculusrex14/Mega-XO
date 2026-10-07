/* Runnable same-origin account/social/game service. Paid entry is OFF by default.
 * Use a TLS reverse proxy and configured Google/Apple clients for production. */
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {DurableStore}=require('./economy-store.js');
const {CommunityStore}=require('./community-store.js');
const {IdentityProviders}=require('./identity-provider.js');
const {TransactionalEmail}=require('./email-provider.js');
const {QueueSession}=require('./queue-session.js');
const {createCommunityHandler}=require('./community-http.js');
const {RoomStore}=require('./rooms.js');
const {MonetizationStore}=require('./monetization-store.js');
const {createMonetizationHandler}=require('./monetization-http.js');
const ROOT=path.resolve(__dirname,'..');
function buildService({file,origin,providers:providerConfig={},providerInstance,emailOptions={},emailInstance,storeOptions={},communityOptions={},monetizationOptions={},allowLocalHttp=false,networkContext=()=>({})}={}){
 if(!emailInstance&&emailOptions.apiKey&&!storeOptions.otpSecret)throw Error('MEGA_OTP_SECRET_REQUIRED');
 const store=new DurableStore(file,storeOptions),community=new CommunityStore({store,origin,now:storeOptions.now||Date.now,otpSecret:storeOptions.otpSecret,...communityOptions}),providers=providerInstance||new IdentityProviders({config:providerConfig}),emailer=emailInstance||new TransactionalEmail(emailOptions),matchmaker=new QueueSession({store,now:storeOptions.now||Date.now}),accountHandler=createCommunityHandler({store,community,providers,emailer,matchmaker,origin,allowLocalHttp,networkContext});
 community.isQueued=actor=>matchmaker.busy(actor);
 const rooms=new RoomStore(file,{...storeOptions,lanOnly:false});
 community.isDeletionBusy=actor=>rooms.active().some(r=>r.players.some(p=>p.id===actor));
 const auth=async req=>accountHandler.authenticate(req);
 const {purchaseProviderFactory,notificationFactory,...monetizationConfig}=monetizationOptions,purchaseProvider=purchaseProviderFactory?purchaseProviderFactory(store):monetizationConfig.purchaseProvider;
 const monetization=new MonetizationStore(store,{...monetizationConfig,purchaseProvider,busy:actor=>matchmaker.busy(actor)||rooms.active().some(r=>r.players.some(p=>p.id===actor))});
 const storeNotifications=notificationFactory?notificationFactory({store,monetization,purchaseProvider}):{};
 const monetizationHandler=createMonetizationHandler({monetization,authenticate:auth,guard:accountHandler.guard,origin,storeNotifications});
 // The existing party router accepts principal resolution; no new guest-to-paid path.
 const {createPartyHandler:partyFactory}=require('./party-http.js');
 let partyHandler=partyFactory?partyFactory({store:rooms,rooms,authenticate:async req=>{const p=await auth(req);if(!p)return null;const row=community.profileRow(p.id);return {id:p.id,actor:p.id,name:row?.display_name||'Player'};},origin}):null;
 const networkLimits=new Map();
 const request=async(req,res)=>{try{
  if(req.url.startsWith('/api/')||req.url.startsWith('/auth/')){const ip=req.socket.remoteAddress||'local',minute=Math.floor(Date.now()/60000),old=networkLimits.get(ip),bucket=old?.minute===minute?old:{minute,hits:0};bucket.hits++;networkLimits.set(ip,bucket);if(networkLimits.size>4096)networkLimits.delete(networkLimits.keys().next().value);if(bucket.hits>1800){res.writeHead(429,{'Content-Type':'application/json','Retry-After':'60'});return res.end(JSON.stringify({error:'RATE_LIMITED'}));}}
  if(await monetizationHandler(req,res))return;
  if(await accountHandler(req,res))return;
  if(req.url.startsWith('/api/party/')){accountHandler.guard(req);if(!partyHandler){res.writeHead(503);res.end();return;}return await partyHandler(req,res);}
  const raw=new URL(req.url,origin).pathname,publicRoutes={'/delete-account':'/public/delete-account.html','/privacy':'/public/privacy.html','/privacy-choices':'/public/privacy-choices.html','/terms':'/public/terms.html','/support':'/public/support.html'},relative=decodeURIComponent(raw==='/'?'/index.html':publicRoutes[raw]||raw),target=path.resolve(ROOT,'.'+relative);
  const allowed=target===path.join(ROOT,'index.html')||target.startsWith(path.join(ROOT,'src')+path.sep)||target.startsWith(path.join(ROOT,'public')+path.sep);
  if(!allowed||!['GET','HEAD'].includes(req.method)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.writeHead(404);res.end('Not found');return;}
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
  res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY'});if(req.method==='HEAD')return res.end();fs.createReadStream(target).pipe(res);
 }catch{if(!res.headersSent)res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'REQUEST_FAILED'}));}};
 const server=http.createServer(request);let timer=null,closing=null;
 return {server,store,community,providers,emailer,matchmaker,rooms,monetization,storeNotifications,request,startWorkers(){if(timer)return;timer=setInterval(()=>{try{matchmaker.tick();rooms.tick();community.cleanup();monetization.processPurchaseFinalizations().catch(e=>console.error('Purchase finalization error:',e.message));}catch(e){console.error('Maintenance error:',e.message);}},1000);timer.unref();},close(){
  if(closing)return closing;clearInterval(timer);timer=null;
  closing=(async()=>{try{server.closeIdleConnections?.();server.closeAllConnections?.();if(server.listening)await new Promise(resolve=>server.close(()=>resolve()));}finally{rooms.close();store.close();}})();
  return closing;
 }};
}
if(require.main===module){const port=Number(process.env.PORT||8080),origin=process.env.MEGA_ORIGIN||'http://localhost:'+port,file=process.env.MEGA_DB||path.join(ROOT,'.data','mega.sqlite');fs.mkdirSync(path.dirname(file),{recursive:true});
 const service=buildService({file,origin,allowLocalHttp:true,emailOptions:{apiKey:process.env.RESEND_API_KEY,from:process.env.MEGA_EMAIL_FROM||'Mega XO by Antimatter Innovations <contact@antimatterinnovations.com>'},storeOptions:{otpSecret:process.env.MEGA_OTP_SECRET},providers:{google:{clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET,nativeAudiences:(process.env.GOOGLE_NATIVE_AUDIENCES||'').split(',').filter(Boolean),authorizedParties:(process.env.GOOGLE_AUTHORIZED_PARTIES||'').split(',').filter(Boolean)},apple:{clientId:process.env.APPLE_SERVICE_ID,teamId:process.env.APPLE_TEAM_ID,keyId:process.env.APPLE_KEY_ID,privateKey:process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g,'\n'),nativeAudiences:(process.env.APPLE_NATIVE_AUDIENCES||'').split(',').filter(Boolean)}}});
 service.rooms.recover();service.startWorkers();service.server.listen(port,'127.0.0.1',()=>console.log('Mega XO account service: '+origin));let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;try{await service.close();}finally{process.exit(0);}});
}
module.exports={buildService};
