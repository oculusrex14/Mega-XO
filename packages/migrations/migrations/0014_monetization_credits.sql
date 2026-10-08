-- V5 P02 (V5-02-02) - monetization credits/progress tables (design section 2.2 monetization{},
-- 2.10 v35_*). Frame ids: 'classic' is the only live catalogue entry; the archived frame names
-- ('Copper edge', 'Orbit frame', 'Crown frame') are tolerated so imports never fail on history
-- (frames stay archived - no reactivation). SOURCE TRUTH: equipped is an arbitrary historical
-- frame id string (mapping.json monetizationRoot.equipped: "str"; fixtures carry aurora_frame),
-- not a closed catalogue, so the column stores source text verbatim. The live catalogue policy
-- for new equip mutations lives in the domain (server/monetization-store.js owned().frames),
-- never as a DB gate; retaining an archived id must not re-enable the item. Reward-day caps are
-- policy, kept in the domain, not encoded as DB bounds (design 2.2).
CREATE TABLE IF NOT EXISTS monetization.credits (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  credit_balance BIGINT NOT NULL DEFAULT 0 CHECK (credit_balance >= 0 AND credit_balance <= 9007199254740991),
  equipped_frame TEXT,
  last_ad_at timestamptz,
  last_reward_start timestamptz,
  extra JSONB,
  CONSTRAINT credits_extra_object_ck CHECK (extra IS NULL OR jsonb_typeof(extra) = 'object')
);

-- SOURCE TRUTH: monetization.redeemed is a SET of frame-id strings (mapping.json
-- monetizationRoot.redeemed) with NO source timestamp. redeemed_at is nullable so an import
-- records genuine absence instead of inventing an acquisition time; a future importer keeps its
-- own import provenance separately. (Runtime mutations that do have a clock may still set it.)
CREATE TABLE IF NOT EXISTS monetization.redeemed_frames (
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  frame TEXT NOT NULL,
  redeemed_at timestamptz,
  PRIMARY KEY (actor_id, frame)
);

-- account.monetization.boosts[] kept as a seq per actor (source array order preserved).
CREATE TABLE IF NOT EXISTS monetization.boosts (
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  boost_seq INTEGER NOT NULL CHECK (boost_seq >= 0),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, boost_seq),
  CONSTRAINT boosts_window_ck CHECK (ends_at > started_at)
);
CREATE INDEX IF NOT EXISTS boosts_actor_ends_idx ON monetization.boosts (actor_id, ends_at);

CREATE TABLE IF NOT EXISTS monetization.reward_daily (
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  day DATE NOT NULL,
  base INTEGER NOT NULL DEFAULT 0 CHECK (base >= 0),
  bonus INTEGER NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  automatic INTEGER NOT NULL DEFAULT 0 CHECK (automatic >= 0),
  PRIMARY KEY (actor_id, day)
);

-- v35_commands: fp = sha256(JSON.stringify(command)); PK(actor,key) legacy domain preserved.
-- SOURCE TRUTH: v35_commands(actor,key,fingerprint,response) has NO timestamp
-- (server/monetization-store.js:13), so committed_at is nullable to preserve genuine absence
-- rather than a fabricated import now().
CREATE TABLE IF NOT EXISTS monetization.command_outcomes (
  actor_id TEXT NOT NULL,
  "key" TEXT NOT NULL CHECK ("key" ~ '^[A-Za-z0-9:_-]{1,160}$'),
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response TEXT NOT NULL CHECK (response IS JSON),
  committed_at timestamptz,
  PRIMARY KEY (actor_id, "key")
);

-- v35_tickets.
CREATE TABLE IF NOT EXISTS monetization.reward_tickets (
  ticket_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('credits', 'boost')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz,
  day DATE NOT NULL,
  settled boolean NOT NULL DEFAULT false,
  transaction_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS reward_tickets_actor_day_idx ON monetization.reward_tickets (actor_id, day);
CREATE INDEX IF NOT EXISTS reward_tickets_pending_idx ON monetization.reward_tickets (actor_id, kind, settled, expires_at);
CREATE INDEX IF NOT EXISTS reward_tickets_actor_issued_idx ON monetization.reward_tickets (actor_id, issued_at);

-- v35_casual: qualified casual rewards per (actor, match) -> claim() anti-join key (design 3.6).
CREATE TABLE IF NOT EXISTS monetization.casual_rewards (
  actor_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  base INTEGER NOT NULL DEFAULT 0 CHECK (base >= 0),
  bonus INTEGER NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  PRIMARY KEY (actor_id, match_id)
);

-- v35_events: INTEGER autoincrement -> IDENTITY to preserve monotonic order (design 2.10).
CREATE TABLE IF NOT EXISTS monetization.reward_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at timestamptz NOT NULL,
  value BIGINT CHECK (value IS NULL OR value BETWEEN -9007199254740991 AND 9007199254740991)
);
CREATE INDEX IF NOT EXISTS reward_events_actor_at_idx ON monetization.reward_events (actor_id, at);
CREATE INDEX IF NOT EXISTS reward_events_kind_at_idx ON monetization.reward_events (kind, at);

-- v41_ad_ticket_context: platform CHECK widened to include 'legacy' (migrations.js grammar) so
-- imports never fail on legacy rows (design 2.10).
CREATE TABLE IF NOT EXISTS monetization.ad_ticket_context (
  ticket_id TEXT PRIMARY KEY REFERENCES monetization.reward_tickets (ticket_id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'legacy')),
  ad_unit TEXT NOT NULL
);
