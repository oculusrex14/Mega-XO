/* tests/v5-p04-services.test.js - V5 P04 PG-backed service-path acceptance.
 *
 * WHAT THIS PROVES
 *   P04's actual production service path is PostgreSQL-only and behaves like the approved V4.1.2
 *   behaviour. This suite constructs the REAL service factories
 *   (`createAccountService`/`createCoreService`/`createCommerceService`) over caller-owned GUARDED
 *   pools (`createPgPool`) against a schema built by the REAL checksummed migration chain, and drives
 *   the real behaviour through them:
 *
 *     1. read-only wrong-schema boot: a missing meta ledger, an incomplete chain and a tampered
 *        checksum each fail the boot with the readiness vocabulary (`SCHEMA_NOT_READY` /
 *        `SCHEMA_INCOMPATIBLE`) and the failed boot mutates nothing and adds no default grant;
 *     2. profile privacy/case/tag retention: private stats are hidden from a non-friend and shown to
 *        the owner/friend, a username edit normalises case, and the stable tag/provider subject survive;
 *     3. revisioned practice saves: two racing writers at the same revision produce exactly one winner
 *        and one `SAVE_CONFLICT`, and a wallet-shaped practice payload never touches the server wallet;
 *     4. friend request/accept/block effects plus EXACT replay (same key returns the stored result) and
 *        conflict (same key, different command -> `IDEMPOTENCY_CONFLICT`);
 *     5. overlapping conversion clients: exactly one winner, no overdraw, the loser refuses;
 *     6. outcome+outbox failure rolls the wallet/ledger/outcome back. The failure is injected as a real
 *        DATABASE fixture (a constraint/trigger installed by the admin/owner on `ops.outbox`), never a
 *        service mock;
 *     7. the same operation key concurrently and after a lost response applies exactly once and returns
 *        the stored response on the retry;
 *     8. verified store purchases: racing callbacks grant once, a refund tombstone never re-mints,
 *        pending/invalid backend evidence grants nothing, and the provider verifier runs OUTSIDE any
 *        open transaction (asserted from `pg_stat_activity`, not from a mock call log);
 *     9. provisioning: an existing imported actor is NEVER re-granted, and a fresh pending actor gets
 *        exactly the approved initial 150 Coins / one `opening:<actor>` ledger row once, replaying
 *        idempotently;
 *    10. lock order under real row locks: accepting and cancelling the SAME offered match from two
 *        independent scopes serialize on the match row (one terminal outcome, no lost result), a
 *        RUNNING match is never cancelled by the social-removal path, and a pending-actor provision
 *        racing a refund of the same actor completes without a 40P01 deadlock;
 *    11. the direct `core.run` purchase boundary refuses with `COMMERCE_OWNED_COMMAND` and mints
 *        nothing (only `commerce.purchase` may grant), and a stale social-removal callback against a
 *        currently-friended pair cancels nothing while a real removal does cancel the open offer;
 *    12. ACCOUNT/AUTH regressions: both shipped password formats authenticate; denied credentials and
 *        wrong OTPs commit their abuse counters durably (five wrong codes -> `OTP_LOCKED`); reset
 *        verifies without consuming, completes once, and a replayed/stale-stamp completion refuses;
 *        provider reauth/link ownership is exact and a FORCED same-subject race creates ONE actor;
 *        concurrent unlinks never leave a methodless account and a consumed provider attempt cannot
 *        re-add an unlinked method; a source bearer is consumed exactly once; many same-actor
 *        transitions serialize without a deadlock (real database barriers, never optimistic races);
 *    13. PROFILE/SOCIAL regressions: the public season is the approved projection (no raw opponent
 *        ids/wins), an API-only read across a quarter boundary writes no Core state, a block beyond
 *        1000 incident edges still decides the pair, request/accept validate BOTH participants,
 *        deletion hides the disabled profile while a wallet-pending actor stays readable, a forced
 *        Core admission during deletion never yields a disabled busy actor, and the schemaVersion1
 *        export carries every nested category with real records;
 *    14. CORE/COMMERCE regressions: a wallet-less actor can neither mutate nor play, a duplicate
 *        match identity is rejected rather than replaced, a service principal's same-key aggregate
 *        conflict writes nothing, disjoint settlements both survive in the burned singleton, a
 *        quarter rollover archives the prior season and normalizes only LOCKED actors, refunds
 *        establish permanent revocations (unknown receipt and duplicate repair) and the direct Core
 *        refund is commerce-owned, a receipt outside the 5000-row cap never regrants, and a new
 *        actor's approved season/credits/record rows are materialized with its wallet.
 *
 * Harness contract (the frozen P02 disposable PG16 contract used by every P04 suite):
 *   - V5_PG_URL=<loopback direct admin URL> + V5_PG_DISPOSABLE=1: a caller-owned synthetic PG16
 *     cluster. The URL is used ONLY to create/drop this suite's tracked v5_test_p04svc_* databases,
 *     enable the runtime LOGIN identities, and install/seed fixtures as the trusted admin; the control
 *     database is never mutated, truncated or dropped.
 *   - Without V5_PG_URL: installed PostgreSQL 16 binaries on a test-owned mkdtemp datadir.
 *   - V5_PG_REQUIRED=1: fail instead of skipping when no backend is available.
 * No Neon, production or SQLite path is ever contacted. This file edits nothing.
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const MANIFEST = require(path.join(ROOT, 'packages', 'migrations', 'manifest.json'));
const CHAIN_LENGTH = MANIFEST.migrations.length;
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
const SUFFIX = crypto.randomBytes(4).toString('hex');
const PID = process.pid;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const OWNED_PREFIX = 'v5_test_p04svc_';
/* The account service requires a STABLE per-environment OTP HMAC secret (>=16 chars); a synthetic
 * value is injected exactly as a deployment would, so no per-process random fallback is relied on. */
