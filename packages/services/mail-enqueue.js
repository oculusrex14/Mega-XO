'use strict';

/* V5 durable mail producer (LR10, 2026-10-16).
 *
 * The API runtime owns INSERT on ops.outbox (migration 0038) but the durable job service is
 * worker-role-locked (0022), so THIS module is the producer: it seals the delivery body with the
 * SAME HKDF secret the mail worker derives its key from, wraps it in the versioned envelope
 * contract, and inserts the row directly. The worker then claims, opens and dispatches it exactly
 * like every other mail job - the API never talks to a provider, and no second SQLite-era writer
 * is created.
 *
 * IDEMPOTENCY. The outbox id is deterministic per challenge
 * (mail:otp:<purpose>:<challengeId>), so a producer retry inside the same unit of work is a
 * structural no-op (ON CONFLICT DO NOTHING). The provider idempotency key rides INSIDE the sealed
 * body (the challenge delivery already carries one), exactly where the legacy outbox put it. */

const { sealMessage } = require('./worker-workflows.js');
const { ENVELOPE_VERSION, ENQUEUE_SQL } = require('./jobs.js');

const DEFAULT_TTL_MS = 15 * 60 * 1000; /* the code itself expires at 10 minutes; the job outlives it slightly */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (code) => { throw Error(code); };

function requireText(value, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 320) fail(code);
  if (/[\u0000-\u001F\u007F]/.test(value)) fail(code);
  return value;
}

function createOtpSink(options = {}) {
  const pool = options && options.pool;
  if (!pool || typeof pool.query !== 'function') fail('MAIL_POOL_REQUIRED');
  const secret = options.secret;
  if (typeof secret !== 'string' || secret.length < 16) fail('MAIL_SECRET_REQUIRED');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('MAIL_TTL_INVALID');

  return async function otpSink(delivery) {
    if (!delivery || typeof delivery !== 'object') fail('MAIL_DELIVERY_REQUIRED');
    const to = requireText(delivery.to, 'MAIL_RECIPIENT_REQUIRED');
    if (!EMAIL_PATTERN.test(to)) fail('MAIL_RECIPIENT_INVALID');
    const code = requireText(delivery.code, 'MAIL_CODE_REQUIRED');
    const purpose = requireText(delivery.purpose, 'MAIL_PURPOSE_REQUIRED');
    const idempotencyKey = requireText(delivery.idempotencyKey, 'MAIL_IDEMPOTENCY_REQUIRED');
    const challengeId = requireText(delivery.challengeId, 'MAIL_CHALLENGE_REQUIRED');
    const id = 'mail:otp:' + purpose + ':' + challengeId;
    const payload = sealMessage(secret, { to, code, purpose, idempotencyKey });
    const envelope = JSON.stringify({ version: ENVELOPE_VERSION, payload, businessKey: id });
    const at = now();
    await pool.query(ENQUEUE_SQL, [id, envelope, 'otp', new Date(at), new Date(at + ttlMs), new Date(at)]);
    return { id, purpose };
  };
}

module.exports = { createOtpSink, DEFAULT_TTL_MS };
