#!/usr/bin/env node
/* scripts/v5/pg-smoke.js - V5 P02 disposable PostgreSQL 16 integration smoke.
 *
 * Design input: local://v5-p02-pg-harness-contract.md (frozen parent interface).
 *
 * Contract (identical to tests/v5-migrations.test.js and tests/v5-pg-guards.test.js):
 *   V5_PG_URL        external DIRECT admin URL; explicit loopback host + non-production
 *                    control database only. Never a Neon endpoint: this smoke mutates
 *                    cluster-wide state (role LOGIN/passwords) and drops its own databases.
 *   V5_PG_DISPOSABLE  must be '1' whenever V5_PG_URL is set - the caller declares the
 *                    cluster exclusively owned synthetic test capacity. Ownership is NEVER
 *                    inferred from the URL alone.
 *   V5_PG_REQUIRED    '1' (CI) turns a missing/incoherent target into a hard failure instead
 *                    of a silent skip.
 *
 * What it proves on the supplied PG16 service, in order:
 *   1. server major is exactly 16, with the exact version string recorded as evidence;
 *   2. one uniquely-owned database v5_smoke_<pid>_<suffix> is created through the control DB;
 *   3. the checksummed migration chain applies from zero (--execute), then --verify passes,
 *      then --dry-run compares the ledger read-only;
 *   4. the SQL chain left runtime roles NOLOGIN, and the synthetic harness enables exact
 *      api_runtime/core_runtime/worker_runtime LOGIN (plus backup_reader/audit_runtime) with
 *      no owner/admin membership for any runtime role;
 *   5. the real packages/db/pg guards accept those login sessions (role + grant posture);
 *   6. withIdempotentTransaction commits, rolls back, and replays one key exactly once;
 *   7. replay conflict on a durable command PK is refused (23505);
 *   8. runtime economic writes are allowed while DDL and append-only/out-of-scope writes are
 *      denied (42501);
 *   9. every tracked database is dropped; the supplied control database is never mutated,
 *      truncated, or dropped, and no unknown/regex-discovered database is touched.
 *
 * Evidence: only sanitized command names, exit codes, result codes, counters, schema hashes
 * and the recorded server version reach stdout/artifacts. URLs, credentials, raw rows and
 * connection strings are never printed.
 *
 * Exit codes: 0 OK | 2 config/env | 4 checksum | 5 migration | 6 verify | 8 denial posture |
 *             9 conflict/replay | 10 internal.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'packages', 'migrations');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');

const EXIT = { OK: 0, CONFIG: 2, CHECKSUM: 4, MIGRATION: 5, VERIFY: 6, DENIAL: 8, CONFLICT: 9, INTERNAL: 10 };
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const OWNED_DB_PREFIX = 'v5_smoke_';
const PRODUCTION_TOKENS = /(^|[^a-z0-9])(prod|production|live)([^a-z0-9]|$)/i;

/* Login roles the synthetic harness enables, and the schemas each runtime role is granted in
 * the checksummed chain (0001 roles, 0020 api, 0021 core, 0022 worker, 0023 backup/audit, 0038
 * runtime service boundaries + meta boot-readiness). The lists are read off the migration files,
 * not from the guard defaults, because a migration smoke must assert the grants the chain ships. */
const RUNTIME_LOGIN_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime', 'backup_reader', 'audit_runtime'];
const ROLE_SCHEMAS = Object.freeze({
  api_runtime: ['meta', 'identity', 'profile', 'social', 'privacy', 'support', 'ops', 'runtime'],
  core_runtime: ['meta', 'economy', 'core', 'match', 'tournament', 'monetization', 'season', 'cosmetics', 'identity', 'runtime', 'social', 'ops'],
  worker_runtime: ['meta', 'ops', 'monetization', 'privacy', 'support', 'runtime'],
  backup_reader: ['meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
    'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'],
  audit_runtime: ['audit'],
});

const steps = [];
class SmokeFailure extends Error {
  constructor(exitCode, code, detail) {
    super(`${code}: ${detail}`);
    this.exitCode = exitCode;
    this.code = code;
    this.detail = detail;
  }
}
function fail(exitCode, code, detail) {
  throw new SmokeFailure(exitCode, code, detail);
}
function record(name, ok, detail) {
  steps.push({ step: name, ok: ok !== false, ...(detail ? { detail } : {}) });
}

