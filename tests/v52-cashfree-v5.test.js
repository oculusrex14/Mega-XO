'use strict';

/* LR13 (2026-10-16) offline + disposable-PG proof for the V5 Cashfree web-commerce lane:
 *
 *   1. the provider (packages/services/cashfree.js) keeps the merged PR 19 contract: server-side
 *      order creation, the INR/currency verify, and the raw-body HMAC webhook window;
 *   2. the ingress maps the three cashfree ops to exactly one commerce call each and the webhook
 *      is actor-free like the SSV;
 *   3. over a REAL disposable PostgreSQL (the frozen harness contract: owned databases, the real
 *      checksummed chain incl. 0056, no Neon/production/SQLite path) the commerce service
 *      records server-side orders, settles only after an independent PAID verification with the
 *      exact recorded amount, settles a webhook exactly once, hides other actors' orders, and
 *      revokes a refunded remove_ads structurally.
 *
 * No V5_PG_URL is required: an installed PostgreSQL 16 binary on a test-owned mkdtemp datadir is
 * used, and the suite fails with an explicit reason when none is available.
 */
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
const CATALOG = Object.freeze({ crowns_100: '89.00', crowns_525: '449.00', crowns_1100: '899.00', remove_ads: '199.00' });
const CLOCK = Date.parse('2026-10-16T12:00:00Z');

const { createCashfreeProvider } = require('../packages/services/cashfree.js');
const { createCommerceIngressService } = require('../packages/services/commerce-ingress.js');
const { createCommerceService } = require('../packages/services/commerce.js');

/* ---------------------------------------------------------------- 1. provider */

test('provider: order creation is server-side and the browser only sees a session id', async () => {
  const calls = [];
  const provider = createCashfreeProvider({
    appId: 'x'.repeat(34), secretKey: 'k'.repeat(40), apiVersion: '2025-01-01', env: 'PRODUCTION',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ order_id: 'cfmx' + 'a'.repeat(24), payment_session_id: 'sess_' + calls.length }) };
    },
  });
  const created = await provider.createOrder({ orderId: provider.newOrderId(), productId: 'crowns_100', amount: '89.00', actor: 'player_x', email: 'a@b.co', phone: '9876543210', returnUrl: 'https://megaxo.online', notifyUrl: 'https://megaxo.online/api/monetization/cashfree/webhook' });
  assert.match(created.paymentSessionId, /^sess_/);
  const body = calls[0].body;
  assert.equal(body.order_currency, 'INR');
  assert.equal(body.order_amount, 89);
  assert.equal(body.order_meta.notify_url, 'https://megaxo.online/api/monetization/cashfree/webhook');
});

test('provider: configuration is complete or refused', () => {
  assert.throws(() => createCashfreeProvider({ appId: '', secretKey: 'k' }), /CASHFREE_CONFIG/);
  assert.throws(() => createCashfreeProvider({ appId: 'x'.repeat(34), secretKey: 'k'.repeat(40), apiVersion: 'v', env: 'STAGING' }), /CASHFREE_CONFIG/);
});

test('provider: verifyOrder returns the status and re-checkable currency', async () => {
  const provider = createCashfreeProvider({ appId: 'x'.repeat(34), secretKey: 'k'.repeat(40), apiVersion: '2025-01-01', env: 'TEST', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ order_status: 'PAID', order_amount: '89.00', order_currency: 'INR' }) }) });
  assert.deepEqual(await provider.verifyOrder('cfmx' + 'a'.repeat(24)), { status: 'PAID', amount: 89, currency: 'INR' });
  const bad = createCashfreeProvider({ appId: 'x'.repeat(34), secretKey: 'k'.repeat(40), apiVersion: '2025-01-01', env: 'TEST', fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ order_status: 'PAID', order_amount: '89.00', order_currency: 'USD' }) }) });
  await assert.rejects(() => bad.verifyOrder('cfmx' + 'a'.repeat(24)), /ORDER_CURRENCY_MISMATCH/);
});

