'use strict';

/* 2026-10-19: the Dodo Payments provider for the V5 commerce lane (owner decision: Dodo is the
 * PRIMARY web checkout; the Polar adapter stays composed but dormant). Same DB-free contract as
 * the Polar provider: the browser only ever sees a checkout URL, the recorded order row is the
 * settlement authority, and a webhook alone never grants - the commerce service re-verifies
 * through GET /payments/{id} (and the session) before any economic transaction.
 *
 * Verified against the live API and docs (2026-10-19):
 * - POST /checkouts {product_cart:[{product_id,quantity}], customer, billing_address.country,
 *   billing_currency, discount_codes, metadata, return_url} -> {session_id, checkout_url}.
 * - GET /checkouts/{session_id} -> {id, payment_id, payment_status, ...} (nulls pre-payment).
 * - GET /payments/{payment_id} -> {status, total_amount, currency, metadata, subscription_id}.
 *   Checkout metadata travels onto the payment, so the recorded order row is resolvable from the
 *   verified payment without trusting any webhook payload field.
 * - GET /subscriptions/{id} -> {status, next_billing_date, previous_billing_date, ...}.
 * - Webhooks use the Standard Webhooks scheme (webhook-id/webhook-timestamp/webhook-signature,
 *   base64 HMAC-SHA256 over "id.timestamp.rawBody" with the whsec_ secret) - the same scheme the
 *   Polar adapter verifies, with a 5-minute timestamp tolerance.
 * - Checkout metadata values may be strings/numbers/booleans only. */
const crypto = require('node:crypto');

const LIVE_BASE = 'https://live.dodopayments.com';
const TEST_BASE = 'https://test.dodopayments.com';
const PRODUCT_ID = /^pdt_[A-Za-z0-9]{6,64}$/;
const SESSION_ID = /^cks_[A-Za-z0-9]{6,80}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,80}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{6,80}$/;
const SUPPORTED_CURRENCIES = new Set(['usd', 'inr', 'eur', 'gbp']);
const METADATA_KEY = /^[A-Za-z0-9_]{1,64}$/;