const OTP_SECRET = 'v5-p04-service-test-otp-secret';

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
  if (found.status === 0 && execFileSync(found.stdout.trim(), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return path.dirname(found.stdout.trim());
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
  if (!control || control.startsWith(OWNED_PREFIX)) throw new Error('V5_PG_URL control database must not be one of this suite\'s owned databases');
  backend = { kind: 'external', adminUrl: external, host: u.hostname, port: Number(u.port || 5432) };
  return backend;
 }
 const bin = whichBinary();
 if (!bin) throw new Error('no PostgreSQL 16 backend available (set V5_PG_URL for an owned loopback cluster)');
 const port = await freePort();
 const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v5-p04svc-pg-${PID}-`));
 execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth-local=trust', '--auth-host=trust', '-U', 'postgres', '-E', 'UTF8'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
 execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`, '-l', path.join(dataDir, 'server.log'), 'start'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
 for (let i = 0; i < 60; i += 1) {
  try { execFileSync(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-q'], { stdio: 'ignore', timeout: 10000 }); break; }
  catch { if (i === 59) throw new Error('binary PG16 never became ready'); execFileSync('sleep', ['1']); }
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
/* A RAW connection as a runtime role: used only to prove the role itself holds no DDL. It is not the
 * guarded pool path (deliberately), because this probe must read the role's own privileges. */
async function roleClient(database, role) {
 const u = new URL(backend.adminUrl);
 const c = new pg.Client({ host: u.hostname, port: Number(u.port || 5432), user: role, database });
 await c.connect();
 return c;
}
function dbUrl(database) { const u = new URL(backend.adminUrl); u.pathname = `/${database}`; u.search = ''; return u.toString(); }

test.after(async () => {
 /* Close every guarded pool BEFORE dropping the owned databases: dropping a database while a pool
  * still holds a connection yields an asynchronous terminating-connection error on that pool, which
  * node:test reports as an uncaught failure. Every step is isolated so one failure never leaves a
  * later resource (or the cluster) dangling. */
 for (const [database, pools] of [...poolSets]) {
  try { await Promise.allSettled(Object.values(pools).map((p) => p.end())); } catch { /* best effort */ }
  poolSets.delete(database);
 }
 if (!backend) return;
 for (const name of [...createdDatabases]) {
  try { const c = await adminClient(); try { await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`); } finally { await c.end(); } } catch { /* best effort, tracked names only */ }
 }
 try { if (backend.stop) backend.stop(); } catch { /* best effort */ }
});

/* ---------------------------------------------------------------- migrations */

function runMigrator(database) {
 const r = spawnSync(process.execPath, [RUNNER, '--execute', '--json', '--database-url', dbUrl(database)], {
  encoding: 'utf8', cwd: ROOT, timeout: 300000,
  env: { ...process.env, V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1', V5_TARGET: 'test', MIGRATE_CONFIRM: database },
 });
 const last = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
 let json = null; try { json = last ? JSON.parse(last) : null; } catch { /* human mode */ }
 return { status: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/* Creates one owned database, migrates it with the REAL checksummed chain, then enables the runtime
 * LOGIN identities - the frozen disposable harness contract. */
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

/* ---------------------------------------------------------------- pools (target side) */

const { createPgPool } = require('../packages/db/pg/pool.js');
const { verifyRuntimeSchema } = require('../packages/db/pg/readiness.js');
const { createAccountService } = require('../packages/services/accounts.js');
const { createCoreService } = require('../packages/services/core.js');
const { createCommerceService } = require('../packages/services/commerce.js');
/* The SHIPPED production password format (scrypt-v1$ / N=131072), the frozen legacy V4 policy helper
 * the account policy keeps for its other callers, and the shared domain (season quarter identity). */
const { Passwords } = require('../server/production/passwords.js');
const policy = require('../packages/domain/account-policy.js');
const D = require('../src/domain.js');

const BUDGET = Object.freeze({ totalConnections: 24, roleConnections: Object.freeze({ core_runtime: 10, api_runtime: 10, worker_runtime: 4 }) });
const poolSets = new Map();
function poolsFor(database) {
 if (poolSets.has(database)) return poolSets.get(database);
 const make = (role, max) => createPgPool({
  host: backend.host, port: backend.port, database, user: role, role, label: 'test',
  service: 'v5-p04svc-test', revision: 'p04services', allowLocalNoTls: true,
  pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 },
  /* The race regressions deliberately hold a lock while a competitor is observed waiting, so the
   * guarded pool's default 2s lock / 5s statement deadlines are raised to keep a scripted barrier
   * from being aborted by the pool's own timers instead of exercising the serialization under test. */
  lockTimeoutMs: 20000, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 30000,
  budget: BUDGET,
 });
 const pools = { core: make('core_runtime', 10), api: make('api_runtime', 10), worker: make('worker_runtime', 4) };
 poolSets.set(database, pools);
 return pools;
}
async function closeDatabasePools(database) {
 const pools = poolSets.get(database);
 if (!pools) return;
 poolSets.delete(database);
 await Promise.allSettled(Object.values(pools).map((p) => p.end()));
}

/* The account and core factories are given the caller-owned guarded pool for their exact runtime
 * role. Boot is asynchronous and verifies role + schema before it returns (frozen interface). */
async function services(database, options = {}) {
 const pools = poolsFor(database);
 const now = options.now || (() => CLOCK);
 const [accounts, core] = await Promise.all([
  createAccountService(pools.api, { ...options, now, otpSecret: options.otpSecret || OTP_SECRET }),
  createCoreService(pools.core, { ...options, now }),
 ]);
 return { accounts, core };
}

/* ---------------------------------------------------------------- trusted-importer fixtures */

const SEED_ACTORS = Object.freeze([
 { actor: 'svc_alice', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
 { actor: 'svc_bob', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' },
 { actor: 'svc_carol', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'private' },
]);
function tagFor(actor) { return 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 10).toUpperCase(); }
const USERNAME = (actor) => 'player_' + actor.replace(/^svc_/, '');

/* The trusted provisioner (the P03 importer's shape): actor/eligibility/profile/profile_saves/wallet/
 * rating + the opening ledger rows. The SERVICES must never mint any of this. */
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
   if (seed.crowns > 0) {
    await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'crowns', $3, 'Opening balance', 'provisioning', $4)",
     ['opening-crowns:' + seed.actor, seed.actor, seed.crowns, new Date(CLOCK - 30 * DAY).toISOString()]);
   }
   await c.query('INSERT INTO profile.profile_saves (actor_id, revision, payload_text, updated_at) VALUES ($1, $2, $3, $4)',
    [seed.actor, 1, JSON.stringify(practicePayload(seed.actor)), new Date(CLOCK - 3600000).toISOString()]);
  }
 } finally { await c.end(); }
}

/* A structurally valid practice document (the source producer's contract: version 3.2, settings with
 * an approved theme, integer wallet fields). `coins` here is PRACTICE data and must never authorise. */
function practicePayload(actor, { coins = 10, crowns = 0, theme = 'vector' } = {}) {
 return { version: 3.2, settings: { theme }, wallet: { coins, crowns, ledger: [], owned: [] }, records: [], processed: [], profile: { name: actor } };
}

/* A catalogue-valid, verified store evidence object (the shape the legacy verifier returns). */
let purchaseSeq = 0;
function googleEvidence(transactionId, productId = 'crowns_100') {
 purchaseSeq += 1;
 return { store: 'google', productId, transactionId, purchaseToken: 'tok-' + crypto.randomBytes(6).toString('hex'), orderId: 'order-' + purchaseSeq };
}

/* ---------------------------------------------------------------- catalog snapshots */

/* A cheap, comparable picture of everything a boot could write: relation count, the runtime grant
 * matrix, the migration ledger, and the rows of the tables a service could seed. Compared before and
 * after a failed boot to prove "no mutation and no default grant". */
async function snapshot(c, database) {
 const rels = (await c.query("SELECT count(*)::int AS n FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')")).rows[0].n;
 const grants = (await c.query("SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee IN ('api_runtime','core_runtime','worker_runtime')")).rows[0].n;
 /* The `missing` case has no meta.migrations at all. PostgreSQL resolves `meta.migrations` at
  * PARSE time, so a CASE guard cannot help: existence is probed first (to_regclass) and the ledger
  * is represented as genuinely ABSENT (null) rather than fabricated as zero - which is also what the
  * before/after comparison must then see on both sides. */
 const present = (await c.query("SELECT to_regclass('meta.migrations') IS NOT NULL AS present")).rows[0].present;
 let migrations = null, head = null;
 if (present) {
  const ledger = (await c.query('SELECT count(*)::int AS n, coalesce(max(id),0)::int AS head FROM meta.migrations')).rows[0];
  migrations = ledger.n; head = ledger.head;
 }
 const count = async (table) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
 return {
  rels, grants, migrations, head, database,
  actors: await count('identity.actors'), wallets: await count('economy.wallets'),
  ledgerRows: await count('economy.ledger'), outbox: await count('ops.outbox'),
  saves: await count('profile.profile_saves'),
 };
}

/* ================================================================ 1. BOOT / READINESS */

/* Wrong-schema, incomplete-chain and tampered-checksum boots must all be refused fail-closed, and a
 * refused boot must leave the database and the runtime grant matrix exactly as it found them. */
test('P04 services: read-only wrong-schema boot is refused and mutates nothing', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL and V5_PG_REQUIRED unset'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }

 /* Three independently damaged copies of the full schema: the ledger absent, the chain short, and a
  * checksum falsified. Each is repaired by admin DDL only - never by a service. */
 const broken = { missing: await createDatabase('boot_missing'), short: await createDatabase('boot_short'), tampered: await createDatabase('boot_tampered') };
 const full = await createDatabase('boot_full');

 /* The guarded pool's checkout verifies the role's schema grants, so a runtime boot is only
  * reachable once the runtime-boundary migration grants `meta` USAGE/SELECT (needed for the chain
  * read). Without it the pool cannot even check out, and the refusal below would be a grant error
  * rather than the readiness verdict under test. */
 const grants = await adminClient(full);
 let metaReady;
 try {
  metaReady = (await grants.query(`SELECT
    has_schema_privilege('api_runtime', 'meta', 'USAGE') AND
    has_table_privilege('api_runtime', 'meta.migrations', 'SELECT') AS ok`)).rows[0].ok;
 } finally { await grants.end(); }
 if (!metaReady) {
  const message = 'P04_SERVICE_INTEGRATION_INCOMPLETE: runtime meta USAGE/SELECT (0038) is absent, so the guarded pool cannot check out';
  if (process.env.V5_PG_REQUIRED === '1') throw new Error(message);
  t.skip(message); return;
 }

 const c = await adminClient(broken.missing);
 try { await c.query('DROP TABLE meta.migrations'); } finally { await c.end(); }
 const c2 = await adminClient(broken.short);
 try { await c2.query(`DELETE FROM meta.migrations WHERE id > $1`, [CHAIN_LENGTH - 2]); } finally { await c2.end(); }
 const c3 = await adminClient(broken.tampered);
 try { await c3.query(`UPDATE meta.migrations SET checksum = $1 WHERE id = $2`, ['0'.repeat(64), CHAIN_LENGTH]); } finally { await c3.end(); }

 for (const [kind, database] of Object.entries(broken)) {
  const beforeClient = await adminClient(database);
  let before;
  try { before = await snapshot(beforeClient, database); } finally { await beforeClient.end(); }
  const pools = poolsFor(database);
  const expected = kind === 'missing' ? /SCHEMA_NOT_READY/ : /SCHEMA_INCOMPATIBLE/;

  /* The frozen readiness interface itself refuses... */
  await assert.rejects(() => verifyRuntimeSchema(pools.api), expected, `${kind}: verifyRuntimeSchema`);
  await assert.rejects(() => verifyRuntimeSchema(pools.core), expected, `${kind}: verifyRuntimeSchema (core)`);

  /* ...and so does every real factory, before it hands a caller a usable service. */
  await assert.rejects(() => createAccountService(pools.api, { now: () => CLOCK, otpSecret: OTP_SECRET }), expected, `${kind}: createAccountService`);
  await assert.rejects(() => createCoreService(pools.core, { now: () => CLOCK }), expected, `${kind}: createCoreService`);
  await assert.rejects(() => createCommerceService(pools.core, { now: () => CLOCK }), expected, `${kind}: createCommerceService`);

  const cAfter = await adminClient(database);
  let after;
  try { after = await snapshot(cAfter, database); } finally { await cAfter.end(); }
  assert.equal(after.rels, before.rels, `${kind}: a refused boot must not create or drop a relation`);
  assert.equal(after.grants, before.grants, `${kind}: a refused boot must not add a default grant`);
  assert.equal(after.migrations, before.migrations, `${kind}: a refused boot must not rewrite the migration ledger`);
  assert.equal(after.head, before.head, `${kind}: a refused boot must not rewrite the migration head`);
  assert.equal(after.actors, before.actors, `${kind}: a refused boot must not seed an actor`);
  assert.equal(after.wallets, before.wallets, `${kind}: a refused boot must not seed a wallet`);
  assert.equal(after.ledgerRows, before.ledgerRows, `${kind}: a refused boot must not append a ledger row`);
  assert.equal(after.outbox, before.outbox, `${kind}: a refused boot must not enqueue an outbox job`);
  assert.equal(after.saves, before.saves, `${kind}: a refused boot must not write a save`);
  await closeDatabasePools(database);
 }

 /* The healthy control must BOOT (otherwise the refusals above could be an arbitrary failure). It
  * needs the runtime-boundary grants (0038) for a non-privileged boot, so on an integration-incomplete
  * schema the control is skipped rather than reported as an adapter defect. */
 if (!(await requireServiceIntegration(t, full, { projection: false }))) return;
 const healthy = await services(full);
 assert.ok(healthy.accounts && healthy.core, 'a full, untampered schema must boot');
 assert.equal((await verifyRuntimeSchema(poolsFor(full).api)).migrations, CHAIN_LENGTH);
 await healthy.accounts.close(); await healthy.core.close();

 /* No runtime identity may hold DDL: a direct api_runtime session is refused CREATE on the very
  * schema it is granted USAGE on. */
 const ddl = await roleClient(full, 'api_runtime');
 try {
  await assert.rejects(() => ddl.query('CREATE TABLE identity.p04_probe (id int)'), (e) => e.code === '42501');
 } finally { await ddl.end(); }
 await closeDatabasePools(full);
});

/* ================================================================ shared driving helpers */

/* The service path depends on the parent-owned runtime-boundary migrations (grants) and the owner
 * projection functions. Asserting those capabilities up front (name-independent, by privilege and
 * function existence) makes an incomplete integration fail with a PRECISE message instead of a
 * confusing 42501/42883 inside a request, and never lets the suite pass vacuously. */
async function serviceCapabilities(database) {
 const c = await adminClient(database);
 try {
  return (await c.query(`SELECT
    to_regprocedure('profile.account_state(text)') IS NOT NULL AS projection,
    to_regprocedure('profile.account_activity(text)') IS NOT NULL AS activity_fn,
    to_regprocedure('profile.account_export(text)') IS NOT NULL AS export_fn,
    to_regprocedure('identity.auth_credential(text,text)') IS NOT NULL AS credential_fn,
    has_table_privilege('core_runtime', 'ops.outbox', 'INSERT') AS core_outbox,
    has_table_privilege('api_runtime', 'ops.outbox', 'INSERT') AS api_outbox,
    has_table_privilege('api_runtime', 'social.command_outcomes', 'INSERT') AS api_social_outcome`)).rows[0];
 } finally { await c.end(); }
}
async function requireServiceIntegration(t, database, { projection = true } = {}) {
 const caps = await serviceCapabilities(database);
 const missing = [];
 if (!caps.core_outbox) missing.push('core_runtime INSERT on ops.outbox');
 if (!caps.api_outbox) missing.push('api_runtime INSERT on ops.outbox');
 if (!caps.api_social_outcome) missing.push('api_runtime INSERT on social.command_outcomes');
 if (projection && !caps.projection) missing.push('profile.account_state(text)');
 if (projection && !caps.activity_fn) missing.push('profile.account_activity(text)');
 if (projection && !caps.export_fn) missing.push('profile.account_export(text)');
 if (projection && !caps.credential_fn) missing.push('identity.auth_credential(text,text)');
 if (missing.length === 0) return true;
 const message = `P04_SERVICE_INTEGRATION_INCOMPLETE: the runtime-boundary grants/projection functions are absent (${missing.join('; ')})`;
 if (process.env.V5_PG_REQUIRED === '1') throw new Error(message);
 t.skip(message);
 return false;
}

/* One live account service for the profile/social/save cases. */
async function accountHarness(actorSeeds = SEED_ACTORS, family = 'accounts') {
 const database = await createDatabase(family);
 await seedActors(database, actorSeeds);
 const [accounts, core] = await Promise.all([
  createAccountService(poolsFor(database).api, { now: () => CLOCK, otpSecret: OTP_SECRET }),
  createCoreService(poolsFor(database).core, { now: () => CLOCK }),
 ]);
 return { database, accounts, core };
}

/* The server wallet, read directly: the practice archive must never influence it. */
async function walletOf(database, actor) {
 const c = await adminClient(database);
 try { const r = await c.query('SELECT coins, crowns, reserved_coins, reserved_crowns, purchased_crowns FROM economy.wallets WHERE actor_id = $1', [actor]); return r.rows[0] || null; } finally { await c.end(); }
}
async function ledgerCount(database, like) {
 const c = await adminClient(database);
 try { const r = await c.query('SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id LIKE $1', [like]); return r.rows[0].n; } finally { await c.end(); }
}

/* ================================================================ 2. PROFILE */

test('P04 account service: profile privacy, case normalisation and tag/provider retention', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const { database, accounts } = await accountHarness();
 if (!(await requireServiceIntegration(t, database))) return;

 /* The owner sees its own private-adjacent surface; a non-friend does NOT see private stats. */
 const own = await accounts.view('svc_carol', 'svc_carol');
 assert.equal(own.tag, tagFor('svc_carol'), 'the canonical tag is retained');
 assert.ok(own.stats, 'the owner sees its own stats');
 const stranger = await accounts.view('svc_alice', 'svc_carol');
 assert.equal(stranger.stats, null, 'a private profile hides stats from a non-friend');
 /* A friends-visible profile is shown to a non-friend? No: `friends` means friends only. */
 const friendsOnly = await accounts.view('svc_alice', 'svc_bob');
 assert.equal(friendsOnly.stats, null, 'stats_visibility friends hides stats from a non-friend');

 /* Case normalisation and stable retention through an edit: the username is lowercased and the
  * tag/provider subject survive. */
 await accounts.edit('svc_alice', { username: 'SVC_ALICE', displayName: 'Alice A', avatar: 'star' });
 const edited = await accounts.view('svc_alice', 'svc_alice');
 assert.equal(edited.username, 'svc_alice', 'a username edit normalises case to lowercase');
 assert.equal(edited.tag, tagFor('svc_alice'), 'an edit must never regenerate the tag');
 assert.equal(edited.displayName, 'Alice A');

 const c = await adminClient(database);
 try {
  await c.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google', 'google-subject-alice', 'svc_alice', $1)", [new Date(CLOCK).toISOString()]);
 } finally { await c.end(); }
 const withProvider = await accounts.self('svc_alice');
 assert.deepEqual(withProvider.providers, ['google'], 'the linked provider subject is preserved');
 /* A private actor is still readable by its owner and its tag/case semantics are the source ones. */
 assert.equal((await accounts.view('svc_carol', 'svc_carol')).username, USERNAME('svc_carol'));
 await accounts.close();
 await closeDatabasePools(database);
});

/* ================================================================ 3. SAVES */

test('P04 account service: revisioned saves race to one winner and never authorise a wallet', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const { database, accounts } = await accountHarness([SEED_ACTORS[0]], 'saves');
 if (!(await requireServiceIntegration(t, database))) return;

 /* Two clients hold revision 1 and race a write: exactly one wins, the other sees SAVE_CONFLICT. */
 const payloadA = practicePayload('svc_alice', { coins: 111, crowns: 3, theme: 'midnight' });
 const payloadB = practicePayload('svc_alice', { coins: 222, crowns: 4, theme: 'paperclub' });
 const raced = await Promise.allSettled([
  accounts.save('svc_alice', 1, payloadA),
  accounts.save('svc_alice', 1, payloadB),
 ]);
 const ok = raced.filter((r) => r.status === 'fulfilled');
 const failed = raced.filter((r) => r.status === 'rejected');
 assert.equal(ok.length, 1, 'exactly one racing save may win');
 assert.equal(failed.length, 1, 'the loser must refuse rather than overwrite');
 assert.match(String(failed[0].reason && failed[0].reason.message), /^SAVE_CONFLICT$/, 'the loser sees the bare SAVE_CONFLICT code');
 assert.equal(ok[0].value.revision, 2, 'the winner advances the revision exactly once');

 /* The archive stores PRACTICE data only: the server wallet is bit-for-bit unchanged. */
 const stored = await accounts.restore('svc_alice');
 assert.equal(stored.revision, 2);
 const practiceCoins = stored.practice.wallet.coins;
 assert.ok([111, 222].includes(practiceCoins), 'the stored practice wallet is the winner\'s practice document');
 const wallet = await walletOf(database, 'svc_alice');
 assert.equal(Number(wallet.coins), 1000, 'a wallet-shaped practice payload must never authorise the server wallet');
 assert.equal(Number(wallet.crowns), 100, 'nor mint Crowns');

 /* A stale revision is refused and writes nothing. */
 await assert.rejects(() => accounts.save('svc_alice', 1, practicePayload('svc_alice')), (e) => e.message === 'SAVE_CONFLICT');
 assert.equal((await accounts.restore('svc_alice')).revision, 2, 'a refused save must not advance the revision');
 await accounts.close();
 await closeDatabasePools(database);
});

/* ================================================================ 4. SOCIAL */

test('P04 account service: friend/request/block effects and exact replay/conflict', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const { database, accounts } = await accountHarness(['svc_alice', 'svc_bob', 'svc_carol'].map((a) => SEED_ACTORS.find((s) => s.actor === a)), 'social');
 if (!(await requireServiceIntegration(t, database))) return;

 /* request -> (bob sees incoming) -> accept -> friends, plus block removes the friendship. */
 const requested = await accounts.social('svc_alice', 'req-1', 'request', 'svc_bob');
 assert.deepEqual(requested, { ok: true });
 const bobFriends = await accounts.friends('svc_bob');
 assert.deepEqual(bobFriends.incoming.map((p) => p.id), ['svc_alice'], 'the request lands on the target');
 const accepted = await accounts.social('svc_bob', 'acc-1', 'accept', 'svc_alice');
 assert.deepEqual(accepted, { ok: true });
 const aliceFriends = await accounts.friends('svc_alice');
 assert.deepEqual(aliceFriends.friends.map((p) => p.id), ['svc_bob'], 'acceptance is symmetric');

 /* EXACT replay: the same key returns the stored result and re-applies nothing. */
 const replay = await accounts.social('svc_alice', 'req-1', 'request', 'svc_bob');
 assert.deepEqual(replay, requested, 'a replayed social key returns the stored response');
 /* Conflict: same key, different command -> IDEMPOTENCY_CONFLICT. */
 await assert.rejects(() => accounts.social('svc_alice', 'req-1', 'remove', 'svc_bob'), (e) => e.message === 'IDEMPOTENCY_CONFLICT');

 /* Block: the friendship is removed on both sides and the relation reads blocked. */
 await accounts.social('svc_alice', 'blk-1', 'block', 'svc_bob');
 const aliceAfterBlock = await accounts.friends('svc_alice');
 assert.deepEqual(aliceAfterBlock.friends, [], 'block removes the friendship');
 assert.deepEqual(aliceAfterBlock.blocked.map((b) => b.id), ['svc_bob']);
 const c = await adminClient(database);
 try {
  const blocks = (await c.query('SELECT count(*)::int AS n FROM social.blocks WHERE blocker_id = $1 AND blocked_id = $2', ['svc_alice', 'svc_bob'])).rows[0].n;
  const friendships = (await c.query('SELECT count(*)::int AS n FROM social.friendships WHERE actor_a = $1 AND actor_b = $2', ['svc_alice', 'svc_bob'])).rows[0].n;
  assert.equal(blocks, 1, 'the block is durable');
  assert.equal(friendships, 0, 'the friendship row is gone');
  const outcomes = (await c.query('SELECT count(*)::int AS n FROM social.command_outcomes')).rows[0].n;
  assert.equal(outcomes, 3, 'exactly one outcome row per distinct social key');
 } finally { await c.end(); }
 await accounts.close();
 await closeDatabasePools(database);
});

/* ================================================================ 5. CONVERSION CONTENTION */

test('P04 core service: overlapping conversion clients produce one winner and never overdraw', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const { database, core } = await accountHarness([SEED_ACTORS[0]], 'convert');
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 /* Two SEPARATE clients (separate pooled connections/scopes) race one wallet's conversion of the
  * whole balance: exactly one may win, the other must refuse INSUFFICIENT_COINS. */
 const race = (key) => core.run({ actor: 'svc_alice', scope: 'player' }, key, { type: 'convert', from: 'coins', amount: 1000 });
 const results = await Promise.allSettled([race('conv-1'), race('conv-2')]);
 const winners = results.filter((r) => r.status === 'fulfilled');
 const losers = results.filter((r) => r.status === 'rejected');
 assert.equal(winners.length, 1, 'exactly one overlapping conversion may win');
 assert.equal(losers.length, 1, 'the second must refuse');
 assert.match(String(losers[0].reason && losers[0].reason.message), /INSUFFICIENT_COINS/, 'the loser refuses on funds');
 const wallet = await walletOf(database, 'svc_alice');
 assert.equal(Number(wallet.coins), 0, 'no overdraw: coins left the wallet exactly once');
 assert.equal(Number(wallet.crowns), 200, 'exactly one full conversion credited 100 Crowns (100 Crowns start + 100)');
 const c = await adminClient(database);
 try {
  const conv = (await c.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id IN ('conv-1:out','conv-1:in','conv-2:out','conv-2:in')")).rows[0].n;
  assert.equal(conv, 2, 'the winning conversion writes exactly two ledger rows; the loser writes none');
 } finally { await c.end(); }
 await core.close();
 await closeDatabasePools(database);
});

/* ================================================================ 6. ROLLBACK ON OUTBOX FAILURE */

test('P04 core service: an outcome/outbox failure rolls back the wallet, ledger and outcome', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const { database, core } = await accountHarness([SEED_ACTORS[0]], 'rollback');
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;

 /* REAL database failure, not a mock: an owner-installed BEFORE INSERT trigger on ops.outbox rejects
  * the next enqueue with a genuine SQLSTATE. A command that must write an outbox row therefore fails
  * inside the same transaction, and every economic effect must roll back with it. */
 const c = await adminClient(database);
 try {
  await c.query(`CREATE FUNCTION ops.p04_refuse_outbox() RETURNS trigger LANGUAGE plpgsql AS $fn$
   BEGIN RAISE EXCEPTION 'P04_OUTBOX_REFUSED' USING ERRCODE = '23514'; END $fn$`);
  await c.query('CREATE TRIGGER p04_refuse_outbox_trigger BEFORE INSERT ON ops.outbox FOR EACH ROW EXECUTE FUNCTION ops.p04_refuse_outbox()');
 } finally { await c.end(); }

 const before = await walletOf(database, 'svc_alice');
 let thrown = null;
 try { await core.run({ actor: 'svc_alice', scope: 'player' }, 'conv-rollback', { type: 'convert', from: 'coins', amount: 500 }); }
 catch (e) { thrown = e; }
 assert.ok(thrown, 'the command must fail when its durable outbox write cannot commit');
 const after = await walletOf(database, 'svc_alice');
 assert.equal(Number(after.coins), Number(before.coins), 'the wallet write rolled back');
 assert.equal(Number(after.crowns), Number(before.crowns), 'no Crown was credited');
 assert.equal(await ledgerCount(database, 'conv-rollback:%'), 0, 'no ledger row survived');
 const c2 = await adminClient(database);
 try {
  const outcome = (await c2.query("SELECT count(*)::int AS n FROM economy.command_outcomes WHERE actor_id = $1 AND \"key\" = $2", ['svc_alice', JSON.stringify('conv-rollback')])).rows[0].n;
  assert.equal(outcome, 0, 'no outcome row survived');
 } finally { await c2.end(); }

 /* Repair the fixture and prove the SAME command now commits (the trigger, not the schema, was the blocker). */
 const c3 = await adminClient(database);
 try {
  await c3.query('DROP TRIGGER p04_refuse_outbox_trigger ON ops.outbox');
  await c3.query('DROP FUNCTION ops.p04_refuse_outbox()');
 } finally { await c3.end(); }
 const committed = await core.run({ actor: 'svc_alice', scope: 'player' }, 'conv-rollback', { type: 'convert', from: 'coins', amount: 500 });
 assert.ok(committed && typeof committed === 'object', 'the repaired command commits');
 assert.equal(Number((await walletOf(database, 'svc_alice')).coins), Number(before.coins) - 500);
 await core.close();
 await closeDatabasePools(database);
});

/* ================================================================ 7. IDEMPOTENCY */

test('P04 core service: the same key concurrently and after a lost response applies exactly once', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const { database, core } = await accountHarness([SEED_ACTORS[0]], 'idempotency');
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;

 /* Two concurrent clients issue the IDENTICAL command under the SAME key. The actor-row locks
  * serialize them, so both callers receive the stored successful result and the effect is applied
  * exactly once - a unique-violation to the second caller is NOT accepted behaviour. */
 const same = (key) => core.run({ actor: 'svc_alice', scope: 'player' }, key, { type: 'convert', from: 'coins', amount: 100 });
 const raced = await Promise.allSettled([same('idem-same'), same('idem-same')]);
 assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 2, 'both same-key callers must succeed (never a unique-key error)');
 /* Both callers describe the SAME conversion (same id/debit/credit); the second may report the
  * domain-level `duplicate` flag, so the economic fields are compared, not incidental extras. */
 for (const r of raced) {
  assert.equal(r.value.id, 'idem-same', 'each same-key caller receives the operation identity');
  assert.equal(r.value.debit, 100);
  assert.equal(r.value.credit, 10);
 }
 const walletAfterRace = await walletOf(database, 'svc_alice');
 assert.equal(Number(walletAfterRace.coins), 900, 'a same-key race must debit the wallet exactly once');
 assert.equal(Number(walletAfterRace.crowns), 110, 'a same-key race must credit exactly once');

 /* Lost-response retry: the response never reached the caller, so it retries the SAME key. It must
  * return the stored response and re-apply nothing. */
 const first = await core.run({ actor: 'svc_alice', scope: 'player' }, 'idem-lost', { type: 'convert', from: 'coins', amount: 100 });
 const retry = await core.run({ actor: 'svc_alice', scope: 'player' }, 'idem-lost', { type: 'convert', from: 'coins', amount: 100 });
 assert.deepEqual(retry, first, 'a lost-response retry returns the stored response verbatim');
 const walletAfterRetry = await walletOf(database, 'svc_alice');
 assert.equal(Number(walletAfterRetry.coins), 800, 'the retried key must not debit a second time');
 assert.equal(Number(walletAfterRetry.crowns), 120);

 /* Exactly one durable outcome and one wallet operation per key. */
 const c = await adminClient(database);
 try {
  for (const key of ['idem-same', 'idem-lost']) {
   const outcomes = (await c.query('SELECT count(*)::int AS n FROM economy.command_outcomes WHERE actor_id = $1 AND "key" = $2', ['svc_alice', JSON.stringify(key)])).rows[0].n;
   assert.equal(outcomes, 1, `exactly one outcome row for ${key}`);
   const operations = (await c.query('SELECT count(*)::int AS n FROM economy.wallet_operations WHERE actor_id = $1 AND "key" = $2', ['svc_alice', key])).rows[0].n;
   assert.equal(operations, 1, `exactly one wallet operation for ${key}`);
   const outbox = (await c.query('SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = $1', [`core.command:svc_alice:${key}`])).rows[0].n;
   assert.equal(outbox, 1, `exactly one durable outbox event for ${key}`);
   const ledgerRows = (await c.query('SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id IN ($1, $2)', [`${key}:out`, `${key}:in`])).rows[0].n;
   assert.equal(ledgerRows, 2, `exactly one conversion effect (2 ledger rows) for ${key}`);
  }
 } finally { await c.end(); }
 await core.close();
 await closeDatabasePools(database);
});

/* ================================================================ 8. STORE / COMMERCE */

test('P04 commerce service: verified races grant once, refund tombstones never re-mint, and the verifier runs outside the transaction', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const database = await createDatabase('commerce');
 await seedActors(database, [SEED_ACTORS[0]]);
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const pools = poolsFor(database);
 const applicationName = pools.core.describe().applicationName;

 /* The verifier is the ONLY external boundary, and it must observe the Core pool with NO open
  * transaction while it runs. It asks the SERVER (`pg_stat_activity`) for an idle-in-transaction
  * backend under this pool's application_name, so a service that kept the transaction open across
  * the await would be caught. The probe runs only during the FIRST, isolated purchase (see below),
  * so a sibling request's in-flight transaction cannot make the observation flaky. */
 const admin = await adminClient(database);
 let observedOpen = null, probing = true;
 const verifyPurchase = async (evidence, actor) => {
  if (probing) {
   observedOpen = (await admin.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state = 'idle in transaction'",
    [applicationName])).rows[0].n;
  }
  return { valid: true, accountId: actor, store: evidence.store, transactionId: evidence.transactionId, productId: evidence.productId, refunded: false };
 };
 const commerce = await createCommerceService(pools.core, { now: () => CLOCK, purchasesEnabled: true, eligible: () => true, verifyPurchase });

 const before = await walletOf(database, 'svc_alice');

 /* 1. One isolated, verified purchase: the grant is durable and the verifier saw no open transaction. */
 const probeEvidence = googleEvidence('tx-probe');
 const probeGrant = await commerce.purchase('svc_alice', 'buy-probe', probeEvidence);
 assert.deepEqual({ crowns: probeGrant.crowns, duplicate: probeGrant.duplicate, productId: probeGrant.productId }, { crowns: 100, duplicate: false, productId: 'crowns_100' }, 'the durable grant is the catalogue Crowns');
 assert.equal(observedOpen, 0, 'the provider verifier must run with NO open Core transaction');
 probing = false;
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), Number(before.crowns) + 100, 'the grant is applied exactly once');

 /* 2. Two clients with DIFFERENT keys race the SAME backend transaction id: the finite grant
  *    happens exactly once. The loser may observe the durable receipt (duplicate) or lose the
  *    unique-key race and refuse - never a second grant. */
 const evidence = googleEvidence('tx-race');
 const raced = await Promise.allSettled([
  commerce.purchase('svc_alice', 'buy-race-1', evidence),
  commerce.purchase('svc_alice', 'buy-race-2', evidence),
 ]);
 const granted = raced.filter((r) => r.status === 'fulfilled' && r.value && r.value.duplicate === false);
 assert.equal(granted.length, 1, 'exactly one racing callback may grant');
 assert.equal(granted.length + raced.filter((r) => r.status === 'fulfilled' && r.value.duplicate === true).length + raced.filter((r) => r.status === 'rejected').length, 2, 'both racers reach a defined outcome');
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), Number(before.crowns) + 200, 'Crowns are granted exactly once across the race');

 /* A deterministic later callback on the now-committed receipt reports the duplicate and grants nothing. */
 const duplicateResult = await commerce.purchase('svc_alice', 'buy-race-3', evidence);
 assert.equal(duplicateResult.duplicate, true, 'a settled receipt replays as a duplicate');
 assert.equal(duplicateResult.productId, 'crowns_100');
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), Number(before.crowns) + 200, 'the duplicate callback grants nothing');

 const c = await adminClient(database);
 try {
  const receipts = (await c.query("SELECT count(*)::int AS n FROM monetization.receipts WHERE store='google' AND transaction_id='tx-race'")).rows[0].n;
  assert.equal(receipts, 1, 'exactly one durable receipt row for the raced receipt');
  const purchaseRows = (await c.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id = 'purchase:google:tx-race' AND actor_id='svc_alice'")).rows[0].n;
  assert.equal(purchaseRows, 1, 'exactly one purchase ledger row for the raced receipt');
 } finally { await c.end(); }

 /* 3. Pending / invalid backend evidence grants nothing at all. This runs while the actor is READY
  *    and unheld, so the evidence check is the thing under test. */
 const crownsBeforeInvalid = Number((await walletOf(database, 'svc_alice')).crowns);
 const badCommerce = await createCommerceService(pools.core, { now: () => CLOCK, purchasesEnabled: true, eligible: () => true, verifyPurchase: async (evidence, actor) => ({ valid: false, accountId: actor, store: evidence.store, transactionId: evidence.transactionId, productId: evidence.productId, refunded: false }) });
 await assert.rejects(() => badCommerce.purchase('svc_alice', 'buy-invalid', googleEvidence('tx-invalid')), /INVALID_RECEIPT/);
 const pendingCommerce = await createCommerceService(pools.core, { now: () => CLOCK, purchasesEnabled: true, eligible: () => true, verifyPurchase: async () => null });
 await assert.rejects(() => pendingCommerce.purchase('svc_alice', 'buy-pending', googleEvidence('tx-pending')), /INVALID_RECEIPT/);
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), crownsBeforeInvalid, 'invalid or pending evidence must grant nothing');
 const cInvalid = await adminClient(database);
 try {
  const rows = (await cInvalid.query("SELECT count(*)::int AS n FROM monetization.receipts WHERE transaction_id IN ('tx-invalid','tx-pending')")).rows[0].n;
  assert.equal(rows, 0, 'no receipt row may be written for refused evidence');
 } finally { await cInvalid.end(); }

 /* 4. Permanent refund tombstone: the receipt is marked refunded (and the actor is put on hold), and
  *    a later attempt on the SAME backend transaction must never re-mint. */
 const crownsBeforeRefund = Number((await walletOf(database, 'svc_alice')).crowns);
 const refunded = await commerce.refund('google', 'tx-race');
 assert.deepEqual({ refunded: refunded.refunded, duplicate: refunded.duplicate }, { refunded: true, duplicate: false }, 'the refund is recorded once');
 await assert.rejects(() => commerce.purchase('svc_alice', 'buy-after-refund', evidence), /RECEIPT_REFUNDED|RECEIPT_REPLAY|INVALID_RECEIPT|ACCOUNT_HELD/);
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), crownsBeforeRefund, 'a refunded receipt must never re-mint Crowns');
 const c2 = await adminClient(database);
 try {
  const revoked = (await c2.query("SELECT count(*)::int AS n FROM monetization.store_revocations WHERE store='google' AND transaction_id='tx-race'")).rows[0].n;
  assert.equal(revoked, 1, 'the permanent refund tombstone exists');
  const purchaseRows = (await c2.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id = 'purchase:google:tx-race'")).rows[0].n;
  assert.equal(purchaseRows, 1, 'still exactly one purchase ledger row after the refund');
 } finally { await c2.end(); }

 await commerce.close(); await badCommerce.close(); await pendingCommerce.close();
 await admin.end();
 await closeDatabasePools(database);
});

/* ================================================================ 9. PROVISIONING */

test('P04 provisioning: imported actors are never re-granted and a pending actor gets exactly the approved 150 Coins once', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }

 /* An API-side database (api_runtime) and the real Core service over the SAME database: the two
  * roles write their own half, exactly like the P05 provisioning handshake. */
 const database = await createDatabase('provision');
 await seedActors(database, [SEED_ACTORS[0]]);
 if (!(await requireServiceIntegration(t, database))) return;
 const pools = poolsFor(database);
 const accounts = await createAccountService(pools.api, { now: () => CLOCK, otpSecret: OTP_SECRET });
 const core = await createCoreService(pools.core, { now: () => CLOCK });

 /* 1. An imported actor with an existing wallet is already ready (wallet-row existence IS the
  *    readiness fact) and MUST NOT receive another opening grant. */
 const pre = await core.provisionActor('svc_alice');
 assert.deepEqual({ ready: pre.ready, created: pre.created }, { ready: true, created: false }, 'an existing wallet is ready and creates nothing');
 assert.equal(Number(pre.coins), 1000, 'the imported balance is untouched');
 assert.equal(await ledgerCount(database, 'opening:svc_alice'), 1, 'the imported opening row is not duplicated');

 /* 2. A NEW pending actor: the API writes identity+eligibility+profile+outbox only (no wallet), then
  *    Core provisions the approved initial shape with a deterministic ledger id. */
 const created = await accounts.createVerifiedActor({ provider: 'google', subject: 'google-subject-dave', provenance: 'provider' });
 assert.equal(created.created, true, 'the API created a new permanent actor');
 const pending = created.actor;
 assert.equal(await ledgerCount(database, `opening:${pending}`), 0, 'the API half must not create a wallet or opening ledger row');
 const c0 = await adminClient(database);
 let outboxKind = null;
 try {
  const r = await c0.query('SELECT kind FROM ops.outbox WHERE outbox_id = $1', [`account.provision:${pending}`]);
  outboxKind = r.rows[0] ? r.rows[0].kind : null;
 } finally { await c0.end(); }
 assert.equal(outboxKind, 'account.provision', 'the durable provisioning outbox row is enqueued by the API');
 /* The pending actor is NOT ready: it exists but has no wallet row, so it cannot mutate. */
 assert.equal(await walletOf(database, pending), null, 'the pending actor has no wallet row yet');
 const pendingState = await accounts.state(pending);
 assert.equal(pendingState && pendingState.walletReady === true, false, 'a pending actor projects walletReady=false');

 /* 3. Core provisioning: exactly the approved initial shape, once. */
 const provisioned = await core.provisionActor(pending);
 assert.deepEqual({ ready: provisioned.ready, created: provisioned.created }, { ready: true, created: true });
 assert.equal(provisioned.coins, 150, 'the approved opening balance is exactly 150 Coins (not an arbitrary grant)');
 assert.equal(Number(provisioned.rating), 600, 'the approved initial rating is 600');
 assert.equal(await ledgerCount(database, `opening:${pending}`), 1, 'exactly one opening ledger row');
 const wallet = await walletOf(database, pending);
 assert.equal(Number(wallet.coins), 150, 'the durable wallet holds exactly 150 Coins');

 /* 4. Replay is structurally idempotent: the wallet PK and the deterministic ledger id make a second
  *    provisioning a no-op that grants nothing. */
 const replay = await core.provisionActor(pending);
 assert.deepEqual({ ready: replay.ready, created: replay.created }, { ready: true, created: false }, 'a replayed provisioning creates nothing');
 assert.equal(await ledgerCount(database, `opening:${pending}`), 1, 'a replay must not write a second opening row');
 assert.equal(Number((await walletOf(database, pending)).coins), 150, 'a replay must not mint');

 /* 5. After provisioning the actor is ready and mutable. The durable readiness fact is the wallet
  *    row; the projection reports the same when the owner read function is present. */
 assert.ok(await walletOf(database, pending), 'the Core wallet row exists after provisioning');
 const afterState = await accounts.state(pending);
 assert.equal(afterState.walletReady, true, 'the projection reports wallet readiness after the Core wallet exists');
 await accounts.close(); await core.close();
 await closeDatabasePools(database);
});

/* ================================================================ 10. LOCK ORDER / SOCIAL CANCEL */

test('P04 core service: accept and cancelSocialOffers serialize on the match row and never lose a result', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const database = await createDatabase('socialcancel');
 await seedActors(database, ['svc_alice', 'svc_bob'].map((a) => SEED_ACTORS.find((s) => s.actor === a)));
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const core = await createCoreService(poolsFor(database).core, { now: () => CLOCK });

 /* One OFFERED direct match between alice and bob (created through the real dispatcher). */
 const offered = await core.run({ actor: 'svc_alice', scope: 'player' }, 'sc-offer', { type: 'offer', id: 'match-sc', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: 40 } });
 assert.ok(offered.termsHash, 'the offer returns its terms hash');

 /* Two independent scopes: alice accepts while the social-removal path cancels the same OFFERED
  * match. They serialize on the match row, so exactly one terminal outcome is reached. */
 const [accepted, cancelled] = await Promise.allSettled([
  core.run({ actor: 'svc_alice', scope: 'player' }, 'sc-accept', { type: 'accept', id: 'match-sc', termsHash: offered.termsHash }),
  core.cancelSocialOffers('svc_alice', 'svc_bob'),
 ]);
 /* Only ONE seat can be accepted here, so the match can never leave OFFERED on the accept path and
  * the removal path (which re-reads status UNDER the lock) always cancels it. The two scopes
  * serialize on the match row: the accept either commits first (and is then cancelled) or is refused
  * `NOT_OPEN` after the cancel - never a lost result, never a torn row. */
 assert.equal(cancelled.status, 'fulfilled', `the removal path must complete (${cancelled.reason && cancelled.reason.message})`);
 assert.deepEqual(cancelled.value.cancelled, ['match-sc'], 'the still-open offer is cancelled exactly once');
 if (accepted.status === 'rejected') {
  assert.match(String(accepted.reason && accepted.reason.message), /NOT_OPEN|NOT_PARTICIPANT|TERMS_CHANGED/, 'a losing accept refuses with a frozen code');
 }
 const c = await adminClient(database);
 let matchRow;
 try {
  matchRow = (await c.query("SELECT status, accepted_count, escrow FROM match.matches WHERE match_id = 'match-sc'")).rows[0];
 } finally { await c.end(); }
 assert.equal(matchRow.status, 'CANCELLED', 'the serialized outcome is a single terminal CANCELLED');
 const wallet = await walletOf(database, 'svc_alice');
 assert.equal(Number(wallet.coins), 1000, 'no wallet overdraw from the cancellation path');
 assert.equal(Number(wallet.reserved_crowns), 0, 'the cancelled offer released its reservation exactly once');

 await core.close();
 await closeDatabasePools(database);
});

test('P04 core service: a running match is never cancelled by the social-removal path', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const database = await createDatabase('playing');
 await seedActors(database, ['svc_alice', 'svc_carol'].map((a) => SEED_ACTORS.find((s) => s.actor === a)));
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const core = await createCoreService(poolsFor(database).core, { now: () => CLOCK });

 /* A dedicated actor pair, so the match is genuinely PLAYING before the removal path runs. */
 const offered = await core.run({ actor: 'svc_alice', scope: 'player' }, 'pl-offer', { type: 'offer', id: 'match-playing', opponent: 'svc_carol', terms: { kind: 'leaderboard', amount: 40 } });
 await core.run({ actor: 'svc_alice', scope: 'player' }, 'pl-accept-a', { type: 'accept', id: 'match-playing', termsHash: offered.termsHash });
 await core.run({ actor: 'svc_carol', scope: 'player' }, 'pl-accept-b', { type: 'accept', id: 'match-playing', termsHash: offered.termsHash });
 const beforeCancel = await core.read((tx) => tx.repositories.matches.for('match-playing'));
 assert.equal(beforeCancel.status, 'PLAYING', 'the match is running');

 const noop = await core.cancelSocialOffers('svc_alice', 'svc_carol');
 const afterCancel = await core.read((tx) => tx.repositories.matches.for('match-playing'));
 assert.deepEqual(noop.cancelled, [], 'the removal path cancels only OFFERED matches');
 assert.equal(afterCancel.status, 'PLAYING', 'the running match survives');
 assert.equal(afterCancel.revision, beforeCancel.revision, 'its revision is unchanged');
 assert.deepEqual(afterCancel.symbols, beforeCancel.symbols, 'its symbol draw is unchanged');
 assert.equal(Number(afterCancel.escrow), Number(beforeCancel.escrow), 'its escrow is unchanged');
 await core.close();
 await closeDatabasePools(database);
});

test('P04 core service: provisioning a pending actor and refunding the same actor do not deadlock', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const database = await createDatabase('lockorder');
 await seedActors(database, [SEED_ACTORS[0]]);
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const core = await createCoreService(poolsFor(database).core, { now: () => CLOCK });
 const commerce = await createCommerceService(poolsFor(database).core, { now: () => CLOCK });

 /* A real receipt for alice so the refund has something to hold. */
 const c = await adminClient(database);
 try {
  await c.query("INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ('google','tx-lock','svc_alice','crowns_100',100,false,$1)", [new Date(CLOCK - 3600000).toISOString()]);
 } finally { await c.end(); }

 /* Both paths start at alice's eligibility row (Core order), so they serialize rather than forming a
  * cycle. A 40P01 here would mean a path still mixes orders. */
 const [provision, refund] = await Promise.allSettled([
  core.provisionActor('svc_alice'),
  commerce.refund('google', 'tx-lock'),
 ]);
 assert.equal(provision.status, 'fulfilled', `provisioning must complete without a deadlock (${provision.reason && provision.reason.message})`);
 assert.equal(refund.status, 'fulfilled', `the refund must complete without a deadlock (${refund.reason && refund.reason.message})`);
 assert.equal(refund.value.refunded, true);
 await core.close(); await commerce.close();
 await closeDatabasePools(database);
});

test('P04 core service: a direct purchase command is refused and mints nothing', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const database = await createDatabase('directbuy');
 await seedActors(database, [SEED_ACTORS[0]]);
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const core = await createCoreService(poolsFor(database).core, { now: () => CLOCK });

 /* The synchronous domain verifier must never mint from client evidence on the direct boundary. Only
  * `commerce.purchase` (which awaits the external verifier OUTSIDE the transaction) may grant. */
 const before = await walletOf(database, 'svc_alice');
 await assert.rejects(
  () => core.run({ actor: 'svc_alice', scope: 'player' }, 'direct-buy', { type: 'purchase', evidence: googleEvidence('tx-direct') }),
  (e) => e.message === 'COMMERCE_OWNED_COMMAND');
 const after = await walletOf(database, 'svc_alice');
 assert.equal(Number(after.crowns), Number(before.crowns), 'a refused direct purchase must not mint Crowns');
 const c = await adminClient(database);
 try {
  assert.equal((await c.query("SELECT count(*)::int AS n FROM monetization.receipts WHERE transaction_id='tx-direct'")).rows[0].n, 0, 'no receipt row for a refused direct purchase');
  assert.equal((await c.query("SELECT count(*)::int AS n FROM ops.outbox WHERE outbox_id = 'core.command:svc_alice:direct-buy'")).rows[0].n, 0, 'no outbox event for a refused direct purchase');
  assert.equal((await c.query("SELECT count(*)::int AS n FROM economy.command_outcomes WHERE actor_id='svc_alice' AND \"key\" = $1", [JSON.stringify('direct-buy')])).rows[0].n, 0, 'no outcome row for a refused direct purchase');
 } finally { await c.end(); }
 await core.close();
 await closeDatabasePools(database);
});

test('P04 core service: a stale social-removal callback after a re-friend cancels nothing', async (t) => {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return; }
 const database = await createDatabase('stale cancel'.replace(' ', '_'));
 await seedActors(database, ['svc_alice', 'svc_bob'].map((a) => SEED_ACTORS.find((s) => s.actor === a)));
 if (!(await requireServiceIntegration(t, database))) return;
 const pools = poolsFor(database);
 const accounts = await createAccountService(pools.api, { now: () => CLOCK, otpSecret: OTP_SECRET });
 const core = await createCoreService(pools.core, { now: () => CLOCK });

 /* The pair is MUTUALLY FRIENDED (real request/accept) when a stale removal callback arrives. Core
  * re-reads the durable social graph under its locks, so the callback must be a no-op. */
 await accounts.social('svc_alice', 'st-req', 'request', 'svc_bob');
 await accounts.social('svc_bob', 'st-acc', 'accept', 'svc_alice');
 const offered = await core.run({ actor: 'svc_alice', scope: 'player' }, 'st-offer', { type: 'offer', id: 'match-stale', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: 40 } });
 assert.ok(offered.termsHash);
 const stale = await core.cancelSocialOffers('svc_alice', 'svc_bob');
 assert.deepEqual(stale.cancelled, [], 'a stale removal callback against a current friendship cancels nothing');
 const match = await core.read((tx) => tx.repositories.matches.for('match-stale'));
 assert.equal(match.status, 'OFFERED', 'the still-open offer is left untouched');
 const c = await adminClient(database);
 try {
  assert.equal((await c.query('SELECT count(*)::int AS n FROM social.friendships WHERE actor_a = $1 AND actor_b = $2', ['svc_alice', 'svc_bob'])).rows[0].n, 1, 'the friendship is still durable');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM social.blocks WHERE blocker_id = $1 AND blocked_id = $2', ['svc_alice', 'svc_bob'])).rows[0].n, 0, 'no block was recorded');
 } finally { await c.end(); }

 /* Positive control in the SAME test: with the friendship gone (real remove) the same callback DOES
  * cancel the still-open offer. */
 await accounts.social('svc_alice', 'st-remove', 'remove', 'svc_bob');
 const cancelled = await core.cancelSocialOffers('svc_alice', 'svc_bob');
 assert.deepEqual(cancelled.cancelled, ['match-stale'], 'after an actual removal the open offer is cancelled');
 assert.equal((await core.read((tx) => tx.repositories.matches.for('match-stale'))).status, 'CANCELLED');
 await accounts.close(); await core.close();
 await closeDatabasePools(database);
});

/* ================================================================ 11. ACCOUNT/AUTH REGRESSIONS
 *
 * Every case below is a CONSUMER regression for a reviewed defect: it drives the real service over
 * the real migrated schema and asserts the observable behaviour the frozen contract requires. The
 * race cases force the interleaving with DATABASE barriers (a trigger that pauses a writer until a
 * competing statement is observed waiting, or a session-scoped advisory lock) - never a service mock
 * or a callback log, and never an optimistic `Promise.all` that only hopes the calls overlap.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* A script-controlled barrier: the SUPERUSER test connection observes another backend WAITING on an
 * advisory lock (granted=false) or on a row lock. Combined with a trigger that blocks the first
 * writer on a test-held advisory lock, this forces both writers past their decision point instead of
 * hoping two calls race. The trigger never inspects pg_stat_activity (a runtime role cannot see other
 * backends), so the barrier is role-safe. */
async function waitForLockWaiter(admin, timeoutMs = 12000, min = 1) {
 const deadline = Date.now() + timeoutMs;
 while (Date.now() < deadline) {
  const r = await admin.query('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> pg_backend_pid()');
  if (r.rows[0].n >= min) return true;
  await sleep(20);
 }
 return false;
}
async function installSql(database, statements) {
 const c = await adminClient(database);
 try { for (const text of statements) await c.query(text); } finally { await c.end(); }
}
/* A BEFORE INSERT gate that blocks the FIRST writer of a matching row on a session advisory lock the
 * TEST holds. The trigger never queries pg_stat_activity (a runtime role cannot see other backends'
 * wait events), so blocking is role-safe; the SUPERUSER test connection observes the waiter and
 * releases the lock to let the writer proceed. Combined with the service's own logical-identity locks
 * this forces a real interleaving instead of hoping two awaited calls overlap. */
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
/* A BEFORE UPDATE gate that HOLDS the first writer until a competing backend is observed blocked on a
 * lock OF THIS RELATION (pg_locks, which a runtime role may read - unlike pg_stat_activity). Because
 * a row lock is taken before the BEFORE trigger fires, the second settlement blocks on the burns row
 * while the first waits here, so both hydrate the PRE-settlement total and the second must not lose
 * the first's burn. */
async function installUpdateWaiterGate(database, { schema, table, name, when, timeoutTicks = 500 }) {
 const fn = `${schema}.${name}`;
 const rel = `${schema}.${table}`;
 await installSql(database, [
  `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $fn$
   DECLARE waited int := 0;
   BEGIN
    IF ${when} THEN
     LOOP
      EXIT WHEN EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND relation = '${rel}'::regclass AND pid <> pg_backend_pid());
      PERFORM pg_sleep(0.02);
      waited := waited + 1;
      EXIT WHEN waited > ${timeoutTicks};
     END LOOP;
    END IF;
    RETURN NEW;
   END $fn$`,
  `CREATE TRIGGER ${name}_trg BEFORE UPDATE ON ${rel} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
 ]);
 return () => installSql(database, [`DROP TRIGGER ${name}_trg ON ${rel}`, `DROP FUNCTION ${fn}()`]);
}
async function scalar(database, text, params = []) {
 const c = await adminClient(database);
 try { const r = await c.query(text, params); return r.rows[0] ? Object.values(r.rows[0])[0] : null; } finally { await c.end(); }
}

/* A per-test boot guard: returns false (after skipping) when no owned backend is configured. */
async function boot(t) {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL'); return false; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return false; }
 return true;
}
async function accountsFor(database, options = {}) {
 return createAccountService(poolsFor(database).api, { ...options, now: options.clock || (() => CLOCK), otpSecret: options.otpSecret || OTP_SECRET });
}
async function coreFor(database, options = {}) { return createCoreService(poolsFor(database).core, { ...options, now: () => CLOCK }); }
const seedFor = (names) => names.map((a) => SEED_ACTORS.find((s) => s.actor === a));

/* A credential row written by the trusted admin exactly as the importer / shipped production flow
 * would. `format` picks the SHIPPED modern verifier (scrypt-v1$, N=131072) or the legacy V4
 * unprefixed verifier (N=16384); the service must accept BOTH. */
async function seedCredential(database, actor, email, password, format = 'modern', verified = true) {
 let hash, salt;
 if (format === 'legacy') {
  /* The legacy V4 format: an unprefixed N=16384 verifier over a random salt (account-policy helper,
   * unchanged for its other V4 callers). */
  salt = policy.passwordSalt();
  hash = policy.passwordHash(password, salt);
 } else {
  /* The SHIPPED modern format: 'scrypt-v1$' with N=131072, produced by the production Passwords. */
  const passwords = new Passwords({ concurrency: 1 });
  try { const modern = await passwords.hash(password); salt = modern.salt; hash = modern.password_hash; } finally { passwords.close(); }
 }
 const c = await adminClient(database);
 try {
  await c.query('INSERT INTO identity.email_credentials (email, actor_id, salt, password_hash, created_at, verified_at) VALUES ($1,$2,$3,$4,$5,$6)',
   [email, actor, salt, hash, new Date(CLOCK).toISOString(), verified ? new Date(CLOCK).toISOString() : null]);
  await c.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('email',$1,$2,$3)", [email, actor, new Date(CLOCK).toISOString()]);
 } finally { await c.end(); }
 return { salt, hash };
}
async function challengeRow(database, id) {
 const c = await adminClient(database);
 try {
  const r = await c.query('SELECT attempts, consumed, verified_at IS NOT NULL AS verified, purpose FROM identity.email_challenges WHERE challenge_id = $1', [id]);
  const v = await c.query('SELECT count(*)::int AS n FROM identity.email_credential_versions WHERE challenge_id = $1', [id]);
  return { ...(r.rows[0] || null), stampRows: v.rows[0].n };
 } finally { await c.end(); }
}
/* A legacy (unprefixed) credential row for an actor that ALREADY exists, optionally unverified:
 * exactly the imported-account shape (credential verified_at NULL, eligibility verified false). */
async function attachLegacyCredential(database, actor, email, password, { verified = true } = {}) {
 const salt = policy.passwordSalt();
 const hash = policy.passwordHash(password, salt);
 const c = await adminClient(database);
 try {
  await c.query('INSERT INTO identity.email_credentials (email, actor_id, salt, password_hash, created_at, verified_at) VALUES ($1,$2,$3,$4,$5,$6)',
   [email, actor, salt, hash, new Date(CLOCK).toISOString(), verified ? new Date(CLOCK).toISOString() : null]);
 } finally { await c.end(); }
}
const throwsCode = (promise, code) => assert.rejects(promise, (e) => e.message === code, `expected ${code}`);

test('P04 account auth: shipped modern and legacy password formats both authenticate; wrong-OTP denials persist', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authformats');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 const password = 'SyntheticPassw0rd';

 /* The two shipped credential formats: the legacy unprefixed N=16384 verifier and the modern
  * 'scrypt-v1$' N=131072 one. Both were accepted by the production Passwords but rejected by the
  * service's old sync-only verifier. */
 await seedCredential(database, 'svc_alice', 'alice@authformats.test', password, 'legacy');
 await seedCredential(database, 'svc_bob', 'bob@authformats.test', password, 'modern');

 const legacySession = await accounts.emailContinue((await accounts.issue()).token, 'alice@authformats.test', password);
 assert.equal(legacySession.actor, 'svc_alice', 'a legacy (unprefixed) stored hash must authenticate');
 assert.ok(legacySession.token, 'a successful login issues a replacement bearer');
 const modernSession = await accounts.emailContinue((await accounts.issue()).token, 'bob@authformats.test', password);
 assert.equal(modernSession.actor, 'svc_bob', 'a modern (scrypt-v1$) stored hash must authenticate');

 /* A wrong password is refused AND its rate spend must be durable (the denial commits without any
  * grant, then throws) - a rolled-back increment never reaches the limit. The bucket is keyed to the
  * source bearer, so a fresh anonymous session gives an unambiguous count. */
 const wrong = await accounts.issue();
 const wrongBucket = crypto.createHash('sha256').update(wrong.token).digest('hex');
 await throwsCode(accounts.emailContinue(wrong.token, 'alice@authformats.test', 'WrongPassw0rd9'), 'INVALID_CREDENTIALS');
 const hits = await scalar(database, 'SELECT hits FROM ops.rate_buckets WHERE bucket_id LIKE $1', [`email-continue:${wrongBucket}:%`]);
 assert.equal(Number(hits), 1, 'a denied credential attempt must persist its durable rate spend (not roll it back)');

 /* OTP denial accounting: five wrong codes must DURABLY increment the challenge attempts (the old
  * code incremented inside the transaction and then threw, erasing its own counter), the challenge
  * must carry a persisted credential stamp, and the next attempt must be OTP_LOCKED. */
 const otpSession = await accounts.issue();
 const challenge = await accounts.emailResetStart(otpSession.token, 'alice@authformats.test');
 assert.ok(challenge.delivery && challenge.delivery.code, 'a known address gets a real reset code');
 const wrongCode = challenge.delivery.code === '000000' ? '000001' : '000000';
 for (let n = 0; n < 5; n += 1) await throwsCode(accounts.emailVerify(otpSession.token, challenge.challengeId, wrongCode), 'INVALID_OTP');
 const row = await challengeRow(database, challenge.challengeId);
 assert.equal(row.attempts, 5, 'five wrong codes must persist five durable attempts');
 assert.ok(row.stampRows >= 1, 'the challenge must carry a persisted canonical credential stamp');
 await throwsCode(accounts.emailVerify(otpSession.token, challenge.challengeId, challenge.delivery.code), 'OTP_LOCKED');
 assert.equal((await challengeRow(database, challenge.challengeId)).attempts, 5, 'a locked challenge must not advance further');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account auth: an imported unverified credential completes the verify-existing OTP flow only on a valid code', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authverifyexisting');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 const password = 'SyntheticPassw0rd';

 /* An IMPORTED, unverified account: the credential's verified_at is NULL and the actor's own
  * eligibility.verified is FALSE. The correct password must route to the verify-existing OTP flow
  * (which is the only path that stamps BOTH halves) and must NOT grant a session on its own. */
 await attachLegacyCredential(database, 'svc_alice', 'alice@verify.test', password, { verified: false });
 await installSql(database, ["UPDATE identity.eligibility SET verified = false WHERE actor_id = 'svc_alice'"]);
 assert.equal(await scalar(database, "SELECT verified FROM identity.eligibility WHERE actor_id = 'svc_alice'"), false, 'fixture: the imported actor is not yet verified');
 assert.equal(await accounts.emailVerified('svc_alice'), false, 'fixture: the credential is not yet verified');

 const anon = await accounts.issue();
 const challenge = await accounts.emailContinue(anon.token, 'alice@verify.test', password);
 assert.equal(challenge.verificationRequired, true, 'an unverified credential routes to the OTP challenge');
 assert.ok(challenge.delivery && challenge.delivery.code, 'a known address gets a real code');

 /* A WRONG code must grant NOTHING: credential and eligibility both stay unverified. */
 const wrongCode = challenge.delivery.code === '000000' ? '000001' : '000000';
 await throwsCode(accounts.emailVerify(anon.token, challenge.challengeId, wrongCode), 'INVALID_OTP');
 assert.equal(await accounts.emailVerified('svc_alice'), false, 'a wrong code must never verify the credential');
 assert.equal(await scalar(database, "SELECT verified FROM identity.eligibility WHERE actor_id = 'svc_alice'"), false, 'nor make the actor eligible');

 /* The VALID code stamps BOTH halves and issues the linked session. */
 const verified = await accounts.emailVerify(anon.token, challenge.challengeId, challenge.delivery.code);
 assert.equal(verified.actor, 'svc_alice', 'a valid verify-existing code completes the flow for the actor');
 assert.equal(typeof verified.token === 'string' && verified.token.length > 0, true, 'and issues its session');
 assert.equal(await accounts.emailVerified('svc_alice'), true, 'the credential is now verified');
 assert.equal(await scalar(database, "SELECT verified FROM identity.eligibility WHERE actor_id = 'svc_alice'"), true, 'and the actor eligibility is now verified (the missing half)');
 assert.equal(await accounts.session(verified.token) !== null, true, 'the issued session is live');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account auth: a challenge without a persisted credential stamp can never grant (any purpose), and a delayed Core callback never invents walletReady', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authnostamp');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 const password = 'SyntheticPassw0rd';
 await attachLegacyCredential(database, 'svc_alice', 'alice@nostamp.test', password, { verified: true });

 /* A challenge whose credential stamp row is absent (an imported/legacy or tampered authorization)
  * must be unusable for EVERY purpose. */
 const purge = async (id) => { const c = await adminClient(database); try { await c.query('DELETE FROM identity.email_credential_versions WHERE challenge_id = $1', [id]); } finally { await c.end(); } };

 /* reset: stamp missing -> the reset cannot even be verified (no grant, no completion). */
 const r = await accounts.issue();
 const reset = await accounts.emailResetStart(r.token, 'alice@nostamp.test');
 await purge(reset.challengeId);
 await throwsCode(accounts.emailVerify(r.token, reset.challengeId, reset.delivery.code), 'INVALID_OTP');
 await throwsCode(accounts.emailResetComplete(r.token, reset.challengeId, 'BrandNewPassw0rd1'), 'RESET_NOT_AUTHORIZED');

 /* verify-existing: stamp missing -> refused, no eligibility grant. */
 await installSql(database, ["UPDATE identity.email_credentials SET verified_at = NULL WHERE actor_id = 'svc_alice'"]);
 const v = await accounts.issue();
 const existing = await accounts.emailContinue(v.token, 'alice@nostamp.test', password);
 await purge(existing.challengeId);
 await throwsCode(accounts.emailVerify(v.token, existing.challengeId, existing.delivery.code), 'INVALID_OTP');
 assert.equal(await accounts.emailVerified('svc_alice'), false, 'a stampless verify-existing challenge grants nothing');

 /* change-email: stamp missing -> refused. (The credential is re-verified first so the challenge is
  * legitimately issuable.) */
 await installSql(database, ["UPDATE identity.email_credentials SET verified_at = now() WHERE actor_id = 'svc_alice'"]);
 const s = await accounts.issue('svc_alice', CLOCK);
 const change = await accounts.emailChangeStart(s.token, 'moved@nostamp.test');
 await purge(change.challengeId);
 const changeOutcome = await accounts.emailVerify(s.token, change.challengeId, change.delivery.code).then(() => 'granted', (e) => e.message);
 assert.match(String(changeOutcome), /INVALID_OTP|EMAIL_IN_USE|EMAIL_UNCHANGED/, `a stampless change-email challenge must not grant (got ${changeOutcome})`);

 /* signup: a brand-new email whose challenge stamp row is removed -> the signup cannot mint the actor.
  * (A signup challenge legitimately pins a NULL stamp, so "no grant" must key on the version row's
  * EXISTENCE, not on its value - hence the absent row is the unusable case under test.) */
 const signupAnon = await accounts.issue();
 const signup = await accounts.emailContinue(signupAnon.token, 'fresh@nostamp.test', password);
 assert.equal(signup.verificationRequired, true, 'signup issues a challenge');
 await purge(signup.challengeId);
 const signupOutcome = await accounts.emailVerify(signupAnon.token, signup.challengeId, signup.delivery.code).then(() => 'granted', (e) => e.message);
 assert.match(String(signupOutcome), /INVALID_OTP/, `a stampless signup challenge must not mint an account (got ${signupOutcome})`);
 assert.equal(await scalar(database, "SELECT count(*)::int AS n FROM identity.actors WHERE actor_id NOT IN ('svc_alice','svc_bob','svc_carol')"), 0, 'no account is created from a stampless signup challenge');

 /* A DELAYED (or enqueue-only) Core provisioning callback must never publish walletReady: readiness
  * is the DURABLE wallet row, not the callback's return value. The callback here blocks until the
  * test releases it, then resolves TRUE without creating any wallet - the honest answer must stay
  * pending, so a "successful" callback cannot fabricate a ready account. */
 let enterCallback; const onEnter = new Promise((resolve) => { enterCallback = resolve; });
 let releaseCallback; const gate = new Promise((resolve) => { releaseCallback = resolve; });
 const delaying = await createAccountService(poolsFor(database).api, {
  now: () => CLOCK, otpSecret: OTP_SECRET,
  provisionActor: async () => { enterCallback(); await gate; return true; },
 });
 const anonSignup = await delaying.issue();
 const signupChallenge = await delaying.emailContinue(anonSignup.token, 'delayed@nostamp.test', password);
 const verifying = delaying.emailVerify(anonSignup.token, signupChallenge.challengeId, signupChallenge.delivery.code);
 await onEnter;                                  /* the callback is now in flight, wallet still absent */
 assert.equal(await scalar(database, "SELECT count(*)::int AS n FROM economy.wallets w JOIN identity.identities i ON i.actor_id = w.actor_id WHERE i.subject = 'delayed@nostamp.test'"), 0, 'the delayed callback has created no wallet yet');
 releaseCallback();                              /* the callback resolves true, but mints nothing */
 const done = await verifying;
 assert.equal(done.walletReady, false, 'a still-pending actor must report walletReady=false, never an invented true');
 assert.equal(await walletOf(database, done.actor), null, 'the callback created no wallet row, so readiness stays false');
 await delaying.close();
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account auth: reset verifies without consuming, completes once, and replays/stale stamps cannot grant', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authreset');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 const oldPassword = 'OldPassw0rd123';
 const newPassword = 'NewPassw0rd456';
 await seedCredential(database, 'svc_alice', 'alice@reset.test', oldPassword, 'modern');

 /* A live linked session that the reset must kill. */
 const linked = await accounts.issue('svc_alice', CLOCK);
 assert.ok(await accounts.session(linked.token), 'the pre-reset linked session is live');

 const anon = await accounts.issue();
 const challenge = await accounts.emailResetStart(anon.token, 'alice@reset.test');
 const verified = await accounts.emailVerify(anon.token, challenge.challengeId, challenge.delivery.code);
 assert.deepEqual(verified, { resetReady: true, challengeId: challenge.challengeId }, 'reset verification authorizes without granting');
 const afterVerify = await challengeRow(database, challenge.challengeId);
 assert.equal(afterVerify.verified, true, 'the reset challenge is stamped verified');
 assert.equal(afterVerify.consumed, false, 'verification must NOT consume (completion consumes the authorization)');

 const completed = await accounts.emailResetComplete(anon.token, challenge.challengeId, newPassword);
 assert.equal(completed.actor, 'svc_alice', 'the reset completes for the authorized actor');
 assert.equal(completed.passwordChangedEmail, 'alice@reset.test');
 assert.ok(completed.token, 'a completed reset issues one session for the caller');
 assert.equal(await accounts.session(linked.token), null, 'a reset must revoke every existing session');

 /* The OLD password no longer authenticates; the reset password does. (Asserted while the credential
  * is still the completed reset's, before the out-of-band rotation below.) */
 await throwsCode(accounts.emailContinue((await accounts.issue()).token, 'alice@reset.test', oldPassword), 'INVALID_CREDENTIALS');
 const login = await accounts.emailContinue((await accounts.issue()).token, 'alice@reset.test', newPassword);
 assert.equal(login.actor, 'svc_alice', 'the reset password authenticates after the completed reset');

 /* Replay of a completed reset refuses, and the replay is refused on the DURABLE consumed state
  * (verification must never consume: consumption is the completion's alone). */
 await throwsCode(accounts.emailResetComplete(anon.token, challenge.challengeId, 'OtherPassw0rd789'), 'RESET_NOT_AUTHORIZED');
 const afterComplete = await challengeRow(database, challenge.challengeId);
 assert.equal(afterComplete.consumed, true, 'the completion consumed the challenge authorization');
 assert.equal(afterComplete.verified, true, 'while the verification stamp remains recorded');

 /* Stale stamp: verify a FRESH challenge, then rotate the credential by another route; the pinned
  * stamp no longer matches, so completion must refuse instead of overwriting the live credential.
  * The challenge is issued past the approved OTP cooldown on an ADVANCING deterministic clock, and
  * the completion is attempted on a fresh anonymous bearer (the completed reset revoked this one). */
 const staleAt = CLOCK + 2 * 60000;
 const staleAccounts = await accountsFor(database, { clock: () => staleAt });
 const staleSession = await staleAccounts.issue();
 const stale = await staleAccounts.emailResetStart(staleSession.token, 'alice@reset.test');
 await staleAccounts.emailVerify(staleSession.token, stale.challengeId, stale.delivery.code);
 const rotated = await (async () => { const c = await adminClient(database); try { return await c.query("UPDATE identity.email_credentials SET password_hash = 'scrypt-v1$' || repeat('A', 43) WHERE actor_id = 'svc_alice'"); } finally { await c.end(); } })();
 assert.equal(rotated.rowCount, 1, 'fixture: the credential is rotated out of band');
 await throwsCode(staleAccounts.emailResetComplete(staleSession.token, stale.challengeId, 'StalePassw0rd789'), 'RESET_NOT_AUTHORIZED');

 /* The service never regressed to granting from a stale authorization: the rotated credential is
  * still the live one (the reset did not overwrite it). */
 const current = await accounts.emailCredential('alice@reset.test');
 assert.ok(current && current.passwordHash.startsWith('scrypt-v1$AAAA'), 'a refused stale completion must not overwrite the live credential');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account auth: provider reauth/link ownership is exact and a forced same-subject race makes exactly one actor', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authprovider');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);

 /* Fixture identities owned by the trusted importer. */
 const c = await adminClient(database);
 try {
  await c.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google','g-alice','svc_alice',$1)", [new Date(CLOCK).toISOString()]);
  await c.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google','g-bob','svc_bob',$1)", [new Date(CLOCK).toISOString()]);
 } finally { await c.end(); }

 /* Same-owner reauthentication must succeed (the old code compared `found.actor` on a STRING). */
 const linked = await accounts.issue('svc_alice', CLOCK);
 const reauthAttempt = await accounts.start(linked.token, 'google', 'reauth', 'native');
 const consumed = await accounts.consume(linked.token, reauthAttempt.state, 'google', 'native');
 assert.equal(consumed.target, 'svc_alice', 'the reauth attempt targets the session actor');
 const reauthed = await accounts.finishVerified(linked.token, consumed, { provider: 'google', subject: 'g-alice' });
 assert.equal(reauthed.actor, 'svc_alice', 'a same-owner Google reauthentication must succeed');
 /* finishVerified returns the replaced session/profile, not a `providers` list; the approved
  * projection of the linked providers is `self().providers` (the DTO is never asserted whole). */
 assert.deepEqual((await accounts.self('svc_alice')).providers, ['google'], 'the linked provider subject is retained');

 /* Relinking the same subject to the same owner is an idempotent no-op, not a rejection. */
 const relinkSession = await accounts.issue('svc_alice', CLOCK);
 const relinkAttempt = await accounts.start(relinkSession.token, 'google', 'link', 'web');
 const consumedRelink = await accounts.consume(relinkSession.token, relinkAttempt.state, 'google', 'web');
 const relinked = await accounts.finishVerified(relinkSession.token, consumedRelink, { provider: 'google', subject: 'g-alice' });
 assert.equal(relinked.actor, 'svc_alice', 'relinking an identity the SAME actor already owns is accepted');
 assert.equal(relinked.created, false, 'and creates nothing');
 assert.deepEqual((await accounts.identities('svc_alice')).filter((i) => i.provider === 'google').map((i) => i.subject), ['g-alice'], 'with exactly one google identity row');

 /* Ownership conflict: alice cannot finish with bob's subject. */
 const conflictSession = await accounts.issue('svc_alice', CLOCK);
 const conflictAttempt = await accounts.start(conflictSession.token, 'google', 'link', 'web');
 const consumedConflict = await accounts.consume(conflictSession.token, conflictAttempt.state, 'google', 'web');
 await throwsCode(accounts.finishVerified(conflictSession.token, consumedConflict, { provider: 'google', subject: 'g-bob' }), 'ACCOUNT_LINKED_ELSEWHERE');

 /* FORCED same-subject race. A trigger on identity.identities blocks the first writer on a
  * TEST-held advisory lock, so BOTH callers are past their absent-subject lookup (the second is
  * observed waiting on the provider-subject lock) before either can insert; the provider-subject
  * identity lock - not luck - must then produce exactly one actor. */
 const gateKey = 918273645;
 const gateClient = await holdGate(database, gateKey);
 const dropGate = await installAdvisoryGate(database, { schema: 'identity', table: 'identities', name: 'p04_identity_gate', when: "NEW.subject = 'apple-race-subject'", key: gateKey });
 const admin = await adminClient(database);
 const before = await scalar(database, 'SELECT count(*)::int AS n FROM identity.actors');
 const raced = Promise.allSettled([
  accounts.createVerifiedActor({ provider: 'apple', subject: 'apple-race-subject', provenance: 'provider' }),
  accounts.createVerifiedActor({ provider: 'apple', subject: 'apple-race-subject', provenance: 'provider' }),
 ]);
 assert.ok(await waitForLockWaiter(admin), 'a competitor is blocked behind the gate');
 await releaseGate(gateClient, gateKey);
 const results = await raced;
 await dropGate();
 await admin.end();
 const after = await scalar(database, 'SELECT count(*)::int AS n FROM identity.actors');
 assert.equal(after - before, 1, 'a same-subject race must create exactly ONE permanent actor');
 const identities = await (async () => { const cc = await adminClient(database); try { return (await cc.query("SELECT actor_id FROM identity.identities WHERE provider = 'apple' AND subject = 'apple-race-subject'")).rows; } finally { await cc.end(); } })();
 assert.equal(identities.length, 1, 'exactly one identity row owns the subject');
 const winner = identities[0].actor_id;
 for (const r of results) {
  if (r.status === 'fulfilled') assert.equal(r.value.actor, winner, 'every fulfilled caller must return the SURVIVING actor (never a candidate with no identity)');
  else assert.match(String(r.reason && r.reason.message), /ACCOUNT_LINKED_ELSEWHERE|PROVIDER_ALREADY_LINKED/, 'a losing caller refuses with an ownership conflict');
 }
 const orphaned = await scalar(database, "SELECT count(*)::int AS n FROM identity.actors a WHERE NOT EXISTS (SELECT 1 FROM identity.identities i WHERE i.actor_id = a.actor_id) AND NOT EXISTS (SELECT 1 FROM identity.email_credentials c WHERE c.actor_id = a.actor_id)");
 assert.equal(orphaned, 0, 'no actor without a login identity may survive the race');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account auth: concurrent unlinks keep one method and a stale provider attempt cannot re-add a removed method', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authunlink');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 await seedCredential(database, 'svc_alice', 'alice@unlink.test', 'SyntheticPassw0rd', 'modern');

 /* Exactly two methods: google + email. */
 const c = await adminClient(database);
 try { await c.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google','g-alice','svc_alice',$1)", [new Date(CLOCK).toISOString()]); } finally { await c.end(); }

 const linked = await accounts.issue('svc_alice', CLOCK);
 const raced = await Promise.allSettled([
  accounts.unlink(linked.token, 'google'),
  accounts.unlink(linked.token, 'email'),
 ]);
 assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1, 'concurrent unlinks may remove exactly one method');
 const loser = raced.find((r) => r.status === 'rejected');
 assert.match(String(loser && loser.reason && loser.reason.message), /LAST_LOGIN_METHOD|PROVIDER_NOT_LINKED|AUTH_REQUIRED/, 'the second unlink refuses (never a methodless account)');
 const remaining = await (async () => { const cc = await adminClient(database); try { return (await cc.query('SELECT count(*)::int AS n FROM identity.identities WHERE actor_id = $1', ['svc_alice'])).rows[0].n; } finally { await cc.end(); } })();
 assert.equal(remaining, 1, 'the account keeps exactly one login method');

 /* Reset the fixture to a known two-method state, then exercise the stale-readd path deterministically:
  * issue + consume a reauth attempt for google, unlink google from ANOTHER session of the same actor,
  * and finally present the already-consumed attempt from the first session. The consumed attempt must
  * not restore the removed provider identity. */
 const c2 = await adminClient(database);
 try {
  await c2.query('DELETE FROM identity.identities WHERE actor_id = $1', ['svc_alice']);
  await c2.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google','g-alice','svc_alice',$1)", [new Date(CLOCK).toISOString()]);
  await c2.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('email','alice@unlink.test','svc_alice',$1)", [new Date(CLOCK).toISOString()]);
 } finally { await c2.end(); }

 const attemptSession = await accounts.issue('svc_alice', CLOCK);
 const attempt = await accounts.start(attemptSession.token, 'google', 'reauth', 'native');
 const consumed = await accounts.consume(attemptSession.token, attempt.state, 'google', 'native');
 assert.equal(consumed.target, 'svc_alice');
 const unlinkSession = await accounts.issue('svc_alice', CLOCK);
 await accounts.unlink(unlinkSession.token, 'google');
 assert.deepEqual((await accounts.identities('svc_alice')).map((i) => i.provider), ['email'], 'the google method is removed');
 /* The unlink dropped the actor's outstanding sign-in attempts, so the consumed attempt no longer
  * exists durably and finishing it can never restore the removed provider identity. */
 const readd = await accounts.finishVerified(attemptSession.token, consumed, { provider: 'google', subject: 'g-alice' }).then(() => null, (e) => e.message);
 assert.match(String(readd), /INVALID_AUTH_STATE|REAUTH_ACCOUNT_MISMATCH|ACCOUNT_LINKED_ELSEWHERE/, `a consumed attempt for a removed provider must be refused (got ${readd})`);
 const googleRows = await scalar(database, "SELECT count(*)::int AS n FROM identity.identities WHERE actor_id = 'svc_alice' AND provider = 'google'");
 assert.equal(googleRows, 0, 'a consumed provider attempt must not re-add an unlinked method');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account auth: the source bearer is consumed exactly once and a held bearer cannot issue a replacement', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authbearer');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 const password = 'SyntheticPassw0rd';
 await seedCredential(database, 'svc_alice', 'alice@bearer.test', password, 'modern');

 /* Two concurrent credential logins sharing ONE anonymous bearer: exactly one may consume it. */
 const source = await accounts.issue();
 const raced = await Promise.allSettled([
  accounts.emailContinue(source.token, 'alice@bearer.test', password),
  accounts.emailContinue(source.token, 'alice@bearer.test', password),
 ]);
 assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1, 'only one login may consume the shared source bearer');
 const loser = raced.find((r) => r.status === 'rejected');
 assert.match(String(loser && loser.reason && loser.reason.message), /AUTH_REQUIRED|RATE_LIMITED/, 'the second login refuses once the bearer is consumed');

 /* A logged-out bearer cannot issue a replacement. */
 const session = await accounts.issue('svc_alice', CLOCK);
 await accounts.logout(session.token);
 await throwsCode(accounts.emailContinue(session.token, 'alice@bearer.test', password), 'AUTH_REQUIRED');

 /* A bearer revoked by another session cannot be used to obtain a replacement either. The sibling's
  * OWN session id is resolved from ITS bearer's live list (the only deterministic identifier - the
  * other bearer's list may carry other pre-existing sessions). */
 const a = await accounts.issue('svc_alice', CLOCK);
 const b = await accounts.issue('svc_alice', CLOCK);
 const aId = (await accounts.sessions(a.token)).find((s) => s.current).id;
 await accounts.revokeSession(b.token, aId);
 assert.equal(await accounts.session(a.token), null, 'the sibling bearer is revoked');
 await throwsCode(accounts.emailContinue(a.token, 'alice@bearer.test', password), 'AUTH_REQUIRED');

 /* An ANONYMOUS credential login (OLD password) concurrent with a TARGET-ACTOR reset that wins the
  * revocation. The reset changes the password and revokes every session, so once it has won the OLD
  * password can no longer authenticate and any session the login managed to issue FIRST is gone.
  * This asserts the DURABLE end state (no old-password grant, no surviving login session), not a
  * session count. */
 const anonLogin = await accounts.issue();
 const resetAnon = await accounts.issue();
 const resetFlow = (async () => {
  const ch = await accounts.emailResetStart(resetAnon.token, 'alice@bearer.test');
  const ready = await accounts.emailVerify(resetAnon.token, ch.challengeId, ch.delivery.code);
  if (ready.resetReady !== true) throw new Error('RESET_NOT_READY');
  return accounts.emailResetComplete(resetAnon.token, ch.challengeId, 'RacedPassw0rd321');
 })();
 const [loginOutcome, resetOutcome] = await Promise.allSettled([
  accounts.emailContinue(anonLogin.token, 'alice@bearer.test', password),
  resetFlow,
 ]);
 assert.equal(resetOutcome.status, 'fulfilled', `the reset must complete (${resetOutcome.reason && resetOutcome.reason.message})`);
 const loginToken = loginOutcome.status === 'fulfilled' ? loginOutcome.value.token : null;
 if (loginOutcome.status === 'rejected') {
  assert.equal(loginOutcome.reason.message, 'INVALID_CREDENTIALS', 'a lost login refuses because the OLD password no longer authenticates');
 } else {
  assert.equal(await accounts.session(loginToken), null, 'a session issued before the reset was revoked; none survives the winning revocation');
 }
 /* The durable proof of the winning revocation: the OLD password is refused by a fresh bearer. */
 await throwsCode(accounts.emailContinue((await accounts.issue()).token, 'alice@bearer.test', password), 'INVALID_CREDENTIALS');
 assert.equal((await accounts.sessions(resetOutcome.value.token)).length, 1, 'only the reset caller\'s session remains for the actor');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account auth: many concurrent transitions on ONE actor serialize without deadlock or a lost method', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('authmutex');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 const password = 'SyntheticPassw0rd';
 await seedCredential(database, 'svc_alice', 'alice@mutex.test', password, 'modern');
 const c = await adminClient(database);
 try { await c.query("INSERT INTO identity.identities (provider, subject, actor_id, created_at) VALUES ('google','g-mutex','svc_alice',$1)", [new Date(CLOCK).toISOString()]); } finally { await c.end(); }

 /* Ten transitions for the SAME actor, each taking the actor auth mutex in the canonical order
  * (source-bearer key -> provider/actor key -> row locks). A mixed order would show up here as a
  * PostgreSQL 40P01 deadlock; a lost method would show up as an identity count below two. */
 const sessions = await Promise.all([0, 1, 2, 3, 4].map(() => accounts.issue('svc_alice', CLOCK)));
 const started = await accounts.start(sessions[0].token, 'google', 'reauth', 'native');
 const raced = await Promise.allSettled([
  accounts.logout(sessions[0].token),
  accounts.revokeSession(sessions[1].token, (await accounts.sessions(sessions[1].token)).find((s) => !s.current).id),
  accounts.emailReauth(sessions[2].token, 'alice@mutex.test', password),
  accounts.emailLinkStart(sessions[3].token, 'newalice@mutex.test', password).catch((e) => e.message),
  accounts.start(sessions[4].token, 'apple', 'link', 'web'),
  accounts.consume(sessions[4].token, started.state, 'google', 'native').catch((e) => e.message),
  accounts.finishVerified(sessions[4].token, started, { provider: 'google', subject: 'g-mutex' }).catch((e) => e.message),
  accounts.unlink(sessions[2].token, 'google').catch((e) => e.message),
  accounts.sessions(sessions[2].token).catch((e) => e.message),
  accounts.emailChangeStart(sessions[2].token, 'moved@mutex.test').catch((e) => e.message),
 ]);
 for (const r of raced) {
  if (r.status === 'rejected') {
   assert.doesNotMatch(String(r.reason && r.reason.message), /40P01|deadlock/i, 'no transition may deadlock');
  }
 }
 const durable = await adminClient(database);
 try {
  const methods = (await durable.query('SELECT count(*)::int AS n FROM identity.identities WHERE actor_id = $1', ['svc_alice'])).rows[0].n;
  const verified = (await durable.query('SELECT verified FROM identity.eligibility WHERE actor_id = $1', ['svc_alice'])).rows[0].verified;
  assert.ok(methods >= 1, `the account is never left with zero login methods (got ${methods})`);
  assert.equal(verified, true, 'and stays a verified, mutable account');
 } finally { await durable.end(); }
 await accounts.close();
 await closeDatabasePools(database);
});

