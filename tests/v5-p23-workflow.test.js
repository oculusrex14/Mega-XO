'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/v5-p23-retirement-foundations.yml'),'utf8');

function audit(src){
  function fail(s){throw Error('P23_CI_REFUSED:'+s);}
  if(!/^name: V5 P23 legacy retirement foundations$/m.test(src) ||
    !/^on:\n  push:\n    branches: \[V5-platform\]/m.test(src)||
    !/^  pull_request:\n    branches: \[V5-platform\]/m.test(src)||
    /^\s*(?:pull_request_target|workflow_run|workflow_dispatch|repository_dispatch|schedule):/m.test(src))fail('EVENT');
  const events=src.slice(src.indexOf('on:\n')+4,src.indexOf('\npermissions:'))+'\n';
  const push=events.match(/^  push:\n(?: {4,}.*\n)+/m)?.[0];
  const pr=events.match(/^  pull_request:\n(?: {4,}.*\n)+/m)?.[0];
  if(!push||!pr||push.replace('  push:','  pull_request:')!==pr)fail('WATCHLIST_DRIFT');
  const required=[
    'scripts/v5/p23/**','scripts/v5/p22/**','docs/v5/progress.json',
    'docs/v5/evidence/**','packages/**','server/**','apps/**','deploy/**',
    'native/**','tools/v5-migration/**','tests/v5-p23-*.test.js',
    'tests/v5-ci-runner-diagnostic.test.js',
  ];
  for(const p of required)if(!push.includes("      - '"+p+"'"))fail('MISSING_PATH_'+p);
  if(!/^permissions:\n  contents: read$/m.test(src)||
    /^\s*[a-z-]+: write$/m.test(src)||
    /\$\{\{\s*secrets\./.test(src)||
    /persist-credentials: true/.test(src))fail('SECRET_OR_WRITE_TOKEN');
  if(!/group: v5-p23-\$\{\{/.test(src) || /group: v5-p23-\\\$\{\{/.test(src))fail('ESCAPED_CONCURRENCY_EXPRESSION');
  const uses=[...src.matchAll(/^\s*- uses: ([^\s#]+)/gm)].map(x=>x[1]);
  if(uses.length!==2||uses.some(x=>!/^[-\w.]+\/[-\w.]+@[0-9a-f]{40}$/.test(x))||
    !src.includes('persist-credentials: false'))fail('UNPINNED_ACTION_OR_GIT_CREDS');
  if(/^\s*- (?:run:|name:).*\b(?:ssh|scp|kubectl|terraform|docker push|vercel deploy|git push)\b/m.test(src) ||
    /--test-force-exit|--test-skip-pattern|\|\|\s*true/.test(src)||
    /^\s*(?:environment:|secrets:|id-token:)/m.test(src))fail('SIDE_EFFECT_OR_TEST_BYPASS');
  for(const suite of ['retirement-readiness','retention-manifest','compatibility-sunset','delivery-report','workflow']){
    if(!src.includes('tests/v5-p23-'+suite+'.test.js'))fail('MISSING_SUITE_'+suite);
  }
  for(const required of [
    'tests/v5-ci-runner-diagnostic.test.js',
    "grep -Eq '^# fail 0$' p23-source.tap",
    "grep -Eq '^# skipped 0$' p23-source.tap",
    'report.v4RetirementAuthorized !== false',
    'report.g23Accepted !== false',
  ])if(!src.includes(required))fail('FALSE_GREEN_GUARD');
  return { readOnly:true, trustedPushAndPr:true, noSkip:true };
}
test('P23 workflow runs exact-source no-skip safeguards on matching V5 push and PR',()=>{
  assert.deepEqual(audit(workflow),{readOnly:true,trustedPushAndPr:true,noSkip:true});
});
test('privileged events, service accounts and unsafe checkout are rejected',()=>{
  for(const mutate of [
    x=>x.replace('  push:', '  workflow_dispatch:'),
    x=>x.replace('  pull_request:', '  pull_request_target:'),
    x=>x.replace('  contents: read', '  contents: write'),
    x=>x.replace('persist-credentials: false','persist-credentials: true'),
    x=>x.replace('group: v5-p23-${{','group: v5-p23-\\${{'),
    x=>x.replace(/actions\/checkout@[0-9a-f]{40}/,'actions/checkout@v4'),
    x=>x.replace('    branches: [V5-platform]', '    branches: [main]'),
  ])assert.throws(()=>audit(mutate(workflow)),/P23_CI_REFUSED/);
});
test('caller dependency watchlists and zero-skip checks cannot be removed',()=>{
  for(const mutate of [
    x=>x.replace("      - 'server/**'","      - 'server/accounts-only.js'"),
    x=>x.replace("      - 'docs/v5/progress.json'","      - 'docs/v5/TODO.md'"),
    x=>x.replace("grep -Eq '^# skipped 0$' p23-source.tap",'echo skipped'),
    x=>x.replace('report.v4RetirementAuthorized !== false','report.v4RetirementAuthorized === true'),
    x=>x.replace('tests/v5-p23-compatibility-sunset.test.js','tests/fake.test.js'),
  ])assert.throws(()=>audit(mutate(workflow)),/P23_CI_REFUSED/);
});
