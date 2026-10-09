'use strict';

/*
 * P22-05/06 rollback classification. No execution, connection, DNS switch,
 * writer activation or false confidence based solely on a missing event row.
 * UNKNOWN is a distinct high-risk first-write state: if first write cannot
 * be proven ABSENT, NEVER direct a rollback to stale V4 SQLite.
 */
const crypto = require('node:crypto');
const { observe } = require('../p18/cutover-state-model');
const { WRITERS } = require('./writer-fence');
const PREWRITE = new Set(['PREPARED','DRAINING','FROZEN','IMPORTED_AND_VERIFIED','ARMED']);
const PG_STATES = new Set(['V5_AUTHORITY','ACCEPTED','RECOVERING_WITH_POSTGRES']);
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const EVIDENCE = /^artifact:\/\/v5\/p22\/[a-z0-9._/-]{8,120}$/;
function refuse(x) { throw Error('P22_ROLLBACK_REFUSED:' + x); }
function exact(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o) ||
      Object.keys(o).sort().join('|') !== [...keys].sort().join('|')) refuse('FIELDS');
}
function classify(record, expectedSha) {
  exact(record,['format','sourceSha','stage','applicationWriteState',
    'v4SourceSnapshotSha256','v4LatestSnapshotSha256','v4FencingEvidenceRef',
    'allV5WritePathsProvenDisabled','pgCompatibleReleaseVerified']);
  if (!SHA.test(expectedSha) || record.sourceSha !== expectedSha ||
      record.format !== 'mega-v5-p22-recovery-evaluation/v1' ||
      ![...PREWRITE, ...PG_STATES].includes(record.stage) ||
      !['NONE_INDEPENDENTLY_PROVEN','OBSERVED','UNKNOWN'].includes(record.applicationWriteState) ||
      !HASH.test(record.v4SourceSnapshotSha256) ||
      !HASH.test(record.v4LatestSnapshotSha256) ||
      (record.v4FencingEvidenceRef !== null &&
        (typeof record.v4FencingEvidenceRef !== 'string' ||
         !EVIDENCE.test(record.v4FencingEvidenceRef))) ||
      typeof record.allV5WritePathsProvenDisabled !== 'boolean' ||
      typeof record.pgCompatibleReleaseVerified !== 'boolean') refuse('INVALID_SCOPE');
  const observed = record.applicationWriteState === 'OBSERVED';
  const missing = record.applicationWriteState === 'UNKNOWN';
  const afterTransfer = PG_STATES.has(record.stage);
  const maybeV4 = !observed && !missing && !afterTransfer &&
    record.allV5WritePathsProvenDisabled === true &&
    record.v4SourceSnapshotSha256 === record.v4LatestSnapshotSha256 &&
    record.v4FencingEvidenceRef !== null;

  let recovery;
  if (maybeV4) recovery = 'V4_SOLE_WRITER_RECOVERY_CANDIDATE_OPERATOR_REVIEW';
  else if (missing || (afterTransfer && !observed)) {
    // Once PostgreSQL transfer is attempted, absence/unknown first-write evidence
    // can NEVER be interpreted as proof of safety to restore SQLite.
    recovery = afterTransfer ? 'QUARANTINE_AND_RECONCILE_POSTGRES' : 'QUARANTINE_UNPROVEN_FIRST_WRITE';
  } else if (observed) recovery = record.pgCompatibleReleaseVerified
    ? 'POSTGRES_COMPATIBLE_RELEASE_OR_FORWARD_FIX'
    : 'QUARANTINE_AND_RECONCILE_POSTGRES';
  else recovery = 'QUARANTINE_UNPROVEN_FIRST_WRITE';
  return Object.freeze({
    format:'mega-v5-p22-recovery-classification/v1',
    sourceSha:expectedSha,
    firstWriteEvidenceClass:record.applicationWriteState,
    applicationWriteIncludes:WRITERS,
    treatment:recovery,
    mayAutomaticallyRestartV4:false,
    mayAutomaticallyEnableV5:false,
    requireIndependentSourceAndWriteObservation:true,
    acknowledgedProviderEventsMustRemainDurable:true,
    authorizesRecovery:false,
    g22Accepted:false,
  });
}
function reviewSyntheticRehearsal(trace, sourceSha, recoveryInput) {
  const state = observe(trace, sourceSha); // reuse P18's authoritative pure transition spec
  const policy = classify(recoveryInput, sourceSha);
  if (trace.scenario === 'abort-before-first-application-write') {
    if (recoveryInput.applicationWriteState !== 'NONE_INDEPENDENTLY_PROVEN' ||
        recoveryInput.stage !== 'ARMED' ||
        policy.treatment !== 'V4_SOLE_WRITER_RECOVERY_CANDIDATE_OPERATOR_REVIEW') {
      refuse('PREWRITE_REHEARSAL_POLICY_MISMATCH');
    }
  } else {
    if (recoveryInput.stage !== 'RECOVERING_WITH_POSTGRES' ||
        recoveryInput.applicationWriteState !== 'OBSERVED' ||
        policy.treatment === 'V4_SOLE_WRITER_RECOVERY_CANDIDATE_OPERATOR_REVIEW') {
      refuse('POSTWRITE_REHEARSAL_POLICY_MISMATCH');
    }
  }
  return Object.freeze({
    format:'mega-v5-p22-synthetic-rollback-review/v1',
    sourceSha,
    scenario:trace.scenario,
    modelFingerprint:state.fingerprint,
    recoveryClass:policy.treatment,
    evidenceFingerprint:crypto.createHash('sha256').update(JSON.stringify(recoveryInput)).digest('hex'),
    actualDrillExecuted:false,
    recoveryAuthorized:false,
    g22Accepted:false,
  });
}
module.exports={PREWRITE,PG_STATES,classify,reviewSyntheticRehearsal};
