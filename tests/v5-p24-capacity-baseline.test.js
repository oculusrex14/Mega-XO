'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {METRICS,baselineTemplate,assessBaseline}=require('../scripts/v5/p24/capacity-baseline');
const SHA='a'.repeat(40), P19='b'.repeat(40);
const ref=(type,n)=>'artifact://v5/p24/'+type+'/measurements-'+n+'-immutable';
function sample(environment='REAL_PRODUCTION'){
 return {
  format:'mega-v5-p24-capacity-baseline/v1',sourceSha:SHA,environment,
  periodStartUtc:'2026-10-01T00:00:00Z',periodEndUtc:'2026-10-02T00:00:00Z',
  capturedAtUtc:'2026-10-02T00:01:00Z',
  p19SourceSha:P19,p19EvidenceRef:'artifact://v5/p19/synthetic/disposable-test-only',
  collectionEvidenceRef:ref('collector','host-primary'),
  metrics:METRICS.map((spec,i)=>({
    signal:spec.signal,value:spec.unit==='percent'?25:5+i,
    sampleCount:250,fullyObserved:true,evidenceRef:ref('meter',String(i)),
  })),
 };
}
function denies(change) {
 const packet=sample();change(packet);
 assert.throws(()=>assessBaseline(packet,SHA),/P24_BASELINE_REFUSED/);
}
test('initial P24 baseline is UNKNOWN, never inferred from P19 disposable tier data',()=>{
 const p=baselineTemplate(SHA);
 assert.equal(p.metrics.length,10);
 assert.ok(p.metrics.every(x=>x.value===null));
 assert.equal(p.productionAlertThresholdsApproved,false);
 assert.equal(p.sourceTrafficForecast,'UNKNOWN');
 assert.equal(assessBaseline(null,SHA).launchCapacityProven,false);
});
test('even a complete production metric claim remains unverified and cannot scale',()=>{
 const result=assessBaseline(sample(),SHA);
 assert.equal(result.status,'PRODUCTION_CLAIM_NEEDS_INDEPENDENT_VERIFICATION');
 assert.equal(result.measuredSignals,METRICS.length);
 assert.equal(result.productionClaimComplete,true);
 assert.equal(result.productionBaselineIndependentlyVerified,false);
 assert.equal(result.currentProductionScaleAuthorization,false);
 assert.equal(result.g24Accepted,false);
});
test('P19 disposable and staging observations cannot silently certify production traffic',()=>{
 for(const environment of ['DISPOSABLE_P19','STAGING_CONTROLLED']){
  const result=assessBaseline(sample(environment),SHA);
  assert.equal(result.productionClaimComplete,false);
  assert.equal(result.launchCapacityProven,false);
  assert.match(result.status,/NOT_.*CAPACITY|NOT_LAUNCH_CAPACITY/);
 }
});
test('unknown data must be explicit, consistent and never treated as measured zero',()=>{
 const p=sample();p.metrics[0]={
  signal:METRICS[0].signal,value:null,sampleCount:0,
  fullyObserved:false,evidenceRef:null,
 };
 const result=assessBaseline(p,SHA);
 assert.equal(result.status,'PRODUCTION_BASELINE_INCOMPLETE');
 assert.ok(result.missingOrPartialSignals.includes(METRICS[0].signal));
 denies(p=>{p.metrics[0].value=null});
 denies(p=>{p.metrics[0].sampleCount=0});
 denies(p=>{p.metrics[0].evidenceRef=null});
});
test('incomplete or duplicate signal inventory and unknown metric types fail closed',()=>{
 denies(p=>p.metrics.pop());
 denies(p=>{p.metrics[1].signal=p.metrics[0].signal});
 denies(p=>{p.metrics[0].signal='actor_email'});
 denies(p=>{p.metrics[0].actorId='sensitive-actor'});
});
test('period must be real bounded UTC and attached to an exact immutable source',()=>{
 denies(p=>{p.sourceSha='b'.repeat(40)});
 denies(p=>{p.p19SourceSha='not-a-sha'});
 denies(p=>{p.collectionEvidenceRef='https://prod.example/secrets'});
 denies(p=>{p.periodStartUtc=p.periodEndUtc});
 denies(p=>{p.periodStartUtc='2026-10-01T05:30:00+05:30'});
 denies(p=>{p.capturedAtUtc='2026-10-01T00:00:00Z'});
 denies(p=>{p.capturedAtUtc='2026-11-02T00:00:00Z'});
 denies(p=>{p.periodStartUtc='2026-01-01T00:00:00Z'});
});
test('NaN, Infinity, negative samples, impossible percentages and malformed proof refs cannot enter a baseline',()=>{
 denies(p=>p.metrics[0].value=Infinity);
 denies(p=>p.metrics[0].value=NaN);
 denies(p=>p.metrics[0].value=-1);
 denies(p=>p.metrics.find(x=>x.signal==='host_cpu_pct').value=101);
 denies(p=>p.metrics[0].sampleCount=-2);
 denies(p=>p.metrics[0].sampleCount=1.5);
 denies(p=>p.metrics[0].evidenceRef='artifact://v5/p24/../forged');
});
test('partial measurement remains incomplete regardless of healthy numeric values',()=>{
 const p=sample();p.metrics[4].fullyObserved=false;
 assert.equal(assessBaseline(p,SHA).productionClaimComplete,false);
 const q=sample();q.metrics[1].sampleCount=1;
 assert.equal(assessBaseline(q,SHA).productionClaimComplete,false);
});
