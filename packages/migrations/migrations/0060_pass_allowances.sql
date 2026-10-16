-- runner: current-role
-- B3 (2026-10-17) - the pass allowance ledger on the paid-period rows (owner annotations 1/7,
-- docs/p21-web/ANNOTATION-IMPLEMENTATION-PLAN-20261016.md). Additive columns on 0059's
-- pass_periods; the Core commerce service is the only writer (core_runtime DML pattern).
--
-- exchange_coins_used: Coins already consumed toward the 200-Coin monthly 8:1 exchange window
-- (enforcement lands with a future V5 exchange lane; the column is the ledger).
-- pack_discounts_reserved / pack_discounts_used: the two discounted Crown packs per paid month.
-- A discounted order creation RESERVES one use under a row lock; verified settlement converts
-- it to used; a terminal provider rejection releases it. The CHECK caps the pair at 2.

ALTER TABLE monetization.pass_periods
  ADD COLUMN IF NOT EXISTS exchange_coins_used INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pack_discounts_reserved SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pack_discounts_used SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE monetization.pass_periods
  DROP CONSTRAINT IF EXISTS pass_periods_exchange_nonnegative,
  ADD CONSTRAINT pass_periods_exchange_nonnegative CHECK (exchange_coins_used >= 0);

ALTER TABLE monetization.pass_periods
  DROP CONSTRAINT IF EXISTS pass_periods_discount_reserved_range,
  ADD CONSTRAINT pass_periods_discount_reserved_range CHECK (pack_discounts_reserved >= 0 AND pack_discounts_reserved <= 2);

ALTER TABLE monetization.pass_periods
  DROP CONSTRAINT IF EXISTS pass_periods_discount_used_range,
  ADD CONSTRAINT pass_periods_discount_used_range CHECK (pack_discounts_used >= 0 AND pack_discounts_used <= 2);

ALTER TABLE monetization.pass_periods
  DROP CONSTRAINT IF EXISTS pass_periods_discount_quota,
  ADD CONSTRAINT pass_periods_discount_quota CHECK (pack_discounts_reserved + pack_discounts_used <= 2);
