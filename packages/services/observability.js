'use strict';

/**
 * packages/services/observability.js - V5 Phase 14 (Unify Traces, Metrics and Alert Delivery)
 *
 * Implements:
 * - V5-14-01: Propagate sanitized request/trace/support identity
 *             (player-safe MX-... support codes, correlation IDs, trace headers,
 *              bounded cardinality, zero raw secrets).
 * - V5-14-02: Instrument role-specific health and metrics
 *             (livez/readyz/opsz with backup freshness & worker backlog checks).
 * - V5-14-03: Configure actionable alerts
 *             (threshold alerts for DLQ, queue backlog, drift, backup staleness).
 * - V5-14-04: Operational triage tool
 *             (private support lookup, component failure localization, runbook mappings).
 *
 * Invariant (Gate G14):
 * One player-safe support ID can be traced across API/Core/DB/worker without exposing secrets;
 * operational health probes reflect real pipeline integrity; private support lookup resolves
 * incidents without leaking PII.
 */

const crypto = require('node:crypto');

/* ==========================================================================
 * 1. Constants & Thresholds
 * ========================================================================== */

const SUPPORT_ID_REGEX = /^MX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const TRACE_HEADERS = Object.freeze({
  TRACE_ID: 'x-trace-id',
  REQUEST_ID: 'x-request-id',
  SUPPORT_ID: 'x-support-id',
});

const ALERT_THRESHOLDS = Object.freeze({
  DLQ_COUNT_MAX: 0,             // Alert immediately if DLQ > 0
  WORKER_STALL_MS: 60 * 1000,    // 60 seconds loop stall
  BACKUP_MAX_AGE_MS: 24 * 60 * 60 * 1000, // 24 hours staleness limit
  OUTBOX_BACKLOG_MAX: 100,      // Outbox backlog warning threshold
  DB_ERROR_RATE_MAX: 0.01,      // 1% DB error rate threshold
});

// Keys whose values must always be redacted in logs and outputs
const SENSITIVE_KEY_REGEX = /password|passwd|pass|token|secret|authorization|cookie|bearer|otp|credential|private_?key|api_?key|ciphertext|signing_?key|totp|auth_?code/i;

