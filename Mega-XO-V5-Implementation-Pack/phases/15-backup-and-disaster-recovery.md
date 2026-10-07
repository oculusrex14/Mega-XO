# Phase 15 - Prove independent backups and disaster recovery

**Milestone:** V5.6 | **Mode:** EXECUTE | **Prerequisites:** P14

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 1](../specs/01-DATA-MIGRATION-AND-ECONOMY.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-15-01 - Freeze measured recovery policy

Resolve actual Neon plan/history, independent RPO/RTO, retention, storage budget and off-host key custody.

**Verification:** Settings/cost/retention align with approved policy; free-tier or 2 GiB assumptions are not silently reused.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-15-02 - Implement direct logical backup plus encryption

Use compatible direct pg_dump, checksummed manifest, encryption before R2, scoped credentials, scheduler and freshness alerts.

**Verification:** Backup can be retrieved/verified; plaintext/temp files and credentials do not leak.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-15-03 - Test Neon recovery and independent restore

Run PITR and a separate R2-to-isolated-PostgreSQL restoration with role/config reconstruction and outbound effects disabled.

**Verification:** Identity, per-actor assets, escrow, purchases, audit and privacy/tombstone invariants pass.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-15-04 - Schedule controlled recurring restore drills

Implement runtime scheduling, evidence retention, target guards, cleanup and failure alerting for periodic restore verification.

**Verification:** One complete scheduled-style drill is executed and measured; upload success alone is not considered proof.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `Neon restore configuration`
- `encrypted R2 PostgreSQL backup pipeline`
- `restore/invariant runner`
- `RPO/RTO/retention evidence`

## Exit gate

G15: independently encrypted material can reconstruct the service data in an isolated PostgreSQL target, including privacy/revocation controls, within measured recovery objectives.

## Abort / rollback boundary

Never overwrite a live database during a drill. Preserve V4 backups and separate V5 prefixes/keys; restore only to a verified isolated target.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
