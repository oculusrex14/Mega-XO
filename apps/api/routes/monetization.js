'use strict';

/* LR12 (2026-10-16): the authenticated player surface for the V5 commerce service. This file holds
 * NO economic logic and NO database handle: every command forwards through the SIGNED commerce
 * ingress (context.monetization.command -> core-gateway -> /ingress/commerce/command -> the
 * Core-owned commerce service on its core_runtime pool). The API tier never touches
 * monetization.* tables and never mints a grant: the only shapes here are session resolution,
 * input projection, and the sanitized reply.
 *
 * IDEMPOTENCY: mutating routes take the CLIENT'S durable operation key (Idempotency-Key /
 * X-Opkey header, or an explicit body.key). Retrying after an ambiguous timeout must reuse the
 * same key or the same economic action could settle twice. A body.key (the commerce-native key
 * grammar) wins over the header when both are present.
 *
 * ADMOB SSV: GET/POST /api/monetization/admob-ssv is actor-free by design — Google's server calls
 * it; the provider proof inside is verified by the commerce service (verifyAd) BEFORE any grant,
 * and the grant binds to the ticket's actor. Fail-closed: an absent/unconfigured verifier answers
 * ADS_UNAVAILABLE, never a silent OK. */

/* The shared reply helpers. WITHOUT this import every sendJson call below is a ReferenceError
 * that the route's own catch cannot classify, so the request falls through to the API's 404 and
 * NO monetization surface (including the webhooks and the SSV callback) can ever answer. */
const { sendJson } = require('./helpers');

/* SEC-V52: one admission gate for the three actor-free callback lanes. A RATE_LIMITED refusal is
 * answered here (429 + Retry-After + no-store) so the callback is never acknowledged with 200 and
 * never reaches the provider verification or the Core round-trip; any other admission error
 * propagates to the route catch with its own stable code and status. */
async function admitCallback(lane, req, res, provider) {
  if (typeof lane.checkCallback !== 'function') fail('CALLBACK_ADMISSION_UNAVAILABLE', 503);
  try {
    await lane.checkCallback(req, provider);
    return true;
  } catch (error) {
    if (error && error.code === 'RATE_LIMITED') {
      const headers = { 'Cache-Control': 'no-store' };
      if (Number.isFinite(error.retryAfter)) headers['Retry-After'] = String(Math.max(1, Math.ceil(error.retryAfter)));
      sendJson(res, 429, { error: 'RATE_LIMITED' }, headers);
      return false;
    }
    throw error;
  }
}

const CACHE_CONTROL = 'private, no-store';

function fail(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status || 400;
  throw error;
}

function resolveMonetization(context) {
  const lane = context && context.monetization;
  if (lane && typeof lane.command === 'function') return lane;
  fail('MONETIZATION_UNAVAILABLE', 503);
}

async function actorOf(context, req) {
  const { resolveAuth } = require('./helpers');
  const { actor } = await resolveAuth(context, req);
  if (typeof actor === 'string' && actor) return actor;
  fail('AUTH_REQUIRED', 401);
}

function opKeyFrom(req, body) {
  /* Contract (LR12): a body.key (the commerce-native key grammar) WINS over the header when both
   * are present. Read the body first so the documented precedence actually holds — a mismatched
   * header can otherwise silently drift the idempotency identity. */
  if (body && typeof body.key === 'string' && body.key.length > 0) return body.key.slice(0, 160);
  const header = req.headers && (req.headers['idempotency-key'] || req.headers['x-opkey']);
  if (typeof header === 'string' && header.length > 0) return header.slice(0, 160);
  return undefined;
}

const ROUTES = Object.freeze({
  '/api/monetization/status': { op: 'status', method: 'GET', args: [] },
  '/api/monetization/ticket': { op: 'ticket', method: 'POST', args: ['kind', 'platform'] },
  '/api/monetization/claim': { op: 'claim', method: 'POST', args: [] },
  '/api/monetization/permit': { op: 'permit', method: 'POST', args: ['platform'] },
  '/api/monetization/purchase': { op: 'purchase', method: 'POST', args: ['evidence', 'restore'] },
  '/api/monetization/cosmetic': { op: 'cosmetic', method: 'POST', args: ['itemId'] },
});

