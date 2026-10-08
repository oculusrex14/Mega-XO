#!/usr/bin/env node
'use strict';

// P17 advisory change-impact analysis. Existing full regression and PostgreSQL
// gates are NEVER skipped by this file; unknown inputs conservatively fan out.
// Future component pipelines may use its additive impact map, never as an
// authority to suppress the required release checks.
const fs = require('node:fs');

const COMPONENTS = Object.freeze(['api', 'browser', 'core', 'database', 'native', 'release', 'security', 'worker']);
const ALWAYS_REQUIRED = Object.freeze([
  'Mega XO validation',
  'V5 PostgreSQL integration',
  'V5 release engineering'
]);

function validatePath(file) {
  if (typeof file !== 'string' || file.length < 1 || file.length > 4096 ||
      file.includes('\0') || file.includes('\\') ||
      file.startsWith('/') || file.startsWith('./') ||
      file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_CHANGED_PATH');
  }
  return file;
}

function groupsFor(file) {
  if (file.startsWith('packages/contracts/') || file.startsWith('packages/domain/')) {
    return { groups: COMPONENTS, reason: 'shared-authority-contract', full: true };
  }
  if (file.startsWith('packages/db/') || file.startsWith('packages/migrations/')) {
    return { groups: ['api', 'core', 'database', 'release', 'security', 'worker'], reason: 'durable-schema-or-repository' };
  }
  if (file.startsWith('.github/workflows/') || file === 'package.json' ||
      file === 'package-lock.json' || file.startsWith('scripts/v5/release-') ||
      file.startsWith('scripts/v5/ci-impact')) {
    return { groups: COMPONENTS, reason: 'build-or-release-control', full: true };
  }
  if (file.startsWith('native/')) return { groups: ['native', 'release', 'security'], reason: 'native-host-or-packaging' };
  if (file.startsWith('src/') || file === 'index.html' || file.startsWith('public/') ||
      file.startsWith('assets/')) {
    // src/authority.js is server-only despite its path, and the retained client
    // is compiled into native apps. Shared game changes affect both runtimes.
    return { groups: ['api', 'browser', 'core', 'native', 'release', 'security'], reason: 'approved-client-or-legacy-authority' };
  }
  if (file.startsWith('server/')) return { groups: ['api', 'core', 'database', 'release', 'security', 'worker'], reason: 'server-or-provider' };
  if (file.startsWith('deploy/') || file === 'Dockerfile' || file === '.dockerignore') {
    return { groups: ['api', 'core', 'release', 'security', 'worker'], reason: 'deployment-or-runtime' };
  }
  if (file.startsWith('apps/')) return { groups: COMPONENTS, reason: 'new-service', full: true };
  if (file.startsWith('tests/')) {
    if (/^tests\/v5-(pg|p04|migration|migrations|uow)/.test(file)) {
      return { groups: ['database', 'release'], reason: 'database-acceptance-test' };
    }
    if (/^tests\/v5-(ci-impact|release-)/.test(file)) {
      return { groups: ['release', 'security'], reason: 'release-engineering-test' };
    }
    if (/^tests\/v5-native/.test(file)) {
      return { groups: ['native', 'release'], reason: 'native-acceptance-test' };
    }
    return { groups: COMPONENTS, reason: 'unknown-test-dependency', full: true };
  }
  if (file.startsWith('scripts/') || file.startsWith('docs/v5/') ||
      file.startsWith('Mega-XO-V5-Implementation-Pack/') || file === 'AGENTS.md') {
    return { groups: COMPONENTS, reason: 'unclassified-operational-dependency', full: true };
  }
  return { groups: COMPONENTS, reason: 'unknown-path-fail-open', full: true };
}

function analyze(files) {
  if (!Array.isArray(files)) throw new Error('INVALID_CHANGED_FILES');
  const unique = Array.from(new Set(files.map(validatePath))).sort();
  const active = new Set();
  const reasons = {};
  let fullFanout = unique.length === 0;
  for (const file of unique) {
    const rule = groupsFor(file);
    for (const group of rule.groups) active.add(group);
    reasons[file] = rule.reason;
    fullFanout = fullFanout || Boolean(rule.full);
  }
  if (fullFanout) for (const group of COMPONENTS) active.add(group);
  return {
    schema: 'mega-v5-ci-impact/v1',
    mode: 'advisory-never-skips-required-gates',
    changedCount: unique.length,
    fullFanout,
    affected: Array.from(active).sort(),
    requiredWorkflows: [...ALWAYS_REQUIRED],
    reasons
  };
}

function readStdin0(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('INVALID_INPUT');
  if (buffer.length === 0) return [];
  if (buffer[buffer.length - 1] !== 0) throw new Error('GIT_DIFF_NAMES_NOT_NUL_TERMINATED');
  return buffer.toString('utf8').split('\0').slice(0, -1);
}
function run(argv = process.argv.slice(2), input = fs.readFileSync(0)) {
  if (argv.length !== 1 || argv[0] !== '--stdin0') throw new Error('USAGE: ci-impact.js --stdin0');
  return analyze(readStdin0(input));
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(run(), null, 2) + '\n'); }
  catch (error) {
    process.stderr.write('CI_IMPACT_REJECTED: ' + error.message + '\n');
    process.exitCode = 2;
  }
}
module.exports = { COMPONENTS, ALWAYS_REQUIRED, analyze, groupsFor, readStdin0, validatePath, run };
