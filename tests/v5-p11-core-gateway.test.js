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
  const ingress = createCoreServiceIngress({
    coreService: core,
    secret: TEST_SECRET,
    ticketIssuer: {
      issueTicket: async (actor, session) => ({
        ticket: 'ticket_' + crypto.randomBytes(8).toString('hex'),
        actor,
        expiresIn: 300,
      }),
    },
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

  const ticketRes = await gateway.requestTicket({
    actor: 'svc_alice',
    session: { sessionId: 'sess-123' },
  });

  assert.ok(ticketRes, 'ticket response received');
  assert.ok(ticketRes.ticket || ticketRes.result?.ticket, 'valid ticket field in response');
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