// Patterns inside strings (messages, queries, headers) to redact
const SENSITIVE_STRING_PATTERNS = [
  // Bearer tokens
  { regex: /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, replacement: '$1[REDACTED]' },
  // Basic auth
  { regex: /(Basic\s+)[A-Za-z0-9+/=]+/gi, replacement: '$1[REDACTED]' },
  // JWT tokens (eyJ...)
  { regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, replacement: '[REDACTED_JWT]' },
  // Key=value secret assignments
  { regex: /((?:password|token|secret|otp|code|apikey|access_token|refresh_token)\s*[:=]\s*["']?)[^\s"',;&]+/gi, replacement: '$1[REDACTED]' },
  // Sensitive headers in query strings (e.g. ?token=... or ?otp=...)
  { regex: /([?&](?:token|secret|otp|code|auth)=)[^&#\s]+/gi, replacement: '$1[REDACTED]' },
  // Private keys
  { regex: /-----BEGIN [A-Z ]+KEY-----[\s\S]*?-----END [A-Z ]+KEY-----/gi, replacement: '[REDACTED_PRIVATE_KEY]' },
];

/* ==========================================================================
 * 2. Trace Context & Support ID Generation (V5-14-01)
 * ========================================================================== */

// Unambiguous player-safe alphanumeric alphabet (excluding vowels/confusables if desired,
// but Crockford-style uppercase alphanumeric [0-9A-Z] strictly adheres to MX-[A-Z0-9]{4}-[A-Z0-9]{4}).
const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Generates a player-safe support code in format MX-[A-Z0-9]{4}-[A-Z0-9]{4}.
 * @returns {string} e.g. "MX-A7K2-9PQ4"
 */
function generateSupportId() {
  const bytes = crypto.randomBytes(8);
  let p1 = '';
  let p2 = '';
  for (let i = 0; i < 4; i++) {
    p1 += ALPHANUMERIC_CHARS[bytes[i] % ALPHANUMERIC_CHARS.length];
    p2 += ALPHANUMERIC_CHARS[bytes[i + 4] % ALPHANUMERIC_CHARS.length];
  }
  return `MX-${p1}-${p2}`;
}

/**
 * Normalizes header keys for lookup.
 */
function findHeaderValue(headers, key) {
  if (!headers || typeof headers !== 'object') return null;
  const target = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return typeof v === 'string' ? v.trim() : String(v);
    }
  }
  return null;
}

/**
 * Trace Context object encapsulating traceId, requestId, supportId, and header propagation.
 */
class TraceContext {
  constructor({ traceId, requestId, supportId } = {}) {
    this.traceId = traceId || crypto.randomUUID();
    this.requestId = requestId || this.traceId;
    this.supportId = (supportId && SUPPORT_ID_REGEX.test(supportId))
      ? supportId
      : generateSupportId();

    this.headers = Object.freeze({
      [TRACE_HEADERS.TRACE_ID]: this.traceId,
      [TRACE_HEADERS.REQUEST_ID]: this.requestId,
      [TRACE_HEADERS.SUPPORT_ID]: this.supportId,
    });
  }

  /**
   * Returns downstream trace headers object.
   */
  toHeaders() {
    return {
      [TRACE_HEADERS.TRACE_ID]: this.traceId,
      [TRACE_HEADERS.REQUEST_ID]: this.requestId,
      [TRACE_HEADERS.SUPPORT_ID]: this.supportId,
    };
  }

  /**
   * Injects trace headers into an existing headers dictionary.
   */
  propagate(target = {}) {
    if (target && typeof target === 'object') {
      target[TRACE_HEADERS.TRACE_ID] = this.traceId;
      target[TRACE_HEADERS.REQUEST_ID] = this.requestId;
      target[TRACE_HEADERS.SUPPORT_ID] = this.supportId;
    }
    return target;
  }
}

/**
 * Creates or parses a TraceContext from incoming HTTP headers.
 * @param {Object} [headers={}] Incoming request headers
 * @returns {TraceContext}
 */
function createTraceContext(headers = {}) {
  const traceId = findHeaderValue(headers, TRACE_HEADERS.TRACE_ID);
  const requestId = findHeaderValue(headers, TRACE_HEADERS.REQUEST_ID);
  const supportId = findHeaderValue(headers, TRACE_HEADERS.SUPPORT_ID);

  return new TraceContext({ traceId, requestId, supportId });
}

/**
 * Propagate trace headers across services.
 * Accepts a TraceContext or raw headers dictionary, and returns target headers.
 */
function propagateTraceHeaders(source = {}, target = {}) {
  const ctx = (source instanceof TraceContext) ? source : createTraceContext(source);
  return ctx.propagate(target);
}

/* ==========================================================================
 * 3. Secret Redaction & Structured JSON Logging (V5-14-01)
 * ========================================================================== */

/**
 * Sanitizes a string by replacing sensitive tokens, JWTs, and passwords.
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  let result = str;
  for (const { regex, replacement } of SENSITIVE_STRING_PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Recursively redacts sensitive keys and values from objects, arrays, and errors.
 * Handles circular references safely using WeakSet.
 */
function redactSecrets(target, seen = new WeakSet()) {
  if (target === null || target === undefined) {
    return target;
  }

  if (typeof target === 'string') {
    return sanitizeString(target);
  }

  if (typeof target === 'number' || typeof target === 'boolean' || typeof target === 'bigint') {
    return target;
  }

  if (target instanceof Date) {
    return target.toISOString();
  }

  if (target instanceof Error) {
    return {
      name: target.name,
      message: sanitizeString(target.message),
      code: target.code,
      stack: sanitizeString(target.stack || ''),
    };
  }

  if (typeof target === 'object') {
    if (seen.has(target)) {
      return '[CIRCULAR]';
    }
    seen.add(target);

    if (Array.isArray(target)) {
      return target.map(item => redactSecrets(item, seen));
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(target)) {
      if (typeof value === 'object' && value !== null) {
        cleaned[key] = redactSecrets(value, seen);
      } else if (SENSITIVE_KEY_REGEX.test(key)) {
        cleaned[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        if (/otp|code|totp/i.test(key) && /^\d{4,8}$/.test(value.trim())) {
          cleaned[key] = '[REDACTED]';
        } else {
          cleaned[key] = sanitizeString(value);
        }
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  return target;
}

/**
 * Formats a structured JSON log entry with automatic secret redaction.
 * @param {Object} options
 * @param {string} [options.level='info'] Log level (info, warn, error, debug)
 * @param {string} [options.message=''] Human-readable log message
 * @param {string} [options.traceId] Active trace identifier
 * @param {string} [options.supportId] Player-safe support code (MX-...)
 * @param {string} [options.event] Named event identifier
 * @param {*} [options.data] Arbitrary payload to sanitize
 * @returns {string} Serialized JSON string
 */
function formatJsonLog({
  level = 'info',
  message = '',
  traceId = null,
  supportId = null,
  event = null,
  data = undefined,
  timestamp = null,
  ...extra
} = {}) {
  const record = {
    timestamp: timestamp || new Date().toISOString(),
    level: String(level).toLowerCase(),
    message: sanitizeString(String(message)),
  };

  if (traceId) record.traceId = traceId;
  if (supportId) record.supportId = supportId;
  if (event) record.event = event;

  if (data !== undefined) {
    record.data = redactSecrets(data);
  }

  if (Object.keys(extra).length > 0) {
    const extraRedacted = redactSecrets(extra);
    Object.assign(record, extraRedacted);
  }

  return JSON.stringify(record);
}

/* ==========================================================================
 * 4. Metrics Collector & Prometheus Exposition (V5-14-02)
 * ========================================================================== */

function formatLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const formatted = entries
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join(',');
  return `{${formatted}}`;
}

function calculatePercentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(p * sortedValues.length) - 1;
  const clamped = Math.max(0, Math.min(index, sortedValues.length - 1));
  return sortedValues[clamped];
}

class MetricsCollector {
  constructor() {
    this.counters = new Map(); // name -> Map(labelKey -> number)
    this.gauges = new Map();   // name -> Map(labelKey -> number)
    this.latencies = new Map(); // name -> Map(labelKey -> number[])
    this.helpTexts = new Map();
  }

  /**
   * Registers a help description for a metric.
   */
  setHelp(name, help) {
    this.helpTexts.set(name, help);
  }

  /**
   * Increments a monotonic counter.
   */
  incrementCounter(name, value = 1, labels = {}) {
    if (!this.counters.has(name)) {
      this.counters.set(name, new Map());
    }
    const labelKey = JSON.stringify(labels);
    const map = this.counters.get(name);
    const current = map.get(labelKey) || 0;
    map.set(labelKey, current + (Number(value) || 0));
  }

  increment(name, value = 1, labels = {}) {
    this.incrementCounter(name, value, labels);
  }

  /**
   * Sets the current value of a gauge.
   */
  setGauge(name, value, labels = {}) {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, new Map());
    }
    const labelKey = JSON.stringify(labels);
    this.gauges.get(name).set(labelKey, Number(value) || 0);
  }

  gauge(name, value, labels = {}) {
    this.setGauge(name, value, labels);
  }

  /**
   * Records a latency duration in milliseconds.
   */
  recordLatency(name, durationMs, labels = {}) {
    if (!this.latencies.has(name)) {
      this.latencies.set(name, new Map());
    }
    const labelKey = JSON.stringify(labels);
    const map = this.latencies.get(name);
    if (!map.has(labelKey)) {
      map.set(labelKey, []);
    }
    map.get(labelKey).push(Number(durationMs) || 0);
  }

  observe(name, durationMs, labels = {}) {
    this.recordLatency(name, durationMs, labels);
  }

  /**
   * Returns a snapshot of all metrics.
   */
  getMetrics() {
    const result = {
      counters: {},
      gauges: {},
      latencies: {},
    };

    for (const [name, map] of this.counters.entries()) {
      result.counters[name] = {};
      for (const [lk, val] of map.entries()) {
        result.counters[name][lk] = val;
      }
    }

    for (const [name, map] of this.gauges.entries()) {
      result.gauges[name] = {};
      for (const [lk, val] of map.entries()) {
        result.gauges[name][lk] = val;
      }
    }

    for (const [name, map] of this.latencies.entries()) {
      result.latencies[name] = {};
      for (const [lk, arr] of map.entries()) {
        const sorted = [...arr].sort((a, b) => a - b);
        const sum = sorted.reduce((acc, v) => acc + v, 0);
        result.latencies[name][lk] = {
          count: sorted.length,
          sum,
          p50: calculatePercentile(sorted, 0.50),
          p95: calculatePercentile(sorted, 0.95),
          p99: calculatePercentile(sorted, 0.99),
        };
      }
    }

    return result;
  }

  /**
   * Clears all metrics in collector.
   */
  reset() {
    this.counters.clear();
    this.gauges.clear();
    this.latencies.clear();
  }

  /**
   * Renders metrics in Prometheus text exposition format.
   * @returns {string}
   */
  renderPrometheusMetrics() {
    const lines = [];

    // 1. Counters
    for (const [name, map] of this.counters.entries()) {
      const help = this.helpTexts.get(name) || `Total count for ${name}`;
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [lk, val] of map.entries()) {
        const labels = JSON.parse(lk);
        lines.push(`${name}${formatLabels(labels)} ${val}`);
      }
    }

    // 2. Gauges
    for (const [name, map] of this.gauges.entries()) {
      const help = this.helpTexts.get(name) || `Current value for ${name}`;
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const [lk, val] of map.entries()) {
        const labels = JSON.parse(lk);
        lines.push(`${name}${formatLabels(labels)} ${val}`);
      }
    }

    // 3. Latencies / Summaries
    for (const [name, map] of this.latencies.entries()) {
      const help = this.helpTexts.get(name) || `Latency summary in milliseconds for ${name}`;
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} summary`);
      for (const [lk, arr] of map.entries()) {
        const labels = JSON.parse(lk);
        const sorted = [...arr].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((acc, v) => acc + v, 0);
        const p50 = calculatePercentile(sorted, 0.50);
        const p95 = calculatePercentile(sorted, 0.95);
        const p99 = calculatePercentile(sorted, 0.99);

        // Render quantiles
        lines.push(`${name}${formatLabels({ ...labels, quantile: '0.5' })} ${p50}`);
        lines.push(`${name}${formatLabels({ ...labels, quantile: '0.95' })} ${p95}`);
        lines.push(`${name}${formatLabels({ ...labels, quantile: '0.99' })} ${p99}`);
        lines.push(`${name}_sum${formatLabels(labels)} ${sum}`);
        lines.push(`${name}_count${formatLabels(labels)} ${count}`);
      }
    }

    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
  }
}

const defaultCollector = new MetricsCollector();

function createMetricsCollector() {
  return new MetricsCollector();
}

function renderPrometheusMetrics(collector = defaultCollector) {
  if (collector && typeof collector.renderPrometheusMetrics === 'function') {
    return collector.renderPrometheusMetrics();
  }
  return defaultCollector.renderPrometheusMetrics();
}

/* ==========================================================================
 * 5. Role-Specific Health Aggregator (V5-14-02)
 * ========================================================================== */

/**
 * HealthStatus aggregator representing operational status checks.
 * Supports both asynchronous probe methods (.livez(), .readyz(), .opsz())
 * and direct awaiting via .then() returning evaluated results.
 */
class HealthAggregator {
  constructor({
    role = 'worker',
    dbCheck = null,
    workerCheck = null,
    backupCheck = null,
    now = Date.now,
  } = {}) {
    this.role = role;
    this.dbCheck = dbCheck;
    this.workerCheck = workerCheck;
    this.backupCheck = backupCheck;
    this.now = now;
  }

  /**
   * livez probe: process responsiveness and event loop heartbeat.
   * Process is alive.
   */
  async livez() {
    return {
      ok: true,
      status: 'ok',
      role: this.role,
      probe: 'livez',
      timestamp: this.now(),
    };
  }

  /**
   * readyz probe: database pool and dependent connectivity.
   */
  async readyz() {
    let dbOk = true;
    let error = null;

    if (this.dbCheck !== null && this.dbCheck !== undefined) {
      if (typeof this.dbCheck === 'function') {
        try {
          const res = await this.dbCheck();
          if (res === false || (typeof res === 'object' && res !== null && res.ok === false)) {
            dbOk = false;
            error = res?.error || 'DB_CHECK_FAILED';
          }
        } catch (err) {
          dbOk = false;
          error = err.message;
        }
      } else if (typeof this.dbCheck === 'object' && typeof this.dbCheck.query === 'function') {
        try {
          await this.dbCheck.query('SELECT 1');
          dbOk = true;
        } catch (err) {
          dbOk = false;
          error = err.message;
        }
      } else if (typeof this.dbCheck === 'boolean') {
        dbOk = this.dbCheck;
      } else if (typeof this.dbCheck === 'object' && this.dbCheck !== null) {
        if (this.dbCheck.ok === false) {
          dbOk = false;
          error = this.dbCheck.error || 'DB_CHECK_FAILED';
        }
        if (typeof this.dbCheck.errorRate === 'number' && this.dbCheck.errorRate > ALERT_THRESHOLDS.DB_ERROR_RATE_MAX) {
          dbOk = false;
          error = 'DB_ERROR_RATE_EXCEEDED';
        }
      }
    }

    return {
      ok: dbOk,
      status: dbOk ? 'ok' : 'degraded',
      role: this.role,
      probe: 'readyz',
      error: error || undefined,
      timestamp: this.now(),
    };
  }

  /**
   * opsz probe: operational health including backup freshness, outbox backlog, and DLQ == 0.
   */
  async opsz() {
    const ready = await this.readyz();
    const currentTime = this.now();
    const failures = [];

    if (!ready.ok) {
      failures.push('Database readiness check failed');
    }

    // 1. Backup freshness check
    let backupStatus = { fresh: true, ageMs: 0 };
    if (this.backupCheck !== null && this.backupCheck !== undefined) {
      let bRes = this.backupCheck;
      if (typeof this.backupCheck === 'function') {
        try {
          bRes = await this.backupCheck();
        } catch (err) {
          bRes = { fresh: false, error: err.message };
        }
      }

      if (bRes === false) {
        backupStatus = { fresh: false, ageMs: ALERT_THRESHOLDS.BACKUP_MAX_AGE_MS + 1 };
        failures.push('Backup is marked not fresh');
      } else if (typeof bRes === 'object' && bRes !== null) {
        const completedAt = bRes.completedAt || bRes.lastBackupTimestamp;
        let ageMs = bRes.ageMs;
        if (ageMs === undefined && completedAt) {
          ageMs = currentTime - completedAt;
        }

        const isStale = bRes.fresh === false ||
          bRes.stale === true ||
          (typeof ageMs === 'number' && ageMs > ALERT_THRESHOLDS.BACKUP_MAX_AGE_MS);

        backupStatus = {
          fresh: !isStale,
          ageMs: ageMs || 0,
          completedAt: completedAt || null,
        };

        if (isStale) {
          failures.push(`Backup is stale (age > 24h: ${ageMs}ms)`);
        }
      }
    }

    // 2. Worker pipeline checks (dead letters, outbox backlog, stall heartbeat)
    let workerStatus = { dlq: 0, backlog: 0, stalled: false };
    if (this.workerCheck !== null && this.workerCheck !== undefined || this.role === 'worker') {
      let wRes = this.workerCheck;
      if (typeof this.workerCheck === 'function') {
        try {
          wRes = await this.workerCheck();
        } catch (err) {
          wRes = { error: err.message, stalled: true };
        }
      }

      if (typeof wRes === 'object' && wRes !== null) {
        const dlq = Number(wRes.deadLetterCount ?? wRes.dlq ?? wRes.deadLetters ?? 0);
        const backlog = Number(wRes.outboxBacklog ?? wRes.backlog ?? wRes.queuedCount ?? 0);
        const backlogThreshold = Number(wRes.backlogThreshold ?? ALERT_THRESHOLDS.OUTBOX_BACKLOG_MAX);

        let stalled = Boolean(wRes.stalled);
        if (!stalled && wRes.lastHeartbeat) {
          const stallMs = currentTime - wRes.lastHeartbeat;
          if (stallMs > ALERT_THRESHOLDS.WORKER_STALL_MS) {
            stalled = true;
          }
        }

        workerStatus = { dlq, backlog, stalled };

        if (dlq > ALERT_THRESHOLDS.DLQ_COUNT_MAX) {
          failures.push(`Dead letter queue count > 0 (${dlq})`);
        }
        if (backlog > backlogThreshold) {
          failures.push(`Outbox backlog (${backlog}) exceeds threshold (${backlogThreshold})`);
        }
        if (stalled) {
          failures.push('Worker loop stalled (> 60s since last heartbeat)');
        }
      }
    }

    const opsOk = ready.ok && failures.length === 0;

    return {
      ok: opsOk,
      status: opsOk ? 'ok' : 'unhealthy',
      role: this.role,
      probe: 'opsz',
      failures,
      backup: backupStatus,
      worker: workerStatus,
      timestamp: currentTime,
    };
  }

  /**
   * Evaluates all three probes and returns a composite health report.
   */
  async evaluate() {
    const [live, ready, ops] = await Promise.all([
      this.livez(),
      this.readyz(),
      this.opsz(),
    ]);

    // Create callable objects so result.livez.ok and result.livez() both work seamlessly
    const livezFn = Object.assign(async () => live, live);
    const readyzFn = Object.assign(async () => ready, ready);
    const opszFn = Object.assign(async () => ops, ops);

    return {
      role: this.role,
      ok: live.ok && ready.ok && ops.ok,
      livez: livezFn,
      readyz: readyzFn,
      opsz: opszFn,
      timestamp: this.now(),
    };
  }

  /**
   * Enables `await createHealthStatus(...)` direct resolution.
   */
  then(onFulfilled, onRejected) {
    return this.evaluate().then(onFulfilled, onRejected);
  }
}

/**
 * Creates a HealthStatus evaluator for a given service role.
 * @param {Object} options
 * @param {string} [options.role='worker'] Service role ('worker', 'core', 'api')
 * @param {*} [options.dbCheck] Database connection check (fn, pool, or obj)
 * @param {*} [options.workerCheck] Worker status check (dlq, backlog, heartbeat)
 * @param {*} [options.backupCheck] Backup status check (freshness, completedAt)
 * @returns {HealthAggregator}
 */
function createHealthStatus(options = {}) {
  return new HealthAggregator(options);
}

/* ==========================================================================
 * 6. Private Support Triage Tool (V5-14-04)
 * ========================================================================== */

/**
 * Triage support incidents by player-safe MX-... support ID without leaking PII.
 * Queries provided logs or pool to resolve affected service, timestamp, and error code.
 *
 * @param {string} supportId Support ID in format MX-[A-Z0-9]{4}-[A-Z0-9]{4}
 * @param {Object} options
 * @param {Array|Function} [options.logs] In-memory logs or log query function
 * @param {Object} [options.pool] PostgreSQL connection pool for audit lookup
 * @returns {Promise<Object>} Safe triage incident report
 */
async function triageSupportIncident(supportId, { logs = [], pool = null } = {}) {
  if (!supportId || typeof supportId !== 'string' || !SUPPORT_ID_REGEX.test(supportId.trim())) {
    return {
      supportId,
      found: false,
      error: 'INVALID_SUPPORT_ID',
      message: 'Support code must match format MX-[A-Z0-9]{4}-[A-Z0-9]{4}',
    };
  }

  const normalizedId = supportId.trim();
  let incident = null;

  // 1. Search logs
  if (Array.isArray(logs)) {
    for (const entry of logs) {
      let parsed = entry;
      if (typeof entry === 'string') {
        try {
          parsed = JSON.parse(entry);
        } catch {
          // If raw text contains support ID, parse minimally
          if (entry.includes(normalizedId)) {
            parsed = { rawText: entry };
          } else {
            continue;
          }
        }
      }

      if (parsed && typeof parsed === 'object') {
        const entrySupportId = parsed.supportId || parsed.support_id || parsed.data?.supportId;
        const matches = entrySupportId === normalizedId ||
          (parsed.rawText && parsed.rawText.includes(normalizedId)) ||
          (parsed.message && parsed.message.includes(normalizedId));

        if (matches) {
          incident = {
            service: parsed.service || parsed.role || parsed.component || 'api',
            timestamp: parsed.timestamp || parsed.time || Date.now(),
            errorCode: parsed.errorCode || parsed.code || parsed.error || parsed.event || 'UNKNOWN_ERROR',
            component: parsed.component || parsed.service || 'runtime',
            data: parsed.data || {},
          };
          break;
        }
      }
    }
  } else if (typeof logs === 'function') {
    try {
      const match = await logs(normalizedId);
      if (match) {
        incident = {
          service: match.service || 'api',
          timestamp: match.timestamp || Date.now(),
          errorCode: match.errorCode || match.code || match.error || 'UNKNOWN_ERROR',
          component: match.component || match.service || 'runtime',
          data: match.data || {},
        };
      }
    } catch {
      // ignore log lookup error
    }
  }

  // 2. Fall back to PostgreSQL query if pool is supplied and not found in logs
  if (!incident && pool && typeof pool.query === 'function') {
    try {
      // Query operator audit or incident store
      const queryStr = `
        SELECT
          details->>'service' AS service,
          details->>'component' AS component,
          action AS error_code,
          created_at AS timestamp
        FROM audit.operator_audit
        WHERE details->>'supportId' = $1
           OR details->>'support_id' = $1
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const res = await pool.query(queryStr, [normalizedId]);
      if (res && res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        incident = {
          service: row.service || 'api',
          timestamp: row.timestamp ? new Date(row.timestamp).getTime() : Date.now(),
          errorCode: row.error_code || 'OPERATOR_EVENT',
          component: row.component || 'operator_audit',
        };
      }
    } catch {
      // Table may not exist in minimal environments; ignore gracefully
    }
  }

  if (!incident) {
    return {
      supportId: normalizedId,
      found: false,
      error: 'INCIDENT_NOT_FOUND',
      message: 'No incident found matching provided support ID',
    };
  }

  // 3. Strictly strip PII and return sanitized incident metadata
  // Remove email, username, actorId, ip, address, session, password, token
  const safeData = redactSecrets(incident.data || {});
  delete safeData.email;
  delete safeData.username;
  delete safeData.phone;
  delete safeData.ip;
  delete safeData.actorId;
  delete safeData.playerId;

  return {
    supportId: normalizedId,
    found: true,
    service: incident.service,
    timestamp: typeof incident.timestamp === 'number'
      ? new Date(incident.timestamp).toISOString()
      : String(incident.timestamp),
    errorCode: incident.errorCode,
    component: incident.component,
    metadata: Object.keys(safeData).length > 0 ? safeData : undefined,
  };
}

/* ==========================================================================
 * 7. Module Exports
 * ========================================================================== */

module.exports = {
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
  defaultCollector,

  // Health Aggregator
  HealthAggregator,
  createHealthStatus,

  // Operational Support Triage
  triageSupportIncident,
};
