/* Shared account client. Same-origin HttpOnly sessions; no provider tokens in
 * localStorage. Existing API consumers keep the same interfaces. */
(function(root){
'use strict';
let session=null,loading=null;
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
function nativeSessionFromProfile(profile){
 if(!profile||typeof profile!=='object'||typeof profile.id!=='string'||!profile.id)return null;
 return {linked:true,csrf:null,native:true,expiresAt:Date.now()+300000,actorId:profile.id,profile,providers:Object.fromEntries((profile.providers||[]).map(p=>[p,{web:false,native:true,linked:true}]))};
}
async function nativeEnsure(force=false){
 if(session&&!force)return session;
 if(loading)return loading;
 loading=(async()=>{
  const host=native();
  const state=await host.session();
  if(!state||state.online!==true)throw Error('ONLINE_UNAVAILABLE');
  if(state.linked!==true)return {linked:false,csrf:null,actorId:state.actorId||null,profile:null,providers:{}};
  // An expired access token is refreshed once before the profile read, never mid-flight.
  if(Number(state.expiresAt||0)<=Date.now()+1000){
   const rotated=await host.refresh();
   if(!rotated||rotated.ok!==true){const error=nativeError(rotated||{error:'AUTH_REQUIRED'});publish(classify(error.message),error.message);throw error;}
  }
  const profile=await host.request('/api/account/profile','GET',null,null);
  if(!profile||profile.ok!==true)throw nativeError(profile||{});
  const parsed=nativeSessionFromProfile(profile.data);
  if(!parsed)throw Error('SERVICE_UNAVAILABLE');
  session=parsed;publish('online');return parsed;
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
 if(native()&&session?.native&&Date.now()>=Number(session.expiresAt||0)){
  const rotated=await native().refresh();
  if(!rotated||rotated.ok!==true){session=null;publish('auth','AUTH_REQUIRED');throw nativeError(rotated||{error:'AUTH_REQUIRED'});}
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
  session=null;publish('online');return true;
 }
 await call('/api/account/logout',{allDevices:all});
 session=null;return true;
}
root.MegaAccount=Object.freeze({request:call,session:ensure,logout,peek:()=>session,reset:()=>{session=null;},id,connectivity:()=>({...connectivity})});
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
