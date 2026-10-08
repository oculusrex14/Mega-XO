-- V5 P02 (V5-02-02) - privacy records, support correlation and the audit chain (design sections
-- 2.10, 5.5). deletion_receipts/reports/requests keep soft actor references because deletion
-- rewrites actor ids to tombstone strings. Audit immutability is enforced by grants (append-only
-- through audit_runtime, 0023) PLUS the two BEFORE UPDATE/DELETE triggers that mirror the exact
-- source triggers (v41_operator_audit_no_update/_no_delete -> RAISE 'AUDIT_IMMUTABLE').
CREATE TABLE IF NOT EXISTS privacy.reports (
  report_id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('cheating', 'username', 'harassment', 'unsportsmanlike', 'other')),
  detail TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 280),
  created_at timestamptz NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'reviewed')),
  reviewed_at timestamptz,
  reviewed_by TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('no_action', 'action_taken', 'duplicate'))
);
CREATE INDEX IF NOT EXISTS reports_target_state_created_idx ON privacy.reports (target_id, state, created_at);
CREATE INDEX IF NOT EXISTS reports_reporter_created_idx ON privacy.reports (reporter_id, created_at);

CREATE TABLE IF NOT EXISTS privacy.requests (
  request_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'deletion'),
  state TEXT NOT NULL CHECK (state IN ('requested', 'verified', 'processing', 'completed', 'cancelled', 'failed')),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  policy_version TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS requests_actor_requested_idx ON privacy.requests (actor_id, requested_at);
CREATE INDEX IF NOT EXISTS requests_state_updated_idx ON privacy.requests (state, updated_at);

CREATE TABLE IF NOT EXISTS privacy.deletion_receipts (
  receipt_id TEXT PRIMARY KEY,
  actor_hash TEXT NOT NULL UNIQUE,
  tombstone TEXT NOT NULL UNIQUE,
  completed_at timestamptz NOT NULL,
  policy_version TEXT NOT NULL,
  retained JSONB NOT NULL,
  CONSTRAINT deletion_receipts_retained_array_ck CHECK (jsonb_typeof(retained) = 'array')
);

-- v41_support_events: sanitized diagnostic index; retention DELETE belongs to worker_runtime
-- only (0022).
CREATE TABLE IF NOT EXISTS support.events (
  event_id TEXT PRIMARY KEY,
  "at" timestamptz NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  code TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_at_idx ON support.events ("at");

CREATE TABLE IF NOT EXISTS audit.operator_audit (
  audit_id TEXT PRIMARY KEY,
  "at" timestamptz NOT NULL,
  operator TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash CHAR(64) NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash CHAR(64) NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS operator_audit_actor_at_idx ON audit.operator_audit (actor_id, "at");

-- Source-parity immutability triggers.
CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'AUDIT_IMMUTABLE';
END
$fn$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'operator_audit_no_update' AND tgrelid = 'audit.operator_audit'::regclass) THEN
    CREATE TRIGGER operator_audit_no_update BEFORE UPDATE ON audit.operator_audit
      FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'operator_audit_no_delete' AND tgrelid = 'audit.operator_audit'::regclass) THEN
    CREATE TRIGGER operator_audit_no_delete BEFORE DELETE ON audit.operator_audit
      FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
  END IF;
END
$$;
