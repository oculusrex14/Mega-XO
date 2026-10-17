'use strict';

/* Offline unit proof for the LR12 commerce ingress: the op allow-list maps ONE signed command to
 * exactly ONE commerce call with the right argument order; unknown ops/args/platforms/kinds refuse
 * with stable codes; status needs no idempotency key; the SSV path is actor-free but
 * signature-verified. No database, no network: the commerce service is a recording fake. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCommerceIngressService } = require('../packages/services/commerce-ingress.js');
const { signRequest, verifyRequest } = require('../packages/services/core-gateway.js');

function fakeCommerce() {
  const calls = [];
  const record = (method) => async (...args) => { calls.push({ method, args }); return { method, args }; };
  return {
    calls,
    status: record('status'),
    claim: record('claim'),
    cosmetic: record('cosmetic'),
    ticket: record('ticket'),
    permit: record('permit'),
    automaticPermit: record('automaticPermit'),
    purchase: record('purchase'),
    callback: record('callback'),
    createCashfreeOrder: record('createCashfreeOrder'),
    cashfreeOrderStatus: record('cashfreeOrderStatus'),
    settleCashfreeWebhook: record('settleCashfreeWebhook'),
    createPolarCheckout: record('createPolarCheckout'),
    polarOrderStatus: record('polarOrderStatus'),
    settlePolarWebhook: record('settlePolarWebhook'),
  };
}

const ACTOR = 'player_abc123';

test('dispatch: each op maps to exactly one commerce call with ordered arguments', async () => {
  const commerce = fakeCommerce();
  const ingress = createCommerceIngressService({ commerce });
  await ingress.command({ actor: ACTOR, op: 'status' });
  await ingress.command({ actor: ACTOR, op: 'claim', key: 'op-1' });
  await ingress.command({ actor: ACTOR, op: 'ticket', key: 'op-2', kind: 'credits', platform: 'android' });
  await ingress.command({ actor: ACTOR, op: 'permit', opKey: 'hdr-op-key', platform: 'ios' });
  await ingress.command({ actor: ACTOR, op: 'purchase', key: 'op-3', evidence: { store: 'google', token: 't' }, restore: true });
  const byMethod = Object.fromEntries(commerce.calls.map((c) => [c.method, c.args]));
  assert.deepEqual(byMethod.status, [ACTOR]);
  assert.deepEqual(byMethod.claim, [ACTOR, 'op-1']);
  assert.deepEqual(byMethod.ticket, [ACTOR, 'op-2', 'credits', 'android']);
  /* The signed header op key becomes the idempotency key when the body carries none. */
  assert.deepEqual(byMethod.automaticPermit, [ACTOR, 'hdr-op-key', 'ios']);
  assert.deepEqual(byMethod.purchase, [ACTOR, 'op-3', { store: 'google', token: 't' }, true]);
});

test('dispatch: unknown ops, bad shapes, and missing keys refuse with stable codes', async () => {
  const ingress = createCommerceIngressService({ commerce: fakeCommerce() });
  await assert.rejects(() => ingress.command({ actor: ACTOR, op: 'selfDestruct' }), /INVALID_COMMERCE_OP/);
  await assert.rejects(() => ingress.command({ actor: ACTOR, op: 'claim' }), /INVALID_IDEMPOTENCY_KEY/);
  /* MXA-ECO-003: ticket kind is the REWARD kind (credits/boost); the rewarded format is implicit. */
  await assert.rejects(() => ingress.command({ actor: ACTOR, op: 'ticket', key: 'k', kind: 'banner', platform: 'android' }), /INVALID_REWARD/);
  await assert.rejects(() => ingress.command({ actor: ACTOR, op: 'ticket', key: 'k', kind: 'credits', platform: 'web' }), /INVALID_PLATFORM/);
  await assert.rejects(() => ingress.command({ actor: 'bad actor', op: 'status' }), /INVALID_ACTOR/);
  await assert.rejects(() => ingress.command({ actor: ACTOR, op: 'ssv' }), /INVALID_SSV_PAYLOAD/);
});

test('ssv path: actor-free but signature-verified (sign/verify roundtrip)', () => {
  const secret = 'unit-test-gateway-secret-0123456789abcdef';
  const timestamp = String(Date.now());
  /* The raw SSV QUERY STRING is what Google signs — the ingress forwards it verbatim. */
  const bodyString = JSON.stringify({ raw: 'ad_unit=ca-app-pub-3940256099942544%2F5224354917&signature=abc&key_id=1' });
  const signature = signRequest({ secret, timestamp, method: 'POST', path: '/ingress/commerce/ssv', actor: '', opKey: 'commerce-ssv', bodyString });
  const verified = verifyRequest({ secret, timestamp, method: 'POST', path: '/ingress/commerce/ssv', actor: '', opKey: 'commerce-ssv', bodyString, signature, now: () => Date.now() });
  assert.equal(verified.valid, true);
  const forged = signRequest({ secret: 'an-entirely-different-secret-key-123456', timestamp, method: 'POST', path: '/ingress/commerce/ssv', actor: '', opKey: 'commerce-ssv', bodyString });
  assert.equal(verifyRequest({ secret, timestamp, method: 'POST', path: '/ingress/commerce/ssv', actor: '', opKey: 'commerce-ssv', bodyString, signature: forged, now: () => Date.now() }).valid, false);
});

