'use strict';

/* Offline unit proof for the LR03 fail-closed deployment guards in
 * scripts/v51/deploy-production.cjs. No network, no host, no docker: only the pure helpers and a
 * source-integrity check that the swap ALWAYS restores host-managed authority files. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const deploy = require('../scripts/v51/deploy-production.cjs');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'v51', 'deploy-production.cjs'), 'utf8');

test('schema: an additive staged tree is accepted, a regression is refused', () => {
  deploy.assertSchemaNotRegressing(55, 55);
  deploy.assertSchemaNotRegressing(56, 55);
  assert.throws(() => deploy.assertSchemaNotRegressing(54, 55), /DEPLOY_REFUSED_SCHEMA_REGRESSION/);
  assert.throws(() => deploy.assertSchemaNotRegressing(NaN, 55), /MIGRATION_COUNT_INVALID/);
});

test('binding: the serve.sh launcher binding is extracted and matched against the host inventory', () => {
  const serveSh = [
    '#!/bin/sh',
    'exec env MEGA_V5_PRODUCTION_SERVER=blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production MEGA_V5_PRODUCTION_SERVE=$EPOCH node scripts/v51/v5-production-server.cjs',
  ].join('\n');
  const binding = deploy.parseServeBinding(serveSh);
  assert.equal(binding, 'blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production');
  assert.equal(deploy.parseServeBinding('no binding here'), null);
  const inventory = { projectId: 'blue-sun-85454968', branchId: 'br-dawn-dawn-b8f9n7zq', database: 'mega_xo_v5_production', nonserving: false };
  assert.equal(deploy.assertTargetsMatch(binding, inventory), binding);
  /* Wrong database / wrong project / wrong branch are each refused before anything is staged. */
  assert.throws(() => deploy.assertTargetsMatch('blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_staging', inventory), /DEPLOY_REFUSED_WRONG_TARGET/);
  assert.throws(() => deploy.assertTargetsMatch('lively-shadow-52629967/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production', inventory), /DEPLOY_REFUSED_WRONG_TARGET/);
  /* A stale nonserving inventory must never arm the authority. */
  assert.throws(() => deploy.assertTargetsMatch(binding, { ...inventory, nonserving: true }), /DEPLOY_REFUSED_NON_SERVING_INVENTORY/);
});

test('readiness: the post-swap gate requires HTTP 200 with ready:true', () => {
  assert.deepEqual(deploy.readinessVerdict('{"status":"ok","live":true,"ready":true}', 200), { ok: true, why: null });
  assert.equal(deploy.readinessVerdict('{"status":"degraded","ready":false}', 200).ok, false);
  assert.equal(deploy.readinessVerdict('{"ready":true}', 502).ok, false);
  assert.equal(deploy.readinessVerdict('gateway timeout', 200).ok, false);
});

test('source integrity: host-managed launchers are ALWAYS restored, never conditionally carried', () => {
  /* The old conditional carry ([ ! -e staged/serve.sh ]) let a stale repo launcher win. */
  assert.match(SOURCE, /const RESTORE = \['docs\/v5\/environments\/production\.json', 'serve\.sh', 'rehearse\.sh'\];/);
  assert.doesNotMatch(SOURCE, /CARRY = \['node_modules', 'serve\.sh'/);
  assert.match(SOURCE, /assertSchemaNotRegressing\(localMigrations/);
  assert.match(SOURCE, /DEPLOY_REFUSED_NO_AUTHORITY_EPOCH/);
  assert.match(SOURCE, /ROLLED_BACK/);
});
