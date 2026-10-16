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
};

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
      const op = requireText(input.op, 'INVALID_COMMERCE_OP', /^[a-z]+$/);
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
        if (value === undefined) fail('INVALID_COMMERCE_ARG: ' + name);
        if (name === 'key') { args.push(requireText(value, 'INVALID_IDEMPOTENCY_KEY', KEY_PATTERN)); }
        else if (name === 'platform') args.push(requireText(value, 'INVALID_PLATFORM', /^(legacy|android|ios)$/));
        else if (name === 'kind') args.push(requireText(value, 'INVALID_AD_KIND', /^(rewarded|interstitial)$/));
        else if (name === 'itemId') args.push(requireText(value, 'INVALID_ITEM_ID', KEY_PATTERN));
        else if (name === 'restore') args.push(value === true);
        else if (name === 'evidence') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_EVIDENCE');
          args.push(value);
        } else if (name === 'raw') {
          if (typeof value !== 'string' || value.length === 0 || value.length > 8192) fail('INVALID_SSV_PAYLOAD');
          args.push(value);
        } else fail('INVALID_COMMERCE_COMMAND');
      }
      return spec.call(commerce, actor, args);
    },
  });
}

module.exports = { createCommerceIngressService, OPS, KEY_PATTERN, PLATFORMS, KINDS };
