'use strict';
// Brief part 4.A regression contract: the native session cache must never invent a lifetime,
// must share ONE rotation across concurrent expiry-triggered calls, must advance the cached
// expiry from host metadata after a successful rotation, and must never loop on terminal
// failures. Fake clock; no network, no browser, no device claims.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
const accountSource=fs.readFileSync(path.join(ROOT,'src/account-client.js'),'utf8');

function fixture({fastTimers=false}={}){
 const clock={ms:1_700_000_000_000};
 let refreshCount=0,sessionReads=0,profileReads=0,requests=0;
let hangSessionReads=false;
 let hostExpiry=clock.ms+60_000; // the host owns the real expiry
 let refreshOutcome=null; // null = OK; otherwise {ok:false,error}
 let refreshDelay=0;
 const host={
 get hangSessionReads(){return hangSessionReads;},
 set hangSessionReads(value){hangSessionReads=value;},
  get refreshCount(){return refreshCount;},
  get sessionReads(){return sessionReads;},
  get profileReads(){return profileReads;},
  get requests(){return requests;},
  setRefreshOutcome(o){refreshOutcome=o;},
  setRefreshDelay(ms){refreshDelay=ms;},
  setHostExpiry(ms){hostExpiry=ms;},
  session:async()=>{sessionReads++;if(hangSessionReads&&refreshCount>0)return new Promise(()=>{});return {ok:true,online:true,linked:true,actorId:'actor-1',expiresAt:hostExpiry,providers:['google']};},
  request:async(path)=>{requests++;return {ok:true,data:{id:'actor-1',providers:['google']}};},
  refresh:async()=>{refreshCount++;if(refreshDelay)await new Promise(r=>setTimeout(r,refreshDelay));if(refreshOutcome)return refreshOutcome;hostExpiry=clock.ms+60_000;return {ok:true};},
  signOut:async()=>({ok:true}),
 };
 const context={
  console,Headers,URL,URLSearchParams,AbortController,Promise,JSON,Object,Array,Number,String,Boolean,Error,Date:{now:()=>clock.ms},
  setTimeout,clearTimeout,crypto,navigator:{onLine:true},
  location:{href:'https://megaxo.online/game',origin:'https://megaxo.online'},
  CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
  document:{querySelector:()=>({content:'native'}),dispatchEvent(){}},
  fetch:async()=>{throw Error('COOKIE_PATH_UNREACHABLE');},
  MegaNativeApi:host,
 };
 context.globalThis=context;context.window=context;
 // Sleep timers must never keep the runner alive past the assertions.
 context.setTimeout=(fn,ms)=>{const t=setTimeout(fn,ms);if(typeof t?.unref==='function')t.unref();return t;};
 vm.createContext(context);
 if(fastTimers){
  // Resolve sleeps immediately so the 15s rotation watchdog race completes instantly.
  context.setTimeout=(fn)=>Promise.resolve().then(fn);
 }
 vm.runInContext(accountSource,context,{filename:'src/account-client.js'});
 return {context,account:context.MegaAccount,host,clock,
  bumpPastExpiry(){clock.ms=hostExpiry+1;}};
}

test('bootstrap installs the host-advertised expiry, never an invented one',async()=>{
 const f=fixture();
 const s=await f.account.session();
 assert.equal(s.linked,true);
 assert.equal(s.expiresAt,f.clock.ms+60_000,'cached expiry must equal the host value');
 assert.equal(f.host.refreshCount,0,'fresh bootstrap must not rotate');
});

test('100 sequential requests across the expiry cause exactly one refresh',async()=>{
 const f=fixture();
 await f.account.session(); // bootstrap profile read counts once
 const before=f.host.requests;
 f.bumpPastExpiry();
 for(let i=0;i<100;i++)await f.account.request('/api/account/profile','GET');
 assert.equal(f.host.refreshCount,1,'sequential requests must reuse the rotated session');
 assert.equal(f.host.requests-before,100);
});

test('a concurrent burst at expiry shares one rotation',async()=>{
 const f=fixture();
 await f.account.session();
 const before=f.host.requests;
 f.bumpPastExpiry();
 await Promise.all(Array.from({length:50},()=>f.account.request('/api/account/profile','GET')));
 assert.equal(f.host.refreshCount,1,'concurrent expiry-triggered calls must single-flight');
 assert.equal(f.host.requests-before,50);
});

