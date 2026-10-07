# Phase 24 - Set scaling triggers and act only on measured demand

**Milestone:** V5.10 | **Mode:** MEASUREMENT_GATED | **Prerequisites:** P23

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-24-01 - Publish baseline and review cadence

Carry forward Phase 19 capacity and production telemetry, identify query/pool/Core/worker/Redis bottlenecks and owner review cadence.

**Verification:** Metrics and unknowns are explicit; no fabricated real-user traffic is substituted for benchmarks.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-24-02 - Define trigger-specific scaling runbooks

For each bottleneck specify metric/duration threshold, smallest capacity/index/read-model action, cost, validation and rollback. Include separate-host Core/ingress design when reliability warrants it.

**Verification:** No generic Kubernetes/Kafka or global multi-primary plan; each action has a measured reason.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-24-03 - Apply extra capacity only when justified

Execute a trigger-backed change only after the threshold/cost/compatibility evidence exists; otherwise record NOT_TRIGGERED and retain the tested initial architecture.

**Verification:** No speculative resource creation and no false claim that host HA exists before a separate failure domain is tested.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `capacity baseline and operating envelope`
- `scale trigger/cost/rollback plan`
- `postlaunch review schedule`

## Exit gate

G24: measured baseline and explicit scaling triggers are delivered. Additional infrastructure is conditional on evidence, not required speculative work.

## Abort / rollback boundary

Scale down only within the measured safe envelope and compatible data/region ownership; never introduce multi-primary currency writers.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
