#!/usr/bin/env node
/* scripts/v5/migrate.js - V5 P02 (V5-02-03) serialized PostgreSQL migration runner.
 *
 * Design inputs: local://v5-p02-schema-design.md sections 4/7/8, specs/01 section 3,
 * specs/04 section 3, ARCHITECTURE persistence points 7-8.
 *
 * Exported CLI contract
 * ---------------------
 *   node scripts/v5/migrate.js [mode] [options]
 *
 * Modes (mutually exclusive):
 *   --dry-run   DEFAULT. Offline plan + integrity check of packages/migrations against its
 *               checksum manifest; no writes. If a database URL is available the ledger is
 *               compared read-only to mark each migration planned|applied|pending.
 *   --execute   Apply pending checksummed migrations, one transaction each, forward-only.
 *               Requires env MIGRATE_CONFIRM set to the exact target database name.
 *               Staging-family targets (V5_TARGET in dev|test|preview|staging, a staging-ish
 *               database name, or a loopback host) proceed with MIGRATE_CONFIRM alone.
 *               Unknown targets are REFUSED. Production requires the additional
 *               --confirm-production flag together with V5_TARGET=production (the production
 *               path exists but is only exercised at P22).
 *   --verify    Checksum re-validation of every applied migration plus catalog conformance
 *               against packages/migrations/conformance.json (expected schemas, tables,
 *               columns+types, named constraints, indexes, roles, and the runtime-role
 *               no-CREATE posture). Read-only.
 *
 * Options:
 *   --database-url <url>   Direct (UNPOOLED) postgres[ql]:// URL; otherwise env
 *                          V5_MIGRATE_DATABASE_URL || MIGRATION_DATABASE_URL || DATABASE_URL.
 *                          TLS posture: sslmode must be require|verify-ca|verify-full.
 *                          sslmode=disable/absent is accepted ONLY for a loopback host with
 *                          env V5_MIGRATE_ALLOW_INSECURE_LOOPBACK=1 and a non-production
 *                          classification (ephemeral CI containers).
 *   --migrations-dir <dir> Default packages/migrations (manifest.json + migrations/*.sql
 *                          + conformance.json).
 *   --json                 Emit exactly one machine-readable summary object on stdout last.
 *   --confirm-production   Second production confirmation flag (see --execute above).
 *   --make-manifest        Maintenance: (re)generate manifest.json for the migrations dir.
 *                          Only for authoring time; CI always VERIFIES, never regenerates.
 *   --help                 Usage.
 *
 * Connection URI contract (shared with the runtime provisioning tooling): scheme
 * postgres|postgresql; single host; DIRECT endpoint only (any '-pooler' host/user or pooler
 * query parameter is refused). Query keys limited to sslmode|sslrootcert|application_name|
 * connect_timeout|channel_binding. NON-LOOPBACK requires sslmode=verify-full with full
 * certificate-chain + hostname verification (no require/verify-ca/no-verify/plaintext, no
 * override). channel_binding=require is enforced: pg 8.23.1 only offers SCRAM-SHA-256-PLUS
 * opportunistically, so the runner observes the actually negotiated SASL mechanism
 * (mechanism string only, nothing retained) and refuses the session (exit 2,
 * CHANNEL_BINDING_REQUIRED) unless it is SCRAM-SHA-256-PLUS; prefer/absent stay opportunistic.
 * The posture is disclosed in every JSON summary (channelBinding{requested,
 * enableChannelBinding,observedMechanism,enforced}).
 *
 * Serialization/model: session-level pg_try_advisory_lock(7202050231) on the direct
 * connection (design 4 + R8: pooled endpoints must not be used); one transaction per
 * migration file (PostgreSQL DDL is transactional); checksum = sha256(name + '\n' + sql),
 * identical to server/production/migrations.js; id contiguity and checksum agreement are
 * enforced before any write; a failed file rolls back its whole transaction, leaving the
 * ledger clean and resumable; nothing is ever truncated or dropped; runtime constructors
 * must never create schema (design 4).
 *
 * Exit codes:
 *   0 OK / dry-run validated      2 config, usage, URL, confirmation, target, runner role
 *   3 MIGRATOR_BUSY (advisory)    4 MANIFEST_MISMATCH / MIGRATION_CHECKSUM_MISMATCH
 *   5 MIGRATION_FAILED            6 CONFORMANCE_FAILED (--verify)
 *   7 SCHEMA_NEWER_OR_INCONSISTENT
 *
 * No secret, token, player row, connection string, or URL value is ever printed; the
 * summary carries the database NAME only.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ADVISORY_LOCK_KEY = 7202050231; // int8; stable cluster-wide migration mutex
const CHECKSUM_ALGORITHM = "sha256(name + '\\n' + sql)";
const RUNNER_LABEL = 'scripts/v5/migrate.js';
const EXIT = { OK: 0, CONFIG: 2, BUSY: 3, CHECKSUM: 4, MIGRATION: 5, VERIFY: 6, LEDGER: 7 };
const V5_SCHEMAS = ['meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
  'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'];
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
const ALL_ROLES = ['v5_owner', 'migration_owner', 'api_runtime', 'core_runtime', 'worker_runtime', 'backup_reader', 'audit_runtime'];
const FILE_RE = /^(\d{4})_([a-z0-9_]{1,80})\.sql$/;
const ALLOWED_QUERY_KEYS = new Set(['sslmode', 'sslrootcert', 'application_name', 'connect_timeout', 'channel_binding']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function migrationChecksum(name, sqlBuffer) {
  return sha256Hex(Buffer.concat([Buffer.from(name + '\n', 'utf8'), sqlBuffer]));
}

/* ---------------------------------------------------------------- plan/manifest */

