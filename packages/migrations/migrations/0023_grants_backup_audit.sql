-- runner: current-role
-- V5 P02 (V5-02-03) - backup_reader and audit_runtime (design section 7).
-- backup_reader: full read for logical dumps, zero mutation, zero DDL. [P provider-pending]
-- implemented via the pg_read_all_data predefined role when available (PG16: available; the
-- V5-02-01 read-only inventory confirms on the live target), with the explicit SELECT grant
-- loop as the boring fallback - both are guarded so either topology migrates cleanly. Schema
-- USAGE is granted either way because pg_read_all_data does not bypass namespace permissions.
-- audit_runtime: INSERT + SELECT on audit.operator_audit ONLY (append function computes
-- prev_hash/entry_hash from the current tail); UPDATE/DELETE are denied by the absence of any
-- grant, by the trigger pair in 0017, and by the absence of UPDATE/DELETE columns grants here.
DO $$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
     AND session_user <> 'migration_owner'
     AND NOT (COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user), false)
              AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = session_user) THEN
    RAISE EXCEPTION 'GRANTS_REQUIRE_MIGRATION_OWNER' USING ERRCODE = '42501';
  END IF;
END
$$;

DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
    'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'
  ] LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO backup_reader', s);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_read_all_data') THEN
    BEGIN
      GRANT pg_read_all_data TO backup_reader;
    EXCEPTION WHEN insufficient_privilege THEN
      -- A CREATEROLE bootstrap identity may not be allowed to grant predefined system roles;
      -- fall back to the explicit SELECT loop so backup dumps work on every topology.
      FOREACH s IN ARRAY ARRAY[
        'meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
        'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'
      ] LOOP
        EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO backup_reader', s);
      END LOOP;
    END;
  ELSE
    FOREACH s IN ARRAY ARRAY[
      'meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
      'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'
    ] LOOP
      EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO backup_reader', s);
    END LOOP;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA audit TO audit_runtime;

GRANT INSERT, SELECT ON audit.operator_audit TO audit_runtime;
