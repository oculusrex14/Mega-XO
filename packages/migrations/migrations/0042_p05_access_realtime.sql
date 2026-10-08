-- 0042: P05 access signing, refresh families, device revocation and one-use realtime tickets.
-- Design: docs/v5/designs/p05-session-design.md B2/B3/B5 (corrected map), TTLs frozen in Part F.
-- Private signing keys NEVER live in the database: identity.signing_keys stores only the public
-- JWK plus a private_ref reference (sealed operator file). All timestamps are timestamptz; every
-- key/hash column is hex with an explicit CHECK. Deterministic import still applies: no
-- constructors, no time rolling, no economy.ledger touch.

CREATE TABLE IF NOT EXISTS identity.signing_keys (
  kid TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('stg', 'prd')),
  algorithm TEXT NOT NULL CHECK (algorithm = 'EdDSA'),
  public_jwk jsonb NOT NULL,
  private_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staging', 'active', 'retiring', 'retired')),
  created_at timestamptz NOT NULL,
  activate_at timestamptz,
  retire_at timestamptz,
  thumbprint TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS signing_keys_servable_idx ON identity.signing_keys (state, activate_at DESC);

-- Hashed refresh credentials only; the secret is derived/returned, never stored.
CREATE TABLE IF NOT EXISTS identity.refresh_families (
  family_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  device_id TEXT,
  created_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
  reused_in_grace int NOT NULL DEFAULT 0 CHECK (reused_in_grace >= 0),
  revoked_at timestamptz,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS refresh_families_actor_idx ON identity.refresh_families (actor_id, state);
CREATE INDEX IF NOT EXISTS refresh_families_session_idx ON identity.refresh_families (session_id);

CREATE TABLE IF NOT EXISTS identity.refresh_tokens (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  family_id TEXT NOT NULL REFERENCES identity.refresh_families (family_id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'rotated', 'revoked', 'expired')),
  issued_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  rotate_at timestamptz,
  grace_until timestamptz
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON identity.refresh_tokens (family_id, generation DESC);

-- The durable revocation counter an access token's `gen` claim is checked against.
CREATE TABLE IF NOT EXISTS identity.session_generations (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS identity.devices (
  device_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'browser')),
  label TEXT,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS devices_actor_idx ON identity.devices (actor_id, revoked_at);

CREATE TABLE IF NOT EXISTS identity.realtime_tickets (
  ticket_hash TEXT PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  generation bigint NOT NULL,
  environment TEXT NOT NULL,
  audience TEXT NOT NULL,
  match_scope TEXT,
  connection_class TEXT NOT NULL,
  issued_ip_hash TEXT,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_by TEXT,
  redeem_connection_id TEXT,
  redeem_ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS realtime_tickets_actor_idx ON identity.realtime_tickets (actor_id, expires_at);
CREATE INDEX IF NOT EXISTS realtime_tickets_open_idx ON identity.realtime_tickets (expires_at) WHERE redeemed_at IS NULL;

-- Session metadata P05 needs: transport class, owning device and the auth-method list. Existing
-- rows default to the retained browser class; no existing column changes meaning.
ALTER TABLE identity.sessions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'browser',
  ADD COLUMN IF NOT EXISTS device_id TEXT REFERENCES identity.devices (device_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amr text[];
ALTER TABLE identity.sessions DROP CONSTRAINT IF EXISTS sessions_kind_ck;
ALTER TABLE identity.sessions ADD CONSTRAINT sessions_kind_ck CHECK (kind IN ('browser', 'native'));
CREATE INDEX IF NOT EXISTS sessions_kind_idx ON identity.sessions (kind);

-- Core reads session/eligibility status WITHOUT any credential column (design C3). The session
-- identifier is the stored sha256 hex digest of the bearer (the same value every V5 surface uses);
-- no credential column is exposed.
CREATE OR REPLACE VIEW core.actor_access_state AS
  SELECT s.actor_id,
         s.token_hash AS session_id,
         g.generation,
         CASE WHEN s.expires_at <= now() THEN 'expired' ELSE 'live' END AS state,
         e.verified, e.suspended, e.security_hold, s.amr
    FROM identity.sessions s
    LEFT JOIN identity.session_generations g ON g.actor_id = s.actor_id
    LEFT JOIN identity.eligibility e ON e.actor_id = s.actor_id
   WHERE s.actor_id IS NOT NULL;

-- One atomic redemption: the durable row is the only authority (design B5.3/C2). Zero rows on
-- replay; the caller disambiguates via a SELECT on the same table (Core holds SELECT).
CREATE OR REPLACE FUNCTION identity.redeem_realtime_ticket(
  p_ticket_hash text, p_connection_id text, p_node text, p_now timestamptz
) RETURNS TABLE (actor_id text, session_id text, generation bigint, environment text, audience text, match_scope text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, identity AS $fn$
  UPDATE identity.realtime_tickets t
     SET redeemed_at = p_now, redeemed_by = p_node, redeem_connection_id = p_connection_id
    FROM (SELECT ticket_hash FROM identity.realtime_tickets
           WHERE ticket_hash = p_ticket_hash AND redeemed_at IS NULL AND expires_at > p_now
           FOR UPDATE) w
   WHERE t.ticket_hash = w.ticket_hash
   RETURNING t.actor_id, t.session_id, t.generation, t.environment, t.audience, t.match_scope;
$fn$;

GRANT EXECUTE ON FUNCTION identity.redeem_realtime_ticket(text, text, text, timestamptz) TO core_runtime;
REVOKE ALL ON FUNCTION identity.redeem_realtime_ticket(text, text, text, timestamptz) FROM PUBLIC;
GRANT SELECT ON identity.realtime_tickets TO core_runtime;
GRANT SELECT ON core.actor_access_state TO core_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON identity.signing_keys TO api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.refresh_families TO api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.refresh_tokens TO api_runtime;
GRANT SELECT, INSERT, UPDATE ON identity.session_generations TO api_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.devices TO api_runtime;
GRANT SELECT, INSERT, UPDATE ON identity.realtime_tickets TO api_runtime;
GRANT SELECT ON identity.signing_keys, identity.refresh_families, identity.refresh_tokens,
  identity.session_generations, identity.devices, identity.realtime_tickets TO worker_runtime;
