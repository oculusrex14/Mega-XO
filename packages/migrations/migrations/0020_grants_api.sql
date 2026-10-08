-- runner: current-role
-- V5 P02 (V5-02-03) - api_runtime least privilege (design section 7, A04).
-- Grants are executed only by migration_owner (or a superuser in an ephemeral local/CI
-- container); v5_owner ownership keeps the grantor on the owner side of every object.
-- api_runtime MUST FAIL: direct economy/match/monetization writes, any DDL, and reads of
-- credential secret columns (salt, password_hash, code_hash, password_salt, nonce, verifier) -
-- those columns are simply absent from the column lists below; a future narrow SECURITY DEFINER
-- function (P04) is the only sanctioned export path. No economy SELECT is granted today: the
-- "read-only views for authorized projections" are a P04 deliverable ([P] boring-standard:
-- keep the role empty until the views exist).
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

GRANT USAGE ON SCHEMA identity, profile, social, privacy, support, ops, runtime TO api_runtime;

-- Authorized reads. Credential tables are column-scoped to hide secret material.
GRANT SELECT ON identity.actors, identity.eligibility, identity.profiles, identity.identities,
  identity.sessions, identity.email_credential_versions TO api_runtime;
GRANT SELECT (actor_id, email, created_at, verified_at) ON identity.email_credentials TO api_runtime;
GRANT SELECT (challenge_id, session_hash, email, purpose, actor_id, created_at, expires_at,
  attempts, verified_at, consumed) ON identity.email_challenges TO api_runtime;
GRANT SELECT (state_hash, session_hash, provider, kind, intent, target_actor, expires_at,
  used) ON identity.signin_attempts TO api_runtime;
GRANT SELECT ON profile.profile_saves TO api_runtime;

-- Account/API intake and mutation paths.
GRANT INSERT, UPDATE ON identity.actors, identity.profiles, identity.identities,
  identity.email_credentials, identity.signin_attempts TO api_runtime;
-- Session lifecycle: logout deletes; expired challenges rotate away (cascade covers versions).
GRANT INSERT, UPDATE, DELETE ON identity.sessions, identity.email_challenges,
  identity.signin_attempts TO api_runtime;

-- Social graph: friendship/request/block changes that carry economic or offered-match effects
-- are delegated to Core commands; the graph rows themselves are API-owned (design ownership
-- register). command_outcomes is append + read only.
GRANT SELECT, INSERT, UPDATE, DELETE ON social.friendships, social.friend_requests, social.blocks TO api_runtime;
GRANT SELECT, INSERT ON social.command_outcomes TO api_runtime;

-- Privacy intake: reports INSERT + resolve-later UPDATE; requests INSERT only (worker owns the
-- state machine, 0021). Practice archive writes are API-owned.
GRANT INSERT, UPDATE ON privacy.reports TO api_runtime;
GRANT SELECT ON privacy.reports, privacy.requests TO api_runtime;
GRANT INSERT ON privacy.requests TO api_runtime;
GRANT INSERT, UPDATE ON profile.profile_saves TO api_runtime;

-- Durable rate budgets (interim until Redis, P06): upsert + reset.
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.rate_buckets TO api_runtime;

-- Every production response may append a sanitized support correlation event (design: hidden
-- effects register).
GRANT INSERT ON support.events TO api_runtime;

-- Operational control read (maintenance mode gate). [P] boring-standard: all three runtime
-- roles may read runtime.controls/runtime.state; they can never write them.
GRANT SELECT ON runtime.controls, runtime.state TO api_runtime;
