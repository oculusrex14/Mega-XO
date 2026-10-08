/* V5-02-04 - PostgreSQL connection and environment guards.
 *
 * Consumer-visible behaviour tests for packages/db/pg: config guards refuse a
 * pool before anything connects; the session probe fails closed with
 * ROLE_MISMATCH before any application query; the explicit target inventory
 * binds non-loopback environments (lexical host tokens are never authority);
 * cross-role membership and mid-session SET ROLE elevation are refused; pool
 * budgets key on the real endpoint (direct and -pooler variants share one
 * capacity account); release sanitization restores the pinned session; and
 * withIdempotentTransaction keeps the P01 borrow-only-when-active semantics
 * with the shared ContextError vocabulary.
 *
 * Harness contract (shared P02 disposable PG16 contract):
 *   V5_PG_URL=postgres://user:***@127.0.0.1:5432/<controlDb>   opt-in external
 *       service. Loopback host + nonproduction control DB only, and it MUST
 *       come with V5_PG_DISPOSABLE=1 (an exclusively owned synthetic test
 *       cluster - role create/LOGIN changes are cluster-wide, so ownership is
 *       never inferred from a URL). The supplied control DB is never
 *       mutated/dropped/truncated; this suite creates only tracked
 *       `v5_test_guards_<pid>_<suffix>` databases and drops only its own
 *       tracked names (async after-hook, plus cluster membership revocations).
 *   V5_PG_REQUIRED=1   fail (never silently skip) when no backend is usable or
 *       the env is incoherent; CI always sets it, and the TLS scenario then
 *       runs on an isolated self-created container so NOTHING skips.
 *   Otherwise: docker backend when the daemon answers on first probe (never
 *   retried to "confirm" a reported failure), else installed Homebrew
 *   postgresql@16 binaries on a test-owned mkdtemp datadir + random loopback
 *   port. The migration chain creates runtime roles NOLOGIN without
 *   membership; this owned synthetic harness enables EXACT runtime roles as
 *   LOGIN principals and every caller connects AS that exact role. The only
 *   membership edges are granted inside single tests to prove the guard
 *   REFUSES them, and are revoked immediately (plus after-hook safety).
 * Run with --test-concurrency=1 when sharing a service; in-test concurrency
 * scenarios use real parallel connections. Assertions are observable
 * queries/failures, never pg internals.
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { after } = require('node:test');
const { spawnSync } = require('node:child_process');
const { inspect } = require('node:util');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ContextError } = require('../packages/db/context.js');
const pg = require('pg');
const {
 createPgPool, fromEnvironment, withIdempotentTransaction, currentPgScope, requirePgScope,
 poolBudgetSnapshot, PgGuardError, PG_ROLES, assertSessionRole, buildApplicationName,
 classifyHint, extractNeonHint, assertEnvironmentCoherence, SEARCH_PATH,
} = require('../packages/db/pg');

const REVISION = 'e0c4302f';
const SERVICE = 'guards-test';
const MOCK_CA = path.join(os.tmpdir(), 'mega-xo-v5-pg-guards-mock-ca.crt');
fs.writeFileSync(MOCK_CA, '-----BEGIN CERTIFICATE-----\nMAAE\n-----END CERTIFICATE-----\n');
const CA_TEXT = fs.readFileSync(MOCK_CA).toString();

let pureTarget = 0;
const pureConfig = (over = {}) => {
 const merged = {
  host: 'db.example.internal', port: 5432, database: 'megaxo_authority',
  user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, password: 'x'.repeat(16),
  service: SERVICE, revision: REVISION, label: 'staging', neonProjectHint: 'megaxo-v5-staging',
  ssl: { ca: CA_TEXT },
  budget: { totalConnections: 64 },
  ...over,
 };
 // the declared target mirrors the URI it must bind (tests override
 // `target:` explicitly to prove mismatch refusal; `target: undefined` opts
 // out - non-loopback refusal is asserted separately)
 if (merged.target === null) delete merged.target; // explicit 'unbound' probe
 else if (merged.target === undefined) merged.target = { version: 1, environment: merged.label, host: merged.host, database: merged.database, pgMajor: 16, nonserving: true };
 return merged;
};
const code = (want) => (e) => e instanceof PgGuardError && e.code === want;

/* ============================== pure config guards ============================== */

test('config guards fail closed before any connection object exists', async () => {
 const cases = [
  [{ host: undefined }, 'PG_HOST_REQUIRED'],
  [{ database: undefined }, 'PG_DATABASE_REQUIRED'],
  [{ user: undefined }, 'PG_USER_REQUIRED'],
  [{ role: undefined }, 'ROLE_REQUIRED'],
  [{ role: 'pg_read_all_data' }, 'ROLE_INVALID'],
  [{ user: 'postgres', role: 'postgres' }, 'ROLE_INVALID'],
  [{ user: 'core_runtime', role: PG_ROLES.API_RUNTIME }, 'ROLE_USER_MISMATCH'],
  [{ label: undefined }, 'ENV_LABEL_REQUIRED'],
  [{ label: 'prod-ish' }, 'ENV_LABEL_INVALID'],
  [{ service: undefined }, 'SERVICE_REQUIRED'],
  [{ revision: undefined }, 'REVISION_REQUIRED'],
  [{ budget: undefined }, 'POOL_BUDGET_REQUIRED'],
  [{ budget: { totalConnections: 0 } }, 'POOL_BUDGET_TOTAL_INVALID'],
  [{ ssl: undefined, sslmode: undefined }, 'SSL_CA_REQUIRED'],
  [{ sslmode: 'disable' }, 'SSL_REQUIRED'],
  [{ ssl: false }, 'SSL_REQUIRED'],
  [{ sslmode: 'prefer' }, 'SSL_REQUIRED'],
  [{ ssl: { ca: 'not a pem' } }, 'SSL_ROOTCERT_NOT_PEM'],
  [{ ssl: { caFile: path.join(os.tmpdir(), 'definitely-missing-ca.crt') } }, 'SSL_ROOTCERT_UNREADABLE'],
  [{ ssl: { ca: CA_TEXT, rejectUnauthorized: false } }, 'SSL_REQUIRED'],
  [{ pool: { max: 0 } }, 'POOL_MAX_INVALID'],
  [{ pool: { max: 17 } }, 'POOL_MAX_INVALID'],
  [{ pool: { queueLimit: 0 } }, 'POOL_QUEUE_LIMIT_INVALID'],
  [{ pool: { idleTimeoutMillis: 5 } }, 'POOL_IDLE_TIMEOUT_INVALID'],
  [{ pool: { connectionTimeoutMillis: 10 } }, 'POOL_ACQUIRE_TIMEOUT_INVALID'],
  [{ statementTimeoutMs: 5 }, 'STATEMENT_TIMEOUT_INVALID'],
  [{ port: 70000 }, 'PG_PORT_INVALID'],
  [{ label: 'staging', password: undefined }, 'PG_CREDENTIALS_REQUIRED'],
  [{ expectedServerMajor: 9 }, 'PG_VERSION_PIN_INVALID'],
  [{ target: undefined, label: 'production', ssl: { ca: CA_TEXT } }, 'ENVIRONMENT_MISMATCH'],
 ];
 for (const [over, want] of cases) {
  assert.throws(() => createPgPool(pureConfig(over)), code(want), `expected ${want} for ${inspect(over)}`);
 }
 const ok = createPgPool(pureConfig());
 assert.equal(typeof ok.connect, 'function');
 assert.equal(ok.describe().applicationName, `api_runtime/${SERVICE}/${REVISION}`);
 await ok.end();
});

test('production-pattern labels refuse staging pools and vice versa', async () => {
 const cross = [
  [{ label: 'staging', database: 'megaxo_production' }, 'ENVIRONMENT_MISMATCH'],
  [{ label: 'staging', neonProjectHint: 'megaxo-prod-53820697' }, 'ENVIRONMENT_MISMATCH'],
  [{ label: 'preview', database: 'megaxo_prod' }, 'ENVIRONMENT_MISMATCH'],
  [{ label: 'production', neonProjectHint: 'megaxo-v5-staging' }, 'ENVIRONMENT_MISMATCH'],
  [{ label: 'production', host: '127.0.0.1', ssl: { ca: CA_TEXT } }, 'ENVIRONMENT_MISMATCH'],
  [{ label: 'production', database: 'megaxo_staging_prod', neonProjectHint: 'megaxo-neutral' }, 'ENVIRONMENT_AMBIGUOUS'],
 ];
 for (const [over, want] of cross) {
  assert.throws(() => createPgPool(pureConfig({ password: 'p'.repeat(12), ...over })), code(want), `expected ${want} for ${inspect(over)}`);
 }
 // credential fields with real naming semantics are classified directly
 assert.throws(() => assertEnvironmentCoherence({ label: 'staging', database: 'db', user: 'megaxo_prod_rw', neonProjectHint: null }), code('ENVIRONMENT_MISMATCH'));
 assert.throws(() => assertEnvironmentCoherence({ label: 'production', database: 'megaxo_staging_rw', user: 'u', neonProjectHint: null }), code('ENVIRONMENT_MISMATCH'));
 assert.equal(classifyHint('megaxo_staging'), 'nonproduction');
 assert.equal(classifyHint('megaxo_authority'), 'neutral');
 assert.equal(classifyHint('megaxo_staging_prod'), 'ambiguous');
 assert.equal(extractNeonHint('ep-cool-name-123-pooler.aws.neon.tech'), 'ep-cool-name-123');
 assert.equal(extractNeonHint('db.example.internal'), null);
 // random-word hostnames are NOT environment authority: a 'dev'-looking slug
 // is accepted when the explicit target inventory binds it to staging
 const neutralHostPool = createPgPool(pureConfig({
  label: 'production', host: 'ep-quiet-devfox-7.c-2.us-east-1.aws.neon.tech', neonProjectHint: undefined,
  target: { version: 1, environment: 'production', projectId: 'prj-prod-9', branchId: 'br-main-9', endpointId: 'ep-quiet-devfox-7', host: 'ep-quiet-devfox-7.c-2.us-east-1.aws.neon.tech', database: 'megaxo_authority', nonserving: false },
 }));
 assert.equal(neutralHostPool.describe().target.environment, 'production');
 await neutralHostPool.end();
});

