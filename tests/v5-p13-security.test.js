'use strict';

/**
 * tests/v5-p13-security.test.js
 *
 * Phase 13: Harden Distributed Trust Boundaries
 *
 * Verifies:
 * 1. Negative SQL permissions on PG16:
 *    - api_runtime cannot write to economy.wallets or economy.ledger (42501).
 *    - worker_runtime cannot write to economy.ledger or monetization.receipts (42501).
 *    - DDL (CREATE/DROP) denied for api_runtime, core_runtime, worker_runtime (42501).
 * 2. Credential mode separation:
 *    - Ambiguous hybrid (cookie AND bearer present) rejected (401 AMBIGUOUS_CREDENTIAL).
 *    - Cookie with mutating method strictly enforces Origin / Referer check or throws 403 CSRF_REJECTED.
 *    - Bearer tokens bypass CSRF.
 * 3. Header sanitizer:
 *    - Untrusted callers cannot spoof x-actor-id, x-test-actor, or x-forwarded-for.
 *    - isInternalGateway allows trusted gateway forwards.
 * 4. Body size limits:
 *    - Rejects request bodies > 100KB with 413 BODY_TOO_LARGE.
 * 5. Audit HMAC verification:
 *    - Dedicated HMAC secret validates chain over audit.operator_audit.
 *    - Tampered entry detected (broken chain / hash mismatch).
 * 6. Public operator rejection:
 *    - /admin/*, /metrics, /operator/* rejected on public ingress with 403 PRIVATE_OPERATOR_ROUTE.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const crypto = require('node:crypto');

const lab = require('./v5-pg-lab.js');
const {
  validateCredentials,
  sanitizeHeaders,
  enforceBodyLimit,
  isOperatorRoute,
  createAuditLogger
} = require('../packages/services/security.js');
const services = require('../packages/services/index.js');
const { createApiHandler } = require('../apps/api/index.js');

lab.installCleanup(test);

const SEED_ACTORS = lab.SEED_ACTORS;

function apiRequest(handler, routePath, {
  method = 'GET',
  headers = {},
  body = null,
  isInternalGateway = false
} = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = routePath;
  req.headers = { ...headers };
  req.body = body;
  req.isInternalGateway = isInternalGateway;

  return new Promise((resolve, reject) => {
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

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/* ==========================================================================
 * 1. Module Exports & Surface Integrity
 * ========================================================================== */

test('1. Security module exports validateCredentials, sanitizeHeaders, enforceBodyLimit, isOperatorRoute, createAuditLogger', () => {
  assert.equal(typeof validateCredentials, 'function');
  assert.equal(typeof sanitizeHeaders, 'function');
  assert.equal(typeof enforceBodyLimit, 'function');
  assert.equal(typeof isOperatorRoute, 'function');
  assert.equal(typeof createAuditLogger, 'function');

  assert.equal(typeof services.validateCredentials, 'function');
  assert.equal(typeof services.sanitizeHeaders, 'function');
  assert.equal(typeof services.enforceBodyLimit, 'function');
  assert.equal(typeof services.isOperatorRoute, 'function');
  assert.equal(typeof services.createAuditLogger, 'function');
});

/* ==========================================================================
 * 2. Negative SQL Permissions on PG16
 * ========================================================================== */

