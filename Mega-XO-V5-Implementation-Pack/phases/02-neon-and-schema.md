# Phase 2 - Provision Neon and versioned PostgreSQL schema

**Milestone:** V5.0 | **Mode:** EXECUTE | **Prerequisites:** P01

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-02-01 - Resolve provider inventory and region

Inspect actual Neon org/projects before creating production/nonproduction targets. Record region/RTT, version, plan and quotas; configure production no-suspend/restore history where supported.

**Verification:** Real IDs/settings and capability evidence recorded; no duplicate guessed projects or false Free-plan guarantees.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-02-02 - Design normalized authority schema

Map every durable source field to relational records or bounded immutable JSONB. Preserve text actor IDs, Elo hundredths, integer assets, store bindings and privacy tombstones.

**Verification:** Schema review plus source-coverage report; uniqueness/FK/check constraints match approved semantics.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-02-03 - Implement migrations and role grants

Add checksummed ordered SQL, single-runner lock, upgrade history, runtime no-DDL and distinct API/Core/worker/backup/migration grants.

**Verification:** Clean create/upgrade tests pass; forbidden direct writes fail for API/worker roles.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-02-04 - Implement connection and environment guards

Use pooled runtime and direct administrative connections appropriately; pin driver/PG versions, timeout/pool budgets and target-environment checks.

**Verification:** Interactive transaction and rollback tests run on actual selected connection modes; no secrets in output.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-02-05 - Deploy nonserving schema to isolated staging

Create disposable test databases/branches from sanitized seeds; suppress production outbound effects. Add DB integration CI and cleanup bounds.

**Verification:** PR credentials cannot access production; cleanup cannot delete production/staging objects.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `Neon production/staging/dev inventory`
- `packages/db/migrations`
- `database roles and connection policy`
- `disposable PostgreSQL integration harness`

## Exit gate

G02: schema builds from zero solely through migrations; environments/roles are isolated; actual plan, TLS, region, pool and recovery settings are evidenced.

## Abort / rollback boundary

Only new empty/nonserving resources are affected. Do not drop existing provider objects automatically; keep V4 production unchanged.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
