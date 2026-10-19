'use strict';

/* Idle-baseline probe (infrastructure brief 2026-10-19, parts 7/8).
 *
 * Aggregates the production server's structured log stream into the acceptance-gate metrics
 * WITHOUT querying the database (monitoring must not keep it awake):
 *   - tournament sweep intervals (deadline-driven after the fix; a flat 1s cadence FAILS)
 *   - matchmaker tick intervals (empty-queue backoff; a flat 3s cadence FAILS)
 *   - worker pass lanes, backup cycles (dump vs change-aware skip), /readyz probe rate
 *
 * Usage (Oracle host, 24-48h soak):
 *   journalctl -u mega-xo-v5 -o cat --since -48h | node v5-idle-probe.js > idle-report.json
 */
const readline = require('node:readline');

const events = new Map();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let doc; try { doc = JSON.parse(line); } catch { return; }
  if (!doc || typeof doc !== 'object' || typeof doc.event !== 'string' || typeof doc.at !== 'string') return;
  const at = Date.parse(doc.at); if (!Number.isFinite(at)) return;
  if (!events.has(doc.event)) events.set(doc.event, []);
  events.get(doc.event).push(at);
});
rl.on('close', () => {
  const report = { format: 'mega-v5-idle-probe/v1', generatedAt: new Date().toISOString(), events: {}, gates: {} };
  for (const [name, stamps] of events) {
    stamps.sort((a, b) => a - b);
    const gaps = []; for (let i = 1; i < stamps.length; i++) gaps.push((stamps[i] - stamps[i - 1]) / 1000);
    report.events[name] = { count: stamps.length, first: new Date(stamps[0]).toISOString(), last: new Date(stamps[stamps.length - 1]).toISOString(), gapSeconds: gaps.length ? { min: Math.min(...gaps), max: Math.max(...gaps), mean: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 100) / 100 } : null };
  }
  report.gates.note = 'A flat fast cadence for tournament/matchmaker events during an idle window FAILS part 7; backup skip events are expected in an idle system.';
  process.stdout.write(JSON.stringify(report, null, 1) + '\n');
});