/* ================================================================ 12. PROFILE / SOCIAL / EXPORT */

test('P04 account service: the public season projection is the approved shape and discloses no raw opponent/win data', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('seasonproj');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob', 'svc_carol']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);

 /* A durable current-season row carrying the raw persistence fields V4 NEVER published (opponent
  * ids and win/loss counters) plus the fields the approved projection needs. */
 const c = await adminClient(database);
 try {
  await c.query(
   "INSERT INTO economy.season_state (actor_id, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating, last_rated_at, qualified_at)"
   + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
   ['svc_alice', '2026-Q4', new Date(CLOCK - 20 * DAY).toISOString(), 4, 3, ['svc_bob', 'svc_carol', 'svc_bob'], 2, 1, 1, 1600, new Date(CLOCK - 2 * DAY).toISOString(), new Date(CLOCK - 2 * DAY).toISOString()]);
  await c.query(
   "INSERT INTO economy.season_history (actor_id, seq, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating, finish_rating, finish_tier, ended_at)"
   + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
   ['svc_alice', 0, '2026-Q3', new Date(CLOCK - 110 * DAY).toISOString(), 9, 5, ['svc_bob'], 6, 2, 1, 1550, 1540, 'silver', new Date(CLOCK - 95 * DAY).toISOString()]);
 } finally { await c.end(); }

 const view = await accounts.view('svc_bob', 'svc_alice');
 const season = view.season;
 for (const key of ['id', 'start', 'end', 'qualified', 'games', 'queueGames', 'uniqueOpponents', 'qualifiedAt', 'peakRating', 'lastRatedAt', 'requirements', 'previous']) {
  assert.ok(Object.hasOwn(season, key), `the approved season projection must carry ${key}`);
 }
 assert.equal(season.id, '2026-Q4');
 assert.equal(season.uniqueOpponents, 2, 'uniqueOpponents is the DEDUPLICATED opponent count');
 assert.deepEqual(season.requirements, { games: 5, queueGames: 3, uniqueOpponents: 3 }, 'the approved placement requirements are published');
 assert.equal(season.previous && season.previous.id, '2026-Q3', 'the prior archived season is published as previous');
 assert.equal(Object.hasOwn(season, 'opponents'), false, 'raw opponent ids must never be published');
 assert.equal(Object.hasOwn(season, 'wins'), false, 'raw win counters must never be published');
 assert.equal(Object.hasOwn(season, 'losses'), false, 'raw loss counters must never be published');

 /* A private profile hides stats from a non-friend but the profile itself still resolves. */
 const carolView = await accounts.view('svc_bob', 'svc_carol');
 assert.equal(carolView.stats, null, 'a private actor hides stats from a non-friend');
 assert.equal(Object.hasOwn(carolView.season || {}, 'opponents'), false, 'a private profile leaks no raw season opponents either');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account service: an API-only read crosses a quarter boundary without writing Core state', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('apiquarter');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);

 /* The durable season row is still the PRIOR quarter (Q3) with no archive; the injected clock is in
  * Q4. Reading through the API must project the CURRENT approved quarter (never an id/bounds mix)
  * WITHOUT writing any Core-owned season row. */
 const c = await adminClient(database);
 try {
  await c.query(
   "INSERT INTO economy.season_state (actor_id, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating) VALUES ($1,'2026-Q3',$2,7,4,$3,5,2,0,1520)",
   ['svc_alice', new Date(CLOCK - 100 * DAY).toISOString(), ['svc_bob']]);
 } finally { await c.end(); }

 const q4 = D.season(CLOCK);
 assert.equal(q4.id, '2026-Q4', 'fixture: the injected clock is in Q4');
 const view = await accounts.view('svc_alice', 'svc_alice');
 assert.equal(view.season.id, '2026-Q4', 'the public projection reports the APPROVED current quarter, not the stale durable id');
 assert.equal(view.season.start, q4.start, 'and the current quarter start (never a mixed old-id/new-bounds projection)');
 assert.equal(view.season.end, q4.end, 'and the current quarter end');
 assert.equal(view.season.previous && view.season.previous.id, '2026-Q3', 'the superseded prior quarter is projected as previous');
 assert.equal(view.season.games, 0, 'the current quarter starts empty');
 assert.equal(view.season.opponents, undefined, 'raw opponent ids are still never published across a rollover');
 const own = await accounts.self('svc_alice');
 assert.equal(own.season.id, '2026-Q4', 'self() agrees with view() on the current quarter');

 /* The read wrote nothing: the durable season row and its (absent) archive are untouched. */
 assert.equal(await scalar(database, 'SELECT season_id FROM economy.season_state WHERE actor_id = $1', ['svc_alice']), '2026-Q3', 'an API read never rolls the Core-owned season row');
 assert.equal(await scalar(database, 'SELECT count(*)::int AS n FROM economy.season_history WHERE actor_id = $1', ['svc_alice']), 0, 'nor writes an archive');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account service: a block beyond 1000 incident edges still decides the pair exactly', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('pairblocking');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);

 /* 1005 incident edges whose blocked_id sorts BEFORE 'svc_bob', so a 1000-row truncated incident
  * read would drop the alice->bob block entirely. */
 const c = await adminClient(database);
 try {
  await c.query("INSERT INTO social.blocks (blocker_id, blocked_id) SELECT 'svc_alice', 'aaa_' || lpad(g::text, 6, '0') FROM generate_series(1, 1005) g");
  await c.query("INSERT INTO social.blocks (blocker_id, blocked_id) VALUES ('svc_alice', 'svc_bob')");
  const total = (await c.query("SELECT count(*)::int AS n FROM social.blocks WHERE blocker_id = 'svc_alice' OR blocked_id = 'svc_alice'")).rows[0].n;
  assert.equal(total, 1006, 'fixture: the incident set exceeds the old 1000-row page');
 } finally { await c.end(); }

 /* Authorization uses the EXACT pair: the relation is blocked and a request is refused. A truncated
  * incident list would have reported 'none' and admitted the request. */
 assert.equal(await accounts.relation('svc_alice', 'svc_bob'), 'blocked', 'the exact pair read sees the block beyond the page');
 await throwsCode(accounts.view('svc_alice', 'svc_bob'), 'PROFILE_NOT_FOUND');
 await throwsCode(accounts.social('svc_bob', 'pb-1', 'request', 'svc_alice'), 'PROFILE_NOT_FOUND');

 /* The bounded LIST read reports overflow instead of pretending completeness. */
 const listed = await accounts.friends('svc_alice');
 assert.equal(listed.truncated, true, 'a bounded list that overflowed must say so');
 assert.ok(Array.isArray(listed.blocked) && listed.blocked.length <= 500, 'the blocked list stays within its page');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account service: request/accept validate BOTH participants on the locked rows', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('socialelig');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);
 const c = await adminClient(database);
 try { await c.query('UPDATE identity.eligibility SET security_hold = true WHERE actor_id = $1', ['svc_bob']); } finally { await c.end(); }

 /* A held TARGET cannot befriend or be befriended (V4 requestFriend/acceptFriend gate BOTH players). */
 await throwsCode(accounts.social('svc_alice', 'se-1', 'request', 'svc_bob'), 'ACCOUNT_UNAVAILABLE');
 await throwsCode(accounts.social('svc_bob', 'se-2', 'accept', 'svc_alice'), 'ACCOUNT_UNAVAILABLE');
 const c2 = await adminClient(database);
 let friendships = 0;
 try { friendships = (await c2.query('SELECT count(*)::int AS n FROM social.friendships')).rows[0].n; } finally { await c2.end(); }
 assert.equal(friendships, 0, 'no friendship may be created with a held target');

 /* A held INITIATOR is refused too. */
 await installSql(database, ['UPDATE identity.eligibility SET security_hold = true WHERE actor_id = \'svc_alice\'',
  'UPDATE identity.eligibility SET security_hold = false WHERE actor_id = \'svc_bob\'']);
 await throwsCode(accounts.social('svc_alice', 'se-3', 'request', 'svc_bob'), 'ACCOUNT_UNAVAILABLE');

 /* The SAME request succeeds once both are eligible again: the decision is made on the LIVE locked
   * rows, so a hold that lapses (or is applied) while the command waits is honoured. */
 await installSql(database, ['UPDATE identity.eligibility SET security_hold = false WHERE actor_id = \'svc_alice\'']);
 assert.deepEqual(await accounts.social('svc_alice', 'se-4', 'request', 'svc_bob'), { ok: true });
 assert.deepEqual((await accounts.friends('svc_bob')).incoming.map((p) => p.id), ['svc_alice'], 'the request lands once the target is eligible');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account service: deletion hides the disabled profile without hiding a plain wallet-pending actor', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('delhide');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database, { deletionPolicy: { enabled: true, policyVersion: 'p04-policy' } });

 /* A WALLET-PENDING but otherwise eligible actor stays readable (only deletion disables). */
 const pending = await accounts.createVerifiedActor({ provider: 'google', subject: 'g-pending', provenance: 'provider' });
 assert.equal(await walletOf(database, pending.actor), null, 'fixture: the actor is wallet-pending');
 const pendingView = await accounts.view('svc_alice', pending.actor);
 assert.equal(pendingView.id, pending.actor, 'a wallet-pending eligible actor is still publicly readable');
 assert.equal(pendingView.walletReady, false, 'and honestly reports walletReady=false');

 /* A real friendship so the friend-list hiding is a genuine observation, not an empty list. */
 await accounts.social('svc_alice', 'dh-req', 'request', 'svc_bob');
 await accounts.social('svc_bob', 'dh-acc', 'accept', 'svc_alice');
 assert.deepEqual((await accounts.friends('svc_alice')).friends.map((p) => p.id), ['svc_bob'], 'fixture: alice and bob are friends');

 /* Disable bob: every public read path must stop serving him. */
 const bobSession = await accounts.issue('svc_bob', CLOCK);
 const tag = (await accounts.self('svc_bob')).tag;
 const ack = await accounts.deleteAccount(bobSession.token, tag);
 assert.equal(ack.deletionPending, true, 'the API acknowledges the deletion as PENDING (never {deleted:true})');
 await throwsCode(accounts.view('svc_alice', 'svc_bob'), 'PROFILE_NOT_FOUND');
 /* Search by the RETAINED tag: the username is tombstoned by the disable, so a tag search is the
  * real test that the search path excludes the disabled actor rather than merely failing to match. */
 assert.equal((await accounts.search('svc_alice', tag)).length, 0, 'a disabled actor is absent from search even by its retained tag');
 assert.deepEqual((await accounts.friends('svc_alice')).friends, [], 'and absent from friend lists');
 const durable = await (async () => { const cc = await adminClient(database); try { return (await cc.query('SELECT verified FROM identity.eligibility WHERE actor_id = $1', ['svc_bob'])).rows[0]; } finally { await cc.end(); } })();
 assert.equal(durable.verified, false, 'the API performed the REAL disable');
 await accounts.close();
 await closeDatabasePools(database);
});

