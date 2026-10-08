#!/usr/bin/env node
'use strict';

/**
 * P18-01 static environment-isolation inventory gate.
 *
 * IMPORTANT: Inventory files are declarations, not provider observations.
 * This command performs NO network I/O, touches no live credentials, never
 * declares staging provisioned, and cannot authorize testing real players.
 * Verify provider IAM, egress, routing and runtime target IDs separately.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ENVIRONMENTS = Object.freeze(['dev', 'staging', 'production']);
const IDS = Object.freeze(['projectId', 'branchId', 'endpointId', 'host', 'database']);
const EGRESS = Object.freeze(['email', 'storeNotifications', 'adRewards']);

function refuse(reason) { throw new Error('P18_ISOLATION_REFUSED: ' + reason); }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function noSecretFields(value, depth = 0) {
  if (depth > 12) refuse('unexpectedly nested inventory');
  if (value && typeof value === 'object') {
    for (const [key, field] of Object.entries(value)) {
      if (/(?:password|token|secret|private[_-]?key|authorization|cookie|connection[_-]?string|urlWithCredential)/i.test(key)) {
        refuse('credential-bearing field in inventory');
      }
      noSecretFields(field, depth + 1);
    }
  }
}

function validateInventory(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) refuse('invalid inventory');
  noSecretFields(record);
  if (record.version !== 1 || record.environment !== expected) refuse('incorrect environment inventory');
  if (record.nonserving !== true) refuse('pre-integration environment must remain nonserving');
  if (record.pgMajor !== 16) refuse('unexpected PostgreSQL major version');
  if (!record.outbound || typeof record.outbound !== 'object') refuse('outbound effect inventory missing');
  for (const effect of EGRESS) {
    if (record.outbound[effect] !== 'disabled') {
      refuse('staging and dormant-production outbound provider effects must remain disabled: ' + effect);
    }
  }
  for (const field of IDS) {
    const value = record[field];
    if (typeof value !== 'string' || value.length < 8 || value.length > 180 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/.test(value)) {
      refuse('invalid or missing ' + field + ' for ' + expected);
    }
  }
  if (!/^ep-[a-z0-9-]+\.c-[0-9]+\.us-east-1\.aws\.neon\.tech$/.test(record.host) ||
      !record.host.startsWith(record.endpointId + '.')) {
    refuse('database host does not match declared Neon endpoint');
  }
  if (!record.database.endsWith('_' + expected)) refuse('database name conflicts with expected environment');
  if (!record.roleConnectionLimits || typeof record.roleConnectionLimits !== 'object') {
    refuse('runtime-role limits missing');
  }
  for (const role of ['api_runtime', 'core_runtime', 'worker_runtime', 'backup_reader', 'audit_runtime']) {
    const limit = record.roleConnectionLimits[role];
    if (!Number.isInteger(limit) || limit <= 0 || limit > 64) refuse('unsafe or missing runtime-role limit');
  }
  return record;
}

function inspect(records) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) refuse('inventories object required');
  const parsed = ENVIRONMENTS.map(name => validateInventory(records[name], name));
  for (const field of IDS) {
    const values = parsed.map(row => row[field].toLowerCase());
    if (new Set(values).size !== values.length) refuse(field + ' is shared across environments');
  }
  // Only sanctioned sanitized observations are emitted. Config fingerprints
  // do not prove that an external provider actually honors the declaration.
  const stage = parsed[1];
  return {
    format: 'mega-v5-p18-static-isolation/v1',
    result: 'DECLARED_ISOLATION_ONLY',
    observedExternalProviders: false,
    stageExecutionAuthorized: false,
    g18Accepted: false,
    environmentNames: [...ENVIRONMENTS],
    verifiedStaticChecks: [
      'Neon project/branch/endpoint/host/database identifiers pairwise distinct',
      'owned nonserving inventories declared for dev/staging/production',
      'staging and dormant production outbound provider effects disabled',
      'Neon v16 endpoint linkage and bounded service role connection limits'
    ],
    stagingInventorySha256: sha256(JSON.stringify(stage)),
    blockers: [
      'authoritative Vercel/Core/worker/Redis/provider environment inventory not observed',
      'real staging credentials/permissions and outbound effects not probed',
      'P17 exit gate and integrated P08-P16 services are not accepted'
    ]
  };
}

function load(root) {
  const records = {};
  for (const name of ENVIRONMENTS) {
    const file = path.join(root, 'docs', 'v5', 'environments', name + '.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) refuse('untrusted inventory file');
    records[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return records;
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(inspect(load(process.cwd())), null, 2) + '\n'); }
  catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 2;
  }
}
module.exports = { ENVIRONMENTS, IDS, EGRESS, validateInventory, inspect, load };
