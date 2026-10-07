# Phase 18 - Complete the dedicated V5 staging platform

**Milestone:** V5.6 | **Mode:** EXECUTE | **Prerequisites:** P17

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 7](../specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-18-01 - Verify full environment isolation

Audit Vercel/Neon/Redis/Core/worker/callback/secrets/endpoints against the environment inventory and outbound-effects controls.

**Verification:** Staging cannot read/write production or send copied users real provider/email events.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-18-02 - Run account/social/save and cross-service journeys

Create/login/link/recover, profile edit, friend/block/report, cloud save, session revoke/export/delete through existing client flows.

**Verification:** Same actor and privacy semantics hold across API/Core and browser/native-style test clients.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-18-03 - Run economic and game journeys

Exercise ranked/casual/direct/tournament entry/play/settlement/refund, receipts/SSV fixtures, reconnect and restart.

**Verification:** Per-actor assets/ratings/results agree across all components; no duplicate effect.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-18-04 - Run visual and behavioral parity

Compare four-theme screenshots and approved game/invariant fixtures; record only justified native/platform exceptions.

**Verification:** No unapproved layout, Crown utility, balance, archived-feature or ad-placement changes.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-18-05 - Rehearse final transfer and both recovery classes

Execute freeze/import/reconcile/read-only stage/first-write activation on copies; abort before write and recover after write with PostgreSQL authority.

**Verification:** Evidence proves no dual writer and no blind SQLite rollback after new application effects.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `integrated V5 staging manifest`
- `end-to-end evidence`
- `reconciliation and cutover rehearsal`
- `UI/gameplay parity report`

## Exit gate

G18: all components function together on isolated realistic data; retained browser/client-style flows and rehearsed migration/abort paths pass without affecting V4.

## Abort / rollback boundary

Only V5 staging is reset/redeployed. Production is never stopped to free staging ports or used as a test database.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
