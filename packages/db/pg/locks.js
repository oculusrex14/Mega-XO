'use strict';
const crypto = require('node:crypto');
const { ContextError } = require('../context');

// A missing row cannot be locked with FOR UPDATE. Serialize its logical identity on the
// already-pinned transaction connection; durable uniqueness/outcomes still own correctness.
// Hash collisions only serialize unrelated work. No session-level or Redis lock is used.
async function lockTransactionIdentity(tx, namespace, parts) {
 if (!tx || typeof tx.query !== 'function') throw new ContextError('TRANSACTION_REQUIRED');
 if (typeof namespace !== 'string' || !namespace || !Array.isArray(parts)) {
  throw new ContextError('LOCK_IDENTITY_REQUIRED');
 }
 const digest = crypto.createHash('sha256').update(JSON.stringify(['mega-xo-v5', namespace, parts])).digest();
 await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [digest.readBigInt64BE(0).toString()]);
}

module.exports = { lockTransactionIdentity };
