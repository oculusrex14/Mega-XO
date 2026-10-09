'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {SCENARIOS,plan,assess}=require('../scripts/v5/p19/chaos-contract.js');
const SHA='c'.repeat(40),DIGEST='a'.repeat(64);
function rows(){
 return SCENARIOS.map(s=>({scenario:s.id,status:s.class==='DISPOSABLE'?'LOCAL_MEASURED':'NOT_EXECUTED',
   durationMs:s.class==='DISPOSABLE'?20:null,
   beforeDigest:s.class==='DISPOSABLE'?DIGEST:null,
   afterDigest:s.class==='DISPOSABLE'?DIGEST:null}));
}
test('P19 explicitly blocks claiming unbuilt multi-instance, socket or worker chaos as passed',()=>{
 const p=plan();
 assert.equal(p.g19Accepted,false);
 assert.ok(p.scenarios.some(s=>s.scenario==='core_ab_process_crash_and_socket_reconnect'));
 assert.ok(p.scenarios.some(s=>s.scenario==='reordered_provider_callbacks'));
 assert.equal(p.scenarios.every(s=>s.status==='NOT_EXECUTED'),true);
 const evidence=assess({sourceSha:SHA,observations:rows()});
 assert.equal(evidence.localScenarioCount,4);
 assert.equal(evidence.unexecutedScenarioCount,5);
 assert.equal(evidence.g19Accepted,false);
 assert.equal(evidence.independentlyObservedOnRealStaging,false);
 assert.equal(evidence.fullServiceFailureRecoveryMeasured,false);
});
test('durable-state difference, faked staging execution and incomplete scenario counts are refused',()=>{
 const attacks=[
  r=>{r[0].afterDigest='b'.repeat(64);},
  r=>{r[1].durationMs=-1;},
  r=>{r[2].beforeDigest=null;},
  r=>{r[3].status='PASS';},
  r=>{r[4].status='LOCAL_MEASURED';r[4].durationMs=20;r[4].beforeDigest=DIGEST;r[4].afterDigest=DIGEST;},
  r=>{r[5].scenario='redis_namespace_wipe';},
  r=>{r.pop();},
  r=>{r[6].durationMs=9;},
 ];
 for(const attack of attacks){
  const data=rows();attack(data);
  assert.throws(()=>assess({sourceSha:SHA,observations:data}),/P19_CHAOS_REFUSED/);
 }
 assert.throws(()=>assess({sourceSha:'not-a-sha',observations:rows()}),/P19_CHAOS_REFUSED/);
});
test('unexecuted local scenario must not be represented as measured or skipped success',()=>{
 const o=rows();
 o[0]={scenario:o[0].scenario,status:'NOT_EXECUTED',
  durationMs:null,beforeDigest:null,afterDigest:null};
 const result=assess({sourceSha:SHA,observations:o});
 assert.equal(result.localScenarioCount,3);
 assert.equal(result.unexecutedScenarioCount,6);
});
