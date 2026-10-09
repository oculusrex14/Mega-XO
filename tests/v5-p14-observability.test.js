'use strict';

/**
 * tests/v5-p14-observability.test.js - V5 Phase 14 (Unify Traces, Metrics and Alert Delivery)
 *
 * SCOPE & CONTRACT:
 * Validates Phase 14 deliverables:
 * 1. Trace propagation across simulated API -> Core -> Worker -> DB.
 * 2. Zero raw secrets or OTP leakage in formatted JSON logs.
 * 3. Role-specific health: opsz fails when backup is stale or DLQ > 0, while livez remains ok.
 * 4. Metrics collection and Prometheus exposition format.
 * 5. Private support triage tool retrieves incident metadata by support ID without PII leakage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  // Constants
  SUPPORT_ID_REGEX,
  TRACE_HEADERS,
  ALERT_THRESHOLDS,

  // Trace Context
  generateSupportId,
  createTraceContext,
  propagateTraceHeaders,
  TraceContext,

  // Logging & Secret Redaction
  redactSecrets,
  formatJsonLog,

  // Metrics
  MetricsCollector,
  createMetricsCollector,
  renderPrometheusMetrics,

  // Health Aggregator
  HealthAggregator,
  createHealthStatus,

  // Support Triage
  triageSupportIncident,
} = require('../packages/services/observability.js');

const services = require('../packages/services/index.js');

/* ==========================================================================
 * 1. Package Exports Verification
 * ========================================================================== */

test('Observability: exports from packages/services/index.js are defined and valid', () => {
  assert.equal(typeof services.generateSupportId, 'function');
  assert.equal(typeof services.createTraceContext, 'function');
  assert.equal(typeof services.propagateTraceHeaders, 'function');
  assert.equal(typeof services.formatJsonLog, 'function');
  assert.equal(typeof services.redactSecrets, 'function');
  assert.equal(typeof services.createMetricsCollector, 'function');
  assert.equal(typeof services.renderPrometheusMetrics, 'function');
  assert.equal(typeof services.createHealthStatus, 'function');
  assert.equal(typeof services.triageSupportIncident, 'function');
  assert.ok(services.SUPPORT_ID_REGEX instanceof RegExp);
  assert.ok(services.ALERT_THRESHOLDS);
  assert.equal(services.ALERT_THRESHOLDS.DLQ_COUNT_MAX, 0);
  assert.equal(services.ALERT_THRESHOLDS.WORKER_STALL_MS, 60000);
});

/* ==========================================================================
 * 2. Trace Context & Support Identity
 * ========================================================================== */

test('Trace Context: generateSupportId() matches MX-[A-Z0-9]{4}-[A-Z0-9]{4} with high entropy', () => {
  const generated = new Set();
  for (let i = 0; i < 100; i++) {
    const id = generateSupportId();
    assert.match(id, SUPPORT_ID_REGEX, `ID ${id} must match MX-[A-Z0-9]{4}-[A-Z0-9]{4}`);
    assert.ok(!generated.has(id), 'Generated support IDs must be unique');
    generated.add(id);
  }
});

test('Trace Context: createTraceContext() preserves incoming headers or generates valid defaults', () => {
  // Case A: Missing headers -> generates fresh traceId, requestId, supportId
  const ctx1 = createTraceContext({});
  assert.ok(ctx1.traceId);
  assert.ok(ctx1.requestId);
  assert.match(ctx1.supportId, SUPPORT_ID_REGEX);

  const headers1 = ctx1.toHeaders();
  assert.equal(headers1['x-trace-id'], ctx1.traceId);
  assert.equal(headers1['x-request-id'], ctx1.requestId);
  assert.equal(headers1['x-support-id'], ctx1.supportId);

  // Case B: Inbound headers present (case-insensitive lookup)
  const incoming = {
    'X-Trace-Id': 'custom-trace-uuid-1234',
    'x-request-id': 'req-9876',
    'X-SUPPORT-ID': 'MX-4A2B-9C1D',
  };
  const ctx2 = createTraceContext(incoming);
  assert.equal(ctx2.traceId, 'custom-trace-uuid-1234');
  assert.equal(ctx2.requestId, 'req-9876');
  assert.equal(ctx2.supportId, 'MX-4A2B-9C1D');
});

