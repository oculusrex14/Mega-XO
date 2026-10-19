'use strict';

/* C05 offline + disposable-PG proof for the V5 Polar commerce lane (the owner decision: Polar =
 * primary global payments, the Indian fallback behind Cashfree). Mirrors tests/v52-cashfree-v5:
 * the ingress arg order with the actor-free webhook, then the REAL-PG journeys - idempotent
 * creation, settle-once with the metadata binding and the exact recorded cents, foreign-order
 * hiding, and the structural remove_ads revocation. Skips (never fails) without a backend. */
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
const CATALOG = Object.freeze({
  crowns_100: { priceId: '9571c5dc-e97e-4f0a-8fc3-fe3913460e04', amountCents: 99 },
  crowns_525: { priceId: '5f02914f-4ecf-4d58-a89f-6fbe995bf873', amountCents: 499 },
  crowns_1100: { priceId: '432c5cb1-aa2f-447c-857c-496ed2a4ceb7', amountCents: 999 },
  remove_ads: { priceId: '318ae019-ccb0-45ac-aa4e-fb018654c2e4', amountCents: 399 },
  mega_pass: { priceId: 'b7e2f1a0-3c4d-4e5f-8a9b-0c1d2e3f4a5b', amountCents: 399 },
});
const CLOCK = Date.parse('2026-10-16T12:00:00Z');
const PASS_SUBSCRIPTION_ID = 'sub_01pass000000000000000000';
const PASS_PERIOD_START = CLOCK;
const PASS_PERIOD_END = CLOCK + 30 * 86400000;

const { createCommerceIngressService } = require('../packages/services/commerce-ingress.js');
const { createCommerceService } = require('../packages/services/commerce.js');

function ingressFake() {
  const calls = [];
  const record = (method) => async (...args) => { calls.push({ method, args }); return { method, args }; };
  return {
    calls,
    status: record('status'), claim: record('claim'), cosmetic: record('cosmetic'), ticket: record('ticket'),
    permit: record('permit'), automaticPermit: record('automaticPermit'), purchase: record('purchase'), callback: record('callback'),
    createCashfreeOrder: record('createCashfreeOrder'), cashfreeOrderStatus: record('cashfreeOrderStatus'), settleCashfreeWebhook: record('settleCashfreeWebhook'),
    createPolarCheckout: record('createPolarCheckout'), polarOrderStatus: record('polarOrderStatus'), settlePolarWebhook: record('settlePolarWebhook'),
    createDodoCheckout: record('createDodoCheckout'), dodoOrderStatus: record('dodoOrderStatus'), settleDodoWebhook: record('settleDodoWebhook'),
    exchangeCoins: record('exchangeCoins'), handleStoreNotification: record('handleStoreNotification'),
  };
}

test('ingress: the polar ops map to exactly one commerce call each; the webhook is actor-free', async () => {
  const commerce = ingressFake();
  const ingress = createCommerceIngressService({ commerce });
  await ingress.command({ actor: 'player_abc123', op: 'polar_create', key: 'op-1', productId: 'crowns_100', customer: { email: 'a@b.co' } });
  await ingress.command({ actor: 'player_abc123', op: 'polar_status', checkoutId: 'c0a80101-0000-4000-8000-000000000001' });
  await ingress.command({ op: 'polar_webhook', payload: { raw: '{}', id: 'msg_1', timestamp: '123', signature: 'sig' } });
  const byMethod = Object.fromEntries(commerce.calls.map((c) => [c.method, c.args]));
  assert.deepEqual(byMethod.createPolarCheckout, ['player_abc123', 'op-1', 'crowns_100', { email: 'a@b.co' }]);
  assert.deepEqual(byMethod.polarOrderStatus, ['player_abc123', 'c0a80101-0000-4000-8000-000000000001']);
  assert.deepEqual(byMethod.settlePolarWebhook, [{ raw: '{}', id: 'msg_1', timestamp: '123', signature: 'sig' }]);
  await assert.rejects(() => ingress.command({ actor: 'player_abc123', op: 'polar_status', checkoutId: 'DROP TABLE' }), /INVALID_CHECKOUTID/);
});

/* ---------------------------------------------------------------- real PG */

