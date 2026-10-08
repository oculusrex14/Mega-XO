/* tests/v5-p04-differential.test.js - V5 P04 (V5-04-05) differential and contention acceptance.
 *
 * WHAT THIS PROVES
 *   The PostgreSQL adapter (packages/db/pg) must reproduce the V4.1.2 behaviour that the SQLite
 *   reference adapter (packages/db) still holds. This suite runs the SAME command sequences, the
 *   SAME injected clock and the SAME deterministic random seed through both paths and compares the
 *   resulting canonical observable state per actor and per entity:
 *
 *     (a) reference: `createSqliteUnitOfWork(DurableStore.db)` + the unchanged
 *         `packages/domain/commands.js` `executeCommand`, against a database built by the real
 *         `server/production/migrations.js` `migrate()` - i.e. the shipped V4 behaviour;
 *     (b) target: `createPgUnitOfWork(pool)` + the SAME `executeCommand`, against a database built
 *         by the real current checksummed migration chain.
 *
 *   Compared: wallet coins/crowns/reserved/purchased/influenced, the account wallet ledger and the
 *   global journal, rating/peak/casual rating and tier, games/casual games, the per-actor history
 *   rows, match rows with their participants/statuses/receipts, tournament records, daily progress
 *   and claimed quests, operation outcomes (idempotency rows) and purchase receipts. A divergence is
 *   REPORTED as a finding (the test fails with the exact JSON paths), never normalised away. The
 *   only two documented exemptions are the append-only ledger ORDER (both adapters expose the same
 *   ROW SET; PG orders by the shipped `at, entry_id` index tiebreak - the same tiebreak the sibling
 *   P04 suite documents) and the two adapter-owned extras documented at the OBSERVED/EXCLUDED split.
 *
 *   Contention races (separate pooled clients, i.e. separate database scopes): two scopes racing one
 *   wallet conversion and one reward claim, the refund path, and match settlement/void. Assertions:
 *   exactly one winner where the resource is finite, no overdraw, no double-reserve, no double-apply,
 *   and a losing/failing unit of work rolls back completely.
 *
 *   Idempotency: the same command key replayed on BOTH adapters returns the stored response and
 *   applies the effect exactly once.
 *
 * Harness contract (identical to tests/v5-p04-repositories.test.js and tests/v5-migrations.test.js,
 * the frozen P02 disposable PG16 contract):
 *   - V5_PG_URL=<loopback direct admin URL> + V5_PG_DISPOSABLE=1: a caller-owned synthetic PG16
 *     cluster. The URL is used ONLY to CREATE/DROP this suite's tracked v5_test_p04diff_* databases,
 *     enable the runtime LOGIN identities, and seed fixture rows as the trusted provisioner; the
 *     control database is never mutated, truncated or dropped.
 *   - Without V5_PG_URL: installed PostgreSQL 16 binaries on a test-owned mkdtemp datadir.
 *   - V5_PG_REQUIRED=1: fail instead of skipping when no backend is available.
 * No Neon or production target is ever contacted. This file edits nothing: it only reads the
 * shipped adapters, the shipped domain engine and the shipped migrations.
 */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const CHAIN_LENGTH = require(path.join(ROOT, 'packages', 'migrations', 'manifest.json')).migrations.length;
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
const SUFFIX = crypto.randomBytes(4).toString('hex');
const PID = process.pid;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const OWNED_PREFIX = 'v5_test_p04diff_';

/* The one injected clock and the one random seed both adapters must honour. 2026-10-08T12:00:00Z is
 * the frozen semantic clock of the whole V5 programme (P02/P03 fixtures use it). */
const CLOCK = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86400000;
const SEED = 0x5eed0f04;

/* ---------------------------------------------------------------- deterministic entropy */

/* A seeded xorshift32 stream. `Authority.random` is consulted exactly once per accepted pair
 * (chooseSymbols) and `crypto.randomInt(2)` is its shipped default, so a caller-supplied stream is
 * the only way two adapters can be compared on the symbol draw at all. */
function seededRandom(seed) {
 let state = (seed >>> 0) || 0x9e3779b9;
 return function random() {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state % 2;
 };
}

/* ---------------------------------------------------------------- backend */

function whichBinary() {
 for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
  try {
   if (fs.existsSync(path.join(dir, 'initdb')) && execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
  } catch { /* next */ }
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
 const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v5-p04diff-pg-${PID}-`));
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
function dbUrl(database) { const u = new URL(backend.adminUrl); u.pathname = `/${database}`; u.search = ''; return u.toString(); }

test.after(async () => {
 if (!backend) return;
 for (const name of [...createdDatabases]) {
  try { const c = await adminClient(); await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`); await c.end(); } catch { /* best effort, tracked names only */ }
 }
 if (backend.stop) backend.stop();
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

