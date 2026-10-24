'use strict';
/* tests/v51-v5-production-server.test.js - offline unit proof for the V5 production composition.
 *
 * SCOPE. Exercises ONLY the pure helpers exported by scripts/v51/v5-production-server.cjs. Nothing
 * here opens a socket, contacts a provider, reads a real secret, starts a server or touches the
 * production database; the module's composition is required lazily inside `main()`, so `require`
 * itself is side-effect free. Every assertion is deterministic.
 *
 * It proves the four fail-closed boundaries the production entry point depends on:
 *   1. the target-binding validator (accepts the exact production binding; refuses a wrong database,
 *      a wrong project/branch, a serving target with no authority-epoch switch, a staging binding and
 *      a malformed/missing binding),
 *   2. the namespace derivation (production and staging never collide for the same input),
 *   3. the role assertion (an api pool described as core_runtime - and the reverse - is refused),
 *   4. the outbound-policy resolver (a class the target file disables cannot be enabled).
 *
 * The bound target is the real checked-in docs/v5/environments/production.json; the credential files
 * referenced by the inventory are never opened.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../scripts/v51/v5-production-server.cjs');
const production = require('../docs/v5/environments/production.json');
const staging = require('../docs/v5/environments/staging.json');

const PROD_BINDING = 'blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production';
/* The staging convention as deployed (two-part project/database) AND the full three-part staging
 * triple; both must be refused by the production validator. */
const STAGING_BINDING = 'lively-shadow-52629967/mega_xo_v5_staging';
const STAGING_TRIPLE = `${staging.projectId}/${staging.branchId}/mega_xo_v5_staging`;

/* A structured failure carries a stable code; match it instead of the human-readable tail. */
const code = (value) => (error) => error && error.code === value;

test('binding: the exact production binding is accepted, and every drift is refused', () => {
  const bound = mod.validateProductionBinding({ binding: PROD_BINDING, target: production });
  assert.equal(bound.projectId, production.projectId);
  assert.equal(bound.branchId, production.branchId);
  assert.equal(bound.database, 'mega_xo_v5_production');
  assert.equal(bound.nonserving, true, 'the checked-in production inventory is still nonserving');
  assert.equal(bound.serving, false, 'a nonserving target is composed but never armed as the authority');
  assert.equal(bound.servingEpoch, null);

  /* A wrong database - either in the binding or in the target file - is refused. */
  assert.throws(() => mod.validateProductionBinding({
    binding: 'blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_staging', target: production,
  }), code('REFUSED_PRODUCTION_BINDING'));
  assert.throws(() => mod.validateProductionBinding({
    binding: PROD_BINDING, target: { ...production, database: 'mega_xo_v5_staging' },
  }), code('REFUSED_NON_PRODUCTION_DATABASE'));
  assert.throws(() => mod.validateProductionBinding({
    binding: 'blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production', target: { ...production, database: 'mega_xo_v5_dev' },
  }), code('REFUSED_NON_PRODUCTION_DATABASE'));

  /* A wrong project and a wrong branch are refused, in the binding and in the target alike. */
  assert.throws(() => mod.validateProductionBinding({
    binding: `lively-shadow-52629967/${production.branchId}/${production.database}`, target: production,
  }), code('REFUSED_PRODUCTION_BINDING'));
  assert.throws(() => mod.validateProductionBinding({
    binding: `blue-sun-85454968/br-other-branch/${production.database}`, target: production,
  }), code('REFUSED_PRODUCTION_BINDING'));
  assert.throws(() => mod.validateProductionBinding({
    binding: PROD_BINDING, target: { ...production, projectId: staging.projectId },
  }), code('REFUSED_PRODUCTION_TARGET_FILE'));
  assert.throws(() => mod.validateProductionBinding({
    binding: PROD_BINDING, target: { ...production, branchId: staging.branchId },
  }), code('REFUSED_PRODUCTION_TARGET_FILE'));
  assert.throws(() => mod.validateProductionBinding({
    binding: PROD_BINDING, target: { ...production, endpointId: 'ep-impostor-1' },
  }), code('REFUSED_PRODUCTION_TARGET_FILE'));
  assert.throws(() => mod.validateProductionBinding({
    binding: PROD_BINDING, target: { ...production, host: 'ep-impostor-1.c-14.us-east-1.aws.neon.tech' },
  }), code('REFUSED_PRODUCTION_TARGET_FILE'));

  /* A serving target is refused unless the separate authority-epoch switch is supplied. */
  const serving = { ...production, nonserving: false };
  assert.throws(() => mod.validateProductionBinding({ binding: PROD_BINDING, target: serving }),
    code('REFUSED_SERVING_PRODUCTION_TARGET'));
  for (const bad of ['', 'yes', 'v5:', 'v5:1:abc', 'v5:1780000000000:zz', `v5:${'1'.repeat(14)}:${'a'.repeat(16)}`, 'V5:1780000000000:abcdef0123456789']) {
    assert.throws(() => mod.validateProductionBinding({ binding: PROD_BINDING, target: serving, servingEpoch: bad }),
      code('REFUSED_SERVING_PRODUCTION_TARGET'), `epoch ${JSON.stringify(bad)} must be refused`);
  }
  /* An epoch supplied while the target is still nonserving would arm early - refused. */
  assert.throws(() => mod.validateProductionBinding({
    binding: PROD_BINDING, target: production, servingEpoch: `v5:${'1'.repeat(13)}:${'a'.repeat(16)}`,
  }), code('SERVING_EPOCH_BEFORE_CUTOVER'));
  /* The one deliberate switch: an exact epoch against an explicit serving target. */
  const armed = mod.validateProductionBinding({
    binding: PROD_BINDING, target: serving, servingEpoch: `v5:${'1'.repeat(13)}:${'a'.repeat(16)}`,
  });
  assert.equal(armed.serving, true);
  assert.equal(armed.nonserving, false);
});

