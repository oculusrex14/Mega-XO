-- 0028: tournament.room_players soft actor reference + source-order ordinal (SourceGate M1,
-- parent-proven). Aligns 0013 with design 5.5 ("hard FKs only on live aggregate tables").
-- SOURCE TRUTH (agent://SourceConstraintGate/report M1, citations verified against the repo):
--   * room_players.actor_id arrived from party_rooms.players[].id (server/rooms.js:17 via
--     src/tournament.js:16-19 join()), where the id is ANY principal the caller passed:
--     LAN guests mint their actor in server/rooms.js:23 guest() (crypto.randomUUID stored ONLY
--     in the quarantined party_guests table - never materialised as identity.actors per
--     tools/v5-migration/mapping.json:75,87,118-122 and the 0013 header "NOT migrated"), and
--     server/rooms.js:74-75,82 join rooms with it; account deletion (server/community-store.js
--     239-272) rewrites matches/journal/receipts/reports/season/history to deleted_<32hex> but
--     NEVER touches party_rooms, and blocks deletion only for ACTIVE rooms
--     (server/community-server.js:20 isDeletionBusy over packages/db/repositories.js:102).
--   * The accepted fixture proves the counterexample class: tools/v5-migration/fixtures/
--     build-synthetic-source.js:743-749 'LAN fixture duel' has two party_guests actors as its
--     only players, and rule C9 (:955-963) whitelists tombstones/guests/'system' for
--     room.players[].id - importing raises 23503 room_players_actor_id_fkey today.
--   * Sibling precedent is already soft for the same reason: rooms.owner_id (server/rooms.js:80
--     'service'), escrow_contributions.actor_id (0013:95-99), match.participants.actor_id
--     (0012:78-85), rooms.ranking TEXT[].
-- [D] parent ruling: drop ONLY the actor FK; the room FK (true aggregate membership) and the PK
-- stay. Guests remain quarantined; tombstoned and guest members import verbatim.
-- ORDER RETENTION: tools/v5-migration/mapping.json:534 declares room players orderMeaningful
-- (join.push sequence at src/tournament.js:16-19; start's deterministic shuffle consumes array
-- order via seed/bracket), so the importer writes an explicit ordinal per array position.
-- [D] NO fabricated ordinal and NO backfill: the column is INTEGER NOT NULL without a DEFAULT so
-- any unexpected pre-existing row fails LOUDLY (the restored target holds 0 room_players rows);
-- legitimate population arrives only from the P03 importer writing each array index.
ALTER TABLE tournament.room_players DROP CONSTRAINT room_players_actor_id_fkey;
ALTER TABLE tournament.room_players ADD COLUMN ordinal INTEGER NOT NULL;
ALTER TABLE tournament.room_players ADD CONSTRAINT room_players_ordinal_check CHECK (ordinal >= 0);
ALTER TABLE tournament.room_players ADD CONSTRAINT room_players_room_id_ordinal_key UNIQUE (room_id, ordinal);
