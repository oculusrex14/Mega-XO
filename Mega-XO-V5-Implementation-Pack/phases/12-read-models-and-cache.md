# Phase 12 - Introduce safe read models and caching

**Milestone:** V5.5 | **Mode:** EXECUTE | **Prerequisites:** P11

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-12-01 - Classify every read and sensitivity

Assign strong-current, short-TTL, event-invalidated or public-cache behavior; explicitly exclude sessions/private wallet/account responses from shared caching.

**Verification:** Route manifest contains cache/privacy rules and stale-data tolerance for every read.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-12-02 - Build versioned projections and indexes

Materialize authorized public stats/leaderboards/history from committed events; index measured query paths without changing publication/rank rules.

**Verification:** Projection replay gives identical results and old events cannot overwrite newer versions.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-12-03 - Add bounded cache invalidation

Implement cache keys, TTLs, version handling and rebuild/fallback; propagate only sanitized public content to CDN caches.

**Verification:** Private response leakage tests pass; clearing all caches leaves correct gameplay and balances.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-12-04 - Measure actual read-load reduction

Compare query/latency/pool load with baseline under representative history size and mixed traffic.

**Verification:** Benefits and staleness observed are recorded, not assumed from installing a cache.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `versioned read projections`
- `cache classification/invalidation policy`
- `privacy/staleness tests`

## Exit gate

G12: cache/projection loss affects speed, not correctness; private state is never shared-cached or used stale for economic authorization.

## Abort / rollback boundary

Disable caches and serve correct primary reads; preserve source-of-truth state and rebuild projections.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
