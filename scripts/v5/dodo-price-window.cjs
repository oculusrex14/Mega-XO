#!/usr/bin/env node
'use strict';

/* 2026-10-19: the Dodo intro-price window flip (owner two-mechanism model). The ONE-TIME 50%
 * launch prices live DIRECTLY on the Dodo products (the provider pricing mechanism - no code,
 * no player action), so the window boundary is an explicit, verified price flip. The Mega Pass
 * is NOT flipped: its product keeps the base recurring price and the discount is the LAUNCH50
 * code the player enters on the Dodo checkout, which expires provider-side on its own date.
 *
 *   node scripts/v5/dodo-price-window.cjs --mode intro   # before the window opens (already done)
 *   node scripts/v5/dodo-price-window.cjs --mode base    # when the window closes
 *   node scripts/v5/dodo-price-window.cjs --verify       # read-only: confirm env matches Dodo
 *   node scripts/v5/dodo-price-window.cjs --restrict-code LAUNCH50 --code-products mega_pass
 *     # scope the launch code so it can never discount the intro-priced one-time products
 *
 * The script NEVER prints the API key or the webhook secret, only talks to the configured mode's
 * host, verifies every change with a follow-up GET, and prints the EXACT provider-signin.env
 * block to apply on the host (DODO_PRICE_CENTS_* / DODO_REGION_IN_* / DODO_INTRO_ENDS_AT). The
 * host env update + service restart remain the documented deploy/ops step. Extending the window
 * is a no-op on Dodo (the intro prices simply stay) - update DODO_INTRO_ENDS_AT only. */

const fs = require('node:fs');
const path = require('node:path');

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
function flag(name) { return process.argv.includes('--' + name); }

