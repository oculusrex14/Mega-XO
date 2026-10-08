-- V5 P02 (V5-02-02) - wallets, ratings, burns and actor legacy extras (design sections 2.2,
-- 3.4, 3.7; R1, R7; spec 01 section 3).
-- Currency: BIGINT with the documented safe-integer bound 0 <= v <= 9007199254740991. Reserved
-- balances are encumbrances, NOT additive holdings (journal records only the available side).
-- Elo: NUMERIC(9,2) exact hundredths; no float recomputation at import.
CREATE TABLE IF NOT EXISTS economy.wallets (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  coins BIGINT NOT NULL DEFAULT 0,
  crowns BIGINT NOT NULL DEFAULT 0,
  reserved_coins BIGINT NOT NULL DEFAULT 0,
  reserved_crowns BIGINT NOT NULL DEFAULT 0,
  purchased_coins BIGINT NOT NULL DEFAULT 0,
  purchased_crowns BIGINT NOT NULL DEFAULT 0,
  purchase_influenced boolean NOT NULL DEFAULT false,
  legacy_competition_restricted boolean NOT NULL DEFAULT false,
  CONSTRAINT wallets_coins_bound_ck CHECK (coins BETWEEN 0 AND 9007199254740991),
  CONSTRAINT wallets_crowns_bound_ck CHECK (crowns BETWEEN 0 AND 9007199254740991),
  CONSTRAINT wallets_reserved_coins_bound_ck CHECK (reserved_coins BETWEEN 0 AND 9007199254740991),
  CONSTRAINT wallets_reserved_crowns_bound_ck CHECK (reserved_crowns BETWEEN 0 AND 9007199254740991),
  CONSTRAINT wallets_purchased_coins_bound_ck CHECK (purchased_coins BETWEEN 0 AND 9007199254740991 AND purchased_coins <= coins),
  CONSTRAINT wallets_purchased_crowns_bound_ck CHECK (purchased_crowns BETWEEN 0 AND 9007199254740991 AND purchased_crowns <= crowns)
);
-- Wealth leaderboard sort support (design 3.4): the predicate flags wealth_public/security_hold
-- live in identity, so a cross-table partial index is impossible; the boring-standard choice
-- (recorded [P]) is this plain expression index plus the visibility filter in the query, which
-- still reads actor rows in sorted-lock order via core.actor_occupancy first.
CREATE INDEX IF NOT EXISTS wallets_wealth_idx ON economy.wallets (((coins + reserved_coins + (crowns + reserved_crowns) * 10)) DESC, actor_id);

CREATE TABLE IF NOT EXISTS economy.ratings (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  rating NUMERIC(9, 2) NOT NULL CHECK (rating >= 0),
  peak NUMERIC(9, 2) NOT NULL CHECK (peak >= 0),
  casual_rating NUMERIC(9, 2) NOT NULL CHECK (casual_rating >= 0),
  games INTEGER NOT NULL DEFAULT 0 CHECK (games >= 0),
  casual_games INTEGER NOT NULL DEFAULT 0 CHECK (casual_games >= 0),
  tier TEXT NOT NULL DEFAULT 'wood' CHECK (tier IN ('wood', 'stone', 'iron', 'bronze', 'silver', 'gold', 'diamond', 'emerald', 'champion', 'master', 'grandmaster')),
  reached_at timestamptz,
  last_rated_at timestamptz
);
CREATE INDEX IF NOT EXISTS ratings_rating_idx ON economy.ratings (rating DESC, actor_id);

-- burned{} singleton (design 2.8).
CREATE TABLE IF NOT EXISTS economy.system_burns (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  coins BIGINT NOT NULL DEFAULT 0 CHECK (coins BETWEEN 0 AND 9007199254740991),
  crowns BIGINT NOT NULL DEFAULT 0 CHECK (crowns BETWEEN 0 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unknown historical account keys land here verbatim with their source locator recorded by the
-- importer (design 5.6 / R11); nothing is silently dropped.
CREATE TABLE IF NOT EXISTS economy.actor_legacy_extra (
  actor_id TEXT PRIMARY KEY,
  extra JSONB NOT NULL CHECK (jsonb_typeof(extra) = 'object')
);
