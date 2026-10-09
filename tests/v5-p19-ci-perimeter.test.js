'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {inspect,run}=require('../scripts/v5/p19/ci-perimeter.js');
const root=path.resolve(__dirname,'..');
const workflow=fs.readFileSync(path.join(root,'.github/workflows/v5-p19-load-chaos.yml'),'utf8');
const ref='$'+'{{ github.event.pull_request.head.sha || github.sha }}';
test('read-only exact source PR checkout and sanitized bounded CI evidence are enforced',()=>{
 const result=run(root);
 assert.equal(result.exactPrHeadCheckouts,2);
 assert.equal(result.productionCredentialInputs,false);
 assert.equal(result.allowedEvidenceFiles,4);
 assert.ok(result.pinnedActionCount>=6);
});
test('privileged event, mutable action or accidental PR merge SHA fails the audited perimeter',()=>{
 for(const change of [
  s=>s.replace('  pull_request:\n','  pull_request_target:\n'),
  s=>s.replace('  contents: read','  contents: write'),
  s=>s.replace('actions/checkout@11d5960a326750d5838078e36cf38b85af677262','actions/checkout@v4'),
  s=>s.replace('          persist-credentials: false','          persist-credentials: true'),
  s=>s.replace('ref: '+ref,'ref: '+'$'+'{{ github.sha }}'),
  s=>s.replace('P19_SOURCE_SHA: '+ref,'P19_SOURCE_SHA: '+'$'+'{{ github.sha }}'),
  s=>s.replace('--sha "$P19_SOURCE_SHA"','--sha "$GITHUB_SHA"'),
  s=>s.replace("V5_P19_DISPOSABLE: '1'","V5_P19_DISPOSABLE: '0'")
 ]){
  const changed=change(workflow);
  assert.notEqual(changed,workflow);
  assert.throws(()=>inspect(changed),/P19_CI_PERIMETER_REFUSED/);
 }
});
test('public Redis, provider token, secret or extra evidence cannot be uploaded',()=>{
 for(const change of [
  s=>s.replace('127.0.0.1:6379:6379','6379:6379'),
  s=>s.replace('redis:7.4@sha256:cd745595f143052dd6a743bc5651d3ce4b03979fe5c99c7fcfab73461f6f217b','redis:latest'),
  s=>s.replace('            .artifacts/p19-chaos-disposable.json','            .env'),
  s=>s.replace('            .artifacts/p19-chaos-disposable.json','            .artifacts/p19-chaos-disposable.json\n            .env'),
  s=>s.replace('      P19_EVIDENCE_OUTPUT:', '      VERCEL_TOKEN: '+'$'+'{{ secrets.VERCEL_TOKEN }}'+'\n      P19_EVIDENCE_OUTPUT:'),
  s=>s.replace('      - name: Run real service latency tiers','      - run: vercel deploy --prod\n      - name: Run real service latency tiers')
 ]){
  const changed=change(workflow);
  assert.notEqual(changed,workflow);
  assert.throws(()=>inspect(changed),/P19_CI_PERIMETER_REFUSED/);
 }
});
