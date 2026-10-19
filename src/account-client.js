/* Shared account client. Same-origin HttpOnly sessions; no provider tokens in
 * localStorage. Existing API consumers keep the same interfaces. */
(function(root){
'use strict';
let session=null,loading=null;
/* One coherent native refresh lifecycle. The host owns the credentials AND the authoritative
 * expiry; this module is a cache that must never invent a lifetime. Concurrent expiry-triggered
 * calls share one rotation; a success advances the cached expiry from validated host metadata
 * before waiters continue; a stale completion (generation changed mid-flight) never overwrites
 * newer state. Ordinary local play and background clients never renew anything just to stay warm
 * (no timers here — refresh happens only when a request actually needs the bearer). */
let nativeRefreshInFlight=null,sessionGeneration=0;
const id=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const native=()=>root.MegaNativeApi&&typeof root.MegaNativeApi.request==='function'?root.MegaNativeApi:null;
/* Generated native bundles have no same-origin account API. An offline host (or a static browser
 * preview of that bundle) must not probe its asset origin as though it were the web service.
 * Unmarked website pages retain their same-origin cookie transport. A configured native bridge
 * always takes precedence, including when its real requests fail. */
const nativeTransport=root.document?.querySelector?.('meta[name="mega-account-transport"]')?.content==='native';
const localOnly=()=>nativeTransport&&!native();
let connectivity={state:localOnly()?'local':root.navigator?.onLine===false?'offline':'online',code:localOnly()?'ONLINE_NOT_CONFIGURED':'',supportId:'',at:Date.now()};
function publish(state,code='',supportId=''){
 if(connectivity.state===state&&connectivity.code===code&&connectivity.supportId===supportId)return;
 connectivity={state,code,supportId:/^MX-[A-F0-9]{16}$/.test(supportId)?supportId:'',at:Date.now()};
 try{root.document?.dispatchEvent(new CustomEvent('mega:connectivity',{detail:{...connectivity}}));}catch{}
}
function classify(code){
 if(code==='AUTH_REQUIRED')return 'auth';
 if(code==='REVOKED')return 'auth';
 if(code==='LINK_ACCOUNT_REQUIRED')return 'auth';
 if(code==='MAINTENANCE')return 'maintenance';
 if(code==='OFFLINE'||root.navigator?.onLine===false)return 'offline';
 if(code==='REQUEST_TIMEOUT')return 'timeout';
 return 'degraded';
}
function transient(code){return ['SERVICE_UNAVAILABLE','ONLINE_UNAVAILABLE','REQUEST_TIMEOUT'].includes(code);}
function localUnavailable(){publish('local','ONLINE_NOT_CONFIGURED');return Error('ONLINE_NOT_CONFIGURED');}
/* P20-03 native host transport. Present only in a signed native host whose Gradle build configured
 * an API origin; absent in the browser and in the offline native flavor. It is NOT a fetch proxy:
 * the host owns the bearer, the host/path allowlist and the redirect policy, and it returns only a
 * validated JSON value. No token ever crosses this boundary in either direction. */
function nativeError(result){
 const code=String(result?.error||'SERVICE_UNAVAILABLE');
 const e=Error(/^[A-Z0-9_]+$/.test(code)?code:'SERVICE_UNAVAILABLE');
 e.status=Number(result?.status||0);
 return e;
}
async function once(path,body,operationKey,timeoutMs=8000){
 const host=native();
 if(host){
  const result=await host.request(path,body===undefined?'GET':'POST',body===undefined?null:body,operationKey||null);
  if(!result||result.ok!==true)throw nativeError(result);
  return result.data;
 }
 const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),timeoutMs);
 try{
  const headers=body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':session?.csrf||'','Idempotency-Key':operationKey};
  const res=await root.fetch(path,{credentials:'same-origin',method:body===undefined?'GET':'POST',signal:ctrl.signal,headers,body:body===undefined?undefined:JSON.stringify(body)}),supportId=String(res.headers?.get?.('X-Support-ID')||'');
  let out;try{out=await res.json();}catch{const error=Error('SERVICE_UNAVAILABLE');error.supportId=supportId;throw error;}
  if(!res.ok){const error=Error(out?.error||'SERVICE_UNAVAILABLE');error.status=res.status;error.supportId=String(out?.supportId||supportId);throw error;}
  return out;
 }catch(e){
  if(e?.name==='AbortError')throw Error('REQUEST_TIMEOUT');
  if(e?.message&&/^[A-Z0-9_]+$/.test(e.message))throw e;
  throw Error(root.navigator?.onLine===false?'OFFLINE':'SERVICE_UNAVAILABLE');
 }finally{clearTimeout(timeout);}
}
/* Native session bootstrap. The host owns access+refresh; this module only receives the profile
 * projection the signed game already renders. `/api/account/session` is deliberately NOT called
 * here: in a native host it is cookie-only, and the native path has no cookie jar at all. */
