/* V3.5 shared monetisation contract. No network calls, account mutations or ad SDK. */
(function(root,factory){const api=factory(typeof module==='object'?require('./domain.js'):root.MegaDomain);if(typeof module==='object')module.exports=api;else root.MegaMonetization=api;})(globalThis,D=>{
'use strict';
const MINUTE=60000,DAY=86400000;
/* `rewardedDayCap` stays the legacy account lane's own rewarded quota, enforced by the server
   ticket store; it is not weakened here. The shipped client measures ONE aggregate ceiling of ten
   rewarded presentations per UTC day across every reward type in `rewardedAggregateDayCap`, which
   `rewardedExposure` reports and the rewarded-power lane enforces. */
const POLICY=Object.freeze({version:'monetisation-1.1',firstAdAge:DAY,firstAdGames:5,gamesBetweenAds:3,activeTimeBetweenAds:8*MINUTE,fullScreenGap:8*MINUTE,interstitialSessionCap:2,interstitialDayCap:6,rewardedDayCap:4,rewardedAggregateDayCap:10,rewardedGap:2*MINUTE,ticketLifetime:5*MINUTE,callbackGrace:24*60*MINUTE,rewardCredits:5,casualCredits:2,casualDayCap:10,boostDuration:10*MINUTE,boostDayCap:10,maxGameSeconds:86400});
/* Cadence storage schema. Version 2 separates a shown presentation from a native-confirmed earned
   reward; a version-1 object is upgraded in place rather than discarded, so an installed client
   keeps its first-seen age, game cadence and daily counters across the update. */
const CADENCE_VERSION=2;
const FRAMES=Object.freeze([
 {id:'classic',name:'Classic',credits:0,description:'The standard Mega XO board surround.'}
].map(Object.freeze));
const PRODUCTS=Object.freeze([
 ...D.CROWN_PACKS.map(p=>({...p,name:p.crowns+' Crowns',type:'consumable',once:false,frames:[],removeAds:false})),
 {id:'remove_ads',name:'Remove Ads',type:'non-consumable',once:true,crowns:0,frames:[],removeAds:true,suggestedUSD:3.99}
].map(p=>Object.freeze({...p,frames:Object.freeze(p.frames)})));
const product=id=>PRODUCTS.find(p=>p.id===id)||null;
const frame=id=>FRAMES.find(f=>f.id===id)||null;
const positive=n=>Number.isFinite(n)&&n>=0;
const day=now=>new Date(now).toISOString().slice(0,10);
function freshProgress(now=Date.now()){return {version:CADENCE_VERSION,firstSeenAt:now,sessions:0,day:day(now),totalGames:0,gamesSinceAd:0,activeSinceAd:0,sessionAds:0,dayAds:0,lastFullScreenAt:0,rewardedShown:0,rewardedGranted:0,lastRewardedCompletedAt:0,lastInterstitialShownAt:0,seen:[]};}
/* Version 1 kept one shared `lastFullScreenAt`: a rewarded ad start moved it even when no ad was
   shown, and an interstitial reset the game cadence on the permit. Upgrade to version 2 without
   losing a single counter, and without inventing an impression that v1 never proved. */
function migrateCadence(raw,now=Date.now()){
 const p=raw&&(raw.version===1||raw.version===CADENCE_VERSION)&&positive(raw.firstSeenAt)&&Array.isArray(raw.seen)?structuredClone(raw):freshProgress(now);
 for(const k of ['sessions','totalGames','gamesSinceAd','activeSinceAd','sessionAds','dayAds','lastFullScreenAt'])if(!positive(p[k]))p[k]=0;
 p.version=CADENCE_VERSION;
 if(!positive(p.rewardedShown))p.rewardedShown=0;
 for(const k of ['rewardedGranted','lastRewardedCompletedAt','lastInterstitialShownAt'])if(!positive(p[k]))p[k]=0;
 if(p.day!==day(now)){p.day=day(now);p.dayAds=0;p.rewardedShown=0;}
 return p;
}
function startSession(raw,now=Date.now()){
 const p=migrateCadence(raw,now);
 p.sessions++;p.sessionAds=0;return p;
}
function meaningfulBot(r){return !!r&&r.mode==='bot'&&!r.practice&&['line','draw'].includes(r.reason)&&['win','loss','draw'].includes(r.result)&&Number.isInteger(r.moves)&&r.moves>=D.POLICY.minRewardMoves&&r.moves<=81&&positive(r.activeSeconds)&&r.activeSeconds>=D.POLICY.minRewardSeconds&&r.activeSeconds<=POLICY.maxGameSeconds&&typeof r.id==='string';}
function noteGame(p,r){if(!meaningfulBot(r)||p.seen.includes(r.id))return false;p.seen.push(r.id);p.seen=p.seen.slice(-500);p.totalGames++;p.gamesSinceAd++;p.activeSinceAd+=r.activeSeconds*1000;return true;}
function interstitialAllowed(p,c,now=Date.now()){
 if(!p||!c||c.adMode!=='hybrid'||c.entitlementsKnown!==true||c.removeAds!==false||c.consentReady!==true||c.adReady!==true)return false;
 if(c.transition!=='result_to_home'||c.gameMode!=='bot'||c.safe!==true||c.playing||c.onlineMatch||c.queued||c.partyOpen||c.hidden||c.modalOpen)return false;
 if(p.sessions<2||now<p.firstSeenAt||now-p.firstSeenAt<POLICY.firstAdAge||p.totalGames<POLICY.firstAdGames)return false;
 if(p.gamesSinceAd<POLICY.gamesBetweenAds||p.activeSinceAd<POLICY.activeTimeBetweenAds)return false;
 if(p.lastFullScreenAt>now||now-p.lastFullScreenAt<POLICY.fullScreenGap)return false;
 return p.sessionAds<POLICY.interstitialSessionCap&&(p.day!==day(now)||p.dayAds<POLICY.interstitialDayCap);
}
function noteFullScreen(p,format,now=Date.now()){
 if(!['rewarded','interstitial'].includes(format))throw Error('INVALID_AD_FORMAT');
 if(p.day!==day(now)){p.day=day(now);p.dayAds=0;if(positive(p.rewardedShown))p.rewardedShown=0;}
 p.lastFullScreenAt=now;
 if(format==='rewarded')p.lastRewardedCompletedAt=now;
 if(format==='interstitial'){p.dayAds++;p.sessionAds++;p.gamesSinceAd=0;p.activeSinceAd=0;p.lastInterstitialShownAt=now;}
}
/* Shown and earned are different facts. `noteRewardedShown` books the aggregate presentation the
   SDK actually put on screen and restarts the full-screen gap; `noteRewardedEarned` books a
   native-confirmed reward. A refused start or a no-fill callback calls neither. */
function noteRewardedShown(p,now=Date.now()){
 if(p.day!==day(now)){p.day=day(now);p.dayAds=0;p.rewardedShown=0;}
 p.rewardedShown=Math.min(9999,(positive(p.rewardedShown)?p.rewardedShown:0)+1);p.lastFullScreenAt=now;
 return p.rewardedShown;
}
function noteRewardedEarned(p,now=Date.now()){
 if(p.day!==day(now)){p.day=day(now);p.dayAds=0;p.rewardedShown=0;p.rewardedGranted=0;}
 p.rewardedGranted=Math.min(9999,(positive(p.rewardedGranted)?p.rewardedGranted:0)+1);p.lastRewardedCompletedAt=now;
 return p.rewardedGranted;
}
/* The one aggregate daily truth the UI may quote: presentations already on screen today, across
   Credits, boost and Undo together, against the ten-per-UTC-day ceiling. */
function rewardedExposure(p,now=Date.now()){
 const shown=p.day!==day(now)?0:(positive(p.rewardedShown)?p.rewardedShown:0);
 return {shownToday:Math.min(shown,POLICY.rewardedAggregateDayCap),dayCap:POLICY.rewardedAggregateDayCap,remaining:Math.max(0,POLICY.rewardedAggregateDayCap-shown)};
}
function cohort(id,mode='off'){
 if(['off','rewarded','hybrid'].includes(mode))return mode;
 if(mode!=='experiment')throw Error('INVALID_AD_MODE');
 let hash=2166136261;for(const c of String(id))hash=Math.imul(hash^c.charCodeAt(0),16777619)>>>0;
 const bucket=hash%100;return bucket<10?'off':bucket<55?'rewarded':'hybrid';
}
function qualifiedCasual(h){return !!h&&h.mode==='casual'&&h.rated===false&&h.queue===true&&h.qualified===true&&['line','draw'].includes(h.reason)&&['win','loss','draw'].includes(h.result)&&typeof h.id==='string'&&positive(h.at)&&positive(h.activeSeconds)&&h.activeSeconds>=D.POLICY.minRewardSeconds&&h.activeSeconds<=POLICY.maxGameSeconds;}
function boostApplies(h,boost){if(!boost||!qualifiedCasual(h))return false;const began=h.at-h.activeSeconds*1000;return began>=boost.startedAt&&began<boost.endsAt;}
function packInfo(id){const p=product(id);if(!p)throw Error('INVALID_PRODUCT');return {id:p.id,crowns:p.crowns,coinEquivalent:p.crowns*D.POLICY.coinsPerCrown,once:p.once,removeAds:p.removeAds,frames:[...p.frames]};}
function revenueScenario(x){
 const keys=['dau','automaticOpportunities','rewardOptIn','rewardsPerViewer','fill','interstitialEcpm','rewardedEcpm','dailyPayerShare','payerSpend','platformFee','refundRate'];
 for(const k of keys)if(!positive(x[k]))throw Error('INVALID_SCENARIO');
 for(const k of ['rewardOptIn','fill','dailyPayerShare','platformFee','refundRate'])if(x[k]>1)throw Error('INVALID_SCENARIO');
 if(x.automaticOpportunities>POLICY.interstitialDayCap||x.rewardsPerViewer>POLICY.rewardedDayCap)throw Error('IMPRESSIONS_EXCEED_POLICY');
 const interstitial=x.dau*x.automaticOpportunities*x.fill*x.interstitialEcpm/1000,rewarded=x.dau*x.rewardOptIn*x.rewardsPerViewer*x.fill*x.rewardedEcpm/1000,iap=x.dau*x.dailyPayerShare*x.payerSpend*(1-x.refundRate)*(1-x.platformFee);
 return {interstitial,rewarded,netIap:iap,totalBeforeOperatingCosts:interstitial+rewarded+iap,netPerDau:x.dau?(interstitial+rewarded+iap)/x.dau:0};
}
return Object.freeze({POLICY,FRAMES,PRODUCTS,MINUTE,DAY,CADENCE_VERSION,product,frame,day,startSession,freshProgress,migrateCadence,meaningfulBot,noteGame,interstitialAllowed,noteFullScreen,noteRewardedShown,noteRewardedEarned,rewardedExposure,cohort,qualifiedCasual,boostApplies,packInfo,revenueScenario});
});
