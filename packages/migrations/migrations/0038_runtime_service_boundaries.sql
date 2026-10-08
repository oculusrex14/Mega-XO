-- runner: current-role
-- P04: real service boot and transaction producers need these narrow capabilities.
-- Migration metadata is read-only. Core reads social facts for the EXISTING friendship/block
-- eligibility rules but cannot mutate the graph. API/Core produce outbox rows; only the worker
-- owns delivery, retries and expiration. No runtime role gains DDL or wallet-write delegation.

GRANT USAGE ON SCHEMA meta TO api_runtime, core_runtime, worker_runtime;
GRANT SELECT ON meta.migrations TO api_runtime, core_runtime, worker_runtime;

GRANT USAGE ON SCHEMA social, ops TO core_runtime;
GRANT SELECT ON social.friendships, social.friend_requests, social.blocks TO core_runtime;

GRANT INSERT ON ops.outbox TO api_runtime, core_runtime;
GRANT SELECT (outbox_id) ON ops.outbox TO api_runtime, core_runtime;

-- Account unlink is API-owned; last-method/recent-auth guards remain in the account service.
GRANT DELETE ON identity.identities, identity.email_credentials, profile.profile_saves TO api_runtime;