function buildPlan(dir) {
  const sqlDir = path.join(dir, 'migrations');
  let files;
  try { files = fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')); }
  catch { fail(EXIT.CONFIG, 'CONFIG_ERROR', `migrations directory not found: ${sqlDir}`); }
  const byId = new Map();
  for (const file of files) {
    const m = FILE_RE.exec(file);
    if (!m) fail(EXIT.CONFIG, 'CONFIG_ERROR', `illegal migration filename: ${file}`);
    const id = Number(m[1]);
    const name = file.slice(0, -'.sql'.length);
    if (byId.has(id)) fail(EXIT.CONFIG, 'CONFIG_ERROR', `duplicate migration id ${id}`);
    const sql = fs.readFileSync(path.join(sqlDir, file));
    byId.set(id, { id, name, file: path.posix.join('migrations', file), sqlText: sql.toString('utf8'), sql, sha256: migrationChecksum(name, sql), currentRoleFile: /^--\s*runner:\s*current-role\s*$/m.test(sql.toString('utf8').split('\n').slice(0, 3).join('\n')) });
  }
  const plan = [...byId.values()].sort((a, b) => a.id - b.id);
  plan.forEach((entry, i) => {
    if (entry.id !== i + 1) fail(EXIT.LEDGER, 'SCHEMA_NEWER_OR_INCONSISTENT', `migration ids are not contiguous from 1 (found id ${entry.id} at position ${i + 1})`);
  });
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { fail(EXIT.CHECKSUM, 'MANIFEST_MISMATCH', `manifest.json is not valid JSON: ${e.message}`); }
  }
  return { dir, plan, manifest, manifestPath };
}

function verifyManifestAgainstPlan({ plan, manifest }) {
  if (!manifest) fail(EXIT.CHECKSUM, 'MANIFEST_MISMATCH', 'manifest.json missing; run --make-manifest at authoring time');
  const entries = Array.isArray(manifest.migrations) ? manifest.migrations : [];
  if (entries.length !== plan.length) fail(EXIT.CHECKSUM, 'MANIFEST_MISMATCH', `manifest lists ${entries.length} entries, directory holds ${plan.length} files`);
  for (let i = 0; i < plan.length; i += 1) {
    const e = entries[i], p = plan[i];
    if (e.id !== p.id || e.name !== p.name || e.file !== p.file) {
      fail(EXIT.CHECKSUM, 'MANIFEST_MISMATCH', `manifest entry ${i + 1} does not match file order (${e.name} vs ${p.name})`);
    }
    if (e.sha256 !== p.sha256) {
      fail(EXIT.CHECKSUM, 'MANIFEST_MISMATCH', `replay conflict: ${p.name} content sha256 ${p.sha256} != manifest ${e.sha256}`);
    }
  }
  if (manifest.advisoryLockKey !== undefined && manifest.advisoryLockKey !== ADVISORY_LOCK_KEY) {
    fail(EXIT.CHECKSUM, 'MANIFEST_MISMATCH', 'manifest advisoryLockKey disagrees with the runner');
  }
}

