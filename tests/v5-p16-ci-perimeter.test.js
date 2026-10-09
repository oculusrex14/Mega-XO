'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditWorkflow } = require('../scripts/v5/p16/ci-perimeter');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/v5-p16-core-failover.yml'), 'utf8');

test('actual P16 dual-job workflow watches identical V5 push/PR dependencies with read-only credentials', () => {
  assert.deepEqual(auditWorkflow(workflow), {
    readOnly: true, serviceLocality: 'loopback', jobs: 2, noSkip: true,
  });
});

test('privileged events, write token or provider secret references are refused', () => {
  const inputs = [
    workflow.replace('  pull_request:', '  pull_request_target:'),
    workflow.replace('  push:', '  workflow_dispatch:'),
    workflow.replace('    branches: [V5-platform]', '    branches: [main]'),
    workflow.replace("      - 'packages/services/**'", "      - 'packages/services/not-all.js'"),
    workflow.replace('  contents: read', '  contents: write'),
    workflow.replace('permissions:', 'env:\n  GH_TOKEN: unexpected\npermissions:'),
  ];
  for (const body of inputs) assert.throws(() => auditWorkflow(body), /P16_CI_REFUSED/);
});

test('unreviewed actions, external services and public port binding are refused', () => {
  const inputs = [
    workflow.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4'),
    workflow.replace('persist-credentials: false', 'persist-credentials: true'),
    workflow.replace('postgres://postgres@127.0.0.1:5432/postgres', 'postgres://admin@prod.example.net:5432/db'),
    workflow.replace("'127.0.0.1:6379:6379'", "'0.0.0.0:6379:6379'"),
    workflow.replace(/redis:7\.4@sha256:[0-9a-f]{64}/, 'redis:latest'),
    workflow.replace(/image: [^\n]*postgres:16@sha256:[a-f0-9]{64}/,
      'image: evil.invalid/library/postgres:16@sha256:' + 'a'.repeat(64)),
  ];
  for (const body of inputs) assert.throws(() => auditWorkflow(body), /P16_CI_REFUSED/);
});

test('deployment commands, missing guards and bypassed tests are refused', () => {
  const inputs = [
    workflow + '\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ssh root@prod\n',
    workflow.replace("V5_PG_REQUIRED: '1'", "V5_PG_REQUIRED: '0'"),
    workflow.replace("grep -Eq '^# skipped 0$' p16-real-failover.tap", 'true'),
    workflow.replace('node scripts/v5/p16/ci-perimeter.js', 'echo audit disabled'),
    workflow.replace('tests/v5-p16-process-failover.test.js', 'tests/fake.test.js'),
  ];
  for (const body of inputs) assert.throws(() => auditWorkflow(body), /P16_CI_REFUSED/);
});
