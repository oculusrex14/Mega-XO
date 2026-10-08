/* V5-02-04 guarded pg.Pool wrapper + the PG mirror of the P01 unit of work.
 *
 * Connection-mode contract (Neon/PgBouncer): runtime strings are TRANSACTION
 * pooled, where session-level SET/RESET does not persist across transactions
 * and consecutive statements may hit different backends. Therefore the
 * AUTHORITATIVE role/grants/GUC verification runs INSIDE the borrowed
 * transaction (BEGIN + probe + work + COMMIT on one assignment via
 * withIdempotentTransaction's expectSession); the checkout-time verifySession
 * is an additional early screen (fully authoritative for direct/session-mode
 * administrative connections). Pinned identity itself is carried by startup
 * parameters, never by session SET; release sanitization protects direct/
 * session-mode reuse, and the pooler owns server-side reset under pooling.
 *
 * createPgPool(config) is fully synchronous and connects nothing: every
 * environment/TLS/budget guard in packages/db/pg/guards.js must pass before a
 * pg.Pool object even exists. Each checkout then runs the fail-closed session
 * probe (role, grants, pinned GUCs) before the caller may issue a query, and
 * every release sanitizes the session with standalone queries (DISCARD ALL,
 * then a SET-only re-pin batch - never combined with DISCARD) or destroys the
 * connection on a real sanitize failure.
 *
 * MODE CONTRACT (host-normalization-detected, no manual switch):
 * - DIRECT (any non-pooler host): startup '-c' options channel pins the
 *   session (search_path proven to land; timeout delivery unconfirmed and
 *   never relied on), public connect() hands out a real session lease, and
 *   release sanitizes with standalone statements.
 * - POOLED (Neon pooler endpoint, first label '-pooler'): transaction
 *   pooling. The Neon pooler REFUSES startup options carrying search_path
 *   (documented 08P01 unsupported startup parameter), so NO options field is
 *   sent; public connect() refuses POOLED_SESSION_UNSUPPORTED before any
 *   borrow because a raw session lease is not sound when statements can move
 *   backends. withTransaction/query are the only app path: checkout verifies
 *   hard (role/TEMP/flags/grants/membership/version/application_name) but
 *   defers ONLY search_path, then inside BEGIN every GUC (search_path,
 *   application_name, the three timers) is pinned transaction-locally via
 *   pg_catalog.set_config(..., true) and FULLY verified before any
 *   application query. Release issues NO DISCARD/session SETs - the pooler
 *   owns server reset and the same backend cannot be guaranteed post-COMMIT.
 *
 * withIdempotentTransaction mirrors packages/db/context.js semantics for async
 * pg clients: exactly one open transaction per client, nested calls BORROW the
 * live scope and never commit independently, repository seams must
 * requirePgScope(client) (ContextError 'TRANSACTION_REQUIRED' - the shared
 * vocabulary imported from ../context.js, never forked).
 */
'use strict';
const { ContextError } = require('../context');
const {
 PgGuardError, ROLE_NAMES, ROLE_GRANT_SCHEMAS,
 assertEnvironmentCoherence, assertTlsConfig, buildApplicationName,
 extractNeonHint, redactUrl, verifySession, isPoolerHost,
 assertTargetBinding, loadTargetFile, targetBudgetIdentity,
} = require('./guards');

/* Startup-pinned search path: only pg_catalog plus the explicit `none` schema
 * resolves unqualified names, so nothing ambient (public/"$user" shadows, an
 * operator's local schema) can ever be reached without a granted, qualified
 * reference. The session probe re-checks it on every checkout. */
const SEARCH_PATH = 'pg_catalog,none';

const BOUNDS = Object.freeze({
 max: Object.freeze({ min: 1, max: 16, code: 'POOL_MAX_INVALID' }),
 idleTimeoutMillis: Object.freeze({ min: 1000, max: 1800000, code: 'POOL_IDLE_TIMEOUT_INVALID' }),
 connectionTimeoutMillis: Object.freeze({ min: 200, max: 60000, code: 'POOL_ACQUIRE_TIMEOUT_INVALID' }),
 queueLimit: Object.freeze({ min: 1, max: 512, code: 'POOL_QUEUE_LIMIT_INVALID' }),
 statementTimeoutMs: Object.freeze({ min: 100, max: 60000, code: 'STATEMENT_TIMEOUT_INVALID' }),
 lockTimeoutMs: Object.freeze({ min: 100, max: 60000, code: 'LOCK_TIMEOUT_INVALID' }),
 idleInTransactionTimeoutMs: Object.freeze({ min: 1000, max: 300000, code: 'IDLE_IN_TRANSACTION_TIMEOUT_INVALID' }),
 totalConnections: Object.freeze({ min: 1, max: 512, code: 'POOL_BUDGET_TOTAL_INVALID' }),
});
const DEFAULTS = Object.freeze({
 port: 5432,
 statementTimeoutMs: 5000,
 lockTimeoutMs: 2000,
 idleInTransactionTimeoutMs: 15000,
 pool: Object.freeze({ max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, queueLimit: 32 }),
 /* The design doc leaves the live Neon major to the read-only provider
 * inventory; until that evidence lands, PG16 is the pinned target. */
 expectedServerMajor: 16,
});

