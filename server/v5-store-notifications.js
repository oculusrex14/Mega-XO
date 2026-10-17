'use strict';
/* MXA-ECO-005 (2026-10-18): the V5 trusted store-notification verification classes.
 *
 * DB-FREE like every commerce provider: credential verification and event parsing happen here,
 * and dedupe + refund route through the injected async callbacks the production entry wires to
 * the Core-owned commerce service. A notification NEVER grants: the only economic effect it can
 * trigger is the trusted refund/revocation workflow (commerce.refund), which is idempotent and
 * writes the permanent revocation tombstone under the receipt identity mutex.
 *
 * Google Play RTDN: the push request carries an OIDC token in the Authorization header (Google
 * documents RS256, iss accounts.google.com). The token is verified against Google's public JWKS;
 * the claim set must be fresh and bind to the configured push identity (service-account email
 * and/or the expected audience). One-time purchase notification type 2 is a CANCELED refund;
 * type 1 refunds only when the provider read shows the purchase was cancelled; a voided purchase
 * notification always refunds. The transaction id is sha256(purchaseToken), exactly the identity
 * server/google-play-billing.js normalize() grants under.
 *
 * Apple: the envelope and the inner transaction are both signedPayload JWS objects verified with
 * the SAME AppleStoreKit chain validation the purchase grant uses (x5c chain to the pinned
 * Apple roots). REFUND/REVOKE notification types and revoked transactions refund. */
const crypto = require('node:crypto');

const safeId = x => typeof x === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(x);
const sha = x => crypto.createHash('sha256').update(x).digest('hex');

class GooglePlayStoreNotifications {
  constructor({ packageName, serviceAccountEmail = null, expectedAudience = null, jwksUrl = 'https://www.googleapis.com/oauth2/v3/certs', billing = null, fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
    if (!safeId(packageName) || packageName.indexOf('.') < 1) throw Error('GOOGLE_RTDN_CONFIG');
    if (serviceAccountEmail === null && expectedAudience === null) throw Error('GOOGLE_RTDN_CONFIG');
    if (serviceAccountEmail !== null && (typeof serviceAccountEmail !== 'string' || serviceAccountEmail.length > 254 || serviceAccountEmail.indexOf('@') < 1)) throw Error('GOOGLE_RTDN_CONFIG');
    this.packageName = packageName; this.serviceAccountEmail = serviceAccountEmail; this.expectedAudience = expectedAudience;
    this.jwksUrl = jwksUrl; this.billing = billing;
    this.fetch = fetcher; this.now = now; this.keys = null;
  }
  async verifyPush(authorization) {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length > 8192) throw Error('INVALID_STORE_NOTIFICATION');
    const token = authorization.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 3) throw Error('INVALID_STORE_NOTIFICATION');
    const parse = p => { try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw Error('INVALID_STORE_NOTIFICATION'); } };
    const header = parse(parts[0]), claims = parse(parts[1]);
    if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256 || header.crit || header.jku || header.x5u) throw Error('INVALID_STORE_NOTIFICATION');
    let keys = this.keys;
    if (!keys) {
      const res = await this.fetch(this.jwksUrl, { signal: AbortSignal.timeout(5000) });
      const body = await res.json().catch(() => null);
      if (!body || !Array.isArray(body.keys)) throw Error('STORE_UNAVAILABLE');
      this.keys = body.keys; keys = this.keys;
    }
    const jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
    if (!jwk) throw Error('INVALID_STORE_NOTIFICATION');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw Error('INVALID_STORE_NOTIFICATION');
    const nowSec = Math.floor(this.now() / 1000);
    const issuers = ['https://accounts.google.com', 'accounts.google.com'];
    if (!issuers.includes(claims.iss) || !Number.isFinite(claims.exp) || claims.exp <= nowSec || !Number.isFinite(claims.iat) || claims.iat > nowSec + 30 || nowSec - claims.iat > 600) throw Error('INVALID_STORE_NOTIFICATION');
    const emailOk = this.serviceAccountEmail !== null && claims.email === this.serviceAccountEmail;
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(this.expectedAudience) : claims.aud === this.expectedAudience;
    if (!emailOk && !audOk) throw Error('INVALID_STORE_NOTIFICATION');
    return claims;
  }
  async handle(authorization, envelope, { seen, record, onRefund } = {}) {
    for (const fn of [seen, record, onRefund]) if (typeof fn !== 'function') throw Error('INVALID_STORE_NOTIFICATION');
    await this.verifyPush(authorization);
    const message = envelope && typeof envelope === 'object' ? envelope.message : null;
    const id = message && (message.messageId || message.message_id);
    if (!safeId(id) || typeof (message && message.data) !== 'string' || message.data.length > 131072) throw Error('INVALID_STORE_NOTIFICATION');
    if (await seen('google', id)) return { ok: true, duplicate: true };
    let body; try { body = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')); } catch { throw Error('INVALID_STORE_NOTIFICATION'); }
    if (!body || body.packageName !== this.packageName) throw Error('INVALID_STORE_NOTIFICATION');
    const one = body.oneTimeProductNotification, voided = body.voidedPurchaseNotification;
    const refunds = [];
    if (one) {
      if (![1, 2].includes(one.notificationType) || !safeId(one.sku) || typeof one.purchaseToken !== 'string' || one.purchaseToken.length > 4096) throw Error('INVALID_STORE_NOTIFICATION');
      if (one.notificationType === 2) refunds.push(sha(one.purchaseToken));
      else if (this.billing && typeof this.billing.currentByToken === 'function') {
        const current = await this.billing.currentByToken(one.purchaseToken).catch(() => null);
        const state = current && current.value && current.value.purchaseStateContext && current.value.purchaseStateContext.purchaseState;
        if (state === 'CANCELLED') refunds.push(sha(one.purchaseToken));
      }
    } else if (voided) {
      if (typeof voided.purchaseToken !== 'string' || voided.purchaseToken.length > 4096) throw Error('INVALID_STORE_NOTIFICATION');
      refunds.push(sha(voided.purchaseToken));
    } else throw Error('INVALID_STORE_NOTIFICATION');
    for (const transactionId of refunds) await onRefund('google', transactionId);
    await record('google', id);
    return { ok: true, duplicate: false, refunded: refunds.length };
  }
}

