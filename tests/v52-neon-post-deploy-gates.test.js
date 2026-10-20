'use strict';
/* Source-only, isolated release safety checks. No production SQL, keys, VPS or external network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHANGE = path.join(ROOT, 'deploy/v5/v5-change-check.js');
const IDLE = path.join(ROOT, 'deploy/v5/v5-idle-probe.js');
const INSTALL = path.join(ROOT, 'deploy/v5/install-change-aware.sh');

function changeCheck(argv, recorded = '0/A1', current = '0/A1', recordedTables = null, currentCounters = null) {
  const source = fs.readFileSync(CHANGE, 'utf8');
  const output = [], requests = [];
  const fakeProcess = {
    argv: ['node', CHANGE, ...argv],
    env: { V5_ROOT: '/isolated/neon-audit', V5_PSQL_BIN: '/isolated/fake-psql' },
    stdout: { write: value => output.push(value) },
    stderr: { write: value => output.push(value) },
    exit: code => { throw Object.assign(Error('MOCK_EXIT'), {exitCode: code}); }
  };
  const fsMock = {
    readFileSync: (filename) => {
      if (String(filename).endsWith('last-backup-lsn')) {
        if (recorded === null) throw Error('ENOENT');
        return recorded;
      }
      if (String(filename).endsWith('last-backup-tables.json')) {
        if (recordedTables === null) throw Error('ENOENT');
        return JSON.stringify({ format: 'mega-v5-backup-table-deltas/v1', capturedAtUtc: '2026-10-20T00:00:00Z', counters: recordedTables });
      }
      throw Error('UNEXPECTED_FILE_READ');
    }
    , writeFileSync: (filename, data) => { tableWrites.push({ filename: String(filename), data }); }
    , renameSync: (from, to) => { tableRenames.push({ from: String(from), to: String(to) }); }
  };
  const tableWrites = [], tableRenames = [];
  const countersPayload = current + '\n' + JSON.stringify(currentCounters === null ? {} : currentCounters);
  const mocks = {
    'node:fs': fsMock, 'node:path': path,
    'node:child_process': {
      spawnSync: (bin, args, options) => {
        requests.push({ bin, args, options });
        const sql = String(args[4] || '');
        const stdout = sql.startsWith("SELECT (SELECT pg_current_wal_lsn()::text) ||") ? countersPayload : current + '\n';
        return { status: 0, stdout };
      }
    }
  };
  const fakeModule = { exports: {} };
  const fakeRequire = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (String(name).endsWith('direct-target.js')) {
        return {
          readTarget: () => ({ kind: 'nonserving-production-source' }),
          buildPgEnv: () => ({ PGHOST: 'test-host.invalid', PATH: '/usr/bin:/bin' })
        };
      }
      throw Error('UNEXPECTED_REQUIRE:' + name);
  };
  fakeRequire.main = fakeModule;
  const context = {
    process: fakeProcess,
    module: fakeModule,
    require: fakeRequire,
  };
  let exit;
  try { vm.runInNewContext(source, context, { filename: CHANGE, timeout: 1000 }); }
  catch (e) { if (e.exitCode === undefined) throw e; exit = e.exitCode; }
  assert.notEqual(exit, undefined, 'the CLI must terminate with a documented status');
  return { exit, output: output.join(''), requests, tableWrites, tableRenames };
}

test('an unchanged LSN returns skip=42 without force', () => {
  const r = changeCheck(['--source', '/isolated/backup-target.json']);
  assert.equal(r.exit, 42);
  assert.equal(r.requests.length, 1);
});

test('--force cannot silently turn into an unchanged skip and still validates the source', () => {
  const r = changeCheck(['--force', '--source', '/isolated/backup-target.json']);
  assert.equal(r.exit, 0);
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].bin, '/isolated/fake-psql');
  assert.equal(r.requests[0].options.env.V5_ROOT, '/isolated/neon-audit');
});

test('the LSN probe works even without a prior snapshot watermark', () => {
  const r = changeCheck(['--print-lsn'], null, '0/B42');
  assert.equal(r.exit, 0);
  assert.match(r.output, /0\/B42/);
  assert.equal(r.requests.length, 1);
});

test('no prior watermark fails open to a full dump, not a misleading unchanged skip', () => {
  const r = changeCheck([], null);
  assert.equal(r.exit, 0);
});

test('an LSN advance confined to the ephemeral ignore list still skips and refreshes the counter baseline', () => {
  const r = changeCheck(['--source', '/isolated/backup-target.json'], '0/A1', '0/A2',
    { 'ops.rate_buckets': [9, 9, 9] }, { 'ops.rate_buckets': [10, 9, 9] });
  assert.equal(r.exit, 42);
  assert.match(r.output, /ONLY_IGNORED_TABLES_CHANGED/);
  assert.equal(r.tableWrites.length, 1);
  const written = JSON.parse(r.tableWrites[0].data);
  assert.equal(written.format, 'mega-v5-backup-table-deltas/v1');
  assert.deepEqual(written.counters['ops.rate_buckets'], [10, 9, 9]);
  assert.equal(r.tableRenames.length, 1);
});

test('a tracked-table write between probes always dumps', () => {
  const r = changeCheck(['--source', '/isolated/backup-target.json'], '0/A1', '0/A2',
    { 'ops.rate_buckets': [9, 9, 9] }, { 'economy.wallets': [1, 0, 0], 'ops.rate_buckets': [10, 9, 9] });
  assert.equal(r.exit, 0);
  assert.match(r.output, /TABLE_CHANGED/);
  assert.match(r.output, /economy\.wallets/);
});

test('a counter reset (compute restart) fails open to a dump', () => {
  const r = changeCheck(['--source', '/isolated/backup-target.json'], '0/A1', '0/A2',
    { 'economy.wallets': [5, 5, 5] }, {});
  assert.equal(r.exit, 0);
  assert.match(r.output, /TABLE_CHANGED/);
});

test('a lost counter baseline fails open to a dump', () => {
  const r = changeCheck(['--source', '/isolated/backup-target.json'], '0/A1', '0/A2', null,
    { 'ops.rate_buckets': [1, 1, 1] });
  assert.equal(r.exit, 0);
  assert.match(r.output, /NO_COUNTER_BASELINE/);
});

function withSamples(before, after, args = [], input = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v52-neon-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'before.json'), JSON.stringify(before));
    fs.writeFileSync(path.join(dir, 'after.json'), JSON.stringify(after));
    const run = spawnSync(process.execPath,
      [IDLE, '--before', path.join(dir, 'before.json'), '--after', path.join(dir, 'after.json'),
        '--min-hours', '1', ...args],
      { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.error, undefined);
    assert.ok(run.stdout, 'the probe must produce a structured receipt even on failure');
    return { status: run.status, report: JSON.parse(run.stdout) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const first = {
  format: 'mega-v5-neon-usage-snapshot/v1',
  sampledAtUtc: '2026-10-19T01:00:00Z',
  consumptionPeriodStart: '2026-10-19T00:00:00Z',
  projectId: 'blue-sun-85454968',
  activeTimeSeconds: 100,
  dataTransferBytes: 4000000,
};
const later = {
  ...first, sampledAtUtc: '2026-10-19T03:00:00Z',
  activeTimeSeconds: 200, dataTransferBytes: 5000000
};

test('no provider usage snapshots cannot pass idle certification', () => {
  const run = spawnSync(process.execPath, [IDLE], { input: '', encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).gates.verdict, 'UNVERIFIED');
});

test('two valid same-period Neon snapshots measure actual active time and egress', () => {
  const { status, report } = withSamples(first, later, [], '2026-10-19T02:00:00Z backup skipped: no change\n');
  assert.equal(status, 0);
  assert.equal(report.gates.verdict, 'PASS_MEASURED_USAGE');
  assert.equal(report.providerMeasurements.activeSeconds, 100);
  assert.equal(report.providerMeasurements.egressBytes, 1000000);
  assert.equal(report.events['backup.skipped'].count, 1);
});

test('frequent wake-ups or high transfer fail the measured gate', () => {
  const active = withSamples(first, {...later, activeTimeSeconds: 2000});
  assert.equal(active.status, 2);
  assert.equal(active.report.gates.verdict, 'FAIL_IDLE_BUDGET');
  const egress = withSamples(first, {...later, dataTransferBytes: 100000000});
  assert.equal(egress.status, 2);
  assert.equal(egress.report.gates.verdict, 'FAIL_IDLE_BUDGET');
});

test('billing-period rollover, changed projects, short windows and counter rollback fail closed', () => {
  for (const bad of [
    {...later, consumptionPeriodStart: '2026-10-20T00:00:00Z'},
    {...later, projectId: 'another-project'},
    {...later, sampledAtUtc: '2026-10-19T01:01:00Z'},
    {...later, dataTransferBytes: 1}
  ]) {
    const result = withSamples(first, bad);
    assert.equal(result.status, 2);
    assert.equal(result.report.gates.verdict, 'UNVERIFIED');
  }
});

test('host installer validates staged scripts before modifying bin and snapshots ALL five files', () => {
  const source = fs.readFileSync(INSTALL, 'utf8');
  assert.ok(source.indexOf('probe --print-lsn') > 0);
  assert.ok(source.indexOf('probe --print-lsn') < source.indexOf('mutation_started=1'));
  assert.match(source, /V5_PSQL_BIN="\$STAGE\/psql"/);
  assert.match(source, /P15_PGSSLROOTCERT="\$STATE\/neon-ca\.pem"/);
  assert.match(source, /P15_OWNER_APPROVE_PRODUCTION_BACKUP=1/);
  assert.match(source, /flock -n 9/);
  assert.match(source, /FILES=\(v5-pg-backup\.sh v5-freshness\.js v5-change-check\.js psql v5-idle-probe\.js\)/);
  assert.match(source, /INSTALL_ROLLED_BACK/);
  assert.equal(spawnSync('bash', ['-n', INSTALL], {encoding:'utf8'}).status, 0);
  assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'deploy/v5/v5-pg-backup.sh')], {encoding:'utf8'}).status, 0);
  assert.equal(spawnSync('sh', ['-n', path.join(ROOT, 'deploy/v5/psql')], {encoding:'utf8'}).status, 0);
});
