'use strict';

/*
 * P22-04: validate nonsecret receipts from the real P03 importer/reconciler.
 * This does not execute importer, inspect provider state or authorize transfer.
 * A source model from the earlier P03 dry-run is NOT a final frozen snapshot.
 */
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const FAMILIES = Object.freeze([
  'actors','wallets','ledger','matchAndEscrow','tournamentAndEscrow',
  'providerInboxAndReceipts','outboxAndJobs','sessionRevocations',
  'privacyAndTombstones','socialAndSaves','seasonAndRank','purchasesAndRefunds',
]);
function refuse(x) { throw Error('P22_IMPORT_REFUSED:' + x); }
function exact(x, keys, label) {
  if (!x || typeof x !== 'object' || Array.isArray(x) ||
      Object.keys(x).sort().join('|') !== [...keys].sort().join('|')) refuse('FIELDS_' + label);
}
function counters(rows, label) {
  exact(rows, FAMILIES, label);
  for (const kind of FAMILIES) {
    const x=rows[kind];
    exact(x,['rows','canonicalSha256'], label + '_' + kind);
    if (!Number.isSafeInteger(x.rows) || x.rows < 0 || !SHA64.test(x.canonicalSha256)) refuse('INVALID_COUNTER');
  }
}
function evaluate(receipt, expectedSha) {
  exact(receipt,['format','sourceSha','environment','database','frozenSource','target','import','verify'], 'RECEIPT');
  if (!SHA40.test(expectedSha) || receipt.sourceSha !== expectedSha ||
      receipt.format !== 'mega-v5-p22-final-import-reconciliation/v1' ||
      receipt.environment !== 'nonserving-production' ||
      typeof receipt.database !== 'string' ||
      !/^[a-z][a-z0-9_]{3,62}$/.test(receipt.database)) refuse('ENV_OR_SOURCE');
  const { frozenSource, target, import: loaded, verify } = receipt;
  exact(frozenSource,['snapshotSha256','sourceReleaseSha','fingerprint','fenceEvidenceRef','families'], 'FROZEN');
  exact(target,['database','schemaManifestSha256','writersDisabled','providerSideEffectsDisabled'], 'TARGET');
  exact(loaded,['command','ok','runId','database','modelFingerprint','snapshotSha256','schemaManifestSha256',
    'coverageUnclassified','targetFamilies','targetWriterDisabled'], 'LOAD');
  exact(verify,['command','ok','runId','database','modelFingerprint','schemaManifestSha256',
    'unexplainedCount','invariantFailures','unverifiedLocators','targetFamilies'], 'VERIFY');
  if (!SHA64.test(frozenSource.snapshotSha256) || !SHA40.test(frozenSource.sourceReleaseSha) ||
      !SHA64.test(frozenSource.fingerprint) || !SHA64.test(target.schemaManifestSha256) ||
      frozenSource.fenceEvidenceRef === null ||
      typeof frozenSource.fenceEvidenceRef !== 'string' ||
      !/^artifact:\/\/v5\/p22\/freeze\/[a-z0-9._/-]{8,120}$/.test(frozenSource.fenceEvidenceRef) ||
      frozenSource.fenceEvidenceRef.includes('..') ||
      target.database !== receipt.database ||
      target.writersDisabled !== true || target.providerSideEffectsDisabled !== true) {
    refuse('FROZEN_SOURCE_OR_TARGET');
  }
  if (loaded.command !== 'load' || verify.command !== 'verify' ||
      loaded.ok !== true || verify.ok !== true ||
      typeof loaded.runId !== 'string' || !/^[a-z0-9][a-z0-9._-]{7,100}$/.test(loaded.runId) ||
      loaded.runId !== verify.runId || loaded.database !== receipt.database ||
      verify.database !== receipt.database ||
      loaded.modelFingerprint !== frozenSource.fingerprint ||
      verify.modelFingerprint !== frozenSource.fingerprint ||
      loaded.snapshotSha256 !== frozenSource.snapshotSha256 ||
      loaded.schemaManifestSha256 !== target.schemaManifestSha256 ||
      verify.schemaManifestSha256 !== target.schemaManifestSha256 ||
      loaded.targetWriterDisabled !== true ||
      !Number.isSafeInteger(loaded.coverageUnclassified) || loaded.coverageUnclassified !== 0 ||
      !Number.isSafeInteger(verify.unexplainedCount) || verify.unexplainedCount !== 0 ||
      !Number.isSafeInteger(verify.invariantFailures) || verify.invariantFailures !== 0 ||
      !Number.isSafeInteger(verify.unverifiedLocators) || verify.unverifiedLocators !== 0) {
    refuse('LOAD_VERIFY_MISMATCH_OR_UNEXPLAINED');
  }
  counters(frozenSource.families,'SOURCE');
  counters(loaded.targetFamilies,'IMPORTED');
  counters(verify.targetFamilies,'RECONCILED');
  for (const family of FAMILIES) {
    const source=JSON.stringify(frozenSource.families[family]);
    if (source !== JSON.stringify(loaded.targetFamilies[family]) ||
        source !== JSON.stringify(verify.targetFamilies[family])) {
      refuse('PER_FAMILY_DIVERGENCE:' + family);
    }
  }
  return Object.freeze({
    format:'mega-v5-p22-final-import-review/v1',
    sourceSha:expectedSha,
    database:receipt.database,
    frozenSourceHash:receipt.frozenSource.snapshotSha256,
    familiesCompared:FAMILIES.length,
    sourceAndTargetDigestClaimsConsistent:true,
    zeroDifferenceClaimPresent:true,
    actualP03CLIAndFrozenSourceReverified:false,
    providerCallbackLedgerReverified:false,
    authorizesApplicationWrites:false,
    g22Accepted:false,
    status:'STRUCTURAL_EVIDENCE_ONLY_REQUIRES_INDEPENDENT_RECONCILIATION',
  });
}
module.exports={FAMILIES,evaluate};
