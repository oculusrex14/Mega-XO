#!/usr/bin/env node
'use strict';

/* 2026-10-19: the Dodo intro-price window flip. The 50% launch prices live DIRECTLY on the Dodo
 * products (never discount codes), so the window boundary is an explicit, verified price flip:
 *
 *   node scripts/v5/dodo-price-window.cjs --mode intro   # before the window opens (already done)
 *   node scripts/v5/dodo-price-window.cjs --mode base    # when the window closes
 *   node scripts/v5/dodo-price-window.cjs --verify       # read-only: confirm env matches Dodo
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
const MODE = arg('mode') || (flag('verify') ? 'verify' : null);
const API_BASE = (flag('mode-test') ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com');

/* The launch price table. INTRO is the live 50%-off launch price; BASE is the standard price the
 * window reverts to. Amounts are integer minor units and MUST equal the env block the script
 * prints (the production server refuses boot when the env and these expectations disagree). */
const PRICES = {
  crowns_100: { base: { usd: 99, inr: 4900 }, intro: { usd: 49, inr: 2500 } },
  crowns_525: { base: { usd: 499, inr: 24900 }, intro: { usd: 249, inr: 12500 } },
  crowns_1100: { base: { usd: 999, inr: 49900 }, intro: { usd: 499, inr: 25000 } },
  remove_ads: { base: { usd: 399, inr: 19900 }, intro: { usd: 199, inr: 9900 } },
  mega_pass: { base: { usd: 399, inr: 19900 }, intro: { usd: 199, inr: 9900 } },
};

async function main() {
  if (!MODE || !['intro', 'base', 'verify'].includes(MODE)) {
    process.stderr.write('usage: node scripts/v5/dodo-price-window.cjs --mode intro|base | --verify [--mode-test] [--private-dir <dir>]\n');
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
  for (const [productId, entry] of Object.entries(catalog)) {
    const target = MODE === 'verify' ? null : PRICES[productId] && PRICES[productId][MODE];
    if (MODE !== 'verify' && target) {
      let patchPrice;
      if (productId === 'mega_pass') patchPrice = { type: 'recurring_price', currency: 'USD', price: target.usd, payment_frequency_count: 1, payment_frequency_interval: 'Month', subscription_period_count: 10, subscription_period_interval: 'Year' };
      else patchPrice = { type: 'one_time_price', currency: 'USD', price: target.usd };
      await call('/products/' + entry.productId, 'PATCH', { price: patchPrice });
    }
    const after = await call('/products/' + entry.productId, 'GET');
    const actualUsd = after && after.price && Number(after.price.price);
    const expectedUsd = MODE === 'verify' ? null : (target ? target.usd : null);
    if (MODE !== 'verify' && actualUsd !== expectedUsd) { process.stderr.write('MISMATCH ' + productId + ': expected ' + expectedUsd + ' got ' + actualUsd + '\n'); failures++; }
    envLines.push('DODO_PRICE_CENTS_' + productId.toUpperCase() + '=' + actualUsd);
    const inrEntry = Array.isArray(after.localized_prices) ? after.localized_prices.find(p => p.currency === 'INR') : null;
    if (inrEntry) envLines.push('DODO_REGION_IN_' + productId.toUpperCase() + '=' + Number(inrEntry.amount));
    process.stdout.write((MODE === 'verify' ? 'verify ' : 'flipped ') + productId + ' usd=' + actualUsd + (inrEntry ? ' inr=' + Number(inrEntry.amount) : '') + '\n');
  }
  if (MODE === 'base') envLines.push('DODO_INTRO_ENDS_AT=');
  process.stdout.write('\n# provider-signin.env block for the host (then restart mega-xo-v5-production):\n' + envLines.join('\n') + '\n');
  if (failures) { process.exitCode = 1; }
}

main().catch((error) => { process.stderr.write(String(error && error.message || error) + '\n'); process.exitCode = 1; });