test('Trace Context: propagation across simulated API -> Core -> Worker -> DB preserves correlation', async () => {
  // Step 1: Ingress HTTP request at API
  const ingressHeaders = {
    'x-request-id': 'req-edge-001',
    // No traceId or supportId provided by client
  };
  const apiContext = createTraceContext(ingressHeaders);
  assert.equal(apiContext.requestId, 'req-edge-001');
  const sharedTraceId = apiContext.traceId;
  const sharedSupportId = apiContext.supportId;

  // Step 2: API calls Game Core Gateway with propagated headers
  const outboundApiHeaders = apiContext.toHeaders();
  const coreContext = createTraceContext(outboundApiHeaders);
  assert.equal(coreContext.traceId, sharedTraceId);
  assert.equal(coreContext.supportId, sharedSupportId);

  // Step 3: Game Core executes command and enqueues outbox job for Worker
  const outboxJob = {
    id: 42,
    kind: 'mail_verification',
    payload: { recipient: 'player@example.com' },
    traceHeaders: coreContext.toHeaders(),
  };

  // Step 4: Worker claims job and restores trace context
  const workerContext = createTraceContext(outboxJob.traceHeaders);
  assert.equal(workerContext.traceId, sharedTraceId);
  assert.equal(workerContext.supportId, sharedSupportId);

  // Step 5: Worker writes audit log to PostgreSQL carrying trace identity
  const auditRow = {
    action: 'mail_dispatched',
    traceId: workerContext.traceId,
    supportId: workerContext.supportId,
    timestamp: Date.now(),
  };

  assert.equal(auditRow.traceId, sharedTraceId);
  assert.equal(auditRow.supportId, sharedSupportId);
  assert.match(auditRow.supportId, SUPPORT_ID_REGEX);
});

/* ==========================================================================
 * 3. Zero Raw Secrets or OTP Leakage in Formatted JSON Logs
 * ========================================================================== */

test('Logging: zero raw secrets or OTP leakage in formatted JSON logs', () => {
  const sensitivePayload = {
    password: 'superSecretPassword123!',
    newPassword: 'myNewSecretPass#456',
    token: 'jwt-header.jwt-payload.jwt-secret',
    accessToken: 'access_token_secret_xyz',
    refreshToken: 'refresh_token_secret_abc',
    otp: '948102',
    code: '123456',
    authorization: 'Bearer super-secret-bearer-token',
    cookie: '__Host-mega_session=somesessioncookie',
    ciphertext: '3f8a91b2c4e5...',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----SECRET-----END RSA PRIVATE KEY-----',
    user: {
      id: 'usr_1',
      sessionToken: 'secret_session_token',
      nestedOtp: {
        totp: '567890',
        safeProperty: 'normal_value',
      },
    },
    items: [
      { token: 'item_token_1' },
      { pass: 'item_pass_2' },
    ],
  };

  const sensitiveMessage = 'Auth failed for token=secret_token_123 with otp: 948102 and Bearer my-auth-token';

  const logString = formatJsonLog({
    level: 'warn',
    message: sensitiveMessage,
    traceId: 'trc-123',
    supportId: 'MX-9A8B-7C6D',
    event: 'AUTH_FAILURE',
    data: sensitivePayload,
  });

  // Verify it is valid JSON
  const parsed = JSON.parse(logString);
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.traceId, 'trc-123');
  assert.equal(parsed.supportId, 'MX-9A8B-7C6D');
  assert.equal(parsed.event, 'AUTH_FAILURE');

  // Verify message has no raw secrets or OTPs
  assert.doesNotMatch(parsed.message, /secret_token_123/);
  assert.doesNotMatch(parsed.message, /948102/);
  assert.doesNotMatch(parsed.message, /my-auth-token/);
  assert.ok(parsed.message.includes('[REDACTED]'));

  // String level checks: ABSOLUTELY ZERO secret leakage anywhere in the raw log string
  assert.doesNotMatch(logString, /superSecretPassword123!/);
  assert.doesNotMatch(logString, /myNewSecretPass#456/);
  assert.doesNotMatch(logString, /access_token_secret_xyz/);
  assert.doesNotMatch(logString, /refresh_token_secret_abc/);
  assert.doesNotMatch(logString, /super-secret-bearer-token/);
  assert.doesNotMatch(logString, /somesessioncookie/);
  assert.doesNotMatch(logString, /secret_session_token/);
  assert.doesNotMatch(logString, /item_token_1/);
  assert.doesNotMatch(logString, /item_pass_2/);
  assert.doesNotMatch(logString, /BEGIN RSA PRIVATE KEY/);

  // Field level checks
  assert.equal(parsed.data.password, '[REDACTED]');
  assert.equal(parsed.data.newPassword, '[REDACTED]');
  assert.equal(parsed.data.token, '[REDACTED]');
  assert.equal(parsed.data.otp, '[REDACTED]');
  assert.equal(parsed.data.code, '[REDACTED]');
  assert.equal(parsed.data.authorization, '[REDACTED]');
  assert.equal(parsed.data.cookie, '[REDACTED]');
  assert.equal(parsed.data.privateKey, '[REDACTED]');
  assert.equal(parsed.data.user.sessionToken, '[REDACTED]');
  assert.equal(parsed.data.user.nestedOtp.totp, '[REDACTED]');
  assert.equal(parsed.data.user.nestedOtp.safeProperty, 'normal_value');
  assert.equal(parsed.data.items[0].token, '[REDACTED]');
  assert.equal(parsed.data.items[1].pass, '[REDACTED]');
});