function bounded(field, value, fallback) {
 const bound = BOUNDS[field];
 if (value === undefined || value === null) value = fallback;
 const n = typeof value === 'number' ? value : Number(String(value));
 if (!Number.isInteger(n) || n < bound.min || n > bound.max) throw new PgGuardError(bound.code, { field, value: String(value), min: bound.min, max: bound.max });
 return n;
}

function requireString(field, code, value) {
 if (typeof value !== 'string' || !value.trim()) throw new PgGuardError(code, { field });
 return value.trim();
}

/* --------------------------------------------------------------- budgets --
 * The approved design bounds the SUM of all V5 pools against actual compute.
 * Every pool registers against one budget declaration per target; a second
 * pool that would over-commit the target's total or its role allocation fails
 * synchronously at createPgPool - before any connection attempt. Budgets
 * release again when the owning pool is ended.
 * ------------------------------------------------------------------------ */
const BUDGETS = new Map();

function parseRoleConnections(raw) {
 if (raw === undefined || raw === null) return null;
 const map = {};
 if (typeof raw === 'string') {
  for (const pair of raw.split(',')) {
   if (!pair.trim()) continue;
   const [role, max] = pair.split(':');
   if (!role || max === undefined) throw new PgGuardError('POOL_BUDGET_ROLES_INVALID', { pair });
   map[role.trim()] = Number(max);
  }
 } else if (typeof raw === 'object') {
  Object.assign(map, raw);
 } else {
  throw new PgGuardError('POOL_BUDGET_ROLES_INVALID', { type: typeof raw });
 }
 for (const [role, max] of Object.entries(map)) {
  if (!ROLE_NAMES.includes(role)) throw new PgGuardError('ROLE_INVALID', { role });
  if (!Number.isInteger(max) || max < 1 || max > BOUNDS.max.max * 8) throw new PgGuardError('POOL_BUDGET_ROLES_INVALID', { role, max: String(max) });
 }
 return Object.freeze(map);
}

function claimBudget(identity, role, max, budget) {
 const totalRaw = budget && budget.totalConnections;
 if (totalRaw === undefined || totalRaw === null || totalRaw === '') throw new PgGuardError('POOL_BUDGET_REQUIRED', { identity }, 'budget.totalConnections (MEGA_PG_POOL_BUDGET_TOTAL) is required for every pool');
 const totalConnections = bounded('totalConnections', totalRaw, undefined);
 const roleConnections = parseRoleConnections(budget && budget.roleConnections);
 if (roleConnections && roleConnections[role] === undefined) throw new PgGuardError('POOL_BUDGET_ROLE_ALLOC_MISSING', { role, allocated: Object.keys(roleConnections) });
 if (roleConnections && max > roleConnections[role]) throw new PgGuardError('POOL_BUDGET_EXCEEDED', { role, max, allocation: roleConnections[role] });
 const entry = BUDGETS.get(identity) || { totalConnections, roleConnections, used: 0, roles: {}, pools: 0 };
 if (entry.totalConnections !== totalConnections) throw new PgGuardError('POOL_BUDGET_CONFLICT', { identity, declared: entry.totalConnections, requested: totalConnections });
 if (entry.roleConnections && (!roleConnections || JSON.stringify(entry.roleConnections) !== JSON.stringify(roleConnections))) throw new PgGuardError('POOL_BUDGET_CONFLICT', { identity, reason: 'roleConnections' });
 const usedForRole = (entry.roles[role] || 0) + max;
 if (roleConnections && usedForRole > roleConnections[role]) throw new PgGuardError('POOL_BUDGET_EXCEEDED', { role, live: entry.roles[role] || 0, requested: max, allocation: roleConnections[role] });
 if (entry.used + max > entry.totalConnections) throw new PgGuardError('POOL_BUDGET_EXCEEDED', { identity, live: entry.used, requested: max, totalConnections });
 entry.used += max;
 entry.roles[role] = usedForRole;
 entry.pools += 1;
 BUDGETS.set(identity, entry);
 return { key: identity, role, max };
}

function releaseBudget(claim) {
 const entry = BUDGETS.get(claim.key);
 if (!entry) return;
 entry.used -= claim.max;
 entry.roles[claim.role] = (entry.roles[claim.role] || 0) - claim.max;
 entry.pools -= 1;
 if (entry.used <= 0 && entry.pools <= 0) BUDGETS.delete(claim.key);
}

