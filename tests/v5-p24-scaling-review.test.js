'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {METRICS}=require('../scripts/v5/p24/capacity-baseline');
const {template}=require('../scripts/v5/p24/scale-policy');
const {reviewScale}=require('../scripts/v5/p24/scaling-review');
const SHA='a'.repeat(40),P19='b'.repeat(40);
const ref=s=>'artifact://v5/p24/'+s+'/operator-verified-20261009';
function ledger(accepted){
 const ids=accepted?[...Array(21).keys(),22,23]:[...Array(9).keys()];
 return {schema_version:1,current:{
  integration_branch:'V5-platform',passed_phase_gates:ids.map(i=>({
   phase:'P'+String(i).padStart(2,'0'),gate:'G'+String(i).padStart(2,'0'),
   evidence_refs:['docs/v5/evidence/phase-gate.json'],
  })),
 }};
}
function metrics(cpu=90){
 return METRICS.map((spec,i)=>({
  signal:spec.signal,value:spec.signal==='host_cpu_pct'?cpu:
   spec.unit==='percent'?25:10+i,
  sampleCount:120,fullyObserved:true,evidenceRef:ref('metric-'+i),
 }));
}
function baseline(environment='REAL_PRODUCTION'){
 return {
  format:'mega-v5-p24-capacity-baseline/v1',sourceSha:SHA,environment,
  periodStartUtc:'2026-10-01T00:00:00Z',periodEndUtc:'2026-10-02T00:00:00Z',
  capturedAtUtc:'2026-10-02T00:01:00Z',p19SourceSha:P19,
  p19EvidenceRef:'artifact://v5/p19/synthetic/disposable-only',
  collectionEvidenceRef:ref('collection-baseline'),
  metrics:metrics(),
 };
}
function policy(approved){
 const p=template(SHA),c=p.entries.find(x=>x.signal==='host_cpu_pct');
 Object.assign(c,{
  threshold:82,sustainMinutes:30,estimatedAdditionalMonthlyUsd:75,
  measurementQueryRef:ref('collector-query'),rollbackEvidenceRef:ref('rollback-plan'),
  operatorApproved:approved,
  ownerApprovalEvidenceRef:approved?ref('operator-approval'):null,
  changeTicketRef:approved?ref('bounded-change-ticket'):null,
 });
 return p;
}
function period(start,end,cpu=90,environment='REAL_PRODUCTION'){
 return {
  format:'mega-v5-p24-scale-interval/v1',sourceSha:SHA,environment,
  startUtc:start,endUtc:end,complete:true,
  collectionEvidenceRef:ref('interval-evidence'),
  metrics:metrics(cpu),
 };
}
const periods=()=>[
 period('2026-10-09T10:00:00Z','2026-10-09T10:10:00Z'),
 period('2026-10-09T10:10:00Z','2026-10-09T10:20:00Z'),
 period('2026-10-09T10:20:00Z','2026-10-09T10:30:00Z'),
];
const args=(accepted=true,approved=true)=>({
 ledger:ledger(accepted),sourceSha:SHA,nowUtc:'2026-10-09T10:31:00Z',
 baseline:baseline(),policy:policy(approved),intervals:periods(),
});
test('actual owner G08-only state cannot trigger G24 or stage a provisioning request',()=>{
 const r=reviewScale(args(false,true));
 assert.equal(r.status,'BLOCKED_G23_NOT_ACCEPTED');
 assert.equal(r.acceptedG23,false);
 assert.deepEqual(r.reviewCandidates,[]);
 assert.equal(r.productionMutationAuthorized,false);
});
test('G23 with no production baseline remains explicitly NOT_TRIGGERED',()=>{
 const a=args();a.baseline=null;
 const r=reviewScale(a);
 assert.equal(r.status,'NOT_TRIGGERED_NO_VERIFIED_PRODUCTION_BASELINE');
 assert.equal(r.actualScaleApplied,false);
});
test('P19 synthetic and staging benchmarks can never trigger Oracle or PG upgrades',()=>{
 for(const environment of ['DISPOSABLE_P19','STAGING_CONTROLLED']){
  const a=args();a.baseline=baseline(environment);
  const r=reviewScale(a);
  assert.equal(r.status,'NOT_TRIGGERED_NO_VERIFIED_PRODUCTION_BASELINE');
  assert.deepEqual(r.reviewCandidates,[]);
 }
});
test('a 3-window sustained production threshold produces a claimed REVIEW, never scale authority',()=>{
 const r=reviewScale(args());
 assert.equal(r.reviewCandidates.length,1);
 assert.equal(r.reviewCandidates[0].signal,'host_cpu_pct');
 assert.equal(r.reviewCandidates[0].sustainedMinutes,30);
 assert.equal(r.reviewCandidates[0].windows,3);
 assert.equal(r.reviewCandidates[0].estimatedAdditionalMonthlyUsd,75);
 assert.equal(r.actualScaleApplied,false);
 assert.equal(r.productionMutationAuthorized,false);
 assert.equal(r.telemetryIndependentlyVerified,false);
 assert.equal(r.independentHostHAProven,false);
 assert.equal(r.g24Accepted,false);
});
test('an unapproved trigger crossing must request review, never invent approval',()=>{
 const r=reviewScale(args(true,false));
 assert.equal(r.status,'THRESHOLD_CLAIM_AWAITS_OWNER_APPROVAL');
 assert.equal(r.ownerApprovalPending.length,1);
 assert.deepEqual(r.reviewCandidates,[]);
});
test('no owner threshold, no windows, below threshold and too few samples are not triggers',()=>{
 const x=args();x.policy=template(SHA);
 assert.equal(reviewScale(x).status,'NOT_TRIGGERED_NO_APPROVED_THRESHOLDS');
 const y=args();y.intervals=[];
 assert.equal(reviewScale(y).status,'NOT_TRIGGERED_NO_CURRENT_TELEMETRY');
 const z=args();z.intervals[1]=period('2026-10-09T10:10:00Z','2026-10-09T10:20:00Z',20);
 assert.deepEqual(reviewScale(z).reviewCandidates,[]);
 const q=args();q.intervals[1].metrics.find(m=>m.signal==='host_cpu_pct').sampleCount=1;
 assert.deepEqual(reviewScale(q).reviewCandidates,[]);
});
test('stale windows, gaps and interrupted intervals fail conservative sustained demand',()=>{
 const old=args();old.nowUtc='2026-10-09T11:00:00Z';
 assert.deepEqual(reviewScale(old).reviewCandidates,[]);
 const gap=args();gap.intervals=[
  period('2026-10-09T10:00:00Z','2026-10-09T10:10:00Z'),
  period('2026-10-09T10:11:00Z','2026-10-09T10:20:00Z'),
  period('2026-10-09T10:20:00Z','2026-10-09T10:30:00Z'),
 ];
 assert.deepEqual(reviewScale(gap).reviewCandidates,[]);
 const partial=args();partial.intervals[1].complete=false;
 assert.deepEqual(reviewScale(partial).reviewCandidates,[]);
 const synthetic=args();synthetic.intervals[1].environment='DISPOSABLE_P19';
 assert.deepEqual(reviewScale(synthetic).reviewCandidates,[]);
});
test('overlap, future intervals, wrong source, unbounded array or missing metrics are refused',()=>{
 const cases=[
  a=>{a.intervals[1].startUtc='2026-10-09T10:05:00Z'},
  a=>{a.intervals[2].endUtc='2026-10-09T11:40:00Z'},
  a=>{a.intervals[1].sourceSha='b'.repeat(40)},
  a=>{a.intervals[0].metrics.pop()},
  a=>{a.intervals[1].environment='UNKNOWN'},
  a=>{a.intervals[0].collectionEvidenceRef='https://untrusted.example'},
  a=>{a.intervals=[...a.intervals,...Array(290).fill(a.intervals[0])]},
 ];
 for(const f of cases) {
  const a=args();f(a);
  assert.throws(()=>reviewScale(a),/P24_SCALE_REFUSED|P24_BASELINE_REFUSED/);
 }
});
test('missing accepted G20 or G22 cannot be laundered by an isolated G23 gate',()=>{
 for(const g of ['G20','G22']){
  const a=args();a.ledger.current.passed_phase_gates=
   a.ledger.current.passed_phase_gates.filter(x=>x.gate!==g);
  assert.equal(reviewScale(a).status,'BLOCKED_G23_NOT_ACCEPTED');
 }
});
test('P21 intentionally deferred: a genuine G23 lineage still allows nonauthorizing review',()=>{
 const a=args();
 assert.equal(a.ledger.current.passed_phase_gates.some(x=>x.gate==='G21'),false);
 assert.equal(reviewScale(a).reviewCandidates.length,1);
});
