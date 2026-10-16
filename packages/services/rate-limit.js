'use strict';

/* LR12 (2026-10-16): the durable per-actor fixed-window rate limiter for the mounted commerce
 * routes. This is the V5 successor of the legacy monetization-http in-memory limiter
 * (60 requests per actor per UTC-minute -> 429 RATE_LIMITED) with the same contract but a
 * DURABLE counter: ops.rate_buckets (0018) already carries api_runtime INSERT/UPDATE grants
 * (0020), the same atomic upsert shape the metrics sink uses, and an expires_at so rows
 * self-expire instead of growing unboundedly. P06 owns any future Redis move - the contract
 * (check(key) refuses above the limit) stays identical.
 *
 * FAIL-CLOSED: a limiter storage error surfaces as RATE_LIMIT_UNAVAILABLE (503) - the route must
 * never silently degrade to unlimited because the counter broke. */

const LIMIT = 60;
const WINDOW_MS = 60000;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;

function fail(code, status) {
  const error = Error(code);
  error.code = code;
  if (status) error.status = status;
  throw error;
}

function createRateLimiter({ pool, limit = LIMIT, windowMs = WINDOW_MS, prefix = 'monetization' } = {}) {
  if (!pool || typeof pool.query !== 'function') fail('RATE_LIMIT_POOL_REQUIRED', 503);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100000) fail('RATE_LIMIT_CONFIG');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 3600000) fail('RATE_LIMIT_CONFIG');
  if (typeof prefix !== 'string' || !/^[a-z][a-z0-9_-]{0,40}$/.test(prefix)) fail('RATE_LIMIT_CONFIG');
  const clock = Date.now;
  const UPSERT = 'INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at) VALUES ($1, 1, $2)'
    + ' ON CONFLICT (bucket_id) DO UPDATE SET hits = ops.rate_buckets.hits + 1, expires_at = EXCLUDED.expires_at'
    + ' RETURNING hits';
  return Object.freeze({
    limit,
    windowMs,
    /* One call per request, BEFORE the command dispatch: an abusive client never reaches Core.
     * The optional now is the test clock seam - composition never passes it. */
    async check(key, at) {
      if (typeof key !== 'string' || !KEY_PATTERN.test(key)) fail('INVALID_RATE_KEY', 400);
      const now = typeof at === 'number' && Number.isFinite(at) ? at : clock();
      const window = Math.floor(now / windowMs);
      const bucketId = prefix + ':' + key + ':' + window;
      let hits;
      try {
        const r = await pool.query(UPSERT, [bucketId, new Date((window + 1) * windowMs).toISOString()]);
        hits = Number(r.rows[0].hits);
      } catch (error) {
        fail('RATE_LIMIT_UNAVAILABLE', 503);
      }
      if (hits > limit) fail('RATE_LIMITED', 429);
      return { allowed: true, hits };
    },
  });
}

module.exports = { createRateLimiter, LIMIT, WINDOW_MS, KEY_PATTERN };
