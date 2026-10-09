'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { observe, STATE_FORMAT, STATES, TRANSITIONS } = require('../scripts/v5/p18/cutover-state-model.js');

const SHA = 'e'.repeat(40);
const HASH = 'a'.repeat(64);
const FIRST_WRITE_REF = 'fixture://first-write/session-revocation-0001';

/**
 * Helper to generate synthetic cutover trace events matching the state machine schema
 */
function makeEvent(state, index, overrides = {}) {
  const pre = ['PREPARED', 'DRAINING'].includes(state);
  const aborted = state === 'ABORTED_BEFORE_APPLICATION_WRITE';
  const frozen = ['FROZEN', 'IMPORTED_AND_VERIFIED', 'ARMED'].includes(state);
  const pg = ['V5_AUTHORITY', 'RECOVERING_WITH_POSTGRES', 'ACCEPTED'].includes(state);

  return {
    state,
    at: '2026-10-10T12:00:' + String(index).padStart(2, '0') + 'Z',
    writer: pre || aborted ? 'SQLITE_ONLY' : frozen ? 'NO_WRITER' : 'POSTGRES_ONLY',
    oldWriterFenced: !(pre || aborted),
    sourceSnapshotHash: pre ? null : HASH,
    postImportApplicationWriteAccepted: pg,
    firstApplicationWriteReference: pg ? FIRST_WRITE_REF : null,
    unexplainedDifferences: pg || state === 'IMPORTED_AND_VERIFIED' || state === 'ARMED' ? 0 : null,
    ...overrides
  };
}

function makeTrace(scenario, stateSequence) {
  return {
    format: STATE_FORMAT,
    sourceSha: SHA,
    environment: 'isolated-synthetic-copy',
    scenario,
    events: stateSequence.map((s, idx) => makeEvent(s, idx))
  };
}

test('cutover state machine transitions through complete happy path: PREPARED -> DRAINING -> FROZEN -> IMPORTED_AND_VERIFIED -> ARMED -> V5_AUTHORITY -> ACCEPTED', () => {
  // Validate complete state machine progression
  const sequence = [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'IMPORTED_AND_VERIFIED',
    'ARMED',
    'V5_AUTHORITY',
    'RECOVERING_WITH_POSTGRES',
    'ACCEPTED'
  ];
  const trace = makeTrace('recover-on-postgresql-after-first-write', sequence);
  const report = observe(trace, SHA);

  assert.equal(report.terminalState, 'ACCEPTED');
  assert.equal(report.firstApplicationWriteObservedInFixture, true);
  assert.equal(report.g18Accepted, false);
  assert.ok(report.fingerprint);
  assert.equal(typeof report.fingerprint, 'string');
});

test('pre-write rollback class: ABORTED_BEFORE_APPLICATION_WRITE preserves sole unchanged SQLite writer', () => {
  // Scenario 1: Abort from ARMED before any application write has been executed
  const abortFromArmed = [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'IMPORTED_AND_VERIFIED',
    'ARMED',
    'ABORTED_BEFORE_APPLICATION_WRITE'
  ];
  const trace = makeTrace('abort-before-first-application-write', abortFromArmed);
  const report = observe(trace, SHA);

  assert.equal(report.terminalState, 'ABORTED_BEFORE_APPLICATION_WRITE');
  assert.equal(report.firstApplicationWriteObservedInFixture, false);

  // Terminal abort event contract: writer MUST be SQLITE_ONLY, old writer unfenced, zero V5 application writes
  const terminalEvent = trace.events[trace.events.length - 1];
  assert.equal(terminalEvent.writer, 'SQLITE_ONLY');
  assert.equal(terminalEvent.oldWriterFenced, false);
  assert.equal(terminalEvent.postImportApplicationWriteAccepted, false);
  assert.equal(terminalEvent.firstApplicationWriteReference, null);
});

test('pre-write abort from FROZEN or IMPORTED_AND_VERIFIED correctly allows rollback with zero SQLite loss', () => {
  // Abort directly from FROZEN
  const abortFromFrozen = [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'ABORTED_BEFORE_APPLICATION_WRITE'
  ];
  const traceFrozen = makeTrace('abort-before-first-application-write', abortFromFrozen);
  const reportFrozen = observe(traceFrozen, SHA);
  assert.equal(reportFrozen.terminalState, 'ABORTED_BEFORE_APPLICATION_WRITE');

  // Abort directly from IMPORTED_AND_VERIFIED
  const abortFromImported = [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'IMPORTED_AND_VERIFIED',
    'ABORTED_BEFORE_APPLICATION_WRITE'
  ];
  const traceImported = makeTrace('abort-before-first-application-write', abortFromImported);
  const reportImported = observe(traceImported, SHA);
  assert.equal(reportImported.terminalState, 'ABORTED_BEFORE_APPLICATION_WRITE');
});

