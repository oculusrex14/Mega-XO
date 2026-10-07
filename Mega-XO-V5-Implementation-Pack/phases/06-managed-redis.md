# Phase 6 - Introduce managed ephemeral coordination

**Milestone:** V5.3 | **Mode:** EXECUTE | **Prerequisites:** P05

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-06-01 - Select and provision the actual managed service

Validate region, access, plan, TCP/TLS/pubsub/Lua/TTL support and quotas; separate production and staging.

**Verification:** Provider IDs and command compatibility/load evidence recorded; no unclaimed temporary or same-host production replacement.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-06-02 - Implement namespaced bounded primitives

Provide tested presence/heartbeat, candidate queue, cache, rate-budget and routing operations with explicit TTLs and key versions.

**Verification:** No unbounded immortal keys, cross-environment credential access or client-visible Redis secrets.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-06-03 - Remove local-only operational state

Move distributed presence/cache/rate coordination from local Maps/SQLite while retaining PostgreSQL security/assignment truth.

**Verification:** Two API/Core processes observe consistent temporary state without owning permanent assets in Redis.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-06-04 - Test full wipe and dependency failure

Delete only staging Redis, restart subscriptions and recover from PostgreSQL/client rejoin; measure safe fallback/rate behavior.

**Verification:** Wallet/rank/purchases unchanged; no permanently stuck paid occupancy or unlimited auth retries.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `managed Redis environment inventory`
- `packages/redis adapter`
- `key/TTL/limits contract`
- `loss/degradation tests`

## Exit gate

G06: Redis loss is temporary disruption only; all player assets/results/identity remain durable and queues/caches recover.

## Abort / rollback boundary

V5 staging alone changes; disable/rebuild ephemera without database rollback. Managed service removal never deletes durable player state.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