test('ssv dispatch: the provider callback is actor-free END TO END through the real ingress', async () => {
  const commerce = fakeCommerce();
  const ingress = createCommerceIngressService({ commerce });
  /* This is the exact shape the gateway dispatches (core-gateway.js /ingress/commerce/ssv): no
   * actor at all. Requiring a session actor here refused every live AdMob callback. */
  await ingress.command({ op: 'ssv', raw: 'ad_unit=ca-app-pub-3940256099942544%2F5224354917&signature=abc' });
  assert.deepEqual(commerce.calls[0].args, ['ad_unit=ca-app-pub-3940256099942544%2F5224354917&signature=abc']);
  /* A player command still requires the signed session actor. */
  await assert.rejects(() => ingress.command({ op: 'status' }), /INVALID_ACTOR/);
});

test('source integrity: the ingress and the API dispatch are wired', () => {
  const gateway = fs.readFileSync(path.join(__dirname, '..', 'packages', 'services', 'core-gateway.js'), 'utf8');
  assert.match(gateway, /pathname === '\/ingress\/commerce\/ssv'/, 'actor-free ssv path present');
  assert.match(gateway, /commerce: createCommerceIngressService|commerce,/);
  const apiIndex = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'index.js'), 'utf8');
  assert.match(apiIndex, /monetizationRoutes\.handleMonetizationRoute/, 'route registered in the API dispatch');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'apps', 'api', 'routes', 'monetization.js'), 'utf8');
  assert.match(routes, /admob-ssv/);
  assert.match(routes, /lane\.ssv\(/, 'the SSV route uses the dedicated actor-free gateway lane');
  assert.doesNotMatch(routes, /op: 'ssv'/, 'the SSV route never rides the player command surface');
  const server = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'v51', 'v5-production-server.cjs'), 'utf8');
  assert.match(server, /ssv: \(raw\) => coreGateway\.commerceSsv/, 'the facade exposes the actor-free ssv lane');
  assert.doesNotMatch(routes, /require\([^)]*commerce\.js|INSERT INTO monetization|UPDATE monetization|FROM monetization\./, 'the API tier imports no commerce service and touches no monetization tables');
});

test('composition: the AdMob verifier is composed only when rewarded ads are enabled', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'v51', 'v5-production-server.cjs'), 'utf8');
  assert.match(source, /createAdMobVerifier\(\)/, 'verifyAd composed from the published-keys verifier');
  assert.match(source, /const verifyAd = commerceAdMode !== 'off' \? createAdMobVerifier\(\) : null/, 'verifyAd stays null while adMode is off');
  assert.match(source, /ADMOB_' \+ platform\.toUpperCase\(\) \+ '_REWARDED_UNIT'/, 'ad units read from the deployment env');
  assert.match(source, /account\.verified === true && account\.suspended !== true && account\.hold !== true/, 'eligibility stays the conservative verified/unheld gate');
});

test('security: the SIGNED ingress actor/opKey are authoritative over any command body (no override)', () => {
  /* SEC-V52-ACTOR-OVERRIDE regression. The dispatcher previously spread the request-supplied
   * `command` object AFTER `actor: actorHeader, opKey: opKeyHeader`, so a signed caller could put
   * its own `actor` in the command and act on an arbitrary player. Guard the exact order now. */
  const gateway = fs.readFileSync(path.join(__dirname, '..', 'packages', 'services', 'core-gateway.js'), 'utf8');
  const dispatch = gateway.match(/commerce\.command\(\{[^}]*\}\)/g) || [];
  const commandSpread = dispatch.find((call) => call.includes('...input'));
  assert.ok(commandSpread, 'the commerce command dispatch still spreads the request input');
  /* The header actor/opKey must come AFTER the spread so they always win. */
  assert.match(commandSpread, /\{\s*\.\.\.input,\s*actor:\s*actorHeader,\s*opKey:\s*opKeyHeader\s*\}/, 'the signed header actor and opKey must be forced AFTER the untrusted input spread');
  assert.doesNotMatch(commandSpread, /actor:\s*actorHeader[^}]*\.\.\.input/, 'the untrusted input must never be spread after the signed header actor');
});
