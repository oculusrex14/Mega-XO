'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_GATES, CHECKS, assess } = require('../scripts/v5/p22/readiness');
const SHA = 'a'.repeat(40), HASH = 'b'.repeat(64);
const TIME = '2026-10-09T09:00:00Z';
const OBS = '2026-10-09T08:59:00Z';
const gate = i => ({
  phase: 'P' + String(i).padStart(2, '0'),
  gate: 'G' + String(i).padStart(2, '0'),
  evidence_refs: ['docs/v5/evidence/phase-gate.json'],
  gate_evidence: 'docs/v5/evidence/phase-gate.json',
});
function ledger(n = 7) {
  return { schema_version: 1, current: {
    phase: 'P07', integration_branch: 'V5-platform',
    passed_phase_gates: Array.from({ length: n }, (_, i) => gate(i)),
  }};
}
function packet() {
  return { format: 'mega-v5-p22-production-readiness-packet/v1',
    environment: 'production', sourceSha: SHA, observedAtUtc: OBS,
    revision: 'review-20261009', v4SourceSnapshotSha256: HASH,
    targetSchemaSha256: HASH, coreImage: 'ghcr.io/org/core@sha256:' + HASH,
    workerImage: 'ghcr.io/org/worker@sha256:' + HASH,
    apiDeploymentId: 'deployment_test_001',
    observations: CHECKS.map(check => ({ check, outcome: 'PASS_CLAIMED',
      evidenceRef: 'docs/v5/evidence/operator-review.json' })),
  };
}
const evaluate = (l=ledger(),p=null,now=TIME) => assess(l,SHA,p,now);
const denied = (edit) => {
  const p=packet();
  edit(p);
  assert.throws(() => evaluate(ledger(21),p), /P22_READINESS_REFUSED/);
};

test('actual early program gates remain blocked and P21 is correctly excluded', () => {
  const result = evaluate();
  assert.equal(result.status,'BLOCKED');
  assert.deepEqual(result.passedLedgerGates,REQUIRED_GATES.slice(0,7));
  assert.deepEqual(result.missingGates,REQUIRED_GATES.slice(7));
  assert.equal(result.blockers.includes('OPERATOR_EVIDENCE_PACKET_MISSING'),true);
  assert.equal(result.excludedPhase,'P21_OWNER_DEFERRED');
  assert.equal(result.cutoverAuthorized,false);
});

test('even an all-green operator claim never authorizes or verifies cutover', () => {
  const result = evaluate(ledger(21),packet());
  assert.equal(result.status,'CLAIMED_COMPLETE_UNVERIFIED');
  assert.equal(result.packetClaimsComplete,true);
  assert.deepEqual(result.missingGates,[]);
  assert.equal(result.liveProviderAndCiVerified,false);
  assert.equal(result.productionWritesPermitted,false);
  assert.equal(result.cutoverAuthorized,false);
  assert.equal(result.g22Accepted,false);
});

test('missing gate, failed check or withheld proof always blocks', () => {
  const p=packet();
  p.observations[0]={check:CHECKS[0],outcome:'NOT_RUN',evidenceRef:null};
  let report=evaluate(ledger(20),p);
  assert.equal(report.status,'BLOCKED');
  assert.ok(report.blockers.includes('GATE_NOT_ACCEPTED:G20'));
  assert.ok(report.blockers.includes('UNPROVEN:' + CHECKS[0]));
  assert.ok(report.blockers.includes('NOT_ALL_PROOFS_CLAIMED'));
  p.observations[0].outcome='FAIL';
  assert.equal(evaluate(ledger(21),p).status,'BLOCKED');
});

test('malformed or duplicate owner-ledger gate entries refuse instead of silently passing', () => {
  const l=ledger(21);
  l.current.passed_phase_gates.push(gate(0));
  assert.throws(() => evaluate(l), /P22_READINESS_REFUSED: OWNER_LEDGER_GATE_INVALID/);
  const bad=ledger(21);
  bad.current.passed_phase_gates[0].gate='G21';
  assert.throws(() => evaluate(bad), /P22_READINESS_REFUSED/);
});

test('reject unknown keys, stale source/digest and missing proof IDs', () => {
  denied(p => { p.productionReady=true; });
  denied(p => { p.sourceSha='c'.repeat(40); });
  denied(p => { p.coreImage='ghcr.io/core:latest'; });
  denied(p => { p.observations[1].outcome='PASS_CLAIMED';p.observations[1].evidenceRef=null; });
  denied(p => { p.observations[0].check=p.observations[1].check; });
  denied(p => { p.observations.push(p.observations[0]); });
  denied(p => { p.observations[0].evidenceRef='https://outside.example.com/secrets'; });
  denied(p => { p.observations[0].evidenceRef='docs/v5/evidence/../secrets.json'; });
});

test('timestamp normalization, stale/future observations, and impossible UTC reject', () => {
  const p=packet();
  p.observedAtUtc='2026-10-09T08:59:00.000Z';
  assert.equal(evaluate(ledger(21),p).status,'CLAIMED_COMPLETE_UNVERIFIED');
  denied(p => { p.observedAtUtc='2026-10-07T00:00:00Z'; });
  denied(p => { p.observedAtUtc='2026-10-09T09:02:00Z'; });
  denied(p => { p.observedAtUtc='2026-02-30T09:00:00Z'; });
});
