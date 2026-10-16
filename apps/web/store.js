/* A2 (2026-10-17): the provider-neutral Store offer normalizer. Pure and side-effect free so it
 * can be tested independently of the DOM: the server-validated /api/monetization/status shape is
 * the only input, unknown or malformed provider rows are REFUSED rather than rendered, and no
 * receipt, token or customer PII ever passes through here. Native localized store prices stay
 * native-authoritative; web prices come from integer minor units plus a supported currency
 * exponent, never from an exchange-rate estimate. */
export const WEB_PRODUCT_IDS = ['crowns_100', 'crowns_525', 'crowns_1100', 'remove_ads', 'mega_pass'];
const CURRENCY_EXPONENTS = { usd: 2, eur: 2, gbp: 2, inr: 2 };

export function formatMinor(amountMinor, currency) {
  const code = String(currency || 'USD').toLowerCase();
  const exponent = CURRENCY_EXPONENTS[code];
  if (exponent === undefined || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  const value = amountMinor / Math.pow(10, exponent);
  try {
    return value.toLocaleString('en-US', { style: 'currency', currency: code.toUpperCase(), minimumFractionDigits: exponent, maximumFractionDigits: exponent });
  } catch {
    return null;
  }
}

function providerBlock(status, name) {
  const block = status[name];
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  if (typeof block.available !== 'boolean' || !block.products || typeof block.products !== 'object' || Array.isArray(block.products)) return null;
  return block;
}

export function normalizeStoreStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
  const polar = providerBlock(status, 'polar');
  const cashfree = providerBlock(status, 'cashfree');
  if (!polar || !cashfree) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
  const owned = Array.isArray(status.products) ? status.products : [];
  const rows = [];
  for (const id of WEB_PRODUCT_IDS) {
    const polarEntry = polar.products[id];
    if (polarEntry !== undefined && polarEntry !== null) {
      if (!polarEntry || typeof polarEntry !== 'object' || Array.isArray(polarEntry)) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
      if (!Number.isSafeInteger(polarEntry.amountCents) || polarEntry.amountCents <= 0 || typeof polarEntry.currency !== 'string') return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
    }
    const inr = cashfree.available === true && typeof cashfree.products[id] === 'string' && cashfree.products[id].trim() ? cashfree.products[id] : null;
    const usdMinor = polar && polar.available === true && polarEntry ? polarEntry.amountCents : null;
    rows.push({
      id,
      kind: id === 'mega_pass' ? 'subscription' : 'once',
      owned: owned.includes(id),
      usdMinor,
      polarPrice: usdMinor !== null ? formatMinor(usdMinor, polarEntry.currency) : null,
      inr,
    });
  }
  const rawPass = status.pass && typeof status.pass === 'object' && !Array.isArray(status.pass) ? status.pass : {};
  return {
    ok: true,
    rows,
    pass: {
      active: rawPass.active === true,
      periodEnd: Number.isFinite(rawPass.periodEnd) ? rawPass.periodEnd : null,
      cancelAtPeriodEnd: rawPass.cancelAtPeriodEnd === true,
    },
    webCheckoutAvailable: status.webCheckoutAvailable === true && (polar.available === true || cashfree.available === true),
  };
}
