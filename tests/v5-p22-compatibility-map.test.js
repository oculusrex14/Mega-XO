'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {SURFACES,CALLBACKS,verifyCompatibility}=require('../scripts/v5/p22/compatibility-map');
const SHA='a'.repeat(40);
function plan(mode='POSTWRITE_COMPAT') {
  const pre=mode==='PREWRITE_FROZEN';
  return {format:'mega-v5-p22-compatibility-map/v1',sourceSha:SHA,mode,
    oldOrigin:'https://play.antimatterinnovations.com',apiOrigin:'https://api.megaxo.online',
    newWebsite:'P21_DEFERRED',cookieStrategy:'OLD_ORIGIN_FACADE',
    v4IndependentWriter:false,singlePgAuthority:!pre,
    entries:SURFACES.map(surface=>({
      surface,handler:pre?'MAINTENANCE_OR_STATIC':'FACADE_TO_V5',
      durableAuthority:pre?'NONE':'SINGLE_PG_V5',clientActorPreserved:true,
      callbackAckPolicy:CALLBACKS.has(surface)
        ? (pre?'RETRYABLE_NON_2XX':'ACK_ONLY_AFTER_PG_IDEMPOTENCY_COMMIT')
        :'NOT_APPLICABLE',
    }))};
}
function denied(edit,mode) {
  const p=plan(mode);edit(p);
  assert.throws(()=>verifyCompatibility(p,SHA),/P22_COMPAT_REFUSED/);
}
test('both prewrite and exclusive modes are complete but never authorize a route change',()=>{
  for(const mode of ['PREWRITE_FROZEN','POSTWRITE_COMPAT']){
    const result=verifyCompatibility(plan(mode),SHA);
    assert.equal(result.requiredSurfaces,SURFACES.length);
    assert.equal(result.oldOriginCookieCannotCrossToApiOrigin,true);
    assert.equal(result.liveRoutingAuthorization,false);
    assert.equal(result.newWebsiteRemainsDeferred,true);
    assert.equal(result.g22Accepted,false);
  }
});
test('prewrite callback must retry without false success while old SQLite is fenced',()=>{
  denied(p=>{p.entries.find(x=>x.surface==='legacy-store-callback').callbackAckPolicy='ACK_ONLY_AFTER_PG_IDEMPOTENCY_COMMIT';},'PREWRITE_FROZEN');
  denied(p=>{p.entries.find(x=>x.surface==='legacy-email-callback').durableAuthority='SINGLE_PG_V5';},'PREWRITE_FROZEN');
  denied(p=>{p.v4IndependentWriter=true;},'PREWRITE_FROZEN');
});
test('postwrite browser/native callback must never restore V4 or duplicate a grant',()=>{
  denied(p=>{p.entries.find(x=>x.surface==='legacy-match-commands').durableAuthority='SQLITE_V4';});
  denied(p=>{p.entries.find(x=>x.surface==='legacy-ad-callback').callbackAckPolicy='ACK_IMMEDIATELY';});
  denied(p=>{p.entries.find(x=>x.surface==='native-ios').clientActorPreserved=false;});
  denied(p=>{p.singlePgAuthority=false;});
});
test('new website deferral and origin-bound browser cookies cannot be bypassed',()=>{
  denied(p=>{p.newWebsite='MEGAXO_ONLINE_LAUNCHED';});
  denied(p=>{p.cookieStrategy='COPY_COOKIE_TO_API_DOMAIN';});
  denied(p=>{p.apiOrigin='https://api.other-domain.example';});
  denied(p=>{p.oldOrigin='https://megaxo.online';});
});
test('missing compatibility route and unapproved metadata never imply readiness',()=>{
  denied(p=>{p.entries.pop();});
  denied(p=>{p.entries[1].surface=p.entries[0].surface;});
  denied(p=>{p.entries[0].surface='unreviewed-legacy-endpoint';});
  denied(p=>{p.prodDeployed=true;});
  denied(p=>{p.sourceSha='b'.repeat(40);});
  const alternate=plan();
  alternate.cookieStrategy='BOUNDED_ONE_TIME_EXCHANGE';
  assert.equal(verifyCompatibility(alternate,SHA).oldOriginSessionContinuityProven,false);
});
