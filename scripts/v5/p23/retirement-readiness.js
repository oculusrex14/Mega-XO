'use strict';

/*
 * P23-01. OFFLINE retirement readiness, not a write-fence installer.
 * A post-P22 V4 retirement must never revive SQLite authority. Claimed
 * operator evidence is untrusted until independently observed on the host.
 */
const { WRITERS, verifyFence } = require('../p22/writer-fence');

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const REF = /^artifact:\/\/v5\/p23\/[a-z0-9][a-z0-9._/-]{7,119}$/;
const RESTART_CASES = Object.freeze([
  'process-restart', 'container-restart', 'host-reboot',
  'service-autorestart', 'scheduler-resume', 'old-image-rollback',
]);
const CALLBACK_CLASSES = new Set([
  'email-and-ad-rewards', 'store-purchase-and-refund', 'provider-callback-and-inbox',
]);

function fail(why) { throw new Error('P23_RETIREMENT_REFUSED:' + why); }
function exact(value, fields, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) fail('FIELDS_' + label);
}
function evidence(value) {
  return typeof value === 'string' && REF.test(value) && !value.includes('..');
}
function hasAcceptedGate(ledger, gate) {
  if (!ledger || ledger.schema_version !== 1 || !ledger.current ||
      ledger.current.integration_branch !== 'V5-platform' ||
      !Array.isArray(ledger.current.passed_phase_gates)) fail('OWNER_LEDGER_REQUIRED');
  const seen = new Set();
  for (const e of ledger.current.passed_phase_gates) {
    if (!e || !/^G(?:0[0-9]|1[0-9]|2[0-4])$/.test(e.gate || '') ||
        e.phase !== 'P' + e.gate.slice(1) || seen.has(e.gate) ||
        !Array.isArray(e.evidence_refs) || e.evidence_refs.length === 0) fail('INVALID_GATE_LEDGER');
    seen.add(e.gate);
  }
  // P21 is owner-DEFERRED, not a prerequisite. G22 nevertheless requires
  // the full accepted G00-G20 lineage; a lone forged G22 cannot enable review.
  if (gate === 'G22' || gate === 'G23') {
    for (let i=0; i<=20; i++) {
      if (!seen.has('G'+String(i).padStart(2,'0'))) return false;
    }
  }
  if (gate === 'G23' && !seen.has('G22')) return false;
  return seen.has(gate);
}

