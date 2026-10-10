'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {diagnose}=require('../scripts/v5/ci-runner-diagnostic');
const SHA='a'.repeat(40);
function snapshot(){
  return {format:'mega-v5-ci-runner-observations/v1',repository:'oculusrex14/Mega-XO',
    sourceSha:SHA,observedAtUtc:'2026-10-09T10:15:00Z',
    runs:[{runId:37916692249,workflow:'V5 P19 disposable load and chaos foundations',
      sourceSha:SHA,event:'pull_request',status:'completed',conclusion:'failure',
      billableMs:0,jobs:[
        {jobId:113774504813,conclusion:'failure',runnerName:null,stepsCount:0},
        {jobId:113774505160,conclusion:'failure',runnerName:null,stepsCount:0},
      ]}],
  };
}
test('failed GH job with no assigned runner, no steps and 0 billable milliseconds is not a code test failure',()=>{
  const r=diagnose(snapshot());
  assert.equal(r.examinedRuns,1);
  assert.equal(r.results[0].classification,'FAILED_BEFORE_RUNNER_OR_TEST_STEPS');
  assert.equal(r.results[0].executedJobs,0);
  assert.equal(r.rootCauseVerified,false);
  assert.equal(r.releaseAuthorized,false);
  assert.equal(r.sourceTestsConsideredPassing,false);
});
test('actual executed failing job is a different failure class',()=>{
  const x=snapshot(),j=x.runs[0].jobs[0];
  j.runnerName='GitHub Hosted Runner';j.stepsCount=6;x.runs[0].billableMs=12000;
  assert.equal(diagnose(x).results[0].classification,
    'FAILURE_AFTER_RUNNER_ALLOCATION_INSPECT_LOGS');
});
test('successful status without observed allocated runnable jobs is not verified green',()=>{
  const x=snapshot();
  x.runs[0].conclusion='success';
  x.runs[0].jobs.forEach(j=>j.conclusion='success');
  assert.equal(diagnose(x).results[0].classification,'INCOMPLETE_OR_INCONCLUSIVE');
  x.runs[0].jobs.forEach(j=>{j.runnerName='GitHub Hosted Runner';j.stepsCount=8});
  assert.equal(diagnose(x).results[0].classification,
    'EXECUTED_SUCCESS_CLAIM_VERIFY_SOURCE_AND_TESTS');
  assert.equal(diagnose(x).sourceTestsConsideredPassing,false);
});
test('a queued job cannot be mistaken for a runnerless failure',()=>{
  const x=snapshot();
  x.runs[0].status='queued';x.runs[0].conclusion=null;
  x.runs[0].jobs[0].conclusion=null;x.runs[0].jobs[1].conclusion=null;
  assert.equal(diagnose(x).results[0].classification,'INCOMPLETE_OR_INCONCLUSIVE');
});
test('foreign repository, source drift, negative step data and fabricated schema are refused',()=>{
  for(const mutate of [
    x=>{x.repository='someone/other'},
    x=>{x.runs[0].sourceSha='c'.repeat(40)},
    x=>{x.runs[0].jobs[0].stepsCount=-1},
    x=>{x.runs[0].event='pull_request_target'},
    x=>{x.runs[0].billableMs=-1},
    x=>{x.runs[0].secret='github_pat_redacted'},
    x=>{x.runs.push({...x.runs[0]})},
  ]){
    const x=snapshot();mutate(x);
    assert.throws(()=>diagnose(x),/V5_CI_DIAGNOSTIC_REFUSED/);
  }
});