test('explicit target inventory binds non-loopback environments', async () => {
 const base = { version: 1, projectId: 'prj-megaxo-nonprod-7', branchId: 'br-feature-a' };
 const stagingTarget = { ...base, environment: 'staging', host: 'ep-red-waterfall-b880jir8.c-14.us-east-1.aws.neon.tech', endpointId: 'ep-red-waterfall-b880jir8', database: 'megaxo_authority', pgMajor: 16, nonserving: true };
 const direct = pureConfig({ host: stagingTarget.host, label: 'staging', target: stagingTarget, neonProjectHint: undefined });
 const pooler = pureConfig({ host: stagingTarget.host.replace('ep-red-waterfall-b880jir8.', 'ep-red-waterfall-b880jir8-pooler.'), label: 'staging', target: stagingTarget, neonProjectHint: undefined });
 const a = createPgPool({ ...direct, pool: { max: 2 }, budget: { totalConnections: 8, roleConnections: { api_runtime: 4, core_runtime: 4 } } });
 // the verified pooler variant of the SAME endpoint is accepted, endpointId unchanged
 const b = createPgPool({ ...pooler, pool: { max: 2 }, budget: { totalConnections: 8, roleConnections: { api_runtime: 4, core_runtime: 4 } } });
 const identity = 'ep:prj-megaxo-nonprod-7/br-feature-a/ep-red-waterfall-b880jir8/megaxo_authority';
 assert.deepEqual(poolBudgetSnapshot(identity), { totalConnections: 8, roleConnections: { api_runtime: 4, core_runtime: 4 }, used: 4, roles: { api_runtime: 4 }, pools: 2 }, 'direct + pooler share ONE budget identity, never double-counted by hostname alias');
 // the alias share is real: api allocation (4) is already exhausted although "db.example.internal" pools exist
 assert.throws(() => createPgPool({ ...pooler, pool: { max: 1 }, budget: { totalConnections: 8, roleConnections: { api_runtime: 4, core_runtime: 4 } } }), code('POOL_BUDGET_EXCEEDED'), 'the pooler alias shares the api allocation - it is already exhausted');
 await a.end();
 await b.end();
 const mismatch = [
  [{ target: { ...stagingTarget, environment: 'dev' } }, 'TARGET_MISMATCH'],
  [{ target: { ...stagingTarget, host: 'ep-blue-delta-1.c-3.us-east-2.aws.neon.tech', endpointId: 'ep-blue-delta-1' } }, 'TARGET_MISMATCH'],
  [{ target: { ...stagingTarget, database: 'megaxo_other' } }, 'TARGET_MISMATCH'],
  [{ target: { ...stagingTarget, endpointId: 'ep-impostor-1' } }, 'TARGET_MISMATCH'],
  [{ target: (() => { const t = { ...stagingTarget }; delete t.nonserving; return t; })() }, 'TARGET_FILE_INVALID'], // serving state must be declared
  [{ target: { version: 1, environment: 'staging', host: 'ep-plain-1.aws.neon.tech', database: 'megaxo_authority', nonserving: true } }, 'TARGET_FILE_INVALID'], // Neon target without project/branch/endpoint ids
  [{ target: { version: 2, environment: 'staging', host: stagingTarget.host, projectId: 'p', branchId: 'b', endpointId: 'ep-red-waterfall-b880jir8', database: 'megaxo_authority', nonserving: true } }, 'TARGET_FILE_INVALID'],
  [{ target: { version: 1, environment: 'staging', host: stagingTarget.host, projectId: 'p', branchId: 'b', endpointId: 'ep-red-waterfall-b880jir8', database: 'megaxo_authority', nonserving: true, password: 'smuggled' } }, 'TARGET_FILE_INVALID'],
  [{ target: null }, 'TARGET_REQUIRED'],
 ];
 for (const [over, want] of mismatch) {
  assert.throws(() => createPgPool(pureConfig({ host: stagingTarget.host, neonProjectHint: undefined, ...over })), code(want), `expected ${want} for target ${inspect(over.target)}`);
 }
 // dev/test labels are the explicit non-authoritative opt-in, no inventory needed
 const dev = createPgPool(pureConfig({ label: 'dev', target: undefined }));
 await dev.end();
 // MEGA_PG_TARGET_FILE manifest path + pgMajor pinning + secret-key refusal
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-xo-pg-target-'));
 const good = path.join(dir, 'staging.json');
 fs.writeFileSync(good, JSON.stringify(stagingTarget));
 const cfg = fromEnvironment({ MEGA_PG_TARGET_FILE: good, MEGA_ENV_LABEL: 'staging', MEGA_PG_HOST: stagingTarget.host, MEGA_PG_DATABASE: 'megaxo_authority', MEGA_PG_USER: 'api_runtime', MEGA_PG_ROLE: 'api_runtime', MEGA_SERVICE: 'api', MEGA_RELEASE_REVISION: REVISION, MEGA_PG_PASSWORD: 'x'.repeat(16) }, { ssl: { ca: CA_TEXT }, budget: { totalConnections: 4 } });
 const viaFile = createPgPool(cfg);
 assert.equal(viaFile.describe().expectedServerMajor, 16);
 assert.equal(viaFile.describe().target.endpointId, 'ep-red-waterfall-b880jir8');
 await viaFile.end();
 const badFile = path.join(dir, 'bad.json');
 fs.writeFileSync(badFile, JSON.stringify({ ...stagingTarget, token: 'secret-like-value' }));
 assert.throws(() => createPgPool(fromEnvironment({ MEGA_PG_TARGET_FILE: badFile, MEGA_ENV_LABEL: 'staging', MEGA_PG_HOST: stagingTarget.host, MEGA_PG_DATABASE: 'megaxo_authority', MEGA_PG_USER: 'api_runtime', MEGA_PG_ROLE: 'api_runtime', MEGA_SERVICE: 'api', MEGA_RELEASE_REVISION: REVISION, MEGA_PG_PASSWORD: 'x'.repeat(16) }, { ssl: { ca: CA_TEXT }, budget: { totalConnections: 4 } })), code('TARGET_FILE_INVALID'));
 const unparseable = path.join(dir, 'broken.json');
 fs.writeFileSync(unparseable, '{nope');
 assert.throws(() => createPgPool(fromEnvironment({ MEGA_PG_TARGET_FILE: unparseable }, { host: stagingTarget.host, database: 'megaxo_authority', user: 'api_runtime', role: 'api_runtime', password: 'x'.repeat(12), service: SERVICE, revision: REVISION, label: 'staging', ssl: { ca: CA_TEXT }, budget: { totalConnections: 4 }, neonProjectHint: undefined })), code('TARGET_FILE_INVALID'));
 fs.rmSync(dir, { recursive: true, force: true });
});

test('the provisioned environment inventories bind their real endpoints', async () => {
 const root = path.join(__dirname, '..');
 const cases = [
  ['docs/v5/environments/staging.json', { label: 'staging', host: 'ep-red-waterfall-b880jir8.c-14.us-east-1.aws.neon.tech', database: 'mega_xo_v5_staging', endpointId: 'ep-red-waterfall-b880jir8', projectId: 'lively-shadow-52629967', branchId: 'br-falling-resonance-b87qm6iz' }],
  ['docs/v5/environments/dev.json', { label: 'dev', host: 'ep-super-breeze-b7lgtrdg.c-13.us-east-1.aws.neon.tech', database: 'mega_xo_v5_dev', endpointId: 'ep-super-breeze-b7lgtrdg', projectId: 'silent-unit-55400508', branchId: 'br-misty-base-b7zadxba' }],
  ['docs/v5/environments/production.json', { label: 'production', host: 'ep-mute-surf-b8v94ksa.c-14.us-east-1.aws.neon.tech', database: 'mega_xo_v5_production', endpointId: 'ep-mute-surf-b8v94ksa', projectId: 'blue-sun-85454968', branchId: 'br-dawn-dawn-b8f9n7zq' }],
 ];
 for (const [rel, inv] of cases) {
  const file = path.join(root, rel);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  const mkEnv = (over = {}) => ({
   MEGA_PG_TARGET_FILE: file, MEGA_ENV_LABEL: inv.label, MEGA_PG_HOST: inv.host, MEGA_PG_DATABASE: inv.database,
   MEGA_PG_USER: 'api_runtime', MEGA_PG_ROLE: 'api_runtime', MEGA_SERVICE: 'guards-verify', MEGA_RELEASE_REVISION: REVISION,
   MEGA_PG_POOL_BUDGET_TOTAL: '8', ...over,
  });
  const secrets = { ssl: { ca: CA_TEXT }, password: 'x'.repeat(16) };
  const direct = createPgPool(fromEnvironment(mkEnv(), secrets));
  assert.equal(direct.describe().expectedServerMajor, 16, 'pgMajor is pinned from the actual inventory');
  assert.equal(direct.describe().target.projectId, inv.projectId);
  assert.equal(direct.describe().target.environment, inv.label);
  // the verified -pooler variant of the SAME endpoint binds with an unchanged endpointId
  const poolHost = inv.host.replace(inv.endpointId + '.', inv.endpointId + '-pooler.');
  const pooler = createPgPool(fromEnvironment(mkEnv({ MEGA_PG_HOST: poolHost, MEGA_PG_MAX: '2' }), secrets));
  const identity = `ep:${inv.projectId}/${inv.branchId}/${inv.endpointId}/${inv.database}`;
  const snap = poolBudgetSnapshot(identity);
  assert.equal(snap.used, 6, 'direct(4) + pooler(2) share ONE endpoint budget identity');
  assert.equal(snap.pools, 2);
  await direct.end();
  await pooler.end();
  assert.equal(poolBudgetSnapshot(identity), null);
  // a host that is neither the inventory host nor its pooler variant is refused
  // (dev is the non-authoritative label and never requires binding)
  if (inv.label !== 'dev') {
   assert.throws(() => createPgPool(fromEnvironment(mkEnv({ MEGA_PG_HOST: inv.host.replace(inv.endpointId, 'ep-impostor-1') }), secrets)), code('TARGET_MISMATCH'));
  }
 }
 // cross-environment labels are refused between the two authority-shaped envs
 const stagingFile = path.join(root, 'docs/v5/environments/staging.json');
 const productionFile = path.join(root, 'docs/v5/environments/production.json');
 assert.throws(() => createPgPool(fromEnvironment({ MEGA_PG_TARGET_FILE: stagingFile, MEGA_ENV_LABEL: 'production', MEGA_PG_HOST: 'ep-red-waterfall-b880jir8.c-14.us-east-1.aws.neon.tech', MEGA_PG_DATABASE: 'mega_xo_v5_staging', MEGA_PG_USER: 'api_runtime', MEGA_PG_ROLE: 'api_runtime', MEGA_SERVICE: 'x', MEGA_RELEASE_REVISION: REVISION, MEGA_PG_POOL_BUDGET_TOTAL: '4' }, { ssl: { ca: CA_TEXT }, password: 'x'.repeat(16) })), code('ENVIRONMENT_MISMATCH'));
 assert.throws(() => createPgPool(fromEnvironment({ MEGA_PG_TARGET_FILE: productionFile, MEGA_ENV_LABEL: 'staging', MEGA_PG_HOST: 'ep-mute-surf-b8v94ksa.c-14.us-east-1.aws.neon.tech', MEGA_PG_DATABASE: 'mega_xo_v5_production', MEGA_PG_USER: 'api_runtime', MEGA_PG_ROLE: 'api_runtime', MEGA_SERVICE: 'x', MEGA_RELEASE_REVISION: REVISION, MEGA_PG_POOL_BUDGET_TOTAL: '4' }, { ssl: { ca: CA_TEXT }, password: 'x'.repeat(16) })), code('ENVIRONMENT_MISMATCH'));
 // unknown/unbound non-loopback target is refused outright
 assert.throws(() => createPgPool(fromEnvironment({ MEGA_ENV_LABEL: 'staging', MEGA_PG_HOST: 'ep-unknown-1.c-9.us-east-2.aws.neon.tech', MEGA_PG_DATABASE: 'some_db', MEGA_PG_USER: 'core_runtime', MEGA_PG_ROLE: 'core_runtime', MEGA_SERVICE: 'x', MEGA_RELEASE_REVISION: REVISION, MEGA_PG_POOL_BUDGET_TOTAL: '4' }, { ssl: { ca: CA_TEXT }, password: 'x'.repeat(16) })), code('TARGET_REQUIRED'));
});

