'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {audit,run}=require('../scripts/v5/ci-safety-audit.js');
const root=path.resolve(__dirname,'..');
const workflow=fs.readFileSync(path.join(root,'.github/workflows/v5-release-engineering.yml'),'utf8');

test('P17 untrusted PR build is read-only with pinned actions and sanitized evidence',()=>{
  const result=run(root);
  assert.equal(result.readOnly,true);
  assert.ok(result.actionCount>=3);
  assert.deepEqual(result.artifacts,['v5-ci-impact.json','v5-source-candidate.json']);
});

test('rejects privileged triggers, mutable actions and secret-bearing release steps',()=>{
  const attacks=[
    workflow.replace('  pull_request:\n','  pull_request_target:\n'),
    workflow.replace('  contents: read','  contents: write'),
    workflow.replace('      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020','      - uses: actions/setup-node@v4'),
    workflow.replace('          persist-credentials: false','          persist-credentials: true'),
    workflow.replace('    timeout-minutes: 10','    environment: production\n    timeout-minutes: 10'),
    workflow.replace('          retention-days: 7','          retention-days: 7\n      - name: Bad deploy\n        run: vercel deploy --prod'),
    workflow.replace('          retention-days: 7','          retention-days: 7\n      - name: Bad token\n        env:\n          VERCEL_TOKEN: test-value')
  ];
  for(const text of attacks) {
    assert.notEqual(text,workflow);
    assert.throws(()=>audit(text),/V5_CI_PERIMETER/);
  }
});

test('refuses unexpected artifact capture paths',()=>{
  for(const text of [
    workflow.replace('.artifacts/v5-ci-impact.json','.artifacts/*'),
    workflow.replace('.artifacts/v5-source-candidate.json','.env'),
    workflow.replace('          path: |\n','          path: .\n')
  ])assert.throws(()=>audit(text),/V5_CI_PERIMETER/);
});
