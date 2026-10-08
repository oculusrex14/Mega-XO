-- runner: current-role
-- 0036: v5_migration bookkeeping namespace for the P03 deterministic import.
--
-- Run by the privileged runner role exactly like 0002 (superuser in the ephemeral CI container,
-- migration_owner - the database owner - in provisioned environments), because CREATE SCHEMA
-- needs database CREATE rights that the NOLOGIN v5_owner role is never given. migration_owner
-- additionally receives USAGE here for the P03 import path, which connects as that trusted
-- runner on a direct TLS connection and assumes v5_owner per transaction; the five runtime
-- identities get nothing at all, so no serving code path can read or write import bookkeeping.
--
-- Design: docs/v5/designs/p03-extraction-design.md section 3.5 (run/target_guard/batch/row_ledger/
-- operation_outcome/coverage/difference). The importer, the reconciler and the resume driver all
-- bind to this one schema, so it is created by the checksummed chain exactly like every other
-- schema: runtime roles hold no DDL and no write grant here, and only the trusted direct
-- migration/admin connection (SET ROLE v5_owner) populates it.
--
-- Scope rules carried from the phase contract and spec 01 section 2:
--   * An unknown target is REFUSED, never implicitly created (target_guard has no default row).
--   * A reused run id with a different source fingerprint or extractor release is refused.
--   * Batching is deterministic (canonical key order, cursor = last committed key) so a resumed
--     run re-derives exactly the same row set; every batch commits its own transaction.
--   * Nothing outside what a run created may be truncated or dropped (no blanket destructive op).
--
-- Type notes: the identifiers/keys are the SOURCE's own text ids (never uuid); hashes are the
-- canonical sha256 hex the extractor already produces; timestamps are timestamptz so the
-- captured epoch milliseconds convert exactly with no local-time drift; counters are BIGINT
-- because a run can legitimately touch more rows than int4.

CREATE SCHEMA IF NOT EXISTS v5_migration AUTHORIZATION v5_owner;
ALTER SCHEMA v5_migration OWNER TO v5_owner;
REVOKE ALL ON SCHEMA v5_migration FROM PUBLIC;
-- The trusted import path connects as the migration runner and assumes v5_owner inside each
-- transaction; USAGE here is what lets a resumed run reach the ledger it wrote, and nothing
-- more. Runtime identities are deliberately not granted anything on this schema.
GRANT USAGE ON SCHEMA v5_migration TO migration_owner;

-- One row per import run. `source_fingerprint` is the extractor's own binding (reader version,
-- capture clock, snapshot file hash, schema head, eight state-root hashes and 35 table roots) and
-- `extractor_release` binds the mapping/codec/reconciliation rules; together they are the run
-- identity. A run can only be `running`->`committed`|`failed`; the lease makes a crashed run
-- visibly stale instead of silently concurrent.
CREATE TABLE IF NOT EXISTS v5_migration.run (
  run_id TEXT PRIMARY KEY,
  source_fingerprint CHAR(64) NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  extractor_release CHAR(64) NOT NULL CHECK (extractor_release ~ '^[0-9a-f]{64}$'),
  source_release_sha TEXT,
  target_environment TEXT NOT NULL,
  target_database TEXT NOT NULL,
  target_system_identifier TEXT,
  schema_head INTEGER NOT NULL CHECK (schema_head >= 1),
  capture_clock_ms BIGINT NOT NULL CHECK (capture_clock_ms > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'committed', 'failed', 'aborted')),
  lock_token TEXT,
  lease_until timestamptz,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  counters JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_code TEXT,
  failure_detail TEXT,
  CONSTRAINT run_counters_object_ck CHECK (jsonb_typeof(counters) = 'object')
);
CREATE INDEX IF NOT EXISTS run_status_started_idx ON v5_migration.run (status, started_at DESC);
CREATE INDEX IF NOT EXISTS run_fingerprint_idx ON v5_migration.run (source_fingerprint);

