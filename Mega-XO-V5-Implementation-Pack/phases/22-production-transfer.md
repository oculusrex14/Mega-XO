# Phase 22 - Execute final production authority transfer

**Milestone:** V5.9 | **Mode:** EXECUTE | **Prerequisites:** P20

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Specification 7](../specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-22-01 - Revalidate go/no-go and actual release identity

Confirm latest code/CI, source deployment, rollback assets, provider configurations, G00-G20 evidence and exact target environment.

**Verification:** No stale digest, unverified backup, unexplained reconciliation gap or missing supported-client compatibility.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-22-02 - Stage production without admitting writes

Prepare exact production-configured API/Core/worker, schema/roles/secrets/routes and backup/monitoring with all mutating jobs/routes disabled.

**Verification:** Only audited read-only health tests run; session/bootstrap or lazy GET cannot secretly cross the boundary.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-22-03 - Drain and freeze every V4 writer

Use existing maintenance behavior, preserve/drain valid games, stop mutation paths/jobs/operators/provider effects, and fence restart. Capture final consistent source snapshot.

**Verification:** Source checksum and no-writer proof recorded; callbacks are durably handled or safely retried, never falsely acknowledged.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-22-04 - Import and reconcile final source

Run the exact tested importer against intended nonserving production target; compare all per-actor/data categories and preserve pending effects/tombstones.

**Verification:** Final migration manifest shows zero unexplained differences and all invariants pass.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-22-05 - Transfer authority and route clients

Record epoch/first-write boundary, keep V4 fenced, enable Core/API/provider inbox/worker in controlled order, promote exact Vercel build and route legacy/native traffic.

**Verification:** No simultaneous independent writer even during DNS/cache propagation; old endpoints delegate to V5.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-22-06 - Perform production smoke and recovery confirmation

Run controlled supported-client flows, verify fresh backup/retrieval, ops/alerts/support lookup and actual error/latency/backlog health.

**Verification:** Exact URLs/digests/builds/schema/first-write evidence captured; any failure uses the correct recovery class.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `final consistent V4 backup`
- `zero-difference final reconciliation`
- `cutover epoch/evidence`
- `production release manifest`
- `post-cutover backup/alerts/smoke`

## Exit gate

G22: V5 is the only live durable production application writer; existing and native clients share it; recovery and operational evidence is green. No dependency on deferred Phase 21.

## Abort / rollback boundary

Before first post-import V5 application write, restore sole unchanged V4 authority if safe. After that boundary, keep PostgreSQL and forward-fix or deploy a compatible previous release.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