test('binding: a staging target string and a malformed/missing binding are refused', () => {
  /* The staging binding names another project, another branch and another database. */
  assert.throws(() => mod.validateProductionBinding({ binding: STAGING_BINDING, target: production }),
    code('MALFORMED_PRODUCTION_BINDING'));
  assert.throws(() => mod.validateProductionBinding({ binding: STAGING_TRIPLE, target: production }),
    code('REFUSED_PRODUCTION_BINDING'));
  /* The staging INVENTORY is not the production target either. */
  assert.throws(() => mod.validateProductionBinding({ binding: STAGING_TRIPLE, target: staging }),
    code('REFUSED_PRODUCTION_TARGET_FILE'));
  assert.throws(() => mod.validateProductionBinding({ binding: PROD_BINDING, target: staging }),
    code('REFUSED_PRODUCTION_TARGET_FILE'));
  /* An enabled outbound class validates: composition (with the capability map) owns the
   * implemented-provider refusal, so a provisioned inventory can boot (LR10 production fix). */
  const enabling = mod.validateProductionBinding({
    binding: PROD_BINDING, target: { ...production, outbound: { ...production.outbound, adRewards: 'enabled' } },
  });
  assert.equal(enabling.outbound.adRewards, 'enabled');

  for (const bad of [undefined, null, '', 0, {}, [], `${production.projectId}/${production.branchId}`,
    `${production.projectId}/${production.branchId}/${production.database}/extra`,
    `/${production.branchId}/${production.database}`, `${production.projectId}//${production.database}`,
    `${production.projectId}/${production.branchId}/mega_xo_v5_ production`,
    `${production.projectId}/${production.branchId}/${'x'.repeat(65)}`]) {
    assert.throws(() => mod.parseProductionBinding(bad), (error) => ['PRODUCTION_BINDING_REQUIRED', 'MALFORMED_PRODUCTION_BINDING'].includes(error.code),
      `binding ${JSON.stringify(bad)} must not parse`);
  }
  assert.throws(() => mod.validateProductionBinding({ binding: undefined, target: production }),
    (error) => ['PRODUCTION_BINDING_REQUIRED', 'MALFORMED_PRODUCTION_BINDING'].includes(error.code));
  /* A missing/!object inventory is refused even with a perfect binding. */
  assert.throws(() => mod.validateProductionBinding({ binding: PROD_BINDING, target: null }),
    code('REFUSED_PRODUCTION_TARGET_FILE'));
  assert.throws(() => mod.validateProductionBinding({ binding: PROD_BINDING, target: { ...production, nonserving: 'true' } }),
    code('REFUSED_NONSERVING_FLAG_INVALID'));
});

