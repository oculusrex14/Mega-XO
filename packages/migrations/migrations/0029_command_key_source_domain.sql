-- 0029: economy/tournament operation-key domain must equal the REAL source validators, not the
-- generator-derived ASCII grammar (SourceGate M3, parent-proven: both schemas raised 23514
-- command_outcomes_key_check on a space-containing legitimate key).
-- SOURCE TRUTH (agent://SourceConstraintGate/report M3):
--   * economy path: server/http.js:38,57 -> packages/contracts/http-guards.js:58-63
--     truthyOperationKey (header merely truthy) -> server/economy-store.js:14-15 ->
--     packages/contracts/invocation.js:16-21 validateInvocation: typeof key === 'string' && key
--     && key.length <= 160. NOTHING else is enforced before the row commits.
--   * party path: server/party-http.js:24 -> http-guards.js:46-55 rawOperationKey (non-empty +
--     length <= 160) -> server/rooms.js RoomStore.run length-only guard -> party_commands
--     (id = JSON.stringify([actor,key])).
--   * tools/v5-migration/reader.js:163-169,202-205 keeps the exact text (grammarDrift
--     disposition N), so the target's stricter CHECK turned committed values such as
--     "party setup v1", "invite#7", "k/1", "ref-1" variants into 23514 at import.
-- [D] parent ruling: replace BOTH grammar CHECKs with the true source domain length(key) IN
-- 1..160, preserving the constraint NAME (presence-based catalog conformance keeps recording
-- command_outcomes_key_check). The three families whose CHECKs mirror real validators are
-- UNTOUCHED and keep their ASCII guards: social safeKey (server/community-store.js:21 vs
-- 0007:41-49), monetization idOK (server/monetization-store.js:7 vs 0014:54-61), match moves
-- validId (src/authority.js:89 vs 0012:100-106). Uniqueness remains the PK (actor_id,key).
ALTER TABLE economy.command_outcomes DROP CONSTRAINT IF EXISTS command_outcomes_key_check;
-- NOTE (pre-apply amendment, 0034): the FINAL admitted domain for BOTH key CHECKs installed
-- below is SUPERSEDED by 0034's canonical-JSON-string form (CASE-guarded json_typeof='string',
-- non-empty, encoded octet cap 962) with the UPDATE-to-canonical re-encoding. This file stays
-- as the historical length-domain step (source-validator parity at the time of authoring); the
-- logical exact-160-unit bound permanently lives in the JS source/loader validator.
ALTER TABLE economy.command_outcomes ADD CONSTRAINT command_outcomes_key_check
  CHECK (length("key") >= 1 AND length("key") <= 160);
ALTER TABLE tournament.command_outcomes DROP CONSTRAINT IF EXISTS command_outcomes_key_check;
ALTER TABLE tournament.command_outcomes ADD CONSTRAINT command_outcomes_key_check
  CHECK (length("key") >= 1 AND length("key") <= 160);