test('P04 account service: a forced Core admission during deletion yields either a busy refusal or a Core abort, never a disabled busy actor', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('delrace');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const pools = poolsFor(database);
 const accounts = await createAccountService(pools.api, { now: () => CLOCK, otpSecret: OTP_SECRET, deletionPolicy: { enabled: true, policyVersion: 'p04-policy' } });
 const core = await createCoreService(pools.core, { now: () => CLOCK });

 /* The barrier: Core's OFFER INSERT blocks on a TEST-held advisory lock, so Core holds its
  * actor/aggregate locks while the API's deletion runs. The deletion therefore contends with Core's
  * claim; whichever wins, a disabled actor must never end up holding an active match. */
 const gateKey = 517293846;
 const gateClient = await holdGate(database, gateKey);
 const dropGate = await installAdvisoryGate(database, { schema: 'match', table: 'matches', name: 'p04_match_gate', when: "NEW.match_id = 'match-adm'", key: gateKey });
 const admin = await adminClient(database);

 const bobSession = await accounts.issue('svc_bob', CLOCK);
 const tag = (await accounts.self('svc_bob')).tag;
 const admission = core.run({ actor: 'svc_alice', scope: 'player' }, 'adm-offer', { type: 'offer', id: 'match-adm', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: 40 } });
 const deletion = accounts.deleteAccount(bobSession.token, tag);
 /* The deletion contends with Core's actor/eligibility locks while Core is blocked on the gate.
  * (If the API's lock order lets it proceed without contending, the invariant below still governs.) */
 const contended = await waitForLockWaiter(admin, 4000);
 await releaseGate(gateClient, gateKey);
 const [adm, del] = await Promise.allSettled([admission, deletion]);

 const state = await (async () => {
  const r = {};
  r.verified = (await admin.query('SELECT verified FROM identity.eligibility WHERE actor_id = $1', ['svc_bob'])).rows[0].verified;
  r.status = (await admin.query("SELECT status FROM match.matches WHERE match_id = 'match-adm'")).rows[0];
  r.participants = (await admin.query("SELECT count(*)::int AS n FROM match.participants WHERE match_id = 'match-adm'")).rows[0].n;
  return r;
 })();
 const disabled = state.verified === false;
 const admitted = !!state.status && ['OFFERED', 'PLAYING'].includes(state.status.status) && state.participants > 0;
 assert.equal(disabled && admitted, false, `a disabled actor must never hold an active match (del=${del.status}/${del.reason && del.reason.message}, adm=${adm.status}/${adm.reason && adm.reason.message}, contended=${contended})`);
 /* Explicit safe implications: a committed OFFERED match forces the deletion to refuse ACCOUNT_BUSY
  * (the actor stays enabled); a disabled actor forces the admission to abort. */
 if (admitted && adm.status === 'fulfilled') {
  assert.equal(disabled, false, 'with a committed match the deletion must keep the actor enabled');
  assert.match(String(del.reason && del.reason.message), /ACCOUNT_BUSY/, 'and it refuses with ACCOUNT_BUSY');
 } else if (disabled) {
  assert.equal(admitted, false, 'a disabled actor must have no active match');
 }
 await dropGate();
 await accounts.close(); await core.close(); await admin.end();
 await closeDatabasePools(database);
});

