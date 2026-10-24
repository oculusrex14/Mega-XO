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

function changeCheck(argv, recorded = '0/A1', current = '0/A1') {
  const token = {format:'mega-v5-db-change/v1',database:'test_db',epoch:'a'.repeat(32),
    covered:true,excludedSchemas:['learning'],revisions:Array(64).fill('0'),sequences:[]};
  const target = require('node:crypto').createHash('sha256').update(JSON.stringify([
    undefined,undefined,undefined,undefined,'test_db'
  ])).digest('hex');
  const watermark = {format:'mega-v5-backup-watermark/v2',backupId:'v5-p15-fixture',target,token,
    ciphertextSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
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
    existsSync:()=>false,
    readFileSync: (filename) => {
      if (String(filename).endsWith('last-backup-state.json')) {
        if (recorded === null) throw Error('ENOENT');
        return JSON.stringify(watermark);
      }
      throw Error('UNEXPECTED_FILE_READ');
    }
  };
  const mocks = {
    'node:fs': fsMock, 'node:path': path, 'node:crypto': require('node:crypto'),
    'node:child_process': {
      spawnSync: (bin, args, options) => {
        requests.push({ bin, args, options });
        return { status: 0, stdout: args.includes('SELECT pg_current_wal_lsn()::text')
          ? current + '\n' : JSON.stringify({lsn:current,token}) };
      }
    }
  };
  const mockModule = {exports:{}};
  const req = name => {
    if (Object.hasOwn(mocks,name)) return mocks[name];
    if (String(name).endsWith('direct-target.js')) return {
      readTarget:()=>({kind:'nonserving-production-source',database:'test_db'}),
      buildPgEnv:()=>({PGHOST:'test-host.invalid',PATH:'/usr/bin:/bin'})
    };
    throw Error('UNEXPECTED_REQUIRE:'+name);
  };
  req.main=mockModule;
  const context = {
    module: mockModule,
    process: fakeProcess,
    require: req
  };
  let exit;
  try { vm.runInNewContext(source, context, { filename: CHANGE, timeout: 1000 }); }
  catch (e) { if (e.exitCode === undefined) throw e; exit = e.exitCode; }
  exit ??= fakeProcess.exitCode;
  assert.notEqual(exit, undefined, 'the CLI must terminate with a documented status');
  return { exit, output: output.join(''), requests };
}

test('an unchanged protected database token returns skip=42 even when cluster WAL advances', () => {
  const r = changeCheck(['--source', '/isolated/backup-target.json'],'0/A1','0/B2');
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
  format: 'mega-v5-neon-usage-snapshot/v2',
  sampledAtUtc: '2026-10-19T01:00:00Z',
  consumptionPeriodStart: '2026-10-19T00:00:00Z',
  projectId: 'blue-sun-85454968',
  activeTimeSeconds: 100,
  computeTimeSeconds:25,
  metricSources:{activeTimeSeconds:'project.active_time_seconds',computeTimeSeconds:'consumption.compute_time_seconds',dataTransferBytes:'consumption.data_transfer_bytes'},
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

test('historical CU-seconds snapshots cannot certify wall-clock sleep',()=>{
 const old=withSamples({...first,format:'mega-v5-neon-usage-snapshot/v1'},later);
 assert.equal(old.status,2);
 assert.equal(old.report.gates.reason,'LEGACY_COUNTER_UNIT_UNVERIFIED');
 const mislabeled=withSamples({...first,metricSources:{...first.metricSources,activeTimeSeconds:'consumption.compute_time_seconds'}},later);
 assert.equal(mislabeled.status,2);
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
  assert.match(source, /FILES=\(v5-pg-backup\.sh v5-freshness\.js v5-change-check\.js v5-journal-check\.js psql v5-idle-probe\.js pg_restore\)/);
  assert.match(source, /INSTALL_ROLLED_BACK/);
  assert.equal(spawnSync('bash', ['-n', INSTALL], {encoding:'utf8'}).status, 0);
  assert.equal(spawnSync('bash', ['-n', path.join(ROOT, 'deploy/v5/v5-pg-backup.sh')], {encoding:'utf8'}).status, 0);
  assert.equal(spawnSync('sh', ['-n', path.join(ROOT, 'deploy/v5/psql')], {encoding:'utf8'}).status, 0);
});
