# Phase 7 - Make matchmaking safe across multiple processes

**Milestone:** V5.3 | **Mode:** EXECUTE | **Prerequisites:** P06

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-07-01 - Port existing queue policy unchanged

Reuse skill expansion, placement/recent-opponent rules, mode, anti-collusion and public tournament cohort behavior; preserve when entry is actually charged.

**Verification:** Baseline matching fixtures and product limits remain identical.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-07-02 - Implement join/cancel/heartbeat/expire

Version and deduplicate queue operations across devices; maintain bounded candidate indices and recover abandoned leases.

**Verification:** Duplicate joins, cancellation races and dead clients do not create phantom paid entries.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-07-03 - Commit assignments transactionally

Recheck actors/eligibility/occupancy/rating/terms/balance in PostgreSQL, create match/reservation under constraints, then notify clients.

**Verification:** Two matchers racing the same actors create at most one compatible assignment and one financial effect.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-07-04 - Exercise distributed recovery

Kill a matcher between Redis claim and database commit, wipe Redis after assignment, race direct invitations and tournaments with queue joins.

**Verification:** Every actor is recoverably queued, assigned or explicitly canceled; no inconsistent permanent state.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `distributed queue adapter`
- `durable occupancy/assignment constraints`
- `matcher recovery tests`

## Exit gate

G07: multiple matchers cannot double-assign, double-charge or lose committed entrants; current matching and charge timing remain unchanged.

## Abort / rollback boundary

Stop new V5 matcher work and rebuild ephemeral queues from durable assignments. Never refund/recharge automatically without the existing transaction policy.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
