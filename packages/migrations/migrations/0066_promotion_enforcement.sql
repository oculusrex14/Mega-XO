-- runner: current-role
-- Prospective allocation starts when this release's schema is installed. No historic orders
-- consume it. Publication/acceptance are separate evidence, NEVER inferred from a checkout.
CREATE TABLE monetization.promotion_policies (
  policy_version TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  cap INTEGER NOT NULL CHECK (cap = 22000),
  published_at timestamptz,
  rule_hash TEXT CHECK (rule_hash ~ '^[0-9a-f]{64}$')
);
INSERT INTO monetization.promotion_policies
  (policy_version, campaign_id, effective_at, expires_at, cap)
  VALUES ('promotion-allocation-v1', 'launch', clock_timestamp(), '2026-12-31T18:29:59Z', 22000);

CREATE TABLE monetization.promotion_acceptances (
  actor_id TEXT NOT NULL REFERENCES identity.actors(actor_id),
  policy_version TEXT NOT NULL REFERENCES monetization.promotion_policies(policy_version),
  acceptance_hash TEXT NOT NULL CHECK (acceptance_hash ~ '^[0-9a-f]{64}$'),
  rule_hash TEXT NOT NULL CHECK (rule_hash ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL,
  disclosed_remaining INTEGER NOT NULL CHECK (disclosed_remaining BETWEEN 0 AND 22000),
  PRIMARY KEY (actor_id, policy_version, acceptance_hash)
);
-- Each reservation is permanent allocation. Even FAILED/UNKNOWN/refunded orders never free
-- capacity automatically: non-creation reconciliation is an operator review, not a fresh budget.
CREATE TABLE monetization.promotion_allocations (
  allocation_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES identity.actors(actor_id),
  policy_version TEXT NOT NULL REFERENCES monetization.promotion_policies(policy_version),
  provider TEXT NOT NULL CHECK (provider IN ('cashfree','polar','dodo','apple','google')),
  op_key TEXT NOT NULL,
  product_id TEXT NOT NULL,
  crowns INTEGER NOT NULL CHECK (crowns > 0 AND crowns <= 22000),
  reserved_at timestamptz NOT NULL,
  acceptance_hash TEXT,
  UNIQUE(actor_id, op_key)
);
CREATE INDEX promotion_allocations_actor_idx ON monetization.promotion_allocations(actor_id);
CREATE TABLE monetization.promotion_lots (
  grant_id TEXT PRIMARY KEY REFERENCES economy.ledger(entry_id) DEFERRABLE INITIALLY DEFERRED,
  allocation_id TEXT NOT NULL UNIQUE REFERENCES monetization.promotion_allocations(allocation_id),
  actor_id TEXT NOT NULL REFERENCES identity.actors(actor_id),
  held_crowns BIGINT NOT NULL CHECK (held_crowns >= 0),
  held_coins BIGINT NOT NULL CHECK (held_coins >= 0),
  credited_at timestamptz NOT NULL
);
-- Append-only evidence/cases and outcomes. A case packet contains immutable frozen evidence;
-- later notice/decision/appeal versions are new records, never edits to the old packet.
CREATE TABLE monetization.promotion_cases (
  case_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES identity.actors(actor_id),
  policy_version TEXT NOT NULL REFERENCES monetization.promotion_policies(policy_version),
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  packet JSONB NOT NULL CHECK (jsonb_typeof(packet) = 'object'),
  recorded_by TEXT NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE TABLE monetization.promotion_events (
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES monetization.promotion_cases(case_id),
  actor_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response JSONB NOT NULL,
  outbox_id TEXT NOT NULL UNIQUE,
  operator_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE monetization.promotion_case_approvals (
  case_id TEXT NOT NULL REFERENCES monetization.promotion_cases(case_id),
  reviewer_id TEXT NOT NULL,
  decision_reference TEXT NOT NULL,
  amounts_hash TEXT NOT NULL,
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, reviewer_id)
);
GRANT SELECT ON monetization.promotion_policies TO core_runtime;
GRANT SELECT, INSERT ON monetization.promotion_acceptances, monetization.promotion_allocations,
  monetization.promotion_cases, monetization.promotion_events,
  monetization.promotion_case_approvals TO core_runtime;
GRANT SELECT, INSERT, UPDATE ON monetization.promotion_lots TO core_runtime;
GRANT SELECT ON monetization.promotion_policies, monetization.promotion_acceptances,
  monetization.promotion_allocations, monetization.promotion_lots,
  monetization.promotion_cases, monetization.promotion_events,
  monetization.promotion_case_approvals TO backup_reader;
-- Audit delivery reads only immutable enforcement events, on its OWN pool. Core has no audit grant.
GRANT USAGE ON SCHEMA monetization TO audit_runtime;
GRANT SELECT ON monetization.promotion_events TO audit_runtime;
