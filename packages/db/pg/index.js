/* packages/db/pg - V5-02-04 PostgreSQL connection and environment guards.
 *
 * Public surface (consumed by P04 repositories and the P02 migration CLI):
 *
 *   createPgPool(config)                 fail-closed guarded pool; validates
 *                                        host/DB/user/role/service/revision/label,
 *                                        TLS verify-full with an explicit root CA,
 *                                        numeric pool bounds and the cross-role
 *                                        connection budget BEFORE any connect.
 *   fromEnvironment(env, overrides)      builds a config from the MEGA_* contract:
 *                                        MEGA_PG_URL | MEGA_PG_HOST/_PORT/_DATABASE/
 *                                        _USER/_PASSWORD, MEGA_ENV_LABEL,
 *                                        MEGA_NEON_PROJECT, MEGA_PG_ROLE,
 *                                        MEGA_SERVICE, MEGA_RELEASE_REVISION,
 *                                        MEGA_PG_SSL_CA/_SSL_ROOTCERT,
 *                                        MEGA_PG_STATEMENT_TIMEOUT_MS,
 *                                        MEGA_PG_LOCK_TIMEOUT_MS,
 *                                        MEGA_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS,
 *                                        MEGA_PG_MAX, MEGA_PG_IDLE_TIMEOUT_MS,
 *                                        MEGA_PG_CONNECT_TIMEOUT_MS,
 *                                        MEGA_PG_QUEUE_LIMIT,
 *                                        MEGA_PG_POOL_BUDGET_TOTAL,
 *                                        MEGA_PG_POOL_BUDGET_ROLES,
 *                                        MEGA_PG_EXPECTED_MAJOR (pin: 16),
 *                                        MEGA_PG_ALLOW_LOCAL_NO_TLS (loopback
 *                                        dev/test only), SSL_CERT_FILE fallback.
 *   assertSessionRole(client, role, o)   current_user AND session_user equality,
 *                                        has_schema_privilege grant sanity, pinned
 *                                        server major; ROLE_MISMATCH fail-closed.
 *   verifySession(client, expectations)  role guard + pinned-GUC drift check
 *                                        (application_name '<role>/<service>/
 *                                        <revision>', search_path 'pg_catalog,none',
 *                                        statement/lock/idle-in-transaction timeouts).
 *   withIdempotentTransaction(client, fn, {key?, now?, connected?})
 *                                        P01 borrow-only-when-active UoW for pg
 *                                        clients; shares ContextError vocabulary
 *                                        with packages/db/context.js.
 *   requirePgScope(client)               repository seam: throws
 *                                        ContextError('TRANSACTION_REQUIRED')
 *                                        outside a live scope.
 *   currentPgScope(client), poolBudgetSnapshot(target?), buildApplicationName,
 *   classifyHint, extractNeonHint, assertEnvironmentCoherence, assertTlsConfig,
 *   PgGuardError, PG_ROLES, ROLE_GRANT_SCHEMAS, ENVIRONMENT_LABELS, BOUNDS,
 *   SEARCH_PATH.
 *
 * Pool mode contract (host-normalization-detected; describe().mode reports
 * it): DIRECT - startup '-c' session pin, public connect() session lease,
 * standalone DISCARD-ALL + re-pin sanitize on release. POOLED (Neon '-pooler'
 * endpoint; startup options are refused there, documented 08P01) - public
 * connect() throws POOLED_SESSION_UNSUPPORTED before any borrow because a raw
 * session lease is unsound under transaction pooling; the only app path is
 * withTransaction()/query() (query is routed through the bounded transaction
 * so the pinned timers always apply), checkout verifies everything except
 * search_path, and inside BEGIN all five identity GUCs are pinned
 * transaction-locally via pg_catalog.set_config(..., true) and fully
 * verified before any application query; release issues no DISCARD/session
 * SETs - the same backend is not guaranteed post-COMMIT and the pooler owns
 * server reset.
 *
 * Error contract: every PgGuardError message is the bare CODE (like the
 * packages/contracts errors); diagnostics live in `.detail`/`.cause` and never
 * carry password or full connection-string material.
 */
'use strict';
const guards = require('./guards');
const pool = require('./pool');
const { ContextError } = require('../context');

module.exports = {
 // pool + unit of work
 createPgPool: pool.createPgPool,
 fromEnvironment: pool.fromEnvironment,
 withIdempotentTransaction: pool.withIdempotentTransaction,
 currentPgScope: pool.currentPgScope,
 requirePgScope: pool.requirePgScope,
 poolBudgetSnapshot: pool.poolBudgetSnapshot,
 BOUNDS: pool.BOUNDS,
 DEFAULTS: pool.DEFAULTS,
 SEARCH_PATH: pool.SEARCH_PATH,
 // guards
 PgGuardError: guards.PgGuardError,
 PG_ROLES: guards.PG_ROLES,
 ROLE_NAMES: guards.ROLE_NAMES,
 ROLE_GRANT_SCHEMAS: guards.ROLE_GRANT_SCHEMAS,
 ENVIRONMENT_LABELS: guards.ENVIRONMENT_LABELS,
 classifyHint: guards.classifyHint,
 extractNeonHint: guards.extractNeonHint,
 isLoopbackHost: guards.isLoopbackHost,
 assertEnvironmentCoherence: guards.assertEnvironmentCoherence,
 assertTlsConfig: guards.assertTlsConfig,
 buildApplicationName: guards.buildApplicationName,
 assertSessionRole: guards.assertSessionRole,
 verifySession: guards.verifySession,
 redactUrl: guards.redactUrl,
 // explicit target inventory (chain-authoritative environment binding)
 BINDING_LABELS: guards.BINDING_LABELS,
 validateTarget: guards.validateTarget,
 loadTargetFile: guards.loadTargetFile,
 assertTargetBinding: guards.assertTargetBinding,
 targetBudgetIdentity: guards.targetBudgetIdentity,
 canonicalHost: guards.canonicalHost,
 normalizeHost: guards.normalizeHost,
 forbiddenMemberships: guards.forbiddenMemberships,
 TEMP_FORBIDDEN_ROLES: guards.TEMP_FORBIDDEN_ROLES,
 // shared SQLite-era error vocabulary (imported, never forked)
 ContextError,
};
