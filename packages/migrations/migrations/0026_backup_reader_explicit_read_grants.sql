-- runner: current-role
-- V5 P02 forward-only 0026 - stock pg_dump contract for backup_reader via EXPLICIT read-only
-- grants (parent ruling 2026-10-08). 0001-0025 are final/applied-pending; nothing earlier is
-- rewritten. No TEMPORARY or any other DDL-shaped privilege is restored anywhere.
--
-- Rationale: pg_dump issues LOCK TABLE ... IN ACCESS SHARE MODE on every dumped relation and
-- SELECTs sequence values. The predefined pg_read_all_data membership was never proven
-- sufficient for that lock-permission probe (one observed LOCK denial; whether an INHERIT-FALSE
-- membership tuple caused it is documented as unresolved), so the backup path now rests on
-- explicit, exact, unconditional privileges that pass regardless of how the provider handled
-- 0023's guarded predefined grant:
--   * USAGE on every V5 schema (incl. meta for ledger dumps);
--   * SELECT on ALL TABLES and ALL SEQUENCES in every V5 schema (existing objects);
--   * ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner so every FUTURE table/sequence is SELECTable
--     by backup_reader without another grant step (v5_owner owns all objects; the runner's
--     SET LOCAL ROLE v5_owner keeps that identity true);
--   * retirement of the now-obsolete pg_read_all_data membership when present: the REVOKE is
--     not silently skipped - if the membership row exists and this session cannot revoke it,
--     the step fails closed with BACKUP_PREDEFINED_MEMBERSHIP_REVOCATION_REQUIRES_ADMIN so the
--     broader active grant is never left unaccounted. When the membership is absent (the usual
--     Neon outcome where 0023 already fell back), no predefined-role ADMIN is required at all.
-- backup_reader remains NOLOGIN-in-chain, NOINHERIT, zero other memberships, zero write, zero
-- DDL: SELECT/USAGE only.
DO $$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
     AND session_user <> 'migration_owner'
     AND NOT (COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user), false)
              AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = session_user) THEN
    RAISE EXCEPTION 'BACKUP_GRANTS_REQUIRE_TRUSTED_RUNNER' USING ERRCODE = '42501';
  END IF;
END
$$;

DO $$
DECLARE
  s text;
  schemas text[] := ARRAY[
    'meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
    'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'
  ];
BEGIN
  FOREACH s IN ARRAY schemas LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO backup_reader', s);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO backup_reader', s);
    EXECUTE format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA %I TO backup_reader', s);
    -- Future-object coverage; idempotent. Requires membership in v5_owner (migration_owner and
    -- the provider bootstrap identity hold it; superusers bypass).
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA %I GRANT SELECT ON TABLES TO backup_reader', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA %I GRANT SELECT ON SEQUENCES TO backup_reader', s);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_auth_members
              WHERE roleid = 'pg_read_all_data'::regrole
                AND member = 'backup_reader'::regrole) THEN
    BEGIN
      REVOKE pg_read_all_data FROM backup_reader;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'BACKUP_PREDEFINED_MEMBERSHIP_REVOCATION_REQUIRES_ADMIN'
        USING ERRCODE = '42501',
              HINT = 'pg_read_all_data membership is obsolete under the explicit-grant contract; run 0026 as an identity that can revoke the membership (superuser, or a CREATEROLE migrator per PG16), or revoke it as its admin - never leave the broader grant silently active';
    END;
  END IF;
END
$$;
