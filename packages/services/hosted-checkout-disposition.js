'use strict';

// These codes come only from the inspected Dodo/Polar adapters' pre-POST validation,
// product lookup, or explicit authentication/validation rejection. A 5xx, timeout,
// conflict, rate limit or malformed success never proves that no session exists.
function provenNonCreation(provider, code) {
 const prefix = provider === 'dodo' ? 'DODO' : provider === 'polar' ? 'POLAR' : null;
 if (!prefix || typeof code !== 'string') return false;
 if ([prefix + '_AUTH', prefix + '_CONFIG'].includes(code)) return true;
 if (provider === 'dodo' && ['INVALID_PRODUCT_ID', 'DODO_METADATA_INVALID', 'DODO_CURRENCY_UNSUPPORTED', 'DODO_DISCOUNT_INVALID', 'INVALID_CUSTOMER_DETAILS'].includes(code)) return true;
 if (provider === 'polar' && ['INVALID_PRICE_ID', 'POLAR_PRICE_NOT_FOUND'].includes(code)) return true;
 return new RegExp('^' + prefix + '_HTTP_(400|401|403|404|405|413|415|422)$').test(code);
}
function fail(code, status = 400) { const error = Error(code); error.code = code; error.status = status; throw error; }
function https(value) {
 try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
 catch { return null; }
}

function createHostedCheckoutDisposition(uow) {
 return async function disposition(actor, provider, key, productId, currency) {
  if (!['dodo', 'polar'].includes(provider) || typeof actor !== 'string' || !actor) fail('AUTH_REQUIRED', 401);
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(key)) fail('IDEMPOTENCY_KEY_REQUIRED');
  if (typeof productId !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(productId) || !/^[a-z]{3}$/.test(currency)) fail('INVALID_PRODUCT');
  return uow.run(async tx => {
   await tx.query('SET TRANSACTION READ ONLY');
   const row = (await tx.query('SELECT provider, product_id, price_snapshot, state, provider_object_id, response_text, error_code FROM monetization.commerce_create_requests WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0] || null;
   const order = (await tx.query('SELECT checkout_id, product_id, currency, status FROM monetization.' + provider + '_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0] || null;
   const snapshot = row && (typeof row.price_snapshot === 'string' ? JSON.parse(row.price_snapshot) : row.price_snapshot);
   if ((row && (row.provider !== provider || row.product_id !== productId || String(snapshot?.currency || '').toLowerCase() !== currency)) ||
    (order && (order.product_id !== productId || String(order.currency).toLowerCase() !== currency))) fail('IDEMPOTENCY_CONFLICT', 409);
   const binding = {actorId:actor, provider, key, productId, currency};
   if (order) {
    let response = null;
    try { response = JSON.parse(row?.response_text || 'null'); } catch { /* URL absent, keep identity */ }
    const checkoutUrl = row?.state === 'READY' && row.provider_object_id === order.checkout_id && response?.checkoutId === order.checkout_id ? https(response.checkoutUrl) : null;
    return {...binding, disposition:'ready', checkoutId:order.checkout_id, status:order.status, ...(checkoutUrl ? {checkoutUrl} : {})};
   }
   // Legacy FAILED rows include upstream 5xx from the old broad classifier. Never
   // promote the label alone into non-creation evidence. No allocation is deleted,
   // released or modified by this read; a later new purchase still faces the cap.
   if (row?.state === 'FAILED' && !row.provider_object_id && provenNonCreation(provider, row.error_code)) return {...binding, disposition:'not_created'};
   return {...binding, disposition:'ambiguous', retrySameKey:!row};
  });
 };
}
module.exports = {createHostedCheckoutDisposition, provenNonCreation};
