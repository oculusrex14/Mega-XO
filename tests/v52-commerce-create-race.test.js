'use strict';

/* SEC-V52-CASHFREE-IDEMPOTENCY-RACE (Decision 2): barrier-controlled same-key concurrency
 * across TWO commerce instances sharing REAL PostgreSQL - exactly one provider create and one
 * reservation; a loser gets CHECKOUT_CREATE_PENDING and never reaches the provider; a crash
 * after reservation never triggers an automatic re-create; an explicit provider rejection
 * becomes terminal FAILED with its sanitized code on replay; a reservation alone changes no
 * balance, entitlement or ledger. Skips (never fails) without a PostgreSQL 16 backend. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'v5', 'migrate.js');
const MANIFEST = require(path.join(ROOT, 'packages', 'migrations', 'manifest.json'));
const CHAIN_LENGTH = MANIFEST.migrations.length;
const CLOCK = Date.parse('2026-10-16T12:00:00Z');
const CATALOG = Object.freeze({ crowns_100: '89.00', remove_ads: '199.00' });
const { createCommerceService } = require('../packages/services/commerce.js');
const { createPgPool } = require('../packages/db/pg/pool.js');

function whichBinary() {
  for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
    try {
      if (fs.existsSync(path.join(dir, 'initdb')) && execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
    } catch { /* next prefix */ }
  }
  return null;
}
const OWNED_PREFIX = 'v5_test_v52race_';
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
let backend = null, backendError = null;
function stopBackendOnce() { if (backend) { const b = backend; backend = null; b.stop(); } }
process.on('exit', stopBackendOnce);
process.on('SIGINT', () => { stopBackendOnce(); process.exit(130); });
process.on('SIGTERM', () => { stopBackendOnce(); process.exit(143); });
const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';
function dbUrl(database) { return 'postgres://postgres@127.0.0.1:' + backend.port + '/' + database; }
async function adminClient(database) {
  const pg = require('pg');
  const c = new pg.Client({ host: '127.0.0.1', port: backend.port, user: 'postgres', database: database || 'postgres' });
  await c.connect();
  return c;
}
function runMigrator(database) {
  const r = spawnSync(process.execPath, [RUNNER, '--execute', '--json', '--database-url', dbUrl(database)], {
    encoding: 'utf8', cwd: ROOT, timeout: 300000,
    env: { ...process.env, V5_MIGRATE_ALLOW_INSECURE_LOOPBACK: '1', V5_TARGET: 'test', MIGRATE_CONFIRM: database },
  });
  const last = (r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  let json = null; try { json = last ? JSON.parse(last) : null; } catch { /* human mode */ }
  return { status: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}
async function ensureBackend() {
  if (backend) return backend;
  if (backendError) throw new Error(backendError);
  const bin = whichBinary();
  if (!bin) { backendError = 'no PostgreSQL 16 backend available'; throw new Error(backendError); }
  const net = require('node:net');
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v52-race-pg-'));
  execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth-local=trust', '--auth-host=trust', '-U', 'postgres', '-E', 'UTF8'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-o', '-p ' + port + ' -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off', '-l', path.join(dataDir, 'server.log'), 'start'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
  for (let i = 0; i < 60; i += 1) {
    try { execFileSync(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-q'], { stdio: 'ignore', timeout: 10000 }); break; }
    catch { if (i === 59) throw new Error('binary PG16 never became ready'); execFileSync('sleep', ['1']); }
  }
  backend = { port, stop: () => {
    try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'i', 'stop'], { stdio: 'ignore', timeout: 30000 }); } catch { /* gone */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  } };
  return backend;
}
async function createDatabase() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (OWNED_PREFIX + process.pid + '_' + suffix).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const c = await adminClient();
  try { await c.query('CREATE DATABASE ' + ident(name)); } finally { await c.end(); }
  const migration = runMigrator(name);
  assert.equal(migration.status, 0, 'migration failed: ' + migration.stdout + migration.stderr);
  assert.equal(migration.json.code, 'OK');
  assert.equal(migration.json.appliedCount, CHAIN_LENGTH, 'the real checksummed chain must apply in full');
  const c2 = await adminClient(name);
  try { for (const role of RUNTIME_ROLES) await c2.query('ALTER ROLE ' + ident(role) + ' LOGIN'); } finally { await c2.end(); }
  return name;
}
async function seedActor(database, actor) {
  const c = await adminClient(database);
  try {
    await c.query('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1, $2, false, $3)', [actor, JSON.stringify('Test'), new Date(CLOCK).toISOString()]);
    await c.query('INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1, true, false, false)', [actor]);
    await c.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1, $2, $3, $4, $5, $6)', [actor, 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 10).toUpperCase(), 'player_' + actor.replace(/^cf_/, ''), actor, new Date(CLOCK).toISOString(), 'friends']);
    await c.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)', [actor, 1000, 0]);
    await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'coins', $3, 'Opening balance', 'provisioning', $4)", ['opening:' + actor, actor, 1000, new Date(CLOCK).toISOString()]);
  } finally { await c.end(); }
}
async function counts(database) {
  const c = await adminClient(database);
  try {
    const q = async (sql) => Number((await c.query(sql)).rows[0].n);
    return {
      orders: await q('SELECT count(*)::int AS n FROM monetization.cashfree_orders'),
      reservations: await q('SELECT count(*)::int AS n FROM monetization.commerce_create_requests'),
      outcomes: await q('SELECT count(*)::int AS n FROM monetization.command_outcomes'),
      crowns: Number((await c.query("SELECT crowns FROM economy.wallets WHERE actor_id = 'cf_alice'")).rows[0].crowns),
    };
  } finally { await c.end(); }
}
/* Barrier provider: every createOrder parks on a gate the test controls. */
function deferredProvider() {
  const gates = [];
  let calls = 0;
  return {
    gates,
    newOrderId: () => 'cfmx' + crypto.randomBytes(12).toString('hex'),
    isOrderId: (v) => typeof v === 'string' && /^cfmx[a-f0-9]{24}$/.test(v),
    createOrder: (input) => { calls += 1; return new Promise((resolve, reject) => gates.push({ input, resolve, reject })); },
    /* Echo the RESERVED input orderId: the ledger insert uses the provider response's order id,


     * which must match the reservation's, so a fixed test payload cannot collide. */


    releaseAll: (payload) => { while (gates.length) { const g = gates.shift(); g.resolve(payload && payload.orderId ? payload : { orderId: g.input.orderId, paymentSessionId: 'sess_' + g.input.orderId.slice(-8) }); } },
    failAll: (code) => { while (gates.length) gates.shift().reject(Error(code)); },
    callCount: () => calls,
  };
}
const BUDGET = Object.freeze({ totalConnections: 12, roleConnections: Object.freeze({ core_runtime: 6, api_runtime: 4, worker_runtime: 2 }) });
const makePool = (database, label) => createPgPool({ host: '127.0.0.1', port: backend.port, database, user: 'core_runtime', role: 'core_runtime', label, service: 'v52race-test', revision: 'decision2', allowLocalNoTls: true, pool: { max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 }, budget: BUDGET });
const makeService = async (t, database, provider, label) => {
  const pool = makePool(database, label);
  const commerce = await createCommerceService(pool, {
    now: () => CLOCK,
    eligible: (account) => account && account.verified === true && account.suspended !== true && account.hold !== true,
    purchasesEnabled: true,
    cashfreeProvider: provider,
    cashfreeCatalog: CATALOG,
    cashfreeReturnUrl: 'https://megaxo.online',
    cashfreeNotifyUrl: 'https://megaxo.online/api/monetization/cashfree/webhook',
  });
  t.after(async () => { commerce.close(); await pool.end(); });
  return commerce;
};
async function raceHarness(t) {
  try { await ensureBackend(); } catch (err) {
    /* The frozen disposable-backend contract: no installed PG16 binary and no V5_PG_URL means
     * the real-PG journeys SKIP with the explicit reason - they never fail a runner without a db. */
    t.skip(err.message);
    return null;
  }
  const database = await createDatabase();
  await seedActor(database, 'cf_alice');
  const provider = deferredProvider();
  const a = await makeService(t, database, provider, 'test');
  const b = await makeService(t, database, provider, 'test');
  return { database, provider, a, b, t };
}
const CUSTOMER = { email: 'a@b.co', phone: '9876543210' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('race: two instances, one key - exactly one provider create, one reservation, one ledger row', async (t) => {
  const h = await raceHarness(t);
  if (!h) return;
  const p1 = h.a.createCashfreeOrder('cf_alice', 'race-key-1', 'crowns_100', CUSTOMER).catch((e) => e);
  const p2 = h.b.createCashfreeOrder('cf_alice', 'race-key-1', 'crowns_100', CUSTOMER).catch((e) => e);
  await wait(400);
  assert.equal(h.provider.callCount(), 1, 'only ONE instance may reach the provider while the fence holds');
  h.provider.releaseAll({ orderId: 'cfmx' + 'a'.repeat(24), paymentSessionId: 'sess_race1' });
  const [r1, r2] = await Promise.all([p1, p2]);
  const ok = [r1, r2].filter((r) => r && r.orderId);
  const pending = [r1, r2].filter((r) => r instanceof Error && r.message === 'CHECKOUT_CREATE_PENDING');
  assert.equal(ok.length, 1, 'exactly one caller gets the created order');
  assert.equal(pending.length, 1, 'the loser is told a create is pending, never an error that invites a retry with a new key');
  const c = await counts(h.database);
  assert.equal(c.orders, 1, 'exactly one ledger row');
  assert.equal(c.reservations, 1, 'exactly one reservation row');
  assert.equal(c.outcomes, 1, 'exactly one durable outcome');
  assert.equal(c.crowns, 0, 'a reservation alone changes no balance');
  const replay = await h.a.createCashfreeOrder('cf_alice', 'race-key-1', 'crowns_100', CUSTOMER);
  assert.equal(replay.orderId, ok[0].orderId, 'a settled replay returns the recorded order without another create');
  assert.equal(h.provider.callCount(), 1, 'no second provider call on replay');
});

test('race: a conflicting product on the same key refuses before any provider I/O', async (t) => {
  const h = await raceHarness(t);
  if (!h) return;
  const p1 = h.a.createCashfreeOrder('cf_alice', 'race-key-2', 'crowns_100', CUSTOMER).catch((e) => e);
  await wait(300);
  h.provider.releaseAll({ orderId: 'cfmx' + 'e'.repeat(24), paymentSessionId: 'sess_race2' });
  const first = await p1;
  assert.ok(first && first.orderId, 'the first create completes');
  const callsBefore = h.provider.callCount();
  await assert.rejects(() => h.b.createCashfreeOrder('cf_alice', 'race-key-2', 'remove_ads', CUSTOMER), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(() => h.a.createCashfreeOrder('cf_alice', 'race-key-2', 'remove_ads', CUSTOMER), /IDEMPOTENCY_CONFLICT/);
  assert.equal(h.provider.callCount(), callsBefore, 'a conflicting command never reaches the provider');
});

test('race: a crash after reservation never re-creates - the parked key returns CHECKOUT_CREATE_PENDING', async (t) => {
  const h = await raceHarness(t);
  if (!h) return;
  // Instance A reserves, then "dies": its service is closed without resolving the provider gate.
  const inFlight = h.a.createCashfreeOrder('cf_alice', 'race-key-3', 'crowns_100', CUSTOMER).catch((e) => e);
  await wait(300);
  assert.equal(h.provider.callCount(), 1, 'the winner reached the provider');
  await h.a.close();
  // Instance B sees the reservation PENDING: it must NOT re-create with the same key.
  await assert.rejects(() => h.b.createCashfreeOrder('cf_alice', 'race-key-3', 'crowns_100', CUSTOMER), (e) => e.message === 'CHECKOUT_CREATE_PENDING' && e.status === 503);
  assert.equal(h.provider.callCount(), 1, 'still exactly one provider call - the orphan is recovered by a provider read, never re-created');
  // The parked winner's promise dies with its pool (close()); the DURABLE contract is what
  // matters: the reservation stays PENDING with the reserved order id, and the recovery read -
  // never a re-create - is the only path forward. No ledger row, no outcome, no balance change.
  assert.equal(h.provider.callCount(), 1, 'still exactly one provider call');
  const c = await counts(h.database);
  assert.equal(c.orders, 0, 'no ledger row for the abandoned create');
  assert.equal(c.reservations, 1, 'the reservation is permanent evidence');
  assert.equal(c.outcomes, 0, 'no outcome was claimed');
  assert.equal(c.crowns, 0, 'no balance changed');
});

test('race: an explicit provider rejection is terminal FAILED; replay returns the sanitized failure', async (t) => {
  const h = await raceHarness(t);
  if (!h) return;
  const p1 = h.a.createCashfreeOrder('cf_alice', 'race-key-4', 'crowns_100', CUSTOMER).catch((e) => e);
  await wait(300);
  h.provider.failAll('CASHFREE_AUTH');
  const r1 = await p1;
  assert.ok(r1 instanceof Error, 'the auth rejection surfaces');
  const c1 = await counts(h.database);
  assert.equal(c1.orders, 0, 'a rejected create records no ledger row');
  const c = await adminClient(h.database);
  let state = null, errCode = null;
  try {
    const row = (await c.query("SELECT state, error_code FROM monetization.commerce_create_requests WHERE op_key = 'race-key-4'")).rows[0];
    state = row.state; errCode = row.error_code;
  } finally { await c.end(); }
  assert.equal(state, 'FAILED', 'an explicit rejection is terminal FAILED');
  assert.equal(errCode, 'CASHFREE_AUTH', 'the sanitized failure is recorded');
  await assert.rejects(() => h.b.createCashfreeOrder('cf_alice', 'race-key-4', 'crowns_100', CUSTOMER), (e) => e.message === 'CASHFREE_AUTH' && e.status === 502, 'a replay returns the stored sanitized failure without another provider call');
  assert.equal(h.provider.callCount(), 1, 'no second provider call on a FAILED replay');
});

test('race: a second actor on the same key is fully independent', async (t) => {
  const h = await raceHarness(t);
  if (!h) return;
  await seedActor(h.database, 'cf_bob');
  const p1 = h.a.createCashfreeOrder('cf_alice', 'race-key-5', 'crowns_100', CUSTOMER).catch((e) => e);
  const p2 = h.b.createCashfreeOrder('cf_bob', 'race-key-5', 'crowns_100', CUSTOMER).catch((e) => e);
  await wait(300);
  /* Echo release: each parked gate resolves with its OWN reserved order id - a fixed payload
   * would hand both flows the same order id and trip the ledger PK by construction. */
  h.provider.releaseAll();
  h.provider.releaseAll();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.ok(!(r1 instanceof Error), 'a: ' + (r1 && r1.message || ''));
  assert.ok(!(r2 instanceof Error), 'b: ' + (r2 && r2.message || ''));
  assert.equal(h.provider.callCount(), 2, 'independent actors each reach the provider');
  assert.ok(r1.orderId && r2.orderId && r1.orderId !== r2.orderId);
  const c = await counts(h.database);
  assert.equal(c.orders, 2);
  assert.equal(c.reservations, 2);
});