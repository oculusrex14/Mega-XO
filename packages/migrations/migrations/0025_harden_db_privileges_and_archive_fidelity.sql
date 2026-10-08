-- runner: current-role
-- V5 P02 (V5-02-03 forward-only follow-up) - two parent-verified contract gaps, fixed additively.
-- Migrations 0001-0024 are FROZEN (applied on the real staging database); everything here is a
-- new step with its own checksum; the old 24 checksums never change.
--
-- (1) PostgreSQL grants PUBLIC CREATE + TEMPORARY on every database by default. A runtime
--     identity can therefore CREATE TEMP TABLE - a DDL-shaped capability the role model never
--     sanctioned ("runtime roles have no CREATE privilege", design section 4/7; parent
--     reproduction: SET ROLE api_runtime; CREATE TEMP TABLE succeeded). Revoke both from PUBLIC
--     and from the five runtime identities on THIS database. All FIVE runtime roles are thus
--     TEMP-denied, backup_reader included (parent ruling 2026-10-08: pg_dump needs no database
--     TEMPORARY and the architecture calls the backup path strictly read-only; the P15 real
--     dump/restore proof validates this posture). TEMPORARY headroom is re-granted only to the
--     trusted management identities migration_owner and v5_owner, never database CREATE.
--     Must run as the trusted
--     session (superuser, migration_owner, or the provider bootstrap identity) because REVOKE
--     ON DATABASE belongs to the database owner, not to v5_owner.
-- (2) profile.profile_saves admission is bound to the VERBATIM source bytes (payload_text);
--     the JSONB payload must remain semantically equal to those bytes or restore/read data can
--     silently diverge (parent reproduction: divergent payload accepted). Add a CHECK comparing
--     payload = payload_text::jsonb behind a valid-JSON guard so malformed source text is a
--     clean violation. Raw text and JSONB are both retained; no generated columns, no
--     destructive cutover, business timestamps stay as frozen.
DO $$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
     AND session_user <> 'migration_owner'
     AND NOT (COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user), false)
              AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = session_user) THEN
    RAISE EXCEPTION 'DB_PRIVILEGE_HARDENING_REQUIRES_TRUSTED_RUNNER' USING ERRCODE = '42501';
  END IF;
  IF NOT (COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
          OR pg_has_role(session_user,
                         (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),
                         'MEMBER')) THEN
    RAISE EXCEPTION 'DB_PRIVILEGE_HARDENING_REQUIRES_DATABASE_OWNER_MEMBERSHIP'
      USING ERRCODE = '42501',
            HINT = 'run this step as the database owner (or a member), or have the owner execute the two REVOKE statements for database ' || current_database();
  END IF;

  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM api_runtime, core_runtime, worker_runtime, backup_reader, audit_runtime', current_database());
  -- TEMPORARY headroom is preserved only for the trusted management identities that perform
  -- in-session scratch work (the migration runner and the schema owner). backup_reader stays
  -- strictly read-only: no CREATE/TEMPORARY here was required for logical dumps, and the
  -- parent P15 restore proof runs pg_dump/restore under this posture (design section 7:
  -- "backup reader cannot mutate"). Neither role gains database CREATE.
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO migration_owner, v5_owner', current_database());
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'profile_saves_payload_matches_text_ck'
                    AND conrelid = 'profile.profile_saves'::regclass) THEN
    ALTER TABLE profile.profile_saves
      ADD CONSTRAINT profile_saves_payload_matches_text_ck CHECK (
        CASE WHEN payload_text IS JSON
             THEN payload = payload_text::jsonb
             ELSE false END);
  END IF;
END
$$;
