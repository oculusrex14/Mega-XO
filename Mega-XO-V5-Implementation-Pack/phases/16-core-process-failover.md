# Phase 16 - Add Core process redundancy and rolling drain

**Milestone:** V5.6 | **Mode:** EXECUTE | **Prerequisites:** P15

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-16-01 - Deploy two independently managed Core processes

Provision bounded A/B instances with shared Neon/Redis, separate private health endpoints and compatible images.

**Verification:** Both can accept authorized clients without conflicting ownership or shared mutable memory.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-16-02 - Implement health-aware routing and drain

Use the single safe ingress, no new sessions on draining nodes, bounded socket shutdown and reconnect recovery.

**Verification:** Rolling update works without simultaneous service stop; sticky sessions are optional for correctness.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-16-03 - Prove in-flight recovery

Kill A during a live move/tournament and reconnect through B; include post-commit/pre-publish failure and session revocation.

**Verification:** No duplicated settlement, lost acknowledged revision or reset turn deadline.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-16-04 - Document failure domains and measured limits

Distinguish process failure from Oracle/edge/zone outage; specify what separate-host expansion would require if justified.

**Verification:** No claim of host HA when both instances share one VPS or public edge.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `Core A/B deployment`
- `WebSocket-capable ingress health/drain config`
- `rolling deployment/failover evidence`
- `host-HA limitation record`

## Exit gate

G16: losing one Core process does not destroy a valid committed match; clients reconnect to the surviving process. Same-host deployment is accurately labeled process HA.

## Abort / rollback boundary

Drain/revert one Core at a time to a compatible image; retain PostgreSQL authority and do not move all traffic to a failed process.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
