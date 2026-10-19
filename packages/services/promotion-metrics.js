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
// Private read-only report. Exact SQL/parameters and frozen rows accompany the proposed signals;
// callers retain/hash that packet for review. The default never enables the incomplete S3 gate.
const PURCHASES_SQL = `WITH orders AS (
 SELECT 'cashfree' AS provider,order_id AS ref,actor_id,created_at,settled_at,refunded_at FROM monetization.cashfree_orders
 UNION ALL SELECT 'polar',checkout_id,actor_id,created_at,settled_at,refunded_at FROM monetization.polar_orders
 UNION ALL SELECT 'dodo',checkout_id,actor_id,created_at,settled_at,refunded_at FROM monetization.dodo_orders
)
SELECT l.entry_id,l.amount,l.at,o.created_at,o.refunded_at FROM orders o
 JOIN economy.ledger l ON l.entry_id = 'purchase:' || o.provider || ':' || o.ref AND l.actor_id=o.actor_id
 WHERE o.actor_id=$1 AND o.created_at >= $2 AND o.created_at <= $3 AND o.settled_at IS NOT NULL
 AND l.currency='crowns' AND l.source='verified-store' AND l.amount>0
UNION ALL
SELECT l.entry_id,l.amount,l.at,a.reserved_at,r.refunded_at FROM monetization.promotion_allocations a
 JOIN monetization.promotion_lots lot USING(allocation_id)
 JOIN economy.ledger l ON l.entry_id=lot.grant_id AND l.actor_id=a.actor_id
 JOIN (SELECT store,transaction_id,CASE WHEN refunded THEN purchased_at ELSE NULL END AS refunded_at FROM monetization.receipts) r
 ON lot.grant_id='purchase:' || r.store || ':' || r.transaction_id
 WHERE a.actor_id=$1 AND a.provider IN ('apple','google') AND a.reserved_at >= $2 AND a.reserved_at <= $3`;
const HOLDINGS_SQL = 'SELECT coins,crowns,reserved_coins,reserved_crowns FROM economy.wallets WHERE actor_id=$1';
const DEPLETION_SQL = `SELECT COALESCE(-sum(CASE WHEN currency='coins' THEN amount::numeric/10 ELSE amount END),0) AS depletion
 FROM economy.ledger WHERE actor_id=$1 AND at >= $2 AND at <= $3
 AND source NOT IN ('provisioning','migration-baseline') AND entry_id NOT LIKE 'purchase:%'`;
const INTEGRITY_SQL = `SELECT pp.subscription_id,pp.period_start,pp.installments_granted,pp.exchange_coins_used,
 count(l.entry_id)::int AS journal_installments,COALESCE(array_agg(l.amount) FILTER(WHERE l.entry_id IS NOT NULL),'{}') AS installment_amounts
 FROM monetization.pass_periods pp JOIN monetization.store_subscriptions ps USING(subscription_id)
 LEFT JOIN economy.ledger l ON l.actor_id=ps.actor_id AND l.entry_id LIKE
 ('pass:' || pp.subscription_id || ':' || to_char(pp.period_start AT TIME ZONE 'UTC','YYYY-MM-DD') || ':%')
 WHERE ps.actor_id=$1 GROUP BY pp.subscription_id,pp.period_start,pp.installments_granted,pp.exchange_coins_used`;
async function readPromotionMetrics(pool, { actor, launchStart, launchEnd, now = Date.now(), spendingCoverageComplete = false, coverageEvidenceHash = null, sourceSha = null }) {
 if (!pool || !['core_runtime','backup_reader'].includes(pool.describe().role)) throw Error('PRIVATE_METRICS_POOL_REQUIRED');
 if (typeof actor !== 'string' || !actor || !Number.isFinite(Date.parse(launchStart))
  || !Number.isFinite(Date.parse(launchEnd)) || Date.parse(launchEnd)<Date.parse(launchStart)) throw Error('INVALID_METRIC_WINDOW');
 if (spendingCoverageComplete && !/^[0-9a-f]{64}$/.test(coverageEvidenceHash)) throw Error('SPENDING_COVERAGE_EVIDENCE_REQUIRED');
 return pool.withTransaction(async tx => {
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const purchaseParams=[actor,launchStart,launchEnd], depletionParams=[actor,new Date(now-14*DAY).toISOString(),new Date(now).toISOString()];
  const purchases=(await tx.query(PURCHASES_SQL,purchaseParams)).rows;
  const wallet=(await tx.query(HOLDINGS_SQL,[actor])).rows[0];
  if(!wallet) throw Error('ACCOUNT_REQUIRED');
  const depletion=Number((await tx.query(DEPLETION_SQL,depletionParams)).rows[0].depletion);
  const integrity=(await tx.query(INTEGRITY_SQL,[actor])).rows;
  const holdings=Number(wallet.crowns)+Number(wallet.reserved_crowns)+(Number(wallet.coins)+Number(wallet.reserved_coins))/10;
  const signals=promotionSignals({purchases:purchases.map(p=>({at:new Date(p.at).getTime(),crowns:Number(p.amount),credited:true,launchWindow:true,refunded:p.refunded_at!==null})),now,holdings,netDepletion14Days:depletion,spendingCoverageComplete,
   integrity:integrity.map(p=>({installments:Number(p.installments_granted),journalInstallments:p.journal_installments,installmentAmounts:p.installment_amounts.map(Number),exchangeCoinsUsed:Number(p.exchange_coins_used)}))});
  return {signals,evidence:{sourceSha,snapshotAt:new Date(now).toISOString(),coverageEvidenceHash,queries:[{sql:PURCHASES_SQL,params:purchaseParams},{sql:HOLDINGS_SQL,params:[actor]},{sql:DEPLETION_SQL,params:depletionParams},{sql:INTEGRITY_SQL,params:[actor]}],frozenRows:{purchases,wallet,depletion,integrity}}};
 });
}
module.exports = { promotionSignals, readPromotionMetrics };
