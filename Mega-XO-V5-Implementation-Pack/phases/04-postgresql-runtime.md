# Phase 4 - Replace production persistence with PostgreSQL adapters

**Milestone:** V5.1 | **Mode:** EXECUTE | **Prerequisites:** P03

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-04-01 - Implement account/social/save repositories

Replace direct SQLite SQL for profiles, linked identities, credentials, sessions, graph, reports and revisioned practice saves through explicit repository adapters.

**Verification:** Parity fixtures preserve identity, case semantics, privacy and non-authoritative practice-wallet behavior.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-04-02 - Implement Core-owned asset/ledger repositories

Normalize wallets/reservations, journals, purchase grants and rating state with one transaction context and stable lock order.

**Verification:** Concurrent spend cannot overdraw or double-reserve; invalid mutation fully rolls back.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-04-03 - Implement match/tournament/provider persistence

Replace serialized-global authority writes with entity-specific durable mutations and constraints. Carry immutable quotes, operation outcomes and provider revocations.

**Verification:** Match/tournament/purchase tests compare to baseline and reject duplicates or conflicting occupancy.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-04-04 - Move schema setup out of constructors

Runtime boot verifies compatibility/readiness but never creates or alters tables or defaults that mint player state.

**Verification:** Fresh service boot on wrong schema fails clearly; runtime role has no DDL rights.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-04-05 - Run differential and contention acceptance

Use identical clocks/random seeds to compare source behavior; race spending, conversion, reward, refund and settlement paths across database clients.

**Verification:** Existing product tests plus new rollback/idempotency/economy invariants pass; SQLite remains only in importer/legacy reference tooling.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `PostgreSQL repositories`
- `Core command transaction boundary`
- `PG-backed account/social/store services`
- `legacy-vs-PG parity suite`

## Exit gate

G04: the V5 production path has no SQLite dependency; concurrent spends/settlements/payouts and rollback tests pass with approved behavior.

## Abort / rollback boundary

V4 stays live. Switch only isolated V5 targets; retain schema-compatible app fallback and additive migrations.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
