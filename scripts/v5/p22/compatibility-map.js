'use strict';

/*
 * P22-05 browser + provider compatibility checklist. This is NOT a routing
 * config generator: a passed declaration cannot change DNS, cookie scope,
 * public Caddy ingress, Vercel, or publisher endpoints.
 */
const SHA40 = /^[a-f0-9]{40}$/;
const SURFACES = Object.freeze([
  'legacy-static-browser','legacy-session-cookie','legacy-account-and-save',
  'legacy-match-commands','legacy-tournament-and-wallet',
  'legacy-email-callback','legacy-store-callback','legacy-ad-callback',
  'native-android','native-ios',
]);
const CALLBACKS = new Set(['legacy-email-callback','legacy-store-callback','legacy-ad-callback']);
function fail(code){throw Error('P22_COMPAT_REFUSED:' + code);}
function exact(v,fields) {
  if(!v||typeof v!=='object'||Array.isArray(v) ||
    Object.keys(v).sort().join('|')!==[...fields].sort().join('|'))fail('FIELDS');
}
function verifyCompatibility(plan,sourceSha) {
  exact(plan,['format','sourceSha','mode','oldOrigin','apiOrigin','newWebsite','cookieStrategy',
    'v4IndependentWriter','singlePgAuthority','entries']);
  if(!SHA40.test(sourceSha)||plan.sourceSha!==sourceSha ||
    plan.format!=='mega-v5-p22-compatibility-map/v1' ||
    !['PREWRITE_FROZEN','POSTWRITE_COMPAT'].includes(plan.mode) ||
    plan.oldOrigin!=='https://play.antimatterinnovations.com' ||
    plan.apiOrigin!=='https://api.megaxo.online' ||
    plan.newWebsite!=='P21_DEFERRED' ||
    plan.v4IndependentWriter!==false ||
    plan.singlePgAuthority!==(plan.mode==='POSTWRITE_COMPAT') ||
    !['OLD_ORIGIN_FACADE','BOUNDED_ONE_TIME_EXCHANGE'].includes(plan.cookieStrategy)) {
    fail('SCOPE_OR_CROSS_ORIGIN_AUTHORITY');
  }
  if(!Array.isArray(plan.entries)||plan.entries.length!==SURFACES.length)fail('SURFACE_COVERAGE');
  const seen=new Set();
  for(const entry of plan.entries){
    exact(entry,['surface','handler','durableAuthority','clientActorPreserved','callbackAckPolicy']);
    if(!SURFACES.includes(entry.surface)||seen.has(entry.surface))fail('DUPLICATE_OR_UNKNOWN_SURFACE');
    seen.add(entry.surface);
    if(entry.clientActorPreserved!==true)fail('ACTOR_IDENTITY_MUST_REMAIN_SHARED');
    const callback=CALLBACKS.has(entry.surface);
    if(plan.mode==='PREWRITE_FROZEN'){
      if(entry.handler!=='MAINTENANCE_OR_STATIC' ||
         entry.durableAuthority!=='NONE' ||
         entry.callbackAckPolicy!==(callback?'RETRYABLE_NON_2XX':'NOT_APPLICABLE')) {
        fail('PREWRITE_CANNOT_ACCEPT_MUTATION_OR_ACK');
      }
    }else{
      if(entry.handler!=='FACADE_TO_V5' ||
         entry.durableAuthority!=='SINGLE_PG_V5' ||
         entry.callbackAckPolicy!==(callback?'ACK_ONLY_AFTER_PG_IDEMPOTENCY_COMMIT':'NOT_APPLICABLE')) {
        fail('POSTWRITE_CANNOT_ROUTE_TO_SQLITE_OR_GRANT_TWICE');
      }
    }
  }
  return Object.freeze({
    format:'mega-v5-p22-compatibility-review/v1',
    sourceSha,
    mode:plan.mode,
    requiredSurfaces:seen.size,
    oldOriginCookieCannotCrossToApiOrigin:true,
    oldOriginSessionContinuityProven:false,
    providerNotificationDedupeProven:false,
    actualSupportedClientResultsVerified:false,
    liveRoutingAuthorization:false,
    newWebsiteRemainsDeferred:true,
    g22Accepted:false,
  });
}
module.exports={SURFACES,CALLBACKS,verifyCompatibility};
