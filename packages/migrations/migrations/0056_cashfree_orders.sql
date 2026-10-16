-- runner: current-role
-- LR13 (2026-10-16) - the authoritative Cashfree order ledger (owner brief C04).
--
-- The merged Cashfree web checkout (PR 19) records orders in the legacy V4 SQLite lane
-- (server/monetization-store.js v52_cashfree_orders). The V5 contract is this Core-owned
-- additive table: the API tier reaches it ONLY through the signed commerce ingress (it gets no
-- grant at all, exactly like every other monetization table), the commerce service writes it on
-- the core_runtime pool, and the receipt-kind CHECK on monetization.receipts stays
-- ('google','apple') UNCHANGED - a Cashfree settlement is recorded HERE, never as an unsupported
-- receipt kind (the recorded finding in the owner brief).
--
-- Permanence mirrors receipts/store_revocations (0015): no runtime role gets DELETE. A refund is
-- the refunded_at terminal marker plus the entitlement projection reading it, never a row delete.
-- backup_reader inherits SELECT through the 0026 default privileges (this migration runs as the
-- v5_owner/migration_owner management identity).
--
-- amount is NUMERIC rupees (Cashfree order_amount is a decimal rupee string, e.g. 89.00); the
-- settlement comparison is exact against the recorded catalog price, never a client value.

CREATE TABLE IF NOT EXISTS monetization.cashfree_orders (
  order_id TEXT NOT NULL CHECK (order_id ~ '^cfmx[0-9a-f]{24}$'),
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAID', 'EXPIRED', 'TERMINATED', 'CANCELLED')),
  session_id TEXT,
  op_key TEXT NOT NULL CHECK (op_key ~ '^[A-Za-z0-9:_-]{1,160}$'),
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  refunded_at timestamptz,
  CONSTRAINT cashfree_orders_pkey PRIMARY KEY (order_id),
  CONSTRAINT cashfree_orders_actor_op_key_key UNIQUE (actor_id, op_key)
);

CREATE INDEX IF NOT EXISTS cashfree_orders_actor_created_idx
  ON monetization.cashfree_orders (actor_id, created_at DESC);

-- Core is the SOLE economic mutation authority (0015/0021 pattern). No DELETE: order rows are
-- permanent evidence like receipts. api_runtime gets nothing (the API reaches commerce only
-- through the signed ingress); worker_runtime gets nothing (Cashfree settlement is not a
-- store_finalize sweep - it happens inside the commerce service under the receipt mutex family).
GRANT SELECT, INSERT, UPDATE ON monetization.cashfree_orders TO core_runtime;

-- The 0026 default privileges fire only for v5_owner-created tables; this migration runs as the
-- management identity, so the backup contract (0026: explicit exact SELECT only) is granted here.
GRANT SELECT ON monetization.cashfree_orders TO backup_reader;
