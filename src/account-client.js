/* Shared account client. Same-origin HttpOnly sessions; no provider tokens in
 * localStorage. Existing API consumers keep the same interfaces. */
(function(root){
'use strict';
let session=null,loading=null;
const id=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let connectivity={state:root.navigator?.onLine===false?'offline':'online',code:'',supportId:'',at:Date.now()};
function publish(state,code='',supportId=''){
 if(connectivity.state===state&&connectivity.code===code&&connectivity.supportId===supportId)return;
 connectivity={state,code,supportId:/^MX-[A-F0-9]{16}$/.test(supportId)?supportId:'',at:Date.now()};
 try{root.document?.dispatchEvent(new CustomEvent('mega:connectivity',{detail:{...connectivity}}));}catch{}
}
function classify(code){
 if(code==='AUTH_REQUIRED')return 'auth';
 if(code==='LINK_ACCOUNT_REQUIRED')return 'auth';
 if(code==='MAINTENANCE')return 'maintenance';
 if(code==='OFFLINE'||root.navigator?.onLine===false)return 'offline';
 if(code==='REQUEST_TIMEOUT')return 'timeout';
 return 'degraded';
}
function transient(code){return ['SERVICE_UNAVAILABLE','ONLINE_UNAVAILABLE','REQUEST_TIMEOUT'].includes(code);}
async function once(path,body,operationKey,timeoutMs=8000){
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
async function call(path,body,operation){
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
async function ensure(force=false){
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
root.addEventListener?.('offline',()=>publish('offline','OFFLINE'));
root.addEventListener?.('online',()=>publish('reconnecting','ONLINE'));
root.MegaAccount=Object.freeze({request:call,session:ensure,peek:()=>session,reset:()=>{session=null;},id,connectivity:()=>({...connectivity})});
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
