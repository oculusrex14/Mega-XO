'use strict';
/*
 * Co-dev compatibility guard: shared runtime/schema/identity changes MUST
 * trigger the relevant consumer jobs, even if no phase-owned source changes.
 * These are source-level route/CI dependency checks, not proof that any job
 * executed, or that any phase gate is accepted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function workflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');
}
function eventPaths(yaml, event) {
  const lines = yaml.split('\n');
  let eventActive = false;
  let pathsActive = false;
  const paths = [];
  for (const line of lines) {
    if (/^  [a-z][a-z_-]*:\s*$/.test(line)) {
      eventActive = line.trim() === event + ':';
      pathsActive = false;
      continue;
    }
    if (!eventActive) continue;
    if (/^    paths:\s*$/.test(line)) { pathsActive = true; continue; }
    if (/^    [a-z][a-z_-]*:\s*/.test(line)) { pathsActive = false; continue; }
    const m = pathsActive && /^      - '([^']+)'\s*$/.exec(line);
    if (m) paths.push(m[1]);
  }
  return paths;
}
function requiredPaths(yaml, event, expected) {
  const actual = eventPaths(yaml, event);
  assert.ok(actual.length >= expected.length, event + ' dependency paths missing');
  for (const name of expected) assert.ok(actual.includes(name), event + ' must watch ' + name);
  assert.equal(actual.some((p) => p.startsWith('!')), false, 'no exclusion may cancel a critical dependency');
  assert.equal(new Set(actual).size, actual.length, 'duplicate trigger paths create review noise');
}

test('P24 source scaling review watches actual P19 measurement, owner ledger and production topology changes', () => {
  const yaml = workflow('v5-p24-scale-readiness.yml');
  const required = [
    '.github/workflows/v5-p24-scale-readiness.yml',
    '.github/workflows/v5-p19-load-chaos.yml',
    '.github/workflows/v5-p23-retirement-foundations.yml',
    'scripts/v5/p24/**','scripts/v5/p19/**','scripts/v5/p23/**',
    'tests/v5-p24-*.test.js','docs/v5/progress.json',
    'docs/v5/evidence/**','packages/db/**','packages/services/**',
    'packages/migrations/**','apps/**','deploy/**','server/**','infra/**','native/**',
  ];
  requiredPaths(yaml,'pull_request',required);
  requiredPaths(yaml,'push',required);
  assert.deepEqual(eventPaths(yaml,'push'),eventPaths(yaml,'pull_request'));
  assert.match(yaml,/^permissions:\n  contents: read$/m);
  assert.ok(yaml.includes('result.productionMutationAuthorized!==false'));
  assert.ok(yaml.includes('result.g24Accepted!==false'));
  assert.doesNotMatch(yaml,/^  (?:pull_request_target|workflow_run|workflow_dispatch):/m);
});

test('P09 post-gate fencing and settlement remain real PG zero-skip acceptance coverage', () => {
  const yaml = workflow('v5-postgresql.yml');
  assert.match(yaml, /^  push:\n    branches: \[V5-platform\]/m);
  assert.match(yaml, /^  pull_request:\n    branches: \[V5-platform\]/m);
  const suites = [
    'tests/v5-p09-persistence.test.js',
    'tests/v5-p09-lifecycle.test.js',
    'tests/v5-p09-fencing.test.js',
    'tests/v5-p09-settlement.test.js',
    'tests/v5-p09-recovery.test.js',
  ];
  for (const suite of suites) {
    assert.ok(yaml.includes('node --test') && yaml.includes(suite),
      suite + ' requires the owned PostgreSQL suite');
    assert.ok(yaml.includes("{ file: '" + suite + "', log: '.evidence-logs/v5-p09-tournaments.tap' }"),
      suite + ' must be registered in the zero-skip, nonzero-pass coverage audit');
  }
  for (const suite of ['v5-p08-http-auth.test.js', 'v5-p08-ingress-bounds.test.js'])
    assert.ok(yaml.includes(suite), suite + ' must not disappear when G09 is merged');
  assert.match(yaml,/if \(pass === null \|\| pass === 0 \|\| fail === null \|\| fail !== 0 \|\| skipped === null \|\| skipped !== 0\)/);
  assert.doesNotMatch(yaml, /--test-skip-pattern/);
});

test('P08 HTTP identity and socket queue safeguards stay in zero-skip PG integration checks', () => {
  const yaml = workflow('v5-postgresql.yml');
  assert.match(yaml, /^  push:\n    branches: \[V5-platform\]/m);
  assert.match(yaml, /^  pull_request:\n    branches: \[V5-platform\]/m);
  for (const suite of [
    'tests/v5-p08-http-auth.test.js',
    'tests/v5-p08-ingress-bounds.test.js',
    'tests/v5-p08-snapshot-recovery.test.js',
    'tests/v5-p08-timers.test.js',
  ]) {
    assert.ok(yaml.includes('node --test') && yaml.includes(suite),
      suite + ' must execute on disposable PG/Redis CI');
    assert.ok(yaml.includes("{ file: '" + suite + "', log: '.evidence-logs/"),
      suite + ' must be present in zero-skip coverage register');
  }
  assert.match(yaml, /if \(pass === null \|\| pass === 0 \|\| fail === null \|\| fail !== 0 \|\| skipped === null \|\| skipped !== 0\)/);
  assert.doesNotMatch(yaml, /--test-skip-pattern/);
});

