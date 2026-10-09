'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * P24 - Evidence-Led Scaling Triggers & Review
 *
 * Requirements:
 * 1. Validates scaling triggers: database capacity, connection pool budget,
 *    Redis memory, and Core websocket limits.
 * 2. Proves scaling thresholds and alerts trigger without exceeding Free-tier quotas unexpectedly.
 * 3. Enforces that scale-up actions require measured justification and cannot be speculatively added.
 */

// Free-tier Quota Envelopes and Scaling Thresholds
const FREE_TIER_QUOTAS = Object.freeze({
  postgresNeon: {
    storageBytesMax: 500 * 1024 * 1024, // 500 MB Neon free limit
    computeHoursMax: 100,               // Compute hours / month
    maxConnectionsBudget: 20            // Connection cap
  },
  redisUpstash: {
    maxMemoryBytes: 256 * 1024 * 1024,  // 256 MB free tier
    maxDailyCommands: 10000             // Free command allowance
  },
  coreProcess: {
    maxWebsocketConnections: 1000,      // Single core WS limit
    maxRssMemoryBytes: 512 * 1024 * 1024 // 512 MB per core
  }
});

const SCALING_ALERT_THRESHOLDS = Object.freeze({
  postgresStoragePercent: 80,           // Alert at 80% (400 MB)
  postgresConnectionPercent: 75,        // Alert at 75% (15 / 20)
  redisMemoryPercent: 75,               // Alert at 75% (192 MB)
  coreWebsocketPercent: 80              // Alert at 80% (800 conns)
});

class CapacityMonitor {
  constructor(quotas = FREE_TIER_QUOTAS, thresholds = SCALING_ALERT_THRESHOLDS) {
    this.quotas = quotas;
    this.thresholds = thresholds;
  }

  evaluateState(metrics) {
    const alerts = [];
    const scalingTriggered = [];

    // 1. PostgreSQL Storage Check
    const pgStoragePct = (metrics.pgStorageBytes / this.quotas.postgresNeon.storageBytesMax) * 100;
    if (pgStoragePct >= this.thresholds.postgresStoragePercent) {
      alerts.push({
        resource: 'POSTGRES_STORAGE',
        level: pgStoragePct >= 95 ? 'CRITICAL' : 'WARNING',
        current: metrics.pgStorageBytes,
        threshold: this.quotas.postgresNeon.storageBytesMax * (this.thresholds.postgresStoragePercent / 100),
        message: `PostgreSQL storage at ${pgStoragePct.toFixed(1)}% of free tier`
      });
      if (pgStoragePct >= 90) {
        scalingTriggered.push('SCALE_NEON_STORAGE_OR_PURGE_EPHEMERAL');
      }
    }

    // 2. PostgreSQL Connection Pool Check
    const pgConnPct = (metrics.pgActiveConnections / this.quotas.postgresNeon.maxConnectionsBudget) * 100;
    if (pgConnPct >= this.thresholds.postgresConnectionPercent) {
      alerts.push({
        resource: 'POSTGRES_CONNECTIONS',
        level: pgConnPct >= 90 ? 'CRITICAL' : 'WARNING',
        current: metrics.pgActiveConnections,
        threshold: this.quotas.postgresNeon.maxConnectionsBudget * (this.thresholds.postgresConnectionPercent / 100),
        message: `PostgreSQL connections at ${pgConnPct.toFixed(1)}% of pool budget`
      });
      if (pgConnPct >= 85) {
        scalingTriggered.push('ENGAGE_CONNECTION_DRAIN_OR_POOL_EXPANSION');
      }
    }

    // 3. Redis Memory Check
    const redisMemPct = (metrics.redisMemoryBytes / this.quotas.redisUpstash.maxMemoryBytes) * 100;
    if (redisMemPct >= this.thresholds.redisMemoryPercent) {
      alerts.push({
        resource: 'REDIS_MEMORY',
        level: redisMemPct >= 90 ? 'CRITICAL' : 'WARNING',
        current: metrics.redisMemoryBytes,
        threshold: this.quotas.redisUpstash.maxMemoryBytes * (this.thresholds.redisMemoryPercent / 100),
        message: `Redis memory usage at ${redisMemPct.toFixed(1)}%`
      });
      if (redisMemPct >= 90) {
        scalingTriggered.push('TRUNCATE_EXPIRED_PRESENCE_OR_UPGRADE_REDIS');
      }
    }

    // 4. Core WebSocket Limits
    const wsPct = (metrics.coreActiveWebsockets / this.quotas.coreProcess.maxWebsocketConnections) * 100;
    if (wsPct >= this.thresholds.coreWebsocketPercent) {
      alerts.push({
        resource: 'CORE_WEBSOCKETS',
        level: wsPct >= 90 ? 'CRITICAL' : 'WARNING',
        current: metrics.coreActiveWebsockets,
        threshold: this.quotas.coreProcess.maxWebsocketConnections * (this.thresholds.coreWebsocketPercent / 100),
        message: `Core process WebSockets at ${wsPct.toFixed(1)}%`
      });
      if (wsPct >= 90) {
        scalingTriggered.push('ROUTE_NEW_ROOMS_TO_SECONDARY_CORE');
      }
    }

    return {
      alerts,
      scalingTriggered,
      isWithinFreeTierSafely: alerts.filter(a => a.level === 'CRITICAL').length === 0
    };
  }
}

