'use strict';

/*
 * P23-03. Usage-driven legacy compatibility sunset advisory.
 * "Zero requests" without complete telemetry, supported-version analysis,
 * provider deregistration and old-origin actor/cookie continuity is NOT proof
 * that an endpoint can be deleted. A candidate is not an authorization.
 */
const { SURFACES, CALLBACKS, verifyCompatibility } = require('../p22/compatibility-map');
const SHA=/^[0-9a-f]{40}$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;
const REF=/^artifact:\/\/v5\/p23\/[a-z0-9][a-z0-9._/-]{7,119}$/;
const ALWAYS_KEEP = new Set([
  'legacy-static-browser','legacy-session-cookie','native-android','native-ios',
]);
function fail(why) { throw Error('P23_COMPAT_REFUSED:' + why); }
function exact(v, keys, kind) {
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) fail('FIELDS_'+kind);
}
function date(v) {
  if (typeof v!=='string' || !UTC.test(v) || !Number.isFinite(Date.parse(v)) ||
      new Date(v).toISOString().replace(/\.000Z$/,'Z') !== v.replace(/\.000Z$/,'Z')) fail('UTC');
  return Date.parse(v);
}
function reference(v){return typeof v==='string'&&REF.test(v)&&!v.includes('..');}

function evaluateSunset(declaration, expectedSha) {
  exact(declaration,[
    'format','sourceSha','observedAtUtc','quietPeriodDays',
    'postwriteCompatibility','surfaces',
  ],'DECLARATION');
  if (!SHA.test(expectedSha) || declaration.sourceSha!==expectedSha ||
      declaration.format!=='mega-v5-p23-compat-sunset/v1' ||
      !Number.isSafeInteger(declaration.quietPeriodDays) ||
      declaration.quietPeriodDays < 90 || declaration.quietPeriodDays > 3650) fail('CONSERVATIVE_WINDOW');
  const now=date(declaration.observedAtUtc);
  const v5=verifyCompatibility(declaration.postwriteCompatibility,expectedSha);
  if (v5.mode!=='POSTWRITE_COMPAT') fail('ONE_POSTGRES_AUTHORITY_REQUIRED');
  if (!Array.isArray(declaration.surfaces) || declaration.surfaces.length!==SURFACES.length) {
    fail('COMPATIBILITY_SURFACES_INCOMPLETE');
  }
  const seen=new Set(), reviews=[];
  for (const s of declaration.surfaces) {
    exact(s,[
      'surface','supportedClientStillUses','providerStillConfigured',
      'completeTelemetryDays','observedRequests','lastSeenUtc',
      'usageEvidenceRef','versionPolicyEvidenceRef','providerDeregistrationRef',
      'operatorApprovedSunset','approvalEvidenceRef','reversibleFacadePreserved',
    ],'SURFACE');
    if (!SURFACES.includes(s.surface)||seen.has(s.surface)) fail('DUPLICATE_OR_UNKNOWN_SURFACE');
    seen.add(s.surface);
    if (typeof s.supportedClientStillUses!=='boolean' ||
        typeof s.providerStillConfigured!=='boolean' ||
        !Number.isSafeInteger(s.completeTelemetryDays) ||
        s.completeTelemetryDays<0 || s.completeTelemetryDays>3650 ||
        (s.observedRequests!==null &&
          (!Number.isSafeInteger(s.observedRequests) || s.observedRequests<0)) ||
        typeof s.operatorApprovedSunset!=='boolean' ||
        typeof s.reversibleFacadePreserved!=='boolean' ||
        (s.usageEvidenceRef!==null && !reference(s.usageEvidenceRef)) ||
        (s.versionPolicyEvidenceRef!==null && !reference(s.versionPolicyEvidenceRef)) ||
        (s.providerDeregistrationRef!==null && !reference(s.providerDeregistrationRef)) ||
        (s.approvalEvidenceRef!==null && !reference(s.approvalEvidenceRef))) fail('UNTRUSTED_USAGE_OBSERVATION');
    const last = s.lastSeenUtc===null ? null : date(s.lastSeenUtc);
    if (last!==null && last>now) fail('FUTURE_USAGE');
    if (s.operatorApprovedSunset && !reference(s.approvalEvidenceRef)) fail('MISSING_OPERATOR_APPROVAL_PROOF');
    if (CALLBACKS.has(s.surface) && !s.providerStillConfigured &&
        s.operatorApprovedSunset && !reference(s.providerDeregistrationRef)) {
      fail('CALLBACK_PROVIDER_DEREGISTRATION_REQUIRED');
    }
    const quiet = s.observedRequests===0 && s.completeTelemetryDays>=declaration.quietPeriodDays &&
      (last===null || now-last>=declaration.quietPeriodDays*86400000);
    const candidate = !ALWAYS_KEEP.has(s.surface) && !s.supportedClientStillUses &&
      (!CALLBACKS.has(s.surface) || !s.providerStillConfigured) &&
      quiet && reference(s.usageEvidenceRef) && reference(s.versionPolicyEvidenceRef) &&
      s.operatorApprovedSunset && reference(s.approvalEvidenceRef) &&
      s.reversibleFacadePreserved &&
      (!CALLBACKS.has(s.surface) || reference(s.providerDeregistrationRef));
    reviews.push(Object.freeze({
      surface:s.surface,
      decision:candidate?'REVIEW_CANDIDATE_KEEP_RUNNING':'KEEP_COMPATIBILITY',
      evidenceSufficientForAutomaticRemoval:false,
    }));
  }
  return Object.freeze({
    format:'mega-v5-p23-compat-sunset-review/v1',sourceSha:expectedSha,
    retainedBrowserAndNativePlatforms:SURFACES.filter(x=>ALWAYS_KEEP.has(x)),
    surfacesReviewed:reviews.length,
    candidatesForIndependentReview:reviews.filter(x=>x.decision==='REVIEW_CANDIDATE_KEEP_RUNNING').map(x=>x.surface),
    decisions:reviews, ownerApprovedLiveRouteRemoval:false,
    callbackDeletionAuthorized:false, v4SQLiteWriterRestorationAllowed:false,
    telemetryIndependentlyVerified:false, g23Accepted:false,
  });
}
module.exports={ALWAYS_KEEP,evaluateSunset};
