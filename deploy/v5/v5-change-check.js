'use strict';

/**
 * V5 change-aware backup gate (infrastructure brief 2026-10-19, part G; 2026-10-20 A4 amendment).
 *
 * Decides whether the next backup cycle must stream a fresh dump from the source database.
 * The probe is fail-closed: every uncertain condition dumps.
 *
 * Decision layers:
 *   1. WAL LSN (unchanged since the recorded pre-dump value) - a skip here is the cheap,
 *      exact no-write proof and costs one tiny round trip.
 *   2. Per-table write counters (pg_stat_user_tables deltas) - when the LSN DID advance,
 *      the cycle still skips when the ONLY tables that moved are on the ephemeral ignore
 *      list (ops.rate_buckets: anonymous request counters, download/metrics tallies and
 *      presence polling noise). Those rows are rebuildable operational state whose loss
 *      window is bounded by the normal dump cadence, and one ambient poll every few
 *      seconds must never force a full-database stream - that is what made the 24-48h
 *      Neon idle budget unwinnable (2026-10-20 A4 pre-flight, AUDIT-DECISION-LOG.md).
 *      Identity, economy, core, monetization, audit and every other schema always dump.
 *
 * State files (host STATE dir, root-only) are OWNED BY THE CALLER (v5-pg-backup.sh), which
 * writes BOTH the LSN watermark and the counter baseline from this probe's single atomic
 * JSON payload - the pair must always describe the same moment, and only a VERIFIED dump (or
 * a proven no-data-change skip) may advance them. Losing either file fails open to a full
 * dump. A counter RESET (compute restart) reads as a negative delta and dumps.
 *
 *   exit 0  - must dump (changed, first run, state lost, counter reset, or --force)
 *   exit 42 - skip: no tracked-table change since the recorded state
 *   other   - fail closed (the caller treats it as a failed cycle)
 *
 * --print-lsn ALWAYS invokes a real pg_current_wal_lsn() probe (used by the caller for the
 * freshness marker) and never consults state files.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
/* Layout-tolerant: repo checkouts keep the p15 contract one directory up; the host install
 * places this file in $BIN next to the psql wrapper with the contract under $LIB. */
const contractPaths = [
  '../scripts/v5/p15/direct-target.js',
  path.join(process.env.V5_ROOT || '/opt/mega-xo-v5-production', 'lib/scripts/v5/p15/direct-target.js'),
];
let directTarget = null;
for (const candidate of contractPaths) { try { directTarget = require(candidate); break; } catch {} }
if (!directTarget && require.main === module) refuse('P15_DIRECT_TARGET_CONTRACT_MISSING');
const { readTarget, buildPgEnv } = directTarget || {};

const ROOT = process.env.V5_ROOT || '/opt/mega-xo-v5-production';
const STATE = path.join(ROOT, 'state');
const LSN_FILE = path.join(STATE, 'last-backup-lsn');
const TABLES_FILE = path.join(STATE, 'last-backup-tables.json');
const TABLES_FORMAT = 'mega-v5-backup-table-deltas/v1';
/* Tables whose writes must never trigger a full dump. Keep this list SHORT and audited:
 * every entry accepts unbounded staleness for that table across disaster recovery. */
const IGNORED_TABLES = Object.freeze(['ops.rate_buckets']);

function refuse(code) { process.stderr.write('V5_CHANGE_CHECK_REFUSED: ' + code + '\n'); process.exit(2); }

const args = process.argv.slice(2);
const force = args.includes('--force');
const source = args[args.indexOf('--source') + 1] || path.join(STATE, 'prod-source.json');
const printLsn = args.includes('--print-lsn');

/* Sol P1 #3: the source argument is a PATH - readTarget parses it, then assertTarget validates
 * the parsed object. assertTarget on the raw string always refuses. Read LAZILY so the argument
 * parsing above has run (Sol round-2: readTarget executed before its const was initialized). */
function buildTargetEnv() {
  return buildPgEnv(readTarget(source, 'backup', process.env), process.env);
}

