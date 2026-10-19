'use strict';
/* The 2026-10-19 Dodo store-lane normalizer contract: the dodo block is optional (every legacy
 * reply stays valid), malformed dodo data is refused rather than rendered, the player's region
 * currency only ever picks a SERVER-configured price (unknown regions fall back to the USD base),
 * and the intro window is display metadata only. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeStoreStatus, formatMinor } = require('../apps/web/store.js');

function baseStatus() {
  return {
    purchasesAvailable: false,
    webCheckoutAvailable: true,
    webCheckoutProvider: 'dodo',
    products: [],
    polar: { available: false, products: {} },
    cashfree: { available: false, products: {} },
    pass: { active: false, periodEnd: null, cancelAtPeriodEnd: false },
  };
}

function dodoBlock() {
  return {
    available: true,
    products: { crowns_100: { amountCents: 49, currency: 'usd' }, mega_pass: { amountCents: 199, currency: 'usd' } },
    regions: {
      crowns_100: { usd: 49, inr: 2500 },
      crowns_525: { usd: 249, inr: 12500 },
      crowns_1100: { usd: 499, inr: 25000 },
      remove_ads: { usd: 199, inr: 9900 },
      mega_pass: { usd: 199, inr: 9900 },
    },
    intro: { active: true, endsAt: '2026-11-18T20:29:59.000Z' },
  };
}

test('a legacy reply without a dodo block stays valid and unchanged', () => {
  const normalized = normalizeStoreStatus(baseStatus());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.webCheckoutProvider, 'dodo');
  for (const row of normalized.rows) assert.equal(row.dodoPrice, null);
  assert.equal(normalized.dodoIntro, null);
});

test('region currency picks a configured localized price and falls back to USD', () => {
  const india = normalizeStoreStatus({ ...baseStatus(), dodo: dodoBlock() }, { regionCurrency: 'inr' });
  assert.equal(india.ok, true);
  const indiaRow = india.rows.find(row => row.id === 'crowns_525');
  assert.equal(indiaRow.dodoCurrency, 'inr');
  assert.equal(indiaRow.dodoPrice, formatMinor(12500, 'inr'));
  const us = normalizeStoreStatus({ ...baseStatus(), dodo: dodoBlock() }, { regionCurrency: 'usd' });
  const usRow = us.rows.find(row => row.id === 'crowns_525');
  assert.equal(usRow.dodoCurrency, 'usd');
  assert.equal(usRow.dodoPrice, formatMinor(249, 'usd'));
  const unknown = normalizeStoreStatus({ ...baseStatus(), dodo: dodoBlock() }, { regionCurrency: 'btc' });
  const unknownRow = unknown.rows.find(row => row.id === 'crowns_525');
  assert.equal(unknownRow.dodoCurrency, 'usd', 'an unsupported region falls back to the USD base, never an estimate');
});

test('the launch code promo discounts the display only after the intro window closes', () => {
  /* MXA-PROMO-CODE (2026-10-19): the server attaches LAUNCH50 to qualifying checkouts and
   * records the discounted amount; the display must match that. During the intro window the
   * promo never applies (no stacking) - the intro price IS the launch price. */
  const base = { ...baseStatus(), dodo: { ...dodoBlock(), promo: { code: 'LAUNCH50', percentBps: 5000, products: ['crowns_100'], expiresAt: '2027-01-01T00:00:00Z' } } };
  const duringIntro = normalizeStoreStatus({ ...base, dodo: { ...base.dodo, intro: { active: true, endsAt: '2026-11-18T20:29:59Z' } } }, { regionCurrency: 'usd' });
  assert.equal(duringIntro.rows.find(row => row.id === 'crowns_100').dodoPrice, '$0.49', 'no promo stacking during the intro window');
  const afterIntro = normalizeStoreStatus({ ...base, dodo: { ...base.dodo, intro: { active: false, endsAt: '2026-11-18T20:29:59Z' } } }, { regionCurrency: 'usd' });
  assert.equal(afterIntro.rows.find(row => row.id === 'crowns_100').dodoPrice, '$0.25');
  const otherProduct = normalizeStoreStatus({ ...base, dodo: { ...base.dodo, intro: { active: false, endsAt: '2026-11-18T20:29:59Z' } } }, { regionCurrency: 'usd' });
  assert.equal(otherProduct.rows.find(row => row.id === 'crowns_525').dodoPrice, '$2.49', 'the promo applies only to the listed products');
});
test('the launch-offer was/now comparison only renders from a server-validated regular price', () => {
  /* 2026-10-19: the slashed-price promo. regularRegions is display-only; a regular price that is
   * not ABOVE the current one never renders as a comparison (no fake discounts). */
  const status = { ...baseStatus(), dodo: { ...dodoBlock(), regularRegions: { crowns_100: { usd: 99, inr: 5000 } } } };
  const usd = normalizeStoreStatus(status, { regionCurrency: 'usd' });
  const crowns = usd.rows.find(row => row.id === 'crowns_100');
  assert.equal(crowns.dodoPrice, '$0.49');
  assert.equal(crowns.dodoRegularPrice, '$0.99');
  const india = normalizeStoreStatus(status, { regionCurrency: 'inr' });
  const indiaRow = india.rows.find(row => row.id === 'crowns_100');
  assert.equal(indiaRow.dodoPrice, '₹25.00');
  assert.equal(indiaRow.dodoRegularPrice, '₹50.00');
  const notAbove = normalizeStoreStatus({ ...status, dodo: { ...dodoBlock(), regularRegions: { crowns_100: { usd: 49 } } } }, { regionCurrency: 'usd' });
  assert.equal(notAbove.rows.find(row => row.id === 'crowns_100').dodoRegularPrice, null);
});

test('the intro window is display metadata and the checkout provider passes through', () => {
  const normalized = normalizeStoreStatus({ ...baseStatus(), dodo: dodoBlock() });
  assert.deepEqual(normalized.dodoIntro, { active: true, endsAt: '2026-11-18T20:29:59.000Z' });
  assert.equal(normalized.webCheckoutAvailable, true);
});

test('malformed dodo data refuses the whole reply instead of rendering a wrong price', () => {
  for (const bad of [
    'yes',
    { available: 'yes', products: {}, regions: {} },
    { available: true, products: [], regions: {} },
    { available: true, products: {}, regions: {}, intro: { active: 'soon', endsAt: 1 } },
  ]) {
    const normalized = normalizeStoreStatus({ ...baseStatus(), dodo: bad });
    assert.equal(normalized.ok, false, JSON.stringify(bad));
    assert.equal(normalized.errorCode, 'STORE_UNAVAILABLE');
  }
});

test('a dodo product entry with a malformed amount refuses the reply', () => {
  const bad = dodoBlock();
  bad.products.crowns_100 = { amountCents: -5, currency: 'usd' };
  const normalized = normalizeStoreStatus({ ...baseStatus(), dodo: bad });
  assert.equal(normalized.ok, false);
});

test('formatMinor keeps the supported currency exponents', () => {
  assert.equal(formatMinor(49, 'usd'), '$0.49');
  assert.equal(formatMinor(2500, 'inr'), '₹25.00');
  assert.equal(formatMinor(-1, 'usd'), null);
  assert.equal(formatMinor(100, 'btc'), null);
});
