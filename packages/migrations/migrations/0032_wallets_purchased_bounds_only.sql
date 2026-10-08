-- 0032: economy.wallets purchased columns keep ONLY the independent source-safe bounds
-- (SourceGate scenario-A, parent-proven on native: the RAW SQLite wallet
-- coins=800 purchasedCoins=1000 reservedCoins=1200 — public purchase + convert + paid
-- tournament reservation — raised 23514 wallets_purchased_coins_bound_ck on insert because
-- the 0008 CHECK bundled purchased <= free balance as a cross-column comparison).
-- SOURCE TRUTH: src/authority.js:27 restore() clamps purchased* to the balance at HYDRATE
-- into JS — an in-memory repair of the live object plus a REPORTED transform
-- (packages/contracts/mapping.json:309-312 purchased-invalid-or-clamped; reader.js:73),
-- NOT an at-rest storage constraint: the raw text row legitimately sits with
-- purchased > free between writes, and the target's duty is conservative EXACT-source
-- import — raw UInt provenance with zero clamp/burn/reallocation.
-- [D] parent FINAL numeric-admission contract: our one public counterexample proves the
-- OLD bound was wrong; it does NOT establish a new global at-rest invariant for all
-- producers. Replace the purchased CHECKs with the standalone 0..MAX_SAFE_INTEGER bound
-- per column ONLY — do NOT substitute any other unproven ratio (neither purchased<=free
-- nor purchased<=free+reserved): extra ratio validation could reject another legitimate
-- source checkpoint. The coins/crowns/reserved bounds remain exactly as 0008 defined
-- them. Constraint names preserved so presence-based catalog conformance is unaffected.
ALTER TABLE economy.wallets DROP CONSTRAINT IF EXISTS wallets_purchased_coins_bound_ck;
ALTER TABLE economy.wallets ADD CONSTRAINT wallets_purchased_coins_bound_ck
  CHECK (purchased_coins BETWEEN 0 AND 9007199254740991);
ALTER TABLE economy.wallets DROP CONSTRAINT IF EXISTS wallets_purchased_crowns_bound_ck;
ALTER TABLE economy.wallets ADD CONSTRAINT wallets_purchased_crowns_bound_ck
  CHECK (purchased_crowns BETWEEN 0 AND 9007199254740991);
