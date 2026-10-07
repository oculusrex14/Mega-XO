# Phase 10 - Extract reliable jobs, notifications and provider retries

**Milestone:** V5.4 | **Mode:** EXECUTE | **Prerequisites:** P09

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 3](../specs/03-DISTRIBUTED-CORE-AND-WORKERS.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-10-01 - Implement durable job and outbox primitives

Add typed/versioned payloads, business idempotency keys, claim/fence metadata, backoff, failure/dead-letter state and restricted inspection/retry.

**Verification:** Kill during claim/I/O/completion; job is recoverable and stale owners cannot complete new claims.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-10-02 - Extract email/security/privacy work

Move existing mail outbox, notifications, cleanup and approved privacy/deletion workflows out of the game process; preserve encryption/retention behavior.

**Verification:** Core restart does not drop jobs; restricted payloads/OTP values do not leak into logs.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-10-03 - Extract provider notification and finalization work

Persist verified callbacks, dedupe by provider identity/environment and invoke Core grants/refunds; finalize only after durable grant.

**Verification:** Duplicate/out-of-order/retried provider messages never remint; pending finalization is visible and recoverable.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-10-04 - Extract season/leaderboard/maintenance scheduling

Use stable UTC period identities and Core-owned competitive commands where applicable; do not fabricate missing legacy snapshots/rewards.

**Verification:** Two workers and downtime catch-up preserve exact approved weekly/quarterly behavior.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-10-05 - Remove legacy duplicate schedulers

Disable V5 production in-process copies of extracted jobs and document role-specific health/alerts.

**Verification:** Only one business effect occurs even when old/new-compatible processes overlap during a deploy.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `apps/worker`
- `job/outbox tables and producers`
- `retry/DLQ operator tools`
- `provider finalization/season tests`

## Exit gate

G10: unrelated jobs survive API/Core restarts; at-least-once delivery produces idempotent authorized effects and visible recoverable failures.

## Abort / rollback boundary

Stop worker claims and deploy prior compatible worker; jobs remain in PostgreSQL with recoverable leases/fences.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
