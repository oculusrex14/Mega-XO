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
const { readTarget, assertTarget, buildPgEnv } = directTarget;

const ROOT = process.env.V5_ROOT || '/opt/mega-xo-v5-production';
const STATE = path.join(ROOT, 'state');
const LSN_FILE = path.join(STATE, 'last-backup-lsn');
const args = process.argv.slice(2);
const force = args.includes('--force');
const source = args[args.indexOf('--source') + 1] || path.join(STATE, 'prod-source.json');
const printLsn = args.includes('--print-lsn');

function refuse(code) { process.stderr.write('V5_CHANGE_CHECK_REFUSED: ' + code + '\n'); process.exit(2); }

function recordedLsn() {
  try {
    const value = fs.readFileSync(LSN_FILE, 'utf8').trim();
    return /^[0-9A-F]+\/[0-9A-F]+$/.test(value) ? value : null;
  } catch { return null; }
}

function queryLsn() {
  const probe = spawnSync(process.env.V5_PSQL_BIN || 'psql',
    ['-X', '-t', '-A', '-c', 'SELECT pg_current_wal_lsn()::text'],
    { env: buildPgEnv(assertTarget(source, 'backup', process.env), process.env), encoding: 'utf8', timeout: 30000 });
  if (probe.error || probe.status !== 0) refuse(probe.error ? String(probe.error.code || probe.error.message) : 'psql-exit-' + probe.status);
  const value = String(probe.stdout || '').trim();
  if (!/^[0-9A-F]+\/[0-9A-F]+$/.test(value)) refuse('lsn-unparsable');
  return value;
}
if (printLsn) { process.stdout.write(queryLsn() + '\n'); process.exit(0); }
const previous = recordedLsn();
if (!previous) process.exit(0); // fail open: unknown state dumps
const current = queryLsn();
 if (current === previous) {
  /* Honest freshness handoff: the newest archive is an ARTIFACT older than the RPO but still
   * contains every committed row, because nothing changed since its pre-dump LSN. The marker
   * (0600, host-local) tells v5-freshness.js exactly that; it is deleted on the next real dump.
   * Fail-closed default: a missing/stale/unparsable marker is treated as no marker at all. */
  const marker = JSON.stringify({ checkedAt: new Date().toISOString(), lsn: current, previous }) + '\n';
  const tmp = LSN_FILE + '.unchanged.tmp';
  fs.writeFileSync(tmp, marker, { mode: 0o600 });
  fs.renameSync(tmp, path.join(STATE, 'backup-unchanged.json'));
 } else {
  try { fs.unlinkSync(path.join(STATE, 'backup-unchanged.json')); } catch {}
 }
process.stdout.write(JSON.stringify({ event: 'change_check', changed: current !== previous, current, previous }) + '\n');
process.exit(current !== previous ? 0 : 42);