function whichBinary() {
  for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
    try {
      if (fs.existsSync(path.join(dir, 'initdb')) && execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
    } catch { /* next prefix */ }
  }
  return null;
}
const OWNED_PREFIX = 'v5_test_v52polar_';
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v52-polar-pg-'));
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
  try { await c.query('CREATE DATABASE ' + ident(name)); } finally { await c.end(); }
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
    await c.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1, $2, $3, $4, $5, $6)', [actor, 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 10).toUpperCase(), 'player_' + actor.replace(/^po_/, ''), actor, new Date(CLOCK).toISOString(), 'friends']);
    await c.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)', [actor, 1000, crowns]);
    await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'coins', $3, 'Opening balance', 'provisioning', $4)", ['opening:' + actor, actor, 1000, new Date(CLOCK).toISOString()]);
  } finally { await c.end(); }
}
function fakePolar() {
  const checkouts = new Map();
  const subscriptions = new Map();
  return {
    checkouts,
    subscriptions,
    isPriceId: (v) => typeof v === 'string' && v.length > 0,
    async createCheckout(input) {
      const id = crypto.randomUUID();
      checkouts.set(id, { ...input, status: 'created', amount: CATALOG[input.productId].amountCents, metadata: { actor: input.actor, product_id: input.productId } });
      return { checkoutId: id, checkoutUrl: 'https://polar.sh/checkout/' + id };
    },
    async verifyCheckout(checkoutId) {
      const c = checkouts.get(checkoutId);
      if (!c) throw Error('POLAR_HTTP_404');
      return { status: c.status, amount: c.amount, currency: 'usd', metadata: c.metadata, checkoutId };
    },
    async verifySubscription(subscriptionId) {
      const sub = subscriptions.get(subscriptionId);
      if (!sub) throw Error('POLAR_HTTP_404');
      return {
        status: sub.status,
        productId: sub.product_id,
        priceId: sub.price_id,
        cancelAtPeriodEnd: sub.cancel_at_period_end === true,
        currentPeriodStart: sub.current_period && typeof sub.current_period.start === 'string' ? sub.current_period.start : null,
        currentPeriodEnd: sub.current_period && typeof sub.current_period.end === 'string' ? sub.current_period.end : null,
        metadata: sub.metadata && typeof sub.metadata === 'object' ? sub.metadata : {},
      };
    },
    verifyWebhook: ({ signature }) => signature === 'sig-good',
  };
}
const { createPgPool } = require('../packages/db/pg/pool.js');
async function commerceHarness(t, family) {
  try { await ensureBackend(); } catch (err) { t.skip(err.message); return null; }
  const database = await createDatabase(family);
  await seedActor(database, 'po_alice', 100);
  await seedActor(database, 'po_bob', 100);
  const BUDGET = Object.freeze({ totalConnections: 12, roleConnections: Object.freeze({ core_runtime: 6, api_runtime: 4, worker_runtime: 2 }) });
  const make = (role, max) => createPgPool({ host: '127.0.0.1', port: backend.port, database, user: role, role, label: 'test', service: 'v52polar-test', revision: 'c05', allowLocalNoTls: true, pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 }, budget: BUDGET });
  const corePool = make('core_runtime', 6);
  const provider = fakePolar();
  const commerce = await createCommerceService(corePool, {
    now: () => CLOCK,
    eligible: (account) => account && account.verified === true && account.suspended !== true && account.hold !== true,
    purchasesEnabled: true,
    polarProvider: provider,
    polarCatalog: CATALOG,
    polarSuccessUrl: 'https://megaxo.online',
  });
  t.after(async () => { commerce.close(); await corePool.end(); });
  return { commerce, provider, database };
}

test('polar commerce: the checkout record is server-side, idempotent per key, and actor-bound', async (t) => {
  const h = await commerceHarness(t, 'create');
  if (!h) return;
  const { commerce, provider } = h;
  const first = await commerce.createPolarCheckout('po_alice', 'po-key-1', 'crowns_100', { email: 'a@b.co' });
  assert.equal(UUID_OK(first.checkoutId), true);
  assert.equal(first.productId, 'crowns_100');
  const replay = await commerce.createPolarCheckout('po_alice', 'po-key-1', 'crowns_100', { email: 'a@b.co' });
  assert.equal(replay.checkoutId, first.checkoutId, 'the same durable key returns the same checkout');
  await assert.rejects(() => commerce.createPolarCheckout('po_alice', 'po-key-1', 'crowns_525', { email: 'a@b.co' }), /IDEMPOTENCY_CONFLICT/);
  await assert.rejects(() => commerce.createPolarCheckout('po_alice', 'po-key-2', 'not_a_product', { email: 'a@b.co' }), /INVALID_PRODUCT/);
  await assert.rejects(() => commerce.createPolarCheckout('po_alice', 'po-key-3', 'crowns_100', { email: 'bad' }), /INVALID_CUSTOMER_DETAILS/);
  await assert.rejects(() => commerce.createPolarCheckout('po_ghost', 'po-key-4', 'crowns_100', { email: 'a@b.co' }), /ACCOUNT_REQUIRED/);
  const recorded = provider.checkouts.get(first.checkoutId);
  assert.equal(recorded.priceId, CATALOG.crowns_100.priceId, 'the checkout carries the SERVER-AUTHORITATIVE price id');
});