function runProbe(sql, single) {
  // The P15 environment intentionally strips ambient variables. Carry ONLY the deployment
  // root so the pinned psql wrapper reads the same root's protected image identity when
  // an isolated rehearsal uses V5_ROOT rather than the host production default.
  const pgEnv = { ...buildTargetEnv(), V5_ROOT: ROOT };
  const probe = spawnSync(process.env.V5_PSQL_BIN || 'psql',
    ['-X', '-t', '-A', '-c', sql],
    { env: pgEnv, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  if (probe.error || probe.status !== 0) refuse(probe.error ? String(probe.error.code || probe.error.message) : 'psql-exit-' + probe.status);
  return String(probe.stdout || '');
}

function queryLsn() {
  const value = runProbe('SELECT pg_current_wal_lsn()::text', true).trim();
  if (!/^[0-9A-F]+\/[0-9A-F]+$/.test(value)) refuse('lsn-unparsable');
  return value;
}
if (printLsn && require.main === module) { process.stdout.write(queryLsn() + '\n'); process.exit(0); }

/* One atomic snapshot: the current LSN plus the per-table cumulative write counters, so the
 * two halves of the decision can never disagree about the moment they measured. */
const COMBINED_SQL = "SELECT (SELECT pg_current_wal_lsn()::text) || E'\n' || " +
  "COALESCE((SELECT json_object_agg(tbl, ARRAY[c1, c2, c3])::text FROM (" +
  "SELECT schemaname || '.' || relname AS tbl, n_tup_ins AS c1, n_tup_upd AS c2, n_tup_del AS c3 " +
  "FROM pg_stat_user_tables) s), '{}')";

function parseCounters(text) {
  if (!text) return null;
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  const lsn = text.slice(0, nl).trim();
  if (!/^[0-9A-F]+\/[0-9A-F]+$/.test(lsn)) return null;
  let counters;
  try { counters = JSON.parse(text.slice(nl + 1).trim() || '{}'); } catch { return null; }
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) return null;
  for (const [table, triple] of Object.entries(counters)) {
    if (!Array.isArray(triple) || triple.length !== 3 || triple.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  }
  return { lsn, counters };
}

function recordedLsn() {
  try {
    const value = fs.readFileSync(LSN_FILE, 'utf8').trim();
    return /^[0-9A-F]+\/[0-9A-F]+$/.test(value) ? value : null;
  } catch { return null; }
}

function recordedCounters() {
  try {
    const doc = JSON.parse(fs.readFileSync(TABLES_FILE, 'utf8'));
    if (doc.format !== TABLES_FORMAT || !doc.counters || typeof doc.counters !== 'object') return null;
    for (const [table, triple] of Object.entries(doc.counters)) {
      if (!Array.isArray(triple) || triple.length !== 3 || triple.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
    }
    return doc.counters;
  } catch { return null; }
}

/* Pure decision core (unit-tested): given the recorded and current states, decide dump/skip.
 *  - any tracked-table delta (including a counter RESET, current < recorded) dumps;
 *  - deltas confined to IGNORED_TABLES skip;
 *  - an absent recorded snapshot or unparsable input dumps (fail open). */
function decide({ previousLsn, currentLsn, recordedCounters: recorded, currentCounters: current }) {
  if (!previousLsn || !currentLsn) return { dump: true, reason: 'NO_RECORDED_STATE' };
  if (previousLsn === currentLsn) return { dump: false, reason: 'LSN_UNCHANGED' };
  if (!recorded || !current) return { dump: true, reason: 'NO_COUNTER_BASELINE' };
  const tables = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  for (const table of tables) {
    if (IGNORED_TABLES.includes(table)) continue;
    const before = recorded[table] || [0, 0, 0];
    const after = current[table] || [0, 0, 0];
    if (after[0] !== before[0] || after[1] !== before[1] || after[2] !== before[2]) {
      return { dump: true, reason: 'TABLE_CHANGED', table };
    }
  }
  return { dump: false, reason: 'ONLY_IGNORED_TABLES_CHANGED' };
}

if (require.main === module) {
  const previous = recordedLsn();
  // --force is never downgraded to a skip; it still probes through the same atomic snapshot
  // so the caller can persist a coherent LSN+counter pair from the forced dump.
  const snap = parseCounters(runProbe(COMBINED_SQL));
  if (!snap) refuse('probe-unparsable');
  const verdict = force || !previous
    ? { dump: true, reason: force ? 'FORCED' : 'NO_RECORDED_STATE' }
    : decide({ previousLsn: previous, currentLsn: snap.lsn, recordedCounters: recordedCounters(), currentCounters: snap.counters });
  process.stdout.write(JSON.stringify({
    event: 'change_check', ...verdict, current: snap.lsn, previous,
    tablesStateDoc: JSON.stringify({ format: TABLES_FORMAT, capturedAtUtc: new Date().toISOString(), counters: snap.counters }),
  }) + '\n');
  process.exit(verdict.dump ? 0 : 42);
}

module.exports = { decide, IGNORED_TABLES, TABLES_FORMAT, parseCounters };