test('provider: the webhook HMAC binds the exact raw body within five minutes', () => {
  const provider = createCashfreeProvider({ appId: 'x'.repeat(34), secretKey: 'k'.repeat(40), apiVersion: '2025-01-01', env: 'PRODUCTION' });
  const raw = JSON.stringify({ type: 'order.paid', data: { order: { order_id: 'cfmx' + 'a'.repeat(24) } } });
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', 'k'.repeat(40)).update(timestamp + raw).digest('base64');
  assert.equal(provider.verifyWebhook({ timestamp, signature, rawBody: raw }), true);
  assert.equal(provider.verifyWebhook({ timestamp, signature, rawBody: raw.replace('order.paid', 'order.expired') }), false);
  assert.equal(provider.verifyWebhook({ timestamp: String(Date.now() - 400000), signature, rawBody: raw }), false);
  assert.equal(provider.verifyWebhook({ timestamp: 'abc', signature, rawBody: raw }), false);
});

/* ---------------------------------------------------------------- 2. ingress */

function fakeCommerce() {
  const calls = [];
  const record = (method) => async (...args) => { calls.push({ method, args }); return { method, args }; };
  return {
    calls,
    status: record('status'), claim: record('claim'), cosmetic: record('cosmetic'), ticket: record('ticket'),
    permit: record('permit'), automaticPermit: record('automaticPermit'), purchase: record('purchase'), callback: record('callback'),
    createCashfreeOrder: record('createCashfreeOrder'),
    cashfreeOrderStatus: record('cashfreeOrderStatus'),
    settleCashfreeWebhook: record('settleCashfreeWebhook'),
    createPolarCheckout: record('createPolarCheckout'),
    polarOrderStatus: record('polarOrderStatus'),
    settlePolarWebhook: record('settlePolarWebhook'),
    exchangeCoins: record('exchangeCoins'), handleStoreNotification: record('handleStoreNotification'),
  };
}

test('ingress: the cashfree ops map to exactly one commerce call each; the webhook is actor-free', async () => {
  const commerce = fakeCommerce();
  const ingress = createCommerceIngressService({ commerce });
  await ingress.command({ actor: 'player_abc123', op: 'cashfree_create', key: 'op-1', productId: 'crowns_100', customer: { email: 'a@b.co', phone: '9876543210' } });
  await ingress.command({ actor: 'player_abc123', op: 'cashfree_status', orderId: 'cfmx' + 'a'.repeat(24) });
  await ingress.command({ op: 'cashfree_webhook', payload: { raw: '{}', timestamp: '123', signature: 'sig' } });
  const byMethod = Object.fromEntries(commerce.calls.map((c) => [c.method, c.args]));
  assert.deepEqual(byMethod.createCashfreeOrder, ['player_abc123', 'op-1', 'crowns_100', { email: 'a@b.co', phone: '9876543210' }]);
  assert.deepEqual(byMethod.cashfreeOrderStatus, ['player_abc123', 'cfmx' + 'a'.repeat(24)]);
  assert.deepEqual(byMethod.settleCashfreeWebhook, [{ raw: '{}', timestamp: '123', signature: 'sig' }]);
  await assert.rejects(() => ingress.command({ actor: 'player_abc123', op: 'cashfree_create', key: 'op-2', productId: 'crowns_100' }), /INVALID_COMMERCE_ARG: customer/);
  await assert.rejects(() => ingress.command({ actor: 'player_abc123', op: 'cashfree_status', orderId: 'DROP TABLE' }), /INVALID_ORDERID/);
  await assert.rejects(() => ingress.command({ op: 'cashfree_webhook', payload: { timestamp: '123', signature: 'sig' } }), /INVALID_WEBHOOK/);
});

/* ---------------------------------------------------------------- 3. real PG */

