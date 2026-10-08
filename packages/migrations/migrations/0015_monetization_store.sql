-- V5 P02 (V5-02-02) - store/receipt permanence tables (design sections 2.4, 2.10, 5.5).
-- receipts, store_bindings, store_revocations and notifications are PERMANENT: runtime roles get
-- no DELETE (0020-0023), the deletion workflow rewrites actor_id to a tombstone exactly like V4,
-- so receipt.actor_id stays a soft TEXT reference. Import writes every revocation row even when
-- no matching receipt exists.
-- P08-P10 core/worker integration (ARCHITECTURE persistence point 5):
--  * store_finalize keeps the V4 pending/done machine and adds a TERMINAL 'abandoned' state with
--    lease_owner/lease_token fencing. The V4 worker DELETE-on-abandon is replaced by the
--    pending->abandoned UPDATE transition, so worker_runtime never needs DELETE here (the
--    revocation/notification tombstone rows survive; no broadened grants).
--  * store_notifications is a durable provider-notification dedupe state machine
--    (pending -> processing -> applied | retry), not just a receipt marker: claim takes the
--    fenced lease (owner + monotonic token + expiry), redelivery replays via the PK, and a stale
--    worker cannot mark applied after a newer claim advanced the lease token.
CREATE TABLE IF NOT EXISTS monetization.receipts (
  store TEXT NOT NULL CHECK (store IN ('google', 'apple')),
  transaction_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  crowns BIGINT NOT NULL DEFAULT 0 CHECK (crowns >= 0 AND crowns <= 9007199254740991),
  refunded boolean NOT NULL DEFAULT false,
  purchased_at timestamptz NOT NULL,
  PRIMARY KEY (store, transaction_id)
);
CREATE INDEX IF NOT EXISTS receipts_actor_purchased_idx ON monetization.receipts (actor_id, purchased_at DESC);
CREATE INDEX IF NOT EXISTS receipts_store_refunded_idx ON monetization.receipts (store, refunded);

CREATE TABLE IF NOT EXISTS monetization.store_bindings (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  google_id TEXT NOT NULL UNIQUE,
  apple_token TEXT NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS monetization.store_revocations (
  store TEXT NOT NULL CHECK (store IN ('google', 'apple')),
  transaction_id TEXT NOT NULL,
  product_id TEXT,
  occurred_at timestamptz NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (store, transaction_id)
);

CREATE TABLE IF NOT EXISTS monetization.store_finalize (
  store TEXT NOT NULL CHECK (store = 'google'),
  transaction_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  purchase_token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('consume', 'acknowledge')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  lease_owner TEXT,
  lease_token BIGINT CHECK (lease_token IS NULL OR lease_token >= 0),
  lease_until timestamptz,
  CONSTRAINT store_finalize_lease_tuple_ck CHECK (
    CASE WHEN lease_owner IS NULL THEN lease_token IS NULL AND lease_until IS NULL
         ELSE lease_token IS NOT NULL AND lease_until IS NOT NULL END)
);
CREATE INDEX IF NOT EXISTS store_finalize_state_next_idx ON monetization.store_finalize (state, next_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS monetization.store_notifications (
  store TEXT NOT NULL CHECK (store IN ('google', 'apple')),
  notification_id TEXT NOT NULL,
  received_at timestamptz NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'applied', 'retry')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at timestamptz NOT NULL,
  processed_at timestamptz,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 280),
  lease_owner TEXT,
  lease_token BIGINT CHECK (lease_token IS NULL OR lease_token >= 0),
  lease_until timestamptz,
  PRIMARY KEY (store, notification_id),
  CONSTRAINT store_notifications_processed_ck CHECK (
    (state = 'applied' AND processed_at IS NOT NULL) OR state <> 'applied'),
  CONSTRAINT store_notifications_lease_tuple_ck CHECK (
    CASE WHEN lease_owner IS NULL THEN lease_token IS NULL AND lease_until IS NULL
         ELSE lease_token IS NOT NULL AND lease_until IS NOT NULL END)
);
CREATE INDEX IF NOT EXISTS store_notifications_state_next_idx ON monetization.store_notifications (state, next_at) WHERE state IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS store_notifications_stale_lease_idx ON monetization.store_notifications (lease_until) WHERE state = 'processing';
