'use strict';

// PRIVATE composition only. Intentionally absent from commerce-ingress. Authentication is supplied
// by the operator host, never from a player body; the explicit authorizer is mandatory at boot.
const { createPgUnitOfWork } = require('../db/pg/uow.js');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');
const { lockTransactionIdentity } = require('../db/pg/locks.js');
const { lockActors } = require('./core.js');
const { hash } = require('./promotion-allocation.js');
const DAY = 86400000;
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9:_-]{1,120}$/;
const iso = n => new Date(n).toISOString();
function text(v) { return typeof v === 'string' && v.trim().length > 0; }
function requireOperator(principal) {
 if (!principal || principal.scope !== 'operator' || !text(principal.actor)) throw Error('OPERATOR_REQUIRED');
}
function validateCase(packet, now) {
 const n = packet && packet.notice, d = packet && packet.decision, e = packet && packet.evidence;
 if (!n || !d || !e || !Array.isArray(packet.transactions) || !packet.transactions.length
  || !HEX.test(e.policyHash) || !HEX.test(e.acceptanceHash) || !/^[0-9a-f]{40}$/.test(e.sourceSha)
  || !text(e.sql) || !Array.isArray(e.params) || !Number.isFinite(Date.parse(e.snapshotAt))
  || !Array.isArray(e.frozenRows) || !e.frozenRows.length || !text(e.provenance)
  || !text(n.rule) || !text(n.transactions) || !text(n.figures) || !text(n.appealRoute)
  || !text(n.inAccountReceipt) || !Number.isFinite(Date.parse(n.deliveredAt))
  || Date.parse(n.deliveredAt) > now - 10 * DAY || !Object.hasOwn(packet, 'response')
  || d.finding !== 'proven_breach' || !text(d.reason) || !text(d.reference)
  || !text(d.reviewer) || !text(d.secondReviewer) || d.reviewer === d.secondReviewer
  || !Number.isFinite(Date.parse(d.decidedAt)) || Date.parse(d.decidedAt) < Date.parse(n.deliveredAt) + 10 * DAY
  || Date.parse(d.decidedAt) > now || Date.parse(d.appealUntil) < Date.parse(d.decidedAt) + 30 * DAY
  || !Number.isFinite(Date.parse(d.appealUntil)) || !Array.isArray(d.amounts) || !d.amounts.length) throw Error('DUE_PROCESS_REQUIRED');
 // Email is conservatively required for every case. No credential-table grant to Core is needed.
 if (!text(n.emailReceipt)) throw Error('NOTICE_DELIVERY_REQUIRED');
 if (packet.response === null && d.basis === 'silence') throw Error('SILENCE_IS_NOT_ADMISSION');
 const seen = new Set();
 for (const a of d.amounts) {
  if (!a || !text(a.grantId) || seen.has(a.grantId)
   || !Number.isSafeInteger(a.crowns) || a.crowns < 0 || !Number.isSafeInteger(a.coins) || a.coins < 0
   || a.crowns + a.coins <= 0) throw Error('INVALID_APPROVED_AMOUNTS');
  seen.add(a.grantId);
 }
 return packet;
}
function debitHeld(wallet, approved, held) {
 if (approved.crowns > held.crowns || approved.coins > held.coins
  || approved.crowns > wallet.crowns || approved.coins > wallet.coins
  || approved.crowns > wallet.purchasedCrowns || approved.coins > wallet.purchasedCoins) throw Error('BENEFITS_NOT_HELD');
 return { crowns: wallet.crowns - approved.crowns, coins: wallet.coins - approved.coins,
  purchasedCrowns: wallet.purchasedCrowns - approved.crowns, purchasedCoins: wallet.purchasedCoins - approved.coins };
}
async function createPromotionOperatorService(pool, { authorize, now = Date.now } = {}) {
 if (!pool || pool.describe().role !== 'core_runtime') throw Error('CORE_POOL_REQUIRED');
 if (typeof authorize !== 'function') throw Error('OPERATOR_AUTHORIZER_REQUIRED');
 await verifyRuntimeSchema(pool);
 const uow = createPgUnitOfWork(pool, { role: 'core_runtime', now });
 async function authorized(principal, action) {
  requireOperator(principal);
  if (await authorize(principal, action) !== true) throw Error('OPERATOR_FORBIDDEN');
 }
 async function recordCase(principal, { caseId, targetActor, policyVersion, evidenceHash, packet }) {
  await authorized(principal, 'recordPromotionCase');
  if (!ID.test(caseId) || !text(targetActor) || !text(policyVersion) || hash(packet) !== evidenceHash) throw Error('INVALID_CASE');
  validateCase(packet, now());
  return uow.run(async tx => {
   await lockTransactionIdentity(tx, 'operation', ['promotion-case', caseId]);
   await lockActors(tx, [targetActor]); // register the TARGET, never an opponent/virtual operator
   const old = (await tx.query('SELECT evidence_hash,actor_id,policy_version FROM monetization.promotion_cases WHERE case_id = $1', [caseId])).rows[0];
   if (old) { if (old.evidence_hash !== evidenceHash || old.actor_id !== targetActor || old.policy_version !== policyVersion) throw Error('IDEMPOTENCY_CONFLICT'); return { caseId }; }
   await tx.query('INSERT INTO monetization.promotion_cases (case_id,actor_id,policy_version,evidence_hash,packet,recorded_by,recorded_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)', [caseId, targetActor, policyVersion, evidenceHash, JSON.stringify(packet), principal.actor, iso(tx.clock())]);
   if (principal.actor !== packet.decision.reviewer) throw Error('REVIEWER_MISMATCH');
   await tx.query('INSERT INTO monetization.promotion_case_approvals (case_id,reviewer_id,decision_reference,amounts_hash,approved_at) VALUES ($1,$2,$3,$4,$5)', [caseId, principal.actor, packet.decision.reference, hash(packet.decision.amounts), iso(tx.clock())]);
   return { caseId };
  });
 }
 async function approveForfeiture(principal, { caseId, evidenceHash }) {
  await authorized(principal, 'approvePromotionForfeiture');
  return uow.run(async tx => {
   await lockTransactionIdentity(tx, 'operation', ['promotion-case', caseId]);
   const row = (await tx.query('SELECT * FROM monetization.promotion_cases WHERE case_id = $1', [caseId])).rows[0];
   if (!row || row.evidence_hash !== evidenceHash || principal.actor !== row.packet.decision.secondReviewer) throw Error('SECOND_REVIEWER_REQUIRED');
   await tx.query('INSERT INTO monetization.promotion_case_approvals (case_id,reviewer_id,decision_reference,amounts_hash,approved_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [caseId, principal.actor, row.packet.decision.reference, hash(row.packet.decision.amounts), iso(tx.clock())]);
   return { caseId, approved: true };
  });
 }
 async function confiscatePromotionBenefits(principal, command) {
  await authorized(principal, 'confiscatePromotionBenefits');
  const { caseId, targetActor, approvedAmounts, policyVersion, reasonCode, evidenceHash, decisionReference } = command || {};
  if (!ID.test(caseId) || !text(targetActor) || !ID.test(reasonCode) || !HEX.test(evidenceHash)) throw Error('INVALID_CASE');
  const fingerprint = hash(command);
  return uow.run(async tx => {
   // Case identity is GLOBAL across operator ids and request keys. It precedes actor row locks.
   await lockTransactionIdentity(tx, 'operation', ['promotion-case', caseId]);
   await lockActors(tx, [targetActor]);
   const old = (await tx.query('SELECT fingerprint,response FROM monetization.promotion_events WHERE event_id = $1', ['confiscation:' + caseId])).rows[0];
   if (old) { if (old.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT'); return old.response; }
   const row = (await tx.query('SELECT * FROM monetization.promotion_cases WHERE case_id = $1', [caseId])).rows[0];
   if (!row || row.actor_id !== targetActor || row.policy_version !== policyVersion || row.evidence_hash !== evidenceHash) throw Error('CASE_MISMATCH');
   const packet = validateCase(row.packet, tx.clock());
   if (packet.decision.reference !== decisionReference || hash(approvedAmounts) !== hash(packet.decision.amounts)) throw Error('DECISION_MISMATCH');
   const approvals = (await tx.query('SELECT reviewer_id FROM monetization.promotion_case_approvals WHERE case_id = $1 AND amounts_hash = $2 AND decision_reference = $3', [caseId, hash(approvedAmounts), decisionReference])).rows;
   if (!approvals.some(a => a.reviewer_id === packet.decision.reviewer)
    || !approvals.some(a => a.reviewer_id === packet.decision.secondReviewer)) throw Error('SECOND_REVIEWER_REQUIRED');
   const wallet = (await tx.query('SELECT * FROM economy.wallets WHERE actor_id = $1', [targetActor])).rows[0];
   if (!wallet) throw Error('ACCOUNT_REQUIRED');
   let current = { crowns: Number(wallet.crowns), coins: Number(wallet.coins), purchasedCrowns: Number(wallet.purchased_crowns), purchasedCoins: Number(wallet.purchased_coins) };
   const journals = [];
   for (const a of approvedAmounts) {
    const lot = (await tx.query('SELECT l.*,a.reserved_at,a.acceptance_hash,a.policy_version,a.provider,a.op_key,a.product_id,a.crowns AS granted_crowns,p.published_at,p.effective_at,p.rule_hash FROM monetization.promotion_lots l JOIN monetization.promotion_allocations a USING (allocation_id) JOIN monetization.promotion_policies p USING (policy_version) WHERE l.grant_id = $1 AND l.actor_id = $2 FOR UPDATE OF l', [a.grantId, targetActor])).rows[0];
    if (!lot || lot.policy_version !== policyVersion || !lot.published_at || !lot.acceptance_hash
     || lot.rule_hash !== packet.evidence.policyHash || lot.acceptance_hash !== packet.evidence.acceptanceHash
     || Date.parse(lot.reserved_at) < Date.parse(lot.effective_at)) throw Error('ACCEPTED_POLICY_REQUIRED');
    const acceptance = (await tx.query('SELECT accepted_at,rule_hash FROM monetization.promotion_acceptances WHERE actor_id = $1 AND policy_version = $2 AND acceptance_hash = $3', [targetActor, policyVersion, lot.acceptance_hash])).rows[0];
    if (!acceptance || acceptance.rule_hash !== lot.rule_hash || Date.parse(acceptance.accepted_at) < Date.parse(lot.published_at)
     || Date.parse(acceptance.accepted_at) > Date.parse(lot.reserved_at)) throw Error('ACCEPTED_POLICY_REQUIRED');
    const evidence = packet.transactions.find(t => t.grantId === a.grantId);
    if (!evidence || !text(evidence.providerOrderRef) || !evidence.verifiedPrice || !HEX.test(evidence.priceVerificationHash)
     || evidence.providerOrderRef !== lot.provider_order_ref || !lot.verified_price || hash(evidence.verifiedPrice) !== hash(lot.verified_price)
     || evidence.allocationId !== lot.allocation_id) throw Error('GRANT_EVIDENCE_REQUIRED');
    // Defensive lower bound covers ALL ledger writers (including tournament/reservation paths),
    // even when their service did not maintain lots. Historic balances alone are never proof.
    const debits = (await tx.query('SELECT currency,COALESCE(sum(-amount),0) AS total FROM economy.ledger WHERE actor_id = $1 AND amount < 0 AND at >= $2 GROUP BY currency', [targetActor, lot.credited_at])).rows;
    const spent = Object.fromEntries(debits.map(r => [r.currency, Number(r.total)]));
    const held = { crowns: Math.min(Number(lot.held_crowns), Math.max(0, Number(lot.granted_crowns) - (spent.crowns || 0))), coins: Math.max(0, Number(lot.held_coins) - (spent.coins || 0)) };
    if (a.coins && (!Array.isArray(evidence.conversionJournalIds) || evidence.conversionJournalIds.length !== 2)) throw Error('CONVERSION_EVIDENCE_REQUIRED');
    if (a.coins) {
     const proof = (await tx.query("SELECT currency,amount FROM economy.ledger WHERE actor_id = $1 AND source = 'conversion' AND entry_id = ANY($2::text[])", [targetActor, evidence.conversionJournalIds])).rows;
     if (proof.length !== 2 || !proof.some(r => r.currency === 'crowns' && Number(r.amount) < 0)
      || !proof.some(r => r.currency === 'coins' && Number(r.amount) >= a.coins)) throw Error('CONVERSION_EVIDENCE_REQUIRED');
    }
    current = debitHeld(current, a, held);
    await tx.query('UPDATE monetization.promotion_lots SET held_crowns = held_crowns - $2,held_coins = held_coins - $3 WHERE grant_id = $1', [a.grantId, a.crowns, a.coins]);
   }
   for (const currency of ['crowns','coins']) {
    const delta = approvedAmounts.reduce((sum,a) => sum + a[currency], 0);
    if (!delta) continue;
    const id = 'confiscation:' + caseId + ':' + currency;
    await tx.query("INSERT INTO economy.ledger (entry_id,actor_id,currency,amount,reason,source,at) VALUES ($1,$2,$3,$4,$5,'spend',$6)", [id, targetActor, currency, -delta, 'Promotion case ' + caseId + ': ' + reasonCode, iso(tx.clock())]);
    journals.push(id);
   }
   const totals = approvedAmounts.reduce((sum,a) => ({ crowns: sum.crowns + a.crowns, coins: sum.coins + a.coins }), { crowns: 0, coins: 0 });
   await tx.query('UPDATE economy.wallets SET crowns = crowns - $2,coins = coins - $3,purchased_crowns = purchased_crowns - $2,purchased_coins = purchased_coins - $3 WHERE actor_id = $1', [targetActor, totals.crowns, totals.coins]);
   const eventId = 'confiscation:' + caseId, outboxId = 'promotion.audit:' + eventId;
   const response = { caseId, targetActor, journalIds: journals, outboxId, approvedAmounts };
   await tx.query("INSERT INTO ops.outbox (outbox_id,payload,kind,state,created_at,expires_at,next_at,lease_until,attempts) VALUES ($1,$2,'promotion.audit','queued',$3,$4,$3,'1970-01-01T00:00:00Z',0)", [outboxId, JSON.stringify({ eventId }), iso(tx.clock()), iso(tx.clock() + 365 * DAY)]);
   await tx.query('INSERT INTO monetization.promotion_events (event_id,case_id,actor_id,fingerprint,response,outbox_id,operator_id,reason_code,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)', [eventId, caseId, targetActor, fingerprint, JSON.stringify(response), outboxId, principal.actor, reasonCode, iso(tx.clock())]);
   return response;
  });
 }
 async function restorePromotionBenefits(principal, command) {
  await authorized(principal, 'restorePromotionBenefits');
  const { caseId, appealReference, appealEvidenceHash, reviewer, secondReviewer, reason } = command || {};
  if (!ID.test(caseId) || !text(appealReference) || !HEX.test(appealEvidenceHash) || !text(reason)
   || !text(reviewer) || !text(secondReviewer) || reviewer === secondReviewer) throw Error('APPEAL_DECISION_REQUIRED');
  return uow.run(async tx => {
   await lockTransactionIdentity(tx, 'operation', ['promotion-case', caseId]);
   const original = (await tx.query('SELECT * FROM monetization.promotion_events WHERE event_id = $1', ['confiscation:' + caseId])).rows[0];
   if (!original) throw Error('CONFISCATION_REQUIRED');
   await lockActors(tx, [original.actor_id]);
   const eventId = 'compensation:' + caseId, fingerprint = hash(command);
   const old = (await tx.query('SELECT fingerprint,response FROM monetization.promotion_events WHERE event_id = $1', [eventId])).rows[0];
   if (old) { if (old.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT'); return old.response; }
   const amounts = original.response.approvedAmounts;
   const total = amounts.reduce((s,a) => ({ crowns: s.crowns + a.crowns, coins: s.coins + a.coins }), { crowns: 0, coins: 0 });
   const journalIds = [];
   for (const currency of ['crowns','coins']) {
    if (!total[currency]) continue;
    const id = eventId + ':' + currency;
    await tx.query("INSERT INTO economy.ledger (entry_id,actor_id,currency,amount,reason,source,at) VALUES ($1,$2,$3,$4,$5,'mint',$6)", [id, original.actor_id, currency, total[currency], 'Successful promotion appeal ' + caseId, iso(tx.clock())]);
    journalIds.push(id);
   }
   await tx.query('UPDATE economy.wallets SET crowns = crowns + $2,coins = coins + $3,purchased_crowns = purchased_crowns + $2,purchased_coins = purchased_coins + $3 WHERE actor_id = $1', [original.actor_id, total.crowns, total.coins]);
   const outboxId = 'promotion.audit:' + eventId;
   const response = { caseId, targetActor: original.actor_id, journalIds, outboxId, appealReference, appealEvidenceHash, reviewer, secondReviewer, reason };
   await tx.query("INSERT INTO ops.outbox (outbox_id,payload,kind,state,created_at,expires_at,next_at,lease_until,attempts) VALUES ($1,$2,'promotion.audit','queued',$3,$4,$3,'1970-01-01T00:00:00Z',0)", [outboxId, JSON.stringify({ eventId }), iso(tx.clock()), iso(tx.clock() + 365 * DAY)]);
   await tx.query('INSERT INTO monetization.promotion_events (event_id,case_id,actor_id,fingerprint,response,outbox_id,operator_id,reason_code,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)', [eventId, caseId, original.actor_id, fingerprint, JSON.stringify(response), outboxId, principal.actor, 'appeal-upheld', iso(tx.clock())]);
   // Compensation does not free allocation or recreate an abusive lot.
   return response;
  });
 }
 return Object.freeze({ recordCase, approveForfeiture, confiscatePromotionBenefits, restorePromotionBenefits, close: () => uow.close() });
}
module.exports = { createPromotionOperatorService, validateCase, debitHeld };
