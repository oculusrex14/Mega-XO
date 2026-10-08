-- V5 P02 (V5-02-02) - practice archive (design section 2.10). The archive is revisioned and
-- never authoritative for competitive assets; the sanitizer keeps the allowed-root allow-list.
-- Bounds mirror the verified sanitizer: version 3.2, records array <= 2000, <= 256 KiB.
-- SOURCE TRUTH: the 256 KiB admission bound is measured on the ORIGINAL source text -
-- server/community-store.js:24 rejects Buffer.byteLength(JSON.stringify(value)) > MAX_SAVE_BYTES
-- before any JSON parsing - so the exact source payload text is retained and bounded here.
-- JSONB's normalized rendering must NOT be the source bound: it writes arrays as "[1, 2]"
-- (comma + space) and inflates a compact legacy payload past 256 KiB, rejecting a save V4
-- accepted. payload JSONB is kept for the bounded runtime queries (root/records checks);
-- payload_text is the verbatim source representation and carries the legacy byte limit.
-- actor_id is a soft TEXT reference (design 5.5: profile.* is outside the hard-FK live set).
CREATE TABLE IF NOT EXISTS profile.profile_saves (
  actor_id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  payload_text TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT profile_saves_payload_object_ck CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT profile_saves_payload_version_ck CHECK (payload ->> 'version' = '3.2'),
  -- CASE guards jsonb_array_length against non-array values (expression order is not
  -- guaranteed by the planner, so a plain AND could raise instead of signalling 23514).
  CONSTRAINT profile_saves_records_limit_ck CHECK (
    CASE WHEN jsonb_typeof(payload -> 'records') = 'array'
         THEN jsonb_array_length(payload -> 'records') <= 2000 ELSE false END),
  CONSTRAINT profile_saves_payload_text_size_ck CHECK (octet_length(payload_text) <= 262144)
);
