'use strict';
/* tests/v5-p11-core-gateway.test.js - V5 Phase 11 Task V5-11-03.
 *
 * SCOPE & CONTRACT:
 * Validates the V5 Core Gateway and Ingress transaction boundary
 * (`packages/services/core-gateway.js`, `apps/api/routes/competitive.js`, `apps/api/index.js`)
 * on real loopback PostgreSQL 16 using guarded `api_runtime` and `core_runtime` pools.
 *
 * VERIFICATION TARGETS:
 * 1. Signed command execution:
 *    - API gateway signs command payload with HMAC-SHA256 over timestamp:method:path:actor:opKey:bodyHash.
 *    - Ingress verifies signature, timestamp, and actor.
 *    - Dispatches valid command to coreService.run({ actor, scope: 'player' }, opKey, command).
 *    - Returns committed result from Core (e.g. coin-to-crown convert); updates wallet and ledger in PG.
 * 2. Forgery and tampering rejection:
 *    - Tampered payload rejected with 403 INVALID_SERVICE_SIGNATURE.
 *    - Forged actor ID header rejected with 403 INVALID_SERVICE_SIGNATURE.
 *    - Wrong secret rejected with 403 INVALID_SERVICE_SIGNATURE.
 *    - Corrupted or missing signature rejected with 403 INVALID_SERVICE_SIGNATURE.
 *    - PG database remains unmutated across all rejection scenarios.
 * 3. Timestamp drift rejection:
 *    - Expired timestamp (> maxDriftMs, default 30s) rejected with 401 REQUEST_EXPIRED.
 *    - Future timestamp beyond drift window rejected with 401 REQUEST_EXPIRED.
 *    - PG database remains unmutated.
 * 4. OpKey idempotency:
 *    - Replaying command with same opKey returns prior Core outcome without re-executing.
 *    - Wallet and ledger are debited/credited exactly once.
 *    - Replaying same opKey with conflicting payload rejected with IDEMPOTENCY_CONFLICT (409).
 * 5. Ticket ingress:
 *    - Gateway requestTicket sends signed request to /ingress/ticket.
 *    - Ingress verifies signature and returns ticket outcome.
 * 6. End-to-end API competitive routes:
 *    - Vercel API handler routes competitive endpoints (/api/v1/convert) to Core via coreGateway.
 *    - Propagates actor, idempotency key, and returns committed result.
 *    - Unauthenticated request rejected with 401 AUTH_REQUIRED.
 * 7. Strict database least privilege:
 *    - api_runtime pool cannot write directly to economy.wallets or economy.ledger.
 *    - Direct UPDATE/INSERT/DELETE statements throw PostgreSQL error 42501 (permission denied).
 * 8. Clean teardown with lab.installCleanup: no lingering handles or open sockets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const lab = require('./v5-pg-lab.js');

const { createCoreGateway, createCoreServiceIngress } = require('../packages/services/core-gateway.js');
const { createApiHandler } = require('../apps/api/index.js');
const { createTicketIssuer } = require('../packages/services/tickets.js');

/* Register top-level cleanup of synthetic PG16 databases and guarded connection pools */
lab.installCleanup(test);

const TEST_SECRET = 'v5-p11-test-core-gateway-shared-secret-32b';
const WRONG_SECRET = 'v5-p11-wrong-tampered-secret-key-32b';

/* ---------------------------------------------------------------- Test Fixtures */

