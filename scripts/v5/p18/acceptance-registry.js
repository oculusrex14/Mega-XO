#!/usr/bin/env node
'use strict';

/**
 * P18 acceptance inventory. Explicitly binds each P18 task to existing
 * frozen A01-A40 cases; this is a plan, NOT simulated E2E execution.
 * Tests reject orphaned/renumbered cases if the owner changes the source.
 */
const fs = require('node:fs');
const path = require('node:path');

const PHASE = 'P18';
const TASKS = Object.freeze({
  'V5-18-01': Object.freeze({
    label: 'Isolated Vercel/Neon/Redis/Core/worker/callback/secrets',
    cases: Object.freeze(['A04', 'A23', 'A26', 'A27']),
    requiredEvidence: Object.freeze(['provider_inventory', 'negative_access', 'egress_sandbox']),
    level: 'DEPLOYED_STAGING'
  }),
  'V5-18-02': Object.freeze({
    label: 'Account/social/save, privacy and cross-client journey',
    cases: Object.freeze(['A12', 'A13', 'A14', 'A19', 'A24', 'A25']),
    requiredEvidence: Object.freeze(['real_api_trace', 'actor_consistency', 'privacy_assertions']),
    level: 'INTEGRATED_STAGING'
  }),
  'V5-18-03': Object.freeze({
    label: 'Wallet/ranked/casual/direct/tournament/receipt/reconnect paths',
    cases: Object.freeze(['A09', 'A10', 'A11', 'A16', 'A17', 'A18', 'A20', 'A21', 'A22', 'A31', 'A34', 'A35']),
    requiredEvidence: Object.freeze(['ledger_snapshot', 'result_replay', 'real_service_trace']),
    level: 'INTEGRATED_STAGING'
  }),
  'V5-18-04': Object.freeze({
    label: 'Four-theme visual, gameplay and native-host parity',
    cases: Object.freeze(['A01', 'A19', 'A24', 'A32', 'A33', 'A36']),
    requiredEvidence: Object.freeze(['baseline_screenshots', 'candidate_screenshots', 'behavioral_assertions']),
    level: 'DEVICE_AND_BROWSER_STAGING'
  }),
  'V5-18-05': Object.freeze({
    label: 'Freeze/reconcile/abort-before-write and PG-only post-write recovery',
    cases: Object.freeze(['A06', 'A07', 'A08', 'A30', 'A38', 'A39']),
    requiredEvidence: Object.freeze(['isolated_rehearsal', 'single_writer_proof', 'cutover_timeline']),
    level: 'ISOLATED_REHEARSAL'
  })
});
const STATUS = 'NOT_EXECUTED_IN_STAGING';

function reject(reason) { throw new Error('P18_REGISTRY_REFUSED: ' + reason); }
function parseSource(markdown) {
  if (typeof markdown !== 'string' || markdown.length < 200) reject('acceptance source missing');
  const ids = [...markdown.matchAll(/^### (A\d{2}) - ([^\n]+)$/gm)];
  const map = new Map();
  for (const match of ids) {
    if (map.has(match[1])) reject('duplicate source acceptance ID: ' + match[1]);
    map.set(match[1], match[2]);
  }
  if (map.size !== 40) reject('source acceptance count drift: ' + map.size);
  for (let i = 1; i <= 40; i++) {
    if (!map.has('A' + String(i).padStart(2,'0'))) reject('source acceptance IDs not consecutive');
  }
  return map;
}
function validate(markdown) {
  const source = parseSource(markdown);
  const tasks = Object.entries(TASKS);
  if (tasks.length !== 5) reject('P18 tasks changed');
  for (let i = 0; i < tasks.length; i++) {
    const [id, spec] = tasks[i];
    if (id !== 'V5-18-0' + (i + 1)) reject('incorrect P18 task ID');
    if (!Array.isArray(spec.cases) || spec.cases.length < 2) reject('missing cases for ' + id);
    if (new Set(spec.cases).size !== spec.cases.length) reject('duplicate case in ' + id);
    for (const caseId of spec.cases) if (!source.has(caseId)) reject('unknown acceptance case ' + caseId);
    if (!Array.isArray(spec.requiredEvidence) || !spec.requiredEvidence.length ||
        new Set(spec.requiredEvidence).size !== spec.requiredEvidence.length) {
      reject('missing or duplicate evidence dimensions for ' + id);
    }
  }
  return source;
}
function plan(markdown) {
  const source = validate(markdown);
  return {
    format: 'mega-v5-p18-acceptance-plan/v1',
    phase: PHASE,
    executionStatus: STATUS,
    g18Accepted: false,
    totalAcceptanceSourceCases: source.size,
    taskCount: 5,
    tasks: Object.entries(TASKS).map(([id, spec]) => ({
      taskId: id,
      scope: spec.label,
      evidenceLevel: spec.level,
      status: STATUS,
      passedCases: [],
      caseIds: [...spec.cases],
      caseTitles: Object.fromEntries(spec.cases.map(key => [key, source.get(key)])),
      requiredEvidence: [...spec.requiredEvidence]
    })),
    requiredPrecondition: 'P17 accepted and all integrated staging services running in isolated environment',
    excludedScope: 'P21 website (deferred by owner)'
  };
}
function loadSource(root) {
  return fs.readFileSync(path.join(root,'Mega-XO-V5-Implementation-Pack','ACCEPTANCE.md'),'utf8');
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(plan(loadSource(process.cwd())),null,2) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode=2; }
}
module.exports = { TASKS, STATUS, parseSource, validate, plan, loadSource };