test('namespace: production and staging never share a keyspace for the same input', () => {
  const prod = mod.deriveNamespace('production', PROD_BINDING);
  const stage = mod.deriveNamespace('staging', PROD_BINDING);
  assert.equal(prod.environment, 'prd');
  assert.equal(stage.environment, 'stg');
  assert.equal(prod.prefix, `mx:prd:${prod.keyVersion}:`);
  assert.notEqual(prod.keyVersion, stage.keyVersion, 'the same input must not derive one shared namespace');
  assert.notEqual(prod.prefix, stage.prefix);
  assert.equal(prod.prefix.startsWith('mx:stg:'), false);
  /* The adapter accepts only `[a-z0-9]{1,8}` and a production process must not be able to name the
   * staging namespace even when handed the staging binding. */
  assert.match(prod.keyVersion, /^[a-z0-9]{1,8}$/);
  assert.match(stage.keyVersion, /^[a-z0-9]{1,8}$/);
  assert.equal(mod.deriveNamespace('production', STAGING_BINDING).environment, 'prd');
  assert.notEqual(mod.deriveNamespace('production', STAGING_BINDING).keyVersion, stage.keyVersion);
  /* Deterministic: the same input always derives the same namespace. */
  assert.equal(prod.keyVersion, mod.deriveNamespace('production', PROD_BINDING).keyVersion);
  assert.throws(() => mod.deriveNamespace('test', PROD_BINDING), code('NAMESPACE_ENVIRONMENT_INVALID'));
  assert.throws(() => mod.deriveNamespace('production', ''), code('PRODUCTION_BINDING_REQUIRED'));
});

