#!/usr/bin/env node
/* scripts/v5/provision-pg-roles.js - V5 P02 runtime LOGIN role provisioning.
 *
 * Contract: local://v5-p02-role-provisioning-contract.md
 * Design inputs: local://v5-p02-schema-design.md sections 4/7, packages/migrations/migrations
 * 0001_roles_bootstrap.sql (the checksummed migrator creates the five runtime roles NOLOGIN/
 * NOINHERIT/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS), 0020-0023 (least-privilege grants).
 *
 * Scope: this tool NEVER creates roles, NEVER grants or revokes memberships, NEVER elevates a
 * role, NEVER drops/truncates anything and NEVER provisions the owner or migration principals.
 * It turns exactly the five migration-created runtime roles into password LOGIN principals,
 * sets their connection limits and persists the resulting credentials privately, outside Git.
 * Roles are expected to already exist (the migrator created them); a missing role is a
 * fail-closed preflight result, not something this tool repairs.
 *
 * Why the ALTER is limited to LOGIN/PASSWORD/CONNECTION LIMIT: on PostgreSQL 16 a CREATEROLE
 * role that is not a superuser may only alter roles it holds ADMIN OPTION on, and may not set
 * the superuser-only attributes (NOSUPERUSER/NOCREATEDB/NOBYPASSRLS/NOREPLICATION) at all. The
 * migrator creates the roles, so migration_owner holds the automatic ADMIN OPTION grant and can
 * flip LOGIN/password/connection limit; the safety attributes are *verified* by preflight
 * (read-only) and anything unsafe is refused rather than "fixed".
 *
 * Actual invocations (nonserving staging, after `node scripts/v5/migrate.js --execute`):
 *
 *   # 1) dry-run (DEFAULT): binds the exact target and runs the read-only posture preflight.
 *   #    Writes nothing, generates nothing, prints no secret.
 *   V5_PG_CA_FILE=/Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/ca.pem \
 *   node scripts/v5/provision-pg-roles.js \
 *     --inventory docs/v5/environments/staging.json \
 *     --credentials /Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/credentials.json \
 *     --output-credentials /Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/runtime-roles.json \
 *     --confirm-target lively-shadow-52629967:br-falling-resonance-b87qm6iz:mega_xo_v5_staging
 *
 *   # 2) execute: persist the generated 0600 credential envelope FIRST, then alter the five
 *   #    roles in one transaction; status becomes 'active' only after COMMIT.
 *   V5_PG_CA_FILE=... node scripts/v5/provision-pg-roles.js <same arguments> --execute
 *
 *   # 3) rerun (explicit resume): the identical command replays the stored passwords verbatim
 *   #    (never regenerated) and is idempotent. A different target/role set/limit set in the
 *   #    existing envelope is refused instead of overwritten.
 *
 *   # 4) production is P22-only and additionally requires --confirm-production.
 *   # 5) --json prints one machine-readable summary object on stdout last (never passwords,
 *   #    never connection URLs, never SQL).
 *
 * Exit codes:
 *   0 OK / dry-run validated         2 config, usage, URL, TLS, confirmation, target, path
 *   3 PREFLIGHT_FAILED (posture)     4 PROVISION_FAILED (DB execute)
 *   5 STATE_ERROR (resume/overwrite/permissions/durability/remint)
 *
 * Secret-path and durability posture: the destination is resolved PHYSICALLY (every ancestor
 * component realpath'd, any symlink ancestor refused), compared against the canonical repository
 * root and forbidden public/artifact segments, and its real parent directory is opened as a
 * descriptor. Envelope creation is O_EXCL + 0600; the file and its containing directory are both
 * fsynced BEFORE any role SQL, and the directory is fsynced again after the atomic active-state
 * rename. A failed durability barrier is STATE_DURABILITY_FAILED and no transaction starts.
 * A missing envelope over roles that are already LOGIN is refused (STATE_MISSING_BUT_LOGIN)
 * instead of silently reminting their passwords.
 *
 * No secret ever reaches stdout/stderr: diagnostics carry role names, counts, non-secret target
 * IDs (project/branch/database/host), SQLSTATE codes and scrubbed error text only.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* Single source of truth for direct TLS-verified connection config: the P02 migration runner's
 * exported parser. It refuses pooler hosts/users, unknown query parameters, missing passwords
 * and non-TLS postures, and returns the exact ssl object node-postgres needs. This tool adds the
 * V5_PG_CA_FILE trust-anchor preference on top; it never installs a no-verify parser. */
const { parseAndGuardUrl } = require('./migrate.js');

const APPLICATION_NAME = 'v5-provision-roles';
const STATE_VERSION = 1;
const SECRET_BYTES = 32; // 256-bit generated secrets
const PG_MAJOR = 16;
const RUNNER_ROLE = 'migration_owner';
const SCHEMA_OWNER = 'v5_owner';
const CONNLIMIT_MAX = 2147483647; // PostgreSQL connlimit is a signed 4-byte integer

const EXIT = { OK: 0, CONFIG: 2, PREFLIGHT: 3, EXECUTE: 4, STATE: 5 };

const ENVIRONMENT_LABELS = ['dev', 'test', 'preview', 'staging', 'production'];
/* Fixed allowlist. Owner/migration principals are deliberately absent: their password material
 * is owner/provider custody, never generated here. */
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime', 'backup_reader', 'audit_runtime'];
/* The migration's runtime roles are NOLOGIN group roles; a runtime session is only accepted when
 * session_user = current_user = the exact runtime role, so these memberships must never exist. */
const FORBIDDEN_MEMBERSHIPS = ['v5_owner', 'migration_owner', 'neon_superuser'];
/* Any membership where one runtime principal is a member of another runtime principal is an
 * elevation path (SET ROLE on a checked-out connection would reach Core's economic/competitive
 * grants) and is refused. Memberships in the owner/migration/neon_superuser principals are
 * likewise refused. This is a read-only refusal: the tool never revokes or repairs. */
const FORBIDDEN_MEMBERSHIP_SUBJECTS = [...RUNTIME_ROLES, ...FORBIDDEN_MEMBERSHIPS];
const V5_SCHEMAS = ['meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
  'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'];
/* Same token families as packages/db/pg/guards.js classifyHint (kept local so this admin tool
 * does not depend on a module owned by another P02 slice). */
