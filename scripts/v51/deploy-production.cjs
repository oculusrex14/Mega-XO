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
 *   4. overlays host-managed files, then guardedly swaps the staged trees,
 *   5. restarts mega-xo-v5-production.service and verifies its PostgreSQL-backed /readyz response.
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

const AUTHORITY_EPOCH = /^v5:[0-9]{13}:[0-9a-f]{16,64}$/;

function assertAuthorityEpoch(epoch) {
  if (typeof epoch !== 'string' || !AUTHORITY_EPOCH.test(epoch)) {
    throw new Error('DEPLOY_REFUSED_INVALID_AUTHORITY_EPOCH');
  }
  return epoch;
}

function assertAuthorityFacts(facts, { checkEpoch = true } = {}) {
  if (!facts || facts.launcherRegular !== true || facts.launcherExecutable !== true || facts.launcherSymlink === true) {
    throw new Error('DEPLOY_REFUSED_LAUNCHER_NOT_EXECUTABLE');
  }
  if (facts.inventoryRegular !== true || facts.inventorySymlink === true) {
    throw new Error('DEPLOY_REFUSED_UNSAFE_HOST_INVENTORY');
  }
  if (facts.nodeModulesDirectory !== true || facts.nodeModulesSymlink === true) {
    throw new Error('DEPLOY_REFUSED_HOST_DEPENDENCIES_MISSING_OR_UNSAFE');
  }
  if (checkEpoch) assertAuthorityEpoch(facts.authorityEpoch);
  return assertTargetsMatch(facts.binding, facts.inventory);
}

function assertStageAuthorityMatchesLive(stageFacts, liveFacts) {
  if (stageFacts.binding !== liveFacts.binding ||
      JSON.stringify(stageFacts.inventory) !== JSON.stringify(liveFacts.inventory)) {
    throw new Error('DEPLOY_REFUSED_STAGE_AUTHORITY_DRIFT');
  }
}

function buildRemoteFactsProgram() {
  return `
const fs=require('node:fs'),path=require('node:path'),root=process.argv[2],epochPath=process.argv[3];
const launcherPath=path.join(root,'serve.sh'),inventoryPath=path.join(root,'docs/v5/environments/production.json');
const rs=fs.lstatSync(root);if(!rs.isDirectory()||rs.isSymbolicLink())throw Error('DEPLOY_REFUSED_UNSAFE_SOURCE_ROOT');
for(const d of ['docs','docs/v5','docs/v5/environments']){const s=fs.lstatSync(path.join(root,d));if(!s.isDirectory()||s.isSymbolicLink())throw Error('DEPLOY_REFUSED_UNSAFE_INVENTORY_PATH')}
const ls=fs.lstatSync(launcherPath),is=fs.lstatSync(inventoryPath),ds=fs.lstatSync(path.join(root,'node_modules'));
if(!ls.isFile()||ls.isSymbolicLink()||!(ls.mode&0o111)||!is.isFile()||is.isSymbolicLink()||!ds.isDirectory()||ds.isSymbolicLink())throw Error('DEPLOY_REFUSED_UNSAFE_HOST_MANAGED_FILES');
const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8')),launcher=fs.readFileSync(launcherPath,'utf8');
const match=/MEGA_V5_PRODUCTION_SERVER=([^\\s'\"]+)/.exec(launcher),migrations=path.join(root,'packages/migrations/migrations');
let authorityEpoch=null;if(epochPath){const es=fs.lstatSync(epochPath);if(!es.isFile()||es.isSymbolicLink())throw Error('DEPLOY_REFUSED_UNSAFE_AUTHORITY_EPOCH');authorityEpoch=fs.readFileSync(epochPath,'utf8').trim()}
process.stdout.write(JSON.stringify({launcherRegular:true,launcherExecutable:true,launcherSymlink:false,inventoryRegular:true,inventorySymlink:false,nodeModulesDirectory:true,nodeModulesSymlink:false,binding:match&&match[1],inventory,authorityEpoch,hostMigrations:fs.readdirSync(migrations).filter((n)=>n.endsWith('.sql')).length}));
`;
}

