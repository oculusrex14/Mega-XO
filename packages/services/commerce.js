/* MXA-ECO-011 (2026-10-18): the pass exchange split. Coins -> Crowns at the pass rate for the
 * first PASS.exchangeMonthlyCoinAllowance Coins of each billing month (the durable 0060
 * exchange_coins_used ledger), the rest at the frozen 10:1 policy rate. The discounted tranche
 * comes from EARNED coins only - purchased coins keep the 10:1 provenance rate, so a
 * crowns->coins->crowns round trip can never mint value. Pure and exported for tests. */
function passExchangeSplit(amount, allowanceRemaining, earnedAvailable) {
 if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('INVALID_AMOUNT');
 const cap = Math.max(0, Math.min(amount, allowanceRemaining, earnedAvailable));
 let discounted = 8 * Math.floor(cap / 8);
 while (discounted >= 0 && (amount - discounted) % 10 !== 0) discounted -= 8;
 if (discounted < 0) throw Error('EXCHANGE_AMOUNT_INVALID');
 return { discounted, standard: amount - discounted, crowns: discounted / 8 + (amount - discounted) / 10 };
}

/* packages/services/commerce.js - V5 P04 PostgreSQL store/monetization service (Core authority).
 *
 * The PostgreSQL successor of `server/monetization-store.js` (MonetizationStore). Every RULE stays
 * where it already was: the catalogue, policy, day caps and cohort split are the frozen pure
 * `src/monetization.js` (`M.product`, `M.frame`, `M.POLICY`, `M.qualifiedCasual`, `M.boostApplies`,
 * `M.cohort`, `M.day`), the wallet/progress arithmetic is the frozen `src/domain.js` (`D.add`), and
 * the durable idempotency family is the SAME `packages/db/scopes.js` V35_COMMANDS layout
 * (`(actor, key)` primary key, `sha256(JSON.stringify(command))` fingerprint, response JSON TEXT
 * verbatim). Nothing is re-created here. The stored response object is returned unchanged on
 * replay, exactly like the source boundary.
 *
 *   const commerce = await createCommerceService(pool, { now, eligible, verifyPurchase, verifyAd, adMode, purchasesEnabled });
 *   await commerce.purchase(actor, key, evidence);      // backend-verified receipt -> durable grant
 *   await commerce.ticket(actor, key, 'credits', 'android');
 *   await commerce.callback(rawSsvPayload);             // provider callback; never a client-watched grant
 *   await commerce.claim(actor, key);                   // casual-play credits
 *   await commerce.refund(store, transactionId);        // trusted store-notification path
 *   commerce.close();                                   // closes the UoW, NOT the pool
 *
 * PROVIDER BOUNDARY. `verifyPurchase` / `purchaseProvider.verify` / `verifyAd` / provider
 * `finalize` are external I/O and are awaited OUTSIDE the economic transaction - before it opens,
 * or after it commits - never inside a wallet lock (spec 03 section 1). The trusted projection of
 * the proof enters the transaction; actor/product/environment/permanent bindings are verified and
 * the grant becomes durable in the same transaction as its idempotency outcome.
 *
 * NO CLIENT-WATCHED GRANT, NO PREMATURE CONSUME. `callback` grants only a `reward_tickets` row this
 * service issued and that the provider independently confirmed; the request is verified against the
 * ticket actor, platform, ad unit, issue/expiry window and the grace window. Provider
 * consume/acknowledge (`purchaseProvider.finalize`) is requested only AFTER the grant transaction
 * has committed, and a pending finalization is reported (`finalizationPending`) rather than
 * silently dropped.
 *
 * STORAGE BOUNDARY (design: `packages/db/pg` repository aggregate + entity tables).
 *  - The aggregate seam already owns and persists exactly what the hydrated account carries:
 *    `monetization.credits` (credits, equipped, last_ad_at, last_reward_start),
 *    `monetization.redeemed_frames`, `monetization.boosts`, `monetization.reward_daily`,
 *    `monetization.receipts`, `economy.wallets.crowns`, `economy.ledger` and
 *    `cosmetics.owned_items`. Those paths go through `commitDomain()`.
 *  - The remaining `v35_*`/`v41_*` tables are NOT part of that aggregate, and 0021 grants
 *    core_runtime full DML on `monetization.reward_tickets`, `casual_rewards`, `reward_events` and
 *    `ad_ticket_context`, so this service writes those four tables with its own bounded
 *    parameterized statements inside the same transaction - exactly as `tournaments.save` writes
 *    the room entity rows. No new member is invented in the frozen adapter and no grant is widened.
 *  - `monetization.store_finalize` / `store_notifications` are worker-owned (0022) and the full
 *    durable provider lifecycle (claim/fence/backoff/dead-letter) is P10 work. This service only
 *    requests provider finalization AFTER a grant commit (`purchaseProvider.finalize`), and
 *    `processPurchaseFinalizations` delegates to `options.purchaseProvider.processDue` when one is
 *    configured - otherwise it fails closed with STORE_FINALIZATION_UNAVAILABLE rather than
 *    reporting a fake `{processed:0,completed:0}` sweep. No P10/provider acceptance is claimed here.
 *
 * LOCK ORDER. Every actor-touching transaction in this file takes the actor's `identity.eligibility`
 * row (sorted) BEFORE `core.actor_occupancy`/`economy.wallets`, matching `core.provisionActor`: no
 * `monetization.*` command names a match/tournament aggregate, so the actor-scoped half of the
 * global order applies (eligibility -> occupancy -> wallet), exactly like a conversion or a
 * purchase. No Core path puts eligibility before a named aggregate.
 *
 * NO MINTING AT BOOT. The constructor creates no table, no row, no binding and no balance. A store
 * binding is READ (`monetization.store_bindings`); the legacy `StoreBindings.get` minted a Google
 * obfuscated id and an Apple app-account token, and that mint belongs to the API signup handshake
 * (P05), not to a boot path - so a missing binding is reported as absent
 * (`STORE_BINDING_REQUIRED` on a purchase) instead of being fabricated here.
 */
'use strict';
const crypto = require('node:crypto');
const { createPgUnitOfWork } = require('../db/pg/uow.js');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');
const { PgGuardError } = require('../db/pg/guards.js');
const { V35_COMMANDS } = require('../db/scopes.js');
const { lockEligibility } = require('./core.js');
const { lockTransactionIdentity } = require('../db/pg/locks.js');
const M = require('../../src/monetization.js');
const D = require('../../src/domain.js');
const { newOrderId } = require('./cashfree.js');
const { UUID_V4 } = require('./polar.js');
const { SESSION_ID, SUPPORTED_CURRENCIES } = require('./dodo.js');
const Promotion = require('./promotion-allocation.js');

const CORE_ROLE = 'core_runtime';
const DAY = 86400000;
const OUTBOX_EXPIRY_MS = 7 * DAY;
const OUTBOX_KIND = 'commerce.command';

/* Legacy key grammar (server/monetization-store.js idOK). */
function idOK(value) { return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value); }
function sha256hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

/* SEC-V52-CASHFREE-IDEMPOTENCY-RACE (owner-delegated decision: reserve-then-create). The
 * (actor, op_key) reservation in 0058 is taken BEFORE any provider I/O; only the reservation
 * winner ever calls the provider. The fingerprint is the SAME sha256(JSON.stringify(command))
 * the V35_COMMANDS claim uses, so the reservation and the outcome fence agree on identity. */
const CREATE_DEADLINE_MS = 10000;
const RESERVATION_STALE_MS = 60000;
function createFingerprint(type, productId) { return sha256hex(JSON.stringify({ type, productId })); }

