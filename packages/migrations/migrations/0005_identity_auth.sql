-- V5 P02 (V5-02-02) - authentication state (design section 2.10, 3.1, 3.3; R5).
-- citext is NOT enabled by default: the boring-standard choice is the PK + lower(email)
-- unique functional index, preserving case-insensitive uniqueness equivalence without a
-- provider-extension dependency. If V5-02-01 section 6.5 confirms citext, a later expand
-- migration may switch this over (recorded [P] decision).

CREATE TABLE IF NOT EXISTS identity.email_credentials (
  email TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL UNIQUE REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at timestamptz NOT NULL,
  verified_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS email_credentials_lower_email_uniq ON identity.email_credentials (lower(email));

-- One-use durable auth security stays in PostgreSQL, NOT Redis (design 2.10).
CREATE TABLE IF NOT EXISTS identity.email_challenges (
  challenge_id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'verify-existing', 'link', 'reset', 'change-email')),
  actor_id TEXT,
  code_hash TEXT NOT NULL,
  password_salt TEXT,
  password_hash TEXT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at timestamptz,
  consumed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS email_challenges_lookup_idx ON identity.email_challenges (session_hash, email, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS email_challenges_email_idx ON identity.email_challenges (email);
CREATE INDEX IF NOT EXISTS email_challenges_expires_idx ON identity.email_challenges (expires_at);

CREATE TABLE IF NOT EXISTS identity.email_credential_versions (
  challenge_id TEXT PRIMARY KEY REFERENCES identity.email_challenges (challenge_id) ON DELETE CASCADE,
  credential_hash TEXT
);

-- Sessions keep only the sha256 of the bearer; the raw token is never stored (design 2.10).
CREATE TABLE IF NOT EXISTS identity.sessions (
  token_hash CHAR(64) PRIMARY KEY,
  actor_id TEXT REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  auth_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00+00:00',
  CONSTRAINT sessions_token_hash_hex_ck CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS sessions_actor_idx ON identity.sessions (actor_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON identity.sessions (expires_at);

CREATE TABLE IF NOT EXISTS identity.signin_attempts (
  state_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'email')),
  kind TEXT NOT NULL CHECK (kind IN ('web', 'native')),
  intent TEXT NOT NULL CHECK (intent IN ('login', 'link', 'reauth')),
  target_actor TEXT,
  nonce TEXT,
  verifier TEXT,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS signin_attempts_expires_idx ON identity.signin_attempts (expires_at);
CREATE INDEX IF NOT EXISTS signin_attempts_session_idx ON identity.signin_attempts (session_hash);