const PRODUCTION_TOKENS = ['prod', 'production', 'live'];
const NONPRODUCTION_TOKENS = ['staging', 'stage', 'stg', 'preview', 'preprod', 'qa', 'test', 'testing', 'dev', 'development', 'local', 'ci', 'sandbox'];
/* Canonical repository root (symlinks in the checkout path resolved) so the boundary comparison
 * is physical, not lexical. */
const REPO_ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..'));
const FORBIDDEN_PATH_SEGMENTS = ['public', 'dist', 'coverage', '.github'];

/* ---------------------------------------------------------------------------- diagnostics */

function fail(exitCode, code, detail) {
  const err = new Error(code + (detail ? ': ' + detail : ''));
  err.exitCode = exitCode; err.code = code; err.detail = detail;
  throw err;
}

/* Removes anything that could carry credential material out of free-form text (pg errors can
 * quote the failing statement fragment, which for ALTER ROLE contains the password literal). */
function scrub(text, secrets) {
  let s = String(text == null ? '' : text);
  for (const secret of secrets || []) {
    if (typeof secret === 'string' && secret.length > 0) s = s.split(secret).join('[REDACTED]');
  }
  s = s.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, '[REDACTED_URL]');
  return s.slice(0, 400);
}

function emit(flags, summary, humanLines) {
  if (flags.json) process.stdout.write(JSON.stringify(summary) + '\n');
  else for (const line of humanLines || []) process.stdout.write(line + '\n');
}

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const start = src.indexOf('/*');
  const end = src.indexOf('*/', start);
  process.stdout.write(src.slice(start, end + 2) + '\n');
}

/* ---------------------------------------------------------------------------- file plumbing */

function readJsonFile(file, exitCode, codeBase, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { fail(exitCode, codeBase + '_UNREADABLE', `${label} cannot be read (${file})`); }
  let doc;
  try { doc = JSON.parse(raw); }
  catch { fail(exitCode, codeBase + '_INVALID', `${label} is not valid JSON (${file})`); }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail(exitCode, codeBase + '_INVALID', `${label} must be a JSON object (${file})`);
  }
  return doc;
}

function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/* Resolves a supplied path PHYSICALLY, refusing user symlink ancestors while preserving the
 * documented macOS filesystem aliases (/var, /tmp, /etc -> /private/...). A top-level component
 * is treated as an OS alias only when its real target is the same basename directly under
 * /private; every other symlink component is refused, so a link cannot hide a destination inside
 * the checkout or a public/artifact tree. The final leaf may be absent (fresh output), in which
 * case its parent must be a real directory. */
const OS_ALIAS_ROOT = path.sep + 'private';
function canonicalizePhysical(absPath, label) {
  const root = path.parse(absPath).root;
  const parts = absPath.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    const next = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(next); }
    catch {
      if (i === parts.length - 1) return { canonical: next, exists: false, stat: null };
      fail(EXIT.CONFIG, 'OUTPUT_PATH_UNRESOLVABLE', `${label} traverses a missing directory (${next})`);
    }
    if (stat.isSymbolicLink()) {
      let real = null;
      try { real = fs.realpathSync(next); } catch { /* dangling */ }
      const isOsAlias = real !== null && path.dirname(real) === OS_ALIAS_ROOT && path.basename(real) === parts[i];
      if (!isOsAlias) {
        fail(EXIT.CONFIG, 'PATH_SYMLINK_REFUSED', `${label} must not be reached (or given) through a symlink (${next})`);
      }
      current = real;
      continue;
    }
    current = next;
  }
  return { canonical: current, exists: true, stat: fs.lstatSync(current) };
}

/* Private-path policy for every file that holds or receives secret material: its CANONICAL
 * destination must be outside the canonical repository tree and outside public/CI artifact
 * segments, with no symlinked ancestor, a real private (no group/other bits) parent directory,
 * and a 0600 regular file. Returns descriptors to re-verify against the realpath'd directory. */
function assertPrivateFileTarget(absPath, label, { mustExist }) {
  const resolved = canonicalizePhysical(path.resolve(absPath), label);
  const canonical = resolved.canonical;
  if (canonical === REPO_ROOT || canonical.startsWith(REPO_ROOT + path.sep)) {
    fail(EXIT.CONFIG, 'OUTPUT_PATH_NOT_PRIVATE', `${label} must resolve outside the repository tree; secrets never enter Git (${canonical})`);
  }
  const segments = canonical.split(path.sep);
  const bad = FORBIDDEN_PATH_SEGMENTS.find((seg) => segments.includes(seg));
  if (bad) fail(EXIT.CONFIG, 'OUTPUT_PATH_NOT_PRIVATE', `${label} must not live under a '${bad}' segment (public/CI artifacts never hold secrets)`);

  const parent = path.dirname(canonical);
  const parentResolved = canonicalizePhysical(parent, label + ' parent');
  if (!parentResolved.exists || !parentResolved.stat.isDirectory()) {
    fail(EXIT.CONFIG, 'OUTPUT_DIR_MISSING', `${label} parent directory does not exist (${parent})`);
  }
  if ((parentResolved.stat.mode & 0o077) !== 0) {
    fail(EXIT.CONFIG, 'OUTPUT_DIR_NOT_PRIVATE', `${label} parent directory is group/other accessible; chmod 700 it (${parentResolved.canonical})`);
  }

  const canonicalDir = parentResolved.canonical;
  const canonicalFile = path.join(canonicalDir, path.basename(canonical));

  if (resolved.exists) {
    if (!resolved.stat.isFile()) fail(EXIT.CONFIG, 'OUTPUT_SYMLINK_REFUSED', `${label} must be a regular file (${canonical})`);
    if ((resolved.stat.mode & 0o077) !== 0) fail(EXIT.CONFIG, 'INSECURE_PERMISSIONS', `${label} is group/other accessible; chmod 600 it (${canonical})`);
  } else if (mustExist) {
    fail(EXIT.CONFIG, 'INVENTORY_OR_CREDENTIALS_MISSING', `${label} does not exist (${canonical})`);
  }
  return {
    canonicalDir,
    canonicalFile,
    exists: resolved.exists,
    // Open directory descriptor: pins the realpath'd parent and provides the durability barrier.
    dirFd: fs.openSync(canonicalDir, 'r'),
  };
}

/* Re-verifies, against the realpath'd directory, that the bound destination is exactly the file
 * we are about to write -- so a path component swapped after the checks cannot redirect the
 * secret. Called immediately before every secret write and rename. */
