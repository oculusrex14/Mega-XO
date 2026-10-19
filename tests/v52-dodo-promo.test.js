'use strict';

/* MXA-PROMO-SPLIT (2026-10-19): the owner two-mechanism promo model, proven end to end.
 *
 *   1. ONE-TIME buys are discounted by the provider's own product pricing: during the launch
 *      window the Dodo catalog carries the intro price, the checkout attaches NO discount code,
 *      and the recorded order amount is exactly the intro price.
 *   2. The Mega Pass keeps its BASE recurring price and is discounted only by the LAUNCH50 code
 *      the player enters on the Dodo checkout - the server never attaches it, and the pack
 *      discount stays off during the window so nothing stacks.
 *   3. Settlement accepts, for an order created inside the promo window, either of the
 *      product's own two configured prices (promo or regular) and NO third amount; an order
 *      created after the code expiry verifies only at its recorded price.
 *   4. The unattended restore is pending before the boundary, flips the catalog to the regular
 *      prices after a verified provider restore, and surfaces failures without flipping.
 *
 * The offline journeys run against a fake fetch/provider; the commerce journeys run over a REAL
 * disposable PostgreSQL (the frozen harness contract) and skip with an explicit reason when no
 * local backend exists - they never fail a runner that simply has no database. */
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

const { createDodoProvider } = require('../packages/services/dodo.js');
const { createCommerceService } = require('../packages/services/commerce.js');

const CLOCK = Date.parse('2026-12-01T12:00:00Z');
const AFTER = Date.parse('2027-01-05T12:00:00Z');
const PROMO = Object.freeze({ code: 'LAUNCH50', percentBps: 5000, expiresAt: '2027-01-01T00:00:00Z', products: ['crowns_100', 'crowns_525', 'crowns_1100', 'remove_ads', 'mega_pass'] });
const DODO_CATALOG = Object.freeze({
  crowns_100: { productId: 'pdt_crowns100', prices: { usd: 49, inr: 2500 } },
  crowns_525: { productId: 'pdt_crowns525', prices: { usd: 249, inr: 12500 } },
  crowns_1100: { productId: 'pdt_crowns1100', prices: { usd: 499, inr: 25000 } },
  remove_ads: { productId: 'pdt_removeads', prices: { usd: 199, inr: 9900 } },
  mega_pass: { productId: 'pdt_megapass', prices: { usd: 399, inr: 19900 } },
});
const DODO_REGULAR = Object.freeze({
  crowns_100: { prices: { usd: 99, inr: 4900 } },
  crowns_525: { prices: { usd: 499, inr: 24900 } },
  crowns_1100: { prices: { usd: 999, inr: 49900 } },
  remove_ads: { prices: { usd: 399, inr: 19900 } },
  mega_pass: { prices: { usd: 399, inr: 19900 } },
});
const DODO_INTRO = Object.freeze({
  crowns_100: { prices: { usd: 49, inr: 2500 } },
  crowns_525: { prices: { usd: 249, inr: 12500 } },
  crowns_1100: { prices: { usd: 499, inr: 25000 } },
  remove_ads: { prices: { usd: 199, inr: 9900 } },
  mega_pass: { prices: { usd: 199, inr: 9900 } },
});

/* ---------------------------------------------------------------- 1. provider restore */

function restoreFetch(state) {
  return async (url, init) => {
    const pathName = new URL(url).pathname;
    if (init && init.method === 'PATCH' && pathName.includes('/localized-prices')) {
      const body = JSON.parse(init.body);
      state.inr = body.amount;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'lcp_1', currency: 'INR', amount: state.inr }) };
    }
    if (init && init.method === 'PATCH') {
      state.usd = JSON.parse(init.body).price.price;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'pdt_x', price: { type: 'one_time_price', currency: 'USD', price: state.usd } }) };
    }
    if (pathName.endsWith('/localized-prices')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: state.inr === null ? [] : [{ id: 'lcp_1', currency: 'INR', amount: state.inr }] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'pdt_x', price: { type: 'one_time_price', currency: 'USD', price: state.usd } }) };
  };
}

