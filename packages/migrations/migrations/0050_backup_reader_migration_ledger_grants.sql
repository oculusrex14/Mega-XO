-- runner: current-role
-- V5 P02 forward-only 0050 - backup_reader schema coverage for the migration ledger.
--
-- Defect: 0026 grants backup_reader USAGE/SELECT across an ENUMERATED schema list
-- (meta, identity, profile, social, economy, core, match, tournament, monetization,
-- cosmetics, season, privacy, audit, support, runtime, ops). The v5_migration ledger
-- schema (created with the importer) is not in that list, so a stock `pg_dump` as
-- backup_reader fails with "permission denied for schema v5_migration" - the documented
-- stock-pg_dump contract for the backup role cannot actually run.
--
-- This forward fix grants exactly the same read-only contract for v5_migration and
-- nothing else: USAGE on the schema plus SELECT on its current tables/sequences. The
-- default-privilege statements that would cover FUTURE objects are applied only when the
-- runner can legitimately act for the owning role (mirrors 0026's conditional), because
-- ALTER DEFAULT PRIVILEGES FOR ROLE needs membership in that role. No write, no DDL right,
-- no change to any existing grant and no change to any other role.
--
-- The private learning.* capture tables remain deliberately unreachable: this migration
-- never mentions the learning schema.
DO $$
DECLARE
  owner_capable boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'v5_migration') THEN
    RAISE EXCEPTION 'V5_MIGRATION_LEDGER_MISSING' USING ERRCODE = '42P01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
    RAISE EXCEPTION 'BACKUP_READER_ROLE_MISSING' USING ERRCODE = '42704';
  END IF;

  GRANT USAGE ON SCHEMA v5_migration TO backup_reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA v5_migration TO backup_reader;
  GRANT SELECT ON ALL SEQUENCES IN SCHEMA v5_migration TO backup_reader;

  -- Only the owning identity (or a superuser) may set default privileges for v5_owner.
  SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER)
      OR pg_has_role(CURRENT_USER, 'v5_owner', 'MEMBER')
      OR CURRENT_USER = 'v5_owner'
    INTO owner_capable;
  IF owner_capable THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA v5_migration '
         || 'GRANT SELECT ON TABLES TO backup_reader';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA v5_migration '
         || 'GRANT SELECT ON SEQUENCES TO backup_reader';
  END IF;
END
$$;
