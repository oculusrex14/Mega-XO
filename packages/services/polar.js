'use strict';

/* C05 (2026-10-16): the Polar provider for the V5 commerce lane. The owner decision
 * (2026-10-16): Polar is the PRIMARY GLOBAL payment provider and the INDIAN FALLBACK behind
 * Cashfree; no live charge without explicit owner authorization - the adapter composes behind
 * feature flags and is dormant unless POLAR_ACCESS_TOKEN + the price map are configured.
 *
 * Like the Cashfree port, this file is DB-FREE: the browser only ever sees a checkout URL, the
 * recorded order row is the settlement authority, and a webhook alone never grants - the
 * commerce service re-verifies through GET /v1/checkouts/{id} before any economic transaction.
 * Webhook signatures follow the Standard Webhooks scheme Polar uses (webhook-id/timestamp/
 * signature headers, base64 HMAC-SHA256 over "id.timestamp.rawBody" with the base64-decoded
 * whsec secret). */
const crypto = require('node:crypto');
const API_BASE = 'https://api.polar.sh';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE_PATTERN = /^[A-Za-z0-9._-]{1,160}$/;

function createPolarProvider({ accessToken, organizationId, apiBase, webhookSecret, fetchImpl = null } = {}) {
  if (!accessToken || typeof accessToken !== 'string') throw Error('POLAR_CONFIG');
  if (!organizationId || !UUID_V4.test(organizationId)) throw Error('POLAR_CONFIG');
/* (url, init) BOTH reach native fetch: a wrapper that dropped the second argument
   * silently downgraded every provider call to a bare GET. */
  const http = fetchImpl || ((input, init) => fetch(input, init));
  const base = apiBase || API_BASE;
  const headers = { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
  async function call(path, method, body) {
    const response = await http(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { throw Error('POLAR_BAD_RESPONSE'); }
    if (!response.ok) throw Error(response.status === 401 || response.status === 403 ? 'POLAR_AUTH' : 'POLAR_HTTP_' + response.status);
    if (!parsed || typeof parsed !== 'object') throw Error('POLAR_BAD_RESPONSE');
    return parsed;
  }
  return {
    organizationId,
    isPriceId: value => typeof value === 'string' && PRICE_PATTERN.test(value),
    /* Server-side checkout creation: the browser only ever sees checkout.url. The price id comes
     * from the SERVER-SIDE catalog map, never a client value, and the actor/product ride the
     * metadata so an independent re-verification can bind the grant. */
    async createCheckout({ priceId, actor, productId, email, successUrl, metadata = {} }) {
      if (!this.isPriceId(priceId)) throw Error('INVALID_PRICE_ID');
      if (!UUID_V4.test(priceId)) throw Error('INVALID_PRICE_ID');
      const checkout = await call('/v1/checkouts', 'POST', {
        products: [priceId],
        customer_email: typeof email === 'string' && email ? email : undefined,
        success_url: typeof successUrl === 'string' && successUrl ? successUrl : undefined,
        metadata: { actor: String(actor), product_id: String(productId), ...metadata },
      });
      if (typeof checkout.id !== 'string' || !UUID_V4.test(checkout.id) || typeof checkout.url !== 'string' || !checkout.url.startsWith('https://')) throw Error('POLAR_BAD_RESPONSE');
      return { checkoutId: checkout.id, checkoutUrl: checkout.url };
    },
    /* The independent re-verification: status, amount, currency and the metadata binding are all
     * RETURNED by Polar, and settlement re-checks them against the recorded order row. */
    async verifyCheckout(checkoutId) {
      if (typeof checkoutId !== 'string' || !UUID_V4.test(checkoutId)) throw Error('ORDER_NOT_FOUND');
      const checkout = await call('/v1/checkouts/' + encodeURIComponent(checkoutId), 'GET');
      const status = typeof checkout.status === 'string' ? checkout.status : '';
      const price = checkout && checkout.product_price && typeof checkout.product_price === 'object' ? checkout.product_price : {};
      const amount = Number(price.price_amount);
      const currency = String(price.price_currency || '').toLowerCase();
      const metadata = checkout && typeof checkout.metadata === 'object' && checkout.metadata ? checkout.metadata : {};
      if (!status) throw Error('POLAR_BAD_RESPONSE');
      return { status, amount, currency, metadata, checkoutId: checkout.id || checkoutId };
    },
    /* B2: the independent subscription re-read. The lifecycle status, the recorded period
     * window and the metadata binding all come back from Polar, so reconciliation decisions
     * never rest on webhook payload fields alone. */
    async verifySubscription(subscriptionId) {
      if (typeof subscriptionId !== 'string' || !subscriptionId || subscriptionId.length > 160) throw Error('ORDER_NOT_FOUND');
      const sub = await call('/v1/subscriptions/' + encodeURIComponent(subscriptionId), 'GET');
      if (!sub || typeof sub.status !== 'string') throw Error('POLAR_BAD_RESPONSE');
      const period = sub.current_period && typeof sub.current_period === 'object' ? sub.current_period : {};
      return {
        status: sub.status,
        productId: typeof sub.product_id === 'string' ? sub.product_id : (sub.product && typeof sub.product.id === 'string' ? sub.product.id : ''),
        priceId: typeof sub.price_id === 'string' ? sub.price_id : (sub.price && typeof sub.price.id === 'string' ? sub.price.id : ''),
        cancelAtPeriodEnd: sub.cancel_at_period_end === true,
        currentPeriodStart: typeof period.start === 'string' ? period.start : null,
        currentPeriodEnd: typeof period.end === 'string' ? period.end : null,
        metadata: sub.metadata && typeof sub.metadata === 'object' ? sub.metadata : {},
      };
    },

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
      /* Standard Webhooks signature framing: space-separated entries, each "v1,<base64 sig>";
       * some senders comma-separate the list. Version-prefixed candidates take precedence; a bare
       * space-separated HMAC stays accepted for the synthetic fixtures. Any one match verifies. */
      const versioned = [...sig.matchAll(/(?:^|\s)v1,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
      const bare = versioned.length ? [] : sig.split(' ').filter(Boolean);
      for (const candidate of [...versioned, ...bare]) {
        const a = Buffer.from(expected), b = Buffer.from(candidate);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
      }
      return false;
    },
  };
}

module.exports = { createPolarProvider, UUID_V4, PRICE_PATTERN };
