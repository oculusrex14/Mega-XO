'use strict';

// Allocation and still-held provenance are distinct: only the latter ever decreases.
const CAP = 22000;
const VERSION = 'promotion-allocation-v1';
const iso = n => new Date(n).toISOString();
// JSONB changes object-key order. Hash canonical JSON, preserving array order, so a frozen
// decision has the same identity before and after its PostgreSQL round trip.
function canonical(v) {
 if (Array.isArray(v)) return v.map(canonical);
 if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
 return v;
}
const hash = v => require('node:crypto').createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(v))))).digest('hex');

function remaining(allocated) {
 if (!Number.isSafeInteger(allocated) || allocated < 0) throw Error('INVALID_ALLOCATION');
 return Math.max(0, CAP - allocated);
}
function requireCapacity(allocated, crowns) {
 if (!Number.isSafeInteger(crowns) || crowns <= 0 || crowns > remaining(allocated)) {
  const e = Error('PROMOTION_ALLOCATION_CAP'); e.status = 409; e.remaining = remaining(allocated); throw e;
 }
}
async function allowance(tx, actor) {
 const policy = (await tx.query('SELECT * FROM monetization.promotion_policies WHERE policy_version = $1', [VERSION])).rows[0];
 if (!policy) throw Error('PROMOTION_POLICY_REQUIRED');
 const allocated = Number((await tx.query('SELECT COALESCE(sum(crowns),0) AS total FROM monetization.promotion_allocations WHERE actor_id = $1', [actor])).rows[0].total);
 return { policyVersion: VERSION, campaignId: policy.campaign_id, cap: CAP, allocated,
  remaining: remaining(allocated), effectiveAt: new Date(policy.effective_at).toISOString(),
  expiresAt: new Date(policy.expires_at).toISOString(),
  publishedAt: policy.published_at, ruleHash: policy.rule_hash };
}
// Caller holds eligibility -> occupancy/wallet before this insert. Every provider shares it.
async function reserve(tx, actor, key, provider, product, acceptanceHash = null) {
 if (!product || !product.crowns) return null; // pass installments/once entitlements are excluded
 const old = (await tx.query('SELECT * FROM monetization.promotion_allocations WHERE actor_id = $1 AND op_key = $2', [actor, key])).rows[0];
 if (old) {
  if (old.provider !== provider || old.product_id !== product.id) throw Error('IDEMPOTENCY_CONFLICT');
  return old;
 }
 const state = await allowance(tx, actor);
 if (tx.clock() < Date.parse(state.effectiveAt) || tx.clock() >= Date.parse(state.expiresAt)) return null;
 requireCapacity(state.allocated, product.crowns);
 if (state.publishedAt && !acceptanceHash) throw Error('PROMOTION_ACCEPTANCE_REQUIRED');
 if (acceptanceHash) {
  const accepted = (await tx.query('SELECT 1 FROM monetization.promotion_acceptances WHERE actor_id = $1 AND policy_version = $2 AND acceptance_hash = $3 AND disclosed_remaining = $4 AND accepted_at <= $5', [actor, VERSION, acceptanceHash, state.remaining, iso(tx.clock())])).rows[0];
  if (!accepted) throw Error('PROMOTION_ACCEPTANCE_REQUIRED');
 }
 const id = hash([actor, key]);
 await tx.query('INSERT INTO monetization.promotion_allocations (allocation_id,actor_id,policy_version,provider,op_key,product_id,crowns,reserved_at,acceptance_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [id, actor, VERSION, provider, key, product.id, product.crowns, iso(tx.clock()), acceptanceHash]);
 return { allocation_id: id, ...state, remaining: state.remaining - product.crowns };
}
async function creditLot(tx, actor, provider, key, grantId, crowns) {
 if (!crowns) return;
 const allocation = (await tx.query('SELECT allocation_id FROM monetization.promotion_allocations WHERE actor_id = $1 AND provider = $2 AND op_key = $3', [actor, provider, key])).rows[0];
 // An older server-approved checkout remains valid, but is never evidence of an accepted breach.
 if (!allocation) return;
 await tx.query('INSERT INTO monetization.promotion_lots (grant_id,allocation_id,actor_id,held_crowns,held_coins,credited_at) VALUES ($1,$2,$3,$4,0,$5) ON CONFLICT (grant_id) DO NOTHING', [grantId, allocation.allocation_id, actor, crowns, iso(tx.clock())]);
}

// Conservative attribution: charge EVERY debit against every extant lot. Only the portion a
// conversion MUST have drawn from that lot can move to the other currency. This can recover less
// than FIFO, never legit/earned/pass funds. Credits/spending/refunds never recreate a depleted lot.
function moveLot(lot, before, debits, converted) {
 const out = { crowns: Number(lot.held_crowns), coins: Number(lot.held_coins) };
 for (const currency of ['crowns', 'coins']) {
  const debit = debits[currency] || 0;
  const guaranteed = Math.max(0, (converted[currency] || 0) - Math.max(0, before[currency] - out[currency]));
  out[currency] = Math.max(0, out[currency] - debit);
  if (currency === 'crowns') out.coins += guaranteed * 10;
  else out.crowns += Math.floor(guaranteed / 10);
 }
 return out;
}
function capture(graph) {
 return { ids: new Set(graph.authority.journal.map(e => e.id)), wallets: new Map([...graph.accounts].map(([a,w]) => [a, { crowns: w.crowns, coins: w.coins }])) };
}
async function track(tx, graph, before) {
 const fresh = graph.authority.journal.filter(e => !before.ids.has(e.id) && e.amount < 0);
 const actors = [...new Set(fresh.map(e => e.actor))].sort();
 for (const actor of actors) {
  const wallet = before.wallets.get(actor);
  if (!wallet) continue; // non-wallet system burn entries carry no recoverable player benefits
  const debits = { crowns: 0, coins: 0 }, converted = { crowns: 0, coins: 0 };
  for (const e of fresh.filter(e => e.actor === actor)) {
   debits[e.currency] += -e.amount;
   if (e.source === 'conversion') converted[e.currency] += -e.amount;
  }
  const lots = (await tx.query('SELECT * FROM monetization.promotion_lots WHERE actor_id = $1 ORDER BY grant_id FOR UPDATE', [actor])).rows;
  for (const lot of lots) {
   const held = moveLot(lot, wallet, debits, converted);
   await tx.query('UPDATE monetization.promotion_lots SET held_crowns = $2, held_coins = $3 WHERE grant_id = $1', [lot.grant_id, held.crowns, held.coins]);
  }
 }
}
module.exports = { CAP, VERSION, remaining, requireCapacity, allowance, reserve, creditLot, capture, track, moveLot, hash };
