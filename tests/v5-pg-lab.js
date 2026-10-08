'use strict';
/* Shared P05 test laboratory: the frozen disposable-harness contract, extracted verbatim from the
 * P04 service suite's helper section so every P05 slice exercises the SAME real guarded pools, the
 * REAL checksummed migration chain and owned synthetic databases. No SQLite, no mocks, no provider
 * or device claims: everything here is loopback PostgreSQL with synthetic actors only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PID = process.pid;
const SUFFIX = crypto.randomBytes(3).toString('hex');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const OWNED_PREFIX = 'v5_test_p05lab_';
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const CHAIN_LENGTH = (() => JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/migrations/manifest.json'), 'utf8')).migrations.length)();

/* A stable synthetic OTP secret; the account service requires one (>=16 chars). */
const OTP_SECRET = 'v5-p05-lab-test-otp-secret';
const CLOCK = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86400000;

/* ---------------------------------------------------------------- backend */

function whichBinary() {
 for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
  try {
   if (fs.existsSync(path.join(dir, 'initdb')) && execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
  } catch { /* next prefix */ }
 }
 try {
  const found = spawnSync('which', ['initdb'], { encoding: 'utf8' });
  if (found.status === 0 && execFileSync(path.join(found.stdout.trim(), '..', 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return path.dirname(found.stdout.trim());
 } catch { /* not on PATH */ }
 return null;
}
function freePort() {
 return new Promise((resolve, reject) => {
  const net = require('node:net');
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
 });
}
let backend = null, backendError = null;
async function ensureBackend() {
 if (backend) return backend;
 if (backendError) throw new Error(backendError);
 const external = process.env.V5_PG_URL || '';
 if (external) {
  if (process.env.V5_PG_DISPOSABLE !== '1') throw new Error('V5_PG_URL requires V5_PG_DISPOSABLE=1 (owned synthetic cluster only)');
  let u;
  try { u = new URL(external); } catch { throw new Error('V5_PG_URL is unparsable'); }
  if (!LOOPBACK.has(u.hostname)) throw new Error('V5_PG_URL must target a loopback host');
  if (/(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i.test(decodeURIComponent(u.pathname))) throw new Error('V5_PG_URL control database must be non-production');
  const control = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!control || control.startsWith(OWNED_PREFIX)) throw new Error('V5_PG_URL control database must not be one of this lab\'s owned databases');
  backend = { kind: 'external', adminUrl: external, host: u.hostname, port: Number(u.port || 5432) };
  return backend;
 }
 const bin = whichBinary();
 if (!bin) throw new Error('no PostgreSQL 16 backend available (set V5_PG_URL for an owned loopback cluster)');
 const port = await freePort();
 const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v5-p05lab-pg-${PID}-`));
 execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth-local=trust', '--auth-host=trust', '-U', 'postgres', '-E', 'UTF8'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
 execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`, '-l', path.join(dataDir, 'server.log'), 'start'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
 for (let i = 0; i < 60; i += 1) {
  try { execFileSync(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-q'], { timeout: 10000 }); break; }
  catch { if (i === 59) throw new Error('binary PG16 never became ready'); await new Promise((r) => setTimeout(r, 1000)); }
 }
 backend = { kind: 'binary', adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`, host: '127.0.0.1', port, stop: () => {
  try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'i', 'stop'], { stdio: 'ignore', timeout: 30000 }); } catch { /* gone */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
 } };
 return backend;
}

const pg = require('pg');
const createdDatabases = new Set();
function ident(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
async function adminClient(database) {
 const u = new URL(backend.adminUrl);
 const c = new pg.Client({ host: u.hostname, port: Number(u.port || 5432), user: u.username ? decodeURIComponent(u.username) : 'postgres', password: u.username ? decodeURIComponent(u.password || '') : undefined, database: database || decodeURIComponent(u.pathname.replace(/^\//, '')) });
 await c.connect();
 return c;
}
function dbUrl(database) { const u = new URL(backend.adminUrl); u.pathname = `/${database}`; u.search = ''; return u.toString(); }

const poolSets = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { createPgPool } = require(path.join(ROOT, 'packages/db/pg/pool.js'));
const BUDGET = Object.freeze({ totalConnections: 30, roleConnections: Object.freeze({ core_runtime: 12, api_runtime: 12, worker_runtime: 4 }) });
function poolsFor(database) {
 if (poolSets.has(database)) return poolSets.get(database);
 const make = (role, max) => createPgPool({
  host: backend.host, port: backend.port, database, user: role, role, label: 'test',
  service: 'v5-p05lab-test', revision: 'p05lab', allowLocalNoTls: true,
  pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 },
  lockTimeoutMs: 20000, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 30000,
  budget: BUDGET,
 });
 const pools = { core: make('core_runtime', 12), api: make('api_runtime', 12), worker: make('worker_runtime', 4) };
 poolSets.set(database, pools);
 return pools;
}
async function closeDatabasePools(database) {
 const pools = poolSets.get(database);
 if (!pools) return;
 poolSets.delete(database);
 await Promise.allSettled(Object.values(pools).map((p) => p.end()));
}

const { createAccountService } = require(path.join(ROOT, 'packages/services/accounts.js'));
const { createCoreService } = require(path.join(ROOT, 'packages/services/core.js'));
const accountsFor = async (database, options = {}) => createAccountService(poolsFor(database).api, { ...options, now: options.clock || (() => CLOCK), otpSecret: options.otpSecret || OTP_SECRET });
const coreFor = async (database, options = {}) => createCoreService(poolsFor(database).core, { ...options, now: options.clock || (() => CLOCK) });

/* ---------------------------------------------------------------- lifecycle */

function runMigrator(database) {
 const r = spawnSync(process.execPath, [RUNNER, '--execute', '--json', '--database-url', dbUrl(database)], {
  encoding: 'utf8', cwd: ROOT, timeout: 300000,
  env: { ...process.env, V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1', V5_TARGET: 'test', MIGRATE_CONFIRM: database },
 });
 const last = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
 let json = null; try { json = last ? JSON.parse(last) : null; } catch { /* human mode */ }
 return { status: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function createDatabase(family, { migrate = true, runtimeRoles = RUNTIME_ROLES } = {}) {
 const name = `${OWNED_PREFIX}${family}_${PID}_${SUFFIX}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
 const c = await adminClient();
 try { await c.query(`CREATE DATABASE ${ident(name)}`); createdDatabases.add(name); } finally { await c.end(); }
 if (migrate) {
  const migration = runMigrator(name);
  assert.equal(migration.status, 0, `migration failed: ${migration.stdout}${migration.stderr}`);
  assert.equal(migration.json.code, 'OK');
  assert.equal(migration.json.appliedCount, CHAIN_LENGTH, 'the real checksummed chain must apply in full');
 }
 const c2 = await adminClient(name);
 try { for (const role of runtimeRoles) await c2.query(`ALTER ROLE ${ident(role)} LOGIN`); } finally { await c2.end(); }
 return name;
}

/* A per-test boot guard: returns false (after skipping) when no owned backend is configured. */
const boot = async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return false; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return false; }
 return true;
};

/* Close every guarded pool BEFORE the owned databases drop. */
const installCleanup = (test) => test.after(async () => {
 for (const [, pools] of [...poolSets]) { try { await Promise.allSettled(Object.values(pools).map((p) => p.end())); } catch { /* best effort */ } }
 poolSets.clear();
 if (!backend) return;
 for (const name of [...createdDatabases]) {
  try { const c = await adminClient(); try { await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`); } finally { await c.end(); } } catch { /* tracked names only */ }
 }
 try { if (backend.stop) backend.stop(); } catch { /* best effort */ }
});

/* ---------------------------------------------------------------- fixtures */

const SEED_ACTORS = Object.freeze([
 { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
 { actor: 'svc_bob', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
 { actor: 'svc_carol', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'private' },
]);
const tagFor = (actor) => 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 10).toUpperCase();
const USERNAME = (actor) => 'player_' + actor.replace(/^svc_/, '');
function practicePayload(actor, { coins = 10, crowns = 0, theme = 'vector' } = {}) {
 return { version: 3.2, settings: { theme }, wallet: { coins, crowns, ledger: [], owned: [] }, records: [], processed: [], profile: { name: actor } };
}
async function seedActors(database, actors = SEED_ACTORS) {
 const c = await adminClient(database);
 try {
  for (const seed of actors) {
   await c.query('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1, $2, false, $3)',
    [seed.actor, JSON.stringify('Test'), new Date(CLOCK - 30 * DAY).toISOString()]);
   await c.query('INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1, true, false, false)', [seed.actor]);
   await c.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1, $2, $3, $4, $5, $6)',
    [seed.actor, tagFor(seed.actor), USERNAME(seed.actor), seed.actor, new Date(CLOCK - 30 * DAY).toISOString(), seed.stats]);
   await c.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)', [seed.actor, seed.coins, seed.crowns]);
   await c.query('INSERT INTO economy.ratings (actor_id, rating, peak, casual_rating, games, tier) VALUES ($1, $2, $2, $2, $3, $4)',
    [seed.actor, seed.rating, seed.games, 'gold']);
   await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'coins', $3, 'Opening balance', 'provisioning', $4)",
    ['opening:' + seed.actor, seed.actor, seed.coins, new Date(CLOCK - 30 * DAY).toISOString()]);
  }
 } finally { await c.end(); }
}
const seedFor = (names) => names.map((a) => SEED_ACTORS.find((s) => s.actor === a));

/* ---------------------------------------------------------------- probes and gates */

async function scalar(database, text, params = []) {
 const c = await adminClient(database);
 try { const r = await c.query(text, params); return r.rows[0] ? Object.values(r.rows[0])[0] : null; } finally { await c.end(); }
}
async function installSql(database, statements) {
 const c = await adminClient(database);
 try { for (const text of statements) await c.query(text); } finally { await c.end(); }
}
async function waitForLockWaiter(admin, timeoutMs = 12000, min = 1) {
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
  const r = await admin.query('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()');
  if (r.rows[0].n >= min) return true;
  await sleep(20);
 }
 return false;
}
async function holdGate(database, key) {
 const client = await adminClient(database);
 await client.query('SELECT pg_advisory_lock($1::bigint)', [String(key)]);
 return client;
}
async function releaseGate(client, key) {
 try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [String(key)]); } finally { await client.end(); }
}
async function installAdvisoryGate(database, { schema, table, name, when, key }) {
 const fn = `${schema}.${name}`;
 await installSql(database, [
  `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN
    IF ${when} THEN PERFORM pg_advisory_xact_lock(${String(key)}::bigint); END IF;
    RETURN NEW;
   END $fn$`,
  `CREATE TRIGGER ${name}_trg BEFORE INSERT ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
 ]);
 return () => installSql(database, [`DROP TRIGGER ${name}_trg ON ${schema}.${table}`, `DROP FUNCTION ${fn}()`]);
}
const throwsCode = (promise, code) => assert.rejects(promise, (e) => e.message === code, `expected ${code}`);

module.exports = {
 ROOT, OTP_SECRET, CLOCK, DAY, CHAIN_LENGTH, RUNTIME_ROLES, SEED_ACTORS, OWNED_PREFIX,
 ensureBackend, adminClient, dbUrl, poolsFor, closeDatabasePools, accountsFor, coreFor,
 createDatabase, runMigrator, boot, installCleanup, seedActors, seedFor, tagFor, USERNAME, practicePayload,
 scalar, installSql, waitForLockWaiter, holdGate, releaseGate, installAdvisoryGate, throwsCode, sleep,
};
