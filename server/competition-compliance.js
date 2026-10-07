'use strict';

const PLATFORM=new Set(['web','ios','android']);
const ENTRY_MODEL=new Set(['free','registration_fee','pooled_stake']);
const ISO2=/^[A-Z]{2}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/;

function fail(code){throw Error(code);}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function date(value,code){const n=Date.parse(value);if(!Number.isFinite(n))fail(code);return n;}
function unique(values){return Array.isArray(values)&&new Set(values).size===values.length;}

function classify(entry={}){
 if(!object(entry))fail('INVALID_COMPETITION_ENTRY');
 if(entry.model&&ENTRY_MODEL.has(entry.model))return entry.model;
 const contribution=Array.isArray(entry.contributions)?entry.contributions.reduce((n,x)=>n+(Number.isFinite(x)?x:0),0):Number(entry.entry||0);
 const pool=Number(entry.pool||0),payout=Number(entry.payout||0),burn=Number(entry.burn||0);
 if(!contribution&&!pool&&!payout&&!burn)return 'free';
 if(pool>0&&(payout>0||burn>0))return 'pooled_stake';
 return 'registration_fee';
}

function validateJurisdiction(j){
 if(!object(j)||!ISO2.test(j.country||''))fail('INVALID_COMPETITION_JURISDICTION');
 if(!unique(j.platforms)||!j.platforms.length||j.platforms.some(x=>!PLATFORM.has(x)))fail('INVALID_COMPETITION_PLATFORMS');
 if(!Number.isSafeInteger(j.minAge)||j.minAge<18||j.minAge>30)fail('INVALID_COMPETITION_MIN_AGE');
 if(!ID.test(j.legalReviewId||''))fail('COMPETITION_LEGAL_REVIEW_REQUIRED');
 for(const key of ['maxEntryFee','dailyEntryCap','dailyLossCap'])if(!Number.isSafeInteger(j[key])||j[key]<0)fail('COMPETITION_SPEND_LIMITS_REQUIRED');
 if(j.maxEntryFee===0||j.dailyEntryCap===0||j.dailyLossCap===0)fail('COMPETITION_SPEND_LIMITS_REQUIRED');
 if(j.subdivisions!==undefined&&(!unique(j.subdivisions)||j.subdivisions.some(x=>typeof x!=='string'||!/^[A-Z0-9-]{1,12}$/.test(x))))fail('INVALID_COMPETITION_SUBDIVISIONS');
 if(j.country==='IN'){
  if(j.classification!=='recognized_esport')fail('INDIA_RECOGNIZED_ESPORT_REQUIRED');
  if(!ID.test(j.ogaiRegistrationId||'')||!ID.test(j.sportsRecognitionId||''))fail('INDIA_REGULATORY_APPROVAL_REQUIRED');
 }
 return {...j,platforms:[...j.platforms],subdivisions:j.subdivisions?[...j.subdivisions]:null};
}

function validatePolicy(policy,{now=Date.now()}={}){
 if(!object(policy))fail('COMPETITION_POLICY_REQUIRED');
 if(policy.enabled!==true)fail('COMPETITION_POLICY_DISABLED');
 if(!ID.test(policy.version||'')||!ID.test(policy.approvalId||''))fail('COMPETITION_POLICY_APPROVAL_REQUIRED');
 const effective=date(policy.effectiveAt,'INVALID_COMPETITION_EFFECTIVE_AT'),expires=date(policy.expiresAt,'INVALID_COMPETITION_EXPIRES_AT');
 if(expires<=effective||now<effective||now>=expires)fail('COMPETITION_POLICY_NOT_EFFECTIVE');
 if(policy.allowPurchasedCurrency!==false)fail('PURCHASED_COMPETITION_CURRENCY_PROHIBITED');
 if(policy.allowPooledStake!==false)fail('POOLED_STAKE_PROHIBITED');
 if(policy.allowCashOut!==false)fail('COMPETITION_CASHOUT_PROHIBITED');
 if(policy.allowRealWorldPrize!==false)fail('REAL_WORLD_PRIZE_REQUIRES_SEPARATE_APPROVAL');
 if(policy.prizeFunding!=='organizer')fail('ORGANIZER_FUNDED_PRIZE_REQUIRED');
 if(!Array.isArray(policy.jurisdictions)||!policy.jurisdictions.length)fail('COMPETITION_JURISDICTION_ALLOWLIST_REQUIRED');
 return {...policy,effective,expires,jurisdictions:policy.jurisdictions.map(validateJurisdiction)};
}

