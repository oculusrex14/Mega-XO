'use strict';
/* MXA-ECO-011 (2026-10-18): the pass exchange split - the pure heart of the V5 Coin->Crown
 * exchange lane. Purchased coins never take the discounted tranche (provenance loop guard). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { passExchangeSplit } = require('../packages/services/commerce.js');

test('pass exchange: an all-discount amount converts at 8:1', () => {
  assert.deepEqual(passExchangeSplit(80, 200, 200), { discounted: 80, standard: 0, crowns: 10 });
  assert.deepEqual(passExchangeSplit(200, 200, 500), { discounted: 200, standard: 0, crowns: 25 });
});

test('pass exchange: the discounted tranche is maximized and the remainder stays at 10:1', () => {
  assert.deepEqual(passExchangeSplit(100, 200, 150), { discounted: 80, standard: 20, crowns: 12 });
  assert.deepEqual(passExchangeSplit(100, 200, 50), { discounted: 40, standard: 60, crowns: 11 });
});

test('pass exchange: purchased coins can never take the discounted tranche', () => {
  assert.deepEqual(passExchangeSplit(100, 200, 0), { discounted: 0, standard: 100, crowns: 10 });
  assert.deepEqual(passExchangeSplit(100, 0, 500), { discounted: 0, standard: 100, crowns: 10 });
});

test('pass exchange: impossible splits fail closed', () => {
  assert.throws(() => passExchangeSplit(101, 200, 500), /EXCHANGE_AMOUNT_INVALID/);
  assert.throws(() => passExchangeSplit(101, 0, 500), /EXCHANGE_AMOUNT_INVALID/);
  assert.throws(() => passExchangeSplit(0, 200, 500), /INVALID_AMOUNT/);
  assert.throws(() => passExchangeSplit(-10, 200, 500), /INVALID_AMOUNT/);
});
