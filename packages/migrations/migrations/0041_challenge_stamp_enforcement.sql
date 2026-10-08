-- 0041: A challenge without a persisted credential version row can never grant.
-- The G9 requirement is enforced at the boundary the runtime already uses: the API's challenge
-- read function exposes the version row's EXISTENCE (not its value) as `credentialStampPresent`,
-- so the service can refuse every purpose when the row is absent. A signup challenge legitimately
-- pins a NULL stamp value, but its row still exists - the existence flag is what distinguishes a
-- legitimate NULL stamp from a tampered/legacy row that was purged.
-- Same SECURITY DEFINER boundary as 0039: api_runtime has EXECUTE only and no direct challenge
-- SELECT, so the owner's privileges (not the caller's) read the row.
CREATE OR REPLACE FUNCTION identity.auth_challenge(p_id text, p_session_hash text)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity AS $fn$
  SELECT json_build_object(
    'challengeId', c.challenge_id, 'sessionHash', c.session_hash, 'email', c.email,
    'purpose', c.purpose, 'actorId', c.actor_id,
    'codeHash', c.code_hash, 'passwordSalt', c.password_salt,
    'passwordHash', c.password_hash, 'credentialHash', v.credential_hash,
    'credentialStampPresent', (v.challenge_id IS NOT NULL),
    'createdAt', (extract(epoch FROM c.created_at) * 1000)::bigint,
    'expiresAt', (extract(epoch FROM c.expires_at) * 1000)::bigint,
    'attempts', c.attempts,
    'verifiedAt', (extract(epoch FROM c.verified_at) * 1000)::bigint,
    'consumed', c.consumed
  )
  FROM identity.email_challenges c
  LEFT JOIN identity.email_credential_versions v ON v.challenge_id = c.challenge_id
  WHERE c.challenge_id = p_id AND c.session_hash = p_session_hash
  LIMIT 1;
$fn$;
GRANT EXECUTE ON FUNCTION identity.auth_challenge(text, text) TO api_runtime;
REVOKE ALL ON FUNCTION identity.auth_challenge(text, text) FROM PUBLIC;
