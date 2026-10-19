'use strict';
const DAY = 86400000;

// Pure, review-only proposals from ANTI-HOARDING-METRIC-DESIGN. No mutation or automatic ban.
function promotionSignals({ purchases, now, holdings, netDepletion14Days, spendingCoverageComplete = false, integrity = [] }) {
 const rows = purchases.filter(p => p.launchWindow === true && !p.refunded && p.credited === true)
  .sort((a,b) => a.at - b.at);
 const total = rows.reduce((s,p) => s + p.crowns, 0);
 let velocity = false, start = 0, windowCrowns = 0;
 for (let end = 0; end < rows.length; end++) {
  windowCrowns += rows[end].crowns;
  while (rows[end].at - rows[start].at > 3600000) windowCrowns -= rows[start++].crowns;
  if (end - start + 1 >= 4 && windowCrowns >= 4400) velocity = true;
 }
 const s1 = total >= 11000;
 const rate = Math.max(0, netDepletion14Days / 14);
 const coverDays = rate === 0 ? Infinity : holdings / rate;
 const s3 = spendingCoverageComplete && s1 && now - rows[0].at >= 14 * DAY
  && holdings >= total * .9 && coverDays >= 180;
 const defects = integrity.filter(p => p.installments !== p.journalInstallments
  || p.installmentAmounts.some(n => n !== 50) || p.exchangeCoinsUsed > 200);
 return {
  S1: { triggered: s1, consequence: 'informational-notice' },
  S2: { triggered: velocity, consequence: 'payment-evidence-review' },
  S3: { enabled: spendingCoverageComplete, triggered: s3, consequence: 'stockpiling-review-only' },
  S4: { triggered: defects.length > 0, consequence: 'investigate-service-defect-first' },
  qualifyingCrowns: total, automaticRestriction: false,
 };
}
module.exports = { promotionSignals };
