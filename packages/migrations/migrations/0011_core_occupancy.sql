-- V5 P02 (V5-02-02) - the single active aggregate per actor (design section 2.2 activeMatch,
-- 3.7). The PK is the invariant: one claimed match OR tournament per actor. Legacy text forms
-- ('tournament:<id>') split into kind/ref_id; the raw legacy string lives only in
-- economy.actor_legacy_extra during P03 verification. Sorted-actor FOR UPDATE on this PK plus
-- economy.wallets_pkey is the documented global lock order (design 3.7 / spec 01 section 3).
CREATE TABLE IF NOT EXISTS core.actor_occupancy (
  actor_id TEXT PRIMARY KEY REFERENCES identity.actors (actor_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('match', 'tournament')),
  ref_id TEXT NOT NULL,
  claimed_at timestamptz NOT NULL,
  CONSTRAINT actor_occupancy_ref_id_grammar_ck CHECK (ref_id ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$')
);
CREATE INDEX IF NOT EXISTS actor_occupancy_kind_ref_idx ON core.actor_occupancy (kind, ref_id);
