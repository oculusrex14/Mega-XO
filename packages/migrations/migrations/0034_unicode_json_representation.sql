-- 0034: Unicode-safe minimal representation for the parent-proven source encoding gate.
-- PROVEN (parent bg203 all-cases Accepted+escaped on the actual source producers; native 2023
-- before-proof): region/room-name/player-name/kind/receipt_reason/op-keys carrying NUL or lone
-- surrogates are ACCEPTED AND ESCAPED at source (SQLite TEXT stores \u0000; unpaired surrogates
-- persist EXACT, LAN-guest name NUL exact with surrogate already replaced at SQLite bind);
-- native raw TEXT rejected NUL (22021) and SILENTLY replaced surrogate code units (INSERT
-- "succeeded" but code-unit round-trip FALSE); PG's JSON type + json_typeof round-tripped
-- scalars/documents BOTH exact, and canonical-encoded key TEXT passed IS JSON SCALAR +
-- json_typeof='string' both EXACT.
-- [D] parent contract: use the PG JSON datatype for the opaque Unicode-bearing fields (NOT
-- JSONB, and NO duplicate raw/encoded alias columns). The closed-ASCII gameplay JSONB columns
-- (quote_json, state_json, banks/slots/groups/seed/final_refs/mini/history_json, risk_actors,
-- result/response payloads) stay JSONB unchanged. Logical bounds remain the JS source/loader
-- validator layer (region 64, room name 48, player name 32, op key 160 units); SQL keeps only
-- the encoded physical caps sized for full escaping: 6n+2 bytes (386 / 290 / 194 / 962).
-- Consumer decode is a P03 ColumnCodec obligation: the driver returns JSON columns as native
-- JS values; canonical-encoded key TEXT requires JSON.parse after load. Existing values are
-- converted through to_json(text) / jsonb::json so prior ASCII data is preserved semantically;
-- json_typeof root gates are recreated NAME-PRESERVING for catalog conformance.
-- json_typeof/jsonb functions are never applied to decode opaque JSON beyond the root gates.

