-- runner: current-role
-- 2026-10-19 - the Dodo Payments store lane (owner decision: Dodo = PRIMARY web checkout;
-- the Polar code stays composed but dormant, and existing Polar checkouts keep settling).
--
-- Additive, same authority pattern as 0056-0058: the API tier reaches these tables ONLY through
-- the signed commerce ingress (no api_runtime/worker grant), the commerce service writes them on
-- the core_runtime pool, and there is no DELETE anywhere. A rolled-back pre-0064 binary keeps
-- working: the provider column defaults to 'polar', the widened CHECK still admits every
-- pre-0064 value, and the views are additive objects the old code never references.

-- The subscription LEDGER is shared: pass_periods.subscription_id carries a FOREIGN KEY to
-- polar_subscriptions (0059), so a Dodo Mega Pass must live in the same table to earn installments
-- and pack discounts. provider marks the lane; ids are namespaced per provider (Polar UUIDs vs
-- Dodo prefixed ids) so the primary key cannot collide. Legacy name documented in 0059.
ALTER TABLE monetization.polar_subscriptions
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'polar' CHECK (provider IN ('polar', 'dodo'));

-- The reservation fence (0058) gains the dodo provider value; every pre-0064 value stays valid.
ALTER TABLE monetization.commerce_create_requests DROP CONSTRAINT commerce_create_requests_provider_check;
ALTER TABLE monetization.commerce_create_requests
  ADD CONSTRAINT commerce_create_requests_provider_check CHECK (provider IN ('cashfree', 'polar', 'dodo'));

-- The Dodo order ledger. Dodo checkout/session ids are provider-prefixed strings (NOT UUIDs) and
-- settlement can be a non-USD currency (adaptive/INR), so this mirror keeps the polar_orders
-- CHECKs (0057) intact. amount_cents stays the SERVER-AUTHORITATIVE recorded price; settlement
-- compares it exactly against the independent provider verification, never a client value.
CREATE TABLE IF NOT EXISTS monetization.dodo_orders (
  checkout_id TEXT NOT NULL CHECK (length(checkout_id) BETWEEN 1 AND 160),
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency IN ('usd', 'inr', 'eur', 'gbp')),
  status TEXT NOT NULL CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'expired')),
  dodo_payment_id TEXT,
  op_key TEXT NOT NULL CHECK (op_key ~ '^[A-Za-z0-9:_-]{1,160}$'),
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  refunded_at timestamptz,
  CONSTRAINT dodo_orders_pkey PRIMARY KEY (checkout_id),
  CONSTRAINT dodo_orders_actor_op_key_key UNIQUE (actor_id, op_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS dodo_orders_dodo_payment_id_key
  ON monetization.dodo_orders (dodo_payment_id) WHERE dodo_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dodo_orders_actor_created_idx
  ON monetization.dodo_orders (actor_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON monetization.dodo_orders TO core_runtime;
GRANT SELECT ON monetization.dodo_orders TO backup_reader;

-- Unified pass/ownership reads: the grant sweep, pack-discount reservation, exchange allowance
-- and owned() projection join these views so a Mega Pass from EITHER provider confers the same
-- benefits. Writes stay on the concrete tables; the views are read-only projections.
CREATE OR REPLACE VIEW monetization.store_subscriptions AS
  SELECT provider, subscription_id, actor_id, product_id, price_id, status, cancel_at_period_end,
         current_period_start, current_period_end, created_at, updated_at
    FROM monetization.polar_subscriptions;

CREATE OR REPLACE VIEW monetization.store_orders AS
  SELECT 'polar'::text AS provider, checkout_id, actor_id, product_id, price_id, amount_cents,
         currency, status, op_key, created_at, settled_at, refunded_at
    FROM monetization.polar_orders
  UNION ALL
  SELECT 'dodo'::text AS provider, checkout_id, actor_id, product_id, price_id, amount_cents,
         currency, status, op_key, created_at, settled_at, refunded_at
    FROM monetization.dodo_orders;

GRANT SELECT ON monetization.store_subscriptions TO core_runtime;
GRANT SELECT ON monetization.store_orders TO core_runtime;
GRANT SELECT ON monetization.store_subscriptions TO backup_reader;
GRANT SELECT ON monetization.store_orders TO backup_reader;