test('P04 account service: the complete schemaVersion1 export carries every nested category with real records', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('exportshape');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob', 'svc_carol']));
 if (!(await requireServiceIntegration(t, database))) return;
 const accounts = await accountsFor(database);

 /* Real durable records behind every exported category. */
 const c = await adminClient(database);
 try {
  await c.query('INSERT INTO social.friendships (actor_a, actor_b) VALUES ($1, $2)', ['svc_alice', 'svc_bob']);
  await c.query('INSERT INTO social.friend_requests (from_id, to_id) VALUES ($1, $2)', ['svc_carol', 'svc_alice']);
  await c.query('INSERT INTO social.friend_requests (from_id, to_id) VALUES ($1, $2)', ['svc_alice', 'svc_carol']);
  await c.query(
   "INSERT INTO economy.daily_progress (actor_id, day, finished, seconds, boards, casual, friend, ranked, ranked_bonus, claimed) VALUES ($1, $2, 3, 600, 6, 1, 0, 2, 5, $3)",
   ['svc_alice', '2026-10-07', ['finish']]);
  await c.query(
   "INSERT INTO economy.match_history (actor_id, seq, match_id, at, opponent, mode, queue, symbol, rated, qualified, activity_qualified, result, reason, active_seconds, rating_delta, casual_delta)"
   + ' VALUES ($1,0,$2,$3,$4,$5,false,$6,true,true,true,$7,$8,$9,$10,$11)',
   ['svc_alice', 'match-exp', new Date(CLOCK - DAY).toISOString(), 'svc_bob', 'ranked', 'X', 'win', 'line', 120, 12.5, null]);
  await c.query(
   "INSERT INTO economy.tournament_records (actor_id, entered, wins, runner_up, top3, top5, best_finish, finish_sum, premium_wins) VALUES ($1,2,1,0,1,2,2,5,0)",
   ['svc_alice']);
  await c.query(
   "INSERT INTO economy.season_state (actor_id, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating, last_rated_at) VALUES ($1,'2026-Q4',$2,3,2,$3,2,1,0,1600,$4)",
   ['svc_alice', new Date(CLOCK - 20 * DAY).toISOString(), ['svc_bob'], new Date(CLOCK - 2 * DAY).toISOString()]);
  await c.query(
   "INSERT INTO economy.season_history (actor_id, seq, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating, finish_rating, finish_tier, ended_at) VALUES ($1,0,'2026-Q3',$2,9,5,$3,6,2,1,1550,1540,'silver',$4)",
   ['svc_alice', new Date(CLOCK - 110 * DAY).toISOString(), ['svc_bob'], new Date(CLOCK - 95 * DAY).toISOString()]);
  await c.query(
   "INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ('google','tx-exp','svc_alice','crowns_100',100,false,$1)",
   [new Date(CLOCK - 3 * DAY).toISOString()]);
  await c.query('INSERT INTO monetization.credits (actor_id, credit_balance, equipped_frame) VALUES ($1, 42, $2)', ['svc_alice', 'orbit']);
 } finally { await c.end(); }

 /* A submitted report (exported as a real record with its target ref). */
 await accounts.report('svc_alice', 'svc_bob', 'cheating', 'synthetic export fixture detail');

 const session = await accounts.issue('svc_alice', CLOCK);
 const exported = await accounts.exportData(session.token);
 assert.equal(exported.schemaVersion, 1);
 assert.equal(exported.account.playerId, 'svc_alice');

 const account = exported.account;
 /* Competitive: every approved sub-category present with real values. */
 assert.equal(account.competitive.season.id, '2026-Q4', 'the current season is exported');
 assert.ok(Array.isArray(account.competitive.seasonHistory) && account.competitive.seasonHistory.some((s) => s.id === '2026-Q3'), 'seasonHistory carries the archived quarter');
 assert.ok(Array.isArray(account.competitive.matchHistory) && account.competitive.matchHistory.length === 1, 'matchHistory carries the real history row');
 assert.equal(account.competitive.matchHistory[0].id, 'match-exp');
 assert.equal(account.competitive.tournamentRecord.entered, 2, 'tournamentRecord carries the real record');
 assert.equal(account.competitive.daily['2026-10-07'].finished, 3, 'daily carries the real per-day object');
 assert.equal(Object.hasOwn(account.competitive, 'activeMatch'), true, 'activeMatch is present');
 /* Social: real refs, not just keys. */
 assert.deepEqual(account.social.friends, [{ playerId: 'svc_bob', tag: tagFor('svc_bob'), username: USERNAME('svc_bob') }], 'friends is a list of real refs');
 assert.deepEqual(account.social.incomingRequests.map((r) => r.playerId), ['svc_carol'], 'incomingRequests is populated');
 assert.deepEqual(account.social.outgoingRequests.map((r) => r.playerId), ['svc_carol'], 'outgoingRequests is populated');
 assert.deepEqual(account.social.blocked, [], 'blocked is an empty list of refs');
 /* Economy + receipts + practice + reports: REAL records with the approved fields. */
 assert.ok(account.economyJournal.some((e) => e.id === 'opening:svc_alice' && e.currency === 'coins' && e.actor === 'svc_alice'), 'economyJournal carries the real opening entry');
 assert.deepEqual(account.purchaseReceipts.map((r) => r.transactionId), ['google:tx-exp'], 'purchaseReceipts carries the real receipt');
 assert.equal(account.purchaseReceipts[0].crowns, 100);
 assert.equal(account.practiceSave.revision, 1, 'practiceSave carries the real revision');
 assert.ok(account.practiceSave.practice && account.practiceSave.practice.wallet, 'practiceSave carries the FULL practice payload');
 assert.ok(Array.isArray(account.reportsSubmitted) && account.reportsSubmitted.length === 1, 'reportsSubmitted carries the real report');
 assert.deepEqual(account.reportsSubmitted[0].target, { playerId: 'svc_bob', tag: tagFor('svc_bob'), username: USERNAME('svc_bob') }, 'a submitted report carries its target ref');
 assert.equal(typeof account.wallet.coins, 'number', 'the wallet register is exported');
 assert.equal(account.wallet.monetization.credits, 42, 'the monetization register carries the real credit balance');
 assert.equal(account.wallet.monetization.equipped, 'orbit', 'and the real equipped frame');
 assert.equal(account.wallet.monetization.redeemed.length, 0, 'with an empty redeemed list when nothing was redeemed');
 await accounts.close();
 await closeDatabasePools(database);
});

