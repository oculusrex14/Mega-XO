'use strict';

/* Regression tests for the production deploy guards and the actual generated shell executors.
 * The executor fixtures run in temporary directories with sudo disabled; no host paths or owner
 * changes are touched. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const deploy = require('../scripts/v51/deploy-production.cjs');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'v51', 'deploy-production.cjs'), 'utf8');

const INVENTORY = {
  projectId: 'fixture-project', branchId: 'fixture-branch', database: 'fixture-production', nonserving: false,
};
const BINDING = `${INVENTORY.projectId}/${INVENTORY.branchId}/${INVENTORY.database}`;
const EPOCH = 'v5:1792037113917:153a8543d555682d';
const OLD_LAUNCHER = `#!/bin/sh\nexec env MEGA_V5_PRODUCTION_SERVER=${BINDING} node scripts/v51/v5-production-server.cjs\n`;

function writeFile(file, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, mode);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-deploy-regression-'));
  const liveSource = path.join(root, 'src-final');
  const stageSource = path.join(root, '.stage-src');
  const liveWeb = path.join(root, 'web-build');
  const stageWeb = path.join(root, '.stage-web');
  const inventory = JSON.stringify(INVENTORY, null, 2) + '\n';
  const staleInventory = JSON.stringify({ ...INVENTORY, nonserving: true }, null, 2) + '\n';
  writeFile(path.join(liveSource, 'serve.sh'), OLD_LAUNCHER, 0o755);
  writeFile(path.join(liveSource, 'docs/v5/environments/production.json'), inventory);
  writeFile(path.join(liveSource, 'node_modules/host-dependency/marker.txt'), 'host dependency\n');
  writeFile(path.join(liveSource, 'old-source-marker.txt'), 'old source\n');
  writeFile(path.join(root, 'state/authority-epoch.txt'), `${EPOCH}\n`);
  writeFile(path.join(stageSource, 'serve.sh'), '#!/bin/sh\n# repository placeholder\n', 0o644);
  writeFile(path.join(stageSource, 'docs/v5/environments/production.json'), staleInventory);
  writeFile(path.join(stageSource, 'node_modules/repo-placeholder.txt'), 'must be replaced\n');
  writeFile(path.join(stageSource, 'new-source-marker.txt'), 'new source\n');
  writeFile(path.join(liveWeb, 'old-web-marker.txt'), 'old web\n');
  writeFile(path.join(stageWeb, 'new-web-marker.txt'), 'new web\n');
  return { root, liveSource, stageSource, liveWeb, stageWeb, inventory, oldLauncher: OLD_LAUNCHER };
}

function execute(script, env = {}) {
  return spawnSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function overlay(fx) {
  return execute(deploy.buildHostManagedOverlayScript(fx.root, { useSudo: false }));
}

function installCommandFixtures(fx) {
  const bin = path.join(fx.root, 'fixture-bin');
  const log = path.join(fx.root, 'systemctl.log');
  const curlCount = path.join(fx.root, 'curl-count');
  writeFile(path.join(bin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MX_SYSTEMCTL_LOG"
if [ "\${MX_FAIL_RESTART:-}" = 1 ] && [ "$1" = restart ]; then exit 42; fi
exit 0
`, 0o755);
  writeFile(path.join(bin, 'curl'), `#!/bin/sh
out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out=$2; shift 2; else shift; fi
done
n=0
if [ -f "$MX_CURL_COUNT" ]; then n=$(cat "$MX_CURL_COUNT"); fi
printf '%s' "$((n + 1))" > "$MX_CURL_COUNT"
case "$MX_CURL_SEQUENCE:$n" in
  false-ready:0) body='{"status":"degraded","ready":false}' ;;
  malformed-ready:0) body='not-json' ;;
  *) body='{"status":"ok","live":true,"ready":true}' ;;
esac
printf '%s' "$body" > "$out"
printf 200
`, 0o755);
  writeFile(path.join(bin, 'mv'), `#!/bin/sh
if [ "\${MX_FAIL_STAGE_WEB_MV:-}" = 1 ] && [ "$1" = "$MX_FIXTURE_ROOT/.stage-web" ]; then exit 73; fi
exec /bin/mv "$@"
`, 0o755);
  writeFile(path.join(bin, 'cp'), `#!/bin/sh
if [ "\${MX_FAIL_ARCHIVE_WEB_COPY:-}" = 1 ] && [ "$2" = "$MX_FIXTURE_ROOT/web-build" ] && [ "$3" = "$MX_FIXTURE_ARCHIVE/web-build" ]; then exit 74; fi
if [ "\${MX_FAIL_ROLLBACK_COPY:-}" = 1 ] && [ "$2" = "$MX_FIXTURE_ARCHIVE/src-final" ] && [ "$3" = "$MX_FIXTURE_ROOT/src-final" ]; then exit 75; fi
exec /bin/cp "$@"
`, 0o755);
  return { bin, log, curlCount };
}

function runTransaction(fx, archive, commandFixtures, extraEnv = {}, options = {}) {
  const script = deploy.buildDeploymentTransactionScript(fx.root, archive, {
    useSudo: false, nodePath: process.execPath, attempts: 1, delaySeconds: 0, ...options,
  });
  return execute(script, {
    PATH: `${commandFixtures.bin}:${process.env.PATH}`,
    MX_SYSTEMCTL_LOG: commandFixtures.log,
    MX_CURL_COUNT: commandFixtures.curlCount,
    MX_CURL_SEQUENCE: 'ready',
    MX_FIXTURE_ROOT: fx.root,
    MX_FIXTURE_ARCHIVE: archive,
    ...extraEnv,
  });
}

function assertArchiveAndRollbackRemainComplete(fx, archive) {
  const archivedSource = path.join(archive, 'src-final');
  const archivedWeb = path.join(archive, 'web-build');
  assert.deepEqual(fs.readdirSync(archive).sort(), ['src-final', 'web-build']);
  assert.equal(fs.readFileSync(path.join(archivedSource, 'old-source-marker.txt'), 'utf8'), 'old source\n');
  assert.equal(fs.readFileSync(path.join(archivedWeb, 'old-web-marker.txt'), 'utf8'), 'old web\n');
  assert.equal(fs.readFileSync(path.join(archivedSource, 'node_modules/host-dependency/marker.txt'), 'utf8'), 'host dependency\n');
  assert.equal(fs.readFileSync(path.join(archivedSource, 'docs/v5/environments/production.json'), 'utf8'), fx.inventory);
  assert.equal(fs.readFileSync(path.join(fx.liveSource, 'old-source-marker.txt'), 'utf8'), 'old source\n');
  assert.equal(fs.readFileSync(path.join(fx.liveWeb, 'old-web-marker.txt'), 'utf8'), 'old web\n');
  assert.equal(fs.readFileSync(path.join(fx.liveSource, 'serve.sh'), 'utf8'), fx.oldLauncher);
  assert.equal(fs.statSync(path.join(fx.liveSource, 'serve.sh')).mode & 0o111, 0o111);
  assert.equal(fs.readFileSync(path.join(fx.liveSource, 'node_modules/host-dependency/marker.txt'), 'utf8'), 'host dependency\n');
}

test('schema: additive migrations pass and regressions or invalid counts are refused', () => {
  deploy.assertSchemaNotRegressing(55, 55);
  deploy.assertSchemaNotRegressing(56, 55);
  assert.throws(() => deploy.assertSchemaNotRegressing(54, 55), /DEPLOY_REFUSED_SCHEMA_REGRESSION/);
  assert.throws(() => deploy.assertSchemaNotRegressing(NaN, 55), /MIGRATION_COUNT_INVALID/);
});

test('binding and authority epoch use the live target plus the existing epoch grammar', () => {
  const serveSh = `exec env MEGA_V5_PRODUCTION_SERVER=${BINDING} node scripts/v51/v5-production-server.cjs`;
  const binding = deploy.parseServeBinding(serveSh);
  assert.equal(binding, BINDING);
  assert.equal(deploy.parseServeBinding('no binding here'), null);
  assert.equal(deploy.assertTargetsMatch(binding, INVENTORY), BINDING);
  assert.throws(() => deploy.assertTargetsMatch('other/project/database', INVENTORY), /DEPLOY_REFUSED_WRONG_TARGET/);
  assert.throws(() => deploy.assertTargetsMatch(binding, { ...INVENTORY, nonserving: true }), /DEPLOY_REFUSED_NON_SERVING_INVENTORY/);
  assert.equal(deploy.assertAuthorityEpoch(EPOCH), EPOCH);
  assert.throws(() => deploy.assertAuthorityEpoch('v4:bad'), /DEPLOY_REFUSED_INVALID_AUTHORITY_EPOCH/);
  const facts = {
    launcherRegular: true, launcherExecutable: true, launcherSymlink: false,
    inventoryRegular: true, inventorySymlink: false,
    nodeModulesDirectory: true, nodeModulesSymlink: false,
    binding, inventory: INVENTORY, authorityEpoch: EPOCH,
  };
  assert.equal(deploy.assertAuthorityFacts(facts), BINDING);
  assert.throws(() => deploy.assertAuthorityFacts({ ...facts, launcherExecutable: false }), /LAUNCHER_NOT_EXECUTABLE/);
  assert.throws(() => deploy.assertAuthorityFacts({ ...facts, inventorySymlink: true }), /UNSAFE_HOST_INVENTORY/);
  assert.throws(() => deploy.assertAuthorityFacts({ ...facts, nodeModulesSymlink: true }), /DEPENDENCIES_MISSING_OR_UNSAFE/);
});

test('readiness requires HTTP 200 and a parseable ready:true body', () => {
  assert.deepEqual(deploy.readinessVerdict('{"status":"ok","live":true,"ready":true}', 200), { ok: true, why: null });
  assert.equal(deploy.readinessVerdict('{"ready":false}', 200).ok, false);
  assert.equal(deploy.readinessVerdict('{"ready":true}', 502).ok, false);
  assert.equal(deploy.readinessVerdict('gateway timeout', 200).ok, false);
});

test('host overlay executor carries launcher, serving inventory and dependencies; rehearse is optional', () => {
  const fx = fixture();
  try {
    writeFile(path.join(fx.stageSource, 'rehearse.sh'), 'stale stage rehearsal\n');
    const absent = overlay(fx);
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(fs.readFileSync(path.join(fx.stageSource, 'serve.sh'), 'utf8'), fx.oldLauncher);
    assert.equal(fs.statSync(path.join(fx.stageSource, 'serve.sh')).mode & 0o111, 0o111);
    assert.equal(fs.readFileSync(path.join(fx.stageSource, 'docs/v5/environments/production.json'), 'utf8'), fx.inventory);
    assert.equal(fs.readFileSync(path.join(fx.stageSource, 'node_modules/host-dependency/marker.txt'), 'utf8'), 'host dependency\n');
    assert.equal(fs.existsSync(path.join(fx.stageSource, 'node_modules/repo-placeholder.txt')), false);
    assert.equal(fs.existsSync(path.join(fx.stageSource, 'rehearse.sh')), false);
    assert.equal(fs.readFileSync(path.join(fx.liveSource, 'old-source-marker.txt'), 'utf8'), 'old source\n');

    writeFile(path.join(fx.liveSource, 'rehearse.sh'), '#!/bin/sh\nexit 0\n', 0o755);
    const present = overlay(fx);
    assert.equal(present.status, 0, present.stderr);
    assert.equal(fs.readFileSync(path.join(fx.stageSource, 'rehearse.sh'), 'utf8'), '#!/bin/sh\nexit 0\n');
    assert.equal(fs.statSync(path.join(fx.stageSource, 'rehearse.sh')).mode & 0o111, 0o111);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('successful transaction archives complete old trees and activates the staged host overlay', () => {
  const fx = fixture();
  const commands = installCommandFixtures(fx);
  const archive = path.join(fx.root, 'rollback', 'success');
  try {
    const copied = overlay(fx);
    assert.equal(copied.status, 0, copied.stderr);
    const result = runTransaction(fx, archive, commands);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DEPLOY_VERIFIED readyz=.*"ready":true/);
    assert.equal(fs.readFileSync(path.join(fx.liveSource, 'new-source-marker.txt'), 'utf8'), 'new source\n');
    assert.equal(fs.readFileSync(path.join(fx.liveWeb, 'new-web-marker.txt'), 'utf8'), 'new web\n');
    assert.equal(fs.readFileSync(path.join(fx.liveSource, 'serve.sh'), 'utf8'), fx.oldLauncher);
    assert.equal(fs.readFileSync(path.join(fx.liveSource, 'node_modules/host-dependency/marker.txt'), 'utf8'), 'host dependency\n');
    assert.equal(fs.readFileSync(path.join(archive, 'src-final/old-source-marker.txt'), 'utf8'), 'old source\n');
    assert.equal(fs.readFileSync(path.join(archive, 'web-build/old-web-marker.txt'), 'utf8'), 'old web\n');
    assert.match(fs.readFileSync(commands.log, 'utf8'), /^restart /);
    assert.doesNotMatch(deploy.buildDeploymentTransactionScript(fx.root, archive, { useSudo: false, nodePath: process.execPath }), /chown/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('partial second-tree swap failure restores both live trees and preserves the complete archive', () => {
  const fx = fixture();
  const commands = installCommandFixtures(fx);
  const archive = path.join(fx.root, 'rollback', 'partial-swap');
  try {
    assert.equal(overlay(fx).status, 0);
    const result = runTransaction(fx, archive, commands, { MX_FAIL_STAGE_WEB_MV: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLED_BACK readyz=.*"ready":true/);
    assertArchiveAndRollbackRemainComplete(fx, archive);
    assert.match(fs.readFileSync(commands.log, 'utf8'), /stop /);
    assert.match(fs.readFileSync(commands.log, 'utf8'), /start /);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('archive copy failure aborts before swap and removes only its incomplete archive', () => {
  const fx = fixture();
  const commands = installCommandFixtures(fx);
  const archive = path.join(fx.root, 'rollback', 'copy-failure');
  try {
    assert.equal(overlay(fx).status, 0);
    const result = runTransaction(fx, archive, commands, { MX_FAIL_ARCHIVE_WEB_COPY: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEPLOY_FAILED_BEFORE_SWAP/);
    assert.equal(fs.readFileSync(path.join(fx.liveSource, 'old-source-marker.txt'), 'utf8'), 'old source\n');
    assert.equal(fs.readFileSync(path.join(fx.liveWeb, 'old-web-marker.txt'), 'utf8'), 'old web\n');
    assert.equal(fs.existsSync(archive), false);
    assert.equal(fs.existsSync(commands.log), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('rollback copy failure leaves the complete source archive intact for recovery', () => {
  const fx = fixture();
  const commands = installCommandFixtures(fx);
  const archive = path.join(fx.root, 'rollback', 'restore-copy-failure');
  try {
    assert.equal(overlay(fx).status, 0);
    const result = runTransaction(fx, archive, commands, {
      MX_FAIL_STAGE_WEB_MV: '1', MX_FAIL_ROLLBACK_COPY: '1',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_RESTORE_FAILED: archive copy failed/);
    assert.equal(fs.readFileSync(path.join(archive, 'src-final/old-source-marker.txt'), 'utf8'), 'old source\n');
    assert.equal(fs.readFileSync(path.join(archive, 'web-build/old-web-marker.txt'), 'utf8'), 'old web\n');
    assert.equal(fs.readFileSync(path.join(archive, 'src-final/node_modules/host-dependency/marker.txt'), 'utf8'), 'host dependency\n');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('systemctl restart failure rolls back and verifies the restored PostgreSQL ready body', () => {
  const fx = fixture();
  const commands = installCommandFixtures(fx);
  const archive = path.join(fx.root, 'rollback', 'restart-failure');
  try {
    assert.equal(overlay(fx).status, 0);
    const result = runTransaction(fx, archive, commands, { MX_FAIL_RESTART: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLED_BACK readyz=.*"ready":true/);
    assertArchiveAndRollbackRemainComplete(fx, archive);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

for (const [sequence, label] of [['false-ready', 'ready:false'], ['malformed-ready', 'malformed JSON']]) {
  test(`HTTP 200 ${label} enters rollback and verifies the restored PostgreSQL ready body`, () => {
    const fx = fixture();
    const commands = installCommandFixtures(fx);
    const archive = path.join(fx.root, 'rollback', sequence);
    try {
      assert.equal(overlay(fx).status, 0);
      const result = runTransaction(fx, archive, commands, { MX_CURL_SEQUENCE: sequence });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ROLLED_BACK readyz=.*"ready":true/);
      assertArchiveAndRollbackRemainComplete(fx, archive);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
}

test('main wires staged validation and the guarded transaction; rollback never consumes the archive', () => {
  assert.match(SOURCE, /readRemoteDeployFacts\(host, path\.join\(PROD_ROOT, '\.stage-src'/);
  assert.match(SOURCE, /run\('ssh', \[host, buildDeploymentTransactionScript\(PROD_ROOT, archive\)\]/);
  assert.match(SOURCE, /cp -a "\$ARCHIVED_SOURCE" "\$LIVE_SOURCE"/);
  assert.match(SOURCE, /cp -a "\$ARCHIVED_WEB" "\$LIVE_WEB"/);
  assert.doesNotMatch(SOURCE, /mv "\$ARCHIVED_(?:SOURCE|WEB)"/);
  assert.doesNotMatch(SOURCE, /chmod -R a-w/);
  assert.doesNotMatch(SOURCE, /RESTORE = \['docs\/v5\/environments\/production\.json', 'serve\.sh', 'rehearse\.sh'\]/);
});
