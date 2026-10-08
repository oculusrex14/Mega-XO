/* V5-02-04 fail-closed PostgreSQL guards (pure - no provider calls, no I/O except
 * reading an operator-supplied root CA file when a path is configured).
 *
 * Everything here runs BEFORE the first connect wherever it can: createPgPool
 * validates configuration synchronously through these helpers, and the session
 * integrity probe runs on every checkout before the caller can issue a single
 * application query. Any doubt throws a PgGuardError whose message is a bare
 * stable code (same convention as packages/contracts errors).
 */
'use strict';
const fs = require('fs');

class PgGuardError extends Error {
 constructor(code, detail, cause) {
  super(code);
  this.name = 'PgGuardError';
  this.code = code;
  if (detail !== undefined) this.detail = detail;
  if (cause !== undefined) this.cause = cause;
 }
}

/* Runtime/admin login roles from the approved P02 design (section 7). v5_owner is
 * the schema owner used by DDL and is never a runtime login expectation. */
const PG_ROLES = Object.freeze({
 MIGRATION_OWNER: 'migration_owner',
 V5_OWNER: 'v5_owner',
 API_RUNTIME: 'api_runtime',
 CORE_RUNTIME: 'core_runtime',
 WORKER_RUNTIME: 'worker_runtime',
 BACKUP_READER: 'backup_reader',
 AUDIT_RUNTIME: 'audit_runtime',
});
const PRIVILEGED_ROLES = Object.freeze([PG_ROLES.MIGRATION_OWNER, PG_ROLES.V5_OWNER]);
const ROLE_NAMES = Object.freeze(Object.values(PG_ROLES));

/* Default USAGE sanity lists, mirrored from the checksummed migration chain
 * (0002/0020-0023 as of this checkpoint; the chain is authoritative - callers
 * pass explicit options.schemas whenever a deployment diverges). Runtime roles
 * must additionally hold NO CREATE; privileged roles must hold CREATE
 * somewhere in their list, otherwise the grant set is broken and the session
 * sanity check fails closed. The chain grants meta USAGE only to
 * migration_owner, so it never belongs in a runtime default here. */
const ALL_SCHEMAS = Object.freeze(['meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament', 'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops']);
const ROLE_GRANT_SCHEMAS = Object.freeze({
 api_runtime: Object.freeze(['identity', 'profile', 'social', 'privacy', 'support', 'ops', 'runtime']),
 core_runtime: Object.freeze(['economy', 'core', 'match', 'tournament', 'monetization', 'season', 'cosmetics', 'identity', 'runtime']),
 worker_runtime: Object.freeze(['ops', 'monetization', 'privacy', 'support', 'runtime']),
 audit_runtime: Object.freeze(['audit']),
 backup_reader: ALL_SCHEMAS,
 migration_owner: ALL_SCHEMAS,
 v5_owner: ALL_SCHEMAS,
});

const ENVIRONMENT_LABELS = Object.freeze(['production', 'staging', 'preview', 'dev', 'test']);
const NONPRODUCTION_LABELS = Object.freeze(['staging', 'preview', 'dev', 'test']);
const LOCAL_LABELS = Object.freeze(['dev', 'test']);

/* Runtime login contract (P02 grants): the SQL migration chain creates the
 * role names NOLOGIN by default; deployment provisions the EXACT runtime role
 * as a LOGIN principal with a secret password out-of-band in each isolated
 * Neon project. There is no per-service secondary member login and no SET ROLE
 * path: a session reached via SET ROLE has session_user != the login role and
 * is therefore REJECTED by the guard, never treated as a valid principal. */
/* Credentials are classified from strings with REAL naming semantics only:
 * the database name, the login user, and an operator-declared Neon project
 * hint. HOSTNAMES ARE DELIBERATELY EXCLUDED - Neon endpoint/project hostnames
 * are random-word identifiers, so lexical host tokens are never environment
 * authority (that would falsely refuse a random slug containing 'dev' or
 * 'test'); non-loopback environments bind ONLY through the explicit target
 * inventory (assertTargetBinding). A credential carrying BOTH reserved word
 * families is ambiguous and refused everywhere rather than guessed. */
const PRODUCTION_TOKENS = Object.freeze(['prod', 'production', 'live']);
const NONPRODUCTION_TOKENS = Object.freeze(['staging', 'stage', 'stg', 'preview', 'preprod', 'qa', 'test', 'testing', 'dev', 'development', 'local', 'ci', 'sandbox', 'demo']);

