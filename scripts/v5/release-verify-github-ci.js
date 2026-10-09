#!/usr/bin/env node
'use strict';
// P17: verify GitHub Actions API metadata for exact source SHA and required
// workflow conclusions. A JSON artifact alone never proves a successful run.
// Read-only, authenticated API access is optional; no deploy credentials.
const fs=require('node:fs');
const https=require('node:https');
const {CI_NAMES,verifyRefs}=require('./release-artifact-references.js');
const OWNER='oculusrex14',REPO='Mega-XO';
function fail(s){throw new Error('V5_CI_EVIDENCE_REFUSED: '+s);}
function validateRun(entry,data,sourceSha) {
  if(!data || typeof data!=='object' || Array.isArray(data)) fail('missing API run data');
  if(data.id!==entry.runId || data.head_sha!==sourceSha) fail('run ID or source SHA mismatch');
  if(data.name!==entry.workflow) fail('workflow identity mismatch');
  if(data.status!=='completed' || data.conclusion!=='success') fail('required workflow not green');
  if(data.repository?.full_name!==OWNER+'/'+REPO) fail('workflow run belongs to different repository');
  if(data.event!=='pull_request' && data.event!=='push') fail('unreviewed event type');
  if(typeof data.html_url!=='string' ||
    data.html_url!== 'https://github.com/'+OWNER+'/'+REPO+'/actions/runs/'+entry.runId) {
    fail('run URL does not match repository and ID');
  }
  return {workflow:entry.workflow,runId:entry.runId,sha:data.head_sha,conclusion:'success'};
}
function requestRun(runId,token) {
  return new Promise((resolve,reject)=>{
    const req=https.get({
      hostname:'api.github.com',
      path:'/repos/'+OWNER+'/'+REPO+'/actions/runs/'+runId,
      headers:{'User-Agent':'MegaXO-V5-CI-evidence-check','Accept':'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:'Bearer '+token}:{})},
      timeout:10000
    },response=>{
      let body='';
      response.setEncoding('utf8');
      response.on('data',part=>{body+=part;if(body.length>262144)req.destroy(new Error('oversized GitHub response'));});
      response.on('end',()=>{
        if(response.statusCode!==200)return reject(new Error('GitHub API HTTP '+response.statusCode));
        try{resolve(JSON.parse(body));}catch(e){reject(e);}
      });
    });
    req.on('timeout',()=>req.destroy(new Error('GitHub API timeout')));
    req.on('error',reject);
  });
}
async function verifyRemote(record,sha,fetcher=requestRun){
  verifyRefs(record,sha);
  const checked=[];
  for(const workflow of CI_NAMES){
    const entry=record.ciEvidence.find(x=>x.workflow===workflow);
    checked.push(validateRun(entry,await fetcher(entry.runId),sha));
  }
  return {format:'mega-v5-remote-ci-review/v1',sourceSha:sha,checked,
    verifiedGitHubRunConclusions:true,
    verifiedRegistryImages:false,verifiedVercelDeployment:false,
    authorizesDeployment:false};
}
async function main(args,env=process.env){
  if(args.length!==4 || args[0]!=='--file' || args[2]!=='--sha')fail('usage: --file .artifacts/name.json --sha COMMIT');
  if(!/^\.artifacts\/[a-z0-9][a-z0-9._-]*\.json$/.test(args[1]))fail('scoped artifact JSON required');
  if(!/^[a-f0-9]{40}$/.test(args[3]))fail('exact commit SHA required');
  const stat=fs.lstatSync(args[1]);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>131072)fail('untrusted input file');
  const data=JSON.parse(fs.readFileSync(args[1],'utf8'));
  return verifyRemote(data,args[3],id=>requestRun(id,env.GITHUB_TOKEN||''));
}
if(require.main===module){
  main(process.argv.slice(2)).then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n'),
    e=>{process.stderr.write(e.message+'\n');process.exitCode=2;});
}
module.exports={validateRun,verifyRemote,requestRun,main};
