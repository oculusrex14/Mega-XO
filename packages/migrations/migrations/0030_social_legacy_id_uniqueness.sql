-- 0030: preserve the social legacy combined-id uniqueness domain (SourceGate M4, parent-proven:
-- the social pair accepted one combined legacy id as two legal target rows).
-- SOURCE TRUTH (agent://SourceConstraintGate/report M4): server/community-store.js:210 stores
-- social_operations.id = actor + ':' + key (packages/contracts/mapping.json:93 records the same
-- encoding; deletion sweeps use WHERE id LIKE actor || ':%'), so the SOURCE uniqueness domain
-- is the CONCATENATION. The target PK (actor_id,"key") (0007:41-49) permits the pairs
-- ('u_1:x','y') and ('u_1','x:y') to coexist although both encode legacy id 'u_1:x:y', which the
-- source could never hold - and the preserved actor grammar (src/authority.js:7 validId, mirrored
-- by 0004:8-11) explicitly admits ':' after the first character (design 5.1 "u_<uuid> and legacy
-- variants").
-- [D] parent ruling: additive UNIQUE INDEX over the concatenation, NO PK rewrite; the split
-- convention itself is a documented P03 importer obligation (reader.js:179-182 re-splits without
-- an actor column): the importer must preserve the legacy combined domain and REPORT ambiguous
-- splits, never guess. A first-':' split relocates colons from actor into key - report-only.
-- The index expression is parenthesized per CREATE INDEX's index_expr grammar; a bare ||
-- chain raises 42601 (proven on native PG16 in the parent's 35-file run at this file).
CREATE UNIQUE INDEX IF NOT EXISTS social_command_outcomes_legacy_id_uniq
  ON social.command_outcomes ((actor_id || ':' || "key"));
