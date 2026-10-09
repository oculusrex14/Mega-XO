#!/usr/bin/env node
'use strict';

/*
 * P22-01 offline pre-cutover evaluation. Reads the program owner's ledger and
 * an optional SANITIZED operator packet; it CANNOT authorize or trigger an
 * environment change. Claimed green evidence is not independently verified.
 * P21 is explicitly owner-deferred, NOT a missing prerequisite.
 */
const fs = require('node:fs');
const path = require('node:path');
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const DIGEST = /^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const REF = /^(?:docs\/v5\/evidence\/[a-z0-9._/-]{4,120}\.json|https:\/\/github\.com\/oculusrex14\/Mega-XO\/actions\/runs\/[0-9]{5,18})$/;
const REQUIRED_GATES = Object.freeze(Array.from({ length: 21 }, (_, i) => 'G' + String(i).padStart(2, '0')));
const CHECKS = Object.freeze([
  'v4ReleaseAndRecovery','currentSourceAndGreenCi','productionTargetIsolation',
  'v5ImmutableBuildAndSchema','legacyBrowserCompatibility','nativeDeviceAcceptance',
  'providerInboxAndCallbacks','realCoreAndWorkerRecovery','independentBackupRestore',
  'fullyReconciledFinalSnapshot','testedV4WriteFence','readOnlyStageAndAlertDelivery',
]);
function refuse(why) { throw Error('P22_READINESS_REFUSED: ' + why); }
function record(v, fields, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).sort().join('|') !== [...fields].sort().join('|')) refuse('FIELDS_' + label);
}
function utc(v) {
  if (typeof v !== 'string' || !UTC.test(v) || !Number.isFinite(Date.parse(v)) ||
      new Date(v).toISOString() !== v.replace(/\.000Z$/, 'Z')) refuse('UTC_REQUIRED');
  return Date.parse(v);
}
function assess(ledger, expectedSha, packet = null, checkedAtUtc = new Date().toISOString()) {
  if (!SHA40.test(expectedSha)) refuse('EXACT_SOURCE_SHA_REQUIRED');
  const checked = utc(checkedAtUtc);
  if (!ledger || ledger.schema_version !== 1 || !ledger.current ||
      ledger.current.integration_branch !== 'V5-platform' ||
      !Array.isArray(ledger.current.passed_phase_gates)) refuse('OWNER_LEDGER_REQUIRED');
  const passed = new Set();
  for (const gate of ledger.current.passed_phase_gates) {
    if (!gate || typeof gate.gate !== 'string' || !REQUIRED_GATES.includes(gate.gate) ||
        gate.phase !== 'P' + gate.gate.slice(1) || passed.has(gate.gate) ||
        !Array.isArray(gate.evidence_refs) || !gate.evidence_refs.length ||
        typeof gate.gate_evidence !== 'string') refuse('OWNER_LEDGER_GATE_INVALID');
    passed.add(gate.gate);
  }
  const missingGates = REQUIRED_GATES.filter(x => !passed.has(x));
  const blockers = missingGates.map(x => 'GATE_NOT_ACCEPTED:' + x);
  const checkedClaims = [];
  let claimsComplete = false;
  if (packet !== null) {
    record(packet, ['format','environment','sourceSha','observedAtUtc','revision','v4SourceSnapshotSha256',
      'targetSchemaSha256','coreImage','workerImage','apiDeploymentId','observations'], 'PACKET');
    if (packet.format !== 'mega-v5-p22-production-readiness-packet/v1' ||
        packet.environment !== 'production' || packet.sourceSha !== expectedSha ||
        typeof packet.revision !== 'string' || !/^[a-zA-Z0-9._-]{8,90}$/.test(packet.revision) ||
        !SHA64.test(packet.v4SourceSnapshotSha256) || !SHA64.test(packet.targetSchemaSha256) ||
        !DIGEST.test(packet.coreImage) || !DIGEST.test(packet.workerImage) ||
        typeof packet.apiDeploymentId !== 'string' ||
        !/^[a-zA-Z0-9_-]{8,100}$/.test(packet.apiDeploymentId)) refuse('PACKET_IDENTITY_OR_DIGEST');
    const observed = utc(packet.observedAtUtc);
    if (observed > checked + 60000 || checked - observed > 24 * 60 * 60 * 1000) {
      refuse('STALE_OR_FUTURE_OBSERVATION');
    }
    if (!Array.isArray(packet.observations) || packet.observations.length !== CHECKS.length) {
      refuse('ALL_CHECKS_REQUIRED');
    }
    const seen = new Set();
    for (const entry of packet.observations) {
      record(entry,['check','outcome','evidenceRef'], 'CHECK');
      if (!CHECKS.includes(entry.check) || seen.has(entry.check)) refuse('UNKNOWN_OR_DUPLICATE_CHECK');
      seen.add(entry.check);
      if (!['PASS_CLAIMED','FAIL','NOT_RUN'].includes(entry.outcome)) refuse('UNKNOWN_OUTCOME');
      if (entry.outcome === 'PASS_CLAIMED' && (!REF.test(entry.evidenceRef) || entry.evidenceRef.includes('..'))) {
        refuse('UNVERIFIABLE_REFERENCE');
      }
      if (entry.outcome !== 'PASS_CLAIMED' && entry.evidenceRef !== null &&
          (!REF.test(entry.evidenceRef) || entry.evidenceRef.includes('..'))) refuse('BAD_REFERENCE');
      if (entry.outcome !== 'PASS_CLAIMED') blockers.push('UNPROVEN:' + entry.check);
      checkedClaims.push({ check: entry.check, outcome: entry.outcome });
    }
    claimsComplete = checkedClaims.every(x => x.outcome === 'PASS_CLAIMED');
  } else {
    blockers.push('OPERATOR_EVIDENCE_PACKET_MISSING');
  }
  if (!claimsComplete && packet !== null) blockers.push('NOT_ALL_PROOFS_CLAIMED');
  const classified = blockers.length ? 'BLOCKED' : 'CLAIMED_COMPLETE_UNVERIFIED';
  return Object.freeze({
    format: 'mega-v5-p22-readiness-assessment/v1',
    sourceSha: expectedSha,
    ownerLedgerPhase: ledger.current.phase,
    requiredGateCount: REQUIRED_GATES.length,
    passedLedgerGates: REQUIRED_GATES.filter(x => passed.has(x)),
    missingGates,
    packetClaimsComplete: claimsComplete,
    status: classified,
    blockers,
    excludedPhase: 'P21_OWNER_DEFERRED',
    liveProviderAndCiVerified: false,
    cutoverAuthorized: false,
    productionWritesPermitted: false,
    g22Accepted: false,
  });
}
function run(args, root = process.cwd()) {
  if (![2,4].includes(args.length) || args[0] !== '--sha' ||
      (args.length === 4 && args[2] !== '--packet')) {
    refuse('USAGE: --sha EXACT_40_CHAR_SHA [--packet .artifacts/p22-readiness.json]');
  }
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'docs/v5/progress.json'), 'utf8'));
  let packet = null;
  if (args.length === 4) {
    if (args[3] !== '.artifacts/p22-readiness.json') refuse('SCOPED_PACKET_PATH_ONLY');
    const p = path.join(root, args[3]);
    const stat = fs.lstatSync(p);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) refuse('PACKET_FILE_REFUSED');
    packet = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return assess(ledger, args[1], packet);
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(run(process.argv.slice(2)), null, 2) + '\n'); }
  catch (err) { process.stderr.write(err.message + '\n'); process.exitCode = 2; }
}
module.exports = { REQUIRED_GATES, CHECKS, assess, run };