function poolBudgetSnapshot(target) {
 const key = target === undefined || target === null ? null
  : (typeof target === 'string' ? target : targetBudgetIdentity(target, target.target));
 if (key) {
  const entry = BUDGETS.get(key);
  return entry ? { totalConnections: entry.totalConnections, roleConnections: entry.roleConnections, used: entry.used, roles: { ...entry.roles }, pools: entry.pools } : null;
 }
 const out = {};
 for (const [k, e] of BUDGETS) out[k] = { totalConnections: e.totalConnections, used: e.used, roles: { ...e.roles }, pools: e.pools };
 return out;
}

/* ------------------------------------------------------------ config ----- */
function normalizeConfig(input = {}) {
 const cfg = { ...input, password: input.password };
 const role = requireString('role', 'ROLE_REQUIRED', cfg.role);
 if (!ROLE_NAMES.includes(role)) throw new PgGuardError('ROLE_INVALID', { role });
 const user = requireString('user', 'PG_USER_REQUIRED', cfg.user);
 if (user !== role) throw new PgGuardError('ROLE_USER_MISMATCH', { role, user }, 'the login user must be the asserted session role');
 const host = requireString('host', 'PG_HOST_REQUIRED', cfg.host);
 const database = requireString('database', 'PG_DATABASE_REQUIRED', cfg.database);
 const service = requireString('service', 'SERVICE_REQUIRED', cfg.service);
 const revision = requireString('revision', 'REVISION_REQUIRED', cfg.revision);
 const label = requireString('label', 'ENV_LABEL_REQUIRED', cfg.label);
 const port = cfg.port === undefined || cfg.port === null ? DEFAULTS.port : Number(cfg.port);
 if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PgGuardError('PG_PORT_INVALID', { port: String(cfg.port) });
 const password = cfg.password;
 if ((label === 'production' || label === 'staging') && !(typeof password === 'string' && password.length > 0)) {
  throw new PgGuardError('PG_CREDENTIALS_REQUIRED', { label }, 'production/staging pools require an explicit password');
 }
 const neonProjectHint = cfg.neonProjectHint || extractNeonHint(host);
 assertEnvironmentCoherence({ label, host, database, user, neonProjectHint });
 const targetInput = cfg.target !== undefined ? cfg.target : (cfg.targetFile ? loadTargetFile(cfg.targetFile) : undefined);
 const target = assertTargetBinding({ label, host, database }, targetInput);
 const ssl = assertTlsConfig({
  label, host,
  ssl: cfg.ssl,
  sslmode: cfg.sslmode,
  sslRootCertPath: cfg.sslRootCertPath,
  systemRootsPath: cfg.systemRootsPath || process.env.SSL_CERT_FILE,
  allowLocalNoTls: cfg.allowLocalNoTls === true,
 });
 const applicationName = buildApplicationName({ role, service, revision });
 const pool = {
  max: bounded('max', cfg.pool && cfg.pool.max, DEFAULTS.pool.max),
  idleTimeoutMillis: bounded('idleTimeoutMillis', cfg.pool && cfg.pool.idleTimeoutMillis, DEFAULTS.pool.idleTimeoutMillis),
  connectionTimeoutMillis: bounded('connectionTimeoutMillis', cfg.pool && cfg.pool.connectionTimeoutMillis, DEFAULTS.pool.connectionTimeoutMillis),
  queueLimit: bounded('queueLimit', cfg.pool && cfg.pool.queueLimit, DEFAULTS.pool.queueLimit),
 };
 const timings = {
  statementTimeoutMs: bounded('statementTimeoutMs', cfg.statementTimeoutMs, DEFAULTS.statementTimeoutMs),
  lockTimeoutMs: bounded('lockTimeoutMs', cfg.lockTimeoutMs, DEFAULTS.lockTimeoutMs),
  idleInTransactionTimeoutMs: bounded('idleInTransactionTimeoutMs', cfg.idleInTransactionTimeoutMs, DEFAULTS.idleInTransactionTimeoutMs),
 };
 const pinSource = cfg.expectedServerMajor !== undefined && cfg.expectedServerMajor !== null
  ? cfg.expectedServerMajor : (target && target.pgMajor !== undefined ? target.pgMajor : DEFAULTS.expectedServerMajor);
 const expectedServerMajor = Number(pinSource);
 if (!Number.isInteger(expectedServerMajor) || expectedServerMajor < 11 || expectedServerMajor > 20) throw new PgGuardError('PG_VERSION_PIN_INVALID', { expectedServerMajor: String(pinSource) });
 const schemas = Object.freeze([...(cfg.roleSchemas || ROLE_GRANT_SCHEMAS[role] || [])]);
 const budgetClaim = claimBudget(targetBudgetIdentity({ host, port, database }, target), role, pool.max, cfg.budget);
 return {
  host, port, database, user, role, service, revision, label, password,
  neonProjectHint, target, ssl, sslmode: cfg.sslmode, applicationName, pool, timings,
  expectedServerMajor, schemas, searchPath: SEARCH_PATH,
  sanitizeOnRelease: cfg.sanitizeOnRelease !== false,
  budgetClaim,
 };
}

