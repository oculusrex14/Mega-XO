/* Shared account client. Same-origin HttpOnly sessions; no provider tokens in
 * localStorage. Existing API consumers keep the same interfaces. */
(function(root){
'use strict';
let session=null,loading=null;
const id=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
async function call(path,body,operation){const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),8000);try{
 if(body!==undefined&&!session)await ensure();
 const res=await fetch(path,{credentials:'same-origin',method:body===undefined?'GET':'POST',signal:ctrl.signal,headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':session.csrf,'Idempotency-Key':operation||id()},body:body===undefined?undefined:JSON.stringify(body)});let out;try{out=await res.json();}catch{throw Error('SERVICE_UNAVAILABLE');}if(!res.ok){if(out.error==='AUTH_REQUIRED')session=null;throw Error(out.error||'SERVICE_UNAVAILABLE');}return out;
 }catch(e){throw Error(e.name==='AbortError'?'SERVICE_UNAVAILABLE':e.message);}finally{clearTimeout(timeout);}}
async function ensure(force=false){if(session&&!force)return session;if(loading)return loading;loading=(async()=>{const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),4500);try{const res=await fetch('/api/account/session',{credentials:'same-origin',signal:ctrl.signal});if(!res.ok)throw Error('SERVICE_UNAVAILABLE');const s=await res.json();if(!s||typeof s.csrf!=='string')throw Error('SERVICE_UNAVAILABLE');session=s;return s;}finally{clearTimeout(t);loading=null;}})();return loading;}
root.MegaAccount=Object.freeze({request:call,session:ensure,peek:()=>session,reset:()=>{session=null;},id});
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
