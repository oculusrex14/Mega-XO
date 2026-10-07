# Phase 21 - New megaxo.online website and browser product: deferred

**Milestone:** V5.8 | **Mode:** DEFERRED_BY_OWNER | **Prerequisites:** none

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 7](../specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

Do not implement the original website tasks in this run. Keep this phase explicitly deferred, not falsely completed. API/origin/callback/domain/association foundations are covered elsewhere. Phase 22 depends on Phase 20, not this phase.

## Required outputs

- `explicit owner deferral record`
- `future presentation integration contract`

## Exit gate

DEFERRED_BY_OWNER: no new website/browser product is built. Its infrastructure obligations are fulfilled in Phases 5, 11 and 20 and verified in 18/20.

## Abort / rollback boundary

No product deployment to roll back. Keep dormant presentation boundary and retained-client compatibility.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