function makeManifest(dir) {
  const built = buildPlan(dir);
  const doc = {
    tool: 'v5-migrate-manifest', version: 1, algorithm: CHECKSUM_ALGORITHM,
    advisoryLockKey: ADVISORY_LOCK_KEY,
    migrations: built.plan.map((p) => ({ id: p.id, name: p.name, file: p.file, sha256: p.sha256 })),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

/* ---------------------------------------------------------------- URL + target */

function fail(exitCode, code, detail) {
  const err = new Error(code + ': ' + detail);
  err.exitCode = exitCode; err.code = code; err.detail = detail;
  throw err;
}

function parseAndGuardUrl(rawUrl, opts = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'database URL missing');
  if (rawUrl !== rawUrl.trim() || /\s/.test(rawUrl)) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'raw whitespace in a database URL is refused');
  let u;
  try { u = new URL(rawUrl.trim()); } catch { fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'database URL is unparsable'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'only postgresql:// URLs are accepted');
  if (!u.hostname) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'host is required');
  if (u.hostname.includes(',')) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'multi-host URLs are refused (single direct connection only)');
  // Direct endpoint enforcement (design R8 / 6.4): pooled Neon endpoints break session
  // advisory locks, so the migration runner refuses anything pooler-shaped outright.
  if (/pooler/i.test(u.hostname)) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'pooler endpoints are refused; migrations require the DIRECT (unpooled) endpoint');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'database name is required');
  if (database.includes('/') || database.includes('?')) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'illegal database name');
  const user = u.username ? decodeURIComponent(u.username) : undefined;
  if (user && /-pooler$/i.test(user)) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'pooler database users are refused; migrations require the DIRECT endpoint user');
  const password = u.username ? decodeURIComponent(u.password || '') : undefined;
  // An empty password is refused for any real endpoint; the loopback CI escape (explicitly
  // opted in via V5_MIGRATE_ALLOW_INSECURE_LOOPBACK below) may use local trust auth.
  const loopbackHost = LOOPBACK_HOSTS.has(u.hostname);
  const insecureLoopback = loopbackHost && process.env.V5_MIGRATE_ALLOW_INSECURE_LOOPBACK === '1';
  if (u.username && password === '' && !insecureLoopback) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'empty password with a username is refused');
  const port = u.port ? Number(u.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'illegal port');
  const params = {};
  for (const [k, v] of u.searchParams) {
    if (!ALLOWED_QUERY_KEYS.has(k)) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', `query parameter '${k}' is not permitted (pooled/pooler options are refused; migrations need the direct endpoint)`);
    params[k] = v;
  }
  // SCRAM channel binding (official Neon direct URIs carry channel_binding=require alongside
  // sslmode=verify-full). pg 8.23.1 has NO hard-'require' mode: enableChannelBinding makes the
  // client OFFER/PREFER SCRAM-SHA-256-PLUS whenever the server supports it (libpq 'prefer'
  // semantics). We map require|prefer -> enableChannelBinding:true, disable/absent -> false and
  // DISCLOSE the negotiated posture in every JSON summary; require is never falsely claimed.
  const channelBinding = params.channel_binding;
  if (channelBinding !== undefined && !['require', 'prefer', 'disable'].includes(channelBinding)) {
    fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', `channel_binding '${channelBinding}' is not accepted (require|prefer|disable)`);
  }
  // TLS posture (parent-frozen): NON-LOOPBACK always verifies certificate chain AND
  // hostname => sslmode=verify-full only; require/verify-ca/no-verify/plaintext are refused
  // and there is no override. The loopback escape exists solely for owned synthetic CI
  // clusters behind an explicit opt-in env and never applies to a production classification.
  const sslmode = params.sslmode || 'disable';
  if (!['require', 'verify-ca', 'verify-full', 'disable'].includes(sslmode)) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', `sslmode '${sslmode}' is not accepted (no-verify never is)`);
  let ssl = null;
  if (!loopbackHost) {
    if (sslmode !== 'verify-full') {
      fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'external endpoints require sslmode=verify-full (certificate chain + hostname always verified); require/verify-ca/no-verify/plaintext are refused');
    }
    ssl = { rejectUnauthorized: true };
    if (params.sslrootcert) {
      const caPath = path.resolve(params.sslrootcert);
      if (!fs.existsSync(caPath)) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'sslrootcert file not found');
      ssl.ca = [fs.readFileSync(caPath, 'utf8')];
    }
  } else {
    if (!insecureLoopback && sslmode === 'disable') {
      fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', 'TLS is mandatory; unencrypted loopback connections are allowed only with V5_MIGRATE_ALLOW_INSECURE_LOOPBACK=1 on an owned synthetic cluster');
    }
    ssl = sslmode === 'verify-ca' || sslmode === 'verify-full' ? { rejectUnauthorized: true } : false;
  }
  return { host: u.hostname, port, database, user, password, ssl, channelBinding: channelBinding || 'absent', applicationName: params.application_name || RUNNER_LABEL };
}
const PROD_NAME_RE = /(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i;
const STAGING_NAME_RE = /(^|[^a-z0-9])(staging|preview|test|ci|dev|sandbox|scratch)([^a-z0-9]|$)/i;

function classifyTarget(database, hostname) {
  const env = (process.env.V5_TARGET || '').trim().toLowerCase();
  const prodName = PROD_NAME_RE.test(database);
  const stagingName = STAGING_NAME_RE.test(database);
  if (env) {
    if (!['dev', 'test', 'preview', 'staging', 'production'].includes(env)) fail(EXIT.CONFIG, 'CONFIG_ERROR', `V5_TARGET '${env}' is not one of dev|test|preview|staging|production`);
    // Conflicting hints REFUSE; a production-looking target is never downgraded by an env
    // label, and a production label on a non-production-looking name is equally refused.
    if (env !== 'production' && prodName) fail(EXIT.CONFIG, 'TARGET_ENVIRONMENT_UNRECOGNIZED', `conflicting target hints: V5_TARGET=${env} but the database name looks production; refusing to downgrade a production-looking target`);
    if (env === 'production' && stagingName && !prodName) fail(EXIT.CONFIG, 'TARGET_ENVIRONMENT_UNRECOGNIZED', 'conflicting target hints: V5_TARGET=production but the database name looks non-production; refusing');
    return { kind: env === 'production' ? 'production' : 'staging', source: 'V5_TARGET' };
  }
  if (prodName) return { kind: 'production', source: 'database-name' };
  if (stagingName) return { kind: 'staging', source: 'database-name' };
  if (LOOPBACK_HOSTS.has(hostname)) return { kind: 'staging', source: 'loopback' };
  return { kind: 'unknown', source: 'none' };
}

function gateExecution(cfg, target, flags) {
  const confirm = process.env.MIGRATE_CONFIRM || '';
  if (confirm !== cfg.database || confirm === '') {
    fail(EXIT.CONFIG, 'CONFIRMATION_REQUIRED', 'MIGRATE_CONFIRM must be set to the exact target database name (echo the db name to proceed)');
  }
  if (target.kind === 'unknown') {
    fail(EXIT.CONFIG, 'TARGET_ENVIRONMENT_UNRECOGNIZED', 'refusing an unknown target: set V5_TARGET=dev|test|preview|staging (or use a staging-ish database name); production requires --confirm-production with V5_TARGET=production');
  }
  if (target.kind === 'production') {
    if (!flags.confirmProduction || (process.env.V5_TARGET || '').trim().toLowerCase() !== 'production') {
      fail(EXIT.CONFIG, 'PRODUCTION_CONFIRMATION_REQUIRED', 'production requires BOTH --confirm-production and V5_TARGET=production (exercised only at P22)');
    }
  }
}

/* ---------------------------------------------------------------- database I/O */

async function withClient(cfg, fn) {
  const { Client } = require('pg');
  const wantsBinding = cfg.channelBinding === 'require' || cfg.channelBinding === 'prefer';
  const client = new Client({
    host: cfg.host, port: cfg.port, database: cfg.database,
    user: cfg.user, password: cfg.password, ssl: cfg.ssl || undefined,
    // pg 8.23.1 has no hard-'require' channel binding mode: enableChannelBinding makes the
    // client OFFER/PREFER SCRAM-SHA-256-PLUS when the server advertises it (libpq prefer
    // semantics). channel_binding=require is therefore ENFORCED by the runner: a pinned,
    // mechanism-string-only observer on the SASL continue event records what actually
    // negotiated, and require refuses the session unless it was SCRAM-SHA-256-PLUS. No driver
    // patch, no fork, no secrets/challenges/nonce retained - only the mechanism name.
    enableChannelBinding: wantsBinding,
    application_name: cfg.applicationName,
    connectionTimeoutMillis: 10000, statement_timeout: 30000,
  });
  let observedMechanism = null;
  if (wantsBinding) {
    client.connection.on('authenticationSASLContinue', () => {
      if (client.saslSession && typeof client.saslSession.mechanism === 'string') {
        observedMechanism = client.saslSession.mechanism; // retain ONLY the mechanism name
      }
    });
  }
  try {
    await client.connect();
    if (cfg.channelBinding === 'require' && observedMechanism !== 'SCRAM-SHA-256-PLUS') {
      fail(EXIT.CONFIG, 'CHANNEL_BINDING_REQUIRED', 'channel_binding=require refused: authentication did not negotiate SCRAM-SHA-256-PLUS (no silent downgrade; prefer/absent stay opportunistic)');
    }
    return await fn(client, {
      requested: cfg.channelBinding || 'absent',
      enableChannelBinding: wantsBinding,
      observedMechanism,
      enforced: cfg.channelBinding === 'require' ? observedMechanism === 'SCRAM-SHA-256-PLUS' : null,
    });
  } finally {
    try { await client.end(); } catch { /* closed */ }
  }
}

async function assertPrivilegedRunner(client) {
  // Trusted runner identities: a true superuser (ephemeral synthetic clusters / containers),
  // the literal migration_owner LOGIN role, or - only with V5_MIGRATE_PROVIDER_MODE=1 - a
  // trusted provider bootstrap identity: a CREATEROLE role that owns the current database.
  // Neon has no true superuser; its initial managed role carries rolcreaterole and owns the
  // nonserving database, and PG16 treats a CREATEROLE role as admin-option member of the
  // roles IT created, so the 0001 bootstrap chain works without elevated membership grants.
  const r = await client.query(`SELECT session_user::text su,
      COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false) sup,
      COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user), false) scr,
      (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) dbo`);
  const { su, sup, scr, dbo } = r.rows[0];
  const providerMode = process.env.V5_MIGRATE_PROVIDER_MODE === '1';
  if (!sup && su !== 'migration_owner' && !(providerMode && scr && dbo === su)) {
    fail(EXIT.CONFIG, 'RUNNER_ROLE_NOT_PRIVILEGED', `migrations must run as migration_owner, a superuser on an owned synthetic cluster, or a CREATEROLE database owner with V5_MIGRATE_PROVIDER_MODE=1; session user is '${su}'`);
  }
  return { su, provider: !sup && su !== 'migration_owner' };
}

async function acquireAdvisoryLock(client) {
  const r = await client.query('SELECT COALESCE(pg_try_advisory_lock($1), false) AS acquired', [String(ADVISORY_LOCK_KEY)]);
  return r.rows[0].acquired === true;
}

/* Tool-managed ledger bootstrap (Flyway-standard). The runner records each applied file INSIDE
that file's own transaction, so meta.migrations must exist before file 0001 commits; migration
0003 remains the checksummed authoritative definition and normalizes ownership/constraints/grants
idempotently. No runtime constructor ever creates schema - only this trusted runner does. */
async function bootstrapLedger(client) {
  await client.query('BEGIN');
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS meta');
    await client.query(`CREATE TABLE IF NOT EXISTS meta.migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum CHAR(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), runner TEXT NOT NULL,
      duration_ms INTEGER, schema_version INTEGER NOT NULL)`);
    // The bootstrap runs before file 0001 records itself, so the ledger access rights that
    // 0003 normalizes must already exist here: schema USAGE + SELECT,INSERT for
    // migration_owner (needed when the session assumes that role for the ledger insert and
    // when migration_owner - not a superuser - executes the runner). Harmless when the
    // session is the owning superuser.
    // Guarded because on a brand-new cluster 0001 has not created migration_owner yet;
    // 0003 re-normalizes the same grants afterwards.
    await client.query(`DO $do$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migration_owner') THEN
          GRANT USAGE ON SCHEMA meta TO migration_owner;
          GRANT SELECT, INSERT ON meta.migrations TO migration_owner;
        END IF;
      END
    $do$`);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* aborted */ }
    throw err;
  }
}