/* ------------------------------------------------------------------ target guard */

function readTarget() {
  const rawUrl = (process.env.V5_PG_URL || '').trim();
  const disposable = (process.env.V5_PG_DISPOSABLE || '').trim();
  const required = (process.env.V5_PG_REQUIRED || '').trim() === '1';
  if (!rawUrl) {
    if (required) fail(EXIT.CONFIG, 'V5_PG_REQUIRED_NO_TARGET', 'V5_PG_REQUIRED=1 but V5_PG_URL is unset (no silent skip)');
    return { rawUrl: null, required, disposable, skipped: 'NO_TARGET' };
  }
  if (disposable !== '1') {
    fail(EXIT.CONFIG, 'V5_PG_DISPOSABLE_REQUIRED', 'V5_PG_URL is set but V5_PG_DISPOSABLE=1 is missing; cluster ownership is never inferred from a URL');
  }
  let url;
  try { url = new URL(rawUrl); } catch { fail(EXIT.CONFIG, 'V5_PG_URL_INVALID', 'V5_PG_URL is unparsable'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') fail(EXIT.CONFIG, 'V5_PG_URL_INVALID', 'only postgres[ql]:// URLs are accepted');
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    fail(EXIT.CONFIG, 'V5_PG_URL_NOT_LOOPBACK', 'this harness drives a disposable loopback cluster only; provider endpoints are never mutated here');
  }
  const control = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!control) fail(EXIT.CONFIG, 'V5_PG_URL_INVALID', 'control database name is required');
  if (PRODUCTION_TOKENS.test(control)) fail(EXIT.CONFIG, 'V5_PG_CONTROL_LOOKS_PRODUCTION', 'refusing a control database whose name reads as production');
  if (control.startsWith(OWNED_DB_PREFIX)) fail(EXIT.CONFIG, 'V5_PG_CONTROL_IS_OWNED_TARGET', 'the control database must not be an owned smoke database');
  return { rawUrl, control, url, required, disposable, skipped: null };
}

function urlForDatabase(base, name) {
  const clone = new URL(base);
  clone.pathname = `/${name}`;
  return clone.toString();
}

function clientConfig(url) {
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ssl: false,
    connectionTimeoutMillis: 10000,
    statement_timeout: 60000,
  };
}

/* ------------------------------------------------------------------ migration CLI */

function runMigrator(mode, ownedUrl, dbName, extraEnv = {}) {
  const args = [RUNNER, mode, '--json', '--database-url', ownedUrl];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 240000,
    env: {
      ...process.env,
      V5_TARGET: 'test',
      MIGRATE_CONFIRM: dbName,
      V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1',
      ...extraEnv,
    },
  });
  const line = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  let json = null;
  try { json = line ? JSON.parse(line) : null; } catch { json = null; }
  return { mode, status: r.status, json, stderr: (r.stderr || '').trim().slice(0, 400) };
}

