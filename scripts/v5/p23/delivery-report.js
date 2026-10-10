'use strict';

/*
 * P23-04: generate truthful delivery-state summaries from sanitized receipts.
 * Code complete != built != tested on device != store submitted != approved
 * != production enabled. This is a REPORT, never a deployment control plane.
 */
const { hasAcceptedGate } = require('./retirement-readiness');
const SHA=/^[0-9a-f]{40}$/, REF=/^artifact:\/\/v5\/p23\/[a-z0-9][a-z0-9._/-]{7,119}$/;
const PLATFORM=Object.freeze(['retained-browser','android','ios','v5-backend']);
const STAGES=Object.freeze([
  'codeComplete','ciVerified','signedArtifact','deviceVerified',
  'storeSubmitted','storeApproved','productionEnabled',
]);
function fail(reason) { throw Error('P23_DELIVERY_REFUSED:'+reason); }
function exact(o,fields,label){
  if(!o||typeof o!=='object'||Array.isArray(o) ||
    Object.keys(o).sort().join('|')!==[...fields].sort().join('|')) fail('FIELDS_'+label);
}
function evidence(value){return typeof value==='string'&&REF.test(value)&&!value.includes('..');}

function createDeliveryReport(ledger,expectedSha,packet){
  if(!SHA.test(expectedSha))fail('EXACT_SOURCE_SHA');
  const g22=hasAcceptedGate(ledger,'G22'),g23=hasAcceptedGate(ledger,'G23');
  exact(packet,['format','sourceSha','products','residualIssues','scopeExclusions'],'PACKET');
  if(packet.format!=='mega-v5-p23-delivery-status/v1'||packet.sourceSha!==expectedSha ||
    !Array.isArray(packet.products)||packet.products.length!==PLATFORM.length ||
    !Array.isArray(packet.scopeExclusions)||packet.scopeExclusions.length!==2 ||
    !packet.scopeExclusions.includes('P21_NEW_SITE_DEFERRED') ||
    !packet.scopeExclusions.includes('NO_V4_SQLITE_REACTIVATION'))fail('PRODUCT_SCOPE');
  const results=[],seen=new Set();
  for(const p of packet.products){
    exact(p,['platform','states','evidenceRefs'],'PRODUCT');
    if(!PLATFORM.includes(p.platform)||seen.has(p.platform))fail('DUPLICATE_PLATFORM');
    seen.add(p.platform);
    exact(p.states,STAGES,'STAGES');
    exact(p.evidenceRefs,STAGES,'MILESTONES');
    for(const name of STAGES){
      if(typeof p.states[name]!=='boolean' ||
         (p.states[name] && !evidence(p.evidenceRefs[name])) ||
         (!p.states[name] && p.evidenceRefs[name]!==null))fail('MILESTONE_PROOF_MISMATCH');
    }
    const a=p.states,app=p.platform==='android'||p.platform==='ios';
    if((a.ciVerified&&!a.codeComplete) ||
      (a.signedArtifact&&!a.ciVerified) ||
      (a.deviceVerified&&!a.signedArtifact) ||
      (a.storeSubmitted&&(!app||!a.signedArtifact)) ||
      (a.storeApproved&&(!app||!a.storeSubmitted)) ||
      (a.productionEnabled && (
        !g22 || !a.ciVerified ||
        (app && (!a.deviceVerified || !a.storeApproved)) ||
        (!app && !a.codeComplete)
      )) ||
      (!app && (a.storeSubmitted||a.storeApproved)))fail('FALSE_MILESTONE_ORDER');
    results.push(Object.freeze({
      platform:p.platform, ...a, proofReferencesCount:STAGES.filter(x=>a[x]).length,
      productionObservedIndependently:false,
    }));
  }
  if(!Array.isArray(packet.residualIssues)||packet.residualIssues.length>80)fail('ISSUE_INVENTORY');
  const issues=new Set();
  for(const item of packet.residualIssues){
    exact(item,['id','classification','description','evidenceRef'],'ISSUE');
    if(typeof item.id!=='string'||!/^[a-z][a-z0-9_-]{4,80}$/.test(item.id)||
      issues.has(item.id)||
      !['OPEN','OWNER_ACTION','RESOLVED_CLAIMED'].includes(item.classification)||
      typeof item.description!=='string'||!/^[-\w ,./:()]{12,160}$/.test(item.description)||
      (item.evidenceRef!==null&&!evidence(item.evidenceRef))||
      (item.classification==='RESOLVED_CLAIMED'&&!evidence(item.evidenceRef)))fail('ISSUE_INVALID');
    issues.add(item.id);
  }
  return Object.freeze({
    format:'mega-v5-p23-delivery-review/v1',sourceSha:expectedSha,
    ownerG22Accepted:g22,ownerG23Accepted:g23,
    platforms:results,openOrExternalItems:packet.residualIssues.filter(x=>x.classification!=='RESOLVED_CLAIMED').length,
    deferredWebsite:true,actualProviderStatusIndependentlyVerified:false,
    canClaimStoreApprovedFromSubmission:false,
    canClaimProductionEnabledFromCodeComplete:false,
    v4ReactivationPermitted:false,reportPublished:false,retirementAuthorized:false,g23Accepted:false,
  });
}
module.exports={PLATFORM,STAGES,createDeliveryReport};
