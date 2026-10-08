-- V5 P02 (V5-02-02) - party rooms/fixtures decomposition (design section 2.9, 3.3).
-- party_guests is NOT migrated (LAN-only 24h TTL practice, explicit expiry per spec 01 section 1).
-- Room JSONB members are bounded display/verbatim fields anchored by the normalized BIGINTs;
-- owner_id is soft (rooms[].players held tombstone strings), room_players is a hard FK (5.5).
-- P08-P10 core/worker integration: room escrow/settled facts stay on rooms (NOT duplicated);
-- per-fixture revision plus a fenced progression lease (owner + monotonic epoch + expiry) gives
-- stale-worker rejection (ARCHITECTURE persistence point 5: "a stale lease cannot finish after
-- a newer worker has advanced the job/room"); a room timer lease guards the round/clock sweep.
CREATE TABLE IF NOT EXISTS tournament.rooms (
  room_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  name TEXT,
  format TEXT CHECK (format IS NULL OR format IN ('duel', 'knockout', 'league', 'mixed', 'group')),
  table_kind TEXT,
  sequential boolean,
  quote_json JSONB,
  quote_currency TEXT CHECK (quote_currency IS NULL OR quote_currency IN ('coins', 'crowns')),
  entry BIGINT CHECK (entry IS NULL OR entry BETWEEN 0 AND 9007199254740991),
  pool BIGINT CHECK (pool IS NULL OR pool BETWEEN 0 AND 9007199254740991),
  burn BIGINT CHECK (burn IS NULL OR burn BETWEEN 0 AND 9007199254740991),
  clock_seconds INTEGER CHECK (clock_seconds IS NULL OR clock_seconds >= 0),
  increment_seconds INTEGER CHECK (increment_seconds IS NULL OR increment_seconds >= 0),
  capacity SMALLINT CHECK (capacity IS NULL OR capacity >= 0),
  rules_version SMALLINT,
  status TEXT NOT NULL CHECK (status IN ('LOBBY', 'RUNNING', 'PAUSED', 'REVIEW', 'COMPLETE', 'VOID', 'CANCELLED')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  deadline timestamptz,
  paused_at timestamptz,
  reason TEXT,
  draw_game TEXT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  round_delay_ms INTEGER CHECK (round_delay_ms IS NULL OR round_delay_ms >= 0),
  groups_json JSONB,
  final_refs_json JSONB,
  seed_json JSONB,
  ranking TEXT[] NOT NULL DEFAULT '{}',
  -- SOURCE TRUTH: server/rooms.js:63-64 settle() writes the committed settlement receipt
  -- ({currency,pool,burn,payouts[{id,amount}],refunded}) and the abuse review metadata
  -- (riskFlags[], _riskActors map of signal -> actor[]); mapping.json rooms.root preserves all
  -- three. receipt_json is the bounded immutable-or-revisioned settlement receipt (design 2.9);
  -- risk_actors is a lossless JSONB map, because flattening it to TEXT[] loses which actors
  -- belong to which signal (_riskActors is a map of arrays, never a flat list). Both are
  -- review-only and are excluded from the delivered room view (T.view deletes _riskActors).
  receipt_json JSONB,
  risk_flags TEXT[] NOT NULL DEFAULT '{}',
  risk_actors JSONB NOT NULL DEFAULT '{}'::jsonb,
  escrow BIGINT NOT NULL DEFAULT 0 CHECK (escrow >= 0 AND escrow <= 9007199254740991),
  settled boolean NOT NULL DEFAULT false,
  settled_at timestamptz,
  timer_lease_owner TEXT,
  timer_lease_epoch BIGINT CHECK (timer_lease_epoch IS NULL OR timer_lease_epoch >= 0),
  timer_lease_until timestamptz,
  extra JSONB,
  CONSTRAINT rooms_room_id_grammar_ck CHECK (room_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$'),
  CONSTRAINT rooms_code_grammar_ck CHECK (code ~ '^[A-Za-z0-9:_-]{1,160}$'),
  CONSTRAINT rooms_quote_json_object_ck CHECK (quote_json IS NULL OR jsonb_typeof(quote_json) = 'object'),
  CONSTRAINT rooms_receipt_json_object_ck CHECK (receipt_json IS NULL OR jsonb_typeof(receipt_json) = 'object'),
  CONSTRAINT rooms_risk_actors_map_ck CHECK (jsonb_typeof(risk_actors) = 'object'),
  -- SOURCE TRUTH (src/tournament.js:13,26,29-40): create() writes groups: [] and start() writes
  -- groups = [{id,name,players[],refs}] and seed = [actorId,...]; both are ARRAYS, so an
  -- object-only gate rejects every ordinary room. Only finalRefs is array-or-object (start()
  -- always assigns an array, but the object branch stays tolerated for older rows).
  CONSTRAINT rooms_groups_json_array_ck CHECK (groups_json IS NULL OR jsonb_typeof(groups_json) = 'array'),
  CONSTRAINT rooms_final_refs_json_ck CHECK (final_refs_json IS NULL OR jsonb_typeof(final_refs_json) IN ('array', 'object')),
  CONSTRAINT rooms_seed_json_array_ck CHECK (seed_json IS NULL OR jsonb_typeof(seed_json) = 'array'),
  CONSTRAINT rooms_timer_lease_tuple_ck CHECK (
    CASE WHEN timer_lease_owner IS NULL THEN timer_lease_epoch IS NULL AND timer_lease_until IS NULL
         ELSE timer_lease_epoch IS NOT NULL AND timer_lease_until IS NOT NULL END),
  CONSTRAINT rooms_extra_object_ck CHECK (extra IS NULL OR jsonb_typeof(extra) = 'object')
);
CREATE INDEX IF NOT EXISTS rooms_status_expires_idx ON tournament.rooms (status, expires_at) WHERE status IN ('LOBBY', 'RUNNING', 'PAUSED', 'REVIEW');
CREATE INDEX IF NOT EXISTS rooms_timer_lease_idx ON tournament.rooms (timer_lease_until) WHERE status IN ('RUNNING', 'PAUSED');
CREATE INDEX IF NOT EXISTS rooms_owner_idx ON tournament.rooms (owner_id);

CREATE TABLE IF NOT EXISTS tournament.room_players (
  room_id TEXT NOT NULL REFERENCES tournament.rooms (room_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  name TEXT,
  ready boolean NOT NULL DEFAULT false,
  withdrawn boolean NOT NULL DEFAULT false,
  -- SOURCE TRUTH: src/tournament.js join() stores only {id,name,ready,withdrawn}; the source has
  -- NO join timestamp (mapping.json roomPlayer confirms). NULL preserves that genuine absence;
  -- a fabricated now() at import would invent a business-event time the source never recorded.
  joined_at timestamptz,
  PRIMARY KEY (room_id, actor_id)
);
CREATE INDEX IF NOT EXISTS room_players_actor_idx ON tournament.room_players (actor_id);

-- Room escrow contributions: normalized reservation facts reconciled against rooms.escrow by
-- Core/import (the rooms.escrow/settled columns themselves are NOT duplicated here).
CREATE TABLE IF NOT EXISTS tournament.escrow_contributions (
  room_id TEXT NOT NULL REFERENCES tournament.rooms (room_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0 AND amount <= 9007199254740991),
  PRIMARY KEY (room_id, actor_id)
);

CREATE TABLE IF NOT EXISTS tournament.fixtures (
  room_id TEXT NOT NULL REFERENCES tournament.rooms (room_id) ON DELETE CASCADE,
  fixture_id TEXT NOT NULL,
  label TEXT,
  "round" INTEGER,
  group_id TEXT,
  decisive boolean,
  slots_json JSONB,
  players TEXT[] NOT NULL DEFAULT '{}',
  "ready" TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('BLOCKED', 'READY', 'PLAYING', 'DONE')),
  state_json JSONB,
  mini_json JSONB,
  winner TEXT,
  attempt SMALLINT,
  opens_at timestamptz,
  expires_at timestamptz,
  ready_deadline timestamptz,
  turn_at timestamptz,
  finished_at timestamptz,
  banks_json JSONB,
  last_move_at timestamptz,
  move_timings JSONB,
  reason TEXT,
  history_json JSONB,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_owner TEXT,
  lease_epoch BIGINT CHECK (lease_epoch IS NULL OR lease_epoch >= 0),
  lease_until timestamptz,
  extra JSONB,
  PRIMARY KEY (room_id, fixture_id),
  -- SOURCE TRUTH: src/tournament.js fixture() writes slots: [a,b] (an ARRAY whose members are
  -- either a player id or a {match,result} slot ref, in source order); the object-only gate
  -- rejected every fixture. Order and the object-or-id union are preserved verbatim in JSONB.
  CONSTRAINT fixtures_slots_json_array_ck CHECK (slots_json IS NULL OR jsonb_typeof(slots_json) = 'array'),
  CONSTRAINT fixtures_state_json_object_ck CHECK (state_json IS NULL OR jsonb_typeof(state_json) = 'object'),
  CONSTRAINT fixtures_mini_json_object_ck CHECK (mini_json IS NULL OR jsonb_typeof(mini_json) IN ('array', 'object')),
  CONSTRAINT fixtures_banks_json_object_ck CHECK (banks_json IS NULL OR jsonb_typeof(banks_json) = 'object'),
  CONSTRAINT fixtures_move_timings_array_ck CHECK (move_timings IS NULL OR jsonb_typeof(move_timings) = 'array'),
  CONSTRAINT fixtures_history_json_object_ck CHECK (history_json IS NULL OR jsonb_typeof(history_json) IN ('array', 'object')),
  CONSTRAINT fixtures_lease_tuple_ck CHECK (
    CASE WHEN lease_owner IS NULL THEN lease_epoch IS NULL AND lease_until IS NULL
         ELSE lease_epoch IS NOT NULL AND lease_until IS NOT NULL END),
  CONSTRAINT fixtures_extra_object_ck CHECK (extra IS NULL OR jsonb_typeof(extra) = 'object'),
  -- SOURCE TRUTH: src/tournament.js fixture() defaults round to 0 and bracket()/duel/knockout
  -- fixtures all start at round 0; group fixtures use 1-based rounds. Nonnegative is the
  -- source-faithful bound (>= 1 rejected every duel/bracket fixture).
  CONSTRAINT fixtures_round_ck CHECK ("round" IS NULL OR "round" >= 0),
  CONSTRAINT fixtures_attempt_ck CHECK (attempt IS NULL OR attempt >= 0)
);
CREATE INDEX IF NOT EXISTS fixtures_room_status_idx ON tournament.fixtures (room_id, status);
CREATE INDEX IF NOT EXISTS fixtures_status_turn_idx ON tournament.fixtures (status, turn_at);
CREATE INDEX IF NOT EXISTS fixtures_ready_deadline_idx ON tournament.fixtures (ready_deadline) WHERE status = 'READY';
CREATE INDEX IF NOT EXISTS fixtures_lease_until_idx ON tournament.fixtures (lease_until) WHERE status = 'PLAYING';

-- party_commands: id = JSON.stringify([actor,key]) => (actor,key) uniqueness domain.
-- SOURCE TRUTH: party_commands(id,fingerprint,response) has NO timestamp (server/rooms.js:17), so
-- committed_at is nullable to preserve genuine absence rather than a fabricated import now().
CREATE TABLE IF NOT EXISTS tournament.command_outcomes (
  actor_id TEXT NOT NULL,
  "key" TEXT NOT NULL CHECK ("key" ~ '^[A-Za-z0-9:_-]{1,160}$'),
  room_id TEXT,
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  response TEXT NOT NULL CHECK (response IS JSON),
  committed_at timestamptz,
  PRIMARY KEY (actor_id, "key")
);
CREATE INDEX IF NOT EXISTS command_outcomes_room_idx ON tournament.command_outcomes (room_id);
