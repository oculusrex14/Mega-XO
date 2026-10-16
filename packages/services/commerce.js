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
async function reserveCreate(uow, actor, key, provider, productId, fingerprint, priceSnapshot) {
  return uow.run(async (tx) => {
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
  if (options[name] !== undefined && typeof options[name] !== 'function') throw new PgGuardError('VERIFIER_REQUIRED', { verifier: name });
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
  cashfreeCatalog: options.cashfreeCatalog || null,
  cashfreeReturnUrl: typeof options.cashfreeReturnUrl === 'string' ? options.cashfreeReturnUrl : '',
  cashfreeNotifyUrl: typeof options.cashfreeNotifyUrl === 'string' ? options.cashfreeNotifyUrl : '',
  polarProvider: options.polarProvider || null,
  polarCatalog: options.polarCatalog || null,
  polarSuccessUrl: typeof options.polarSuccessUrl === 'string' ? options.polarSuccessUrl : '',
  adMode,
  rewardItem: typeof options.rewardItem === 'string' && options.rewardItem ? options.rewardItem : 'cosmetic_reward',
  adUnits: normalizeAdUnits(options.adUnits, options.adUnit),
  busy: typeof options.busy === 'function' ? options.busy : () => false,
 };

 const uow = createPgUnitOfWork(pool, { role: CORE_ROLE, now: options.now });

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

 /* Settled Cashfree AND Polar once-products for the owned() projection: the additive receipt
  * contracts (0056/0057). Both tables carry the terminal refunded_at, so a refunded
  * once-product (remove_ads) is revoked structurally in the same projection. */
 async function cashfreeOnceRows(tx, actor) {
  const r = await tx.query(
   'SELECT product_id, refunded_at FROM monetization.cashfree_orders WHERE actor_id = $1 AND settled_at IS NOT NULL ORDER BY created_at LIMIT $2',
   [actor, 100]);
  return r.rows;
 }

 /* owned() over the receipts UNION the settled Cashfree and Polar once-products. */
 async function ownedWithCashfree(tx, graph, account, actor) {
  const receipts = await tx.repositories.purchases.forActor(actor);
  const cashfreeRows = await cashfreeOnceRows(tx, actor);
  const polarRows = await tx.query('SELECT product_id, refunded_at FROM monetization.polar_orders WHERE actor_id = $1 AND settled_at IS NOT NULL ORDER BY created_at LIMIT $2', [actor, 100]);
  return owned(graph, account, [...receipts,
   ...cashfreeRows.map((r) => ({ productId: r.product_id, refunded: r.refunded_at !== null })),
   ...polarRows.rows.map((r) => ({ productId: r.product_id, refunded: r.refunded_at !== null }))]);
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
   const result = await fn(tx, graph, account);
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

 /* Reward-ticket issuance. A ticket is a durable REQUEST; the grant happens only in `callback`
  * after the provider independently confirms the impression. */
 function ticket(actor, key, kind, platform = 'legacy') {
  return transaction(actor, key, { type: 'ticket', kind, platform }, async (tx, _graph, account) => {
   const adUnit = assertAdSafe(account, platform, 'rewarded');
   if (!['credits', 'boost'].includes(kind)) throw Error('INVALID_REWARD');
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
   else {
    if (s.boosts.some((b) => b.endsAt > now)) throw Error('BOOST_ACTIVE');
    boost = { startedAt: now, endsAt: now + M.POLICY.boostDuration };
    s.boosts.push(boost);
   }
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
  const result = await transaction(actor, key, { type: restore ? 'restore' : 'purchase', receipt: safeReceipt }, async (tx, graph, current) => {
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
   current.crowns = D.add(current.crowns, product.crowns);
   if (product.crowns) current.purchaseInfluenced = true;
   graph.receipts.set(id, { actor, productId: product.id, crowns: product.crowns, refunded: false, at: tx.clock() });
   if (product.crowns) journal(graph, { id: 'purchase:' + id, actor, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: tx.clock() });
   await event(tx, actor, restore ? 'purchase_restored' : 'purchase_verified', product.crowns);
   return { productId: product.id, crowns: product.crowns, duplicate: false };
  }, [receipt.store, receipt.transactionId]);
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
   return { orderId: previous.order_id, productId: previous.product_id, paymentSessionId: previous.session_id };
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
  const reservation = await reserveCreate(uow, actor, key, 'cashfree', productId, fingerprint, { amount: price, currency: 'INR' });
  if (!reservation.won) {
   const r = reservation.reservation;
   if (!r || r.provider !== 'cashfree' || r.product_id !== productId || r.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
   if (r.state === 'FAILED') { const e = Error(r.error_code || 'CASHFREE_CREATE_FAILED'); e.status = 502; throw e; }
   /* READY/unknown-by-us: the ledger is the authority; a completed create replays from it. */
   if (r.state === 'READY' && r.provider_object_id) {
    const row = (await uow.run(async (tx) => { await tx.query('SET TRANSACTION READ ONLY'); return (await tx.query('SELECT order_id, session_id FROM monetization.cashfree_orders WHERE order_id = $1', [r.provider_object_id])).rows[0] || null; }));
    if (row) return { orderId: row.order_id, productId, paymentSessionId: row.session_id };
   }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  const requestId = reservation.requestId;
  const provider = config.cashfreeProvider;
  const orderId = typeof provider.newOrderId === 'function' ? provider.newOrderId() : newOrderId();
  await markReservation(uow, requestId, 'PENDING', { providerObjectId: orderId });
  let created;
  try {
   created = await withDeadline(provider.createOrder({ orderId, productId, amount: price, actor, email, phone, returnUrl: config.cashfreeReturnUrl, notifyUrl: config.cashfreeNotifyUrl }));
  } catch (error) {
   /* An explicit provider rejection proving non-creation (auth/4xx) is terminal FAILED;
    * timeouts, disconnects and 5xx/429/408 are ambiguous UNKNOWN. Neither is ever re-created
    * automatically - the reservation records exactly what happened for the recovery read. */
   const code = String(error && error.message || 'CASHFREE_CREATE_UNKNOWN');
   const httpMatch = /^CASHFREE_HTTP_([0-9]{3})$/.exec(code);
   const terminal = code === 'CASHFREE_AUTH' || code === 'CASHFREE_CONFIG' || (!!httpMatch && httpMatch[1] !== '408' && httpMatch[1] !== '429');
   await markReservation(uow, requestId, terminal ? 'FAILED' : 'UNKNOWN', { providerObjectId: orderId, errorCode: terminal ? code : null });
   if (terminal) { error.status = 502; throw error; }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  return transaction(actor, key, { type: 'cashfree-create', productId }, async (tx) => {
   /* The (actor, op_key) unique constraint (0056) is the durable race fence: two concurrent
    * creates with one key record ONE row; the loser returns the winner's recorded order. */
   await tx.query(
    'INSERT INTO monetization.cashfree_orders (order_id, actor_id, product_id, amount, currency, status, session_id, op_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (actor_id, op_key) DO NOTHING',
    [created.orderId, actor, productId, price, 'INR', 'ACTIVE', created.paymentSessionId, key, iso(tx.clock())]);
   const row = (await tx.query('SELECT order_id, session_id FROM monetization.cashfree_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0];
   if (!row) throw Error('CASHFREE_RECORD_FAILED');
   /* The reservation completes in the SAME transaction as the ledger + outcome: a crash between
    * the provider call and this commit leaves PENDING/UNKNOWN with the reserved order id, which
    * the recovery read resolves - never a silent second create. */
   await tx.query(
    'UPDATE monetization.commerce_create_requests SET state = $2, provider_object_id = $3, response_text = $4, updated_at = $5 WHERE request_id = $1 AND state = $6',
    [requestId, 'READY', created.orderId, JSON.stringify(created).slice(0, 4096), iso(tx.clock()), 'PENDING']);
   return { orderId: row.order_id, productId, paymentSessionId: row.session_id };
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
   return (await tx.query('SELECT order_id, actor_id, product_id, amount, status, settled_at, refunded_at FROM monetization.cashfree_orders WHERE order_id = $1', [orderId])).rows[0] || null;
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
   if (product.crowns) current.purchaseInfluenced = true;
   /* The ledger source stays within the frozen 0010 CHECK vocabulary: a server-verified Cashfree
    * payment is a verified-store purchase, exactly like the native store grants. */
   if (product.crowns) journal(graph, { id: 'purchase:cashfree:' + orderId, actor: recorded.actor_id, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: tx.clock() });
   await event(tx, recorded.actor_id, 'purchase_verified', product.crowns);
   await tx.query('UPDATE monetization.cashfree_orders SET status = $2, settled_at = $3 WHERE order_id = $1', [orderId, 'PAID', iso(tx.clock())]);
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
   return (await tx.query('SELECT order_id, actor_id, settled_at, refunded_at FROM monetization.cashfree_orders WHERE order_id = $1', [orderId])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  if (!recorded.settled_at) return { orderId, refunded: false, reason: 'UNSETTLED' };
  return transaction(recorded.actor_id, 'cashfree-refund:' + orderId, { type: 'cashfree-refund', orderId }, async (tx) => {
   const row = (await tx.query('SELECT refunded_at FROM monetization.cashfree_orders WHERE order_id = $1 FOR UPDATE', [orderId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) return { orderId, refunded: true, duplicate: true };
   await tx.query('UPDATE monetization.cashfree_orders SET refunded_at = $2 WHERE order_id = $1', [orderId, iso(tx.clock())]);
   await emitOutbox(tx, { id: 'commerce.cashfree-refund:' + orderId, event: { orderId, actor: recorded.actor_id, known: true, reason: String(reason).slice(0, 120) } });
   await event(tx, recorded.actor_id, 'purchase_refunded', 0);
   return { orderId, refunded: true, duplicate: false };
  }, ['cashfree', orderId]);
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
   return { checkoutId: previous.checkout_id, productId: previous.product_id, status: previous.status };
  }
  /* The account gate BEFORE the provider round-trip (the purchase preflight pattern). */
  const preflight = await uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const graph = await tx.repositories.domain();
   const wallet = await tx.query('SELECT 1 AS ok FROM economy.wallets WHERE actor_id = $1', [actor]);
   return { ready: wallet.rows.length > 0, account: accountOf(graph, actor) };
  });
  if (!preflight.ready) throw Error('ACCOUNT_REQUIRED');
  const reservation = await reserveCreate(uow, actor, key, 'polar', productId, fingerprint, { priceId: entry.priceId, amountCents: entry.amountCents, currency: 'usd' });
  if (!reservation.won) {
   const r = reservation.reservation;
   if (!r || r.provider !== 'polar' || r.product_id !== productId || r.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
   if (r.state === 'FAILED') { const e = Error(r.error_code || 'POLAR_CREATE_FAILED'); e.status = 502; throw e; }
   if (r.state === 'READY' && r.provider_object_id) {
    const row = (await uow.run(async (tx) => { await tx.query('SET TRANSACTION READ ONLY'); return (await tx.query('SELECT checkout_id, status FROM monetization.polar_orders WHERE checkout_id = $1', [r.provider_object_id])).rows[0] || null; }));
    if (row) return { checkoutId: row.checkout_id, productId, status: row.status };
   }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  const requestId = reservation.requestId;
  let created;
  try {
   created = await withDeadline(config.polarProvider.createCheckout({ priceId: entry.priceId, actor, productId, email: email || undefined, successUrl: config.polarSuccessUrl, metadata: { request_id: requestId } }));
  } catch (error) {
   const code = String(error && error.message || 'POLAR_CREATE_UNKNOWN');
   const httpMatch = /^POLAR_HTTP_([0-9]{3})$/.exec(code);
   const terminal = code === 'POLAR_AUTH' || code === 'POLAR_CONFIG' || (!!httpMatch && httpMatch[1] !== '408' && httpMatch[1] !== '429');
   await markReservation(uow, requestId, terminal ? 'FAILED' : 'UNKNOWN', { errorCode: terminal ? code : null });
   if (terminal) { error.status = 502; throw error; }
   const e = Error('CHECKOUT_CREATE_PENDING'); e.status = 503; e.retryAfter = 2; throw e;
  }
  return transaction(actor, key, { type: 'polar-create', productId }, async (tx) => {
   /* The (actor, op_key) unique constraint (0057) is the durable race fence. */
   await tx.query(
    'INSERT INTO monetization.polar_orders (checkout_id, actor_id, product_id, price_id, amount_cents, currency, status, op_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (actor_id, op_key) DO NOTHING',
    [created.checkoutId, actor, productId, entry.priceId, entry.amountCents, 'usd', 'created', key, iso(tx.clock())]);
   const row = (await tx.query('SELECT checkout_id, status FROM monetization.polar_orders WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0];
   if (!row) throw Error('POLAR_RECORD_FAILED');
   /* READY commits in the SAME transaction as the ledger + outcome (see the Cashfree lane). */
   await tx.query(
    'UPDATE monetization.commerce_create_requests SET state = $2, provider_object_id = $3, response_text = $4, updated_at = $5 WHERE request_id = $1 AND state = $6',
    [requestId, 'READY', created.checkoutId, JSON.stringify(created).slice(0, 4096), iso(tx.clock()), 'PENDING']);
   return { checkoutId: row.checkout_id, productId, status: row.status };
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
   return (await tx.query('SELECT checkout_id, actor_id, product_id, price_id, amount_cents, currency, status, polar_order_id, settled_at, refunded_at FROM monetization.polar_orders WHERE checkout_id = $1', [checkoutId])).rows[0] || null;
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
   if (product.crowns) current.purchaseInfluenced = true;
   if (product.crowns) journal(graph, { id: 'purchase:polar:' + checkoutId, actor: recorded.actor_id, currency: 'crowns', amount: product.crowns, reason: 'Crown purchase', source: 'verified-store', at: tx.clock() });
   await event(tx, recorded.actor_id, 'purchase_verified', product.crowns);
   await tx.query('UPDATE monetization.polar_orders SET status = $2, settled_at = $3, polar_order_id = COALESCE($4, polar_order_id) WHERE checkout_id = $1', [checkoutId, 'succeeded', iso(tx.clock()), polarOrderId]);
   return { productId: product.id, crowns: product.crowns, duplicate: false, settled: true };
  }, ['polar', checkoutId]);
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
   if (!UUID_V4.test(checkoutId)) return { handled: false, reason: 'NO_CHECKOUT' };
   if (type === 'order.paid') return settlePolarOrder(checkoutId, { orderId: typeof data.id === 'string' ? data.id : undefined });
   return { handled: true, type, checkoutId };
  }
  if (type.startsWith('refund.')) {
   const ref = typeof data.order_id === 'string' && data.order_id ? data.order_id : (typeof data.checkout_id === 'string' ? data.checkout_id : '');
   if (!ref) return { handled: false, reason: 'NO_REFERENCE' };
   return refundPolarOrder(ref, 'provider-webhook');
  }
  return { handled: false, reason: 'UNROUTED_TYPE' };
 }

 /* The actor-bound status poll: hides other actors' orders and settles through the provider. */
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
   return (await tx.query('SELECT checkout_id, actor_id, settled_at, refunded_at FROM monetization.polar_orders WHERE checkout_id = $1 OR polar_order_id = $1', [reference])).rows[0] || null;
  });
  if (!recorded) throw Error('ORDER_NOT_FOUND');
  const checkoutId = recorded.checkout_id;
  if (!recorded.settled_at) return { checkoutId, refunded: false, reason: 'UNSETTLED' };
  return transaction(recorded.actor_id, 'polar-refund:' + checkoutId, { type: 'polar-refund', checkoutId }, async (tx) => {
   const row = (await tx.query('SELECT refunded_at FROM monetization.polar_orders WHERE checkout_id = $1 FOR UPDATE', [checkoutId])).rows[0];
   if (!row) throw Error('ORDER_NOT_FOUND');
   if (row.refunded_at) return { checkoutId, refunded: true, duplicate: true };
   await tx.query('UPDATE monetization.polar_orders SET refunded_at = $2 WHERE checkout_id = $1', [checkoutId, iso(tx.clock())]);
   await emitOutbox(tx, { id: 'commerce.polar-refund:' + checkoutId, event: { checkoutId, actor: recorded.actor_id, known: true, reason: String(reason).slice(0, 120) } });
   await event(tx, recorded.actor_id, 'purchase_refunded', 0);
   return { checkoutId, refunded: true, duplicate: false };
  }, ['polar', checkoutId]);
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
  /* Releases this service's unit-of-work state only. The pool is caller-owned (it carries a
    cluster-wide connection-budget claim) and is NEVER closed here. */
  close() { uow.close(); },
 });
}

module.exports = { createCommerceService, CORE_ROLE, normalizeAdUnits };
