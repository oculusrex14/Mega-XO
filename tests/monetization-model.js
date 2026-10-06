/* Sensitivity scenarios, not observed eCPMs, purchaser conversion or revenue forecasts. */
'use strict';
const M=require('../src/monetization.js'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const rows=[
 {name:'low',automaticOpportunities:.3,rewardOptIn:.1,rewardsPerViewer:1,fill:.65,interstitialEcpm:.5,rewardedEcpm:2,dailyPayerShare:.001,payerSpend:1.99},
 {name:'base',automaticOpportunities:.6,rewardOptIn:.2,rewardsPerViewer:1.5,fill:.8,interstitialEcpm:2,rewardedEcpm:6,dailyPayerShare:.002,payerSpend:2.99},
 {name:'high',automaticOpportunities:1,rewardOptIn:.35,rewardsPerViewer:2,fill:.9,interstitialEcpm:6,rewardedEcpm:15,dailyPayerShare:.004,payerSpend:3.99}
].map(x=>{const inputs={dau:10000,platformFee:.3,refundRate:.02,...x},outputs=M.revenueScenario(inputs),netAdRemoval=3.99*(1-inputs.platformFee)*(1-inputs.refundRate),foregonePerPayerDay=1.5*inputs.fill*inputs.interstitialEcpm/1000;return {inputs,outputs,removeAds:{priceHypothesis:3.99,automaticImpressionsPerPayerDayHypothesis:1.5,netAdRemoval,foregonePerPayerDay,breakEvenActiveDays:netAdRemoval/foregonePerPayerDay}};});
const fixedOnly=M.POLICY.rewardedDayCap*M.POLICY.rewardCredits+M.POLICY.casualDayCap;
const boostAndFixed=(M.POLICY.rewardedDayCap-1)*M.POLICY.rewardCredits+M.POLICY.casualDayCap+M.POLICY.boostDayCap;
assert.equal(fixedOnly,30);assert.equal(boostAndFixed,35);assert(M.PRODUCTS.every(p=>!p.subscription&&!p.elo));
const report={disclaimer:'All behavioral, price, fee, fill and eCPM inputs are authored sensitivity assumptions. No live revenue or uplift is measured. Do not reuse V3.4 90-day purchaser share as a daily conversion rate.',currency:'USD planning equivalents, not localized store quotes',scenarios:rows,cosmeticEconomy:{maxBaseCreditsPerDay:10,maxWithFourFixedAds:fixedOnly,maxWithOneBoostAndThreeFixedAds:boostAndFixed,competitiveCoinsMintedByAds:0,crownsMintedByAds:0,creditExchangeAllowed:false},rollout:{assignment:'10% no-ad control / 45% rewarded-only / 45% hybrid when explicitly configured for experiment; default off',firstStage:'Rewarded-only sandbox and beta before hybrid expansion',retentionMarginHypothesis:0.01,analysis:'Intention-to-treat and predeclared power/window; no peeking or claims based only on ad viewers'}};
fs.mkdirSync(path.join(__dirname,'../.artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.artifacts/v35-monetization-model.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
