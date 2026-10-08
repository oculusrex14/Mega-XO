-- 0033: profile.profile_saves clean opaque-archive cutover (SourceGate scenario-B,
-- parent-proven: server/community-store.js save() ACCEPTS and persists escaped-NUL and
-- unpaired-surrogate bytes EXACTLY; the twin JSONB payload column raised 22P05/22P02 on those
-- legitimate source documents at INSERT time, and the jsonb-derived metadata checks (version
-- probe via ->>, records cardinality via jsonb_array_length, the 0025 equality CHECK) fail
-- with 22PXX on the same bytes — the JSON simple cast cannot be repurposed for these gates).
-- [D] parent ruling: payload_text is the ONLY authoritative opaque document. Retire the
-- redundant JSONB cache column and every CHECK derived from it (object root, version string,
-- records cardinality, payload/payload_text equality — dropped EXPLICITLY below, not by
-- cascade surprise). The DATABASE enforces exactly two raw facts:
--   (a) the document is a JSON OBJECT: payload_text IS JSON OBJECT — grammar validation
--       WITHOUT materialization, which (unlike jsonb input) admits escaped-NUL and
--       unpaired-surrogate byte sequences the source producer committed; and
--   (b) the raw byte cap: octet_length(payload_text) <= 262144 measured against the ORIGINAL
--       bytes (server/community-store.js:23-28 MAX_SAVE_BYTES before parse).
-- The "version"='3.2' gate and records<=2000 are the source producer validator's and the P03
-- loader's existing responsibility (JS side, before/at admission) — that layer split is the
-- contract; no jsonb fallback, cache, helper, regex special-case or duplicate copy is added,
-- and no SQL-side version/records check returns. revision and updated_at are unchanged.
ALTER TABLE profile.profile_saves DROP CONSTRAINT IF EXISTS profile_saves_payload_matches_text_ck;
ALTER TABLE profile.profile_saves DROP CONSTRAINT IF EXISTS profile_saves_records_limit_ck;
ALTER TABLE profile.profile_saves DROP CONSTRAINT IF EXISTS profile_saves_payload_version_ck;
ALTER TABLE profile.profile_saves DROP CONSTRAINT IF EXISTS profile_saves_payload_object_ck;
ALTER TABLE profile.profile_saves DROP COLUMN payload;
ALTER TABLE profile.profile_saves ADD CONSTRAINT profile_saves_payload_text_is_json_object_ck
  CHECK (payload_text IS JSON OBJECT);