function computeSignature(secret, { timestamp, method, path, actor, opKey, bodyHash }) {
  const payload = `${timestamp}:${method}:${path}:${actor}:${opKey}:${bodyHash}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function hashBody(body) {
  const str = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Starts a real loopback HTTP server running the ingress handler.
 */
function startIngressServer(ingressHandler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(ingressHandler);
    const sockets = new Set();
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        url,
        close: async () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          server.closeAllConnections?.();
          server.closeIdleConnections?.();
          if (server.listening) {
            await new Promise((res) => {
              server.close(() => res());
              setTimeout(res, 50).unref();
            });
          }
        },
      });
    });
    server.on('error', reject);
  });
}

/**
 * Issues a low-level HTTP request to ingress with explicit custom headers.
 */
function rawIngressRequest(baseUrl, routePath, { method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const u = new URL(routePath, baseUrl);
    const req = http.request(u, {
      method,
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyStr),
        connection: 'close',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
        });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
function testHttpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const method = options.method || 'POST';
    const bodyStr = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : '';
    const reqHeaders = { ...options.headers, connection: 'close' };
    if (bodyStr) reqHeaders['content-length'] = Buffer.byteLength(bodyStr);

    const req = http.request(u, {
      method,
      agent: false,
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusCode: res.statusCode,
          headers: res.headers,
          text: async () => data,
          json: async () => JSON.parse(data),
        });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Issues a request to the Vercel API handler.
 */
async function apiRequest(target, routePath, { method = 'GET', actor = null, token = null, body = null, headers = {} } = {}) {
  const handler = (target && typeof target === 'object' && target.handler) ? target.handler : target;
  const req = new EventEmitter();
  req.method = method;
  req.url = routePath;
  req.headers = { ...headers };
  // P11 gateway tests obtain a real session, never a spoofable actor header.
  if (actor && !token) {
    if (!target?._testAccounts?.issue) throw new Error('TEST_AUTHORITY_REQUIRED');
    target._testSessions ||= new Map();
    if (!target._testSessions.has(actor)) {
      target._testSessions.set(actor, target._testAccounts.issue(actor, Date.now()));
    }
    token = (await target._testSessions.get(actor)).token;
  }
  if (token) req.headers['authorization'] = `Bearer ${token}`;
  req.body = body;

  return new Promise(async (resolve, reject) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const responseHeaders = {};
    res.setHeader = (k, v) => { responseHeaders[k.toLowerCase()] = v; };
    res.getHeader = (k) => responseHeaders[k.toLowerCase()];
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (data) => {
      resolve({ status: res.statusCode, headers: responseHeaders, data });
    };
    res.end = (chunk) => {
      let data = null;
      if (chunk) {
        try { data = JSON.parse(chunk); } catch { data = chunk; }
      }
      resolve({ status: res.statusCode, headers: responseHeaders, data });
    };

    try {
      await handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

/* ==========================================================================
 * 1. Module Export Verification
 * ========================================================================== */

test('1. Core Gateway & Ingress modules export createCoreGateway and createCoreServiceIngress', () => {
  const direct = require('../packages/services/core-gateway.js');
  const index = require('../packages/services/index.js');

  assert.equal(typeof direct.createCoreGateway, 'function', 'direct createCoreGateway export');
  assert.equal(typeof direct.createCoreServiceIngress, 'function', 'direct createCoreServiceIngress export');
  assert.equal(typeof index.createCoreGateway, 'function', 'index createCoreGateway export');
  assert.equal(typeof index.createCoreServiceIngress, 'function', 'index createCoreServiceIngress export');
});

/* ==========================================================================
 * 2. Signed Command Execution (End-to-end to real Core & PG16)
 * ========================================================================== */

test('2. Signed command execution: API gateway sends signed request, Core verifies and executes command', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_cmd');
  await lab.seedActors(db, lab.SEED_ACTORS);

  const pools = lab.poolsFor(db);
  const core = await lab.coreFor(db);

  const ingress = createCoreServiceIngress({
    coreService: core,
    secret: TEST_SECRET,
  });
  const ingressServer = await startIngressServer(ingress);

  t.after(async () => {
    await ingressServer.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  const gateway = createCoreGateway({
    coreUrl: ingressServer.url,
    secret: TEST_SECRET,
    fetcher: testHttpFetch,
  });

  // Verify initial wallet state for svc_alice: 1000 coins, 100 crowns
  const initialCoins = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
  const initialCrowns = await lab.scalar(db, "SELECT crowns FROM economy.wallets WHERE actor_id = 'svc_alice'");
  assert.equal(Number(initialCoins), 1000, 'initial coins 1000');
  assert.equal(Number(initialCrowns), 100, 'initial crowns 100');

  // Forward convert command: convert 100 coins to 10 crowns
  const outcome = await gateway.forwardCommand({
    actor: 'svc_alice',
    opKey: 'op-signed-convert-01',
    command: { type: 'convert', from: 'coins', amount: 100 },
  });

  assert.ok(outcome, 'outcome returned');
  const r1 = (outcome && typeof outcome === 'object' && outcome.result) ? outcome.result : outcome;
  assert.equal(r1.from, 'coins', 'outcome converted from coins');
  assert.equal(r1.to, 'crowns', 'outcome converted to crowns');
  assert.equal(r1.debit, 100, 'outcome debited 100 coins');
  assert.equal(r1.credit, 10, 'outcome credited 10 crowns');

  // Verify PostgreSQL mutation in durable tables under core_runtime
  const afterCoins = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
  const afterCrowns = await lab.scalar(db, "SELECT crowns FROM economy.wallets WHERE actor_id = 'svc_alice'");
  assert.equal(Number(afterCoins), 900, 'coins debited by 100');
  assert.equal(Number(afterCrowns), 110, 'crowns credited by 10');

  // Verify economy.ledger has durable journal records for the operation
  const outcomeCount = await lab.scalar(db, "SELECT count(*)::int FROM economy.command_outcomes WHERE actor_id = 'svc_alice' AND \"key\" = to_json('op-signed-convert-01'::text)::text");
  assert.equal(Number(outcomeCount), 1, 'command outcome recorded for the operation');
  const ledgerCount = await lab.scalar(db, "SELECT count(*)::int FROM economy.ledger WHERE actor_id = 'svc_alice' AND source = 'conversion'");
  assert.equal(Number(ledgerCount), 2, 'ledger contains debit and credit conversion entries');
});

/* ==========================================================================
 * 3. Forgery and Tampering Rejection (403 INVALID_SERVICE_SIGNATURE)
 * ========================================================================== */

test('3. Forgery rejection: tampered payload, forged actor ID, wrong secret, or bad signature rejected with 403', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_forgery');
  await lab.seedActors(db, lab.SEED_ACTORS);

  const core = await lab.coreFor(db);
  const ingress = createCoreServiceIngress({
    coreService: core,
    secret: TEST_SECRET,
  });
  const ingressServer = await startIngressServer(ingress);

  t.after(async () => {
    await ingressServer.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  const now = Date.now();
  const validBody = { command: { type: 'convert', from: 'coins', amount: 100 } };
  const validBodyStr = JSON.stringify(validBody);
  const validBodyHash = hashBody(validBodyStr);

  // A. Tampered Payload: signature created for amount 100, but payload modified to amount 200
  {
    const tamperedBody = { command: { type: 'convert', from: 'coins', amount: 200 } };
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now,
      method: 'POST',
      path: '/ingress/command',
      actor: 'svc_alice',
      opKey: 'op-forgery-01',
      bodyHash: validBodyHash,
    });

    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': 'svc_alice',
        'x-service-opkey': 'op-forgery-01',
        'x-service-signature': sig,
      },
      body: tamperedBody,
    });

    assert.equal(res.status, 403, 'tampered payload rejected with 403');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE', 'error code INVALID_SERVICE_SIGNATURE');
  }

  // B. Forged Actor ID: signature created for svc_alice, but header x-service-actor changed to svc_bob
  {
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now,
      method: 'POST',
      path: '/ingress/command',
      actor: 'svc_alice',
      opKey: 'op-forgery-02',
      bodyHash: validBodyHash,
    });

    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': 'svc_bob', // Forged actor
        'x-service-opkey': 'op-forgery-02',
        'x-service-signature': sig,
      },
      body: validBody,
    });

    assert.equal(res.status, 403, 'forged actor header rejected with 403');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE');
  }

  // C. Wrong Secret: signed with non-matching secret
  {
    const wrongSig = computeSignature(WRONG_SECRET, {
      timestamp: now,
      method: 'POST',
      path: '/ingress/command',
      actor: 'svc_alice',
      opKey: 'op-forgery-03',
      bodyHash: validBodyHash,
    });

    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': 'svc_alice',
        'x-service-opkey': 'op-forgery-03',
        'x-service-signature': wrongSig,
      },
      body: validBody,
    });

    assert.equal(res.status, 403, 'wrong secret signature rejected with 403');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE');
  }

  // D. Corrupted Signature Header
  {
    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': 'svc_alice',
        'x-service-opkey': 'op-forgery-04',
        'x-service-signature': 'deadbeef0123456789abcdef',
      },
      body: validBody,
    });

    assert.equal(res.status, 403, 'corrupted signature rejected with 403');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE');
  }

  // E. Missing Signature Header
  {
    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': 'svc_alice',
        'x-service-opkey': 'op-forgery-05',
      },
      body: validBody,
    });

    assert.equal(res.status, 403, 'missing signature header rejected with 403');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE');
  }

  // Ensure database remained completely untouched
  const aliceCoins = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
  assert.equal(Number(aliceCoins), 1000, 'svc_alice wallet untouched after forgery attempts');
});

/* ==========================================================================
 * 4. Timestamp Drift Rejection (401 REQUEST_EXPIRED)
 * ========================================================================== */

test('4. Timestamp drift rejection: request with expired timestamp (> 30s) rejected with REQUEST_EXPIRED', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_drift');
  await lab.seedActors(db, lab.SEED_ACTORS);

  const core = await lab.coreFor(db);
  const ingress = createCoreServiceIngress({
    coreService: core,
    secret: TEST_SECRET,
    maxDriftMs: 30000,
  });
  const ingressServer = await startIngressServer(ingress);

  t.after(async () => {
    await ingressServer.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  const validBody = { command: { type: 'convert', from: 'coins', amount: 100 } };
  const validBodyHash = hashBody(validBody);

  // A. Stale timestamp: 60 seconds in the past (> 30s maxDriftMs)
  {
    const staleTime = Date.now() - 60000;
    const sig = computeSignature(TEST_SECRET, {
      timestamp: staleTime,
      method: 'POST',
      path: '/ingress/command',
      actor: 'svc_alice',
      opKey: 'op-drift-stale',
      bodyHash: validBodyHash,
    });

    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(staleTime),
        'x-service-actor': 'svc_alice',
        'x-service-opkey': 'op-drift-stale',
        'x-service-signature': sig,
      },
      body: validBody,
    });

    assert.equal(res.status, 401, 'expired timestamp rejected with 401');
    assert.equal(res.data.error, 'REQUEST_EXPIRED');
  }

  // B. Future timestamp: 60 seconds into future (> 30s maxDriftMs)
  {
    const futureTime = Date.now() + 60000;
    const sig = computeSignature(TEST_SECRET, {
      timestamp: futureTime,
      method: 'POST',
      path: '/ingress/command',
      actor: 'svc_alice',
      opKey: 'op-drift-future',
      bodyHash: validBodyHash,
    });

    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(futureTime),
        'x-service-actor': 'svc_alice',
        'x-service-opkey': 'op-drift-future',
        'x-service-signature': sig,
      },
      body: validBody,
    });

    assert.equal(res.status, 401, 'future timestamp beyond max drift rejected with 401');
    assert.equal(res.data.error, 'REQUEST_EXPIRED');
  }

  // Ensure database remained untouched
  const aliceCoins = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
  assert.equal(Number(aliceCoins), 1000, 'svc_alice wallet untouched after expired timestamp attempts');
});

/* ==========================================================================
 * 5. OpKey Idempotency
 * ========================================================================== */

test('5. OpKey idempotency: retried command with same opKey returns prior Core outcome without second execution', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_idem');
  await lab.seedActors(db, lab.SEED_ACTORS);

  const core = await lab.coreFor(db);
  const ingress = createCoreServiceIngress({
    coreService: core,
    secret: TEST_SECRET,
  });
  const ingressServer = await startIngressServer(ingress);

  t.after(async () => {
    await ingressServer.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  const gateway = createCoreGateway({
    coreUrl: ingressServer.url,
    secret: TEST_SECRET,
    fetcher: testHttpFetch,
  });

  const opKey = 'op-idem-convert-99';
  const command = { type: 'convert', from: 'coins', amount: 100 };

  // 1. Initial execution
  const firstOutcome = await gateway.forwardCommand({
    actor: 'svc_alice',
    opKey,
    command,
  });
  const o1 = (firstOutcome && typeof firstOutcome === 'object' && firstOutcome.result) ? firstOutcome.result : firstOutcome;
  assert.equal(o1.debit, 100);
  assert.equal(o1.credit, 10);

  const coinsAfterFirst = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
  assert.equal(Number(coinsAfterFirst), 900, 'first call debited 100 coins');

  // 2. Exact same command replay with same opKey
  const secondOutcome = await gateway.forwardCommand({
    actor: 'svc_alice',
    opKey,
    command,
  });

  const o2 = (secondOutcome && typeof secondOutcome === 'object' && secondOutcome.result) ? secondOutcome.result : secondOutcome;
  assert.equal(o2.debit, o1.debit, 'replayed call returns identical debit');
  assert.equal(o2.credit, o1.credit, 'replayed call returns identical credit');
  assert.equal(o2.id, o1.id, 'replayed call returns identical outcome id');

  // Verify wallet was NOT debited a second time
  const coinsAfterSecond = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
  assert.equal(Number(coinsAfterSecond), 900, 'replayed command did NOT deduct coins a second time');

  // 3. Replay with conflicting command payload on same opKey should reject with IDEMPOTENCY_CONFLICT
  await assert.rejects(
    () => gateway.forwardCommand({
      actor: 'svc_alice',
      opKey,
      command: { type: 'convert', from: 'coins', amount: 200 }, // Conflicting payload
    }),
    (err) => err.message.includes('IDEMPOTENCY_CONFLICT') || err.message.includes('409'),
    'conflicting payload with same opKey rejected'
  );
});

/* ==========================================================================
 * 6. Ticket Ingress Verification
 * ========================================================================== */

test('6. Ticket ingress: requestTicket sends signed request and receives valid ticket response', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_ticket');
  await lab.seedActors(db, lab.SEED_ACTORS);

  const core = await lab.coreFor(db);
  const pools = lab.poolsFor(db);
  const accounts = await lab.accountsFor(db);
  const session = await accounts.issue('svc_alice', Date.now());
  const binding = await accounts.accessBinding(session.token);
  const ticketIssuer = await createTicketIssuer(pools.api, { environment: 'stg', audience: 'mega-core' });
  const ingress = createCoreServiceIngress({ coreService: core, secret: TEST_SECRET, ticketIssuer });
  const ingressServer = await startIngressServer(ingress);

  t.after(async () => {
    await ingressServer.close();
    await ticketIssuer.close();
    await accounts.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  const gateway = createCoreGateway({
    coreUrl: ingressServer.url,
    secret: TEST_SECRET,
    fetcher: testHttpFetch,
  });

  const handler = createApiHandler({ pool: pools.api, accounts, coreGateway: gateway, ticketIssuer });
  const apiServer = await startIngressServer(handler);
  t.after(async () => { await apiServer.close(); });
  for (const body of [
    { sessionId: 'foreign-session' }, { generation: binding.generation + 1 },
    { actor: 'svc_bob' }, { connectionClass: 'android' }, { environment: 'prod' },
    { audience: 'attacker' },
  ]) {
    const rejected = await rawIngressRequest(apiServer.url, '/api/v1/ticket', {
      method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body,
    });
    assert.equal(rejected.status, 400, 'ticket identity is never supplied by the caller');
  }
  assert.equal(Number(await lab.scalar(db, 'SELECT count(*) FROM identity.realtime_tickets')), 0);
  const bobSession = await accounts.issue('svc_bob', Date.now());
  const bobBinding = await accounts.accessBinding(bobSession.token);
  await assert.rejects(() => gateway.requestTicket({
    actor: binding.actor,
    session: { actor: bobBinding.actor, sessionId: bobBinding.sessionId,
      generation: bobBinding.generation, connectionClass: bobBinding.connectionClass },
  }), (error) => error.status >= 400,
  'nested foreign actor/session cannot override signed principal at real Core issuer');
  assert.equal(Number(await lab.scalar(db, 'SELECT count(*) FROM identity.realtime_tickets')), 0,
    'forged signed nested binding creates no durable ticket for either actor');
  const issued = await rawIngressRequest(apiServer.url, '/api/v1/ticket', {
    method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: {},
  });
  assert.equal(issued.status, 200);
  assert.equal(typeof issued.data.ticket, 'string');
  assert.equal(await lab.scalar(db, 'SELECT actor_id FROM identity.realtime_tickets'), binding.actor);
  assert.equal(await lab.scalar(db, 'SELECT session_id FROM identity.realtime_tickets'), binding.sessionId);
  assert.equal(Number(await lab.scalar(db, 'SELECT generation FROM identity.realtime_tickets')), binding.generation);
  assert.equal(await lab.scalar(db, 'SELECT connection_class FROM identity.realtime_tickets'), binding.connectionClass);
});

/* ==========================================================================
 * 7. End-to-end API Competitive Routes Integration
 * ========================================================================== */

test('7. Competitive API routes: /api/v1/convert routes through coreGateway to Core', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_api');
  await lab.seedActors(db, lab.SEED_ACTORS);

  const pools = lab.poolsFor(db);
  const accounts = await lab.accountsFor(db);
  const core = await lab.coreFor(db);

  const ingress = createCoreServiceIngress({
    coreService: core,
    secret: TEST_SECRET,
  });
  const ingressServer = await startIngressServer(ingress);

  const gateway = createCoreGateway({
    coreUrl: ingressServer.url,
    secret: TEST_SECRET,
    fetcher: testHttpFetch,
  });

  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    coreGateway: gateway,
  });
  handler._testAccounts = accounts;

  t.after(async () => {
    await ingressServer.close();
    await accounts.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  // A0. A browser can forge actor headers, but they must never become a Core principal.
  for (const headers of [
    { 'x-actor-id': 'svc_alice' },
    { 'x-test-actor': 'svc_alice' },
    { 'x-actor-id': 'svc_alice', authorization: 'Bearer invalid-token' },
  ]) {
    const forged = await apiRequest(handler, '/api/v1/convert', {
      method: 'POST',
      headers,
      body: { from: 'coins', amount: 100 },
    });
    assert.equal(forged.status, 401, 'unverified headers cannot authorize economic commands');
    assert.equal(forged.data.error, 'AUTH_REQUIRED');
  }
  assert.equal(Number(await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'")), 1000,
    'forged requests did not change the wallet');

  // A. Unauthenticated request rejected
  {
    const res = await apiRequest(handler, '/api/v1/convert', {
      method: 'POST',
      body: { from: 'coins', amount: 100 },
    });
    assert.equal(res.status, 401, 'unauthenticated request rejected with 401');
  }

  // B. Authenticated convert request
  {
    const res = await apiRequest(handler, '/api/v1/convert', {
      method: 'POST',
      actor: 'svc_alice',
      headers: {
        'idempotency-key': 'api-convert-01',
      },
      body: { from: 'coins', amount: 100 },
    });

    assert.equal(res.status, 200, 'authenticated convert request succeeds');
  const d1 = (res.data && typeof res.data === 'object' && res.data.result) ? res.data.result : res.data;
  assert.equal(d1.debit, 100, 'debit recorded in API response');
  assert.equal(d1.credit, 10, 'credit recorded in API response');

    // Verify database reflection
    const coins = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
    assert.equal(Number(coins), 900, 'wallet coins decremented to 900');
  }

  // C. Idempotent replay of API request returns cached outcome
  {
    const res = await apiRequest(handler, '/api/v1/convert', {
      method: 'POST',
      actor: 'svc_alice',
      headers: {
        'idempotency-key': 'api-convert-01',
      },
      body: { from: 'coins', amount: 100 },
    });

    assert.equal(res.status, 200, 'replayed request succeeds');
  const d2 = (res.data && typeof res.data === 'object' && res.data.result) ? res.data.result : res.data;
  assert.equal(d2.debit, 100);

    const coins = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
    assert.equal(Number(coins), 900, 'no second debit in database');
  }
});

/* ==========================================================================
 * 7b. Competitive API routes: offer/accept/decline/cancel resolve through the
 *     signed Core ingress and commit the durable outcome (V5-11-03).
 * ========================================================================== */

test('7b. Competitive API routes: offer -> accept -> decline -> cancel through signed Core ingress', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_offer');
  /* Distinct offer pairs: direct ranked pair limits and one-active-match rules are
   * Core-owned, so each scenario uses its own opponent and the accept that commits
   * PLAYING runs LAST (an active match blocks every further offer from that actor). */
  await lab.seedActors(db, [
    { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
    { actor: 'svc_bob', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
    { actor: 'svc_carol', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
    { actor: 'svc_dave', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
  ]);

  const pools = lab.poolsFor(db);
  const accounts = await lab.accountsFor(db);
  const core = await lab.coreFor(db);

  const ingress = createCoreServiceIngress({
    coreService: core,
    secret: TEST_SECRET,
  });
  const ingressServer = await startIngressServer(ingress);

  const gateway = createCoreGateway({
    coreUrl: ingressServer.url,
    secret: TEST_SECRET,
    fetcher: testHttpFetch,
  });

  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    coreGateway: gateway,
  });

  t.after(async () => {
    await ingressServer.close();
    await accounts.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  /* Cookie-authenticated linked sessions, exactly like the real browser client: the
   * API composition enforces Origin/CSRF and resolveAuth binds the actor server-side. */
  const sessions = new Map();
  async function cookieFor(actor) {
    if (!sessions.has(actor)) sessions.set(actor, await accounts.issue(actor, Date.now()));
    return sessions.get(actor);
  }
  const cookieRequest = async (actor, routePath, { body, opKey, csrf = true } = {}) => {
    const session = await cookieFor(actor);
    const headers = { cookie: `mega_dev_session=${session.token}`, origin: 'https://megaxo.online' };
    if (csrf) headers['x-csrf-token'] = session.csrf;
    if (opKey !== undefined) headers['idempotency-key'] = opKey;
    return apiRequest(handler, routePath, { method: 'POST', body, headers });
  };

  /* Direct ranked Gold-vs-Gold: the Core quote minimum for a leaderboard pot is
   * 2*ceil(65*8/16)=66 Crowns; 80 is an even pot above the minimum that the
   * challenger (who seeds the whole pot) can fund from 100 Crowns. */
  const TERMS = { kind: 'leaderboard', amount: 80 };

  // A. Authenticated linked offer commits a real OFFERED match in Core.
  const offer = await cookieRequest('svc_alice', '/api/v1/offer', {
    opKey: 'api-offer-01',
    body: { id: 'api-match-accept', opponent: 'svc_bob', terms: TERMS },
  });
  assert.equal(offer.status, 200, 'authenticated offer succeeds');
  assert.equal(offer.data.status, 'OFFERED', 'the committed Core view is OFFERED');
  assert.equal(offer.data.players[0], 'svc_alice', 'the offer principal is the server-resolved actor');
  assert.equal(typeof offer.data.termsHash, 'string', 'the committed terms hash is returned');
  {
    const view = await core.readMatch('svc_alice', 'api-match-accept');
    assert.equal(view.status, 'OFFERED', 'durable match row reflects the committed offer');
  }

  // B. Two more distinct offers for the decline/cancel scenarios.
  const declineOffer = await cookieRequest('svc_alice', '/api/v1/offer', {
    opKey: 'api-offer-decline',
    body: { id: 'api-match-decline', opponent: 'svc_carol', terms: TERMS },
  });
  assert.equal(declineOffer.status, 200, 'second distinct offer succeeds');
  const cancelOffer = await cookieRequest('svc_alice', '/api/v1/offer', {
    opKey: 'api-offer-cancel',
    body: { id: 'api-match-cancel', opponent: 'svc_dave', terms: TERMS },
  });
  assert.equal(cancelOffer.status, 200, 'third distinct offer succeeds');

  // C. A wrong actor (not a participant) cannot accept another pair's offer.
  {
    const res = await cookieRequest('svc_dave', '/api/v1/accept', {
      opKey: 'api-accept-wrongactor',
      body: { id: 'api-match-accept', termsHash: offer.data.termsHash },
    });
    assert.equal(res.status, 409, 'a non-participant accept is refused by Core');
    assert.equal(res.data.error, 'NOT_PARTICIPANT');
    const view = await core.readMatch('svc_alice', 'api-match-accept');
    assert.equal(view.status, 'OFFERED', 'the refused accept committed no state change');
  }

  // D. Decline resolves through Core for the invited participant.
  {
    const res = await cookieRequest('svc_carol', '/api/v1/decline', {
      opKey: 'api-decline-01',
      body: { id: 'api-match-decline' },
    });
    assert.equal(res.status, 200, 'decline resolves through the signed ingress');
    assert.equal(res.data.status, 'DECLINED', 'Core committed the decline');
    const view = await core.readMatch('svc_carol', 'api-match-decline');
    assert.equal(view.status, 'DECLINED', 'durable row reflects the committed decline');
  }

  // E. Cancel resolves through Core for the offer creator; a non-creator is refused.
  {
    const wrong = await cookieRequest('svc_dave', '/api/v1/cancel', {
      opKey: 'api-cancel-wrong',
      body: { id: 'api-match-cancel' },
    });
    assert.equal(wrong.status, 409, 'a non-creator cancel is refused by Core');
    assert.equal(wrong.data.error, 'CANNOT_CANCEL');
    const res = await cookieRequest('svc_alice', '/api/v1/cancel', {
      opKey: 'api-cancel-01',
      body: { id: 'api-match-cancel' },
    });
    assert.equal(res.status, 200, 'creator cancel resolves through the signed ingress');
    assert.equal(res.data.status, 'CANCELLED', 'Core committed the cancel');
    const view = await core.readMatch('svc_alice', 'api-match-cancel');
    assert.equal(view.status, 'CANCELLED', 'durable row reflects the committed cancel');
  }

  // F. Missing operation key is refused before any Core call.
  {
    const res = await cookieRequest('svc_alice', '/api/v1/offer', {
      opKey: undefined,
      body: { id: 'api-match-nokey', opponent: 'svc_bob', terms: TERMS },
    });
    assert.equal(res.status, 400, 'a missing operation key is refused');
    assert.equal(res.data.error, 'IDEMPOTENCY_KEY_REQUIRED');
  }

  // G. Forged / malformed operation key is refused.
  {
    const res = await cookieRequest('svc_alice', '/api/v1/offer', {
      opKey: 'bad\nkey',
      body: { id: 'api-match-badkey', opponent: 'svc_bob', terms: TERMS },
    });
    assert.equal(res.status, 400, 'a forged operation key is refused');
    assert.equal(res.data.error, 'INVALID_IDEMPOTENCY_KEY');
  }

  // H. Unauthenticated request is refused (no committed side effect).
  {
    const res = await apiRequest(handler, '/api/v1/offer', {
      method: 'POST',
      headers: { origin: 'https://megaxo.online' },
      body: { id: 'api-match-anon', opponent: 'svc_bob', terms: TERMS },
    });
    assert.equal(res.status, 401, 'unauthenticated offer refused with 401');
    assert.equal(res.data.error, 'AUTH_REQUIRED');
  }

  // I. The invited participant accepts by the Core-issued terms hash -> PLAYING with escrow.
  const accept = await cookieRequest('svc_bob', '/api/v1/accept', {
    opKey: 'api-accept-01',
    body: { id: 'api-match-accept', termsHash: offer.data.termsHash },
  });
  assert.equal(accept.status, 200, 'participant accept succeeds');
  assert.equal(accept.data.status, 'PLAYING', 'both seats accepted -> committed PLAYING');
  assert.ok(accept.data.symbols && accept.data.symbols.X && accept.data.symbols.O, 'Core committed the symbol draw');
  {
    const view = await core.readMatch('svc_bob', 'api-match-accept');
    assert.equal(view.status, 'PLAYING', 'durable match row reflects the committed accept');
    assert.equal(Number(view.escrow), 80, 'the accepted match holds its committed escrow');
    const reserved = await lab.scalar(db, "SELECT reserved_crowns FROM economy.wallets WHERE actor_id = 'svc_alice'");
    assert.equal(Number(reserved), 80, 'the accept reserved the challenger stake in the durable wallet');
  }
});

/* ==========================================================================
 * 8. Strict Database Least Privilege (PostgreSQL 42501 Permission Denied)
 * ========================================================================== */

test('8. Strict database least privilege: api_runtime role cannot directly write to economy.wallets or economy.ledger', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_least_priv');
  await lab.seedActors(db, lab.SEED_ACTORS);

  const pools = lab.poolsFor(db);
  const apiPool = pools.api;

  t.after(async () => {
    await lab.closeDatabasePools(db);
  });

  // Verify pool role identity is api_runtime
  const currentRole = await apiPool.query('SELECT current_user, session_user');
  assert.equal(currentRole.rows[0].current_user, 'api_runtime', 'api pool must run as api_runtime');

  const isDenied = (err) => err && (err.code === '42501' || /permission denied/i.test(err.message));

  // 1. Direct UPDATE on economy.wallets
  await assert.rejects(
    () => apiPool.query("UPDATE economy.wallets SET coins = 999999 WHERE actor_id = 'svc_alice'"),
    isDenied,
    'api_runtime cannot UPDATE economy.wallets (42501 expected)'
  );

  // 2. Direct INSERT into economy.wallets
  await assert.rejects(
    () => apiPool.query("INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ('svc_hacker', 500, 500)"),
    isDenied,
    'api_runtime cannot INSERT into economy.wallets (42501 expected)'
  );

  // 3. Direct DELETE from economy.wallets
  await assert.rejects(
    () => apiPool.query("DELETE FROM economy.wallets WHERE actor_id = 'svc_alice'"),
    isDenied,
    'api_runtime cannot DELETE from economy.wallets (42501 expected)'
  );

  // 4. Direct INSERT into economy.ledger
  await assert.rejects(
    () => apiPool.query(
      "INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) " +
      "VALUES ('tamper-hack-01', 'svc_alice', 'coins', 1000, 'hack', 'api', now())"
    ),
    isDenied,
    'api_runtime cannot INSERT into economy.ledger (42501 expected)'
  );

  // 5. Direct UPDATE on economy.ledger
  await assert.rejects(
    () => apiPool.query("UPDATE economy.ledger SET amount = 99999 WHERE entry_id = 'opening:svc_alice'"),
    isDenied,
    'api_runtime cannot UPDATE economy.ledger (42501 expected)'
  );

  // 6. Direct DELETE from economy.ledger
  await assert.rejects(
    () => apiPool.query("DELETE FROM economy.ledger WHERE entry_id = 'opening:svc_alice'"),
    isDenied,
    'api_runtime cannot DELETE from economy.ledger (42501 expected)'
  );

  // Ensure balance is unaltered
  const finalCoins = await lab.scalar(db, "SELECT coins FROM economy.wallets WHERE actor_id = 'svc_alice'");
  assert.equal(Number(finalCoins), 1000, 'wallet balance remains completely intact');
});

/* ==========================================================================
 * 9. Core-Served Public Leaderboard (Actor-Free Signed Ingress)
 * ========================================================================== */

test('9. Public leaderboard: API composition serves the real projection through the actor-free signed Core ingress', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_leaderboard');
  /* This test needs PUBLIC profiles AND distinct ratings (the ORDER BY is on rating/games):
   * alice must sort unambiguously first, carol is private and must be excluded. */
  await lab.seedActors(db, [
    { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1650, games: 30, stats: 'public' },
    { actor: 'svc_bob', coins: 1000, crowns: 100, rating: 1550, games: 30, stats: 'public' },
    { actor: 'svc_carol', coins: 1000, crowns: 100, rating: 1450, games: 30, stats: 'private' },
  ]);

  const pools = lab.poolsFor(db);
  const accounts = await lab.accountsFor(db);
  const core = await lab.coreFor(db);

  // The Core ingress owns the Core pool; the API gateway holds NO Core pool.
  const ingress = createCoreServiceIngress({
    coreService: core,
    leaderboardPool: pools.core,
    secret: TEST_SECRET,
  });
  const ingressServer = await startIngressServer(ingress);

  const gateway = createCoreGateway({
    coreUrl: ingressServer.url,
    secret: TEST_SECRET,
    fetcher: testHttpFetch,
  });

  // Deliberately NO corePool: the deployed API composition holds only api_runtime.
  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    coreGateway: gateway,
  });
  handler._testAccounts = accounts;

  t.after(async () => {
    await ingressServer.close();
    await accounts.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  // A. Real HTTP GET /api/v1/leaderboard: real public rows, no actor credentials.
  const res = await apiRequest(handler, '/api/v1/leaderboard');
  assert.equal(res.status, 200, 'public leaderboard served with 200');
  assert.ok(Array.isArray(res.data), 'response is the public rows array');
  const ids = res.data.map((row) => row.id);
  assert.ok(ids.includes('svc_alice'), 'real public row svc_alice present');
  assert.ok(ids.includes('svc_bob'), 'real public row svc_bob present');
  assert.ok(!ids.includes('svc_carol'), 'private profile never appears on the public board');
  assert.equal(res.data[0].id, 'svc_alice', 'ranked by rating desc (alice first at 1650)');
  assert.equal(Number(res.data[0].rating), 1650, 'materialized rating is real');

  // B. The gateway client itself requires no actor and rejects a real transport failure.
  const direct = await gateway.leaderboard({ metric: 'rating', scope: 'global', league: 'all', region: '' });
  assert.ok(Array.isArray(direct), 'actor-free gateway read returns rows');
  assert.ok(direct.some((row) => row.id === 'svc_alice'), 'actor-free gateway read is the real projection');

  // C. The api_runtime pool still cannot read economy.ratings directly (42501).
  const isDenied = (err) => err && (err.code === '42501' || /permission denied/i.test(err.message));
  await assert.rejects(
    () => pools.api.query('SELECT rating FROM economy.ratings LIMIT 1'),
    isDenied,
    'api_runtime cannot read economy.ratings (42501 expected)'
  );
  await assert.rejects(
    () => materializeForTest(pools.api),
    isDenied,
    'api_runtime materialization of the leaderboard is denied (42501 expected)'
  );

  // D. A real transport failure surfaces as 503, never a silent empty 200.
  const deadGateway = createCoreGateway({
    coreUrl: 'http://127.0.0.1:1',
    secret: TEST_SECRET,
    fetcher: testHttpFetch,
  });
  const deadHandler = createApiHandler({ pool: pools.api, accounts, coreGateway: deadGateway });
  const deadRes = await apiRequest(deadHandler, '/api/v1/leaderboard?metric=wealth');
  assert.equal(deadRes.status, 503, 'an available-but-failing leaderboard transport yields 503');
  assert.equal(deadRes.data.error, 'SERVICE_UNAVAILABLE');
});

/* The api_runtime leaderboard materialization is the exact Core read path, exercised
 * here to prove the API-role denial is real rather than a missing function. */
async function materializeForTest(pool) {
  const { materializeLeaderboardProjection } = require('../packages/services/read-cache.js');
  return materializeLeaderboardProjection(pool, { metric: 'rating', limit: 50 });
}

/* ==========================================================================
 * 10. Actor-Free Ingress Hardening (Tampering, Path, Query, Cross-Path Reuse)
 * ========================================================================== */

test('10. Public leaderboard ingress refuses tampering, wrong path, oversized/unknown query and cross-path reuse', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p11_gateway_leaderboard_guard');
  await lab.seedActors(db, [
    { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1650, games: 30, stats: 'public' },
    { actor: 'svc_bob', coins: 1000, crowns: 100, rating: 1550, games: 30, stats: 'public' },
  ]);

  const pools = lab.poolsFor(db);
  const core = await lab.coreFor(db);

  const ingress = createCoreServiceIngress({
    coreService: core,
    leaderboardPool: pools.core,
    secret: TEST_SECRET,
  });
  const ingressServer = await startIngressServer(ingress);

  t.after(async () => {
    await ingressServer.close();
    await core.close();
    await lab.closeDatabasePools(db);
  });

  const now = Date.now();
  const goodBody = { metric: 'rating', scope: 'global', league: 'all', region: '' };
  const goodBodyStr = JSON.stringify(goodBody);
  const goodHash = hashBody(goodBodyStr);

  // A. Valid actor-free signed read succeeds (baseline).
  {
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/leaderboard',
      actor: '', opKey: '', bodyHash: goodHash,
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '',
        'x-service-opkey': '',
        'x-service-signature': sig,
      },
      body: goodBody,
    });
    assert.equal(res.status, 200, 'baseline actor-free signed read succeeds');
    assert.equal(res.data.ok, true);
    assert.ok(Array.isArray(res.data.result), 'result is the public rows array');
  }

  // B. Tampered body: signature made for the original query, body swapped.
  {
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/leaderboard',
      actor: '', opKey: '', bodyHash: goodHash,
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '', 'x-service-opkey': '', 'x-service-signature': sig,
      },
      body: { metric: 'wealth', scope: 'global', league: 'all', region: '' },
    });
    assert.equal(res.status, 403, 'tampered leaderboard body rejected with 403');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE');
  }

  // C. Wrong path: a signature valid for /ingress/leaderboard replayed at another path.
  {
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/leaderboard',
      actor: '', opKey: '', bodyHash: goodHash,
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/command', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '', 'x-service-opkey': '', 'x-service-signature': sig,
      },
      body: goodBody,
    });
    assert.equal(res.status, 403, 'path reuse rejected with 403');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE');
  }

  // D. Cross-path reuse: a fully valid queue signature (same actor, same body) is
  // replayed at the leaderboard path; only the path differs and it must be refused.
  {
    const queueBody = { command: {} };
    const queueHash = hashBody(JSON.stringify(queueBody));
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/queue/status',
      actor: 'svc_alice', opKey: 'queue-status', bodyHash: queueHash,
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': 'svc_alice', 'x-service-opkey': 'queue-status', 'x-service-signature': sig,
      },
      body: queueBody,
    });
    assert.equal(res.status, 403, 'queue-signed request cannot be reused at the leaderboard path');
    assert.equal(res.data.error, 'INVALID_SERVICE_SIGNATURE');
  }

  // E. Actor-free signature cannot be used on an actor-required path.
  {
    const emptyActorHash = hashBody(JSON.stringify({ command: {} }));
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/queue/status',
      actor: '', opKey: '', bodyHash: emptyActorHash,
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/queue/status', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '', 'x-service-opkey': '', 'x-service-signature': sig,
      },
      body: { command: {} },
    });
    assert.equal(res.status, 403, 'actor-free signing is admitted ONLY on the fixed leaderboard path');
  }

  // F. Unknown query field rejected 400.
  {
    const body = { metric: 'rating', evil: 'x' };
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/leaderboard',
      actor: '', opKey: '', bodyHash: hashBody(JSON.stringify(body)),
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '', 'x-service-opkey': '', 'x-service-signature': sig,
      },
      body,
    });
    assert.equal(res.status, 400, 'unknown query field rejected with 400');
    assert.equal(res.data.error, 'INVALID_LEADERBOARD_QUERY');
  }

  // G. Oversized query value rejected 400.
  {
    const body = { region: 'A'.repeat(200) };
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/leaderboard',
      actor: '', opKey: '', bodyHash: hashBody(JSON.stringify(body)),
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '', 'x-service-opkey': '', 'x-service-signature': sig,
      },
      body,
    });
    assert.equal(res.status, 400, 'oversized query value rejected with 400');
    assert.equal(res.data.error, 'INVALID_LEADERBOARD_QUERY');
  }

  // H. Unsupported metric rejected 400.
  {
    const body = { metric: 'balance' };
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'POST', path: '/ingress/leaderboard',
      actor: '', opKey: '', bodyHash: hashBody(JSON.stringify(body)),
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'POST',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '', 'x-service-opkey': '', 'x-service-signature': sig,
      },
      body,
    });
    assert.equal(res.status, 400, 'unsupported metric rejected with 400');
  }

  // I. GET is not admitted on the fixed path (properly signed for the GET method).
  {
    const sig = computeSignature(TEST_SECRET, {
      timestamp: now, method: 'GET', path: '/ingress/leaderboard',
      actor: '', opKey: '', bodyHash: hashBody(''),
    });
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'GET',
      headers: {
        'x-service-timestamp': String(now),
        'x-service-actor': '', 'x-service-opkey': '', 'x-service-signature': sig,
      },
    });
    assert.equal(res.status, 405, 'GET on the leaderboard ingress is refused with 405');
    assert.equal(res.data.error, 'METHOD_NOT_ALLOWED');
  }

  // J. Missing signature rejected 403 (the empty actor is signed, never omitted).
  {
    const res = await rawIngressRequest(ingressServer.url, '/ingress/leaderboard', {
      method: 'POST',
      headers: { 'x-service-timestamp': String(now), 'x-service-actor': '' },
      body: goodBody,
    });
    assert.equal(res.status, 403, 'missing signature rejected with 403');
  }
});
