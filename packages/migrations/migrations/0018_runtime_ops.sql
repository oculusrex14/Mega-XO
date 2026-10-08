-- V5 P02 (V5-02-02) - operational controls, durable rate budgets and the mail/job outbox
-- (design sections 2.10, 3.3, 5.4, R12). community_limits and v4_limits merge into
-- ops.rate_buckets: 'mail-budget:*' rows are DURABLE spend records, never disposable cache
-- (R12), which is why they stay in PostgreSQL until managed Redis owns the rest (P06).
-- outbox gains the V5 lease fences (lease_owner/lease_token, design 2.10 [D]); the sealed
-- payload is NULLed after send/expire, and CHECK (payload IS NULL OR state IN
-- ('queued','sending')) makes that transition structural (source mail-outbox.js semantics).
CREATE TABLE IF NOT EXISTS runtime.controls (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  maintenance boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime.state (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL
);

-- expires_at NULL models community_limits' non-expiring rows (design 2.10).
CREATE TABLE IF NOT EXISTS ops.rate_buckets (
  bucket_id TEXT PRIMARY KEY,
  hits BIGINT NOT NULL CHECK (hits >= 0),
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS rate_buckets_expires_idx ON ops.rate_buckets (expires_at);

CREATE TABLE IF NOT EXISTS ops.outbox (
  outbox_id TEXT PRIMARY KEY,
  payload TEXT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  next_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_token BIGINT,
  CONSTRAINT outbox_sealed_payload_ck CHECK (payload IS NULL OR state IN ('queued', 'sending'))
);
CREATE INDEX IF NOT EXISTS outbox_state_next_idx ON ops.outbox (state, next_at);