test('post-write recovery class: RECOVERING_WITH_POSTGRES forbids restoring stale SQLite writer', () => {
  // Once the first post-import application write is accepted, system enters V5_AUTHORITY.
  // Any failure after this boundary MUST transition to RECOVERING_WITH_POSTGRES and remain on PostgreSQL.
  const recoverSequence = [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'IMPORTED_AND_VERIFIED',
    'ARMED',
    'V5_AUTHORITY',
    'RECOVERING_WITH_POSTGRES',
    'ACCEPTED'
  ];
  const trace = makeTrace('recover-on-postgresql-after-first-write', recoverSequence);
  const report = observe(trace, SHA);
  assert.equal(report.terminalState, 'ACCEPTED');

  // Violation check: Attempting to abort back to SQLite after V5_AUTHORITY is rejected by the model
  const illegalRollback = makeTrace('recover-on-postgresql-after-first-write', [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'IMPORTED_AND_VERIFIED',
    'ARMED',
    'V5_AUTHORITY',
    'ABORTED_BEFORE_APPLICATION_WRITE'
  ]);
  assert.throws(() => observe(illegalRollback, SHA), /P18_CUTOVER_REFUSED/);

  // Violation check: Attempting to switch writer to SQLITE_ONLY during RECOVERING_WITH_POSTGRES
  const illegalWriterTrace = makeTrace('recover-on-postgresql-after-first-write', recoverSequence);
  illegalWriterTrace.events[6].writer = 'SQLITE_ONLY';
  assert.throws(() => observe(illegalWriterTrace, SHA), /P18_CUTOVER_REFUSED/);

  // Violation check: Attempting to unfence old writer during recovery
  const unfencedOldWriter = makeTrace('recover-on-postgresql-after-first-write', recoverSequence);
  unfencedOldWriter.events[6].oldWriterFenced = false;
  assert.throws(() => observe(unfencedOldWriter, SHA), /P18_CUTOVER_REFUSED/);
});

test('zero split-brain invariant: at no point can both SQLite and PostgreSQL be active writers simultaneously', () => {
  // Test every allowed state to ensure writer is strictly singular or NO_WRITER
  const validWriters = ['SQLITE_ONLY', 'NO_WRITER', 'POSTGRES_ONLY'];

  for (const s of STATES) {
    if (s === 'PREPARED' || s === 'DRAINING' || s === 'ABORTED_BEFORE_APPLICATION_WRITE') {
      const ev = makeEvent(s, 0);
      assert.equal(ev.writer, 'SQLITE_ONLY');
      assert.notEqual(ev.writer, 'BOTH');
    } else if (s === 'FROZEN' || s === 'IMPORTED_AND_VERIFIED' || s === 'ARMED') {
      const ev = makeEvent(s, 0);
      assert.equal(ev.writer, 'NO_WRITER');
      assert.equal(ev.oldWriterFenced, true);
    } else {
      const ev = makeEvent(s, 0);
      assert.equal(ev.writer, 'POSTGRES_ONLY');
      assert.equal(ev.oldWriterFenced, true);
    }
  }

  // An event attempting dual-writer "BOTH" or "SQLITE_AND_POSTGRES" must be rejected
  const splitBrainTrace = makeTrace('abort-before-first-application-write', [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'ABORTED_BEFORE_APPLICATION_WRITE'
  ]);
  splitBrainTrace.events[2].writer = 'BOTH';
  assert.throws(() => observe(splitBrainTrace, SHA), /P18_CUTOVER_REFUSED/);

  // If frozen stage has oldWriterFenced = false while trying to run PostgreSQL writes, refuse
  const unfencedFrozen = makeTrace('abort-before-first-application-write', [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'ABORTED_BEFORE_APPLICATION_WRITE'
  ]);
  unfencedFrozen.events[2].oldWriterFenced = false;
  assert.throws(() => observe(unfencedFrozen, SHA), /P18_CUTOVER_REFUSED/);
});

test('zero unexplained differences required across import and reconciliation stages', () => {
  // If unexplained differences exist during IMPORTED_AND_VERIFIED, transition is forbidden
  const traceWithDiffs = makeTrace('abort-before-first-application-write', [
    'PREPARED',
    'DRAINING',
    'FROZEN',
    'IMPORTED_AND_VERIFIED',
    'ABORTED_BEFORE_APPLICATION_WRITE'
  ]);
  traceWithDiffs.events[3].unexplainedDifferences = 3;
  assert.throws(() => observe(traceWithDiffs, SHA), /P18_CUTOVER_REFUSED/);
});
