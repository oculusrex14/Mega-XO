'use strict';
const C = require('./capture.js');
const transient = e => /^(08|40|53|57P0)/.test(e.code || '') || ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE'].includes(e.code);
const safeCode = e => {
 const s = String(e.message || '').match(/^(CAPTURE_[A-Z0-9_]{1,70})(?:$|\s)/);
 return s ? s[1] : /^[0-9A-Z]{5}$/.test(e.code || '') ? 'CAPTURE_DATABASE_' + e.code : 'CAPTURE_SOURCE_INVALID';
};
function createCaptureWorker(db, {workerId, batchSize = 8, leaseMs = 30000} = {}) {
 if (!db || typeof db.query !== 'function' || !/^[A-Za-z0-9:_-]{1,120}$/.test(workerId || '') || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600000) throw new Error('CAPTURE_WORKER_CONFIG');
 const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0]?.value;
 async function tick() {
  const config = await scalar('SELECT learning.configuration() AS value');
  if (!config?.enabled) return {disabled:true,claimed:0,sealed:0,quarantined:0,suppressed:0,retry:0,stale:0};
  if (config.rulesHash !== C.RULES_HASH) throw new Error('CAPTURE_RULES_DEPLOYMENT_MISMATCH');
  const {rows} = await db.query('SELECT * FROM learning.claim($1,$2,$3)',[workerId,batchSize,leaseMs]);
  const result = {disabled:false,claimed:rows.length,sealed:0,quarantined:0,suppressed:0,retry:0,stale:0,errors:{}};
  for (const job of rows) {
   try {
    const p = await scalar('SELECT learning.project($1) AS value',[job.capture_id]);
    let body = null;
    if (!p?.suppressed) {
     if (p?.rulesHash !== C.RULES_HASH) throw new Error('CAPTURE_RULES_MISMATCH');
     if (!p?.source) throw new Error('CAPTURE_SOURCE_MISSING');
     body = C.stable(C.seal(p.source,p).payload);
    }
    const state = await scalar('SELECT learning.finish($1,$2,$3,$4,$5) AS value',[job.capture_id,workerId,job.lease_token,body,p?.sourceToken || null]);
    if (!['sealed','quarantined','suppressed'].includes(state)) throw new Error('CAPTURE_WORKER_RESULT');
    result[state]++;
   } catch (e) {
    const code=safeCode(e); result.errors[code]=(result.errors[code] || 0)+1;
    if (safeCode(e) === 'CAPTURE_STALE_LEASE') { result.stale++; continue; }
    // Store only a bounded allowlisted code, never stack/SQL/credentials/source payload.
    try {
     const state = await scalar('SELECT learning.reject($1,$2,$3,$4,$5) AS value',[job.capture_id,workerId,job.lease_token,safeCode(e),transient(e)]);
     result[state]++;
    } catch (rejection) {
     if (safeCode(rejection) === 'CAPTURE_STALE_LEASE') { result.stale++; continue; }
     // Connection loss leaves the durable lease intact for expiry/reclaim; do not fake success.
     throw new Error('CAPTURE_WORKER_DATABASE_UNAVAILABLE',{cause:rejection});
    }
   }
  }
  return result;
 }
 async function reconcile({kind='match',after='',limit=100,audit=false}={}) {
  if (!['match','fixture'].includes(kind) || typeof after !== 'string' || after.length>400 || !Number.isInteger(limit) || limit<1 || limit>500 || typeof audit !== 'boolean') throw new Error('CAPTURE_RECONCILE_CONFIG');
  return scalar('SELECT learning.reconcile($1,$2,$3,$4) AS value',[kind,after,limit,audit]);
 }
 return Object.freeze({tick,reconcile,metrics:()=>scalar('SELECT learning.metrics() AS value')});
}
module.exports={createCaptureWorker,safeCode,transient};
