'use strict';

/* C05 offline proof for the Polar provider: least-privilege config, server-side checkout
 * creation (the browser only ever sees checkout.url), the independent re-verification shape,
 * and the Standard Webhooks signature binding over the exact raw bytes. No network, no DB. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createPolarProvider, UUID_V4 } = require('../packages/services/polar.js');

const ORG = 'fcb1c02a-b607-40bd-931f-bda18ea001c7';
const PRICE = '9571c5dc-e97e-4f0a-8fc3-fe3913460e04';
const SECRET_B64 = crypto.randomBytes(32).toString('base64');

function sign(secretB64, id, ts, rawBody) {
  const key = Buffer.from(secretB64, 'base64');
  return crypto.createHmac('sha256', key).update(id + '.' + ts + '.' + rawBody).digest('base64');
}

test('polar: configuration is complete or refused', () => {
  assert.throws(() => createPolarProvider({}), /POLAR_CONFIG/);
  assert.throws(() => createPolarProvider({ accessToken: 'tok', organizationId: 'not-a-uuid' }), /POLAR_CONFIG/);
});

test('polar: checkout creation is server-side with the actor binding in metadata', async () => {
  const calls = [];
  const provider = createPolarProvider({
    accessToken: 'polar_oat_test', organizationId: ORG,
    fetchImpl: async (url, init) => {
      /* MXA-ECO-007: checkout creation now resolves the parent product id first. */
      if (String(url).includes('/v1/products/')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: '9d3af6c2-0000-4000-8000-000000000009', prices: [{ id: PRICE }] }] }) };
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'c0a80101-0000-4000-8000-000000000001', url: 'https://polar.sh/checkout/x' }) };
    },
  });
  const created = await provider.createCheckout({ priceId: PRICE, actor: 'player_abc', productId: 'crowns_100', email: 'a@b.co', successUrl: 'https://megaxo.online' });
  assert.equal(created.checkoutUrl, 'https://polar.sh/checkout/x');
  assert.equal(UUID_V4.test(created.checkoutId), true);
  /* MXA-ECO-007: products carries the resolved PRODUCT id; the catalog price id is never sent. */
  assert.deepEqual(calls[0].body.products, ['9d3af6c2-0000-4000-8000-000000000009'], 'the price id is resolved to the provider product id server-side, never a client value');
  assert.equal(calls[0].body.metadata.actor, 'player_abc');
  assert.equal(calls[0].body.metadata.product_id, 'crowns_100');
  await assert.rejects(() => provider.createCheckout({ priceId: 'not-a-uuid', actor: 'x', productId: 'p' }), /INVALID_PRICE_ID/);
});

test('polar: verifyCheckout returns the independent status/amount/currency/metadata', async () => {
  const provider = createPolarProvider({
    accessToken: 'polar_oat_test', organizationId: ORG,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'c0a80101-0000-4000-8000-000000000001', status: 'succeeded', product_price: { price_amount: 99, price_currency: 'usd' }, metadata: { actor: 'player_abc', product_id: 'crowns_100' } }) }),
  });
  const verified = await provider.verifyCheckout('c0a80101-0000-4000-8000-000000000001');
  assert.deepEqual(verified, { status: 'succeeded', amount: 99, currency: 'usd', metadata: { actor: 'player_abc', product_id: 'crowns_100' }, checkoutId: 'c0a80101-0000-4000-8000-000000000001' });
  await assert.rejects(() => provider.verifyCheckout('garbage'), /ORDER_NOT_FOUND/);
});

test('polar: the webhook HMAC binds the exact raw bytes within a five minute window', () => {
  const provider = createPolarProvider({ accessToken: 'tok', organizationId: ORG, webhookSecret: 'whsec_' + SECRET_B64 });
  const raw = JSON.stringify({ type: 'order.paid', data: { id: 'ord-1' } });
  const id = 'msg_1';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(SECRET_B64, id, ts, raw);
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: sig, rawBody: raw }), true);
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: sig, rawBody: raw.replace('order.paid', 'order.refunded') }), false);
  assert.equal(provider.verifyWebhook({ id, timestamp: String(Math.floor(Date.now() / 1000) - 400), signature: sig, rawBody: raw }), false);
  assert.equal(provider.verifyWebhook({ id: '', timestamp: ts, signature: sig, rawBody: raw }), false);
  /* Polar may send space-separated multiple signatures: any one match verifies. */
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: 'bogus ' + sig, rawBody: raw }), true);
});

test('polar: the Standard Webhooks v1,-framed signatures verify (single, rotated and comma-separated) and wrong versions are refused', () => {
  const provider = createPolarProvider({ accessToken: 'tok', organizationId: ORG, webhookSecret: 'whsec_' + SECRET_B64 });
  const raw = JSON.stringify({ type: 'order.paid', data: { id: 'ord-1' } });
  const id = 'msg_v1';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(SECRET_B64, id, ts, raw);
  const other = sign(SECRET_B64, 'msg_x', ts, raw);
  /* Single v1 entry. */
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: 'v1,' + sig, rawBody: raw }), true);
  /* Rotated: a stale/other signature followed by the valid one. */
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: 'v1,' + other + ' v1,' + sig, rawBody: raw }), true);
  /* Comma-separated list (no whitespace between entries). */
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: 'v1,' + other + ',v1,' + sig, rawBody: raw }), true);
  /* A wrong-version-prefixed signature alone is refused (never falls through to a bare match). */
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: 'v2,' + sig, rawBody: raw }), false);
  /* A v1 framing over different bytes is refused. */
  assert.equal(provider.verifyWebhook({ id, timestamp: ts, signature: 'v1,' + sig, rawBody: raw.replace('order.paid', 'order.refunded') }), false);
});
