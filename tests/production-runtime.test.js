'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {config}=require('../server/production/config');
const {createRuntime}=require('../server/production/main');
const {snapshot,verify,restore}=require('../server/production/backup');
const {preflight}=require('../server/production/migrations');
const {DatabaseSync}=require('node:sqlite');
const http=require('node:http'),crypto=require('node:crypto');
function httpFetch(url,options={}) {
 return new Promise((resolve,reject)=>{const req=http.request(url,{method:options.method,headers:options.headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join('; '):v])),text:async()=>Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.end(options.body);});
}
const secrets={MEGA_ORIGIN:'https://game.test',MEGA_OTP_SECRET:'1'.repeat(64),MEGA_PROXY_SECRET:'2'.repeat(64)};
async function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mega-production-')),logs=[],sent=[];
 const cfg={...config(secrets),file:path.join(dir,'db.sqlite'),host:'127.0.0.1',port:0,adminPort:0,backupStatus:path.join(dir,'backup.json'),authWorkers:1};
 const runtime=await createRuntime(cfg,{log:x=>logs.push(x),transport:{enabled:()=>true,sendOtp:async m=>sent.push(m),sendPasswordChanged:async m=>sent.push(m)}});
 t.after(async()=>{await runtime.close();fs.rmSync(dir,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+runtime.service.server.address().port;
 function client(ip='198.51.100.2') {
  let cookie='',csrf='';return {get cookie(){return cookie;},async call(route,data,extra={}) {
   const result=await httpFetch(url+route,{method:data===undefined?'GET':'POST',headers:{Host:'game.test','X-Mega-Proxy-Key':cfg.proxySecret,'X-Mega-Client-IP':ip,Origin:cfg.origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),'X-CSRF-Token':csrf,'Idempotency-Key':crypto.randomUUID(),...extra},body:data===undefined?undefined:JSON.stringify(data)});
   if(result.headers.get('set-cookie'))cookie=result.headers.get('set-cookie').split(';')[0];
   const text=await result.text();let value;try{value=JSON.parse(text);}catch{value=text;}
   if(value.csrf)csrf=value.csrf;return {status:result.status,data:value,headers:result.headers};
  }};
 }
 return {dir,cfg,runtime,logs,sent,url,client};
}
test('production config is fail-closed and forbids ambiguous secrets or paid enablement',()=>{
 assert.equal(config(secrets).mailDaily,80);
 for(const patch of [{MEGA_ORIGIN:'http://game.test'},{MEGA_DB:'relative.db'},{MEGA_OTP_SECRET:'short'},{MEGA_PROXY_SECRET:'1'.repeat(64)},{MEGA_OTP_SECRET_FILE:'/tmp/key'},{MEGA_PAID_ENTRY_ENABLED:'true'},{MEGA_AD_MODE:'hybrid'},{PORT:'8080x'},{GOOGLE_CLIENT_ID:'incomplete'},{MEGA_MAIL_DAILY_LIMIT:'101'}])assert.throws(()=>config({...secrets,...patch}));
});
test('production perimeter authenticates the proxy and never logs tokens or query values',async t=>{
 const f=await fixture(t),c=f.client();
 assert.equal((await fetch(f.url+'/livez')).status,200);
 assert.equal((await c.call('/api/account/session',undefined,{'X-Mega-Proxy-Key':''})).status,403);
 assert.equal((await c.call('/api/account/session',undefined,{'X-Mega-Client-IP':'spoof, 1.1.1.1'})).status,400);
 const r=await c.call('/api/account/session?password=DO_NOT_LOG_ME');assert.equal(r.status,200);for(const flag of ['HttpOnly','Secure','SameSite=Lax'])assert(r.headers.get('set-cookie').includes(flag));assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await c.call('/api/account/email',{action:'continue',email:'private@example.com',password:'private-password-42'},{Origin:'https://evil.test'})).status,403);
 assert(!JSON.stringify(f.logs).includes('DO_NOT_LOG_ME'));assert(!JSON.stringify(f.logs).includes('private@example.com'));assert(!JSON.stringify(f.logs).includes(c.cookie));
 assert.equal((await c.call('/api/account/email',{x:'a'.repeat(25000)})).status,413);
 assert.equal((await c.call('/api/account/email',[])).status,400);
 assert.equal((await c.call('/api/account/email',{action:'continue'},{'X-CSRF-Token':'bad'})).status,409);
});
test('production email route queues encrypted delivery, verifies ownership and signs in again',async t=>{
 const f=await fixture(t),a=f.client();await a.call('/api/account/session');
 const pending=await a.call('/api/account/email',{action:'continue',email:'player@example.com',password:'correct-horse-42'});
 assert.equal(pending.status,200,JSON.stringify(pending.data));assert.equal(pending.data.verificationRequired,true);assert(!pending.data.delivery);assert.equal(f.runtime.service.store.read().accounts.size,0);
 const queued=f.runtime.service.store.db.prepare('SELECT payload FROM v4_outbox').get();assert(!queued.payload.includes('player@example.com'));
 await f.runtime.outbox.tick();assert.equal(f.sent.length,1);
 const verified=await a.call('/api/account/email',{action:'verify',challengeId:pending.data.challengeId,code:f.sent[0].code});
 assert.equal(verified.status,200,JSON.stringify(verified.data));assert.equal(verified.data.profile.emailVerified,true);
 const b=f.client('198.51.100.3');await b.call('/api/account/session');
 const signed=await b.call('/api/account/email',{action:'continue',email:'PLAYER@example.com',password:'correct-horse-42'});
 assert.equal(signed.data.profile.id,verified.data.profile.id);assert.equal(f.runtime.service.store.read().accounts.size,1);
 const off=await b.call('/api/monetization/status');assert.equal(off.data.adMode,'off');assert.equal(off.data.purchasesAvailable,false);
 assert(!f.logs.some(x=>JSON.stringify(x).includes(f.sent[0].code)));
});
test('maintenance stops new work but keeps liveness and rejects readiness',async t=>{
 const f=await fixture(t),c=f.client();await c.call('/api/account/session');f.runtime.service.store.db.exec('UPDATE v4_controls SET maintenance=1');
 assert.equal((await fetch(f.url+'/livez')).status,200);assert.equal((await fetch(f.url+'/readyz')).status,503);
 assert.equal((await c.call('/api/v1/queue',{mode:'casual'})).status,503);
 const status=await fetch('http://127.0.0.1:'+f.runtime.metrics.address().port+'/status').then(r=>r.json());assert.equal(status.maintenance,true);assert.equal(status.backup.fresh,false);
 f.runtime.service.store.db.exec('UPDATE v4_controls SET maintenance=0');assert.equal((await fetch(f.url+'/readyz')).status,200);
});
test('backup contains committed WAL state and guarded restore rejects corruption',async t=>{
 const f=await fixture(t),db=f.runtime.service.store.db;
 db.exec("INSERT INTO v4_runtime VALUES('durable-test','42')");const destination=path.join(f.dir,'backup.sqlite');
 await snapshot(f.cfg.file,destination);const manifest=await verify(destination);assert.equal(manifest.schema,1);
 const copy=path.join(f.dir,'restored.sqlite');await restore(destination,copy,{confirm:true});
 const restored=new DatabaseSync(copy);assert.equal(restored.prepare("SELECT value FROM v4_runtime WHERE key='durable-test'").get().value,'42');restored.close();
 await assert.rejects(restore(destination,copy),/RESTORE_CONFIRMATION/);
 fs.appendFileSync(destination,'corrupt');await assert.rejects(verify(destination),/BACKUP_CHECKSUM/);
});
test('migration preflight refuses future schemas before application constructors run',async t=>{
 const f=await fixture(t);f.runtime.service.store.db.exec("INSERT INTO v4_schema VALUES(99,'future','unknown',1)");
 assert.throws(()=>preflight(f.cfg.file),/SCHEMA_NEWER/);
});