async function readLedger(client) {
  const exists = await client.query("SELECT to_regclass('meta.migrations') AS t");
  if (!exists.rows[0].t) return [];
  const r = await client.query('SELECT id, name, checksum FROM meta.migrations ORDER BY id');
  return r.rows;
}

async function runMigration(client, entry, sessionUser, providerIdentity) {
  const t0 = Date.now();
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SET LOCAL lock_timeout = '20s'");
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
    if (!entry.currentRoleFile) await client.query('SET LOCAL ROLE v5_owner');
    await client.query(entry.sqlText);
    await client.query('RESET ROLE');
    // A provider bootstrap identity that is neither superuser nor literally migration_owner
    // created migration_owner and is therefore its admin-option member in PG16; assume it
    // solely for the ledger insert, which 0003 grants to migration_owner alone.
    if (providerIdentity) await client.query('SET LOCAL ROLE migration_owner');
    const durationMs = Date.now() - t0;
    await client.query(
      'INSERT INTO meta.migrations (id, name, checksum, runner, duration_ms, schema_version) VALUES ($1, $2, $3, $4, $5, $6)',
      [entry.id, entry.name, entry.sha256, `${RUNNER_LABEL} as ${sessionUser}`, durationMs, entry.id]);
    await client.query('COMMIT');
    return durationMs;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* aborted */ }
    throw err;
  }
}

