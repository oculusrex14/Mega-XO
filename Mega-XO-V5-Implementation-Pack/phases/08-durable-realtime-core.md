# Phase 8 - Deploy revision-based durable realtime Game Core

**Milestone:** V5.4 | **Mode:** EXECUTE | **Prerequisites:** P07

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-08-01 - Implement authenticated WSS transport

Expose staging realtime through nonconflicting ingress, redeem one-use tickets, enforce subscription membership, message bounds and safe errors.

**Verification:** Unauthorized, expired, oversized and cross-actor subscription attempts are rejected without leaks.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-08-02 - Implement command revision transactions

Validate existing move rules, dedupe operation before stale-revision checks, lock/compare state and commit outcome/outbox atomically.

**Verification:** Lost-response retry returns the prior result; altered-payload reuse conflicts and rollback is complete.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-08-03 - Implement durable clocks and scheduled expiry

Persist absolute deadlines and revision-bound timeout identity; serialize move-vs-timeout races using a tested clock convention.

**Verification:** Reconnect/restart never extends the turn; old timer claims cannot settle a newer revision.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-08-04 - Implement snapshot/delta recovery and polling

Client resumes from last acknowledged revision, accepts bounded deltas or current snapshot; preserve HTTP command/snapshot compatibility.

**Verification:** Missed/out-of-order pubsub and socket disconnects recover without reapplying moves.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-08-05 - Remove memory-authoritative restart recovery

Replace V4 startup void logic on the V5 runtime with loading durable active state. Add drain, slow-client handling and multi-process routing.

**Verification:** Kill Core before/after commit/publish/response; latest committed game resumes on the surviving process.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `apps/game-core realtime service`
- `durable command/deadline/outbox implementation`
- `HTTP fallback`
- `reconnect/load tests`

## Exit gate

G08: acknowledged moves survive process death and resume from committed state on another process; no reset deadline, duplicate effect or split match.

## Abort / rollback boundary

Drain staging sockets and deploy a schema-compatible previous Core. Database state is retained; no restart-void fallback for valid durable matches.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
