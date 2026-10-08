-- runner: current-role
-- V5 P02 (V5-02-02) - the 16 authority schemas, owned by v5_owner (design section 1.1).
-- Run by the privileged runner role (superuser in an ephemeral container, migration_owner in
-- provisioned environments) because CREATE SCHEMA ... AUTHORIZATION v5_owner needs database
-- CREATE rights the NOLOGIN owner role is never given. PUBLIC gets nothing; migration_owner
-- receives USAGE for the ledger insert and the P03 import path.
DO $$
DECLARE
  s text;
  own text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
    'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'
  ] LOOP
    own := (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = s);
    IF own IS NULL THEN
      EXECUTE format('CREATE SCHEMA %I AUTHORIZATION v5_owner', s);
    ELSIF own <> 'v5_owner' THEN
      EXECUTE format('ALTER SCHEMA %I OWNER TO v5_owner', s);
    END IF;
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', s);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO migration_owner', s);
  END LOOP;
END
$$;
