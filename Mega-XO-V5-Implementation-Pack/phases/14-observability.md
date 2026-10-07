# Phase 14 - Unify traces, metrics and alert delivery

**Milestone:** V5.5 | **Mode:** EXECUTE | **Prerequisites:** P13

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-14-01 - Propagate sanitized request/trace/support identity

Carry stable safe diagnostics through API/Core/database/outbox/worker, with explicit redaction and bounded cardinality.

**Verification:** A staged failure can be followed end-to-end without raw personal/provider/session data.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-14-02 - Instrument role-specific health and metrics

Separate live/ready/ops status and measure API, socket, transaction, queue, job, provider, host and backup health.

**Verification:** Backup freshness and worker backlog affect operational health appropriately, not just process liveness.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-14-03 - Configure actionable alerts

Reuse existing monitors/mail delivery and add V5 thresholds tied to measured limits and runbooks.

**Verification:** Forced staging dependency failure and recovery yield verified alerts at intended destinations.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-14-04 - Document operational triage

Provide private support lookup, component failure localization and alert response steps linked to release IDs.

**Verification:** Operator can investigate a real test support code and determine affected actor/action without public admin exposure.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `cross-service telemetry`
- `private operational dashboards`
- `alert/runbook mappings`
- `failure/recovery delivery evidence`

## Exit gate

G14: one player-safe support ID can be traced across API/Core/DB/worker without exposing secrets; critical failure and recovery alerts actually arrive.

## Abort / rollback boundary

Telemetry failures must not corrupt business transactions; reduce sampling/log volume rather than expose raw data or disable authority checks.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