/* ================================================================ 13. CORE / COMMERCE */

const SEED_DAVE = Object.freeze({ actor: 'svc_dave', coins: 1000, crowns: 100, rating: 1500, games: 30, stats: 'friends' });
const FOUR = Object.freeze(['svc_alice', 'svc_bob', 'svc_carol', 'svc_dave'].map((a) => (a === 'svc_dave' ? SEED_DAVE : SEED_ACTORS.find((s) => s.actor === a))));

test('P04 core service: a pending (wallet-less) actor cannot mutate, play or claim', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('pendinggate');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const pools = poolsFor(database);
 const accounts = await createAccountService(pools.api, { now: () => CLOCK, otpSecret: OTP_SECRET });
 const core = await createCoreService(pools.core, { now: () => CLOCK });

 const created = await accounts.createVerifiedActor({ provider: 'google', subject: 'g-pending-gate', provenance: 'provider' });
 const pending = created.actor;
 assert.equal(await walletOf(database, pending), null, 'fixture: the actor has no wallet');

 /* A wallet-less actor may not ECONOMICALLY mutate, PLAY or CLAIM: every affected PLAYER participant
  * must hold a real wallet row (the durable readiness fact). This is a provisioning-readiness gate,
  * not a gameplay rule - the provisioned control below plays normally. */
 const pendingPrincipal = { actor: pending, scope: 'player' };
 await throwsCode(core.run(pendingPrincipal, 'pg-conv', { type: 'convert', from: 'coins', amount: 10 }), 'ACCOUNT_REQUIRED');
 await throwsCode(core.run(pendingPrincipal, 'pg-quest', { type: 'quest', quest: 'finish' }), 'ACCOUNT_REQUIRED');
 await throwsCode(core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'pg-queue', { type: 'queue', id: 'match-pending', a: pending, b: 'svc_alice', mode: 'ranked' }), 'ACCOUNT_REQUIRED');

 const c = await adminClient(database);
 try {
  const wallet = (await c.query('SELECT coins, crowns FROM economy.wallets WHERE actor_id = $1', [pending])).rows[0] || null;
  const ledger = (await c.query('SELECT count(*)::int AS n FROM economy.ledger WHERE actor_id = $1', [pending])).rows[0].n;
  const matches = (await c.query("SELECT count(*)::int AS n FROM match.matches")).rows[0].n;
  const participants = (await c.query('SELECT count(*)::int AS n FROM match.participants WHERE actor_id = $1', [pending])).rows[0].n;
  const occupancy = (await c.query('SELECT count(*)::int AS n FROM core.actor_occupancy WHERE actor_id = $1', [pending])).rows[0].n;
  assert.equal(wallet, null, 'a pending actor must never acquire a wallet row through a command');
  assert.equal(ledger, 0, 'nor an opening/quest ledger entry');
  assert.equal(matches, 0, 'a pending actor must not create a match');
  assert.equal(participants, 0, 'nor a participant row');
  assert.equal(occupancy, 0, 'nor an occupancy claim');
 } finally { await c.end(); }

 /* Positive control: once Core provisions it, the SAME actor can convert and play. */
 await core.provisionActor(pending);
 assert.ok(await walletOf(database, pending), 'provisioning is what creates the wallet');
 const converted = await core.run(pendingPrincipal, 'pg-conv-ok', { type: 'convert', from: 'coins', amount: 10 });
 assert.equal(converted.credit, 1, 'a provisioned actor can convert');
 const queued = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'pg-queue-ok', { type: 'queue', id: 'match-prov', a: pending, b: 'svc_alice', mode: 'ranked' });
 assert.equal(queued.id, 'match-prov', 'and is admitted to a queue offer');
 await accounts.close(); await core.close();
 await closeDatabasePools(database);
});

