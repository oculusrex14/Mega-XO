'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const { TASKS,plan,loadSource }=require('../scripts/v5/p18/acceptance-registry.js');
const { FORMAT,evaluate }=require('../scripts/v5/p18/stage-evidence.js');
const root=path.resolve(__dirname,'..'),sha='a'.repeat(40);
const stage=require('../docs/v5/environments/staging.json');
function fixture(status='NOT_RUN') {
  const tasks=plan(loadSource(root)).tasks.map((task,n)=>({
    taskId:task.taskId, status,level:task.evidenceLevel,sourceSha:sha,
    observedAtUtc:status==='NOT_RUN'?null:'2026-10-09T00:00:00Z',
    runId:status==='NOT_RUN'?null:1000+n,
    proofs:status==='NOT_RUN'?[]:task.requiredEvidence.map((kind,i)=>({
      kind,ref:'artifact://staging/p18-'+String(n)+'-'+String(i)+'-synthetic-reference'
    })),
    caseResults:task.caseIds.map((caseId,i)=>({caseId,
      status:status==='OBSERVED_FAIL' && i===0?'OBSERVED_FAIL':
        status==='OBSERVED_FAIL'?'OBSERVED_PASS':status}))
  }));
  return {format:FORMAT,sourceSha:sha,environment:'staging',
    stageNeonProjectId:stage.projectId,stageNeonBranchId:stage.branchId,
    stageNeonEndpointId:stage.endpointId,stageDatabase:stage.database,
    providerEffectsDisabled:true,tasks};
}
test('unexecuted P18 observations stay blocked, not fabricated green',()=>{
 const result=evaluate(fixture(),root,sha);
 assert.equal(result.status,'G18_EVIDENCE_INCOMPLETE');
 assert.equal(result.g18Accepted,false);
 assert.equal(result.evidenceSubmitted,false);
 assert.equal(result.tasks.length,5);
 assert.ok(result.tasks.every(x=>x.classification==='NOT_EXECUTED'));
});
test('even a perfectly filled synthetic record never certifies G18 or provider state',()=>{
 const result=evaluate(fixture('OBSERVED_PASS'),root,sha);
 assert.equal(result.status,'ALL_PASS_CLAIMS_UNVERIFIED');
 assert.equal(result.g18Accepted,false);
 assert.equal(result.requiresIndependentProviderAndExecutionReview,true);
});
test('a pass cannot hide missing cases, unexecuted cases or evidence dimensions',()=>{
 for (const change of [
   o=>o.tasks[0].proofs.pop(),
   o=>o.tasks[1].caseResults[0].status='NOT_RUN',
   o=>o.tasks[1].caseResults.pop(),
   o=>o.tasks[2].caseResults[0].caseId=o.tasks[2].caseResults[1].caseId,
   o=>o.tasks[2].runId=o.tasks[1].runId,
   o=>o.tasks[4].sourceSha='b'.repeat(40),
   o=>o.tasks[3].observedAtUtc=null
 ]) {
   const copy=fixture('OBSERVED_PASS');change(copy);
   assert.throws(()=>evaluate(copy,root,sha),/P18_EVIDENCE_REFUSED/);
 }
});
test('stage identity or outbound configuration mismatch is denied',()=>{
 for(const change of [
   o=>o.environment='production',
   o=>o.stageNeonProjectId='blue-sun-85454968',
   o=>o.stageNeonBranchId='br-dawn-dawn-b8f9n7zq',
   o=>o.providerEffectsDisabled=false,
   o=>o.sourceSha='b'.repeat(40),
   o=>o.tasks.push({...o.tasks[0]})
 ]){
   const copy=fixture();change(copy);
   assert.throws(()=>evaluate(copy,root,sha),/P18_EVIDENCE_REFUSED/);
 }
});
test('NOT_RUN cannot smuggle a claimed pass or raw credentials',()=>{
 for(const change of [
   o=>o.tasks[0].caseResults[0].status='OBSERVED_PASS',
   o=>o.tasks[0].runId=100,
   o=>o.tasks[0].proofs=[{kind:'provider_inventory',ref:'artifact://fake/pretend'}],
   o=>o.tasks[0].privateKey='SENSITIVE_VALUE',
   o=>o.tasks[1].caseResults[0].rawReceipt='SENSITIVE_VALUE'
 ]){
   const copy=fixture();change(copy);
   assert.throws(()=>evaluate(copy,root,sha),/P18_EVIDENCE_REFUSED/);
 }
});
test('evidence locations may not contain arbitrary URLs or private file paths',()=>{
 const copy=fixture('OBSERVED_PASS');
 copy.tasks[0].proofs[0].ref='https://prod.megaxo.online/secrets';
 assert.throws(()=>evaluate(copy,root,sha),/P18_EVIDENCE_REFUSED/);
 copy.tasks[0].proofs[0].ref='artifact://staging/p18-check-001';
 assert.equal(evaluate(copy,root,sha).g18Accepted,false);
});
