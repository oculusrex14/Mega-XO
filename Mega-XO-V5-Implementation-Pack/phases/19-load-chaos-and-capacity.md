# Phase 19 - Measure load, failure recovery and safe degradation

**Milestone:** V5.6 | **Mode:** EXECUTE | **Prerequisites:** P18

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-19-01 - Define forecast and measured load tiers

Use actual expected launch traffic or an explicit unknown-forecast benchmark plan; include API/auth/socket/game/tournament/worker mix.

**Verification:** Reported capacity is a measured envelope, not an invented customer forecast or assumed 10x guarantee.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-19-02 - Measure saturation and resource headroom

Increase controlled load with realistic history, track p95/p99, pools/locks/event loop/CPU/RAM/storage and queue age; protect co-hosted services.

**Verification:** Safe admission limits, bottlenecks and resource caps have reproducible evidence.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-19-03 - Run dependency and process chaos

Slow/stop PostgreSQL, wipe Redis, lose pubsub/network, kill Core/worker and duplicate/reorder callbacks/commands.

**Verification:** No permanent asset/result/identity loss or double effect; each degraded behavior matches the architecture.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-19-04 - Validate recovery and alert thresholds

Measure failover/reconnect/job catch-up and fresh backups after incidents; tune alerts before the observed saturation cliff.

**Verification:** Recovery targets are met or accurately revised with rationale and recorded remaining risk.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `capacity report`
- `chaos results`
- `launch envelope and alerts`
- `resource/connection budget`

## Exit gate

G19: sustainable capacity, latency, headroom and failure behavior are measured at realistic history sizes; no integrity failure under retries, loss or concurrency.

## Abort / rollback boundary

Stop isolated load clients, reduce admission and restore compatible V5 configuration; do not truncate real data or void games to hide overload.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