test('P04 core service: a duplicate match identity across disjoint pairs is rejected, never replaced', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('dupidentity');
 await seedActors(database, FOUR);
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const core = await coreFor(database);

 /* Two disjoint pairs, two DIFFERENT keys, the SAME match id. Exactly one may create 'match-dup';
  * the loser must refuse rather than UPSERT-replace the winner's match and participants. The DB
  * barrier is the aggregate advisory lock: whoever wins, the other observes the committed row. */
 const raced = await Promise.allSettled([
  core.run({ actor: 'svc_alice', scope: 'player' }, 'dup-a', { type: 'offer', id: 'match-dup', opponent: 'svc_bob', terms: { kind: 'leaderboard', amount: 40 } }),
  core.run({ actor: 'svc_carol', scope: 'player' }, 'dup-b', { type: 'offer', id: 'match-dup', opponent: 'svc_dave', terms: { kind: 'leaderboard', amount: 40 } }),
 ]);
 const winners = raced.filter((r) => r.status === 'fulfilled');
 const losers = raced.filter((r) => r.status === 'rejected');
 assert.equal(winners.length, 1, 'exactly one offer may create the match identity');
 assert.match(String(losers[0] && losers[0].reason && losers[0].reason.message), /DUPLICATE_OR_INVALID_MATCH|PENDING_INVITATION/, 'the loser refuses a duplicate aggregate identity');

 const c = await adminClient(database);
 try {
  const matches = (await c.query("SELECT count(*)::int AS n FROM match.matches WHERE match_id = 'match-dup'")).rows[0].n;
  const participants = (await c.query("SELECT actor_id FROM match.participants WHERE match_id = 'match-dup' ORDER BY seat")).rows.map((r) => r.actor_id);
  assert.equal(matches, 1, 'exactly one durable match row');
  assert.equal(participants.length, 2, 'the surviving match has two participants');
  const winnerPair = winners[0].value.players.slice().sort();
  assert.deepEqual(participants.slice().sort(), winnerPair, 'the surviving participants are the WINNER pair, never overwritten by the loser');
  /* The loser wrote no outcome and no second participant set. */
  const outcomes = (await c.query("SELECT count(*)::int AS n FROM economy.command_outcomes WHERE \"key\" = $1 OR \"key\" = $2", [JSON.stringify('dup-a'), JSON.stringify('dup-b')])).rows[0].n;
  assert.equal(outcomes, 1, 'only the winning command records an outcome');
  const occupancy = (await c.query('SELECT count(*)::int AS n FROM core.actor_occupancy')).rows[0].n;
  assert.equal(occupancy, 0, 'an OFFERED match claims no occupancy yet');
 } finally { await c.end(); }
 await core.close();
 await closeDatabasePools(database);
});

