'use strict';
/* scripts/v51/deploy-production.cjs - deploy the current V5.2 source + generated P21 bundle to the
 * Oracle V5 PRODUCTION authority tree (/opt/mega-xo-v5-production).
 *
 * It does NOT build anything. The caller builds the bundle first with
 *   node scripts/p21/build-web.js --output .artifacts/p21-web
 * then this script:
 *   1. verifies the local HEAD equals --commit and that the bundle manifest records that commit,
 *   2. stages the exact source tree and bundle into fresh remote temp dirs,
 *   3. archives the currently-deployed source+bundle to a dated rollback directory,
 *   4. atomically swaps the staged trees in, carrying the vendored node_modules across,
 *   5. restarts mega-xo-v5-production.service and prints the tail of the server log.
 *
 * The running authority is never mutated in place: a failed swap leaves the previous tree intact in
 * its dated archive, and the receipt is written before the swap so a failure still leaves evidence.
 *
 *   node scripts/v51/deploy-production.cjs --commit <sha> [--bundle .artifacts/p21-web] [--host command]
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROD_ROOT = '/opt/mega-xo-v5-production';
const SERVICE = 'mega-xo-v5-production.service';

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { stdio: options.stdio || 'pipe', encoding: 'utf8', ...options });
}
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function main() {
  const commit = arg('commit');
  const bundle = path.resolve(ROOT, arg('bundle', '.artifacts/p21-web'));
  const host = arg('host', 'command');
  if (!commit) throw new Error('--commit <sha> is required');

  const localHead = run('git', ['-C', ROOT, 'rev-parse', 'HEAD']).trim();
  if (localHead !== commit) throw new Error(`LOCAL_HEAD_MISMATCH: HEAD ${localHead} != ${commit}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'web-build.manifest.json'), 'utf8'));
  if (manifest.source_commit !== commit) {
    throw new Error(`BUNDLE_SOURCE_MISMATCH: manifest ${manifest.source_commit} != ${commit}`);
  }
  const fileCount = (manifest.files || []).length;
  if (!fileCount || !Number.isSafeInteger(manifest.total_bytes)) throw new Error('BUNDLE_MANIFEST_INVALID');

  const excludes = ['--exclude=.git', '--exclude=.artifacts', '--exclude=tests-output',
    '--exclude=mega_xoxo_website_logo_pack', '--exclude=.DS_Store', '--exclude=node_modules'];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = `${PROD_ROOT}/rollback/${stamp}-${commit.slice(0, 12)}`;

  // 1. Stage the source and the bundle into fresh remote temp dirs (never mutate the running tree).
  run('ssh', [host, `set -e
    sudo -n rm -rf ${PROD_ROOT}/.stage-src ${PROD_ROOT}/.stage-web
    sudo -n mkdir -p ${PROD_ROOT}/.stage-src ${PROD_ROOT}/.stage-web ${PROD_ROOT}/rollback
    # rsync runs as the unprivileged ssh user, so hand it ownership of the throwaway stage dirs only.
    # The live tree stays root-owned; the swap re-applies root ownership.
    sudo -n chown -R \$(id -un):\$(id -gn) ${PROD_ROOT}/.stage-src ${PROD_ROOT}/.stage-web`]);
  run('rsync', ['-az', '--delete', ...excludes, `${ROOT}/`, `${host}:${PROD_ROOT}/.stage-src/`], { stdio: 'inherit' });
  run('rsync', ['-az', '--delete', `${bundle}/`, `${host}:${PROD_ROOT}/.stage-web/`], { stdio: 'inherit' });

  // 2. Receipt before the swap, so a failed swap still leaves identity evidence.
  const receipt = {
    at: new Date().toISOString(), kind: 'v5-production-deploy', source_commit: commit,
    bundle_sha256: manifest.bundle_sha256, file_count: fileCount, total_bytes: manifest.total_bytes,
    staged_from: os.hostname(), archive, service: SERVICE,
  };
  run('ssh', [host, `sudo -n chown \$(id -un):\$(id -gn) ${PROD_ROOT}/state
tee ${PROD_ROOT}/state/deploy-receipt.json <<'EOF'\n${JSON.stringify(receipt, null, 2)}\nEOF`]);

  // 3. Archive the currently-deployed source+bundle (the rollback point), then swap atomically.
  // Host-local launchers and vendored deps are NOT in the repo, so they must be carried across the
  // swap or the unit's ExecStart target (serve.sh) disappears. The environment target file is also
  // host-managed: the cutover flips docs/v5/environments/production.json to nonserving:false, which
  // the repo copy does not carry, so a repo copy would refuse to serve (SERVING_EPOCH_BEFORE_CUTOVER).
  // It exists on both sides, so it must ALWAYS be restored from the archive rather than only when absent.
  const CARRY = ['node_modules', 'serve.sh', 'rehearse.sh'];
  const RESTORE = ['docs/v5/environments/production.json'];
  const carry = [
    ...CARRY.map((f) => `    if [ -e ${archive}/src-final/${f} ] && [ ! -e ${PROD_ROOT}/src-final/${f} ]; then sudo -n mv ${archive}/src-final/${f} ${PROD_ROOT}/src-final/${f}; fi`),
    ...RESTORE.map((f) => `    if [ -e ${archive}/src-final/${f} ]; then sudo -n rm -rf ${PROD_ROOT}/src-final/${f} && sudo -n mv ${archive}/src-final/${f} ${PROD_ROOT}/src-final/${f}; fi`),
  ].join('\n');
  run('ssh', [host, `set -e
    sudo -n mkdir -p ${archive}
    sudo -n mv ${PROD_ROOT}/src-final ${archive}/src-final
    sudo -n mv ${PROD_ROOT}/web-build ${archive}/web-build
    sudo -n mv ${PROD_ROOT}/.stage-src ${PROD_ROOT}/src-final
    sudo -n mv ${PROD_ROOT}/.stage-web ${PROD_ROOT}/web-build
${carry}
    sudo -n chown -R root:root ${PROD_ROOT}/src-final ${PROD_ROOT}/web-build
    test -x ${PROD_ROOT}/src-final/serve.sh || { echo SERVE_LAUNCHER_MISSING; exit 1; }
    echo "archive: ${archive}"
    echo "src sha: $(sudo -n sha256sum ${PROD_ROOT}/src-final/scripts/v51/v5-production-server.cjs | cut -c1-16)"
    echo "web files: $(sudo -n find ${PROD_ROOT}/web-build -type f | wc -l)"`], { stdio: 'inherit' });

  // 4. Restart the authority service and surface the first log lines.
  run('ssh', [host, `set -e
    sudo -n systemctl restart ${SERVICE}
    sleep 12
    echo "service: $(systemctl is-active ${SERVICE})"
    sudo -n tail -4 ${PROD_ROOT}/state/production-server.log`], { stdio: 'inherit' });

  process.stdout.write(JSON.stringify({ ok: true, commit, bundle_sha256: manifest.bundle_sha256, files: fileCount, archive }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.message).slice(0, 300) + '\n'); process.exitCode = 1; }
}

module.exports = { main };