-- identity.actors.region -> JSON string scalar; JSON empty-string default; the old 64-char
-- TEXT cap moves to the JS layer (SQL keeps the 386-byte encoded ceiling).
-- The legacy inline CHECK (auto-named actors_region_check from the frozen 0004:8 declaration,
-- read off the catalog, not guessed) MUST be dropped BEFORE ALTER TYPE: ALTER COLUMN TYPE
-- re-validates every surviving CHECK expression against the new type, and length(json) does
-- not exist (native-proven 42883 in the parent's bg215 rerun at this statement).
ALTER TABLE identity.actors DROP CONSTRAINT IF EXISTS actors_region_check;
ALTER TABLE identity.actors ALTER COLUMN region DROP DEFAULT;
ALTER TABLE identity.actors ALTER COLUMN region TYPE JSON USING to_json(region);
ALTER TABLE identity.actors ALTER COLUMN region SET DEFAULT '""';
ALTER TABLE identity.actors ADD CONSTRAINT actors_region_json_string_ck
  CHECK (json_typeof(region) = 'string' AND octet_length(region::text) <= 386);

-- tournament.rooms.name / tournament.room_players.name -> JSON string scalar, nullable.
ALTER TABLE tournament.rooms ALTER COLUMN name TYPE JSON USING to_json(name);
ALTER TABLE tournament.rooms ADD CONSTRAINT rooms_name_json_string_ck
  CHECK (name IS NULL OR (json_typeof(name) = 'string' AND octet_length(name::text) <= 290));
ALTER TABLE tournament.room_players ALTER COLUMN name TYPE JSON USING to_json(name);
ALTER TABLE tournament.room_players ADD CONSTRAINT room_players_name_json_string_ck
  CHECK (name IS NULL OR (json_typeof(name) = 'string' AND octet_length(name::text) <= 194));

-- match.matches: kind -> JSON string scalar; receipt_reason -> JSON any value (the source
-- void-flow writes strings AND objects like {"note":...} AND null; the JSON type itself is the
-- validity admission, so NO CHECK is added); terms_json/receipt_json/extra -> JSON documents
-- with the root gates recreated name-preservingly around the type change.
ALTER TABLE match.matches DROP CONSTRAINT IF EXISTS matches_terms_json_object_ck;
ALTER TABLE match.matches DROP CONSTRAINT IF EXISTS matches_receipt_json_object_ck;
ALTER TABLE match.matches DROP CONSTRAINT IF EXISTS matches_extra_object_ck;
ALTER TABLE match.matches ALTER COLUMN kind TYPE JSON USING to_json(kind);
ALTER TABLE match.matches ALTER COLUMN receipt_reason TYPE JSON USING to_json(receipt_reason);
ALTER TABLE match.matches ALTER COLUMN terms_json TYPE JSON USING terms_json::json;
ALTER TABLE match.matches ALTER COLUMN receipt_json TYPE JSON USING receipt_json::json;
ALTER TABLE match.matches ALTER COLUMN extra TYPE JSON USING extra::json;
ALTER TABLE match.matches ADD CONSTRAINT matches_kind_json_string_ck
  CHECK (kind IS NULL OR json_typeof(kind) = 'string');
ALTER TABLE match.matches ADD CONSTRAINT matches_terms_json_object_ck
  CHECK (json_typeof(terms_json) = 'object');
ALTER TABLE match.matches ADD CONSTRAINT matches_receipt_json_object_ck
  CHECK (receipt_json IS NULL OR json_typeof(receipt_json) = 'object');
ALTER TABLE match.matches ADD CONSTRAINT matches_extra_object_ck
  CHECK (extra IS NULL OR json_typeof(extra) = 'object');

-- The five opaque extras are EXPLICIT APPROVED EXTENSIONS (design 5.6): JSON + root-object
-- gate, recreated name-preservingly. Closed-ASCII JSONB columns elsewhere are untouched.
ALTER TABLE tournament.rooms DROP CONSTRAINT IF EXISTS rooms_extra_object_ck;
ALTER TABLE tournament.rooms ALTER COLUMN extra TYPE JSON USING extra::json;
ALTER TABLE tournament.rooms ADD CONSTRAINT rooms_extra_object_ck
  CHECK (extra IS NULL OR json_typeof(extra) = 'object');
ALTER TABLE tournament.fixtures DROP CONSTRAINT IF EXISTS fixtures_extra_object_ck;
ALTER TABLE tournament.fixtures ALTER COLUMN extra TYPE JSON USING extra::json;
ALTER TABLE tournament.fixtures ADD CONSTRAINT fixtures_extra_object_ck
  CHECK (extra IS NULL OR json_typeof(extra) = 'object');
ALTER TABLE monetization.credits DROP CONSTRAINT IF EXISTS credits_extra_object_ck;
ALTER TABLE monetization.credits ALTER COLUMN extra TYPE JSON USING extra::json;
ALTER TABLE monetization.credits ADD CONSTRAINT credits_extra_object_ck
  CHECK (extra IS NULL OR json_typeof(extra) = 'object');
ALTER TABLE economy.actor_legacy_extra DROP CONSTRAINT IF EXISTS actor_legacy_extra_extra_check;
ALTER TABLE economy.actor_legacy_extra ALTER COLUMN extra TYPE JSON USING extra::json;
ALTER TABLE economy.actor_legacy_extra ADD CONSTRAINT actor_legacy_extra_extra_check
  CHECK (json_typeof(extra) = 'object');

-- Operation KEYS, ONLY the two families whose source guard is non-empty + <=160 units
-- (economy/party; see 0029 header): the TEXT primary-key column keeps its type but stores the
-- CANONICALIZATION IS UNCONDITIONAL and happens exactly once: no encoded representation can
-- pre-exist before this checksummed step, and a legitimate logical key may itself begin with a
-- quote - any detection heuristic would mis-skip it. No raw/encoded dual aliases. The CHECK
-- uses a CASE guard so malformed non-JSON text signals 23514 (not a 22P02 cast failure), per
-- the 0006/0012 precedent; encoded cap 962 = 6*160+2 supports every legitimate 160-unit key.
-- social/monetization/move key families keep their ASCII grammar checks UNCHANGED.
ALTER TABLE economy.command_outcomes DROP CONSTRAINT IF EXISTS command_outcomes_key_check;
UPDATE economy.command_outcomes SET "key" = to_json("key")::text;
-- json_typeof has no text overload and TEXT has no implicit cast to json (native-proven):
-- the guarded THEN must cast the encoded key explicitly.
ALTER TABLE economy.command_outcomes ADD CONSTRAINT command_outcomes_key_check CHECK (
  CASE WHEN "key" IS JSON SCALAR
       THEN json_typeof("key"::json) = 'string' AND "key" <> '""' AND octet_length("key") <= 962
       ELSE false END);
ALTER TABLE tournament.command_outcomes DROP CONSTRAINT IF EXISTS command_outcomes_key_check;
UPDATE tournament.command_outcomes SET "key" = to_json("key")::text;
ALTER TABLE tournament.command_outcomes ADD CONSTRAINT command_outcomes_key_check CHECK (
  CASE WHEN "key" IS JSON SCALAR
       THEN json_typeof("key"::json) = 'string' AND "key" <> '""' AND octet_length("key") <= 962
       ELSE false END);
