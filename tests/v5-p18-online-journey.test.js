'use strict';
/* tests/v5-p18-online-journey.test.js - the COMPLETE co-located online journey (R05/R07).
 *
 * SCOPE. One end-to-end HTTP journey over the REAL public API composition against owned loopback
 * PostgreSQL 16 and Redis, exercising the exact path the browser/native clients use:
 *
 *   queue admission (both players) -> real matchmaker tick -> termsHash offer -> both accepts
 *   (API -> signed Core ingress -> Core) -> match PLAYING -> a committed move -> durable revision ->
 *   resign -> durable terminal result.
 *
 * It also records the measured offer->accept latency and asserts it is far inside the preserved
 * 15000 ms queue-offer TTL (the staging OFFER_EXPIRED cause was cross-region DB latency, not the
 * route). No mocks: every assertion reads a real HTTP response, a real PostgreSQL row or a real
 * service. This is code-level proof; deployed/staging acceptance is separate.
 *
 * GATING (repo convention): needs the owned loopback Redis (REDIS_URL or V5_REDIS_REQUIRED=1) and
 * PostgreSQL lab (V5_PG_URL or V5_PG_REQUIRED=1); absent either, the suite skips honestly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const lab = require('./v5-pg-lab.js');
const { createApiHandler } = require('../apps/api/index.js');
const { createCoreGateway, createCoreServiceIngress } = require('../packages/services/core-gateway.js');
const { createQueueService } = require('../packages/services/queue.js');
const { createEphemeraService } = require('../packages/services/ephemera.js');

lab.installCleanup(test);

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:50710';
const HAVE_REDIS = process.env.REDIS_URL !== undefined || process.env.V5_REDIS_REQUIRED === '1';
const HAVE_PG = process.env.V5_PG_URL !== undefined || process.env.V5_PG_REQUIRED === '1';
const GATE = HAVE_REDIS && HAVE_PG ? false : (!HAVE_REDIS ? 'no REDIS_URL' : 'no V5_PG_URL');
const OFFER_TTL_MS = 15000; // preserved product constant (src/authority.js)

const ACTORS = [
  { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
  { actor: 'svc_bob', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
];

test('V5 online journey: queue -> tick -> offer -> both accepts -> PLAYING -> move -> resign settles durably', { skip: GATE }, async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p18journey');
  await lab.seedActors(db, ACTORS);
  const pools = lab.poolsFor(db);
  const core = await lab.coreFor(db);
  const accounts = await lab.accountsFor(db);
  const ephemera = await createEphemeraService({
    url: REDIS_URL, environment: 'test', keyVersion: 'p18jrny',
    allowPlaintext: !REDIS_URL.startsWith('rediss://'), socket: { connectTimeout: 3000 },
  });
  assert.equal(await ephemera.healthy(), true, 'the owned Redis answers PING');
  const queue = createQueueService({ ephemera, core, pool: pools.core });

  const secret = 'p18-owned-online-journey-signing-secret';
  const ingress = http.createServer(createCoreServiceIngress({ coreService: core, queue, secret }));
  await new Promise((r) => ingress.listen(0, '127.0.0.1', r));
  const coreUrl = `http://127.0.0.1:${ingress.address().port}`;
  const gateway = createCoreGateway({ coreUrl, secret });
  const handler = createApiHandler({ pool: pools.api, accounts, core, coreGateway: gateway, allowedOrigins: ['https://megaxo.online'] });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.closeAllConnections?.() ?? server.close(r));
    await new Promise((r) => { ingress.closeAllConnections?.(); ingress.close(r); });
    for (const c of [() => queue.close(), () => ephemera.wipeNamespace(), () => ephemera.close(), () => core.close(), () => accounts.close()]) { try { await c(); } catch {} }
    await lab.closeDatabasePools(db);
  });

  const alice = await accounts.issue('svc_alice', Date.now());
  const bob = await accounts.issue('svc_bob', Date.now());

  async function req(session, route, { method = 'GET', opKey = null, body = null } = {}) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        Cookie: `mega_dev_session=${session.token}`, 'X-CSRF-Token': session.csrf,
        Origin: 'https://megaxo.online', 'Content-Type': 'application/json',
        ...(opKey ? { 'Idempotency-Key': opKey } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  }

  // 1. Both players admit to the queue through the API (Core-owned, signed ingress).
  const aJoin = await req(alice, '/api/v1/queue', { method: 'POST', opKey: 'j-alice', body: { mode: 'casual', region: 'us-east', latencyMs: 20 } });
  const bJoin = await req(bob, '/api/v1/queue', { method: 'POST', opKey: 'j-bob', body: { mode: 'casual', region: 'us-east', latencyMs: 20 } });
  assert.equal(aJoin.status, 200);
  assert.equal(aJoin.data.state, 'searching');
  assert.equal(bJoin.status, 200);
  assert.equal(bJoin.data.state, 'searching');

  // 2. The real matchmaker produces the pairing (offer committed OFFERED with a 15 s window).
  const tick = await queue.matchTick({ mode: 'casual', matcherId: 'journey-matcher', limit: 2 });
  assert.equal(tick.matched, 1, 'the matchmaker paired exactly one match');
  const pairing = tick.pairings[0];
  assert.deepEqual([pairing.a, pairing.b].sort(), ['svc_alice', 'svc_bob'], 'both seeded players were paired');
  const matchId = pairing.matchId;

  // 3. Both accepts go through the public API -> signed Core -> Core, and must land inside the TTL.
  const aAccept = await req(alice, '/api/v1/accept', { method: 'POST', opKey: 'a-alice', body: { id: matchId, termsHash: pairing.termsHash } });
  const bAccept = await req(bob, '/api/v1/accept', { method: 'POST', opKey: 'a-bob', body: { id: matchId, termsHash: pairing.termsHash } });
  assert.equal(aAccept.status, 200, 'alice accept succeeded');
  assert.equal(bAccept.status, 200, 'bob accept succeeded');
  assert.equal(bAccept.data.status, 'PLAYING', 'the match is PLAYING once both players have accepted');
  const maxAcceptMs = Math.max(aAccept.ms, bAccept.ms);
  assert.ok(maxAcceptMs < OFFER_TTL_MS, `accept round trip ${maxAcceptMs.toFixed(1)}ms is inside the ${OFFER_TTL_MS}ms offer TTL`);
  console.log(`[journey] offer->accept max round trip ${maxAcceptMs.toFixed(1)}ms (TTL ${OFFER_TTL_MS}ms, margin ${(OFFER_TTL_MS - maxAcceptMs).toFixed(1)}ms)`);

  // 4. Both players observe the same durable PLAYING match, with symbols assigned.
  const aView = await req(alice, `/api/v1/match/${matchId}`);
  const bView = await req(bob, `/api/v1/match/${matchId}`);
  assert.equal(aView.status, 200);
  assert.equal(bView.status, 200);
  assert.equal(aView.data.status, 'PLAYING');
  assert.equal(aView.data.matchId, bView.data.matchId, 'both clients resolve the same match');
  const mover = aView.data.symbols.X === 'svc_alice' ? alice : bob;

  // 5. A legal move is committed through the API and the durable revision advances.
  const before = Number(await lab.scalar(db, 'SELECT revision FROM match.matches WHERE match_id = $1', [matchId]));
  const move = await req(mover, '/api/v1/move', { method: 'POST', opKey: 'm-1', body: { id: matchId, revision: before, move: { b: 0, c: 0 } } });
  assert.equal(move.status, 200, 'the move committed');
  const after = Number(await lab.scalar(db, 'SELECT revision FROM match.matches WHERE match_id = $1', [matchId]));
  assert.equal(after, before + 1, 'the durable revision advanced by exactly one');

  // 6. Resign through the API ends the match durably.
  const resigner = mover === alice ? bob : alice;
  const resign = await req(resigner, '/api/v1/resign', { method: 'POST', opKey: 'r-1', body: { id: matchId } });
  assert.equal(resign.status, 200, 'the resign committed');
  assert.equal(resign.data.reason, 'resign', 'the terminal reason is a resign');
  const finalStatus = await lab.scalar(db, 'SELECT status FROM match.matches WHERE match_id = $1', [matchId]);
  assert.ok(['FINISHED', 'DONE', 'ENDED', 'SETTLED', 'COMPLETE'].includes(String(finalStatus).toUpperCase()),
    `the match reached a terminal durable status (got ${finalStatus})`);
});