function tokens(value) {
 return String(value == null ? '' : value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function classifyHint(value) {
 const seen = tokens(value);
 const prod = seen.some((t) => PRODUCTION_TOKENS.includes(t));
 const nonprod = seen.some((t) => NONPRODUCTION_TOKENS.includes(t));
 if (prod && nonprod) return 'ambiguous';
 if (prod) return 'production';
 if (nonprod) return 'nonproduction';
 return 'neutral';
}

function isLoopbackHost(host) {
 const h = String(host || '').replace(/^\[|\]$/g, '');
 return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || h === '';
}

/* FIRST-ORDER HINT ONLY: for a *.aws.neon.tech hostname the first label is the
 * ENDPOINT identifier ('ep-...' / pooler variant) - it identifies an endpoint,
 * NOT the project or branch. Environment binding MUST come from explicitly
 * configured actual identities (label + MEGA_NEON_PROJECT/endpoint/database
 * values); this token is only a cross-check that those explicit declarations do
 * not contradict the names the credential carries. No provider lookup. */
function extractNeonHint(host) {
 const h = String(host || '').toLowerCase();
 if (!/(^|\.)neon\.tech$/.test(h)) return null;
 const first = h.split('.')[0] || null;
 return first ? first.replace(/-pooler$/, '') : null;
}

function assertEnvironmentCoherence({ label, host, database, user, neonProjectHint }) {
 if (typeof label !== 'string' || !label) throw new PgGuardError('ENV_LABEL_REQUIRED', 'MEGA_ENV_LABEL is required (one of ' + ENVIRONMENT_LABELS.join(',') + ')');
 if (!ENVIRONMENT_LABELS.includes(label)) throw new PgGuardError('ENV_LABEL_INVALID', label);
 const isProduction = label === 'production';
 const hints = Object.freeze({
  database: classifyHint(database),
  user: classifyHint(user),
  neonProject: neonProjectHint ? classifyHint(neonProjectHint) : 'neutral',
 });
 for (const [field, verdict] of Object.entries(hints)) {
  if (verdict === 'ambiguous') throw new PgGuardError('ENVIRONMENT_AMBIGUOUS', { field, label }, 'credential carries both production and nonproduction tokens');
  if (isProduction && verdict === 'nonproduction') throw new PgGuardError('ENVIRONMENT_MISMATCH', { field, label, verdict }, 'production pool refuses nonproduction-patterned credential');
  if (!isProduction && verdict === 'production') throw new PgGuardError('ENVIRONMENT_MISMATCH', { field, label, verdict }, label + ' pool refuses production-patterned credential');
 }
 if (isProduction && isLoopbackHost(host)) throw new PgGuardError('ENVIRONMENT_MISMATCH', { field: 'host', label, verdict: 'loopback' }, 'production credentials are never used against a loopback target');
 return { label, hints };
}

/* ------------------------------------------- explicit target inventory --
 * Pattern hints never bind an environment: every non-loopback production /
 * staging / preview pool MUST declare its actual target identity -
 * {version:1, environment, projectId, branchId, endpointId, host, database,
 * pgMajor?, nonserving?} - through config.target or MEGA_PG_TARGET_FILE (a
 * nonsecret manifest such as docs/v5/environments/staging.json; secrets stay
 * in the separate connection-string contract). The URI host must equal the
 * declared host or its single verified pooler variant of the SAME endpoint
 * ('<first-label>-pooler.<rest>'); endpointId is variant-invariant. Project
 * and branch identity are never inferred from host words - they are recorded,
 * validated declarations, and Neon targets must state them. Unknown targets
 * are refused. dev/test synthetic loopback fixtures are the explicit local
 * opt-in and need no inventory. */
const TARGET_KEYS = Object.freeze(['version', 'environment', 'projectId', 'branchId', 'endpointId', 'host', 'database', 'pgMajor', 'nonserving', 'roleConnectionLimits', 'compute', 'historyRetentionSeconds', 'outbound']);
const TARGET_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BINDING_LABELS = Object.freeze(['production', 'staging', 'preview']);

function normalizeHost(h) {
 return String(h || '').toLowerCase().replace(/\.+$/, '');
}
function isNeonHost(h) {
 return /(^|\.)neon\.tech$/.test(normalizeHost(h));
}
function endpointBase(h) {
 return normalizeHost(h).split('.')[0].replace(/-pooler$/, '');
}
function poolerVariant(h) {
 const n = normalizeHost(h);
 const i = n.indexOf('.');
 if (i < 1 || !isNeonHost(n)) return null;
 const first = n.slice(0, i);
 return first.endsWith('-pooler') ? n : first + '-pooler' + n.slice(i);
}
/* True when the host IS a Neon pooler endpoint (first label ends '-pooler'
 * under the same verified normalization as poolerVariant/canonicalHost). */
function isPoolerHost(h) {
 const n = normalizeHost(h);
 const i = n.indexOf('.');
 if (i < 1 || !isNeonHost(n)) return false;
 return n.slice(0, i).endsWith('-pooler');
}
/* Collapses the direct/pooler alias pair to one budget identity so the same
 * endpoint is never counted twice by hostname variant. */
function canonicalHost(h) {
 const n = normalizeHost(h);
 const i = n.indexOf('.');
 if (i < 1) return n;
 const first = n.slice(0, i);
 return (first.endsWith('-pooler') ? first.slice(0, -'-pooler'.length) : first) + n.slice(i);
}

function validateTarget(target, source) {
 if (!target || typeof target !== 'object' || Array.isArray(target)) {
  throw new PgGuardError('TARGET_REQUIRED', { source }, 'non-loopback pools must declare {environment, projectId, branchId, endpointId, host, database} via config.target or MEGA_PG_TARGET_FILE');
 }
 for (const key of Object.keys(target)) {
  if (!TARGET_KEYS.includes(key)) throw new PgGuardError('TARGET_FILE_INVALID', { key, source }, 'target manifests are closed allow-lists (also blocks secret smuggling through manifest keys)');
 }
 if (target.version !== 1) throw new PgGuardError('TARGET_FILE_INVALID', { field: 'version', observed: String(target.version), source });
 for (const f of ['environment', 'host', 'database']) {
  if (typeof target[f] !== 'string' || !TARGET_TOKEN.test(target[f])) throw new PgGuardError('TARGET_FILE_INVALID', { field: f, source }, 'target values are short nonsecret identity tokens');
 }
 if (!ENVIRONMENT_LABELS.includes(target.environment)) throw new PgGuardError('TARGET_FILE_INVALID', { field: 'environment', observed: target.environment, source });
 for (const f of ['projectId', 'branchId', 'endpointId']) {
  if (target[f] !== undefined && (typeof target[f] !== 'string' || !TARGET_TOKEN.test(target[f]))) throw new PgGuardError('TARGET_FILE_INVALID', { field: f, source });
 }
 if (isNeonHost(target.host) && !(target.projectId && target.branchId && target.endpointId)) {
  throw new PgGuardError('TARGET_FILE_INVALID', { source, missing: 'projectId/branchId/endpointId' }, 'Neon targets must state the actual project, branch and endpoint ids');
 }
 if (target.pgMajor !== undefined && (!Number.isInteger(target.pgMajor) || target.pgMajor < 11 || target.pgMajor > 20)) throw new PgGuardError('TARGET_FILE_INVALID', { field: 'pgMajor', source });
 if (typeof target.nonserving !== 'boolean') throw new PgGuardError('TARGET_FILE_INVALID', { field: 'nonserving', source }, 'targets must declare serving state (true = nonserving schema only)');
 return Object.freeze({
  version: 1, environment: target.environment, host: normalizeHost(target.host), database: target.database,
  projectId: target.projectId, branchId: target.branchId, endpointId: target.endpointId,
  pgMajor: target.pgMajor, nonserving: target.nonserving,
 });
}

function loadTargetFile(pathname) {
 let raw;
 try {
  raw = fs.readFileSync(String(pathname), 'utf8');
 } catch (error) {
  throw new PgGuardError('TARGET_FILE_INVALID', { path: String(pathname) }, error);
 }
 let parsed;
 try {
  parsed = JSON.parse(raw);
 } catch (error) {
  throw new PgGuardError('TARGET_FILE_INVALID', { path: String(pathname), reason: 'unparseable-json' }, error);
 }
 return validateTarget(parsed, 'MEGA_PG_TARGET_FILE');
}

function assertTargetBinding({ label, host, database }, target) {
 if (isLoopbackHost(host)) {
  // explicit local synthetic opt-in; production-on-loopback is already
  // refused by assertEnvironmentCoherence before this point.
  if (target !== undefined && target !== null) return validateTarget(target, 'config.target');
  return null;
 }
 if (!BINDING_LABELS.includes(label)) {
  return target === undefined || target === null ? null : validateTarget(target, 'config.target');
 }
 const v = validateTarget(target, 'config.target|MEGA_PG_TARGET_FILE');
 if (v.environment !== label) throw new PgGuardError('TARGET_MISMATCH', { field: 'environment', declared: v.environment, label }, 'target inventory environment must equal the declared MEGA_ENV_LABEL');
 const nh = normalizeHost(host);
 if (nh !== v.host && poolerVariant(v.host) !== nh) throw new PgGuardError('TARGET_MISMATCH', { field: 'host', label }, 'URI host is neither the inventory host nor its verified pooler variant');
 if (v.database !== database) throw new PgGuardError('TARGET_MISMATCH', { field: 'database', label }, 'URI database does not match the target inventory');
 if (v.endpointId !== undefined && endpointBase(v.host) !== endpointBase(v.endpointId)) throw new PgGuardError('TARGET_MISMATCH', { field: 'endpointId', label }, 'endpointId contradicts the inventory host (pooler variants share one endpointId)');
 return v;
}

/* One budget identity per real endpoint: direct and pooler hostnames of the
 * same project/branch/endpoint/database never double-count capacity. */
function targetBudgetIdentity({ host, port, database }, target) {
 if (target && target.endpointId && isNeonHost(target.host)) {
  return 'ep:' + [target.projectId || '-', target.branchId || '-', target.endpointId, target.database].join('/');
 }
 if (isLoopbackHost(host)) return 'local:' + host + '|' + port + '|' + database;
 return canonicalHost(host) + '|' + port + '|' + database;
}

/* TLS policy: Neon requires TLS and node-postgres must verify the full chain.
 * Accepted configurations, in priority order:
 *   ssl: { ca } | { caFile }         - explicit root CA (PEM text / path)
 *   sslRootCertPath                  - path from URL sslrootcert=, env MEGA_PG_SSL_ROOTCERT,
 *                                      or SSL_CERT_FILE (the "valid system roots path" escape:
 *                                      the file is read here and pinned as the trust anchor)
 * Refused: sslmode=disable/false, no-verify/rejectUnauthorized:false, no anchor at
 * all, empty/non-PEM anchor files. The only no-TLS path is an explicit
 * allowLocalNoTls opt-in for loopback targets under dev/test labels. */
function readAnchor(pathname, code, causeTag) {
 let raw;
 try {
  raw = fs.readFileSync(pathname);
 } catch (error) {
  throw new PgGuardError('SSL_ROOTCERT_UNREADABLE', { source: causeTag, path: String(pathname) }, error);
 }
 if (raw.length === 0) throw new PgGuardError('SSL_ROOTCERT_EMPTY', { source: causeTag, path: String(pathname) });
 if (!raw.includes('-----BEGIN CERTIFICATE-----')) throw new PgGuardError('SSL_ROOTCERT_NOT_PEM', { source: causeTag, path: String(pathname) });
 return raw.toString('utf8');
}

function assertTlsConfig({ label, host, ssl, sslmode, sslRootCertPath, systemRootsPath, allowLocalNoTls }) {
 // EXPLICIT no-TLS requests (refused everywhere but the loopback dev/test
 // opt-in) are distinct from ABSENT ssl config (which falls through to the
 // mandatory-anchor checks below as SSL_CA_REQUIRED).
 const explicitNoTls = ssl === false || ssl === 'disable' || ssl === 'no-verify'
  || (typeof sslmode === 'string' && ['disable', 'false', '0', 'off', 'no'].includes(sslmode.toLowerCase()))
  || (ssl && typeof ssl === 'object' && (ssl.rejectUnauthorized === false || ssl.sslmode === 'disable'));
 const localBypass = allowLocalNoTls === true && LOCAL_LABELS.includes(label) && isLoopbackHost(host);
 if (localBypass && (ssl === undefined || ssl === null || explicitNoTls)) return false;
 if (explicitNoTls) throw new PgGuardError('SSL_REQUIRED', { label }, 'TLS is mandatory; sslmode-disable and no-verify are refused outside the loopback dev/test opt-in');
 if (label === 'production' && allowLocalNoTls === true) throw new PgGuardError('ENVIRONMENT_MISMATCH', { field: 'allowLocalNoTls', label }, 'no-TLS opt-in is never valid for production');
 if (typeof sslmode === 'string' && !['require', 'verify-ca', 'verify-full'].includes(sslmode.toLowerCase())) {
  throw new PgGuardError('SSL_REQUIRED', { label, sslmode }, 'only require/verify-ca/verify-full are accepted; prefer/allow/no-verify are refused');
 }
 const caData = (ssl && typeof ssl === 'object' && typeof ssl.ca === 'string') ? ssl.ca : (typeof ssl === 'string' && ssl.includes('-----BEGIN CERTIFICATE-----') ? ssl : null);
 const caFile = (ssl && typeof ssl === 'object' && typeof ssl.caFile === 'string') ? ssl.caFile : null;
 let ca = null;
 if (caData) {
  if (!/-----BEGIN CERTIFICATE-----/.test(caData)) throw new PgGuardError('SSL_ROOTCERT_NOT_PEM', { source: 'inline-ca' });
  ca = caData;
 } else if (caFile) {
  ca = readAnchor(caFile, 'SSL_ROOTCERT_UNREADABLE', 'ssl.caFile');
 } else if (sslRootCertPath) {
  ca = readAnchor(sslRootCertPath, 'SSL_ROOTCERT_UNREADABLE', 'sslrootcert');
 } else if (systemRootsPath) {
  ca = readAnchor(systemRootsPath, 'SSL_ROOTCERT_UNREADABLE', 'SSL_CERT_FILE');
 } else {
  throw new PgGuardError('SSL_CA_REQUIRED', { label }, 'an explicit root CA is required (MEGA_PG_SSL_CA / MEGA_PG_SSL_ROOTCERT / URL sslrootcert= / SSL_CERT_FILE)');
 }
 const h = String(host || 'localhost');
 // node's tls forbids an IP as options.servername; hostname verification then
 // proceeds via the socket address, which the cert must cover with an IP SAN.
 const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');
 return { ca, servername: isIp ? undefined : h, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

/* application_name contract: '<role>/<service>/<revision>' - every segment is a
 * conservative token (no quotes/slashes/spaces) and the whole string fits the
 * 64-byte GUC so it can never smuggle SQL or options syntax. */
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
function buildApplicationName({ role, service, revision }) {
 for (const [field, value] of Object.entries({ role, service, revision })) {
  if (typeof value !== 'string' || !NAME_SEGMENT.test(value)) {
   throw new PgGuardError(field === 'role' ? 'ROLE_INVALID' : field === 'service' ? 'SERVICE_REQUIRED' : 'REVISION_REQUIRED', { [field]: typeof value === 'string' ? value : String(value) });
  }
 }
 const name = role + '/' + service + '/' + revision;
 if (name.length > 63) throw new PgGuardError('APPLICATION_NAME_INVALID', { length: name.length });
 return name;
}

function redactUrl(url) {
 return String(url || '').replace(/(:\/\/[^:/@/?#]+:)[^@/]*(@)/, '$1***$2');
}

/* Single-round-trip session probe. Every value is fetched from the server side of
 * the checked-out connection - nothing the caller asserted about is self-reported
 * by the client object. */
function buildSessionProbe(schemas) {
 const list = schemas.map((s) => "'" + String(s).replace(/'/g, "''") + "'").join(',');
 // has_schema_privilege() RAISES (not returns false) for names missing from
 // the catalog, and privilege checks by QUALIFIED table name resolve through
 // schema USAGE (raising 42501 for denied schemas). Existence-filter against
 // the public catalogs pg_namespace/pg_roles so an absent object is a clean
 // fail-closed false, never a probe explosion.
 // EVERY catalog table/function reference is pg_catalog-qualified: a runtime
 // that could create temp-schema shadows (database TEMP via PUBLIC) must never
 // have a guard input resolved through a mutable search path.
 return "SELECT current_user AS \"current_user\", session_user AS \"session_user\","
  + " current_setting('server_version') AS server_version,"
  + " (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'application_name') AS application_name,"
  + " current_setting('search_path', true) AS search_path,"
  + " coalesce((SELECT setting FROM pg_catalog.pg_settings WHERE name = 'statement_timeout'), '') AS statement_timeout,"
  + " coalesce((SELECT setting FROM pg_catalog.pg_settings WHERE name = 'lock_timeout'), '') AS lock_timeout,"
  + " coalesce((SELECT setting FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout'), '') AS idle_in_transaction_session_timeout,"
  + " coalesce(pg_catalog.has_database_privilege(current_user, current_database(), 'TEMP'), true) AS db_temp,"
  + " coalesce((SELECT pg_catalog.jsonb_object_agg(x.nm, CASE WHEN ns.oid IS NOT NULL THEN pg_catalog.jsonb_build_object('usage', pg_catalog.has_schema_privilege(current_user, ns.oid, 'USAGE'), 'create', pg_catalog.has_schema_privilege(current_user, ns.oid, 'CREATE')) ELSE pg_catalog.jsonb_build_object('usage', false, 'create', false) END) FROM pg_catalog.unnest(ARRAY["
  + list + "]::text[]) AS x(nm) LEFT JOIN pg_catalog.pg_namespace ns ON ns.nspname = x.nm), '{}'::jsonb) AS schema_privileges";
}

function requireRow(client) {
 if (!client || typeof client.query !== 'function') throw new PgGuardError('ROLE_CHECK_FAILED', 'assertSessionRole needs a connected pg client');
}

async function probeSession(client, schemas) {
 requireRow(client);
 let result;
 try {
  result = await client.query(buildSessionProbe(schemas));
 } catch (error) {
  // Fail closed: a probe that cannot run can never prove the session is safe.
  throw new PgGuardError('ROLE_CHECK_FAILED', { reason: 'probe-failed', message: error && error.message }, error);
 }
 const row = result && result.rows && result.rows[0];
 if (!row) throw new PgGuardError('ROLE_CHECK_FAILED', { reason: 'empty-probe' });
 return row;
}

/* The role guard required by the P02 design: current_user AND session_user must
 * both equal the expected login role (a SET ROLE drift changes only
 * current_user), the role's grants must actually exist (USAGE sanity, no ambient
 * CREATE for runtime roles), and the server major must be the pinned one.
 * Throws ROLE_MISMATCH before the caller has executed any application query. */
function checkRoleRow(row, expectedRole, options, schemas) {
 const phase = options.phase ? { phase: options.phase } : {};
 if (row.current_user !== expectedRole || row.session_user !== expectedRole) {
  throw new PgGuardError('ROLE_MISMATCH', { expected: expectedRole, current_user: row.current_user, session_user: row.session_user, ...phase });
 }
 if (options.expectedServerMajor !== undefined && options.expectedServerMajor !== null
  && Number.parseInt(row.server_version, 10) !== options.expectedServerMajor) {
  throw new PgGuardError('PG_VERSION_MISMATCH', { expected: options.expectedServerMajor, observed: row.server_version, ...phase });
 }
 // No runtime principal may hold database TEMP (parent decision + 0025
 // posture): TEMP in a mutable temp schema can shadow guard metadata inputs
 // and lease scratch state; the read-only backup identity needs neither.
 const privileged = PRIVILEGED_ROLES.includes(expectedRole);
 if (TEMP_FORBIDDEN_ROLES.includes(expectedRole) && row.db_temp !== false) {
  throw new PgGuardError('ROLE_MISMATCH', { expected: expectedRole, reason: 'database-temp-privilege', ...phase }, 'serving runtime sessions require REVOKE TEMPORARY ON DATABASE FROM PUBLIC; posture');
 }
 const privileges = row.schema_privileges || {};
 let sawCreate = false;
 for (const schema of schemas) {
  const entry = privileges[schema];
  if (!entry || entry.usage !== true) throw new PgGuardError('ROLE_MISMATCH', { expected: expectedRole, schema, reason: 'usage-grant-missing', ...phase });
  if (entry.create === true) sawCreate = true;
  if (!privileged && entry.create === true) throw new PgGuardError('ROLE_MISMATCH', { expected: expectedRole, schema, reason: 'ambient-create-privilege', ...phase });
 }
 if (privileged && !sawCreate) throw new PgGuardError('ROLE_MISMATCH', { expected: expectedRole, reason: 'missing-create-privilege', ...phase });
}

/* Cross-role capability refusal (P1 provisioning review): a session that can
 * SET ROLE into (or inherits) ANY other runtime role or an
 * owner/migrator/neon_superuser principal could elevate after the initial
 * current_user=session_user check passes. Membership is therefore refused
 * fail-closed on every guarded runtime session; backup_reader's required
 * zero-edge rule since chain 0026: NO runtime identity, backup_reader
 * included, may hold any membership edge - the old positive pg_read_all_data
 * expectation is obsolete and its presence is now itself a refusal. */
const ADMIN_PRINCIPALS = Object.freeze(['neon_superuser', 'pg_execute_server_program', 'pg_write_server_files', 'pg_read_server_files']);
/* Database-TEMP prohibition scope (parent decision, 2026-10-08): ALL five
 * runtime identities, including backup_reader - the architecture is explicit
 * that a read-only backup needs no DDL and no TEMP scratch (no real pg_dump
 * TEMP requirement was evidenced; logical dumps run off SELECT grants). 0025
 * accordingly revokes PUBLIC TEMP and grants none to runtime roles; only the
 * privileged migration identities are exempt. */
const TEMP_FORBIDDEN_ROLES = Object.freeze([PG_ROLES.API_RUNTIME, PG_ROLES.CORE_RUNTIME, PG_ROLES.WORKER_RUNTIME, PG_ROLES.BACKUP_READER, PG_ROLES.AUDIT_RUNTIME]);
/* Predefined membership edges banned for every runtime identity since chain
 * 0026 (parent ruling): backup_reader's pg_read_all_data grant was OBSOLETE
 * AND REVOKED - on 16.15 the NOINHERIT membership was inert for SELECT and
 * blocked pg_dump's LOCK probe; explicit table privileges are the contract. */
const PREDEFINED_BANNED = Object.freeze(['pg_read_all_data', 'pg_write_all_data']);
function forbiddenMemberships(expectedRole) {
 if (PRIVILEGED_ROLES.includes(expectedRole)) return [];
 const extra = PREDEFINED_BANNED.slice();
 // 0026: explicit USAGE/SELECT grants are authoritative; NO runtime identity
 // (backup_reader included) may hold ANY membership edge - predefined-role
 // membership is not a special case anymore, it is the same zero-edge rule.
 return ROLE_NAMES.filter((r) => r !== expectedRole).concat(ADMIN_PRINCIPALS, extra);
}
async function checkCrossRoleMemberships(client, expectedRole, options = {}) {
 const forbidden = forbiddenMemberships(expectedRole);
 if (forbidden.length === 0) return;
 const list = forbidden.map((r) => "'" + String(r).replace(/'/g, "''") + "'").join(',');
 let result;
 try {
  // pg_has_role() RAISES SQLSTATE 42704 for names absent from pg_roles, so
  // the list is existence-filtered first (an absent name cannot be held =>
  // not a member => pass). The predefined pg_* roles DO exist on every PG16
  // and stay banned; only provider-specific names like neon_superuser vary.
  result = await client.query("SELECT pg_catalog.jsonb_object_agg(x.nm, CASE WHEN pr.rolname IS NOT NULL THEN pg_catalog.pg_has_role(current_user, x.nm, 'MEMBER') ELSE false END) AS role_memberships FROM pg_catalog.unnest(ARRAY[" + list + "]::text[]) AS x(nm) LEFT JOIN pg_catalog.pg_roles pr ON pr.rolname = x.nm");
 } catch (error) {
  throw new PgGuardError('ROLE_CHECK_FAILED', { reason: 'cross-membership-probe-failed', message: error && error.message }, error);
 }
 const entries = (result && result.rows && result.rows[0] && result.rows[0].role_memberships) || {};
 for (const role of forbidden) {
  if (!(role in entries)) throw new PgGuardError('ROLE_CHECK_FAILED', { reason: 'cross-membership-probe-incomplete', role });
  if (entries[role] === true) throw new PgGuardError('ROLE_MISMATCH', { expected: expectedRole, role, reason: 'cross-role-membership', ...(options && options.phase ? { phase: options.phase } : {}) }, 'runtime sessions may not hold any other runtime/owner/migrator/superuser principal');
 }
}

/* The role guard required by the P02 design: current_user AND session_user must
 * both equal the expected login role (a SET ROLE drift changes only
 * current_user), the role's grants must actually exist (USAGE sanity, no ambient
 * CREATE for runtime roles), NO cross-role membership capability exists, and
 * the server major is the pinned one. Throws ROLE_MISMATCH before the caller
 * has executed any application query. */
async function assertSessionRole(client, expectedRole, options = {}) {
 if (typeof expectedRole !== 'string' || !ROLE_NAMES.includes(expectedRole)) {
  throw new PgGuardError('ROLE_INVALID', { expected: String(expectedRole) }, 'expected role must be one of ' + ROLE_NAMES.join(','));
 }
 const schemas = Object.freeze([...(options.schemas || ROLE_GRANT_SCHEMAS[expectedRole] || [])]);
 const row = await probeSession(client, schemas);
 checkRoleRow(row, expectedRole, options, schemas);
 await checkCrossRoleMemberships(client, expectedRole);

 return { current_user: row.current_user, session_user: row.session_user, serverVersion: row.server_version };
}

/* Full checkout verification used by createPgPool: one probe proving role,
 * grants AND that the pinned session settings actually landed server-side,
 * plus the fail-closed cross-role membership refusal (no runtime session may
 * hold SET/inherited membership in any other runtime role, the schema owner,
 * the migrator, or neon_superuser - otherwise a post-checkout SET ROLE could
 * elevate inside an otherwise-clean session). */
async function verifySession(client, expectations) {
 const { role, schemas, applicationName, statementTimeoutMs, lockTimeoutMs, idleInTransactionTimeoutMs, searchPath, expectedServerMajor } = expectations;
 if (typeof role !== 'string' || !ROLE_NAMES.includes(role)) throw new PgGuardError('ROLE_INVALID', { role: String(role) });
 const row = await probeSession(client, schemas);
 checkRoleRow(row, role, { expectedServerMajor, phase: expectations.phase }, schemas);
 await checkCrossRoleMemberships(client, role, { phase: expectations.phase });
 const drift = [];
 if (row.application_name !== applicationName) drift.push({ setting: 'application_name', expected: applicationName, observed: row.application_name });
 // Under transaction pooling the POOLED checkout may not be able to bind
 // search_path to a guaranteed backend, so the pool defers ONLY this check
 // to the transaction-open phase (checkSearchPath:false at checkout);
 // everything else stays hard, and nothing strips quotes or loosens the
 // comparison anywhere.
 if (expectations.checkSearchPath !== false
  && String(row.search_path || '').replace(/\s+/g, '') !== searchPath) drift.push({ setting: 'search_path', expected: searchPath, observed: row.search_path });
 // The three timeout GUCs are AUTHORITATIVE only inside the borrowed
 // transaction: a transaction-pooling proxy (verified on actual Neon) may
 // deliver server defaults (0/0/300000) for the session regardless of the
 // startup parameters the driver emits. Enforcement + verification of these
 // values therefore belongs to the transaction-open phase, where
 // withIdempotentTransaction has already pinned them with SET LOCAL; at
 // checkout they are reported informationally without throwing. Identity
 // checks (role/grants/membership/TEMP/version/application_name/search_path)
 // stay hard at BOTH phases - never weakened.
 if (expectations.phase === 'transaction-open') {
  if (row.statement_timeout !== String(statementTimeoutMs)) drift.push({ setting: 'statement_timeout', expected: String(statementTimeoutMs), observed: row.statement_timeout });
  if (row.lock_timeout !== String(lockTimeoutMs)) drift.push({ setting: 'lock_timeout', expected: String(lockTimeoutMs), observed: row.lock_timeout });
  if (row.idle_in_transaction_session_timeout !== String(idleInTransactionTimeoutMs)) drift.push({ setting: 'idle_in_transaction_session_timeout', expected: String(idleInTransactionTimeoutMs), observed: row.idle_in_transaction_session_timeout });
 }
 if (drift.length) throw new PgGuardError('SESSION_SETTINGS_DRIFT', { role, phase: expectations.phase || 'checkout', drift });
 return { role, applicationName, serverVersion: row.server_version };
}

module.exports = {
 PgGuardError,
 PG_ROLES,
 PRIVILEGED_ROLES,
 ROLE_NAMES,
 ROLE_GRANT_SCHEMAS,
 ALL_SCHEMAS,
 ENVIRONMENT_LABELS,
 NONPRODUCTION_LABELS,
 LOCAL_LABELS,
 classifyHint,
 isLoopbackHost,
 extractNeonHint,
 assertEnvironmentCoherence,
 BINDING_LABELS,
 validateTarget,
 loadTargetFile,
 assertTargetBinding,
 targetBudgetIdentity,
 canonicalHost,
 normalizeHost,
 isPoolerHost,
 assertTlsConfig,
 buildApplicationName,
 buildSessionProbe,
 redactUrl,
 assertSessionRole,
 verifySession,
 forbiddenMemberships,
 TEMP_FORBIDDEN_ROLES,
 checkCrossRoleMemberships,
};
