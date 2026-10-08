-- runner: current-role
-- V5 P02 (V5-02-03) - cluster roles for the authority schema.
-- Design inputs: local://v5-p02-schema-design.md sections 4, 7; specs/04 sections 3-5.
-- Guarded and idempotent so re-runs after a partial failure are safe. Cluster-wide roles are
-- created once per PostgreSQL cluster; subsequent databases skip the CREATE statements.
-- Trusted identities (no true superuser exists on Neon): a superuser (ephemeral synthetic
-- clusters only), the literal migration_owner LOGIN role, or a CREATEROLE role owning the
-- current database (the Neon initial managed role pattern: rolcreaterole + neon_superuser
-- membership + database ownership). neon_superuser is NEVER granted to any runtime role.
-- Membership rules: the five runtime identities receive NO membership of anything and can
-- never SET/cross into each other; the only read-only predefined membership in the system is
-- backup_reader -> pg_read_all_data (0023). migration_owner additionally needs direct ADMIN
-- OPTION on the five runtime roles so it can ALTER them for exact LOGIN provisioning even
-- when a different managed bootstrap principal created them (PG16 CREATEROLE alone does not
-- confer ALTER on roles created by others; ADMIN OPTION membership does).
-- [P-provider] The runtime roles stay NOLOGIN group roles by default: each environment
-- provisions the exact runtime role as LOGIN out-of-band with a secret-managed password
-- (Neon console / secret store) and connects AS that exact identity - never a shared admin
-- user, never SET ROLE between runtime identities. Test and synthetic CI harnesses may ALTER
-- these exact names to LOGIN for the disposable cluster; production keeps least privilege
-- with no password material ever appearing in a migration file.
DO $$
DECLARE
  r text;
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
     AND session_user <> 'migration_owner'
     AND NOT (COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user), false)
              AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = session_user) THEN
    RAISE EXCEPTION 'ROLE_BOOTSTRAP_REQUIRES_PRIVILEGED_RUNNER' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v5_owner') THEN
    -- Schema/table owner. NOLOGIN by design: no application may connect as the owner.
    CREATE ROLE v5_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migration_owner') THEN
    -- Trusted operator/CI migration runner only (direct TLS connection). CREATEROLE lets this
    -- role run the bootstrap above on fresh clusters that were not pre-provisioned by the owner.
    CREATE ROLE migration_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOBYPASSRLS;
  END IF;

  FOREACH r IN ARRAY ARRAY['api_runtime', 'core_runtime', 'worker_runtime', 'backup_reader', 'audit_runtime'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      -- NOLOGIN group identities provisioned to exact LOGIN principals out-of-band; NOINHERIT
      -- and zero memberships keep them incapable of acting as one another.
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
    END IF;
    -- migration_owner needs direct ADMIN OPTION for ALTER provisioning of each runtime role,
    -- no matter which trusted bootstrap principal created it. ADMIN OPTION grants here are
    -- management-only: they confer no table privileges and no ability to SET ROLE across
    -- runtime identities at application time (the guard asserts current_user =
    -- session_user = the exact runtime role; membership rows are invisible to login checks).
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members
                    WHERE roleid = r::regrole AND member = 'migration_owner'::regrole
                      AND admin_option) THEN
      EXECUTE format('GRANT %I TO migration_owner WITH ADMIN OPTION', r);
    END IF;
  END LOOP;

  -- The runner's tool-managed ledger bootstrap ran as THIS session just before file 0001, so
  -- this session owns schema meta/meta.migrations on a brand-new cluster; give migration_owner
  -- its ledger rights before the first history row is inserted (0003 re-normalizes them).
  IF to_regclass('meta.migrations') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA meta TO migration_owner;
    GRANT SELECT, INSERT ON meta.migrations TO migration_owner;
  END IF;

  -- DDL is performed inside migration transactions by SET ROLE v5_owner; only migration_owner
  -- (or the trusted provider bootstrap identity owning this database) may hold that membership.
  -- PG16 ground truth (verified on 16.15): a non-superuser CREATEROLE role that CREATEs a role
  -- receives ADMIN TRUE / INHERIT FALSE / SET FALSE membership, so a plain MEMBER check can be
  -- true while SET ROLE stays denied; the capability that matters is the SET option.
  IF NOT pg_has_role('migration_owner', 'v5_owner', 'SET') THEN
    GRANT v5_owner TO migration_owner WITH INHERIT TRUE, SET TRUE;
  END IF;

  -- A trusted provider bootstrap identity whose LOGIN name is neither migration_owner nor a
  -- superuser (the Neon initial managed role pattern) takes SET-capable membership in exactly
  -- these two management roles: v5_owner for the migration-transaction SET ROLE and
  -- migration_owner for the ledger insert.
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
     AND session_user <> 'migration_owner' THEN
    IF NOT pg_has_role(session_user, 'v5_owner', 'SET') THEN
      GRANT v5_owner TO session_user WITH INHERIT TRUE, SET TRUE;
    END IF;
    IF NOT pg_has_role(session_user, 'migration_owner', 'SET') THEN
      GRANT migration_owner TO session_user WITH INHERIT TRUE, SET TRUE;
    END IF;
  END IF;
END
$$;
