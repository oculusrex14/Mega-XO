# Phase 9 - Make tournament and lobby execution durable

**Milestone:** V5.4 | **Mode:** EXECUTE | **Prerequisites:** P08

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-09-01 - Persist complete room and fixture state

Migrate ownership/code/roster/readiness/rules/fixtures/clocks/ranking/revisions/quotes/contributions/settlement records.

**Verification:** Full room snapshot survives service restart with no missing ownership or financial state.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-09-02 - Preserve user lifecycle behavior

Retain approved host-leave CANCELLED behavior, allowed transfer/pause/leave paths, public cohort/entry/payout rules and normal-Elo independence.

**Verification:** Existing party/tournament UI and rule fixtures remain unchanged.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-09-03 - Implement fenced timer and progression claims

Use transactional claims and current-fence completion for due fixtures/timeouts across workers; revalidate state before advancing.

**Verification:** A stale worker cannot act after a new owner has progressed the tournament.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-09-04 - Make settlement/refund indivisible

Lock room and affected actors/wallets in consistent order; record unique settlement and all ledger/escrow/record effects in one transaction.

**Verification:** Payout/refund/timeout races and mid-transaction crashes produce one correct result.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-09-05 - Prove full multi-worker tournament recovery

Run representative ten-player and private room flows while killing/restarting workers and duplicate-delivering commands.

**Verification:** No lost escrow, duplicate prize, unexpected host handover or restart-caused user leave.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `transactional tournament repositories`
- `fixture/timer claim processing`
- `exactly-once-effect settlement tests`

## Exit gate

G09: crash/concurrent workers cannot double-pay, double-refund or lose escrow; approved tournament and private lobby behavior remains.

## Abort / rollback boundary

Pause/drain processing without changing player outcomes, deploy compatible code and resume fenced work from PostgreSQL.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
