-- V5 P02 (V5-02-03) - explicit default-privilege revocation (design section 7: "explicit
-- default privileges are revoked"). v5_owner owns every future object created through the
-- runner, so PUBLIC is denied on everything created after this point; nothing relies on
-- PostgreSQL defaults. Runtime roles receive only the scoped grants in 0019-0022, never CREATE.
DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'meta', 'identity', 'profile', 'social', 'economy', 'core', 'match', 'tournament',
    'monetization', 'cosmetics', 'season', 'privacy', 'audit', 'support', 'runtime', 'ops'
  ] LOOP
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA %I REVOKE ALL ON TABLES FROM PUBLIC', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM PUBLIC', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM PUBLIC', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE v5_owner IN SCHEMA %I REVOKE ALL ON TYPES FROM PUBLIC', s);
  END LOOP;
END
$$;