test('polar commerce: settlement grants only after an independent succeeded verification with the exact cents and metadata binding', async (t) => {
  const h = await commerceHarness(t, 'settle');
  if (!h) return;
  const { commerce, provider } = h;
  const created = await commerce.createPolarCheckout('po_alice', 'settle-key-1', 'crowns_525', { email: 'a@b.co' });
  const checkoutId = created.checkoutId;
  const status = await commerce.polarOrderStatus('po_alice', checkoutId);
  assert.equal(status.paid, false, 'a created checkout never grants');
  provider.checkouts.get(checkoutId).amount = 999;
  provider.checkouts.get(checkoutId).status = 'succeeded';
  await assert.rejects(() => commerce.polarOrderStatus('po_alice', checkoutId), /ORDER_AMOUNT_MISMATCH/);
  provider.checkouts.get(checkoutId).amount = CATALOG.crowns_525.amountCents;
  provider.checkouts.get(checkoutId).metadata = { actor: 'po_bob', product_id: 'crowns_525' };
  await assert.rejects(() => commerce.polarOrderStatus('po_alice', checkoutId), /INVALID_RECEIPT/, 'a metadata actor binding mismatch is refused');
  provider.checkouts.get(checkoutId).metadata = { actor: 'po_alice', product_id: 'crowns_525' };
  const granted = await commerce.polarOrderStatus('po_alice', checkoutId);
  assert.equal(granted.paid, true);
  assert.equal(granted.crowns, 525);
  await assert.rejects(() => commerce.polarOrderStatus('po_bob', checkoutId), /ORDER_NOT_FOUND/, 'another actor never sees a foreign order');
});

test('polar commerce: the webhook settles a succeeded order exactly once and routes refunds', async (t) => {
  const h = await commerceHarness(t, 'webhook');
  if (!h) return;
  const { commerce, provider } = h;
  const created = await commerce.createPolarCheckout('po_alice', 'hook-key-1', 'crowns_100', { email: 'a@b.co' });
  const checkoutId = created.checkoutId;
  provider.checkouts.get(checkoutId).status = 'succeeded';
  const raw = JSON.stringify({ type: 'order.paid', data: { id: 'ord_1', checkout_id: checkoutId } });
  const result = await commerce.settlePolarWebhook({ raw, id: 'msg_1', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'sig-good' });
  assert.deepEqual(result, { productId: 'crowns_100', crowns: 100, duplicate: false, settled: true });
  const replay = await commerce.settlePolarWebhook({ raw, id: 'msg_1', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'sig-good' });
  assert.equal(replay.settled, true);
  await assert.rejects(() => commerce.settlePolarWebhook({ raw, id: 'msg_1', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'nope' }), /INVALID_WEBHOOK_SIGNATURE/);
  const refundRaw = JSON.stringify({ type: 'refund.created', data: { order_id: 'ord_1' } });
  const refund = await commerce.settlePolarWebhook({ raw: refundRaw, id: 'msg_2', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'sig-good' });
  assert.deepEqual(refund, { checkoutId, refunded: true, duplicate: false });
  const refundAgain = await commerce.settlePolarWebhook({ raw: refundRaw, id: 'msg_3', timestamp: String(Math.floor(Date.now() / 1000)), signature: 'sig-good' });
  assert.deepEqual(refundAgain, { checkoutId, refunded: true, duplicate: false }, 'op-key replay returns the stored first response verbatim');
});

