'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),G=require('../../src/game.js'),{Model}=require('../../src/bot/onnx.js');
function runtime(){const providers=[],released=[];return {providers,released,env:{wasm:{}},Tensor:class{constructor(type,data,dims){this.data=data;this.dims=dims;}dispose(){}},InferenceSession:{async create(bytes,{executionProviders:[p]}){providers.push(p);return {async run(){if(p==='webgpu')throw Error('device lost');return {policy:{data:new Float32Array(81)},value:{data:new Float32Array([.2])}};},release(){released.push(p);}};}}};}
test('unhealthy WebGPU warmup falls back to single-thread WASM and keeps legal masks',async()=>{const ort=runtime(),model=new Model(ort,new Uint8Array([1]),{preferGPU:true,gpuAvailable:true});await model.initialize();assert.deepEqual(ort.providers,['webgpu','wasm']);assert.equal(ort.env.wasm.numThreads,1);const state=G.apply(G.create(),{b:0,c:4}),result=await model.infer(state);assert.equal(result.provider,'wasm');assert.equal(result.policy.filter(x=>x>0).length,9);await model.dispose();await assert.rejects(model.infer(state),/NOT_READY/);});
test('pre-aborted inference and malformed neural values cannot return an action',async()=>{const ort=runtime(),model=new Model(ort,new Uint8Array([1]));await model.initialize();const c=new AbortController();c.abort();await assert.rejects(model.infer(G.create(),{signal:c.signal}),{name:'AbortError'});model.session.run=async()=>({policy:{data:new Float32Array(81)},value:{data:new Float32Array([NaN])}});await assert.rejects(model.infer(G.create()),/INVALID_NEURAL_OUTPUT/);await model.dispose();});
test('parallel initialization cannot leak a second runtime session',async()=>{const ort=runtime(),model=new Model(ort,new Uint8Array([1]));const first=model.initialize();await assert.rejects(model.initialize(),/NEURAL_INITIALIZING/);await first;await model.initialize();assert.deepEqual(ort.providers,['wasm']);await model.dispose();});
test('failed warmup releases its input tensor before attempting a fallback',async()=>{const ort=runtime();let disposed=0;ort.Tensor=class{constructor(type,data,dims){this.data=data;this.dims=dims;}dispose(){disposed++;}};const model=new Model(ort,new Uint8Array([1]),{preferGPU:true,gpuAvailable:true});await model.initialize();assert.equal(disposed,2);assert.deepEqual(ort.released,['webgpu']);await model.dispose();});
test('healthy WebGPU warmup followed by runtime error during infer falls back to WASM',async()=>{
 const providers=[],released=[];
 let webgpuWarmupDone=false;
 const ort={
  providers,released,env:{wasm:{}},
  Tensor:class{constructor(type,data,dims){this.data=data;this.dims=dims;}dispose(){}},
  InferenceSession:{
   async create(bytes,{executionProviders:[p]}){
    providers.push(p);
    return {
     async run(){
      if(p==='webgpu'){
       if(!webgpuWarmupDone){webgpuWarmupDone=true;return {policy:{data:new Float32Array(81)},value:{data:new Float32Array([0])}};}
       throw Error('webgpu device lost mid-inference');
      }
      return {policy:{data:new Float32Array(81)},value:{data:new Float32Array([0.5])}};
     },
     release(){released.push(p);}
    };
   }
  }
 };
 const model=new Model(ort,new Uint8Array([1]),{preferGPU:true,gpuAvailable:true});
 await model.initialize();
 assert.equal(model.provider,'webgpu');
 assert.equal(providers.length,1);
 const state=G.apply(G.create(),{b:0,c:4});
 const result=await model.infer(state);
 assert.equal(result.provider,'wasm');
 assert.equal(model.fallbackReason,'webgpu-inference-failed');
 assert.ok(released.includes('webgpu'));
 assert.equal(result.policy.filter(x=>x>0).length,9);
 await model.dispose();
});
test('backpressure and terminal state handling during model inference fail cleanly',async()=>{
 const ort=runtime();
 const model=new Model(ort,new Uint8Array([1]));
 await model.initialize();
 let wonState=G.create();
 // 3-in-a-row mini board 0 for X, mini 1 for X, mini 2 for X
 for(const m of [{b:0,c:0},{b:0,c:1},{b:0,c:3},{b:0,c:4},{b:0,c:6}]) {
  if(G.legal(wonState).some(x=>x.b===m.b&&x.c===m.c&&x.player===wonState.turn)) wonState=G.apply(wonState,m);
 }
 // Test terminal state when mask has no legal moves
 const fullTerminal={board:Array(81).fill('X'),mini:Array(9).fill('X'),turn:'X',required:null,winner:'X',moves:[]};
 await assert.rejects(model.infer(fullTerminal),/NEURAL_TERMINAL_STATE/);
 await model.dispose();
});
