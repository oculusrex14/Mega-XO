'use strict';
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');
const location=path.join(__dirname,'../.github/workflows/v5-p22-cutover-readiness.yml');
const actual=fs.readFileSync(location,'utf8');
function inspect(text){
  const bad=(reason)=>{throw Error('P22_CI_REFUSED:'+reason);};
  if(!/^name: V5 P22 cutover readiness safeguards$/m.test(text) ||
    !/^on:\n  push:\n    branches: \[V5-platform\]/m.test(text) ||
    !/^  pull_request:\n    branches: \[V5-platform\]/m.test(text) ||
    /^\s*(?:pull_request_target|workflow_run|workflow_dispatch|repository_dispatch|schedule):/m.test(text))bad('EVENT');
  const eventSpec=text.slice(text.indexOf('on:\n')+4,text.indexOf('\npermissions:'));
  const push=eventSpec.match(/^  push:\n(?: {4,}.*\n)+/m)?.[0];
  const pr=eventSpec.match(/^  pull_request:\n(?: {4,}.*\n)+/m)?.[0];
  if(!push||!pr||push.replace('  push:','  pull_request:')!==pr)bad('TRIGGER_DRIFT');
  if(!/^permissions:\n  contents: read$/m.test(text) ||
    /^\s+[a-z-]+: write$/m.test(text) ||
    /\$\{\{\s*secrets\./.test(text))bad('TOKEN');
  const uses=[...text.matchAll(/^\s*- uses: ([^\s#]+)/gm)].map(m=>m[1]);
  if(uses.length!==2 || uses.some(x=>!/^[-\w.]+\/[-\w.]+@[a-f0-9]{40}$/.test(x)) ||
    !/persist-credentials: false/.test(text))bad('PINNED_CHECKOUT');
  if(/^\s*(?:environment:|secrets:|id-token:)/m.test(text) ||
    /\b(?:curl|wget|ssh|scp|kubectl|docker\s+(?:push|login)|gh\s+release|vercel\s+(?:deploy|promote)|git\s+push)\b/.test(text) ||
    /\bmigrate\.js\s+--execute/.test(text) ||
    /\btools\/v5-migration\/cli\.js\s+(?:load|verify)\b/.test(text))bad('SIDE_EFFECTS');
  for(const name of ['readiness','writer-fence','rollback-policy','import-reconciliation','compatibility-map','workflow']){
    if(!text.includes('tests/v5-p22-'+name+'.test.js'))bad('MISSING_SUITE_'+name);
  }
  for(const phrase of ["grep -Eq '^# fail 0$'","grep -Eq '^# skipped 0$'",
    'productionWritesPermitted !== false','cutoverAuthorized !== false','g22Accepted !== false']){
    if(!text.includes(phrase))bad('FALSE_GREEN_GATE');
  }
  return {readOnly:true,execution:'STATIC_ONLY',suiteCount:6};
}
test('the actual push/PR P22 workflow is read-only, source-only and insists on zero skips',()=>{
  assert.deepEqual(inspect(actual),{readOnly:true,execution:'STATIC_ONLY',suiteCount:6});
});
test('privileged triggers, write tokens, secret access and mutable actions fail',()=>{
  for(const text of [
    actual.replace('  pull_request:', '  pull_request_target:'),
    actual.replace('  push:', '  workflow_dispatch:'),
    actual.replace('    branches: [V5-platform]', '    branches: [main]'),
    actual.replace("      - 'packages/**'", "      - 'packages/services/only.js'"),
    actual.replace('  contents: read','  contents: write'),
    actual.replace(/actions\/checkout@[a-f0-9]{40}/,'actions/checkout@v4'),
    actual.replace('persist-credentials: false','persist-credentials: true'),
    actual+'  malicious:\n    steps:\n      - run: ssh root@host\n',
    actual+'  unsafe:\n    run: vercel deploy --prod\n',
  ])assert.throws(()=>inspect(text),/P22_CI_REFUSED/);
});
test('passing only selected suites or skipping fail gating is not accepted',()=>{
  for(const text of [
    actual.replace('tests/v5-p22-rollback-policy.test.js','tests/noop.test.js'),
    actual.replace("grep -Eq '^# skipped 0$'",'echo tests-skipped-accepted'),
    actual.replace('cutoverAuthorized !== false','cutoverAuthorized === true'),
  ])assert.throws(()=>inspect(text),/P22_CI_REFUSED/);
});
