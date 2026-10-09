'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DECISIONS,plan,evaluate}=require('../scripts/v5/p15/recovery-policy.js');

const SHA='a'.repeat(40);
function intake(status='OBSERVED'){
 return {format:'mega-v5-p15-policy-intake/v1',sourceSha:SHA,
  checkedAtUtc:'2026-10-09T00:00:00Z',
  decisions:DECISIONS.map(id=>({id,status,evidenceRef:status==='OBSERVED'?'restricted/proof/p15-'+id:null}))};
}
test('recovery plan cannot fabricate actual Neon plan, R2 cost, RTO or approval',()=>{
 const p=plan();
 assert.equal(p.status,'PROPOSED_TARGETS_NOT_APPROVED');
 assert.equal(p.candidateRpoMinutes,15);
 assert.equal(p.candidateRtoMinutes,60);
 assert.equal(p.actualProductionRpoMinutes,null);
 assert.equal(p.actualProductionRtoMinutes,null);
 assert.equal(p.measuredStorageCost,null);
 assert.equal(p.realR2RecoveryVerified,false);
 assert.equal(p.g15Accepted,false);
 assert.equal(p.decisions.length,9);
});
test('even all declared OBSERVED rows do not automatically certify backup, PITR or G15',()=>{
 const result=evaluate(intake());
 assert.equal(result.declarationCount,DECISIONS.length);
 assert.equal(result.pending.length,0);
 assert.equal(result.actualRestoreObserved,false);
 assert.equal(result.g15Accepted,false);
 assert.equal(result.productionEnablementAuthorized,false);
});
test('missing, duplicated, fake and insecure evidence references are refused',()=>{
 const mutations=[
  v=>v.decisions.pop(),
  v=>{v.decisions[0].id=v.decisions[1].id;},
  v=>{v.decisions[0].status='PASSED';},
  v=>{v.decisions[0].evidenceRef='../../secret';},
  v=>{v.decisions[0].evidenceRef='';},
  v=>{v.decisions[0].unknown=true;},
  v=>{v.checkedAtUtc='invalid';},
  v=>{v.sourceSha='HEAD';}
 ];
 for(const mutate of mutations){
  const record=intake();mutate(record);
  assert.throws(()=>evaluate(record),/P15_POLICY_REFUSED/);
 }
 const incomplete=intake('NOT_VERIFIED');
 assert.equal(evaluate(incomplete).declarationCount,0);
 assert.equal(evaluate(incomplete).g15Accepted,false);
});
