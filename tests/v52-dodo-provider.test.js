'use strict';
/* The Dodo provider contract (2026-10-19): config validation, the checkout/session request shape,
 * the independent payment re-verification, subscription normalization and the Standard Webhooks
 * HMAC — all against a fetch stub, never the live API. Amounts/currencies mirror the live API
 * shapes documented at docs.dodopayments.com and probed on 2026-10-19. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDodoProvider } = require('../packages/services/dodo.js');

const API_KEY = 'test-key-with-sufficient-length-2026';
const PRODUCT = 'pdt_testProduct01';
const SESSION = 'cks_testSession001';
const PAYMENT = 'pay_testPayment001';
const SUBSCRIPTION = 'sub_testSubscrip01';

function provider(handlers) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null });
    const path = String(input).replace(/^https:\/\/[a-z]+\.dodopayments\.com/, '');
    const handler = handlers[path] || (() => { throw Error('UNROUTED ' + path); });
    return { ok: true, status: 200, text: async () => JSON.stringify(handler(calls.at(-1))) };
  };
  const p = createDodoProvider({ apiKey: API_KEY, webhookSecret: 'whsec_' + Buffer.from('test-secret-2026-2026-2026-2026').toString('base64'), mode: 'test', fetchImpl });
  return { p, calls };
}

test('config validation refuses incomplete or invalid configuration', () => {
  assert.throws(() => createDodoProvider({}), /DODO_CONFIG/);
  assert.throws(() => createDodoProvider({ apiKey: 'short' }), /DODO_CONFIG/);
  assert.throws(() => createDodoProvider({ apiKey: API_KEY, mode: 'staging' }), /DODO_CONFIG/);
  assert.throws(() => createDodoProvider({ apiKey: API_KEY, webhookSecret: 'x' }), /DODO_CONFIG/);
});

test('createCheckout posts the product cart, currency, metadata and returns the hosted url', async () => {
  const { p, calls } = provider({ '/checkouts': () => ({ session_id: SESSION, checkout_url: 'https://checkout.dodopayments.com/session/' + SESSION }) });
  const result = await p.createCheckout({ productId: PRODUCT, actor: 'actor-1', storeProductId: 'crowns_100', email: 'player@example.com', successUrl: 'https://megaxo.online', metadata: { request_id: 'req-1', op_key: 'op-1' }, billingCurrency: 'inr', country: 'IN' });
  assert.equal(result.checkoutId, SESSION);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body.product_cart, [{ product_id: PRODUCT, quantity: 1 }]);
  assert.equal(calls[0].body.billing_currency, 'INR');
  assert.deepEqual(calls[0].body.billing_address, { country: 'IN' });
  assert.equal(calls[0].body.metadata.actor, 'actor-1');
  assert.equal(calls[0].body.metadata.product_id, 'crowns_100');
  await assert.rejects(() => p.createCheckout({ productId: 'pdt_bad', actor: 'a', storeProductId: 'x' }), /INVALID_PRODUCT_ID/);
  await assert.rejects(() => p.createCheckout({ productId: PRODUCT, actor: 'a', storeProductId: 'x', metadata: { bad: { nested: true } } }), /DODO_METADATA_INVALID/);
});

test('verifyCheckout returns pending for unpaid sessions and verifies the charge on the payment', async () => {
  const { p } = provider({
    ['/checkouts/' + SESSION]: () => ({ id: SESSION, payment_id: null, payment_status: null, created_at: '2026-10-19T00:00:00Z' }),
  });
  const pending = await p.verifyCheckout(SESSION);
  assert.equal(pending.status, 'pending');
});

test('a succeeded session verifies through the documented payment object', async () => {
  const { p, calls } = provider({
    ['/checkouts/' + SESSION]: () => ({ id: SESSION, payment_id: PAYMENT, payment_status: 'succeeded', created_at: '2026-10-19T00:00:00Z' }),
    ['/payments/' + PAYMENT]: () => ({ payment_id: PAYMENT, status: 'succeeded', total_amount: 2500, currency: 'INR', metadata: { actor: 'actor-1', product_id: 'crowns_525', op_key: 'op-9' }, subscription_id: null, product_cart: [{ product_id: PRODUCT, quantity: 1 }] }),
  });
  const verified = await p.verifyCheckout(SESSION);
  assert.equal(verified.status, 'succeeded');
  assert.equal(verified.amount, 2500);
  assert.equal(verified.currency, 'inr');
  assert.equal(verified.metadata.op_key, 'op-9');
  assert.equal(calls[0].url.includes('/checkouts/'), true);
  assert.equal(calls[1].url.includes('/payments/'), true);
});

test('verifyPayment normalizes the standalone payment re-read and fails closed on bad shapes', async () => {
  const { p } = provider({
    ['/payments/' + PAYMENT]: () => ({ payment_id: PAYMENT, status: 'succeeded', total_amount: 99, currency: 'USD', metadata: { actor: 'a' } }),
  });
  const verified = await p.verifyPayment(PAYMENT);
  assert.equal(verified.amount, 99);
  assert.equal(verified.currency, 'usd');
  await assert.rejects(() => p.verifyPayment('pay_bad'), /ORDER_NOT_FOUND/);
});

test('verifySubscription normalizes the lifecycle status and the billing window', async () => {
  const { p } = provider({
    ['/subscriptions/' + SUBSCRIPTION]: () => ({ subscription_id: SUBSCRIPTION, status: 'active', product_id: PRODUCT, cancel_at_next_billing_date: true, previous_billing_date: '2026-10-01T00:00:00Z', next_billing_date: '2026-11-01T00:00:00Z', metadata: { actor: 'actor-1' } }),
  });
  const verified = await p.verifySubscription(SUBSCRIPTION);
  assert.equal(verified.status, 'active');
  assert.equal(verified.cancelAtPeriodEnd, true);
  assert.equal(verified.currentPeriodStart, '2026-10-01T00:00:00Z');
  assert.equal(verified.currentPeriodEnd, '2026-11-01T00:00:00Z');
});

test('webhook verification follows the Standard Webhooks scheme with a five-minute tolerance', () => {
  const secret = Buffer.from('standard-webhooks-test-secret-2026').toString('base64');
  const p = createDodoProvider({ apiKey: API_KEY, webhookSecret: 'whsec_' + secret, mode: 'test' });
  const id = 'msg_test_001';
  const timestamp = String(Math.floor(1750000000));
  const rawBody = JSON.stringify({ type: 'payment.succeeded', data: { payment_id: PAYMENT } });
  const signature = 'v1,' + crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(id + '.' + timestamp + '.' + rawBody).digest('base64');
  assert.equal(p.verifyWebhook({ id, timestamp, signature, rawBody, now: 1750000000000 }), true);
  assert.equal(p.verifyWebhook({ id, timestamp, signature: signature.replace(/.$/, 'A'), rawBody }), false);
  assert.equal(p.verifyWebhook({ id, timestamp: String(Number(timestamp) - 9999), signature, rawBody, now: 1750000000000 }), false, 'outside the five-minute tolerance is refused');
  assert.equal(p.verifyWebhook({ id, timestamp, signature, rawBody: rawBody + ' ' }), false);
});

test('the supported currency list matches the ledger CHECK and rejects unknown hints', () => {
  const p = createDodoProvider({ apiKey: API_KEY, mode: 'test' });
  assert.equal(p.supportedCurrency('INR'), 'inr');
  assert.equal(p.supportedCurrency('USD'), 'usd');
  assert.equal(p.supportedCurrency('BTC'), null);
});
