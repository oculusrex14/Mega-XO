/* scripts/v5/pg-integrity-check.js - read-only production integrity verifier invariants.
 *
 * The verifier's job is to catch a schema that drifted from the checked-in chain without needing
 * a privileged migration role. These tests pin the pure, offline parts: the checksum rule MUST
 * match the migration runner's rule exactly (otherwise every honest database would be reported
 * corrupt), and the checked-in plan MUST be contiguous from 1.
 */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const crypto = require('node:crypto');

const integrity = require('../scripts/v5/pg-integrity-check.js');
const migrate = require('../scripts/v5/migrate.js');

test('checksum: the verifier reuses the runner checksum rule byte-for-byte', () => {
  const a = Buffer.from('SELECT 1;', 'utf8');
  const b = Buffer.from('SELECT 2;', 'utf8');
  assert.equal(integrity.migrationChecksum('0001_x', a), migrate.migrationChecksum('0001_x', a));
  const want = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('0001_x\n', 'utf8'), a])).digest('hex');
  assert.equal(integrity.migrationChecksum('0001_x', a), want);
  /* A string SQL and its UTF-8 bytes must hash identically: the runtime path passes strings. */
  assert.equal(integrity.migrationChecksum('0001_x', 'SELECT 1;'), want);
  /* A one-byte content change must change the checksum: this is what catches a replay conflict. */
  assert.notEqual(integrity.migrationChecksum('0001_x', a), integrity.migrationChecksum('0001_x', b));
  assert.notEqual(integrity.migrationChecksum('0001_x', a), integrity.migrationChecksum('0002_x', a));
});

test('plan: the checked-in chain is contiguous from 1 and matches its manifest', () => {
  const dir = path.join(__dirname, '..', 'packages', 'migrations');
  const plan = integrity.loadPlan(dir);
  const manifest = require(path.join(dir, 'manifest.json'));
  assert.ok(plan.length > 0);
  assert.equal(plan.length, manifest.migrations.length);
  for (let i = 0; i < plan.length; i += 1) {
    assert.equal(plan[i].id, i + 1, `plan entry ${i} must be numbered ${i + 1}`);
    assert.equal(plan[i].name, manifest.migrations[i].name);
    assert.equal(plan[i].sha256, manifest.migrations[i].sha256);
  }
});

test('required tables and runtime roles: the verifier asserts the exact durable surface', () => {
  for (const table of ['meta.migrations', 'identity.actors', 'economy.wallets', 'ops.outbox', 'audit.operator_audit']) {
    assert.ok(integrity.REQUIRED_TABLES.includes(table), `${table} must be asserted present`);
  }
  assert.deepEqual(integrity.RUNTIME_ROLES, ['api_runtime', 'core_runtime', 'worker_runtime']);
  assert.ok(integrity.V5_SCHEMAS.includes('learning'));
});
