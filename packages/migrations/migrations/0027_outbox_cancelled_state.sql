-- 0027: ops.outbox terminal 'cancelled' state (parent-proven P02 schema-compatibility fix).
-- SOURCE TRUTH (verified 2026-10-08 against the V4.1.2 production code paths, all three writers):
--   server/production/email-auth.js:36  (issue-time supersede):
--     UPDATE v4_outbox SET state='cancelled',payload=NULL WHERE state='queued'
--       AND id IN (SELECT id FROM email_challenges WHERE session=? AND email=? AND purpose=?)
--   server/production/email-auth.js:103 (email re-link supersede): same shape, WHERE state='queued'
--     AND id IN (SELECT id FROM email_challenges WHERE actor=?)
--   server/community-store.js:260 (tombstone cascade):
--     UPDATE v4_outbox SET state='cancelled',payload=NULL WHERE state IN ('queued','sending')
--       AND id IN (SELECT id FROM email_challenges WHERE session IN (...))
-- The frozen 0018 inline CHECK (auto-named outbox_state_check) excluded 'cancelled'; the parent
-- proved on native PG16 that the source insert shape (NULL payload + 'cancelled') fails 23514
-- outbox_state_check (transaction rolled back). payload is already nullable in 0018.
-- [D] Boring standard decision: widen the state domain with 'cancelled' as a terminal state.
-- outbox_sealed_payload_ck (payload NOT NULL only while queued|sending) is UNCHANGED and
-- therefore keeps the exact source invariant: a cancelled row must carry payload NULL.
-- Rebuild is name-preserving: the constraint remains outbox_state_check, so catalog conformance
-- (which records constraint names/columns) is provably unaffected by this step.
ALTER TABLE ops.outbox DROP CONSTRAINT IF EXISTS outbox_state_check;
ALTER TABLE ops.outbox ADD CONSTRAINT outbox_state_check
  CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'expired', 'cancelled'));
