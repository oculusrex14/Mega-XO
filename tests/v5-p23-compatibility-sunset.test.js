'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {SURFACES,CALLBACKS}=require('../scripts/v5/p22/compatibility-map');
const {evaluateSunset,ALWAYS_KEEP}=require('../scripts/v5/p23/compatibility-sunset');
const SHA='a'.repeat(40),NOW='2026-10-09T10:00:00Z';
const ref=x=>'artifact://v5/p23/'+x+'/verified-observation-20261009';
function sample(){
  return {
    format:'mega-v5-p23-compat-sunset/v1',sourceSha:SHA,observedAtUtc:NOW,
    quietPeriodDays:90,
    postwriteCompatibility:{
      format:'mega-v5-p22-compatibility-map/v1',sourceSha:SHA,
      mode:'POSTWRITE_COMPAT',oldOrigin:'https://play.antimatterinnovations.com',
      apiOrigin:'https://api.megaxo.online',newWebsite:'P21_DEFERRED',
      cookieStrategy:'OLD_ORIGIN_FACADE',v4IndependentWriter:false,singlePgAuthority:true,
      entries:SURFACES.map(surface=>({
        surface,handler:'FACADE_TO_V5',durableAuthority:'SINGLE_PG_V5',
        clientActorPreserved:true,
        callbackAckPolicy:CALLBACKS.has(surface)?
          'ACK_ONLY_AFTER_PG_IDEMPOTENCY_COMMIT':'NOT_APPLICABLE',
      })),
    },
    surfaces:SURFACES.map(surface=>({
      surface,supportedClientStillUses:true,
      providerStillConfigured:CALLBACKS.has(surface),
      completeTelemetryDays:0,observedRequests:null,lastSeenUtc:null,
      usageEvidenceRef:null,versionPolicyEvidenceRef:null,
      providerDeregistrationRef:null,operatorApprovedSunset:false,
      approvalEvidenceRef:null,reversibleFacadePreserved:true,
    })),
  };
}
function candidate(surf='legacy-store-callback') {
  const x=sample(),row=x.surfaces.find(y=>y.surface===surf);
  Object.assign(row,{
    supportedClientStillUses:false,providerStillConfigured:false,
    completeTelemetryDays:120,observedRequests:0,
    lastSeenUtc:'2026-05-01T10:00:00Z',
    usageEvidenceRef:ref('telemetry'),versionPolicyEvidenceRef:ref('supported-versions'),
    providerDeregistrationRef:CALLBACKS.has(surf)?ref('provider-deregister'):null,
    operatorApprovedSunset:true,approvalEvidenceRef:ref('owner-approval'),
    reversibleFacadePreserved:true,
  });
  return x;
}
function denies(edit){
  const x=sample();edit(x);
  assert.throws(()=>evaluateSunset(x,SHA),/P23_COMPAT_REFUSED|P22_COMPAT_REFUSED/);
}
test('unknown traffic, current clients and configured callbacks always remain supported',()=>{
  const x=evaluateSunset(sample(),SHA);
  assert.equal(x.surfacesReviewed,SURFACES.length);
  assert.deepEqual(x.candidatesForIndependentReview,[]);
  assert.equal(x.ownerApprovedLiveRouteRemoval,false);
  assert.equal(x.g23Accepted,false);
});
test('a deregistered, unsupported, quiet old callback is only a review candidate',()=>{
  const x=evaluateSunset(candidate(),SHA);
  assert.deepEqual(x.candidatesForIndependentReview,['legacy-store-callback']);
  assert.equal(x.decisions.find(y=>y.surface==='legacy-store-callback').decision,'REVIEW_CANDIDATE_KEEP_RUNNING');
  assert.equal(x.callbackDeletionAuthorized,false);
  assert.equal(x.telemetryIndependentlyVerified,false);
});
test('retained browser origin, session cookie and supported native platforms never sunset',()=>{
  for(const surf of ALWAYS_KEEP){
    const x=evaluateSunset(candidate(surf),SHA);
    assert.equal(x.candidatesForIndependentReview.includes(surf),false);
  }
});
test('missing observed usage, insufficient window or version policy cannot imply zero consumers',()=>{
  for(const change of [
    r=>{r.observedRequests=null},
    r=>{r.completeTelemetryDays=30},
    r=>{r.usageEvidenceRef=null},
    r=>{r.versionPolicyEvidenceRef=null},
    r=>{r.operatorApprovedSunset=false;r.approvalEvidenceRef=null},
    r=>{r.reversibleFacadePreserved=false},
    r=>{r.lastSeenUtc='2026-10-01T10:00:00Z'},
    r=>{r.providerStillConfigured=true},
  ]){
    const x=candidate();change(x.surfaces.find(y=>y.surface==='legacy-store-callback'));
    assert.deepEqual(evaluateSunset(x,SHA).candidatesForIndependentReview,[]);
  }
});
test('provider deregistration evidence is mandatory before approved callback sunset',()=>{
  denies(x=>{const r=x.surfaces.find(y=>y.surface==='legacy-email-callback');
    r.providerStillConfigured=false;r.operatorApprovedSunset=true;r.approvalEvidenceRef=ref('approval');});
  const x=candidate();x.surfaces.find(y=>y.surface==='legacy-store-callback').providerDeregistrationRef=null;
  assert.throws(()=>evaluateSunset(x,SHA),/P23_COMPAT_REFUSED/);
});
test('old browser must still forward into ONE V5 PostgreSQL actor/session authority',()=>{
  denies(x=>{x.postwriteCompatibility.oldOrigin='https://megaxo.online'});
  denies(x=>{x.postwriteCompatibility.singlePgAuthority=false});
  denies(x=>{x.postwriteCompatibility.entries[0].durableAuthority='SQLITE_V4'});
  denies(x=>{x.postwriteCompatibility.entries[1].clientActorPreserved=false});
  denies(x=>{x.postwriteCompatibility.cookieStrategy='COPY_OLD_COOKIE_TO_API_HOST'});
  denies(x=>{x.sourceSha='b'.repeat(40)});
});
test('reject forged telemetry, duplicate surfaces, dates and hidden deletion permissions',()=>{
  denies(x=>x.surfaces.pop());
  denies(x=>x.surfaces[1].surface=x.surfaces[0].surface);
  denies(x=>x.quietPeriodDays=7);
  denies(x=>x.surfaces[1].lastSeenUtc='2027-01-01T00:00:00Z');
  denies(x=>x.surfaces[1].usageEvidenceRef='artifact://v5/p23/../sensitive');
  denies(x=>x.allowDelete=true);
});
