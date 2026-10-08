-- V5 P02 (V5-02-02) - social graph + social command outcomes (design sections 2.2, 2.10, 3.2).
-- Legacy arrays friends[]/friendRequests[]/blocked[] become canonical pair tables; members hold
-- either an actor id or a legacy tombstone string, so these pairs are SOFT references (design
-- 5.5: hard FKs are limited to live aggregate tables). The import must verify both legacy arrays
-- agree before inserting (P03 obligation, not a DB constraint).
-- Command results are TEXT verbatim so differential replay compares exact committed bytes
-- (design 1.2 / R2); `IS JSON` is the PG16 validity gate (boring-standard over a ::jsonb cast,
-- which raises cast errors instead of clean 23514 violations - recorded [P] decision).

CREATE TABLE IF NOT EXISTS social.friendships (
  actor_a TEXT NOT NULL,
  actor_b TEXT NOT NULL,
  PRIMARY KEY (actor_a, actor_b),
  CONSTRAINT friendships_canonical_order_ck CHECK (actor_a < actor_b)
);
CREATE INDEX IF NOT EXISTS friendships_actor_b_idx ON social.friendships (actor_b);

CREATE TABLE IF NOT EXISTS social.friend_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id),
  CONSTRAINT friend_requests_not_self_ck CHECK (from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON social.friend_requests (to_id, from_id);

CREATE TABLE IF NOT EXISTS social.blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_not_self_ck CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON social.blocks (blocked_id);

-- Legacy social_operations: id = actor || ':' || key, so the (actor,key) pair is the exact
-- legacy uniqueness domain. Fingerprint = sha(JSON.stringify({command,target})) stored verbatim.
-- SOURCE TRUTH: server/community-store.js:210 fp is server/identity-provider.js:12 sha(), whose
-- digest is base64url, NOT hex: exactly 43 URL-safe characters, no padding. Re-encoding to hex
-- would be a rehash and break differential replay (R3), so the storage stays TEXT with the
-- family-correct 43-char constraint. Only this family uses base64url; economy/party/monetization/
-- move fingerprints remain sha256 hex.
CREATE TABLE IF NOT EXISTS social.command_outcomes (
  actor_id TEXT NOT NULL,
  "key" TEXT NOT NULL CHECK ("key" ~ '^[A-Za-z0-9:_-]{1,160}$'),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  result TEXT NOT NULL CHECK (result IS JSON),
  -- SOURCE TRUTH: social_operations(id,fingerprint,result) has NO timestamp column
  -- (server/community-store.js:47); NULL preserves genuine absence instead of a fabricated
  -- now() at import. Runtime commands that do observe a clock may still set it.
  committed_at timestamptz,
  PRIMARY KEY (actor_id, "key")
);
