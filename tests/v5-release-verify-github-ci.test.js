'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {CI_NAMES}=require('../scripts/v5/release-artifact-references.js');
const {validateRun,verifyRemote}=require('../scripts/v5/release-verify-github-ci.js');
const sha='d'.repeat(40);
const entry=()=>({workflow:CI_NAMES[0],runId:123456,sourceSha:sha});
const run=()=>({id:123456,head_sha:sha,name:CI_NAMES[0],status:'completed',
  conclusion:'success',event:'pull_request',
  repository:{full_name:'oculusrex14/Mega-XO'},
  html_url:'https://github.com/oculusrex14/Mega-XO/actions/runs/123456'});
test('exact SHA, workflow, repository and successful conclusion are required',()=>{
 assert.equal(validateRun(entry(),run(),sha).conclusion,'success');
 for(const delta of [
  {head_sha:'a'.repeat(40)},{name:'Fake test'},{status:'in_progress'},
  {conclusion:'skipped'},{conclusion:'failure'},{event:'workflow_dispatch'},
  {id:1},{repository:{full_name:'other/repo'}},{html_url:'https://example.com'}
 ])assert.throws(()=>validateRun(entry(),{...run(),...delta},sha),/V5_CI_EVIDENCE_REFUSED/);
});
test('remote verification checks all three independent workflows without authorizing deployment',async()=>{
 const record={
  format:'mega-v5-artifact-references/v1',sourceSha:sha,version:'5.5.0',
  api:{deploymentId:'dpl_1234567890123456',sourceSha:sha,buildEnvironment:'production',domainsAssigned:false},
  core:{image:'ghcr.io/oculusrex14/mega-xo-core@sha256:'+'a'.repeat(64),sourceSha:sha,platforms:['linux/arm64','linux/amd64']},
  worker:{image:'ghcr.io/oculusrex14/mega-xo-worker@sha256:'+'b'.repeat(64),sourceSha:sha,platforms:['linux/arm64','linux/amd64']},
  ciEvidence:CI_NAMES.map((workflow,i)=>({workflow,runId:123456+i,sourceSha:sha}))
 };
 const result=await verifyRemote(record,sha,async id=>({
  ...run(),id,name:record.ciEvidence.find(x=>x.runId===id).workflow,
  html_url:'https://github.com/oculusrex14/Mega-XO/actions/runs/'+id
 }));
 assert.equal(result.checked.length,3);
 assert.equal(result.verifiedGitHubRunConclusions,true);
 assert.equal(result.authorizesDeployment,false);
 await assert.rejects(verifyRemote(record,sha,async id=>({...run(),id,conclusion:'failure'})),/V5_CI_EVIDENCE_REFUSED/);
});
