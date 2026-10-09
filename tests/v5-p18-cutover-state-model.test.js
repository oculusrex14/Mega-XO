'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {observe,STATE_FORMAT}=require('../scripts/v5/p18/cutover-state-model.js');
const SHA='e'.repeat(40),HASH='a'.repeat(64),FIRST='fixture://first-write/session-revocation-0001';
const STATES=['PREPARED','DRAINING','FROZEN','IMPORTED_AND_VERIFIED','ARMED'];
function event(state,index,overrides={}){
  const pre=['PREPARED','DRAINING'].includes(state);
  const aborted=state==='ABORTED_BEFORE_APPLICATION_WRITE';
  const frozen=['FROZEN','IMPORTED_AND_VERIFIED','ARMED'].includes(state);
  const pg=['V5_AUTHORITY','RECOVERING_WITH_POSTGRES','ACCEPTED'].includes(state);
  return {
    state,at:'2026-10-09T00:00:'+String(index).padStart(2,'0')+'Z',
    writer:pre||aborted?'SQLITE_ONLY':frozen?'NO_WRITER':'POSTGRES_ONLY',
    oldWriterFenced:!(pre||aborted),
    sourceSnapshotHash:pre?null:HASH,
    postImportApplicationWriteAccepted:pg,
    firstApplicationWriteReference:pg?FIRST:null,
    unexplainedDifferences:pg||state==='IMPORTED_AND_VERIFIED'||state==='ARMED'?0:null,
    ...overrides
  };
}
function trace(type) {
 const seq=type==='abort'?
  [...STATES,'ABORTED_BEFORE_APPLICATION_WRITE']:
  [...STATES,'V5_AUTHORITY','RECOVERING_WITH_POSTGRES','ACCEPTED'];
 return {
  format:STATE_FORMAT,sourceSha:SHA,environment:'isolated-synthetic-copy',
  scenario:type==='abort'?'abort-before-first-application-write':'recover-on-postgresql-after-first-write',
  events:seq.map((state,i)=>event(state,i))
 };
}
function denied(edit,type='abort'){
 const x=trace(type);edit(x);
 assert.throws(()=>observe(x,SHA),/P18_CUTOVER_REFUSED/);
}
test('pre-write abort returns sole unchanged SQLite writer with no V5 application effects',()=>{
 const x=trace('abort'),report=observe(x,SHA);
 assert.equal(report.terminalState,'ABORTED_BEFORE_APPLICATION_WRITE');
 assert.equal(report.firstApplicationWriteObservedInFixture,false);
 assert.equal(report.actualCutoverRehearsalVerified,false);
 assert.equal(report.g18Accepted,false);
 assert.match(report.fingerprint,/^[a-f0-9]{64}$/);
});
test('post-write failure MUST recover on PostgreSQL and cannot restore stale V4',()=>{
 const report=observe(trace('recover'),SHA);
 assert.equal(report.terminalState,'ACCEPTED');
 assert.equal(report.firstApplicationWriteObservedInFixture,true);
 assert.equal(report.g18Accepted,false);
 denied(x=>{x.events[6].writer='SQLITE_ONLY'},'recover');
 denied(x=>{x.events[6].oldWriterFenced=false},'recover');
 denied(x=>{x.events[6].postImportApplicationWriteAccepted=false},'recover');
 denied(x=>{x.events[6].firstApplicationWriteReference=null},'recover');
 denied(x=>{x.events[7].firstApplicationWriteReference='fixture://first-write/other-session-100'},'recover');
 denied(x=>{x.events[7].state='ABORTED_BEFORE_APPLICATION_WRITE'},'recover');
});
test('import/armed phases admit no writer and require exact reconciliation',()=>{
 denied(x=>{x.events[3].writer='POSTGRES_ONLY'});
 denied(x=>{x.events[4].oldWriterFenced=false});
 denied(x=>{x.events[3].unexplainedDifferences=1});
 denied(x=>{x.events[3].sourceSnapshotHash='b'.repeat(64)});
 denied(x=>{x.events[1].sourceSnapshotHash=HASH});
 denied(x=>{x.events[2].oldWriterFenced=false});
});
test('invalid transitions and time regressions never look like success',()=>{
 denied(x=>{x.events[1].state='V5_AUTHORITY'});
 denied(x=>{x.events[3].at=x.events[2].at});
 denied(x=>{x.events[2].writer='BOTH'});
 denied(x=>{x.events[0].state='ACCEPTED'});
 denied(x=>{x.events[5].postImportApplicationWriteAccepted=true});
 denied(x=>{x.events[2].unexplainedDifferences=99});
 denied(x=>{x.events[2].firstApplicationWriteReference='fixture://first-write/premature-effect'});
});
test('pre-write abort cannot be mislabeled as post-write PG recovery',()=>{
 denied(x=>{x.scenario='recover-on-postgresql-after-first-write'});
 denied(x=>{x.events.push(event('ACCEPTED',6))});
 denied(x=>{x.environment='production'});
 denied(x=>{x.sourceSha='f'.repeat(40)});
});
