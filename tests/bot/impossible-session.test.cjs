'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const G=require('../../src/game.js'),D=require('../../src/domain.js'),C=require('../../src/bot/contracts.js'),P=require('../../src/bot/pack.js'),L=require('../../src/bot/local-ai.js'),NR=require('../../src/bot/neural-runtime.js'),LS=require('../../src/bot/local-session.js');

const bytes=new Uint8Array([10,20,30,40]);
const hash=crypto.createHash('sha256').update(bytes).digest('hex');
const fixtureInfo={
  schemaVersion:1,
  version:'test-candidate-v1',
  sha256:hash,
  url:'/ai/'+hash+'.onnx',
  bytes:4,
  gzipBytes:4,
  ruleset:C.RULESET,
  encodingVersion:P.ENCODING,
  deploymentStatus:'APPROVED'
};

function createMockWorkerFactory(){
  const workers=[];
  const factory=()=>{
    const w={
      jobs:[],
      terminated:false,
      postMessage(job){this.jobs.push(job);},
      terminate(){this.terminated=true;},
      reply(value){
        const latest=this.jobs.at(-1);
        if(!latest)return;
        this.onmessage({data:{requestId:latest.requestId,...value}});
      }
    };
    workers.push(w);
    return w;
  };
  return {factory,workers};
}

function createMockStore(catalog=[fixtureInfo]){
  const cache=new Map();
  cache.set(fixtureInfo.url,new Response(bytes));
  return new P.Store({
    baseURL:'https://game.example/',
    catalog,
    cacheStorage:{
      open:async()=>({
        match:async k=>cache.get(k)?.clone(),
        put:async(k,v)=>cache.set(k,v.clone()),
        delete:async k=>cache.delete(k)
      })
    },
    fetcher:async()=>new Response(bytes)
  });
}

test('empty approved catalog truthfully reports unavailable and fails closed',async()=>{
  const {factory}=createMockWorkerFactory();
  const session=LS.createSession({
    baseURL:'https://game.example/',
    catalog:[],
    workerFactory:factory
  });
  assert.equal(session.isAvailable(),false);
  assert.equal(session.getLatestManifest(),null);
  await assert.rejects(session.prepareModel({consent:true}),/NO_APPROVED_MODEL/);
  session.destroy();
});

test('model preparation requires explicit consent when model is not cached',async()=>{
  const {factory}=createMockWorkerFactory();
  const emptyStore=new P.Store({
    baseURL:'https://game.example/',
    catalog:[fixtureInfo],
    cacheStorage:{open:async()=>({match:async()=>null,put:async()=>{},delete:async()=>{}})},
    fetcher:async()=>new Response(bytes)
  });
  const session=LS.createSession({
    baseURL:'https://game.example/',
    catalog:[fixtureInfo],
    store:emptyStore,
    workerFactory:factory
  });
  await assert.rejects(session.prepareModel(),/PACK_CONSENT_REQUIRED/);
  await assert.rejects(session.prepareModel({consent:false}),/PACK_CONSENT_REQUIRED/);
  session.destroy();
});

test('model preparation with trusted candidate configures runtime and pins model',async()=>{
  const {factory,workers}=createMockWorkerFactory();
  const store=createMockStore([fixtureInfo]);
  const session=LS.createSession({
    baseURL:'https://game.example/',
    catalog:[fixtureInfo],
    store,
    workerFactory:factory
  });

  const preparePromise=session.prepareModel({consent:true});
  while(!workers[0]?.jobs.length)await new Promise(r=>setImmediate(r));
  workers[0].reply({modelHash:hash,provider:'wasm'});
  const {manifest,pin}=await preparePromise;

  assert.equal(manifest.sha256,hash);
  assert.equal(pin.modelHash,hash);
  assert.equal(pin.packVersion,'test-candidate-v1');
  assert.equal(session.isAvailable(),true);
  session.destroy();
});

test('start match pins model and seed, applies moves, fences neural response and finishes cleanly',async()=>{
  const {factory,workers}=createMockWorkerFactory();
  const store=createMockStore([fixtureInfo]);
  const session=LS.createSession({
    baseURL:'https://game.example/',
    catalog:[fixtureInfo],
    store,
    workerFactory:factory
  });

  const preparePromise=session.prepareModel({consent:true});
  while(!workers[0]?.jobs.length)await new Promise(r=>setImmediate(r));
  workers[0].reply({modelHash:hash,provider:'wasm'});
  await preparePromise;

  const match=session.startMatch({id:'match-01',first:'X',seed:12345});
  assert.equal(match.id,'match-01');
  assert.equal(match.difficulty,'Impossible');
  assert.equal(match.engine,'neural');
  assert.equal(match.resultClass,'unverified-local-ai');
  assert.equal(match.pin.modelHash,hash);
  assert.equal(match.seed,12345);
  assert.equal(match.status,'ready');

  // Human plays cell {b:0, c:4}
  session.applyHumanMove({b:0,c:4});
  assert.equal(session.getMatch().state.moves.length,1);
  assert.equal(session.getMatch().state.turn,'O');

  // Bot chooses move
  const choosePromise=session.chooseMove();
  while(workers[0].jobs.length<2)await new Promise(r=>setImmediate(r));
  assert.equal(workers[0].jobs[1].op,'choose');
  assert.equal(workers[0].jobs[1].modelHash,hash);
  assert.equal(workers[0].jobs[1].revision,1);

  // Bot plays {b:4, c:0}
  workers[0].reply({
    gameId:'match-01',
    revision:1,
    move:{b:4,c:0},
    diagnostics:{modelHash:hash,evalScore:0.2}
  });

  const {move,diagnostics}=await choosePromise;
  assert.deepEqual(move,{b:4,c:0});
  assert.equal(diagnostics.modelHash,hash);
  assert.equal(session.getMatch().state.moves.length,2);
  assert.equal(session.getMatch().state.turn,'X');

  session.destroy();
});

