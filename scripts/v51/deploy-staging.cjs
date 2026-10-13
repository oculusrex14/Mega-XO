'use strict';
/* scripts/v51/deploy-staging.cjs - deploy the current V5.1 source + generated P21 bundle to the
 * isolated Oracle staging origin, atomically and without touching live V4.
 *
 * It does NOT build anything: the caller builds the bundle first with
 *   node scripts/p21/build-web.js --output .artifacts/p21-web
 * then this script rsyncs the exact source tree and the exact bundle, swaps them in, records the
 * source/bundle identity, and restarts the staging tmux session. The served bytes are verified by a
 * separate step (the server self-check + an external fetch), never assumed from a local build.
 *
 * Safety: staging only. It never writes ports 80/443, never restarts a production container, and it
 * refuses to run without an explicit --commit that matches the bundle manifest's source_commit.
 *
 * Usage:
 *   node scripts/v51/deploy-staging.cjs --commit <sha> [--bundle .artifacts/p21-web] [--host command]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const STAGING_ROOT = '/opt/mega-xo-v51-staging';
const REMOTE_REPO = STAGING_ROOT + '/repo';
const REMOTE_WEB = STAGING_ROOT + '/p21-web';
const SESSION = 'v51stg';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { stdio: options.stdio || 'pipe', encoding: 'utf8', ...options });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const host = arg('--host', 'command');
  const commit = arg('--commit', null);
  const bundle = path.resolve(arg('--bundle', path.join(ROOT, '.artifacts/p21-web')));
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('USAGE: --commit <40-hex-sha>');

  const manifestPath = path.join(bundle, 'web-build.manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('BUNDLE_MISSING: build first (scripts/p21/build-web.js)');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.generator !== 'scripts/p21/build-web.js') throw new Error('BUNDLE_NOT_OWNED_BY_BUILDER');
  if (manifest.source_commit !== commit) {
    throw new Error(`BUNDLE_COMMIT_MISMATCH: bundle is ${manifest.source_commit}, requested ${commit}`);
  }

  const localHead = run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();
  if (localHead !== commit) throw new Error(`LOCAL_HEAD_MISMATCH: HEAD ${localHead} != ${commit}`);

  const excludes = ['--exclude=.git', '--exclude=.artifacts', '--exclude=tests-output',
    '--exclude=mega_xoxo_website_logo_pack', '--exclude=.DS_Store', '--exclude=node_modules'];

  // 1. Stage source into a fresh remote temp dir (never mutate the running tree in place).
  const stageRepo = `${STAGING_ROOT}/.stage-repo`;
  const stageWeb = `${STAGING_ROOT}/.stage-web`;
  run('ssh', [host, `rm -rf ${stageRepo} ${stageWeb} && mkdir -p ${stageRepo} ${stageWeb}`]);
  run('rsync', ['-az', '--delete', ...excludes, `${ROOT}/`, `${host}:${stageRepo}/`],
    { stdio: 'inherit' });
  run('rsync', ['-az', '--delete', `${bundle}/`, `${host}:${stageWeb}/`],
    { stdio: 'inherit' });

  // 2. Write the identity receipt BEFORE the swap so a failed swap leaves evidence.
  const receipt = {
    at: new Date().toISOString(), source_commit: commit, bundle_sha256: manifest.bundle_sha256,
    file_count: manifest.file_count, total_bytes: manifest.total_bytes, staged_from: os.hostname(),
  };
  run('ssh', [host, `cat > ${STAGING_ROOT}/deploy-receipt.json <<'EOF'\n${JSON.stringify(receipt, null, 2)}\nEOF`]);

  // 3. Atomic swap: move the running dirs aside, move the staged ones in, remove the old ones.
  //    node_modules is vendored (pg+redis) and excluded from rsync, so it is moved across the swap.
  run('ssh', [host, `set -e
    cd ${STAGING_ROOT}
    [ -d repo ] && mv repo .prev-repo || true
    [ -d p21-web ] && mv p21-web .prev-web || true
    mv .stage-repo repo
    mv .stage-web p21-web
    if [ -d .prev-repo/node_modules ]; then mv .prev-repo/node_modules repo/node_modules; fi
    rm -rf .prev-repo .prev-web`]);

  // 4. Restart the staging session (kill the tmux session, relaunch via run.sh).
  run('ssh', [host, `tmux kill-session -t ${SESSION} 2>/dev/null || true; sleep 1;
    tmux new-session -d -s ${SESSION} "bash ${STAGING_ROOT}/run.sh > ${STAGING_ROOT}/server.log 2>&1"; sleep 6;
    tail -3 ${STAGING_ROOT}/server.log`], { stdio: 'inherit' });

  process.stdout.write(JSON.stringify({ ok: true, commit, bundle_sha256: manifest.bundle_sha256, files: manifest.file_count }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.message).slice(0, 200) + '\n'); process.exitCode = 1; }
}

module.exports = { main };
