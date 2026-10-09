'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {WRITERS,CALLBACKS,verifyFence}=require('../scripts/v5/p22/writer-fence');
const SHA='a'.repeat(40),V4='b'.repeat(40),SNAP='c'.repeat(64);
function manifest(phase) {
  return { format:'mega-v5-p22-writer-inventory/v1',
    sourceSha:SHA,phase,v4ReleaseSha:V4,
    v4FrozenSnapshotSha256:phase==='V4_SERVING'?null:SNAP,
    v4RebootFenceTestRef:phase==='V4_SERVING'?null:'artifact://v5/p22/fence-reboot/owned-rehearsal-01',
    firstV5ApplicationWriteRef:phase==='V5_EXCLUSIVE'?
      'artifact://v5/p22/first-write/pg-event-unique-001':null,
    safeReadProbes:[{method:'GET',route:'/livez',observedNoMutation:true}],
    entries:WRITERS.map(kind=>({
      class:kind,
      v4Mode:phase==='V4_SERVING'?'V4_WRITES_ONLY':'FENCED',
      v5Mode:phase==='V5_EXCLUSIVE'?'V5_POSTGRES_ONLY':'V5_MUTATIONS_DISABLED',
      v4RestartFenced:phase!=='V4_SERVING',
      callbackResponse:phase==='V4_SERVING'?'NORMAL_V4':(CALLBACKS.has(kind)
        ? (phase==='V4_FROZEN'?'RETRYABLE_NO_ACK':'V5_ACK_AFTER_DURABLE_DEDUPE')
        :'NOT_APPLICABLE'),
    })),
  };
}
function denied(edit,phase='V4_FROZEN') {
  const m=manifest(phase);
  edit(m);
  assert.throws(()=>verifyFence(m,SHA),/P22_FENCE_REFUSED/);
}

test('every phase classifies all 16 mutation/restart classes without granting runtime authority',()=>{
  for(const phase of ['V4_SERVING','V4_FROZEN','V5_EXCLUSIVE']) {
    const a=verifyFence(manifest(phase),SHA);
    assert.equal(a.minimumWriterClassesAccountedFor,16);
    assert.equal(a.phase,phase);
    assert.equal(a.runtimeWritePermission,false);
    assert.equal(a.cutoverAuthorized,false);
    assert.equal(a.observedEffectiveFenceVerified,false);
    assert.equal(a.g22Accepted,false);
  }
});

test('frozen V4 has no independent writer and all provider callbacks must retry without ACK',()=>{
  denied(m=>{m.entries[0].v4Mode='V4_WRITES_ONLY'});
  denied(m=>{m.entries[1].v5Mode='V5_POSTGRES_ONLY'});
  denied(m=>{m.entries[2].v4RestartFenced=false});
  denied(m=>{m.entries.find(x=>x.class==='store-purchase-and-refund').callbackResponse='V5_ACK_AFTER_DURABLE_DEDUPE'});
  denied(m=>{m.entries.find(x=>x.class==='provider-callback-and-inbox').callbackResponse='NORMAL_V4'});
});

test('post-write case cannot reenable SQLite, lose epoch or acknowledge provider before dedupe',()=>{
  denied(m=>{m.entries[0].v4Mode='V4_WRITES_ONLY'},'V5_EXCLUSIVE');
  denied(m=>{m.entries[0].v5Mode='V5_MUTATIONS_DISABLED'},'V5_EXCLUSIVE');
  denied(m=>{m.firstV5ApplicationWriteRef=null},'V5_EXCLUSIVE');
  denied(m=>{m.entries[3].v4RestartFenced=false},'V5_EXCLUSIVE');
  denied(m=>{m.entries.find(x=>x.class==='email-and-ad-rewards').callbackResponse='NORMAL_V4'},'V5_EXCLUSIVE');
  let m=manifest('V5_EXCLUSIVE');
  m.entries[0].v4Mode='FORWARD_TO_V5';
  assert.equal(verifyFence(m,SHA).phase,'V5_EXCLUSIVE');
});

test('inventory incomplete, extra class, duplicate or contradictory snapshot rejected',()=>{
  denied(m=>{m.entries.pop()});
  denied(m=>{m.entries[1].class=m.entries[0].class});
  denied(m=>{m.entries[1].class='undocumented-legacy-authority'});
  denied(m=>{m.v4FrozenSnapshotSha256=null});
  denied(m=>{m.v4RebootFenceTestRef='https://github.com/example'});
  denied(m=>{m.v4RebootFenceTestRef='artifact://v5/p22/fence/../other-audit'});
  denied(m=>{m.firstV5ApplicationWriteRef='artifact://v5/p22/first-write/already-committed'});
  denied(m=>{m.productionReady=true});
  denied(m=>{m.sourceSha='d'.repeat(40)});
  denied(m=>{m.v4FrozenSnapshotSha256=SNAP},'V4_SERVING');
});

test('read-only health preflight must not call implicit session/bootstrap GETs',()=>{
  denied(m=>{m.safeReadProbes=[{method:'GET',route:'/api/account/session',observedNoMutation:true}]});
  denied(m=>{m.safeReadProbes=[{method:'POST',route:'/livez',observedNoMutation:true}]});
  denied(m=>{m.safeReadProbes=[{method:'GET',route:'/readyz',observedNoMutation:false}]});
  denied(m=>{m.safeReadProbes=[{method:'GET',route:'/livez',observedNoMutation:true},
    {method:'GET',route:'/livez',observedNoMutation:true}]});
});