test('P16 Core recovery runs when P08/P06 runtime, shared protocol, schema or fixture changes', () => {
  const yaml = workflow('v5-p16-core-failover.yml');
  const required = [
    'packages/services/**','packages/contracts/**','packages/db/**',
    'packages/migrations/**','apps/game-core/**','apps/worker/**','deploy/**',
    'src/domain.js','scripts/v5/p16/**',
    'tests/v5-p16-*.test.js','tests/v5-pg-lab.js',
    'tests/helpers/v5-presence-service-process.js',
  ];
  requiredPaths(yaml, 'pull_request', required);
  requiredPaths(yaml, 'push', required);
  assert.deepEqual(eventPaths(yaml,'push'), eventPaths(yaml,'pull_request'));
  assert.match(yaml, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(yaml, /^  (?:pull_request_target|workflow_run|workflow_dispatch):/m);
});

test('P22 go/no-go is re-evaluated when owner gate evidence, economy, migrations and clients change', () => {
  const yaml = workflow('v5-p22-cutover-readiness.yml');
  const required = [
    'docs/v5/progress.json','docs/v5/evidence/**','packages/**',
    'tools/v5-migration/**','apps/**','server/**','deploy/**',
    'src/**','native/**',
    'scripts/v5/release-*','scripts/v5/build-client.js',
    'scripts/v5/p22/**','scripts/v5/p18/**','tests/v5-p22-*.test.js',
  ];
  requiredPaths(yaml, 'pull_request', required);
  requiredPaths(yaml, 'push', required);
  assert.deepEqual(eventPaths(yaml,'push'), eventPaths(yaml,'pull_request'));
  assert.match(yaml, /^permissions:\n  contents: read$/m);
  assert.match(yaml, /group: v5-p22-\$\{\{/);
  assert.doesNotMatch(yaml, /group: v5-p22-\\\$\{\{/);
});

test('P23 retention and V4 retirement guards rerun on cutover, owner ledger and legacy server changes', () => {
  const yaml = workflow('v5-p23-retirement-foundations.yml');
  const required = [
    'scripts/v5/p23/**','scripts/v5/p22/**','docs/v5/progress.json',
    'docs/v5/evidence/**','packages/**','server/**','apps/**','deploy/**',
    'native/**','tools/v5-migration/**','tests/v5-p23-*.test.js',
    'tests/v5-ci-runner-diagnostic.test.js',
  ];
  requiredPaths(yaml, 'pull_request', required);
  requiredPaths(yaml, 'push', required);
  assert.deepEqual(eventPaths(yaml,'push'), eventPaths(yaml,'pull_request'));
  assert.match(yaml, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(yaml, /^  (?:pull_request_target|workflow_run|workflow_dispatch):/m);
});

test('Android/iOS compile checks watch the same P05 contracts and bundle inputs on PR and push', () => {
  const yaml = workflow('v5-native.yml');
  const expected = [
    'native/**','packages/contracts/**','packages/domain/**','src/**','public/**',
    'assets/vendor/**','index.html','scripts/v5/build-client.js',
    'scripts/v5/native-*','scripts/v5/verify-native-bundle-parity.js',
    'tests/v5-client-bundle.test.js','package.json','package-lock.json',
  ];
  requiredPaths(yaml, 'push', expected);
  requiredPaths(yaml, 'pull_request', expected);
  assert.deepEqual(eventPaths(yaml,'push'), eventPaths(yaml,'pull_request'),
    'native app checks must not silently differ on review vs integration');
});

test('conservative change-impact planner never suppresses the independent full regressions', () => {
  const { analyze, COMPONENTS } = require('../scripts/v5/ci-impact.js');
  for (const changed of [
    ['packages/services/queue.js'],
    ['packages/contracts/native-bridge.js'],
    ['packages/migrations/migrations/999_future.sql'],
    ['docs/v5/progress.json'],
    ['scripts/v5/p22/readiness.js'],
  ]) {
    const plan = analyze(changed);
    for (const required of ['Mega XO validation','V5 PostgreSQL integration','V5 release engineering']) {
      assert.ok(plan.requiredWorkflows.includes(required), 'source change cannot bypass ' + required);
    }
    if (changed[0].startsWith('packages/contracts/')) assert.deepEqual(plan.affected, COMPONENTS);
  }
});