function assertBindingStable(target, label) {
  const stat = fs.lstatSync(target.canonicalFile);
  if (!stat.isFile()) fail(EXIT.STATE, 'OUTPUT_SYMLINK_REFUSED', `${label} changed type under the bound path; refusing to write`);
  return stat;
}

/* Durability barrier: fsync the containing directory so the new/renamed entry survives a host
 * crash. A failure here is a state error and the caller MUST NOT begin role SQL. */
function fsyncDirectory(target, label) {
  try { fs.fsyncSync(target.dirFd); }
  catch (err) { fail(EXIT.STATE, 'STATE_DURABILITY_FAILED', `${label} directory could not be fsynced (${scrub(err && err.message)}); no database transaction was started`); }
}

function writePrivateExclusive(target, text, secrets) {
  let fd;
  try { fd = fs.openSync(target.canonicalFile, 'wx', 0o600); } // O_CREAT|O_EXCL: never clobbers content
  catch (err) {
    const code = err && err.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'STATE_WRITE_FAILED';
    fail(EXIT.STATE, code, `refusing to overwrite ${target.canonicalFile} (${scrub(err && err.message, secrets)})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail(EXIT.STATE, 'OUTPUT_SYMLINK_REFUSED', 'the opened descriptor is not a regular file');
    fs.writeSync(fd, text);
    fs.fsyncSync(fd); // file content durable before the directory entry
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(target.canonicalFile, 0o600);
  fsyncDirectory(target, 'credential envelope');
}

/* Status is only ever advanced to 'active' by replacing the file we own, atomically, 0600. */
function writePrivateReplace(target, text, secrets) {
  const tmp = `${target.canonicalFile}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target.canonicalFile);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to remove */ }
    fail(EXIT.STATE, 'STATE_WRITE_FAILED', `could not update ${target.canonicalFile} (${scrub(err && err.message, secrets)})`);
  }
  fsyncDirectory(target, 'credential envelope');
}

/* ---------------------------------------------------------------------------- metadata */

