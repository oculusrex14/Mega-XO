-- V5 P02 (V5-02-02) - actor identity core tables (design sections 2.2, 2.10, 3.1, 5.1).
-- Text identities are preserved verbatim: actor ids are NEVER cast to uuid, tags/usernames are
-- never regenerated. Timestamps are timestamptz (imported from epoch ms with exact UTC
-- conversion, design R6).

CREATE TABLE IF NOT EXISTS identity.actors (
  actor_id TEXT PRIMARY KEY,
  region TEXT NOT NULL DEFAULT '' CHECK (length(region) <= 64),
  wealth_public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  CONSTRAINT actors_actor_id_grammar_ck CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$')
);

-- Account owns `verified`; Core owns `suspended`/`security_hold` via column-level grants
-- (0021/0022). The three flags were embedded booleans in accounts[] and import exactly.
CREATE TABLE IF NOT EXISTS identity.eligibility (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  verified boolean NOT NULL DEFAULT false,
  suspended boolean NOT NULL DEFAULT false,
  security_hold boolean NOT NULL DEFAULT false
);

-- profiles is canonical for tag/display name (design 5.4: the embedded copies in accounts[]
-- are verification-only during import, not columns). The tag CHECK is generator-derived
-- ('MEGA-' + 8..12 upper hex); P03 widens only via a later migration if real data differs.
CREATE TABLE IF NOT EXISTS identity.profiles (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  tag TEXT NOT NULL UNIQUE CHECK (tag ~ '^MEGA-[0-9A-F]{8,12}$'),
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT 'board',
  stats_visibility TEXT NOT NULL DEFAULT 'friends' CHECK (stats_visibility IN ('public', 'friends', 'private')),
  presence_visibility TEXT NOT NULL DEFAULT 'friends' CHECK (presence_visibility IN ('friends', 'hidden')),
  created_at timestamptz NOT NULL,
  username_changed timestamptz,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT profiles_username_nonempty_ck CHECK (length(username) >= 1 AND length(display_name) >= 1)
);
-- Prefix search (username >= p AND username < p||chr(255)) uses text_pattern_ops (design 3.1).
CREATE INDEX IF NOT EXISTS profiles_username_pattern_idx ON identity.profiles (username text_pattern_ops);

CREATE TABLE IF NOT EXISTS identity.identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'email')),
  subject TEXT NOT NULL CHECK (length(subject) <= 255),
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (provider, subject),
  CONSTRAINT identities_actor_provider_key UNIQUE (actor_id, provider)
);
CREATE INDEX IF NOT EXISTS identities_actor_idx ON identity.identities (actor_id);