/* SAGAN-012: a linked identity is only NATIVE-capable when this host actually installs an
 * adapter for it (Android currently ships Google only, iOS its own set). The host advertises
 * its capability list in the native session op; intersect it with the profile's linked set
 * instead of marking every linked provider native-supported (dead Verify/Link controls). */
function nativeSessionFromProfile(profile,hostProviders,hostExpiresAt){
 if(!profile||typeof profile!=='object'||typeof profile.id!=='string'||!profile.id)return null;
 const capable=new Set(Array.isArray(hostProviders)?hostProviders:[]);
 /* The host advertises the real session expiry with the profile projection. Never stamp a fresh
  * invented lifetime merely because a profile was fetched: an absent/zero expiry stays 0, which
  * the call path treats as "stale, rotate once via single-flight, then read the host truth". */
 const advertised=Number(hostExpiresAt);
 return {linked:true,csrf:null,native:true,expiresAt:Number.isFinite(advertised)&&advertised>0?advertised:0,actorId:profile.id,profile,providers:Object.fromEntries((profile.providers||[]).map(p=>[p,{web:false,native:capable.has(p),linked:true}]))};
}
/* Single-flight rotation shared by the bootstrap and the call path. Returns the host outcome
 * ({ok:true}|{ok:false,error}) or null on a bounded timeout (the caller may still attempt the
 * request with the held token; a genuinely dead token 401s into the honest AUTH path).
 * Sol P2 #9: ONE 15s deadline covers the rotation AND the metadata re-read - a wedged bridge
 * call resolves the shared promise honestly instead of wedging every later caller. */