test('roles: a pool whose described role is not the expected one is refused in BOTH directions', () => {
  const api = { describe: () => ({ role: 'api_runtime', applicationName: 'api_runtime/v5/rev' }) };
  const core = { describe: () => ({ role: 'core_runtime', applicationName: 'core_runtime/v5/rev' }) };
  const worker = { describe: () => ({ role: 'worker_runtime', applicationName: 'worker_runtime/v5/rev' }) };

  assert.equal(mod.assertPoolRole(api, 'api_runtime', 'api').role, 'api_runtime');
  assert.throws(() => mod.assertPoolRole(core, 'api_runtime', 'api'), code('POOL_ROLE_MISMATCH'));
  assert.throws(() => mod.assertPoolRole(api, 'core_runtime', 'core'), code('POOL_ROLE_MISMATCH'));
  assert.throws(() => mod.assertPoolRole(worker, 'core_runtime', 'core'), code('POOL_ROLE_MISMATCH'));
  assert.throws(() => mod.assertPoolRole(null, 'api_runtime', 'api'), code('POOL_ROLE_MISMATCH'));
  assert.throws(() => mod.assertPoolRole({}, 'api_runtime', 'api'), code('POOL_ROLE_MISMATCH'));

  const separation = mod.assertRoleSeparation({ api, core, worker });
  assert.deepEqual(Object.keys(separation).sort(), ['api', 'core', 'worker']);
  assert.equal(separation.api.role, 'api_runtime');
  assert.equal(separation.core.role, 'core_runtime');
  assert.equal(separation.worker.role, 'worker_runtime');
  /* Two pools of the same role can never stand in for the required three-way separation. */
  assert.throws(() => mod.assertRoleSeparation({ api, core: api, worker }), code('POOL_ROLE_MISMATCH'));
  assert.throws(() => mod.assertRoleSeparation({ api: core, core: api, worker }), code('POOL_ROLE_MISMATCH'));
  assert.throws(() => mod.assertRoleSeparation({ api, core, worker: core }), code('POOL_ROLE_MISMATCH'));

  /* The API process holds NO Core pool and no Core service: it reaches Core over the signed ingress. */
  assert.equal(mod.assertApiCompositionHoldsNoCoreAccess({ pool: api }).role, 'api_runtime');
  for (const key of ['corePool', 'coreService', 'leaderboardPool', 'workerPool', 'privacyPool', 'coreClient']) {
    assert.throws(() => mod.assertApiCompositionHoldsNoCoreAccess({ pool: api, [key]: core }),
      code('API_HOLDS_CORE_POOL'), `an API context carrying ${key} must be refused`);
  }
  assert.throws(() => mod.assertApiCompositionHoldsNoCoreAccess({ pool: core }), code('POOL_ROLE_MISMATCH'));
  assert.throws(() => mod.assertApiCompositionHoldsNoCoreAccess(null), code('API_CONTEXT_REQUIRED'));

  /* The mirror proof: the Core composition keeps Core, queue, leaderboard and realtime on the
   * `core_runtime` pool, and the ticket issuer - the ONE API-owned member - is asserted as such. */
  assert.equal(mod.assertCoreCompositionUsesCorePool({
    corePool: core, queuePool: core, leaderboardPool: core, ticketIssuerPool: api, apiPool: api,
  }).role, 'core_runtime');
  assert.throws(() => mod.assertCoreCompositionUsesCorePool({
    corePool: api, queuePool: core, leaderboardPool: core, ticketIssuerPool: api, apiPool: api,
  }), code('POOL_ROLE_MISMATCH'), 'the Core service must not run on the API pool');
  assert.throws(() => mod.assertCoreCompositionUsesCorePool({
    corePool: core, queuePool: api, leaderboardPool: core, ticketIssuerPool: api, apiPool: api,
  }), code('POOL_ROLE_MISMATCH'), 'the Core-owned queue must not run on the API pool');
  assert.throws(() => mod.assertCoreCompositionUsesCorePool({
    corePool: core, queuePool: core, leaderboardPool: api, ticketIssuerPool: api, apiPool: api,
  }), code('POOL_ROLE_MISMATCH'), 'the leaderboard materializer must not run on the API pool');
  assert.throws(() => mod.assertCoreCompositionUsesCorePool({
    corePool: core, queuePool: core, leaderboardPool: core, ticketIssuerPool: core, apiPool: api,
  }), code('POOL_ROLE_MISMATCH'), 'the ticket issuer is API-owned and must be asserted as API');
  assert.throws(() => mod.assertCoreCompositionUsesCorePool({
    corePool: core, queuePool: core, leaderboardPool: core, ticketIssuerPool: api, apiPool: core,
  }), code('POOL_ROLE_MISMATCH'));

  /* The pool budget is read from the inventory's per-role limits, never invented. */
  const resolved = mod.resolveConnectionBudget(production);
  assert.deepEqual(resolved.budget.roleConnections, {
    api_runtime: production.roleConnectionLimits.api_runtime,
    core_runtime: production.roleConnectionLimits.core_runtime,
    worker_runtime: production.roleConnectionLimits.worker_runtime,
  });
  assert.equal(resolved.budget.totalConnections,
    production.roleConnectionLimits.api_runtime + production.roleConnectionLimits.core_runtime
    + production.roleConnectionLimits.worker_runtime);
  assert.throws(() => mod.resolveConnectionBudget(production, { api: 99, core: 1, worker: 1 }),
    code('POOL_MAX_EXCEEDS_ROLE_LIMIT'));
  assert.throws(() => mod.resolveConnectionBudget({ roleConnectionLimits: { api_runtime: 4 } }),
    code('INVENTORY_ROLE_LIMITS_INVALID'));
});