function tokensOf(value) { return String(value == null ? '' : value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
function carriesToken(value, list) { return tokensOf(value).some((t) => list.includes(t)); }

function requireString(doc, key, codeBase, label) {
  if (typeof doc[key] !== 'string' || doc[key].length === 0) {
    fail(EXIT.CONFIG, codeBase + '_INVALID', `${label}.${key} is required and must be a non-empty string`);
  }
  return doc[key];
}

function loadInventory(file) {
  const doc = readJsonFile(file, EXIT.CONFIG, 'INVENTORY', 'inventory');
  if (doc.version !== STATE_VERSION) fail(EXIT.CONFIG, 'INVENTORY_INVALID', `inventory.version must be ${STATE_VERSION}`);
  const environment = requireString(doc, 'environment', 'ENV_METADATA_UNKNOWN', 'inventory');
  if (!ENVIRONMENT_LABELS.includes(environment)) {
    fail(EXIT.CONFIG, 'ENV_METADATA_UNKNOWN', `inventory.environment '${environment}' is not one of ${ENVIRONMENT_LABELS.join('|')}`);
  }
  const projectId = requireString(doc, 'projectId', 'INVENTORY_INVALID', 'inventory');
  const branchId = requireString(doc, 'branchId', 'INVENTORY_INVALID', 'inventory');
  const endpointId = requireString(doc, 'endpointId', 'INVENTORY_INVALID', 'inventory');
  const host = requireString(doc, 'host', 'INVENTORY_INVALID', 'inventory');
  const database = requireString(doc, 'database', 'INVENTORY_INVALID', 'inventory');
  if (doc.pgMajor !== PG_MAJOR) {
    fail(EXIT.CONFIG, 'INVENTORY_INVALID', `inventory.pgMajor must be ${PG_MAJOR} (this tool pins the P02 target version)`);
  }
  if (environment !== 'production' && doc.nonserving !== true) {
    fail(EXIT.CONFIG, 'ENV_NOT_NONSERVING', `inventory.nonserving must be true for a ${environment} bootstrap target; refusing a serving target`);
  }
  if (/pooler/i.test(host)) {
    fail(EXIT.CONFIG, 'POOLED_HOST_REFUSED', 'inventory.host is a pooled endpoint; runtime provisioning binds the DIRECT endpoint');
  }
  const firstLabel = host.split('.')[0];
  if (/^ep-[a-z0-9-]+$/.test(firstLabel) && firstLabel !== endpointId) {
    fail(EXIT.CONFIG, 'ENV_METADATA_INCOHERENT', `inventory.host belongs to endpoint '${firstLabel}' but inventory.endpointId is '${endpointId}' (stale inventory)`);
  }
  const isProduction = environment === 'production';
  for (const [field, value] of [['database', database], ['host', host], ['projectId', projectId]]) {
    if (isProduction && carriesToken(value, NONPRODUCTION_TOKENS)) {
      fail(EXIT.CONFIG, 'ENV_METADATA_INCOHERENT', `inventory ${field} carries a non-production token while environment is 'production'`);
    }
    if (!isProduction && carriesToken(value, PRODUCTION_TOKENS)) {
      fail(EXIT.CONFIG, 'ENV_METADATA_INCOHERENT', `inventory ${field} carries a production token while environment is '${environment}'`);
    }
  }
  const limits = doc.roleConnectionLimits;
  if (!isPlainObject(limits)) fail(EXIT.CONFIG, 'INVENTORY_INVALID', 'inventory.roleConnectionLimits must be an object');
  const keys = Object.keys(limits);
  for (const key of keys) {
    if (!RUNTIME_ROLES.includes(key)) {
      fail(EXIT.CONFIG, 'INVENTORY_INVALID', `inventory.roleConnectionLimits.${key} is outside the fixed role allowlist (${RUNTIME_ROLES.join(', ')})`);
    }
    const value = limits[key];
    if (!Number.isInteger(value) || value < 1 || value > CONNLIMIT_MAX) {
      fail(EXIT.CONFIG, 'INVENTORY_INVALID', `inventory.roleConnectionLimits.${key} must be an integer between 1 and ${CONNLIMIT_MAX}`);
    }
  }
  for (const role of RUNTIME_ROLES) {
    if (!(role in limits)) fail(EXIT.CONFIG, 'INVENTORY_INVALID', `inventory.roleConnectionLimits.${role} is required`);
  }
  return { environment, projectId, branchId, endpointId, host, database, nonserving: doc.nonserving === true, roleConnectionLimits: limits };
}

function loadCredentials(file) {
  const binding = assertPrivateFileTarget(file, 'credentials input', { mustExist: true });
  const doc = readJsonFile(binding.canonicalFile, EXIT.CONFIG, 'CREDENTIALS', 'credentials');
  for (const key of ['project', 'branch', 'database', 'migration_url']) {
    requireString(doc, key, 'CREDENTIALS', 'credentials');
  }
  return { file: binding.canonicalFile, project: doc.project, branch: doc.branch, database: doc.database, migrationUrl: doc.migration_url };
}

/* The parser's ssl object is preserved; V5_PG_CA_FILE is preferred as an explicit trust anchor
 * when the URL carries no sslrootcert. A URL-derived no-verify posture (sslmode=require) is
 * refused, and so is a missing anchor -- the only no-TLS path is the migration runner's own
 * explicit loopback escape, further narrowed here to dev/test inventory on a loopback host. */
function resolveTls(cfg, environment) {
  const urlCa = cfg.ssl && Array.isArray(cfg.ssl.ca) && cfg.ssl.ca.length > 0 ? cfg.ssl.ca[0] : null;
  if (urlCa) return { ssl: { ca: [urlCa], rejectUnauthorized: true }, caSource: 'url-sslrootcert' };
  const envCaPath = (process.env.V5_PG_CA_FILE || '').trim();
  if (envCaPath) {
    const resolved = path.resolve(envCaPath);
    let pem;
    try { pem = fs.readFileSync(resolved, 'utf8'); }
    catch { fail(EXIT.CONFIG, 'CA_FILE_INVALID', `V5_PG_CA_FILE cannot be read (${resolved})`); }
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) fail(EXIT.CONFIG, 'CA_FILE_INVALID', 'V5_PG_CA_FILE is not a PEM certificate bundle');
    return { ssl: { ca: [pem], rejectUnauthorized: true }, caSource: 'env-V5_PG_CA_FILE' };
  }
  if (cfg.ssl === false) {
    // parseAndGuardUrl already refused this unless the host is loopback with
    // V5_MIGRATE_ALLOW_INSECURE_LOOPBACK=1 and a non-production classification; this tool
    // narrows it further to a local dev/test inventory. Real Neon targets are verify-full.
    const loopback = cfg.host === 'localhost' || cfg.host === '::1' || /^127(\.\d{1,3}){3}$/.test(cfg.host);
    if (loopback && (environment === 'dev' || environment === 'test')) {
      return { ssl: false, caSource: 'loopback-no-tls' };
    }
    fail(EXIT.CONFIG, 'TLS_VERIFICATION_REQUIRED', 'TLS is mandatory for runtime provisioning; the loopback escape is limited to a dev/test inventory');
  }
  if (!cfg.ssl) fail(EXIT.CONFIG, 'TLS_VERIFICATION_REQUIRED', 'TLS is mandatory for runtime provisioning');
  if (cfg.ssl.rejectUnauthorized !== true) {
    fail(EXIT.CONFIG, 'TLS_VERIFICATION_REQUIRED', 'the migration URL does not verify the server certificate (sslmode=require); use sslmode=verify-full, sslrootcert=... or V5_PG_CA_FILE');
  }
  return { ssl: cfg.ssl, caSource: 'system-roots' };
}

/* Channel binding. The shared parser (scripts/v5/migrate.js parseAndGuardUrl) validates and
 * surfaces the URI's channel_binding value as cfg.channelBinding ('require'|'prefer'|'disable'
 * or 'absent'). pg 8.23.1 implements SCRAM-SHA-256-PLUS (p=tls-server-end-point, see
 * pg/lib/crypto/sasl.js) gated by the client option `enableChannelBinding`; pg-connection-string
 * does not map the URL key, so the value is acted on EXPLICITLY and never stripped:
 * require|prefer -> enableChannelBinding true, disable/absent -> false. For `require`, a minimal
 * connection observer captures the negotiated mechanism and the tool FAILS CLOSED after connect
 * and before any role SQL unless it is exactly SCRAM-SHA-256-PLUS (`prefer` negotiates
 * opportunistically). TLS verification itself is untouched (sslmode=verify-full). */
const CHANNEL_BINDING_VALUES = ['require', 'prefer', 'disable', 'absent'];
function resolveChannelBinding(parsedValue, secrets) {
  const value = parsedValue === undefined || parsedValue === null ? 'absent' : String(parsedValue).toLowerCase();
  if (!CHANNEL_BINDING_VALUES.includes(value)) {
    fail(EXIT.CONFIG, 'CHANNEL_BINDING_INVALID', `channel_binding '${scrub(value, secrets)}' is not one of ${CHANNEL_BINDING_VALUES.join('|')}`);
  }
  return { requested: value, enableChannelBinding: value === 'require' || value === 'prefer' };
}

function bindTarget(inv, cred, cfg, confirmTarget) {
  const expected = `${inv.projectId}:${inv.branchId}:${inv.database}`;
  if (typeof confirmTarget !== 'string' || confirmTarget !== expected) {
    fail(EXIT.CONFIG, 'CONFIRMATION_REQUIRED', `--confirm-target must be exactly '${expected}' (project:branch:database)`);
  }
  if (cred.project !== inv.projectId) fail(EXIT.CONFIG, 'TARGET_MISMATCH', `credentials.project '${cred.project}' does not match inventory.projectId '${inv.projectId}'`);
  if (cred.branch !== inv.branchId) fail(EXIT.CONFIG, 'TARGET_MISMATCH', `credentials.branch '${cred.branch}' does not match inventory.branchId '${inv.branchId}'`);
  if (cred.database !== inv.database) fail(EXIT.CONFIG, 'TARGET_MISMATCH', `credentials.database '${cred.database}' does not match inventory.database '${inv.database}'`);
  if (cfg.database !== inv.database) fail(EXIT.CONFIG, 'TARGET_MISMATCH', `the migration URL database does not match inventory.database '${inv.database}'`);
  if (cfg.host !== inv.host) fail(EXIT.CONFIG, 'TARGET_MISMATCH', `the migration URL host does not match inventory.host '${inv.host}'`);
}

/* ---------------------------------------------------------------------------- state envelope */

function derivePooledHost(host) {
  if (!/(^|\.)neon\.tech$/i.test(host)) return null; // only Neon exposes the '-pooler' endpoint convention
  const m = /^([^.]+)\.(.+)$/.exec(host);
  if (!m) return null;
  return `${m[1]}-pooler.${m[2]}`;
}

function buildRoleUrls(inv, role, password) {
  const user = encodeURIComponent(role);
  const secret = encodeURIComponent(password);
  const db = encodeURIComponent(inv.database);
  const direct = `postgresql://${user}:${secret}@${inv.host}/${db}?sslmode=verify-full`;
  const pooledHost = derivePooledHost(inv.host);
  const pooled = pooledHost ? `postgresql://${user}:${secret}@${pooledHost}/${db}?sslmode=verify-full` : null;
  return { directUrl: direct, pooledUrl: pooled };
}

/* Fresh envelope: one 256-bit secret per allowlisted role, with the direct/pooled connection
 * URLs derived from the bound inventory (the pooled URL is the Neon '-pooler' sibling host and
 * is null when the host is not a Neon endpoint). */
function buildFreshState(inv) {
  const roles = {};
  for (const role of RUNTIME_ROLES) {
    const password = crypto.randomBytes(SECRET_BYTES).toString('base64url');
    roles[role] = Object.assign(
      { password, connectionLimit: inv.roleConnectionLimits[role] },
      buildRoleUrls(inv, role, password),
    );
  }
  return { version: STATE_VERSION, project: inv.projectId, branch: inv.branchId, database: inv.database, host: inv.host, status: 'prepared', updated_at: new Date().toISOString(), roles };
}

function advanceToActive(state) {
  return Object.assign({}, state, { status: 'active', updated_at: new Date().toISOString() });
}

/* Every secret this process must keep out of any diagnostic: the admin URL password, the admin
 * URL itself, and each generated/stored role password. */
function collectSecrets(cfg, state) {
  const secrets = [cfg.password, cfg.user, cfg.host].filter((v) => typeof v === 'string' && v.length > 0);
  for (const role of RUNTIME_ROLES) {
    const password = state.roles[role] && state.roles[role].password;
    if (typeof password === 'string' && password.length > 0) secrets.push(password);
  }
  return secrets;
}

/* Resume: an existing envelope must describe this exact target, this exact role set and these
 * exact limits, otherwise the tool refuses to touch it (no unknown overwrite, no silent
 * credential rotation of an unrelated environment). */
function loadStateForResume(binding, inv) {
  const file = binding.canonicalFile;
  if (!binding.exists) return null;
  const stat = fs.lstatSync(file);
  if ((stat.mode & 0o077) !== 0) fail(EXIT.STATE, 'INSECURE_PERMISSIONS', `existing credential envelope is group/other accessible; chmod 600 it (${file})`);
  const doc = readJsonFile(file, EXIT.STATE, 'STATE', 'credential envelope');
  if (doc.version !== STATE_VERSION) fail(EXIT.STATE, 'STATE_TARGET_MISMATCH', `existing envelope version ${String(doc.version)} is not ${STATE_VERSION}`);
  if (doc.project !== inv.projectId || doc.branch !== inv.branchId || doc.database !== inv.database || doc.host !== inv.host) {
    fail(EXIT.STATE, 'STATE_TARGET_MISMATCH', 'existing credential envelope belongs to a different project/branch/database/host; refusing to overwrite it');
  }
  if (doc.status !== 'prepared' && doc.status !== 'active') {
    fail(EXIT.STATE, 'STATE_ROLES_MISMATCH', `existing envelope status '${String(doc.status)}' is not prepared|active`);
  }
  if (!isPlainObject(doc.roles)) fail(EXIT.STATE, 'STATE_ROLES_MISMATCH', 'existing envelope has no roles object');
  const found = Object.keys(doc.roles).sort().join(',');
  if (found !== [...RUNTIME_ROLES].sort().join(',')) {
    fail(EXIT.STATE, 'STATE_ROLES_MISMATCH', 'existing envelope role set differs from the fixed runtime allowlist; refusing to reuse or overwrite it');
  }
  for (const role of RUNTIME_ROLES) {
    const entry = doc.roles[role];
    if (!isPlainObject(entry) || typeof entry.password !== 'string' || entry.password.length === 0) {
      fail(EXIT.STATE, 'STATE_ROLES_MISMATCH', `existing envelope role ${role} has no usable stored password`);
    }
    if (entry.connectionLimit !== inv.roleConnectionLimits[role]) {
      fail(EXIT.STATE, 'STATE_LIMITS_MISMATCH', `existing envelope connection limit for ${role} differs from the inventory; refusing an implicit posture change`);
    }
  }
  return doc;
}

/* ---------------------------------------------------------------------------- database */

function clientConfig(cfg, tls, channelBinding) {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: tls.ssl,
    enableChannelBinding: channelBinding.enableChannelBinding,
    application_name: APPLICATION_NAME,
    connectionTimeoutMillis: 10000,
  };
}

