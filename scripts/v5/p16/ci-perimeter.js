#!/usr/bin/env node
'use strict';
/*
 * P16 read-only CI perimeter. This is a conservative source audit of OUR
 * source-only workflows on both V5 pushes and PRs, not a replacement for protected environments.
 * Never trust PR-controlled workflows with provider or release credentials.
 */
const fs = require('node:fs');
const path = require('node:path');

function refuse(reason) { throw Error('P16_CI_REFUSED:' + reason); }

function auditWorkflow(text) {
  if (typeof text !== 'string' || text.length < 500) refuse('ABSENT');
  if (!/^name: V5 P16 process failover foundations\s*$/m.test(text)) refuse('IDENTITY');
  if (!/^on:\n  push:\n    branches: \[V5-platform\]/m.test(text) ||
      !/^  pull_request:\n    branches: \[V5-platform\]/m.test(text)) refuse('TRIGGER');
  if (/^\s*(?:pull_request_target|workflow_run|workflow_dispatch|repository_dispatch|schedule):/m.test(text)) {
    refuse('UNTRUSTED_EVENT');
  }
  const events = text.slice(text.indexOf('on:\n') + 4, text.indexOf('\npermissions:'));
  const pushes = events.match(/^  push:\n(?: {4,}.*\n)+/m)?.[0];
  const reviews = events.match(/^  pull_request:\n(?: {4,}.*\n)+/m)?.[0];
  if (!pushes || !reviews || pushes.replace('  push:', '  pull_request:') !== reviews) {
    refuse('EVENT_DEPENDENCY_DRIFT');
  }
  if (!/^permissions:\n  contents: read$/m.test(text)) refuse('READ_ONLY');
  if (/^\s*(?:id-token|actions|packages|checks|deployments|issues|contents): write\s*$/m.test(text)
      || /\$\{\{\s*secrets\./.test(text)
      || /^\s*(?:GH_TOKEN|GITHUB_TOKEN|VERCEL_TOKEN|R2_|NEON_|AWS_|APP_STORE_|PLAY_)[A-Za-z_]*:/m.test(text)) {
    refuse('SECRETS_OR_WRITE');
  }
  const uses = [...text.matchAll(/^\s*-\s+uses:\s*([^\s#]+)/gm)].map(m => m[1]);
  if (uses.length !== 4 || uses.some(x => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(x))) {
    refuse('PINNED_ACTIONS');
  }
  const checkouts = [...text.matchAll(/^\s*- uses: actions\/checkout@[a-f0-9]{40} # v4\n\s+with:\n\s+persist-credentials: false$/gm)];
  if (checkouts.length !== 2) refuse('CHECKOUT_CREDENTIALS');
  if (!/^  core-drain:\n/m.test(text) || !/^  core-failure-recovery:\n/m.test(text)
      || !/tests\/v5-p16-real-sockets\.test\.js/.test(text)
      || !/tests\/v5-p16-process-failover\.test\.js/.test(text)) refuse('OWNED_SUITES');
  if (!/image: postgres:16@sha256:[a-f0-9]{64}/.test(text) ||
      !/image: redis:7\.4@sha256:[a-f0-9]{64}/.test(text) ||
      !/V5_PG_URL: postgres:\/\/postgres@127\.0\.0\.1:5432\/postgres/.test(text) ||
      !/REDIS_URL: redis:\/\/127\.0\.0\.1:6379/.test(text) ||
      !/V5_PG_DISPOSABLE: '1'/.test(text) ||
      !/V5_PG_REQUIRED: '1'/.test(text) ||
      !/V5_REDIS_REQUIRED: '1'/.test(text)) refuse('DISPOSABLE_SERVICES');
  if (!/ports: \['127\.0\.0\.1:5432:5432'\]/.test(text) ||
      !/ports: \['127\.0\.0\.1:6379:6379'\]/.test(text)) refuse('LOOPBACK_ONLY');

  if (/\b(?:curl|wget|ssh|scp|kubectl|terraform|ansible-playbook)\b/.test(text) ||
      /\b(?:docker\s+(?:push|login)|git\s+push|npm\s+publish|gh\s+release|vercel\s+(?:deploy|promote))\b/.test(text) ||
      /migrate\.js\s+--execute/.test(text) ||
      /--test-force-exit|--test-skip-pattern|\|\|\s*true/.test(text)) {
    refuse('UNTRUSTED_ACTION');
  }
  if (!/grep -Eq '\^# skipped 0\$' p16-tap\.log/.test(text) ||
      !/grep -Eq '\^# skipped 0\$' p16-real-failover\.tap/.test(text)) refuse('ZERO_SKIP_GATE');
  if (!/node scripts\/v5\/p16\/ci-perimeter\.js/.test(text)) refuse('SELF_AUDIT');
  return Object.freeze({ readOnly: true, serviceLocality: 'loopback', jobs: 2, noSkip: true });
}

function run(root = process.cwd()) {
  const location = path.join(root, '.github/workflows/v5-p16-core-failover.yml');
  return auditWorkflow(fs.readFileSync(location, 'utf8'));
}

if (require.main === module) {
  try {
    const result = run();
    process.stdout.write('P16_CI_BOUNDARY_OK jobs=' + result.jobs + ' read-only loopback\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 2;
  }
}
module.exports = { auditWorkflow, run };