test('outbound: a class the target file disables cannot be enabled, for all three classes', async () => {
  /* The checked-in production inventory disables every outbound provider class right now. */
  const resolved = mod.resolveOutboundPolicy(production);
  assert.deepEqual(resolved, { email: 'disabled', storeNotifications: 'disabled', adRewards: 'disabled' });
  for (const klass of mod.OUTBOUND_CLASSES) {
    assert.throws(() => mod.resolveOutboundPolicy(production, { [klass]: 'enabled' }),
      code('OUTBOUND_CLASS_DISABLED_BY_TARGET'), `${klass} must not be enableable by a flag`);
  }
  assert.throws(() => mod.resolveOutboundPolicy(production, { all: 'enabled' }), code('OUTBOUND_CLASS_UNKNOWN'));
  assert.throws(() => mod.resolveOutboundPolicy(production, { email: 'maybe' }), code('OUTBOUND_REQUEST_INVALID'));
  assert.throws(() => mod.resolveOutboundPolicy({ ...production, outbound: undefined }), code('OUTBOUND_DECLARATION_INVALID'));
  assert.throws(() => mod.resolveOutboundPolicy({ ...production, outbound: { ...production.outbound, email: 'on' } }),
    code('OUTBOUND_DECLARATION_INVALID'));
  /* Explicitly requesting the declared state is a no-op, not an escalation. */
  assert.deepEqual(mod.resolveOutboundPolicy(production, { email: 'disabled' }), resolved);
  /* Only an inventory that itself enables a class can yield an enabled policy for it - a request can
   * never flip it, it can only confirm the declaration. */
  const enabling = { ...production, outbound: { ...production.outbound, storeNotifications: 'enabled' } };
  assert.equal(mod.resolveOutboundPolicy(enabling, { storeNotifications: 'enabled' }).storeNotifications, 'enabled');
  assert.equal(mod.resolveOutboundPolicy(enabling).storeNotifications, 'enabled', 'the declaration alone decides');
  assert.throws(() => mod.resolveOutboundPolicy(enabling, { storeNotifications: 'disabled' }),
    code('OUTBOUND_REQUEST_INVALID'), 'a declared-enabled class is not disarmed by a request either');

  /* The composed mail transport defers while the target disables email and throws on every attempt. */
  const transport = mod.createMailTransportForPolicy(resolved);
  assert.equal(transport.enabled(), false);
  for (const method of ['sendOtp', 'sendPasswordChanged', 'sendSecurityNotice', 'sendMail']) {
    assert.throws(() => transport[method]({}), code('OUTBOUND_DISABLED_BY_TARGET'));
  }
  /* LR10: email ENABLED is legal now, but only with the Resend key in the approved channel. */
  assert.throws(() => mod.createMailTransportForPolicy({ ...resolved, email: 'enabled' }),
    code('OUTBOUND_EMAIL_KEY_REQUIRED'), 'an enabled class without its provider secret refuses');
  const live = mod.createMailTransportForPolicy({ ...resolved, email: 'enabled' },
    { resendApiKey: 're_test_key_1234567890', emailFetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(live.enabled(), true);
  await live.sendOtp({ to: 'player@example.com', code: '123456', purpose: 'signup', idempotencyKey: 'k' });

  /* This entry composes a provider ONLY for a class with a declared capability (LR10: email/resend). */
  assert.deepEqual(mod.assertProviderClassesComposable(resolved), { composed: false, classes: resolved });
  assert.deepEqual(mod.assertProviderClassesComposable({ ...resolved, email: 'enabled' }, { email: 'resend' }),
    { composed: false, classes: { ...resolved, email: 'enabled' } });
  assert.throws(() => mod.assertProviderClassesComposable(mod.resolveOutboundPolicy(enabling, { storeNotifications: 'enabled' })),
    code('OUTBOUND_CLASS_UNIMPLEMENTED'));
  assert.throws(() => mod.assertProviderClassesComposable({ email: 'enabled', storeNotifications: 'disabled', adRewards: 'disabled' }),
    code('OUTBOUND_CLASS_UNIMPLEMENTED'));
  assert.throws(() => mod.assertProviderClassesComposable(null), code('OUTBOUND_POLICY_REQUIRED'));
});

test('bind: the production HTTP pattern is loopback only on the MEGA_HTTP_PORT default', () => {
  assert.deepEqual(mod.resolveHttpBinding({}), { host: '127.0.0.1', port: mod.DEFAULT_HTTP_PORT });
  assert.equal(mod.resolveHttpBinding({ port: '8081' }).port, 8081);
  for (const host of ['0.0.0.0', '::', '10.0.0.5', '100.64.128.46', 'example.com']) {
    assert.throws(() => mod.resolveHttpBinding({ host }), code('REFUSED_NON_LOOPBACK_BIND'), `${host} must be refused`);
  }
  for (const port of ['0', '80', '443', '1023', 'abc', '70000', 1.5]) {
    assert.throws(() => mod.resolveHttpBinding({ port }), (error) => ['HTTP_PORT_INVALID', 'REFUSED_RESERVED_HTTP_PORT'].includes(error.code),
      `port ${port} must be refused`);
  }
  assert.equal(mod.resolveHttpBinding({ port: '1024' }).port, 1024);
  assert.deepEqual(mod.resolveHttpBinding({ host: '172.18.0.1', port: '8080', allowPrivate: true }), { host: '172.18.0.1', port: 8080 });
  assert.throws(() => mod.resolveHttpBinding({ host: '0.0.0.0', port: '8080', allowPrivate: true }), code('REFUSED_NON_LOOPBACK_BIND'));
  assert.throws(() => mod.resolveHttpBinding({ host: '100.64.128.46', port: '8080', allowPrivate: true }), code('REFUSED_NON_LOOPBACK_BIND'));
});

test('secrets: private material is read only from absolute, non-symlinked, mode-0600 regular files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-prod-secret-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const privateFile = path.join(dir, 'private.json');
  fs.writeFileSync(privateFile, '{"ok":true}', { mode: 0o600 });
  assert.equal(mod.readSecretFile(privateFile, { label: 'test' }), '{"ok":true}');

  const worldReadable = path.join(dir, 'world.json');
  fs.writeFileSync(worldReadable, '{"ok":true}', { mode: 0o644 });
  fs.chmodSync(worldReadable, 0o644);
  assert.throws(() => mod.readSecretFile(worldReadable, { label: 'test' }), code('SECRET_FILE_NOT_PRIVATE'));

  const link = path.join(dir, 'link.json');
  fs.symlinkSync(privateFile, link);
  assert.throws(() => mod.readSecretFile(link, { label: 'test' }), code('SECRET_FILE_UNSAFE'));
  assert.throws(() => mod.readSecretFile('relative.json', { label: 'test' }), code('SECRET_PATH_REQUIRED'));
  assert.throws(() => mod.readSecretFile(path.join(dir, 'absent.json'), { label: 'test' }), code('SECRET_FILE_UNREADABLE'));
  assert.throws(() => mod.readSecretFile(dir, { label: 'test' }), code('SECRET_FILE_UNSAFE'));
  assert.throws(() => mod.secretPaths('relative/dir'), code('SECRETS_DIR_MUST_BE_ABSOLUTE'));

  const paths = mod.secretPaths(dir);
  assert.deepEqual(Object.keys(paths).sort(), ['apkDownloads', 'ca', 'credentials', 'gateway', 'keys', 'otp', 'proxy', 'runtimeRoles']);
  for (const file of Object.values(paths)) assert.ok(path.isAbsolute(file) && file.startsWith(dir + path.sep));

  /* A stable secret is minted once (0600) and reused, so a restart never invalidates a code. */
  const first = mod.loadStableSecret(paths.otp, 'PRODUCTION_OTP_SECRET');
  assert.equal(first.length, 64);
  assert.equal(mod.loadStableSecret(paths.otp, 'PRODUCTION_OTP_SECRET'), first);
  assert.equal(fs.statSync(paths.otp).mode & 0o777, 0o600);
  const anonymousKey = mod.loadStableSecret(paths.apkDownloads, 'PRODUCTION_APK_DOWNLOAD_SECRET');
  assert.equal(anonymousKey.length, 64);
  assert.notEqual(anonymousKey, first, 'analytics and OTP must never share a secret');
  assert.equal(mod.loadStableSecret(paths.apkDownloads, 'PRODUCTION_APK_DOWNLOAD_SECRET'), anonymousKey);
  assert.equal(fs.statSync(paths.apkDownloads).mode & 0o777, 0o600);
  /* Each generated-once secret is purpose-scoped; analytics adds its own private key. */
  assert.deepEqual(Object.values(mod.SECRET_FILES).sort(),
    ['apk-download.secret', 'ca.pem', 'core-gateway.secret', 'credentials.json', 'keys.sealed.json', 'otp.secret', 'proxy.secret', 'runtime-roles.json']);
  /* A too-short existing secret is refused rather than silently accepted. */
  const short = path.join(dir, 'short.secret');
  fs.writeFileSync(short, 'abc\n', { mode: 0o600 });
  assert.throws(() => mod.loadStableSecret(short, 'PRODUCTION_OTP_SECRET'), code('PRODUCTION_OTP_SECRET_TOO_SHORT'));
});

test('surface: /livez and /readyz keep the API-handler semantics the deploy tooling expects', () => {
  /* The health monitor and the deploy tooling probe these three exact paths; they must reach the API
   * handler (which answers 200 {"status":"ok","live":true,"ready":true} / 503 degraded), never a 404
   * from the static bundle. */
  for (const pathname of ['/livez', '/readyz', '/health']) {
    assert.equal(mod.classifyPath(pathname), 'api', `${pathname} must be served by the API handler`);
  }
  assert.equal(mod.classifyPath('/api/v1/queue'), 'api');
  assert.equal(mod.classifyPath('/auth/callback/google'), 'api');
  assert.equal(mod.classifyPath('/.well-known/assetlinks.json'), 'api');
  assert.equal(mod.classifyPath('/ingress/command'), 'ingress');
  assert.equal(mod.classifyPath('/ingress/queue/join'), 'ingress');
  assert.equal(mod.classifyPath('/realtime/v1/snapshot'), 'realtime');
  assert.equal(mod.classifyPath('/realtime/v1/match/m1'), 'realtime');
  assert.equal(mod.classifyPath('/'), 'static');
  assert.equal(mod.classifyPath('/legacy-game/src/game.js'), 'static');
  assert.equal(mod.classifyPath('/livez/'), 'static', 'only the exact health paths are API routes');
  assert.equal(mod.classifyPath('/opsz'), 'ops', 'the operations-health probe is its own surface');
  assert.equal(mod.classifyPath('/opsz/'), 'static', 'only the exact ops path is the probe');
  assert.throws(() => mod.classifyPath(''), code('PATH_REQUIRED'));
});

test('ops: /opsz fails on a stale/missing backup and on dead letters, and never reports liveness-only green', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-ops-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const freshnessFile = path.join(dir, 'freshness-state.json');
  const observationFile = path.join(dir, 'worker-observation.json');
  const writeObservation = (dlq, backlog) => fs.writeFileSync(observationFile, JSON.stringify({
    at: nowMs, dlq, backlog, source: 'worker-tick',
  }));
  const nowMs = Date.UTC(2026, 9, 15, 4, 30, 0);
  const now = () => nowMs;

  /* Fresh backup, empty queue -> ok. */
  fs.writeFileSync(freshnessFile, JSON.stringify({ state: 'fresh', checkedAtUtc: new Date(nowMs - 60_000).toISOString() }));
  writeObservation(0, 3);
  let report = await mod.buildOpsReport({ freshnessFile, observationFile, now });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.backup.fresh, true);
  assert.equal(report.worker.dlq, 0);

  /* Missing report is never green. */
  fs.rmSync(freshnessFile);
  report = await mod.buildOpsReport({ freshnessFile, observationFile, now });
  assert.equal(report.ok, false);
  assert.equal(report.backup.fresh, false);
  assert.ok(report.failures.some((f) => f.includes('missing')));

  /* A stale declared state is red even when the file was just written. */
  fs.writeFileSync(freshnessFile, JSON.stringify({ state: 'stale', checkedAtUtc: new Date(nowMs).toISOString() }));
  report = await mod.buildOpsReport({ freshnessFile, observationFile, now });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('stale')));

  /* A fresh-but-ancient report is red: the budget is enforced on the report age too. */
  fs.writeFileSync(freshnessFile, JSON.stringify({
    state: 'fresh', checkedAtUtc: new Date(nowMs - (mod.OPS_BACKUP_MAX_AGE_MS + 60_000)).toISOString(),
  }));
  report = await mod.buildOpsReport({ freshnessFile, observationFile, now });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('older than')));

  /* Dead letters are red; backlog beyond the budget is red. */
  fs.writeFileSync(freshnessFile, JSON.stringify({ state: 'fresh', checkedAtUtc: new Date(nowMs).toISOString() }));
  writeObservation(2, 0);
  report = await mod.buildOpsReport({ freshnessFile, observationFile, now });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('dead-lettered')));
  writeObservation(0, mod.OPS_OUTBOX_BACKLOG_MAX + 1);
  report = await mod.buildOpsReport({ freshnessFile, observationFile, now });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('backlog')));

  /* An unreadable queue is red, never silently green. */
  fs.writeFileSync(observationFile, '{broken');
  report = await mod.buildOpsReport({
    freshnessFile, observationFile, now,
  });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.includes('worker queue')));
});