/* Minimal, fork-free connection authentication observer: attaches to the pg connection's own
 * events BEFORE connect and retains ONLY the negotiated SASL mechanism string. It never reads or
 * keeps the nonce, server challenge, password, or session material. Returns an observed object
 * mutated in place so the caller can enforce the channel-binding posture after connect. */
function observeConnectionAuth(client) {
  const observed = { mechanismsOffered: null, mechanism: null, sawSASLContinue: false, sawSASLFinal: false };
  const connection = client.connection;
  if (!connection || typeof connection.on !== 'function') return observed;
  connection.on('authenticationSASL', (msg) => {
    observed.mechanismsOffered = Array.isArray(msg && msg.mechanisms)
      ? msg.mechanisms.filter((m) => typeof m === 'string')
      : null;
  });
  connection.on('authenticationSASLContinue', () => {
    observed.sawSASLContinue = true;
    const session = client.saslSession;
    if (session && typeof session.mechanism === 'string') observed.mechanism = session.mechanism; // string only
  });
  connection.on('authenticationSASLFinal', () => { observed.sawSASLFinal = true; });
  return observed;
}

/* require -> the negotiated mechanism MUST be SCRAM-SHA-256-PLUS, else fail closed and close;
 * prefer -> opportunistic (no failure). Called after connect and BEFORE any role SQL. The code
 * matches scripts/v5/migrate.js's enforced-binding failure so both tools fail identically. */
function enforceChannelBinding(observed, channelBinding) {
  if (channelBinding.requested !== 'require') return;
  if (observed.mechanism !== 'SCRAM-SHA-256-PLUS') {
    fail(EXIT.CONFIG, 'CHANNEL_BINDING_REQUIRED',
      `channel_binding=require was requested but the server negotiated '${observed.mechanism || (observed.sawSASLContinue ? 'unknown' : 'no SASL authentication')}'; refusing to proceed without SCRAM-SHA-256-PLUS`);
  }
}

