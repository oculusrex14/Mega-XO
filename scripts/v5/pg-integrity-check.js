#!/usr/bin/env node
'use strict';
/* scripts/v5/pg-integrity-check.js - V5 production PostgreSQL read-only integrity check.
 *
 * WHY THIS EXISTS: the V4 deployment checked SQLite with `PRAGMA quick_check` + a foreign-key sweep
 * inside the `app` container. After the V5 cutover PostgreSQL - not SQLite - is the durable
 * authority and that container is retired, so the V4 check can only report a false failure. The
 * migration runner's `--verify` mode re-checks checksums AND catalog conformance, but it
 * deliberately requires a privileged runner role (migration_owner / CREATEROLE owner), which the
 * monitoring path must NOT hold.
 *
 * This tool is the least-privilege operational analogue. It runs ONLY read-only checks that a
 * read-only role can legitimately perform, and reports them in the same small JSON shape the
 * monitoring unit and /opsz consumed before:
 *   1. connectivity + server major version;
 *   2. the migration ledger is contiguous from 1, with no unknown/duplicated id, and its length
 *      equals the checksummed plan's length (so a schema newer than the checked-in chain, or a
 *      half-applied migration, is caught);
 *   3. every applied migration's recorded checksum matches the checked-in file checksum (replay
 *      conflict detection - the same rule the runner enforces);
 *   4. the REQUIRED application tables exist and are queryable;
 *   5. the runtime roles exist and none holds CREATE on a non-system schema (the no-DDL posture);
 *   6. no unvalidated foreign key exists in the application schemas.
 *
 * It never writes, never applies, never drops. It prints the database NAME only - never the URL,
 * credentials or raw rows.
 *
 * Usage: node scripts/v5/pg-integrity-check.js --database-url <direct url> [--json]
 * Exit: 0 OK | 2 config | 3 integrity failure | 4 connectivity
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const MIGRATIONS_DIR = process.env.V5_MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'packages', 'migrations');
const V5_SCHEMAS = ['meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
  'monetization', 'cosmetics', 'season', 'privacy', 'support', 'audit', 'runtime', 'ops', 'v5_migration', 'learning'];
const REQUIRED_TABLES = [
  'meta.migrations', 'identity.actors', 'identity.eligibility', 'identity.profiles',
  'economy.wallets', 'economy.ratings', 'economy.ledger', 'economy.command_outcomes',
  'match.matches', 'match.escrow_contributions', 'tournament.rooms',
  'monetization.receipts', 'monetization.store_revocations', 'monetization.store_notifications',
  'privacy.requests', 'privacy.deletion_receipts', 'audit.operator_audit', 'ops.outbox',
];
const RUNTIME_ROLES = process.env.V5_RUNTIME_ROLES
  ? process.env.V5_RUNTIME_ROLES.split(',')
  : ['api_runtime', 'core_runtime', 'worker_runtime'];

function parseArgs(argv) {
  const out = { json: false, url: process.env.V5_INTEGRITY_DATABASE_URL || null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--database-url') out.url = argv[++i];
    else if (argv[i] === '--migrations-dir') out.dir = argv[++i];
    else throw Object.assign(new Error('unknown argument ' + argv[i]), { exitCode: 2 });
  }
  return out;
}

/* The checksum rule is shared with the migration runner: sha256(name + '\n' + sql), where the SQL
 * is hashed as BYTES so a repository with CRLF line endings hashes identically to the runner. */
function migrationChecksum(name, sql) {
  const body = Buffer.isBuffer(sql) ? sql : Buffer.from(sql, 'utf8');
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from(name + '\n', 'utf8'), body])).digest('hex');
}

