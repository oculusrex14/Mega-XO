'use strict';

/**
 * Read-only idle soak evaluator.
 *
 * A journal showing no activity is NOT proof that a database slept. This command refuses to
 * certify an idle window without TWO dated, same-period Neon project usage snapshots, because
 * missing/malformed logs otherwise generated an attractive but content-free "gates" report.
 *
 * Example (collect snapshots privately from Neon describe_project API before/after 24h):
 *   journalctl -u mega-xo-v5-production.service -u mega-xo-v5-backup.service \
 *     -o cat --since '24 hours ago' | \
 *     node v5-idle-probe.js --before before.json --after after.json > idle-report.json
 *
 * Snapshot schema (NEVER include an API key or database URL):
 *   {"format":"mega-v5-neon-usage-snapshot/v1","sampledAtUtc":"2026-10-19T00:00:00Z",
 *    "projectId":"blue-sun-85454968","consumptionPeriodStart":"2026-10-19T00:00:00Z",
 *    "activeTimeSeconds":150,"dataTransferBytes":1234567}
 *
 * Project API counters are monotonic only WITHIN a consumption period. The script rejects a
 * period reset, backward counters, mismatched project IDs and insufficient observation windows.
 */
const fs = require('node:fs');
const readline = require('node:readline');

const FORMAT = 'mega-v5-neon-usage-snapshot/v1';
const EVENTS_LIMIT = 200000;
const MAX_FILE_BYTES = 16384;
const MB = 1000000;
const DAY_SECONDS = 86400;
const args = process.argv.slice(2);

function requireArgs() {
  const result = { before: null, after: null, minHours: 24, maxActivePercent: 5, maxEgressMbPerDay: 50 };
  for (let i = 0; i < args.length; i++) {
    const key = args[i], next = args[++i];
    if (key === '--before') result.before = next;
    else if (key === '--after') result.after = next;
    else if (key === '--min-hours') result.minHours = Number(next);
    else if (key === '--max-active-percent') result.maxActivePercent = Number(next);
    else if (key === '--max-egress-mb-per-day') result.maxEgressMbPerDay = Number(next);
    else throw Error('INVALID_PROBE_ARGUMENT');
  }
  if (!Number.isFinite(result.minHours) || result.minHours < 1 || result.minHours > 168 ||
      !Number.isFinite(result.maxActivePercent) || result.maxActivePercent < 0 || result.maxActivePercent > 100 ||
      !Number.isFinite(result.maxEgressMbPerDay) || result.maxEgressMbPerDay < 0 || result.maxEgressMbPerDay > 10000) {
    throw Error('INVALID_PROBE_BOUND');
  }
  return result;
}

function snapshot(filename) {
  if (typeof filename !== 'string' || !filename || !fs.existsSync(filename)) throw Error('MISSING_USAGE_SNAPSHOT');
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw Error('INVALID_USAGE_SNAPSHOT_FILE');
  const doc = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (doc.format !== FORMAT || typeof doc.sampledAtUtc !== 'string' ||
      typeof doc.consumptionPeriodStart !== 'string' ||
      !/^[a-z0-9-]{4,80}$/.test(doc.projectId || '')) throw Error('INVALID_USAGE_SNAPSHOT');
  const at = Date.parse(doc.sampledAtUtc), period = Date.parse(doc.consumptionPeriodStart);
  if (!Number.isFinite(at) || !Number.isFinite(period) || period > at ||
      !Number.isSafeInteger(doc.activeTimeSeconds) || doc.activeTimeSeconds < 0 ||
      !Number.isSafeInteger(doc.dataTransferBytes) || doc.dataTransferBytes < 0) {
    throw Error('INVALID_USAGE_SNAPSHOT');
  }
  return { projectId: doc.projectId, at, period,
    activeSeconds: doc.activeTimeSeconds, egressBytes: doc.dataTransferBytes };
}

