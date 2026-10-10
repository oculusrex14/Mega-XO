/* Persistent, pinned neural Worker. Product approval remains the catalog's job. */
(function(root,factory){const api=factory(root,typeof module==='object'?require('./contracts.js'):root.MegaBotContract,typeof module==='object'?require('./pack.js'):root.MegaBotPack);if(typeof module==='object')module.exports=api;else root.MegaBotNeuralRuntime=api;})(globalThis,(root,C,P)=>{
'use strict';
const VERSION='neural-runtime-v1';
const scriptURL=typeof document!=='undefined'?document.currentScript?.src:null;
const workerURL=scriptURL?new URL('neural-worker.js',scriptURL).href:null;
function fail(code,abort=false){const e=Error(code);e.code=code;if(abort)e.name='AbortError';return e;}
class Client {
 constructor({workerFactory,baseURL,onState=()=>{},loadTimeoutMs=15000,thinkTimeoutMs=2600}={}){
  this.factory=workerFactory||(()=>{if(!workerURL||!root.Worker)throw fail('NEURAL_WORKER_UNAVAILABLE');return new root.Worker(workerURL);});
  this.baseURL=baseURL||root.location?.href;this.onState=onState;this.loadTimeoutMs=Math.max(100,Math.min(30000,Number.isFinite(loadTimeoutMs)?loadTimeoutMs:15000));this.thinkTimeoutMs=Math.max(100,Math.min(5000,Number.isFinite(thinkTimeoutMs)?thinkTimeoutMs:2600));
  this.worker=null;this.pending=null;this.info=null;this.bytes=null;this.loaded=false;this.serial=0;this.generation=0;this.busy=false;this.state={status:'unavailable',modelHash:null};
 }
 emit(status,extra={}){this.state={...this.state,...extra,status};try{this.onState({...this.state});}catch{}}
 stopWorker(){this.worker?.terminate();this.worker=null;this.loaded=false;}
 cancel(code='NEURAL_CANCELLED',abort=true){this.generation++;const pending=this.pending;this.pending=null;if(pending){clearTimeout(pending.timer);pending.reject(fail(code,abort));}if(pending||this.busy)this.stopWorker();this.emit(abort?'cancelled':'failed',{error:code});}
 unload(){this.cancel();this.stopWorker();this.bytes=null;this.info=null;this.emit('unavailable',{modelHash:null,error:null});}
 request(payload,timeout,transfer=[]){if(this.pending)return Promise.reject(fail('NEURAL_BACKPRESSURE'));return new Promise((resolve,reject)=>{
  if(!this.worker){try{this.worker=this.factory();}catch{reject(fail('NEURAL_WORKER_UNAVAILABLE'));return;}}
  const worker=this.worker,requestId=++this.serial,pending={resolve,reject,requestId};this.pending=pending;
  pending.timer=setTimeout(()=>{if(this.pending===pending)this.cancel('NEURAL_WORKER_TIMEOUT',false);},timeout);
  worker.onerror=()=>{if(this.worker===worker)this.cancel('NEURAL_WORKER_FAILURE',false);};
  worker.onmessage=event=>{if(this.worker!==worker||this.pending!==pending||event.data?.requestId!==requestId)return;
   if(event.data.error){this.cancel('NEURAL_WORKER_FAILURE',false);return;}
   this.pending=null;clearTimeout(pending.timer);resolve(event.data);
  };
  try{worker.postMessage({...payload,requestId},transfer);}catch{this.cancel('NEURAL_WORKER_FAILURE',false);}
 });}
 async initialize(generation){if(this.loaded&&this.worker)return;if(!this.info||!this.bytes)throw fail('NEURAL_NOT_CONFIGURED');this.emit('loading',{modelHash:this.info.sha256,error:null});const copy=this.bytes.slice();
  const result=await this.request({op:'initialize',manifest:this.info,bytes:copy.buffer,preferGPU:true},this.loadTimeoutMs,[copy.buffer]);
  if(generation!==this.generation)throw fail('NEURAL_CANCELLED',true);
  if(result.modelHash!==this.info.sha256||!['wasm','webgpu'].includes(result.provider)){this.stopWorker();throw fail('NEURAL_INVALID_INITIALIZATION');}
  this.loaded=true;this.emit('ready',{provider:result.provider,modelHash:result.modelHash,error:null});
 }
 async configure(value,bytes,{signal}={}){
  if(this.busy)throw fail('NEURAL_BACKPRESSURE');
  this.unload();const generation=this.generation,abort=()=>this.cancel();if(signal?.aborted)throw fail('NEURAL_CANCELLED',true);signal?.addEventListener('abort',abort,{once:true});this.busy=true;
  try{const info=P.manifest(value,this.baseURL);await P.verify(bytes,info);if(generation!==this.generation)throw fail('NEURAL_CANCELLED',true);this.info=info;this.bytes=bytes.slice();await this.initialize(generation);return {...this.state};}
  catch(e){if(e.name!=='AbortError')this.emit('failed',{error:e.code||'NEURAL_INITIALIZATION_FAILED'});throw e;}
  finally{signal?.removeEventListener('abort',abort);this.busy=false;}
 }
 async choose(job,{signal}={}){
  if(this.busy)throw fail('NEURAL_BACKPRESSURE');if(!this.info||!this.bytes)throw fail('NEURAL_NOT_CONFIGURED');
  if(typeof job?.gameId!=='string'||job.gameId.length>160||job.revision!==job.state?.moves?.length||job.revision>81||job.modelHash!==this.info.sha256)throw fail('NEURAL_INVALID_REQUEST');
  if(signal?.aborted)throw fail('NEURAL_CANCELLED',true);const generation=this.generation,abort=()=>this.cancel();signal?.addEventListener('abort',abort,{once:true});this.busy=true;
  const snapshot=JSON.parse(JSON.stringify(job.state));
  try{await this.initialize(generation);if(generation!==this.generation)throw fail('NEURAL_CANCELLED',true);this.emit('thinking',{error:null});
   const result=await this.request({...job,state:snapshot,op:'choose'},this.thinkTimeoutMs);
   if(generation!==this.generation)throw fail('NEURAL_CANCELLED',true);
   C.accept({state:snapshot,gameId:job.gameId,revision:job.revision},result);
   if(result.diagnostics?.modelHash!==this.info.sha256)throw fail('NEURAL_MODEL_CHANGED');this.emit('ready',{error:null});return result;
  }catch(e){if(e.name!=='AbortError'){this.stopWorker();this.emit('failed',{error:e.code||'NEURAL_INVALID_RESULT'});}throw e;}
  finally{signal?.removeEventListener('abort',abort);this.busy=false;}
 }
}
return {VERSION,Client};
});
