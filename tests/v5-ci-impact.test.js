'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, COMPONENTS, ALWAYS_REQUIRED, readStdin0, run } = require('../scripts/v5/ci-impact.js');

test('common shared contracts trigger all consumers, including native and worker', () => {
  const plan = analyze(['packages/contracts/realtime.js', 'packages/domain/commands.js']);
  assert.deepEqual(plan.affected, COMPONENTS);
  assert.equal(plan.fullFanout, true);
  assert.deepEqual(plan.requiredWorkflows, ALWAYS_REQUIRED);
});

test('durable schema and repository edits reach DB, API, Core and worker gates', () => {
  const plan = analyze(['packages/migrations/migrations/0038_next.sql', 'packages/db/pg/repositories.js']);
  for (const role of ['api','core','database','release','security','worker']) assert.ok(plan.affected.includes(role));
  assert.equal(plan.fullFanout, false);
  assert.deepEqual(plan.requiredWorkflows, ALWAYS_REQUIRED);
});

test('approved browser client changes always include the native host build', () => {
  for (const file of ['src/app.js','src/authority.js','src/styles.css','index.html','public/privacy.html','assets/vendor/a.js']) {
    const plan = analyze([file]);
    assert.ok(plan.affected.includes('native'), file);
    assert.ok(plan.affected.includes('browser'), file);
  }
});

test('release pipeline or unknown paths fail open, never bypass global gates', () => {
  for (const files of [[], ['.github/workflows/v5-postgresql.yml'], ['scripts/new-mystery.sh'], ['tests/new-thing.test.js']]) {
    const plan = analyze(files);
    assert.equal(plan.fullFanout, true);
    assert.deepEqual(plan.affected, COMPONENTS);
    assert.deepEqual(plan.requiredWorkflows, ALWAYS_REQUIRED);
  }
});

test('targeted native and PG changes retain independent global baseline checks', () => {
  const native = analyze(['native/ios/MegaXO/MegaStoreKit.swift']);
  const pg = analyze(['tests/v5-pg-guards.test.js']);
  assert.ok(native.affected.includes('native'));
  assert.ok(pg.affected.includes('database'));
  assert.deepEqual(native.requiredWorkflows, ALWAYS_REQUIRED);
  assert.deepEqual(pg.requiredWorkflows, ALWAYS_REQUIRED);
});

test('git diff --name-only -z parsing handles spaces, dedupes and rejects malformed streams', () => {
  const raw = Buffer.from('native/ios/Mega XO.swift\0packages/contracts/index.js\0native/ios/Mega XO.swift\0');
  const result = run(['--stdin0'],raw);
  assert.equal(result.changedCount, 2);
  assert.deepEqual(result.affected, COMPONENTS);
  assert.deepEqual(readStdin0(Buffer.alloc(0)), []);
  assert.throws(() => readStdin0(Buffer.from('src/app.js')), /NUL_TERMINATED/);
  assert.throws(() => run(['--bad'],raw), /USAGE/);
});

test('hostile or malformed path components fail closed', () => {
  for (const path of ['/tmp/secret','../secret','src/../authority.js','src//app.js',
    'src\\app.js','./native/file','a/\u0000b','']) {
    assert.throws(() => analyze([path]), /INVALID_CHANGED_PATH/, path);
  }
  assert.throws(() => analyze('src/app.js'), /INVALID_CHANGED_FILES/);
});