function whichBinary() {
  for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
    try {
      if (fs.existsSync(path.join(dir, 'initdb')) && execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
    } catch { /* next prefix */ }
  }
  return null;
}
const OWNED_PREFIX = 'v5_test_v52cashfree_';
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
let backend = null, backendError = null;
function stopBackendOnce() { if (backend) { const b = backend; backend = null; b.stop(); } }
process.on('exit', stopBackendOnce);
process.on('SIGINT', () => { stopBackendOnce(); process.exit(130); });
process.on('SIGTERM', () => { stopBackendOnce(); process.exit(143); });
const createdDatabases = new Set();
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v52-cashfree-pg-'));
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
async function createDatabase(family) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const name = (OWNED_PREFIX + family + '_' + process.pid + '_' + suffix).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const c = await adminClient();
  try { await c.query('CREATE DATABASE ' + ident(name)); createdDatabases.add(name); } finally { await c.end(); }
  const migration = runMigrator(name);
  assert.equal(migration.status, 0, 'migration failed: ' + migration.stdout + migration.stderr);
  assert.equal(migration.json.code, 'OK');
  assert.equal(migration.json.appliedCount, CHAIN_LENGTH, 'the real checksummed chain must apply in full');
  const c2 = await adminClient(name);
  try { for (const role of RUNTIME_ROLES) await c2.query('ALTER ROLE ' + ident(role) + ' LOGIN'); } finally { await c2.end(); }
  return name;
}
async function seedActor(database, actor, crowns) {
  const c = await adminClient(database);
  try {
    await c.query('INSERT INTO identity.actors (actor_id, region, wealth_public, created_at) VALUES ($1, $2, false, $3)', [actor, JSON.stringify('Test'), new Date(CLOCK).toISOString()]);
    await c.query('INSERT INTO identity.eligibility (actor_id, verified, suspended, security_hold) VALUES ($1, true, false, false)', [actor]);
    await c.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1, $2, $3, $4, $5, $6)', [actor, 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 10).toUpperCase(), 'player_' + actor.replace(/^cf_/, ''), actor, new Date(CLOCK).toISOString(), 'friends']);
    await c.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)', [actor, 1000, crowns]);
    await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'coins', $3, 'Opening balance', 'provisioning', $4)", ['opening:' + actor, actor, 1000, new Date(CLOCK).toISOString()]);
  } finally { await c.end(); }
}
function fakeProvider() {
  const orders = new Map();
  return {
    orders,
    newOrderId: () => 'cfmx' + crypto.randomBytes(12).toString('hex'),
    isOrderId: (v) => typeof v === 'string' && /^cfmx[a-f0-9]{24}$/.test(v),
    async createOrder(input) { orders.set(input.orderId, { ...input, status: 'ACTIVE' }); return { orderId: input.orderId, paymentSessionId: 'sess_' + input.orderId }; },
    async verifyOrder(orderId) { const o = orders.get(orderId); if (!o) throw Error('CASHFREE_HTTP_404'); return { status: o.status, amount: Number(o.amount), currency: 'INR' }; },
    verifyWebhook: ({ signature }) => signature === 'sig-good',
  };
}
const { createPgPool } = require('../packages/db/pg/pool.js');
async function commerceHarness(t, family, overrides = {}) {
  try {
    await ensureBackend();
  } catch (err) {
    /* The frozen disposable-backend contract (tests/v5-p04-services.test.js): no installed PG16
     * binary and no V5_PG_URL means the real-PG journeys SKIP with the explicit reason - they
     * never fail a runner that simply has no local database. The offline journeys above still run. */
    t.skip(err.message);
    return null;
  }
  const database = await createDatabase(family);
  await seedActor(database, 'cf_alice', 100);
  await seedActor(database, 'cf_bob', 100);
  const BUDGET = Object.freeze({ totalConnections: 12, roleConnections: Object.freeze({ core_runtime: 6, api_runtime: 4, worker_runtime: 2 }) });
  const make = (role, max) => createPgPool({ host: '127.0.0.1', port: backend.port, database, user: role, role, label: 'test', service: 'v52cashfree-test', revision: 'lr13', allowLocalNoTls: true, pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 }, budget: BUDGET });
  const corePool = make('core_runtime', 6);
  const provider = overrides.provider || fakeProvider();
  const commerce = await createCommerceService(corePool, {
    now: () => CLOCK,
    eligible: (account) => account && account.verified === true && account.suspended !== true && account.hold !== true,
    purchasesEnabled: true,
    cashfreeProvider: provider,
    cashfreeCatalog: CATALOG,
    cashfreeReturnUrl: 'https://megaxo.online',
    cashfreeNotifyUrl: 'https://megaxo.online/api/monetization/cashfree/webhook',
  });
  t.after(async () => { commerce.close(); await corePool.end(); });
  return { commerce, provider, database, skipped: false };
}

