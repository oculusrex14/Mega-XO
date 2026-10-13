'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),R=require('../packages/learning/release-gate.js'),C=require('../packages/learning/capture.js');
test('release gate cannot infer zero backlog or a sealed canary from missing/null/coerced counts',()=>{
 const sourceCommit='a'.repeat(40),now=Date.now(),configuration={enabled:true,sourceCommit,rulesHash:C.RULES_HASH,environment:'staging',policyVersion:'test',privacyEpoch:0};
 const receipt={sourceCommit,rulesHash:C.RULES_HASH,environment:'staging',policyVersion:'test',privacyEpoch:0,checkedAt:new Date(now).toISOString(),evidence:Object.fromEntries(R.REQUIRED.map(k=>[k,{status:'PASS',artifact:'synthetic-only'}]))};
 const metrics={pending:0,quarantined:0,expiredUnpurged:0,sealed:1};
 assert.equal(R.assess({sourceCommit,configuration,receipt,metrics,now}).result,'RECEIPTS_READY_FOR_MAIN_REVIEW');
 for(const key of Object.keys(metrics))for(const value of [undefined,null,'0',NaN])assert.equal(R.assess({sourceCommit,configuration,receipt,metrics:{...metrics,[key]:value},now}).result,'BLOCKED');
});
