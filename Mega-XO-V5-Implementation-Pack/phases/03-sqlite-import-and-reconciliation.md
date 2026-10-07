# Phase 3 - Build deterministic SQLite import and proof

**Milestone:** V5.0 | **Mode:** EXECUTE | **Prerequisites:** P02

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 7](../specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-03-01 - Capture consistent source snapshots

Use proven SQLite backup/restore tooling including WAL consistency; record release/schema/hash and inventory actual relational and JSON data.

**Verification:** Restored source passes integrity checks and no table/key is unclassified.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-03-02 - Implement pure deterministic extraction

Read raw aggregate/room JSON without Authority.restore time effects, provisioning, random IDs or provider calls. Handle versioned legacy field variants explicitly.

**Verification:** Quarter rollover, non-UUID actor and legacy-variant fixtures produce unchanged source semantics.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-03-03 - Import all durable account/game/economy state

Migrate identities, passwords, profiles, graph, saves, assets/reservations, seasons, matches, tournaments, receipts, store bindings, revocations, grants, jobs, audit and privacy state.

**Verification:** Coverage manifest accounts for all source records; no duplicate actor, remint or regenerated purchase binding.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-03-04 - Implement lossless accounting reconciliation

Compare per-actor available/reserved assets, escrow representations, credit/inventory/entitlement/rank/history state and global totals; define legacy journal/accounting baseline without replaying old postings.

**Verification:** A balance swap between actors fails even when totals match; all unexplained differences are zero.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-03-05 - Make reruns and resume safe

Add target guard, source fingerprint, run identity, deterministic batches/checkpoints and import lock. Test retries and crash recovery; never truncate an unknown database.

**Verification:** Repeated import and each interrupted batch converge to the same canonical target state.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-03-06 - Record foundation migration proof

Import a realistic sanitized/restored V4 staging snapshot into isolated Neon, run all invariants, and retain restricted details plus sanitized signed/checksummed summary.

**Verification:** G03 evidence is complete before distributed runtime development proceeds.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `source-to-target inventory`
- `versioned importer`
- `reconciler and difference reports`
- `migration manifest`
- `interruption/rerun fixtures`

## Exit gate

G03: representative V4 snapshots import with zero unexplained per-actor/data differences; reruns and interruption recovery preserve identical canonical state and all financial/identity invariants.

## Abort / rollback boundary

Operate only on source copies and nonserving targets. Preserve immutable source snapshot; reset only explicitly identified disposable targets.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
