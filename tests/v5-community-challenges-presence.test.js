'use strict';
/* Launch-fix tests (2026-10-18): the contracted /api/community/challenges and
 * /api/community/presence routes previously had no V5 implementation (the mounted API
 * answered 404 and signed clients showed a permanent "Connection interrupted" state).
 * These tests pin the route handlers, the dispatch wiring, the display projection and the
 * /api/v1/invitations provider path, using stubbed credentials - no database required.
 * The durable profile.challenges_for(text) function itself is exercised by the PG lanes. */
const test = require('node:test');
const assert = require('node:assert/strict');

const social = require('../apps/api/routes/social.js');
const compat = require('../apps/api/routes/compat.js');

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

function stubContext({ rows = [], heartbeat } = {}) {
  const queries = [];
  return {
    queries,
    pool: { query: async (text, params) => { queries.push({ text, params }); return { rows }; } },
    accounts: {
      requireLinked: async (token) => { if (!token) throw new Error('AUTH_REQUIRED'); return { actor: 'u_actor1', hash: 'sesshash' }; },
      heartbeat: heartbeat || (async (token, foreground) => ({ state: 'online', online: foreground })),
    },
  };
}

const FIXTURE_ROWS = [
  {
    match_id: 'm_direct_1', source: 'direct', status: 'OFFERED',
    terms: { kind: 'friend', rated: true, turnSeconds: 30 }, terms_hash: 'a'.repeat(64),
    quote: { rated: true, pool: 20, payout: 10 }, created: 1000, expires: 999000,
    players: ['u_challenger', 'u_actor1'], accepted: ['u_challenger'],
    player_names: { u_challenger: 'Challenger One', u_actor1: 'Actor One' },
  },
  {
    match_id: 'm_queue_1', source: 'queue', status: 'OFFERED',
    terms: { kind: 'casual', rated: false }, terms_hash: 'b'.repeat(64),
    quote: { rated: false, pool: 0 }, created: 2000, expires: 999000,
    players: ['u_actor1', 'u_random'], accepted: [],
    player_names: { u_actor1: 'Actor One', u_random: 'Random' },
  },
];

test('GET /api/community/challenges reads the 0063 projection, filters queue source and projects the display shape', async () => {
  const context = stubContext({ rows: FIXTURE_ROWS });
  const req = { url: '/api/community/challenges', method: 'GET', headers: {}, sessionToken: 'tok' };
  const res = mockRes();
  const handled = await social.handleSocialRoute(context, req, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(context.queries.length, 1);
  assert.match(context.queries[0].text, /profile\.challenges_for/);
  assert.deepEqual(context.queries[0].params, ['u_actor1']);
  const body = JSON.parse(res.body);
  assert.equal(body.length, 1, 'queue-sourced offers are excluded server-side');
  const item = body[0];
  assert.equal(item.id, 'm_direct_1');
  assert.equal(item.status, 'OFFERED');
  assert.equal(item.terms.source, 'direct');
  assert.equal(item.termsHash, 'a'.repeat(64));
  assert.deepEqual(item.quote, { rated: true, pool: 20, payout: 10 });
  assert.deepEqual(item.players, ['u_challenger', 'u_actor1']);
  assert.equal(item.challengerName, 'Challenger One');
  assert.equal(item.playerNames.u_actor1, 'Actor One');
  assert.equal(typeof item.serverNow, 'number');
});

test('POST /api/community/presence forwards the session token and foreground flag to accounts.heartbeat', async () => {
  let seen = null;
  const context = stubContext({ heartbeat: async (token, foreground) => { seen = { token, foreground }; return { state: 'online', online: true }; } });
  const req = { url: '/api/community/presence', method: 'POST', headers: {}, sessionToken: 'tok', body: JSON.stringify({ foreground: true }) };
  const res = mockRes();
  const handled = await social.handleSocialRoute(context, req, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, { token: 'tok', foreground: true });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.online, true);
  assert.equal(body.state, 'online');
});

test('unauthenticated challenge and presence calls are refused with AUTH_REQUIRED', async () => {
  const context = stubContext({});
  const get = { url: '/api/community/challenges', method: 'GET', headers: {} };
  const getRes = mockRes();
  await assert.rejects(() => social.handleSocialRoute(context, get, getRes), /AUTH_REQUIRED/);
  const post = { url: '/api/community/presence', method: 'POST', headers: {} };
  const postRes = mockRes();
  await assert.rejects(() => social.handleSocialRoute(context, post, postRes), /AUTH_REQUIRED/);
});

test('formatChallengeRow keeps the queue source for callers that need it', () => {
  const row = social.formatChallengeRow(FIXTURE_ROWS[1], 5000);
  assert.equal(row.id, 'm_queue_1');
  assert.equal(row.terms.source, 'queue');
  assert.equal(row.challengerName, 'Actor One');
  assert.equal(row.serverNow, 5000);
});

test('/api/v1/invitations consumes the injected challengesFor provider (no direct match.* grants)', async () => {
  let calledWith = null;
  const context = {
    accounts: { requireLinked: async () => ({ actor: 'u_actor1' }) },
    challengesFor: async (actor) => { calledWith = actor; return [{ id: 'm_direct_1', status: 'OFFERED', terms: { source: 'direct' }, players: ['u_challenger', 'u_actor1'], accepted: [] }]; },
  };
  const req = { url: '/api/v1/invitations', method: 'GET', headers: {}, sessionToken: 'tok' };
  const res = mockRes();
  await compat.handleGetInvitations(context, req, res);
  assert.equal(calledWith, 'u_actor1');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].id, 'm_direct_1');
  assert.equal(body[0].players[0], 'u_challenger');
});
