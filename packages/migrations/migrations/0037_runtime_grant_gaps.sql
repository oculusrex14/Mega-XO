-- runner: current-role
-- 0037: close three runtime-grant gaps found by executing the P04 repository port against the real
-- schema. Each is a WRITE that an existing V4 producer performs and that no runtime role can perform
-- under the 0020-0023 grants, so the V5 parity path could not work without either the grant or a
-- privileged workaround (which is forbidden). Evidence: parent probes on the migrated target show
--   api_runtime: identity.eligibility INSERT/UPDATE = false (column grants are SELECT only; core has
--     column-UPDATE on suspended/security_hold only, which cannot write the verified flag)
--   api_runtime: identity.email_credential_versions INSERT/UPDATE = false
--   worker_runtime: ops.rate_buckets INSERT/UPDATE = false
-- Additive only: no existing grant is revoked here, no column is added or retyped, and the runtime
-- identities still hold no DDL, no DELETE on permanent tables and no economic write outside theirs.
-- The additions are the minimum the named producer needs and nothing more:
--   * identity.eligibility INSERT + the verified column UPDATE: server/community-store.js creates the
--     eligibility row at signup and stamps verified when email verification completes. The UPDATE is
--     COLUMN-LEVEL (verified only) so api_runtime still cannot clear a suspension or a security hold,
--     which remains Core-owned through 0021's suspended/security_hold column grant.
--   * identity.email_credential_versions INSERT + DELETE: server/production/email-auth.js:39 writes the
--     stale-credential stamp when a challenge is created and the maintenance sweep deletes versions
--     whose challenge is gone (server/community-store.js:265, server/production/main.js:74). This is a
--     transient guard table keyed to a challenge that itself expires, not permanent state.
--   * ops.rate_buckets INSERT + UPDATE: server/production/mail-outbox.js:8,37 upserts the durable
--     mail-budget:<period> spend counters from the worker, and cleanup() deletes expired buckets
--     (:82). DELETE is deliberately NOT granted: expiry is a retention concern and 0022 already owns
--     the worker retention surface; leaving DELETE out keeps the blast radius at upsert-only.
-- A matching conformance/privilege expectation update is required in the same commit.

GRANT INSERT ON identity.eligibility TO api_runtime;
GRANT UPDATE (verified) ON identity.eligibility TO api_runtime;

GRANT INSERT, DELETE ON identity.email_credential_versions TO api_runtime;

GRANT INSERT, UPDATE ON ops.rate_buckets TO worker_runtime;