function schemaHash() {
  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, 'manifest.json'));
  const manifest = JSON.parse(raw.toString('utf8'));
  const aggregate = crypto.createHash('sha256').update(manifest.migrations.map((m) => `${m.id} ${m.name} ${m.sha256}`).join('\n')).digest('hex');
  return { migrations: manifest.migrations.length, aggregateSha256: aggregate, manifestSha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const target = readTarget();
  const summary = { tool: 'v5-pg-smoke', ok: true, code: 'OK', server: {}, schema: schemaHash(), steps, cleanup: null };

  if (target.skipped) {
    summary.ok = true;
    summary.code = 'SMOKE_NO_TARGET';
    summary.detail = 'V5_PG_URL unset and V5_PG_REQUIRED not set; nothing executed';
    record('target', true, 'no external target (opt-in)');
    return emit(summary, EXIT.OK);
  }

  const { Client } = require('pg');
  const { assertSessionRole, withIdempotentTransaction } = require(path.join(ROOT, 'packages', 'db', 'pg'));

  const controlCfg = clientConfig(target.url);
  summary.control = { host: controlCfg.host, port: controlCfg.port, database: controlCfg.database };
  const admin = new Client(controlCfg);
  const owned = `${OWNED_DB_PREFIX}${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const tracked = [];
  let cleanupDone = false;
  let ownedAdminRef = null;
  let ownedUrl = null;

  const connect = async (cfg, label) => {
    const client = new Client(cfg);
    /* A backend we terminate during cleanup drops the socket; without a listener that emits an
     * unhandled 'error' event and kills the process before the drop can finish. */
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (error) {
      fail(EXIT.CONFIG, 'PG_CONNECT_FAILED', `${label}: ${String(error && error.message || error).slice(0, 200)}`);
    }
    return client;
  };

  /* Bounded drain: terminate the owned database's backends, wait for them to actually leave,
   * then DROP. Never touches the control database or any database we did not create. */
  const dropOwned = async (name) => {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    const deadline = Date.now() + 10000;
    for (;;) {
      const busy = (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name])).rows[0].n;
      if (busy === 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  };

  const expectDenied = async (label, client, sql, params, codes) => {
    let error = null;
    try { await client.query(sql, params); } catch (e) { error = e; }
    if (!error) fail(EXIT.DENIAL, 'DENIAL_MISSING', `${label} was allowed`);
    if (codes && !codes.includes(error.code)) fail(EXIT.DENIAL, 'DENIAL_UNEXPECTED', `${label} -> ${error.code || error.name}`);
    record(`denied:${label}`, true, error.code || 'error');
    return error.code;
  };
  const expectOk = async (label, client, sql, params) => {
    try {
      const r = await client.query(sql, params);
      record(`allowed:${label}`, true, String(r.rowCount));
      return r;
    } catch (error) {
      fail(EXIT.DENIAL, 'ALLOWED_CALL_REJECTED', `${label} -> ${error.code || error.message}`);
    }
  };

  try {
    await admin.connect();
    const version = (await admin.query("SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n")).rows[0];
    const major = Math.floor(Number(version.n) / 10000);
    summary.server = { version: version.v, major };
    if (major !== 16) fail(EXIT.CONFIG, 'PG_MAJOR_MISMATCH', `expected PostgreSQL major 16, connected to ${version.v}`);
    record('server-major', true, `16 (${version.v})`);

    /* ---- owned database (the only name this smoke ever creates or drops) ---- */
    await admin.query(`CREATE DATABASE "${owned}"`);
    tracked.push(owned);
    ownedUrl = urlForDatabase(target.url, owned);
    record('create-owned-db', true, owned);

    /* ---- schema from zero -> verify -> ledger dry-run ---- */
    const execute = runMigrator('--execute', ownedUrl, owned);
    if (execute.status !== 0 || !execute.json || execute.json.code !== 'OK') {
      fail(EXIT.MIGRATION, 'MIGRATION_EXECUTE_FAILED', `exit=${execute.status} code=${execute.json && execute.json.code} ${execute.stderr}`);
    }
    const appliedCount = execute.json.appliedCount;
    if (appliedCount !== summary.schema.migrations) fail(EXIT.MIGRATION, 'MIGRATION_COUNT_MISMATCH', `applied ${appliedCount} of ${summary.schema.migrations}`);
    record('migrate-execute', true, `applied=${appliedCount}`);

    const verify = runMigrator('--verify', ownedUrl, owned);
    if (verify.status !== 0 || !verify.json || verify.json.ok !== true) {
      fail(EXIT.VERIFY, 'CONFORMANCE_FAILED', `exit=${verify.status} code=${verify.json && verify.json.code} failures=${JSON.stringify((verify.json && verify.json.failures || []).slice(0, 5))}`);
    }
    record('migrate-verify', true, `checked=${verify.json.checked}`);

    const dryRun = runMigrator('--dry-run', ownedUrl, owned);
    const statuses = dryRun.json && dryRun.json.plan ? dryRun.json.plan.map((p) => p.status) : [];
    if (dryRun.status !== 0 || dryRun.json.code !== 'OK' || dryRun.json.connected !== true || statuses.length !== appliedCount || statuses.some((s) => s !== 'applied')) {
      fail(EXIT.CHECKSUM, 'LEDGER_DRY_RUN_MISMATCH', `exit=${dryRun.status} code=${dryRun.json && dryRun.json.code} statuses=${[...new Set(statuses)].join(',')}`);
    }
    record('migrate-dry-run', true, `${statuses.length} applied, ledger compares`);

    /* catalog-level probes (schema USAGE, membership edges) read the owned database's
     * namespaces, so they run through a second admin session pinned to that database. */
    const ownedAdmin = await connect({ ...controlCfg, database: owned }, 'owned-admin');
    ownedAdminRef = ownedAdmin;

    /* ---- runtime roles: chain left them NOLOGIN; the owned harness enables exact LOGIN ---- */
    const posture = (await admin.query(
      "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
      [RUNTIME_LOGIN_ROLES])).rows;
    if (posture.length !== RUNTIME_LOGIN_ROLES.length) fail(EXIT.DENIAL, 'RUNTIME_ROLE_MISSING', `chain created ${posture.length} of ${RUNTIME_LOGIN_ROLES.length} runtime roles`);
    const logins = posture.filter((r) => r.rolcanlogin).map((r) => r.rolname);
    if (logins.length !== 0) fail(EXIT.DENIAL, 'RUNTIME_ROLE_LOGIN_UNEXPECTED', `chain shipped LOGIN runtime roles: ${logins.join(',')}`);
    const inheritors = posture.filter((r) => r.rolinherit).map((r) => r.rolname);
    if (inheritors.length !== 0) fail(EXIT.DENIAL, 'RUNTIME_ROLE_INHERIT_UNEXPECTED', `chain shipped INHERIT runtime roles: ${inheritors.join(',')}`);
    for (const role of posture) {
      if (role.rolsuper || role.rolcreatedb || role.rolcreaterole) fail(EXIT.DENIAL, 'RUNTIME_ROLE_PRIVILEGED', `${role.rolname} holds elevated cluster attributes`);
    }
    record('runtime-roles-nologin', true, `${posture.length} roles verified`);

    /* The chain grants the runtime roles USAGE on exactly the schemas they are scoped for and
     * nothing on the others; a later grant widening is caught here as a posture regression. */
    const usage = (await ownedAdmin.query(
      `SELECT r.rolname, n.nspname, has_schema_privilege(r.rolname, n.nspname, 'USAGE') AS usage
         FROM unnest($1::text[]) AS r(rolname)
         CROSS JOIN unnest($2::text[]) AS n(nspname)`,
      [RUNTIME_LOGIN_ROLES, [...new Set(Object.values(ROLE_SCHEMAS).flat())]])).rows;
    for (const row of usage) {
      const want = ROLE_SCHEMAS[row.rolname].includes(row.nspname);
      if (row.usage !== want) fail(EXIT.DENIAL, 'RUNTIME_SCHEMA_USAGE_REGRESSION', `${row.rolname}/${row.nspname} usage=${row.usage} expected=${want}`);
    }
    record('runtime-schema-usage', true, `${usage.length} role/schema probes`);

    /* Ownership is never granted to a runtime role, and no runtime role may hold ANY membership
     * edge at all: 0026 revoked the former backup_reader -> pg_read_all_data shortcut in favour
     * of explicit exact grants, so the approved runtime-membership set is the EMPTY set. Only
     * management-side edges between non-runtime roles may exist. Anything else fails closed,
     * including transitive paths where a runtime role reaches another role through an
     * intermediate role. */
    const membership = (await admin.query(
      `SELECT m.rolname AS member, g.rolname AS granted
         FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
         JOIN pg_roles g ON g.oid = am.roleid
        WHERE m.rolname = ANY($1::text[])`, [RUNTIME_LOGIN_ROLES])).rows;
    for (const edge of membership) {
      if (edge.granted === 'v5_owner' || edge.granted === 'migration_owner') {
        fail(EXIT.DENIAL, 'RUNTIME_ROLE_OWNS_SCHEMA_OWNER', `${edge.member} is a member of ${edge.granted}`);
      }
    }
    if (membership.length) fail(EXIT.DENIAL, 'RUNTIME_ROLE_UNAPPROVED_MEMBERSHIP', membership.map((e) => `${e.member}->${e.granted}`).join(','));
    for (const member of RUNTIME_LOGIN_ROLES) {
      for (const target of RUNTIME_LOGIN_ROLES) {
        if (member === target) continue;
        const held = (await admin.query('SELECT pg_has_role($1, $2, $3) AS m', [member, target, 'MEMBER'])).rows[0].m;
        if (held === true) fail(EXIT.DENIAL, 'RUNTIME_ROLE_TRANSITIVE_ELEVATION', `${member} can reach ${target} (direct or transitive)`);
      }
    }
    record('runtime-membership-posture', true, `${membership.length} edges, none owned by a runtime role`);

    /* Login is enabled out-of-band here, exactly as the contract states: the checksummed chain
     * ships NOLOGIN group roles, the owned synthetic harness attaches a LOGIN principal. */
    for (const role of RUNTIME_LOGIN_ROLES) {
      await admin.query(`ALTER ROLE "${role}" LOGIN NOINHERIT`);
    }
    record('provision-runtime-logins', true, RUNTIME_LOGIN_ROLES.join(','));

    /* ---- guards accept the real login sessions ---- */
    for (const role of RUNTIME_LOGIN_ROLES) {
      const cfg = { ...clientConfig(target.url), database: owned, user: role, password: undefined };
      const client = await connect(cfg, role);
      try {
        /* 0026 removed every runtime membership path: USAGE/SELECT grants are the authority and
         * the guard holds the zero-edge membership policy (no read-all membership probe). */
        const proof = await assertSessionRole(client, role, { schemas: ROLE_SCHEMAS[role], expectedServerMajor: 16 });
        if (proof.current_user !== role || proof.session_user !== role) fail(EXIT.DENIAL, 'ROLE_GUARD_MISMATCH', `${role} probe disagrees`);
        record(`guard-session:${role}`, true, `${proof.current_user}@${proof.serverVersion}`);
      } finally {
        await client.end().catch(() => {});
      }
    }

    /* ---- commit / rollback / replay / conflict through the real unit of work ----
     * Each service connects as its exact runtime role. The chain grants no membership
     * between the runtime roles, so there is no SET ROLE elevation to lean on: the
     * economic mutations below run on a real core_runtime login session. */
    const api = await connect({ ...clientConfig(target.url), database: owned, user: 'api_runtime', password: undefined }, 'api_runtime');
    const core = await connect({ ...clientConfig(target.url), database: owned, user: 'core_runtime', password: undefined }, 'core_runtime');
    const worker = await connect({ ...clientConfig(target.url), database: owned, user: 'worker_runtime', password: undefined }, 'worker_runtime');
    const actorA = `smoke-a-${crypto.randomBytes(3).toString('hex')}`;
    const actorB = `smoke-b-${crypto.randomBytes(3).toString('hex')}`;
    const actorC = `smoke-c-${crypto.randomBytes(3).toString('hex')}`;
    try {
      await expectOk('api actor insert', api, 'INSERT INTO identity.actors (actor_id, created_at) VALUES ($1, now())', [actorA]);
      await expectOk('api second actor insert', api, 'INSERT INTO identity.actors (actor_id, created_at) VALUES ($1, now())', [actorB]);
      await expectOk('api third actor insert', api, 'INSERT INTO identity.actors (actor_id, created_at) VALUES ($1, now())', [actorC]);
      await expectDenied('api direct economy write', api, 'INSERT INTO economy.wallets (actor_id) VALUES ($1)', [actorA], ['42501']);
      /* the same no-elevation rule applies to api_runtime: it must not SET ROLE into core_runtime
       * even though it is the account-facing edge of the app. */
      await expectDenied('api role elevation', api, 'SET ROLE core_runtime', [], ['42501']);

      await expectOk('core wallet write', core, 'INSERT INTO economy.wallets (actor_id) VALUES ($1)', [actorA]);
      await expectOk('core ledger append', core, 'INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1,$2,$3,$4,$5,$6,now())', [`smoke-ledger-${actorA}`, actorA, 'coins', 10, 'smoke', 'spend']);
      await expectDenied('core DDL', core, 'CREATE TABLE economy.smoke_forbidden_ddl (x integer)', [], ['42501']);
      await expectDenied('core ledger update (append-only)', core, 'UPDATE economy.ledger SET amount = amount + 1', [], ['42501']);
      await expectDenied('core ledger delete (append-only)', core, 'DELETE FROM economy.ledger', [], ['42501']);
      await expectDenied('worker role elevation', worker, 'SET ROLE core_runtime', [], ['42501']);
      await expectDenied('worker economy write', worker, 'INSERT INTO economy.wallets (actor_id) VALUES ($1)', [actorA], ['42501']);

      /* commit proof */
      const committed = await withIdempotentTransaction(core, (tx) => tx.query('INSERT INTO economy.wallets (actor_id) VALUES ($1)', [actorB]));
      if (!committed || committed.command !== 'INSERT') fail(EXIT.INTERNAL, 'TX_COMMIT_SHAPE', 'commit did not return the INSERT result');
      const present = (await core.query('SELECT coins FROM economy.wallets WHERE actor_id = $1', [actorB])).rows.length;
      if (present !== 1) fail(EXIT.INTERNAL, 'TX_COMMIT_NOT_DURABLE', 'committed wallet row is absent');
      record('tx-commit', true, 'wallet visible after commit');

      /* rollback proof: the callback throws, the unit of work must undo the write */
      let rolledBack = false;
      try {
        await withIdempotentTransaction(core, async (tx) => {
          await tx.query('INSERT INTO economy.wallets (actor_id) VALUES ($1)', [actorC]);
          throw new Error('smoke-rollback-proof');
        });
      } catch (error) {
        rolledBack = /smoke-rollback-proof/.test(String(error && error.message));
      }
      if (!rolledBack) fail(EXIT.INTERNAL, 'TX_ROLLBACK_NOT_PROPAGATED', 'the callback error did not surface');
      const residual = (await core.query('SELECT 1 AS present FROM economy.wallets WHERE actor_id = $1', [actorC])).rows.length;
      if (residual !== 0) fail(EXIT.INTERNAL, 'TX_ROLLBACK_LEAKED', 'rolled-back wallet row survived');
      record('tx-rollback', true, 'write undone');

      /* replay: two keyed invocations inside one unit of work execute the callback exactly once
       * and the second returns the first's stored result verbatim (single-flight replay).
       * Key encoding split (0034): the live in-process map keyed by withIdempotentTransaction
       * stays the RAW JS key (raw object identity/equality), while the durable command surfaces
       * retain the SOURCE key exactly as canonical JSON text, so every SQL param uses the one
       * JSON.stringify(encodedKey) value computed here — SQL cannot store decoded NUL/surrogate
       * direct-store keys as text. No key rename or alias: `key` remains the raw consumer key. */
      const key = `smoke-replay-${crypto.randomBytes(3).toString('hex')}`;
      const encodedKey = JSON.stringify(key);
      const fingerprint = crypto.createHash('sha256').update(encodedKey).digest('hex');
      let executions = 0;
      const keyed = () => withIdempotentTransaction(core, async (tx) => {
        executions += 1;
        await tx.query('INSERT INTO economy.command_outcomes (actor_id, "key", fingerprint, response, committed_at) VALUES ($1,$2,$3,$4,now())', [actorA, encodedKey, fingerprint, '{"ok":true}']);
        return { key, encodedKey, fingerprint, executions };
      }, { key });
      const replayed = await withIdempotentTransaction(core, async () => {
        const first = await keyed();
        const second = await keyed();
        if (first !== second) fail(EXIT.CONFLICT, 'REPLAY_DIFFERENT_RESULT', 'the second keyed invocation did not return the stored result');
        return first;
      });
      if (executions !== 1) fail(EXIT.CONFLICT, 'REPLAY_DID_NOT_REPLAY', `callback ran ${executions} times for one key`);
      const outcomes = (await core.query('SELECT count(*)::int AS n FROM economy.command_outcomes WHERE actor_id = $1 AND "key" = $2', [actorA, encodedKey])).rows[0].n;
      if (outcomes !== 1) fail(EXIT.CONFLICT, 'REPLAY_DUPLICATED', `replayed key persisted ${outcomes} rows`);
      record('tx-replay', true, `one execution, one row, result ${replayed.fingerprint.slice(0, 12)}…`);

      /* conflict: the durable command surface is keyed by the canonical-JSON text, so a second
       * INSERT of the same encoded key is refused by the (actor_id, key) primary key. */
      const conflictCode = await expectDenied('duplicate command key', core, 'INSERT INTO economy.command_outcomes (actor_id, "key", fingerprint, response, committed_at) VALUES ($1,$2,$3,$4,now())', [actorA, encodedKey, fingerprint, '{"ok":true}'], ['23505']);
      summary.conflict = { code: conflictCode, surface: 'economy.command_outcomes(actor_id,key)' };
    } finally {
      await api.end().catch(() => {});
      await core.end().catch(() => {});
      await worker.end().catch(() => {});
    }

    /* ---- cleanup: only tracked names, never the control database ---- */
    await ownedAdmin.end().catch(() => {});
    const others = (await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${OWNED_DB_PREFIX}%`])).rows.map((r) => r.datname);
    for (const name of tracked) {
      await dropOwned(name);
    }
    const leftovers = (await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${OWNED_DB_PREFIX}%`])).rows.map((r) => r.datname);
    if (leftovers.length) fail(EXIT.INTERNAL, 'CLEANUP_INCOMPLETE', `owned databases survived: ${leftovers.join(',')}`);
    cleanupDone = true;
    summary.cleanup = { dropped: [...tracked], preexistingOwnedPrefix: others.length - tracked.length, controlDatabase: controlCfg.database, untrackedTouched: false };
    record('cleanup-owned-dbs', true, `${tracked.length} dropped`);

    return emit(summary, EXIT.OK);
  } finally {
    /* A failure anywhere above must not leave the smoke's own database on the service: drop
     * exactly the names this run created (tracked), never the control database and never an
     * unknown database, then report any residual owned-prefix leftovers as evidence. */
    try {
      for (const name of tracked) {
        await dropOwned(name);
      }
      if (!cleanupDone) {
        const residual = (await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${OWNED_DB_PREFIX}%`])).rows.map((r) => r.datname);
        summary.cleanup = summary.cleanup || { dropped: [...tracked], residual, controlDatabase: controlCfg.database, untrackedTouched: false };
      }
    } catch { /* the service is disposable; the primary failure stays authoritative */ }
    await ownedAdminRef?.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}

