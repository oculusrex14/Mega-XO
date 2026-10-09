'use strict';

/*
 * P23-02. Offline proof-contract for archival continuity. This module does
 * NOT access, delete, rotate, decrypt or restore any artifact. Dates/hashes
 * and operator evidence are DECLARATIONS pending independent retrieval tests.
 */
const crypto = require('node:crypto');
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REF = /^artifact:\/\/v5\/p23\/[a-z0-9][a-z0-9._/-]{7,119}$/;
const TYPES = Object.freeze([
  'v4-frozen-sqlite-encrypted',
  'v4-signed-release-or-image',
  'v4-source-history-tag',
  'p03-final-import-and-coverage',
  'p22-transfer-and-first-write',
  'migration-audit-key-custody',
  'v5-postgres-encrypted-backup',
  'retained-browser-and-callback-contract',
]);
const CONFIDENTIAL = new Set([
  'v4-frozen-sqlite-encrypted','migration-audit-key-custody',
  'v5-postgres-encrypted-backup',
]);
const MONITORS = Object.freeze([
  'v4-sqlite-writer-health', 'v4-backup-freshness', 'v4-service-restart',
  'v5-postgres-backup-freshness', 'v5-core-and-api-health',
  'v5-provider-callback-lag', 'v5-recovery-alert-delivery',
]);
function reject(why) { throw Error('P23_RETENTION_REFUSED:' + why); }
function exact(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) reject('FIELDS_' + label);
}
function time(v) {
  if (typeof v !== 'string' || !UTC.test(v) || !Number.isFinite(Date.parse(v)) ||
      new Date(v).toISOString().replace(/\.000Z$/,'Z') !== v.replace(/\.000Z$/,'Z')) reject('UTC_INVALID');
  return Date.parse(v);
}
function evidence(v) {
  return typeof v === 'string' && REF.test(v) && !v.includes('..');
}
function assessRetention(declaration, expectedSha) {
  exact(declaration, [
    'format','sourceSha','observedAtUtc','operatorRetentionDays',
    'approvedPolicyRef','artifacts','monitors',
  ],'DECLARATION');
  if (!SHA.test(expectedSha) || declaration.sourceSha !== expectedSha ||
      declaration.format !== 'mega-v5-p23-archive-manifest/v1' ||
      !Number.isSafeInteger(declaration.operatorRetentionDays) ||
      declaration.operatorRetentionDays < 30 || declaration.operatorRetentionDays > 3650 ||
      !evidence(declaration.approvedPolicyRef)) reject('POLICY_SCOPE');

  const now = time(declaration.observedAtUtc);
  if (!Array.isArray(declaration.artifacts) || declaration.artifacts.length !== TYPES.length) {
    reject('ARTIFACT_COVERAGE_INCOMPLETE');
  }
  const names = new Set(), refs = new Set();
  for (const row of declaration.artifacts) {
    exact(row,[
      'type','sha256','immutableArchiveRef','encryptedAtRest',
      'retrievalObservedAtUtc','retrievalEvidenceRef','retainUntilUtc',
      'accessClass','deletionPermitted',
    ],'ARTIFACT');
    if (!TYPES.includes(row.type) || names.has(row.type) || !HASH.test(row.sha256) ||
        !evidence(row.immutableArchiveRef) || refs.has(row.immutableArchiveRef) ||
        !evidence(row.retrievalEvidenceRef) ||
        !['RESTRICTED_OPERATORS','PRIVATE_AUDIT'].includes(row.accessClass) ||
        row.deletionPermitted !== false ||
        typeof row.encryptedAtRest !== 'boolean' ||
        (CONFIDENTIAL.has(row.type) && (row.encryptedAtRest !== true ||
          row.accessClass !== 'RESTRICTED_OPERATORS'))) reject('ARTIFACT_NOT_SAFELY_RETAINED');
    names.add(row.type);refs.add(row.immutableArchiveRef);
    const tested = time(row.retrievalObservedAtUtc),retained = time(row.retainUntilUtc);
    if (tested > now || now - tested > 30*86400000 ||
        retained < now + declaration.operatorRetentionDays*86400000) {
      reject('STALE_RETRIEVAL_OR_RETENTION');
    }
  }

  if (!Array.isArray(declaration.monitors) || declaration.monitors.length !== MONITORS.length) {
    reject('MONITOR_MAPPING_INCOMPLETE');
  }
  const covered = new Set();
  for (const row of declaration.monitors) {
    exact(row,['signal','decision','observedEvidenceRef'],'MONITOR');
    if (!MONITORS.includes(row.signal) || covered.has(row.signal) ||
        !evidence(row.observedEvidenceRef)) reject('UNKNOWN_MONITOR');
    covered.add(row.signal);
    if (row.decision !== (row.signal.startsWith('v4-')
      ? 'DISABLE_OLD_ALERT_WITH_ARCHIVED_AUDIT'
      : 'RETAIN_OR_REPOINT_TO_POSTGRES_AUTHORITY')) reject('WRONG_AUTHORITY_ALERT');
  }

  const fingerprint=crypto.createHash('sha256').update(
    JSON.stringify(TYPES.map(name => {
      const item=declaration.artifacts.find(x=>x.type===name);
      return [item.type,item.sha256,item.immutableArchiveRef,item.retainUntilUtc];
    }))
  ).digest('hex');
  return Object.freeze({
    format:'mega-v5-p23-archive-audit/v1', sourceSha:expectedSha,
    policyClaimsPresent:true, artifactsDeclared:names.size, monitorsMapped:covered.size,
    manifestFingerprintSha256:fingerprint,
    retrievalAndRestoreIndependentlyVerified:false,
    secretsOrArchiveContentsInspected:false,
    deletionAuthorized:false, policyApplied:false, g23Accepted:false,
    status:'REVIEW_ONLY_RETRIEVAL_AND_ALERT_DELIVERY_REQUIRED',
  });
}
module.exports={TYPES,MONITORS,assessRetention};