function refreshNativeSession(){
 if(nativeRefreshInFlight)return nativeRefreshInFlight;
 const host=native();
 if(!host||typeof host.refresh!=='function')return Promise.resolve({ok:false,error:'ONLINE_UNAVAILABLE'});
 const generation=sessionGeneration;
 const work=(async()=>{
  const rotated=await host.refresh().catch(()=>null);
   /* A REJECTED rotation is treated exactly like the 1.0.4 fallback: null, i.e. "no rotation
    * happened", so the caller falls through to the held-token attempt instead of tearing the
    * session down (a transient WebView bridge hiccup must never sign the player out). Only an
    * EXPLICIT {ok:false} outcome from the host is a real answer. */
   if(rotated===null)return null;
   if(rotated.ok!==true)return {rotated};
  if(generation!==sessionGeneration)return {rotated}; // identity changed mid-flight; install nothing
  /* Advance the cached expiry from the host's own metadata (a memory read, not a network hop).
   * The host is the only authority on lifetime; the cache never fabricates one. The validated
   * state rides the result so bootstrap needs NO second post-rotation bridge call (Sol P2 #2:
   * every post-rotation read stays inside the one deadline). */
  const state=await host.session().catch(()=>null);
  if(generation!==sessionGeneration)return {rotated}; // Sol P2 #7: re-check after EVERY await
  if(state&&state.linked===true&&session&&session.native){
   const fresh=Number(state.expiresAt);
   if(Number.isFinite(fresh)&&fresh>0)session={...session,expiresAt:fresh};
  }
  return {rotated,state};
 })();
 const outcome=Promise.race([work,sleep(15000).then(()=>"timeout")]).then(value=>value==="timeout"?null:value);
 nativeRefreshInFlight=outcome;
 /* Sol P2 #7: clear by PROMISE IDENTITY regardless of generation - a generation bump during
  * the flight must not strand the settled promise here for later callers to reuse. */
 nativeRefreshInFlight.finally(()=>{if(nativeRefreshInFlight===outcome)nativeRefreshInFlight=null;});
 return nativeRefreshInFlight;
}
async function nativeEnsure(force=false){
 if(session&&!force)return session;
 if(loading)return loading;
 loading=(async()=>{
  const host=native();
  let state=await host.session();
  if(!state||state.online!==true)throw Error('ONLINE_UNAVAILABLE');
  /* A cold process reports no live session even when a durable refresh credential is vaulted.
   * Ask the host ONCE to restore it before concluding that the user is a guest; an absent or
   * failed restore keeps the honest guest answer. No credential value crosses the bridge. */
  if(state.linked!==true&&typeof host.restore==='function'){
   const restored=await Promise.race([host.restore().catch(()=>null),sleep(10000).then(()=>null)]);
   if(restored&&restored.ok===true){
    const again=await host.session().catch(()=>null);
    if(again&&again.online===true&&again.linked===true)state=again;
   }
  }
 /* Guests still need the provider capability map: the sign-in buttons gate on it, and the host
  * already reports which native adapters were compiled in (Android: google, iOS: apple). */
 if(state.linked!==true)return {linked:false,csrf:null,actorId:state.actorId||null,profile:null,providers:Object.fromEntries((Array.isArray(state.providers)?state.providers:[]).map(p=>[p,{web:false,native:true}]))};
  // An expired access token is refreshed once before the profile read, never mid-flight.
  /* Rotate ONLY on a positively-advertised expiry. A zero/absent one (bridge that does not
   * advertise TTL) never triggers a rotation: the held token is simply used, and a genuinely
   * dead credential 401s into the honest AUTH path. This is the anti-storm guard - the 1.0.4
   * invented-lifetime behavior is gone, but so is rotate-on-every-call. */
  if(Number(state.expiresAt||0)>0 && state.expiresAt<=Date.now()+1000){
  /* A rotation that never answers must not wedge the whole ensure: race it, and on a timeout
   * fall through to the profile read with the token still held. If that token is truly dead the
   * profile read answers 401 and the honest auth state follows; if the expiry was merely
   * conservative the read succeeds and the user stays signed in. */
   const result=await refreshNativeSession();
   if(result!==null&&result.rotated&&result.rotated.ok!==true){const error=nativeError(result.rotated||{error:'AUTH_REQUIRED'});publish(classify(error.message),error.message);throw error;}
   /* Sol P2 #8: the rotation renewed the host credential; the snapshot read before it is stale.
    * The validated post-rotation metadata rides the bounded refresh result - no second unbounded
    * bridge call here (Sol round-3 #2: bootstrap must never hang past the 15s deadline). */
   const refreshed=result===null?null:result.state;
   if(refreshed&&refreshed.online===true&&refreshed.linked===true&&Number(refreshed.expiresAt)>0)state=refreshed;
  }
  const profile=await host.request('/api/account/profile','GET',null,null);
  if(!profile||profile.ok!==true)throw nativeError(profile||{});
  const parsed=nativeSessionFromProfile(profile.data,state.providers,state.expiresAt);
  if(!parsed)throw Error('SERVICE_UNAVAILABLE');
  sessionGeneration++;session=parsed;publish('online');return parsed;
 })().catch(error=>{const code=error?.message&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'SERVICE_UNAVAILABLE';publish(classify(code),code,error?.supportId||'');throw error;}).finally(()=>{loading=null;});
 return loading;
}
async function ensure(force=false){
 if(localOnly())throw localUnavailable();
 if(!native())return cookieEnsure(force);
 if(session&&!force)return session;
 return nativeEnsure(force);
}
/* Every authenticated native call must re-prove itself after a terminal refresh revocation instead
 * of replaying a dead bearer. The host refuses online use until a fresh sign-in installs a session. */