function emit(summary, exitCode) {
  if (process.argv.slice(2).includes('--json')) {
    process.stdout.write(JSON.stringify({ ...summary, exitCode }) + '\n');
  } else {
    const lines = [`v5-pg-smoke ${summary.ok ? 'OK' : 'FAILED'} (${summary.code})`];
    if (summary.detail) lines.push(`detail: ${summary.detail}`);
    if (summary.server && summary.server.version) lines.push(`server: PostgreSQL ${summary.server.version}`);
    if (summary.schema) lines.push(`schema: ${summary.schema.migrations} migrations, aggregate sha256 ${summary.schema.aggregateSha256}`);
    for (const s of summary.steps || []) lines.push(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.step}${s.detail ? ' :: ' + s.detail : ''}`);
    if (summary.cleanup) lines.push(`cleanup: dropped ${summary.cleanup.dropped.length} owned db(s); control '${summary.cleanup.controlDatabase}' untouched`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  return exitCode;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    const exitCode = error instanceof SmokeFailure ? error.exitCode : EXIT.INTERNAL;
    const code = error instanceof SmokeFailure ? error.code : 'INTERNAL';
    const detail = error instanceof SmokeFailure ? error.detail
      : error && error.detail ? `${error.code || error.name}: ${JSON.stringify(error.detail)}${error.cause && error.cause.message ? ' <- ' + error.cause.message : ''}`
      : String(error && error.message || error);
    const summary = { tool: 'v5-pg-smoke', ok: false, code, detail: String(detail).slice(0, 500), steps, schema: (() => { try { return schemaHash(); } catch { return null; } })() };
    emit(summary, exitCode);
    process.exitCode = exitCode;
  });
}

module.exports = { readTarget, schemaHash, ROLE_SCHEMAS, RUNTIME_LOGIN_ROLES, EXIT, urlForDatabase };