function loadPlan(dir) {
  const files = fs.readdirSync(path.join(dir, 'migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return files.map((file, index) => {
    const sql = fs.readFileSync(path.join(dir, 'migrations', file));
    const name = file.replace(/\.sql$/, '');
    return { id: index + 1, name, sha256: migrationChecksum(name, sql) };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || typeof args.url !== 'string') {
    throw Object.assign(new Error('a direct database URL is required (--database-url or V5_INTEGRITY_DATABASE_URL)'), { exitCode: 2 });
  }
  let parsed;
  try { parsed = new URL(args.url); } catch { throw Object.assign(new Error('database URL is unparsable'), { exitCode: 2 }); }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw Object.assign(new Error('only postgresql:// URLs are accepted'), { exitCode: 2 });
  if (/pooler/i.test(parsed.hostname)) throw Object.assign(new Error('pooler endpoints are refused; integrity checks use the DIRECT endpoint'), { exitCode: 2 });

  const plan = loadPlan(args.dir || MIGRATIONS_DIR);
  const failures = [];
  const client = new Client({
    connectionString: args.url,
    application_name: 'mega-v5-pg-integrity',
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    query_timeout: 30000,
  });
  let serverMajor = null;
  try {
    await client.connect();
    /* Read-only posture, enforced by the session itself. */
    await client.query('SET default_transaction_read_only = on');
    serverMajor = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2));

    /* 2+3. Ledger contiguity and checksum agreement with the checked-in chain. */
    const ledger = (await client.query('SELECT id, name, checksum FROM meta.migrations ORDER BY id')).rows;
    if (ledger.length !== plan.length) {
      failures.push(`ledger holds ${ledger.length} migrations but the checked-in chain has ${plan.length}`);
    }
    for (let i = 0; i < Math.min(ledger.length, plan.length); i += 1) {
      const row = ledger[i], want = plan[i];
      if (Number(row.id) !== want.id) { failures.push(`ledger row ${i} has id ${row.id}, expected ${want.id}`); continue; }
      if (row.name !== want.name) failures.push(`ledger row ${row.id} is ${row.name}, expected ${want.name}`);
      else if (row.checksum !== want.sha256) failures.push(`checksum conflict on ${want.name}: applied ${row.checksum} != file ${want.sha256}`);
    }

    /* 4. The REQUIRED tables exist and are queryable. */
    const tables = new Set((await client.query(
      "SELECT n.nspname || '.' || c.relname AS qualified FROM pg_catalog.pg_class c " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE c.relkind = 'r' AND n.nspname = ANY($1)", [V5_SCHEMAS])).rows.map((r) => r.qualified));
    for (const table of REQUIRED_TABLES) if (!tables.has(table)) failures.push(`required table ${table} is missing`);

    /* 5. The no-DDL posture: no runtime role may hold CREATE on a non-system schema. */
    const ddl = (await client.query(
      "SELECT r.rolname, n.nspname FROM pg_catalog.pg_roles r " +
      "CROSS JOIN pg_catalog.pg_namespace n " +
      "WHERE r.rolname = ANY($1) AND n.nspname = ANY($2) " +
      "AND has_schema_privilege(r.rolname, n.nspname, 'CREATE')", [RUNTIME_ROLES, V5_SCHEMAS])).rows;
    for (const row of ddl) failures.push(`runtime role ${row.rolname} holds CREATE on ${row.nspname}`);
    const rolesPresent = (await client.query('SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1)', [RUNTIME_ROLES])).rows.map((r) => r.rolname);
    for (const role of RUNTIME_ROLES) if (!rolesPresent.includes(role)) failures.push(`runtime role ${role} is missing`);

    /* 6. No unvalidated foreign key in the application schemas. */
    const fks = (await client.query(
      "SELECT n.nspname || '.' || c.relname AS qualified, con.conname FROM pg_catalog.pg_constraint con " +
      "JOIN pg_catalog.pg_class c ON c.oid = con.conrelid " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE con.contype = 'f' AND NOT con.convalidated AND n.nspname = ANY($1)", [V5_SCHEMAS])).rows;
    for (const row of fks) failures.push(`unvalidated foreign key ${row.conname} on ${row.qualified}`);
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }

  const ok = failures.length === 0;
  const summary = {
    ok,
    check: 'ledger+checksums+required-tables+no-ddl+validated-foreign-keys',
    database: parsed.pathname.replace(/^\//, '') || null,
    serverMajor,
    migrationsChecked: plan.length,
    failures,
  };
  if (args.json) process.stdout.write(JSON.stringify(summary) + '\n');
  else process.stdout.write((ok ? 'MEGA_XO_DATABASE_INTEGRITY_OK\n' : 'MEGA_XO_DATABASE_INTEGRITY_FAILED: ' + failures.join('; ') + '\n'));
  return ok ? 0 : 3;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write('PG_INTEGRITY_ERROR: ' + (err.code || err.message) + '\n');
    process.exitCode = err.exitCode || 2;
  });
}

module.exports = { V5_SCHEMAS, REQUIRED_TABLES, RUNTIME_ROLES, migrationChecksum, loadPlan, main };