test('application_name contract is exactly <role>/<service>/<revision>', () => {
 assert.equal(buildApplicationName({ role: 'core_runtime', service: 'core-a', revision: REVISION }), `core_runtime/core-a/${REVISION}`);
 assert.throws(() => buildApplicationName({ role: 'core_runtime', service: 'bad service', revision: REVISION }), code('SERVICE_REQUIRED'));
 assert.throws(() => buildApplicationName({ role: 'core_runtime', service: SERVICE, revision: 'x'.repeat(40) }), code('REVISION_REQUIRED'));
 assert.throws(() => buildApplicationName({ role: 'core_runtime', service: 'a'.repeat(31), revision: 'b'.repeat(31) }), code('APPLICATION_NAME_INVALID'));
});

test('pool budgets are shared across roles per target and refused up front', async () => {
 const target = { host: 'db.example.internal', port: 5432, database: `megaxo_authority_b${++pureTarget}` };
 const budget = { totalConnections: 3, roleConnections: { api_runtime: 2, core_runtime: 2 } };
 const a = createPgPool(pureConfig({ ...target, pool: { max: 2 }, budget }));
 assert.throws(() => createPgPool(pureConfig({ ...target, pool: { max: 2 }, budget })), code('POOL_BUDGET_EXCEEDED'), 'a second api pool would double its allocation');
 assert.throws(() => createPgPool(pureConfig({ ...target, role: PG_ROLES.WORKER_RUNTIME, user: PG_ROLES.WORKER_RUNTIME, budget })), code('POOL_BUDGET_ROLE_ALLOC_MISSING'));
 assert.throws(() => createPgPool(pureConfig({ ...target, role: PG_ROLES.CORE_RUNTIME, user: PG_ROLES.CORE_RUNTIME, pool: { max: 2 }, budget })), code('POOL_BUDGET_EXCEEDED'), '2+2 exceeds the 3-connection total');
 assert.throws(() => createPgPool(pureConfig({ ...target, role: PG_ROLES.CORE_RUNTIME, user: PG_ROLES.CORE_RUNTIME, pool: { max: 3 }, budget })), code('POOL_BUDGET_EXCEEDED'), 'one pool above its role allocation');
 assert.throws(() => createPgPool(pureConfig({ ...target, budget: { totalConnections: 3 } })), code('POOL_BUDGET_CONFLICT'));
 await a.end();
 const reborn = createPgPool(pureConfig({ ...target, pool: { max: 2 }, budget }));
 await reborn.end();
});

test('budget accounting releases when pools end', async () => {
 const target = { host: 'db.example.internal', port: 5432, database: `megaxo_authority_c${++pureTarget}` };
 const budget = { totalConnections: 4, roleConnections: { api_runtime: 2, core_runtime: 2 } };
 const a = createPgPool(pureConfig({ ...target, pool: { max: 2 }, budget }));
 const b = createPgPool(pureConfig({ ...target, role: PG_ROLES.CORE_RUNTIME, user: PG_ROLES.CORE_RUNTIME, pool: { max: 2 }, budget }));
 assert.deepEqual(poolBudgetSnapshot(target), { totalConnections: 4, roleConnections: budget.roleConnections, used: 4, roles: { api_runtime: 2, core_runtime: 2 }, pools: 2 });
 await a.end();
 assert.throws(() => createPgPool(pureConfig({ ...target, budget })), code('POOL_BUDGET_EXCEEDED')); // default max 4 breaches the api allocation of 2
 const c = createPgPool(pureConfig({ ...target, pool: { max: 1 }, budget })); // 1 fits the freed headroom
 assert.equal(poolBudgetSnapshot(target).pools, 2);
 await Promise.all([b.end(), c.end()]);
 assert.equal(poolBudgetSnapshot(target), null);
});

test('fromEnvironment assembles the documented MEGA_* contract without leaking the password', async () => {
 const env = {
  MEGA_PG_URL: 'postgres://api_runtime:s3cr3t-va1ue@ep-neutral-9.aws.neon.tech:5432/megaxo_authority?sslmode=require',
  MEGA_ENV_LABEL: 'staging',
  MEGA_NEON_PROJECT: 'megaxo-v5-nonprod',
  MEGA_PG_ROLE: 'api_runtime',
  MEGA_SERVICE: 'api',
  MEGA_RELEASE_REVISION: REVISION,
  MEGA_PG_EXPECTED_MAJOR: '16',
  MEGA_PG_MAX: '3',
  MEGA_PG_QUEUE_LIMIT: '5',
  MEGA_PG_CONNECT_TIMEOUT_MS: '2000',
  MEGA_PG_STATEMENT_TIMEOUT_MS: '4000',
  MEGA_PG_POOL_BUDGET_TOTAL: '12',
  MEGA_PG_POOL_BUDGET_ROLES: 'api_runtime:3',
  MEGA_PG_SSL_ROOTCERT: MOCK_CA,
 };
 const target = { version: 1, environment: 'staging', projectId: 'prj-nonprod-1', branchId: 'br-review-a', endpointId: 'ep-neutral-9', host: 'ep-neutral-9.aws.neon.tech', database: 'megaxo_authority', nonserving: true };
 const cfg = fromEnvironment(env, { target });
 assert.equal(cfg.host, 'ep-neutral-9.aws.neon.tech');
 assert.equal(cfg.port, 5432);
 assert.equal(cfg.database, 'megaxo_authority');
 assert.equal(cfg.user, 'api_runtime');
 assert.equal(cfg.sslmode, 'require');
 assert.equal(cfg.sslRootCertPath, MOCK_CA);
 assert.equal(cfg.password, 's3cr3t-va1ue');
 assert.equal(JSON.stringify(cfg).includes('s3cr3t-va1ue'), false, 'password must not be enumerable');
 assert.equal(inspect(cfg).includes('s3cr3t-va1ue'), false, 'inspection must not leak the password');
 const pool = createPgPool(cfg);
 assert.equal(pool.describe().ssl, 'verify-full(explicit-root-ca)');
 assert.equal(pool.describe().pool.max, 3);
 assert.throws(() => createPgPool(fromEnvironment({ ...env, MEGA_PG_URL: env.MEGA_PG_URL.replace('sslmode=require', 'sslmode=disable') }, { target })), code('SSL_REQUIRED'));
 assert.throws(() => createPgPool(fromEnvironment({ ...env, MEGA_PG_URL: env.MEGA_PG_URL.replace('api_runtime:s3', 'api2_runtime:s3') }, { target })), code('ROLE_USER_MISMATCH'));
 return pool.end();
});

