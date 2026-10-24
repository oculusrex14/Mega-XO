'use strict';

/* LR12 (2026-10-16): the API-tier commerce command surface.
 *
 * The commerce service (packages/services/commerce.js) runs ONLY on a core_runtime pool and is
 * composed inside the Core process. The API tier reaches it through the SIGNED service ingress —
 * the same pattern as queue/tournaments — via this narrow op dispatcher. It exists so the signed
 * ingress dispatch never spreads commerce method knowledge across files: ONE allow-list maps a
 * signed command {op, ...args} to exactly one commerce call, everything else is refused.
 *
 * NOT EXPORTED TO PLAYERS DIRECTLY: the idempotency key is the client's durable operation key
 * (never generated API-side), the actor is the authenticated session actor, and every economic
 * effect remains inside the commerce service's core_runtime transactions. */

const KEY_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/;
const PLATFORMS = ['legacy', 'android', 'ios'];
const KINDS = ['rewarded', 'interstitial'];

/* op -> argument extractor. Each entry states exactly which signed-command fields the commerce
 * method consumes; unknown extra fields are ignored (forward-compatible), missing required ones
 * refuse with a stable code. */
const OPS = {
  status: { args: [], method: 'status', call: (c, actor, a) => c.status(actor) },
  claim: { args: ['key'], method: 'claim', call: (c, actor, a) => c.claim(actor, a[0]) },
  cosmetic: { args: ['key', 'itemId'], method: 'cosmetic', call: (c, actor, a) => c.cosmetic(actor, a[0], a[1]) },
  ticket: { args: ['key', 'kind', 'platform'], method: 'ticket', call: (c, actor, a) => c.ticket(actor, a[0], a[1], a[2]) },
  permit: { args: ['key', 'platform'], method: 'automaticPermit', call: (c, actor, a) => c.automaticPermit(actor, a[0], a[1]) },
  purchase: { args: ['key', 'evidence', 'restore'], method: 'purchase', call: (c, actor, a) => c.purchase(actor, a[0], a[1], a[2]) },
  /* The AdMob SSV provider callback is actor-free (Google calls it); the commerce service verifies
	 * the provider proof inside callback() and binds the grant to the ticket actor there. The raw
	 * payload is the SSV QUERY STRING (what Google signs), never a re-encoded param map. */
  ssv: { args: ['raw'], method: 'callback', actorFree: true, call: (c, actor, a) => c.callback(a[0]) },
  /* LR13: the Cashfree web-commerce lane. create/status are player commands (session actor);
   * the webhook is actor-free (Cashfree's server calls it) and carries {raw, timestamp,
   * signature} - the commerce service verifies the HMAC against the EXACT raw bytes. */
  cashfree_create: { args: ['key', 'productId', 'customer'], method: 'createCashfreeOrder', call: (c, actor, a) => c.createCashfreeOrder(actor, a[0], a[1], a[2]) },
  cashfree_status: { args: ['orderId'], method: 'cashfreeOrderStatus', call: (c, actor, a) => c.cashfreeOrderStatus(actor, a[0]) },
  cashfree_webhook: { args: ['payload'], method: 'settleCashfreeWebhook', actorFree: true, call: (c, actor, a) => c.settleCashfreeWebhook(a[0]) },
  /* C05: the Polar lane. create/status are player commands (session actor); the webhook is
   * actor-free (Polar's server calls it) and carries {raw, id, timestamp, signature}. */
  polar_create: { args: ['key', 'productId', 'customer'], method: 'createPolarCheckout', call: (c, actor, a) => c.createPolarCheckout(actor, a[0], a[1], a[2]) },
  polar_status: { args: ['checkoutId'], method: 'polarOrderStatus', call: (c, actor, a) => c.polarOrderStatus(actor, a[0]) },
  polar_disposition: { args: ['key', 'productId', 'region'], method: 'polarOrderStatus', call: (c, actor, a) => c.polarOrderStatus(actor, null, {key:a[0], productId:a[1], currency:a[2].currency}) },
  polar_webhook: { args: ['payload'], method: 'settlePolarWebhook', actorFree: true, call: (c, actor, a) => c.settlePolarWebhook(a[0]) },
  /* 2026-10-19: the Dodo lane (owner decision: Dodo = PRIMARY web checkout, Polar dormant).
   * Same contract shape: create/status are player commands (the region hint rides the create so
   * the SERVER-SIDE catalog picks the charge currency); the webhook is actor-free and carries
   * {raw, id, timestamp, signature} verified against the exact raw bytes. */
  dodo_create: { args: ['key', 'productId', 'customer', 'region'], method: 'createDodoCheckout', call: (c, actor, a) => c.createDodoCheckout(actor, a[0], a[1], a[2], a[3]) },
  dodo_status: { args: ['checkoutId'], method: 'dodoOrderStatus', call: (c, actor, a) => c.dodoOrderStatus(actor, a[0]) },
  dodo_disposition: { args: ['key', 'productId', 'region'], method: 'dodoOrderStatus', call: (c, actor, a) => c.dodoOrderStatus(actor, null, {key:a[0], productId:a[1], currency:a[2].currency}) },
  dodo_webhook: { args: ['payload'], method: 'settleDodoWebhook', actorFree: true, call: (c, actor, a) => c.settleDodoWebhook(a[0]) },
  /* MXA-WALLET-PATH (2026-10-19): the server-side Crown debit for power-up charges. itemId is
   * the power kind (undo/hint); the cost table lives in the commerce service so the client can
   * never name its own price. */
  power_spend: { args: ['key', 'itemId'], method: 'powerSpend', call: (c, actor, a) => c.powerSpend(actor, a[0], a[1]) },
  /* MXA-ECO-005: the trusted store-notification lane (Google RTDN / Apple ASNv2). Actor-free:
   * the provider credential rides as an argument and the Core-side handler verifies it before
   * any dedupe or refund; the only economic path is the idempotent commerce.refund. */
  store_notification: { args: ['provider', 'credential', 'body'], method: 'handleStoreNotification', actorFree: true, call: (c, actor, a) => c.handleStoreNotification(a[0], a[1], a[2]) },
  /* MXA-ECO-011: the player-facing pass exchange (Coins -> Crowns with the monthly allowance). */
  exchange: { args: ['key', 'amount'], method: 'exchangeCoins', call: (c, actor, a) => c.exchangeCoins(actor, a[0], a[1]) },
  /* MXA-PROMOTION-DISCLOSURE (2026-10-20): the native pre-billing reservation gate (PR #55
   * contract: call BEFORE presenting promotional billing, then deliver with the SAME key) and
   * the disclosure acceptance recorder (receipt carries the signed disclosure token the Core
   * side re-verifies; a body saying accepted:true is never sufficient). */
  promotion_reserve: { args: ['key', 'productId', 'provider', 'acceptanceHash'], method: 'reservePromotionCheckout', call: (c, actor, a) => c.reservePromotionCheckout(actor, a[0], a[1], a[2], a[3]) },
  promotion_accept: { args: ['receipt'], method: 'acceptPromotionPolicy', call: (c, actor, a) => c.acceptPromotionPolicy(actor, a[0]) },
};

