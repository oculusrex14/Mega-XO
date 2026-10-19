'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireCapacity, remaining, moveLot, hash } = require('../packages/services/promotion-allocation.js');
const { promotionSignals } = require('../packages/services/promotion-metrics.js');
const { validateCase, debitHeld } = require('../packages/services/promotion-operator.js');
const DAY = 86400000, NOW = Date.parse('2026-12-01T00:00:00Z');
function packet() {
 return {
  transactions: [{ grantId: 'purchase:dodo:cks_test' }], response: null,
  evidence: { policyHash: 'a'.repeat(64), acceptanceHash: 'b'.repeat(64), sourceSha: 'c'.repeat(40), sql: 'SELECT frozen evidence', params: [], snapshotAt: new Date(NOW - 12 * DAY).toISOString(), frozenRows: [{ crowns: 100 }], provenance: 'verified order + immutable grant' },
  notice: { rule: 'v1 rule', transactions: 'order one', figures: '100 Crowns', proposedAmounts:{crowns:100,coins:0}, appealRoute: '/appeals', inAccountReceipt: 'delivered:1', emailReceipt: 'delivered:2', deliveredAt: new Date(NOW - 11 * DAY).toISOString() },
  decision: { finding: 'proven_breach', reason: 'Independent payment evidence', basis: 'evidence', breachedRule:'accepted promotion v1', breachEvidenceHash:'d'.repeat(64), reference: 'decision:1', reviewer: 'operator:1', secondReviewer: 'operator:2', decidedAt: new Date(NOW).toISOString(),deliveredAt:new Date(NOW).toISOString(),deliveryReceipt:'decision:delivered', appealUntil: new Date(NOW + 30 * DAY).toISOString(), amounts: [{ grantId: 'purchase:dodo:cks_test', crowns: 100, coins: 0 }] },
 };
}
test('allocation: every pack size consumes one non-replenishing 22,000-Crown budget', () => {
 for (const pack of [100,525,1100]) {
  let allocated = 0;
  while (remaining(allocated) >= pack) { requireCapacity(allocated,pack); allocated += pack; }
  assert.throws(() => requireCapacity(allocated,pack), /PROMOTION_ALLOCATION_CAP/);
  for (const _action of ['spend','convert','refund']) assert.equal(remaining(allocated), 22000 - allocated);
 }
 requireCapacity(20900,1100);
 assert.throws(() => requireCapacity(22000,100), /PROMOTION_ALLOCATION_CAP/);
});
test('S1/S2 boundaries are inclusive and signals never restrict an account', () => {
 const purchases = Array.from({length: 10}, (_,i) => ({ at: NOW + i * 1200000, crowns: 1100, credited: true, launchWindow: true }));
 const result = promotionSignals({ purchases, now: NOW + 15 * DAY, holdings: 11000, netDepletion14Days: 0 });
 assert.equal(result.S1.triggered,true);
 assert.equal(result.S2.triggered,true,'four purchases spanning exactly 60 minutes qualify');
 assert.equal(result.S3.enabled,false);
 assert.equal(result.automaticRestriction,false);
 const outside = purchases.slice(0,4).map((p,i) => ({ ...p, at: NOW + i * 1200001 }));
 assert.equal(promotionSignals({ purchases: outside }).S2.triggered,false);
});
test('S3 requires complete spending evidence, fourteen days, 90% holdings and 180 days cover', () => {
 const input = { purchases: [{ at: NOW, crowns: 11000, credited: true, launchWindow: true }], now: NOW + 14 * DAY, holdings: 9900, netDepletion14Days: 770, spendingCoverageComplete: true };
 assert.equal(promotionSignals(input).S3.triggered,true);
 for (const change of [{ spendingCoverageComplete: false }, { now: NOW + 14 * DAY - 1 }, { holdings: 9899 }, { netDepletion14Days: 771 }]) assert.equal(promotionSignals({...input,...change}).S3.triggered,false);
 assert.equal(promotionSignals({...input,purchases: [{...input.purchases[0],refunded:true}]}).S1.triggered,false);
});
test('S4 directs defects to a service investigation first', () => {
 for (const integrity of [{ installments: 3,journalInstallments: 2,installmentAmounts:[50,50],exchangeCoinsUsed:200 }, { installments:1,journalInstallments:1,installmentAmounts:[150],exchangeCoinsUsed:0 }, { installments:3,journalInstallments:3,installmentAmounts:[50,50,50],exchangeCoinsUsed:201 }]) {
  const r = promotionSignals({purchases:[],integrity:[integrity]});
  assert.equal(r.S4.triggered,true);
  assert.equal(r.S4.consequence,'investigate-service-defect-first');
 }
});
test('held-only recovery preserves earned/legitimate funds and cannot overdraw', () => {
 const wallet = { crowns: 150,coins: 200,purchasedCrowns:100,purchasedCoins:100 };
 assert.deepEqual(debitHeld(wallet,{crowns:100,coins:100},{crowns:100,coins:100}),{crowns:50,coins:100,purchasedCrowns:0,purchasedCoins:0});
 for (const amounts of [{crowns:101,coins:0},{crowns:0,coins:101},{crowns:151,coins:0}]) assert.throws(() => debitHeld(wallet,amounts,{crowns:100,coins:100}),/BENEFITS_NOT_HELD/);
});
test('conversion moves only provably attributable held benefits and never recreates spent lots', () => {
 assert.deepEqual(moveLot({held_crowns:100,held_coins:0},{crowns:100,coins:0},{crowns:100},{crowns:100}),{crowns:0,coins:1000});
 assert.deepEqual(moveLot({held_crowns:100,held_coins:0},{crowns:200,coins:0},{crowns:100},{crowns:100}),{crowns:0,coins:0},'ambiguous provenance is excluded');
 assert.deepEqual(moveLot({held_crowns:0,held_coins:0},{crowns:100,coins:0},{crowns:50},{}),{crowns:0,coins:0});
});
test('due process rejects missing notice, ten-day wait, second reviewer and short appeal', () => {
 assert.equal(validateCase(packet(),NOW).response,null,'silence does not establish admission');
 for (const mutate of [p=>delete p.notice.emailReceipt,p=>p.notice.deliveredAt=new Date(NOW - 9*DAY).toISOString(),p=>p.decision.secondReviewer=p.decision.reviewer,p=>p.decision.appealUntil=new Date(NOW+29*DAY).toISOString(),p=>p.decision.basis='silence',p=>delete p.evidence.frozenRows,p=>p.decision.amounts[0].crowns=-1]) {
  const p = packet(); mutate(p); assert.throws(()=>validateCase(p,NOW));
 }
});
module.exports = { packet };
test('case fingerprints survive JSONB key ordering without changing array order', () => {
 assert.equal(hash({b:2,a:{z:3,c:1}}),hash({a:{c:1,z:3},b:2}));
 assert.notEqual(hash([{crowns:1},{crowns:2}]),hash([{crowns:2},{crowns:1}]));
});
