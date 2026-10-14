-- runner: current-role
-- V5 P02 forward-only 0051 - backup_reader schema reachability for the capture dependencies.
--
-- Real defect found by running the stock-pg_dump contract as backup_reader against the
-- production database: the gameplay-capture schema `learning` (created by 0044) is referenced by
-- CONSTRAINT TRIGGERs on match.matches, tournament.fixtures, tournament.rooms and
-- privacy.requests, so a full-database pg_dump must resolve the schema - but backup_reader has no
-- USAGE on it, so the dump aborts with "permission denied for schema learning".
--
-- Granting table SELECT would expose private capture rows to the backup role, which is exactly
-- what 0044 exists to prevent. This migration therefore grants USAGE ON SCHEMA learning ONLY and
-- nothing else: no table, sequence, function, type or default-privilege grant is made there.
-- After this, `SELECT ... FROM learning.captures`, learning.capture_subjects, learning.policy,
-- learning.suppressions and every other capture relation still fail with
-- "permission denied for table ...", while pg_dump can resolve the trigger surface. The disaster
-- recovery dump additionally excludes all learning table DATA (backup-cli.js
-- `--exclude-table-data=learning.*`).
--
-- No write, no DDL right, no change to any existing grant and no change to any other role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
    RAISE EXCEPTION 'BACKUP_READER_ROLE_MISSING' USING ERRCODE = '42704';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'learning') THEN
    GRANT USAGE ON SCHEMA learning TO backup_reader;
  END IF;
END
$$;