test('2. Negative SQL permissions on PG16: api_runtime, worker_runtime, and DDL restrictions', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p13_security_sql');
  await lab.seedActors(db, SEED_ACTORS);

  const pools = lab.poolsFor(db);
  const apiPool = pools.api;
  const workerPool = pools.worker;
  const corePool = pools.core;

  t.after(async () => {
    await lab.closeDatabasePools(db);
  });

  const isDenied = (err) => err && (err.code === '42501' || /permission denied/i.test(err.message));

  // 2.1 api_runtime cannot write to economy.wallets or economy.ledger (42501)
  await assert.rejects(
    () => apiPool.query("UPDATE economy.wallets SET coins = 999999 WHERE actor_id = 'svc_alice'"),
    isDenied,
    'api_runtime cannot UPDATE economy.wallets (42501 expected)'
  );
  await assert.rejects(
    () => apiPool.query("INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ('svc_hack', 10, 10)"),
    isDenied,
    'api_runtime cannot INSERT into economy.wallets (42501 expected)'
  );
  await assert.rejects(
    () => apiPool.query("DELETE FROM economy.wallets WHERE actor_id = 'svc_alice'"),
    isDenied,
    'api_runtime cannot DELETE from economy.wallets (42501 expected)'
  );
  await assert.rejects(
    () => apiPool.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ('tamper-api', 'svc_alice', 'coins', 100, 'hack', 'api', now())"),
    isDenied,
    'api_runtime cannot INSERT into economy.ledger (42501 expected)'
  );
  await assert.rejects(
    () => apiPool.query("DELETE FROM economy.ledger WHERE actor_id = 'svc_alice'"),
    isDenied,
    'api_runtime cannot DELETE from economy.ledger (42501 expected)'
  );

  // 2.2 worker_runtime cannot write to economy.ledger or monetization.receipts (42501)
  await assert.rejects(
    () => workerPool.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ('tamper-wrk', 'svc_alice', 'coins', 100, 'hack', 'worker', now())"),
    isDenied,
    'worker_runtime cannot INSERT into economy.ledger (42501 expected)'
  );
  await assert.rejects(
    () => workerPool.query("UPDATE economy.ledger SET amount = 99999 WHERE actor_id = 'svc_alice'"),
    isDenied,
    'worker_runtime cannot UPDATE economy.ledger (42501 expected)'
  );
  await assert.rejects(
    () => workerPool.query("DELETE FROM economy.ledger WHERE actor_id = 'svc_alice'"),
    isDenied,
    'worker_runtime cannot DELETE from economy.ledger (42501 expected)'
  );
  await assert.rejects(
    () => workerPool.query("INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ('apple', 'tx-hack', 'svc_alice', 'crowns_100', 100, false, now())"),
    isDenied,
    'worker_runtime cannot INSERT into monetization.receipts (42501 expected)'
  );
  await assert.rejects(
    () => workerPool.query("UPDATE monetization.receipts SET crowns = 99999 WHERE transaction_id = 'tx-any'"),
    isDenied,
    'worker_runtime cannot UPDATE monetization.receipts (42501 expected)'
  );
  await assert.rejects(
    () => workerPool.query("DELETE FROM monetization.receipts WHERE transaction_id = 'tx-any'"),
    isDenied,
    'worker_runtime cannot DELETE from monetization.receipts (42501 expected)'
  );

  // 2.3 DDL (CREATE/DROP) denied for api_runtime, core_runtime, worker_runtime (42501)
  for (const [name, pool] of [['api_runtime', apiPool], ['core_runtime', corePool], ['worker_runtime', workerPool]]) {
    await assert.rejects(
      () => pool.query('CREATE TABLE identity.tamper_probe (id int)'),
      isDenied,
      `${name} cannot CREATE table (42501 expected)`
    );
    await assert.rejects(
      () => pool.query('DROP TABLE IF EXISTS identity.actors CASCADE'),
      isDenied,
      `${name} cannot DROP table (42501 expected)`
    );
    await assert.rejects(
      () => pool.query('CREATE TEMP TABLE tmp_smuggle (n int)'),
      isDenied,
      `${name} cannot CREATE temp table (42501 expected)`
    );
  }
});

/* ==========================================================================
 * 3. Credential Mode Separation
 * ========================================================================== */

test('3. Credential separation: hybrid rejected, CSRF enforced for cookies, bearer CSRF-exempt', () => {
  // 3.1 Ambiguous hybrid (cookie AND bearer present) -> throws AMBIGUOUS_CREDENTIAL (401)
  assert.throws(
    () => validateCredentials({
      cookie: '__Host-mega_session=sess-1234',
      authorization: 'Bearer token-5678',
      method: 'POST'
    }),
    (err) => err.code === 'AMBIGUOUS_CREDENTIAL' && err.status === 401
  );

  // 3.2 Bearer tokens bypass CSRF on mutating requests
  const bearerResult = validateCredentials({
    cookie: null,
    authorization: 'Bearer token-valid-jwt',
    method: 'POST',
    origin: 'https://malicious-site.com',
    allowedOrigins: ['https://play.megaxo.com']
  });
  assert.equal(bearerResult.mode, 'bearer');
  assert.equal(bearerResult.token, 'token-valid-jwt');
  assert.equal(bearerResult.csrfExempt, true);

  // 3.3 Cookie credentials with safe method (GET) pass without CSRF origin
  const cookieGetResult = validateCredentials({
    cookie: '__Host-mega_session=sess-safe-cookie',
    authorization: null,
    method: 'GET',
    origin: null
  });
  assert.equal(cookieGetResult.mode, 'cookie');
  assert.equal(cookieGetResult.csrfExempt, false);

  // 3.4 Cookie credentials with mutating method (POST) without origin -> throws CSRF_REJECTED (403)
  assert.throws(
    () => validateCredentials({
      cookie: '__Host-mega_session=sess-mutating-cookie',
      authorization: null,
      method: 'POST',
      origin: null,
      referer: null
    }),
    (err) => err.code === 'CSRF_REJECTED' && err.status === 403
  );

  // 3.5 Cookie credentials with mutating method (POST) from disallowed origin -> throws CSRF_REJECTED (403)
  assert.throws(
    () => validateCredentials({
      cookie: '__Host-mega_session=sess-mutating-cookie',
      authorization: null,
      method: 'POST',
      origin: 'https://attacker.evil.com',
      allowedOrigins: ['https://megaxo.com']
    }),
    (err) => err.code === 'CSRF_REJECTED' && err.status === 403
  );

  // 3.6 Cookie credentials with mutating method (POST) from allowed origin -> succeeds
  const cookieAllowedResult = validateCredentials({
    cookie: '__Host-mega_session=sess-mutating-cookie',
    authorization: null,
    method: 'POST',
    origin: 'https://megaxo.com',
    allowedOrigins: ['https://megaxo.com']
  });
  assert.equal(cookieAllowedResult.mode, 'cookie');
  assert.equal(cookieAllowedResult.csrfExempt, false);
});

