-- runner: current-role
-- Sol review R5 (2026-10-20): the powers lane issues undo/hint reward tickets
-- (packages/services/commerce.js admits 'credits','boost','undo','hint'), but the 0014
-- CHECK only allowed credits/boost, so every eligible power-ad issuance failed with a
-- PostgreSQL CHECK violation before any ad could settle. Forward-only expansion: existing
-- rows keep their kind, the two power kinds are added, nothing is dropped or rewritten.
ALTER TABLE monetization.reward_tickets DROP CONSTRAINT reward_tickets_kind_check;
ALTER TABLE monetization.reward_tickets ADD CONSTRAINT reward_tickets_kind_check
  CHECK (kind IN ('credits', 'boost', 'undo', 'hint'));