test('P04 core service: a service principal reusing one key for two aggregates is an IDEMPOTENCY_CONFLICT with no side effects', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('svcprincipal');
 await seedActors(database, FOUR);
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const core = await coreFor(database);

 /* The SAME service principal ('matchmaker') and the SAME key, two DIFFERENT queue commands on
  * disjoint aggregates. The logical operation identity must serialize even for a service principal,
  * so the second is a conflicting fingerprint and must abort the WHOLE transaction. */
 const first = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'mm-shared', { type: 'queue', id: 'mm-q1', a: 'svc_alice', b: 'svc_bob', mode: 'ranked' });
 assert.equal(first.id, 'mm-q1', 'the first service-principal command succeeds');
 const second = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'mm-shared', { type: 'queue', id: 'mm-q2', a: 'svc_carol', b: 'svc_dave', mode: 'ranked' }).then(() => null, (e) => e.message);
 assert.equal(second, 'IDEMPOTENCY_CONFLICT', 'a same-key different-aggregate service command conflicts');

 const c = await adminClient(database);
 try {
  const rows = (await c.query("SELECT match_id FROM match.matches ORDER BY match_id")).rows.map((r) => r.match_id);
  assert.deepEqual(rows, ['mm-q1'], 'the losing command must leave NO second aggregate');
  const occupancy = (await c.query('SELECT count(*)::int AS n FROM core.actor_occupancy')).rows[0].n;
  assert.equal(occupancy, 0, 'an OFFERED queue match claims no occupancy for either command');
  const outcomes = (await c.query('SELECT count(*)::int AS n FROM economy.command_outcomes')).rows[0].n;
  assert.equal(outcomes, 1, 'exactly one outcome row survives');
 } finally { await c.end(); }

 /* Replaying the WINNING key with the identical command returns the stored response unchanged. */
 const replay = await core.run({ actor: 'matchmaker', scope: 'matchmaker' }, 'mm-shared', { type: 'queue', id: 'mm-q1', a: 'svc_alice', b: 'svc_bob', mode: 'ranked' });
 assert.deepEqual(replay, first, 'an identical same-key replay returns the stored response');
 await core.close();
 await closeDatabasePools(database);
});

test('P04 core service: disjoint settlements both survive in the shared burn ledger and the singleton', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('burns');
 await seedActors(database, FOUR);
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const core = await coreFor(database);

 const play = async (matchId, challenger, opponent, okey) => {
  const offer = await core.run({ actor: challenger, scope: 'player' }, `${okey}-offer`, { type: 'offer', id: matchId, opponent, terms: { kind: 'leaderboard', amount: 40 } });
  const accepted = await core.run({ actor: opponent, scope: 'player' }, `${okey}-accept`, { type: 'accept', id: matchId, termsHash: offer.termsHash });
  assert.equal(accepted.status, 'PLAYING', `${matchId} is running`);
  return accepted;
 };
 await play('burn-a', 'svc_alice', 'svc_bob', 'ba');
 await play('burn-b', 'svc_carol', 'svc_dave', 'bb');

 /* The migration seeds the shared singleton row (0024); reset it to zero (never a duplicate INSERT,
  * which would violate the `id = 1` primary key). Both settlements then UPDATE the same row, so the
  * row lock - not an insert conflict - is what serializes them. */
 await installSql(database, ['UPDATE economy.system_burns SET coins = 0, crowns = 0 WHERE id = 1']);
 assert.equal(await scalar(database, 'SELECT count(*)::int AS n FROM economy.system_burns'), 1, 'fixture: exactly one burn singleton row exists');

 /* FORCE the interleave: the FIRST settlement's update of the shared burn row waits until the second
  * settlement is observed BLOCKED on that row. Both hydrations read the PRE-settlement total, so a
  * stale absolute-total overwrite would lose the first burn; only an additive delta keeps both. The
  * gate fires only on the pre-settlement total (OLD.crowns = 0), so the second update never waits. */
 const dropGate = await installUpdateWaiterGate(database, { schema: 'economy', table: 'system_burns', name: 'p04_burn_gate', when: 'OLD.id = 1 AND OLD.crowns = 0' });

 /* Both matches forfeit CONCURRENTLY on the same system_burns singleton (each burns half its 40
  * escrow = 20 crowns). A stale absolute-total write would lose one; an additive delta keeps both. */
 const settled = await Promise.allSettled([
  core.run({ actor: 'svc_bob', scope: 'player' }, 'ba-resign', { type: 'resign', id: 'burn-a' }),
  core.run({ actor: 'svc_dave', scope: 'player' }, 'bb-resign', { type: 'resign', id: 'burn-b' }),
 ]);
 await dropGate();
 assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 2, 'both disjoint settlements must commit');

 const c = await adminClient(database);
 try {
  const burns = (await c.query('SELECT coins, crowns FROM economy.system_burns WHERE id = 1')).rows[0];
  assert.equal(Number(burns.crowns), 40, 'both disjoint Crown burns survive in the singleton');
 } finally { await c.end(); }
 /* The winner of each match depends on the random symbol draw, so the invariant is the PAIR TOTAL:
  * the challenger paid a 40-crown escrow, of which 20 was burned and 20 paid to the winner, leaving
  * the pair with 180 (200 - 40 + 20). No escrow is lost and no double payout occurs. */
 const pairTotal = async (a, b) => Number((await walletOf(database, a)).crowns) + Number((await walletOf(database, b)).crowns);
 assert.equal(await pairTotal('svc_alice', 'svc_bob'), 180, 'the first match paid its escrow out exactly once (20 burned, 20 to the winner)');
 assert.equal(await pairTotal('svc_carol', 'svc_dave'), 180, 'the second match paid its escrow out exactly once');
 assert.equal(Number((await walletOf(database, 'svc_alice')).reserved_crowns) + Number((await walletOf(database, 'svc_bob')).reserved_crowns), 0, 'no reservation is left held after settlement');
 await core.close();
 await closeDatabasePools(database);
});

test('P04 core service: a quarter rollover archives the prior season and normalizes only LOCKED actors', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('quarterroll');
 await seedActors(database, seedFor(['svc_alice', 'svc_bob']));
 if (!(await requireServiceIntegration(t, database))) return;
 const core = await coreFor(database);

 /* Both actors carry a durable PRIOR-quarter season row and no archive. */
 const c = await adminClient(database);
 try {
  for (const actor of ['svc_alice', 'svc_bob']) {
   await c.query(
    "INSERT INTO economy.season_state (actor_id, season_id, started_at, games, queue_games, opponents, wins, losses, draws, peak_rating) VALUES ($1,'2026-Q3',$2,7,4,$3,5,2,0,1520)",
    [actor, new Date(CLOCK - 100 * DAY).toISOString(), ['svc_bob']]);
  }
 } finally { await c.end(); }

 /* A command that locks ONLY svc_alice must archive alice's Q3 season and leave bob untouched. */
 await core.run({ actor: 'svc_alice', scope: 'player' }, 'qr-conv', { type: 'convert', from: 'coins', amount: 100 });

 const c2 = await adminClient(database);
 try {
  const aliceSeason = (await c2.query('SELECT season_id FROM economy.season_state WHERE actor_id = $1', ['svc_alice'])).rows[0];
  const bobSeason = (await c2.query('SELECT season_id FROM economy.season_state WHERE actor_id = $1', ['svc_bob'])).rows[0];
  const aliceArchive = (await c2.query('SELECT season_id, finish_rating, finish_tier, ended_at FROM economy.season_history WHERE actor_id = $1', ['svc_alice'])).rows;
  const bobArchive = (await c2.query('SELECT count(*)::int AS n FROM economy.season_history WHERE actor_id = $1', ['svc_bob'])).rows[0].n;
  assert.equal(aliceSeason.season_id, '2026-Q4', 'the locked actor rolls to the current quarter');
  assert.equal(aliceArchive.length, 1, 'the prior Q3 season is ARCHIVED, not dropped');
  assert.equal(aliceArchive[0].season_id, '2026-Q3', 'the archive retains the prior season id');
  assert.ok(aliceArchive[0].ended_at !== null, 'the archive records the quarter boundary as endedAt');
  assert.equal(bobSeason.season_id, '2026-Q3', 'an UNLOCKED actor is never normalized by another actor\'s maintenance');
  assert.equal(bobArchive, 0, 'and no archive row is written for it');
 } finally { await c2.end(); }

 /* The API projection for the rolled actor carries the Q4 season and the Q3 archive as `previous`. */
 const pools = poolsFor(database);
 const accounts = await createAccountService(pools.api, { now: () => CLOCK, otpSecret: OTP_SECRET });
 const view = await accounts.view('svc_alice', 'svc_alice');
 assert.equal(view.season.id, '2026-Q4', 'the public projection agrees on the current season');
 assert.equal(view.season.previous && view.season.previous.id, '2026-Q3', 'and publishes the archived quarter as previous');
 await accounts.close(); await core.close();
 await closeDatabasePools(database);
});

test('P04 core/commerce: a refund before the verified grant and a duplicate tombstone both stay permanently revoked', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('refundrevoke');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const pools = poolsFor(database);
 const core = await createCoreService(pools.core, { now: () => CLOCK });
 const verifyPurchase = async (evidence, actor) => ({ valid: true, accountId: actor, store: evidence.store, transactionId: evidence.transactionId, productId: evidence.productId, refunded: false });
 const commerce = await createCommerceService(pools.core, { now: () => CLOCK, purchasesEnabled: true, eligible: () => true, verifyPurchase });

 /* 1. REFUND BEFORE GRANT: a trusted refund for a store transaction that has no receipt yet must
  *    establish a PERMANENT revocation WITHOUT inventing an actor or a refund balance; the later
  *    purchase then sees the tombstone and refuses. */
 const pre = await commerce.refund('google', 'tx-pre-grant');
 assert.equal(pre.refunded, true, 'a refund of an unknown receipt reports the durable revocation');
 assert.equal(pre.known, false, 'and reports the receipt as not yet known');
 assert.equal(pre.accountHeld, false, 'without inventing an actor hold or a refund balance');
 const c = await adminClient(database);
 try {
  const revoked = (await c.query("SELECT count(*)::int AS n FROM monetization.store_revocations WHERE store='google' AND transaction_id='tx-pre-grant'")).rows[0].n;
  assert.equal(revoked, 1, 'a refund before the grant must leave a durable tombstone');
 } finally { await c.end(); }
 const crownsBefore = Number((await walletOf(database, 'svc_alice')).crowns);
 await assert.rejects(() => commerce.purchase('svc_alice', 'buy-pre', googleEvidence('tx-pre-grant')), /RECEIPT_REFUNDED/);
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), crownsBefore, 'a pre-grant revocation must never regrant');
 assert.equal(await ledgerCount(database, 'purchase:google:tx-pre-grant'), 0, 'and writes no purchase ledger row');

 /* 2. DUPLICATE TOMBSTONE REPAIR: a receipt refunded once, then refunded AGAIN (including a receipt
  *    whose tombstone was written out of band), must end with exactly one tombstone and refuse the
  *    later purchase. The direct Core refund path is commerce-owned and refuses by name. */
 const c2 = await adminClient(database);
 try {
  await c2.query("INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ('google','tx-dup-repair','svc_alice','crowns_100',100,false,$1)", [new Date(CLOCK - 3600000).toISOString()]);
 } finally { await c2.end(); }
 await throwsCode(core.run({ actor: 'store', scope: 'store' }, 'rf-core', { type: 'refund', store: 'google', transactionId: 'tx-dup-repair' }), 'COMMERCE_OWNED_COMMAND');
 const firstRefund = await commerce.refund('google', 'tx-dup-repair');
 assert.equal(firstRefund.refunded, true);
 assert.equal(firstRefund.duplicate, false, 'the first trusted refund records the revocation');
 const c3 = await adminClient(database);
 try {
  assert.equal((await c3.query("SELECT count(*)::int AS n FROM monetization.store_revocations WHERE transaction_id='tx-dup-repair'")).rows[0].n, 1, 'the trusted refund writes the permanent tombstone');
 } finally { await c3.end(); }
 const dup = await commerce.refund('google', 'tx-dup-repair');
 assert.equal(dup.refunded, true, 'a second refund of the same receipt is still a successful (idempotent) revocation');
 const c4 = await adminClient(database);
 try {
  assert.equal((await c4.query("SELECT count(*)::int AS n FROM monetization.store_revocations WHERE transaction_id='tx-dup-repair'")).rows[0].n, 1, 'a duplicate refund leaves exactly one tombstone (repaired, not doubled)');
 } finally { await c4.end(); }
 await assert.rejects(() => commerce.purchase('svc_alice', 'buy-dup', googleEvidence('tx-dup-repair')), /RECEIPT_REFUNDED|ACCOUNT_HELD|INVALID_RECEIPT/);
 const c5 = await adminClient(database);
 try {
  assert.equal((await c5.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id = 'purchase:google:tx-dup-repair'")).rows[0].n, 0, 'a refunded receipt never grants a purchase ledger row');
 } finally { await c5.end(); }
 await commerce.close(); await core.close();
 await closeDatabasePools(database);
});

test('P04 commerce service: a receipt omitted by the global cap is still honoured, and ordinary purchases do not go dark', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('receiptcap');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database, { projection: false }))) return;
 const pools = poolsFor(database);
 const verifyPurchase = async (evidence, actor) => ({ valid: true, accountId: actor, store: evidence.store, transactionId: evidence.transactionId, productId: evidence.productId, refunded: false });
 const commerce = await createCommerceService(pools.core, { now: () => CLOCK, purchasesEnabled: true, eligible: () => true, verifyPurchase });

 /* More than the global receipt cap (5000), with the TARGET receipt sorting after the retained page
  * so the whole-graph hydration cannot see it. */
 const c = await adminClient(database);
 try {
  await c.query("INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) SELECT 'google', 'a' || lpad(g::text, 6, '0'), 'svc_alice', 'crowns_100', 100, false, now() FROM generate_series(1, 5000) g");
  await c.query("INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ('google','zzzz-omitted','svc_alice','crowns_100',100,false,now())");
  assert.equal((await c.query('SELECT count(*)::int AS n FROM monetization.receipts')).rows[0].n, 5001, 'fixture: the receipt history exceeds the cap');
 } finally { await c.end(); }

 const before = Number((await walletOf(database, 'svc_alice')).crowns);
 /* The omitted valid receipt must NOT regrant under a fresh operation key; the targeted own-row read
  * finds it and reports the duplicate. */
 const omitted = await commerce.purchase('svc_alice', 'buy-omitted', googleEvidence('zzzz-omitted'));
 assert.equal(omitted.duplicate, true, 'a receipt outside the retained page is found by the targeted read and reported as a duplicate');
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), before, 'and never regrants');
 assert.equal(await ledgerCount(database, 'purchase:google:zzzz-omitted'), 0, 'nor writes a second purchase ledger row');

 /* Positive control: ordinary purchases must still work with a saturated receipt history (no
  * artificial all-game outage at 5000 receipts). */
 const granted = await commerce.purchase('svc_alice', 'buy-fresh', googleEvidence('tx-fresh-after-cap'));
 assert.equal(granted.duplicate, false, 'a brand-new receipt still grants with a saturated history');
 assert.equal(granted.crowns, 100);
 assert.equal(Number((await walletOf(database, 'svc_alice')).crowns), before + 100, 'the fresh grant is applied exactly once');
 await commerce.close();
 await closeDatabasePools(database);
});

test('P04 provisioning: a new actor gets its approved season/credits/record rows as the projection expects', async (t) => {
 if (!(await boot(t))) return;
 const database = await createDatabase('provmaterialize');
 await seedActors(database, seedFor(['svc_alice']));
 if (!(await requireServiceIntegration(t, database))) return;
 const pools = poolsFor(database);
 const accounts = await createAccountService(pools.api, { now: () => CLOCK, otpSecret: OTP_SECRET });
 const core = await createCoreService(pools.core, { now: () => CLOCK });

 const created = await accounts.createVerifiedActor({ provider: 'google', subject: 'g-materialize', provenance: 'provider' });
 const pending = created.actor;
 assert.equal(await ledgerCount(database, `opening:${pending}`), 0, 'the API half mints nothing');

 await core.provisionActor(pending);

 /* The approved initial rows are materialized atomically with the wallet, so the API's own
  * projection (which reads economy through the owner function) sees a current season, not null. */
 const c = await adminClient(database);
 try {
  const season = (await c.query('SELECT season_id FROM economy.season_state WHERE actor_id = $1', [pending])).rows[0];
  const credits = (await c.query('SELECT count(*)::int AS n FROM monetization.credits WHERE actor_id = $1', [pending])).rows[0].n;
  const record = (await c.query('SELECT count(*)::int AS n FROM economy.tournament_records WHERE actor_id = $1', [pending])).rows[0].n;
  assert.ok(season, 'a provisioned actor has its approved season row');
  assert.equal(season.season_id, '2026-Q4', 'the materialized season is the CURRENT quarter');
  assert.equal(credits, 1, 'the approved credits row is materialized');
  assert.equal(record, 1, 'the approved tournament record row is materialized');
 } finally { await c.end(); }

 const state = await accounts.state(pending);
 assert.ok(state.season, 'the API state projection reports the current season (the parent smoke saw null)');
 assert.equal(state.season.id, '2026-Q4');
 const view = await accounts.view('svc_alice', pending);
 assert.equal(view.season && view.season.id, '2026-Q4', 'and the public projection agrees for a brand-new actor');
 assert.equal(view.walletReady, true);

 /* Re-running provisioning with an existing wallet mints nothing and never overwrites the season. */
 const replay = await core.provisionActor(pending);
 assert.deepEqual({ ready: replay.ready, created: replay.created }, { ready: true, created: false });
 assert.equal(await ledgerCount(database, `opening:${pending}`), 1, 'a replay writes no second opening row');
 assert.equal(Number((await walletOf(database, pending)).coins), 150, 'a replay mints nothing');
 assert.equal((await adminClient(database).then(async (cc) => { try { return (await cc.query('SELECT season_id FROM economy.season_state WHERE actor_id = $1', [pending])).rows[0].season_id; } finally { await cc.end(); } })), '2026-Q4', 'a replay never overwrites the existing season');
 await accounts.close(); await core.close();
 await closeDatabasePools(database);
});
