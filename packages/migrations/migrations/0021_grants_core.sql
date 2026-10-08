-- runner: current-role
-- V5 P02 (V5-02-03) - core_runtime least privilege (design section 7, A04).
-- Game Core is the SOLE competitive/economic mutation authority (ARCHITECTURE ownership
-- register). core_runtime MUST FAIL: credential export (no SELECT on identity credential/challenge
-- secret tables at all), worker-owned sweeps (store_finalize/store_notifications), any DDL,
-- direct audit mutation, and UPDATE/DELETE on the append-only economy.ledger.
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

GRANT USAGE ON SCHEMA economy, core, match, tournament, monetization, season, cosmetics, identity, runtime TO core_runtime;

-- Full DML on the economic/competitive domain, then explicit REVOKEs for the permanent tables:
-- PostgreSQL GRANTs accumulate per grantee, so the carve-outs MUST be revocations, not narrower
-- grants. economy.ledger is append-only for every runtime role; season.weekly_payouts and the
-- store permanence tables (receipts/store_bindings/store_revocations, 0020) allow no DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA economy, core, match, tournament, season, cosmetics TO core_runtime;
REVOKE UPDATE, DELETE ON economy.ledger FROM core_runtime;
REVOKE DELETE ON season.weekly_payouts FROM core_runtime;

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA economy, monetization, audit, ops, identity TO core_runtime;

GRANT SELECT, INSERT, UPDATE ON monetization.receipts, monetization.store_bindings,
  monetization.store_revocations TO core_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON monetization.credits, monetization.redeemed_frames,
  monetization.boosts, monetization.reward_daily, monetization.command_outcomes,
  monetization.reward_tickets, monetization.casual_rewards, monetization.reward_events,
  monetization.ad_ticket_context TO core_runtime;
-- Worker-owned sweeps stay closed to Core (design 2.10/7): store_finalize, store_notifications.

-- Eligibility and display facts: read actors/eligibility/profiles; column-level UPDATE for
-- the Core-owned safety flags only.
GRANT SELECT ON identity.actors, identity.eligibility, identity.profiles TO core_runtime;
GRANT UPDATE (suspended, security_hold) ON identity.eligibility TO core_runtime;

-- Operational control read (maintenance gate).
GRANT SELECT ON runtime.controls, runtime.state TO core_runtime;