test('the cached expiry is advanced after a successful rotation',async()=>{
 const f=fixture();
 const before=await f.account.session();
 f.bumpPastExpiry();
 await f.account.request('/api/account/profile','GET');
 const after=f.account.peek();
 assert.equal(after.expiresAt,f.clock.ms+60_000,'refresh must install the host new expiry');
 assert.notEqual(after.expiresAt,before.expiresAt);
 // Later sequential requests reuse it: no further rotation.
 const seen=f.host.refreshCount;
 await f.account.request('/api/account/profile','GET');
 await f.account.request('/api/account/profile','GET');
 assert.equal(f.host.refreshCount,seen);
});

test('a REVOKED rotation is terminal and clears the cache without looping',async()=>{
 const f=fixture();
 await f.account.session();
 const before=f.host.requests;
 f.host.setRefreshOutcome({ok:false,error:'REVOKED'});
 f.bumpPastExpiry();
 await assert.rejects(()=>f.account.request('/api/account/profile','GET'),error=>error.message==='REVOKED');
 assert.equal(f.host.refreshCount,1);
 assert.equal(f.account.peek(),null,'terminal revocation must drop the cached session');
 assert.equal(f.host.requests-before,0,'a revoked family must never replay the bearer');
});

test('a rotation timeout still attempts the held token exactly once (no loop)',async()=>{
 const f=fixture({fastTimers:true});
 await f.account.session();
 const before=f.host.requests;
 f.host.setRefreshDelay(100); // real ms; the JS race window resolves first (fast timers)
 f.bumpPastExpiry();
 await f.account.request('/api/account/profile','GET');
 assert.equal(f.host.refreshCount,1,'timeout must not retry the rotation inside one call');
 assert.equal(f.host.requests-before,1,'the held token attempt still runs');
});

test('sign-out invalidates the cached state and forces an honest re-bootstrap',async()=>{
 const f=fixture();
 await f.account.session();
 f.bumpPastExpiry();
 await f.account.request('/api/account/profile','GET');
 const readsAfterBootstrap=f.host.sessionReads;
 await f.account.logout(false);
 assert.equal(f.account.peek(),null);
 await f.account.request('/api/account/profile','GET');
 assert.ok(f.host.sessionReads>readsAfterBootstrap,'post-sign-out traffic re-establishes state');
 assert.ok(f.host.refreshCount<=1,'sign-out itself never rotates');
});

test('a stale rotation completion cannot overwrite a newer identity (account switch)',async()=>{
 const f=fixture();
 await f.account.session();
 f.host.setRefreshDelay(30);
 f.bumpPastExpiry();
 const flight=f.account.request('/api/account/profile','GET');
 f.account.reset(); // account switch: generation bumps while the rotation is in flight
 await flight;
 const s=f.account.peek();
 if(s)assert.ok(s.expiresAt===0||s.expiresAt>f.clock.ms,'a stale completion must never install an expired or invented lifetime');
});

test('Sol #7: a generation bump must not strand the refresh promise (next expiry rotates again)',async()=>{
 const f=fixture();
 await f.account.session();
 f.host.setRefreshDelay(30);
 f.bumpPastExpiry();
 const flight=f.account.request('/api/account/profile','GET');
 f.account.reset(); // generation bump while the rotation is in flight
 await flight;
 f.bumpPastExpiry();
 const before=f.host.refreshCount;
 await f.account.request('/api/account/profile','GET');
 assert.equal(f.host.refreshCount,before+1,'a stranded in-flight promise must never satisfy a later rotation');
});

test('Sol #8: bootstrap after an expired snapshot carries the POST-rotation expiry',async()=>{
 const f=fixture();
 f.host.setHostExpiry(f.clock.ms-1000); // host reports an expired access token at cold start
 await f.account.session(); // bootstrap rotates once, then reads the profile
 assert.equal(f.host.refreshCount,1,'cold-start restore rotates exactly once');
 await f.account.request('/api/account/profile','GET');
 assert.equal(f.host.refreshCount,1,'the cached session must carry the post-rotation expiry, not the stale snapshot');
});

test('Sol round-3 #2: bootstrap settles even when the post-rotation metadata read never resolves',async()=>{
 // The metadata re-read rides the ONE 15s deadline; a wedged bridge call must not block
 // session() forever. The deadline path falls back to the pre-rotation snapshot honestly.
 const f=fixture({fastTimers:true});
 f.host.hangSessionReads=true;
 f.host.setHostExpiry(f.clock.ms-1000);
 await f.account.session(); // must SETTLE (not hang) with the rotation already counted
 assert.equal(f.host.refreshCount,1,'the rotation itself completed');
 assert.equal(f.host.requests,1,'bootstrap still performs its single profile read');
});