async function call(path,body,operation){
 if(localOnly())throw localUnavailable();
 /* A native host has no cookie jar, so EVERY account/API call needs the host's bearer - including
  * public reads. Establishing the session state first means a signed-out guest gets the honest auth
  * state ('Sign in to play online') from the caller, rather than the transport failure the host
  * returns when no bearer is installed, which surfaced as a false "Connection interrupted" banner. */
 if(native()&&!session){
  const current=await ensure();
  if(!current||current.linked!==true){const e=Error('LINK_ACCOUNT_REQUIRED');e.status=401;throw e;}
 }
 /* Rotate ONLY on a positively-advertised expired expiry (see the bootstrap note). A zero or
  * missing expiry never triggers a rotation - the held token is used and a dead one 401s
  * honestly, so a bridge that does not advertise TTL cannot cause rotate-on-every-call. */
 if(native()&&session?.native&&Number(session.expiresAt||0)>0&&Date.now()>=Number(session.expiresAt)){
  /* Concurrent expiry-triggered calls share one rotation; a bounded timeout still lets the held
   * token attempt the request (a conservative expiry then costs nothing, a dead token 401s into
   * the honest AUTH path). A terminal failure is never retried in a loop. */
  const result=await refreshNativeSession();
  const rotated=result===null?null:result.rotated;
  if(rotated!==null&&rotated.ok!==true){
   sessionGeneration++;session=null;publish('auth','AUTH_REQUIRED');
   throw nativeError(rotated||{error:'AUTH_REQUIRED'});
  }
 }
 if(body!==undefined&&!session)await ensure();
 const operationKey=body===undefined?null:(operation||id()),attempts=body===undefined?3:2;
 let last;
 for(let attempt=0;attempt<attempts;attempt++){
  try{
   const out=await once(path,body,operationKey);
   publish('online');
   return out;
  }catch(e){
   last=e;
   if(e.message==='AUTH_REQUIRED')session=null;
   const state=classify(e.message);
   if(!transient(e.message)||state==='offline'||attempt===attempts-1){publish(state,e.message,e.supportId||'');throw e;}
   publish('reconnecting',e.message,e.supportId||'');
   await sleep(250*(attempt+1));
  }
 }
 throw last||Error('SERVICE_UNAVAILABLE');
}
async function cookieEnsure(force=false){
 if(session&&!force)return session;
 if(loading)return loading;
 loading=(async()=>{
  let last;
  for(let attempt=0;attempt<2;attempt++){
   const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),4500);
   try{
    const res=await root.fetch('/api/account/session',{credentials:'same-origin',signal:ctrl.signal}),supportId=String(res.headers?.get?.('X-Support-ID')||'');
    let out;try{out=await res.json();}catch{const error=Error('SERVICE_UNAVAILABLE');error.supportId=supportId;throw error;}
    if(!res.ok){const error=Error(out?.error||'SERVICE_UNAVAILABLE');error.supportId=String(out?.supportId||supportId);throw error;}
    if(!out||typeof out.csrf!=='string')throw Error('SERVICE_UNAVAILABLE');
    session=out;publish('online');return out;
   }catch(e){
    const code=e?.name==='AbortError'?'REQUEST_TIMEOUT':e?.message&&/^[A-Z0-9_]+$/.test(e.message)?e.message:(root.navigator?.onLine===false?'OFFLINE':'SERVICE_UNAVAILABLE');
    last=Error(code);last.supportId=e?.supportId||'';
    const state=classify(code);
    if(!transient(code)||state==='offline'||attempt===1){publish(state,code,last.supportId);throw last;}
    publish('reconnecting',code,last.supportId);await sleep(250);
   }finally{clearTimeout(timer);}
  }
  throw last||Error('SERVICE_UNAVAILABLE');
 })().finally(()=>{loading=null;});
 return loading;
}
root.addEventListener?.('offline',()=>localOnly()?publish('local','ONLINE_NOT_CONFIGURED'):publish('offline','OFFLINE'));
root.addEventListener?.('online',()=>localOnly()?publish('local','ONLINE_NOT_CONFIGURED'):publish('reconnecting','ONLINE'));
/* Sign-out. The native host revokes the presenting family, wipes the Keystore vault and drops the
 * in-memory access token; the cookie path keeps the retained /api/account/logout call exactly as it
 * is. `allDevices` is best-effort: if the server rejects the field rather than ignoring it, retry
 * once without it, and never let that field be the reason a sign-out fails. A genuine failure is
 * surfaced rather than swallowed, so the user is never told they are signed out when the server
 * still holds a live family. */
async function logout(all){
 const host=native();
 if(host&&typeof host.signOut==='function'){
  let result=await host.signOut(all===true);
  if((!result||result.ok!==true)&&all===true)result=await host.signOut(false);
  if(!result||result.ok!==true)throw nativeError(result||{error:'SERVICE_UNAVAILABLE'});
  sessionGeneration++;session=null;publish('online');return true;
 }
 await call('/api/account/logout',{allDevices:all});
 session=null;return true;
}
root.MegaAccount=Object.freeze({request:call,session:ensure,logout,peek:()=>session,reset:()=>{sessionGeneration++;session=null;},id,connectivity:()=>({...connectivity})});
})(globalThis);

/* The accepted party UI predates CSRF sessions. Adapt only its same-origin POSTs;
 * bearer-authenticated free LAN traffic is left unchanged. */
(function(root){
const original=root.fetch.bind(root);root.fetch=async function(resource,options={}){
 let u;try{u=new URL(typeof resource==='string'?resource:resource.url,location.href);}catch{return original(resource,options);}
 if(u.origin!==location.origin||!u.pathname.startsWith('/api/party/')||String(options.method||'GET').toUpperCase()!=='POST')return original(resource,options);
 const headers=new Headers(options.headers||{});if(u.pathname!=='/api/party/session'&&!headers.has('Authorization')){const s=await root.MegaAccount.session();headers.set('X-CSRF-Token',s.csrf);}
 document.dispatchEvent(new CustomEvent('mega:party-transport',{detail:{pending:true}}));try{return await original(resource,{...options,headers});}finally{document.dispatchEvent(new CustomEvent('mega:party-transport',{detail:{pending:false}}));}
};
})(globalThis);