test('restoring match with unavailable model marks pack-unavailable and preserves human moves',async()=>{
  const {factory}=createMockWorkerFactory();
  const session=LS.createSession({
    baseURL:'https://game.example/',
    catalog:[fixtureInfo],
    workerFactory:factory
  });

  const pin={packVersion:fixtureInfo.version,modelHash:fixtureInfo.sha256,ruleset:fixtureInfo.ruleset,encodingVersion:fixtureInfo.encodingVersion,deploymentStatus:'RESEARCH'};
  const originalMatch=L.create({id:'match-resume',first:'X',pin,seed:42},[fixtureInfo]);
  const withMove=L.accept(originalMatch,{gameId:'match-resume',revision:0,move:{b:0,c:4},diagnostics:{modelHash:hash}});
  const snapshot=L.snapshot(withMove);

  // Restore in session with empty catalog (model unavailable)
  const emptySession=LS.createSession({baseURL:'https://game.example/',catalog:[],workerFactory:factory});
  const restored=await emptySession.restoreMatch(snapshot);

  assert.equal(restored.status,'pack-unavailable');
  assert.equal(restored.difficulty,'Impossible');
  assert.equal(restored.state.moves.length,1);
  assert.deepEqual(restored.state.moves[0],{b:0,c:4,player:'X'});

  // Explicit expert fallback preserves human moves and unverified class
  const fallback=emptySession.expertFallback({confirmed:true});
  assert.equal(fallback.status,'ready');
  assert.equal(fallback.difficulty,'Expert');
  assert.equal(fallback.engine,'legacy');
  assert.equal(fallback.resultClass,'unverified-local-ai');
  assert.equal(fallback.fallbackFrom,hash);
  assert.equal(fallback.state.moves.length,1);

  // Bot move on fallback without worker and without explicit main thread fallback fails closed
  await assert.rejects(emptySession.chooseMove(),/BOT_WORKER_UNAVAILABLE|LEGACY_WORKER_UNAVAILABLE/);

  // With explicit main thread fallback, computes move with measured elapsedMs
  const fallbackBot=await emptySession.chooseMove({allowMainThreadFallback:true});
  assert.ok(fallbackBot.move);
  assert.equal(fallbackBot.diagnostics.engine,'legacy');
  assert.equal(typeof fallbackBot.diagnostics.elapsedMs,'number');
  assert.equal(emptySession.getMatch().state.moves.length,2);

  // Benign diagnostic status check
  const status=emptySession.getRuntimeStatus();
  assert.equal(status.match.engine,'legacy');
  assert.equal(status.match.difficulty,'Expert');
  assert.equal(status.match.fallbackFrom,hash);
  emptySession.destroy();
  session.destroy();
});

test('idempotent recording to localAiRecords leaves economy, daily and official stats untouched',async()=>{
  const {factory,workers}=createMockWorkerFactory();
  const store=createMockStore([fixtureInfo]);
  const session=LS.createSession({baseURL:'https://game.example/',catalog:[fixtureInfo],store,workerFactory:factory});

  const preparePromise=session.prepareModel({consent:true});
  while(!workers[0]?.jobs.length)await new Promise(r=>setImmediate(r));
  workers[0].reply({modelHash:hash,provider:'wasm'});
  await preparePromise;

  session.startMatch({id:'finished-game',first:'X',seed:999});
  // Simulate game to finish
  const rng=C.seeded(42);
  while(!session.getMatch().state.winner){
    const legal=G.legal(session.getMatch().state);
    const m=legal[Math.floor(rng()*legal.length)];
    session.match=L.accept(session.getMatch(),{
      gameId:'finished-game',
      revision:session.getMatch().state.moves.length,
      move:m,
      diagnostics:{modelHash:hash}
    });
  }

  const data=D.fresh(),before=structuredClone(data);
  const recordedFirst=session.recordMatch(data);
  assert.equal(recordedFirst,true);
  const recordedSecond=session.recordMatch(data);
  assert.equal(recordedSecond,false);

  const stats=session.stats(data);
  assert.equal(stats.games,1);
  assert.deepEqual(data.wallet,before.wallet);
  assert.deepEqual(data.daily,before.daily);
  assert.deepEqual(data.records,before.records);
  assert.deepEqual(data.processed,before.processed);

  session.destroy();
});