test('Logging: handles circular references and Error instances cleanly', () => {
  const circular = { name: 'circular-test' };
  circular.self = circular;

  const err = new Error('Database connection failed with password=topsecret');
  err.code = 'ECONNREFUSED';

  const logString = formatJsonLog({
    level: 'error',
    message: 'Encountered error',
    data: { circular, err },
  });

  const parsed = JSON.parse(logString);
  assert.equal(parsed.data.circular.self, '[CIRCULAR]');
  assert.doesNotMatch(logString, /topsecret/);
  assert.equal(parsed.data.err.name, 'Error');
  assert.equal(parsed.data.err.code, 'ECONNREFUSED');
});

/* ==========================================================================
 * 4. Role-Specific Health: livez, readyz, opsz
 * ========================================================================== */

test('Health Aggregator: all probes pass in steady state', async () => {
  const now = 1760000000000;
  const health = createHealthStatus({
    role: 'worker',
    dbCheck: async () => ({ ok: true }),
    workerCheck: async () => ({
      dlq: 0,
      outboxBacklog: 12,
      lastHeartbeat: now - 5000, // 5s ago
      stalled: false,
    }),
    backupCheck: async () => ({
      fresh: true,
      completedAt: now - (2 * 3600 * 1000), // 2 hours ago
    }),
    now: () => now,
  });

  const report = await health.evaluate();
  assert.equal(report.ok, true);
  assert.equal(report.role, 'worker');

  const livez = await report.livez();
  assert.equal(livez.ok, true);
  assert.equal(livez.status, 'ok');

  const readyz = await report.readyz();
  assert.equal(readyz.ok, true);
  assert.equal(readyz.status, 'ok');

  const opsz = await report.opsz();
  assert.equal(opsz.ok, true);
  assert.equal(opsz.status, 'ok');
  assert.equal(opsz.backup.fresh, true);
  assert.equal(opsz.worker.dlq, 0);
  assert.equal(opsz.worker.backlog, 12);
});

test('Health Aggregator: opsz fails when backup is stale while livez remains ok', async () => {
  const now = 1760000000000;
  const staleBackupTime = now - (25 * 3600 * 1000); // 25 hours ago (> 24h limit)

  const health = createHealthStatus({
    role: 'worker',
    dbCheck: async () => ({ ok: true }),
    workerCheck: async () => ({
      dlq: 0,
      outboxBacklog: 5,
      lastHeartbeat: now - 2000,
    }),
    backupCheck: async () => ({
      fresh: false,
      completedAt: staleBackupTime,
    }),
    now: () => now,
  });

  const report = await health.evaluate();

  // livez MUST be OK (process is alive and responding)
  const livez = await report.livez();
  assert.equal(livez.ok, true);
  assert.equal(livez.status, 'ok');

  // readyz MUST be OK (DB is connected)
  const readyz = await report.readyz();
  assert.equal(readyz.ok, true);
  assert.equal(readyz.status, 'ok');

  // opsz MUST FAIL (backup is stale)
  const opsz = await report.opsz();
  assert.equal(opsz.ok, false);
  assert.equal(opsz.status, 'unhealthy');
  assert.equal(opsz.backup.fresh, false);
  assert.ok(opsz.failures.some(f => f.includes('Backup is')));

  // Overall evaluated ok is false
  assert.equal(report.ok, false);
});

