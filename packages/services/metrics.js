'use strict';

/* LR19 (2026-10-16): minimal OPTIONAL telemetry. The owner brief requires privacy-respecting
 * metrics for real ads, verified outcomes and user experience - and forbids inferring age/gender,
 * profiling minors from ad response, or joining optional research with commercial targeting.
 *
 * PRIVACY POSTURE (all three are structural, not policy):
 *   1. NO ACTOR BINDING - the route never resolves a session; counters are daily aggregates.
 *   2. NO FREE TEXT - only kinds from the frozen allow-list are accepted; no message, no payload.
 *   3. DAILY AGGREGATES ONLY - events collapse into one counter row per day per kind, so no
 *      per-event history exists to leak.
 * The counters reuse ops.rate_buckets (api_runtime already holds the grants) with a ~13-month
 * expiry; the existing purge removes them once lapsed. Client-side the lane is OPT-IN and OFF by
 * default; the server accepts batches from anyone (no auth) but the client never sends before the
 * explicit choice. */

const EVENT_KINDS = Object.freeze([
  'ad_shown',
  'ad_earned',
  'ad_failed',
  'match_completed_win',
  'match_completed_loss',
  'match_completed_draw',
  'session_started',
]);

const MAX_BATCH = 32;
const COUNTER_TTL_MS = 400 * 24 * 60 * 60 * 1000; /* ~13 months; the purge removes lapsed rows */

const fail = (code) => { const e = Error(code); e.code = code; throw e; };

function dayBucket(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function createMetricsSink({ pool, now } = {}) {
  if (!pool || typeof pool.query !== 'function') fail('METRICS_POOL_REQUIRED');
  const clock = typeof now === 'function' ? now : Date.now;
  const UPSERT = 'INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at) VALUES ($1, $2, $3)'
    + ' ON CONFLICT (bucket_id) DO UPDATE SET hits = ops.rate_buckets.hits + $2,'
    + ' expires_at = EXCLUDED.expires_at';
  return Object.freeze({
    eventKinds: EVENT_KINDS,
    async batch(events) {
      if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH) fail('METRICS_BATCH_INVALID');
      const day = dayBucket(clock());
      const seen = new Set();
      for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) fail('METRICS_EVENT_INVALID');
        if (typeof event.kind !== 'string' || !EVENT_KINDS.includes(event.kind)) fail('METRICS_KIND_UNKNOWN');
        const count = event.count === undefined ? 1 : event.count;
        if (!Number.isSafeInteger(count) || count < 1 || count > 100) fail('METRICS_COUNT_INVALID');
        const id = 'metrics:' + day + ':' + event.kind;
        if (seen.has(id)) continue;
        seen.add(id);
        await pool.query(UPSERT, [id, count, new Date(clock() + COUNTER_TTL_MS)]);
      }
      return { accepted: seen.size };
    },
  });
}

module.exports = { createMetricsSink, EVENT_KINDS, MAX_BATCH, COUNTER_TTL_MS };