/* ---------------------------------------------------------------- verify */

async function verifyConformance(client, conformancePath) {
  const failures = [];
  const doc = JSON.parse(fs.readFileSync(conformancePath, 'utf8'));
  const schemaNames = Object.keys(doc.schemas || {});
  const schemas = (await client.query('SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n WHERE n.nspname = ANY($1::text[])', [schemaNames])).rows;
  const schemaMap = new Map(schemas.map((s) => [s.name, s]));
  for (const name of schemaNames) {
    const spec = doc.schemas[name];
    const got = schemaMap.get(name);
    if (!got) failures.push(`schema ${name} is missing`);
    else if (spec.owner && got.owner !== spec.owner) failures.push(`schema ${name} owner is ${got.owner}, expected ${spec.owner}`);
  }
  const cols = (await client.query(
    `SELECT n.nspname AS s, c.relname AS t, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS nn
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'`, [schemaNames])).rows;
  const colMap = new Map(cols.map((r) => [`${r.s}.${r.t}.${r.col}`, r]));
  const cons = (await client.query(
    `SELECT n.nspname AS s, c.relname AS t, con.conname AS name
       FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])`, [schemaNames])).rows;
  const conSet = new Set(cons.map((r) => `${r.s}.${r.t}.${r.name}`));
  const idx = (await client.query('SELECT schemaname AS s, tablename AS t, indexname AS name FROM pg_indexes WHERE schemaname = ANY($1::text[])', [schemaNames])).rows;
  const idxSet = new Set(idx.map((r) => `${r.s}.${r.t}.${r.name}`));
  for (const [schemaName, spec] of Object.entries(doc.schemas || {})) {
    for (const [tableName, table] of Object.entries(spec.tables || {})) {
      for (const [colName, want] of Object.entries(table.columns || {})) {
        const got = colMap.get(`${schemaName}.${tableName}.${colName}`);
        if (!got) { failures.push(`column ${schemaName}.${tableName}.${colName} is missing`); continue; }
        if (got.typ !== want.t) failures.push(`column ${schemaName}.${tableName}.${colName} type is ${got.typ}, expected ${want.t}`);
        if (want.nn === true && got.nn !== true) failures.push(`column ${schemaName}.${tableName}.${colName} is nullable, expected NOT NULL`);
      }
      for (const name of table.constraints || []) if (!conSet.has(`${schemaName}.${tableName}.${name}`)) failures.push(`constraint ${schemaName}.${tableName}.${name} is missing`);
      for (const name of table.indexes || []) if (!idxSet.has(`${schemaName}.${tableName}.${name}`)) failures.push(`index ${schemaName}.${tableName}.${name} is missing`);
    }
  }
  const roleRows = (await client.query('SELECT rolname AS name FROM pg_roles WHERE rolname = ANY($1::text[])', [doc.roles || ALL_ROLES])).rows;
  const roleSet = new Set(roleRows.map((r) => r.name));
  for (const role of doc.roles || ALL_ROLES) if (!roleSet.has(role)) failures.push(`role ${role} is missing`);
  const missingPrivSubject = (probe) => !roleSet.has(probe.role) || !schemaMap.has(probe.schema);
  for (const probe of doc.privilegeChecks || []) {
    if (missingPrivSubject(probe)) { failures.push(`privilege probe ${probe.role}/${probe.schema} skipped: subject absent (catalog drift)`); continue; }
    const r = await client.query('SELECT has_schema_privilege($1, $2, $3) AS allowed', [probe.role, probe.schema, probe.privilege || 'CREATE']);
    if (r.rows[0].allowed !== (probe.expect !== undefined ? probe.expect : false)) {
      failures.push(`privilege probe ${probe.role}/${probe.schema}/${probe.privilege || 'CREATE'} expected ${probe.expect !== undefined ? probe.expect : false}, got ${r.rows[0].allowed}`);
    }
  }
  // Database-level posture (0025): runtime identities must hold neither CREATE nor TEMPORARY
  // on the target database, so no runtime session can create even a TEMP table. Only the
  // trusted management identities (migration_owner, v5_owner) keep TEMPORARY, never CREATE.
  for (const probe of doc.databasePrivilegeChecks || []) {
    if (!roleSet.has(probe.role)) { failures.push(`database privilege probe ${probe.role}/${probe.privilege} skipped: role absent (catalog drift)`); continue; }
    const r = await client.query(
      'SELECT has_database_privilege($1, current_database(), $2) AS allowed', [probe.role, probe.privilege]);
    const want = probe.expect !== undefined ? probe.expect : false;
    if (r.rows[0].allowed !== want) {
      failures.push(`database privilege probe ${probe.role}/${probe.privilege} expected ${want}, got ${r.rows[0].allowed}`);
    }
  }
  // Backup contract (0026): stock pg_dump runs as backup_reader on EXPLICIT exact read-only
  // grants only - schema USAGE, SELECT on every conformance-listed table and every sequence in
  // the V5 schemas, and NO pg_read_all_data membership (that predefined grant is obsolete under
  // the explicit strategy and must not silently remain active).
  const brc = doc.backupReadContract;
  if (brc) {
    const role = brc.role;
    const mem = await client.query(
      `SELECT count(*)::int n FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = 'pg_read_all_data' AND m.rolname = $1`, [role]);
    if (brc.expectPgReadAllDataMembership === false && mem.rows[0].n !== 0) {
      failures.push(`backup contract: ${role} must not hold pg_read_all_data membership under the explicit-grant strategy`);
    }
    if (!roleSet.has(role)) failures.push(`backup contract: role ${role} is absent (catalog drift)`);
    else for (const [schemaName, spec] of Object.entries(doc.schemas || {})) {
      // Catalog drift must be REPORTED (exit VERIFY), not crash the probe: has_schema_privilege
      // and has_table_privilege RAISE on absent objects, so resolve through the reg* functions
      // first and classify an absent object as a conformance failure.
      const ns = await client.query('SELECT to_regnamespace($1) AS n', [schemaName]);
      if (ns.rows[0].n === null) { failures.push(`backup contract: schema ${schemaName} is absent (catalog drift)`); continue; }
      const usage = await client.query('SELECT has_schema_privilege($1, $2, $3) AS allowed', [role, schemaName, 'USAGE']);
      if (usage.rows[0].allowed !== true) failures.push(`backup contract: ${role} lacks USAGE on schema ${schemaName}`);
      for (const tableName of Object.keys(spec.tables || {})) {
        const reg = await client.query('SELECT to_regclass($1) AS t', [`${schemaName}.${tableName}`]);
        if (reg.rows[0].t === null) { failures.push(`backup contract: relation ${schemaName}.${tableName} is absent (catalog drift)`); continue; }
        const sel = await client.query('SELECT has_table_privilege($1, $2, $3) AS allowed', [role, `${schemaName}.${tableName}`, 'SELECT']);
        if (sel.rows[0].allowed !== true) failures.push(`backup contract: ${role} lacks SELECT on ${schemaName}.${tableName}`);
      }
      const seqs = await client.query(
        `SELECT c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY 1`, [schemaName]);
      for (const row of seqs.rows) {
        const sel = await client.query('SELECT has_sequence_privilege($1, $2, $3) AS allowed', [role, `${schemaName}.${row.t}`, 'SELECT']);
        if (sel.rows[0].allowed !== true) failures.push(`backup contract: ${role} lacks SELECT on sequence ${schemaName}.${row.t}`);
      }
    }
  }
  return failures;
}

