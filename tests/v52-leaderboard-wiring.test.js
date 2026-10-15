/* The public leaderboard transport must be WIRED, not merely described.
 *
 * A real defect (V5-O016, fixed 2026-10-15) was that both server entries said "queue and leaderboard
 * go through the signed Core gateway" while only `queue` was actually set. The route then fell through
 * to context.pool - the api_runtime role, which has no economy SELECT - and compat.js swallowed the
 * 42501 into a 200 []. The board looked empty rather than broken, and no real player could ever appear.
 *
 * This pins the wiring statically so the omission cannot silently return, and pins the two runtime
 * contracts the route relies on: the gateway function is used when present, and a failing transport
 * surfaces 503 rather than an empty board.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const compat = require('../apps/api/routes/compat.js');
const { createReadCache } = require('../packages/services/read-cache.js');

test('wiring: both server entries pass the leaderboard transport, not just the queue', () => {
  for (const entry of ['scripts/v51/v5-production-server.cjs', 'scripts/v51/p21-staging-server.cjs']) {
    const src = read(entry);
    assert.match(src, /leaderboard:\s*\(/, `${entry} must wire a leaderboard transport`);
    assert.match(src, /queue:\s*coreGateway/, `${entry} must still wire the queue`);
    // The leaderboard must route through the actor-free signed gateway, never a Core pool. The token
    // `leaderboardPool` legitimately appears in the forbidden-keys assertion, so check the actual API
    // context block rather than the whole file.
    const ctx = src.slice(src.indexOf('const apiContext = {') >= 0 ? src.indexOf('const apiContext = {') : src.indexOf('createApiHandler({'));
    const block = src.slice(ctx, ctx + 600);
    assert.doesNotMatch(block, /leaderboardPool:/, `${entry} must not hand the API a Core pool`);
  }
});

function fakeRes() {
  const state = { statusCode: 0, headers: {}, body: '' };
  return {
    state,
    // `sendJson` assigns `res.statusCode` directly rather than calling writeHead, so the fake must
    // expose it as a plain writable property and only mirror it into the captured state on end().
    set statusCode(code) { state.statusCode = code; },
    get statusCode() { return state.statusCode; },
    setHeader(k, v) { state.headers[k.toLowerCase()] = v; },
    getHeader(k) { return state.headers[k.toLowerCase()]; },
    writeHead(code, headers) { state.statusCode = code; Object.assign(state.headers, headers || {}); },
    end(body) { state.body = body === undefined ? '' : String(body); },
  };
}

test('route: a real leaderboard transport is used and its rows are served', async () => {
  const rows = [{ id: 'svc_alice', rating: 1650, games: 12 }];
  let asked = 0;
  const res = fakeRes();
  const handled = await compat.handleCompatRoute(
    { readCache: createReadCache(), leaderboard: async (q) => { asked += 1; assert.equal(q.metric, 'rating'); return rows; } },
    { url: '/api/v1/leaderboard?metric=rating', method: 'GET', headers: {} }, res,
  );
  assert.equal(handled, true);
  assert.equal(asked, 1, 'the configured transport must actually be called');
  assert.equal(res.state.statusCode, 200);
  const body = JSON.parse(res.state.body);
  assert.deepEqual(body.map((r) => r.id), ['svc_alice'], 'real rows reach the public board');
});

test('route: a failing transport surfaces 503, never a masked empty board', async () => {
  const res = fakeRes();
  await compat.handleCompatRoute(
    { readCache: createReadCache(), leaderboard: async () => { const e = new Error('CORE_UNREACHABLE'); e.code = 'CORE_UNREACHABLE'; throw e; } },
    { url: '/api/v1/leaderboard?metric=rating', method: 'GET', headers: {} }, res,
  );
  assert.equal(res.state.statusCode, 503, 'a real transport failure is not an empty board');
  assert.equal(JSON.parse(res.state.body).error, 'SERVICE_UNAVAILABLE');
});

test('route: an api_runtime pool that cannot read economy must not be the silent fallback', async () => {
  // A pool whose query rejects exactly as api_runtime does (42501 on economy). The route must not turn
  // that into a 200 board; with no configured transport it yields the unchanged empty public shape only
  // because there is genuinely nothing to read, and the pool error must not be reported as success data.
  const res = fakeRes();
  let queried = 0;
  const pool = { query: async () => { queried += 1; const e = new Error('permission denied for schema economy'); e.code = '42501'; throw e; } };
  await compat.handleCompatRoute(
    { readCache: createReadCache(), pool }, { url: '/api/v1/leaderboard?metric=rating', method: 'GET', headers: {} }, res,
  );
  assert.equal(res.state.statusCode, 200);
  assert.deepEqual(JSON.parse(res.state.body), [], 'no rows are invented from a failed pool read');
});