test('Health Aggregator: opsz fails when DLQ > 0 while livez remains ok', async () => {
  const now = 1760000000000;

  const health = createHealthStatus({
    role: 'worker',
    dbCheck: async () => ({ ok: true }),
    workerCheck: async () => ({
      dlq: 3, // 3 dead letters present
      outboxBacklog: 10,
      lastHeartbeat: now - 1000,
    }),
    backupCheck: async () => ({
      fresh: true,
      completedAt: now - 3600000,
    }),
    now: () => now,
  });

  const report = await health.evaluate();

  // livez is still ok
  const livez = await report.livez();
  assert.equal(livez.ok, true);

  // opsz fails due to dead letters
  const opsz = await report.opsz();
  assert.equal(opsz.ok, false);
  assert.equal(opsz.worker.dlq, 3);
  assert.ok(opsz.failures.some(f => f.includes('Dead letter queue count > 0')));
});

test('Health Aggregator: opsz fails when worker loop is stalled (> 60s)', async () => {
  const now = 1760000000000;

  const health = createHealthStatus({
    role: 'worker',
    dbCheck: async () => ({ ok: true }),
    workerCheck: async () => ({
      dlq: 0,
      outboxBacklog: 10,
      lastHeartbeat: now - 75000, // 75 seconds ago (> 60s limit)
    }),
    now: () => now,
  });

  const opsz = await health.opsz();
  assert.equal(opsz.ok, false);
  assert.equal(opsz.worker.stalled, true);
  assert.ok(opsz.failures.some(f => f.includes('Worker loop stalled')));
});

test('Health Aggregator: direct await resolution and dual property/function access', async () => {
  const now = 1760000000000;

  // Direct await via thenable
  const status = await createHealthStatus({
    role: 'api',
    dbCheck: async () => ({ ok: true }),
    now: () => now,
  });

  // Dual access: status.livez.ok AND (await status.livez()).ok
  assert.equal(status.livez.ok, true);
  const livezObj = await status.livez();
  assert.equal(livezObj.ok, true);

  assert.equal(status.readyz.ok, true);
  const readyzObj = await status.readyz();
  assert.equal(readyzObj.ok, true);

  assert.equal(status.opsz.ok, true);
  const opszObj = await status.opsz();
  assert.equal(opszObj.ok, true);
});

/* ==========================================================================
 * 5. Metrics Collection & Prometheus Exposition Format
 * ========================================================================== */

test('Metrics: counters, latencies, and gauges with Prometheus exposition format', () => {
  const collector = createMetricsCollector();
  collector.setHelp('http_requests_total', 'Total HTTP requests served');
  collector.setHelp('worker_outbox_dead_letter_count', 'Number of dead letters in outbox');
  collector.setHelp('core_tick_duration_ms', 'Tick cycle execution duration in milliseconds');

  // 1. Monotonic Counters
  collector.increment('http_requests_total', 10, { method: 'GET', status: '200' });
  collector.increment('http_requests_total', 2, { method: 'POST', status: '500' });

  // 2. Gauges
  collector.setGauge('active_connections', 42);
  collector.setGauge('worker_outbox_dead_letter_count', 0);
  collector.setGauge('worker_outbox_queued_count', 18);

  // 3. Latencies (p50, p95, p99)
  const latencies = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
  for (const lat of latencies) {
    collector.recordLatency('core_tick_duration_ms', lat, { service: 'game-core' });
  }

  // Snapshot inspection
  const snapshot = collector.getMetrics();
  assert.equal(snapshot.counters.http_requests_total[JSON.stringify({ method: 'GET', status: '200' })], 10);
  assert.equal(snapshot.gauges.active_connections[JSON.stringify({})], 42);

  const summary = snapshot.latencies.core_tick_duration_ms[JSON.stringify({ service: 'game-core' })];
  assert.equal(summary.count, 20);
  assert.equal(summary.p50, 50);
  assert.equal(summary.p95, 95);
  assert.equal(summary.p99, 100);

  // Prometheus text rendering
  const rendered = collector.renderPrometheusMetrics();

  // Verify Prometheus headers
  assert.ok(rendered.includes('# HELP http_requests_total Total HTTP requests served'));
  assert.ok(rendered.includes('# TYPE http_requests_total counter'));
  assert.ok(rendered.includes('http_requests_total{method="GET",status="200"} 10'));

  assert.ok(rendered.includes('# HELP worker_outbox_dead_letter_count Number of dead letters in outbox'));
  assert.ok(rendered.includes('# TYPE worker_outbox_dead_letter_count gauge'));
  assert.ok(rendered.includes('worker_outbox_dead_letter_count 0'));
  assert.ok(rendered.includes('active_connections 42'));

  assert.ok(rendered.includes('# HELP core_tick_duration_ms Tick cycle execution duration in milliseconds'));
  assert.ok(rendered.includes('# TYPE core_tick_duration_ms summary'));
  assert.ok(rendered.includes('core_tick_duration_ms{service="game-core",quantile="0.5"} 50'));
  assert.ok(rendered.includes('core_tick_duration_ms{service="game-core",quantile="0.95"} 95'));
  assert.ok(rendered.includes('core_tick_duration_ms{service="game-core",quantile="0.99"} 100'));
  assert.ok(rendered.includes('core_tick_duration_ms_sum{service="game-core"} 1050'));
  assert.ok(rendered.includes('core_tick_duration_ms_count{service="game-core"} 20'));
});

