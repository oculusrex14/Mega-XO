/* Optional data pack; no executable model code or economy authority. */
(function(root,factory){const api=factory(root,typeof module==='object'?require('./contracts.js'):root.MegaBotContract);if(typeof module==='object')module.exports=api;else root.MegaBotPack=api;})(globalThis,(root,C)=>{
'use strict';
const CACHE='mega-xoxo-ai-v1',ENCODING='planes8-v1',MAX_BYTES=8*1024*1024,MAX_COMPRESSED=5*1024*1024;
// Only a reviewed, strength/device/license-approved manifest belongs here.
const APPROVED_CATALOG=Object.freeze([]);
function failure(code,abort=false){const e=Error(code);e.code=code;if(abort)e.name='AbortError';return e;}
function manifest(value,baseURL){
 if(!value||value.schemaVersion!==1||value.ruleset!==C.RULESET||value.encodingVersion!==ENCODING||typeof value.version!=='string'||!/^[a-zA-Z0-9._-]{1,64}$/.test(value.version)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isInteger(value.bytes)||value.bytes<1||value.bytes>MAX_BYTES||!Number.isInteger(value.gzipBytes)||value.gzipBytes<1||value.gzipBytes>MAX_COMPRESSED)throw failure('PACK_INCOMPATIBLE');
 const base=new URL(baseURL),url=new URL(value.url,base);
 if(url.origin!==base.origin||!['https:','http:'].includes(url.protocol)||url.search||url.hash||url.username||url.password||!url.pathname.endsWith('/'+value.sha256+'.onnx'))throw failure('PACK_URL_INVALID');
 return Object.freeze({...value,url:url.href});
}
async function verify(bytes,info){
 if(!(bytes instanceof Uint8Array)||bytes.length!==info.bytes||bytes.length>MAX_BYTES)throw failure('PACK_SIZE_MISMATCH');
 if(!root.crypto?.subtle)throw failure('PACK_CRYPTO_UNSUPPORTED');
 const actual=Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 if(actual!==info.sha256)throw failure('PACK_HASH_MISMATCH');return bytes;
}
async function boundedBytes(response,info,alive,progress=()=>{}){
 if(!response?.ok||!response.body?.getReader)throw failure('PACK_DOWNLOAD_FAILED');
 const reader=response.body.getReader(),bytes=new Uint8Array(info.bytes);let received=0;
 try{while(true){const {done,value}=await reader.read();alive();if(done)break;if(!value||received+value.byteLength>info.bytes)throw failure('PACK_SIZE_MISMATCH');bytes.set(value,received);received+=value.byteLength;progress(received);}if(received!==info.bytes)throw failure('PACK_SIZE_MISMATCH');return bytes;}
 finally{try{reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}
function resolvePinned(pin,catalog=APPROVED_CATALOG){return catalog.find(m=>m.version===pin?.packVersion&&m.sha256===pin?.modelHash&&m.ruleset===pin?.ruleset&&m.encodingVersion===pin?.encodingVersion&&m.deploymentStatus==='APPROVED')||null;}
class Store {
 constructor({baseURL,cacheStorage=root.caches,fetcher=root.fetch?.bind(root),onState=()=>{},catalog=APPROVED_CATALOG}={}){
  this.baseURL=baseURL||root.location?.href;this.caches=cacheStorage;this.fetch=fetcher;this.onState=onState;this.catalog=catalog;
  this.state={status:'unavailable',receivedBytes:0,totalBytes:null,error:null};this.sequence=0;this.controller=null;this.inflight=new Set();this.removing=false;
 }
 emit(status,extra={}){this.state={...this.state,...extra,status};try{this.onState({...this.state});}catch{}return this.state;}
 info(value){return manifest(value,this.baseURL);}
 async cache(){if(!this.caches?.open)throw failure('PACK_STORAGE_UNSUPPORTED');return this.caches.open(CACHE);}
 track(promise){this.inflight.add(promise);promise.finally(()=>this.inflight.delete(promise)).catch(()=>{});return promise;}
 pause(){this.sequence++;this.controller?.abort();this.controller=null;this.emit('paused',{error:null});}
 read(value){
  if(this.removing)return Promise.reject(failure('PACK_BUSY'));let info;try{info=this.info(value);}catch(e){return Promise.reject(e);}
  const sequence=this.sequence,alive=()=>{if(sequence!==this.sequence)throw failure('PACK_CANCELLED',true);};
  return this.track((async()=>{const cache=await this.cache();alive();const response=await cache.match(info.url);alive();
   if(!response){this.emit('unavailable',{version:info.version,modelHash:null,error:null});return null;}
   try{const bytes=await boundedBytes(response,info,alive);await verify(bytes,info);alive();this.emit('ready',{version:info.version,modelHash:info.sha256,receivedBytes:bytes.length,totalBytes:bytes.length,error:null});return bytes;}
   catch(e){if(e.name==='AbortError')throw e;await cache.delete(info.url);alive();this.emit('corrupt',{version:info.version,modelHash:null,error:e.code||'PACK_CORRUPT'});throw e;}
  })());
 }
 download(value,{consent=false,signal}={}){
  if(!consent)return Promise.reject(failure('PACK_CONSENT_REQUIRED'));if(this.removing)return Promise.reject(failure('PACK_BUSY'));
  let info;try{info=this.info(value);}catch(e){return Promise.reject(e);}
  this.pause();const sequence=this.sequence,controller=new AbortController();this.controller=controller;
  const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();
  const alive=()=>{if(controller.signal.aborted||sequence!==this.sequence)throw failure('PACK_DOWNLOAD_CANCELLED',true);};
  return this.track((async()=>{try{
   alive();const cache=await this.cache();alive();this.emit('downloading',{version:info.version,modelHash:null,totalBytes:info.bytes,receivedBytes:0,error:null});
   if(typeof this.fetch!=='function')throw failure('PACK_NETWORK_UNSUPPORTED');
   const response=await this.fetch(info.url,{signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});alive();
   const bytes=await boundedBytes(response,info,alive,n=>this.emit('downloading',{receivedBytes:n}));await verify(bytes,info);alive();
   await cache.put(info.url,new Response(bytes,{headers:{'Content-Type':'application/octet-stream','X-Mega-Model-SHA256':info.sha256}}));alive();
   this.emit('ready',{modelHash:info.sha256,receivedBytes:bytes.length,error:null});return bytes;
  }catch(e){if(sequence===this.sequence)this.emit(e.name==='AbortError'?'paused':/HASH|SIZE/.test(e.code||'')?'corrupt':'unavailable',{modelHash:null,error:e.code||'PACK_DOWNLOAD_FAILED'});throw e;}
  finally{signal?.removeEventListener('abort',cancel);if(this.controller===controller)this.controller=null;}})());
 }
 async remove(value){
  if(this.removing)throw failure('PACK_BUSY');const info=this.info(value);this.removing=true;this.pause();
  try{await Promise.allSettled([...this.inflight]);const cache=await this.cache();await cache.delete(info.url);this.emit('unavailable',{version:info.version,receivedBytes:0,modelHash:null,error:null});}
  finally{this.removing=false;}
 }
 pin(value){const info=this.info(value),pin={packVersion:info.version,modelHash:info.sha256,ruleset:info.ruleset,encodingVersion:info.encodingVersion};if(this.state.status!=='ready'||this.state.modelHash!==info.sha256||info.deploymentStatus!=='APPROVED'||!resolvePinned(pin,this.catalog))throw failure('PACK_NOT_APPROVED_READY');return Object.freeze(pin);}
}
return {CACHE,ENCODING,MAX_BYTES,MAX_COMPRESSED,manifest,verify,Store,APPROVED_CATALOG,resolvePinned};
});