/* ---------------------------------------------------------------- main */

function parseArgs(argv) {
  const flags = { mode: null, json: false, confirmProduction: false, makeManifest: false, help: false, databaseUrl: null, migrationsDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': setMode(flags, 'dry-run', a); break;
      case '--execute': setMode(flags, 'execute', a); break;
      case '--verify': setMode(flags, 'verify', a); break;
      case '--json': flags.json = true; break;
      case '--confirm-production': flags.confirmProduction = true; break;
      case '--make-manifest': setMode(flags, 'make-manifest', a); break;
      case '--help': case '-h': flags.help = true; break;
      case '--database-url': case '--migrations-dir':
        flags[a === '--database-url' ? 'databaseUrl' : 'migrationsDir'] = argv[++i];
        break;
      default:
        if (a.startsWith('--database-url=')) flags.databaseUrl = a.slice('--database-url='.length);
        else if (a.startsWith('--migrations-dir=')) flags.migrationsDir = a.slice('--migrations-dir='.length);
        else fail(EXIT.CONFIG, 'CONFIG_ERROR', `unknown argument '${a}' (see --help)`);
    }
  }
  if (!flags.mode) flags.mode = 'dry-run';
  return flags;
}
function setMode(flags, mode, arg) {
  if (flags.mode && flags.mode !== mode) fail(EXIT.CONFIG, 'CONFIG_ERROR', 'modes are mutually exclusive: ' + arg);
  flags.mode = mode;
}

