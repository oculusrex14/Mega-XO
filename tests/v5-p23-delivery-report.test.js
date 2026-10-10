'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PLATFORM,STAGES,createDeliveryReport}=require('../scripts/v5/p23/delivery-report');
const SHA='a'.repeat(40),ref=x=>'artifact://v5/p23/'+x+'/completed-20261009';
function ledger(g22=false){
  const ids=g22?[...Array(21).keys(),22]:[...Array(8).keys()];
  return {schema_version:1,current:{
    integration_branch:'V5-platform',
    passed_phase_gates:ids.map(i=>({
      gate:'G'+String(i).padStart(2,'0'),phase:'P'+String(i).padStart(2,'0'),
      evidence_refs:['docs/v5/evidence/phase-gate.json'],
    })),
  }};
}
function sample(){
  return {
    format:'mega-v5-p23-delivery-status/v1',sourceSha:SHA,
    scopeExclusions:['P21_NEW_SITE_DEFERRED','NO_V4_SQLITE_REACTIVATION'],
    residualIssues:[{id:'actions-runner-outage',classification:'OWNER_ACTION',
      description:'Investigate zero-step GitHub Actions runner scheduling',evidenceRef:null}],
    products:PLATFORM.map(platform=>({
      platform,states:Object.fromEntries(STAGES.map(key=>[key,false])),
      evidenceRefs:Object.fromEntries(STAGES.map(key=>[key,null])),
    })),
  };
}
function set(p,key){
  p.states[key]=true;p.evidenceRefs[key]=ref(key.replace(/[A-Z]/g,x=>'-'+x.toLowerCase()));
}
function denies(edit,g22=false){const x=sample();edit(x);
  assert.throws(()=>createDeliveryReport(ledger(g22),SHA,x),/P23_DELIVERY_REFUSED/);}
test('honest delivery report shows all tracks separately and never grants release authority',()=>{
  const x=sample();
  set(x.products[1],'codeComplete');set(x.products[1],'ciVerified');
  set(x.products[1],'signedArtifact');set(x.products[1],'storeSubmitted');
  const r=createDeliveryReport(ledger(),SHA,x);
  const android=r.platforms.find(x=>x.platform==='android');
  assert.equal(android.codeComplete,true);
  assert.equal(android.storeSubmitted,true);
  assert.equal(android.storeApproved,false);
  assert.equal(android.deviceVerified,false);
  assert.equal(android.productionEnabled,false);
  assert.equal(r.canClaimStoreApprovedFromSubmission,false);
  assert.equal(r.reportPublished,false);
  assert.equal(r.g23Accepted,false);
});
test('code ready alone never implies signed binary, CI green or launched app',()=>{
  const x=sample();set(x.products[2],'codeComplete');
  const r=createDeliveryReport(ledger(),SHA,x);
  assert.equal(r.platforms[2].codeComplete,true);
  assert.equal(r.platforms[2].ciVerified,false);
  assert.equal(r.platforms[2].productionEnabled,false);
});
test('production enablement requires owner G22 and exact native approval evidence',()=>{
  denies(x=>{const p=x.products[1];for(const s of STAGES)set(p,s);});
  denies(x=>{const p=x.products[2];set(p,'productionEnabled');},true);
  denies(x=>{const p=x.products[2];['codeComplete','ciVerified','signedArtifact','storeSubmitted',
    'storeApproved','productionEnabled'].forEach(s=>set(p,s));},true);
  const x=sample(),p=x.products[1];
  STAGES.forEach(s=>set(p,s));
  assert.equal(createDeliveryReport(ledger(true),SHA,x).platforms[1].productionEnabled,true);
  assert.equal(createDeliveryReport(ledger(true),SHA,x).retirementAuthorized,false);
});
test('every milestone must carry its own evidence and cannot be forged by future state',()=>{
  denies(x=>{x.products[0].states.ciVerified=true;});
  denies(x=>{x.products[0].evidenceRefs.codeComplete=ref('forged');});
  denies(x=>{set(x.products[0],'storeApproved')},true);
  denies(x=>{x.products[0].states.backendPaid=true;});
  denies(x=>{set(x.products[1],'storeSubmitted');},true);
});
test('all supported products, exclusions and external blockers stay visible',()=>{
  denies(x=>x.products.pop());
  denies(x=>x.products[1].platform=x.products[0].platform);
  denies(x=>x.scopeExclusions=['NO_V4_SQLITE_REACTIVATION']);
  denies(x=>x.sourceSha='b'.repeat(40));
  denies(x=>x.residualIssues[0].classification='RESOLVED_CLAIMED');
  denies(x=>x.residualIssues.push({...x.residualIssues[0]}));
  denies(x=>x.residualIssues.push({id:'new',classification:'OPEN',description:'token=private-key',evidenceRef:null}));
});
