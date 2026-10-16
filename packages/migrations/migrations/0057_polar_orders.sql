-- runner: current-role
-- C05 (2026-10-16) - the authoritative Polar order ledger (owner decision: Polar is the PRIMARY
-- GLOBAL payment provider and the INDIAN FALLBACK behind Cashfree).
--
-- The same additive contract as 0056: the API tier reaches it ONLY through the signed commerce
-- ingress (no api_runtime/worker_runtime grant), the commerce service writes it on the
-- core_runtime pool, and monetization.receipts keeps its ('google','apple') CHECK - a Polar
-- settlement is recorded HERE, never as an unsupported receipt kind.
--
-- checkout_id is Polar's checkout uuid (the recorded authority for settlement); polar_order_id
-- is optional and filled from the order.paid webhook so refund events (which carry order ids)
-- can route. amount_cents is the SERVER-AUTHORITATIVE catalog price (99/499/999/399 for the
-- recorded products); settlement compares it exactly against the independent provider
-- verification, never a client value.

CREATE TABLE IF NOT EXISTS monetization.polar_orders (
  checkout_id TEXT NOT NULL CHECK (checkout_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status TEXT NOT NULL CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'expired')),
  polar_order_id TEXT,
  op_key TEXT NOT NULL CHECK (op_key ~ '^[A-Za-z0-9:_-]{1,160}$'),
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  refunded_at timestamptz,
  CONSTRAINT polar_orders_pkey PRIMARY KEY (checkout_id),
  CONSTRAINT polar_orders_actor_op_key_key UNIQUE (actor_id, op_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS polar_orders_polar_order_id_key
  ON monetization.polar_orders (polar_order_id) WHERE polar_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS polar_orders_actor_created_idx
  ON monetization.polar_orders (actor_id, created_at DESC);

-- Core is the SOLE economic mutation authority (0015/0021 pattern). No DELETE: order rows are
-- permanent evidence like receipts. api_runtime gets nothing (signed ingress only); worker gets
-- nothing (Polar settlement is not a store_finalize sweep).
GRANT SELECT, INSERT, UPDATE ON monetization.polar_orders TO core_runtime;

-- The 0026 default privileges fire only for v5_owner-created tables; this migration runs as the
-- management identity, so the backup contract (0026: explicit exact SELECT only) is granted here.
GRANT SELECT ON monetization.polar_orders TO backup_reader;