function emit(flags, summary, humanLines) {
  if (flags.json) process.stdout.write(JSON.stringify(summary) + '\n');
  else for (const line of humanLines || []) process.stdout.write(line + '\n');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*?![^\n]*\n?/, '') + '*/\n');
    return EXIT.OK;
  }
  const dir = path.resolve(flags.migrationsDir || path.join(process.cwd(), 'packages', 'migrations'));
  const built = buildPlan(dir);

  if (flags.mode === 'make-manifest') {
    const doc = makeManifest(dir);
    emit(flags, { tool: 'v5-migrate', mode: 'make-manifest', ok: true, code: 'OK', entries: doc.migrations.length }, [`manifest.json written with ${doc.migrations.length} entries`]);
    return EXIT.OK;
  }

  verifyManifestAgainstPlan(built);
  const planLines = built.plan.map((p) => `${String(p.id).padStart(4, '0')} ${p.name} sha256:${p.sha256}`);

  const rawUrl = flags.databaseUrl || process.env.V5_MIGRATE_DATABASE_URL || process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || '';
  let cfg = null, target = null;
  if (rawUrl) {
    const preTarget = (() => { try { return new URL(rawUrl.trim()); } catch { return null; } })();
    const dbName = preTarget ? decodeURIComponent(preTarget.pathname.replace(/^\//, '')) : '';
    const looksProd = (process.env.V5_TARGET || '').trim().toLowerCase() === 'production' || /(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i.test(dbName);
    cfg = parseAndGuardUrl(rawUrl, { production: looksProd });
    target = classifyTarget(cfg.database, cfg.host);
  }

  if (flags.mode === 'dry-run') {
    let ledger = [];
    if (cfg) ledger = await withClient(cfg, (c) => readLedger(c));
    const applied = new Map(ledger.map((r) => [r.id, r]));
    const migrations = built.plan.map((p) => {
      const row = applied.get(p.id);
      let status = 'pending';
      if (row) status = row.checksum === p.sha256 ? 'applied' : 'CHECKSUM-CONFLICT';
      return { id: p.id, name: p.name, sha256: p.sha256, status };
    });
    const conflict = migrations.some((m) => m.status === 'CHECKSUM-CONFLICT');
    const summary = { tool: 'v5-migrate', mode: 'dry-run', ok: !conflict, code: conflict ? 'MIGRATION_CHECKSUM_MISMATCH' : 'OK', database: cfg ? cfg.database : null, target: target ? target.kind : null, plan: migrations, connected: Boolean(cfg) };
    emit(flags, summary, [...planLines, `${migrations.length} migrations validated against manifest (checksum rule ${CHECKSUM_ALGORITHM})`]);
    return conflict ? EXIT.CHECKSUM : EXIT.OK;
  }

  if (!cfg) fail(EXIT.CONFIG, 'DATABASE_URL_INVALID', `${flags.mode} requires a database URL (--database-url or V5_MIGRATE_DATABASE_URL)`);
  if (flags.mode === 'execute') gateExecution(cfg, target, flags);

  return withClient(cfg, async (client, channelBinding) => {
    const runner = await assertPrivilegedRunner(client);
    if (flags.mode === 'verify') {
      const ledger = await readLedger(client);
      const failures = [];
      const byId = new Map(ledger.map((r) => [r.id, r]));
      if (ledger.length > built.plan.length) failures.push(`ledger holds ${ledger.length} rows but only ${built.plan.length} migrations are known (SCHEMA_NEWER_OR_INCONSISTENT)`);
      for (let i = 0; i < Math.min(ledger.length, built.plan.length); i += 1) {
        const row = ledger[i], p = built.plan[i];
        if (row.id !== i + 1) { failures.push(`ledger row ${i} has id ${row.id}, expected ${i + 1}`); continue; }
        if (row.name !== p.name) failures.push(`ledger row ${row.id} is ${row.name}, expected ${p.name}`);
        else if (row.checksum !== p.sha256) failures.push(`replay conflict: ${p.name} applied checksum ${row.checksum} != file checksum ${p.sha256}`);
      }
      const confFailures = await verifyConformance(client, path.join(dir, 'conformance.json'));
      failures.push(...confFailures);
      const ok = failures.length === 0;
      emit(flags, { tool: 'v5-migrate', mode: 'verify', ok, code: ok ? 'OK' : 'CONFORMANCE_FAILED', database: cfg.database, target: target.kind, checked: built.plan.length, channelBinding, failures },
        ok ? [`verify OK: ${built.plan.length} checksums + catalog conformance`] : failures);
      return ok ? EXIT.OK : (failures.some((f) => f.includes('replay conflict') || f.includes('SCHEMA_NEWER_OR_INCONSISTENT')) ? EXIT.CHECKSUM : EXIT.VERIFY);
    }

    // --execute
    const acquired = await acquireAdvisoryLock(client);
    if (!acquired) {
      emit(flags, { tool: 'v5-migrate', mode: 'execute', ok: false, code: 'MIGRATOR_BUSY', database: cfg.database, target: target.kind, channelBinding }, ['another migrator holds the advisory lock; nothing changed']);
      return EXIT.BUSY;
    }
    // The busy path above writes NOTHING: the tool-managed ledger bootstrap happens only
    // after the advisory lock is owned by this session (direct connection, design R8).
    await bootstrapLedger(client);
    try {
      const ledger = await readLedger(client);
      for (let i = 0; i < ledger.length; i += 1) {
        const row = ledger[i];
        if (row.id !== i + 1) fail(EXIT.LEDGER, 'SCHEMA_NEWER_OR_INCONSISTENT', `ledger row ${i} has id ${row.id}; refusing to continue`);
        const p = built.plan[i];
        if (!p) fail(EXIT.LEDGER, 'SCHEMA_NEWER_OR_INCONSISTENT', `ledger holds ${ledger.length} rows but only ${built.plan.length} migrations are known`);
        if (row.name !== p.name) fail(EXIT.LEDGER, 'SCHEMA_NEWER_OR_INCONSISTENT', `ledger row ${row.id} is '${row.name}', expected '${p.name}'`);
        if (row.checksum !== p.sha256) fail(EXIT.CHECKSUM, 'MIGRATION_CHECKSUM_MISMATCH', `replay conflict on ${p.name}: applied ${row.checksum} != file ${p.sha256}`);
      }
      const applied = [], results = [];
      for (const entry of built.plan.slice(ledger.length)) {
        const t0 = Date.now();
        try {
          const durationMs = await runMigration(client, entry, runner.su, runner.provider);
          applied.push(entry.name);
          results.push({ id: entry.id, name: entry.name, sha256: entry.sha256, status: 'applied', durationMs });
        } catch (err) {
          results.push({ id: entry.id, name: entry.name, sha256: entry.sha256, status: 'failed', pgCode: err.code || null, message: String(err.message || '').slice(0, 400) });
          emit(flags, { tool: 'v5-migrate', mode: 'execute', ok: false, code: 'MIGRATION_FAILED', database: cfg.database, target: target.kind, channelBinding, plan: results },
            [applied.map((n) => `applied ${n}`).join('\n'), `FAILED ${entry.name}: ${err.message}`].filter(Boolean));
          return EXIT.MIGRATION;
        }
      }
      emit(flags, { tool: 'v5-migrate', mode: 'execute', ok: true, code: 'OK', database: cfg.database, target: target.kind, channelBinding, plan: results, appliedCount: applied.length },
        applied.length ? applied.map((n) => `applied ${n}`) : ['no pending migrations (idempotent no-op)']);
      return EXIT.OK;
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1)', [String(ADVISORY_LOCK_KEY)]); } catch { /* dropped */ }
    }
  });
}

/* The exported parts are consumed by tests/v5-migrations.test.js and (later) apps tooling. */
module.exports = { ADVISORY_LOCK_KEY, CHECKSUM_ALGORITHM, V5_SCHEMAS, buildPlan, verifyManifestAgainstPlan, makeManifest, parseAndGuardUrl, classifyTarget, migrationChecksum, main, parseArgs };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    const code = err.exitCode || EXIT.CONFIG;
    const msg = err.code ? `${err.code}: ${err.detail || err.message}` : String(err.message || err);
    if (process.argv.slice(2).includes('--json')) {
      process.stdout.write(JSON.stringify({ tool: 'v5-migrate', ok: false, code: err.code || 'ERROR', detail: (err.detail || String(err.message || '')).slice(0, 400) }) + '\n');
    } else {
      process.stderr.write(msg + '\n');
    }
    process.exitCode = code;
  });
}