function evaluate(first, last, conf) {
  if (first.projectId !== last.projectId || first.period !== last.period) {
    throw Error('PROJECT_OR_BILLING_PERIOD_CHANGED');
  }
  const seconds = (last.at - first.at) / 1000;
  if (seconds < conf.minHours * 3600) throw Error('OBSERVATION_WINDOW_TOO_SHORT');
  const activeSeconds = last.activeSeconds - first.activeSeconds;
  const egressBytes = last.egressBytes - first.egressBytes;
  if (activeSeconds < 0 || egressBytes < 0 || activeSeconds > seconds * 1.05) {
    throw Error('CONSUMPTION_COUNTERS_INVALID');
  }
  const activePercent = (activeSeconds / seconds) * 100;
  const egressMbPerDay = egressBytes / MB * DAY_SECONDS / seconds;
  return {
    windowHours: Math.round(seconds / 3600 * 100) / 100,
    projectId: first.projectId,
    activeSeconds, egressBytes,
    activePercent: Math.round(activePercent * 100) / 100,
    egressMbPerDay: Math.round(egressMbPerDay * 100) / 100,
    maxActivePercent: conf.maxActivePercent,
    maxEgressMbPerDay: conf.maxEgressMbPerDay,
    activeGate: activePercent <= conf.maxActivePercent,
    egressGate: egressMbPerDay <= conf.maxEgressMbPerDay,
  };
}

function main() {
  const report = {
    format: 'mega-v5-idle-probe/v2', generatedAt: new Date().toISOString(),
    events: {}, providerMeasurements: null,
    gates: { verdict: 'UNVERIFIED', reason: 'Neon provider before/after measurements required' },
  };
  const events = new Map();
  let seen = 0, dropped = 0;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let event = null, at = null;
    try {
      const doc = JSON.parse(line);
      if (doc && typeof doc.event === 'string' && typeof doc.at === 'string') {
        event = doc.event;
        at = Date.parse(doc.at);
      }
    } catch {
      // The independent backup oneshot logs timestamped plain text, not JSON events.
      const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) backup (start|skipped|complete)\b/.exec(line);
      if (match) { event = 'backup.' + match[2]; at = Date.parse(match[1]); }
    }
    if (event === null || !Number.isFinite(at)) return;
    if (++seen > EVENTS_LIMIT) { dropped++; return; }
    if (!events.has(event)) events.set(event, []);
    events.get(event).push(at);
  });
  rl.on('close', () => {
    for (const [name, stamps] of events) {
      stamps.sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / 1000);
      report.events[name] = {
        count: stamps.length, first: new Date(stamps[0]).toISOString(),
        last: new Date(stamps[stamps.length - 1]).toISOString(),
        gapSeconds: gaps.length ? {
          min: Math.min(...gaps), max: Math.max(...gaps),
          mean: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 100) / 100,
        } : null,
      };
    }
    report.eventCoverage = { recognized: seen - dropped, dropped, note:
      'Log-event gaps are diagnostic, not proof of database sleep; provider measurements govern the verdict.' };
    try {
      const conf = requireArgs();
      if (!conf.before || !conf.after) throw Error('MISSING_USAGE_SNAPSHOTS');
      const metrics = evaluate(snapshot(conf.before), snapshot(conf.after), conf);
      report.providerMeasurements = metrics;
      report.gates = {
        verdict: metrics.activeGate && metrics.egressGate ? 'PASS_MEASURED_USAGE' : 'FAIL_IDLE_BUDGET',
        activeGate: metrics.activeGate, egressGate: metrics.egressGate,
        note: 'This tests database usage for a declared idle window, not the absence of live player requests; verify load independently.',
      };
    } catch (error) {
      report.gates = { verdict: 'UNVERIFIED', reason: String(error.message).slice(0, 80) };
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.gates.verdict !== 'PASS_MEASURED_USAGE') process.exitCode = 2;
  });
}
main();
