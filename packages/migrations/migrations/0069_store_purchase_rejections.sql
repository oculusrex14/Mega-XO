-- runner: current-role
-- Sol re-review N7 (2026-10-20): a paid purchase the promotion guard refuses is charged but
-- ungranted. The refusal is recorded durably (own transaction, the economic one rolls back)
-- so the charge is always reconcilable: the provider purchase is deliberately never
-- acknowledged/consumed, the store's unacknowledged-purchase refund is the documented
-- backstop, and the operator resolves rows once the refund/revocation is confirmed:
--   SELECT * FROM monetization.store_purchase_rejections WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS monetization.store_purchase_rejections (
  id BIGSERIAL PRIMARY KEY,
  store TEXT NOT NULL CHECK (store IN ('google', 'apple')),
  transaction_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('PROMOTION_RESERVATION_REQUIRED', 'PROMOTION_RESERVATION_MISMATCH')),
  refused_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (store, transaction_id)
);
CREATE INDEX IF NOT EXISTS store_purchase_rejections_open_idx
  ON monetization.store_purchase_rejections (refused_at) WHERE resolved_at IS NULL;
-- Role grants (Sol CI run 39381820229: the backup contract requires backup_reader SELECT on
-- every monetization sequence; Core records refusals, the worker reconciles resolved rows).
GRANT SELECT ON monetization.store_purchase_rejections TO backup_reader;
GRANT USAGE, SELECT ON SEQUENCE monetization.store_purchase_rejections_id_seq TO backup_reader;
GRANT INSERT ON monetization.store_purchase_rejections TO core_runtime;
GRANT USAGE, SELECT ON SEQUENCE monetization.store_purchase_rejections_id_seq TO core_runtime;
GRANT SELECT ON monetization.store_purchase_rejections TO worker_runtime;
GRANT UPDATE (resolved_at) ON monetization.store_purchase_rejections TO worker_runtime;
