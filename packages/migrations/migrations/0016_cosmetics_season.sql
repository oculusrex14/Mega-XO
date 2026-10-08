-- V5 P02 (V5-02-02) - cosmetics ownership + season publication/payouts (design sections 2.2
-- owned[], 2.5, 2.6). Legacy item names (including archived frames) are stored verbatim; frames
-- stay archived. weekly_payouts.payout_id is preserved because journal entries reference
-- 'weekly:'||id (design 2.6), and the payouts row is permanent (no runtime DELETE).
-- SOURCE TRUTH: account.owned is a SET of cosmetic names with NO source acquisition timestamp
-- (mapping.json owned[]), and a weeklyPayment stores {id,account,week,amount,tier,eligible,days}
-- with NO source created time (mapping.json weeklyPayment). Both clocks are nullable so the
-- import preserves genuine timestamp absence rather than inventing a now() business-event time;
-- a future importer records its own import provenance separately.
CREATE TABLE IF NOT EXISTS cosmetics.owned_items (
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  acquired_at timestamptz,
  PRIMARY KEY (actor_id, item)
);

-- snapshots[date]={actor:tier}
CREATE TABLE IF NOT EXISTS season.day_snapshots (
  day DATE NOT NULL,
  actor_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  PRIMARY KEY (day, actor_id)
);
CREATE INDEX IF NOT EXISTS day_snapshots_actor_day_idx ON season.day_snapshots (actor_id, day);

-- leagueWeek singleton
CREATE TABLE IF NOT EXISTS season.league_week (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  week DATE,
  published_at timestamptz
);

-- weeklyPaid[week:actor]
CREATE TABLE IF NOT EXISTS season.weekly_payouts (
  payout_id TEXT PRIMARY KEY,
  week DATE NOT NULL,
  actor_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 0 AND amount <= 9007199254740991),
  tier TEXT,
  eligible boolean,
  days SMALLINT CHECK (days IS NULL OR days BETWEEN 0 AND 7),
  created_at timestamptz,
  CONSTRAINT weekly_payouts_week_actor_key UNIQUE (week, actor_id)
);
CREATE INDEX IF NOT EXISTS weekly_payouts_actor_week_idx ON season.weekly_payouts (actor_id, week DESC);
