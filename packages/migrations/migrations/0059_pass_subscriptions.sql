-- runner: current-role
-- B2 (2026-10-17) - the V5 recurring Mega Pass subscription ledger (owner annotations 1 and 7,
-- docs/p21-web/ANNOTATION-IMPLEMENTATION-PLAN-20261016.md). Additive, same authority pattern as
-- 0056/0057/0058: the API tier reaches it ONLY through the signed commerce ingress, the commerce
-- service writes it on the core_runtime pool, and no api_runtime/worker grant exists.
--
-- polar_subscriptions: one row per provider subscription. The actor binding is established from
-- the recorded polar_orders checkout (metadata.actor + product/price match) or the already-bound
-- row - never from metadata alone. status is the reconciled lifecycle: 'active' keeps access
-- until current_period_end (cancel_at_period_end only flags auto-renew-off), 'revoked' ends it.
--
-- pass_periods: one row per PAID billing period, created only from a verified paid order or a
-- provider-verified active period. installments_granted counts the canonical 50-Crown grants
-- (M.PASS.installments) delivered at period_start + 0/10/20 days, bounded by period_end.

CREATE TABLE IF NOT EXISTS monetization.polar_subscriptions (
  subscription_id TEXT NOT NULL CHECK (length(subscription_id) BETWEEN 1 AND 160),
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'canceled', 'revoked')),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT polar_subscriptions_pkey PRIMARY KEY (subscription_id),
  CONSTRAINT polar_subscriptions_product CHECK (product_id = 'mega_pass')
);

CREATE INDEX IF NOT EXISTS polar_subscriptions_actor_idx
  ON monetization.polar_subscriptions (actor_id, current_period_end DESC);

CREATE TABLE IF NOT EXISTS monetization.pass_periods (
  subscription_id TEXT NOT NULL REFERENCES monetization.polar_subscriptions (subscription_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  installments_granted SMALLINT NOT NULL DEFAULT 0 CHECK (installments_granted BETWEEN 0 AND 3),
  created_at timestamptz NOT NULL,
  CONSTRAINT pass_periods_pkey PRIMARY KEY (subscription_id, period_start),
  CONSTRAINT pass_periods_window CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS pass_periods_due_idx
  ON monetization.pass_periods (installments_granted) WHERE installments_granted < 3;

-- Core is the SOLE economic mutation authority (0015/0021 pattern). No DELETE: subscription and
-- period rows are permanent evidence. api_runtime gets nothing (signed ingress only); the worker
-- never receives wallet DML (grants run inside the commerce service's own transactions).
GRANT SELECT, INSERT, UPDATE ON monetization.polar_subscriptions TO core_runtime;
GRANT SELECT, INSERT, UPDATE ON monetization.pass_periods TO core_runtime;

-- The 0026 backup contract: explicit exact SELECT only (this migration runs as the management
-- identity, so the grants are stated here rather than inherited).
GRANT SELECT ON monetization.polar_subscriptions TO backup_reader;
GRANT SELECT ON monetization.pass_periods TO backup_reader;
