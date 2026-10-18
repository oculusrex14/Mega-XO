-- runner: current-role
-- MXA-ECO-004/011 follow-up (2026-10-18, Sol review): the pack-discount reservation must settle
-- against the EXACT (subscription, period) pair it reserved. Without the persisted pair, a
-- renewal or replacement between create and settlement converts the wrong month's quota. Both
-- columns are nullable: legacy rows and undiscounted orders keep the current behavior.
ALTER TABLE monetization.cashfree_orders
  ADD COLUMN IF NOT EXISTS discount_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS discount_period_start timestamptz;
ALTER TABLE monetization.polar_orders
  ADD COLUMN IF NOT EXISTS discount_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS discount_period_start timestamptz;
