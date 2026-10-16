'use strict';

/* LR12 negative-proof: the mounted commerce surface rate-limits per actor BEFORE the Core
 * round-trip (the legacy 60/min contract, 429 RATE_LIMITED), a different actor is unaffected, the
 * window rolls, and a limiter storage failure fails CLOSED (503) instead of silently degrading to
 * unlimited. No database: the counter is the ops.rate_buckets upsert, asserted against a
 * recording fake pool plus a source-integrity check that the facade actually wraps commands. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRateLimiter, LIMIT, WINDOW_MS } = require('../packages/services/rate-limit.js');

function fakePool() {
  const counters = new Map();
  return {
    queries: [],
    healthy: true,
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (!this.healthy) throw Error('CONNECTION_REFUSED');
      if (!sql.includes('ops.rate_buckets')) throw Error('UNEXPECTED_SQL');
      const id = params[0];
      const next = (counters.get(id) || 0) + 1;
      counters.set(id, next);
      return { rows: [{ hits: next }] };
    },
  };
}

test('rate limit: under the limit passes, the 61st distinct request in one window refuses 429', async () => {
  const pool = fakePool();
  const limiter = createRateLimiter({ pool, now: undefined });
  let now = Date.parse('2026-10-16T12:00:00Z');
  for (let i = 0; i < LIMIT; i += 1) {
    const r = await limiter.check('player_abc' + (i % 3), now);
    assert.equal(r.allowed, true);
  }
  /* A single actor hammering past the limit refuses with the frozen code and status. */
  for (let i = 0; i < LIMIT; i += 1) await limiter.check('player_spam', now);
  await assert.rejects(() => limiter.check('player_spam', now), (error) => error.code === 'RATE_LIMITED' && error.status === 429);
  /* A different actor in the same window is unaffected. */
  const other = await limiter.check('player_other', now);
  assert.equal(other.allowed, true);
});

test('rate limit: the window rolls and the budget resets', async () => {
  const pool = fakePool();
  const limiter = createRateLimiter({ pool });
  const t0 = Date.parse('2026-10-16T12:00:00Z');
  for (let i = 0; i < LIMIT; i += 1) await limiter.check('player_abc', t0);
  await assert.rejects(() => limiter.check('player_abc', t0), /RATE_LIMITED/);
  const nextWindow = t0 + WINDOW_MS;
  const r = await limiter.check('player_abc', nextWindow);
  assert.equal(r.allowed, true, 'a new window starts from one');
});

test('rate limit: malformed keys refuse, and a storage failure fails CLOSED with 503', async () => {
  const pool = fakePool();
  const limiter = createRateLimiter({ pool });
  await assert.rejects(() => limiter.check('bad actor'), (error) => error.code === 'INVALID_RATE_KEY' && error.status === 400);
  pool.healthy = false;
  await assert.rejects(() => limiter.check('player_abc'), (error) => error.code === 'RATE_LIMIT_UNAVAILABLE' && error.status === 503);
});

test('rate limit: source integrity - the facade wraps commands, the route maps the status', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'v51', 'v5-production-server.cjs'), 'utf8');
  assert.match(server, /createRateLimiter\(\{ pool: apiPool/, 'the limiter is composed on the api_runtime pool');
  assert.match(server, /monetizationLimiter\.check\(input\.actor\)/, 'every actor-bound command passes the limiter before the Core round-trip');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'routes', 'monetization.js'), 'utf8');
  assert.match(routes, /error\.status \|\|/, 'the route maps thrown statuses (429 RATE_LIMITED) onto the reply');
  assert.doesNotMatch(routes, /INSERT INTO ops\.rate_buckets/, 'the route file itself stays free of direct DB access');
});