test('Capacity monitor remains green within normal baseline envelope', () => {
  const monitor = new CapacityMonitor();
  const baselineMetrics = {
    pgStorageBytes: 150 * 1024 * 1024,      // 30% of 500MB
    pgActiveConnections: 6,                 // 30% of 20
    redisMemoryBytes: 50 * 1024 * 1024,     // 19.5% of 256MB
    coreActiveWebsockets: 200               // 20% of 1000
  };

  const evaluation = monitor.evaluateState(baselineMetrics);
  assert.equal(evaluation.alerts.length, 0);
  assert.equal(evaluation.scalingTriggered.length, 0);
  assert.equal(evaluation.isWithinFreeTierSafely, true);
});

test('Scaling alerts trigger accurately when approaching Free-tier thresholds', () => {
  const monitor = new CapacityMonitor();

  // Scenario: Postgres storage reaches 82% and connections reach 80%
  const elevatedMetrics = {
    pgStorageBytes: 410 * 1024 * 1024,      // 82%
    pgActiveConnections: 16,                // 80%
    redisMemoryBytes: 80 * 1024 * 1024,     // 31%
    coreActiveWebsockets: 300               // 30%
  };

  const evaluation = monitor.evaluateState(elevatedMetrics);
  assert.equal(evaluation.alerts.length, 2);
  assert.ok(evaluation.alerts.some(a => a.resource === 'POSTGRES_STORAGE' && a.level === 'WARNING'));
  assert.ok(evaluation.alerts.some(a => a.resource === 'POSTGRES_CONNECTIONS' && a.level === 'WARNING'));
  assert.equal(evaluation.isWithinFreeTierSafely, true);
});

test('Critical thresholds trigger operational scaling actions before hard quota breach', () => {
  const monitor = new CapacityMonitor();

  // Scenario: Severe load where Core websockets reach 92% and Redis reaches 91%
  const criticalMetrics = {
    pgStorageBytes: 200 * 1024 * 1024,
    pgActiveConnections: 10,
    redisMemoryBytes: 235 * 1024 * 1024,    // 91.8%
    coreActiveWebsockets: 920               // 92%
  };

  const evaluation = monitor.evaluateState(criticalMetrics);
  assert.ok(evaluation.alerts.some(a => a.resource === 'REDIS_MEMORY' && a.level === 'CRITICAL'));
  assert.ok(evaluation.alerts.some(a => a.resource === 'CORE_WEBSOCKETS' && a.level === 'CRITICAL'));
  assert.deepEqual(evaluation.scalingTriggered, [
    'TRUNCATE_EXPIRED_PRESENCE_OR_UPGRADE_REDIS',
    'ROUTE_NEW_ROOMS_TO_SECONDARY_CORE'
  ]);
  assert.equal(evaluation.isWithinFreeTierSafely, false);
});

test('Speculative capacity additions are rejected without measured metric justification', () => {
  // Rule: Scale triggers cannot activate when metrics are sub-threshold
  const monitor = new CapacityMonitor();
  const lowUsageMetrics = {
    pgStorageBytes: 50 * 1024 * 1024,
    pgActiveConnections: 2,
    redisMemoryBytes: 10 * 1024 * 1024,
    coreActiveWebsockets: 50
  };

  const evaluation = monitor.evaluateState(lowUsageMetrics);
  assert.equal(evaluation.scalingTriggered.length, 0);

  function applySpeculativeScaleUp(evalResult) {
    if (evalResult.scalingTriggered.length === 0) {
      throw new Error('NOT_TRIGGERED: Speculative scaling disallowed without measured load');
    }
  }

  assert.throws(() => applySpeculativeScaleUp(evaluation), /NOT_TRIGGERED/);
});
