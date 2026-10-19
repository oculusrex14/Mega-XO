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
    products: { crowns_100: { amountCents: 99, currency: 'usd' }, mega_pass: { amountCents: 399, currency: 'usd' } },
    regions: {
      crowns_100: { usd: 99, inr: 4900 },
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

test('the display renders the server-sent chargeable price and never estimates a discount', () => {
  /* MXA-PROMO-SPLIT (2026-10-19, owner two-mechanism model): the server owns pricing. During
   * the window the Dodo catalog carries the intro price and the client renders it verbatim;
   * after the boundary the server sends the base catalog and the same code path renders it.
   * A promo block in the reply must never cause a client-side percentage computation. */
  const promo = { code: 'LAUNCH50', percentBps: 5000, products: ['crowns_100', 'mega_pass'], expiresAt: '2027-01-01T00:00:00Z' };
  const introRegions = { ...dodoBlock().regions, crowns_100: { usd: 49, inr: 2500 }, mega_pass: { usd: 399, inr: 19900 } };
  const during = normalizeStoreStatus({ ...baseStatus(), dodo: { ...dodoBlock(), regions: introRegions, promo } }, { regionCurrency: 'usd' });
  assert.equal(during.ok, true);
  assert.equal(during.rows.find(row => row.id === 'crowns_100').dodoPrice, '$0.49', 'the server-sent intro price renders verbatim');
  assert.equal(during.rows.find(row => row.id === 'mega_pass').dodoPrice, '$3.99', 'the pass renders its base price - the discount is the checkout code');
  assert.deepEqual(during.dodoPromo, { code: 'LAUNCH50', percentBps: 5000, products: ['crowns_100', 'mega_pass'], endsAt: '2027-01-01T00:00:00Z' }, 'the promo block passes through for the pass badge');
  const baseRegions = dodoBlock().regions;
  const after = normalizeStoreStatus({ ...baseStatus(), dodo: { ...dodoBlock(), regions: baseRegions, promo: { ...promo, expiresAt: '2026-10-01T00:00:00Z' } } }, { regionCurrency: 'usd' });
  assert.equal(after.rows.find(row => row.id === 'crowns_100').dodoPrice, '$0.99', 'an expired promo window serves the base catalog');
  assert.equal(after.dodoPromo, null, 'an expired promo block is dropped');
});
test('the launch-offer was/now comparison only renders from a server-validated regular price', () => {
  /* 2026-10-19: the slashed-price promo. regularRegions is display-only; a regular price that is
   * not ABOVE the current one never renders as a comparison (no fake discounts). */
  const introRegions = { ...dodoBlock().regions, crowns_100: { usd: 49, inr: 2500 } };
  const status = { ...baseStatus(), dodo: { ...dodoBlock(), regions: introRegions, regularRegions: { crowns_100: { usd: 99, inr: 4900 } }, promo: { code: 'LAUNCH50', percentBps: 5000, products: ['crowns_100'], expiresAt: '2027-01-01T00:00:00Z' } } };
  const usd = normalizeStoreStatus(status, { regionCurrency: 'usd' });
  const crowns = usd.rows.find(row => row.id === 'crowns_100');
  assert.equal(crowns.dodoPrice, '$0.49');
  assert.equal(crowns.dodoRegularPrice, '$0.99');
  const india = normalizeStoreStatus(status, { regionCurrency: 'inr' });
  const indiaRow = india.rows.find(row => row.id === 'crowns_100');
  assert.equal(indiaRow.dodoPrice, '₹25.00');
  assert.equal(indiaRow.dodoRegularPrice, '₹49.00');
  const notAbove = normalizeStoreStatus({ ...status, dodo: { ...status.dodo, regularRegions: { crowns_100: { usd: 49 } } } }, { regionCurrency: 'usd' });
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
