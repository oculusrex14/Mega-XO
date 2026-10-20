'use strict';
const crypto = require('node:crypto');
const { lockTransactionIdentity } = require('../db/pg/locks.js');

// Separate audit_runtime credentials, never borrowed Core credentials. Durable eventId is the
// idempotency key, so a death after append but before job completion is safe to redeliver.
function createPromotionAuditDelivery(pool, { secret, now = Date.now } = {}) {
 if (!pool || pool.describe().role !== 'audit_runtime' || typeof pool.withTransaction !== 'function') throw Error('AUDIT_POOL_REQUIRED');
 if (typeof secret !== 'string' || secret.length < 16) throw Error('AUDIT_SECRET_REQUIRED');
 async function deliver({ eventId }) {
  if (typeof eventId !== 'string' || !/^(confiscation|compensation):[A-Za-z0-9:_-]{1,120}$/.test(eventId)) throw Error('INVALID_PROMOTION_EVENT');
  return pool.withTransaction(async tx => {
   await lockTransactionIdentity(tx, 'audit', ['operator-chain']);
   const auditId = 'promotion:' + eventId;
   const old = (await tx.query('SELECT audit_id FROM audit.operator_audit WHERE audit_id = $1', [auditId])).rows[0];
   if (old) return old;
   const e = (await tx.query('SELECT * FROM monetization.promotion_events WHERE event_id = $1', [eventId])).rows[0];
   if (!e) throw Error('PROMOTION_EVENT_REQUIRED');
   const tail = (await tx.query('SELECT entry_hash,at FROM audit.operator_audit ORDER BY at DESC,audit_id DESC LIMIT 1')).rows[0];
   const previous = tail ? tail.entry_hash : 'GENESIS';
   const at = Math.max(now(), tail ? new Date(tail.at).getTime() + 1 : 0);
   const detail = JSON.stringify({ caseId: e.case_id, eventId, outboxId: e.outbox_id, journalIds: e.response.journalIds });
   const action = eventId.startsWith('confiscation:') ? 'confiscatePromotionBenefits' : 'restorePromotionBenefits';
   const entryHash = crypto.createHmac('sha256', secret).update(JSON.stringify([previous, auditId, at, e.operator_id, action, e.actor_id, e.reason_code, detail])).digest('hex');
   await tx.query('INSERT INTO audit.operator_audit (audit_id,at,operator,action,actor_id,reason,detail,prev_hash,entry_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [auditId, new Date(at).toISOString(), e.operator_id, action, e.actor_id, e.reason_code, detail, previous, entryHash]);
   return { audit_id: auditId };
  });
 }
 return Object.freeze({ deliver });
}
function createPromotionAuditWorker({ jobs, audit, workerId = 'promotion-audit' }) {
 return Object.freeze({ async tick() {
  const batch = await jobs.claimJobs({ workerId, kinds: ['promotion.audit'], limit: 16 });
  for (const job of batch) {
   try {
    await audit.deliver(job.payload);
    await jobs.completeJob({ id: job.id, workerId, fence: job.fence });
   } catch {
    await jobs.failJob({ id: job.id, workerId, fence: job.fence, error: 'PROMOTION_AUDIT_DELIVERY_FAILED' });
   }
  }
  return { processed: batch.length };
 } });
}
module.exports = { createPromotionAuditDelivery, createPromotionAuditWorker };