function readRemoteDeployFacts(host, sourceRoot, { checkEpoch = true } = {}) {
  const epochPath = checkEpoch ? `${PROD_ROOT}/state/authority-epoch.txt` : '';
  const output = run('ssh', [host, `set -e
    sudo -n ${PROD_ROOT}/bin/node-24/bin/node - ${shellQuote(sourceRoot)} ${shellQuote(epochPath)} <<'MX_DEPLOY_FACTS'
${buildRemoteFactsProgram()}
MX_DEPLOY_FACTS`]);
  const factsLine = output.split('\n').find((line) => line.startsWith('{'));
  if (!factsLine) throw new Error('DEPLOY_REFUSED_FACTS_MISSING: the host did not report deploy facts');
  return JSON.parse(factsLine);
}

/* Copy host-managed source details into the fresh git-archive stage. This function is also run in
 * the regression fixture with sudo disabled, exercising the exact executor path without a host. */
function buildHostManagedOverlayScript(root = PROD_ROOT, { useSudo = true } = {}) {
  const prodRoot = path.resolve(root);
  const live = path.join(prodRoot, 'src-final');
  const stage = path.join(prodRoot, '.stage-src');
  const sudo = useSudo ? 'sudo -n ' : '';
  const inventory = 'docs/v5/environments/production.json';
  const livePath = (relative) => path.join(live, relative);
  const stagePath = (relative) => path.join(stage, relative);
  const copyFromLive = (relative) => [
    `${sudo}rm -rf ${shellQuote(stagePath(relative))}`,
    `${sudo}cp -a ${shellQuote(livePath(relative))} ${shellQuote(stagePath(relative))}`,
  ].join('\n');
  const liveRehearse = shellQuote(livePath('rehearse.sh'));
  const stageRehearse = shellQuote(stagePath('rehearse.sh'));
  const liveParents = ['docs', 'docs/v5', 'docs/v5/environments'].map((part) =>
    `[ -d ${shellQuote(path.join(live, part))} ] && [ ! -L ${shellQuote(path.join(live, part))} ]`).join(' && ');
  const stageParents = ['docs', 'docs/v5', 'docs/v5/environments'].map((part) =>
    `[ ! -L ${shellQuote(path.join(stage, part))} ]`).join(' && ');
  return [
    'set -e',
    `[ -d ${shellQuote(live)} ] && [ ! -L ${shellQuote(live)} ] || { echo DEPLOY_REFUSED_UNSAFE_LIVE_SOURCE >&2; exit 1; }`,
    `[ -d ${shellQuote(stage)} ] && [ ! -L ${shellQuote(stage)} ] || { echo DEPLOY_REFUSED_UNSAFE_STAGE_SOURCE >&2; exit 1; }`,
    `${liveParents} || { echo DEPLOY_REFUSED_UNSAFE_LIVE_INVENTORY_PATH >&2; exit 1; }`,
    `${stageParents} || { echo DEPLOY_REFUSED_UNSAFE_STAGE_INVENTORY_PATH >&2; exit 1; }`,
    `[ -f ${shellQuote(livePath('serve.sh'))} ] && [ ! -L ${shellQuote(livePath('serve.sh'))} ] && [ -x ${shellQuote(livePath('serve.sh'))} ] || { echo DEPLOY_REFUSED_NO_EXECUTABLE_SERVE_LAUNCHER >&2; exit 1; }`,
    `[ -f ${shellQuote(livePath(inventory))} ] && [ ! -L ${shellQuote(livePath(inventory))} ] || { echo DEPLOY_REFUSED_NO_HOST_INVENTORY >&2; exit 1; }`,
    `[ -d ${shellQuote(livePath('node_modules'))} ] && [ ! -L ${shellQuote(livePath('node_modules'))} ] || { echo DEPLOY_REFUSED_NO_SAFE_HOST_DEPENDENCIES >&2; exit 1; }`,
    `mkdir -p ${shellQuote(path.dirname(stagePath(inventory)))}`,
    copyFromLive('serve.sh'),
    copyFromLive(inventory),
    copyFromLive('node_modules'),
    `if [ -e ${liveRehearse} ] || [ -L ${liveRehearse} ]; then\n  [ -f ${liveRehearse} ] && [ ! -L ${liveRehearse} ] || { echo DEPLOY_REFUSED_UNSAFE_REHEARSE_FILE >&2; exit 1; }\n  ${sudo}rm -rf ${stageRehearse}\n  ${sudo}cp -a ${liveRehearse} ${stageRehearse}\nelse\n  ${sudo}rm -rf ${stageRehearse}\nfi`,
  ].join('\n');
}

