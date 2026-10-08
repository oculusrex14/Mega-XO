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

const CORE_ROLE = 'core_runtime';
const DAY = 86400000;
const OUTBOX_EXPIRY_MS = 7 * DAY;
const OUTBOX_KIND = 'commerce.command';

/* Legacy key grammar (server/monetization-store.js idOK). */
function idOK(value) { return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value); }
function sha256hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
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
  adMode,
  rewardItem: typeof options.rewardItem === 'string' && options.rewardItem ? options.rewardItem : 'cosmetic_reward',
  adUnits: normalizeAdUnits(options.adUnits, options.adUnit),
  busy: typeof options.busy === 'function' ? options.busy : () => false,
 };

 const uow = createPgUnitOfWork(pool, { role: CORE_ROLE, now: options.now });

 function allowed(account) { return config.eligible(structuredClone(account)) === true; }

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
  return { frames: [...frames], products: [...new Set(products)], removeAds: products.includes('remove_ads') };
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
 async function transaction(actor, key, command, fn, prelock = null) {
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
   if (M.cohort(actor, config.adMode) !== 'hybrid' || owned(graph, account, await tx.repositories.purchases.forActor(actor)).removeAds) throw Error('AUTOMATIC_AD_DISABLED');
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
   if (!owned(graph, account, await tx.repositories.purchases.forActor(actor)).frames.includes(id)) {
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
   const s = account.monetization, own = owned(graph, account, await tx.repositories.purchases.forActor(actor)), now = tx.clock(), eligible = allowed(account);
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
  /* Releases this service's unit-of-work state only. The pool is caller-owned (it carries a
    cluster-wide connection-budget claim) and is NEVER closed here. */
  close() { uow.close(); },
 });
}

module.exports = { createCommerceService, CORE_ROLE, normalizeAdUnits };
