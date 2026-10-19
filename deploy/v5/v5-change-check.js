'use strict';

/**
 * V5 change-aware backup gate (infrastructure brief 2026-10-19, part G).
 *
 * Compares the source database current WAL LSN against the LSN recorded before the last
 * successful dump. The LSN is server-side durable state that advances for EVERY writer commit
 * (API, Core, worker - all roles share one WAL), and the recorded value is captured BEFORE a
 * dump starts, so any commit after it forces the next cycle to dump: a skip only ever happens
 * when nothing at all has changed. Losing the state file (host loss) fails open to a full dump.
 *
 *   exit 0  - must dump (changed, first run, state lost, or --force)
 *   exit 42 - skip: no change since the recorded LSN
 *   other   - fail closed (the caller treats it as a failed cycle)
 *
 * The probe is a single pg_current_wal_lsn()::text read - a few bytes, no user tables - so a
 * skip cycle costs one tiny round trip instead of streaming the whole database.
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
if (!directTarget) refuse('P15_DIRECT_TARGET_CONTRACT_MISSING');
const { readTarget, buildPgEnv } = directTarget;

const ROOT = process.env.V5_ROOT || '/opt/mega-xo-v5-production';
const STATE = path.join(ROOT, 'state');
const LSN_FILE = path.join(STATE, 'last-backup-lsn');
const args = process.argv.slice(2);
const force = args.includes('--force');
const source = args[args.indexOf('--source') + 1] || path.join(STATE, 'prod-source.json');
const printLsn = args.includes('--print-lsn');

function refuse(code) { process.stderr.write('V5_CHANGE_CHECK_REFUSED: ' + code + '\n'); process.exit(2); }
/* Sol P1 #3: the source argument is a PATH - readTarget parses it, then assertTarget validates
 * the parsed object. assertTarget on the raw string always refuses. Read LAZILY so the argument
 * parsing above has run (Sol round-2: readTarget executed before its const was initialized). */
function buildTargetEnv() {
  return buildPgEnv(readTarget(source, 'backup', process.env), process.env);
}

function recordedLsn() {
  try {
    const value = fs.readFileSync(LSN_FILE, 'utf8').trim();
    return /^[0-9A-F]+\/[0-9A-F]+$/.test(value) ? value : null;
  } catch { return null; }
}

function queryLsn() {
  const probe = spawnSync(process.env.V5_PSQL_BIN || 'psql',
    ['-X', '-t', '-A', '-c', 'SELECT pg_current_wal_lsn()::text'],
    { env: buildTargetEnv(), encoding: 'utf8', timeout: 30000 });
  if (probe.error || probe.status !== 0) refuse(probe.error ? String(probe.error.code || probe.error.message) : 'psql-exit-' + probe.status);
  const value = String(probe.stdout || '').trim();
  if (!/^[0-9A-F]+\/[0-9A-F]+$/.test(value)) refuse('lsn-unparsable');
  return value;
}
if (printLsn) { process.stdout.write(queryLsn() + '\n'); process.exit(0); }
const previous = recordedLsn();
if (!previous) process.exit(0); // fail open: unknown state dumps
const current = queryLsn();
 /* Sol P1 #5: the changed/unchanged decision is ALL this script owns. The freshness marker is
  * written by v5-pg-backup.sh, which can bind it to the newest VERIFIED archive identity - a
  * marker written here could not be bound and might vouch for the wrong recovery point. */
process.stdout.write(JSON.stringify({ event: 'change_check', changed: current !== previous, current, previous }) + '\n');
process.exit(current !== previous ? 0 : 42);

