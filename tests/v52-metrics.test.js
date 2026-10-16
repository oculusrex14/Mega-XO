'use strict';

/* Offline unit proof for the LR19 telemetry slice: the sink writes ONLY daily-aggregate counters
 * for allow-listed kinds (no actor column, no free text, bounded counts), the route refuses
 * unknown kinds and oversized batches, and the client lane is OFF unless explicitly opted in. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMetricsSink, EVENT_KINDS } = require('../packages/services/metrics.js');
const { createTelemetryLane, telemetryOptedIn, setTelemetryOptIn } = require('../apps/web/metrics.js');

function fakePool() {
  const queries = [];
  return { pool: { query: async (text, params) => { queries.push({ text, params }); return { rows: [], rowCount: 1 }; } }, queries };
}

test('sink: a valid batch upserts one daily counter per kind with the day in the bucket id', async () => {
  const { pool, queries } = fakePool();
  const sink = createMetricsSink({ pool, now: () => Date.UTC(2026, 9, 16, 12) });
  const result = await sink.batch([{ kind: 'ad_earned' }, { kind: 'match_completed_win', count: 3 }]);
  assert.equal(result.accepted, 2);
  assert.equal(queries.length, 2);
  assert.match(queries[0].params[0], /^metrics:2026-10-16:ad_earned$/);
  assert.equal(queries[0].params[1], 1);
  assert.match(queries[1].params[0], /^metrics:2026-10-16:match_completed_win$/);
  assert.equal(queries[1].params[1], 3);
});

test('sink: unknown kinds, bad counts, and invalid batches refuse', async () => {
  const { pool } = fakePool();
  const sink = createMetricsSink({ pool, now: () => Date.UTC(2026, 9, 16, 12) });
  await assert.rejects(() => sink.batch([{ kind: 'age_band_42' }]), /METRICS_KIND_UNKNOWN/);
  await assert.rejects(() => sink.batch([{ kind: 'ad_earned', count: 0 }]), /METRICS_COUNT_INVALID/);
  await assert.rejects(() => sink.batch([{ kind: 'ad_earned', count: 999 }]), /METRICS_COUNT_INVALID/);
  await assert.rejects(() => sink.batch([]), /METRICS_BATCH_INVALID/);
  await assert.rejects(() => sink.batch(new Array(33).fill({ kind: 'ad_earned' })), /METRICS_BATCH_INVALID/);
  await assert.rejects(() => sink.batch('not-an-array'), /METRICS_BATCH_INVALID/);
});

test('sink: the allow-list carries no identity-bearing or free-text kinds', () => {
  for (const kind of EVENT_KINDS) assert.match(kind, /^[a-z_]+$/);
  assert.equal(EVENT_KINDS.includes('age_band'), false);
  assert.equal(EVENT_KINDS.includes('gender'), false);
  assert.equal(EVENT_KINDS.includes('location'), false);
  assert.equal(EVENT_KINDS.includes('note'), false);
});

test('client lane: OFF by default; the explicit opt-in flag enables it', () => {
  const storage = { store: new Map(), getItem(k) { return this.store.get(k) || null; }, setItem(k, v) { this.store.set(k, v); }, removeItem(k) { this.store.delete(k); } };
  assert.equal(telemetryOptedIn(storage), false, 'no flag = off');
  setTelemetryOptIn(storage, true);
  assert.equal(telemetryOptedIn(storage), true);
  setTelemetryOptIn(storage, false);
  assert.equal(telemetryOptedIn(storage), false, 'opt-out removes the flag entirely');
  const lane = createTelemetryLane({ storage, request: async () => {} });
  assert.equal(lane, null, 'a non-opted storage produces NO lane at all');
});
