-- V5 P02 (V5-02-02) - match aggregate decomposition (design section 2.3, 3.2, 3.3).
-- terms/quote/state/receipt are bounded immutable-or-revisioned JSONB (ARCHITECTURE persistence
-- point 1); every currency number that constraints or reconciliation touch is duplicated into
-- BIGINT columns (design R1); quote policy fields (minimum/ceiling/fee/burn/payout/bonus/net_win)
-- stay in quote_json verbatim with NO repricing. Command outcomes are TEXT verbatim (R2).
-- SOURCE TRUTH: receipt.refunded for a MATCH is a money amount (src/authority.js:104 stores the
-- refunded escrow on an operator void; line 133 stores the escrow on a draw), NOT a boolean;
-- mapping.json matchReceipt.refunded is a uint. Store purchase/tournament refunded booleans stay
-- boolean elsewhere (monetization receipts, room receipts).
CREATE TABLE IF NOT EXISTS match.matches (
  match_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('queue', 'direct')),
  mode TEXT NOT NULL CHECK (mode IN ('queue', 'direct', 'unranked')),
  kind TEXT,
  rated boolean NOT NULL DEFAULT false,
  amount BIGINT CHECK (amount IS NULL OR amount BETWEEN 0 AND 9007199254740991),
  currency TEXT CHECK (currency IS NULL OR currency IN ('coins', 'crowns')),
  turn_seconds INTEGER CHECK (turn_seconds IS NULL OR turn_seconds IN (0, 30, 60)),
  from_tier TEXT CHECK (from_tier IS NULL OR from_tier IN ('wood', 'stone', 'iron', 'bronze', 'silver', 'gold', 'diamond', 'emerald', 'champion', 'master', 'grandmaster')),
  to_tier TEXT CHECK (to_tier IS NULL OR to_tier IN ('wood', 'stone', 'iron', 'bronze', 'silver', 'gold', 'diamond', 'emerald', 'champion', 'master', 'grandmaster')),
  terms_ratings NUMERIC(9, 2)[] CHECK (terms_ratings IS NULL OR cardinality(terms_ratings) = 2),
  terms_json JSONB NOT NULL,
  terms_hash CHAR(64) NOT NULL,
  quote_json JSONB NOT NULL,
  pool BIGINT NOT NULL CHECK (pool >= 0 AND pool <= 9007199254740991),
  contribution_a BIGINT NOT NULL CHECK (contribution_a >= 0 AND contribution_a <= 9007199254740991),
  contribution_b BIGINT NOT NULL CHECK (contribution_b >= 0 AND contribution_b <= 9007199254740991),
  accepted_count SMALLINT NOT NULL DEFAULT 0 CHECK (accepted_count IN (0, 1, 2)),
  status TEXT NOT NULL CHECK (status IN ('OFFERED', 'PLAYING', 'FINISHED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'VOID')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state_json JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  symbol_x TEXT,
  symbol_y TEXT,
  escrow BIGINT NOT NULL DEFAULT 0 CHECK (escrow >= 0 AND escrow <= 9007199254740991),
  settled boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  last_move_at timestamptz,
  deadline timestamptz,
  move_timings JSONB,
  pre_ratings NUMERIC(9, 2)[],
  pre_tiers TEXT[],
  receipt_json JSONB,
  receipt_at timestamptz,
  receipt_reason TEXT,
  receipt_payout BIGINT CHECK (receipt_payout IS NULL OR receipt_payout BETWEEN 0 AND 9007199254740991),
  receipt_burn BIGINT CHECK (receipt_burn IS NULL OR receipt_burn BETWEEN 0 AND 9007199254740991),
  receipt_bonus BIGINT CHECK (receipt_bonus IS NULL OR receipt_bonus BETWEEN 0 AND 9007199254740991),
  receipt_refunded BIGINT CHECK (receipt_refunded IS NULL OR receipt_refunded BETWEEN 0 AND 9007199254740991),
  risk_flags TEXT[] NOT NULL DEFAULT '{}',
  -- SOURCE TRUTH: mapping.json match._riskActors is a MAP of signal -> actor[] (ABUSE.matchSignals
  -- returns actors as an object of arrays). Flattening to TEXT[] lost which actors belong to which
  -- signal, so the lossless JSONB map is stored; risk_flags stays the flat flag list.
  risk_actors JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra JSONB,
  CONSTRAINT matches_match_id_grammar_ck CHECK (match_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$'),
  CONSTRAINT matches_terms_json_object_ck CHECK (jsonb_typeof(terms_json) = 'object'),
  CONSTRAINT matches_quote_json_object_ck CHECK (jsonb_typeof(quote_json) = 'object'),
  CONSTRAINT matches_state_json_object_ck CHECK (jsonb_typeof(state_json) = 'object'),
  CONSTRAINT matches_terms_hash_hex_ck CHECK (terms_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT matches_contributions_sum_ck CHECK (contribution_a + contribution_b = pool),
  -- CASE guards jsonb_array_length against non-array values (evaluation order of ANDed
  -- expressions is not guaranteed by the planner; CASE makes it a clean 23514 violation).
  CONSTRAINT matches_move_timings_bound_ck CHECK (
    CASE WHEN move_timings IS NULL THEN true
         WHEN jsonb_typeof(move_timings) = 'array' THEN jsonb_array_length(move_timings) <= 200
         ELSE false END),
  CONSTRAINT matches_receipt_json_object_ck CHECK (receipt_json IS NULL OR jsonb_typeof(receipt_json) = 'object'),
  CONSTRAINT matches_risk_actors_map_ck CHECK (jsonb_typeof(risk_actors) = 'object'),
  CONSTRAINT matches_extra_object_ck CHECK (extra IS NULL OR jsonb_typeof(extra) = 'object'),
  CONSTRAINT matches_deadline_ck CHECK (deadline IS NULL OR turn_seconds = 0 OR deadline > started_at)
);
CREATE INDEX IF NOT EXISTS matches_offered_expires_idx ON match.matches (expires_at) WHERE status = 'OFFERED';
CREATE INDEX IF NOT EXISTS matches_playing_deadline_idx ON match.matches (deadline) WHERE status = 'PLAYING' AND settled = false AND deadline IS NOT NULL;

-- players[2]: seat 0/1; actor values may be tombstoned strings -> soft reference (design 5.5).
CREATE TABLE IF NOT EXISTS match.participants (
  match_id TEXT NOT NULL REFERENCES match.matches (match_id) ON DELETE CASCADE,
  seat SMALLINT NOT NULL CHECK (seat IN (0, 1)),
  actor_id TEXT NOT NULL,
  accepted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, seat),
  CONSTRAINT participants_match_actor_key UNIQUE (match_id, actor_id)
);
CREATE INDEX IF NOT EXISTS participants_actor_idx ON match.participants (actor_id);

-- escrow contributions; the per-match sum vs match.escrow equality is asserted by the
-- importer/Core validation pass, not by a deferred aggregate constraint (design 2.3).
CREATE TABLE IF NOT EXISTS match.escrow_contributions (
  match_id TEXT NOT NULL REFERENCES match.matches (match_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  PRIMARY KEY (match_id, actor_id)
);

-- commands{key:{fingerprint,result}}; fingerprint = sha256(JSON.stringify({actor,revision,move})).
-- SOURCE TRUTH: m.commands stores {fingerprint,result} with NO timestamp (src/authority.js:95), so
-- committed_at is nullable to preserve genuine absence instead of a fabricated import now().
CREATE TABLE IF NOT EXISTS match.move_outcomes (
  match_id TEXT NOT NULL REFERENCES match.matches (match_id) ON DELETE CASCADE,
  "key" TEXT NOT NULL CHECK ("key" ~ '^[A-Za-z0-9:_-]{1,160}$'),
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  result TEXT NOT NULL CHECK (result IS JSON),
  committed_at timestamptz,
  PRIMARY KEY (match_id, "key")
);
CREATE INDEX IF NOT EXISTS move_outcomes_match_committed_idx ON match.move_outcomes (match_id, committed_at);
