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

/* 2026-10-19: the Dodo lane is optional in the shape (absent or available:false keeps every
 * legacy reply valid). When present it carries the SERVER-AUTHORITATIVE per-currency display
 * prices per product; the caller's region currency picks among the CONFIGURED currencies only —
 * an unknown or unsupported region falls back to the base USD price, never an estimate. The
 * intro window is display metadata only; the charged amount is the configured price. */
function dodoBlock(status) {
  const block = status.dodo;
  if (block === undefined || block === null) return { available: false, products: {}, regions: {}, intro: null };
  if (typeof block !== 'object' || Array.isArray(block)) return { malformed: true };
  if (typeof block.available !== 'boolean' || !block.products || typeof block.products !== 'object' || Array.isArray(block.products) || !block.regions || typeof block.regions !== 'object' || Array.isArray(block.regions)) return { malformed: true };
  if (block.intro !== undefined && block.intro !== null && (typeof block.intro !== 'object' || Array.isArray(block.intro) || typeof block.intro.active !== 'boolean' || typeof block.intro.endsAt !== 'string')) return { malformed: true };
  return block;
}

export function normalizeStoreStatus(status, options = {}) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
  const polar = providerBlock(status, 'polar');
  const cashfree = providerBlock(status, 'cashfree');
  if (!polar || !cashfree) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
  const dodo = dodoBlock(status);
  if (dodo.malformed) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
  const regionCurrency = typeof options.regionCurrency === 'string' && CURRENCY_EXPONENTS[options.regionCurrency.toLowerCase()] !== undefined ? options.regionCurrency.toLowerCase() : null;
  const owned = Array.isArray(status.products) ? status.products : [];
  const rows = [];
  /* MXA-PROMO-CODE: the server decides when the launch code applies; the display discounts the
  * current price by the promo percentage only for products the server listed. */
  const dodoPromoBlock = dodo.available === true && dodo.promo && typeof dodo.promo === 'object' && !Array.isArray(dodo.promo) && Array.isArray(dodo.promo.products) && Number.isSafeInteger(dodo.promo.percentBps) && dodo.promo.percentBps > 0 && dodo.promo.percentBps < 10000 && !(dodo.intro && dodo.intro.active === true) ? dodo.promo : null;
  const dodoPromoFor = id => dodoPromoBlock && dodoPromoBlock.products.includes(id) ? dodoPromoBlock : null;
  for (const id of WEB_PRODUCT_IDS) {
    const polarEntry = polar.products[id];
    if (polarEntry !== undefined && polarEntry !== null) {
      if (!polarEntry || typeof polarEntry !== 'object' || Array.isArray(polarEntry)) return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
      if (!Number.isSafeInteger(polarEntry.amountCents) || polarEntry.amountCents <= 0 || typeof polarEntry.currency !== 'string') return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
    }
    const inr = cashfree.available === true && typeof cashfree.products[id] === 'string' && cashfree.products[id].trim() ? cashfree.products[id] : null;
    const usdMinor = polar && polar.available === true && polarEntry ? polarEntry.amountCents : null;
    const dodoRegionPrices = dodo.available === true && dodo.regions[id] && typeof dodo.regions[id] === 'object' && !Array.isArray(dodo.regions[id]) ? dodo.regions[id] : null;
    const dodoRegularRegions = dodo.available === true && dodo.regularRegions && typeof dodo.regularRegions === 'object' && !Array.isArray(dodo.regularRegions) && dodo.regularRegions[id] && typeof dodo.regularRegions[id] === 'object' && !Array.isArray(dodo.regularRegions[id]) ? dodo.regularRegions[id] : null;
    if (dodo.available === true && dodo.products[id] !== undefined && dodo.products[id] !== null) {
      const base = dodo.products[id];
      if (!base || typeof base !== 'object' || Array.isArray(base) || !Number.isSafeInteger(base.amountCents) || base.amountCents <= 0 || typeof base.currency !== 'string') return { ok: false, errorCode: 'STORE_UNAVAILABLE' };
    }
    const dodoMinor = dodoRegionPrices && regionCurrency && Number.isSafeInteger(dodoRegionPrices[regionCurrency]) ? dodoRegionPrices[regionCurrency] : (dodoRegionPrices && Number.isSafeInteger(dodoRegionPrices.usd) ? dodoRegionPrices.usd : null);
    const dodoCurrency = dodoMinor !== null ? (regionCurrency && dodoRegionPrices && Number.isSafeInteger(dodoRegionPrices[regionCurrency]) ? regionCurrency : 'usd') : null;
    const dodoPromo = dodoPromoFor(id);
    const dodoDisplayMinor = dodoMinor !== null && dodoPromo ? Math.max(1, Math.round(dodoMinor * (1 - dodoPromo.percentBps / 10000))) : dodoMinor;
    const dodoRegularMinor = dodoRegularRegions && dodoCurrency && Number.isSafeInteger(dodoRegularRegions[dodoCurrency]) ? dodoRegularRegions[dodoCurrency] : null;
    rows.push({
      id,
      kind: id === 'mega_pass' ? 'subscription' : 'once',
      owned: owned.includes(id),
      usdMinor,
      polarPrice: usdMinor !== null ? formatMinor(usdMinor, polarEntry.currency) : null,
      inr,
      dodoPrice: dodoDisplayMinor !== null ? formatMinor(dodoDisplayMinor, dodoCurrency) : null,
      dodoCurrency,
      dodoRegularPrice: dodoRegularMinor !== null && dodoMinor !== null && dodoRegularMinor > dodoMinor ? formatMinor(dodoRegularMinor, dodoCurrency) : null,
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
    webCheckoutAvailable: status.webCheckoutAvailable === true && (polar.available === true || cashfree.available === true || dodo.available === true),
    webCheckoutProvider: typeof status.webCheckoutProvider === 'string' && ['dodo', 'polar', 'cashfree'].includes(status.webCheckoutProvider) ? status.webCheckoutProvider : null,
    dodoIntro: dodo.intro ? { active: dodo.intro.active === true, endsAt: dodo.intro.endsAt } : null,
    dodoPromo: dodoPromoBlock ? { code: dodoPromoBlock.code, percentBps: dodoPromoBlock.percentBps, endsAt: dodoPromoBlock.expiresAt } : null,
  };
}