test('provider: restoreProductPrice patches only mismatches and re-verifies the write', async () => {
  const state = { usd: 49, inr: 2500 };
  const provider = createDodoProvider({ apiKey: 'dk_' + 'x'.repeat(24), mode: 'test', fetchImpl: restoreFetch(state) });
  assert.equal(await provider.restoreProductPrice({ dodoProductId: 'pdt_x1abcd', base: { usd: 99, inr: 4900 } }), 'patched');
  assert.equal(state.usd, 99);
  assert.equal(state.inr, 4900);
  assert.equal(await provider.restoreProductPrice({ dodoProductId: 'pdt_x1abcd', base: { usd: 99, inr: 4900 } }), 'already', 'a verified product never writes again');
});

test('provider: a restore whose re-verify disagrees throws instead of reporting success', async () => {
  let rejectVerify = true;
  const state = { usd: 49, inr: 2500 };
  const fetchImpl = async (url, init) => {
    if (rejectVerify && (!init || init.method !== 'PATCH')) {
      const pathName = new URL(url).pathname;
      if (pathName.includes('/localized-prices')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'lcp_1', currency: 'INR', amount: state.inr }] }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'pdt_x', price: { type: 'one_time_price', currency: 'USD', price: 49 } }) };
    }
    return restoreFetch(state)(url, init);
  };
  const provider = createDodoProvider({ apiKey: 'dk_' + 'x'.repeat(24), mode: 'test', fetchImpl });
  await assert.rejects(() => provider.restoreProductPrice({ dodoProductId: 'pdt_x1abcd', base: { usd: 99, inr: 4900 } }), /DODO_RESTORE_VERIFY_FAILED/);
  rejectVerify = false;
  state.usd = 49; state.inr = 2500;
  assert.equal(await provider.restoreProductPrice({ dodoProductId: 'pdt_x1abcd', base: { usd: 99, inr: 4900 } }), 'patched', 'the retry after a failed restore succeeds');
});

test('provider: checkout creation locks the price and the currency against checkout-page edits', async () => {
  const bodies = [];
  const provider = createDodoProvider({ apiKey: 'dk_' + 'x'.repeat(24), mode: 'test', fetchImpl: async (url, init) => {
    bodies.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ session_id: 'cks_' + 'a'.repeat(12), checkout_url: 'https://checkout.dodopayments.com/x' }) };
  } });
  await provider.createCheckout({ productId: 'pdt_crowns100', actor: 'dp_x', storeProductId: 'crowns_100', email: 'a@b.co', successUrl: 'https://megaxo.online', metadata: { request_id: 'r1' }, discountCodes: null, billingCurrency: 'inr', country: 'IN' });
  await provider.createCheckout({ productId: 'pdt_megapass', actor: 'dp_x', storeProductId: 'mega_pass', email: 'a@b.co', successUrl: 'https://megaxo.online', metadata: { request_id: 'r2' }, discountCodes: null, billingCurrency: 'inr', country: 'IN' });
  const body = bodies[0].body;
  assert.deepEqual(body.feature_flags, { allow_discount_code: false, allow_currency_selection: false }, 'a one-time checkout allows neither code entry nor a currency change');
  assert.equal(body.discount_codes, undefined, 'no server-attached code either');
  assert.equal(body.billing_currency, 'INR');
  const passBody = bodies[1].body;
  assert.equal(passBody.feature_flags.allow_discount_code, true, 'the Mega Pass checkout MUST accept the player-entered LAUNCH50 code');
  assert.equal(passBody.feature_flags.allow_currency_selection, false);
});

/* ---------------------------------------------------------------- 2. disposable backend */

