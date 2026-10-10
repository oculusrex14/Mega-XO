/* Reusable ORT adapter for a dedicated Worker. Runtime bytes are separately owned assets. */
(function(root,factory){const api=factory(typeof module==='object'?require('./encoding.js'):root.MegaBotEncoding);if(typeof module==='object')module.exports=api;else root.MegaBotOnnx=api;})(globalThis,(E)=>{
'use strict';
function cancelled(signal){if(signal?.aborted){const e=Error('NEURAL_CANCELLED');e.name='AbortError';throw e;}}
function outputs(result){const p=result?.policy,v=result?.value;if(!p||!v||p.data?.length!==81||v.data?.length!==1||!Array.from(p.data).every(Number.isFinite)||!Number.isFinite(v.data[0])||Math.abs(v.data[0])>1.0001)throw Error('INVALID_NEURAL_OUTPUT');return {logits:new Float32Array(p.data),value:Math.max(-1,Math.min(1,v.data[0]))};}
class Model {
 constructor(ort,bytes,{preferGPU=false,gpuAvailable=false}={}){if(!ort?.InferenceSession||!ort?.Tensor||!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>8*1024*1024)throw Error('INVALID_NEURAL_RUNTIME');this.ort=ort;this.bytes=bytes;this.preferGPU=preferGPU&&gpuAvailable;this.session=null;this.provider=null;this.busy=false;this.initializing=false;this.closed=false;this.fallbackReason=null;}
 async initialize(signal){cancelled(signal);if(this.closed)throw Error('NEURAL_DISPOSED');if(this.session)return this;if(this.initializing)throw Error('NEURAL_INITIALIZING');this.initializing=true;this.ort.env.wasm.numThreads=1;try{
  for(const provider of this.preferGPU?['webgpu','wasm']:['wasm']){let session;try{session=await this.ort.InferenceSession.create(this.bytes,{executionProviders:[provider],graphOptimizationLevel:'all'});cancelled(signal);const tensor=new this.ort.Tensor('float32',new Float32Array(648),[1,8,9,9]);const result=await session.run({planes:tensor});try{outputs(result);}finally{for(const t of Object.values(result))t.dispose?.();tensor.dispose?.();}cancelled(signal);if(this.closed)throw Error('NEURAL_DISPOSED');this.session=session;this.provider=provider;return this;
   }catch(e){await session?.release?.();if(e.name==='AbortError'||this.closed)throw e;this.fallbackReason=provider+'-initialization-failed';}}
  throw Error('NEURAL_RUNTIME_UNAVAILABLE');}finally{this.initializing=false;}
 }
 async infer(state,{signal}={}){cancelled(signal);if(this.closed||!this.session)throw Error('NEURAL_NOT_READY');if(this.busy)throw Error('NEURAL_BACKPRESSURE');this.busy=true;let input,result;
  try{const encoding=E.encode(state);if(!encoding.mask.some(Boolean))throw Error('NEURAL_TERMINAL_STATE');input=new this.ort.Tensor('float32',encoding.planes,encoding.shape);try{result=await this.session.run({planes:input});}catch(e){if(this.provider!=='webgpu')throw e;cancelled(signal);await this.session.release();this.session=null;this.preferGPU=false;this.fallbackReason='webgpu-inference-failed';await this.initialize(signal);result=await this.session.run({planes:input});}cancelled(signal);if(this.closed)throw Error('NEURAL_DISPOSED');const out=outputs(result);return {...out,policy:E.maskedPolicy(out.logits,encoding.mask),provider:this.provider};}
  finally{if(result)for(const tensor of Object.values(result))tensor.dispose?.();input?.dispose?.();this.busy=false;}
 }
 async dispose(){this.closed=true;const session=this.session;this.session=null;this.bytes=null;await session?.release?.();}
}
return {Model,outputs};
});
