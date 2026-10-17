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

/* ---- LR03 fail-closed deployment guards (pure, offline-testable) ---- */

/* The staged tree must never regress the deployed PostgreSQL schema: migrations are additive. */
function assertSchemaNotRegressing(stagedMigrations, hostMigrations) {
  if (!Number.isSafeInteger(stagedMigrations) || !Number.isSafeInteger(hostMigrations)) {
    throw new Error('DEPLOY_REFUSED_MIGRATION_COUNT_INVALID');
  }
  if (stagedMigrations < hostMigrations) {
    throw new Error(`DEPLOY_REFUSED_SCHEMA_REGRESSION: staged ${stagedMigrations} < deployed ${hostMigrations}`);
  }
}

/* Extract the production binding a host-managed serve.sh launches with. */
function parseServeBinding(serveShText) {
  const match = /MEGA_V5_PRODUCTION_SERVER=([^\s'"]+)/.exec(serveShText || '');
  return match ? match[1] : null;
}

/* A deployment must never arm the wrong database/project: the launcher binding and the host's
 * authoritative inventory file must describe the exact same target. */
function assertTargetsMatch(binding, inventory) {
  const expected = `${inventory.projectId}/${inventory.branchId}/${inventory.database}`;
  if (binding !== expected) {
    throw new Error(`DEPLOY_REFUSED_WRONG_TARGET: serve.sh ${binding} != inventory ${expected}`);
  }
  if (inventory.nonserving !== false) {
    throw new Error('DEPLOY_REFUSED_NON_SERVING_INVENTORY: the host inventory must declare the serving posture');
  }
  return expected;
}

/* Post-swap readiness verdict from a /readyz body (the authority answers ready:true only when the
 * database answers). */
function readinessVerdict(body, httpStatus) {
  if (httpStatus !== 200) return { ok: false, why: `readyz HTTP ${httpStatus}` };
  try {
    const doc = JSON.parse(body);
    if (doc.ready !== true) return { ok: false, why: 'readyz ready!=true' };
    return { ok: true, why: null };
  } catch { return { ok: false, why: 'readyz body unparsable' }; }
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

  // 0. LR03 fail-closed predeploy: the host must BE a serving V5 authority before anything is
  // staged — a readable authority epoch, a node runtime, the host-managed launcher, a
  // serving-posture inventory whose target matches the launcher binding, and a schema the staged
  // tree does not regress. Any refusal happens BEFORE a byte is staged or swapped.
  const localMigrations = fs.readdirSync(path.join(ROOT, 'packages', 'migrations', 'migrations'))
    .filter((f) => f.endsWith('.sql')).length;
  const factsRaw = run('ssh', [host, `set -e
    test -d ${PROD_ROOT} || { echo 'DEPLOY_REFUSED_NO_PROD_ROOT' >&2; exit 1; }
    test -s ${PROD_ROOT}/state/authority-epoch.txt || { echo 'DEPLOY_REFUSED_NO_AUTHORITY_EPOCH' >&2; exit 1; }
    test -x ${PROD_ROOT}/bin/node-24/bin/node || { echo 'DEPLOY_REFUSED_NO_NODE_RUNTIME' >&2; exit 1; }
    test -f ${PROD_ROOT}/src-final/docs/v5/environments/production.json || { echo 'DEPLOY_REFUSED_NO_HOST_INVENTORY' >&2; exit 1; }
    test -f ${PROD_ROOT}/src-final/serve.sh || { echo 'DEPLOY_REFUSED_NO_SERVE_LAUNCHER' >&2; exit 1; }
    HOST_MIGRATIONS=$(ls ${PROD_ROOT}/src-final/packages/migrations/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
    SERVE_BINDING=$(sed -n 's/^.*MEGA_V5_PRODUCTION_SERVER=\\([^ ]*\\).*$/\\1/p' ${PROD_ROOT}/src-final/serve.sh | head -1)
    INV=$(${PROD_ROOT}/bin/node-24/bin/node -e "const d=require('${PROD_ROOT}/src-final/docs/v5/environments/production.json');console.log([d.projectId,d.branchId,d.database,d.nonserving].join('|'))")
    printf 'DEPLOY_FACTS {"hostMigrations":%s,"serveBinding":"%s","inv":"%s"}\n' "$HOST_MIGRATIONS" "$SERVE_BINDING" "$INV"
  `]);
  const factsLine = factsRaw.split('\n').find((l) => l.startsWith('DEPLOY_FACTS '));
  if (!factsLine) throw new Error('DEPLOY_REFUSED_FACTS_MISSING: the host did not report its authority facts');
  const facts = JSON.parse(factsLine.slice('DEPLOY_FACTS '.length));
  const invParts = facts.inv.split('|');
  assertSchemaNotRegressing(localMigrations, Number(facts.hostMigrations));
  assertTargetsMatch(facts.serveBinding, {
    projectId: invParts[0], branchId: invParts[1], database: invParts[2],
    nonserving: invParts[3] === 'true',
  });

  const excludes = ['--exclude=.git', '--exclude=.artifacts', '--exclude=tests-output',
    '--exclude=mega_xoxo_website_logo_pack', '--exclude=.DS_Store', '--exclude=node_modules'];

  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
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
  // Host-managed files and vendored deps are NOT in the repo. node_modules is carried across only
  // if the new tree lacks it; serve.sh, rehearse.sh and the serving-posture inventory are
  // HOST-MANAGED AUTHORITY STATE and must ALWAYS be restored from the archive — a stale repo copy
  // of any of them (nonserving inventory, devtest launcher) would take the authority down or point
  // it at the wrong target on the next restart. LR03: a deployment never overwrites the active
  // authority declaration with repository values.
  const CARRY = ['node_modules'];
  const RESTORE = ['docs/v5/environments/production.json', 'serve.sh', 'rehearse.sh'];
  /* MXA-INF-001: the archive is the rollback point and must stay COMPLETE. The old mv-based
   * carry stripped node_modules and the host-managed authority files out of it, so the unhealthy
   * path restored an unstartable tree and deleted the only complete copy with the swap. Copy
   * from the archive instead; the archive is never mutated after it is written. */
  const carry = [
    ...CARRY.map((f) => `    if [ -e ${archive}/src-final/${f} ] && [ ! -e ${PROD_ROOT}/src-final/${f} ]; then sudo -n cp -a ${archive}/src-final/${f} ${PROD_ROOT}/src-final/${f}; fi`),
    ...RESTORE.map((f) => `    if [ -e ${archive}/src-final/${f} ]; then sudo -n rm -rf ${PROD_ROOT}/src-final/${f} && sudo -n cp -a ${archive}/src-final/${f} ${PROD_ROOT}/src-final/${f}; fi`),
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

  // 4. Restart, then VERIFY readiness against the same contract the deploy tooling and the host
  // health monitor expect (readyz 200 with the database answering). A red authority is rolled back
  // to the archived previous trees automatically — the swap is never trusted on process liveness
  // alone (LR03: verified repeat deployments and rollback to an earlier PostgreSQL-compatible build).
  const healthOutput = run('ssh', [host, `set -e
    sudo -n systemctl restart ${SERVICE}
    READY=false
    for i in 1 2 3 4 5 6; do
      sleep 5
      CODE=$(curl -s -o /tmp/mx-readyz.json -w '%{http_code}' -m 5 http://172.18.0.1:8080/readyz || echo 000)
      if [ "$CODE" = "200" ]; then READY=true; break; fi
    done
    if [ "$READY" != "true" ]; then
      echo "DEPLOY_UNHEALTHY: rolling back to ${archive}" >&2
      sudo -n systemctl stop ${SERVICE}
      sudo -n rm -rf ${PROD_ROOT}/src-final ${PROD_ROOT}/web-build
      sudo -n mv ${archive}/src-final ${PROD_ROOT}/src-final
      sudo -n mv ${archive}/web-build ${PROD_ROOT}/web-build
      test -x ${PROD_ROOT}/src-final/serve.sh || { echo ROLLBACK_LAUNCHER_MISSING; exit 1; }
      sudo -n systemctl start ${SERVICE}
      sleep 8
      echo "ROLLED_BACK: previous trees restored from ${archive}" >&2
      exit 1
    fi
    echo "service: $(systemctl is-active ${SERVICE})"
    cat /tmp/mx-readyz.json
  `]);
  const readyzBody = healthOutput.trim().split('\n').pop() || '';
  const verdict = readinessVerdict(readyzBody, 200);
  if (!verdict.ok) throw new Error('DEPLOY_UNHEALTHY_POSTVERIFY: ' + verdict.why);
  process.stdout.write('deploy verified: ' + readyzBody.trim() + '\n');

  process.stdout.write(JSON.stringify({ ok: true, commit, bundle_sha256: manifest.bundle_sha256, files: fileCount, archive }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.message).slice(0, 300) + '\n'); process.exitCode = 1; }
}

module.exports = {
  main,
  /* LR03 fail-closed deployment guards (pure, offline-testable). */
  assertSchemaNotRegressing, parseServeBinding, assertTargetsMatch, readinessVerdict,
};
