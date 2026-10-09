'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessRetirement, RESTART_CASES } = require('../scripts/v5/p23/retirement-readiness');
const { WRITERS, CALLBACKS } = require('../scripts/v5/p22/writer-fence');
const SHA = 'a'.repeat(40), V4 = 'b'.repeat(40), HASH = 'c'.repeat(64);
const FIRST = 'artifact://v5/p22/first-write/verified-first-write-01';
const ref = name => 'artifact://v5/p23/' + name + '/operator-test-evidence-001';
function ledger(accepted = false) {
  const count = accepted ? 23 : 8;
  return { schema_version:1, current:{ integration_branch:'V5-platform',
    passed_phase_gates:Array.from({length:count},(_,i)=>({
      phase:'P'+String(i).padStart(2,'0'), gate:'G'+String(i).padStart(2,'0'),
      evidence_refs:['docs/v5/evidence/phase-gate.json'],
    })),
  }};
}
function declaration() {
  return {
    format:'mega-v5-p23-retirement-declaration/v1',sourceSha:SHA,
    authorityEpoch:'v5:1791528000000:' + 'e'.repeat(24),
    firstV5ApplicationWriteRef:FIRST,v4ReleaseSha:V4,
    sqliteFinalSnapshotSha256:HASH,sqliteArchiveReadOnly:true,
    v5OnlyPostgresWriter:true,v4LegacyRole:'FACADE_TO_V5_ONLY',
    writerFence:{
      format:'mega-v5-p22-writer-inventory/v1',sourceSha:SHA,phase:'V5_EXCLUSIVE',
      v4ReleaseSha:V4,v4FrozenSnapshotSha256:HASH,
      v4RebootFenceTestRef:'artifact://v5/p22/reboot/verified-fence-001',
      firstV5ApplicationWriteRef:FIRST,safeReadProbes:[],
      entries:WRITERS.map(kind=>({
        class:kind,v4Mode:'FENCED',v5Mode:'V5_POSTGRES_ONLY',
        v4RestartFenced:true,
        callbackResponse:CALLBACKS.has(kind) ?
          'V5_ACK_AFTER_DURABLE_DEDUPE':'NOT_APPLICABLE',
      })),
    },
    writers:WRITERS.map(kind=>({
      class:kind,v4MutatingRoutes:0,v4ActiveSchedulerJobs:0,
      restartStillFenced:true,durableAuthority:'SINGLE_V5_POSTGRES',
      compatibilityRoute:CALLBACKS.has(kind) ?
        'FORWARD_TO_V5_DURABLE_INBOX':'DISABLED_OR_FORWARD_TO_V5',
      evidenceRef:ref('writers'),
    })),
    restartChecks:RESTART_CASES.map(scenario=>({
      scenario,outcome:'PASS_CLAIMED',evidenceRef:ref('reboot'),
    })),
  };
}
function refuse(edit) {
  const p=declaration();edit(p);
  assert.throws(()=>assessRetirement(ledger(true),SHA,p),/P23_RETIREMENT_REFUSED|P22_FENCE_REFUSED/);
}

test('current G07-only owner ledger blocks V4 retirement even with a fabricated perfect packet',()=>{
  const r=assessRetirement(ledger(false),SHA,declaration());
  assert.equal(r.status,'BLOCKED_G22_NOT_ACCEPTED');
  assert.equal(r.g23Accepted,false);
  assert.equal(r.v4RetirementAuthorized,false);
  assert.equal(r.productionMutationAllowed,false);
});
test('G22 accepted but no packet cannot imply V4 is fenced',()=>{
  const r=assessRetirement(ledger(true),SHA);
  assert.equal(r.status,'BLOCKED_NO_RETIREMENT_EVIDENCE');
  assert.equal(r.v4WritersActuallyFenced,false);
});
test('a complete retirement packet remains REVIEW ONLY, never applies service changes',()=>{
  const r=assessRetirement(ledger(true),SHA,declaration());
  assert.equal(r.status,'DECLARATIONS_COMPLETE_INDEPENDENT_EXECUTION_REQUIRED');
  assert.equal(r.coveredWriterClasses,WRITERS.length);
  assert.equal(r.coveredRestartScenarios,RESTART_CASES.length);
  assert.equal(r.ownerEvidenceIndependentlyVerified,false);
  assert.equal(r.v4RetirementAuthorized,false);
  assert.equal(r.g23Accepted,false);
});
test('the exact P22 first accepted app write, source SQLite and authority epoch cannot change',()=>{
  refuse(p=>{p.sourceSha='f'.repeat(40)});
  refuse(p=>{p.writerFence.v4FrozenSnapshotSha256='d'.repeat(64)});
  refuse(p=>{p.firstV5ApplicationWriteRef='artifact://v5/p23/first-write/a-fake-first-write-ref'});
  refuse(p=>{p.firstV5ApplicationWriteRef='artifact://v5/p22/first-write/../forged-receipt'});
  refuse(p=>{p.firstV5ApplicationWriteRef='artifact://v5/p22/first-write/some-other-unique-event'});
  refuse(p=>{p.authorityEpoch='v4:unknown'});
  refuse(p=>{p.sqliteArchiveReadOnly=false});
});
test('legacy cron, callback, mutation or rollback can never remain an independent SQLite writer',()=>{
  refuse(p=>{p.writers[2].v4MutatingRoutes=1});
  refuse(p=>{p.writers[4].v4ActiveSchedulerJobs=1});
  refuse(p=>{p.writers[6].restartStillFenced=false});
  refuse(p=>{p.writers.find(x=>x.class==='provider-callback-and-inbox').compatibilityRoute='OLD_SQLITE_CALLBACK'});
  refuse(p=>{p.v5OnlyPostgresWriter=false});
  refuse(p=>{p.v4LegacyRole='SQLITE_FALLBACK'});
});
test('every actor-class and restart vector must be covered without extra or spoofed claims',()=>{
  refuse(p=>{p.writers.pop()});
  refuse(p=>{p.writers[1].class=p.writers[0].class});
  refuse(p=>{p.restartChecks=p.restartChecks.filter(x=>x.scenario!=='host-reboot')});
  refuse(p=>{p.restartChecks[1].scenario=p.restartChecks[0].scenario});
  refuse(p=>{p.restartChecks[0].outcome='NOT_RUN'});
  refuse(p=>{p.restartChecks[2].evidenceRef='artifact://v5/p23/../forged'});
  refuse(p=>{p.extraAuthorityPermission=true});
});
test('unknown or duplicated owner gate entries are not trusted',()=>{
  const l=ledger(true);l.current.passed_phase_gates.push(l.current.passed_phase_gates[0]);
  assert.throws(()=>assessRetirement(l,SHA),/P23_RETIREMENT_REFUSED:INVALID_GATE_LEDGER/);
  const x=ledger(true);x.current.integration_branch='main';
  assert.throws(()=>assessRetirement(x,SHA),/P23_RETIREMENT_REFUSED:OWNER_LEDGER_REQUIRED/);
});
