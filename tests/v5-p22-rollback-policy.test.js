'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, reviewSyntheticRehearsal } = require('../scripts/v5/p22/rollback-policy');
const { STATE_FORMAT } = require('../scripts/v5/p18/cutover-state-model');
const SHA = 'a'.repeat(40), HASH = 'b'.repeat(64), FIRST = 'fixture://first-write/session-bootstrap-0001';
function record(stage='ARMED', kind='NONE_INDEPENDENTLY_PROVEN') {
  return {
    format:'mega-v5-p22-recovery-evaluation/v1',sourceSha:SHA,stage,
    applicationWriteState:kind,v4SourceSnapshotSha256:HASH,v4LatestSnapshotSha256:HASH,
    v4FencingEvidenceRef:'artifact://v5/p22/fence/owned-test-01',
    allV5WritePathsProvenDisabled:true,pgCompatibleReleaseVerified:true,
  };
}
function event(state,i,override={}) {
  const pre=['PREPARED','DRAINING'].includes(state);
  const abort=state==='ABORTED_BEFORE_APPLICATION_WRITE';
  const frozen=['FROZEN','IMPORTED_AND_VERIFIED','ARMED'].includes(state);
  const pg=['V5_AUTHORITY','ACCEPTED','RECOVERING_WITH_POSTGRES'].includes(state);
  return {
    state,at:'2026-10-09T00:00:'+String(i).padStart(2,'0')+'Z',
    writer:pre||abort?'SQLITE_ONLY':frozen?'NO_WRITER':'POSTGRES_ONLY',
    oldWriterFenced:!(pre||abort),sourceSnapshotHash:pre?null:HASH,
    postImportApplicationWriteAccepted:pg,
    firstApplicationWriteReference:pg?FIRST:null,
    unexplainedDifferences:pg||state==='IMPORTED_AND_VERIFIED'||state==='ARMED'?0:null,
    ...override,
  };
}
function trace(postWrite=false) {
  const states=['PREPARED','DRAINING','FROZEN','IMPORTED_AND_VERIFIED','ARMED',
    ...(postWrite?['V5_AUTHORITY','RECOVERING_WITH_POSTGRES','ACCEPTED']:
      ['ABORTED_BEFORE_APPLICATION_WRITE'])];
  return {format:STATE_FORMAT,sourceSha:SHA,environment:'isolated-synthetic-copy',
    scenario:postWrite?'recover-on-postgresql-after-first-write':'abort-before-first-application-write',
    events:states.map((state, i) => event(state, i))};
}

test('prewrite rollback candidate requires all independent no-first-write and unchanged V4 proofs',()=>{
  for(const state of ['PREPARED','DRAINING','FROZEN','IMPORTED_AND_VERIFIED','ARMED']) {
    const x=classify(record(state),SHA);
    assert.equal(x.treatment,'V4_SOLE_WRITER_RECOVERY_CANDIDATE_OPERATOR_REVIEW');
    assert.equal(x.mayAutomaticallyRestartV4,false);
    assert.equal(x.authorizesRecovery,false);
  }
});

test('even an ordinary session/bootstrap/provider inbox write irreversibly requires PostgreSQL recovery',()=>{
  for(const stage of ['PREPARED','ARMED','V5_AUTHORITY','ACCEPTED','RECOVERING_WITH_POSTGRES']) {
    const result=classify(record(stage,'OBSERVED'),SHA);
    assert.equal(result.treatment,'POSTGRES_COMPATIBLE_RELEASE_OR_FORWARD_FIX');
    assert.equal(result.applicationWriteIncludes.includes('session-bootstrap'),true);
    assert.equal(result.applicationWriteIncludes.includes('provider-callback-and-inbox'),true);
    assert.equal(result.applicationWriteIncludes.includes('outbox-and-delivery'),true);
    assert.equal(result.mayAutomaticallyRestartV4,false);
  }
});

test('unknown state, missing fence, changed V4 snapshot or unproven disabled writers forbid V4 rollback',()=>{
  for(const change of [
    x=>{x.applicationWriteState='UNKNOWN';},
    x=>{x.v4FencingEvidenceRef=null;},
    x=>{x.v4LatestSnapshotSha256='c'.repeat(64);},
    x=>{x.allV5WritePathsProvenDisabled=false;},
  ]) {
    const x=record();change(x);
    assert.equal(classify(x,SHA).treatment,'QUARANTINE_UNPROVEN_FIRST_WRITE');
  }
});

test('after transfer neither lost write evidence nor disabled PG rollback is mistaken for V4 candidate',()=>{
  const unknown=record('V5_AUTHORITY','UNKNOWN');
  assert.equal(classify(unknown,SHA).treatment,'QUARANTINE_AND_RECONCILE_POSTGRES');
  const x=record('RECOVERING_WITH_POSTGRES','OBSERVED');
  x.pgCompatibleReleaseVerified=false;
  assert.equal(classify(x,SHA).treatment,'QUARANTINE_AND_RECONCILE_POSTGRES');
  assert.equal(classify(record('ACCEPTED','NONE_INDEPENDENTLY_PROVEN'),SHA).mayAutomaticallyRestartV4,false);
});

test('synthetic pre-write abort and post-write PG recovery must agree with frozen P18 cutover protocol',()=>{
  const abort=reviewSyntheticRehearsal(trace(false),SHA,record());
  assert.equal(abort.scenario,'abort-before-first-application-write');
  assert.equal(abort.actualDrillExecuted,false);
  assert.equal(abort.recoveryAuthorized,false);
  assert.equal(abort.g22Accepted,false);
  const post=reviewSyntheticRehearsal(trace(true),SHA,record('RECOVERING_WITH_POSTGRES','OBSERVED'));
  assert.equal(post.scenario,'recover-on-postgresql-after-first-write');
  assert.equal(post.recoveryClass,'POSTGRES_COMPATIBLE_RELEASE_OR_FORWARD_FIX');
  assert.equal(post.g22Accepted,false);
});

test('rehearsal refuses contradictory first-write metadata and replayed V4 authority',()=>{
  assert.throws(()=>reviewSyntheticRehearsal(trace(true),SHA,record('ARMED')),/P22_ROLLBACK_REFUSED/);
  assert.throws(()=>reviewSyntheticRehearsal(trace(false),SHA,record('RECOVERING_WITH_POSTGRES','OBSERVED')),/P22_ROLLBACK_REFUSED/);
  const x=trace(true);x.events[6].writer='SQLITE_ONLY';
  assert.throws(()=>reviewSyntheticRehearsal(x,SHA,record('RECOVERING_WITH_POSTGRES','OBSERVED')),/P18_CUTOVER_REFUSED/);
});

test('malformed or stolen evidence cannot silently make a rollback decision',()=>{
  const x=record();x.sourceSha='d'.repeat(40);
  assert.throws(()=>classify(x,SHA),/P22_ROLLBACK_REFUSED/);
  const y=record();y.productionPermission=true;
  assert.throws(()=>classify(y,SHA),/P22_ROLLBACK_REFUSED/);
  const z=record();z.v4FencingEvidenceRef='https://attacker.example/redirect';
  const pathTraversal=record();pathTraversal.v4FencingEvidenceRef='artifact://v5/p22/fence/../fakeproof';
  assert.throws(()=>classify(pathTraversal,SHA),/P22_ROLLBACK_REFUSED/);
  assert.throws(()=>classify(z,SHA),/P22_ROLLBACK_REFUSED/);
});