test('assertSessionRole fails closed on a mismatched or broken session without touching application data', async () => {
 const stub = (rows, opts = {}) => ({
  async query(sql) {
   if (sql.includes('role_memberships')) {
    const names = [...sql.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).filter((n) => n !== 'USAGE');
    return { rows: [{ role_memberships: Object.fromEntries(names.map((n) => [n, (opts.crossMembers || []).includes(n)])) }] };
   }
   return { rows: [rows] };
  },
 });
 const good = { current_user: 'api_runtime', session_user: 'api_runtime', server_version: '16.4', db_temp: false, schema_privileges: { identity: { usage: true, create: false } } };
 // wrong role: ROLE_MISMATCH and only guard probes were issued
 await assert.rejects(assertSessionRole(stub({ ...good, current_user: 'core_runtime' }), PG_ROLES.API_RUNTIME, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.current_user === 'core_runtime');
 // SET ROLE drift: current_user right, session_user wrong (a SET ROLE session is
 // never a valid principal - the chain grants no memberships for one)
 await assert.rejects(assertSessionRole(stub({ ...good, session_user: 'postgres' }), PG_ROLES.API_RUNTIME, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.session_user === 'postgres');
 // missing USAGE grant sanity
 await assert.rejects(assertSessionRole(stub({ ...good, schema_privileges: { identity: { usage: false, create: false } } }), PG_ROLES.API_RUNTIME, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'usage-grant-missing');
 // ambient CREATE on a runtime schema is a privilege smell
 await assert.rejects(assertSessionRole(stub({ ...good, schema_privileges: { identity: { usage: true, create: true } } }), PG_ROLES.API_RUNTIME, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'ambient-create-privilege');
 // database TEMP is refused for ALL FIVE runtime identities (0025+0026:
 // read-only roles need no scratch, and predefined-role memberships are
 // banned too, so no legitimate tool needs an exemption)
 for (const serving of [PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME, PG_ROLES.WORKER_RUNTIME, PG_ROLES.AUDIT_RUNTIME, PG_ROLES.BACKUP_READER]) {
  await assert.rejects(assertSessionRole(stub({ ...good, current_user: serving, session_user: serving, db_temp: true }), serving, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'database-temp-privilege');
 }
 // P1: membership in ANY other runtime principal is refused even with a clean
 // current_user=session_user session (the SET ROLE vector after checkout)
 await assert.rejects(assertSessionRole(stub(good, { crossMembers: ['core_runtime'] }), PG_ROLES.API_RUNTIME, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'cross-role-membership' && e.detail.role === 'core_runtime');
 await assert.rejects(assertSessionRole(stub(good, { crossMembers: ['neon_superuser'] }), PG_ROLES.API_RUNTIME, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.role === 'neon_superuser');
 // pinned server major
 await assert.rejects(assertSessionRole(stub({ ...good, server_version: '15.9' }), PG_ROLES.API_RUNTIME, { schemas: ['identity'], expectedServerMajor: 16 }), (e) => e.code === 'PG_VERSION_MISMATCH');
 // 0026: backup_reader holds ZERO memberships and no TEMP; revokers fail closed
 const reader = { current_user: 'backup_reader', session_user: 'backup_reader', server_version: '16.4', db_temp: false, schema_privileges: {} };
 // the zero-membership backup pass posture is proven live below (no mock echo)
 await assert.rejects(assertSessionRole(stub({ ...reader, db_temp: true }), PG_ROLES.BACKUP_READER, { schemas: [] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'database-temp-privilege', 'read-only backup needs no TEMP scratch (parent decision)');
 await assert.rejects(assertSessionRole(stub(reader, { crossMembers: ['pg_read_all_data'] }), PG_ROLES.BACKUP_READER, { schemas: [] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'cross-role-membership' && e.detail.role === 'pg_read_all_data', '0026: a surviving pg_read_all_data edge on a runtime role is itself a refusal');
 // broken probe -> ROLE_CHECK_FAILED, never a pass
 await assert.rejects(assertSessionRole({ async query() { throw new Error('connection reset by peer'); } }, PG_ROLES.API_RUNTIME), (e) => e.code === 'ROLE_CHECK_FAILED');
 await assert.rejects(assertSessionRole(null, PG_ROLES.API_RUNTIME), (e) => e.code === 'ROLE_CHECK_FAILED');
 await assert.rejects(assertSessionRole(stub(good), 'root'), (e) => e.code === 'ROLE_INVALID');
});

test('withIdempotentTransaction input guards share the packages/db/context.js error vocabulary', async () => {
 await assert.rejects(withIdempotentTransaction(null, () => {}), (e) => e instanceof ContextError && e.code === 'PG_CLIENT_REQUIRED');
 await assert.rejects(withIdempotentTransaction({ query() {} }, 'nope'), (e) => e instanceof ContextError && e.code === 'CALLBACK_REQUIRED');
 assert.throws(() => requirePgScope({ query() {} }), (e) => e instanceof ContextError && e.code === 'TRANSACTION_REQUIRED');
});

/* ==================== server-backed verification (disposable PG16) ==================== */

const IMAGE = 'postgres:16';
const REQUIRED = process.env.V5_PG_REQUIRED === '1';
/* Homebrew paths (macOS) plus the Debian/Ubuntu packages path (GitHub's ubuntu-latest
 * image ships postgresql-16 there; without it the external-mode TLS scenario finds no
 * binary and no docker daemon inside the runner's job container). */
const BIN_DIRS = ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/opt/homebrew/bin', '/usr/lib/postgresql/16/bin'];
function pgBin() {
 for (const dir of BIN_DIRS) {
  const tools = ['pg_ctl', 'initdb', 'psql', 'pg_isready'];
  if (tools.every((t) => fs.existsSync(path.join(dir, t)))) {
   const v = spawnSync(path.join(dir, 'postgres'), ['--version'], { encoding: 'utf8', timeout: 15000 });
   if (v.status === 0 && /\b16\./.test(v.stdout || '')) return dir;
  }
 }
 return null;
}
function isLoopback(host) {
 const h = String(host || '').replace(/^\[|\]$/g, '');
 return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}
function dockerAvailable() {
 try {
  return spawnSync('docker', ['version', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 25000 }).status === 0;
 } catch {
  return false;
 }
}
let MODE = null;
let SKIP = 'backend unresolved';
let extAdmin = null;
(function resolveBackend() {
 const url = process.env.V5_PG_URL;
 if (url) {
  let parsed;
  try { parsed = new URL(url); } catch {
   if (REQUIRED) throw new Error('V5_PG_REQUIRED=1 but V5_PG_URL is unparseable');
   SKIP = 'V5_PG_URL unparseable';
   return;
  }
  const controlDb = parsed.pathname.length > 1 ? decodeURIComponent(parsed.pathname.slice(1)) : '';
  const bad = !isLoopback(parsed.hostname) || !controlDb || !/^[a-z0-9_$]+$/.test(controlDb)
   || (classifyHint(controlDb) !== 'nonproduction' && classifyHint(controlDb) !== 'neutral');
  if (bad) {
   if (REQUIRED) throw new Error('V5_PG_REQUIRED=1 but V5_PG_URL is not a loopback service with a nonproduction control DB');
   SKIP = 'V5_PG_URL must target a loopback disposable service with a nonproduction control DB';
   return;
  }
  if (process.env.V5_PG_DISPOSABLE !== '1') {
   if (REQUIRED) throw new Error('V5_PG_REQUIRED=1 but V5_PG_DISPOSABLE=1 is missing: cluster-wide role changes require an explicitly owned synthetic cluster');
   SKIP = 'V5_PG_URL supplied without V5_PG_DISPOSABLE=1 - ownership is never inferred from a URL';
   return;
  }
  extAdmin = { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 5432, user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), controlDb };
  MODE = 'external';
  SKIP = false; // a resolved REQUIRED external backend never silently skips
  return;
 }
 if (dockerAvailable()) { MODE = 'docker'; SKIP = false; return; }
 MODE = pgBin() ? 'binary' : null;
 SKIP = MODE ? false : 'no PostgreSQL backend: V5_PG_URL unset, docker daemon unavailable, Homebrew postgresql@16 not found';
 if (!MODE && REQUIRED) throw new Error('V5_PG_REQUIRED=1 but no backend is available (' + SKIP + ')');
})();

const RUN_SUFFIX = crypto.randomBytes(4).toString('hex');
const CONTAINER = `megaxo-v5-pg-guards-${process.pid}-${RUN_SUFFIX}`;
const TLS_CONTAINER = `megaxo-v5-pg-guards-tls-${process.pid}-${RUN_SUFFIX}`;
/* every database this suite creates is tracked by exact name and only these
 * are ever dropped - the control DB and anything unknown are untouchable */
const OWNED_DBS = [];
const OWNED_DB = 'v5_test_guards_' + process.pid + '_' + RUN_SUFFIX;
const PROD_PROBE_DB = 'v5_test_guards_prod_' + process.pid + '_' + RUN_SUFFIX;
let serverUp = false;
let fixtureDone = false;
let pgHost = '127.0.0.1';
let pgPort = null;
let tlsDir = null;
let caFile = null;
let dataDir = null;
let tlsStandalone = null; // {container,port} isolated TLS scenario (external mode)
let controlDbName = 'postgres';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function docker(args, opts = {}) {
 return spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout || 90000, input: opts.input });
}

function psqlFileMode(sql, db) {
 if (MODE === 'docker') {
  const r = docker(['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-qX'], { input: sql });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return r.stdout;
 }
 const r = spawnSync(path.join(pgBin(), 'psql'), ['-v', 'ON_ERROR_STOP=1', '-h', pgHost, '-p', String(pgPort), '-U', 'postgres', '-d', db, '-qX'], { encoding: 'utf8', timeout: 60000, input: sql });
 if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
 return r.stdout;
}

function psqlScalar(sql, db) {
 if (MODE === 'docker') {
  const r = docker(['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-Atq', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
  return r.stdout;
 }
 const r = spawnSync(path.join(pgBin(), 'psql'), ['-v', 'ON_ERROR_STOP=1', '-h', pgHost, '-p', String(pgPort), '-U', 'postgres', '-d', db, '-Atq', '-c', sql], { encoding: 'utf8', timeout: 60000 });
 if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).slice(0, 600)}`);
 return r.stdout;
}

async function adminQuery(sql, db) {
 if (MODE !== 'external') return psqlFileMode(sql, db);
 const client = new pg.Client({ host: extAdmin.host, port: extAdmin.port, database: db, user: extAdmin.user, password: extAdmin.password });
 await client.connect();
 try {
  const r = await client.query(sql);
  return r.rows && r.rows.length ? JSON.stringify(r.rows) : '';
 } finally { await client.end().catch(() => {}); }
}
async function adminScalar(sql, db) {
 if (MODE !== 'external') return psqlScalar(sql, db).trim();
 const client = new pg.Client({ host: extAdmin.host, port: extAdmin.port, database: db, user: extAdmin.user, password: extAdmin.password });
 await client.connect();
 try {
  const r = await client.query(sql);
  return r.rows.length ? String(r.rows[0][Object.keys(r.rows[0])[0]]) : '';
 } finally { await client.end().catch(() => {}); }
}

function startServerSync() {
 if (serverUp || MODE === 'external') { serverUp = true; return; }
 if (MODE === 'docker') {
  const run = docker(['run', '-d', '--rm', '--name', CONTAINER,
   '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
   '-p', '127.0.0.1:0:5432', IMAGE]);
  if (run.status !== 0) throw new Error(`container run failed: ${(run.stderr || run.stdout).slice(0, 400)}`);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
   if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-q']).status === 0) { serverUp = true; break; }
   sleep(1000);
  }
  if (!serverUp) throw new Error('postgres container never became ready');
  const m = /127\.0\.0\.1:(\d+)/.exec(docker(['port', CONTAINER, '5432/tcp']).stdout || '');
  if (!m) throw new Error('could not resolve loopback port');
  pgPort = Number(m[1]);
  return;
 }
 const dir = pgBin();
 if (!dir) throw new Error('Homebrew postgresql@16 binaries unavailable');
 dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-xo-pg-guards-data-'));
 const init = spawnSync(path.join(dir, 'initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8', timeout: 180000 });
 if (init.status !== 0) throw new Error(`initdb failed: ${(init.stderr || init.stdout).slice(0, 500)}`);
 let lastError = null;
 for (let attempt = 0; attempt < 8 && !serverUp; attempt += 1) {
  pgPort = 20000 + crypto.randomInt(0, 40000);
  fs.appendFileSync(path.join(dataDir, 'postgresql.conf'),
   `\nlisten_addresses = '127.0.0.1'\nport = ${pgPort}\nunix_socket_directories = '${dataDir}'\nfsync = off\nmax_connections = 40\n`);
  const start = spawnSync(path.join(dir, 'pg_ctl'), ['-D', dataDir, '-l', path.join(dataDir, 'server.log'), '-w', '-t', '60', 'start'], { encoding: 'utf8', timeout: 120000 });
  lastError = (start.stderr || start.stdout || '').slice(0, 500);
  if (start.status !== 0) continue;
  const deadline = Date.now() + 30000;
  for (;;) {
   const ready = spawnSync(path.join(dir, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', '-q'], { timeout: 10000 });
   if (ready.status === 0) { serverUp = true; break; }
   if (Date.now() > deadline) break;
   sleep(500);
  }
  if (!serverUp) spawnSync(path.join(dir, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30000 });
 }
 if (!serverUp) throw new Error('local postgres never bound a free port: ' + lastError);
}

async function ensureOwnedCluster() {
 startServerSync();
 if (MODE === 'external') { pgHost = extAdmin.host; pgPort = extAdmin.port; }
 controlDbName = MODE === 'external' ? extAdmin.controlDb : 'postgres';
 const ver = await adminScalar("SELECT current_setting('server_version');", controlDbName);
 if (!ver.startsWith('16.')) {
  if (REQUIRED) throw new Error('harness requires PostgreSQL 16, observed ' + JSON.stringify(ver));
  throw new Error('server is not PostgreSQL 16 (' + JSON.stringify(ver) + ')');
 }
 for (const db of [OWNED_DB, PROD_PROBE_DB]) {
  if (!/^v5_test_guards_[a-z0-9_]+$/.test(db)) throw new Error('owned name discipline violated: ' + db);
  const exists = await adminScalar(`SELECT 1 FROM pg_database WHERE datname = '${db}';`, controlDbName);
  if (exists !== '1') await adminQuery(`CREATE DATABASE ${db};`, controlDbName);
  OWNED_DBS.push(db); // tracked BEFORE any mutation so cleanup always sees it
 }
 await adminQuery(`DO $mig$ BEGIN
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${PG_ROLES.API_RUNTIME}') THEN CREATE ROLE ${PG_ROLES.API_RUNTIME} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${PG_ROLES.CORE_RUNTIME}') THEN CREATE ROLE ${PG_ROLES.CORE_RUNTIME} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${PG_ROLES.WORKER_RUNTIME}') THEN CREATE ROLE ${PG_ROLES.WORKER_RUNTIME} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${PG_ROLES.BACKUP_READER}') THEN CREATE ROLE ${PG_ROLES.BACKUP_READER} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${PG_ROLES.AUDIT_RUNTIME}') THEN CREATE ROLE ${PG_ROLES.AUDIT_RUNTIME} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  END $mig$;`, OWNED_DB);
 for (const role of [PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME, PG_ROLES.WORKER_RUNTIME, PG_ROLES.BACKUP_READER, PG_ROLES.AUDIT_RUNTIME]) {
  await adminQuery(`ALTER ROLE ${role} LOGIN;`, OWNED_DB); // exact-principal login, owned synthetic cluster, loopback trust
 }
}

async function schemaFixture() {
 if (fixtureDone) return;
 await ensureOwnedCluster();
 // Chain-shaped grants WITHOUT any membership edges (memberships are granted
 // only inside single refusal-proof tests and revoked immediately).
 await adminQuery(`
  CREATE SCHEMA IF NOT EXISTS meta;
  CREATE SCHEMA IF NOT EXISTS identity;
  CREATE SCHEMA IF NOT EXISTS economy;
  CREATE SCHEMA IF NOT EXISTS ops;
  CREATE SCHEMA IF NOT EXISTS audit;
  GRANT USAGE ON SCHEMA meta, identity, economy, ops TO ${PG_ROLES.API_RUNTIME}, ${PG_ROLES.CORE_RUNTIME}, ${PG_ROLES.WORKER_RUNTIME};
  CREATE TABLE IF NOT EXISTS identity.profiles(actor_id text PRIMARY KEY, display_name text NOT NULL);
  CREATE TABLE IF NOT EXISTS economy.wallets(actor_id text PRIMARY KEY, coins bigint NOT NULL CHECK (coins >= 0));
  REVOKE ALL ON ALL TABLES IN SCHEMA identity, economy, ops FROM PUBLIC;
  REVOKE TEMPORARY ON DATABASE ${OWNED_DB} FROM PUBLIC;
  GRANT SELECT, INSERT, UPDATE ON economy.wallets TO ${PG_ROLES.CORE_RUNTIME};
  GRANT SELECT ON identity.profiles, economy.wallets TO ${PG_ROLES.API_RUNTIME};`, OWNED_DB);
 fixtureDone = true;
}

async function grantMembership(from, to) {
 await adminQuery(`GRANT ${to} TO ${from};`, controlDbName);
 PENDING_REVOCATIONS.push([from, to]);
}
async function revokeMembership(from, to) {
 const idx = PENDING_REVOCATIONS.findIndex(([f, t]) => f === from && t === to);
 if (idx >= 0) PENDING_REVOCATIONS.splice(idx, 1);
 try { await adminQuery(`REVOKE ${to} FROM ${from};`, controlDbName); } catch { /* after-hook retries */ }
}
const PENDING_REVOCATIONS = [];

after(async () => {
 if (!MODE) return;
 if (fixtureDone) {
  for (const [from, to] of [...PENDING_REVOCATIONS]) await revokeMembership(from, to);
  for (const db of OWNED_DBS.splice(0)) {
   try { await adminQuery(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`, controlDbName); } catch { /* instance teardown below covers local modes */ }
  }
 }
 stopServer();
});

process.on('exit', () => stopServer());

function stopServer() {
 if (tlsStandalone) {
  if (tlsStandalone.container) docker(['rm', '-f', tlsStandalone.container], { timeout: 30000 });
  else if (tlsStandalone.tlsBinary) {
   spawnSync(path.join(pgBin(), 'pg_ctl'), ['-D', tlsStandalone.tlsBinary.dir, '-m', 'fast', 'stop'], { timeout: 30000 });
   fs.rmSync(tlsStandalone.tlsBinary.dir, { recursive: true, force: true });
  }
  tlsStandalone = null;
 }
 if (!serverUp) return;
 serverUp = false;
 if (MODE === 'docker') docker(['rm', '-f', CONTAINER], { timeout: 30000 });
 else if (MODE === 'binary' && dataDir) {
  spawnSync(path.join(pgBin(), 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { timeout: 30000 });
  fs.rmSync(dataDir, { recursive: true, force: true });
 }
 if (tlsDir) fs.rmSync(tlsDir, { recursive: true, force: true });
}

function makeCerts(dir) {
 const caKey = path.join(dir, 'ca.key'), caCert = path.join(dir, 'ca.crt');
 const srvKey = path.join(dir, 'server.key'), srvCsr = path.join(dir, 'server.csr'), srvCert = path.join(dir, 'server.crt');
 const openssl = (args) => {
  const r = spawnSync('openssl', args, { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error('openssl ' + args[0] + ': ' + (r.stderr || '').slice(0, 300));
 };
 openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-subj', '/CN=megaxo-guards-test-ca', '-days', '2']);
 openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', srvKey, '-out', srvCsr, '-subj', '/CN=localhost']);
 fs.writeFileSync(path.join(dir, 'san.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
 openssl(['x509', '-req', '-in', srvCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', srvCert, '-days', '2', '-extfile', path.join(dir, 'san.cnf')]);
 return { caCert, srvCert, srvKey };
}
async function installTls(container, host, port, certs) {
 let certPath, keyPath;
 if (container) {
  const sh = async (cmd) => {
   const r = docker(['exec', container, 'sh', '-c', cmd]);
   if (r.status !== 0) throw new Error('container tls setup failed: ' + (r.stderr || '').slice(0, 300));
  };
  await sh('mkdir -p /tls && chown postgres:postgres /tls && chmod 700 /tls');
  for (const f of ['server.crt', 'server.key']) {
   if (docker(['cp', certs[f === 'server.crt' ? 'srvCert' : 'srvKey'], `${container}:/tls/${f}`]).status !== 0) throw new Error('docker cp ' + f + ' failed');
  }
  await sh('chown postgres:postgres /tls/server.* && chmod 600 /tls/server.key');
  certPath = '/tls/server.crt';
  keyPath = '/tls/server.key';
 } else {
  fs.chmodSync(certs.srvKey, 0o600);
  certPath = certs.srvCert;
  keyPath = certs.srvKey;
 }
 const runSql = (sql) => {
  const r = container
   ? docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-qX'], { input: sql })
   : null;
  if (container && r.status !== 0) throw new Error('ALTER SYSTEM failed: ' + (r.stderr || '').slice(0, 300));
  if (!container) psqlFileMode(sql, 'postgres');
 };
 const checkSsl = () => container
  ? docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atq', '-c', "SELECT setting FROM pg_settings WHERE name='ssl';"]).stdout
  : psqlScalar("SELECT setting FROM pg_settings WHERE name='ssl';", 'postgres');
 runSql(`ALTER SYSTEM SET ssl = on;
  ALTER SYSTEM SET ssl_cert_file = '${certPath}';
  ALTER SYSTEM SET ssl_key_file = '${keyPath}';
  SELECT pg_reload_conf();`);
 const deadline = Date.now() + 30000;
 for (;;) {
  if (String(checkSsl()).trim() === 'on') break;
  if (Date.now() > deadline) throw new Error('server ssl never came up');
  sleep(500);
 }
 return { host, port, caFile: certs.caCert };
}

/* TLS scenario target: local modes enable TLS on their own owned instance;
 * external mode builds a SEPARATE isolated PG16 instance, preferring the
 * available native postgresql@16 binaries (Docker is known-blocked on this
 * host and is never probed/retried from the external path; a single docker
 * attempt remains only for environments without native binaries, e.g. CI).
 * Throws when V5_PG_REQUIRED=1 and the isolated scenario cannot start -
 * never silently degrades. */
async function installTlsBinary(dir, port, certs) {
 fs.chmodSync(certs.srvKey, 0o600);
 const at = (sql, out) => {
  const args = ['-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', out ? '-Atq' : '-qX'];
  if (out) args.push('-c', sql);
  const r = spawnSync(path.join(pgBin(), 'psql'), args, { encoding: 'utf8', timeout: 60000, input: out ? undefined : sql });
  if (r.status !== 0) throw new Error('tls-instance psql failed: ' + (r.stderr || r.stdout || '').slice(0, 300));
  return out ? String(r.stdout).trim() : null;
 };
 at(`ALTER SYSTEM SET ssl = on;
  ALTER SYSTEM SET ssl_cert_file = '${certs.srvCert}';
  ALTER SYSTEM SET ssl_key_file = '${certs.srvKey}';
  SELECT pg_reload_conf();`);
 const deadline = Date.now() + 30000;
 for (;;) {
  if (at("SELECT setting FROM pg_settings WHERE name='ssl';", true) === 'on') break;
  if (Date.now() > deadline) throw new Error('tls-instance ssl never came up');
  sleep(500);
 }
 return { host: '127.0.0.1', port, caFile: certs.caCert };
}

async function bootstrapTlsFixture(target) {
 const control = new pg.Client({ host: target.host, port: target.port, database: 'postgres', user: 'postgres', ssl: false });
 await control.connect();
 try {
  await control.query(`CREATE ROLE ${PG_ROLES.API_RUNTIME} LOGIN NOINHERIT`);
  await control.query(`CREATE DATABASE ${OWNED_DB}`);
 } finally { await control.end(); }
 const database = new pg.Client({ host: target.host, port: target.port, database: OWNED_DB, user: 'postgres', ssl: false });
 await database.connect();
 try {
  await database.query(`CREATE SCHEMA meta; CREATE SCHEMA identity;
   GRANT USAGE ON SCHEMA meta, identity TO ${PG_ROLES.API_RUNTIME};
   REVOKE TEMPORARY ON DATABASE ${OWNED_DB} FROM PUBLIC`);
 } finally { await database.end(); }
}

async function tlsScenario() {
 if (MODE !== 'external') {
  if (caFile) return { host: pgHost, port: pgPort, caFile };
  startServerSync();
  tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-xo-pg-tls-'));
  const certs = makeCerts(tlsDir);
  const res = await installTls(MODE === 'docker' ? CONTAINER : null, pgHost, pgPort, certs);
  caFile = res.caFile;
  return res;
 }
 if (tlsStandalone) return tlsStandalone.target;
 if (pgBin()) {
  const dir = pgBin();
  const tdata = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-xo-pg-tlsdata-'));
  tlsDir = tlsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mega-xo-pg-tls-'));
  const certs = makeCerts(tlsDir);
  let tport = 0;
  let started = false;
  let lastError = '';
  const init = spawnSync(path.join(dir, 'initdb'), ['-D', tdata, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8', timeout: 180000 });
  if (init.status === 0) {
   for (let attempt = 0; attempt < 8 && !started; attempt += 1) {
    tport = 20000 + crypto.randomInt(0, 40000);
    fs.appendFileSync(path.join(tdata, 'postgresql.conf'),
     `\nlisten_addresses = '127.0.0.1'\nport = ${tport}\nunix_socket_directories = '${tdata}'\nfsync = off\n`);
    const start = spawnSync(path.join(dir, 'pg_ctl'), ['-D', tdata, '-l', path.join(tdata, 'server.log'), '-w', '-t', '60', 'start'], { encoding: 'utf8', timeout: 120000 });
    lastError = (start.stderr || start.stdout || '').slice(0, 300);
    if (start.status !== 0) continue;
    const deadline = Date.now() + 30000;
    for (;;) {
     const ready = spawnSync(path.join(dir, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(tport), '-U', 'postgres', '-q'], { timeout: 10000 });
     if (ready.status === 0) { started = true; break; }
     if (Date.now() > deadline) break;
     sleep(500);
    }
    if (!started) spawnSync(path.join(dir, 'pg_ctl'), ['-D', tdata, '-m', 'fast', 'stop'], { timeout: 30000 });
   }
  } else {
   lastError = (init.stderr || init.stdout || '').slice(0, 300);
  }
  if (started) {
   const target = await installTlsBinary(tdata, tport, certs);
   tlsStandalone = { tlsBinary: { dir: tdata, port: tport }, target };
   await bootstrapTlsFixture(target);
   return target;
  }
  fs.rmSync(tdata, { recursive: true, force: true });
  if (!dockerAvailable()) throw new Error('isolated native TLS instance failed to start (' + lastError + ') and no docker fallback');
 }
 if (!dockerAvailable()) throw new Error('external TLS scenario needs native postgresql@16 binaries or one isolated postgres:16 container');
 const run = docker(['run', '-d', '--rm', '--name', TLS_CONTAINER, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1:0:5432', IMAGE]);
 if (run.status !== 0) throw new Error('TLS scenario container failed: ' + (run.stderr || run.stdout).slice(0, 300));
 const deadline = Date.now() + 180000;
 while (Date.now() < deadline) {
  if (docker(['exec', TLS_CONTAINER, 'pg_isready', '-U', 'postgres', '-q']).status === 0) break;
  sleep(1000);
 }
 const m = /127\.0\.0\.1:(\d+)/.exec(docker(['port', TLS_CONTAINER, '5432/tcp']).stdout || '');
 if (!m) throw new Error('TLS scenario port unresolved');
 tlsDir = tlsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mega-xo-pg-tls-'));
 const certs = makeCerts(tlsDir);
 const target = await installTls(TLS_CONTAINER, '127.0.0.1', Number(m[1]), certs);
 tlsStandalone = { container: TLS_CONTAINER, target };
 await bootstrapTlsFixture(target);
 return target;
}

const ownedConfig = (over = {}) => ({
 host: pgHost, port: pgPort, database: OWNED_DB,
 user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME,
 service: SERVICE, revision: REVISION, label: 'test', allowLocalNoTls: true,
 neonProjectHint: 'megaxo-v5-staging',
 budget: { totalConnections: 32 },
 ...over,
});

async function roleLogin(role) {
 const client = new pg.Client({ host: pgHost, port: pgPort, database: OWNED_DB, user: role });
 await client.connect();
 return client;
}

test('missing CA configuration fails against the real target before any socket opens', { skip: SKIP }, async () => {
 await schemaFixture();
 assert.throws(() => createPgPool({ ...ownedConfig({ label: 'staging', password: 'trust-only-local' }), allowLocalNoTls: false, ssl: undefined }), code('SSL_CA_REQUIRED'));
 assert.throws(() => createPgPool({ ...ownedConfig(), ssl: false, sslmode: 'disable', allowLocalNoTls: false }), code('SSL_REQUIRED'));
});

test('correct role passes and the pinned session lands server-side', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta', 'identity', 'economy', 'ops'] }));
 const { client, release } = await pool.connect();
 try {
  const r = await client.query("SELECT application_name, current_user, session_user, current_setting('search_path') AS sp FROM pg_stat_activity WHERE pid = pg_backend_pid()");
  const row = r.rows[0];
  assert.equal(row.application_name, `api_runtime/${SERVICE}/${REVISION}`, 'application_name must be visible in pg_stat_activity');
  assert.equal(row.current_user, 'api_runtime');
  assert.equal(row.session_user, 'api_runtime');
  assert.equal(String(row.sp).replace(/\s+/g, ''), SEARCH_PATH);
  const t2 = await client.query("SELECT name, setting FROM pg_settings WHERE name IN ('statement_timeout','idle_in_transaction_session_timeout','lock_timeout') ORDER BY name");
  assert.deepEqual(t2.rows, [
   { name: 'idle_in_transaction_session_timeout', setting: '15000' },
   { name: 'lock_timeout', setting: '2000' },
   { name: 'statement_timeout', setting: '5000' },
  ], 'pinned timeouts report exact milliseconds');
  const reg = await client.query("SELECT to_regclass('profiles') AS bare, to_regclass('identity.profiles') AS qualified");
  assert.equal(reg.rows[0].bare, null, 'search_path pg_catalog,none blocks ambient resolution');
  assert.equal(reg.rows[0].qualified, 'identity.profiles');
 } finally { await release(); }
 await pool.end();
});

test('transaction-local pins hold when the session-level timeouts are overridden', { skip: SKIP }, async () => {
 await schemaFixture();
 const schemas = ['meta', 'identity', 'economy', 'ops'];
 const pool = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: schemas }));
 let borrowed;
 try {
  borrowed = await pool.connect();
  await borrowed.client.query('SET statement_timeout = 0; SET lock_timeout = 0; SET idle_in_transaction_session_timeout = 0');
  const timings = "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle";
  assert.deepEqual((await borrowed.client.query(timings)).rows[0], { statement: '0', lock: '0', idle: '0' });
  const description = pool.describe();
  const inside = await withIdempotentTransaction(borrowed.client, tx => tx.query(timings), {
   connected: true,
   expectSession: {
    role: description.role, schemas, applicationName: description.applicationName,
    searchPath: description.searchPath, expectedServerMajor: description.expectedServerMajor,
    ...description.timings,
   },
  });
  assert.deepEqual(inside.rows[0], { statement: '5s', lock: '2s', idle: '15s' });
  assert.deepEqual((await borrowed.client.query(timings)).rows[0], { statement: '0', lock: '0', idle: '0' }, 'LOCAL pins must not leak beyond commit');
 } finally {
  if (borrowed) await borrowed.release();
  await pool.end();
 }
});

test('wrong role fails ROLE_MISMATCH before any application query runs', { skip: SKIP }, async () => {
 await schemaFixture();
 // 1) superuser SET ROLE shape (deployment never does this; guard refuses it)
 const superCreds = MODE === 'external' ? { user: extAdmin.user, password: extAdmin.password } : { user: 'postgres' };
 const superClient = new pg.Client({ host: pgHost, port: pgPort, database: OWNED_DB, ...superCreds });
 await superClient.connect();
 const isSuper = (await superClient.query("SELECT current_setting('is_superuser') AS s")).rows[0].s === 'true';
 if (isSuper) {
  await superClient.query(`SET ROLE ${PG_ROLES.API_RUNTIME}`);
  await assert.rejects(assertSessionRole(superClient, PG_ROLES.API_RUNTIME, { schemas: ['identity'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.session_user === superCreds.user, 'super SET ROLE drift must be refused');
 }
 await superClient.end();
 // 2) exact-principal core_runtime against the api_runtime expectation
 const coreClient = await roleLogin(PG_ROLES.CORE_RUNTIME);
 try {
  await assert.rejects(assertSessionRole(coreClient, PG_ROLES.API_RUNTIME, { schemas: ['meta', 'identity', 'economy', 'ops'] }), (e) => e.code === 'ROLE_MISMATCH' && e.detail.current_user === 'core_runtime', 'core principal against api expectation must be refused');
 } finally { await coreClient.end(); }
 // 3a) database TEMP privilege is refused for a runtime principal (mutable
 // temp schema could shadow the guards' own pg_catalog inputs)
 await adminQuery(`GRANT TEMPORARY ON DATABASE ${OWNED_DB} TO ${PG_ROLES.API_RUNTIME};`, controlDbName);
 try {
  const temply = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta'] }));
  await assert.rejects(temply.connect(), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'database-temp-privilege', 'runtime TEMP posture must be refused at checkout');
  await temply.end();
 } finally {
  await adminQuery(`REVOKE TEMPORARY ON DATABASE ${OWNED_DB} FROM ${PG_ROLES.API_RUNTIME};`, controlDbName);
 }
 // 3b) parent decision: backup_reader must pass only WITHOUT TEMP; a granted
 // TEMPORARY edge (pre-0025-fix shape) is refused fail-closed like any runtime
 await adminQuery(`GRANT TEMPORARY ON DATABASE ${OWNED_DB} TO ${PG_ROLES.BACKUP_READER};`, controlDbName);
 try {
  const withTemp = createPgPool(ownedConfig({ user: PG_ROLES.BACKUP_READER, role: PG_ROLES.BACKUP_READER, roleSchemas: [] }));
  await assert.rejects(withTemp.connect(), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'database-temp-privilege', 'backup_reader must not serve with TEMP granted');
  await withTemp.end();
 } finally {
  await adminQuery(`REVOKE TEMPORARY ON DATABASE ${OWNED_DB} FROM ${PG_ROLES.BACKUP_READER};`, controlDbName);
 }
 const dumps = createPgPool(ownedConfig({ user: PG_ROLES.BACKUP_READER, role: PG_ROLES.BACKUP_READER, roleSchemas: [] }));
 assert.equal((await dumps.query('SELECT current_user AS who')).rows[0].who, PG_ROLES.BACKUP_READER, 'backup_reader passes with TEMP false');
 await dumps.end();
 // 3) missing USAGE grant is refused at checkout
 const auditless = createPgPool(ownedConfig({ user: PG_ROLES.CORE_RUNTIME, role: PG_ROLES.CORE_RUNTIME, roleSchemas: ['meta', 'audit'] }));
 await assert.rejects(auditless.connect(), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'usage-grant-missing' && e.detail.schema === 'audit', 'missing audit USAGE must be refused at checkout');
 await auditless.end();
 // 4) P1 provisioning shape: a granted cross-runtime membership (would allow
 //    later SET ROLE elevation) fails the checkout guard, and the guarded
 //    transaction never reaches the table
 await grantMembership(PG_ROLES.API_RUNTIME, PG_ROLES.WORKER_RUNTIME);
 try {
  const elevated = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta'] }));
  await assert.rejects(elevated.connect(), (e) => e.code === 'ROLE_MISMATCH' && e.detail.reason === 'cross-role-membership' && e.detail.role === PG_ROLES.WORKER_RUNTIME, 'granted worker membership must be refused at checkout');
  await elevated.end();
  const writer = createPgPool(ownedConfig({ user: PG_ROLES.WORKER_RUNTIME, role: PG_ROLES.WORKER_RUNTIME, roleSchemas: ['meta', 'audit'] }));
  await assert.rejects(writer.withTransaction(async (tx) => { await tx.query('INSERT INTO economy.wallets VALUES ($1, 10)', ['ghost']); }), code('ROLE_MISMATCH'));
  await writer.end();
  const probe = createPgPool(ownedConfig({ user: PG_ROLES.CORE_RUNTIME, role: PG_ROLES.CORE_RUNTIME, roleSchemas: ['meta', 'identity', 'economy', 'ops'] }));
  const counted = await probe.query('SELECT count(*)::int AS n FROM economy.wallets WHERE actor_id = $1', ['ghost']);
  assert.equal(counted.rows[0].n, 0, 'no row may be written when the role guard fires');
  await probe.end();
 } finally {
  await revokeMembership(PG_ROLES.API_RUNTIME, PG_ROLES.WORKER_RUNTIME);
 }
});

test('pool caps queue and throttle deterministically past max', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({
  user: PG_ROLES.CORE_RUNTIME, role: PG_ROLES.CORE_RUNTIME, roleSchemas: ['meta'],
  pool: { max: 1, queueLimit: 1, connectionTimeoutMillis: 1200, idleTimeoutMillis: 1000 },
 }));
 const holder = await pool.connect();
 const queued = pool.connect(); // fills the single queue slot
 await assert.rejects(pool.connect(), code('POOL_QUEUE_LIMIT'), 'requests beyond max+queueLimit fail fast');
 const started = Date.now();
 await assert.rejects(queued, code('POOL_ACQUIRE_TIMEOUT'), 'the queued request times out while the sole slot is held');
 assert.ok(Date.now() - started >= 1000, 'the acquire timeout is honoured, not skipped');
 await holder.release();
 const freed = await pool.connect(); // deterministic: the slot returned
 assert.equal(typeof freed.client.query, 'function');
 await freed.release();
 await pool.end();
});

test('release sanitizes SET ROLE and SET drift back to the pinned session', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({
  user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta', 'identity'],
  // max 1 + long idle: the reacquire MUST be the SAME physical backend, so a
  // silently failing sanitize (destroy+reconnect churn) cannot hide behind a
  // fresh connection; 0-destroy is part of the contract.
  pool: { max: 1, idleTimeoutMillis: 60000, connectionTimeoutMillis: 15000 },
 }));
 const first = await pool.connect(); // clean checkout BEFORE the single-test edge exists
 const pid1 = (await first.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await grantMembership(PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME); // revoked below and in after()
 try {
  await first.client.query(`SET ROLE ${PG_ROLES.CORE_RUNTIME}`);
  await first.client.query('SET statement_timeout = 9000');
  await first.client.query('SET search_path TO public');
  await first.release();
  await revokeMembership(PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME);
  const second = await pool.connect(); // throws if the tainted session survived
  try {
   const pid2 = await second.client.query('SELECT pg_backend_pid() AS pid');
   assert.equal(pid2.rows[0].pid, pid1, 'a healthy release must REUSE the same backend - no hidden sanitize failure/destroy churn');
   const r = await second.client.query("SELECT current_user, session_user, current_setting('statement_timeout') AS st, current_setting('search_path') AS sp FROM pg_stat_activity WHERE pid = pg_backend_pid()");
   assert.equal(r.rows[0].current_user, 'api_runtime', 'SET ROLE must not survive a release');
   assert.equal(r.rows[0].session_user, 'api_runtime');
   assert.equal(r.rows[0].st, '5s');
   assert.equal(String(r.rows[0].sp).replace(/\s+/g, ''), SEARCH_PATH);
  } finally { await second.release(); }
 } finally {
  await revokeMembership(PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME);
  await pool.end();
 }
});

test('mid-session SET ROLE elevation is refused at transaction start', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta', 'identity'] }));
 const { client, release } = await pool.connect(); // clean checkout BEFORE the edge exists
 await grantMembership(PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME); // revoked below and in after()
 try {
  try {
   await client.query(`SET ROLE ${PG_ROLES.CORE_RUNTIME}`); // post-checkout elevation
   await assert.rejects(
    withIdempotentTransaction(client, async () => 'must-not-run', { connected: true, expectRole: PG_ROLES.API_RUNTIME }),
    (e) => e.code === 'ROLE_MISMATCH' && e.detail.current_user === PG_ROLES.CORE_RUNTIME && e.detail.phase === 'transaction-open',
    'the borrowed transaction must refuse a backend whose identity drifted after checkout',
   );
   await client.query('RESET ROLE');
   const ok = await withIdempotentTransaction(client, async (tx) => (await tx.query('SELECT 1 AS one')).rows[0].one, { connected: true, expectRole: PG_ROLES.API_RUNTIME });
   assert.equal(ok, 1, 'the same session works again once the drift is reset');
  } finally { await release(); }
 } finally {
  await revokeMembership(PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME);
  await pool.end();
 }
});

test('TLS verify-full succeeds with the explicit root CA and refuses a wrong CA', { skip: SKIP }, async (t) => {
 await schemaFixture();
 let tls;
 try {
  tls = await tlsScenario();
 } catch (error) {
  if (REQUIRED) throw error;
  return t.skip(error.message);
 }
 const pool = createPgPool(ownedConfig({
  host: tls.host, port: tls.port, label: 'staging', user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME,
  password: 'trust-ignored-locally', allowLocalNoTls: false, ssl: { caFile: tls.caFile }, roleSchemas: ['meta', 'identity'],
 }));
 try {
  const sec = await pool.query('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  assert.equal(sec.rows[0].ssl, true, 'this self-owned TLS server has no proxy: pg_stat_ssl must report ssl=true');
  assert.match(sec.rows[0].version, /^TLSv1\.[23]/);
  const { client, release } = await pool.connect();
  try {
   const stream = client.connection && client.connection.stream;
   assert.equal(stream && stream.encrypted, true, 'the client socket is actually encrypted');
   assert.equal(stream && stream.authorized, true, 'the client socket verified the server certificate');
  } finally { await release(); }
 } finally { await pool.end(); }
 // wrong anchor: the same target with an unrelated CA must not connect
 const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-xo-pg-badca-'));
 const foreign = makeCerts(foreignDir).caCert;
 const badCa = createPgPool(ownedConfig({
  host: tls.host, port: tls.port, label: 'staging', user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME,
  password: 'x', allowLocalNoTls: false, ssl: { caFile: foreign }, roleSchemas: ['meta'],
 }));
 try {
  await assert.rejects(async () => {
   const connected = await badCa.connect();
   await connected.release();
  }, (e) => e.code === 'TLS_VERIFICATION_FAILED');
 } finally {
  await badCa.end();
  fs.rmSync(foreignDir, { recursive: true, force: true });
 }
});

test('staging pool refuses production-patterned credentials and vice versa against the live target', { skip: SKIP }, async () => {
 await schemaFixture();
 assert.throws(() => createPgPool(ownedConfig({ label: 'production', ssl: { ca: CA_TEXT }, password: 'p'.repeat(12), neonProjectHint: 'megaxo-v5-staging', allowLocalNoTls: false })), code('ENVIRONMENT_MISMATCH'));
 assert.throws(() => createPgPool(ownedConfig({ database: PROD_PROBE_DB, label: 'staging', password: 'p'.repeat(12), neonProjectHint: 'megaxo-v5-staging' })), (e) => e.code === 'ENVIRONMENT_MISMATCH' || e.code === 'ENVIRONMENT_AMBIGUOUS');
 const ok = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta', 'identity'] }));
 assert.equal((await ok.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the correctly labelled pool still reaches the owned database');
 await ok.end();
});

test('withIdempotentTransaction commits, rolls back, borrows nested scopes and replays keys', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({ user: PG_ROLES.CORE_RUNTIME, role: PG_ROLES.CORE_RUNTIME, roleSchemas: ['meta', 'economy', 'ops'] }));
 const coins = async (id) => {
  const r = await pool.query('SELECT coins FROM economy.wallets WHERE actor_id = $1', [id]);
  return r.rows[0] ? Number(r.rows[0].coins) : undefined;
 };
 await pool.withTransaction(async (tx) => { await tx.query('INSERT INTO economy.wallets VALUES ($1, 100)', ['alice']); });
 assert.equal(await coins('alice'), 100);

 await assert.rejects(pool.withTransaction(async (tx) => {
  await tx.query('INSERT INTO economy.wallets VALUES ($1, 5)', ['bob']);
  throw new Error('business failure');
 }), /business failure/);
 assert.equal(await coins('bob'), undefined, 'rollback must remove the partial write');

 // nested borrow: the inner call commits nothing on its own
 await assert.rejects(pool.withTransaction(async (tx) => {
  await tx.query('INSERT INTO economy.wallets VALUES ($1, 7)', ['carol']);
  const inner = await withIdempotentTransaction(tx.client, async (itx) => {
   assert.equal(currentPgScope(tx.client).depth, 2, 'inner call must borrow the live scope');
   await itx.query('INSERT INTO economy.wallets VALUES ($1, 9)', ['dave']);
   return 'inner';
  });
  assert.equal(inner, 'inner');
  throw new Error('outer fails');
 }), /outer fails/);
 assert.equal(await coins('carol'), undefined);
 assert.equal(await coins('dave'), undefined, 'inner writes roll back with the outer scope');

 // idempotent replay inside one unit of work: one key executes once
 let calls = 0;
 await pool.withTransaction(async (tx) => {
  const run = () => { calls += 1; return tx.query('INSERT INTO economy.wallets VALUES ($1, 3)', ['erin']).then(() => 'done'); };
  const first = withIdempotentTransaction(tx.client, run, { key: 'cmd-1' });
  const second = withIdempotentTransaction(tx.client, run, { key: 'cmd-1' });
 assert.equal(await first, 'done');
  assert.equal(await second, 'done');
 });
 assert.equal(calls, 1, 'single-flight replay inside the borrowed scope');
 assert.equal(await coins('erin'), 3);

 // repository seam outside any live scope: nothing to borrow
 const raw = await roleLogin(PG_ROLES.CORE_RUNTIME);
 assert.throws(() => requirePgScope(raw), (e) => e instanceof ContextError && e.code === 'TRANSACTION_REQUIRED');
 assert.equal(currentPgScope(raw), null);
 await withIdempotentTransaction(raw, async (tx) => { await tx.query('INSERT INTO economy.wallets VALUES ($1, 1)', ['frank']); }, { connected: true });
 assert.equal(await coins('frank'), 1);
 let ghost;
 await withIdempotentTransaction(raw, async (tx) => { ghost = tx; }, { connected: true });
 assert.throws(() => ghost.query('SELECT 1'), (e) => e instanceof ContextError && e.code === 'TRANSACTION_REQUIRED', 'a captured handle cannot write after its scope ended');
 await raw.end();
 await pool.end();
});

test('pinned server major and per-pool timeout overrides verified live', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta'], expectedServerMajor: 16, statementTimeoutMs: 4500, lockTimeoutMs: 1200, idleInTransactionTimeoutMs: 9000 }));
 const { client, release } = await pool.connect();
 try {
  const r = await client.query("SELECT setting AS v FROM pg_settings WHERE name = 'statement_timeout' UNION ALL SELECT setting FROM pg_settings WHERE name = 'lock_timeout' UNION ALL SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'");
  assert.deepEqual(r.rows.map((x) => x.v), ['4500', '1200', '9000'], 'pg_settings reports exact pinned milliseconds');
 } finally { await release(); }
 // a wrong version pin fails closed on a fresh pool against the same server
 const wrong = createPgPool(ownedConfig({ user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta'], expectedServerMajor: 15 }));
 await assert.rejects(wrong.connect(), (e) => e.code === 'PG_VERSION_MISMATCH');
 await wrong.end();
 await pool.end();
});

test('cold acquisitions cannot bypass the configured queue limit', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({
  user: PG_ROLES.CORE_RUNTIME, role: PG_ROLES.CORE_RUNTIME, roleSchemas: ['meta'],
  pool: { max: 1, queueLimit: 1, connectionTimeoutMillis: 1200, idleTimeoutMillis: 1000 },
 }));
 let holder;
 try {
  // None of the requests has finished opening or verifying a connection yet.
  const first = pool.connect();
  const second = pool.connect();
  const queuedTimeout = assert.rejects(second, code('POOL_ACQUIRE_TIMEOUT'));
  const third = pool.connect();
  const overflow = assert.rejects(third, code('POOL_QUEUE_LIMIT'));
  holder = await first;
  await overflow;
  assert.equal(pool.stats().waiting, 1, 'only the single permitted waiter reaches the driver');
  await queuedTimeout;
  await holder.release();
  holder = null;
  const resumed = await pool.connect();
  try {
   const identity = (await resumed.client.query('SELECT current_user, session_user')).rows[0];
   assert.equal(identity.current_user, PG_ROLES.CORE_RUNTIME);
   assert.equal(identity.session_user, PG_ROLES.CORE_RUNTIME);
  } finally { await resumed.release(); }
 } finally {
  if (holder) await holder.release();
  await pool.end();
 }
});

test('plain pool queries enforce their timeout even after a reused session disables it', { skip: SKIP }, async () => {
 await schemaFixture();
 const pool = createPgPool(ownedConfig({
  user: PG_ROLES.API_RUNTIME, role: PG_ROLES.API_RUNTIME, roleSchemas: ['meta'],
  statementTimeoutMs: 100,
  sanitizeOnRelease: false,
  pool: { max: 1, idleTimeoutMillis: 60000 },
 }));
 try {
  const borrowed = await pool.connect();
  let backend;
  try {
   backend = (await borrowed.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await borrowed.client.query('SET statement_timeout = 0');
  } finally { await borrowed.release(); }
  await assert.rejects(pool.query('SELECT pg_catalog.pg_sleep(0.2)'), (error) => error.code === '57014');
  const recovered = (await pool.query("SELECT pg_backend_pid() AS pid, current_setting('statement_timeout') AS timeout, current_user, session_user")).rows[0];
  assert.equal(recovered.pid, backend, 'a rolled-back timeout must not destroy a healthy connection');
  assert.equal(recovered.timeout, '100ms');
  assert.equal(recovered.current_user, PG_ROLES.API_RUNTIME);
  assert.equal(recovered.session_user, PG_ROLES.API_RUNTIME);
 } finally { await pool.end(); }
});