function resolveArchivePath(root, archive) {
  const prodRoot = path.resolve(root);
  const rollbackRoot = path.join(prodRoot, 'rollback');
  const archivePath = path.resolve(archive);
  if (path.dirname(archivePath) !== rollbackRoot) {
    throw new Error('DEPLOY_REFUSED_UNSAFE_ARCHIVE_PATH');
  }
  return { prodRoot, archivePath };
}

function buildDeploymentTransactionScript(root, archive, {
  useSudo = true, nodePath = `${PROD_ROOT}/bin/node-24/bin/node`, readyUrl = 'http://172.18.0.1:8080/readyz',
  attempts = 6, delaySeconds = 5, service = SERVICE,
} = {}) {
  const { prodRoot, archivePath } = resolveArchivePath(root, archive);
  const sudo = useSudo ? 'sudo -n ' : '';
  const liveSource = path.join(prodRoot, 'src-final');
  const liveWeb = path.join(prodRoot, 'web-build');
  const stageSource = path.join(prodRoot, '.stage-src');
  const stageWeb = path.join(prodRoot, '.stage-web');
  const archivedSource = path.join(archivePath, 'src-final');
  const archivedWeb = path.join(archivePath, 'web-build');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(delaySeconds) || delaySeconds < 0) {
    throw new Error('DEPLOY_REFUSED_INVALID_HEALTH_RETRY_SETTINGS');
  }
  const stageCheck = `const f=require('node:fs'),p=require('node:path'),r=process.argv[1],e=process.argv[2];
const l=f.lstatSync(p.join(r,'serve.sh')),i=p.join(r,'docs/v5/environments/production.json'),d=f.lstatSync(p.join(r,'node_modules'));
const inv=JSON.parse(f.readFileSync(i,'utf8')),m=/MEGA_V5_PRODUCTION_SERVER=([^\\s'\"]+)/.exec(f.readFileSync(p.join(r,'serve.sh'),'utf8'));
if(!l.isFile()||l.isSymbolicLink()||!(l.mode&0o111)||!f.lstatSync(i).isFile()||f.lstatSync(i).isSymbolicLink()||!d.isDirectory()||d.isSymbolicLink()||!m||m[1]!==[inv.projectId,inv.branchId,inv.database].join('/')||inv.nonserving!==false)throw Error('DEPLOY_REFUSED_STAGE_AUTHORITY_MISMATCH');
const es=f.lstatSync(e),epoch=f.readFileSync(e,'utf8').trim();if(!es.isFile()||es.isSymbolicLink()||!/^v5:[0-9]{13}:[0-9a-f]{16,64}$/.test(epoch))throw Error('DEPLOY_REFUSED_INVALID_AUTHORITY_EPOCH');`;
  const readyCheck = `try{if(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).ready===true)process.exit(0)}catch{}process.exit(1)`;
  const attemptsList = Array.from({ length: attempts }, (_, index) => index + 1).join(' ');
  const retrySleep = delaySeconds ? `    sleep ${delaySeconds}` : '';
  const ownership = useSudo
    ? `sudo -n chown -R root:root ${shellQuote(liveSource)} ${shellQuote(liveWeb)}`
    : '';
  const restoreOwnership = useSudo
    ? `  sudo -n chown -R root:root ${shellQuote(liveSource)} ${shellQuote(liveWeb)}`
    : '';
  const sudoMkdir = `${sudo}mkdir`;
  const sudoMkdirP = `${sudo}mkdir -p`;
  const sudoRemove = `${sudo}rm -rf`;
  return `set -eu
ARCHIVE=${shellQuote(archivePath)}
LIVE_SOURCE=${shellQuote(liveSource)}
LIVE_WEB=${shellQuote(liveWeb)}
STAGE_SOURCE=${shellQuote(stageSource)}
STAGE_WEB=${shellQuote(stageWeb)}
ARCHIVED_SOURCE=${shellQuote(archivedSource)}
ARCHIVED_WEB=${shellQuote(archivedWeb)}
NODE=${shellQuote(nodePath)}
READY_URL=${shellQuote(readyUrl)}
SERVICE=${shellQuote(service)}
ARCHIVE_CREATED=0
ARCHIVE_COMPLETE=0
READY_FILE=$(mktemp)

wait_ready() {
  for attempt in ${attemptsList}; do
    code=$(curl -sS -o "$READY_FILE" -w '%{http_code}' -m 5 "$READY_URL" 2>/dev/null || true)
    if [ "$code" = 200 ] && "$NODE" -e ${shellQuote(readyCheck)} "$READY_FILE"; then
      READY_BODY=$(cat "$READY_FILE")
      return 0
    fi
${retrySleep}
  done
  return 1
}

recover_on_exit() {
  status=$?
  trap - EXIT
  set +e
  if [ "$status" -eq 0 ]; then rm -f "$READY_FILE"; exit 0; fi
  if [ "$ARCHIVE_COMPLETE" -ne 1 ]; then
    if [ "$ARCHIVE_CREATED" -eq 1 ]; then ${sudoRemove} "$ARCHIVE"; fi
    rm -f "$READY_FILE"
    echo "DEPLOY_FAILED_BEFORE_SWAP status=$status" >&2
    exit "$status"
  fi
  # R6/N5: use the compatibility facts recorded BEFORE the swap; unknown facts fail closed,
  # because a live manifest lost in a partial swap must never authorize an unbootable restart.
  . "$ARCHIVE/manifest-counts.env" 2>/dev/null || true
  OLD_MANIFEST_COUNT=\${OLD_MANIFEST_COUNT:-unknown}
  NEW_MANIFEST_COUNT=\${NEW_MANIFEST_COUNT:-unknown}
  case "$OLD_MANIFEST_COUNT$NEW_MANIFEST_COUNT" in *unknown*|*[!0-9]*)
    echo "FORWARD_RECOVERY_REQUIRED: migration compatibility facts missing or unreadable; the archived application cannot be trusted against the live schema" >&2
    echo "FORWARD_RECOVERY: keeping the NEW trees in place; diagnose the readiness failure, fix forward and restart $SERVICE; archive preserved at $ARCHIVE" >&2
    rm -f "$READY_FILE"
    exit "$status"
    ;;
  esac
  if [ "$NEW_MANIFEST_COUNT" -gt "$OLD_MANIFEST_COUNT" ]; then
    echo "FORWARD_RECOVERY_REQUIRED: live schema moved past the archived app (old manifest $OLD_MANIFEST_COUNT < new $NEW_MANIFEST_COUNT); the archived application cannot boot against it" >&2
    echo "FORWARD_RECOVERY: keeping the NEW trees in place; diagnose the readiness failure, fix forward and restart $SERVICE; archive preserved at $ARCHIVE" >&2
    rm -f "$READY_FILE"
    exit "$status"
  fi
  echo "DEPLOY_FAILED: restoring complete archive $ARCHIVE" >&2
  ${sudo}systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  if ! ${sudo}rm -rf "$LIVE_SOURCE" "$LIVE_WEB"; then
    rollback_failed 'could not clear live trees'
  fi
  if ! ${sudo}cp -a "$ARCHIVED_SOURCE" "$LIVE_SOURCE" || ! ${sudo}cp -a "$ARCHIVED_WEB" "$LIVE_WEB"; then
    rollback_failed 'archive copy failed'
  fi
${restoreOwnership}
  if [ ! -x "$LIVE_SOURCE/serve.sh" ] || [ ! -d "$LIVE_SOURCE/node_modules" ] || [ -L "$LIVE_SOURCE/node_modules" ]; then
    rollback_failed 'launcher or PostgreSQL dependencies missing'
  fi
  if ! ${sudo}systemctl start "$SERVICE"; then
    rollback_failed 'service start failed'
  fi
  if ! wait_ready; then
    rollback_failed 'restored PostgreSQL authority did not return ready:true'
  fi
  echo "ROLLED_BACK readyz=$READY_BODY archive=$ARCHIVE" >&2
  rm -f "$READY_FILE"
  exit "$status"
}
rollback_failed() { rm -f "$READY_FILE"; echo "ROLLBACK_RESTORE_FAILED: $1; archive preserved at $ARCHIVE" >&2; exit 1; }
trap recover_on_exit EXIT

[ -d "$LIVE_SOURCE" ] && [ ! -L "$LIVE_SOURCE" ] && [ -d "$LIVE_WEB" ] && [ ! -L "$LIVE_WEB" ] || { echo DEPLOY_REFUSED_LIVE_TREE_MISSING >&2; exit 1; }
[ -d "$STAGE_SOURCE" ] && [ ! -L "$STAGE_SOURCE" ] && [ -d "$STAGE_WEB" ] && [ ! -L "$STAGE_WEB" ] || { echo DEPLOY_REFUSED_STAGE_TREE_MISSING >&2; exit 1; }
[ ! -e "$ARCHIVE" ] || { echo DEPLOY_REFUSED_ARCHIVE_EXISTS >&2; exit 1; }
"$NODE" -e ${shellQuote(stageCheck)} "$STAGE_SOURCE" ${shellQuote(`${prodRoot}/state/authority-epoch.txt`)}
${sudoMkdirP} ${shellQuote(path.dirname(archivePath))}
${sudoMkdir} "$ARCHIVE"
ARCHIVE_CREATED=1
${sudo}cp -a "$LIVE_SOURCE" "$ARCHIVED_SOURCE"
${sudo}cp -a "$LIVE_WEB" "$ARCHIVED_WEB"
[ -d "$ARCHIVED_SOURCE" ] && [ -d "$ARCHIVED_WEB" ] && [ -x "$ARCHIVED_SOURCE/serve.sh" ] && [ -f "$ARCHIVED_SOURCE/docs/v5/environments/production.json" ] && [ -d "$ARCHIVED_SOURCE/node_modules" ] || { echo ROLLBACK_ARCHIVE_INCOMPLETE >&2; exit 1; }
ARCHIVE_COMPLETE=1

# R6/N5 (Sol re-review): record the migration-compatibility facts BEFORE the destructive
# swap - a later swap failure can leave the live manifest absent, and the failure trap must
# fail closed on unknown facts instead of restarting an unbootable archive. Both counts are
# mandatory; an unreadable manifest refuses the deploy BEFORE anything is touched.
OLD_MANIFEST_COUNT=$("$NODE" -e 'const m=require(process.argv[1]);console.log(m.migrations.length)' "$LIVE_SOURCE/packages/migrations/manifest.json" 2>/dev/null || echo unreadable)
NEW_MANIFEST_COUNT=$("$NODE" -e 'const m=require(process.argv[1]);console.log(m.migrations.length)' "$STAGE_SOURCE/packages/migrations/manifest.json" 2>/dev/null || echo unreadable)
  case "$OLD_MANIFEST_COUNT$NEW_MANIFEST_COUNT" in *unreadable*|*[!0-9]*) echo DEPLOY_REFUSED_MANIFEST_UNREADABLE old=$OLD_MANIFEST_COUNT new=$NEW_MANIFEST_COUNT >&2; exit 1 ;; esac
printf "OLD=%s\\nNEW=%s\\n" "$OLD_MANIFEST_COUNT" "$NEW_MANIFEST_COUNT" | ${sudo}tee "$ARCHIVE/manifest-counts.env" >/dev/null
COMPAT_RECORDED=1

${sudoRemove} "$LIVE_SOURCE"
${sudo}mv "$STAGE_SOURCE" "$LIVE_SOURCE"
${sudoRemove} "$LIVE_WEB"
${sudo}mv "$STAGE_WEB" "$LIVE_WEB"
${ownership}
[ -x "$LIVE_SOURCE/serve.sh" ] || { echo SERVE_LAUNCHER_MISSING >&2; exit 1; }
${sudo}systemctl restart "$SERVICE"
if ! wait_ready; then echo "DEPLOY_UNHEALTHY: readyz did not return HTTP 200 with ready:true" >&2; exit 1; fi
echo "DEPLOY_VERIFIED readyz=$READY_BODY archive=$ARCHIVE"
trap - EXIT
rm -f "$READY_FILE"
`;
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
  run('git', ['-C', ROOT, 'diff', '--quiet', 'HEAD', '--']);

  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'web-build.manifest.json'), 'utf8'));
  if (manifest.source_commit !== commit) {
    throw new Error(`BUNDLE_SOURCE_MISMATCH: manifest ${manifest.source_commit} != ${commit}`);
  }
  const fileCount = (manifest.files || []).length;
  if (!fileCount || !Number.isSafeInteger(manifest.total_bytes)) throw new Error('BUNDLE_MANIFEST_INVALID');

  // 0. Refuse before staging unless the live host still has its valid authority epoch,
  // executable launcher, serving inventory, real dependency directory and migration baseline.
  const localMigrations = fs.readdirSync(path.join(ROOT, 'packages', 'migrations', 'migrations'))
    .filter((f) => f.endsWith('.sql')).length;
  run('ssh', [host, `test -d ${PROD_ROOT} && test -x ${PROD_ROOT}/bin/node-24/bin/node || { echo DEPLOY_REFUSED_NO_PROD_RUNTIME >&2; exit 1; }`]);
  const liveAuthorityFacts = readRemoteDeployFacts(host, path.join(PROD_ROOT, 'src-final'));
  assertAuthorityFacts(liveAuthorityFacts);
  assertSchemaNotRegressing(localMigrations, Number(liveAuthorityFacts.hostMigrations));

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
  // Send only committed bytes. Copying ROOT also copied ignored native builds, scratch diagnostics
  // and private/untracked files, so the deployed tree did not reliably equal the approved SHA.
  const sourceTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'megaxo-deploy-'));
  try {
    const sourceArchive = path.join(sourceTemp, 'source.tar');
    const sourceDir = path.join(sourceTemp, 'source');
    fs.mkdirSync(sourceDir);
    run('git', ['-C', ROOT, 'archive', '--format=tar', '--output', sourceArchive, commit]);
    run('tar', ['-xf', sourceArchive, '-C', sourceDir]);
    run('rsync', ['-az', '--delete', ...excludes, `${sourceDir}/`, `${host}:${PROD_ROOT}/.stage-src/`], { stdio: 'inherit' });
  } finally {
    fs.rmSync(sourceTemp, { recursive: true, force: true });
  }
  run('rsync', ['-az', '--delete', `${bundle}/`, `${host}:${PROD_ROOT}/.stage-web/`], { stdio: 'inherit' });

  // Overlay host-managed launcher, serving inventory and dependencies before the swap. rehearse.sh
  // is optional. Validate the staged launcher and inventory against the live authority first.
  run('ssh', [host, buildHostManagedOverlayScript(PROD_ROOT)], { stdio: 'inherit' });
  run('ssh', [host, 'sudo -n chown -R root:root /opt/mega-xo-v5-production/.stage-src /opt/mega-xo-v5-production/.stage-web']);
  const stagedAuthorityFacts = readRemoteDeployFacts(host, path.join(PROD_ROOT, '.stage-src'), { checkEpoch: false });
  assertAuthorityFacts(stagedAuthorityFacts, { checkEpoch: false });
  assertStageAuthorityMatchesLive(stagedAuthorityFacts, liveAuthorityFacts);
  assertSchemaNotRegressing(localMigrations, Number(stagedAuthorityFacts.hostMigrations));

  // 2. Receipt before the swap, so a failed swap still leaves identity evidence.
  const receipt = {
    at: new Date().toISOString(), kind: 'v5-production-deploy', source_commit: commit,
    bundle_sha256: manifest.bundle_sha256, file_count: fileCount, total_bytes: manifest.total_bytes,
    staged_from: os.hostname(), archive, service: SERVICE,
  };
  run('ssh', [host, `sudo -n chown \$(id -un):\$(id -gn) ${PROD_ROOT}/state
tee ${PROD_ROOT}/state/deploy-receipt.json <<'EOF'\n${JSON.stringify(receipt, null, 2)}\nEOF`]);

  // One guarded transaction owns archive creation, swap, restart and readiness. Any failure after
  // the archive is complete restores by copy and verifies that the PostgreSQL authority is ready.
  run('ssh', [host, buildDeploymentTransactionScript(PROD_ROOT, archive)], { stdio: 'inherit' });

  process.stdout.write(JSON.stringify({ ok: true, commit, bundle_sha256: manifest.bundle_sha256, files: fileCount, archive }) + '\n');
}

if (require.main === module) {
  try { main(); } catch (err) { process.stderr.write(String(err && err.message).slice(0, 300) + '\n'); process.exitCode = 1; }
}

module.exports = {
  main,
  /* Pure guards and the exact shell executors used by main, for offline regression fixtures. */
  assertSchemaNotRegressing, parseServeBinding, assertTargetsMatch, assertAuthorityEpoch,
  assertAuthorityFacts, readinessVerdict, buildHostManagedOverlayScript,
  buildDeploymentTransactionScript,
};