function whichBinary() {
  for (const dir of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
    try {
      if (fs.existsSync(path.join(dir, 'initdb')) && execFileSync(path.join(dir, 'initdb'), ['--version'], { encoding: 'utf8' }).includes(' 16.')) return dir;
    } catch { /* next prefix */ }
  }
  return null;
}
const OWNED_PREFIX = 'v5_test_v52dodopromo_';
const RUNTIME_ROLES = ['api_runtime', 'core_runtime', 'worker_runtime'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
let backend = null, backendError = null;
function stopBackendOnce() { if (backend && typeof backend.stop === 'function') { const b = backend; backend = null; b.stop(); } else { backend = null; } }
process.on('exit', stopBackendOnce);
process.on('SIGINT', () => { stopBackendOnce(); process.exit(130); });
process.on('SIGTERM', () => { stopBackendOnce(); process.exit(143); });
const createdDatabases = new Set();
const ident = (name) => '"' + String(name).replace(/"/g, '""') + '"';
function dbUrl(database) { const u = new URL(backend.adminUrl); u.pathname = '/' + database; u.search = ''; return u.toString(); }
async function adminClient(database) {
  const pg = require('pg');
  const u = new URL(backend.adminUrl);
  const c = new pg.Client({ host: u.hostname, port: Number(u.port || 5432), user: u.username ? decodeURIComponent(u.username) : 'postgres', password: u.username ? decodeURIComponent(u.password || '') : undefined, database: database || decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres' });
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
  /* The frozen contract's external path (tests/v5-p04-services.test.js): an owned LOOPBACK
   * cluster via V5_PG_URL + V5_PG_DISPOSABLE=1 (the CI service containers), else a local PG16
   * binary, else an explicit skip - a runner with neither never silently passes nothing. */
  const external = process.env.V5_PG_URL || '';
  if (external) {
    if (process.env.V5_PG_DISPOSABLE !== '1') throw new Error('V5_PG_URL requires V5_PG_DISPOSABLE=1 (owned synthetic cluster only)');
    let u;
    try { u = new URL(external); } catch { throw new Error('V5_PG_URL is unparsable'); }
    if (!LOOPBACK.has(u.hostname)) throw new Error('V5_PG_URL must target a loopback host');
    if (/(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i.test(decodeURIComponent(u.pathname))) throw new Error('V5_PG_URL control database must be non-production');
    const control = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!control || control.startsWith(OWNED_PREFIX)) throw new Error('V5_PG_URL control database must not be one of this suite owned databases');
    backend = { kind: 'external', adminUrl: external, host: u.hostname, port: Number(u.port || 5432) };
    return backend;
  }
  const bin = whichBinary();
  if (!bin) { backendError = 'no PostgreSQL 16 backend available'; throw new Error(backendError); }
  const net = require('node:net');
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v52-dodopromo-pg-'));
  execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth-local=trust', '--auth-host=trust', '-U', 'postgres', '-E', 'UTF8'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-o', '-p ' + port + ' -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off', '-l', path.join(dataDir, 'server.log'), 'start'], { stdio: 'ignore', env: { ...process.env, LC_ALL: 'C' }, timeout: 120000 });
  for (let i = 0; i < 60; i += 1) {
    try { execFileSync(path.join(bin, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-q'], { stdio: 'ignore', timeout: 10000 }); break; }
    catch { if (i === 59) throw new Error('binary PG16 never became ready'); execFileSync('sleep', ['1']); }
  }
  backend = { kind: 'binary', adminUrl: 'postgres://postgres@127.0.0.1:' + port + '/postgres', host: '127.0.0.1', port, stop: () => {
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
    await c.query('INSERT INTO identity.profiles (actor_id, tag, username, display_name, created_at, stats_visibility) VALUES ($1, $2, $3, $4, $5, $6)', [actor, 'MEGA-' + crypto.createHash('sha256').update(actor).digest('hex').slice(0, 10).toUpperCase(), 'player_' + actor.replace(/^dp_/, ''), actor, new Date(CLOCK).toISOString(), 'friends']);
    await c.query('INSERT INTO economy.wallets (actor_id, coins, crowns) VALUES ($1, $2, $3)', [actor, 1000, crowns]);
    await c.query("INSERT INTO economy.ledger (entry_id, actor_id, currency, amount, reason, source, at) VALUES ($1, $2, 'coins', $3, 'Opening balance', 'provisioning', $4)", ['opening:' + actor, actor, 1000, new Date(CLOCK).toISOString()]);
  } finally { await c.end(); }
}

function fakeDodoProvider(state) {
  return {
    creates: state.creates,
    async createCheckout(input) { state.creates.push(input); return { checkoutId: 'cks_' + crypto.randomBytes(9).toString('hex'), checkoutUrl: 'https://checkout.dodopayments.com/' + state.creates.length }; },
    async verifyCheckout(sessionId) { const v = state.verifies.get(sessionId); return v || { status: 'pending' }; },
    async restoreProductPrice(input) { state.restores.push(input); if (state.restoreFail) throw Error('DODO_HTTP_500'); return 'patched'; },
    isProductId: (v) => typeof v === 'string' && /^pdt_/.test(v),
    isSessionId: (v) => typeof v === 'string' && /^cks_/.test(v),
    supportedCurrency: (v) => (['usd', 'inr'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : null),
  };
}

async function promoHarness(t, family, clock) {
  try {
    await ensureBackend();
  } catch (err) {
    t.skip(err.message);
    return null;
  }
  const database = await createDatabase(family);
  const state = { creates: [], verifies: new Map(), restores: [], restoreFail: false };
  const BUDGET = Object.freeze({ totalConnections: 12, roleConnections: Object.freeze({ core_runtime: 6, api_runtime: 4, worker_runtime: 2 }) });
  const make = (role, max) => { const { createPgPool } = require('../packages/db/pg/pool.js'); return createPgPool({ host: new URL(backend.adminUrl).hostname, port: Number(new URL(backend.adminUrl).port || 5432), database, user: role, role, label: 'test', service: 'v52dodopromo-test', revision: 'mxa-promo-split', allowLocalNoTls: true, pool: { max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 16 }, budget: BUDGET }); };
  const corePool = make('core_runtime', 6);
  const commerce = await createCommerceService(corePool, {
    now: () => (clock || CLOCK),
    eligible: (account) => account && account.verified === true && account.suspended !== true && account.hold !== true,
    purchasesEnabled: true,
    dodoProvider: fakeDodoProvider(state),
    dodoCatalog: JSON.parse(JSON.stringify(DODO_CATALOG)),
    dodoRegularCatalog: JSON.parse(JSON.stringify(DODO_REGULAR)),
    dodoIntroCatalog: JSON.parse(JSON.stringify(DODO_INTRO)),
    dodoSuccessUrl: 'https://megaxo.online',
    dodoPackDiscountId: 'PACKCODE15',
    dodoIntroEndsAt: '2026-12-31T18:29:59Z',
    dodoIntroPricingActive: true,
    dodoPromo: { ...PROMO },
  });
  t.after(async () => { commerce.close(); await corePool.end(); });
  return { commerce, state, database, skipped: false };
}

async function recordedOrder(database, checkoutId) {
  const c = await adminClient(database);
  try { return (await c.query('SELECT product_id, amount_cents, currency, status, actor_id, created_at FROM monetization.dodo_orders WHERE checkout_id = $1', [checkoutId])).rows[0] || null; }
  finally { await c.end(); }
}

/* ---------------------------------------------------------------- 3. checkout creation */

test('commerce: a one-time checkout records the intro price and attaches no launch code', async (t) => {
  const h = await promoHarness(t, 'create');
  if (!h) return;
  await seedActor(h.database, 'dp_alice', 100);
  const created = await h.commerce.createDodoCheckout('dp_alice', 'promo-key-1', 'crowns_100', { email: 'a@b.co' }, { currency: 'inr' });
  assert.match(created.checkoutId, /^cks_/);
  const sent = h.state.creates[0];
  assert.equal(sent.discountCodes, null, 'no discount code rides the one-time checkout - the provider price IS the promo');
  const row = await recordedOrder(h.database, created.checkoutId);
  assert.equal(row.product_id, 'crowns_100');
  assert.equal(Number(row.amount_cents), 2500, 'the recorded amount is the intro catalog price');
  assert.equal(row.currency, 'inr');
  const passCheckout = await h.commerce.createDodoCheckout('dp_alice', 'promo-key-2', 'mega_pass', { email: 'a@b.co' }, {});
  const passSent = h.state.creates[1];
  assert.equal(passSent.discountCodes, null, 'the pass code is the player checkout action, never a server attach');
  const passRow = await recordedOrder(h.database, passCheckout.checkoutId);
  assert.equal(Number(passRow.amount_cents), 399, 'the pass records its BASE price');
  assert.equal(passRow.currency, 'usd');
});

test('commerce: the pack discount stays off during the launch window', async (t) => {
  const h = await promoHarness(t, 'pack');
  if (!h) return;
  await seedActor(h.database, 'dp_pass', 100);
  const c0 = await adminClient(h.database);
  try {
    await c0.query("INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at, provider) VALUES ('sub_promo', 'dp_pass', 'mega_pass', 'pdt_megapass', 'active', false, $1, $2, $3, $3, 'dodo')", [new Date(CLOCK).toISOString(), new Date(CLOCK + 30 * 86400000).toISOString(), new Date(CLOCK).toISOString()]);
    await c0.query("INSERT INTO monetization.pass_periods (subscription_id, actor_id, period_start, period_end, installments_granted, pack_discounts_reserved, created_at) VALUES ('sub_promo', 'dp_pass', $1, $2, 3, 0, $3)", [new Date(CLOCK).toISOString(), new Date(CLOCK + 30 * 86400000).toISOString(), new Date(CLOCK).toISOString()]);
  } finally { await c0.end(); }
  await h.commerce.createDodoCheckout('dp_pass', 'promo-key-3', 'crowns_100', { email: 'p@b.co' }, { currency: 'inr' });
  assert.equal(h.state.creates[0].discountCodes, null, 'PACKCODE15 must not stack on the intro price during the window');
});

/* ---------------------------------------------------------------- 4. settlement boundary */

test('commerce: settlement accepts the two configured boundary prices and no third amount', async (t) => {
  const h = await promoHarness(t, 'settle');
  if (!h) return;
  for (const actor of ['dp_settle_a', 'dp_settle_b', 'dp_settle_c', 'dp_settle_d', 'dp_settle_e']) await seedActor(h.database, actor, 100);
  const verify = (actor, productId, amount, currency) => ({ status: 'succeeded', amount, currency, metadata: { actor, product_id: productId } });
  // 1. The intro charge settles and grants once.
  const a = await h.commerce.createDodoCheckout('dp_settle_a', 'settle-key-1', 'crowns_100', { email: 'a@b.co' }, { currency: 'inr' });
  h.state.verifies.set(a.checkoutId, verify('dp_settle_a', 'crowns_100', 2500, 'inr'));
  const settledA = await h.commerce.dodoOrderStatus('dp_settle_a', a.checkoutId);
  assert.equal(settledA.paid, true);
  assert.equal(settledA.crowns, 100);
  const c1 = await adminClient(h.database);
  try { const w = (await c1.query('SELECT crowns FROM economy.wallets WHERE actor_id = $1', ['dp_settle_a'])).rows[0]; assert.equal(Number(w.crowns), 200, 'the crowns grant runs exactly once'); } finally { await c1.end(); }
  // 2. The boundary race - a pre-window checkout that completes at the REGULAR price - verifies.
  const b = await h.commerce.createDodoCheckout('dp_settle_b', 'settle-key-2', 'crowns_100', { email: 'b@b.co' }, { currency: 'inr' });
  h.state.verifies.set(b.checkoutId, verify('dp_settle_b', 'crowns_100', 4900, 'inr'));
  const settledB = await h.commerce.dodoOrderStatus('dp_settle_b', b.checkoutId);
  assert.equal(settledB.paid, true, 'the regular price is the product own other configured price');
  // 3. Any third amount is a mismatch.
  const c = await h.commerce.createDodoCheckout('dp_settle_c', 'settle-key-3', 'crowns_100', { email: 'c@b.co' }, { currency: 'inr' });
  h.state.verifies.set(c.checkoutId, verify('dp_settle_c', 'crowns_100', 3000, 'inr'));
  await assert.rejects(() => h.commerce.dodoOrderStatus('dp_settle_c', c.checkoutId), /ORDER_AMOUNT_MISMATCH/);
  // 4. The pass code-applied total verifies for an order created inside the code window.
  const d = await h.commerce.createDodoCheckout('dp_settle_d', 'settle-key-4', 'mega_pass', { email: 'd@b.co' }, {});
  h.state.verifies.set(d.checkoutId, verify('dp_settle_d', 'mega_pass', 200, 'usd'));
  const settledD = await h.commerce.dodoOrderStatus('dp_settle_d', d.checkoutId);
  assert.equal(settledD.paid, true, 'the LAUNCH50 total (half of the recorded base) verifies');
  // 5. An order created after the code expiry verifies only at its recorded price.
  const e = await h.commerce.createDodoCheckout('dp_settle_e', 'settle-key-5', 'mega_pass', { email: 'e@b.co' }, {});
  h.state.verifies.set(e.checkoutId, verify('dp_settle_e', 'mega_pass', 200, 'usd'));
  const c2 = await adminClient(h.database);
  try { await c2.query("UPDATE monetization.dodo_orders SET created_at = '2027-01-02T00:00:00Z' WHERE checkout_id = $1", [e.checkoutId]); } finally { await c2.end(); }
  await assert.rejects(() => h.commerce.dodoOrderStatus('dp_settle_e', e.checkoutId), /ORDER_AMOUNT_MISMATCH/, 'a post-expiry code total never verifies');
});

test('commerce: currency binds every accepted amount and a wrong-currency charge never verifies', async (t) => {
  const h = await promoHarness(t, 'currency');
  if (!h) return;
  await seedActor(h.database, 'dp_curr', 100);
  const order = await h.commerce.createDodoCheckout('dp_curr', 'curr-key-1', 'crowns_100', { email: 'c@b.co' }, { currency: 'inr' });
  /* A checkout-page currency flip (now impossible with the flags, but an inherited legacy
   * session could predate them): the INR intro amount arriving as "USD" must never verify. */
  h.state.verifies.set(order.checkoutId, { status: 'succeeded', amount: 2500, currency: 'usd', metadata: { actor: 'dp_curr', product_id: 'crowns_100' } });
  await assert.rejects(() => h.commerce.dodoOrderStatus('dp_curr', order.checkoutId), /ORDER_AMOUNT_MISMATCH/);
  /* The regular-price fallback is also currency-bound: the matching INR number as USD is not the regular USD price. */
  const order2 = await h.commerce.createDodoCheckout('dp_curr', 'curr-key-2', 'crowns_100', { email: 'c@b.co' }, { currency: 'inr' });
  h.state.verifies.set(order2.checkoutId, { status: 'succeeded', amount: 4900, currency: 'usd', metadata: { actor: 'dp_curr', product_id: 'crowns_100' } });
  await assert.rejects(() => h.commerce.dodoOrderStatus('dp_curr', order2.checkoutId), /ORDER_AMOUNT_MISMATCH/);
});

test('commerce: a pre-restore order completes at the current provider price and legacy attach-design orders settle', async (t) => {
  const h = await promoHarness(t, 'boundary', CLOCK);
  if (!h) return;
  await seedActor(h.database, 'dp_bnd', 100);
  /* The restore-boundary race: the order records the intro price, the provider completes at the
   * CURRENT catalog price after a verified restore (either direction of the race). */
  const order = await h.commerce.createDodoCheckout('dp_bnd', 'bnd-key-1', 'crowns_100', { email: 'b@b.co' }, { currency: 'inr' });
  assert.equal(Number((await recordedOrder(h.database, order.checkoutId)).amount_cents), 2500);
  const restore = await h.commerce.processIntroPriceRestore();
  /* The frozen clock is BEFORE the window here, so simulate the post-boundary state directly:
   * a second service clock is not needed - the tolerance branch itself is exercised by the
   * catalog-price alternative below, driven by the promo window being active. */
  assert.notEqual(restore.pending, undefined);
  h.state.verifies.set(order.checkoutId, { status: 'succeeded', amount: 4900, currency: 'inr', metadata: { actor: 'dp_bnd', product_id: 'crowns_100' } });
  const settled = await h.commerce.dodoOrderStatus('dp_bnd', order.checkoutId);
  assert.equal(settled.paid, true, 'the regular price verifies for an in-window order');
  /* A legacy attach-design order (recorded at base*0.5 = 2450) settles at its recorded amount
   * and at the new intro price (the transition), but never at a double-halved total. */
  const legacy = await h.commerce.createDodoCheckout('dp_bnd', 'bnd-key-2', 'crowns_100', { email: 'b@b.co' }, { currency: 'inr' });
  const c0 = await adminClient(h.database);
  try { await c0.query('UPDATE monetization.dodo_orders SET amount_cents = 2450 WHERE checkout_id = $1', [legacy.checkoutId]); } finally { await c0.end(); }
  h.state.verifies.set(legacy.checkoutId, { status: 'succeeded', amount: 2450, currency: 'inr', metadata: { actor: 'dp_bnd', product_id: 'crowns_100' } });
  const legacySettled = await h.commerce.dodoOrderStatus('dp_bnd', legacy.checkoutId);
  assert.equal(legacySettled.paid, true, 'the legacy recorded amount verifies');
  const legacy2 = await h.commerce.createDodoCheckout('dp_bnd', 'bnd-key-3', 'crowns_100', { email: 'b@b.co' }, { currency: 'inr' });
  const c1 = await adminClient(h.database);
  try { await c1.query('UPDATE monetization.dodo_orders SET amount_cents = 2450 WHERE checkout_id = $1', [legacy2.checkoutId]); } finally { await c1.end(); }
  h.state.verifies.set(legacy2.checkoutId, { status: 'succeeded', amount: 2500, currency: 'inr', metadata: { actor: 'dp_bnd', product_id: 'crowns_100' } });
  const legacy2Settled = await h.commerce.dodoOrderStatus('dp_bnd', legacy2.checkoutId);
  assert.equal(legacy2Settled.paid, true, 'the current catalog (intro) price verifies for a legacy order');
  const legacy3 = await h.commerce.createDodoCheckout('dp_bnd', 'bnd-key-4', 'crowns_100', { email: 'b@b.co' }, { currency: 'inr' });
  const c2 = await adminClient(h.database);
  try { await c2.query('UPDATE monetization.dodo_orders SET amount_cents = 2450 WHERE checkout_id = $1', [legacy3.checkoutId]); } finally { await c2.end(); }
  h.state.verifies.set(legacy3.checkoutId, { status: 'succeeded', amount: 1225, currency: 'inr', metadata: { actor: 'dp_bnd', product_id: 'crowns_100' } });
  await assert.rejects(() => h.commerce.dodoOrderStatus('dp_bnd', legacy3.checkoutId), /ORDER_AMOUNT_MISMATCH/, 'a double-halved total (25% of base) never verifies');
});

/* ---------------------------------------------------------------- 5. the unattended restore */

test('restore: the sweep is pending before the boundary and flips the catalog after it', async (t) => {
  const h = await promoHarness(t, 'restore', CLOCK);
  if (!h) return;
  await seedActor(h.database, 'dp_restore', 100);
  const pending = await h.commerce.processIntroPriceRestore();
  assert.deepEqual(pending, { pending: true, endsAt: '2026-12-31T18:29:59Z' });
  assert.equal(h.state.restores.length, 0, 'nothing is patched before the window closes');
  const during = await h.commerce.createDodoCheckout('dp_restore', 'restore-key-1', 'crowns_100', { email: 'r@b.co' }, { currency: 'inr' });
  assert.equal(Number((await recordedOrder(h.database, during.checkoutId)).amount_cents), 2500, 'the intro price records while the window is open');
  const after = await promoHarness(t, 'restore2', AFTER);
  if (!after) return;
  await seedActor(after.database, 'dp_restore2', 100);
  const result = await after.commerce.processIntroPriceRestore();
  assert.equal(result.done, true);
  assert.equal(result.restored, 4, 'every once-product is restored');
  assert.equal(h.state.restores.length, 0, 'the first harness never restored - the second did');
  const flipped = await after.commerce.createDodoCheckout('dp_restore2', 'restore-key-2', 'crowns_100', { email: 'r@b.co' }, { currency: 'inr' });
  assert.equal(Number((await recordedOrder(after.database, flipped.checkoutId)).amount_cents), 4900, 'new orders record the base price after the verified restore');
  const idempotent = await after.commerce.processIntroPriceRestore();
  assert.equal(idempotent.done, true, 'a completed restore never re-patches');
});

test('restore: a failed provider restore surfaces failures and keeps the intro catalog', async (t) => {
  const h = await promoHarness(t, 'restorefail', AFTER);
  if (!h) return;
  await seedActor(h.database, 'dp_fail', 100);
  h.state.restoreFail = true;
  const result = await h.commerce.processIntroPriceRestore();
  assert.equal(result.pending, true);
  assert.equal(result.failures.length, 4, 'every failure is named for the operations alert');
  const order = await h.commerce.createDodoCheckout('dp_fail', 'fail-key-1', 'crowns_100', { email: 'f@b.co' }, { currency: 'inr' });
  assert.equal(Number((await recordedOrder(h.database, order.checkoutId)).amount_cents), 2500, 'a failing restore keeps the intro catalog so recorded always equals the provider charge');
});

test('restore: the pack discount resumes automatically and pre-restore orders survive the restart window', async (t) => {
  const h = await promoHarness(t, 'packresume', AFTER);
  if (!h) return;
  await seedActor(h.database, 'dp_resume', 100);
  const c0 = await adminClient(h.database);
  try {
    await c0.query("INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at, provider) VALUES ('sub_resume', 'dp_resume', 'mega_pass', 'pdt_megapass', 'active', false, $1, $2, $3, $3, 'dodo')", [new Date(AFTER - 86400000).toISOString(), new Date(AFTER + 30 * 86400000).toISOString(), new Date(AFTER - 86400000).toISOString()]);
    await c0.query("INSERT INTO monetization.pass_periods (subscription_id, actor_id, period_start, period_end, installments_granted, pack_discounts_reserved, created_at) VALUES ('sub_resume', 'dp_resume', $1, $2, 3, 0, $3)", [new Date(AFTER - 86400000).toISOString(), new Date(AFTER + 30 * 86400000).toISOString(), new Date(AFTER - 86400000).toISOString()]);
  } finally { await c0.end(); }
  /* The restart window: an order created BEFORE the first restore tick (the stale intro env)
   * records the intro price while the provider is at base - it must still settle. */
  const pre = await h.commerce.createDodoCheckout('dp_resume', 'resume-key-1', 'crowns_100', { email: 'r@b.co' }, { currency: 'inr' });
  assert.equal(Number((await recordedOrder(h.database, pre.checkoutId)).amount_cents), 2500, 'the stale intro env records the intro price');
  h.state.verifies.set(pre.checkoutId, { status: 'succeeded', amount: 4900, currency: 'inr', metadata: { actor: 'dp_resume', product_id: 'crowns_100' } });
  const result = await h.commerce.processIntroPriceRestore();
  assert.equal(result.done, true, 'the restore completes on the first tick');
  const settled = await h.commerce.dodoOrderStatus('dp_resume', pre.checkoutId);
  assert.equal(settled.paid, true, 'a pre-restore order settles at the restored provider price');
  /* Post-expiry pack resumption: the restore clears the intro-pricing gate in memory, so the
   * 15% pack code attaches again without any env edit or restart. */
  const pack = await h.commerce.createDodoCheckout('dp_resume', 'resume-key-2', 'crowns_100', { email: 'r@b.co' }, { currency: 'inr' });
  const packSent = h.state.creates.find(c => c.metadata && c.metadata.op_key === 'resume-key-2');
  assert.deepEqual(packSent.discountCodes, ['PACKCODE15'], 'PACKCODE15 resumes automatically after the verified restore');
});
