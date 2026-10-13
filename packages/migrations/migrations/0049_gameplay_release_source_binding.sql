-- DC12: proof of deployed capture source must come from the DB policy, not solely
-- from a caller-provided release receipt. Adds only a non-sensitive immutable SHA
-- to the existing role-restricted projection; no table/API/economy grants change.
CREATE OR REPLACE FUNCTION learning.configuration() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,learning,pg_temp AS $$
 SELECT jsonb_build_object('enabled',enabled,'policyVersion',policy_version,
  'privacyEpoch',privacy_epoch,'rulesHash',rules_hash,'environment',environment,
  'sourceCommit',source_commit) FROM learning.policy WHERE id
$$;
REVOKE ALL ON FUNCTION learning.configuration() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION learning.configuration() TO capture_runtime,capture_exporter,capture_privacy;