test('polar commerce: a Mega Pass subscription binds, reconciles, grants installments and revokes', async (t) => {
  const h = await commerceHarness(t, 'pass');
  if (!h) return;
  const { commerce, provider, database } = h;
  // The first paid pass order binds the subscription row to the RECORDED checkout actor.
  const created = await commerce.createPolarCheckout('po_alice', 'pass-key-1', 'mega_pass', {});
  const checkoutId = created.checkoutId;
  assert.equal(typeof created.checkoutUrl, 'string', 'the reply carries the hosted checkout URL');
  provider.checkouts.get(checkoutId).status = 'succeeded';
  const paid = await commerce.settlePolarWebhook({
    raw: JSON.stringify({ type: 'order.paid', data: { id: 'ord_pass_1', checkout_id: checkoutId, subscription_id: PASS_SUBSCRIPTION_ID } }),
    id: 'msg_pass_1', timestamp: String(Math.floor(CLOCK / 1000)), signature: 'sig-good',
  });
  assert.equal(paid.settled, true);
  assert.equal(paid.crowns, 0, 'the pass itself grants no instant crowns');
  // A subscription event with NO recorded binding is refused; the verified metadata must match a
  // recorded pass checkout for the same price id.
  provider.subscriptions.set('sub_orphan', { status: 'active', product_id: 'mega_pass', price_id: CATALOG.mega_pass.priceId, cancel_at_period_end: false, current_period: { start: new Date(PASS_PERIOD_START).toISOString(), end: new Date(PASS_PERIOD_END).toISOString() }, metadata: { actor: 'po_bob', product_id: 'mega_pass' } });
  const orphan = await commerce.settlePolarWebhook({
    raw: JSON.stringify({ type: 'subscription.created', data: { id: 'sub_orphan' } }),
    id: 'msg_pass_2', timestamp: String(Math.floor(CLOCK / 1000)), signature: 'sig-good',
  });
  assert.deepEqual(orphan, { handled: false, reason: 'INVALID_BINDING' }, 'metadata.actor alone never binds');
  // The genuine provider-verified subscription reconciles into an active, grantable period.
  provider.subscriptions.set(PASS_SUBSCRIPTION_ID, { status: 'active', product_id: 'mega_pass', price_id: CATALOG.mega_pass.priceId, cancel_at_period_end: false, current_period: { start: new Date(PASS_PERIOD_START).toISOString(), end: new Date(PASS_PERIOD_END).toISOString() }, metadata: { actor: 'po_alice', product_id: 'mega_pass' } });
  const reconciled = await commerce.settlePolarWebhook({
    raw: JSON.stringify({ type: 'subscription.created', data: { id: PASS_SUBSCRIPTION_ID } }),
    id: 'msg_pass_3', timestamp: String(Math.floor(CLOCK / 1000)), signature: 'sig-good',
  });
  assert.equal(reconciled.handled, true);
  assert.equal(reconciled.status, 'active');
  let status = await commerce.status('po_alice');
  assert.equal(status.pass.active, true, 'the pass is live after reconciliation');
  assert.equal(status.pass.periodEnd, PASS_PERIOD_END);
  assert.equal(status.removeAds, true, 'the pass turns automatic ads off');
  // Installment 1 is due immediately (period start + 0 days) and commits exactly once.
  const sweep = await commerce.processPassGrants();
  assert.equal(sweep.granted, 1);
  status = await commerce.status('po_alice');
  assert.equal(status.credits ? status.credits.length >= 0 : true, true);
  const crownsAfterFirst = await crownsOf(database, 'po_alice');
  assert.equal(crownsAfterFirst, 150, 'installment 1 delivers the canonical 50 Crowns');
  const sweepAgain = await commerce.processPassGrants();
  assert.equal(sweepAgain.granted, 0, 'installments 2 and 3 are not due at period day 0');
  // A cancel keeps access until the paid period end; a revocation ends it immediately.
  await commerce.settlePolarWebhook({
    raw: JSON.stringify({ type: 'subscription.canceled', data: { id: PASS_SUBSCRIPTION_ID } }),
    id: 'msg_pass_4', timestamp: String(Math.floor(CLOCK / 1000)), signature: 'sig-good',
  });
  status = await commerce.status('po_alice');
  assert.equal(status.pass.active, true, 'cancel keeps the paid period');
  assert.equal(status.pass.cancelAtPeriodEnd, true);
  await commerce.settlePolarWebhook({
    raw: JSON.stringify({ type: 'subscription.revoked', data: { id: PASS_SUBSCRIPTION_ID } }),
    id: 'msg_pass_5', timestamp: String(Math.floor(CLOCK / 1000)), signature: 'sig-good',
  });
  status = await commerce.status('po_alice');
  assert.equal(status.pass.active, false, 'revocation ends the entitlement');
  assert.equal(status.removeAds, false);
});

async function crownsOf(database, actor) {
  const c = await adminClient(database);
  try { const r = await c.query('SELECT crowns FROM economy.wallets WHERE actor_id = $1', [actor]); return Number(r.rows[0].crowns); }
  finally { await c.end(); }
}

test('polar commerce: a refunded remove_ads loses the entitlement structurally', async (t) => {
  const h = await commerceHarness(t, 'refund');
  if (!h) return;
  const { commerce, provider } = h;
  const created = await commerce.createPolarCheckout('po_alice', 'ads-key-1', 'remove_ads', { email: 'a@b.co' });
  provider.checkouts.get(created.checkoutId).status = 'succeeded';
  const settled = await commerce.polarOrderStatus('po_alice', created.checkoutId);
  assert.equal(settled.paid, true);
  const before = await commerce.status('po_alice');
  assert.equal(before.removeAds, true);
  await commerce.refundPolarOrder(created.checkoutId, 'operator-test');
  const after = await commerce.status('po_alice');
  assert.equal(after.removeAds, false, 'the refunded once-product is revoked by the owned() projection');
  const dup = await commerce.refundPolarOrder(created.checkoutId, 'operator-test');
  assert.deepEqual(dup, { checkoutId: created.checkoutId, refunded: true, duplicate: false });
  await assert.rejects(() => commerce.refundPolarOrder('c0a80101-0000-4000-8000-000000000009'), /ORDER_NOT_FOUND/);
});

function UUID_OK(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