function createDodoProvider({ apiKey, webhookSecret, mode = 'live', fetchImpl = null } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 16) throw Error('DODO_CONFIG');
  if (!['live', 'test'].includes(mode)) throw Error('DODO_CONFIG');
  if (webhookSecret !== undefined && webhookSecret !== null && (typeof webhookSecret !== 'string' || webhookSecret.length < 16)) throw Error('DODO_CONFIG');
  const http = fetchImpl || ((input, init) => fetch(input, init));
  const base = mode === 'test' ? TEST_BASE : LIVE_BASE;
  const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };

  async function call(path, method, body) {
    const response = await http(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { throw Error('DODO_BAD_RESPONSE'); }
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'DODO_AUTH' : 'DODO_HTTP_' + response.status);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('DODO_BAD_RESPONSE');
    return parsed;
  }

  function cleanMetadata(metadata) {
    if (metadata === undefined || metadata === null) return undefined;
    if (typeof metadata !== 'object' || Array.isArray(metadata)) throw Error('DODO_METADATA_INVALID');
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!METADATA_KEY.test(key) || value === undefined || value === null) throw Error('DODO_METADATA_INVALID');
      if (typeof value === 'string') { if (value.length > 512) throw Error('DODO_METADATA_INVALID'); out[key] = value; }
      else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      else if (typeof value === 'boolean') out[key] = value;
      else throw Error('DODO_METADATA_INVALID');
    }
    return out;
  }

  return {
    mode,
    isProductId: value => typeof value === 'string' && PRODUCT_ID.test(value),
    isSessionId: value => typeof value === 'string' && SESSION_ID.test(value),
    supportedCurrency: value => (typeof value === 'string' && SUPPORTED_CURRENCIES.has(value.toLowerCase()) ? value.toLowerCase() : null),

    /* Server-side checkout creation: the browser only ever sees checkout.url. The product id and
     * the expected charge currency come from the SERVER-SIDE catalog, never a client value; the
     * actor/product/checkout binding rides the metadata so the independent re-verification can
     * resolve and validate the grant. */
    async createCheckout({ productId, actor, storeProductId, email, successUrl, metadata = {}, discountCodes = null, country = null, billingCurrency = null }) {
      if (!this.isProductId(productId)) throw Error('INVALID_PRODUCT_ID');
      if (typeof actor !== 'string' || !actor || actor.length > 160) throw Error('DODO_METADATA_INVALID');
      if (typeof storeProductId !== 'string' || !storeProductId) throw Error('DODO_METADATA_INVALID');
      const cart = [{ product_id: productId, quantity: 1 }];
      const body = { product_cart: cart, metadata: cleanMetadata({ ...metadata, actor, product_id: storeProductId }) };
      if (email !== undefined && email !== null) {
        if (typeof email !== 'string' || email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('INVALID_CUSTOMER_DETAILS');
        body.customer = { email };
      }
      if (typeof successUrl === 'string' && successUrl.startsWith('https://')) body.return_url = successUrl;
      if (billingCurrency !== null && billingCurrency !== undefined) {
        if (!this.supportedCurrency(billingCurrency)) throw Error('DODO_CURRENCY_UNSUPPORTED');
        body.billing_currency = billingCurrency.toUpperCase();
        /* A billing currency only applies to a country whose local methods settle in it; the
         * country rides along so Dodo's checkout starts from the player's region. */
        if (typeof country === 'string' && /^[A-Z]{2}$/.test(country)) body.billing_address = { country };
      }
      if (Array.isArray(discountCodes) && discountCodes.length) {
        if (discountCodes.some(code => typeof code !== 'string' || code.length < 3 || code.length > 64)) throw Error('DODO_DISCOUNT_INVALID');
        body.discount_codes = discountCodes;
      }
      const session = await call('/checkouts', 'POST', body);
      if (!this.isSessionId(session.session_id) || typeof session.checkout_url !== 'string' || !session.checkout_url.startsWith('https://')) throw Error('DODO_BAD_RESPONSE');
      return { checkoutId: session.session_id, checkoutUrl: session.checkout_url };
    },

    /* The independent re-verification: status, charged amount, currency AND the metadata binding
     * are all RETURNED by Dodo, and settlement re-checks them against the recorded order row.
     * Unpaid/failed sessions answer with their status and no amount; only a succeeded payment
     * returns an authoritative charge. */
    async verifyCheckout(sessionId) {
      if (!this.isSessionId(sessionId)) throw Error('ORDER_NOT_FOUND');
      const session = await call('/checkouts/' + encodeURIComponent(sessionId), 'GET');
      const paymentStatus = typeof session.payment_status === 'string' ? session.payment_status : null;
      const paymentId = typeof session.payment_id === 'string' && PAYMENT_ID.test(session.payment_id) ? session.payment_id : null;
      if (paymentStatus !== 'succeeded' || !paymentId) return { status: paymentStatus || 'pending', checkoutId: sessionId };
      const payment = await call('/payments/' + encodeURIComponent(paymentId), 'GET');
      const amount = Number(payment.total_amount);
      const currency = this.supportedCurrency(payment.currency);
      if (!Number.isSafeInteger(amount) || amount <= 0 || !currency) throw Error('DODO_BAD_RESPONSE');
      const subscriptionId = typeof payment.subscription_id === 'string' && payment.subscription_id ? payment.subscription_id.slice(0, 160) : null;
      return {
        status: payment.status === 'succeeded' ? 'succeeded' : String(payment.status || 'unknown'),
        amount,
        currency,
        metadata: payment.metadata && typeof payment.metadata === 'object' && !Array.isArray(payment.metadata) ? payment.metadata : {},
        subscriptionId,
        paymentId,
        checkoutId: sessionId,
      };
    },

    /* The independent subscription re-read: lifecycle status and the period window come from
     * Dodo, so reconciliation decisions never rest on webhook payload fields alone. */
    async verifySubscription(subscriptionId) {
      if (typeof subscriptionId !== 'string' || !SUBSCRIPTION_ID.test(subscriptionId)) throw Error('ORDER_NOT_FOUND');
      const sub = await call('/subscriptions/' + encodeURIComponent(subscriptionId), 'GET');
      if (typeof sub.status !== 'string') throw Error('DODO_BAD_RESPONSE');
      const periodStart = typeof sub.previous_billing_date === 'string' ? sub.previous_billing_date : (typeof sub.created_at === 'string' ? sub.created_at : null);
      const periodEnd = typeof sub.next_billing_date === 'string' ? sub.next_billing_date : null;
      return {
        status: sub.status,
        productId: typeof sub.product_id === 'string' ? sub.product_id : '',
        cancelAtPeriodEnd: sub.cancel_at_next_billing_date === true,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        metadata: sub.metadata && typeof sub.metadata === 'object' && !Array.isArray(sub.metadata) ? sub.metadata : {},
      };
    },

    /* The standalone payment re-read (the webhook trigger path): the metadata binding, charged
     * amount and currency all come back from the documented Payment API, never the payload. */
    async verifyPayment(paymentId) {
      if (typeof paymentId !== 'string' || !PAYMENT_ID.test(paymentId)) throw Error('ORDER_NOT_FOUND');
      const payment = await call('/payments/' + encodeURIComponent(paymentId), 'GET');
      const amount = Number(payment.total_amount);
      const currency = this.supportedCurrency(payment.currency);
      if (!Number.isSafeInteger(amount) || amount <= 0 || !currency) throw Error('DODO_BAD_RESPONSE');
      return {
        status: typeof payment.status === 'string' ? payment.status : 'unknown',
        amount,
        currency,
        metadata: payment.metadata && typeof payment.metadata === 'object' && !Array.isArray(payment.metadata) ? payment.metadata : {},
        subscriptionId: typeof payment.subscription_id === 'string' && payment.subscription_id ? payment.subscription_id.slice(0, 160) : null,
        paymentId,
      };
    },

    /* MXA-PROMO-RESTORE (2026-10-19): verify-then-patch one one-time product back to its base
     * price (the USD base price plus the INR localized rule), mirroring the dodo-price-window
     * flip procedure. Idempotent per call - a verified product returns 'already' without any
     * write - and every write is re-read afterwards, so a silently failed patch throws instead
     * of reporting success. Only ever called for once-products; the Mega Pass price never flips
     * because its promo discount is the customer-entered code on a base-priced subscription. */
    async restoreProductPrice({ dodoProductId, base }) {
      if (!this.isProductId(dodoProductId) || !base || typeof base !== 'object' || Array.isArray(base)) throw Error('DODO_RESTORE_INVALID');
      const usd = Number(base.usd);
      if (!Number.isSafeInteger(usd) || usd <= 0) throw Error('DODO_RESTORE_INVALID');
      const inrTarget = Number.isSafeInteger(Number(base.inr)) && Number(base.inr) > 0 ? Number(base.inr) : null;
      const product = await call('/products/' + encodeURIComponent(dodoProductId), 'GET');
      const currentUsd = product && product.price ? Number(product.price.price) : null;
      let inrRule = null;
      if (inrTarget !== null) {
        const localized = await call('/products/' + encodeURIComponent(dodoProductId) + '/localized-prices', 'GET');
        const rules = localized && Array.isArray(localized.items) ? localized.items : [];
        inrRule = rules.find(rule => String(rule.currency).toUpperCase() === 'INR' && rule.id) || null;
      }
      const usdOk = currentUsd === usd;
      const inrOk = inrTarget === null ? true : (inrRule ? Number(inrRule.amount) === inrTarget : false);
      if (usdOk && inrOk) return 'already';
      if (!usdOk) await call('/products/' + encodeURIComponent(dodoProductId), 'PATCH', { price: { type: 'one_time_price', currency: 'USD', price: usd } });
      if (!inrOk) {
        if (!inrRule) await call('/products/' + encodeURIComponent(dodoProductId) + '/localized-prices', 'POST', { currency: 'INR', country_code: 'IN', amount: inrTarget });
        else await call('/products/' + encodeURIComponent(dodoProductId) + '/localized-prices/' + encodeURIComponent(inrRule.id), 'PATCH', { amount: inrTarget });
      }
      const after = await call('/products/' + encodeURIComponent(dodoProductId), 'GET');
      const afterUsd = after && after.price ? Number(after.price.price) : null;
      if (afterUsd !== usd) throw Error('DODO_RESTORE_VERIFY_FAILED');
      if (inrTarget !== null) {
        const afterLocalized = await call('/products/' + encodeURIComponent(dodoProductId) + '/localized-prices', 'GET');
        const afterRules = afterLocalized && Array.isArray(afterLocalized.items) ? afterLocalized.items : [];
        const afterInr = afterRules.find(rule => String(rule.currency).toUpperCase() === 'INR');
        if (!afterInr || Number(afterInr.amount) !== inrTarget) throw Error('DODO_RESTORE_VERIFY_FAILED');
      }
      return 'patched';
    },

    /* Standard Webhooks verification (shared scheme with Polar): entries are "v1,<base64>";
     * the signed content is id.timestamp.rawBody; the secret is base64 after the whsec_ prefix. */
    verifyWebhook({ id, timestamp, signature, rawBody, now = Date.now() }) {
      const whId = String(id || ''), ts = String(timestamp || ''), sig = String(signature || '');
      if (!whId || whId.length > 128 || !/^\d+$/.test(ts) || !sig) return false;
      if (Math.abs(now - Number(ts) * 1000) > 300000) return false;
      if (typeof rawBody !== 'string' || rawBody.length === 0 || rawBody.length > 262144) return false;
      if (!webhookSecret || typeof webhookSecret !== 'string') return false;
      const secret = webhookSecret.startsWith('whsec_') ? webhookSecret.slice(6) : webhookSecret;
      let key; try { key = Buffer.from(secret, 'base64'); } catch { return false; }
      if (key.length < 16) return false;
      const expected = crypto.createHmac('sha256', key).update(whId + '.' + ts + '.' + rawBody).digest('base64');
      const versioned = [...sig.matchAll(/(?:^|[\s,])v1,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
      const bare = versioned.length ? [] : sig.split(' ').filter(Boolean);
      for (const candidate of [...versioned, ...bare]) {
        const a = Buffer.from(expected), b = Buffer.from(candidate);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
      }
      return false;
    },
  };
}

module.exports = { createDodoProvider, SUPPORTED_CURRENCIES, PRODUCT_ID, SESSION_ID, PAYMENT_ID, SUBSCRIPTION_ID };