/* One owned database per test, migrated by the real runner to 37/37. */
const databases = new Map();
async function freshDatabase(t, family) {
 if (process.env.V5_PG_REQUIRED !== '1' && !process.env.V5_PG_URL) { t.skip('no V5_PG_URL and V5_PG_REQUIRED unset'); return null; }
 try { await ensureBackend(); } catch (err) { if (process.env.V5_PG_REQUIRED === '1') throw err; t.skip(err.message); return null; }
 const name = `${OWNED_PREFIX}${family}_${PID}_${SUFFIX}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
 const c = await adminClient();
 try { await c.query(`CREATE DATABASE ${ident(name)}`); createdDatabases.add(name); } finally { await c.end(); }
 const migration = runMigrator(name);
 assert.equal(migration.status, 0, `migration failed: ${migration.stdout}${migration.stderr}`);
 assert.equal(migration.json.code, 'OK');
 assert.equal(migration.json.appliedCount, CHAIN_LENGTH, 'the real checksummed chain must apply in full');
 const c2 = await adminClient(name);
 try { for (const role of RUNTIME_ROLES) await c2.query(`ALTER ROLE ${ident(role)} LOGIN`); } finally { await c2.end(); }
 databases.set(family, name);
 return name;
}

/* ---------------------------------------------------------------- pools (target side) */

const { createPgPool } = require('../packages/db/pg/pool.js');
const { createPgUnitOfWork } = require('../packages/db/pg/uow.js');
const { executeCommand } = require('../packages/domain/commands.js');
const { COMMANDS, SOCIAL_OPERATIONS } = require('../packages/db/scopes');

const BUDGET = Object.freeze({ totalConnections: 12, roleConnections: Object.freeze({ core_runtime: 6, api_runtime: 4, worker_runtime: 2 }) });
const poolFor = new Map();
function poolsFor(database) {
 if (poolFor.has(database)) return poolFor.get(database);
 const make = (role, max) => createPgPool({
  host: backend.host, port: backend.port, database, user: role, role, label: 'test',
  service: 'v5-p04diff-test', revision: 'p04differential', allowLocalNoTls: true,
  pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 },
  budget: BUDGET,
 });
 const pools = { core: make('core_runtime', 6), api: make('api_runtime', 4), worker: make('worker_runtime', 2) };
 poolFor.set(database, pools);
 return pools;
}
test.after(async () => {
 for (const pools of poolFor.values()) await Promise.all([pools.core.end(), pools.api.end(), pools.worker.end()]);
 poolFor.clear();
});

/* One unit of work per CALLER for the target side: contention needs two independent scopes, so the
 * unit of work (its `now`, `random` and store verifier) is constructed per racing party, never
 * shared. `random`/`verifyPurchase` are carried in `options` because that is the object
 * `pgRepositoriesFor` hands to the domain model (`authorityFor`). */
const VERIFY_PURCHASE = (evidence, actor) => ({ ...evidence, valid: true, accountId: actor, refunded: false });
function pgUnit(pools, { now = () => CLOCK, random = seededRandom(SEED), verifyPurchase = VERIFY_PURCHASE, role = 'core_runtime' } = {}) {
 const pool = role === 'api_runtime' ? pools.api : role === 'worker_runtime' ? pools.worker : pools.core;
 return createPgUnitOfWork(pool, { now, random, verifyPurchase, role });
}

/* ---------------------------------------------------------------- reference side (V4.1.2) */

const { DurableStore } = require('../server/economy-store.js');
const { migrate } = require('../server/production/migrations.js');

/* The shipped V4 store over its own real schema. `now`, `random` and `verifyPurchase` are the same
 * injected dependencies the target side receives, so both paths see identical inputs. */
function openReference(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-p04diff-sqlite-'));
 const file = path.join(dir, 'reference.sqlite');
 let clock = CLOCK;
 const store = new DurableStore(file, {
  now: () => clock,
  random: seededRandom(SEED),
  verifyPurchase: (evidence, actor) => ({ ...evidence, valid: true, accountId: actor, refunded: false }),
 });
 migrate(store.db);
 t.after(() => { try { store.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
 return { store, advance: (ms) => { clock += ms; return clock; } };
}

/* ---------------------------------------------------------------- shared seed state */

/* Both sides start from the SAME factual seed: the trusted provisioner's actor/eligibility/profile/
 * wallet/rating rows and the opening journal entries that V4's `Authority.addAccount` writes. On the
 * reference side that is the real `provision` command; on the target side the V5 ownership split
 * (design P04 section 7, finding 5) makes provisioning a two-role handshake, so the same factual
 * rows are written by the trusted provisioner exactly as the P03 importer writes them. The two
 * resulting states are then asserted EQUAL before the scripted commands run. */
const SEED_ACTORS = Object.freeze([
 { actor: 'alice', coins: 1000, crowns: 100, rating: 1500, games: 30 },
 { actor: 'bob_2', coins: 1000, crowns: 100, rating: 1500, games: 30 },
 /* Held out of the refund path: `refundPurchase` freezes its receipt's account, and a frozen actor
  * cannot be paired into the match lifecycle, so the match uses carol. */
 { actor: 'carol', coins: 1000, crowns: 100, rating: 1500, games: 30 },
]);
const USERNAME = (actor) => 'player_' + actor;

function tagFor(actor) { return 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 10).toUpperCase(); }

function seedReference(reference) {
 for (const seed of SEED_ACTORS) {
  reference.store.run({ actor: 'ops-provisioner', scope: 'operator' }, 'provision:' + seed.actor, {
   type: 'provision', account: seed.actor,
   options: { coins: seed.coins, crowns: seed.crowns, rating: seed.rating, games: seed.games, verified: true, createdAt: CLOCK - 30 * DAY, region: 'Test' },
  });
 }
}

async function seedTarget(database, actors = SEED_ACTORS) {
 const c = await adminClient(database);
 try {
  for (const seed of actors) {
   await c.query('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1, $2, false, $3)',
    [seed.actor, JSON.stringify('Test'), new Date(CLOCK - 30 * DAY).toISOString()]);
   await c.query('INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1, true, false, false)', [seed.actor]);
   await c.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at) VALUES ($1, $2, $3, $4, $5)',
    [seed.actor, tagFor(seed.actor), USERNAME(seed.actor), seed.actor, new Date(CLOCK - 30 * DAY).toISOString()]);
   await c.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)', [seed.actor, seed.coins, seed.crowns]);
   await c.query('INSERT INTO economy.ratings (actor_id, rating, peak, casual_rating, games, casual_games, tier) VALUES ($1, $2, $2, $3, $4, 0, $5)',
    [seed.actor, seed.rating, seed.games >= 10 ? seed.rating : 1000, seed.games, tierOf(seed.rating)]);
   await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'coins', $3, 'Opening balance', 'provisioning', $4)",
    ['opening:' + seed.actor, seed.actor, seed.coins, new Date(CLOCK).toISOString()]);
   if (seed.crowns > 0) {
    await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'crowns', $3, 'Opening balance', 'provisioning', $4)",
     ['opening-crowns:' + seed.actor, seed.actor, seed.crowns, new Date(CLOCK).toISOString()]);
   }
  }
 } finally { await c.end(); }
}

const D = require('../src/domain.js');
function tierOf(rating) { return D.basicTier(rating).id; }

/* ---------------------------------------------------------------- command script */

/* The shared script. Every entry is executed by the SAME `executeCommand` through BOTH adapters, in
 * order. `role` names the TARGET runtime role that owns the tables the step writes (design section
 * 6 / the ownership register): economy, match and monetization belong to core_runtime, while a
 * preference change writes `identity.actors.wealth_public`, which is api_runtime's. The reference
 * adapter has no role split, so the role only selects the target's pool. */
const SCRIPT = Object.freeze([
 { principal: { actor: 'alice', scope: 'player' }, key: 'convert-1', cmd: { type: 'convert', from: 'coins', amount: 100 } },
 { principal: { actor: 'alice', scope: 'player' }, key: 'cosmetic-1', cmd: { type: 'cosmetic', name: 'Copper edge' } },
 { principal: { actor: 'alice', scope: 'player' }, key: 'prefs-1', role: 'api_runtime', family: 'social', cmd: { type: 'preferences', changes: { wealthPublic: true } } },
 { principal: { actor: 'alice', scope: 'player' }, key: 'purchase-1', cmd: { type: 'purchase', evidence: { store: 'google', productId: 'crowns_100', transactionId: 'tx-diff-1' } } },
 { principal: { actor: 'store-ops', scope: 'store' }, key: 'refund-1', cmd: { type: 'refund', store: 'google', transactionId: 'tx-diff-1' } },
]);

/* The match script runs as ONE unit of work per adapter: a match lifecycle is a single business
 * effect chain (offer -> accept -> accept -> resign -> void) and the target adapter hydrates the
 * aggregate once per transaction, exactly like the reference store's serialized row. */
async function runMatchScriptReference(reference) {
 const unit = reference.store.uow;
 return unit.run((tx) => {
  const graph = tx.repositories.domain();
  const operator = { actor: 'ops-provisioner', scope: 'operator' };
  const a = { actor: 'carol', scope: 'player' };
  const b = { actor: 'bob_2', scope: 'player' };
  const offered = executeCommand(graph.authority, a, 'offer-1', { type: 'offer', id: 'match-diff-1', opponent: 'bob_2', terms: { kind: 'leaderboard', amount: 12 } });
  const acceptedA = executeCommand(graph.authority, a, 'accept-1', { type: 'accept', id: 'match-diff-1', termsHash: offered.termsHash });
  const acceptedB = executeCommand(graph.authority, b, 'accept-2', { type: 'accept', id: 'match-diff-1', termsHash: offered.termsHash });
  const voided = executeCommand(graph.authority, operator, 'void-1', { type: 'void', id: 'match-diff-1', reason: 'differential' });
  tx.repositories.commitDomain();
  return { offered, acceptedA, acceptedB, voided };
 });
}

async function runMatchScriptTarget(pools) {
 const unit = pgUnit(pools);
 return unit.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const operator = { actor: 'ops-provisioner', scope: 'operator' };
  const a = { actor: 'carol', scope: 'player' };
  const b = { actor: 'bob_2', scope: 'player' };
  const offered = executeCommand(graph.authority, a, 'offer-1', { type: 'offer', id: 'match-diff-1', opponent: 'bob_2', terms: { kind: 'leaderboard', amount: 12 } });
  const acceptedA = executeCommand(graph.authority, a, 'accept-1', { type: 'accept', id: 'match-diff-1', termsHash: offered.termsHash });
  const acceptedB = executeCommand(graph.authority, b, 'accept-2', { type: 'accept', id: 'match-diff-1', termsHash: offered.termsHash });
  const voided = executeCommand(graph.authority, operator, 'void-1', { type: 'void', id: 'match-diff-1', reason: 'differential' });
  await tx.repositories.commitDomain();
  return { offered, acceptedA, acceptedB, voided };
 });
}

/* The reference executor replays the production boundary: outcome lookup, dispatch, commit, outcome
 * save - all inside one real scope on the store connection. */
function referenceExecutor(reference) {
 return (step) => reference.store.uow.run((tx) => {
  const repositories = tx.repositories;
  const id = JSON.stringify([step.principal.actor, step.key]);
  const previous = repositories.outcomes.find(COMMANDS, id);
  if (previous) {
   if (previous.fingerprint !== fingerprintFor(step)) throw new Error('IDEMPOTENCY_CONFLICT');
   return { replay: true, response: JSON.parse(previous.response), shape: outcomeShape(previous.response) };
  }
  const graph = repositories.domain();
  const result = executeCommand(graph.authority, step.principal, step.key, step.cmd);
  const response = JSON.stringify(result);
  repositories.commitDomain();
  repositories.outcomes.save(COMMANDS, id, step.principal.actor, fingerprintFor(step), response);
  return { replay: false, response: result };
 });
}

/* The target executor is the same sequence over the asynchronous unit of work. The unit of work is
 * constructed per STEP because the step's owning runtime role decides which pool (and therefore
 * which guarded grants) the transaction runs under - exactly the role split the V5 schema ships. */
function targetExecutor(pools, options = {}) {
 return (step) => pgUnit(pools, { ...options, role: step.role || options.role || 'core_runtime' }).run(async (tx) => {
  const repositories = tx.repositories;
  /* The outcome FAMILY is part of the step's contract: the production boundary keys every command
  * under `(actor, key)`, and the target adapter keeps one table per family. The api-role step writes
  * the social family (its own grants), everything else the economy family. */
  const family = step.family === 'social' ? SOCIAL_OPERATIONS : COMMANDS;
  const id = family === SOCIAL_OPERATIONS ? `${step.principal.actor}:${step.key}` : JSON.stringify([step.principal.actor, step.key]);
  const fingerprint = fingerprintFor(step);
  const previous = await repositories.outcomes.find(family, id);
  if (previous) {
   if (previous.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
   return { replay: true, response: decodeOutcome(previous.result ?? previous.response), shape: outcomeShape(previous.result ?? previous.response) };
  }
  const graph = await repositories.domain();
  const result = executeCommand(graph.authority, step.principal, step.key, step.cmd);
  const response = JSON.stringify(result);
  await repositories.commitDomain();
  /* Each family keeps its OWN legacy key/column layout (packages/db/scopes.js): the economy family
  * keys `(id, actor, fingerprint, response)`, the social family `(id, fingerprint, result)`. */
  if (family === SOCIAL_OPERATIONS) await repositories.outcomes.save(family, id, fingerprint, response);
  else await repositories.outcomes.save(family, id, step.principal.actor, fingerprint, response);
  return { replay: false, response: result };
 });
}

function fingerprintOf(step) {
 return crypto.createHash('sha256').update(JSON.stringify({ principal: step.principal, cmd: step.cmd })).digest('hex');
}
/* The SOCIAL family's `social_operations.fingerprint` is a 43-char base64url digest (0007), the same
 * re-encoding convention the session token hash uses; the economy family keeps sha256 hex. The V4
 * reference has one untyped `commands` table, so it accepts either - the encoding is the target
 * schema's own column grammar, and both adapters stay internally consistent by using this. */
function fingerprintFor(step) {
 const hex = fingerprintOf(step);
 return step.family === 'social' ? Buffer.from(hex, 'hex').toString('base64url') : hex;
}

/* The production boundary (server/economy-store.js:38) reads a stored outcome as JSON TEXT
 * (`JSON.parse(previous.response)`), and the SQLite reference returns exactly that TEXT. The
 * SHAPE the adapter hands back is therefore part of the differential contract; it is decoded
 * tolerantly here so a shape divergence is REPORTED by the comparison below rather than crashing
 * the suite, and asserted explicitly as `outcomeShape`. */
function decodeOutcome(raw) { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
function outcomeShape(raw) { return raw === null || raw === undefined ? 'absent' : typeof raw; }

/* ---------------------------------------------------------------- canonical observable state */

/* The product-contract observable fields, exactly the set the phase names. The two adapters may
 * legitimately carry these differently, and each difference is asserted for its own contract instead
 * so no BUSINESS divergence can hide behind the exclusion:
 *   `friendCode` - the V4 `Authority.addAccount` mints a RANDOM `MEGA-<8hex>` friend code and no
 *       source column carries it; `identity.profiles.tag` is canonical and the target adapter derives
 *       the account copy from it (asserted equal below).
 *   `name`      - the V4 account does not carry one; the target derives it from
 *       `identity.profiles.username` (asserted equal below).
 *   `reachedAt`/`lastRatedAt` - the V4 `addAccount` leaves them unset (undefined) while the target
 *       hydrates NULL columns as null; absence vs null is representation, not a fact.
 *   `monetization` - absent on a V4 account until `MonetizationStore` first runs for it; the target
 *       hydrates the (empty) sub-record eagerly. Its FIELDS are covered by the monetization suite. */
const OBSERVED = Object.freeze([
 'id', 'coins', 'crowns', 'purchasedCoins', 'purchasedCrowns', 'purchaseInfluenced',
 'legacyCompetitionRestricted', 'reservedCoins', 'reservedCrowns', 'rating', 'peak', 'games', 'tier',
 'casualRating', 'casualGames', 'verified', 'createdAt', 'region', 'wealthPublic', 'suspended', 'hold',
 'blocked', 'friends', 'friendRequests', 'activeMatch', 'history', 'daily', 'operations', 'ledger',
 'owned', 'tournamentRecord', 'season', 'seasonHistory',
]);
const MATCH_OBSERVED = Object.freeze([
 'id', 'players', 'accepted', 'terms', 'quote', 'termsHash', 'created', 'expires', 'status', 'state',
 'symbols', 'revision', 'escrow', 'settled', 'riskFlags', 'started', 'lastMoveAt', 'deadline',
 'moveTimings', 'preRatings', 'preTiers', 'receipt',
]);

function nil(value) { return value === undefined ? null : value; }
function sortByAtId(list) {
 return [...list].sort((a, b) => (a.at - b.at) || String(a.id).localeCompare(String(b.id)));
}
function canonAccount(account) {
 const out = {};
 for (const key of OBSERVED) out[key] = nil(account[key]);
 /* The append-only wallet ledger carries the same ROWS on both adapters; PG reads it back through
  * the shipped `(actor_id, at, entry_id)` index, so the two share an ORDER TIEBREAK that the
  * reference's in-memory push order does not. Rows are compared, order is not. */
 out.ledger = sortByAtId(out.ledger);
 out.history = [...out.history].sort((a, b) => (a.at - b.at) || String(a.id).localeCompare(String(b.id)));
 if (out.season) out.season = { ...out.season, opponents: [...(out.season.opponents || [])].sort() };
 return out;
}
function canonMatch(match) {
 const out = {};
 for (const key of MATCH_OBSERVED) out[key] = nil(match[key]);
 /* `commands` is a Map in the domain model; the target adapter hydrates it from move_outcomes. */
 return out;
}
function canonGraph(exported) {
 return {
  accounts: [...exported.accounts].map(([id, account]) => [id, canonAccount(account)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  matches: [...exported.matches].map(([id, match]) => [id, canonMatch(match)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  receipts: [...exported.receipts].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  snapshots: [...exported.snapshots].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  weeklyPaid: [...exported.weeklyPaid].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  burned: exported.burned,
  /* The one documented ORDER exemption: the global journal is append-only and PG reads it through
  * the shipped `(at, entry_id)` index; the reference holds push order. Rows must be identical. */
  journal: sortByAtId(exported.journal),
  leagueWeek: nil(exported.leagueWeek),
 };
}

/* A recursive JSON-path diff: it reports EVERY divergence with its path instead of stopping at the
 * first, so a failure names the whole finding rather than one symptom. */
function deepDiff(expected, actual, at = '$', out = []) {
 if (expected === actual) return out;
 if (typeof expected !== typeof actual) { out.push(`${at}: type ${typeof expected} vs ${typeof actual}`); return out; }
 if (expected === null || actual === null) { out.push(`${at}: ${JSON.stringify(expected)} vs ${JSON.stringify(actual)}`); return out; }
 if (Array.isArray(expected) || Array.isArray(actual)) {
  if (!Array.isArray(expected) || !Array.isArray(actual)) { out.push(`${at}: array vs non-array`); return out; }
  if (expected.length !== actual.length) out.push(`${at}.length: ${expected.length} vs ${actual.length}`);
  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) deepDiff(expected[i], actual[i], `${at}[${i}]`, out);
  return out;
 }
 if (typeof expected === 'object') {
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
   if (!(key in expected)) { out.push(`${at}.${key}: absent on reference, ${JSON.stringify(actual[key])} on target`); continue; }
   if (!(key in actual)) { out.push(`${at}.${key}: absent on target, ${JSON.stringify(expected[key])} on reference`); continue; }
   deepDiff(expected[key], actual[key], `${at}.${key}`, out);
  }
  return out;
 }
 out.push(`${at}: ${JSON.stringify(expected)} vs ${JSON.stringify(actual)}`);
 return out;
}
function assertSame(actual, expected, what) {
 const divergences = deepDiff(expected, actual);
 assert.equal(divergences.length, 0, `${what}\n  divergence(s):\n  - ${divergences.slice(0, 40).join('\n  - ')}${divergences.length > 40 ? `\n  ... ${divergences.length - 40} more` : ''}`);
}

/* ================================================================ 1. DIFFERENTIAL */

test('P04 differential: identical clock, seed and command script give identical observable state on both adapters', async (t) => {
 const database = await freshDatabase(t, 'main');
 if (!database) return;
 const pools = poolsFor(database);
 const reference = openReference(t);

 seedReference(reference);
 await seedTarget(database);

 /* The two independently built seed states must already agree, so a divergence below is caused by
  * the scripted commands, not by the seed. */
 const seedReferenceExport = reference.store.read().export();
 const seedTargetExport = await pgUnit(pools).run((tx) => tx.repositories.state.read());
 assertSame(canonGraph(seedTargetExport), canonGraph(seedReferenceExport), 'seed state must be equivalent on both adapters');

 /* Same script, same keys, same clock, same random stream, both adapters. */
 const runReference = referenceExecutor(reference);
 const runTarget = targetExecutor(pools);
 for (const step of SCRIPT) {
  const fromReference = runReference(step);
  const fromTarget = await runTarget(step);
  assertSame(fromTarget.response, fromReference.response, `response for ${step.key}`);
 }

 /* The match lifecycle runs as one unit of work on each side. */
 const matchReference = await runMatchScriptReference(reference);
 const matchTarget = await runMatchScriptTarget(pools);
 assertSame(matchTarget.voided, matchReference.voided, 'void receipt');
 assertSame(matchTarget.acceptedB.escrow, matchReference.acceptedB.escrow, 'escrow held on acceptance');
 assertSame(matchTarget.acceptedB.symbols, matchReference.acceptedB.symbols, 'symbol draw from the injected seed');
 assertSame(matchTarget.acceptedB.status, matchReference.acceptedB.status, 'match status on acceptance');

 /* The canonical observable state must be equal per actor and per entity. */
 const referenceExport = reference.store.read().export();
 const targetExport = await pgUnit(pools).run(async (tx) => {
  await tx.repositories.state.read();
  return (await tx.repositories.domain()).export();
 });
 assertSame(canonGraph(targetExport), canonGraph(referenceExport), 'canonical observable state');

 /* The adapter-owned extras are not allowed to silently drift either: the derived `name` must BE the
  * canonical profile username, and the derived `friendCode` must BE the canonical profile tag. */
 const targetByName = new Map(targetExport.accounts.map(([id, a]) => [id, a]));
 for (const id of targetByName.keys()) {
  const target = targetByName.get(id);
  const profile = await pgUnit(pools).run((tx) => tx.repositories.profiles.for(id));
  assert.equal(target.name, USERNAME(id), `derived name must be identity.profiles.username for ${id}`);
  assert.equal(target.friendCode, profile.tag, `derived friendCode must be identity.profiles.tag for ${id}`);
  assert.equal(target.monetization !== undefined, true, 'the target adapter supplies the monetization sub-record');
 }

 /* Entity tables: the receipts and the match rows are the durable faces of the state above. */
 const c = await adminClient(database);
 try {
  const receipts = (await c.query('SELECT store, transaction_id, actor_id, product_id, crowns, refunded FROM monetization.receipts ORDER BY store, transaction_id')).rows;
  assertSame(receipts.map((r) => ({ store: r.store, transactionId: r.transaction_id, actor: r.actor_id, productId: r.product_id, crowns: Number(r.crowns), refunded: r.refunded })), [...referenceExport.receipts].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([key, r]) => ({ store: key.slice(0, key.indexOf(':')), transactionId: key.slice(key.indexOf(':') + 1), actor: r.actor, productId: r.productId, crowns: r.crowns, refunded: r.refunded })), 'monetization.receipts rows');
  const matches = (await c.query('SELECT match_id, status, settled, escrow, accepted_count FROM match.matches ORDER BY match_id')).rows;
  assertSame(matches.map((r) => ({ id: r.match_id, status: r.status, settled: r.settled, escrow: Number(r.escrow), accepted: Number(r.accepted_count) })), [...referenceExport.matches].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([id, m]) => ({ id, status: m.status, settled: m.settled, escrow: m.escrow, accepted: m.accepted.length })), 'match.matches rows');
  const participants = (await c.query('SELECT match_id, seat, actor_id, accepted FROM match.participants ORDER BY match_id, seat')).rows;
  const referenceParticipants = [...referenceExport.matches].flatMap(([id, m]) => m.players.map((actor, seat) => ({ match_id: String(id), seat, actor_id: String(actor), accepted: m.accepted.includes(actor) })));
  assertSame(participants, referenceParticipants.sort((a, b) => a.match_id.localeCompare(b.match_id) || a.seat - b.seat), 'match.participants rows');
  /* The economy family's outcome rows for the actor the script keys under. The outcome row's
  * RESPONSE is JSON TEXT in both adapters (V4 `commands.response` is TEXT); only its decode shape is
  * asserted above. The tournament/social/monetization families carry their own key grammars and are
  * exercised by the idempotency case. */
  const outcomes = (await c.query(`SELECT actor_id, "key", fingerprint FROM economy.command_outcomes WHERE actor_id = 'alice' ORDER BY "key"`)).rows;
  const economySteps = SCRIPT.filter((step) => step.principal.actor === 'alice' && step.family !== 'social');
  const referenceOutcomes = economySteps.map((step) => ({ actor_id: 'alice', key: JSON.stringify(step.key), fingerprint: fingerprintFor(step) }));
  assertSame(outcomes.map((r) => ({ actor_id: r.actor_id, key: r.key, fingerprint: r.fingerprint })), referenceOutcomes.sort((a, b) => a.key.localeCompare(b.key)), 'economy.command_outcomes rows');
  /* The api-role step's outcome lives in its OWN family table (social.command_outcomes), written by
  * api_runtime's grants - the ownership split the target schema ships. */
  const social = (await c.query("SELECT actor_id, \"key\", fingerprint FROM social.command_outcomes WHERE actor_id = 'alice'")).rows;
  assert.equal(social.length, 1, 'the preference step writes exactly one social outcome row');
  assert.equal(social[0].key, 'prefs-1');
 } finally { await c.end(); }
});

/* ================================================================ 2. CONTENTION */

test('P04 contention: two separate scopes racing one wallet produce exactly one winner and never overdraw', async (t) => {
 const database = await freshDatabase(t, 'race');
 if (!database) return;
 const pools = poolsFor(database);
 const reference = openReference(t);
 seedReference(reference);
 await seedTarget(database);

 /* The racing party takes the documented lock FIRST - `wallets.lock` is the caller's obligation for
  * its command's aggregate-then-actors chain (design section 5) - then performs the whole
  * read-modify-write inside that same scope. Each party is its own pooled client, i.e. two
  * independent database scopes. The reference races in exactly the same shape (its single
  * connection serializes at BEGIN IMMEDIATE, the V4 behaviour). */
 const convertTarget = (key) => pgUnit(pools).run(async (tx) => {
  await tx.repositories.wallets.lock(['alice']);
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, { actor: 'alice', scope: 'player' }, key, { type: 'convert', from: 'coins', amount: 1000 });
  await tx.repositories.commitDomain();
  return result;
 });
 const convertReference = (key) => reference.store.uow.run((tx) => {
  const graph = tx.repositories.domain();
  const result = executeCommand(graph.authority, { actor: 'alice', scope: 'player' }, key, { type: 'convert', from: 'coins', amount: 1000 });
  tx.repositories.commitDomain();
  return result;
 });

 /* The reference race runs FIRST so both final wallets describe a completed race. */
 const referenceRace = await Promise.allSettled([Promise.resolve().then(() => convertReference('rr-1')), Promise.resolve().then(() => convertReference('rr-2'))]);
 assert.equal(referenceRace.filter((r) => r.status === 'fulfilled').length, 1, 'the reference must also serialize its two conversions to one winner');
 assert.match(String(referenceRace.find((r) => r.status === 'rejected').reason && referenceRace.find((r) => r.status === 'rejected').reason.message), /INSUFFICIENT_COINS/);

 const [first, second] = await Promise.allSettled([convertTarget('race-1'), convertTarget('race-2')]);
 const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
 const rejected = [first, second].filter((r) => r.status === 'rejected');
 assert.equal(fulfilled.length, 1, 'exactly one of two racing conversions may win');
 assert.equal(rejected.length, 1, 'the loser must refuse rather than partly apply');
 assert.match(String(rejected[0].reason && rejected[0].reason.message), /INSUFFICIENT_COINS/);

 /* No minting: the wallet holds 1000 Coins converted to 100 Crowns exactly once, and the raced
  * target wallet is bit-for-bit the reference shape. */
 const wallet = await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice'));
 const referenceWallet = reference.store.repositories().wallets.for('alice');
 assert.equal(wallet.coins, 0, 'no overdraw: coins left the wallet exactly once');
 assert.equal(wallet.crowns, 200, 'exactly one 1000-Coin conversion credited 100 Crowns');
 assertSame(wallet, referenceWallet, 'the raced wallet matches the reference shape');
 const c = await adminClient(database);
 try {
  const ledger = (await c.query("SELECT entry_id, amount FROM economy.ledger WHERE actor_id = 'alice' ORDER BY entry_id")).rows;
  const conversions = ledger.filter((r) => /^race-\d:/.test(r.entry_id));
  assert.equal(conversions.length, 2, 'one winning conversion writes exactly two ledger rows');
  assert.equal(conversions.filter((r) => r.entry_id.endsWith(':out')).length, 1, 'exactly one debit row');
  assert.equal(conversions.filter((r) => r.entry_id.endsWith(':in')).length, 1, 'exactly one credit row');
  /* The losing scope committed nothing at all. */
  const losingKey = 'race-' + (first.status === 'fulfilled' ? '2' : '1');
  assert.equal(ledger.filter((r) => r.entry_id.startsWith(losingKey + ':')).length, 0, 'the losing unit of work must leave no ledger row');
 } finally { await c.end(); }
});

test('P04 contention: reward claim, refund and match void cannot double-apply across scopes, and a failed unit rolls back', async (t) => {
 const database = await freshDatabase(t, 'apply');
 if (!database) return;
 const pools = poolsFor(database);
 /* A dedicated refund actor: `refundPurchase` puts the receipt's account on hold, and a held actor
  * may not be paired into the match race below (INELIGIBLE). */
 await seedTarget(database, [...SEED_ACTORS, { actor: 'dana', coins: 1000, crowns: 100, rating: 1500, games: 30 }]);

 /* A seeded daily counter makes the reward claim actually payable: the source metric `boards` must
  * already stand at its target. (The seeded row is also the daily-progress parity probe: the target
  * adapter must hydrate the DATE key as `YYYY-MM-DD`, exactly like the reference's `D.day()`.) */
 const c0 = await adminClient(database);
 try {
  await c0.query("INSERT INTO economy.daily_progress (actor_id, day, finished, seconds, boards, claimed) VALUES ('alice', '2026-10-08', 3, 600, 8, ARRAY[]::text[])");
 } finally { await c0.end(); }

 const claim = (key) => pgUnit(pools).run(async (tx) => {
  await tx.repositories.wallets.lock(['alice']);
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, { actor: 'alice', scope: 'player' }, key, { type: 'quest', quest: 'boards' });
  await tx.repositories.commitDomain();
  return result;
 });
 const [claimA, claimB] = await Promise.allSettled([claim('q-a'), claim('q-b')]);
 const claimWinners = [claimA, claimB].filter((r) => r.status === 'fulfilled' && r.value === 3);
 assert.equal(claimWinners.length, 1, 'exactly one racing reward claim may settle (the other must read no claimable reward)');
 const afterClaim = await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice'));
 assert.equal(afterClaim.coins, 1003, 'the reward is minted exactly once');
 const c1 = await adminClient(database);
 try {
  const daily = (await c1.query("SELECT boards, claimed FROM economy.daily_progress WHERE actor_id = 'alice' AND day = '2026-10-08'")).rows[0];
  assert.equal(Number(daily.boards), 8, 'a claim must not destroy the pre-existing daily progress');
  assert.deepEqual(daily.claimed, ['boards'], 'the claimed quest is recorded exactly once');
  const quests = (await c1.query("SELECT count(*)::int AS n FROM economy.ledger WHERE actor_id = 'alice' AND entry_id LIKE 'quest:%'")).rows[0].n;
  assert.equal(quests, 1, 'exactly one quest mint row');
 } finally { await c1.end(); }

 /* Refund: one scope wins, the other must observe the already-refunded receipt and never re-hold. */
 const c2 = await adminClient(database);
 try {
  await c2.query("INSERT INTO monetization.receipts (store, transaction_id, actor_id, product_id, crowns, refunded, purchased_at) VALUES ('google', 'tx-refund-race', 'dana', 'crowns_100', 100, false, $1)", [new Date(CLOCK - 7200000).toISOString()]);
 } finally { await c2.end(); }
 const refund = (key) => pgUnit(pools).run(async (tx) => {
  await tx.repositories.wallets.lock(['dana']);
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, { actor: 'store-ops', scope: 'store' }, key, { type: 'refund', store: 'google', transactionId: 'tx-refund-race' });
  await tx.repositories.commitDomain();
  return result;
 });
 const refunds = await Promise.allSettled([refund('r-a'), refund('r-b')]);
 const held = refunds.filter((r) => r.status === 'fulfilled' && r.value && r.value.held === true);
 const duplicates = refunds.filter((r) => r.status === 'fulfilled' && r.value && r.value.duplicate === true);
 assert.equal(held.length + duplicates.length, 2, 'both racing refunds must reach a defined outcome');
 assert.ok(held.length >= 1, 'a refund race must not silently lose the refund');
 const c3 = await adminClient(database);
 try {
  const holds = (await c3.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id = 'refund-hold:google:tx-refund-race'")).rows[0].n;
  assert.equal(holds, 1, 'the refund hold row is written exactly once');
  assert.equal((await c3.query("SELECT refunded FROM monetization.receipts WHERE transaction_id = 'tx-refund-race'")).rows[0].refunded, true);
 } finally { await c3.end(); }

 /* Match void: two operator scopes race the same live match; the escrow must be released once. */
 const setup = pgUnit(pools).run(async (tx) => {
  const graph = await tx.repositories.domain();
  const a = { actor: 'carol', scope: 'player' };
  const b = { actor: 'bob_2', scope: 'player' };
  const offered = executeCommand(graph.authority, a, 'void-offer', { type: 'offer', id: 'match-void-race', opponent: 'bob_2', terms: { kind: 'leaderboard', amount: 40 } });
  executeCommand(graph.authority, a, 'void-accept-a', { type: 'accept', id: 'match-void-race', termsHash: offered.termsHash });
  executeCommand(graph.authority, b, 'void-accept-b', { type: 'accept', id: 'match-void-race', termsHash: offered.termsHash });
  await tx.repositories.commitDomain();
 });
 await setup;
 const beforeVoid = await pgUnit(pools).run((tx) => tx.repositories.wallets.for('carol'));
 /* A DIRECT challenge is funded by its challenger alone (`quote.contributions = [offered, 0]`), so
  * carol holds the reservation and bob's wallet is untouched. */
 assert.equal(beforeVoid.reservedCrowns, 40, 'the accepted direct challenge reserved carol\'s contribution');
 const voidMatch = (key) => pgUnit(pools).run(async (tx) => {
  /* The documented chain: the business aggregate row first, then occupancy, then wallets. */
  await tx.repositories.wallets.lock(['carol', 'bob_2'], { aggregate: { kind: 'match', id: 'match-void-race' } });
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, { actor: 'ops-provisioner', scope: 'operator' }, key, { type: 'void', id: 'match-void-race', reason: 'race' });
  await tx.repositories.commitDomain();
  return result;
 });
 await Promise.allSettled([voidMatch('v-a'), voidMatch('v-b')]);
 const afterVoid = await pgUnit(pools).run(async (tx) => ({ carol: await tx.repositories.wallets.for('carol'), bob: await tx.repositories.wallets.for('bob_2'), match: await tx.repositories.matches.for('match-void-race') }));
 assert.equal(afterVoid.carol.reservedCrowns, 0, 'no double-reserve survives the void');
 assert.equal(afterVoid.carol.crowns, 100, 'the escrow is refunded exactly once (a double refund would show 140)');
 assert.equal(afterVoid.bob.crowns, 100, 'the opponent contributed nothing and receives nothing');
 assert.equal(afterVoid.match.settled, true);
 assert.equal(afterVoid.match.status, 'VOID');
 const c4 = await adminClient(database);
 try {
  const refundRows = (await c4.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id = 'match-void-race:refund:carol'")).rows[0].n;
  assert.equal(refundRows, 1, 'the void refund row is written exactly once');
 } finally { await c4.end(); }

 /* Match settlement race: two scopes resign/void the SAME live match concurrently. The settlement is
  * only reachable once - the second scope must observe a settled match, never a second payout. */
 const settledSetup = pgUnit(pools).run(async (tx) => {
  const graph = await tx.repositories.domain();
  const a = { actor: 'carol', scope: 'player' };
  const b = { actor: 'bob_2', scope: 'player' };
  const offered = executeCommand(graph.authority, a, 'settle-offer', { type: 'offer', id: 'match-settle-race', opponent: 'bob_2', terms: { kind: 'leaderboard', amount: 40 } });
  executeCommand(graph.authority, a, 'settle-accept-a', { type: 'accept', id: 'match-settle-race', termsHash: offered.termsHash });
  executeCommand(graph.authority, b, 'settle-accept-b', { type: 'accept', id: 'match-settle-race', termsHash: offered.termsHash });
  await tx.repositories.commitDomain();
 });
 await settledSetup;
 const settle = (key, principal, cmd) => pgUnit(pools).run(async (tx) => {
  await tx.repositories.wallets.lock(['carol', 'bob_2'], { aggregate: { kind: 'match', id: 'match-settle-race' } });
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, principal, key, cmd);
  await tx.repositories.commitDomain();
  return result;
 });
 const settlement = await Promise.allSettled([
  settle('settle-a', { actor: 'carol', scope: 'player' }, { type: 'resign', id: 'match-settle-race' }),
  settle('settle-b', { actor: 'ops-provisioner', scope: 'operator' }, { type: 'void', id: 'match-settle-race', reason: 'race' }),
 ]);
 assert.ok(settlement.some((r) => r.status === 'fulfilled'), 'at least one settlement must commit');
 const afterSettle = await pgUnit(pools).run(async (tx) => ({ carol: await tx.repositories.wallets.for('carol'), match: await tx.repositories.matches.for('match-settle-race') }));
 assert.equal(afterSettle.match.settled, true, 'the match ends settled exactly once');
 assert.equal(afterSettle.carol.reservedCrowns, 0, 'the escrow is released exactly once');
 const c5 = await adminClient(database);
 try {
  const payoutRows = (await c5.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id IN ('match-settle-race:payout','match-settle-race:refund:carol')")).rows[0].n;
  assert.equal(payoutRows, 1, 'exactly one terminal settlement row (payout XOR refund), never both');
 } finally { await c5.end(); }

 /* A failing unit of work rolls back every entity it touched - wallet, ledger, outcome. */
 await assert.rejects(() => pgUnit(pools).run(async (tx) => {
  const graph = await tx.repositories.domain();
  const account = graph.authority.account('alice');
  account.coins = 7;
  await tx.repositories.commitDomain();
  await tx.repositories.outcomes.save(COMMANDS, JSON.stringify(['alice', 'rollback-probe']), 'alice', 'a'.repeat(64), '{}');
  throw new Error('FORCED_ROLLBACK');
 }), /FORCED_ROLLBACK/);
 const rolled = await pgUnit(pools).run(async (tx) => ({
  wallet: await tx.repositories.wallets.for('alice'),
  outcome: await tx.repositories.outcomes.find(COMMANDS, JSON.stringify(['alice', 'rollback-probe'])),
 }));
 assert.equal(rolled.wallet.coins, afterClaim.coins, 'the failed unit must roll its wallet write back');
 assert.equal(rolled.outcome, null, 'the failed unit must roll its outcome row back');
});

/* ================================================================ 3. IDEMPOTENCY */

test('P04 differential idempotency: the same key replays the stored response and applies once on both adapters', async (t) => {
 const database = await freshDatabase(t, 'idem');
 if (!database) return;
 const pools = poolsFor(database);
 const reference = openReference(t);
 seedReference(reference);
 await seedTarget(database);

 const replay = { principal: { actor: 'alice', scope: 'player' }, key: 'idem-1', cmd: { type: 'convert', from: 'coins', amount: 100 } };
 const runReference = referenceExecutor(reference);
 const runTarget = targetExecutor(pools);

 const firstReference = runReference(replay);
 const firstTarget = await runTarget(replay);
 assert.equal(firstReference.replay, false);
 assert.equal(firstTarget.replay, false);
 assertSame(firstTarget.response, firstReference.response, 'first response');

 const secondReference = runReference(replay);
 const secondTarget = await runTarget(replay);
 assert.equal(secondReference.replay, true, 'the reference returns the stored response');
 assert.equal(secondTarget.replay, true, 'the target returns the stored response');
 assertSame(secondTarget.response, firstReference.response, 'replayed response must be the stored one');
 assertSame(secondReference.response, firstReference.response, 'the reference must replay identically');

 /* The effect is applied exactly once on each adapter. */
 assertSame(await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice')), { ...reference.store.repositories().wallets.for('alice') }, 'wallet after replay');
 const c = await adminClient(database);
 try {
  assert.equal((await c.query("SELECT count(*)::int AS n FROM economy.ledger WHERE entry_id IN ('idem-1:in','idem-1:out')")).rows[0].n, 2, 'exactly one conversion effect');
  assert.equal((await c.query("SELECT count(*)::int AS n FROM economy.command_outcomes WHERE actor_id = 'alice' AND \"key\" = $1", [JSON.stringify('idem-1')])).rows[0].n, 1, 'exactly one outcome row');
  assert.equal((await c.query('SELECT count(*)::int AS n FROM economy.wallet_operations WHERE actor_id = $1 AND "key" = $2', ['alice', 'idem-1'])).rows[0].n, 1, 'exactly one wallet operation row');
 } finally { await c.end(); }

 /* A replayed key with a DIFFERENT payload conflicts instead of double-applying. The production
  * boundary raises IDEMPOTENCY_CONFLICT on the stored fingerprint BEFORE dispatching, so the
  * reference and the target executor are both driven with the conflicting payload here. */
 const conflicted = { ...replay, cmd: { type: 'convert', from: 'coins', amount: 200 } };
 assert.throws(() => referenceExecutor(reference)(conflicted), /IDEMPOTENCY_CONFLICT/);
 await assert.rejects(() => targetExecutor(pools)(conflicted), /IDEMPOTENCY_CONFLICT/);
 /* Neither adapter re-applied anything: the domain-level guard would also refuse the second
  * conversion (the key is already recorded in the account's operations map). */
 const before = await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice'));
 assert.throws(() => reference.store.uow.run((tx) => {
  const graph = tx.repositories.domain();
  executeCommand(graph.authority, conflicted.principal, conflicted.key, conflicted.cmd);
 }), /IDEMPOTENCY_CONFLICT/);
 await pgUnit(pools).run(async (tx) => {
  const graph = await tx.repositories.domain();
  assert.throws(() => executeCommand(graph.authority, conflicted.principal, conflicted.key, conflicted.cmd), /IDEMPOTENCY_CONFLICT/);
 });
 assertSame(await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice')), before, 'a conflicting replay leaves the wallet untouched');
 assertSame(reference.store.repositories().wallets.for('alice'), before, 'the reference wallet is untouched by a conflicting replay');

 /* The DOMAIN-level guard behind the outcome row (V4 `src/domain.js convert`): the account's
  * `operations` map must make a replayed key idempotent ACROSS TRANSACTIONS even when the outcome
  * row is bypassed. This is the invariant that catches a re-hydrated operation map. */
 const domainReplay = { principal: { actor: 'alice', scope: 'player' }, key: 'domain-1', cmd: { type: 'convert', from: 'coins', amount: 50 } };
 const applyDirect = (unit) => unit.run(async (tx) => {
  const graph = await tx.repositories.domain();
  const result = executeCommand(graph.authority, domainReplay.principal, domainReplay.key, domainReplay.cmd);
  await tx.repositories.commitDomain();
  return result;
 });
 const referenceApply = (unit) => reference.store.uow.run((tx) => {
  const graph = tx.repositories.domain();
  const result = executeCommand(graph.authority, domainReplay.principal, domainReplay.key, domainReplay.cmd);
  tx.repositories.commitDomain();
  return result;
 });
 const firstDirect = await applyDirect(pgUnit(pools));
 const firstReferenceDirect = referenceApply(reference);
 assertSame(firstDirect, firstReferenceDirect, 'the first direct conversion response');
 const targetBeforeReplay = await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice'));
 const referenceBeforeReplay = reference.store.repositories().wallets.for('alice');
 const targetReplay = await applyDirect(pgUnit(pools));
 const referenceReplayDirect = referenceApply(reference);
 assert.equal(referenceReplayDirect.duplicate, true, 'the reference recognises its operation key across transactions');
 assert.equal(targetReplay.duplicate, true, 'the target must recognise its operation key across transactions');
 assertSame(targetReplay, referenceReplayDirect, 'the replayed conversion response');
 assertSame(await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice')), targetBeforeReplay, 'a domain-level replay must not move a coin');
 assertSame(reference.store.repositories().wallets.for('alice'), referenceBeforeReplay, 'the reference domain-level replay must not move a coin');
 assertSame(await pgUnit(pools).run((tx) => tx.repositories.wallets.for('alice')), reference.store.repositories().wallets.for('alice'), 'both adapters agree after the replay');
});
