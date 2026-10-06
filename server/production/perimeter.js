'use strict';
const crypto=require('node:crypto'),net=require('node:net');
const {Readable}=require('node:stream');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {equal}=require('./passwords');
const known=new Set(['/api/account/email','/api/account/session','/api/account/save','/api/account/logout','/api/account/profile','/api/account/start','/api/account/native/challenge','/api/account/native/finish','/api/account/unlink','/api/community/friends','/api/community/search','/api/community/presence','/api/community/friend','/api/community/challenges','/api/v1/profile','/api/v1/queue','/api/v1/cancel-queue','/api/v1/move','/api/v1/resign','/api/v1/offer','/api/v1/accept','/api/v1/decline','/api/v1/cancel','/api/v1/leaderboard','/api/v1/invitations','/api/v1/purchase','/api/v1/convert','/api/v1/quest','/api/party/command','/api/party/capabilities','/api/monetization/status','/api/monetization/purchase','/api/monetization/restore','/api/monetization/claim','/api/monetization/reward-ticket','/api/monetization/interstitial-permit','/api/monetization/admob-ssv']);
function route(path) {
 if(known.has(path))return path;
 for(const prefix of ['/api/v1/match/','/api/community/profile/','/api/party/rooms/'])if(path.startsWith(prefix))return prefix+':id';
 if(path==='/auth/callback/google'||path==='/auth/callback/apple')return '/auth/callback/:provider';
 return path.startsWith('/api/')?'unknown-api':'static';
}
function json(res,status,value) {
 if(res.headersSent)return;
 res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));
}
function body(req,limit) {
 return new Promise((resolve,reject)=>{
  const chunks=[];let bytes=0,done=false;
  const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',errorHandler);req.off('aborted',aborted);if(error){req.pause();reject(error);}else resolve(Buffer.concat(chunks));};
  const data=chunk=>{bytes+=chunk.length;if(bytes>limit)return finish(Error('BODY_TOO_LARGE'));chunks.push(chunk);};
  const end=()=>finish(),errorHandler=()=>finish(Error('BAD_REQUEST')),aborted=()=>finish(Error('BAD_REQUEST'));
  const timer=setTimeout(()=>finish(Error('REQUEST_TIMEOUT')),8000);timer.unref();
  req.on('data',data);req.once('end',end);req.once('error',errorHandler);req.once('aborted',aborted);
 });
}
class Telemetry {
 constructor(log=()=>{}) {this.log=log;this.inflight=0;this.requests=0;this.errors=0;this.busy=0;this.durations=[0,0,0,0,0,0];this.events={};this.loop=monitorEventLoopDelay({resolution:20});this.loop.enable();}
 event(value) {const event=value.event;if(!/^[a-z_]{1,48}$/.test(event))return;this.events[event]=(this.events[event]||0)+1;this.log({event});}
 finish(id,method,label,status,start) {
  const ms=performance.now()-start;this.requests++;if(status>=500)this.errors++;
  [10,50,150,400,1000,Infinity].forEach((n,i)=>{if(ms<=n)this.durations[i]++;});
  this.log({event:'http',requestId:id,method,route:label,status,durationMs:Math.round(ms*100)/100});
 }
 snapshot(){return {requests:this.requests,errors:this.errors,inflight:this.inflight,busy:this.busy,durationBuckets:this.durations,eventLoopP99Ms:Math.round(this.loop.percentile(99)/1e6),rssBytes:process.memoryUsage().rss,events:{...this.events}};}
 close(){this.loop.disable();}
}
function createPerimeter({service,config,emailAuth,telemetry,state}) {
 const limits=new Map();
 const consume=(ip,scope,max)=>{
  const now=Date.now(),key=scope+':'+crypto.createHash('sha256').update(ip).digest('hex');let item=limits.get(key);
  if(!item||item.until<=now){item={hits:0,until:now+60000};if(limits.size>=20000){for(const [k,v]of limits)if(v.until<=now)limits.delete(k);if(limits.size>=20000)return false;}limits.set(key,item);}
  return ++item.hits<=max;
 };
 return async(req,res)=>{
  const id=crypto.randomUUID(),start=performance.now();let path='/',tracked=false;
  res.setHeader('X-Request-ID',id);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://unpkg.com/lucide@0.468.0/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  res.once('finish',()=>{telemetry.finish(id,['GET','HEAD','POST'].includes(req.method)?req.method:'OTHER',route(path),res.statusCode,start);});
  try {
   if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.length>8192)throw Error('BAD_REQUEST');
   path=new URL(req.url,config.origin).pathname;
   if(['/api/v1/cosmetic','/api/monetization/redeem','/api/monetization/equip'].includes(path))return json(res,404,{error:'NOT_FOUND'});
   if((path==='/livez'||path==='/readyz')&&req.method==='GET')return json(res,path==='/livez'||state.healthy()?200:503,{ok:path==='/livez'||state.healthy()});
   if(req.headers.host!==new URL(config.origin).host||!equal(String(req.headers['x-mega-proxy-key']||''),config.proxySecret))return json(res,403,{error:'FORBIDDEN'});
   const ip=String(req.headers['x-mega-client-ip']||'');if(!net.isIP(ip))return json(res,400,{error:'BAD_REQUEST'});
   if(!consume(ip,'all',600)||((path.startsWith('/api/account/')&&req.method==='POST')&&!consume(ip,'auth',20))||(path==='/api/monetization/admob-ssv'&&!consume(ip,'ssv',120))) {res.setHeader('Retry-After','60');return json(res,429,{error:'RATE_LIMITED'});}
   if(state.draining||telemetry.inflight>=config.maxInflight){telemetry.busy++;res.setHeader('Retry-After','5');return json(res,503,{error:'SERVICE_UNAVAILABLE'});}
   telemetry.inflight++;tracked=true;
   if(!['GET','HEAD','POST'].includes(req.method))return json(res,405,{error:'METHOD_NOT_ALLOWED'});
   const limit=path==='/api/account/save'?300000:24576;
   if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')return json(res,415,{error:'UNSUPPORTED_ENCODING'});
   if(req.headers['content-length']&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>limit))throw Error('BODY_TOO_LARGE');
   const data=req.method==='POST'?await body(req,limit):Buffer.alloc(0);
   let parsed=null;
   if(req.method==='POST') {
    if(!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'INVALID_JSON'});
    try {parsed=JSON.parse(data.toString('utf8'));}catch {throw Error('BAD_REQUEST');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('BAD_REQUEST');
   }
   const continued=new Set(['/api/v1/move','/api/v1/resign','/api/v1/decline','/api/v1/cancel','/api/v1/cancel-queue','/api/account/save','/api/account/logout','/api/community/presence']);
   const continuingParty=path==='/api/party/command'&&['move','resign','leave','cancel','pause'].includes(parsed?.type);
   if(state.maintenance()&&((req.method==='POST'&&!continued.has(path)&&!continuingParty)||(req.method==='GET'&&path==='/api/v1/queue'))){res.setHeader('Retry-After','30');return json(res,503,{error:'MAINTENANCE'});}
   if(path==='/api/account/email'&&req.method==='POST') {
    const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('__Host-mega_session='));const token=cookie?.slice('__Host-mega_session='.length);
    if(req.headers.origin!==config.origin)return json(res,403,{error:'ORIGIN_OR_CONTENT_TYPE'});
    service.community.csrf(token,req.headers['x-csrf-token']);
    const result=await emailAuth.dispatch(token,parsed);
    if(result.token){res.setHeader('Set-Cookie','__Host-mega_session='+result.token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600');return json(res,200,{linked:true,csrf:result.csrf,profile:result.profile,created:result.created,verified:parsed.action==='verify',passwordChanged:result.passwordChanged});}
    return json(res,200,result);
   }
   // The trusted proxy's canonical IP is passed to the legacy per-IP limiter.
   // No attacker-provided forwarding chain reaches it. Original SSV URL is untouched.
   const forwarded=Readable.from(data.length?[data]:[]);
   Object.assign(forwarded,{headers:req.headers,method:req.method,url:req.url,socket:{remoteAddress:ip}});
   await service.request(forwarded,res);
  } catch(error) {
   const code=error.message;
   if(code==='BODY_TOO_LARGE'||code==='REQUEST_TIMEOUT'){res.setHeader('Connection','close');res.once('finish',()=>req.destroy());return json(res,code==='BODY_TOO_LARGE'?413:408,{error:code});}
   const publicErrors=new Set(['INVALID_EMAIL','PASSWORD_WEAK','INVALID_CREDENTIALS','INVALID_OTP','OTP_EXPIRED','OTP_LOCKED','OTP_USED','OTP_COOLDOWN','RESET_NOT_AUTHORIZED','ALREADY_LINKED','EMAIL_IN_USE','REAUTH_REQUIRED','LINK_ACCOUNT_REQUIRED','CSRF_FAILED','AUTH_REQUIRED','ACCOUNT_UNAVAILABLE','INVALID_AUTH_REQUEST']);
   if(publicErrors.has(code))return json(res,code==='AUTH_REQUIRED'?401:409,{error:code});
   if(code==='RATE_LIMITED'){res.setHeader('Retry-After','60');return json(res,429,{error:code});}
   if(['AUTH_BUSY','EMAIL_BUDGET_EXCEEDED','EMAIL_QUEUE_FULL','EMAIL_DELIVERY_NOT_CONFIGURED'].includes(code))return json(res,503,{error:'SERVICE_UNAVAILABLE'});
   if(code==='BAD_REQUEST')return json(res,400,{error:code});
   telemetry.event({event:'request_failed'});return json(res,500,{error:'REQUEST_FAILED'});
  } finally {if(tracked)telemetry.inflight--;}
 };
}
module.exports={createPerimeter,Telemetry,route,json};
