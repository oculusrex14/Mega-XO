/* Optional runtime assets are trusted application code, never supplied by a model manifest. */
'use strict';
importScripts('../game.js','contracts.js','encoding.js','pack.js','onnx.js','neural-search.js');
let model=null,manifest=null,busy=false;
self.onmessage=async event=>{
 const job=event.data;if(!job||!['initialize','choose'].includes(job.op))return;
 if(busy){self.postMessage({requestId:job.requestId,error:'NEURAL_BACKPRESSURE'});return;}busy=true;
 try{
  if(job.op==='initialize'){
   await model?.dispose();model=null;manifest=null;
   const info=MegaBotPack.manifest(job.manifest,self.location.href),bytes=new Uint8Array(job.bytes);await MegaBotPack.verify(bytes,info);
   const useGPU=job.preferGPU===true&&!!self.navigator.gpu;
   const runtimeBase=new URL('ort-1.23.2/',self.location.href).href;
   if(!self.ort){
    const script=useGPU?'ort.webgpu.min.js':'ort.wasm.min.js';
    try{importScripts(new URL(script,runtimeBase).href);}
    catch{importScripts(new URL('ort.wasm.min.js',runtimeBase).href);}
   }
   ort.env.wasm.wasmPaths=runtimeBase;
   model=new MegaBotOnnx.Model(ort,bytes,{preferGPU:useGPU,gpuAvailable:!!self.navigator.gpu});await model.initialize();manifest=info;
   self.postMessage({requestId:job.requestId,modelHash:manifest.sha256,provider:model.provider,version:'neural-worker-v1'});
  }else{
   if(!model||!manifest||job.modelHash!==manifest.sha256||typeof job.gameId!=='string'||job.revision!==job.state?.moves?.length)throw Error('NEURAL_MODEL_NOT_READY');
   const result=await MegaBotNeuralSearch.choose(job.state,{...job,infer:state=>model.infer(state)});
   MegaBotContract.assertMove(job.state,result.move);result.diagnostics.provider=model.provider;
   self.postMessage({...result,requestId:job.requestId});
  }
 }catch{self.postMessage({requestId:job.requestId,error:'NEURAL_REQUEST_FAILED'});}
 finally{busy=false;}
};
