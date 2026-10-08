-- runner: current-role
-- V5 P02 (V5-02-03) - worker_runtime least privilege (design section 7, A04).
-- The worker claims durable jobs/outbox, drives provider finalization/notification dedupe, the
-- privacy request state machine and support retention. It holds NOTHING on economy.* and no
-- match/tournament writes: economic/competitive effects are invoked as Core commands (design
-- section 7; ARCHITECTURE "no independent payout/grant writer"). worker_runtime MUST FAIL on
-- wallets, ledger, matches, rooms or receipts.
DO $$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = session_user), false)
     AND session_user <> 'migration_owner'
     AND NOT (COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = session_user), false)
              AND (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = session_user) THEN
    RAISE EXCEPTION 'GRANTS_REQUIRE_MIGRATION_OWNER' USING ERRCODE = '42501';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA ops, monetization, privacy, support, runtime TO worker_runtime;

-- Durable outbox: claim/update and retention delete.
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.outbox TO worker_runtime;

-- Provider finalization state machine + notification dedupe (Core is excluded above).
GRANT SELECT, INSERT, UPDATE ON monetization.store_finalize TO worker_runtime;
GRANT SELECT, INSERT, UPDATE ON monetization.store_notifications TO worker_runtime;

-- Privacy deletion workflow: worker owns state transitions and writes the permanent
-- deletion receipt; it never rewrites wallets itself (Core command owns economic effects).
GRANT SELECT, UPDATE ON privacy.requests TO worker_runtime;
GRANT SELECT, INSERT ON privacy.deletion_receipts TO worker_runtime;

-- Support retention: the ONLY role with DELETE on support.events.
GRANT SELECT, DELETE ON support.events TO worker_runtime;

-- Operational control read (maintenance gate).
GRANT SELECT ON runtime.controls, runtime.state TO worker_runtime;
