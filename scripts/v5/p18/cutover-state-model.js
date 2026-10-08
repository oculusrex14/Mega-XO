#!/usr/bin/env node
'use strict';

/**
 * P18-05/P22 cutover event-log validator for ISOLATED SYNTHETIC REHEARSALS.
 * Implements the existing V5 spec 07/template state machine without touching
 * DB, V4, DNS, workers, provider inboxes, or any production environment.
 * Passing these state-model fixtures does NOT prove a cutover was rehearsed.
 */
const crypto = require('node:crypto');
const STATES = Object.freeze([
  'PREPARED','DRAINING','FROZEN','IMPORTED_AND_VERIFIED','ARMED',
  'V5_AUTHORITY','ACCEPTED','ABORTED_BEFORE_APPLICATION_WRITE',
  'RECOVERING_WITH_POSTGRES'
]);
const TRANSITIONS = Object.freeze({
  PREPARED: ['DRAINING'],
  DRAINING: ['FROZEN'],
  FROZEN: ['IMPORTED_AND_VERIFIED','ABORTED_BEFORE_APPLICATION_WRITE'],
  IMPORTED_AND_VERIFIED: ['ARMED','ABORTED_BEFORE_APPLICATION_WRITE'],
  ARMED: ['V5_AUTHORITY','ABORTED_BEFORE_APPLICATION_WRITE'],
  V5_AUTHORITY: ['V5_AUTHORITY','ACCEPTED','RECOVERING_WITH_POSTGRES'],
  ACCEPTED: ['RECOVERING_WITH_POSTGRES'],
  RECOVERING_WITH_POSTGRES: ['RECOVERING_WITH_POSTGRES','ACCEPTED'],
  ABORTED_BEFORE_APPLICATION_WRITE: []
});
const STATE_FORMAT='mega-v5-p18-cutover-trace/v1';
const sha40=/^[a-f0-9]{40}$/, sha64=/^[a-f0-9]{64}$/;
const isoTime=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
function refuse(reason){throw new Error('P18_CUTOVER_REFUSED: '+reason);}
function exact(value,fields,label){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).sort().join('\0')!==[...fields].sort().join('\0')) {
    refuse('unrecognized or missing '+label+' fields');
  }
}
function observe(trace,sourceSha) {
  exact(trace,['format','sourceSha','environment','scenario','events'],'cutover trace');
  if(trace.format!==STATE_FORMAT||!sha40.test(trace.sourceSha)||
    trace.sourceSha!==sourceSha||trace.environment!=='isolated-synthetic-copy') {
    refuse('only explicit synthetic staging-copy trace and exact source commit permitted');
  }
  if(!['abort-before-first-application-write','recover-on-postgresql-after-first-write'].includes(trace.scenario)) {
    refuse('unknown rollback class');
  }
  if(!Array.isArray(trace.events)||trace.events.length<4||trace.events.length>30){
    refuse('bounded event history required');
  }
  let previous=null,firstWrite=false,snapshot=null,lastTime=-Infinity,usedPostgres=false;
  const normalized=[];
  for(const [index,e] of trace.events.entries()) {
    exact(e,['state','at','writer','oldWriterFenced','sourceSnapshotHash',
      'postImportApplicationWriteAccepted','firstApplicationWriteReference','unexplainedDifferences'],'cutover event');
    if(!STATES.includes(e.state)) refuse('unrecognized cutover state');
    if(!isoTime.test(e.at)||!Number.isFinite(Date.parse(e.at))||Date.parse(e.at)<=lastTime) {
      refuse('cutover event time missing, invalid or not monotonic');
    }
    lastTime=Date.parse(e.at);
    if(index===0&&e.state!=='PREPARED') refuse('rehearsal must begin PREPARED');
    if(previous && !TRANSITIONS[previous].includes(e.state)) refuse('illegal state transition '+previous+' -> '+e.state);
    const beforeFreeze=e.state==='PREPARED'||e.state==='DRAINING';
    const frozen=['FROZEN','IMPORTED_AND_VERIFIED','ARMED'].includes(e.state);
    const postgres=['V5_AUTHORITY','RECOVERING_WITH_POSTGRES','ACCEPTED'].includes(e.state);
    const aborted=e.state==='ABORTED_BEFORE_APPLICATION_WRITE';
    if(beforeFreeze || aborted) {
      if(e.writer!=='SQLITE_ONLY'||e.oldWriterFenced!==false) refuse('V4 must be sole unfenced writer only before freeze or safe abort');
    } else if(frozen) {
      if(e.writer!=='NO_WRITER'||e.oldWriterFenced!==true) refuse('frozen/import/armed states must have zero writers');
    } else if(postgres) {
      if(e.writer!=='POSTGRES_ONLY'||e.oldWriterFenced!==true) refuse('PostgreSQL must be only writer and V4 fenced');
      usedPostgres=true;
    }
    if(beforeFreeze && e.sourceSnapshotHash!==null) refuse('frozen source hash cannot be captured before freeze');
    if(!beforeFreeze) {
      if(typeof e.sourceSnapshotHash!=='string'||!sha64.test(e.sourceSnapshotHash)) refuse('consistent frozen SQLite source hash required');
      if(snapshot===null)snapshot=e.sourceSnapshotHash;
      if(snapshot!==e.sourceSnapshotHash) refuse('source snapshot changed during import/rehearsal');
    }
    const reconciled=['IMPORTED_AND_VERIFIED','ARMED','V5_AUTHORITY','RECOVERING_WITH_POSTGRES','ACCEPTED'].includes(e.state);
    if(reconciled && e.unexplainedDifferences!==0) refuse('imported state needs zero unexplained differences');
    if(!reconciled && e.unexplainedDifferences!==null && e.unexplainedDifferences!==0) {
      refuse('unexplained differences cannot be treated as a harmless observation');
    }
    if(typeof e.postImportApplicationWriteAccepted!=='boolean') refuse('first-write flag must be boolean');
    if(firstWrite&&!e.postImportApplicationWriteAccepted) refuse('first application write is irreversible');
    if(e.postImportApplicationWriteAccepted) {
      if(!postgres) refuse('an accepted V5 application write requires exclusive PostgreSQL authority');
      if(typeof e.firstApplicationWriteReference!=='string'||
        !/^fixture:\/\/first-write\/[a-z0-9_-]{8,100}$/.test(e.firstApplicationWriteReference)) {
        refuse('first-write identity missing or unbounded');
      }
      if(firstWrite && normalized[normalized.length-1].firstApplicationWriteReference!==e.firstApplicationWriteReference) {
        refuse('first write reference cannot change');
      }
      firstWrite=true;
    } else if(e.firstApplicationWriteReference!==null) refuse('first-write reference cannot appear before accepted effect');
    if((e.state==='RECOVERING_WITH_POSTGRES'||e.state==='ACCEPTED')&&!firstWrite) {
      refuse('PG recovery and acceptance require recorded first application write');
    }
    if(aborted && firstWrite) refuse('SQLite rollback forbidden after any post-import application write');
    previous=e.state;
    normalized.push({...e});
  }
  const last=normalized.at(-1);
  if(trace.scenario==='abort-before-first-application-write') {
    if(last.state!=='ABORTED_BEFORE_APPLICATION_WRITE'||firstWrite||usedPostgres) {
      refuse('pre-write abort must return to sole SQLite before V5 application writes');
    }
  } else if(last.state!=='ACCEPTED'||!firstWrite||
       !normalized.some(e=>e.state==='RECOVERING_WITH_POSTGRES')) {
    refuse('post-write scenario must recover and accept while remaining on PostgreSQL');
  }
  return {
    format:'mega-v5-p18-cutover-state-model-result/v1',
    scenario:trace.scenario,
    sourceSha:trace.sourceSha,
    eventCount:normalized.length,
    terminalState:last.state,
    firstApplicationWriteObservedInFixture:firstWrite,
    outcome:'SYNTHETIC_STATE_MODEL_ONLY',
    actualCutoverRehearsalVerified:false,
    g18Accepted:false,
    fingerprint:crypto.createHash('sha256').update(JSON.stringify(trace)).digest('hex')
  };
}
module.exports={STATES,TRANSITIONS,STATE_FORMAT,observe};