/* LR13: the Cashfree customer-contact grammar (the legacy cashfree/order route). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9]{10,15}$/;

async function handleMonetizationRoute(context, req, res) {
  const method = (req.method || 'GET').toUpperCase();
  let pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (!pathname.startsWith('/api/monetization/')) return false;

  try {
    const lane = resolveMonetization(context);

    if (pathname === '/api/monetization/admob-ssv') {
      if (method !== 'GET' && method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
      /* SEC-V52-SSV-UNLIMITED-DOS: the actor-free callback lanes admit by canonical source IP
       * BEFORE any signature work or Core round-trip. Missing admission protection is a 503, and
       * an exhausted or unavailable budget never acknowledges the callback with 200. */
      if (!(await admitCallback(lane, req, res, 'admob'))) return true;
      /* The raw SSV QUERY STRING is exactly what Google signs — never re-encode or reorder it. */
      /* The raw SSV bytes are exactly what Google signs; never re-encode, reorder or
       * URL-normalize them: slice the query straight out of the raw target instead of
       * new URL(), whose .search normalizes legal characters and changes signed bytes. */
      const rawTarget = String(req.url || '/');
      const queryStart = rawTarget.indexOf('?');
      const raw = method === 'GET'
        ? (queryStart >= 0 ? rawTarget.slice(queryStart + 1) : '')
        : (typeof req.body === 'string' ? req.body : '');
      if (!raw) fail('INVALID_SSV_PAYLOAD', 400);
      /* The SSV callback is actor-free: it MUST go through the dedicated signed gateway path
       * (commerceSsv -> /ingress/commerce/ssv), not the player command surface — commerceCommand
       * has no actor to sign with and drops the raw payload entirely. */
      if (typeof lane.ssv !== 'function') fail('MONETIZATION_UNAVAILABLE', 503);
      const result = await lane.ssv(raw);
      sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
      return true;
    }

    /* LR13: the Cashfree web-commerce surfaces. Order creation is session-bound (the actor is
     * the payer; the catalog price is server-side); the webhook is actor-free and verifies the
     * HMAC over the EXACT raw bytes Cashfree signed; the status poll is session-bound and hides
     * other actors' orders. */
    if (pathname === '/api/monetization/cashfree/order') {
      if (method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
      const actor = await actorOf(context, req);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      if (!EMAIL.test(email) || email.length > 254 || !PHONE.test(phone)) fail('INVALID_CUSTOMER_DETAILS', 400);
      if (typeof body.product !== 'string' || !body.product) fail('INVALID_PRODUCT', 400);
      const key = opKeyFrom(req, body);
      if (!key) fail('IDEMPOTENCY_KEY_REQUIRED', 400);
      const result = await lane.command({ actor, op: 'cashfree_create', opKey: key, key, productId: body.product, customer: { email, phone } });
      sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
      return true;
    }

    if (pathname === '/api/monetization/cashfree/status') {
      if (method !== 'GET') fail('METHOD_NOT_ALLOWED', 405);
      const actor = await actorOf(context, req);
      const orderId = new URL(req.url || '/', 'http://localhost').searchParams.get('order_id') || '';
      if (!orderId) fail('ORDER_NOT_FOUND', 404);
      const result = await lane.command({ actor, op: 'cashfree_status', opKey: 'cashfree-status', orderId });
      sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
      return true;
    }

    if (pathname === '/api/monetization/cashfree/webhook') {
      if (method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
      if (!(await admitCallback(lane, req, res, 'cashfree'))) return true;
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!raw) fail('INVALID_WEBHOOK', 400);
      if (typeof lane.cashfreeWebhook !== 'function') fail('MONETIZATION_UNAVAILABLE', 503);
      const result = await lane.cashfreeWebhook({
        raw,
        timestamp: String((req.headers && req.headers['x-webhook-timestamp']) || ''),
        signature: String((req.headers && req.headers['x-webhook-signature']) || ''),
      });
      sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
      return true;
    }

    /* C05: the Polar surfaces (the owner decision: Polar = primary global + Indian fallback).
     * Checkout creation is session-bound with the SERVER-AUTHORITATIVE catalog price id; the
     * webhook is actor-free and verifies the Standard Webhooks HMAC over the EXACT raw bytes;
     * the status poll is session-bound and hides other actors' orders. */
    if (pathname === '/api/monetization/polar/checkout') {
      if (method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
      const actor = await actorOf(context, req);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      if (typeof body.product !== 'string' || !body.product) fail('INVALID_PRODUCT', 400);
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail('INVALID_CUSTOMER_DETAILS', 400);
      const key = opKeyFrom(req, body);
      if (!key) fail('IDEMPOTENCY_KEY_REQUIRED', 400);
      const result = await lane.command({ actor, op: 'polar_create', opKey: key, key, productId: body.product, customer: email ? { email } : undefined });
      sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
      return true;
    }

    if (pathname === '/api/monetization/polar/status') {
      if (method !== 'GET') fail('METHOD_NOT_ALLOWED', 405);
      const actor = await actorOf(context, req);
      const checkoutId = new URL(req.url || '/', 'http://localhost').searchParams.get('checkout_id') || '';
      if (!checkoutId) fail('ORDER_NOT_FOUND', 404);
      const result = await lane.command({ actor, op: 'polar_status', opKey: 'polar-status', checkoutId });
      sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
      return true;
    }

    if (pathname === '/api/monetization/polar/webhook') {
      if (method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
      if (!(await admitCallback(lane, req, res, 'polar'))) return true;
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!raw) fail('INVALID_WEBHOOK', 400);
      if (typeof lane.polarWebhook !== 'function') fail('MONETIZATION_UNAVAILABLE', 503);
      const result = await lane.polarWebhook({
        raw,
        id: String((req.headers && req.headers['webhook-id']) || ''),
        timestamp: String((req.headers && req.headers['webhook-timestamp']) || ''),
        signature: String((req.headers && req.headers['webhook-signature']) || ''),
      });
      sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
      return true;
    }

    const spec = ROUTES[pathname];
    if (!spec) { sendJson(res, 404, { error: 'NOT_FOUND' }); return true; }
    if (spec.method !== method) fail('METHOD_NOT_ALLOWED', 405);

    const actor = await actorOf(context, req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const command = { actor, op: spec.op };
    if (method === 'POST') command.opKey = opKeyFrom(req, body);
    else command.opKey = opKeyFrom(req, {}) || 'commerce-status';
    for (const name of spec.args) {
      if (Object.prototype.hasOwnProperty.call(body, name)) command[name] = body[name];
    }
    const result = await lane.command(command);
    sendJson(res, 200, result, { 'Cache-Control': CACHE_CONTROL });
    return true;
  } catch (error) {
    if (error && (error.status || (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code)))) {
      sendJson(res, error.status || 400, { error: error.code || error.message });
      return true;
    }
    return false; /* transport/unknown faults fall through to the API's own handler */
  }
}

module.exports = { handleMonetizationRoute };