const PRIVATE_DIR = process.env.DODO_PRIVATE_DIR || '/Users/oculus/Downloads/Mega-XO-private-evidence/dodo';
const MODE = arg('mode') || (flag('verify') ? 'verify' : (arg('restrict-code') ? 'restrict-code' : null));
const API_BASE = (flag('mode-test') ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com');

/* The launch price table. INTRO is the live 50%-off launch price; BASE is the standard price the
 * window reverts to. Amounts are integer minor units and MUST equal the env block the script
 * prints (the production server refuses boot when the env and these expectations disagree). */
const PRICES = {
  crowns_100: { base: { usd: 99, inr: 4900 }, intro: { usd: 49, inr: 2500 } },
  crowns_525: { base: { usd: 499, inr: 24900 }, intro: { usd: 249, inr: 12500 } },
  crowns_1100: { base: { usd: 999, inr: 49900 }, intro: { usd: 499, inr: 25000 } },
  remove_ads: { base: { usd: 399, inr: 19900 }, intro: { usd: 199, inr: 9900 } },
  /* The Mega Pass never flips: the intro entry equals base so even a stray loop is a no-op, and
   * the flip loop skips it outright - its discount is the customer-entered LAUNCH50 code. */
  mega_pass: { base: { usd: 399, inr: 19900 }, intro: { usd: 399, inr: 19900 } },
};

const RESTRICT_CODE = arg('restrict-code');
const CODE_PRODUCTS = (arg('code-products') || 'mega_pass').split(',').map(s => s.trim()).filter(Boolean);
/* The ONE authoritative promo end: the display window, the Dodo code expiry and the env
 * DODO_PROMO_EXPIRES_AT must all carry the same instant, so no gap exists where the site shows
 * normal prices while the code still discounts (or vice versa). */
const CODE_EXPIRY = arg('code-expiry');

async function main() {
  if (!MODE || !['intro', 'base', 'verify', 'restrict-code'].includes(MODE)) {
    process.stderr.write('usage: node scripts/v5/dodo-price-window.cjs --mode intro|base | --verify | --restrict-code <CODE> [--code-products id,id] [--mode-test] [--private-dir <dir>]\n');
    process.exitCode = 1;
    return;
  }
  const apiKey = fs.readFileSync(path.join(PRIVATE_DIR, 'api.key'), 'utf8').trim();
  const catalog = JSON.parse(fs.readFileSync(path.join(PRIVATE_DIR, 'catalog.json'), 'utf8'));
  const call = async (p, method, body) => {
    const res = await fetch(API_BASE + p, { method, headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw Error('DODO_HTTP_' + res.status + ' ' + p);
    return text ? JSON.parse(text) : null;
  };
  let failures = 0;
  const envLines = [];
  if (MODE === 'restrict-code') {
    if (!RESTRICT_CODE || RESTRICT_CODE.length < 3) { process.stderr.write('restrict-code needs a code\n'); process.exitCode = 1; return; }
    /* Sol P1 (promo audit): the list endpoint paginates with page_number/page_size and returns
     * items carrying discount_id (not id); restricted_to carries PROVIDER product ids (pdt_*),
     * so the internal game names are mapped through the catalog first. */
    const wanted = CODE_PRODUCTS.map(id => { const entry = catalog[id]; if (!entry || !entry.productId) { process.stderr.write('UNKNOWN_PRODUCT ' + id + '\n'); process.exitCode = 1; return null; } return entry.productId; });
    if (wanted.some(id => id === null)) return;
    let discount = null;
    /* Sol round 2: Dodo's discount list pagination is 0-based - a code in the first page is
     * missed when the scan starts at 1. */
    for (let page = 0; page <= 10 && !discount; page++) {
      const listed = await call('/discounts?page_number=' + page + '&page_size=100', 'GET');
      const items = listed && Array.isArray(listed.items) ? listed.items : [];
      discount = items.find(item => typeof item.code === 'string' && item.code.toUpperCase() === RESTRICT_CODE.toUpperCase()) || null;
      if (!items.length) break;
    }
    if (!discount || !(discount.discount_id || discount.id)) { process.stderr.write('DISCOUNT_NOT_FOUND ' + RESTRICT_CODE + '\n'); process.exitCode = 1; return; }
    const discountId = discount.discount_id || discount.id;
    const patchBody = { restricted_to: wanted };
    if (CODE_EXPIRY) {
      if (!Number.isFinite(Date.parse(CODE_EXPIRY))) { process.stderr.write('INVALID_CODE_EXPIRY\n'); process.exitCode = 1; return; }
      patchBody.expires_at = CODE_EXPIRY;
    }
    await call('/discounts/' + discountId, 'PATCH', patchBody);
    const after = await call('/discounts/' + discountId, 'GET');
    const scoped = after && Array.isArray(after.restricted_to) ? after.restricted_to : [];
    const expiryOk = !CODE_EXPIRY || after.expires_at === CODE_EXPIRY;
    const ok = wanted.every(id => scoped.includes(id)) && scoped.length === wanted.length && expiryOk;
    if (!expiryOk) process.stderr.write('EXPIRY_MISMATCH ' + String(after && after.expires_at) + '\n');
    process.stdout.write((ok ? 'restricted ' : 'RESTRICT_MISMATCH ') + discount.code + ' -> ' + JSON.stringify(scoped) + '\n');
    if (!ok) process.exitCode = 1;
    return;
  }
  for (const [productId, entry] of Object.entries(catalog)) {
    const skipFlip = productId === 'mega_pass';
    const target = MODE === 'verify' ? null : PRICES[productId] && PRICES[productId][MODE];
    if (MODE !== 'verify' && target && !skipFlip) {
      let patchPrice;
      if (productId === 'mega_pass') patchPrice = { type: 'recurring_price', currency: 'USD', price: target.usd, payment_frequency_count: 1, payment_frequency_interval: 'Month', subscription_period_count: 10, subscription_period_interval: 'Year' };
      else patchPrice = { type: 'one_time_price', currency: 'USD', price: target.usd };
      await call('/products/' + entry.productId, 'PATCH', { price: patchPrice });
    }
    /* MXA-INTRO-FLIP-INR (2026-10-19, Sol research): the USD PATCH alone leaves the INR
     * localized rule at its old amount - the verified production bug class this script exists
     * to close. Localized rules are separate entities (GET /products/{id}/localized-prices,
     * id lcp_*); PATCH only the amount, then re-read and MISMATCH-check against the table. */
    const localizedBefore = MODE === 'verify' ? null : await call('/products/' + entry.productId + '/localized-prices', 'GET');
    const rules = localizedBefore && Array.isArray(localizedBefore.items) ? localizedBefore.items : [];
    const inrRule = rules.find(rule => String(rule.currency).toUpperCase() === 'INR');
    if (MODE !== 'verify' && target && !skipFlip) {
     if (!inrRule) {
      await call('/products/' + entry.productId + '/localized-prices', 'POST', { currency: 'INR', country_code: 'IN', amount: target.inr });
     } else if (Number(inrRule.amount) !== target.inr) {
      await call('/products/' + entry.productId + '/localized-prices/' + inrRule.id, 'PATCH', { amount: target.inr });
     }
    }
    const after = await call('/products/' + entry.productId, 'GET');
    const actualUsd = after && after.price && Number(after.price.price);
    const expectedUsd = MODE === 'verify' ? null : (target ? target.usd : null);
    if (MODE !== 'verify' && actualUsd !== expectedUsd) { process.stderr.write('MISMATCH ' + productId + ': expected ' + expectedUsd + ' got ' + actualUsd + '\n'); failures++; }
    const inrAfter = (Array.isArray(after.localized_prices) ? after.localized_prices : rules).find(p => String(p.currency).toUpperCase() === 'INR');
    const actualInr = inrAfter ? Number(inrAfter.amount) : null;
    if (MODE !== 'verify' && target && actualInr !== target.inr) { process.stderr.write('MISMATCH ' + productId + ' INR: expected ' + target.inr + ' got ' + actualInr + '\n'); failures++; }
    envLines.push('DODO_PRICE_CENTS_' + productId.toUpperCase() + '=' + actualUsd);
    if (actualInr !== null) envLines.push('DODO_REGION_IN_' + productId.toUpperCase() + '=' + actualInr);
    process.stdout.write((MODE === 'verify' ? 'verify ' : 'flipped ') + productId + ' usd=' + actualUsd + (actualInr !== null ? ' inr=' + actualInr : '') + '\n');
  }
  if (MODE === 'base') { envLines.push('DODO_INTRO_ENDS_AT='); envLines.push('DODO_INTRO_PRICING_ACTIVE=false'); }
  if (MODE === 'intro') envLines.push('DODO_INTRO_PRICING_ACTIVE=true');
  process.stdout.write('\n# provider-signin.env block for the host (then restart mega-xo-v5-production):\n' + envLines.join('\n') + '\n');
  if (failures) { process.exitCode = 1; }
}

main().catch((error) => { process.stderr.write(String(error && error.message || error) + '\n'); process.exitCode = 1; });