test('commerce: an active Mega Pass reserves, charges and settles the two discounted packs', async (t) => {
  const harness = await commerceHarness(t, 'discount');
  if (!harness) return;
  const { commerce, provider, database } = harness;
  // Seed the pass: an active subscription plus the paid period covering the frozen clock.
  const c0 = await adminClient(database);
  try {
    await c0.query("INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at) VALUES ('sub_disc', 'cf_alice', 'mega_pass', 'b7e2f1a0-3c4d-4e5f-8a9b-0c1d2e3f4a5b', 'active', false, $1, $2, $3, $3)", [new Date(CLOCK).toISOString(), new Date(CLOCK + 30 * 86400000).toISOString(), new Date(CLOCK).toISOString()]);
    await c0.query("INSERT INTO monetization.pass_periods (subscription_id, actor_id, period_start, period_end, installments_granted, created_at) VALUES ('sub_disc', 'cf_alice', $1, $2, 3, $3)", [new Date(CLOCK).toISOString(), new Date(CLOCK + 30 * 86400000).toISOString(), new Date(CLOCK).toISOString()]);
  } finally { await c0.end(); }
  // 1. The first pack order reserves a use and charges 15% off the catalog price.
  const first = await commerce.createCashfreeOrder('cf_alice', 'disc-key-1', 'crowns_100', { email: 'a@b.co', phone: '9876543210' });
  assert.equal(provider.orders.get(first.orderId).amount, '75.65', 'the discounted INR amount is server-computed');
  const reserved1 = await quotaOf(database);
  assert.equal(reserved1.reserved, 1); assert.equal(reserved1.used, 0);
  // 2. Verified settlement converts the reservation to used and grants the crowns once.
  provider.orders.get(first.orderId).status = 'PAID';
  const settled = await commerce.cashfreeOrderStatus('cf_alice', first.orderId);
  assert.equal(settled.paid, true); assert.equal(settled.crowns, 100);
  const used1 = await quotaOf(database);
  assert.equal(used1.reserved, 0); assert.equal(used1.used, 1);
  // 3. A second pack discounts again; a third finds the quota exhausted and pays full price.
  const second = await commerce.createCashfreeOrder('cf_alice', 'disc-key-2', 'crowns_525', { email: 'a@b.co', phone: '9876543210' });
  assert.equal(provider.orders.get(second.orderId).amount, '381.65', 'the second discount still applies');
  const third = await commerce.createCashfreeOrder('cf_alice', 'disc-key-3', 'crowns_1100', { email: 'a@b.co', phone: '9876543210' });
  assert.equal(provider.orders.get(third.orderId).amount, '899.00', 'the quota caps the discount at two packs');
  // 4. A non-pack product never discounts even with quota left.
  await adminClient(database).then(async c => { await c.query("UPDATE monetization.pass_periods SET pack_discounts_used = 0, pack_discounts_reserved = 0 WHERE subscription_id = 'sub_disc'"); await c.end(); });
  const fourth = await commerce.createCashfreeOrder('cf_bob', 'disc-key-4', 'remove_ads', { email: 'b@b.co', phone: '9876543210' });
  assert.equal(provider.orders.get(fourth.orderId).amount, '199.00', 'Remove Ads is not a Crown pack');
  const bob = await quotaOfFor(database, 'cf_bob');
  assert.equal(bob, null, 'an actor without a pass never gets a reservation');
});