test('module: requiring the entry point has no side effects and exposes no composer at import time', () => {
  /* The composition is required lazily inside main(), so the module namespace is pure data + helpers. */
  assert.equal(typeof mod.main, 'function');
  assert.equal(mod.PRODUCTION_TARGET_FILE, path.join(__dirname, '..', 'docs', 'v5', 'environments', 'production.json'));
  assert.equal(mod.PRODUCTION_BINDING, PROD_BINDING);
  assert.equal(mod.BINDING_ENV, 'MEGA_V5_PRODUCTION_SERVER');
  assert.equal(mod.SERVING_EPOCH_ENV, 'MEGA_V5_PRODUCTION_SERVE');
  assert.equal(mod.HTTP_PORT_ENV, 'MEGA_HTTP_PORT');
  assert.equal(mod.DEFAULT_HTTP_PORT, 8080);
  /* The production prefix is distinct from the staging one, so the two processes cannot be started by
   * the same variable. */
  for (const key of [mod.BINDING_ENV, mod.SERVING_EPOCH_ENV, mod.REDIS_CREDENTIALS_ENV]) {
    assert.ok(key.startsWith('MEGA_V5_PRODUCTION_'), `${key} must be namespaced to production`);
    assert.equal(key.startsWith('MEGA_V51_'), false);
  }
});