function withDeadline(promise, ms = CREATE_DEADLINE_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = Error('CREATE_DEADLINE_EXCEEDED'); e.ambiguous = true; reject(e); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* Inserts the PENDING reservation under the durable (actor, op_key) fence. Returns
 * { won: true, requestId } for the inserter - the ONLY caller allowed to reach the provider -
 * or { won: false, reservation } with the winner's row for conflict/replay handling. */
async function reserveCreate(uow, actor, key, provider, productId, fingerprint, priceSnapshot, acceptanceHash = null) {
  return uow.run(async (tx) => {
    await lockEligibility(tx.query, [actor]);
    const locked = await tx.repositories.wallets.lock([actor]);
    if (!locked.wallets) throw Error('ACCOUNT_REQUIRED');
    const prior = (await tx.query('SELECT request_id FROM monetization.commerce_create_requests WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0];
    if (!prior) {
      const allocation = await Promotion.reserve(tx, actor, key, provider, M.product(productId), acceptanceHash);
      if (allocation) priceSnapshot = { ...priceSnapshot, promotion: allocation };
    }
    const inserted = await tx.query(
      'INSERT INTO monetization.commerce_create_requests (request_id, actor_id, op_key, provider, product_id, fingerprint, price_snapshot, state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9) ON CONFLICT (actor_id, op_key) DO NOTHING RETURNING request_id',
      [crypto.randomUUID(), actor, key, provider, productId, fingerprint, JSON.stringify(priceSnapshot), 'PENDING', iso(tx.clock())]);
    if (inserted.rows.length > 0) return { won: true, requestId: inserted.rows[0].request_id };
    const row = (await tx.query('SELECT request_id, provider, product_id, fingerprint, state, provider_object_id, error_code, created_at, updated_at FROM monetization.commerce_create_requests WHERE actor_id = $1 AND op_key = $2 FOR UPDATE', [actor, key])).rows[0];
    return { won: false, reservation: row || null };
  });
}

/* Terminal state write for a reservation (FAILED / UNKNOWN), independent of any ledger
 * commit: an explicit provider rejection becomes FAILED with its sanitized code; an ambiguous
 * transport outcome becomes UNKNOWN and is recovered only by an explicit provider read. */
async function markReservation(uow, requestId, state, opts = {}) {
  await uow.run(async (tx) => {
    await tx.query(
      'UPDATE monetization.commerce_create_requests SET state = $2, provider_object_id = COALESCE($3, provider_object_id), error_code = $4, updated_at = $5 WHERE request_id = $1',
      [requestId, state, opts.providerObjectId || null, opts.errorCode || null, iso(tx.clock())]);
  });
}

/* A PENDING row older than the stale window is treated exactly like UNKNOWN: the provider
 * call either long finished or never left, and only an explicit provider read may resolve it. */
function effectivelyUnknown(row, now) {
  if (!row) return false;
  if (row.state === 'UNKNOWN') return true;
  if (row.state === 'PENDING') return now - Date.parse(row.updated_at) > RESERVATION_STALE_MS;
  return false;
}
function iso(ms) { return new Date(ms).toISOString(); }
function msOf(value) {
 if (value === null || value === undefined) return null;
 if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
 const n = Number(value);
 return Number.isFinite(n) ? n : null;
}

/* The account gate of the legacy store: a linked, unheld account only. A missing actor is the
 * frozen adapter's `ACCOUNT_REQUIRED` (the V5 vocabulary for a missing aggregated account; the V4
 * `Authority` said `UNKNOWN_ACCOUNT`). */
function accountOf(graph, actor) {
 const account = graph.account(actor);
 if (!account.verified) throw Error('LINK_ACCOUNT_REQUIRED');
 if (account.suspended || account.hold) throw Error('ACCOUNT_HELD');
 return account;
}

/* Sanitized durable outbox event. Routing facts only - never a receipt, a purchase token, a
 * provider transaction id or a balance: the authoritative grant already lives in
 * monetization.receipts / reward_tickets and the ledger. */
async function emitOutbox(tx, { id, event, kind = OUTBOX_KIND }) {
 const now = tx.clock();
 await tx.query(
  'INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at, lease_until, attempts)'
  + " VALUES ($1, $2, $3, 'queued', $4, $5, $4, '1970-01-01T00:00:00+00:00', 0)"
  + ' ON CONFLICT (outbox_id) DO NOTHING',
  [id, JSON.stringify(event), kind, iso(now), iso(now + OUTBOX_EXPIRY_MS)]);
 return id;
}

/* The legacy constructor's ad-unit normalization, verbatim. */
function normalizeAdUnits(adUnits, adUnit) {
 const normalized = {};
 for (const [platform, value] of Object.entries(adUnits || {})) {
  if (!['android', 'ios'].includes(platform) || !value || typeof value !== 'object') continue;
  const rewarded = typeof value.rewarded === 'string' ? value.rewarded : '';
  const interstitial = typeof value.interstitial === 'string' ? value.interstitial : '';
  if (rewarded || interstitial) normalized[platform] = { rewarded, interstitial };
 }
 if (adUnit) normalized.legacy = { rewarded: adUnit, interstitial: adUnit };
 return Object.freeze(normalized);
}

async function createCommerceService(pool, options = {}) {
 if (!pool || typeof pool.describe !== 'function' || typeof pool.withTransaction !== 'function') {
  throw new PgGuardError('PG_POOL_REQUIRED');
 }
 const described = pool.describe();
 if (!described || described.role !== CORE_ROLE) {
  throw new PgGuardError('ROLE_MISMATCH', { expected: CORE_ROLE, observed: described ? described.role : null }, 'the commerce service must run on a core_runtime pool (monetization.* is core-owned)');
 }
 if (options.now !== undefined && typeof options.now !== 'function') throw new PgGuardError('CLOCK_REQUIRED');
 if (options.eligible !== undefined && typeof options.eligible !== 'function') throw new PgGuardError('ELIGIBILITY_POLICY_REQUIRED');
 for (const name of ['verifyPurchase', 'verifyAd']) {
  /* null is the legitimate 'lane off' value (adMode off composes verifyAd: null); only a
   * NON-NULL non-function is a composition error. */
  if (options[name] != null && typeof options[name] !== 'function') throw new PgGuardError('VERIFIER_REQUIRED', { verifier: name });
 }
 /* The legacy constructor validated the mode through the pure cohort function; an unknown mode is
  * refused (INVALID_AD_MODE) before any statement. */
 const adMode = options.adMode === undefined ? 'off' : options.adMode;
 M.cohort('validate', adMode);
 /* Boot gate: read-only chain verification. No DDL, no seeding, no default rows. */
 const readiness = await verifyRuntimeSchema(pool);

 const config = {
  eligible: typeof options.eligible === 'function' ? options.eligible : () => false,
  purchasesEnabled: options.purchasesEnabled === true,
  verifyPurchase: options.verifyPurchase || null,
  verifyAd: options.verifyAd || null,
  purchaseProvider: options.purchaseProvider || null,
  cashfreeProvider: options.cashfreeProvider || null,
  cashfreeEnv: options.cashfreeEnv || 'PRODUCTION',
  cashfreeCatalog: options.cashfreeCatalog || null,
  cashfreeReturnUrl: typeof options.cashfreeReturnUrl === 'string' ? options.cashfreeReturnUrl : '',
  cashfreeNotifyUrl: typeof options.cashfreeNotifyUrl === 'string' ? options.cashfreeNotifyUrl : '',
  polarProvider: options.polarProvider || null,
  polarCatalog: options.polarCatalog || null,
  polarSuccessUrl: typeof options.polarSuccessUrl === 'string' ? options.polarSuccessUrl : '',
  /* MXA-ECO-005: the composed verification classes (server/v5-store-notifications.js). */
  storeNotificationHandlers: options.storeNotificationHandlers || null,
  /* Sol review 2026-10-18: the discount id must reach the service or the pack-discount guard is dead. */
  polarPackDiscountId: typeof options.polarPackDiscountId === 'string' && options.polarPackDiscountId ? options.polarPackDiscountId : null,
  /* 2026-10-19: the Dodo lane (owner decision: Dodo = PRIMARY web checkout, Polar dormant).
   * The catalog price per product is a per-currency map of the SERVER-AUTHORITATIVE amounts
   * configured on the Dodo product (usd base + localized inr); the intro window is display
   * metadata only - the charged amount is whatever the configured Dodo product price says. */
  dodoProvider: options.dodoProvider || null,
  dodoCatalog: options.dodoCatalog || null,
  /* 2026-10-19: the REGULAR (pre-intro) price catalog, display-only (the slashed-price promo).
   * Optional: absent config simply means the client renders no was/now comparison. */
  dodoRegularCatalog: options.dodoRegularCatalog || null,
  /* MXA-PROMO-RESTORE-LEDGER (Sol round 2): the INTRO price catalog is RETAINED after the
   * restore so settlement keeps knowing every price the product legitimately carried during the
   * promo era - a legacy or boundary-crossing order then verifies at its recorded amount, the
   * current catalog, the regular price or the intro price (all the product's own prices), no
   * matter how many flips, restarts or partial restores happened since creation. */
  dodoIntroCatalog: options.dodoIntroCatalog || null,
  dodoSuccessUrl: typeof options.dodoSuccessUrl === 'string' ? options.dodoSuccessUrl : '',
  dodoPackDiscountId: typeof options.dodoPackDiscountId === 'string' && options.dodoPackDiscountId ? options.dodoPackDiscountId : null,
  dodoIntroEndsAt: typeof options.dodoIntroEndsAt === 'string' && options.dodoIntroEndsAt ? options.dodoIntroEndsAt : null,
  /* MXA-INTRO-STACKING (2026-10-19): the pass pack discount must key off whether the INTRO
   * PRICES are actually live, not merely whether the display timestamp has passed - a delayed
   * Nov 18 flip would otherwise stack the 15% pass discount on top of intro prices (42.5% of
   * regular). The flag is set by the price-flip procedure together with the price env; absent
   * flag falls back to the timestamp check (backward compatible with today's deployment). */
  dodoIntroPricingActive: options.dodoIntroPricingActive === true ? true : options.dodoIntroPricingActive === false ? false : null,
  /* MXA-PROMO-CODE (2026-10-19): the owner's launch-price bridge. After the intro flip, the
   * LAUNCH50 Dodo discount code keeps the Mega Pass at 50% off until it expires (2027-01-01);
   * the SERVER decides when to attach it (never the client) and records the DISCOUNTED amount
   * so settlement verification matches the actually charged total. products: the game product
   * ids the promo applies to; the Dodo code itself is restricted to the same product set. */
  dodoPromo: (() => {
   const promo = options.dodoPromo;
   if (!promo || typeof promo !== 'object') return null;
   const code = typeof promo.code === 'string' ? promo.code.trim() : '';
   const percentBps = Number(promo.percentBps);
   const expiresAt = typeof promo.expiresAt === 'string' ? promo.expiresAt : '';
   const products = Array.isArray(promo.products) ? promo.products.filter(id => typeof id === 'string' && M.product(id)) : [];
   if (!code || !/^[A-Za-z0-9_-]{3,64}$/.test(code) || !Number.isSafeInteger(percentBps) || percentBps <= 0 || percentBps >= 10000 || !Number.isFinite(Date.parse(expiresAt)) || products.length === 0) return null;
   return Object.freeze({ code, percentBps, expiresAt, products: Object.freeze(products) });
  })(),
  adMode,
  rewardItem: typeof options.rewardItem === 'string' && options.rewardItem ? options.rewardItem : 'cosmetic_reward',
  adUnits: normalizeAdUnits(options.adUnits, options.adUnit),
  busy: typeof options.busy === 'function' ? options.busy : () => false,
 };

 const uow = createPgUnitOfWork(pool, { role: CORE_ROLE, now: options.now });
 /* The service clock: the frozen test clock in harnesses, wall time in production. The ledger
  * sweep and the subscription reconciliation use the SAME source as every other economic read. */
 const serviceNow = typeof options.now === 'function' ? options.now : Date.now;

 function allowed(account) { return config.eligible(structuredClone(account)) === true; }

/* ------------------------------------------------------------------- cashfree (LR13)
 *
 * The authoritative Cashfree web-commerce lane (owner brief C04): the provider order is created
 * server-side from a SERVER-AUTHORITATIVE catalog price (never a client amount), recorded in the
 * Core-owned monetization.cashfree_orders table (0056), and settled only after an INDEPENDENT
 * provider verification - a browser returning from checkout, a captured webhook or a replayed
 * signed webhook alone never grants. The receipts table keeps its ('google','apple') CHECK: a
 * Cashfree settlement is recorded in cashfree_orders (the additive contract), and once-products
 * are projected from it by cashfreeOnceRows below. */

 const CASHFREE_PRICE = /^\d+(\.\d{1,2})?$/;
 function cashfreePrice(productId) {
  if (!config.cashfreeProvider || typeof config.cashfreeProvider.createOrder !== 'function') throw Error('CASHFREE_UNAVAILABLE');
  if (!config.cashfreeCatalog || typeof config.cashfreeCatalog !== 'object' || Array.isArray(config.cashfreeCatalog)) throw Error('CASHFREE_UNAVAILABLE');
  const price = config.cashfreeCatalog[productId];
  if (typeof price !== 'string' || !CASHFREE_PRICE.test(price) || Number(price) <= 0) throw Error('INVALID_PRODUCT');
  if (!M.product(productId)) throw Error('INVALID_PRODUCT');
  return price;
 }

 /* Boot-time catalog validation: a partially configured catalog must refuse loudly, exactly like
  * the legacy production config (INCOMPLETE_CASHFREE_PRICE / INVALID_CASHFREE_PRICE). */
 function validateCashfreeCatalog() {
  if (!config.cashfreeProvider) return;
  if (!config.cashfreeCatalog || typeof config.cashfreeCatalog !== 'object' || Array.isArray(config.cashfreeCatalog)) throw new PgGuardError('CASHFREE_CATALOG_REQUIRED');
  for (const [productId, price] of Object.entries(config.cashfreeCatalog)) {
   if (!M.product(productId)) throw new PgGuardError('INVALID_CASHFREE_PRODUCT', { productId });
   if (typeof price !== 'string' || !CASHFREE_PRICE.test(price) || Number(price) <= 0) throw new PgGuardError('INVALID_CASHFREE_PRICE', { productId });
  }
 }
 validateCashfreeCatalog();

/* ---------------------------------------------------------------------- polar (C05)
 *
 * The Polar lane (the owner decision: PRIMARY GLOBAL payments, the INDIAN FALLBACK behind
 * Cashfree) mirrors the Cashfree contract exactly: the server-side catalog price is recorded at
 * creation, the settlement requires an INDEPENDENT provider verification with the exact recorded
 * amount AND the metadata actor/product binding, and the refund is a terminal refunded_at under
 * the same order-identity mutex. The receipts table keeps its ('google','apple') CHECK - a Polar
 * settlement is recorded in monetization.polar_orders (0057), the additive data contract. */

 const POLAR_CENTS = /^\d{1,9}$/;
 /* A3: the browser SDK must load the SAME environment the order was created in. */
 const cashfreeSdkMode = config.cashfreeEnv === 'TEST' ? 'sandbox' : 'production';
 function polarCatalogEntry(productId) {
  if (!config.polarProvider || typeof config.polarProvider.createCheckout !== 'function') throw Error('POLAR_UNAVAILABLE');
  if (!config.polarCatalog || typeof config.polarCatalog !== 'object' || Array.isArray(config.polarCatalog)) throw Error('POLAR_UNAVAILABLE');
  const entry = config.polarCatalog[productId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('INVALID_PRODUCT');
  if (typeof entry.priceId !== 'string' || !UUID_V4.test(entry.priceId)) throw Error('INVALID_PRODUCT');
  if (typeof entry.amountCents !== 'number' || !POLAR_CENTS.test(String(entry.amountCents)) || entry.amountCents <= 0) throw Error('INVALID_PRODUCT');
  if (!M.product(productId)) throw Error('INVALID_PRODUCT');
  return entry;
 }

 function validatePolarCatalog() {
  if (!config.polarProvider) return;
  if (!config.polarCatalog || typeof config.polarCatalog !== 'object' || Array.isArray(config.polarCatalog)) throw new PgGuardError('POLAR_CATALOG_REQUIRED');
  for (const [productId, entry] of Object.entries(config.polarCatalog)) {
   if (!M.product(productId)) throw new PgGuardError('INVALID_POLAR_PRODUCT', { productId });
   if (!entry || typeof entry !== 'object' || typeof entry.priceId !== 'string' || !UUID_V4.test(entry.priceId)) throw new PgGuardError('INVALID_POLAR_PRICE_ID', { productId });
   if (typeof entry.amountCents !== 'number' || !POLAR_CENTS.test(String(entry.amountCents)) || entry.amountCents <= 0) throw new PgGuardError('INVALID_POLAR_PRICE_CENTS', { productId });
  }
 }
 validatePolarCatalog();

/* -------------------------------------------------------------------- dodo (2026-10-19)
 *
 * The Dodo lane (owner decision: Dodo = PRIMARY web checkout; Polar stays composed but dormant).
 * Mirrors the Polar contract exactly: the server-side catalog price is recorded at creation, the
 * settlement requires an INDEPENDENT provider verification with the exact recorded amount AND the
 * metadata actor/product binding, and the refund is a terminal refunded_at under the same
 * order-identity mutex. Orders live in monetization.dodo_orders (0064 - Dodo ids are not UUIDs
 * and settlement can be a localized currency, so the 0057 CHECKs cannot carry this lane); the
 * Mega Pass subscription ledger is SHARED (polar_subscriptions.provider='dodo') because
 * pass_periods.subscription_id carries its foreign key there. */

 const DODO_CENTS = /^\d{1,9}$/;
 const DODO_COUNTRY = /^[A-Z]{2}$/;
 function dodoCatalogEntry(productId) {
  if (!config.dodoProvider || typeof config.dodoProvider.createCheckout !== 'function') throw Error('DODO_UNAVAILABLE');
  if (!config.dodoCatalog || typeof config.dodoCatalog !== 'object' || Array.isArray(config.dodoCatalog)) throw Error('DODO_UNAVAILABLE');
  const entry = config.dodoCatalog[productId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('INVALID_PRODUCT');
  if (typeof entry.productId !== 'string' || !config.dodoProvider.isProductId(entry.productId)) throw Error('INVALID_PRODUCT');
  if (!entry.prices || typeof entry.prices !== 'object' || Array.isArray(entry.prices)) throw Error('INVALID_PRODUCT');
  for (const [currency, cents] of Object.entries(entry.prices)) {
   if (!SUPPORTED_CURRENCIES.has(currency) || typeof cents !== 'number' || !DODO_CENTS.test(String(cents)) || cents <= 0) throw Error('INVALID_PRODUCT');
  }
  if (!M.product(productId)) throw Error('INVALID_PRODUCT');
  return entry;
 }

 /* The checkout currency comes from the player's region hint and MUST exist in the configured
  * catalog; anything else (including a guessed region) falls back to the base USD price. */
 function dodoPriceFor(entry, currency) {
  const normalized = config.dodoProvider.supportedCurrency(currency);
  const resolved = normalized && typeof entry.prices[normalized] === 'number' ? normalized : 'usd';
  return { currency: resolved, amountCents: entry.prices[resolved] };
 }

 function validateDodoCatalog() {
  if (!config.dodoProvider) return;
  if (!config.dodoCatalog || typeof config.dodoCatalog !== 'object' || Array.isArray(config.dodoCatalog)) throw new PgGuardError('DODO_CATALOG_REQUIRED');
  for (const [productId, entry] of Object.entries(config.dodoCatalog)) {
   if (!M.product(productId)) throw new PgGuardError('INVALID_DODO_PRODUCT', { productId });
   if (!entry || typeof entry !== 'object' || typeof entry.productId !== 'string' || !config.dodoProvider.isProductId(entry.productId)) throw new PgGuardError('INVALID_DODO_PRODUCT_ID', { productId });
   if (!entry.prices || typeof entry.prices !== 'object' || Array.isArray(entry.prices) || !Object.keys(entry.prices).length) throw new PgGuardError('DODO_PRICE_REQUIRED', { productId });
   for (const [currency, cents] of Object.entries(entry.prices)) {
    if (!SUPPORTED_CURRENCIES.has(currency)) throw new PgGuardError('INVALID_DODO_CURRENCY', { productId, currency });
    if (typeof cents !== 'number' || !DODO_CENTS.test(String(cents)) || cents <= 0) throw new PgGuardError('INVALID_DODO_PRICE_CENTS', { productId, currency });
   }
  }
  if (config.dodoIntroEndsAt !== null && Number.isNaN(Date.parse(config.dodoIntroEndsAt))) throw new PgGuardError('INVALID_DODO_INTRO_ENDS_AT');
  if (config.dodoRegularCatalog !== null) {
   if (typeof config.dodoRegularCatalog !== 'object' || Array.isArray(config.dodoRegularCatalog)) throw new PgGuardError('INVALID_DODO_REGULAR_CATALOG');
   for (const [productId, entry] of Object.entries(config.dodoRegularCatalog)) {
    if (!M.product(productId)) throw new PgGuardError('INVALID_DODO_PRODUCT', { productId });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !entry.prices || typeof entry.prices !== 'object' || Array.isArray(entry.prices) || !Object.keys(entry.prices).length) throw new PgGuardError('INVALID_DODO_REGULAR_PRICE', { productId });
    for (const [currency, cents] of Object.entries(entry.prices)) {
     if (!SUPPORTED_CURRENCIES.has(currency)) throw new PgGuardError('INVALID_DODO_CURRENCY', { productId, currency });
     if (typeof cents !== 'number' || !DODO_CENTS.test(String(cents)) || cents <= 0) throw new PgGuardError('INVALID_DODO_PRICE_CENTS', { productId, currency });
    }
   }
  }
 }
 validateDodoCatalog();

 /* Settled Cashfree AND Polar once-products for the owned() projection: the additive receipt
  * contracts (0056/0057). Both tables carry the terminal refunded_at, so a refunded
  * once-product (remove_ads) is revoked structurally in the same projection. */
 async function cashfreeOnceRows(tx, actor) {
  const r = await tx.query(
   'SELECT product_id, refunded_at FROM monetization.cashfree_orders WHERE actor_id = $1 AND settled_at IS NOT NULL ORDER BY created_at LIMIT $2',
   [actor, 100]);
  return r.rows;
 }

 /* B2: the active-pass read projection. The ONE current-period rule: when an actor somehow holds
  * more than one store subscription, the latest paid period wins and benefits never stack. */
 async function activePassRow(tx, actor, now) {
  const at = typeof now === 'number' ? new Date(now).toISOString() : now;
  return (await tx.query(
   "SELECT subscription_id, status, cancel_at_period_end, current_period_start, current_period_end FROM monetization.store_subscriptions WHERE actor_id = $1 AND status = 'active' AND current_period_end IS NOT NULL AND current_period_end > $2 ORDER BY current_period_end DESC LIMIT 1",
   [actor, at])).rows[0] || null;
 }

 /* owned() over the receipts UNION the settled Cashfree and Polar once-products, plus the active
  * Mega Pass subscription: a pass is never 'owned' merely because a historical receipt exists -
  * only a live paid period confers it, and it structurally revokes when the period lapses. */
 async function ownedWithCashfree(tx, graph, account, actor) {
  const receipts = await tx.repositories.purchases.forActor(actor);
  const cashfreeRows = await cashfreeOnceRows(tx, actor);
  const polarRows = await tx.query('SELECT product_id, refunded_at FROM monetization.polar_orders WHERE actor_id = $1 AND settled_at IS NOT NULL ORDER BY created_at LIMIT $2', [actor, 100]);
  const dodoRows = await tx.query('SELECT product_id, refunded_at FROM monetization.dodo_orders WHERE actor_id = $1 AND settled_at IS NOT NULL ORDER BY created_at LIMIT $2', [actor, 100]);
  const projection = owned(graph, account, [...receipts,
   ...cashfreeRows.map((r) => ({ productId: r.product_id, refunded: r.refunded_at !== null })),
   ...polarRows.rows.map((r) => ({ productId: r.product_id, refunded: r.refunded_at !== null })),
   ...dodoRows.rows.map((r) => ({ productId: r.product_id, refunded: r.refunded_at !== null }))]);
  const pass = await activePassRow(tx, actor, tx.clock());
  if (pass) {
   projection.products = [...new Set([...projection.products, 'mega_pass'])];
   projection.removeAds = true;
  }
  projection.pass = pass
   ? { active: true, periodEnd: Date.parse(pass.current_period_end), cancelAtPeriodEnd: pass.cancel_at_period_end === true }
   : { active: false, periodEnd: null, cancelAtPeriodEnd: false };
  return projection;
 }

 /* The shared RECEIPT-identity mutex namespace: `receipt` + [store, transactionId], the same
  * vocabulary `lockTransactionIdentity` documents and the Core boundary uses. Purchase grants and
  * refund tombstones take it, so a refund arriving between provider verification and the initial
  * grant serializes with that grant instead of being forgotten. */
 async function lockReceipt(tx, store, transactionId) { return lockTransactionIdentity(tx, 'receipt', [store, transactionId]); }

 /* The receipt identity, read from its OWN row rather than from the globally capped receipt map: an
  * absence in a capped hydration cannot be read as "this receipt does not exist". */
 async function receiptOf(tx, store, transactionId) { return tx.repositories.purchases.receipt(store, transactionId); }

 /* A durable ledger entry appended through the aggregate journal so the aggregate diff persists it
  * once with the rest of the transaction. */
 function journal(graph, entry) { graph.authority.journal.push(entry); }

 /* The legacy `owned()` projection over the hydrated aggregate: derived frame set, the
  * non-consumable product set, and the remove-ads entitlement. The product set is built from the
  * actor's OWN receipts (a complete, actor-scoped read) rather than from the globally capped receipt
  * map, so a receipt outside the global cap can never hide an owned-once product or grant a second
  * one. */
 function owned(graph, account, actorReceipts = null) {
  const frames = new Set(['classic', ...(account.monetization.redeemed || [])]);
  for (const frame of M.FRAMES) if ((account.owned || []).includes(frame.name)) frames.add(frame.id);
  const products = [];
  for (const receipt of actorReceipts || []) {
   if (receipt.refunded) continue;
   const product = M.product(receipt.productId);
   if (!product) continue;
   if (product.once) products.push(product.id);
   for (const frame of product.frames) frames.add(frame);
  }
  /* Mega Pass is the premium-pass entitlement (owner-approved): one purchase, ads off for good,
     same structural revoke-on-refund as remove_ads. */
  return { frames: [...frames], products: [...new Set(products)], removeAds: products.includes('remove_ads')||products.includes('mega_pass') };
 }

 /* The one keyed transaction boundary (server/monetization-store.js:23-26): key grammar, canonical
  * fingerprint, AFFECTED-LOCK ACQUISITION, outcome lookup, conflict, mutation, aggregate commit,
  * outcome save - in ONE transaction, with a sanitized durable outbox event added inside the same
  * transaction so a business change and its delivery notice commit or roll back together.
  *
  * The locks come BEFORE the outcome lookup and hydration, in the global order: the actor's
  * `identity.eligibility` row, then `core.actor_occupancy` and `economy.wallets` (`wallets.lock`).
  * A purchase/restore mutates `economy.wallets.crowns`, so the row lock makes that read-modify-write
  * serialized across Core instances; and taking it before the lookup means a same-key concurrent
  * retry blocks, then re-reads the outcome the winner committed, and returns the stored response
  * instead of applying the effect twice. */
 async function transaction(actor, key, command, fn, prelock = null, opts = null) {
  if (!idOK(key)) throw Error('IDEMPOTENCY_KEY_REQUIRED');
  const fingerprint = sha256hex(JSON.stringify(command));
  return uow.run(async (tx) => {
   const repositories = tx.repositories;
   /* LOGICAL IDENTITIES FIRST, before any row lock: the receipt identity (when the command names
    * one) precedes eligibility -> occupancy/wallet, exactly the frozen order, so a purchase and a
    * refund of the same store transaction can never take those two in opposite orders. */
   if (prelock) await lockReceipt(tx, prelock[0], prelock[1]);
   await lockEligibility(tx.query, [actor]);
   const locked = await repositories.wallets.lock([actor]);
   const previous = await repositories.outcomes.find(V35_COMMANDS, actor, key);
   if (previous) {
    if (previous.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
    return previous.response;
   }
   /* FENCE EXTENSION: a key reserved for an in-flight provider creation cannot be claimed by
    * another commerce command, and the reservation row itself is part of the same durable
    * identity family. Only the winning creator (same fingerprint, opts.reservation.won) may
    * pass while its reservation is PENDING/UNKNOWN - that is the finalization commit. */
   const reservation = (await tx.query('SELECT state, fingerprint, provider FROM monetization.commerce_create_requests WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0] || null;
   if (reservation && (reservation.state === 'PENDING' || reservation.state === 'UNKNOWN')) {
    const isFinalizer = opts && opts.reservation && opts.reservation.won === true && reservation.fingerprint === fingerprint;
    if (!isFinalizer) {
     const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
    }
   }
   /* The wallet row is the durable readiness fact (`economy.wallets` existence, P05). An actor the
    * API has not handed to Core yet has no wallet row, and running an economic command for it would
    * create a 0-balance wallet as a SIDE EFFECT - which would then read as "provisioned". Refuse
    * with the frozen `ACCOUNT_REQUIRED` instead, so `core.provisionActor` stays the only wallet
    * creator. */
   if (locked.wallets === 0) throw Error('ACCOUNT_REQUIRED');
   const graph = await repositories.domain();
   /* NO WRITABLE TRUNCATED AGGREGATE (same rule as Core): an incomplete decision input cannot prove
    * which row is absent, so the command fails closed rather than applying a degraded effect. */
   if (graph.complete !== true) throw Error('STATE_TRUNCATED');
   const account = accountOf(graph, actor);
   const promotionBefore = Promotion.capture(graph);
   const result = await fn(tx, graph, account);
   await Promotion.track(tx, graph, promotionBefore);
   const stats = await repositories.commitDomain();
   /* Strict claim: the operation identity lock above means this insert cannot legitimately conflict,
    * so a conflict aborts the transaction (business effect included) instead of committing a second
    * effect behind one outcome row. */
   const claimed = await repositories.outcomes.claim(V35_COMMANDS, actor, key, fingerprint, JSON.stringify(result));
   if (!claimed) throw Error('IDEMPOTENCY_CONFLICT');
   if (stats.upserts + stats.deletes > 0) {
    await emitOutbox(tx, { id: `commerce.command:${actor}:${key}`, event: { actor, key, type: command.type, changes: stats.upserts + stats.deletes } });
   }
   return result;
  });
 }

 /* Sanitized monetization event row (v35_events). Core holds INSERT on monetization.reward_events
  * (0021); the monotonic identity column preserves the source ordering. */
 function event(tx, actor, kind, value = 0) {
  return tx.query('INSERT INTO monetization.reward_events (actor_id, kind, at, value) VALUES ($1, $2, $3, $4)', [actor, kind, iso(tx.clock()), value]);
 }

 async function ticketsOnDay(tx, actor, day) {
  const r = await tx.query('SELECT count(*) AS n FROM monetization.reward_tickets WHERE actor_id = $1 AND day = $2', [actor, day]);
  return Number(r.rows[0].n);
 }

 /* The trusted store binding, READ-ONLY. A missing binding is reported absent, never generated. */
 async function bindingFor(tx, actor) {
  const r = await tx.query('SELECT google_id, apple_token, created_at FROM monetization.store_bindings WHERE actor_id = $1', [actor]);
  const row = r.rows[0];
  if (!row) return null;
  return { googleAccountId: row.google_id, appleAppAccountToken: row.apple_token, created: msOf(row.created_at) };
 }

 function assertAdSafe(account, platform, kind = 'rewarded') {
  const units = config.adUnits[platform];
  if (!allowed(account) || !units || !units[kind] || typeof config.verifyAd !== 'function' || M.cohort(account.id, config.adMode) === 'off') throw Error('ADS_UNAVAILABLE');
  if (account.activeMatch || config.busy(account.id)) throw Error('MATCH_ACTIVE');
  return units[kind];
 }

 /* ---------------------------------------------------------------- reward path */

 /* Casual-play credits. The policy test and the boost window are the frozen pure helpers; the
  * durable anti-join key is `monetization.casual_rewards(actor_id, match_id)`, read once per
  * transaction instead of once per history row. */
 function claim(actor, key) {
  return transaction(actor, key, { type: 'claim' }, async (tx, graph, account) => {
   const now = tx.clock();
   const seen = (await tx.query('SELECT match_id FROM monetization.casual_rewards WHERE actor_id = $1', [actor])).rows.map((row) => row.match_id);
   const rewarded = new Set(seen);
   const s = account.monetization;
   /* `graph.matches` is a derived Map rebuilt on every access, so it is built ONCE here rather than
    * once per history row. */
   const matches = graph.matches;
   let base = 0, bonus = 0;
   for (const h of [...account.history].sort((a, b) => a.at - b.at)) {
    if (!M.qualifiedCasual(h) || h.at > now || rewarded.has(h.id)) continue;
    const day = s.daily[M.day(h.at)] || (s.daily[M.day(h.at)] = { base: 0, bonus: 0, automatic: 0 });
    const b = Math.min(M.POLICY.casualCredits, Math.max(0, M.POLICY.casualDayCap - day.base));
    const match = matches.get(h.id);
    const timed = Number.isFinite(match && match.started) ? { ...h, activeSeconds: (h.at - match.started) / 1000 } : h;
    const x = b && s.boosts.some((boost) => M.boostApplies(timed, boost)) ? Math.min(b, Math.max(0, M.POLICY.boostDayCap - day.bonus)) : 0;
    day.base += b;
    day.bonus += x;
    base += b;
    bonus += x;
    rewarded.add(h.id);
    await tx.query('INSERT INTO monetization.casual_rewards (actor_id, match_id, base, bonus) VALUES ($1, $2, $3, $4) ON CONFLICT (actor_id, match_id) DO NOTHING', [actor, h.id, b, x]);
   }
   s.credits = D.add(s.credits, base + bonus);
   if (base + bonus) await event(tx, actor, 'casual_credits', base + bonus);
   return { base, bonus, credits: s.credits };
  });
 }

 /* Sol re-review N7: durable reconciliation for refused paid purchases. A purchase the
  * promotion guard refuses is charged-but-ungranted: the refusal is recorded in its OWN
  * transaction (the economic one rolled back), the provider purchase is never acknowledged
  * or consumed, and the store's own unacknowledged-purchase refund is the documented
  * backstop. The record makes the refusal supportable and reconcilable; the operator query
  * for outstanding refusals is
  *   SELECT * FROM monetization.store_purchase_rejections WHERE resolved_at IS NULL;
  * and rows are marked resolved once the provider refund/revocation is confirmed. */
 async function recordPurchaseRejection(actorId, verifiedReceipt, reason) {
  if (!verifiedReceipt || !verifiedReceipt.store || !verifiedReceipt.transactionId) return;
  await uow.run(async (tx) => {
   await tx.query(`INSERT INTO monetization.store_purchase_rejections (store, transaction_id, actor_id, product_id, reason) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (store, transaction_id) DO NOTHING`, [verifiedReceipt.store, verifiedReceipt.transactionId, actorId, verifiedReceipt.productId, reason]);
  });
 }

 /* Reward-ticket issuance. A ticket is a durable REQUEST; the grant happens only in `callback`
  * after the provider independently confirms the impression. */
 function ticket(actor, key, kind, platform = 'legacy') {
  return transaction(actor, key, { type: 'ticket', kind, platform }, async (tx, _graph, account) => {
   const adUnit = assertAdSafe(account, platform, 'rewarded');
   /* MXA-ADS-D2 (2026-10-20): the powers lane earns undo/hint charges through rewarded ads
    * and requests its ticket with the POWER kind (src/powers-ui.js request(kind)); the old
    * credits/boost-only rule answered INVALID_REWARD for every power-ad request and left the
    * native rewarded-for-powers flow dead. The ticket stays a REQUEST: pacing, daily caps and
    * the single-outstanding-ticket rule apply identically, and the SSV callback settles it. */
   if (!['credits', 'boost', 'undo', 'hint'].includes(kind)) throw Error('INVALID_REWARD');
   const now = tx.clock(), s = account.monetization;
   if (now - s.lastRewardStart < M.POLICY.rewardedGap) throw Error('AD_COOLDOWN');
   if (kind === 'boost' && s.boosts.some((b) => b.endsAt > now)) throw Error('BOOST_ACTIVE');
   if (kind === 'boost') {
    const pending = await tx.query("SELECT 1 FROM monetization.reward_tickets WHERE actor_id = $1 AND kind = 'boost' AND settled = false AND expires_at > $2", [actor, iso(now - M.POLICY.callbackGrace)]);
    if (pending.rows.length) throw Error('AD_PENDING');
   }
   if (await ticketsOnDay(tx, actor, M.day(now)) >= M.POLICY.rewardedDayCap) throw Error('AD_DAILY_LIMIT');
   const outstanding = await tx.query('SELECT 1 FROM monetization.reward_tickets WHERE actor_id = $1 AND settled = false AND expires_at > $2', [actor, iso(now)]);
   if (outstanding.rows.length) throw Error('AD_PENDING');
   const id = crypto.randomBytes(24).toString('hex');
   const expires = now + M.POLICY.ticketLifetime;
   await tx.query('INSERT INTO monetization.reward_tickets (ticket_id, actor_id, kind, issued_at, expires_at, day) VALUES ($1, $2, $3, $4, $5, $6)', [id, actor, kind, iso(now), iso(expires), M.day(now)]);
   await tx.query('INSERT INTO monetization.ad_ticket_context (ticket_id, platform, ad_unit) VALUES ($1, $2, $3)', [id, platform, adUnit]);
   s.lastRewardStart = now;
   s.lastAdAt = now;
   await event(tx, actor, 'reward_requested');
   return { ticket: id, actor, kind, platform, expires, adUnit, rewardItem: config.rewardItem, rewardAmount: 1 };
  });
 }

 /* Provider SSV callback. `verifyAd` (external I/O) is awaited BEFORE the transaction; the
  * provider proof is bound to the ticket inside it, the grant becomes durable in that same
  * transaction, and nothing is acknowledged before then. */
 async function callback(raw) {
  if (typeof config.verifyAd !== 'function') throw Error('ADS_UNAVAILABLE');
  const e = await config.verifyAd(raw);
  if (!e || typeof e.transactionId !== 'string' || e.transactionId.length > 200 || e.rewardItem !== config.rewardItem || e.amount !== 1 || !Number.isSafeInteger(e.timestamp)) throw Error('INVALID_AD_REWARD');
  return transaction(e.actor, 'ssv:' + sha256hex(e.transactionId), { type: 'ssv', event: e }, async (tx, _graph, account) => {
   const row = (await tx.query('SELECT actor_id, kind, issued_at, expires_at, settled, transaction_id FROM monetization.reward_tickets WHERE ticket_id = $1', [e.ticket])).rows[0];
   const ctx = (await tx.query('SELECT platform, ad_unit FROM monetization.ad_ticket_context WHERE ticket_id = $1', [e.ticket])).rows[0];
   const now = tx.clock();
   if (!row || !ctx || ctx.ad_unit !== e.adUnit || row.actor_id !== e.actor
     || e.timestamp < msOf(row.issued_at) || e.timestamp > msOf(row.expires_at)
     || e.timestamp > now + 60000 || now - e.timestamp > M.POLICY.callbackGrace) throw Error('INVALID_AD_TICKET');
   if (row.settled) throw Error('AD_TICKET_USED');
   if ((await tx.query('SELECT 1 FROM monetization.reward_tickets WHERE transaction_id = $1', [e.transactionId])).rows.length) throw Error('AD_TRANSACTION_USED');
   const s = account.monetization;
   let boost = null;
   if (row.kind === 'credits') s.credits = D.add(s.credits, M.POLICY.rewardCredits);
   else if (row.kind === 'boost') {
    if (s.boosts.some((b) => b.endsAt > now)) throw Error('BOOST_ACTIVE');
    boost = { startedAt: now, endsAt: now + M.POLICY.boostDuration };
    s.boosts.push(boost);
   }
   /* undo/hint: the power charge itself is device-side inventory granted by the powers lane
    * after the verified presentation (the same model as a Crowns-bought charge). The server
    * grant for these kinds is the settled, SSV-verified ticket - no wallet mutation. */
   s.lastAdAt = now;
   await tx.query('UPDATE monetization.reward_tickets SET settled = true, transaction_id = $2 WHERE ticket_id = $1', [e.ticket, e.transactionId]);
   await event(tx, e.actor, 'reward_verified', row.kind === 'credits' ? M.POLICY.rewardCredits : 0);
   return { granted: row.kind, credits: s.credits, boost: row.kind === 'boost' ? boost : null };
  });
 }

 /* Automatic (interstitial) permit. Aggregate-backed: lastAdAt and reward_daily.automatic. */
 function automaticPermit(actor, key, platform = 'legacy') {
  return transaction(actor, key, { type: 'automatic-permit', platform }, async (tx, graph, account) => {
   const adUnit = assertAdSafe(account, platform, 'interstitial');
   if (M.cohort(actor, config.adMode) !== 'hybrid' || (await ownedWithCashfree(tx, graph, account, actor)).removeAds) throw Error('AUTOMATIC_AD_DISABLED');
   const s = account.monetization, now = tx.clock();
   const d = s.daily[M.day(now)] || (s.daily[M.day(now)] = { base: 0, bonus: 0, automatic: 0 });
   if (now - account.createdAt < M.POLICY.firstAdAge || now - s.lastAdAt < M.POLICY.fullScreenGap) throw Error('AD_COOLDOWN');
   if (d.automatic >= M.POLICY.interstitialDayCap) throw Error('AD_DAILY_LIMIT');
   s.lastAdAt = now;
   d.automatic += 1;
   await event(tx, actor, 'interstitial_permitted');
   return { allowed: true, platform, adUnit, expires: now + 3000 };
  });
 }

 /* ----------------------------------------------------------------- cosmetics */

 function cosmetic(actor, key, id, equip = false) {
  return transaction(actor, key, { type: equip ? 'equip' : 'redeem', id }, async (tx, graph, account) => {
   const frame = M.frame(id);
   if (!frame) throw Error('INVALID_FRAME');
   const s = account.monetization;
   if (!(await ownedWithCashfree(tx, graph, account, actor)).frames.includes(id)) {
    if (equip || frame.credits === null) throw Error('FRAME_NOT_OWNED');
    if (s.credits < frame.credits) throw Error('INSUFFICIENT_COSMETIC_CREDITS');
    s.credits -= frame.credits;
    s.redeemed.push(id);
    await event(tx, actor, 'cosmetic_redeemed', frame.credits);
   }
   s.equipped = id;
   return { equipped: id, credits: s.credits };
  });
 }

 /* ----------------------------------------------------------------- purchase */

 /* Backend-verified purchase -> durable grant. The verifier is awaited OUTSIDE the economic
  * transaction; only its trusted projection enters the transaction. */
 async function purchase(actor, key, evidence, restore = false) {
  const provider = config.purchaseProvider;
  const providerVerify = provider && typeof provider.verify === 'function' ? provider : null;
  /* ONE read-only transaction resolves the account gate and, for a provider verifier, the API-owned
    store binding the proof must be bound to. No wallet lock is held here. The account gate runs
    first, exactly like the source boundary (`this.account(...)` before the verifier check). */
  const preflight = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const graph = await tx.repositories.domain();
   const wallet = await tx.query('SELECT 1 AS ok FROM economy.wallets WHERE actor_id = $1', [actor]);
   return { account: accountOf(graph, actor), ready: wallet.rows.length > 0, binding: providerVerify ? await bindingFor(tx, actor) : null };
  });
  /* Do not spend a provider round-trip on an actor Core has not provisioned. */
  if (!preflight.ready) throw Error('ACCOUNT_REQUIRED');
  if (!providerVerify && typeof config.verifyPurchase !== 'function') throw Error('STORE_UNAVAILABLE');
  if (!restore && (!config.purchasesEnabled || !allowed(preflight.account))) throw Error('PURCHASE_UNAVAILABLE');
  /* The store binding (Google obfuscated account id / Apple app-account token) is API-owned and
   * must already exist: without it the provider proof cannot be bound to this actor, and this
   * service never mints one. */
  if (providerVerify && !preflight.binding) throw Error('STORE_BINDING_REQUIRED');
  const receipt = providerVerify
   ? await providerVerify.verify(evidence, actor, preflight.binding)
   : await config.verifyPurchase(evidence, actor);
  if (!receipt || receipt.valid !== true || receipt.accountId !== actor || receipt.refunded || !['apple', 'google'].includes(receipt.store) || !idOK(receipt.transactionId)) throw Error('INVALID_RECEIPT');
  const product = M.product(receipt.productId);
  if (!product || (restore && !product.once)) throw Error('INVALID_PRODUCT');
  const safeReceipt = { valid: true, accountId: receipt.accountId, store: receipt.store, transactionId: receipt.transactionId, productId: product.id, refunded: false };
  /* Sol re-review N7: a refused paid purchase is recorded durably (best effort) before the
   * error propagates, so the charge is always reconcilable even if the client dies. */
  let result;
  try {
   result = await transaction(actor, key, { type: restore ? 'restore' : 'purchase', receipt: safeReceipt }, async (tx, graph, current) => {
   if (!restore && (!config.purchasesEnabled || !allowed(current))) throw Error('PURCHASE_UNAVAILABLE');
   /* The receipt identity mutex is already held by `transaction` (see `prelock`), so a refund of
    * this exact store transaction can never interleave between the tombstone check and the grant. */
   /* Permanent refund tombstone, re-checked under the receipt mutex: a refund committed between the
    * pre-check and this transaction must not be overwritten by a fresh grant. */
   if ((await tx.query('SELECT 1 FROM monetization.store_revocations WHERE store = $1 AND transaction_id = $2', [receipt.store, receipt.transactionId])).rows.length) throw Error('RECEIPT_REFUNDED');
   /* The receipt identity is read from its OWN row, never from the globally capped receipt map: a
    * receipt outside the 5000-row hydration cap must not read as absent and regrant its Crowns under
    * a fresh operation key. */
   const old = await receiptOf(tx, receipt.store, receipt.transactionId);
   const id = receipt.store + ':' + receipt.transactionId;
   if (old) {
    if (old.actor !== actor || old.productId !== product.id) throw Error('RECEIPT_REPLAY');
    if (old.refunded) throw Error('RECEIPT_REFUNDED');
    return { productId: product.id, duplicate: true };
   }
   if (product.once) {
    for (const r of await tx.repositories.purchases.forActor(actor)) {
     if (r.productId !== product.id) continue;
     if (r.refunded) throw Error('PRODUCT_PREVIOUSLY_REFUNDED');
     return { productId: product.id, alreadyOwned: true };
    }
   }
   /* Sol review R4: a published promotion policy caps promotional Crowns across EVERY checkout
    * method. Native settlement previously credited valid receipts without a matching
    * reservation (Promotion.creditLot silently returned when none existed), bypassing the cap.
    * With a published policy a crown-granting store purchase MUST carry the reservation the
    * upgraded client makes BEFORE billing (same actor/provider/delivery key). A legacy client's
    * delivery is refused with PROMOTION_RESERVATION_REQUIRED: the provider purchase is left
    * unacknowledged, so the store's own auto-refund returns the money - no player is charged
    * for an ungranted grant, and the cap cannot be bypassed by skipping the reserve call. */
   if (product.crowns && !restore) {
    const policy = (await tx.query('SELECT published_at FROM monetization.promotion_policies WHERE policy_version = $1', [Promotion.VERSION])).rows[0];
    if (policy && policy.published_at) {
     /* Sol re-review N1: the reservation must match the independently verified receipt's
      * product AND quantity, so a small-pack reservation can never authorize a larger pack. */
     /* Sol re-review N7: a verifiably PRE-POLICY purchase (trusted provider purchase time
      * before publication) delivered after publication is grandfathered - no reservation was
      * possible when the policy did not exist yet. Post-publication purchases need it. */
     const prePolicyPurchase = Number(receipt.purchaseTimeMs) > 0 && Number(receipt.purchaseTimeMs) < Date.parse(policy.published_at);
     if (!prePolicyPurchase) {
      const allocation = (await tx.query('SELECT product_id, crowns FROM monetization.promotion_allocations WHERE actor_id = $1 AND provider = $2 AND op_key = $3', [actor, receipt.store, key])).rows[0];
      if (!allocation) throw Error('PROMOTION_RESERVATION_REQUIRED');
      if (allocation.product_id !== product.id || Number(allocation.crowns) !== Number(product.crowns)) throw Error('PROMOTION_RESERVATION_MISMATCH');
    }
   }
   }
   current.crowns = D.add(current.crowns, product.crowns);
   current.purchasedCrowns = D.add(current.purchasedCrowns || 0, product.crowns);
   if (product.crowns) current.purchaseInfluenced = true;
   graph.receipts.set(id, { actor, productId: product.id, crowns: product.crowns, refunded: false, at: tx.clock() });
   if (product.crowns) journal(graph, { id: 'purchase:' + id, actor, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: tx.clock() });
   await Promotion.creditLot(tx, actor, receipt.store, key, 'purchase:' + id, product.crowns);
   await event(tx, actor, restore ? 'purchase_restored' : 'purchase_verified', product.crowns);
   return { productId: product.id, crowns: product.crowns, duplicate: false };
  }, [receipt.store, receipt.transactionId]);
  } catch (error) {
   if (error && (error.message === 'PROMOTION_RESERVATION_REQUIRED' || error.message === 'PROMOTION_RESERVATION_MISMATCH')) {
    await recordPurchaseRejection(actor, { store: receipt.store, transactionId: receipt.transactionId, productId: product.id }, error.message).catch(() => {});
   }
   throw error;
  }
  /* Provider consume/acknowledge is requested only AFTER the durable grant. A failure is reported
    as pending (the worker's finalization sweep owns retries) instead of being silently dropped. */
  if (provider && typeof provider.finalize === 'function') {
   const finalized = await provider.finalize(receipt).catch(() => false);
   if (!finalized) return { ...result, finalizationPending: true };
  }
  return result;
 }

 /* Provider finalization sweep. `monetization.store_finalize`/`store_notifications` are
  * worker-owned (0022) and the full durable provider lifecycle is P10 work, so a deployment with no
  * real provider processDue CANNOT report a successful sweep of zero jobs - that would be a fake
  * worker result. It fails closed with STORE_FINALIZATION_UNAVAILABLE instead. */
 async function processPurchaseFinalizations() {
  if (!config.purchaseProvider || typeof config.purchaseProvider.processDue !== 'function') throw Error('STORE_FINALIZATION_UNAVAILABLE');
  return config.purchaseProvider.processDue(async (store, id) => {
   const r = await pool.query('SELECT 1 FROM monetization.receipts WHERE store = $1 AND transaction_id = $2', [store, id]);
   return r.rows.length > 0;
  });
 }

  /* Server-side order creation (the legacy cashfree/order POST). The catalog price is
  * SERVER-AUTHORITATIVE; the client only names the product and its customer details. The SAME
  * durable key returns the SAME order - no second provider call, no second charge.
  *
  * RESERVE-THEN-CREATE: the (actor, op_key) reservation in 0058 is taken BEFORE the provider
  * call and ONLY the reservation winner reaches Cashfree. The locally-allocated order id is
  * stored on the reservation at PENDING time (reconciliation key). An explicit provider
  * rejection marks FAILED (replay returns the sanitized failure); an ambiguous transport
  * outcome marks UNKNOWN and is recovered ONLY by an explicit provider read against the
  * reserved id - never an automatic re-create. */
 async function createCashfreeOrder(actor, key, productId, customer) {
  const price = cashfreePrice(productId);
  if (!idOK(key)) throw Error('IDEMPOTENCY_KEY_REQUIRED');
  if (!customer || typeof customer !== 'object' || Array.isArray(customer)) throw Error('INVALID_CUSTOMER_DETAILS');
  const email = typeof customer.email === 'string' ? customer.email.trim() : '';
  const phone = typeof customer.phone === 'string' ? customer.phone.trim() : '';
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('INVALID_CUSTOMER_DETAILS');
  if (!/^\+?[0-9]{10,15}$/.test(phone)) throw Error('INVALID_CUSTOMER_DETAILS');
  const fingerprint = createFingerprint('cashfree-create', productId);
  const previous = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT order_id, product_id, session_id FROM monetization.cashfree_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0] || null;
  });
  if (previous) {
   if (previous.product_id !== productId) throw Error('IDEMPOTENCY_CONFLICT');
   return { orderId: previous.order_id, productId: previous.product_id, paymentSessionId: previous.session_id, environment: cashfreeSdkMode };
  }
  /* The account gate BEFORE the provider round-trip (the purchase preflight pattern): never spend
   * a provider call on an actor Core has not provisioned. */
  const preflight = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const graph = await tx.repositories.domain();
   const wallet = await tx.query('SELECT 1 AS ok FROM economy.wallets WHERE actor_id = $1', [actor]);
   return { ready: wallet.rows.length > 0, account: accountOf(graph, actor) };
  });
  if (!preflight.ready) throw Error('ACCOUNT_REQUIRED');
  const reservation = await reserveCreate(uow, actor, key, 'cashfree', productId, fingerprint, { amount: price, currency: 'INR' }, customer && customer.promotionAcceptanceHash);
  if (!reservation.won) {
   const r = reservation.reservation;
   if (!r || r.provider !== 'cashfree' || r.product_id !== productId || r.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
   if (r.state === 'FAILED') { const e = Error(r.error_code || 'CASHFREE_CREATE_FAILED'); e.status = 502; throw e; }
   /* READY/unknown-by-us: the ledger is the authority; a completed create replays from it. */
   if (r.state === 'READY' && r.provider_object_id) {
    const row = (await uow.run(async (tx) => { await tx.query('SET TRANSACTION READ ONLY'); return (await tx.query('SELECT order_id, session_id FROM monetization.cashfree_orders WHERE order_id = $1', [r.provider_object_id])).rows[0] || null; }));
    if (row) return { orderId: row.order_id, productId, paymentSessionId: row.session_id, environment: cashfreeSdkMode };
   }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  const requestId = reservation.requestId;
  const provider = config.cashfreeProvider;
  const orderId = typeof provider.newOrderId === 'function' ? provider.newOrderId() : newOrderId();
  /* B3: an active Mega Pass discounts at most two Crown packs per paid month. Only the
   * reservation winner reaches this point; the use is RESERVED under a row lock in one write
   * transaction and a terminal provider rejection releases it. An ambiguous outcome keeps the
   * reservation because the order may exist - the recovery read resolves it. */
  const packProduct = M.product(productId);
  const isPack = Boolean(packProduct && packProduct.crowns > 0);
  let charged = price;
  let reservedPeriod = null;
  if (isPack) {
   const reserved = await uow.run(async (tx) => (await tx.query(
    "UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved + 1 FROM monetization.store_subscriptions ps WHERE pp.subscription_id = ps.subscription_id AND ps.actor_id = $1 AND ps.status = 'active' AND pp.period_start <= $2 AND pp.period_end > $2 AND pp.pack_discounts_reserved + pp.pack_discounts_used < 2 AND pp.subscription_id = (SELECT ps2.subscription_id FROM monetization.store_subscriptions ps2 WHERE ps2.actor_id = $1 AND ps2.status = 'active' ORDER BY ps2.created_at DESC LIMIT 1) AND pp.period_start = (SELECT MAX(pp3.period_start) FROM monetization.pass_periods pp3 WHERE pp3.subscription_id = pp.subscription_id AND pp3.period_start <= $2 AND pp3.period_end > $2) RETURNING pp.subscription_id, pp.period_start",
    [actor, new Date(serviceNow()).toISOString()])).rows[0] || null);
   if (reserved) {
    /* Sol review 2026-10-18: record the EXACT reserved (subscription, period) pair so the
     * release can never decrement a same-date period of a second subscription. */
    reservedPeriod = { subscriptionId: reserved.subscription_id, start: new Date(reserved.period_start).toISOString() };
    charged = (Math.round(parseFloat(price) * (1 - M.PASS.packDiscount) * 100) / 100).toFixed(2);
   }
  }
  await markReservation(uow, requestId, 'PENDING', { providerObjectId: orderId });
  let created;
  try {
   created = await withDeadline(provider.createOrder({ orderId, productId, amount: charged, actor, email, phone, returnUrl: config.cashfreeReturnUrl, notifyUrl: config.cashfreeNotifyUrl }));
  } catch (error) {
   /* An explicit provider rejection proving non-creation (auth/4xx) is terminal FAILED;
    * timeouts, disconnects and 5xx/429/408 are ambiguous UNKNOWN. Neither is ever re-created
    * automatically - the reservation records exactly what happened for the recovery read. */
   const code = String(error && error.message || 'CASHFREE_CREATE_UNKNOWN');
   const httpMatch = /^CASHFREE_HTTP_([0-9]{3})$/.exec(code);
   const terminal = code === 'CASHFREE_AUTH' || code === 'CASHFREE_CONFIG' || (!!httpMatch && httpMatch[1] !== '408' && httpMatch[1] !== '429');
   /* MXA-ECO-012 (audit 2026-10-17): the discount reservation is released ONLY for a terminal,
    * proven non-creation; an ambiguous outcome keeps it because the order may still exist - the
    * recovery read resolves it. The previous unconditional release contradicted the contract
    * comment above and let a discounted retry consume the same budget twice. */
   if (terminal && reservedPeriod) await uow.run(async (tx) => {
    await tx.query("UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved - 1 WHERE pp.subscription_id = $2 AND pp.period_start = $3 AND pp.pack_discounts_reserved > 0", [actor, reservedPeriod.subscriptionId, reservedPeriod.start]);
   });
   await markReservation(uow, requestId, terminal ? 'FAILED' : 'UNKNOWN', { providerObjectId: orderId, errorCode: terminal ? code : null });
   if (terminal) { error.status = 502; throw error; }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  return transaction(actor, key, { type: 'cashfree-create', productId }, async (tx) => {
   /* The (actor, op_key) unique constraint (0056) is the durable race fence: two concurrent
    * creates with one key record ONE row; the loser returns the winner's recorded order. */
   await tx.query(
    'INSERT INTO monetization.cashfree_orders (order_id, actor_id, product_id, amount, currency, status, session_id, op_key, created_at, discount_subscription_id, discount_period_start) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (actor_id, op_key) DO NOTHING',
    [created.orderId, actor, productId, charged, 'INR', 'ACTIVE', created.paymentSessionId, key, iso(tx.clock()), reservedPeriod ? reservedPeriod.subscriptionId : null, reservedPeriod ? reservedPeriod.start : null]);
   const row = (await tx.query('SELECT order_id, session_id FROM monetization.cashfree_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0];
   if (!row) throw Error('CASHFREE_RECORD_FAILED');
   /* The reservation completes in the SAME transaction as the ledger + outcome: a crash between
    * the provider call and this commit leaves PENDING/UNKNOWN with the reserved order id, which
    * the recovery read resolves - never a silent second create. */
   await tx.query(
    'UPDATE monetization.commerce_create_requests SET state = $2, provider_object_id = $3, response_text = $4, updated_at = $5 WHERE request_id = $1 AND state = $6',
    [requestId, 'READY', created.orderId, JSON.stringify(created).slice(0, 4096), iso(tx.clock()), 'PENDING']);
   return { orderId: row.order_id, productId, paymentSessionId: row.session_id, environment: cashfreeSdkMode };
  }, null, { reservation: { requestId, won: true } });
 }

 /* The settlement core, shared by the webhook and the status poll. Provider verification happens
  * BEFORE any economic transaction (the provider boundary, spec 03 section 1); the grant then
  * commits in the same keyed transaction as its idempotency outcome, under the order-identity
  * mutex so a webhook racing the status poll settles exactly once. */
 async function settleCashfreeOrder(orderId) {
  const provider = config.cashfreeProvider;
  if (!provider || typeof provider.verifyOrder !== 'function') throw Error('CASHFREE_UNAVAILABLE');
  if (typeof orderId !== 'string' || !provider.isOrderId(orderId)) throw Error('ORDER_NOT_FOUND');
  /* The recorded row is the authority on WHO and WHAT: a provider proof alone carries no product,
   * no price and no actor binding, so it can never grant by itself. */
  const recorded = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT order_id, actor_id, product_id, amount, status, settled_at, refunded_at, discount_subscription_id, discount_period_start FROM monetization.cashfree_orders WHERE order_id = $1', [orderId])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  if (recorded.refunded_at) throw Error('ORDER_REFUNDED');
  const verified = await provider.verifyOrder(orderId);
  if (!verified || verified.status !== 'PAID') return { orderId, settled: false, status: verified ? verified.status : null };
  if (verified.currency !== 'INR' || Math.abs(Number(recorded.amount) - verified.amount) > 1e-9) throw Error('ORDER_AMOUNT_MISMATCH');
  const product = M.product(recorded.product_id);
  if (!product) throw Error('INVALID_PRODUCT');
  return transaction(recorded.actor_id, 'cashfree:' + orderId, { type: 'cashfree-settle', orderId }, async (tx, graph, current) => {
   if (!config.purchasesEnabled || !allowed(current)) throw Error('PURCHASE_UNAVAILABLE');
   const row = (await tx.query('SELECT settled_at, refunded_at FROM monetization.cashfree_orders WHERE order_id = $1 FOR UPDATE', [orderId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) throw Error('ORDER_REFUNDED');
   if (row.settled_at) return { productId: product.id, duplicate: true, settled: true };
   if (product.once) {
    for (const r of await tx.repositories.purchases.forActor(recorded.actor_id)) {
     if (r.productId !== product.id) continue;
     if (r.refunded) throw Error('PRODUCT_PREVIOUSLY_REFUNDED');
     return { productId: product.id, alreadyOwned: true, settled: true };
    }
    const prev = (await tx.query('SELECT refunded_at FROM monetization.cashfree_orders WHERE actor_id = $1 AND product_id = $2 AND settled_at IS NOT NULL AND order_id <> $3 ORDER BY created_at LIMIT 1', [recorded.actor_id, product.id, orderId])).rows[0];
    if (prev) {
     if (prev.refunded_at) throw Error('PRODUCT_PREVIOUSLY_REFUNDED');
     return { productId: product.id, alreadyOwned: true, settled: true };
    }
   }
   current.crowns = D.add(current.crowns, product.crowns);
   current.purchasedCrowns = D.add(current.purchasedCrowns || 0, product.crowns);
   if (product.crowns) current.purchaseInfluenced = true;
   /* The ledger source stays within the frozen 0010 CHECK vocabulary: a server-verified Cashfree
    * payment is a verified-store purchase, exactly like the native store grants. */
   if (product.crowns) journal(graph, { id: 'purchase:cashfree:' + orderId, actor: recorded.actor_id, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: tx.clock() });
   await creditWebPromotion(tx, recorded.actor_id, 'cashfree', orderId, 'purchase:cashfree:' + orderId, product.crowns, verified);
   await event(tx, recorded.actor_id, 'purchase_verified', product.crowns);
   await tx.query('UPDATE monetization.cashfree_orders SET status = $2, settled_at = $3 WHERE order_id = $1', [orderId, 'PAID', iso(tx.clock())]);
   /* B3: a discounted pack converts its reserved use to used on verified settlement; the CHECK
    * constraint is the backstop, so an over-consume can never commit silently. */
   if (product.crowns > 0) {
    const catalogPrice = config.cashfreeCatalog && typeof config.cashfreeCatalog[product.id] === 'string' ? config.cashfreeCatalog[product.id] : null;
    const wasDiscounted = catalogPrice !== null && Number(catalogPrice) > 0 && Math.abs(Number(recorded.amount) - Number(catalogPrice)) > 1e-9;
    if (!wasDiscounted) return { productId: product.id, crowns: product.crowns, duplicate: false, settled: true };
    await tx.query("UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved - 1, pack_discounts_used = pp.pack_discounts_used + 1 WHERE pp.subscription_id = $1 AND pp.period_start = $2 AND pp.pack_discounts_reserved > 0 AND pp.pack_discounts_used < 2", [recorded.discount_subscription_id, recorded.discount_period_start]);
   }
   return { productId: product.id, crowns: product.crowns, duplicate: false, settled: true };
  }, ['cashfree', orderId]);
 }

 /* The provider webhook (actor-free): the HMAC binds the EXACT raw bytes + timestamp to the
  * secret within a five-minute window, then the recorded order is settled through the INDEPENDENT
  * verification above - a captured or replayed webhook alone never grants. Refund events route to
  * the trusted refund below. */
 async function settleCashfreeWebhook(payload) {
  const provider = config.cashfreeProvider;
  if (!provider || typeof provider.verifyWebhook !== 'function') throw Error('CASHFREE_UNAVAILABLE');
  const raw = payload && typeof payload.raw === 'string' ? payload.raw : '';
  const timestamp = payload && typeof payload.timestamp === 'string' ? payload.timestamp : '';
  const signature = payload && typeof payload.signature === 'string' ? payload.signature : '';
  if (!raw || raw.length > 65536) throw Error('INVALID_WEBHOOK');
  if (!provider.verifyWebhook({ timestamp, signature, rawBody: raw })) throw Error('INVALID_WEBHOOK_SIGNATURE');
  let parsed; try { parsed = JSON.parse(raw); } catch { throw Error('INVALID_WEBHOOK'); }
  const orderId = parsed && parsed.data && parsed.data.order && parsed.data.order.order_id;
  if (typeof orderId !== 'string' || !provider.isOrderId(orderId)) throw Error('INVALID_WEBHOOK');
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  if (type.includes('refund')) return refundCashfreeOrder(orderId, 'provider-webhook');
  return settleCashfreeOrder(orderId);
 }

 /* The actor-bound status poll (the legacy cashfree/status GET): hides other actors' orders and
  * settles through the provider, so a missed webhook still grants. */
 async function cashfreeOrderStatus(actor, orderId) {
  if (typeof actor !== 'string' || !actor || typeof orderId !== 'string' || !orderId) throw Error('ORDER_NOT_FOUND');
  const row = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT order_id, product_id, status, settled_at, refunded_at FROM monetization.cashfree_orders WHERE order_id = $1 AND actor_id = $2', [orderId, actor])).rows[0] || null;
  });
  if (!row) throw Error('ORDER_NOT_FOUND');
  if (row.settled_at) {
   const product = M.product(row.product_id);
   return { orderId, paid: true, productId: row.product_id, crowns: product ? product.crowns : 0, refunded: row.refunded_at !== null };
  }
  const result = await settleCashfreeOrder(orderId);
  return {
   orderId,
   paid: result.settled === true,
   productId: row.product_id,
   crowns: result.settled ? (result.crowns || 0) : 0,
   status: result.settled ? undefined : result.status,
   duplicate: result.duplicate === true || result.alreadyOwned === true,
  };
 }

 /* The trusted refund lane (provider webhook or a later operator surface): marks the terminal
  * refunded_at (never a DELETE - the order row is permanent evidence), under the SAME order
  * identity mutex the settlement takes. The owned() projection reads refunded_at, so a refunded
  * once-product (remove_ads) is revoked structurally; spent Crowns stay spent - the ledger is
  * append-only and clawing funds from an innocent opponent is not a refund, it is a second bug. */
 async function refundCashfreeOrder(orderId, reason = 'refund') {
  const provider = config.cashfreeProvider;
  if (provider && typeof provider.isOrderId === 'function' && !provider.isOrderId(orderId)) throw Error('ORDER_NOT_FOUND');
  if (typeof orderId !== 'string' || !orderId) throw Error('ORDER_NOT_FOUND');
  const recorded = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT order_id, actor_id, product_id, settled_at, refunded_at FROM monetization.cashfree_orders WHERE order_id = $1', [orderId])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  if (!recorded.settled_at) return { orderId, refunded: false, reason: 'UNSETTLED' };
 return transaction(recorded.actor_id, 'cashfree-refund:' + orderId, { type: 'cashfree-refund', orderId }, async (tx, graph) => {
   const row = (await tx.query('SELECT refunded_at FROM monetization.cashfree_orders WHERE order_id = $1 FOR UPDATE', [orderId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) return { orderId, refunded: true, duplicate: true };
   await tx.query('UPDATE monetization.cashfree_orders SET refunded_at = $2 WHERE order_id = $1', [orderId, iso(tx.clock())]);
   /* MXA-ECO-013 (audit 2026-10-17): parity with the native refund lane - a refunded pack that
    * granted Crowns puts the account in review hold (never clawing from opponents); remove_ads
    * is revoked structurally by the owned() projection reading refunded_at. */
   const refundedProduct = M.product(recorded.product_id);
   const heldAccount = refundedProduct && refundedProduct.crowns > 0 ? graph.accounts.get(recorded.actor_id) : null;
   if (heldAccount) heldAccount.hold = true;
   await emitOutbox(tx, { id: 'commerce.cashfree-refund:' + orderId, event: { orderId, actor: recorded.actor_id, known: true, reason: String(reason).slice(0, 120) } });
   await event(tx, recorded.actor_id, 'purchase_refunded', 0);
   return { orderId, refunded: true, duplicate: false };
  }, ['cashfree', orderId]);
 }

  /* A1b: the browser needs the hosted checkout URL. It is stored durably on the READY reservation
  * (response_text) and re-read on every replay path, so the SAME durable key always returns the
  * SAME checkout without a second provider create and without trusting any client value. */
 async function polarReadyCheckoutUrl(checkoutId) {
  const row = (await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query("SELECT response_text FROM monetization.commerce_create_requests WHERE provider = 'polar' AND provider_object_id = $1 AND state = 'READY' AND response_text IS NOT NULL LIMIT 1", [checkoutId])).rows[0] || null;
  }));
  if (!row) return null;
  try { const parsed = JSON.parse(row.response_text); return typeof parsed.checkoutUrl === 'string' && parsed.checkoutUrl.startsWith('https://') ? parsed.checkoutUrl : null; } catch { return null; }
 }

 /* Server-side Polar checkout creation (the legacy cashfree/order shape, USD). The SAME durable
  * key returns the SAME checkout; the catalog price id and cents are SERVER-AUTHORITATIVE.
  *
  * RESERVE-THEN-CREATE: identical fence to the Cashfree lane. Polar generates its own checkout
  * id, so the reservation's request_id travels in the server-owned checkout metadata (the
  * reconciliation key - Polar provides no external idempotency and none is assumed). */
 async function createPolarCheckout(actor, key, productId, customer) {
  const entry = polarCatalogEntry(productId);
  if (!idOK(key)) throw Error('IDEMPOTENCY_KEY_REQUIRED');
  if (customer !== undefined && customer !== null && (typeof customer !== 'object' || Array.isArray(customer))) throw Error('INVALID_CUSTOMER_DETAILS');
  const email = customer && typeof customer.email === 'string' ? customer.email.trim() : '';
  if (email && (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw Error('INVALID_CUSTOMER_DETAILS');
  const fingerprint = createFingerprint('polar-create', productId);
  const previous = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, product_id, status FROM monetization.polar_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0] || null;
  });
  if (previous) {
   if (previous.product_id !== productId) throw Error('IDEMPOTENCY_CONFLICT');
   const replayUrl = await polarReadyCheckoutUrl(previous.checkout_id);
   return { checkoutId: previous.checkout_id, productId: previous.product_id, status: previous.status, ...(replayUrl ? { checkoutUrl: replayUrl } : {}) };
  }
  /* The account gate BEFORE the provider round-trip (the purchase preflight pattern). */
  const preflight = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const graph = await tx.repositories.domain();
   const wallet = await tx.query('SELECT 1 AS ok FROM economy.wallets WHERE actor_id = $1', [actor]);
   return { ready: wallet.rows.length > 0, account: accountOf(graph, actor) };
  });
  if (!preflight.ready) throw Error('ACCOUNT_REQUIRED');
  const reservation = await reserveCreate(uow, actor, key, 'polar', productId, fingerprint, { priceId: entry.priceId, amountCents: entry.amountCents, currency: 'usd' }, customer && customer.promotionAcceptanceHash);
  if (!reservation.won) {
   const r = reservation.reservation;
   if (!r || r.provider !== 'polar' || r.product_id !== productId || r.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
   if (r.state === 'FAILED') { const e = Error(r.error_code || 'POLAR_CREATE_FAILED'); e.status = 502; throw e; }
   if (r.state === 'READY' && r.provider_object_id) {
    const row = (await uow.run(async (tx) => { await tx.query('SET TRANSACTION READ ONLY'); return (await tx.query('SELECT checkout_id, status FROM monetization.polar_orders WHERE checkout_id = $1', [r.provider_object_id])).rows[0] || null; }));
    if (row) { const readyUrl = await polarReadyCheckoutUrl(row.checkout_id); return { checkoutId: row.checkout_id, productId, status: row.status, ...(readyUrl ? { checkoutUrl: readyUrl } : {}) }; }
   }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  const requestId = reservation.requestId;
  /* MXA-ECO-011 (audit 2026-10-17): B3 parity for the Polar lane - an active Mega Pass discounts
   * at most two Crown packs per paid month. The use is RESERVED under a row lock before the
   * provider call (single actor-level period, mirroring the Cashfree lane) and released only on
   * a terminal, proven non-creation; verified settlement converts it to used. */
  const packProduct = M.product(productId);
  const isPack = Boolean(packProduct && packProduct.crowns > 0) && typeof config.polarPackDiscountId === 'string' && config.polarPackDiscountId.length > 0;
  let reservedPeriod = null;
  let expectedCents = entry.amountCents;
  if (isPack) {
   const reserved = await uow.run(async (tx) => (await tx.query(
    "UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved + 1 FROM monetization.store_subscriptions ps WHERE pp.subscription_id = ps.subscription_id AND ps.actor_id = $1 AND ps.status = 'active' AND pp.period_start <= $2 AND pp.period_end > $2 AND pp.pack_discounts_reserved + pp.pack_discounts_used < 2 AND pp.subscription_id = (SELECT ps2.subscription_id FROM monetization.store_subscriptions ps2 WHERE ps2.actor_id = $1 AND ps2.status = 'active' ORDER BY ps2.created_at DESC LIMIT 1) AND pp.period_start = (SELECT MAX(pp3.period_start) FROM monetization.pass_periods pp3 WHERE pp3.subscription_id = pp.subscription_id AND pp3.period_start <= $2 AND pp3.period_end > $2) RETURNING pp.subscription_id, pp.period_start",
    [actor, new Date(serviceNow()).toISOString()])).rows[0] || null);
   if (reserved) {
    reservedPeriod = { subscriptionId: reserved.subscription_id, start: new Date(reserved.period_start).toISOString() };
    expectedCents = Math.round(entry.amountCents * (1 - M.PASS.packDiscount));
   }
  }
  let created;
  try {
   created = await withDeadline(config.polarProvider.createCheckout({ priceId: entry.priceId, actor, productId, email: email || undefined, successUrl: config.polarSuccessUrl, metadata: { request_id: requestId }, discountId: reservedPeriod ? config.polarPackDiscountId : undefined }));
  } catch (error) {
   const code = String(error && error.message || 'POLAR_CREATE_UNKNOWN');
   const httpMatch = /^POLAR_HTTP_([0-9]{3})$/.exec(code);
   const terminal = code === 'POLAR_AUTH' || code === 'POLAR_CONFIG' || (!!httpMatch && httpMatch[1] !== '408' && httpMatch[1] !== '429');
   if (terminal && reservedPeriod) await uow.run(async (tx) => {
    await tx.query("UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved - 1 WHERE pp.subscription_id = $2 AND pp.period_start = $3 AND pp.pack_discounts_reserved > 0", [actor, reservedPeriod.subscriptionId, reservedPeriod.start]);
   });
   await markReservation(uow, requestId, terminal ? 'FAILED' : 'UNKNOWN', { errorCode: terminal ? code : null });
   if (terminal) { error.status = 502; throw error; }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  return transaction(actor, key, { type: 'polar-create', productId }, async (tx) => {
   /* The (actor, op_key) unique constraint (0057) is the durable race fence. */
   await tx.query(
    'INSERT INTO monetization.polar_orders (checkout_id, actor_id, product_id, price_id, amount_cents, currency, status, op_key, created_at, discount_subscription_id, discount_period_start) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (actor_id, op_key) DO NOTHING',
    [created.checkoutId, actor, productId, entry.priceId, expectedCents, 'usd', 'created', key, iso(tx.clock()), reservedPeriod ? reservedPeriod.subscriptionId : null, reservedPeriod ? reservedPeriod.start : null]);
   const row = (await tx.query('SELECT checkout_id, status FROM monetization.polar_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0];
   if (!row) throw Error('POLAR_RECORD_FAILED');
   /* READY commits in the SAME transaction as the ledger + outcome (see the Cashfree lane). */
   await tx.query(
    'UPDATE monetization.commerce_create_requests SET state = $2, provider_object_id = $3, response_text = $4, updated_at = $5 WHERE request_id = $1 AND state = $6',
    [requestId, 'READY', created.checkoutId, JSON.stringify(created).slice(0, 4096), iso(tx.clock()), 'PENDING']);
   return { checkoutId: row.checkout_id, productId, status: row.status, checkoutUrl: created.checkoutUrl };
  }, null, { reservation: { requestId, won: true } });
 }

 /* The Polar settlement core, shared by the webhook and the status poll. The INDEPENDENT
  * verification returns the price amount, currency AND the metadata binding; all three must match
  * the recorded row before any economic transaction (the provider boundary). */
 async function settlePolarOrder(checkoutId, hints = {}) {
  const provider = config.polarProvider;
  if (!provider || typeof provider.verifyCheckout !== 'function') throw Error('POLAR_UNAVAILABLE');
  if (typeof checkoutId !== 'string' || !UUID_V4.test(checkoutId)) throw Error('ORDER_NOT_FOUND');
  const recorded = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, actor_id, product_id, price_id, amount_cents, currency, status, polar_order_id, settled_at, refunded_at, discount_subscription_id, discount_period_start FROM monetization.polar_orders WHERE checkout_id = $1', [checkoutId])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  if (recorded.refunded_at) throw Error('ORDER_REFUNDED');
  const verified = await provider.verifyCheckout(checkoutId);
  if (!verified || verified.status !== 'succeeded') return { checkoutId, settled: false, status: verified ? verified.status : null };
  if (verified.currency !== recorded.currency || Number(recorded.amount_cents) !== verified.amount) throw Error('ORDER_AMOUNT_MISMATCH');
  const metaActor = verified.metadata && typeof verified.metadata.actor === 'string' ? verified.metadata.actor : '';
  const metaProduct = verified.metadata && typeof verified.metadata.product_id === 'string' ? verified.metadata.product_id : '';
  if (metaActor !== recorded.actor_id || metaProduct !== recorded.product_id) throw Error('INVALID_RECEIPT');
  const product = M.product(recorded.product_id);
  if (!product) throw Error('INVALID_PRODUCT');
  const polarOrderId = typeof hints.orderId === 'string' && hints.orderId && hints.orderId.length <= 160 ? hints.orderId : null;
  return transaction(recorded.actor_id, 'polar:' + checkoutId, { type: 'polar-settle', checkoutId }, async (tx, graph, current) => {
   if (!config.purchasesEnabled || !allowed(current)) throw Error('PURCHASE_UNAVAILABLE');
   const row = (await tx.query('SELECT settled_at, refunded_at FROM monetization.polar_orders WHERE checkout_id = $1 FOR UPDATE', [checkoutId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) throw Error('ORDER_REFUNDED');
   if (row.settled_at) return { productId: product.id, duplicate: true, settled: true };
   if (product.once) {
    for (const r of await tx.repositories.purchases.forActor(recorded.actor_id)) {
     if (r.productId !== product.id) continue;
     if (r.refunded) throw Error('PRODUCT_PREVIOUSLY_REFUNDED');
     return { productId: product.id, alreadyOwned: true, settled: true };
    }
    const prev = (await tx.query('SELECT refunded_at FROM monetization.polar_orders WHERE actor_id = $1 AND product_id = $2 AND settled_at IS NOT NULL AND checkout_id <> $3 ORDER BY created_at LIMIT 1', [recorded.actor_id, product.id, checkoutId])).rows[0];
    if (prev) {
     if (prev.refunded_at) throw Error('PRODUCT_PREVIOUSLY_REFUNDED');
     return { productId: product.id, alreadyOwned: true, settled: true };
    }
   }
   current.crowns = D.add(current.crowns, product.crowns);
   current.purchasedCrowns = D.add(current.purchasedCrowns || 0, product.crowns);
   if (product.crowns) current.purchaseInfluenced = true;
   if (product.crowns) journal(graph, { id: 'purchase:polar:' + checkoutId, actor: recorded.actor_id, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: tx.clock() });
   await creditWebPromotion(tx, recorded.actor_id, 'polar', checkoutId, 'purchase:polar:' + checkoutId, product.crowns, verified);
   await event(tx, recorded.actor_id, 'purchase_verified', product.crowns);
   await tx.query('UPDATE monetization.polar_orders SET status = $2, settled_at = $3, polar_order_id = COALESCE($4, polar_order_id) WHERE checkout_id = $1', [checkoutId, 'succeeded', iso(tx.clock()), polarOrderId]);
   /* MXA-ECO-011: a discounted pack converts its reserved use to used on verified settlement;
    * the CHECK constraint is the backstop, so an over-consume can never commit silently. */
   const catalogEntry = config.polarCatalog && config.polarCatalog[product.id];
   const catalogCents = catalogEntry && Number.isFinite(Number(catalogEntry.amountCents)) ? Number(catalogEntry.amountCents) : null;
   if (product.crowns > 0 && catalogCents !== null && Number(recorded.amount_cents) < catalogCents) {
    await tx.query('UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved - 1, pack_discounts_used = pp.pack_discounts_used + 1 WHERE pp.subscription_id = $1 AND pp.period_start = $2 AND pp.pack_discounts_reserved > 0 AND pp.pack_discounts_used < 2', [recorded.discount_subscription_id, recorded.discount_period_start]);
   }
   /* B2: the first paid pass order binds the subscription row to the RECORDED checkout actor and
    * product/price inside the settlement transaction - never from webhook payload fields alone.
    * The grantable period window arrives with the provider-verified subscription events. */
   const passSubscriptionId = typeof hints.subscriptionId === 'string' && hints.subscriptionId && hints.subscriptionId.length <= 160 ? hints.subscriptionId : null;
   if (passSubscriptionId && product.id === 'mega_pass') {
    await tx.query(
     "INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at) VALUES ($1, $2, 'mega_pass', $3, 'active', false, NULL, NULL, $4, $4) ON CONFLICT (subscription_id) DO NOTHING",
     [passSubscriptionId, recorded.actor_id, recorded.price_id, iso(tx.clock())]);
   }
   return { productId: product.id, crowns: product.crowns, duplicate: false, settled: true };
  }, ['polar', checkoutId]);
 }

 /* The Dodo lane (2026-10-19): identical reserve-then-create fence, independent verification and
  * settlement semantics as the Polar lane, against monetization.dodo_orders (0064). The player's
  * region hint picks the catalog currency (validated against the SERVER-SIDE per-currency prices,
  * never a client amount); the recorded (currency, amount_cents) is what settlement requires the
  * verified payment to match exactly. During the intro window the pack-discount code is NOT
  * stacked on top of the intro pricing - the deeper launch price already applies, so the pass
  * holder's two-per-month pack discounts stay reserved for the standard price window. */
 async function dodoReadyCheckoutUrl(checkoutId) {
  const row = (await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query("SELECT response_text FROM monetization.commerce_create_requests WHERE provider = 'dodo' AND provider_object_id = $1 AND state = 'READY' AND response_text IS NOT NULL LIMIT 1", [checkoutId])).rows[0] || null;
  }));
  if (!row) return null;
  try { const parsed = JSON.parse(row.response_text); return typeof parsed.checkoutUrl === 'string' && parsed.checkoutUrl.startsWith('https://') ? parsed.checkoutUrl : null; } catch { return null; }
 }

 function dodoIntroActive() {
  if (!config.dodoIntroEndsAt) return false;
  const end = Date.parse(config.dodoIntroEndsAt);
  return Number.isFinite(end) && serviceNow() < end;
 }
 function dodoIntroPricingActive() {
  if (config.dodoIntroPricingActive === true || config.dodoIntroPricingActive === false) return config.dodoIntroPricingActive;
  return dodoIntroActive();
 }
 function dodoPromoFor(productId) {
  const promo = config.dodoPromo;
  /* The promo window is the launch-discount mechanism itself: the products sit at BASE prices
   * and the code delivers the 50% at checkout, so it applies for the whole configured window -
   * there is no separate intro-price state to collide with any more. */
  if (!promo || !promo.products.includes(productId)) return null;
  const end = Date.parse(promo.expiresAt);
  if (!Number.isFinite(end) || serviceNow() >= end) return null;
  return promo;
 }

 /* MXA-PROMO-RESTORE (2026-10-19): the unattended promo-expiry restore. After the intro window
  * the one-time Dodo products must return to their base prices WITHOUT a human SSH step: the
  * provider state is verified first, only mismatches are patched, every write is re-verified,
  * and only then does the running catalog flip to the regular prices so new orders record the
  * base amount. A failed restore keeps the intro catalog serving (so the recorded amount always
  * equals the provider charge), returns the failure list, and the caller raises the operational
  * alert. Idempotent and retryable by construction; a restart simply re-verifies. The Mega Pass
  * is excluded - its price never flips because its promo discount is the customer-entered code. */
 let introRestoreDone = false;
 async function processIntroPriceRestore() {
  if (introRestoreDone) return { done: true, restored: 0, already: 0 };
  const provider = config.dodoProvider;
  if (!provider || typeof provider.restoreProductPrice !== 'function') return { skipped: 'no-provider' };
  if (!config.dodoCatalog || !config.dodoRegularCatalog || !config.dodoIntroEndsAt) return { skipped: 'not-configured' };
  const end = Date.parse(config.dodoIntroEndsAt);
  if (!Number.isFinite(end)) return { skipped: 'invalid-window' };
  if (serviceNow() < end) return { pending: true, endsAt: config.dodoIntroEndsAt };
  const targets = Object.entries(config.dodoCatalog).filter(([productId, entry]) =>
   productId !== 'mega_pass' && entry && typeof entry.productId === 'string' &&
   config.dodoRegularCatalog[productId] && config.dodoRegularCatalog[productId].prices);
  if (!targets.length) { introRestoreDone = true; return { done: true, restored: 0, already: 0 }; }
  const failures = [];
  let restored = 0, already = 0;
  for (const [productId, entry] of targets) {
   try {
    const result = await provider.restoreProductPrice({ dodoProductId: entry.productId, base: config.dodoRegularCatalog[productId].prices });
    if (result === 'patched') restored++; else already++;
    /* MXA-PROMO-RESTORE-PARTIAL (Sol P1): flip each product's catalog prices the moment ITS
     * provider restore is verified, so a later product's failure can never leave an
     * already-restored product recording intro prices the provider no longer charges. */
    entry.prices = { ...config.dodoRegularCatalog[productId].prices };
   } catch (error) { failures.push({ productId, code: String(error && error.message || error).slice(0, 120) }); }
  }
  if (failures.length) return { pending: true, failures, restored, already };
  /* Sol round 2: a successful unattended restore also resumes the pack discount - the explicit
   * env flag must not stay true forever after the prices it guarded are gone. */
  config.dodoIntroPricingActive = false;
  introRestoreDone = true;
  return { done: true, restored, already };
 }

 async function createDodoCheckout(actor, key, productId, customer, region = {}) {
  const entry = dodoCatalogEntry(productId);
  if (!idOK(key)) throw Error('IDEMPOTENCY_KEY_REQUIRED');
  if (customer !== undefined && customer !== null && (typeof customer !== 'object' || Array.isArray(customer))) throw Error('INVALID_CUSTOMER_DETAILS');
  const email = customer && typeof customer.email === 'string' ? customer.email.trim() : '';
  if (email && (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw Error('INVALID_CUSTOMER_DETAILS');
  const { currency, amountCents } = dodoPriceFor(entry, region && region.currency);
  const country = region && typeof region.country === 'string' && DODO_COUNTRY.test(region.country) ? region.country : null;
  const fingerprint = createFingerprint('dodo-create', productId + ':' + currency);
  /* MXA-PROMO-SPLIT (2026-10-19, owner model, FINAL): the recorded amount is exactly the
   * configured catalog price. During the launch window the Dodo product itself carries the
   * intro price (the provider's own pricing mechanism - no code, no player action), and the
   * Mega Pass stays at its base price because its discount is the LAUNCH50 code the player
   * enters on the Dodo checkout. Recorded price and provider charge are therefore the same
   * number by construction, and the settlement boundary tolerance below covers only the
   * promo-boundary race and the code-applied pass total. */
  const recordedCents = amountCents;
  const previous = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, product_id, status FROM monetization.dodo_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0] || null;
  });
  if (previous) {
   if (previous.product_id !== productId) throw Error('IDEMPOTENCY_CONFLICT');
   const replayUrl = await dodoReadyCheckoutUrl(previous.checkout_id);
   return { checkoutId: previous.checkout_id, productId: previous.product_id, status: previous.status, ...(replayUrl ? { checkoutUrl: replayUrl } : {}) };
  }
  const preflight = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const graph = await tx.repositories.domain();
   const wallet = await tx.query('SELECT 1 AS ok FROM economy.wallets WHERE actor_id = $1', [actor]);
   return { ready: wallet.rows.length > 0, account: accountOf(graph, actor) };
  });
  if (!preflight.ready) throw Error('ACCOUNT_REQUIRED');
   const reservation = await reserveCreate(uow, actor, key, 'dodo', productId, fingerprint, { productId: entry.productId, amountCents: recordedCents, currency }, customer && customer.promotionAcceptanceHash);
  if (!reservation.won) {
   const r = reservation.reservation;
   if (!r || r.provider !== 'dodo' || r.product_id !== productId || r.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
   if (r.state === 'FAILED') { const e = Error(r.error_code || 'DODO_CREATE_FAILED'); e.status = 502; throw e; }
   if (r.state === 'READY' && r.provider_object_id) {
    const row = (await uow.run(async (tx) => { await tx.query('SET TRANSACTION READ ONLY'); return (await tx.query('SELECT checkout_id, status FROM monetization.dodo_orders WHERE checkout_id = $1', [r.provider_object_id])).rows[0] || null; }));
    if (row) { const readyUrl = await dodoReadyCheckoutUrl(row.checkout_id); return { checkoutId: row.checkout_id, productId, status: row.status, ...(readyUrl ? { checkoutUrl: readyUrl } : {}) }; }
   }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  const requestId = reservation.requestId;
  /* MXA-ECO-011 parity for the Dodo lane: an active Mega Pass discounts at most two Crown packs
   * per paid month. The use is RESERVED under a row lock before the provider call and released
   * only on a terminal, proven non-creation; verified settlement converts it to used. During the
   * intro window the launch price is already the deeper discount, so the pack code never stacks. */
  const packProduct = M.product(productId);
   const packDiscountUsable = Boolean(packProduct && packProduct.crowns > 0) && !dodoPromoFor(productId) && typeof config.dodoPackDiscountId === 'string' && config.dodoPackDiscountId.length > 0 && !dodoIntroPricingActive();
  let reservedPeriod = null;
   let expectedCents = recordedCents;
   if (packDiscountUsable) {
   const reserved = await uow.run(async (tx) => (await tx.query(
    "UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved + 1 FROM monetization.store_subscriptions ps WHERE pp.subscription_id = ps.subscription_id AND ps.actor_id = $1 AND ps.status = 'active' AND pp.period_start <= $2 AND pp.period_end > $2 AND pp.pack_discounts_reserved + pp.pack_discounts_used < 2 AND pp.subscription_id = (SELECT ps2.subscription_id FROM monetization.store_subscriptions ps2 WHERE ps2.actor_id = $1 AND ps2.status = 'active' ORDER BY ps2.created_at DESC LIMIT 1) AND pp.period_start = (SELECT MAX(pp3.period_start) FROM monetization.pass_periods pp3 WHERE pp3.subscription_id = pp.subscription_id AND pp3.period_start <= $2 AND pp3.period_end > $2) RETURNING pp.subscription_id, pp.period_start",
    [actor, new Date(serviceNow()).toISOString()])).rows[0] || null);
   if (reserved) {
    reservedPeriod = { subscriptionId: reserved.subscription_id, start: new Date(reserved.period_start).toISOString() };
    expectedCents = Math.round(amountCents * (1 - M.PASS.packDiscount));
   }
  }
  let created;
  try {
   created = await withDeadline(config.dodoProvider.createCheckout({
    productId: entry.productId, actor, storeProductId: productId, email: email || undefined,
    successUrl: config.dodoSuccessUrl, metadata: { request_id: requestId, op_key: key },
    billingCurrency: currency, country,
    /* No launch code is ever attached here: one-time products are discounted by the provider
     * price itself, and the Mega Pass code is the player's own checkout action. The pack
     * discount (15% off up to two packs per pass month) is the only server-attached code. */
    discountCodes: reservedPeriod ? [config.dodoPackDiscountId] : null,
   }));
  } catch (error) {
   const code = String(error && error.message || 'DODO_CREATE_UNKNOWN');
   const httpMatch = /^DODO_HTTP_([0-9]{3})$/.exec(code);
   const terminal = code === 'DODO_AUTH' || code === 'DODO_CONFIG' || (!!httpMatch && httpMatch[1] !== '408' && httpMatch[1] !== '429');
   if (terminal && reservedPeriod) await uow.run(async (tx) => {
    await tx.query("UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved - 1 WHERE pp.subscription_id = $2 AND pp.period_start = $3 AND pp.pack_discounts_reserved > 0", [actor, reservedPeriod.subscriptionId, reservedPeriod.start]);
   });
   await markReservation(uow, requestId, terminal ? 'FAILED' : 'UNKNOWN', { errorCode: terminal ? code : null });
   if (terminal) { error.status = 502; throw error; }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  /* The finalization command fingerprint MUST equal the reservation fingerprint exactly
   * (createFingerprint('dodo-create', productId + ':' + currency)): transaction() recomputes
   * sha256(JSON.stringify(command)) and only the winning creator (same fingerprint) may pass
   * the PENDING fence. Currency-scoped idempotency is deliberate - a retry with a different
   * currency must never replay the first currency's checkout - so the currency rides here. */
  return transaction(actor, key, { type: 'dodo-create', productId: productId + ':' + currency }, async (tx) => {
   await tx.query(
    'INSERT INTO monetization.dodo_orders (checkout_id, actor_id, product_id, price_id, amount_cents, currency, status, op_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (actor_id, op_key) DO NOTHING',
    [created.checkoutId, actor, productId, entry.productId, expectedCents, currency, 'created', key, iso(tx.clock())]);
   const row = (await tx.query('SELECT checkout_id, status FROM monetization.dodo_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0];
   if (!row) throw Error('DODO_RECORD_FAILED');
   /* Canonical fence-close (Cashfree/Polar 853/1087): $1 is the request_id in the WHERE and the
    * PENDING guard is part of the fence; the previous shape left $1 unused (pg 42P18) and shifted
    * every value one slot. */
   await tx.query(
    'UPDATE monetization.commerce_create_requests SET state = $2, provider_object_id = $3, response_text = $4, updated_at = $5 WHERE request_id = $1 AND state = $6',
    [requestId, 'READY', created.checkoutId, JSON.stringify({ checkoutUrl: created.checkoutUrl, checkoutId: created.checkoutId }).slice(0, 4096), iso(tx.clock()), 'PENDING']);
   await event(tx, actor, 'checkout_created', 0);
   return { checkoutId: created.checkoutId, productId, status: 'created', checkoutUrl: created.checkoutUrl };
  /* Same fence authorization the Cashfree finalization passes: without it the PENDING fence
   * refuses the creator itself and every create dies CHECKOUT_CREATE_PENDING (2026-10-19 e2e). */
  }, null, { reservation: { requestId, won: true } });
 }

 /* The provider webhook (actor-free): the Standard Webhooks HMAC binds the EXACT raw bytes, then
  * the recorded order is settled through the INDEPENDENT verification above; refund events route
  * to the trusted lane by checkout_id or polar_order_id. */
 async function settlePolarWebhook(payload) {
  const provider = config.polarProvider;
  if (!provider || typeof provider.verifyWebhook !== 'function') throw Error('POLAR_UNAVAILABLE');
  const raw = payload && typeof payload.raw === 'string' ? payload.raw : '';
  const id = payload && typeof payload.id === 'string' ? payload.id : '';
  const timestamp = payload && typeof payload.timestamp === 'string' ? payload.timestamp : '';
  const signature = payload && typeof payload.signature === 'string' ? payload.signature : '';
  if (!raw || raw.length > 262144) throw Error('INVALID_WEBHOOK');
  if (!provider.verifyWebhook({ id, timestamp, signature, rawBody: raw })) throw Error('INVALID_WEBHOOK_SIGNATURE');
  let parsed; try { parsed = JSON.parse(raw); } catch { throw Error('INVALID_WEBHOOK'); }
  const type = parsed && typeof parsed.type === 'string' ? parsed.type : '';
  const data = parsed && typeof parsed.data === 'object' && parsed.data ? parsed.data : {};
  if (type.startsWith('order.')) {
   const checkoutId = typeof data.checkout_id === 'string' ? data.checkout_id : '';
   const subscriptionId = typeof data.subscription_id === 'string' && data.subscription_id && data.subscription_id.length <= 160 ? data.subscription_id : '';
   if (!UUID_V4.test(checkoutId)) return { handled: false, reason: 'NO_CHECKOUT' };
   if (type === 'order.paid') return settlePolarOrder(checkoutId, { orderId: typeof data.id === 'string' ? data.id : undefined, subscriptionId: subscriptionId || undefined });
   return { handled: true, type, checkoutId };
  }
  if (type.startsWith('subscription.')) {
   return reconcilePolarSubscription(type, data);
  }
  if (type.startsWith('refund.')) {
   const ref = typeof data.order_id === 'string' && data.order_id ? data.order_id : (typeof data.checkout_id === 'string' ? data.checkout_id : '');
   if (!ref) return { handled: false, reason: 'NO_REFERENCE' };
   return refundPolarOrder(ref, 'provider-webhook');
  }
  return { handled: false, reason: 'UNROUTED_TYPE' };
 }

 /* B2: subscription lifecycle reconciliation. EVERY event is re-read from the provider before any
  * write (the verifyCheckout pattern). The actor binding comes from the already-bound row or from a
  * recorded pass checkout with matching actor/product/price - never from metadata.actor alone. A
  * cancel keeps access until the paid period end; a revocation ends it immediately. A provider-
  * verified active period (Polar only advances current_period after a successful billing payment;
  * failed renewals go past_due and keep the old window) becomes a grantable paid period, and the
  * sweep still bounds every installment by that window. */
 async function reconcilePolarSubscription(type, data) {
  const provider = config.polarProvider;
  if (!provider || typeof provider.verifySubscription !== 'function') throw Error('POLAR_UNAVAILABLE');
  const subscriptionId = typeof data.id === 'string' && data.id && data.id.length <= 160 ? data.id : '';
  if (!subscriptionId) return { handled: false, reason: 'NO_SUBSCRIPTION' };
  const verified = await provider.verifySubscription(subscriptionId);
  if (!verified || typeof verified.status !== 'string') return { handled: false, reason: 'NOT_VERIFIABLE' };
  const now = new Date(serviceNow());
  const existing = (await pool.query('SELECT actor_id, price_id FROM monetization.polar_subscriptions WHERE subscription_id = $1', [subscriptionId])).rows[0] || null;
  let actor = existing ? existing.actor_id : null;
  const priceId = verified.priceId || (existing ? existing.price_id : '');
  const entry = config.polarCatalog ? config.polarCatalog['mega_pass'] : null;
  if (entry && priceId && priceId !== entry.priceId) return { handled: false, reason: 'INVALID_BINDING' };
  if (!actor) {
   const metaActor = typeof verified.metadata.actor === 'string' ? verified.metadata.actor.slice(0, 160) : '';
   if (!metaActor || !priceId) return { handled: false, reason: 'NO_ACTOR_BINDING' };
   const checkout = (await pool.query('SELECT actor_id FROM monetization.polar_orders WHERE actor_id = $1 AND product_id = $2 AND price_id = $3 LIMIT 1', [metaActor, 'mega_pass', priceId])).rows[0] || null;
   if (!checkout) return { handled: false, reason: 'INVALID_BINDING' };
   actor = metaActor;
  }
  if (type === 'subscription.revoked' || verified.status === 'revoked' || verified.status === 'inactive') {
   await pool.query("INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at) VALUES ($1, $2, 'mega_pass', $3, 'revoked', false, $4, $5, $6, $6) ON CONFLICT (subscription_id) DO UPDATE SET status = 'revoked', updated_at = $6",
    [subscriptionId, actor, priceId, verified.currentPeriodStart, verified.currentPeriodEnd, now]);
   return { handled: true, subscriptionId, status: 'revoked' };
  }
  if (type === 'subscription.canceled' || type === 'subscription.uncanceled' || type === 'subscription.updated' || type === 'subscription.created' || type === 'subscription.active') {
   const canceled = type === 'subscription.canceled' || verified.cancelAtPeriodEnd === true;
   const lifecycled = ['active', 'trialing', 'past_due'].includes(verified.status);
   const status = lifecycled ? 'active' : 'revoked';
   await pool.query("INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at) VALUES ($1, $2, 'mega_pass', $3, $4, $5, $6, $7, $8, $8) ON CONFLICT (subscription_id) DO UPDATE SET status = $4, cancel_at_period_end = $5, current_period_start = $6, current_period_end = $7, updated_at = $8",
    [subscriptionId, actor, priceId, status, canceled, verified.currentPeriodStart, verified.currentPeriodEnd, now]);
   /* A provider-verified active window becomes a grantable paid period. */
   const periodStart = verified.currentPeriodStart ? new Date(verified.currentPeriodStart) : null;
   const periodEnd = verified.currentPeriodEnd ? new Date(verified.currentPeriodEnd) : null;
   /* MXA-ECO-008 (audit 2026-10-17): a grantable PAID period requires the PROVIDER-verified
    * status 'active'. trialing/past_due keep row access ('active' per the 0059 CHECK) but can
    * never mint pass_periods, so an unpaid window can never qualify for Crown installments. */
   if (verified.status === 'active' && status === 'active' && periodStart && periodEnd && !Number.isNaN(periodStart.getTime()) && !Number.isNaN(periodEnd.getTime()) && periodEnd > periodStart) {
    await pool.query('INSERT INTO monetization.pass_periods (subscription_id, actor_id, period_start, period_end, installments_granted, created_at) VALUES ($1, $2, $3, $4, 0, $5) ON CONFLICT (subscription_id, period_start) DO NOTHING',
     [subscriptionId, actor, periodStart, periodEnd, now]);
   }
   return { handled: true, subscriptionId, status, canceled, periodStart: verified.currentPeriodStart, periodEnd: verified.currentPeriodEnd };
  }
  return { handled: false, reason: 'UNROUTED_SUBSCRIPTION_TYPE', type };
 }

 /* B2: the maintenance sweep for the canonical 150 Crowns / paid month as 50 on period day 1, 11
  * and 21 (paid period start + 0/10/20 days, bounded by the paid period end). Each grant commits
  * the wallet credit and its installment marker in ONE Core transaction; downtime catches up
  * exactly once and a replayed grant is refused by the marker. Status reads stay read-only -
  * this is the only catch-up path. */
 async function processPassGrants() {
  if (!config.purchasesEnabled) return { granted: 0, skipped: 'PURCHASES_DISABLED' };
  const offsets = [0, 10, 20];
  /* MXA-ECO-009 (audit 2026-10-17): ONE paid pass per actor - the newest active subscription
   * owns the grantable period; duplicates are skipped explicitly instead of stacking 3x50. */
  const due = await pool.query(
   "SELECT DISTINCT ON (pp.actor_id) pp.subscription_id, pp.actor_id, pp.period_start, pp.period_end, pp.installments_granted FROM monetization.pass_periods pp JOIN monetization.store_subscriptions ps ON ps.subscription_id = pp.subscription_id WHERE ps.status = 'active' AND pp.installments_granted < 3 AND pp.subscription_id = (SELECT ps2.subscription_id FROM monetization.store_subscriptions ps2 WHERE ps2.actor_id = pp.actor_id AND ps2.status = 'active' ORDER BY ps2.created_at DESC LIMIT 1) ORDER BY pp.actor_id, ps.created_at DESC, pp.period_end DESC LIMIT 200");
  let granted = 0;
  const now = serviceNow();
  for (const row of due.rows) {
   const start = new Date(row.period_start).getTime(), end = new Date(row.period_end).getTime();
   const n = Number(row.installments_granted);
   const offset = offsets[n];
   if (!Number.isFinite(offset)) continue;
   if (now < start + offset * 86400000 || now > end) continue;
   const result = await transaction(row.actor_id, 'pass-installment:' + row.subscription_id + ':' + new Date(row.period_start).toISOString().slice(0, 10) + ':' + n,
    { type: 'pass-installment', subscriptionId: row.subscription_id, index: n },
    async (tx, graph, current) => {
     const fresh = (await tx.query('SELECT installments_granted FROM monetization.pass_periods WHERE subscription_id = $1 AND period_start = $2 FOR UPDATE', [row.subscription_id, row.period_start])).rows[0];
     if (!fresh) return { granted: false, reason: 'PERIOD_GONE' };
     /* Sol review round 2: reconciliation can install a newer active subscription between the
      * due query and this lock - the actor-level single-pass policy is re-checked INSIDE the
      * transaction, so a superseded subscription can never mint alongside the new one. */
     const stillNewest = (await tx.query("SELECT 1 FROM monetization.store_subscriptions ps WHERE ps.subscription_id = $1 AND ps.status = 'active' AND ps.subscription_id = (SELECT ps2.subscription_id FROM monetization.store_subscriptions ps2 WHERE ps2.actor_id = $2 AND ps2.status = 'active' ORDER BY ps2.created_at DESC LIMIT 1)", [row.subscription_id, row.actor_id])).rows.length > 0;
     if (!stillNewest) return { granted: false, reason: 'SUPERSEDED_SUBSCRIPTION' };
     if (Number(fresh.installments_granted) !== n) return { granted: false, duplicate: true };
     if (!config.purchasesEnabled || !allowed(current)) return { granted: false, reason: 'PURCHASE_UNAVAILABLE' };
     const amount = M.PASS.installments[n];
     current.crowns = D.add(current.crowns, amount);
     /* MXA-ECO-010 (audit 2026-10-17): the append-only ledger id needs the immutable paid-period
      * identity - without it, month two reuses month one's id and the credit is silently lost. */
     journal(graph, { id: 'pass:' + row.subscription_id + ':' + new Date(row.period_start).toISOString().slice(0, 10) + ':' + n, actor: row.actor_id, currency: 'crowns', amount, reason: 'Mega Pass monthly Crowns', source: 'verified-store', at: tx.clock() });
     await event(tx, row.actor_id, 'pass_installment', amount);
     await tx.query('UPDATE monetization.pass_periods SET installments_granted = $3 WHERE subscription_id = $1 AND period_start = $2', [row.subscription_id, row.period_start, n + 1]);
     return { granted: true, amount };
    });
   if (result && result.granted) granted++;
  }
  return { granted };
 }

 /* The player-facing pass exchange: an idempotent Core command that debits Coins and credits
  * Crowns inside ONE transaction with the period row locked, so two concurrent exchanges can
  * never over-consume the monthly allowance. */
 async function exchangeCoins(actor, key, amount) {
  if (!idOK(key)) throw Error('IDEMPOTENCY_KEY_REQUIRED');
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) throw Error('INVALID_AMOUNT');
  return transaction(actor, key, { type: 'pass-exchange', amount }, async (tx, graph, current) => {
   if (!config.purchasesEnabled || !allowed(current)) throw Error('PURCHASE_UNAVAILABLE');
   const now = tx.clock();
   const passRow = await activePassRow(tx, actor, now);
   const at = typeof now === 'number' ? new Date(now).toISOString() : now;
   let periodRow = null;
   if (passRow) {
    periodRow = (await tx.query(
     'SELECT subscription_id, period_start, exchange_coins_used FROM monetization.pass_periods WHERE subscription_id = $1 AND period_start <= $2 AND period_end > $2 ORDER BY period_start DESC LIMIT 1 FOR UPDATE',
     [passRow.subscription_id, at])).rows[0] || null;
   }
   const used = periodRow ? Math.max(0, Number(periodRow.exchange_coins_used) || 0) : 0;
   const allowanceRemaining = periodRow ? Math.max(0, M.PASS.exchangeMonthlyCoinAllowance - used) : 0;
   const totalCoins = Number(current.coins) || 0;
   const purchasedCoins = Number(current.purchasedCoins) || 0;
   if (amount > totalCoins) throw Error('INSUFFICIENT_COINS');
   const earnedAvailable = Math.max(0, totalCoins - purchasedCoins);
   const split = passExchangeSplit(amount, allowanceRemaining, earnedAvailable);
   /* Purchased coins are consumed by the standard-rate tranche first and keep the frozen 10:1
    * provenance rate; purchasedCoins only ever enters at multiples of 10 (crowns->coins mints
    * 10 per Crown), so the restricted-provenance invariant holds by construction. */
   const purchasedUsed = Math.min(split.standard, purchasedCoins);
   current.coins = (Number(current.coins) || 0) - amount;
   current.purchasedCoins = purchasedCoins - purchasedUsed;
   current.crowns = D.add(current.crowns || 0, split.crowns);
   /* Sol review round 2: the purchased tranche keeps its RESTRICTED provenance on the Crowns side
    * too, exactly like the canonical conversion - otherwise a crowns->coins->crowns round trip
    * launders purchased Crowns into earned ones and the next month's 8:1 tranche mints value. */
   current.purchasedCrowns = D.add(current.purchasedCrowns || 0, purchasedUsed / 10);
   if (periodRow && split.discounted > 0) {
    await tx.query('UPDATE monetization.pass_periods SET exchange_coins_used = exchange_coins_used + $2 WHERE subscription_id = $1 AND period_start = $3', [periodRow.subscription_id, split.discounted, periodRow.period_start]);
   }
   /* Sol review round 2: economy.ledger entry ids are GLOBALLY unique - two actors sharing a
    * legal key must not collide, or the second mutation commits without its audit entries. */
   journal(graph, { id: 'exchange:' + actor + ':' + key + ':out', actor, currency: 'coins', amount: -amount, reason: 'Pass exchange', source: 'conversion', at: now });
   journal(graph, { id: 'exchange:' + actor + ':' + key + ':in', actor, currency: 'crowns', amount: split.crowns, reason: 'Pass exchange', source: 'conversion', at: now });
   await event(tx, actor, 'pass_exchange', split.crowns);
   return { crowns: split.crowns, discountedCoins: split.discounted, standardCoins: split.standard, allowanceRemaining: Math.max(0, allowanceRemaining - split.discounted) };
  });
 }

 /* MXA-WALLET-PATH (2026-10-19): the SERVER-side Crown debit for power-up charges. The native
  * adapter previously debited only the DEVICE save wallet while purchased Crowns credited the
  * ACCOUNT wallet - two ledgers that never met, so purchased Crowns could not fund a single
  * Undo. This op makes the online path spend from the authoritative account wallet with the
  * same idempotent transaction fence as every other economic command. Earned Crowns are
  * consumed first so the restricted purchased provenance survives as long as possible (the
  * same direction the exchange uses). Offline play keeps using the device wallet. */
 const POWER_COSTS = Object.freeze({ undo: 2, hint: 3 });
 async function powerSpend(actor, key, itemId) {
  if (!idOK(key)) throw Error('IDEMPOTENCY_KEY_REQUIRED');
  const cost = POWER_COSTS[itemId];
  if (!cost) throw Error('INVALID_POWER_KIND');
  return transaction(actor, key, { type: 'power-spend', kind: itemId }, async (tx, graph, current) => {
   if (!config.purchasesEnabled || !allowed(current)) throw Error('PURCHASE_UNAVAILABLE');
   const total = Number(current.crowns) || 0;
   if (total < cost) throw Error('INSUFFICIENT_CROWNS');
   const purchased = Number(current.purchasedCrowns) || 0;
   const earned = Math.max(0, total - purchased);
   const earnedSpent = Math.min(earned, cost);
   current.purchasedCrowns = Math.max(0, purchased - (cost - earnedSpent));
   current.crowns = total - cost;
   /* Sol review round 2 convention: ledger entry ids are GLOBALLY unique per mutation. */
   /* source='spend' stays inside the frozen 0010 ledger CHECK (no migration needed); the
    * reason carries the power kind for the audit trail. */
   journal(graph, { id: 'power:' + actor + ':' + key, actor, currency: 'crowns', amount: -cost, reason: 'Power-up purchase (' + itemId + ')', source: 'spend', at: tx.clock() });
   await event(tx, actor, 'power_spend', cost);
   return { kind: itemId, cost, crowns: current.crowns };
  });
 }

 /* The actor-bound status poll: hides other actors' orders and settles through the provider. */
 /* MXA-ECO-005 (2026-10-18): the durable provider-notification dedupe. The verification classes
  * stay DB-free; these two methods are the ONLY writers/readers of monetization.store_notifications
  * and run on this service's core_runtime pool, keeping the API tier out of the ledger. */
 async function storeNotificationSeen(store, notificationId) {
  if (!['google', 'apple'].includes(store) || typeof notificationId !== 'string' || notificationId.length < 1 || notificationId.length > 200) return true; /* fail closed: an unreadable id is treated as seen */
  const r = await pool.query('SELECT 1 FROM monetization.provider_notifications WHERE store = $1 AND notification_id = $2 LIMIT 1', [store, notificationId]);
  return r.rows.length > 0;
 }
 async function storeNotificationRecord(store, notificationId) {
  if (!['google', 'apple'].includes(store) || typeof notificationId !== 'string' || notificationId.length < 1 || notificationId.length > 200) throw Error('INVALID_STORE_NOTIFICATION');
  await pool.query('INSERT INTO monetization.provider_notifications (store, notification_id, received_at) VALUES ($1, $2, $3) ON CONFLICT (store, notification_id) DO NOTHING', [store, notificationId, new Date(serviceNow()).toISOString()]);
 }

 /* The Core-side notification lane: the composed verifier class (credential + parse) runs
  * OUTSIDE any wallet lock, then dedupe + the trusted refund route execute inside this service's
  * own pool. A notification can never mint: the only economic path is commerce.refund. */
 async function handleStoreNotification(provider, credential, payload) {
  const handlers = config.storeNotificationHandlers || null;
  const handler = handlers ? (provider === 'google' ? handlers.google : provider === 'apple' ? handlers.apple : null) : null;
  if (!handler || typeof handler.handle !== 'function') throw Error('STORE_UNAVAILABLE');
  /* The Google lane takes (push credential, envelope); the Apple lane takes (body) and verifies
   * the signedPayload itself. */
  const hooks = {
   seen: (store, id) => storeNotificationSeen(store, id),
   record: (store, id) => storeNotificationRecord(store, id),
   onRefund: (store, transactionId) => refund(store, transactionId),
  };
  return provider === 'google' ? handler.handle(credential, payload, hooks) : handler.handle(payload, hooks);
 }

 async function polarOrderStatus(actor, checkoutId) {
  if (typeof actor !== 'string' || !actor || typeof checkoutId !== 'string' || !checkoutId) throw Error('ORDER_NOT_FOUND');
  const row = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, product_id, status, settled_at, refunded_at FROM monetization.polar_orders WHERE checkout_id = $1 AND actor_id = $2', [checkoutId, actor])).rows[0] || null;
  });
  if (!row) throw Error('ORDER_NOT_FOUND');
  if (row.settled_at) {
   const product = M.product(row.product_id);
   return { checkoutId, paid: true, productId: row.product_id, crowns: product ? product.crowns : 0, refunded: row.refunded_at !== null };
  }
  const result = await settlePolarOrder(checkoutId);
  return {
   checkoutId,
   paid: result.settled === true,
   productId: row.product_id,
   crowns: result.settled ? (result.crowns || 0) : 0,
   status: result.settled ? undefined : result.status,
   duplicate: result.duplicate === true || result.alreadyOwned === true,
  };
 }

 /* The trusted Polar refund lane: finds the order by checkout_id OR polar_order_id, marks the
  * terminal refunded_at under the SAME identity mutex the settlement takes; the owned()
  * projection revokes a refunded remove_ads structurally. */
 async function refundPolarOrder(reference, reason = 'refund') {
  if (typeof reference !== 'string' || !reference) throw Error('ORDER_NOT_FOUND');
  const recorded = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, actor_id, product_id, settled_at, refunded_at FROM monetization.polar_orders WHERE checkout_id = $1 OR polar_order_id = $1', [reference])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  const checkoutId = recorded.checkout_id;
  if (!recorded.settled_at) return { checkoutId, refunded: false, reason: 'UNSETTLED' };
 return transaction(recorded.actor_id, 'polar-refund:' + checkoutId, { type: 'polar-refund', checkoutId }, async (tx, graph) => {
   const row = (await tx.query('SELECT refunded_at FROM monetization.polar_orders WHERE checkout_id = $1 FOR UPDATE', [checkoutId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) return { checkoutId, refunded: true, duplicate: true };
   await tx.query('UPDATE monetization.polar_orders SET refunded_at = $2 WHERE checkout_id = $1', [checkoutId, iso(tx.clock())]);
   /* MXA-ECO-013: the same review-hold parity as the Cashfree lane. */
   const refundedProduct = M.product(recorded.product_id);
   const heldAccount = refundedProduct && refundedProduct.crowns > 0 ? graph.accounts.get(recorded.actor_id) : null;
   if (heldAccount) heldAccount.hold = true;
   await emitOutbox(tx, { id: 'commerce.polar-refund:' + checkoutId, event: { checkoutId, actor: recorded.actor_id, known: true, reason: String(reason).slice(0, 120) } });
   await event(tx, recorded.actor_id, 'purchase_refunded', 0);
   return { checkoutId, refunded: true, duplicate: false };
  }, ['polar', checkoutId]);
 }

 /* The Dodo settlement core, shared by the webhook and the status poll. The INDEPENDENT
  * verification (session -> payment) returns the charged amount, currency AND the metadata
  * binding; all must match the recorded row before any economic transaction. A ±1 minor-unit
  * tolerance absorbs provider rounding on pass-discounted packs - the binding checks, not the
  * penny, are what stand between a player and an economic grant. */
 async function settleDodoOrder(checkoutId, hints = {}) {
  const provider = config.dodoProvider;
  if (!provider || typeof provider.verifyCheckout !== 'function') throw Error('DODO_UNAVAILABLE');
  if (typeof checkoutId !== 'string' || !provider.isSessionId(checkoutId)) throw Error('ORDER_NOT_FOUND');
  const recorded = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, actor_id, product_id, price_id, amount_cents, currency, status, dodo_payment_id, settled_at, refunded_at, created_at FROM monetization.dodo_orders WHERE checkout_id = $1', [checkoutId])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  if (recorded.refunded_at) throw Error('ORDER_REFUNDED');
  const verified = await provider.verifyCheckout(checkoutId);
  if (!verified || verified.status !== 'succeeded') return { checkoutId, settled: false, status: verified ? verified.status : null };
  /* MXA-PROMO-BOUNDARY (2026-10-19, owner model): the recorded amount is the catalog price at
   * creation. A checkout that crosses the promo boundary - or predates a flip, a restore or a
   * restart - may legitimately complete at ANY price the product actually carried in its promo
   * era: the current catalog, the retained intro catalog, the regular (base) catalog, and for
   * the Mega Pass the code-applied half of its base. Every candidate is one of the product's
   * OWN configured prices; the accepted set can never contain a stacked or invented amount.
   * The Dodo code expiry (provider-enforced) bounds the whole branch, and Dodo's own
   * checkout-session expiry stops an old discounted checkout from living indefinitely. */
  const promoConfig = config.dodoPromo && Array.isArray(config.dodoPromo.products) && config.dodoPromo.products.includes(recorded.product_id) ? config.dodoPromo : null;
  const recordedAt = Date.parse(recorded.created_at);
  /* The currency binds EVERY accepted amount: a matching number in the wrong currency is a
   * mismatch (Sol P1: the fallback branches previously skipped this and a numerically equal
   * cross-currency price verified). The structural candidates (current catalog, retained
   * intro, regular base) are unconditional - they are prices the product really carried, so
   * a flip/restore/restart between creation and payment can never strand the order. The
   * code-applied half is the ONE promo-gated candidate: it verifies only for an order created
   * inside the code window (Dodo itself rejects expired codes afterwards). */
  if (verified.currency !== recorded.currency) throw Error('ORDER_AMOUNT_MISMATCH');
  let amountVerified = Math.abs(Number(recorded.amount_cents) - verified.amount) <= 1;
  if (!amountVerified) {
   const candidates = new Set();
   const addPrice = (entry) => { const cents = entry && entry.prices ? entry.prices[recorded.currency] : null; if (Number.isSafeInteger(cents)) candidates.add(cents); };
   addPrice(config.dodoCatalog && config.dodoCatalog[recorded.product_id]);
   addPrice(config.dodoRegularCatalog && config.dodoRegularCatalog[recorded.product_id]);
   addPrice(config.dodoIntroCatalog && config.dodoIntroCatalog[recorded.product_id]);
   if (promoConfig && recorded.product_id === 'mega_pass' && Number.isFinite(recordedAt) && recordedAt < Date.parse(promoConfig.expiresAt)) {
    const passEntry = config.dodoCatalog && config.dodoCatalog.mega_pass;
    const passBaseCents = passEntry && passEntry.prices ? passEntry.prices[recorded.currency] : null;
    const promoCents = Number.isSafeInteger(passBaseCents) ? Math.max(1, Math.round(passBaseCents * (1 - promoConfig.percentBps / 10000))) : null;
    if (promoCents !== null) candidates.add(promoCents);
   }
   if (candidates.has(verified.amount)) amountVerified = true;
  }
  if (!amountVerified) throw Error('ORDER_AMOUNT_MISMATCH');
  const metaActor = verified.metadata && typeof verified.metadata.actor === 'string' ? verified.metadata.actor : '';
  const metaProduct = verified.metadata && typeof verified.metadata.product_id === 'string' ? verified.metadata.product_id : '';
  if (metaActor !== recorded.actor_id || metaProduct !== recorded.product_id) throw Error('INVALID_RECEIPT');
  const product = M.product(recorded.product_id);
  if (!product) throw Error('INVALID_PRODUCT');
  const dodoPaymentId = typeof hints.paymentId === 'string' && hints.paymentId && hints.paymentId.length <= 160 ? hints.paymentId : (verified.paymentId || null);
  return transaction(recorded.actor_id, 'dodo:' + checkoutId, { type: 'dodo-settle', checkoutId }, async (tx, graph, current) => {
   if (!config.purchasesEnabled || !allowed(current)) throw Error('PURCHASE_UNAVAILABLE');
   const row = (await tx.query('SELECT settled_at, refunded_at FROM monetization.dodo_orders WHERE checkout_id = $1 FOR UPDATE', [checkoutId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) throw Error('ORDER_REFUNDED');
   if (row.settled_at) return { productId: product.id, duplicate: true, settled: true };
   if (product.once) {
    for (const r of await tx.repositories.purchases.forActor(recorded.actor_id)) {
     if (r.productId !== product.id) continue;
     if (r.refunded) throw Error('PRODUCT_PREVIOUSLY_REFUNDED');
     return { productId: product.id, alreadyOwned: true, settled: true };
    }
    const prev = (await tx.query('SELECT refunded_at FROM monetization.dodo_orders WHERE actor_id = $1 AND product_id = $2 AND settled_at IS NOT NULL AND checkout_id <> $3 ORDER BY created_at LIMIT 1', [recorded.actor_id, product.id, checkoutId])).rows[0];
    if (prev) {
     if (prev.refunded_at) throw Error('PRODUCT_PREVIOUSLY_REFUNDED');
     return { productId: product.id, alreadyOwned: true, settled: true };
    }
   }
   current.crowns = D.add(current.crowns, product.crowns);
   current.purchasedCrowns = D.add(current.purchasedCrowns || 0, product.crowns);
   if (product.crowns) current.purchaseInfluenced = true;
   if (product.crowns) journal(graph, { id: 'purchase:dodo:' + checkoutId, actor: recorded.actor_id, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: tx.clock() });
   await creditWebPromotion(tx, recorded.actor_id, 'dodo', checkoutId, 'purchase:dodo:' + checkoutId, product.crowns, verified);
   await event(tx, recorded.actor_id, 'purchase_verified', product.crowns);
   await tx.query('UPDATE monetization.dodo_orders SET status = $2, settled_at = $3, dodo_payment_id = COALESCE($4, dodo_payment_id) WHERE checkout_id = $1', [checkoutId, 'succeeded', iso(tx.clock()), dodoPaymentId]);
   /* MXA-ECO-011: a discounted pack converts its reserved use to used on verified settlement. */
   const catalogEntry = config.dodoCatalog && config.dodoCatalog[product.id];
   const baseForCurrency = catalogEntry && catalogEntry.prices && Number.isFinite(Number(catalogEntry.prices[recorded.currency])) ? Number(catalogEntry.prices[recorded.currency]) : null;
   if (product.crowns > 0 && baseForCurrency !== null && Number(recorded.amount_cents) < baseForCurrency) {
    await tx.query('UPDATE monetization.pass_periods pp SET pack_discounts_reserved = pp.pack_discounts_reserved - 1, pack_discounts_used = pp.pack_discounts_used + 1 WHERE pp.subscription_id = (SELECT ps.subscription_id FROM monetization.store_subscriptions ps WHERE ps.actor_id = $1 AND ps.status = $2 ORDER BY ps.created_at DESC LIMIT 1) AND pp.period_start <= $3 AND pp.period_end > $3 AND pp.pack_discounts_reserved > 0 AND pp.pack_discounts_used < 2', [recorded.actor_id, 'active', new Date(iso(tx.clock())).toISOString()]);
   }
   /* B2: the first paid pass order binds the subscription row to the RECORDED checkout actor and
    * product/price inside the settlement transaction - never from webhook payload fields alone. */
   const passSubscriptionId = typeof hints.subscriptionId === 'string' && hints.subscriptionId && hints.subscriptionId.length <= 160 ? hints.subscriptionId : (verified.subscriptionId || null);
   if (passSubscriptionId && product.id === 'mega_pass') {
    await tx.query(
     "INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at, provider) VALUES ($1, $2, 'mega_pass', $3, 'active', false, NULL, NULL, $4, $4, 'dodo') ON CONFLICT (subscription_id) DO NOTHING",
     [passSubscriptionId, recorded.actor_id, recorded.price_id, iso(tx.clock())]);
   }
   return { productId: product.id, crowns: product.crowns, duplicate: false, settled: true };
  }, ['dodo', checkoutId]);
 }

 /* The Dodo subscription lifecycle reconciliation: EVERY event is re-read from the provider
  * before any write; the actor binding comes from the already-bound row (provider='dodo') or a
  * recorded pass checkout with matching actor/product/price. Dodo statuses map to the shared
  * ledger's 'active'/'revoked' pair; only a provider-verified 'active' status can mint a
  * grantable paid period (trialing/past_due/on_hold never do). */
 async function reconcileDodoSubscription(type, data) {
  const provider = config.dodoProvider;
  if (!provider || typeof provider.verifySubscription !== 'function') throw Error('DODO_UNAVAILABLE');
  const subscriptionId = typeof data.id === 'string' && data.id && data.id.length <= 160 ? data.id : '';
  if (!subscriptionId) return { handled: false, reason: 'NO_SUBSCRIPTION' };
  const verified = await provider.verifySubscription(subscriptionId);
  if (!verified || typeof verified.status !== 'string') return { handled: false, reason: 'NOT_VERIFIABLE' };
  const now = new Date(serviceNow());
  const existing = (await pool.query('SELECT actor_id, price_id, provider FROM monetization.polar_subscriptions WHERE subscription_id = $1', [subscriptionId])).rows[0] || null;
  let actor = existing && existing.provider === 'dodo' ? existing.actor_id : null;
  const priceId = existing && existing.provider === 'dodo' ? existing.price_id : (config.dodoCatalog && config.dodoCatalog.mega_pass ? config.dodoCatalog.mega_pass.productId : '');
  const entry = config.dodoCatalog ? config.dodoCatalog['mega_pass'] : null;
  if (entry && priceId && priceId !== entry.productId) return { handled: false, reason: 'INVALID_BINDING' };
  if (!actor) {
   const metaActor = typeof verified.metadata.actor === 'string' ? verified.metadata.actor.slice(0, 160) : '';
   if (!metaActor || !priceId) return { handled: false, reason: 'NO_ACTOR_BINDING' };
   const checkout = (await pool.query("SELECT actor_id FROM monetization.dodo_orders WHERE actor_id = $1 AND product_id = 'mega_pass' AND price_id = $2 LIMIT 1", [metaActor, priceId])).rows[0] || null;
   if (!checkout) return { handled: false, reason: 'INVALID_BINDING' };
   actor = metaActor;
  }
  if (type === 'subscription.cancelled' || type === 'subscription.expired' || type === 'subscription.failed' || verified.status === 'cancelled' || verified.status === 'expired' || verified.status === 'failed') {
   await pool.query("INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at, provider) VALUES ($1, $2, 'mega_pass', $3, 'revoked', false, $4, $5, $6, $6, 'dodo') ON CONFLICT (subscription_id) DO UPDATE SET status = 'revoked', updated_at = $6",
    [subscriptionId, actor, priceId, verified.currentPeriodStart, verified.currentPeriodEnd, now]);
   return { handled: true, subscriptionId, status: 'revoked' };
  }
  if (type === 'subscription.active' || type === 'subscription.updated' || type === 'subscription.renewed' || type === 'subscription.unpaused' || ['active', 'past_due', 'on_hold', 'paused'].includes(verified.status)) {
   const canceled = type === 'subscription.cancelled' || verified.cancelAtPeriodEnd === true;
   const lifecycled = verified.status === 'active';
   const status = lifecycled ? 'active' : 'revoked';
   await pool.query("INSERT INTO monetization.polar_subscriptions (subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end, current_period_start, current_period_end, created_at, updated_at, provider) VALUES ($1, $2, 'mega_pass', $3, $4, $5, $6, $7, $8, $8, 'dodo') ON CONFLICT (subscription_id) DO UPDATE SET status = $4, cancel_at_period_end = $5, current_period_start = $6, current_period_end = $7, updated_at = $8",
    [subscriptionId, actor, priceId, status, canceled, verified.currentPeriodStart, verified.currentPeriodEnd, now]);
   const periodStart = verified.currentPeriodStart ? new Date(verified.currentPeriodStart) : null;
   const periodEnd = verified.currentPeriodEnd ? new Date(verified.currentPeriodEnd) : null;
   if (verified.status === 'active' && status === 'active' && periodStart && periodEnd && !Number.isNaN(periodStart.getTime()) && !Number.isNaN(periodEnd.getTime()) && periodEnd > periodStart) {
    await pool.query('INSERT INTO monetization.pass_periods (subscription_id, actor_id, period_start, period_end, installments_granted, created_at) VALUES ($1, $2, $3, $4, 0, $5) ON CONFLICT (subscription_id, period_start) DO NOTHING',
     [subscriptionId, actor, periodStart, periodEnd, now]);
   }
   return { handled: true, subscriptionId, status, canceled, periodStart: verified.currentPeriodStart, periodEnd: verified.currentPeriodEnd };
  }
  return { handled: false, reason: 'UNROUTED_SUBSCRIPTION_TYPE', type };
 }

 /* The provider webhook (actor-free): the Standard Webhooks HMAC binds the EXACT raw bytes, then
  * the event routes on its type. Payment settlement resolves the recorded row through the VERIFIED
  * payment metadata (op_key/actor), never the webhook payload alone; refunds route by payment id. */
 async function settleDodoWebhook(payload) {
  const provider = config.dodoProvider;
  if (!provider || typeof provider.verifyWebhook !== 'function') throw Error('DODO_UNAVAILABLE');
  const raw = payload && typeof payload.raw === 'string' ? payload.raw : '';
  const id = payload && typeof payload.id === 'string' ? payload.id : '';
  const timestamp = payload && typeof payload.timestamp === 'string' ? payload.timestamp : '';
  const signature = payload && typeof payload.signature === 'string' ? payload.signature : '';
  if (!raw || raw.length > 262144) throw Error('INVALID_WEBHOOK');
  if (!provider.verifyWebhook({ id, timestamp, signature, rawBody: raw })) throw Error('INVALID_WEBHOOK_SIGNATURE');
  let parsed; try { parsed = JSON.parse(raw); } catch { throw Error('INVALID_WEBHOOK'); }
  const type = parsed && typeof parsed.type === 'string' ? parsed.type : '';
  const data = parsed && typeof parsed.data === 'object' && parsed.data ? parsed.data : {};
  if (type === 'payment.succeeded' || type === 'payment.processing' || type === 'payment.failed') {
   const paymentId = typeof data.payment_id === 'string' && data.payment_id ? data.payment_id : (typeof data.id === 'string' && data.id ? data.id : '');
   if (!paymentId || paymentId.length > 160) return { handled: false, reason: 'NO_PAYMENT' };
   const payment = await provider.verifyPayment(paymentId).catch(() => null);
   const opKey = payment && payment.metadata && typeof payment.metadata.op_key === 'string' ? payment.metadata.op_key : '';
   const metaActor = payment && payment.metadata && typeof payment.metadata.actor === 'string' ? payment.metadata.actor : '';
   if (!opKey || !metaActor) return { handled: true, type, paymentId, reason: 'NO_ORDER_BINDING' };
   const recorded = (await pool.query('SELECT checkout_id FROM monetization.dodo_orders WHERE actor_id = $1 AND op_key = $2', [metaActor, opKey])).rows[0] || null;
   if (!recorded) return { handled: true, type, paymentId, reason: 'NO_ORDER_ROW' };
   if (type !== 'payment.succeeded') return { handled: true, type, checkoutId: recorded.checkout_id };
   return settleDodoOrder(recorded.checkout_id, { paymentId });
  }
  if (type.startsWith('subscription.')) {
   return reconcileDodoSubscription(type, data);
  }
  if (type === 'refund.succeeded' || type === 'refund.failed') {
   const ref = typeof data.payment_id === 'string' && data.payment_id ? data.payment_id : '';
   if (!ref) return { handled: false, reason: 'NO_REFERENCE' };
   return refundDodoOrder(ref, 'provider-webhook');
  }
  return { handled: false, reason: 'UNROUTED_TYPE' };
 }

 /* The actor-bound status poll: hides other actors' orders and settles through the provider. */
 async function dodoOrderStatus(actor, checkoutId) {
  if (typeof actor !== 'string' || !actor || typeof checkoutId !== 'string' || !checkoutId) throw Error('ORDER_NOT_FOUND');
  const row = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, product_id, status, settled_at, refunded_at FROM monetization.dodo_orders WHERE checkout_id = $1 AND actor_id = $2', [checkoutId, actor])).rows[0] || null;
  });
  if (!row) throw Error('ORDER_NOT_FOUND');
  if (row.settled_at) {
   const product = M.product(row.product_id);
   return { checkoutId, paid: true, productId: row.product_id, crowns: product ? product.crowns : 0, refunded: row.refunded_at !== null };
  }
  const result = await settleDodoOrder(checkoutId);
  return {
   checkoutId,
   paid: result.settled === true,
   productId: row.product_id,
   crowns: result.settled ? (result.crowns || 0) : 0,
   status: result.settled ? undefined : result.status,
   duplicate: result.duplicate === true || result.alreadyOwned === true,
  };
 }

 /* The trusted Dodo refund lane: finds the order by checkout_id OR dodo_payment_id, marks the
  * terminal refunded_at under the SAME identity mutex the settlement takes; the owned()
  * projection revokes a refunded remove_ads structurally. */
 async function refundDodoOrder(reference, reason = 'refund') {
  if (typeof reference !== 'string' || !reference) throw Error('ORDER_NOT_FOUND');
  const recorded = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   return (await tx.query('SELECT checkout_id, actor_id, product_id, settled_at, refunded_at FROM monetization.dodo_orders WHERE checkout_id = $1 OR dodo_payment_id = $1', [reference])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  const checkoutId = recorded.checkout_id;
  if (!recorded.settled_at) return { checkoutId, refunded: false, reason: 'UNSETTLED' };
  return transaction(recorded.actor_id, 'dodo-refund:' + checkoutId, { type: 'dodo-refund', checkoutId }, async (tx, graph) => {
   const row = (await tx.query('SELECT refunded_at FROM monetization.dodo_orders WHERE checkout_id = $1 FOR UPDATE', [checkoutId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) return { checkoutId, refunded: true, duplicate: true };
   await tx.query('UPDATE monetization.dodo_orders SET refunded_at = $2 WHERE checkout_id = $1', [checkoutId, iso(tx.clock())]);
   const refundedProduct = M.product(recorded.product_id);
   const heldAccount = refundedProduct && refundedProduct.crowns > 0 ? graph.accounts.get(recorded.actor_id) : null;
   if (heldAccount) heldAccount.hold = true;
   await emitOutbox(tx, { id: 'commerce.dodo-refund:' + checkoutId, event: { checkoutId, actor: recorded.actor_id, known: true, reason: String(reason).slice(0, 120) } });
   await event(tx, recorded.actor_id, 'purchase_refunded', 0);
   return { checkoutId, refunded: true, duplicate: false };
  }, ['dodo', checkoutId]);
 }

 /* Trusted store-notification integration only. Never mount as a player endpoint. The refund
  * freezes the receipt and the account (security_hold) rather than clawing funds from an innocent
  * opponent, and records the permanent revocation tombstone so a later purchase of the same store
  * transaction fails `RECEIPT_REFUNDED` structurally.
  *
  * EVERY trusted refund establishes that tombstone, in ONE transaction with the receipt identity
  * mutex the purchase grant takes:
  *   - an UNKNOWN receipt is a revocation for a store transaction this database never granted (the
  *     provider charged and refunded it), so the tombstone is written WITHOUT inventing an actor
  *     hold or a refund balance;
  *   - an ALREADY-REFUNDED receipt is REPAIRED when its tombstone is missing - a refund that was
  *     recorded only through a path that did not write one must not stay re-grantable.
  * Only the receipt's OWN row decides actor/product; the globally capped receipt map is never used
  * as existence truth here. */
 async function refund(store, transactionId) {
  return uow.run(async (tx) => {
   const repositories = tx.repositories;
   await lockReceipt(tx, store, transactionId);
   const receipt = await receiptOf(tx, store, transactionId);
   const occurredAt = iso(tx.clock());
   if (!receipt) {
    /* Durable revocation for an unrouted store transaction: no actor, no hold, no balance. */
    await tx.query(
     'INSERT INTO monetization.store_revocations (store, transaction_id, product_id, occurred_at, reason) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (store, transaction_id) DO NOTHING',
     [store, transactionId, null, occurredAt, 'refund']);
    await emitOutbox(tx, { id: `commerce.refund:${store}:${transactionId}`, event: { store, transactionId, actor: null, known: false } });
    return { refunded: true, accountHeld: false, duplicate: false, known: false };
   }
   const actor = receipt.actor;
   /* Take the actor's eligibility row first (the Core column UPDATE grant permits the row lock),
    * then occupancy and wallet - the same eligibility -> occupancy -> wallet order the aggregate
    * diff's eligibility write and `core.provisionActor` use, so a refund racing a provisioning of
    * the same actor serializes instead of deadlocking. */
   await lockEligibility(tx.query, [actor]);
   await repositories.wallets.lock([actor]);
   const graph = await repositories.domain();
   /* Repair the tombstone FIRST, even for an already-refunded receipt: a refund that was recorded
    * through a path which did not write one must not stay re-grantable. */
   await tx.query(
    'INSERT INTO monetization.store_revocations (store, transaction_id, product_id, occurred_at, reason) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (store, transaction_id) DO NOTHING',
    [store, transactionId, receipt.productId || null, occurredAt, 'refund']);
   const id = store + ':' + transactionId;
   const live = graph.receipts.get(id);
   if (receipt.refunded) {
    /* Already refunded (possibly through the direct Core command): report the duplicate, and heal
     * the durable receipt flag if the capped hydration happened not to carry it. */
    await tx.query('UPDATE monetization.receipts SET refunded = true WHERE store = $1 AND transaction_id = $2', [store, transactionId]);
    if (live) live.refunded = true;
    await repositories.commitDomain();
    await emitOutbox(tx, { id: `commerce.refund:${store}:${transactionId}`, event: { store, transactionId, actor, known: true } });
    return { refunded: true, accountHeld: false, duplicate: true, known: true };
   }
   if (live) {
    live.refunded = true;
    const account = graph.accounts.get(actor);
    if (live.crowns && account) account.hold = true;
   } else {
    /* A receipt outside the hydration cap: persist the refunded flag through its own row, and hold
     * the account the receipt names. */
    await tx.query('UPDATE monetization.receipts SET refunded = true WHERE store = $1 AND transaction_id = $2', [store, transactionId]);
    const account = graph.accounts.get(actor);
    if (receipt.crowns && account) account.hold = true;
   }
   await repositories.commitDomain();
   await emitOutbox(tx, { id: `commerce.refund:${store}:${transactionId}`, event: { store, transactionId, actor, known: true } });
   await event(tx, actor, 'purchase_refunded');
   return { refunded: true, accountHeld: !!(receipt.crowns && (live ? live.crowns : true)), duplicate: false, known: true };
  });
 }

 // Private service integration for native stores: call BEFORE opening native billing. No
 // operator command is added to commerce ingress. Existing pre-policy receipts stay valid.
 async function reservePromotionCheckout(actor, key, productId, provider, acceptanceHash) {
  if (!['apple', 'google'].includes(provider) || !idOK(key)) throw Error('INVALID_PROMOTION_CHECKOUT');
  return uow.run(async tx => {
   await lockEligibility(tx.query, [actor]);
   if (!(await tx.repositories.wallets.lock([actor])).wallets) throw Error('ACCOUNT_REQUIRED');
   return Promotion.reserve(tx, actor, key, provider, M.product(productId), acceptanceHash);
  });
 }
 async function acceptPromotionPolicy(actor, receipt) {
  // Caller supplies an authenticated delivery/acceptance attestation verifier at composition.
  // A body saying accepted:true is insufficient and cannot establish retrospective acceptance.
  if (typeof options.verifyPromotionAcceptance !== 'function'
   || await options.verifyPromotionAcceptance(actor, receipt) !== true) throw Error('PROMOTION_ACCEPTANCE_UNVERIFIED');
  return uow.run(async tx => {
   await lockEligibility(tx.query, [actor]);
   await tx.repositories.wallets.lock([actor]);
   const state = await Promotion.allowance(tx, actor);
   if (!state.publishedAt || !state.ruleHash || receipt.policyVersion !== state.policyVersion
    || receipt.ruleHash !== state.ruleHash || receipt.remaining !== state.remaining
    || Date.parse(state.publishedAt) > tx.clock()) throw Error('PROMOTION_DISCLOSURE_STALE');
   const acceptanceHash = Promotion.hash({ actor, ...receipt });
   await tx.query('INSERT INTO monetization.promotion_acceptances (actor_id,policy_version,acceptance_hash,rule_hash,accepted_at,disclosed_remaining) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [actor, state.policyVersion, acceptanceHash, state.ruleHash, iso(tx.clock()), state.remaining]);
   return { acceptanceHash, ...state };
  });
 }
 async function creditWebPromotion(tx, actor, provider, orderId, grantId, crowns, verified) {
  if (!crowns) return;
  const row = (await tx.query('SELECT op_key FROM monetization.commerce_create_requests WHERE actor_id = $1 AND provider = $2 AND provider_object_id = $3', [actor, provider, orderId])).rows[0];
  if (row) await Promotion.creditLot(tx, actor, provider, row.op_key, grantId, crowns, {providerOrderRef:orderId,amount:verified.amount,currency:verified.currency});
 }

 /* ---------------------------------------------------------------- reads */

 /* The legacy `status()` projection. `purchasesAvailable` is false when the deployment has no
  * verifier, or when a provider verifier needs a store binding this actor does not have, so a
  * client is never told a purchase is possible when it cannot be. */
 async function status(actor) {
  return uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const graph = await tx.repositories.domain();
   const account = accountOf(graph, actor);
   const s = account.monetization, own = await ownedWithCashfree(tx, graph, account, actor), now = tx.clock(), eligible = allowed(account);
   const platforms = Object.entries(config.adUnits).filter(([, v]) => v.rewarded).map(([k]) => k);
   const adMode = eligible && platforms.length && typeof config.verifyAd === 'function' ? M.cohort(actor, config.adMode) : 'off';
   const verifier = config.purchaseProvider || config.verifyPurchase;
   const binding = await bindingFor(tx, actor);
   const purchasesAvailable = eligible && config.purchasesEnabled && !!verifier && (!(config.purchaseProvider && typeof config.purchaseProvider.verify === 'function') || !!binding);
   return {
    actor,
    serverNow: now,
    promotionAllocation: await Promotion.allowance(tx, actor),
    credits: s.credits,
    ...own,
    equipped: own.frames.includes(s.equipped) ? s.equipped : 'classic',
    boost: s.boosts.find((b) => b.endsAt > now) || null,
    rewardedRemaining: Math.max(0, M.POLICY.rewardedDayCap - await ticketsOnDay(tx, actor, M.day(now))),
    rewardReadyAt: s.lastRewardStart + M.POLICY.rewardedGap,
    adMode,
    purchasesAvailable,
    storeContext: purchasesAvailable && binding ? binding : null,
    stores: purchasesAvailable && config.purchaseProvider && typeof config.purchaseProvider.stores === 'function' ? config.purchaseProvider.stores() : [],
    adPlatforms: adMode === 'off' ? [] : platforms,
    /* A2: the web offer surface. Native purchasesAvailable semantics stay untouched - the lack of
     * a native bridge must never disable browser checkout, and guests browsing prices never read
     * another actor's entitlements (this whole reply stays actor-scoped and no-store). */
    webCheckoutAvailable: eligible && config.purchasesEnabled && Boolean(config.dodoProvider || config.polarProvider || config.cashfreeProvider),
    /* 2026-10-19: which provider NEW web checkouts use (the owner decision: Dodo primary, Polar
     * dormant). Existing Polar/Cashfree orders keep settling through their own lanes. */
    webCheckoutProvider: config.dodoProvider ? 'dodo' : config.polarProvider ? 'polar' : config.cashfreeProvider ? 'cashfree' : null,
    polar: config.polarProvider ? { available: true, products: Object.fromEntries(Object.entries(config.polarCatalog || {}).map(([id, entry]) => [id, { amountCents: entry.amountCents, currency: 'usd' }])) } : { available: false, products: {} },
    cashfree: config.cashfreeProvider ? { available: true, products: config.cashfreeCatalog || {} } : { available: false, products: {} },
    dodo: config.dodoProvider ? {
      available: true,
      products: Object.fromEntries(Object.entries(config.dodoCatalog || {}).filter(([id, entry]) => entry && Number.isFinite(Number(entry.prices.usd))).map(([id, entry]) => [id, { amountCents: entry.prices.usd, currency: 'usd' }])),
      /* Region-aware display prices in minor units (the localized Dodo prices); the client picks
       * its currency and the checkout charges exactly the recorded amount for that currency. */
      regions: Object.fromEntries(Object.entries(config.dodoCatalog || {}).map(([id, entry]) => [id, Object.fromEntries(Object.entries(entry.prices).map(([currency, cents]) => [currency, cents]))])),
      /* The REGULAR (pre-intro) prices for the slashed-price promo, in the same per-currency
       * minor-unit shape; absent config renders as null and the client shows no comparison. */
      regularRegions: config.dodoRegularCatalog ? Object.fromEntries(Object.entries(config.dodoRegularCatalog).map(([id, entry]) => [id, Object.fromEntries(Object.entries(entry.prices).map(([currency, cents]) => [currency, cents]))])) : null,
      /* The owner's launch-price bridge: while this promo is active the SERVER attaches the
       * Dodo discount code to qualifying checkouts and records the discounted amount, so the
       * client display and the settlement verification agree without any client input. */
      promo: config.dodoPromo && serviceNow() < Date.parse(config.dodoPromo.expiresAt) ? { code: config.dodoPromo.code, percentBps: config.dodoPromo.percentBps, products: config.dodoPromo.products, expiresAt: config.dodoPromo.expiresAt } : null,
      intro: config.dodoIntroEndsAt ? { active: dodoIntroActive(), endsAt: config.dodoIntroEndsAt } : null,
    } : { available: false, products: {}, regions: {} },
    pass: own.pass || { active: false, periodEnd: null, cancelAtPeriodEnd: false },
    /* MXA-ECO-011: the exchange surface the client needs to construct valid amounts. */
    passExchange: await (async () => {
     if (!own.pass || own.pass.active !== true) return { active: false, rate: D.POLICY.coinsPerCrown, remaining: 0, allowance: 0 };
     const periodRow = (await tx.query(
      'SELECT pp.exchange_coins_used FROM monetization.pass_periods pp JOIN monetization.store_subscriptions ps ON ps.subscription_id = pp.subscription_id WHERE ps.actor_id = $1 AND ps.status = $2 AND pp.period_start <= $3 AND pp.period_end > $3 ORDER BY ps.created_at DESC, pp.period_start DESC LIMIT 1',
      [actor, 'active', iso(now)])).rows[0] || null;
     const used = periodRow ? Math.max(0, Number(periodRow.exchange_coins_used) || 0) : 0;
     return { active: true, rate: M.PASS.exchangeCoinsPerCrown, remaining: Math.max(0, M.PASS.exchangeMonthlyCoinAllowance - used), allowance: M.PASS.exchangeMonthlyCoinAllowance };
    })(),
    policy: M.POLICY,
   };
  });
 }

 /* Sanitized monetization event counts (the legacy `report()`). */
 async function report() {
  const r = await pool.query('SELECT kind, count(*) AS events, sum(value) AS value FROM monetization.reward_events GROUP BY kind ORDER BY kind');
  return r.rows.map((row) => ({ kind: row.kind, events: Number(row.events), value: row.value === null ? null : Number(row.value) }));
 }

 return Object.freeze({
  role: CORE_ROLE,
  readiness,
  claim,
  cosmetic,
  ticket,
  callback,
  automaticPermit,
  purchase,
  reservePromotionCheckout,
  acceptPromotionPolicy,
  refund,
  status,
  report,
  processPurchaseFinalizations,
  createCashfreeOrder,
  settleCashfreeWebhook,
  cashfreeOrderStatus,
  refundCashfreeOrder,
  createPolarCheckout,
  settlePolarWebhook,
  polarOrderStatus,
  refundPolarOrder,
  createDodoCheckout,
  settleDodoWebhook,
  dodoOrderStatus,
  refundDodoOrder,
  processIntroPriceRestore,
  processPassGrants,
  passExchangeSplit,
  exchangeCoins,
  powerSpend,
  storeNotificationSeen,
  storeNotificationRecord,
  handleStoreNotification,
  /* Releases this service's unit-of-work state only. The pool is caller-owned (it carries a
    cluster-wide connection-budget claim) and is NEVER closed here. */
  close() { uow.close(); },
 });
}

module.exports = { createCommerceService, CORE_ROLE, normalizeAdUnits, passExchangeSplit };
