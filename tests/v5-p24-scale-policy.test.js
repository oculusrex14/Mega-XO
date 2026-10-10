'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {METRICS}=require('../scripts/v5/p24/capacity-baseline');
const {ARCHITECTURE,template,assessPolicy}=require('../scripts/v5/p24/scale-policy');
const SHA='a'.repeat(40);
const ref=kind=>'artifact://v5/p24/'+kind+'/operator-review-20261009';
function configured(signal='host_cpu_pct'){
 const policy=template(SHA),e=policy.entries.find(x=>x.signal===signal);
 Object.assign(e,{
  threshold:82,sustainMinutes:30,estimatedAdditionalMonthlyUsd:45,
  measurementQueryRef:ref('measurement-query'),rollbackEvidenceRef:ref('rollback'),
 });
 return policy;
}
function denies(edit){const p=configured();edit(p);
 assert.throws(()=>assessPolicy(p,SHA),/P24_POLICY_REFUSED/);}
test('P24 template contains all fixed domains, no fake production thresholds',()=>{
 const p=template(SHA),report=assessPolicy(p,SHA);
 assert.equal(p.entries.length,METRICS.length);
 assert.ok(p.entries.every(x=>x.threshold===null&&!x.operatorApproved));
 assert.equal(report.configuredTriggers,0);
 assert.equal(report.liveInfrastructureChangeAuthorized,false);
 assert.equal(report.independentHostHAProven,false);
});
test('a plausible numeric trigger with budget/rollback is still review-only',()=>{
 const result=assessPolicy(configured(),SHA);
 assert.equal(result.configuredTriggers,1);
 assert.equal(result.approvedClaims,0);
 assert.equal(result.productionBudgetVerified,false);
 assert.equal(result.g24Accepted,false);
});
test('even operator approval claims do not turn the policy into a provisioning API',()=>{
 const p=configured();
 const x=p.entries.find(e=>e.signal==='host_cpu_pct');
 x.operatorApproved=true;
 x.ownerApprovalEvidenceRef=ref('approval');
 x.changeTicketRef=ref('change-ticket');
 const r=assessPolicy(p,SHA);
 assert.equal(r.approvedClaims,1);
 assert.equal(r.operatorEvidenceIndependentlyVerified,false);
 assert.equal(r.liveInfrastructureChangeAuthorized,false);
});
test('host HA must not be claimed by two Core containers on one Oracle machine',()=>{
 for(const key of Object.keys(ARCHITECTURE)){
  denies(p=>{p.architectureGuards[key]=!ARCHITECTURE[key]});
 }
 denies(p=>{p.architectureGuards.hostHaAlreadyProven=true});
});
test('cannot substitute arbitrary Kafka/Kubernetes/global-write-master plan for the fixed minimal action',()=>{
 denies(p=>{p.entries.find(e=>e.signal==='host_cpu_pct').action='MOVE_TO_KUBERNETES'});
 denies(p=>{p.entries.find(e=>e.signal==='host_cpu_pct').action='MULTI_PRIMARY_CROWNS'});
 denies(p=>{p.entries[0].signal=p.entries[1].signal});
 denies(p=>p.entries.pop());
});
test('no threshold without sustained duration, query provenance, rollback and a cost estimate',()=>{
 denies(p=>{p.entries.find(x=>x.threshold!==null).sustainMinutes=0});
 denies(p=>{p.entries.find(x=>x.threshold!==null).threshold=NaN});
 denies(p=>{p.entries.find(x=>x.threshold!==null).threshold=-1});
 denies(p=>{p.entries.find(x=>x.threshold!==null).estimatedAdditionalMonthlyUsd=null});
 denies(p=>{p.entries.find(x=>x.threshold!==null).rollbackEvidenceRef=null});
 denies(p=>{p.entries.find(x=>x.threshold!==null).measurementQueryRef='https://internal.example'});
 denies(p=>{p.entries.find(x=>x.threshold!==null).ownerApprovalEvidenceRef=ref('fake-approved')});
});
test('approval requires a specific owner review and change record, not a boolean',()=>{
 denies(p=>{p.entries.find(x=>x.threshold!==null).operatorApproved=true});
 denies(p=>{
  const x=p.entries.find(x=>x.threshold!==null);
  x.operatorApproved=true;x.ownerApprovalEvidenceRef=ref('approved');
 });
});
test('unconfigured triggers never carry partial speculative changes',()=>{
 const p=template(SHA);p.entries[0].estimatedAdditionalMonthlyUsd=123;
 assert.throws(()=>assessPolicy(p,SHA),/P24_POLICY_REFUSED/);
 assert.equal(assessPolicy(null,SHA).status,'NO_APPROVED_SCALE_TRIGGERS');
});
test('source revision and owner review cadence are bounded',()=>{
 denies(p=>p.sourceSha='b'.repeat(40));
 denies(p=>p.ownerReviewCadenceDays=0);
 denies(p=>p.ownerReviewCadenceDays=31);
});