function assessRetirement(ledger, expectedSha, declaration = null) {
  if (!SHA.test(expectedSha)) fail('EXACT_SOURCE_SHA');
  if (!hasAcceptedGate(ledger, 'G22')) {
    return Object.freeze({
      format:'mega-v5-p23-retirement-review/v1', sourceSha:expectedSha,
      status:'BLOCKED_G22_NOT_ACCEPTED', acceptedG22:false,
      blockers:['G22_NOT_ACCEPTED', 'V4_SQLITE_MUST_REMAIN_AUTHORITATIVE_UNTIL_GATED_P22'],
      v4WritersActuallyFenced:false, ownerEvidenceIndependentlyVerified:false,
      productionMutationAllowed:false, v4RetirementAuthorized:false, g23Accepted:false,
    });
  }
  if (declaration === null) {
    return Object.freeze({
      format:'mega-v5-p23-retirement-review/v1', sourceSha:expectedSha,
      status:'BLOCKED_NO_RETIREMENT_EVIDENCE', acceptedG22:true,
      blockers:['RESTART_FENCE_INVENTORY_AND_PROVIDER_EVIDENCE_REQUIRED'],
      v4WritersActuallyFenced:false, ownerEvidenceIndependentlyVerified:false,
      productionMutationAllowed:false, v4RetirementAuthorized:false, g23Accepted:false,
    });
  }

  exact(declaration, [
    'format','sourceSha','authorityEpoch','firstV5ApplicationWriteRef',
    'v4ReleaseSha','sqliteFinalSnapshotSha256','sqliteArchiveReadOnly',
    'v5OnlyPostgresWriter','v4LegacyRole','writerFence','writers','restartChecks',
  ], 'DECLARATION');
  if (declaration.format !== 'mega-v5-p23-retirement-declaration/v1' ||
      declaration.sourceSha !== expectedSha || !SHA.test(declaration.v4ReleaseSha) ||
      !HASH.test(declaration.sqliteFinalSnapshotSha256) ||
      !/^v5:[0-9]{13}:[0-9a-f]{16,64}$/.test(declaration.authorityEpoch || '') ||
      typeof declaration.firstV5ApplicationWriteRef !== 'string' ||
      !/^artifact:\/\/v5\/p22\/first-write\/[a-z0-9][a-z0-9._/-]{7,119}$/.test(declaration.firstV5ApplicationWriteRef) ||
      declaration.firstV5ApplicationWriteRef.includes('..') ||
      declaration.sqliteArchiveReadOnly !== true ||
      declaration.v5OnlyPostgresWriter !== true ||
      !['STATIC_ONLY','FACADE_TO_V5_ONLY','OFFLINE_ARCHIVE_ONLY'].includes(declaration.v4LegacyRole)) {
    fail('AUTHORITY_EPOCH_OR_ARCHIVE');
  }
  const fence = verifyFence(declaration.writerFence, expectedSha);
  if (fence.phase !== 'V5_EXCLUSIVE' ||
      declaration.writerFence.v4ReleaseSha !== declaration.v4ReleaseSha ||
      declaration.writerFence.v4FrozenSnapshotSha256 !== declaration.sqliteFinalSnapshotSha256 ||
      declaration.writerFence.firstV5ApplicationWriteRef !== declaration.firstV5ApplicationWriteRef) {
    fail('P22_POSTWRITE_FENCE_REQUIRED');
  }

  if (!Array.isArray(declaration.writers) || declaration.writers.length !== WRITERS.length) {
    fail('COMPLETE_WRITER_CATALOGUE');
  }
  const seen = new Set();
  for (const row of declaration.writers) {
    exact(row, [
      'class','v4MutatingRoutes','v4ActiveSchedulerJobs','restartStillFenced',
      'compatibilityRoute','durableAuthority','evidenceRef',
    ], 'WRITER');
    if (!WRITERS.includes(row.class) || seen.has(row.class)) fail('WRITER_DUPLICATE_OR_UNKNOWN');
    seen.add(row.class);
    if (row.v4MutatingRoutes !== 0 || row.v4ActiveSchedulerJobs !== 0 ||
        row.restartStillFenced !== true || row.durableAuthority !== 'SINGLE_V5_POSTGRES' ||
        !evidence(row.evidenceRef) ||
        row.compatibilityRoute !== (CALLBACK_CLASSES.has(row.class)
          ? 'FORWARD_TO_V5_DURABLE_INBOX' : 'DISABLED_OR_FORWARD_TO_V5')) {
      fail('V4_WRITER_OR_CALLBACK_STILL_ACTIVE');
    }
  }

  if (!Array.isArray(declaration.restartChecks) ||
      declaration.restartChecks.length !== RESTART_CASES.length) fail('RESTART_MATRIX_INCOMPLETE');
  const checked = new Set();
  for (const row of declaration.restartChecks) {
    exact(row, ['scenario','outcome','evidenceRef'], 'RESTART');
    if (!RESTART_CASES.includes(row.scenario) || checked.has(row.scenario) ||
        row.outcome !== 'PASS_CLAIMED' || !evidence(row.evidenceRef)) fail('RESTART_PROOF_NOT_COMPLETE');
    checked.add(row.scenario);
  }
  return Object.freeze({
    format:'mega-v5-p23-retirement-review/v1', sourceSha:expectedSha,
    status:'DECLARATIONS_COMPLETE_INDEPENDENT_EXECUTION_REQUIRED', acceptedG22:true,
    coveredWriterClasses:seen.size, coveredRestartScenarios:checked.size,
    blockers:['ACTUAL_RUNTIME_RESTART_AND_ARCHIVE_PROOF_NOT_INDEPENDENTLY_VERIFIED'],
    v4WritersActuallyFenced:false, ownerEvidenceIndependentlyVerified:false,
    productionMutationAllowed:false, v4RetirementAuthorized:false, g23Accepted:false,
  });
}
module.exports = { RESTART_CASES, assessRetirement, hasAcceptedGate };
