'use strict';
/* Sol review R2/R3 regression: the EXACT production composition, not only the standalone
   helper. R2 - the API routes and the Core verifier pass the RAW secret string; a pre-derived
   subkey is rejected loudly (DISCLOSURE_SECRET_REQUIRED) instead of silently failing. R3 - the
   signed gateway projection forwards receipt/provider/acceptanceHash so mounted promotion
   commands reach the Core ingress instead of INVALID_COMMERCE_ARG. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Disclosure = require('../packages/services/promotion-disclosure.js');
const { createCoreGateway } = require('../packages/services/core-gateway.js');

const SECRET = 'promotion-disclosure-composition-secret-v1';
const NOW = Date.parse('2026-11-01T12:00:00Z');

test('R2: production issue -> receipt -> verify composition with the raw secret string', () => {
  const token = Disclosure.issueToken({ actor: 'acct_r2', policyVersion: 'promotion-allocation-v1', ruleHash: Disclosure.ruleHash(), remaining: 22000, now: NOW }, SECRET);
  const receipt = Disclosure.receiptFromToken(token, SECRET, 'acct_r2');
  assert.equal(Disclosure.verifyAcceptanceReceipt(SECRET, 'acct_r2', receipt), true);
  assert.equal(Disclosure.verifyAcceptanceReceipt(SECRET, 'acct_other', receipt), false, 'another actor can never accept with this receipt');
});

test('R2: a pre-derived subkey is rejected loudly at every entry point', () => {
  const derived = Disclosure.deriveSecret(SECRET);
  assert.throws(() => Disclosure.issueToken({ actor: 'a', policyVersion: 'p', ruleHash: Disclosure.ruleHash(), remaining: 1, now: NOW }, derived), /DISCLOSURE_SECRET_REQUIRED/);
  assert.throws(() => Disclosure.verifyToken('x.y', derived), /DISCLOSURE_SECRET_REQUIRED/);
  assert.throws(() => Disclosure.receiptFromToken('x.y', derived, 'a'), /DISCLOSURE_SECRET_REQUIRED/);
  /* verifyAcceptanceReceipt fails closed: a pre-derived secret can never verify (the Core bug). */
  assert.equal(Disclosure.verifyAcceptanceReceipt(derived, 'a', { policyVersion: 'p', ruleHash: Disclosure.ruleHash(), remaining: 1, disclosureReceipt: 'x.y' }), false);
});

test('R3: the signed gateway forwards the promotion command arguments to Core', async () => {
  const bodies = [];
  const gateway = createCoreGateway({
    coreUrl: 'https://core.example.test',
    secret: 'gateway-composition-secret-v1',
    fetcher: async (url, options) => {
      bodies.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
  });
  const receipt = Disclosure.receiptFromToken(
    Disclosure.issueToken({ actor: 'acct_r3', policyVersion: 'promotion-allocation-v1', ruleHash: Disclosure.ruleHash(), remaining: 21900, now: NOW }, SECRET),
    SECRET, 'acct_r3');
  await gateway.commerceCommand({ actor: 'acct_r3', opKey: 'op-accept-1', op: 'promotion_accept', receipt });
  await gateway.commerceCommand({ actor: 'acct_r3', opKey: 'op-reserve-1', op: 'promotion_reserve', key: 'checkout-key-1', productId: 'crowns_100', provider: 'google', acceptanceHash: 'a'.repeat(64) });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].url, 'https://core.example.test/ingress/commerce/command');
  assert.deepEqual(bodies[0].body.command.receipt && Object.keys(bodies[0].body.command.receipt).sort(), ['disclosureReceipt', 'policyVersion', 'remaining', 'ruleHash']);
  assert.equal(bodies[1].body.command.provider, 'google');
  assert.equal(bodies[1].body.command.acceptanceHash, 'a'.repeat(64));
  assert.equal(bodies[1].body.command.productId, 'crowns_100');
  assert.equal(bodies[1].body.command.key, 'checkout-key-1');
});
