'use strict';
// P0 evidence-integrity tests: a CI run is not a provider, physical-device or
// live-cutover approval. These tests verify that the audit stays complete,
// attributable to source, and honest as the owner's ledger changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const audit = JSON.parse(fs.readFileSync(path.join(ROOT,
  'docs/co-dev/P0-ACCEPTANCE-TRIAGE.json'), 'utf8'));
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT,
  'docs/v5/progress.json'), 'utf8'));
const SHA = /^[a-f0-9]{40}$/;
const LEVELS = new Set([
  'MIXED_EXTERNAL','CI_PROVEN_SCOPE','REPORTED_OWNER_PROOF',
  'LEDGER_PASS','PROVIDER_DEVICE_PENDING','PROVIDER_ENV_PENDING',
  'PRODUCTION_CUTOVER_PENDING',
]);
const LIVE_PENDING = new Set(['A38','A39','A40']);

test('P0 acceptance audit covers exactly the immutable A01-A40 contracts', () => {
  assert.equal(audit.schema_version, 1);
  assert.equal(audit.format, 'mega-xo-v5-acceptance-triage/v1');
  assert.match(audit.reviewed_source_sha, SHA);
  assert.match(audit.owner_audit_sha, SHA);
  assert.equal(audit.cases.length, 40);
  assert.equal(ledger.acceptance_cases.length, 40);
  assert.deepEqual(audit.cases.map(c => c.id),
    Array.from({ length: 40 }, (_, i) => 'A' + String(i + 1).padStart(2, '0')));
  for (const [i, entry] of audit.cases.entries()) {
    const source = ledger.acceptance_cases[i];
    assert.equal(entry.title, source.title, entry.id);
    assert.equal(entry.ledger_status, source.status,
      entry.id + ' needs explicit audit review when ledger acceptance changes');
    assert.ok(LEVELS.has(entry.proof_scope), entry.id + ' unknown proof level');
    assert.ok(['co-dev','main-agent','joint'].includes(entry.lead));
    assert.ok(typeof entry.remaining_proof === 'string' && entry.remaining_proof.length >= 30,
      entry.id + ' must have an actionable closure gap');
    assert.ok(Array.isArray(entry.evidence_refs) && entry.evidence_refs.length > 0);
    for (const name of entry.evidence_refs) {
      assert.match(name, /^docs\/v5\/evidence\/[a-z0-9.-]+\.json$/);
      assert.ok(fs.statSync(path.join(ROOT, name)).isFile(),
        entry.id + ' evidence reference missing: ' + name);
    }
  }
});

test('P0 never promotes CI coverage to acceptance or external proof', () => {
  assert.equal(audit.evidence_baseline.head_sha, audit.reviewed_source_sha);
  assert.equal(audit.evidence_baseline.required_workflows, 12);
  assert.equal(audit.evidence_baseline.passed_workflows, 12);
  assert.equal(audit.evidence_baseline.failed_workflows, 0);
  assert.deepEqual(audit.cases.filter(c => c.ledger_status === 'PASS').map(c => c.id),
    ['A04', 'A05']);
  assert.equal(audit.cases.filter(c => c.ledger_status === 'NOT_RUN').length, 38);
  for (const entry of audit.cases) {
    if (entry.proof_scope === 'LEDGER_PASS') assert.equal(entry.ledger_status, 'PASS');
    else assert.equal(entry.ledger_status, 'NOT_RUN',
      entry.id + ' remains unaccepted regardless of source/CI evidence');
  }
});

test('P0 V4 production reality cannot be overwritten by simulated cutover results', () => {
  const auditFacts = JSON.parse(fs.readFileSync(path.join(ROOT,
    'docs/v5/evidence/live-production-authority-audit.json'), 'utf8'));
  assert.equal(audit.production_authority, 'V4_SQLITE');
  assert.equal(audit.v5_live_cutover_executed, false);
  assert.equal(audit.cutover_authorized, false);
  assert.equal(auditFacts.verdict.active_production_authority, 'V4_SQLITE');
  assert.equal(auditFacts.verdict.conflicting_writers, false);
  assert.equal(auditFacts.neon_production_database.written_data_bytes, 0);
  assert.equal(ledger.production_safety.postgres_import_performed, false);
  assert.equal(ledger.production_safety.cutover_epoch, null);
  assert.equal(ledger.production_safety.first_post_import_application_write, null);
  assert.deepEqual(ledger.current.passed_phase_gates.slice(-1).map(e => e.gate), ['G20']);
  for (const gate of ['G22','G23','G24']) {
    assert.equal(ledger.current.passed_phase_gates.some(e => e.gate === gate),
      false, 'live gate must stay open: ' + gate);
  }
  for (const entry of audit.cases.filter(c => LIVE_PENDING.has(c.id))) {
    assert.equal(entry.proof_scope, 'PRODUCTION_CUTOVER_PENDING');
    assert.equal(entry.ledger_status, 'NOT_RUN');
    assert.equal(entry.lead, 'main-agent');
  }
});

test('P0 source-check pass cannot silently close device/store or staging acceptance', () => {
  for (const id of ['A12','A19','A24','A32','A34','A35','A36','A37']) {
    const entry = audit.cases.find(c => c.id === id);
    assert.equal(entry.proof_scope, 'PROVIDER_DEVICE_PENDING');
    assert.equal(entry.ledger_status, 'NOT_RUN');
  }
  for (const id of ['A26','A27','A28','A29','A30','A31']) {
    const entry = audit.cases.find(c => c.id === id);
    assert.equal(entry.proof_scope, 'PROVIDER_ENV_PENDING');
    assert.equal(entry.ledger_status, 'NOT_RUN');
  }
});
