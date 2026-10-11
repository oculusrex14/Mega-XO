'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const G=require('../../src/game.js'),C=require('../../src/bot/contracts.js'),R=require('../../src/bot/neural-runtime.js');
const bytes=new Uint8Array([2,3,4]),hash=crypto.createHash('sha256').update(bytes).digest('hex');
const info={schemaVersion:1,version:'fixture',sha256:hash,url:'/ai/'+hash+'.onnx',bytes:3,gzipBytes:3,ruleset:C.RULESET,encodingVersion:'planes8-v1',deploymentStatus:'UNAPPROVED'};
function fixture(){const workers=[];const client=new R.Client({baseURL:'https://game.example/',workerFactory:()=>{const w={jobs:[],terminated:false,postMessage(job){this.jobs.push(job);},terminate(){this.terminated=true;},reply(value){this.onmessage({data:{requestId:this.jobs.at(-1).requestId,...value}});}};workers.push(w);return w;}});return {workers,client};}
async function ready(f){const configured=f.client.configure(info,bytes);while(!f.workers[0]?.jobs.length)await new Promise(r=>setImmediate(r));f.workers[0].reply({modelHash:hash,provider:'wasm'});await configured;}
const job=()=>({state:G.create(),gameId:'fixture',revision:0,seed:4,modelHash:hash,budgetMs:10});
async function requestReady(worker,count){while(worker.jobs.length<count)await new Promise(r=>setImmediate(r));}
test('one pinned model stays warm across legal requests; no per-move download or reload',async()=>{const f=fixture();await ready(f);for(let i=0;i<2;i++){const result=f.client.choose(job());await requestReady(f.workers[0],i+2);f.workers[0].reply({gameId:'fixture',revision:0,move:{b:4,c:4},diagnostics:{modelHash:hash}});await result;}assert.equal(f.workers.length,1);assert.equal(f.workers[0].jobs.filter(x=>x.op==='initialize').length,1);f.client.unload();assert.equal(f.client.bytes,null);});
test('cancel terminates running inference and a late callback cannot land',async()=>{const f=fixture();await ready(f);const result=f.client.choose(job()),rejected=assert.rejects(result,{name:'AbortError'});await requestReady(f.workers[0],2);f.client.cancel();f.workers[0].reply({gameId:'fixture',revision:0,move:{b:4,c:4},diagnostics:{modelHash:hash}});await rejected;assert.equal(f.workers[0].terminated,true);assert.equal(f.client.loaded,false);assert.ok(f.client.bytes);f.client.unload();});
test('stale revision, model drift and illegal cells never become a live move',async()=>{for(const patch of [{gameId:'other'},{revision:8},{move:{b:99,c:0}},{diagnostics:{modelHash:'0'.repeat(64)}}]){const f=fixture();await ready(f);const result=f.client.choose(job());await requestReady(f.workers[0],2);f.workers[0].reply({gameId:'fixture',revision:0,move:{b:4,c:4},diagnostics:{modelHash:hash},...patch});await assert.rejects(result);assert.equal(f.client.loaded,false);f.client.unload();}});
test('unload during integrity verification cannot resurrect the model',async()=>{const f=fixture(),result=f.client.configure(info,bytes);f.client.unload();await assert.rejects(result,{name:'AbortError'});assert.equal(f.client.bytes,null);assert.equal(f.workers.length,0);});
test('worker timeout is explicit, stops computation and retains no pending move',async()=>{const f=fixture();await ready(f);f.client.thinkTimeoutMs=100;await assert.rejects(f.client.choose(job()),/NEURAL_WORKER_TIMEOUT/);assert.equal(f.client.pending,null);assert.equal(f.workers[0].terminated,true);f.client.unload();});

test('concurrent configuration is rejected without replacing the first model operation',async()=>{const f=fixture(),first=f.client.configure(info,bytes);await assert.rejects(f.client.configure(info,bytes),/NEURAL_BACKPRESSURE/);while(!f.workers[0]?.jobs.length)await new Promise(r=>setImmediate(r));f.workers[0].reply({modelHash:hash,provider:'wasm'});await first;assert.equal(f.workers.length,1);assert.equal(f.client.loaded,true);f.client.unload();});
test('signal abort during choose cancels inference cleanly and marks client cancelled',async()=>{
 const f=fixture();await ready(f);
 const controller=new AbortController();
 const chosen=f.client.choose(job(),{signal:controller.signal});
 await requestReady(f.workers[0],2);
 controller.abort();
 await assert.rejects(chosen,{name:'AbortError'});
 assert.equal(f.workers[0].terminated,true);
 assert.equal(f.client.loaded,false);
 f.client.unload();
});
test('configure with corrupted bytes fails integrity verification without spawning a worker',async()=>{
 const f=fixture();
 const corruptBytes=new Uint8Array([9,9,9]);
 await assert.rejects(f.client.configure(info,corruptBytes),/PACK_HASH_MISMATCH/);
 assert.equal(f.workers.length,0);
 assert.equal(f.client.loaded,false);
 assert.equal(f.client.bytes,null);
});

test('default Worker URL stays beside the runtime module when the caller is another script',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const source=fs.readFileSync(path.resolve(__dirname,'../../src/bot/neural-runtime.js'),'utf8');
 for(const prefix of ['https://game.example/','https://game.example/legacy-game/','file:///native/bundle/']){
  const runtimeURL=prefix+'src/bot/neural-runtime.js',urls=[];
  const document={currentScript:{src:runtimeURL},querySelectorAll:()=>[{src:runtimeURL}]};
  const context={document,location:{href:prefix+'index.html'},URL,MegaBotContract:C,MegaBotPack:require('../../src/bot/pack.js'),Worker:function(url){urls.push(url);}};
  vm.runInNewContext(source,context);
  document.currentScript={src:prefix+'src/app.js'};
  new context.MegaBotNeuralRuntime.Client().factory();
  document.currentScript=null;
  new context.MegaBotNeuralRuntime.Client().factory();
  assert.deepEqual(urls,[prefix+'src/bot/neural-worker.js',prefix+'src/bot/neural-worker.js']);
 }
});
test('default Worker URL supports document-free dedicated Worker context without a deployment base',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),urls=[];
 const context={location:{href:'https://game.example/legacy-game/src/bot/client-host.js'},URL,MegaBotContract:C,MegaBotPack:require('../../src/bot/pack.js'),Worker:function(url){urls.push(url);}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../src/bot/neural-runtime.js'),'utf8'),context);
 new context.MegaBotNeuralRuntime.Client().factory();
 assert.deepEqual(urls,['https://game.example/legacy-game/src/bot/neural-worker.js']);
});
