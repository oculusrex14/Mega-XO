# Phase 0 - Freeze baseline, scope and ownership

**Milestone:** V5.0 | **Mode:** EXECUTE | **Prerequisites:** none

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-00-01 - Verify Git and carry local work

Inspect branch/status, remote head, CI and local approved changes; preserve untracked architecture and skills files. Record source, runtime and deployment-script revisions separately.

**Verification:** Baseline SHA/CI ID recorded; no discarded local files or overwritten release tags.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-00-02 - Inspect live operations and reconcile handoff

Use Tailscale SSH and provider reads to verify image, health, backups, R2 retrieval, ingress ownership, monitors and package visibility. Resolve conflicting backup and EXT statements using actual evidence, not blanket summaries.

**Verification:** Sanitized evidence classifies each fact verified/reported/unresolved; backup repair is tested if actually required.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-00-03 - Create or resume V5 integration branch

Create V5-platform from the current green V4.1 baseline, or safely resume the existing branch. Add the unchanged source documents and this plan as references without committing local secrets.

**Verification:** Branch ancestry and clean/carry-forward worktree state recorded; production branch and V4 tags untouched.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-00-04 - Freeze product and future ownership

Inventory all routes, source tables/JSON keys and their owners. Record no-UI/gameplay-change rule, future-browser scope, managed database choice and process-vs-host HA boundary.

**Verification:** Every existing route/data domain has an owner; Phase 21 deferral and Phase 22 bypass are explicit.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-00-05 - Capture approved UI and rule baselines

Run baseline tests and capture four-theme/device screenshots, assets/rule hashes, API responses, economy and rank fixtures. Include any approved local changes newer than GitHub.

**Verification:** Evidence permits before/after comparisons; failures are not hidden by re-baselining without explanation.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-00-06 - Enable immediate V5 CI and progress records

Add V5 branch/PR validation, preserve V4 jobs and create task/evidence/decision/open-item records. Inventory all provider and native build access, identifiers and quotas.

**Verification:** First meaningful V5 commit runs CI; no claim of native/provider verification based only on access.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `docs/v5/BASELINE.md`
- `docs/v5/ARCHITECTURE.md`
- `docs/v5/PROGRESS.md`
- `docs/v5/DECISIONS.md`
- `docs/v5/OPEN-ITEMS.md`
- `V5 branch CI trigger`

## Exit gate

G00: exact green baseline, scope freeze, environment inventory and initial CI exist; contradictory runtime claims have an evidence-based resolution or precisely scoped gap. No production data migration starts with unproven recovery.

## Abort / rollback boundary

Only documentation, branch and nonproduction validation change. Any necessary operational repair has its own reversible runbook; V4 remains the live authority.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
