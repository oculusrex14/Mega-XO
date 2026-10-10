#!/usr/bin/env node
'use strict';

/*
 * Offline GitHub Actions evidence triage. Never diagnose WHY GitHub did not
 * allocate a runner (billing/policy/service are hypotheses), never conflate
 * pre-step failures with failed source tests, and never mark release green.
 * Optional CLI accepts a sanitized local JSON export, not provider secrets.
 */
const fs=require('node:fs');
const path=require('node:path');
const SHA=/^[0-9a-f]{40}$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const TERMINAL=new Set(['success','failure','cancelled','skipped','timed_out','action_required']);
function refuse(reason){throw Error('V5_CI_DIAGNOSTIC_REFUSED:'+reason);}
function exact(o,fields,label){
  if(!o||typeof o!=='object'||Array.isArray(o)||
    Object.keys(o).sort().join('|')!==[...fields].sort().join('|'))refuse('FIELDS_'+label);
}
function diagnose(snapshot){
  exact(snapshot,['format','repository','sourceSha','observedAtUtc','runs'],'SNAPSHOT');
  if(snapshot.format!=='mega-v5-ci-runner-observations/v1'||
    snapshot.repository!=='oculusrex14/Mega-XO'||!SHA.test(snapshot.sourceSha)||
    typeof snapshot.observedAtUtc!=='string'||!UTC.test(snapshot.observedAtUtc)||
    !Number.isFinite(Date.parse(snapshot.observedAtUtc))||
    !Array.isArray(snapshot.runs)||!snapshot.runs.length||snapshot.runs.length>100)refuse('SCOPE');
  const ids=new Set(),results=[];
  for(const run of snapshot.runs){
    exact(run,['runId','workflow','sourceSha','event','status','conclusion','billableMs','jobs'],'RUN');
    if(!Number.isSafeInteger(run.runId)||run.runId<1||ids.has(run.runId)||
      typeof run.workflow!=='string'||!/^[\w ()/.:-]{4,130}$/.test(run.workflow)||
      run.sourceSha!==snapshot.sourceSha||
      !['pull_request','push'].includes(run.event)||
      !['queued','in_progress','completed'].includes(run.status)||
      (run.conclusion!==null&&!TERMINAL.has(run.conclusion))||
      !Number.isSafeInteger(run.billableMs)||run.billableMs<0||
      !Array.isArray(run.jobs)||run.jobs.length===0||run.jobs.length>50)refuse('RUN_DETAILS');
    ids.add(run.runId);
    let failed=0,executed=0,unallocated=0,finished=0,skipped=0;
    for(const job of run.jobs){
      exact(job,['jobId','conclusion','runnerName','stepsCount'],'JOB');
      if(!Number.isSafeInteger(job.jobId)||job.jobId<1||
        (job.conclusion!==null&&!TERMINAL.has(job.conclusion))||
        (job.runnerName!==null&&(typeof job.runnerName!=='string'||job.runnerName.length>140))||
        !Number.isSafeInteger(job.stepsCount)||job.stepsCount<0||job.stepsCount>500)refuse('JOB_DETAILS');
      if(job.conclusion==='failure')failed++;
      if(job.conclusion!==null)finished++;
      if(job.conclusion==='skipped')skipped++;
      if(job.stepsCount>0&&typeof job.runnerName==='string'&&job.runnerName.length)executed++;
      if(job.stepsCount===0&&job.runnerName===null)unallocated++;
    }
    let classification='INCOMPLETE_OR_INCONCLUSIVE';
    if(run.status==='completed'&&run.conclusion==='failure'&&failed>0 &&
      unallocated===run.jobs.length&&run.billableMs===0) {
      classification='FAILED_BEFORE_RUNNER_OR_TEST_STEPS';
    } else if(run.status==='completed'&&run.conclusion==='failure'&&
      executed>0) {
      classification='FAILURE_AFTER_RUNNER_ALLOCATION_INSPECT_LOGS';
    } else if(run.status==='completed'&&run.conclusion==='success'&&
      executed===run.jobs.length&&finished===run.jobs.length&&skipped===0) {
      classification='EXECUTED_SUCCESS_CLAIM_VERIFY_SOURCE_AND_TESTS';
    }
    results.push({runId:run.runId,workflow:run.workflow,classification,
      executedJobs:executed,unallocatedJobs:unallocated,failedJobs:failed});
  }
  return Object.freeze({
    format:'mega-v5-ci-health-classification/v1',sourceSha:snapshot.sourceSha,
    examinedRuns:results.length,results,
    rootCauseVerified:false,
    rootCauseCandidates:['GITHUB_ACTIONS_ACCOUNT_BILLING_OR_LIMIT',
      'GITHUB_ACTIONS_REPOSITORY_RUNNER_POLICY','GITHUB_HOSTED_RUNNER_OR_SERVICE_AVAILABILITY'],
    repairPerformed:false,rerunPerformed:false,sourceTestsConsideredPassing:false,
    releaseAuthorized:false,
  });
}
function main(argv,root=process.cwd()){
  if(argv.length!==1||argv[0]!=='.artifacts/v5-ci-runs.json')refuse('ONLY_LOCAL_SANITIZED_EVIDENCE');
  const dir=fs.lstatSync(path.join(root,'.artifacts'));
  if(!dir.isDirectory()||dir.isSymbolicLink())refuse('ARTIFACT_DIRECTORY_SYMLINK');
  const file=path.join(root,argv[0]),st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>131072)refuse('ARTIFACT_FILE_UNSAFE');
  return diagnose(JSON.parse(fs.readFileSync(file,'utf8')));
}
if(require.main===module){
  try{process.stdout.write(JSON.stringify(main(process.argv.slice(2)),null,2)+'\n');}
  catch(e){process.stderr.write(e.message+'\n');process.exitCode=2;}
}
module.exports={diagnose,main};