/* ---------------------------------------------------------------- pg ----- */
let pgModule = null;
function driver() {
 if (!pgModule) {
  try {
   pgModule = require('pg');
  } catch (error) {
   throw new PgGuardError('PG_DRIVER_UNAVAILABLE', { package: 'pg@8.23.1' }, error);
  }
 }
 return pgModule;
}

const RELEASED = Symbol('megaXoPgReleased');
function quoteLiteral(value) {
 return "'" + String(value).replace(/'/g, "''") + "'";
}

function sanitizeStatements(resolved) {
 // Direct/session-mode hygiene, sent as SEPARATE standalone queries:
 // DISCARD ALL resets role/session-authorization and every session GUC
 // (RESET ALL/CLOSE ALL/DEALLOCATE ALL included), then a SET-only batch
 // re-pins the startup identity so the next checkout's probe passes.
 // DISCARD ALL must NEVER share a simple-query string with other
// statements: PostgreSQL's implicit multi-statement transaction makes it
 // fail 25001, which would destroy every healthy release into churn.
 // Under transaction pooling this cannot reach pooled backends (the pooler
 // owns server reset); the per-transaction expectSession verification is
 // what guards work there.
 return [
  'DISCARD ALL',
  [
   // Restore the EXACT raw GUC string via set_config, not the SET parser:
   // `TO pg_catalog, none` auto-quotes the keyword none into the identifier
   // "none", and `TO 'pg_catalog,none'` treats the string as ONE identifier
   // (observed on real Neon post-release as '"pg_catalog,none"'). The third
   // argument false keeps it a SESSION-level set. verifySession stays strict
   // against the verbatim startup value - no quote-stripping, no parser
   // loosen in the guard.
   `SELECT pg_catalog.set_config('search_path', ${quoteLiteral(SEARCH_PATH)}, false)`,
   `SET application_name TO ${quoteLiteral(resolved.applicationName)}`,
   `SET statement_timeout TO ${resolved.timings.statementTimeoutMs}`,
   `SET lock_timeout TO ${resolved.timings.lockTimeoutMs}`,
   `SET idle_in_transaction_session_timeout TO ${resolved.timings.idleInTransactionTimeoutMs}`,
  ].join('; ') + ';',
 ];
}

function createPgPool(input = {}) {
 const resolved = normalizeConfig(input);
 const { Pool } = driver();
 // Mode boundary decided by the verified host normalization, not by guesswork:
 // a Neon '-pooler' endpoint is transaction pooling; everything else is a
 // direct/session backend.
 const pooled = isPoolerHost(resolved.host);
 const raw = new Pool({
  host: resolved.host,
  port: resolved.port,
  database: resolved.database,
  user: resolved.user,
  password: resolved.password,
  application_name: resolved.application_name || resolved.applicationName,
  // DIRECT only: best-effort SESSION-level pin through the startup options
  // channel (search_path proven to land verbatim; timeout delivery there is
  // UNCONFIRMED and never relied on). AUTHORITATIVE enforcement is always
  // per transaction inside BEGIN via set_config(..., true).
  // POOLED never sends options: the Neon pooler refuses startup options
  // carrying search_path (documented 08P01 unsupported startup parameter).
  ...(pooled ? {} : { options: `-c search_path=${SEARCH_PATH} -c statement_timeout=${resolved.timings.statementTimeoutMs} -c lock_timeout=${resolved.timings.lockTimeoutMs} -c idle_in_transaction_session_timeout=${resolved.timings.idleInTransactionTimeoutMs}` }),
  ssl: resolved.ssl,
  max: resolved.pool.max,
  idleTimeoutMillis: resolved.pool.idleTimeoutMillis,
  connectionTimeoutMillis: resolved.pool.connectionTimeoutMillis,
 });
 const expectations = {
  role: resolved.role,
  schemas: resolved.schemas,
  applicationName: resolved.applicationName,
  statementTimeoutMs: resolved.timings.statementTimeoutMs,
  lockTimeoutMs: resolved.timings.lockTimeoutMs,
  idleInTransactionTimeoutMs: resolved.timings.idleInTransactionTimeoutMs,
  searchPath: resolved.searchPath,
  expectedServerMajor: resolved.expectedServerMajor,
 };

 let ended = false;
 let checkedOut = 0;
 let queued = 0;
 // pg-pool emits 'error' on the POOL for an idle backend death and on a leased client for a
 // mid-lease backend death; an unhandled 'error' event throws ERR_UNHANDLED_ERROR and kills
 // the process (pg-pool/index.js idle handler). Record it as a non-secret diagnostic and
 // never let it escape as an uncaught process error.
 let lastPoolError = null;
 raw.on('error', (error) => {
  const message = String((error && error.message) || error);
  lastPoolError = (error && error.code) ? `${error.code}: ${message}` : message;
 });
 // Synchronous accepted-request reservation. Covers the whole lifecycle -
 // acquiring + leased + queued + RELEASING - from before the first await in
 // acquire() until the actual raw.release/sanitize completes. The gate is
 // decided on THIS counter only; checkedOut/queued stay public-stats fields
 // that move after awaits and would leave a cold window where every
 // concurrent acquire passes the gate at once.
 let outstanding = 0;

 async function acquire(opts = {}) {
  const checkSearchPath = opts.checkSearchPath !== false;
  const sanitize = opts.sanitize !== false;
  if (ended) throw new PgGuardError('POOL_CLOSED', { target: resolved.database });
  // Rejection and the queued tag are decided on the reservation counter
  // BEFORE the first await: a cold pool would otherwise let every concurrent
  // acquire pass while checkedOut/queued still read zero (the parent's
  // max1/queue1/request3 repro saw all three enter raw.connect at once).
  if (outstanding >= resolved.pool.max + resolved.pool.queueLimit) {
   throw new PgGuardError('POOL_QUEUE_LIMIT', { max: resolved.pool.max, queueLimit: resolved.pool.queueLimit });
  }
  const gateQueued = outstanding >= resolved.pool.max;
  outstanding += 1;
  if (gateQueued) queued += 1;
  let client;
  try {
   client = await raw.connect();
  } catch (error) {
   outstanding -= 1;
   if (gateQueued) queued = Math.max(0, queued - 1);
   const message = String((error && error.message) || error);
   if (/timeout/i.test(message)) throw new PgGuardError('POOL_ACQUIRE_TIMEOUT', { ms: resolved.pool.connectionTimeoutMillis }, error);
   if (/certificate|ssl/i.test(message)) throw new PgGuardError('TLS_VERIFICATION_FAILED', { target: resolved.database, reason: message }, error);
   throw new PgGuardError('PG_CONNECT_FAILED', { target: resolved.database, reason: message }, error);
  }
  try {
   await verifySession(client, { ...expectations, checkSearchPath });
  } catch (error) {
   outstanding -= 1;
   if (gateQueued) queued = Math.max(0, queued - 1);
   client.release(error); // destroy the untrusted connection, never reuse it
   throw error;
  }
  checkedOut += 1;
  if (gateQueued) queued = Math.max(0, queued - 1); // leased now; the reservation persists through the lease
  let released = false;
  client[RELEASED] = false;
  // pg-pool removes its own error listener at acquire time, so a backend killed mid-lease
  // would otherwise emit 'error' with no listener (uncaught, process-fatal). This no-op
  // handler keeps the emission non-fatal: the next statement on the dead client rejects
  // normally and the caller's UoW/transaction path reports it as a failed operation.
  const leasedErrorGuard = (error) => {
   const message = String((error && error.message) || error);
   lastPoolError = (error && error.code) ? `${error.code}: ${message}` : message;
  };
  client.on('error', leasedErrorGuard);
  const release = async (failure) => {
   if (released) return;
   released = true;
   checkedOut -= 1;
   client[RELEASED] = true;
   // Detach the lease-scoped guard first: pg-pool only removes its OWN idle listener, so a
   // guard left attached would accumulate one per acquire/release cycle.
   client.removeListener('error', leasedErrorGuard);
   try {
    // POOLED: no session cleanup is verifiable - the same backend is not
    // guaranteed after COMMIT and the pooler owns server reset.
    if (failure || !sanitize || !resolved.sanitizeOnRelease) return client.release(failure || undefined);
    try {
     for (const statement of sanitizeStatements(resolved)) await client.query(statement);
     return client.release();
    } catch (error) {
     return client.release(error); // fail-closed: only a REAL sanitize failure destroys
    }
   } finally {
    // The reservation is released exactly once, only after sanitize and
    // raw.release have ACTUALLY completed (decrementing before those awaits
    // reopens the very cold-queue gap this counter exists to close).
    outstanding -= 1;
   }
  };
  return { client, release };
 }

 /* PUBLIC session lease - DIRECT mode only. A raw session under transaction
  * pooling would pretend stability that the mode cannot honour (release
  * sanitize, pinned session GUCs, checkout search_path all bind to a
  * backend that statements may leave), so it is refused before any borrow. */
 async function connect() {
  if (pooled) throw new PgGuardError('POOLED_SESSION_UNSUPPORTED',
   { host: resolved.host, database: resolved.database, role: resolved.role },
   'a raw session lease is not sound on a pooler endpoint; use withTransaction() or query()');
  return acquire({ checkSearchPath: true, sanitize: true });
 }

 async function withTransaction(fn, options = {}) {
  // The private acquire is shared by both modes; POOLED defers ONLY
  // search_path (re-established and fully verified inside BEGIN).
  const { client, release } = await acquire({ checkSearchPath: !pooled, sanitize: !pooled });
  try {
   return await withIdempotentTransaction(client, fn, { ...options, connected: true, expectSession: expectations });
  } finally {
   await release();
  }
 }

 /* One-shot app query - routed through the bounded transaction path in BOTH
  * modes, so every application query runs under the pinned timers. */
 async function query(text, params) {
  return withTransaction((tx) => tx.query(text, params));
 }

 return {
  connect,
  withTransaction,
  query,
  stats: () => ({ total: raw.totalCount, idle: raw.idleCount, waiting: raw.waitingCount, checkedOut, queued, lastPoolError }),
  describe: () => ({
   host: resolved.host, port: resolved.port, database: resolved.database, user: resolved.user, role: resolved.role,
   service: resolved.service, revision: resolved.revision, label: resolved.label, applicationName: resolved.applicationName,
   ssl: resolved.ssl === false ? 'disabled(local)' : 'verify-full(explicit-root-ca)',
   mode: pooled ? 'pooled' : 'direct',
   searchPath: resolved.searchPath, timings: resolved.timings, pool: resolved.pool,
   expectedServerMajor: resolved.expectedServerMajor,
   target: resolved.target ? {
    environment: resolved.target.environment, projectId: resolved.target.projectId,
    branchId: resolved.target.branchId, endpointId: resolved.target.endpointId,
    host: resolved.target.host, database: resolved.target.database, nonserving: resolved.target.nonserving,
   } : null,
  }),
  async end() {
   if (ended) return;
   ended = true;
   await raw.end();
   releaseBudget(resolved.budgetClaim);
  },
 };
}

/* ---------------------------------------------- environment contract -----
 * Reads the documented MEGA_* variables; explicit overrides win, then the
 * MEGA_* env, then the URL. Password material is attached non-enumerable so a
 * stray console.log(JSON.stringify(config)) cannot leak it.
 *
 *   MEGA_PG_URL                        postgres://... (optional base; sslmode= and
 *                                      sslrootcert= query params are honoured)
 *   MEGA_PG_HOST / _PORT / _DATABASE / _USER / _PASSWORD
 *   MEGA_ENV_LABEL                     production|staging|preview|dev|test
 *   MEGA_NEON_PROJECT                  Neon project/branch hint for env isolation
 *   MEGA_PG_ROLE                       one of PG_ROLES (login user must match)
 *   MEGA_SERVICE                       service segment of application_name
 *   MEGA_RELEASE_REVISION              revision segment (GIT_COMMIT fallback)
 *   MEGA_PG_SSL_CA                     inline root CA PEM (secret-manager style)
 *   MEGA_PG_SSL_ROOTCERT               root CA path (URL sslrootcert= / SSL_CERT_FILE also accepted)
 *   MEGA_PG_STATEMENT_TIMEOUT_MS / _LOCK_TIMEOUT_MS / _IDLE_IN_TRANSACTION_TIMEOUT_MS
 *   MEGA_PG_MAX / MEGA_PG_IDLE_TIMEOUT_MS / MEGA_PG_CONNECT_TIMEOUT_MS / MEGA_PG_QUEUE_LIMIT
 *   MEGA_PG_POOL_BUDGET_TOTAL          total server connections across ALL V5 role pools
 *   MEGA_PG_POOL_BUDGET_ROLES          'api_runtime:6,core_runtime:4' allocations
 *   MEGA_PG_EXPECTED_MAJOR             pinned server major (default 16)
 *   MEGA_PG_ALLOW_LOCAL_NO_TLS         '1' - loopback dev/test only
 * ------------------------------------------------------------------------ */
function fromEnvironment(env = process.env, overrides = {}) {
 const cfg = { ...overrides };
 if (cfg.host === undefined && env.MEGA_PG_URL) {
  const url = env.MEGA_PG_URL;
  let parsed;
  try {
   parsed = new URL(url);
  } catch (error) {
   throw new PgGuardError('PG_URL_INVALID', { url: redactUrl(url) }, error);
  }
  cfg.host = parsed.hostname;
  cfg.port = parsed.port ? Number(parsed.port) : undefined;
  cfg.database = parsed.pathname.length > 1 ? decodeURIComponent(parsed.pathname.slice(1)) : undefined;
  cfg.user = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  if (cfg.password === undefined && parsed.password) cfg.password = decodeURIComponent(parsed.password);
  if (parsed.searchParams.has('sslmode')) cfg.sslmode = parsed.searchParams.get('sslmode');
  if (parsed.searchParams.has('sslrootcert')) cfg.sslRootCertPath = parsed.searchParams.get('sslrootcert');
 }
 const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
 cfg.host = cfg.host || env.MEGA_PG_HOST;
 if (cfg.port === undefined) cfg.port = num(env.MEGA_PG_PORT);
 cfg.database = cfg.database || env.MEGA_PG_DATABASE;
 cfg.user = cfg.user || env.MEGA_PG_USER;
 if (cfg.password === undefined) cfg.password = env.MEGA_PG_PASSWORD;
 if (cfg.sslmode === undefined) cfg.sslmode = env.MEGA_PG_SSLMODE;
 if (cfg.sslRootCertPath === undefined) cfg.sslRootCertPath = env.MEGA_PG_SSL_ROOTCERT;
 if (cfg.ssl === undefined && env.MEGA_PG_SSL_CA) cfg.ssl = { ca: env.MEGA_PG_SSL_CA };
 cfg.label = cfg.label || env.MEGA_ENV_LABEL;
 cfg.neonProjectHint = cfg.neonProjectHint || env.MEGA_NEON_PROJECT;
 cfg.role = cfg.role || env.MEGA_PG_ROLE;
 cfg.service = cfg.service || env.MEGA_SERVICE;
 cfg.revision = cfg.revision || env.MEGA_RELEASE_REVISION || env.GIT_COMMIT;
 if (cfg.statementTimeoutMs === undefined) cfg.statementTimeoutMs = num(env.MEGA_PG_STATEMENT_TIMEOUT_MS);
 if (cfg.lockTimeoutMs === undefined) cfg.lockTimeoutMs = num(env.MEGA_PG_LOCK_TIMEOUT_MS);
 if (cfg.idleInTransactionTimeoutMs === undefined) cfg.idleInTransactionTimeoutMs = num(env.MEGA_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS);
 cfg.pool = {
  max: (cfg.pool && cfg.pool.max) ?? num(env.MEGA_PG_MAX),
  idleTimeoutMillis: (cfg.pool && cfg.pool.idleTimeoutMillis) ?? num(env.MEGA_PG_IDLE_TIMEOUT_MS),
  connectionTimeoutMillis: (cfg.pool && cfg.pool.connectionTimeoutMillis) ?? num(env.MEGA_PG_CONNECT_TIMEOUT_MS),
  queueLimit: (cfg.pool && cfg.pool.queueLimit) ?? num(env.MEGA_PG_QUEUE_LIMIT),
 };
 if (cfg.budget === undefined && (env.MEGA_PG_POOL_BUDGET_TOTAL || env.MEGA_PG_POOL_BUDGET_ROLES)) {
  cfg.budget = { totalConnections: num(env.MEGA_PG_POOL_BUDGET_TOTAL), roleConnections: env.MEGA_PG_POOL_BUDGET_ROLES };
 }
 if (cfg.expectedServerMajor === undefined) cfg.expectedServerMajor = num(env.MEGA_PG_EXPECTED_MAJOR);
 if (cfg.target === undefined && cfg.targetFile === undefined && env.MEGA_PG_TARGET_FILE) cfg.targetFile = env.MEGA_PG_TARGET_FILE;
 if (cfg.allowLocalNoTls === undefined && env.MEGA_PG_ALLOW_LOCAL_NO_TLS === '1') cfg.allowLocalNoTls = true;
 if (cfg.systemRootsPath === undefined && env.SSL_CERT_FILE) cfg.systemRootsPath = env.SSL_CERT_FILE;
 const password = cfg.password;
 delete cfg.password;
 Object.defineProperty(cfg, 'password', { value: password, enumerable: false, writable: true, configurable: true });
 return cfg;
}

/* ------------------------------------------- borrowed-scope transactions --
 * Same semantics as the SQLite unit of work in packages/db/context.js:
 *  - one live transaction per client; nested invocations borrow it and cannot
 *    commit or roll back on their own;
 *  - repository seams must borrow: requirePgScope(client) outside a live scope
 *    throws the shared ContextError('TRANSACTION_REQUIRED');
 *  - "idempotent": within one open unit of work, repeated invocations sharing
 *    the same options.key execute fn exactly once and replay the stored
 *    result (single-flight), mirroring how command outcomes replay.
 */
const SCOPES = new WeakMap();

class PgTransactionScope {
 constructor(client, clock) {
  this.client = client;
  this.clock = typeof clock === 'function' ? clock : Date.now;
  this.depth = 1;
  this.ended = false;
  this.aborted = false;
  this.results = new Map();
  const scope = this;
  this.tx = Object.freeze({
   client,
   scope,
   clock: scope.clock,
   query(text, params) {
    if (scope.ended) throw new ContextError('TRANSACTION_REQUIRED');
    return client.query(text, params);
   },
  });
 }
}

function currentPgScope(client) {
 const scope = SCOPES.get(client);
 return scope && !scope.ended ? scope : null;
}

function requirePgScope(client) {
 const scope = currentPgScope(client);
 if (!scope) throw new ContextError('TRANSACTION_REQUIRED');
 return scope;
}

async function withIdempotentTransaction(client, fn, options = {}) {
 if (!client || typeof client.query !== 'function') throw new ContextError('PG_CLIENT_REQUIRED');
 if (typeof fn !== 'function') throw new ContextError('CALLBACK_REQUIRED');
 if (client[RELEASED]) throw new ContextError('CLIENT_RELEASED');
 const active = currentPgScope(client);
 if (active) {
  const cacheKey = options.key === undefined ? undefined : String(options.key);
  if (cacheKey !== undefined && active.results.has(cacheKey)) return active.results.get(cacheKey);
  active.depth += 1;
  let settled = false;
  const run = (async () => {
   try {
    const value = await fn(active.tx);
    settled = true;
    return value;
   } catch (error) {
    active.aborted = true;
    settled = true;
    throw error;
   } finally {
    active.depth -= 1;
   }
  })();
  if (cacheKey !== undefined) {
   active.results.set(cacheKey, run);
   run.catch(() => { if (settled) active.results.delete(cacheKey); });
  }
  return run;
 }
 if (!options.connected) {
  try {
   await client.connect();
  } catch (error) {
   if (!/already been connected/i.test(String(error && error.message))) throw error;
  }
 }
 const scope = new PgTransactionScope(client, options.now);
 SCOPES.set(client, scope);
 try {
  await client.query('BEGIN');
  // The authoritative verification point. Neon runtime strings go through
  // PgBouncer TRANSACTION pooling, where session SET/RESET does not persist
  // across transactions and a later statement can land on a different
  // backend: only checks executed INSIDE the borrowed transaction prove the
  // backend actually serving this unit of work. (SET LOCAL inside this
  // pinned transaction is the safe pattern; plain SET is never relied on.)
  if (options.expectSession !== undefined && options.expectSession !== null) {
   // Pin EVERY session identity GUC - search_path, application_name and the
   // three timers - transaction-locally on the backend ACTUALLY serving this
   // transaction (set_config(..., true) == SET LOCAL, but as raw string
   // values it bypasses the SET parser's identifier quoting of 'none'
   // entirely). The read-back in verifySession below proves they landed.
   const t = options.expectSession;
   await client.query(
    `SELECT pg_catalog.set_config('search_path', ${quoteLiteral(t.searchPath)}, true),`
    + ` pg_catalog.set_config('application_name', ${quoteLiteral(t.applicationName)}, true),`
    + ` pg_catalog.set_config('statement_timeout', ${quoteLiteral(String(t.statementTimeoutMs))}, true),`
    + ` pg_catalog.set_config('lock_timeout', ${quoteLiteral(String(t.lockTimeoutMs))}, true),`
    + ` pg_catalog.set_config('idle_in_transaction_session_timeout', ${quoteLiteral(String(t.idleInTransactionTimeoutMs))}, true);`);
   await verifySession(client, { ...options.expectSession, phase: 'transaction-open' });
  } else if (options.expectRole !== undefined && options.expectRole !== null) {
   let idRow = null;
   try {
    const r = await client.query('SELECT current_user AS cu, session_user AS su');
    idRow = r && r.rows && r.rows[0];
   } catch (error) {
    throw new PgGuardError('ROLE_CHECK_FAILED', { reason: 'begin-identity-probe-failed', message: error && error.message }, error);
   }
   if (!idRow || idRow.cu !== options.expectRole || idRow.su !== options.expectRole) {
    throw new PgGuardError('ROLE_MISMATCH', { expected: options.expectRole, current_user: idRow && idRow.cu, session_user: idRow && idRow.su, reason: 'mid-session-elevation', phase: 'transaction-open' });
   }
  }
  const value = await fn(scope.tx);
  await client.query('COMMIT');
  return value;
 } catch (error) {
  scope.aborted = true;
  try {
   await client.query('ROLLBACK');
  } catch { /* the original failure is authoritative */ }
  throw error;
 } finally {
  scope.ended = true;
  SCOPES.delete(client);
 }
}

module.exports = {
 BOUNDS,
 DEFAULTS,
 SEARCH_PATH,
 createPgPool,
 fromEnvironment,
 withIdempotentTransaction,
 currentPgScope,
 requirePgScope,
 poolBudgetSnapshot,
 sanitizeStatements,
};
