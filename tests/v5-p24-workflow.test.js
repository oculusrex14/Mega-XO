'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const yaml=fs.readFileSync(path.join(__dirname,'../.github/workflows/v5-p24-scale-readiness.yml'),'utf8');
const WATCH=Object.freeze([
 '.github/workflows/v5-p24-scale-readiness.yml',
 '.github/workflows/v5-p19-load-chaos.yml',
 '.github/workflows/v5-p23-retirement-foundations.yml',
 'scripts/v5/p24/**','scripts/v5/p19/**','scripts/v5/p23/**',
 'tests/v5-p24-*.test.js','tests/v5-p19-*.test.js',
 'docs/v5/progress.json','docs/v5/evidence/**',
 'packages/db/**','packages/services/**','packages/migrations/**',
 'apps/**','deploy/**','infra/**','server/**','native/**',
]);
function fail(why){throw Error('P24_WORKFLOW_REFUSED:'+why);}
function audit(src){
 if(!/^name: V5 P24 evidence-led scaling foundations$/m.test(src)||
    !/^on:\n  push:\n    branches: \[V5-platform\]/m.test(src)||
    !/^  pull_request:\n    branches: \[V5-platform\]/m.test(src)||
    /^\s*(?:pull_request_target|workflow_dispatch|workflow_run|repository_dispatch|schedule):/m.test(src))
   fail('UNTRUSTED_EVENT');
 const a=src.indexOf('\non:\n'),b=src.indexOf('\npermissions:\n');
 if(a<0||b<=a)fail('EVENTS');
 const events=src.slice(a+1,b);
 const push=events.match(/^  push:\n(?: {4,}.*\n?)+/m)?.[0];
 const pr=events.match(/^  pull_request:\n(?: {4,}.*\n?)+/m)?.[0];
 if(!push||!pr||push.replace(/^  push:/,'  pull_request:').trimEnd()!==pr.trimEnd())fail('EVENT_WATCH_DRIFT');
 for(const pattern of WATCH)if(!push.includes("      - '"+pattern+"'"))fail('MISSING_DEPENDENCY_'+pattern);
 if(!/^permissions:\n  contents: read$/m.test(src)||
    /^\s*[A-Za-z_-]+: write$/m.test(src)||
    /\$\{\{\s*secrets\./.test(src)||
    /persist-credentials:\s*true/.test(src)||
    /^\s*(?:environment:|id-token:|secrets:)/m.test(src))fail('CREDENTIAL_ACCESS');
 const actions=[...src.matchAll(/^\s*- uses: ([^\s#]+)/gm)].map(x=>x[1]);
 if(actions.length!==2||actions.some(x=>!/^[-\w.]+\/[-\w.]+@[0-9a-f]{40}$/.test(x))||
    !src.includes('persist-credentials: false'))fail('PINNED_ACTIONS');
 const head='${{ github.event.pull_request.head.sha || github.sha }}';
 if(!src.includes("ref: "+head)||!src.includes('P24_SOURCE_SHA: '+head)||
    !src.includes('test "$(git rev-parse HEAD)" = "$P24_SOURCE_SHA"')||
    !src.includes('sourceSha:process.env.P24_SOURCE_SHA'))fail('SOURCE_PROVENANCE');
 for(const path of [
  'tests/v5-p24-capacity-baseline.test.js',
  'tests/v5-p24-scale-policy.test.js',
  'tests/v5-p24-scaling-review.test.js',
  'tests/v5-p24-review-cli.test.js',
  'tests/v5-p24-workflow.test.js',
 ])if(!src.includes(path))fail('SUITE_OMITTED_'+path);
 for(const proof of [
  "grep -Eq '^# tests [1-9][0-9]*$'",
  "grep -Eq '^# pass [1-9][0-9]*$'",
  "grep -Eq '^# fail 0$'",
  "grep -Eq '^# skipped 0$'",
  'result.productionMutationAuthorized!==false',
  'result.actualScaleApplied!==false',
  'result.g24Accepted!==false',
 ])if(!src.includes(proof))fail('FALSE_GREEN');
 if(/--test-skip-pattern|\|\|\s*true|^\s*-\s*run:.*(?:ssh|scp|kubectl|terraform|vercel deploy)/m.test(src)||
    /^\s*-\s*uses:\s*[^#\n]*(?:upload-artifact|download-artifact)/m.test(src))fail('FORBIDDEN_SIDE_EFFECT');
 if(!src.includes('group: v5-p24-${{')||
    src.includes('group: v5-p24-\\${{'))fail('BROKEN_CONCURRENCY');
 return {readOnly:true,exactSource:true,symmetricScopes:true,noSkip:true};
}
test('P24 uses read-only exact-SHA push/PR workflow with mandatory no-skip tests',()=>{
 assert.deepEqual(audit(yaml),
  {readOnly:true,exactSource:true,symmetricScopes:true,noSkip:true});
});
test('privileged jobs, broad tokens or unpinned actions cannot be introduced',()=>{
 for(const mutate of [
  x=>x.replace('  pull_request:', '  pull_request_target:'),
  x=>x.replace('  contents: read','  contents: write'),
  x=>x.replace('persist-credentials: false','persist-credentials: true'),
  x=>x.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v4'),
  x=>x.replace('    branches: [V5-platform]','    branches: [main]'),
  x=>x.replace('group: v5-p24-${{','group: v5-p24-\\${{'),
 ])assert.throws(()=>audit(mutate(yaml)),/P24_WORKFLOW_REFUSED/);
});
test('P19/P23 upstream change scopes, latest head and threshold safety cannot drift',()=>{
 for(const mutate of [
  x=>x.replace("      - 'scripts/v5/p19/**'","      - 'scripts/v5/p19/metrics.js'"),
  x=>x.replace("      - 'docs/v5/progress.json'","      - 'docs/v5/README.md'"),
  x=>x.replace("      - 'deploy/**'","      - 'deploy/docker-compose.yaml'"),
  x=>x.replace('sourceSha:process.env.P24_SOURCE_SHA','sourceSha:"fake"'),
  x=>x.replace('ref: ${{ github.event.pull_request.head.sha || github.sha }}','ref: main'),
  x=>x.replace("grep -Eq '^# skipped 0$'","echo skip-ok"),
  x=>x.replace('result.actualScaleApplied!==false','result.actualScaleApplied===true'),
 ])assert.throws(()=>audit(mutate(yaml)),/P24_WORKFLOW_REFUSED/);
});
