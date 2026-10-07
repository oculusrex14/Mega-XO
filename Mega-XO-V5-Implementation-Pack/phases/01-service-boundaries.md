# Phase 1 - Extract clean service and repository boundaries

**Milestone:** V5.0 | **Mode:** EXECUTE | **Prerequisites:** P00

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-01-01 - Map write paths and implicit effects

Trace state JSON updates, room/economy transactions, provider mutations and lazy GET side effects. Distinguish durable state from caches and process Maps.

**Verification:** Route/data inventories include every discovered authority write and stateful constructor.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-01-02 - Introduce repository and transaction interfaces

Define account/profile/session/save/wallet/ledger/match/tournament/purchase/job repositories and shared unit-of-work context. Keep SQLite adapters while behavior tests remain unchanged.

**Verification:** Contract tests prove one transaction encompasses all economic effects; no hidden independently committed calls.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-01-03 - Extract pure domain behavior without rebalance

Reuse game/rating/season/economy/tournament/abuse rules with injected clock/randomness. Preserve current constants and module compatibility.

**Verification:** Seeded differential tests and existing invariant/balance tests pass without changed expected product values.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-01-04 - Freeze versioned contracts and adapters

Capture existing /api/v1 and other routes, errors, idempotency, cookie behavior and native bridges. Define new realtime schema separately and add shared validators.

**Verification:** Existing clients remain contract-compatible; invalid payloads fail consistently.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-01-05 - Add deterministic client packaging seam

Create a client-only asset allowlist/build manifest without visual changes. Explicitly exclude server-only src/authority.js and unrelated repository files.

**Verification:** Bundle inspection and four-theme baseline test show correct assets and no server/secrets leakage.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `packages/domain`
- `packages/contracts`
- `repository and unit-of-work interfaces`
- `legacy adapter compatibility tests`

## Exit gate

G01: existing UI and game behavior remain equivalent; pure domain and contract tests run independently of HTTP/SQLite; a transaction can span multiple repository operations.

## Abort / rollback boundary

Retain the legacy adapter and compatibility shims; avoid a mass file move. Revert isolated extraction commits if parity fails.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