/* ==========================================================================
 * 4. Header Sanitizer
 * ========================================================================== */

test('4. Header sanitizer: untrusted caller cannot spoof x-actor-id, x-test-actor, x-forwarded-for', () => {
  const forgedHeaders = {
    'x-actor-id': 'svc_alice',
    'x-test-actor': 'svc_superadmin',
    'x-forwarded-for': '127.0.0.1',
    'authorization': 'Bearer token-123',
    'content-type': 'application/json'
  };

  // Untrusted public caller: stripped
  const sanitized = sanitizeHeaders(forgedHeaders, { isInternalGateway: false });
  assert.equal(sanitized['x-actor-id'], undefined);
  assert.equal(sanitized['x-test-actor'], undefined);
  assert.equal(sanitized['x-forwarded-for'], undefined);
  assert.equal(sanitized['authorization'], 'Bearer token-123');
  assert.equal(sanitized['content-type'], 'application/json');

  // Trusted internal gateway: preserved
  const trusted = sanitizeHeaders(forgedHeaders, { isInternalGateway: true });
  assert.equal(trusted['x-actor-id'], 'svc_alice');
  assert.equal(trusted['x-test-actor'], 'svc_superadmin');
  assert.equal(trusted['x-forwarded-for'], '127.0.0.1');
});

/* ==========================================================================
 * 5. Body Size Limit Enforcement
 * ========================================================================== */

test('5. Body size limits: rejects bodies > 100KB with 413 BODY_TOO_LARGE', () => {
  const smallBody = 'a'.repeat(50 * 1024); // 50KB
  assert.equal(enforceBodyLimit(smallBody, 100 * 1024), true);

  const largeBody = 'a'.repeat(101 * 1024); // 101KB
  assert.throws(
    () => enforceBodyLimit(largeBody, 100 * 1024),
    (err) => err.code === 'BODY_TOO_LARGE' && err.status === 413
  );

  const largeBuffer = Buffer.alloc(105 * 1024);
  assert.throws(
    () => enforceBodyLimit(largeBuffer, 100 * 1024),
    (err) => err.code === 'BODY_TOO_LARGE' && err.status === 413
  );
});

/* ==========================================================================
 * 6. Audit Trail Logger with HMAC-SHA256 Chain Verification
 * ========================================================================== */

test('6. Audit HMAC verification: dedicated HMAC secret validates chain and detects tampering', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p13_security_audit');

  const pools = lab.poolsFor(db);
  const corePool = pools.core;

  t.after(async () => {
    await lab.closeDatabasePools(db);
  });

  const auditSecret = 'audit-secret-key-0123456789abcdef0123456789abcdef';
  let mockTime = 1700000000000;
  const adminClient = await lab.adminClient(db);
  const logger = createAuditLogger({
    pool: adminClient,
    secret: auditSecret,
    now: () => mockTime
  });

  // Verify empty / initial chain
  const initialCheck = await logger.verifyChain();
  assert.equal(initialCheck.valid, true);
  assert.equal(initialCheck.count, 0);

  // Append entry 1
  mockTime += 1000;
  const entry1 = await logger.append('operator_bob', 'account_hold', 'svc_alice', 'Risk inspection', { reasonCode: 'R1' });
  assert.equal(entry1.prevHash, 'GENESIS');
  assert.match(entry1.entryHash, /^[0-9a-f]{64}$/);

  // Append entry 2
  mockTime += 1000;
  const entry2 = await logger.append('operator_carol', 'account_release', 'svc_alice', 'Risk cleared', { reasonCode: 'R0' });
  assert.equal(entry2.prevHash, entry1.entryHash);
  assert.match(entry2.entryHash, /^[0-9a-f]{64}$/);

  // Append entry 3
  mockTime += 1000;
  const entry3 = await logger.append('operator_lead', 'policy_update', null, 'Routine rotation', { version: 2 });
  assert.equal(entry3.prevHash, entry2.entryHash);

  // Verify full chain integrity
  const verified = await logger.verifyChain();
  assert.equal(verified.valid, true);
  assert.equal(verified.count, 3);
  assert.equal(verified.lastHash, entry3.entryHash);

  // Wrong secret fails verification
  const wrongLogger = createAuditLogger({
    pool: adminClient,
    secret: 'wrong-audit-secret-key-111111111111111111111111111',
    now: () => mockTime
  });
  const tamperedKeyCheck = await wrongLogger.verifyChain();
  assert.equal(tamperedKeyCheck.valid, false);
  assert.equal(tamperedKeyCheck.error, 'TAMPER_DETECTED_HASH_MISMATCH');

  // Database immutability trigger prevents tampering with reason/detail in audit.operator_audit
  await assert.rejects(
    () => adminClient.query("UPDATE audit.operator_audit SET reason = 'Tampered' WHERE audit_id = $1", [entry1.auditId]),
    /AUDIT_IMMUTABLE/i,
    'audit table immutability trigger blocks update tampering'
  );
  await assert.rejects(
    () => adminClient.query("DELETE FROM audit.operator_audit WHERE audit_id = $1", [entry1.auditId]),
    /AUDIT_IMMUTABLE/i,
    'audit table immutability trigger blocks deletion'
  );
  await adminClient.end();
});

