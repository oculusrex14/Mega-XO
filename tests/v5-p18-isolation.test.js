'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load, inspect } = require('../scripts/v5/p18/staging-isolation.js');
const root = path.resolve(__dirname, '..');
const originals = load(root);
function copy() { return JSON.parse(JSON.stringify(originals)); }
function refuses(modify) {
  const records = copy();
  modify(records);
  assert.throws(() => inspect(records), /P18_ISOLATION_REFUSED/);
}

test('actual committed inventories declare distinct Neon resources but no live proof', () => {
  const result = inspect(copy());
  assert.equal(result.result, 'DECLARED_ISOLATION_ONLY');
  assert.equal(result.observedExternalProviders, false);
  assert.equal(result.stageExecutionAuthorized, false);
  assert.equal(result.g18Accepted, false);
  assert.deepEqual(result.environmentNames, ['dev', 'staging', 'production']);
  assert.match(result.stagingInventorySha256, /^[a-f0-9]{64}$/);
  assert.ok(result.blockers.length >= 3);
});
test('cross-environment Neons or database targets cannot overlap', () => {
  for (const field of ['projectId', 'branchId', 'endpointId', 'host', 'database']) {
    refuses(records => { records.staging[field] = records.production[field]; });
  }
});
test('outbound production-like provider effects stay disabled', () => {
  for (const key of ['email', 'storeNotifications', 'adRewards']) {
    refuses(records => { records.staging.outbound[key] = 'enabled'; });
    refuses(records => { delete records.staging.outbound[key]; });
  }
});
test('inventory cannot claim serving staging or have an unknown database major', () => {
  refuses(records => { records.staging.nonserving = false; });
  refuses(records => { records.staging.pgMajor = 17; });
  refuses(records => { records.staging.environment = 'production'; });
  refuses(records => { records.staging.host = 'api.megaxo.online'; });
  refuses(records => { records.staging.roleConnectionLimits.core_runtime = 0; });
});
test('inventory rejects embedded secrets without ever printing them', () => {
  refuses(records => { records.staging.credentials = { providerSecret: 'not-for-git' }; });
  refuses(records => { records.staging.outbound.refreshToken = 'not-for-git'; });
});