/* ==========================================================================
 * 6. Private Support Triage Tool
 * ========================================================================== */

test('Support Triage: resolves incident metadata by support ID without PII leakage', async () => {
  const targetSupportId = 'MX-8F2K-1D9X';

  // Sample log buffer containing various logs
  const logs = [
    formatJsonLog({
      level: 'info',
      message: 'User requested password reset',
      supportId: 'MX-0000-0000',
      event: 'RESET_REQUEST',
    }),
    // The target incident log containing potentially sensitive fields that MUST be stripped
    JSON.stringify({
      level: 'error',
      supportId: targetSupportId,
      service: 'worker',
      component: 'mail_outbox',
      timestamp: 1760000500000,
      errorCode: 'SMTP_PROVIDER_503',
      message: 'Failed to deliver notification email',
      // Sensitive fields that MUST NOT leak in triage output:
      email: 'player@private-domain.com',
      actorId: 'usr_secret_12345',
      ip: '203.0.113.195',
      data: {
        recipientHost: 'smtp.mail.com',
        password: 'leak_attempt_password',
        authCode: '987654',
      },
    }),
  ];

  const result = await triageSupportIncident(targetSupportId, { logs });

  assert.equal(result.found, true);
  assert.equal(result.supportId, targetSupportId);
  assert.equal(result.service, 'worker');
  assert.equal(result.component, 'mail_outbox');
  assert.equal(result.errorCode, 'SMTP_PROVIDER_503');
  assert.ok(result.timestamp);

  // CRITICAL PRIVACY CHECKS: PII must NEVER be present in the triage result!
  assert.equal(result.email, undefined);
  assert.equal(result.actorId, undefined);
  assert.equal(result.ip, undefined);

  // In metadata, password and authCode must be redacted
  assert.equal(result.metadata.recipientHost, 'smtp.mail.com');
  assert.equal(result.metadata.password, '[REDACTED]');
  assert.equal(result.metadata.authCode, '[REDACTED]');
});

test('Support Triage: validates format and handles unknown support ID gracefully', async () => {
  // Case 1: Malformed support ID
  const invalid = await triageSupportIncident('INVALID-CODE-123', { logs: [] });
  assert.equal(invalid.found, false);
  assert.equal(invalid.error, 'INVALID_SUPPORT_ID');

  // Case 2: Valid format, but not in logs
  const notFound = await triageSupportIncident('MX-ZZZZ-9999', { logs: [] });
  assert.equal(notFound.found, false);
  assert.equal(notFound.error, 'INCIDENT_NOT_FOUND');
});

test('Support Triage: fallback to PostgreSQL query when logs empty', async () => {
  const targetSupportId = 'MX-4B3C-2A1Z';

  // Mock pool simulating audit.operator_audit lookup
  const mockPool = {
    query: async (sql, params) => {
      assert.ok(sql.includes('audit.operator_audit'));
      assert.equal(params[0], targetSupportId);
      return {
        rows: [
          {
            service: 'game-core',
            component: 'matchmaker',
            error_code: 'MATCHMAKER_TIMEOUT',
            timestamp: new Date('2026-10-10T12:00:00Z'),
          },
        ],
      };
    },
  };

  const result = await triageSupportIncident(targetSupportId, { pool: mockPool, logs: [] });
  assert.equal(result.found, true);
  assert.equal(result.service, 'game-core');
  assert.equal(result.component, 'matchmaker');
  assert.equal(result.errorCode, 'MATCHMAKER_TIMEOUT');
});