/* Optional trailing args: a promotion_reserve may run before the policy is published, where no
 * acceptance hash exists yet. Every other arg stays required exactly as before. */
const OPTIONAL_ARGS = new Set(['acceptanceHash']);

function fail(code) { const e = Error(code); e.code = code; throw e; }

function requireText(value, code, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function createCommerceIngressService({ commerce }) {
  if (!commerce || typeof commerce !== 'object') throw Error('COMMERCE_SERVICE_REQUIRED');
  for (const op of Object.keys(OPS)) {
    if (typeof commerce[OPS[op].method] !== 'function') throw Error('COMMERCE_METHOD_MISSING: ' + OPS[op].method);
  }

  return Object.freeze({
    async command(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_COMMERCE_COMMAND');
      const op = requireText(input.op, 'INVALID_COMMERCE_OP', /^[a-z_]+$/);
      const spec = OPS[op];
      if (!spec) fail('INVALID_COMMERCE_OP');
      /* Actor-free provider callbacks (the AdMob SSV) carry their actor INSIDE the verified proof;
       * every player command requires the signed session actor. The gateway dispatches ssv with an
       * EMPTY actor header by design, so demanding a session actor here refused every live callback. */
      const actor = spec.actorFree && input.actor === undefined ? null
        : requireText(input.actor, 'INVALID_ACTOR', /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/);
      /* The idempotency key: the command's explicit key wins; the client's durable operation key
       * (signed header) is the fallback. Only ops whose commerce method takes a key require one —
       * status is a pure read. */
      const key = input.key !== undefined ? requireText(input.key, 'INVALID_IDEMPOTENCY_KEY', KEY_PATTERN)
        : input.opKey !== undefined ? requireText(input.opKey, 'INVALID_IDEMPOTENCY_KEY', /^[!-~]{1,160}$/)
        : undefined;
      const args = [];
      for (const name of spec.args) {
        const value = input[name] !== undefined ? input[name] : (name === 'key' ? key : undefined);
        if (value === undefined && name === 'key') fail('INVALID_IDEMPOTENCY_KEY');
        if (value === undefined && name === 'raw') fail('INVALID_SSV_PAYLOAD');
        if (value === undefined && OPTIONAL_ARGS.has(name)) { args.push(undefined); continue; }
        if (value === undefined) fail('INVALID_COMMERCE_ARG: ' + name);
        if (name === 'key') { args.push(requireText(value, 'INVALID_IDEMPOTENCY_KEY', KEY_PATTERN)); }
        else if (name === 'platform') args.push(requireText(value, 'INVALID_PLATFORM', /^(legacy|android|ios)$/));
        /* MXA-ECO-003 (audit 2026-10-17) + MXA-ADS-D2 (2026-10-20): `kind` on the ticket op is
         * the REWARD kind the client selects (credits/boost) or the power a rewarded ad earns
         * (undo/hint, the powers lane), matching commerce.ticket and the reward-ticket contract; the
         * rewarded format is implicit and the automatic lane (permit) carries no kind at all. */
        else if (name === 'kind') args.push(requireText(value, 'INVALID_REWARD', /^(credits|boost|undo|hint)$/));
        else if (name === 'itemId') args.push(requireText(value, 'INVALID_ITEM_ID', KEY_PATTERN));
        else if (name === 'amount') {
         if (!Number.isInteger(value) || value <= 0 || value > 1000000) fail('INVALID_AMOUNT');
         args.push(value);
        }
        else if (name === 'productId' || name === 'orderId') args.push(requireText(value, 'INVALID_' + name.toUpperCase(), KEY_PATTERN));
        else if (name === 'checkoutId') args.push(requireText(value, 'INVALID_CHECKOUTID', /^[!-~]{1,160}$/));
        else if (name === 'customer') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_CUSTOMER_DETAILS');
          args.push(value);
        } else if (name === 'region') {
          /* The player's region HINT only selects among server-configured prices; an unknown
           * currency falls back to the USD base inside the commerce service. Shape-validated
           * here so garbage never reaches the provider call. */
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_REGION');
          if (value.currency !== undefined && (typeof value.currency !== 'string' || !/^[a-z]{2,8}$/.test(value.currency))) fail('INVALID_REGION');
          if (value.country !== undefined && (typeof value.country !== 'string' || !/^[A-Za-z]{2}$/.test(value.country))) fail('INVALID_REGION');
          args.push(value);
        } else if (name === 'payload') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_WEBHOOK');
          if (typeof value.raw !== 'string' || value.raw.length === 0 || value.raw.length > 65536) fail('INVALID_WEBHOOK');
          if (typeof value.timestamp !== 'string' || typeof value.signature !== 'string') fail('INVALID_WEBHOOK');
          args.push(value);
        } else if (name === 'restore') args.push(value === true);
        else if (name === 'evidence') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_EVIDENCE');
          args.push(value);
        } else if (name === 'provider') {
          args.push(requireText(value, 'INVALID_STORE_NOTIFICATION', /^(google|apple)$/));
        } else if (name === 'credential') {
          args.push(requireText(value, 'INVALID_STORE_NOTIFICATION', /^[\u0020-\u007e]{0,8192}$/));
        } else if (name === 'body') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_STORE_NOTIFICATION');
          args.push(value);
        } else if (name === 'raw') {
          if (typeof value !== 'string' || value.length === 0 || value.length > 8192) fail('INVALID_SSV_PAYLOAD');
          args.push(value);
        } else if (name === 'acceptanceHash') {
          args.push(requireText(value, 'INVALID_PROMOTION_ACCEPTANCE', /^[0-9a-f]{64}$/));
        } else if (name === 'receipt') {
          /* Shape only: the token inside is verified against the disclosure secret on the Core
           * side before any acceptance is recorded; this tier cannot attest anything. */
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_PROMOTION_RECEIPT');
          if (typeof value.policyVersion !== 'string' || !value.policyVersion
            || typeof value.ruleHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.ruleHash)
            || !Number.isSafeInteger(value.remaining) || value.remaining < 0
            || typeof value.disclosureReceipt !== 'string' || value.disclosureReceipt.length > 4096) fail('INVALID_PROMOTION_RECEIPT');
          args.push(value);
        } else fail('INVALID_COMMERCE_COMMAND');
      }
      return spec.call(commerce, actor, args);
    },
  });
}

module.exports = { createCommerceIngressService, OPS, KEY_PATTERN, PLATFORMS, KINDS };
