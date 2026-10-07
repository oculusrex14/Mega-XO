'use strict';
const D=require('../src/domain');
const T=require('../src/tournament');
const {classify,assess}=require('../server/competition-compliance');
const {config}=require('../server/production/config');

const now=Date.parse('2026-10-07T00:00:00Z');
const candidate={
 enabled:true,version:'audit-policy-v1',approvalId:'audit-approval-v1',
 effectiveAt:'2026-10-01T00:00:00Z',expiresAt:'2026-12-31T23:59:59Z',
 allowPooledStake:false,allowCashOut:false,allowRealWorldPrize:false,prizeFunding:'organizer',
 jurisdictions:[{country:'GB',platforms:['web'],minAge:18,legalReviewId:'audit-gb-review',maxEntryFee:100,dailyEntryCap:1000,dailyLossCap:1000}]
};
const context={policy:candidate,platform:'web',location:{trusted:true,country:'GB',proxyRisk:false},age:{verified:true,trusted:true,age:21,verifiedAt:'2026-10-01T00:00:00Z'},spend:{entryToday:0,lossToday:0,selfExcluded:false,accountHold:false,coolingOffUntil:null},now};

function assert(condition,code){if(!condition)throw Error(code);}
function denied(name,entry){
 const model=classify(entry),decision=assess({...context,entry});
 assert(model==='pooled_stake',name+'_MUST_REMAIN_CLASSIFIED_AS_POOLED_STAKE');
 assert(decision.allowed===false&&decision.code==='POOLED_STAKE_PROHIBITED',name+'_MUST_REMAIN_DENIED');
 return {name,model,decision:decision.code};
}

function audit(){
 const checks=[];
 checks.push(denied('ranked_queue',D.quote({mode:'ranked',from:'gold',to:'gold'})));
 checks.push(denied('direct_crown_challenge',D.quote({mode:'direct',kind:'friend',from:'gold',to:'gold',amount:20})));
 for(const table of Object.keys(T.TABLES))checks.push(denied('tournament_'+table,T.prize(table)));
 const env={MEGA_ENV:'production',MEGA_ORIGIN:'https://play.antimatterinnovations.com',MEGA_DB:'/data/mega.sqlite',MEGA_OTP_SECRET:'1'.repeat(64),MEGA_PROXY_SECRET:'2'.repeat(64),MEGA_PAID_ENTRY_ENABLED:'true'};
 let hardDisabled=false;try{config(env);}catch(error){hardDisabled=error.message==='PAID_FEATURES_NOT_RELEASED';}
 assert(hardDisabled,'PRODUCTION_PAID_ENTRY_MUST_BE_HARD_DISABLED');
 const free=assess({entry:{model:'free'},platform:'web'});
 assert(free.allowed&&free.code==='FREE_COMPETITION','FREE_COMPETITION_MUST_REMAIN_AVAILABLE');
 return {ok:true,productionPaidEntryHardDisabled:true,currencySourceAgnostic:true,pooledStakeAllowed:false,cashOutAllowed:false,realWorldPrizeAllowed:false,checks};
}
if(require.main===module){try{process.stdout.write(JSON.stringify(audit(),null,2)+'\n');}catch(error){console.error('COMPETITION_COMPLIANCE_AUDIT_FAILED: '+error.message);process.exitCode=1;}}
module.exports={audit};
