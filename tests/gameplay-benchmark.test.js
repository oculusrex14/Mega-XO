'use strict';
/* Measured, paired-order owned-loopback microbenchmark, not a deployed latency SLA. */
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg'),fs=require('node:fs').promises,os=require('node:os'),zlib=require('node:zlib');
const lab=require('./v5-pg-lab.js'),C=require('../packages/learning/capture.js'),G=require('../src/game.js'),{createCaptureWorker}=require('../packages/learning/worker.js'),{source}=require('./helpers/gameplay-fixture.js');
lab.installCleanup(test);
const summarize=values=>{const a=[...values].sort((a,b)=>a-b);return {n:a.length,p50:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)],max:a.at(-1)};};
test('DC11 capture CPU/storage and actual move/settlement overhead measured without changing game budgets',async t=>{
 if(!await lab.boot(t))return;const db=await lab.createDatabase('capture_bench',{runtimeRoles:[...lab.RUNTIME_ROLES,'capture_runtime']});await lab.seedActors(db);
 const admin=await lab.adminClient(db);t.after(()=>admin.end());
 await admin.query("UPDATE learning.policy SET policy_version='test',approval_ref='synthetic',encryption_ref='synthetic',choice_ref='synthetic',capture_after='epoch',retention_days=7,export_retention_days=1,backup_retention_days=7,source_commit=$1,rules_hash=$2,environment='test'",['a'.repeat(40),C.RULES_HASH]);
 let now=Date.now();const core=await lab.coreFor(db,{clock:()=>now,random:()=>0.1});t.after(()=>core.close());const run=(a,k,c,scope='player')=>core.run({actor:a,scope},k,c);
 const latency={enabled:{move:[],settlement:[]},disabled:{move:[],settlement:[]}};
 // Alternate order between paired blocks to reduce monotonic warmup bias; first pair warms caches.
 for(let pair=0;pair<10;pair++)for(const enabled of pair%2?[true,false]:[false,true]){
  await admin.query('UPDATE learning.policy SET enabled=$1',[enabled]);const id='bench-'+pair+'-'+enabled;
  const offered=await run('matchmaker',id+'q',{type:'queue',id,a:'svc_alice',b:'svc_bob',mode:'casual',turnSeconds:30},'matchmaker');for(const actor of ['svc_alice','svc_bob'])await run(actor,id+actor,{type:'accept',id,termsHash:offered.termsHash});let v=await core.readMatch('svc_alice',id);
  for(let i=0;i<6;i++){now+=1000;const move=G.legal(v.state)[0],before=performance.now();const r=await run(v.symbols[v.state.turn],id+'m'+i,{type:'move',id,revision:i,move});const duration=performance.now()-before;v.state=r.state;if(pair)latency[enabled?'enabled':'disabled'].move.push(duration);}
  const start=performance.now();await run('svc_alice',id+'end',{type:'resign',id});if(pair)latency[enabled?'enabled':'disabled'].settlement.push(performance.now()-start);
 }
 await admin.query('UPDATE learning.policy SET enabled=true');const u=new URL(lab.dbUrl(db));u.username='capture_runtime';u.password='';const cap=new Pool({connectionString:u.toString()});t.after(()=>cap.end());const worker=createCaptureWorker(cap,{workerId:'bench-worker',batchSize:20});assert.equal((await worker.tick()).sealed,10);
 const cpu=[],rawBytes=[],gzipBytes=[],plies=[];
 for(let n=1;n<=200;n++){const s=source(n),start=performance.now();const v=C.seal(s,{sourceCommit:'a'.repeat(40),environment:'test',population:'test-fixture'});cpu.push(performance.now()-start);const body=C.stable(v.payload);rawBytes.push(Buffer.byteLength(body));gzipBytes.push(zlib.gzipSync(body).length);plies.push(s.revision);}
 const report={format:'gameplay-benchmark/v1',sourceCommit:process.env.GITHUB_SHA||null,rulesHash:C.RULES_HASH,
  environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,scope:'SYNTHETIC_OWNED_LOOPBACK_NOT_STAGING'},
  protocol:{pairedBlocks:10,warmupBlocksExcluded:1,movesPerGame:6,captureWorkerDuringGameplay:false,trainingExecuted:false},
  latency:Object.fromEntries(Object.entries(latency).map(([k,v])=>[k,{moveMs:summarize(v.move),settlementMs:summarize(v.settlement)}])),
  archive:{fullGames:200,plies:summarize(plies),sealMs:summarize(cpu),rawBytes:summarize(rawBytes),gzipBytes:summarize(gzipBytes)},
  warning:'Shared-runner noise and synthetic small games; no production p95 guarantee or provider storage cost claim.'};
 report.latency.moveP95DeltaMs=report.latency.enabled.moveMs.p95-report.latency.disabled.moveMs.p95;
 await fs.mkdir('.artifacts/gameplay-tests',{recursive:true});await fs.writeFile('.artifacts/gameplay-tests/benchmark.json',JSON.stringify(report,null,2)+'\n');console.log('CAPTURE_BENCHMARK '+JSON.stringify(report));
 assert.ok(cpu.every(Number.isFinite));assert.ok(rawBytes.every(x=>x<C.MAX_BYTES));assert.equal((await worker.metrics()).pending,0);
});