class AppleStoreNotificationsV5 {
  constructor({ storeKit, now = () => Date.now() } = {}) {
    if (!storeKit || typeof storeKit.verifyJws !== 'function' || typeof storeKit.inspectTransaction !== 'function') throw Error('APPLE_NOTIFICATION_CONFIG');
    this.storeKit = storeKit; this.now = now;
  }
  async handle(body, { seen, record, onRefund } = {}) {
    for (const fn of [seen, record, onRefund]) if (typeof fn !== 'function') throw Error('INVALID_STORE_NOTIFICATION');
    if (!body || typeof body.signedPayload !== 'string' || body.signedPayload.length > 65536) throw Error('INVALID_STORE_NOTIFICATION');
    let payload; try { payload = this.storeKit.verifyJws(body.signedPayload); } catch { throw Error('INVALID_STORE_NOTIFICATION'); }
    const id = payload && payload.notificationUUID;
    if (!safeId(id)) throw Error('INVALID_STORE_NOTIFICATION');
    if (await seen('apple', id)) return { ok: true, duplicate: true };
    const data = payload && payload.data;
    if (!data || typeof data.signedTransactionInfo !== 'string') throw Error('INVALID_STORE_NOTIFICATION');
    let tx; try { tx = this.storeKit.inspectTransaction(this.storeKit.verifyJws(data.signedTransactionInfo)); } catch { throw Error('INVALID_STORE_NOTIFICATION'); }
    const revoke = tx.revoked === true || ['REFUND', 'REVOKE'].includes(payload.notificationType);
    if (revoke) await onRefund('apple', tx.transactionId);
    await record('apple', id);
    return { ok: true, duplicate: false, refunded: revoke ? 1 : 0 };
  }
}

module.exports = { GooglePlayStoreNotifications, AppleStoreNotificationsV5 };
