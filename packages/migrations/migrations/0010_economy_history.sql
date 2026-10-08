-- V5 P02 (V5-02-02) - season/tournament records, per-actor match history and the global journal
-- (design sections 2.2, 2.7, 3.5, 3.6). The journal is APPEND-ONLY: no runtime role receives
-- UPDATE/DELETE (enforced by grants in 0021/0022); entry_id PK is the append idempotency key.
-- journal.actor stays a soft TEXT: legacy burn rows use the literal 'system' and deletion
-- rewrites actor ids to tombstone strings (design 2.7/5.5).

CREATE TABLE IF NOT EXISTS economy.season_state (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  season_id TEXT NOT NULL CHECK (season_id ~ '^[0-9]{4}-Q[1-4]$'),
  started_at timestamptz NOT NULL,
  games INTEGER NOT NULL DEFAULT 0 CHECK (games >= 0),
  queue_games INTEGER NOT NULL DEFAULT 0 CHECK (queue_games >= 0),
  opponents TEXT[] NOT NULL DEFAULT '{}',
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  peak_rating NUMERIC(9, 2) CHECK (peak_rating IS NULL OR peak_rating >= 0),
  last_rated_at timestamptz,
  qualified_at timestamptz
);
CREATE INDEX IF NOT EXISTS season_state_season_actor_idx ON economy.season_state (season_id, actor_id);

-- SOURCE TRUTH: every seasonHistoryEntry carries lastRatedAt and qualifiedAt (mapping.json
-- seasonHistoryEntry; src/authority.js archives the whole prior season), and the source's own
-- POLICY.seasonHistoryLimit=8 truncation happens ONLY when restore() rolls a season - the raw
-- stored array can already hold more than 8 entries (fixtures/tests retain 9 without a roll).
-- The import therefore MUST NOT cap or truncate: seq stays the ordered 0-based index over the
-- full array and only the nonnegative domain bound is enforced. Both clocks are nullable because
-- the source stores null on entries that never rated/qualified.
CREATE TABLE IF NOT EXISTS economy.season_history (
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  seq SMALLINT NOT NULL,
  season_id TEXT NOT NULL CHECK (season_id ~ '^[0-9]{4}-Q[1-4]$'),
  started_at timestamptz NOT NULL,
  games INTEGER NOT NULL DEFAULT 0 CHECK (games >= 0),
  queue_games INTEGER NOT NULL DEFAULT 0 CHECK (queue_games >= 0),
  opponents TEXT[] NOT NULL DEFAULT '{}',
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
  peak_rating NUMERIC(9, 2) CHECK (peak_rating IS NULL OR peak_rating >= 0),
  last_rated_at timestamptz,
  qualified_at timestamptz,
  finish_rating NUMERIC(9, 2) CHECK (finish_rating IS NULL OR finish_rating >= 0),
  finish_tier TEXT,
  ended_at timestamptz,
  PRIMARY KEY (actor_id, seq),
  CONSTRAINT season_history_seq_ck CHECK (seq >= 0)
);

CREATE TABLE IF NOT EXISTS economy.tournament_records (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  entered INTEGER NOT NULL DEFAULT 0 CHECK (entered >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  runner_up INTEGER NOT NULL DEFAULT 0 CHECK (runner_up >= 0),
  top3 INTEGER NOT NULL DEFAULT 0 CHECK (top3 >= 0),
  top5 INTEGER NOT NULL DEFAULT 0 CHECK (top5 >= 0),
  best_finish SMALLINT CHECK (best_finish BETWEEN 1 AND 10),
  finish_sum INTEGER NOT NULL DEFAULT 0 CHECK (finish_sum >= 0),
  premium_wins INTEGER NOT NULL DEFAULT 0 CHECK (premium_wins >= 0)
);

-- account.history[]; opponent is an actor id OR a legacy tombstone text -> soft verified,
-- no hard FK (design 2.2/5.5). (actor_id, at DESC) serves profile stats and the sorted
-- monetization claim scan (design 3.6).
CREATE TABLE IF NOT EXISTS economy.match_history (
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  match_id TEXT NOT NULL,
  at timestamptz NOT NULL,
  opponent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ranked', 'casual', 'friend')),
  queue boolean NOT NULL,
  symbol TEXT NOT NULL CHECK (symbol IN ('X', 'O')),
  rated boolean NOT NULL,
  qualified boolean NOT NULL,
  activity_qualified boolean NOT NULL DEFAULT false,
  result TEXT NOT NULL CHECK (result IN ('win', 'loss', 'draw')),
  reason TEXT,
  active_seconds INTEGER CHECK (active_seconds IS NULL OR active_seconds >= 0),
  rating_delta NUMERIC(9, 2),
  casual_delta NUMERIC(9, 2),
  PRIMARY KEY (actor_id, seq),
  CONSTRAINT match_history_seq_ck CHECK (seq >= 0),
  CONSTRAINT match_history_actor_match_key UNIQUE (actor_id, match_id)
);
CREATE INDEX IF NOT EXISTS match_history_actor_at_idx ON economy.match_history (actor_id, at DESC);

-- journal[] -> the global append-only ledger (design 2.7).
CREATE TABLE IF NOT EXISTS economy.ledger (
  entry_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('coins', 'crowns')),
  amount BIGINT NOT NULL CHECK (amount BETWEEN -9007199254740991 AND 9007199254740991),
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('game', 'provisioning', 'mint', 'conversion', 'verified-store', 'spend', 'tournament', 'migration-baseline')),
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_actor_at_idx ON economy.ledger (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS ledger_at_idx ON economy.ledger (at DESC, entry_id);
CREATE INDEX IF NOT EXISTS ledger_source_at_idx ON economy.ledger (source, at);