-- The declared, adopted target. There is deliberately NO default row: absence is a refusal, not
-- an implicit "create". `adopted_existing_tables` records exactly which pre-existing tables the
-- run was authorised to write, so a later destructive step can be bounded to them.
CREATE TABLE IF NOT EXISTS v5_migration.target_guard (
  target_system_id TEXT PRIMARY KEY,
  target_environment TEXT NOT NULL,
  target_database TEXT NOT NULL,
  schema_head INTEGER NOT NULL CHECK (schema_head >= 1),
  created_by_run TEXT NOT NULL REFERENCES v5_migration.run (run_id) ON DELETE RESTRICT,
  adopted_existing_tables TEXT[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- One row per (run, kind, ordinal). `definition_hash` binds the kind's projection definition
-- (source locator, filter, canonical order, batch size) so a re-run with a changed definition is
-- detectable rather than silently different. `cursor` is the last committed canonical key, never
-- an offset, which is what makes a resume re-derive the identical row set.
CREATE TABLE IF NOT EXISTS v5_migration.batch (
  run_id TEXT NOT NULL REFERENCES v5_migration.run (run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  definition_hash CHAR(64) NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  cursor TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'committed', 'failed')),
  committed_row_hash CHAR(64),
  rows_written BIGINT NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (run_id, ordinal),
  CONSTRAINT batch_kind_ordinal_key UNIQUE (run_id, kind, ordinal)
);
CREATE INDEX IF NOT EXISTS batch_run_status_idx ON v5_migration.batch (run_id, status, ordinal);

-- Per-row idempotency ledger. `source_locator` is the structured canonical locator of the SOURCE
-- record (kind + stable source key), and `target_pk_hash` is the canonical hash of the target
-- primary key it produced, so a resumed run can verify a previously committed row byte-for-byte
-- and refuse to overwrite a mismatch instead of silently re-writing it.
CREATE TABLE IF NOT EXISTS v5_migration.row_ledger (
  run_id TEXT NOT NULL REFERENCES v5_migration.run (run_id) ON DELETE CASCADE,
  source_locator TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_pk_hash CHAR(64) NOT NULL CHECK (target_pk_hash ~ '^[0-9a-f]{64}$'),
  row_hash CHAR(64) NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  batch_ordinal INTEGER NOT NULL,
  written_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, source_locator, target_table)
);
CREATE INDEX IF NOT EXISTS row_ledger_batch_idx ON v5_migration.row_ledger (run_id, batch_ordinal);
CREATE INDEX IF NOT EXISTS row_ledger_target_idx ON v5_migration.row_ledger (run_id, target_table);

-- Stored command/operation outcomes per family: the source's own idempotency domain, its
-- fingerprint text and its response, preserved verbatim. `replay_semantics` records what a
-- future replay may return (the party family returns the CURRENT room view, which is a real
-- source behaviour and must not be mistaken for a stored snapshot of the old one).
CREATE TABLE IF NOT EXISTS v5_migration.operation_outcome (
  run_id TEXT NOT NULL REFERENCES v5_migration.run (run_id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  op_key TEXT NOT NULL,
  actor_id TEXT,
  fingerprint TEXT NOT NULL,
  response_hash CHAR(64) NOT NULL CHECK (response_hash ~ '^[0-9a-f]{64}$'),
  response_bytes BIGINT NOT NULL CHECK (response_bytes >= 0),
  replay_class TEXT NOT NULL,
  replay_semantics TEXT,
  PRIMARY KEY (run_id, family, op_key)
);
CREATE INDEX IF NOT EXISTS operation_outcome_actor_idx ON v5_migration.operation_outcome (run_id, family, actor_id);

-- Coverage: every source locator the run saw, with its classification and the rule that justified
-- it. An unclassified locator is recorded, never dropped; the run refuses to commit while any
-- unclassified row lacks an explicit accepted rule.
CREATE TABLE IF NOT EXISTS v5_migration.coverage (
  run_id TEXT NOT NULL REFERENCES v5_migration.run (run_id) ON DELETE CASCADE,
  locator_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  classification TEXT NOT NULL,
  rule_id TEXT,
  note TEXT,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, locator_kind, name, key)
);
CREATE INDEX IF NOT EXISTS coverage_class_idx ON v5_migration.coverage (run_id, classification);

-- Differences: one row per compared field that is not an exact match. `category` is either the
-- literal 'unexplained' or an explained category with the `rule_id` that justifies it; the gate is
-- zero 'unexplained' rows. Hashes, never raw values, so this table is safe to keep and report.
CREATE TABLE IF NOT EXISTS v5_migration.difference (
  run_id TEXT NOT NULL REFERENCES v5_migration.run (run_id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  actor_hash CHAR(64),
  locator TEXT NOT NULL,
  field_path TEXT NOT NULL,
  expected_hash CHAR(64),
  actual_hash CHAR(64),
  rule_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('unexplained', 'explained', 'informational')),
  detail TEXT,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, locator, field_path, category)
);
CREATE INDEX IF NOT EXISTS difference_severity_idx ON v5_migration.difference (run_id, severity);
