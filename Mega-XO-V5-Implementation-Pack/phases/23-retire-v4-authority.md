# Phase 23 - Retire obsolete V4 authority while retaining recovery evidence

**Milestone:** V5.9 | **Mode:** EXECUTE | **Prerequisites:** P22

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Specification 7](../specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-23-01 - Permanently fence obsolete writers and schedulers

Remove active V4 app mutation routes/jobs/restart paths, retain static/compatibility roles only if needed and label SQLite read-only archive.

**Verification:** Restart/host reboot cannot revive an independent V4 authority.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-23-02 - Retain required artifacts and update operations

Preserve immutable release tags, encrypted backups, migration manifests/audit keys and source history according to policy; update DNS/monitor/runbook inventory.

**Verification:** Recovery evidence is retrievable and old alarms or scripts do not target retired authority incorrectly.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-23-03 - Retire compatibility only from usage/version evidence

Keep old callbacks/client endpoints while supported users/providers need them; document sunset criteria and remove unused shims later.

**Verification:** No supported client or provider notification is broken merely to claim cleanup complete.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-23-04 - Publish final delivery and residual-item report

Report production/native states, scope exclusions, hashes/URLs, parity and recovery evidence, plus precise unresolved external/provider items.

**Verification:** Code-complete, device-verified, submitted, approved and enabled statuses are not conflated.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `V4 writer retirement record`
- `archived SQLite/tag/migration evidence`
- `updated runbooks/monitors`
- `compatibility retirement criteria`

## Exit gate

G23: no production service depends on V4 SQLite. Required history/backups and supported-client/provider compatibility remain available under policy.

## Abort / rollback boundary

Retirement does not authorize reinstating a stale V4 writer. Restore only documented compatible serving components while PostgreSQL remains authoritative.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
