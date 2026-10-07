'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classify,validatePolicy,assess}=require('../server/competition-compliance');
const D=require('../src/domain');
const T=require('../src/tournament');

const NOW=Date.parse('2026-10-07T08:00:00Z');
const basePolicy={
 enabled:true,version:'competition-review-2026-10',approvalId:'legal-board-2026-10',
 effectiveAt:'2026-10-01T00:00:00Z',expiresAt:'2026-12-31T23:59:59Z',
 allowPooledStake:false,allowCashOut:false,allowRealWorldPrize:false,prizeFunding:'organizer',
 jurisdictions:[{country:'GB',platforms:['web','ios','android'],purchasedEntryPlatforms:['web','ios','android'],appleReviewId:'apple-review-2026-10',googleReviewId:'google-review-2026-10',minAge:18,legalReviewId:'gb-review-2026-10',maxEntryFee:50,dailyEntryCap:100,dailyLossCap:100}]
};
const age={verified:true,trusted:true,age:21,verifiedAt:'2026-09-01T00:00:00Z'};
const location={trusted:true,country:'GB',subdivision:'',proxyRisk:false};
const spend={entryToday:0,lossToday:0,selfExcluded:false,accountHold:false,coolingOffUntil:null};

test('current direct Crown challenge is classified as pooled stake and denied',()=>{
 const q=D.quote({mode:'direct',kind:'friend',from:'gold',to:'gold',amount:20});
 assert.equal(classify(q),'pooled_stake');
 assert.deepEqual(assess({policy:basePolicy,entry:q,platform:'web',location,age,spend,now:NOW}),{allowed:false,code:'POOLED_STAKE_PROHIBITED'});
});

test('current public tournament tables are pooled stakes and denied',()=>{
 for(const table of Object.keys(T.TABLES)){
  const q=T.prize(table);assert.equal(classify(q),'pooled_stake');
  assert.equal(assess({policy:basePolicy,entry:q,platform:'web',location,age,spend,now:NOW}).code,'POOLED_STAKE_PROHIBITED');
 }
});

test('free competition stays available without paid policy',()=>{
 assert.deepEqual(assess({entry:{model:'free'},platform:'web'}),{allowed:true,code:'FREE_COMPETITION'});
});

test('approved registration-fee model needs trusted geo age and spend context',()=>{
 const entry={model:'registration_fee',entry:10,purchasedCurrency:false,cashOut:false,prizeRealWorldValue:false};
 const ok=assess({policy:basePolicy,entry,platform:'web',location,age,spend,now:NOW});
 assert.equal(ok.allowed,true);assert.equal(ok.code,'APPROVED_REGISTRATION_FEE');
 assert.equal(assess({policy:basePolicy,entry,platform:'web',location:{country:'GB',trusted:false},age,spend,now:NOW}).code,'TRUSTED_COMPETITION_LOCATION_REQUIRED');
 assert.equal(assess({policy:basePolicy,entry,platform:'web',location,age:{verified:false,age:21},spend,now:NOW}).code,'COMPETITION_AGE_NOT_VERIFIED');
 assert.equal(assess({policy:basePolicy,entry,platform:'web',location,age,spend:{entryToday:95,lossToday:0,selfExcluded:false,accountHold:false,coolingOffUntil:null},now:NOW}).code,'COMPETITION_DAILY_ENTRY_LIMIT');
});

test('purchased closed-loop virtual currency is allowed only on explicitly reviewed platforms',()=>{
 const entry={model:'registration_fee',entry:10,purchasedCurrency:true,cashOut:false,prizeRealWorldValue:false};
 assert.equal(assess({policy:basePolicy,entry,platform:'web',location,age,spend,now:NOW}).code,'APPROVED_REGISTRATION_FEE');
 assert.equal(assess({policy:basePolicy,entry,platform:'ios',location,age,payment:{source:'apple_iap',purchasedCurrency:true},spend,now:NOW}).code,'APPROVED_REGISTRATION_FEE');
 const webOnly={...basePolicy,jurisdictions:[{...basePolicy.jurisdictions[0],purchasedEntryPlatforms:['web']}]};
 assert.equal(assess({policy:webOnly,entry,platform:'ios',location,age,payment:{source:'apple_iap',purchasedCurrency:true},spend,now:NOW}).code,'PURCHASED_VIRTUAL_ENTRY_NOT_APPROVED');
 assert.equal(assess({policy:basePolicy,entry:{...entry,prizeRealWorldValue:true},platform:'android',location,age,spend,now:NOW}).code,'REAL_WORLD_PRIZE_REQUIRES_SEPARATE_APPROVAL');
});

test('India can only appear in a candidate policy with explicit recognized-esport approvals',()=>{
 const candidate={...basePolicy,jurisdictions:[{country:'IN',platforms:['web'],purchasedEntryPlatforms:[],minAge:18,legalReviewId:'india-review-2026-10',classification:'recognized_esport',maxEntryFee:50,dailyEntryCap:100,dailyLossCap:100}]};
 assert.throws(()=>validatePolicy(candidate,{now:NOW}),/INDIA_REGULATORY_APPROVAL_REQUIRED/);
 const approved={...candidate,jurisdictions:[{...candidate.jurisdictions[0],ogaiRegistrationId:'ogai-registration-123',sportsRecognitionId:'sports-recognition-123'}]};
 assert.equal(validatePolicy(approved,{now:NOW}).jurisdictions[0].country,'IN');
});

test('India cannot approve purchased virtual entry even with esport registrations',()=>{
 const jurisdiction={country:'IN',platforms:['web'],purchasedEntryPlatforms:['web'],minAge:18,legalReviewId:'india-review-2026-10',classification:'recognized_esport',ogaiRegistrationId:'ogai-registration-123',sportsRecognitionId:'sports-recognition-123',maxEntryFee:50,dailyEntryCap:100,dailyLossCap:100};
 assert.throws(()=>validatePolicy({...basePolicy,jurisdictions:[jurisdiction]},{now:NOW}),/INDIA_PURCHASED_VIRTUAL_ENTRY_PROHIBITED/);
});

test('policy cannot approve pooled stakes, cashout, real-world prizes or user-funded prizes',()=>{
 for(const patch of [
  {allowPooledStake:true},
  {allowCashOut:true},
  {allowRealWorldPrize:true},
  {prizeFunding:'player_pool'}
 ]){
  assert.throws(()=>validatePolicy({...basePolicy,...patch},{now:NOW}));
 }
});