function locate(policy,location){
 if(!object(location)||location.trusted!==true||!ISO2.test(location.country||''))fail('TRUSTED_COMPETITION_LOCATION_REQUIRED');
 const subdivision=typeof location.subdivision==='string'?location.subdivision.toUpperCase():'';
 return policy.jurisdictions.find(j=>j.country===location.country&&(!j.subdivisions||!j.subdivisions.length||j.subdivisions.includes(subdivision)))||fail('COMPETITION_JURISDICTION_DENIED');
}

function assess({policy,entry,platform,location,age,payment={},spend={},now=Date.now()}={}){
 let p,j,model;
 try{model=classify(entry);if(model==='free')return {allowed:true,code:'FREE_COMPETITION'};p=validatePolicy(policy,{now});j=locate(p,location);}catch(error){return {allowed:false,code:error.message};}
 if(!PLATFORM.has(platform)||!j.platforms.includes(platform))return {allowed:false,code:'COMPETITION_PLATFORM_DENIED'};
 if(model==='pooled_stake')return {allowed:false,code:'POOLED_STAKE_PROHIBITED'};
 if(entry?.purchasedCurrency===true||payment?.purchasedCurrency===true)return {allowed:false,code:'PURCHASED_COMPETITION_CURRENCY_PROHIBITED'};
 if(entry?.cashOut===true)return {allowed:false,code:'COMPETITION_CASHOUT_PROHIBITED'};
 if(entry?.prizeRealWorldValue===true)return {allowed:false,code:'REAL_WORLD_PRIZE_REQUIRES_SEPARATE_APPROVAL'};
 if(!object(age)||age.verified!==true||age.trusted!==true||!Number.isSafeInteger(age.age)||age.age<j.minAge)return {allowed:false,code:'COMPETITION_AGE_NOT_VERIFIED'};
 if(age.verifiedAt&&now-date(age.verifiedAt,'INVALID_AGE_VERIFICATION_AT')>365*86400000)return {allowed:false,code:'COMPETITION_AGE_VERIFICATION_STALE'};
 if(platform==='ios'&&payment.source==='apple_iap')return {allowed:false,code:'APPLE_IAP_COMPETITION_CURRENCY_PROHIBITED'};
 if(platform==='android'&&payment.source==='play_billing'&&entry?.prizeRealWorldValue===true)return {allowed:false,code:'GOOGLE_PLAY_BILLING_REAL_MONEY_PROHIBITED'};
 if(location.proxyRisk===true)return {allowed:false,code:'COMPETITION_LOCATION_RISK'};
 const fee=Number(entry?.entry||0);if(!Number.isSafeInteger(fee)||fee<0)return {allowed:false,code:'INVALID_COMPETITION_ENTRY_FEE'};
 if(!object(spend)||!Number.isSafeInteger(spend.entryToday)||spend.entryToday<0||!Number.isSafeInteger(spend.lossToday)||spend.lossToday<0||typeof spend.selfExcluded!=='boolean'||typeof spend.accountHold!=='boolean'||!(spend.coolingOffUntil===null||typeof spend.coolingOffUntil==='string'))return {allowed:false,code:'COMPETITION_SPEND_CONTEXT_REQUIRED'};
 if(spend.selfExcluded)return {allowed:false,code:'COMPETITION_SELF_EXCLUDED'};
 if(spend.accountHold)return {allowed:false,code:'COMPETITION_ACCOUNT_HELD'};
 if(spend.coolingOffUntil!==null&&date(spend.coolingOffUntil,'INVALID_COMPETITION_COOLING_OFF')>now)return {allowed:false,code:'COMPETITION_COOLING_OFF'};
 if(fee>j.maxEntryFee)return {allowed:false,code:'COMPETITION_ENTRY_LIMIT'};
 if(spend.entryToday+fee>j.dailyEntryCap)return {allowed:false,code:'COMPETITION_DAILY_ENTRY_LIMIT'};
 if(spend.lossToday+fee>j.dailyLossCap)return {allowed:false,code:'COMPETITION_DAILY_LOSS_LIMIT'};
 return {allowed:true,code:'APPROVED_REGISTRATION_FEE',policyVersion:p.version,jurisdiction:j.country,legalReviewId:j.legalReviewId};
}

module.exports={classify,validatePolicy,assess};