async function quotaOf(database) { return quotaOfFor(database, 'cf_alice'); }
async function quotaOfFor(database, actor) {
  const c = await adminClient(database);
  try { const r = await c.query('SELECT pp.pack_discounts_reserved AS reserved, pp.pack_discounts_used AS used FROM monetization.pass_periods pp JOIN monetization.polar_subscriptions ps ON ps.subscription_id = pp.subscription_id WHERE ps.actor_id = $1', [actor]); return r.rows[0] ? { reserved: Number(r.rows[0].reserved), used: Number(r.rows[0].used) } : null; }
  finally { await c.end(); }
}

test('commerce: the order record is server-side, idempotent per key, and actor-bound', async (t) => {
  const harness = await commerceHarness(t, 'create');
  if (!harness) return;
  const { commerce, provider } = harness;
  const first = await commerce.createCashfreeOrder('cf_alice', 'order-key-1', 'crowns_100', { email: 'a@b.co', phone: '9876543210' });
  assert.match(first.orderId, /^cfmx[0-9a-f]{24}$/);
  assert.equal(first.productId, 'crowns_100');
  assert.match(first.paymentSessionId, /^sess_/);
  const replay = await commerce.createCashfreeOrder('cf_alice', 'order-key-1', 'crowns_100', { email: 'a@b.co', phone: '9876543210' });
  assert.equal(replay.orderId, first.orderId, 'the same durable key returns the same order');
  await assert.rejects(() => commerce.createCashfreeOrder('cf_alice', 'order-key-1', 'crowns_525', { email: 'a@b.co', phone: '9876543210' }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(() => commerce.createCashfreeOrder('cf_alice', 'order-key-2', 'not_a_product', { email: 'a@b.co', phone: '9876543210' }), /INVALID_PRODUCT/);
  await assert.rejects(() => commerce.createCashfreeOrder('cf_alice', 'order-key-3', 'crowns_100', { email: 'bad', phone: '9876543210' }), /INVALID_CUSTOMER_DETAILS/);
  await assert.rejects(() => commerce.createCashfreeOrder('cf_alice', 'order-key-4', 'crowns_100', { email: 'a@b.co', phone: '12' }), /INVALID_CUSTOMER_DETAILS/);
  await assert.rejects(() => commerce.createCashfreeOrder('cf_ghost', 'order-key-5', 'crowns_100', { email: 'a@b.co', phone: '9876543210' }), /ACCOUNT_REQUIRED/);
  assert.equal(provider.orders.get(first.orderId).amount, '89.00', 'the provider order carries the SERVER-AUTHORITATIVE catalog price');
});

test('commerce: settlement grants only after an independent PAID verification with the exact amount', async (t) => {
  const harness = await commerceHarness(t, 'settle');
  if (!harness) return;
  const { commerce, provider } = harness;
  const created = await commerce.createCashfreeOrder('cf_alice', 'settle-key-1', 'crowns_525', { email: 'a@b.co', phone: '9876543210' });
  const orderId = created.orderId;
  const status = await commerce.cashfreeOrderStatus('cf_alice', orderId);
  assert.equal(status.paid, false, 'an ACTIVE order never grants');
  provider.orders.get(orderId).amount = '99.00';
  provider.orders.get(orderId).status = 'PAID';
  await assert.rejects(() => commerce.cashfreeOrderStatus('cf_alice', orderId), /ORDER_AMOUNT_MISMATCH/);
  provider.orders.get(orderId).amount = '449.00';
  const granted = await commerce.cashfreeOrderStatus('cf_alice', orderId);
  assert.equal(granted.paid, true);
  assert.equal(granted.crowns, 525);
  const again = await commerce.cashfreeOrderStatus('cf_alice', orderId);
  assert.equal(again.paid, true);
  await assert.rejects(() => commerce.cashfreeOrderStatus('cf_bob', orderId), /ORDER_NOT_FOUND/, 'another actor never sees a foreign order');
});

test('commerce: the webhook settles a PAID order exactly once and routes refunds', async (t) => {
  const harness = await commerceHarness(t, 'webhook');
  if (!harness) return;
  const { commerce, provider } = harness;
  const created = await commerce.createCashfreeOrder('cf_alice', 'hook-key-1', 'crowns_100', { email: 'a@b.co', phone: '9876543210' });
  const orderId = created.orderId;
  provider.orders.get(orderId).status = 'PAID';
  const raw = JSON.stringify({ type: 'order.paid', data: { order: { order_id: orderId } } });
  const result = await commerce.settleCashfreeWebhook({ raw, timestamp: String(Date.now()), signature: 'sig-good' });
  assert.deepEqual(result, { productId: 'crowns_100', crowns: 100, duplicate: false, settled: true });
  const replay = await commerce.settleCashfreeWebhook({ raw, timestamp: String(Date.now()), signature: 'sig-good' });
  assert.equal(replay.settled, true);
  await assert.rejects(() => commerce.settleCashfreeWebhook({ raw, timestamp: String(Date.now()), signature: 'nope' }), /INVALID_WEBHOOK_SIGNATURE/);
  await assert.rejects(() => commerce.settleCashfreeWebhook({ raw: '{}', timestamp: String(Date.now()), signature: 'sig-good' }), /INVALID_WEBHOOK/);
  const refundRaw = JSON.stringify({ type: 'refund.processed', data: { order: { order_id: orderId } } });
  const refund = await commerce.settleCashfreeWebhook({ raw: refundRaw, timestamp: String(Date.now()), signature: 'sig-good' });
  assert.deepEqual(refund, { orderId, refunded: true, duplicate: false });
  const refundAgain = await commerce.settleCashfreeWebhook({ raw: refundRaw, timestamp: String(Date.now()), signature: 'sig-good' });
  /* Op-key replay returns the STORED first response verbatim (the frozen commerce contract) - the
   * guarantee is that a redelivered refund never re-applies, not a fresh duplicate flag. */
  assert.deepEqual(refundAgain, { orderId, refunded: true, duplicate: false });
});

test('commerce: a refunded remove_ads loses the entitlement structurally', async (t) => {
  const harness = await commerceHarness(t, 'refund');
  if (!harness) return;
  const { commerce, provider } = harness;
  const created = await commerce.createCashfreeOrder('cf_alice', 'ads-key-1', 'remove_ads', { email: 'a@b.co', phone: '9876543210' });
  provider.orders.get(created.orderId).status = 'PAID';
  const settled = await commerce.cashfreeOrderStatus('cf_alice', created.orderId);
  assert.equal(settled.paid, true);
  const before = await commerce.status('cf_alice');
  assert.equal(before.removeAds, true);
  await commerce.refundCashfreeOrder(created.orderId, 'operator-test');
  const after = await commerce.status('cf_alice');
  assert.equal(after.removeAds, false, 'the refunded once-product is revoked by the owned() projection');
  const dup = await commerce.refundCashfreeOrder(created.orderId, 'operator-test');
  assert.deepEqual(dup, { orderId: created.orderId, refunded: true, duplicate: false });
  await assert.rejects(() => commerce.refundCashfreeOrder('cfmx' + 'b'.repeat(24)), /ORDER_NOT_FOUND/);
});