/* ==========================================================================
 * 7. Operator Protection on Public Ingress
 * ========================================================================== */

test('7. Public operator rejection: /admin/*, /metrics, /operator/* rejected on public ingress', async () => {
  const handler = createApiHandler({});

  const operatorRoutes = [
    '/admin',
    '/admin/users',
    '/admin/dashboard',
    '/metrics',
    '/metrics/prometheus',
    '/operator',
    '/operator/audit',
    '/operator/lockdown'
  ];

  for (const route of operatorRoutes) {
    const res = await apiRequest(handler, route, { method: 'GET' });
    assert.equal(res.status, 403, `Route ${route} must be rejected with 403`);
    assert.equal(res.data?.error, 'PRIVATE_OPERATOR_ROUTE');
  }

  // Non-operator route (e.g. health) is allowed
  const healthRes = await apiRequest(handler, '/health', { method: 'GET' });
  assert.equal(healthRes.status, 200, 'Public health endpoint must be reachable');
});

/* ==========================================================================
 * 8. End-to-End Ingress Integration (Spoofing, Hybrids, Size limits)
 * ========================================================================== */

test('8. End-to-end ingress integration: hybrid rejected (401), actor spoof stripped, body too large (413)', async (t) => {
  if (!(await lab.boot(t))) return;
  const db = await lab.createDatabase('p13_security_ingress');
  await lab.seedActors(db, SEED_ACTORS);

  const pools = lab.poolsFor(db);
  // Even rejected ingress requests must use the actual configured API
  // account authority; a missing OTP secret is a deployment failure.
  const accounts = await lab.accountsFor(db);
  const handler = createApiHandler({
    pool: pools.api,
    accounts,
    allowedOrigins: ['https://megaxo.com']
  });

  t.after(async () => {
    await lab.closeDatabasePools(db);
  });

  // 8.1 Ambiguous Hybrid Credential rejected on ingress with 401 AMBIGUOUS_CREDENTIAL
  const hybridRes = await apiRequest(handler, '/api/account/export', {
    method: 'GET',
    headers: {
      cookie: '__Host-mega_session=cookie-session-token',
      authorization: 'Bearer bearer-token-value'
    }
  });
  assert.equal(hybridRes.status, 401, 'Hybrid credential must return 401');
  assert.equal(hybridRes.data?.error, 'AMBIGUOUS_CREDENTIAL');

  // 8.2 Untrusted actor spoofing via x-actor-id is stripped, cannot bypass auth
  const spoofRes = await apiRequest(handler, '/api/account/export', {
    method: 'GET',
    headers: {
      'x-actor-id': 'svc_alice'
    }
  });
  assert.equal(spoofRes.status, 401, 'Spoofed x-actor-id must be stripped and fail with 401');
  assert.equal(spoofRes.data?.error, 'AUTH_REQUIRED');

  // 8.3 Body size limit rejected with 413 BODY_TOO_LARGE
  const oversizedPayload = { data: 'x'.repeat(120 * 1024) }; // > 100KB
  const sizeRes = await apiRequest(handler, '/api/account/profile', {
    method: 'POST',
    headers: {
      authorization: 'Bearer any-token'
    },
    body: oversizedPayload
  });
  assert.equal(sizeRes.status, 413, 'Body > 100KB must be rejected with 413');
  assert.equal(sizeRes.data?.error, 'BODY_TOO_LARGE');
});