test('headers: route-aware crawl policy mirrors the bundle manifest (LR04)', () => {
  const seo = { metadata: {
    '/': { indexable: true, robots: 'index, follow, max-image-preview:large', canonical: 'https://megaxo.online/' },
    '/about': { indexable: true, robots: 'index, follow, max-image-preview:large', canonical: 'https://megaxo.online/about' },
    '/game': { indexable: false, robots: 'noindex, follow', canonical: 'https://megaxo.online/game' },
    '/privacy': { indexable: true, robots: 'index, follow, max-image-preview:large', canonical: 'https://megaxo.online/privacy' },
  } };
  /* Public pages are released from the blanket noindex with the manifest robots value. */
  assert.equal(mod.robotsHeaderFor({ pathname: '/', status: 200, seo }), 'index, follow, max-image-preview:large');
  assert.equal(mod.robotsHeaderFor({ pathname: '/about/', status: 200, seo }), 'index, follow, max-image-preview:large');
  /* Private game-shell routes, unknown assets, errors and missing metadata keep the blanket noindex. */
  assert.equal(mod.robotsHeaderFor({ pathname: '/game', status: 200, seo }), mod.DEFAULT_ROBOTS_HEADER);
  assert.equal(mod.robotsHeaderFor({ pathname: '/assets/art/mark.webp', status: 200, seo }), mod.DEFAULT_ROBOTS_HEADER);
  assert.equal(mod.robotsHeaderFor({ pathname: '/about', status: 404, seo }), mod.DEFAULT_ROBOTS_HEADER);
  assert.equal(mod.robotsHeaderFor({ pathname: '/about', status: 200, seo: null }), mod.DEFAULT_ROBOTS_HEADER);
  assert.equal(mod.robotsHeaderFor({ pathname: '/about', status: 200 }), mod.DEFAULT_ROBOTS_HEADER);
  /* Legal files keep the canonical Link header their alias route declares. */
  assert.equal(mod.legalCanonicalLink({ pathname: '/legal/privacy.html', seo }), '<https://megaxo.online/privacy>; rel="canonical"');
  assert.equal(mod.legalCanonicalLink({ pathname: '/game', seo }), null);
  assert.equal(mod.legalCanonicalLink({ pathname: '/legal/unknown-name.html', seo }), null);
  /* The production entry reuses the preview CSP string instead of carrying a third copy. */
  const { CSP } = require('../scripts/p21/serve-web.js');
  assert.match(CSP, /default-src 'self'/);
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'v51', 'v5-production-server.cjs'), 'utf8');
  assert.match(serverSource, /Content-Security-Policy', CSP\)/, 'production handler applies the shared CSP');
  assert.match(serverSource, /robotsHeaderFor\(\{ pathname, status: resolved\.status/, 'static responses use the route-aware policy');
});

test('loadWebArtifact: carries manifest seo metadata for the crawl policy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-web-artifact-'));
  try {
    fs.writeFileSync(path.join(dir, 'web-build.manifest.json'), JSON.stringify({
      generator: 'scripts/p21/build-web.js',
      files: [{ path: 'index.html' }],
      routes: { '/': 'index.html' },
      seo: { metadata: { '/': { indexable: true, robots: 'index, follow', canonical: 'https://megaxo.online/' } } },
    }));
    const artifact = mod.loadWebArtifact(dir);
    assert.equal(artifact.seo.metadata['/'].indexable, true);
    assert.equal(mod.robotsHeaderFor({ pathname: '/', status: 200, seo: artifact.seo }), 'index, follow');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