async function connect(clientCfg, secrets, channelBinding) {
  const { Client } = require('pg');
  const client = new Client(clientCfg);
  // Observer attached before connect: retains only the mechanism string.
  const observed = observeConnectionAuth(client);
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* not connected */ }
    fail(EXIT.CONFIG, 'DB_CONNECT_FAILED', `could not open a direct TLS session (${scrub(err && err.message, secrets)})`);
  }
  try {
    enforceChannelBinding(observed, channelBinding);
  } catch (err) {
    try { await client.end(); } catch { /* closed */ }
    throw err;
  }
  return { client, observed };
}

async function preflight(client, inv) {
  const failures = [];
  const session = (await client.query(
    `SELECT session_user::text AS session_user, current_user::text AS current_user,
            current_database() AS database, current_setting('server_version_num')::int AS version_num`,
  )).rows[0];
  if (session.session_user !== RUNNER_ROLE) {
    failures.push(`RUNNER_ROLE_NOT_EXACT:session_user=${session.session_user}`);
  }
  if (session.current_user !== session.session_user) {
    failures.push('SESSION_ROLE_DRIFT:current_user differs from session_user (SET ROLE is not permitted)');
  }
  if (session.database !== inv.database) failures.push(`DATABASE_MISMATCH:current_database=${session.database}`);
  if (Math.floor(session.version_num / 10000) !== PG_MAJOR) failures.push(`PG_MAJOR_MISMATCH:server_version_num=${session.version_num}`);

  const schemas = (await client.query(
    'SELECT n.nspname::text AS name, pg_get_userbyid(n.nspowner)::text AS owner FROM pg_namespace n WHERE n.nspname = ANY($1::text[])',
    [V5_SCHEMAS],
  )).rows;
  const owners = new Map(schemas.map((row) => [row.name, row.owner]));
  for (const schema of V5_SCHEMAS) {
    if (!owners.has(schema)) failures.push(`SCHEMA_MISSING:${schema}`);
    else if (owners.get(schema) !== SCHEMA_OWNER) failures.push(`SCHEMA_OWNER_MISMATCH:${schema}:${owners.get(schema)}`);
  }
  const ledger = (await client.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meta' AND c.relname = 'migrations' AND c.relkind = 'r'`,
  )).rows[0];
  if (!ledger || ledger.n !== 1) failures.push('LEDGER_MISSING:meta.migrations');

  const roleRows = (await client.query(
    `SELECT rolname::text AS name, rolcanlogin, rolconnlimit, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [RUNTIME_ROLES],
  )).rows;
  const posture = new Map(roleRows.map((row) => [row.name, row]));
  for (const role of RUNTIME_ROLES) {
    const row = posture.get(role);
    if (!row) { failures.push(`ROLE_MISSING:${role}`); continue; }
    const unsafe = [];
    if (row.rolsuper) unsafe.push('SUPERUSER');
    if (row.rolcreaterole) unsafe.push('CREATEROLE');
    if (row.rolcreatedb) unsafe.push('CREATEDB');
    if (row.rolbypassrls) unsafe.push('BYPASSRLS');
    if (unsafe.length > 0) failures.push(`ROLE_POSTURE_UNSAFE:${role}:${unsafe.join('+')}`);
  }
  const memberships = (await client.query(
    `SELECT r.rolname::text AS member, f.rolname::text AS granted_role, pg_has_role(r.oid, f.oid, 'MEMBER') AS is_member
       FROM (SELECT oid, rolname FROM pg_roles WHERE rolname = ANY($1::text[])) r
       CROSS JOIN (SELECT oid, rolname FROM pg_roles WHERE rolname = ANY($2::text[])) f
      WHERE r.oid <> f.oid`, // every role is trivially a member of itself; only real edges count
    [RUNTIME_ROLES, FORBIDDEN_MEMBERSHIP_SUBJECTS],
  )).rows;
  for (const row of memberships) {
    if (row.is_member) failures.push(`ROLE_MEMBERSHIP_FORBIDDEN:${row.member}:${row.granted_role}`);
  }

  /* On PG16 a CREATEROLE runner may only alter roles it has ADMIN OPTION on (a superuser may
   * alter any role). The migrator creates these roles, so migration_owner normally holds the
   * automatic ADMIN OPTION grant; a target where the roles were created some other way (e.g. a
   * provider-managed principal, or a bootstrap that ran as a different role) is NOT
   * administerable and must be refused here rather than "fixed". */
  const sessionSuper = (await client.query(
    "SELECT COALESCE(rolsuper, false) AS is_super FROM pg_roles WHERE rolname = session_user",
  )).rows[0].is_super === true;
  const adminOptions = (await client.query(
    `SELECT r.rolname::text AS name, COALESCE(am.admin_option, false) AS admin_option
       FROM pg_roles r
       LEFT JOIN pg_auth_members am ON am.roleid = r.oid AND am.member = (SELECT oid FROM pg_roles WHERE rolname = session_user)
      WHERE r.rolname = ANY($1::text[])`,
    [RUNTIME_ROLES],
  )).rows;
  const administerable = new Map(adminOptions.map((row) => [row.name, row.admin_option === true]));
  if (!sessionSuper) {
    for (const role of RUNTIME_ROLES) {
      if (posture.has(role) && administerable.get(role) !== true) failures.push(`ROLE_NOT_ADMINISTERABLE:${role}`);
    }
  }
  return {
    failures,
    sessionSuper,
    posture: RUNTIME_ROLES.map((role) => {
      const row = posture.get(role) || null;
      return {
        role,
        present: Boolean(row),
        login: row ? row.rolcanlogin === true : null,
        connectionLimit: row ? row.rolconnlimit : null,
        inherit: row ? row.rolinherit === true : null,
      };
    }),
  };
}

function planRoles(posture, inv) {
  return posture.map((row) => ({
    role: row.role,
    action: 'alter-role',
    loginNow: row.login,
    connectionLimitNow: row.connectionLimit,
    loginTarget: true,
    connectionLimitTarget: inv.roleConnectionLimits[row.role],
  }));
}

/* ALTER ROLE cannot take a protocol bind parameter, so the statement is built with format()'s
 * %I/%L quoting *server-side* from bind parameters: the client never interpolates a role name or
 * a password into SQL text, and the resulting statement is never logged by this tool. */
async function provisionRoles(client, inv, stored, secrets) {
  const altered = [];
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '20s'");
    for (const role of RUNTIME_ROLES) {
      let stmt;
      try {
        stmt = (await client.query(
          "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L CONNECTION LIMIT %s', $1::text, $2::text, $3::int) AS stmt",
          [role, stored.roles[role].password, inv.roleConnectionLimits[role]],
        )).rows[0].stmt;
        await client.query(stmt);
      } catch (err) {
        fail(EXIT.EXECUTE, 'PROVISION_FAILED', [role, err && err.code ? `SQLSTATE ${err.code}` : null, scrub(err && err.message, secrets)].filter(Boolean).join(' '));
      }
      altered.push(role);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* aborted */ }
    throw err;
  }
  return altered;
}

async function readPosture(client) {
  const rows = (await client.query(
    'SELECT rolname::text AS name, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = ANY($1::text[])',
    [RUNTIME_ROLES],
  )).rows;
  const byName = new Map(rows.map((row) => [row.name, row]));
  return RUNTIME_ROLES.map((role) => {
    const row = byName.get(role) || null;
    return { role, login: row ? row.rolcanlogin === true : false, connectionLimit: row ? row.rolconnlimit : null };
  });
}

/* ---------------------------------------------------------------------------- cli */

function parseArgs(argv) {
  const flags = {
    mode: 'dry-run', json: false, help: false, execute: false, confirmProduction: false,
    inventory: null, credentials: null, confirmTarget: null, outputCredentials: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--execute': flags.execute = true; flags.mode = 'execute'; break;
      case '--dry-run': flags.execute = false; flags.mode = 'dry-run'; break;
      case '--confirm-production': flags.confirmProduction = true; break;
      case '--json': flags.json = true; break;
      case '--help': case '-h': flags.help = true; break;
      case '--inventory': flags.inventory = argv[++i]; break;
      case '--credentials': flags.credentials = argv[++i]; break;
      case '--confirm-target': flags.confirmTarget = argv[++i]; break;
      case '--output-credentials': flags.outputCredentials = argv[++i]; break;
      default:
        if (arg.startsWith('--inventory=')) flags.inventory = arg.slice('--inventory='.length);
        else if (arg.startsWith('--credentials=')) flags.credentials = arg.slice('--credentials='.length);
        else if (arg.startsWith('--confirm-target=')) flags.confirmTarget = arg.slice('--confirm-target='.length);
        else if (arg.startsWith('--output-credentials=')) flags.outputCredentials = arg.slice('--output-credentials='.length);
        else fail(EXIT.CONFIG, 'CONFIG_ERROR', `unknown argument '${arg}' (see --help)`);
    }
  }
  return flags;
}

function requireFlag(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(EXIT.CONFIG, 'CONFIG_ERROR', `${name} is required`);
  return value;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { printHelp(); return EXIT.OK; }

  const inventoryFile = requireFlag(flags.inventory, '--inventory <nonsecretJSON>');
  const credentialsFile = requireFlag(flags.credentials, '--credentials <privateJSON>');
  const confirmTarget = requireFlag(flags.confirmTarget, '--confirm-target <project:branch:database>');

  const inv = loadInventory(inventoryFile);
  const cred = loadCredentials(credentialsFile);

  /* The production gate is evaluated before any connection material is examined so an
   * unauthorized production run fails on the missing confirmation, not on a TLS detail. */
  if (flags.execute && inv.environment === 'production' && !flags.confirmProduction) {
    fail(EXIT.CONFIG, 'PRODUCTION_CONFIRMATION_REQUIRED', 'production execution requires --confirm-production (P22 only)');
  }

  /* Direct TLS-verified config, reused from the migration runner's parser (pooler hosts/users,
   * unknown query parameters and non-TLS postures are refused there). */
  let cfg;
  try {
    cfg = parseAndGuardUrl(cred.migrationUrl, { production: inv.environment === 'production' });
  } catch (err) {
    if (err && err.exitCode) fail(EXIT.CONFIG, err.code || 'DATABASE_URL_INVALID', err.detail || scrub(err.message));
    throw err;
  }
  const tls = resolveTls(cfg, inv.environment);
  const channelBinding = resolveChannelBinding(cfg.channelBinding, [cfg.password]);
  bindTarget(inv, cred, cfg, confirmTarget);

  if (flags.execute && !flags.outputCredentials) {
    fail(EXIT.CONFIG, 'CONFIG_ERROR', '--execute requires --output-credentials <privateJSON> so generated secrets are persisted before the database transaction');
  }

  const target = {
    project: inv.projectId, branch: inv.branchId, database: inv.database,
    host: inv.host, endpointId: inv.endpointId, environment: inv.environment,
  };
  const baseSummary = {
    tool: 'v5-provision-pg-roles', mode: flags.mode, target,
    tls: { verified: true, caSource: tls.caSource },
    channelBinding: { requested: channelBinding.requested, enableChannelBinding: channelBinding.enableChannelBinding },
  };

  /* Credential envelope location: canonical private binding, outside the repo, 0600, never a
   * symlink at the leaf or any ancestor, with an open directory descriptor for durability. */
  const output = flags.outputCredentials ? assertPrivateFileTarget(flags.outputCredentials, 'output credentials', { mustExist: false }) : null;
  const outputFile = output ? output.canonicalFile : null;
  const stored = output ? loadStateForResume(output, inv) : null;
  const resumed = stored !== null;

  const clientCfg = clientConfig(cfg, tls, channelBinding);
  const { client, observed } = await connect(clientCfg, [cfg.password, cfg.user, cfg.host, cred.migrationUrl].filter(Boolean), channelBinding);
  baseSummary.channelBinding = {
    requested: channelBinding.requested,
    enableChannelBinding: channelBinding.enableChannelBinding,
    negotiatedMechanism: observed.mechanism,
  };
  let result;
  try {
    const pre = await preflight(client, inv);
    if (pre.failures.length > 0) {
      emit(flags, Object.assign({}, baseSummary, {
        ok: false, code: 'PREFLIGHT_FAILED', resumed, status: stored ? stored.status : null,
        roles: pre.posture, failures: pre.failures, counts: { roles: RUNTIME_ROLES.length, altered: 0 },
      }), ['preflight failed:', ...pre.failures.map((f) => '  ' + f)]);
      return EXIT.PREFLIGHT;
    }

    /* A missing envelope over roles that are ALREADY LOGIN means a prior run's secrets were lost
     * (or live elsewhere): reminting would silently rotate credentials that existing services
     * hold. Refuse instead of rotating; the operator must remove LOGIN or supply the envelope. */
    if (flags.execute && output && !resumed) {
      const liveLogin = pre.posture.filter((row) => row.present && row.login === true).map((row) => row.role);
      if (liveLogin.length > 0) {
        fail(EXIT.STATE, 'STATE_MISSING_BUT_LOGIN', `${outputFile} is absent for this target but ${liveLogin.join(', ')} ${liveLogin.length === 1 ? 'is' : 'are'} already LOGIN; refusing to remint passwords without the stored secrets. Remove LOGIN from those roles or restore the credential envelope, then rerun.`);
      }
    }

    if (!flags.execute) {
      const planned = planRoles(pre.posture, inv);
      const liveLogin = pre.posture.filter((row) => row.present && row.login === true).map((row) => row.role);
      const missingButLogin = output && !resumed && liveLogin.length > 0;
      emit(flags, Object.assign({}, baseSummary, {
        ok: true, code: 'OK', resumed, status: stored ? stored.status : null,
        roles: pre.posture, planned, counts: { roles: RUNTIME_ROLES.length, altered: 0 }, wrote: false,
        willRefuseRemint: missingButLogin,
      }), [
        `dry-run: target ${inv.projectId}:${inv.branchId}:${inv.database} (${inv.environment}) host ${inv.host}`,
        `preflight ok: session_user ${RUNNER_ROLE}, ${V5_SCHEMAS.length} schemas owned by ${SCHEMA_OWNER}, meta.migrations present, ${RUNTIME_ROLES.length} roles in safe posture, no forbidden memberships`,
        resumed
          ? `resume available: ${outputFile} holds status '${stored.status}' for this exact target; --execute replays the stored passwords`
          : `no credential envelope at ${outputFile || '(none given)'}; --execute would generate ${SECRET_BYTES * 8}-bit secrets and write it 0600 first`,
        ...(missingButLogin
          ? [`WARNING: ${outputFile} is absent but ${liveLogin.join(', ')} ${liveLogin.length === 1 ? 'is' : 'are'} already LOGIN; --execute will REFUSE (STATE_MISSING_BUT_LOGIN) rather than remint those passwords`]
          : []),
        ...planned.map((p) => `  planned alter: ${p.role} LOGIN, connection limit ${p.connectionLimitTarget} (now ${p.connectionLimitNow === null ? 'absent' : p.connectionLimitNow}${p.loginNow ? ', login' : ', no login'})`),
        'no change applied (dry-run)',
      ]);
      return EXIT.OK;
    }

    /* --- execute --- */
    /* The envelope is either resumed (its stored passwords are replayed verbatim) or created
     * fresh: generated secrets are written at 0600 with O_EXCL, the file AND its containing
     * directory are fsynced, and only then does any role SQL begin. A durability failure is a
     * state error and the transaction never starts. */
    const state = resumed ? stored : buildFreshState(inv);
    const secrets = collectSecrets(cfg, state);
    secrets.push(cred.migrationUrl);
    if (!resumed) writePrivateExclusive(output, JSON.stringify(state, null, 2) + '\n', secrets);
    else assertBindingStable(output, 'credential envelope');

    const altered = await provisionRoles(client, inv, state, secrets);
    const post = await readPosture(client);
    const mismatched = post.filter((row) => row.login !== true || row.connectionLimit !== inv.roleConnectionLimits[row.role]);
    if (mismatched.length > 0) {
      emit(flags, Object.assign({}, baseSummary, {
        ok: false, code: 'PROVISION_UNVERIFIED', resumed, status: 'prepared', roles: post,
        failures: mismatched.map((row) => `POST_STATE_MISMATCH:${row.role}`), counts: { roles: RUNTIME_ROLES.length, altered: altered.length },
      }), ['the ALTERs committed but the post-state does not match the requested login/limit posture; envelope left prepared for resumed investigation']);
      return EXIT.EXECUTE;
    }

    writePrivateReplace(output, JSON.stringify(advanceToActive(state), null, 2) + '\n', secrets);

    result = Object.assign({}, baseSummary, {
      ok: true, code: 'OK', resumed, status: 'active', roles: post,
      counts: { roles: RUNTIME_ROLES.length, altered: altered.length },
      output: { path: outputFile, mode: '0600' },
    });
    emit(flags, result, [
      `${resumed ? 'resumed' : 'provisioned'}: ${inv.projectId}:${inv.branchId}:${inv.database} (${inv.environment}) host ${inv.host}`,
      `preflight ok: session_user ${RUNNER_ROLE}, ${V5_SCHEMAS.length} schemas owned by ${SCHEMA_OWNER}, ${RUNTIME_ROLES.length} roles in safe posture`,
      ...altered.map((role) => `  altered ${role}: LOGIN, connection limit ${inv.roleConnectionLimits[role]} (password ${resumed ? 'replayed from the envelope' : 'generated'})`),
      `credential envelope: ${outputFile} (0600, status active)`,
      'runtime roles are LOGIN-only; no membership was granted or revoked',
    ]);
    return EXIT.OK;
  } finally {
    try { await client.end(); } catch { /* closed */ }
  }
}

module.exports = {
  EXIT, RUNTIME_ROLES, FORBIDDEN_MEMBERSHIPS, FORBIDDEN_MEMBERSHIP_SUBJECTS, V5_SCHEMAS, STATE_VERSION,
  parseArgs, resolveTls, resolveChannelBinding, derivePooledHost, buildRoleUrls, buildFreshState, advanceToActive,
  collectSecrets, loadInventory, loadCredentials, assertPrivateFileTarget, canonicalizePhysical,
  assertBindingStable, observeConnectionAuth, enforceChannelBinding, loadStateForResume, bindTarget, preflight, main,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    const code = err.exitCode || EXIT.CONFIG;
    const msg = err.code ? `${err.code}: ${err.detail || err.message}` : scrub(err.message);
    if (process.argv.slice(2).includes('--json')) {
      process.stdout.write(JSON.stringify({ tool: 'v5-provision-pg-roles', ok: false, code: err.code || 'ERROR', detail: scrub(err.detail || err.message) }) + '\n');
    } else {
      process.stderr.write(msg + '\n');
    }
    process.exitCode = code;
  });
}
