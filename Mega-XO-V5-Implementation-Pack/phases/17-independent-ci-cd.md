# Phase 17 - Complete independent component CI/CD and release gates

**Milestone:** V5.6 | **Mode:** EXECUTE | **Prerequisites:** P16

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Specification 7](../specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-17-01 - Expand early V5 CI into full component gates

Add path-aware tests with shared-package dependency coverage, migrations, Redis/PG/realtime, economy/security/browser/native compile and artifacts.

**Verification:** Changing a shared contract triggers all affected consumers; required tests cannot be bypassed by path filters.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-17-02 - Publish independent immutable artifacts

Build ARM64/AMD64 Core/worker with provenance and signed/hashable native outputs from exact reviewed commits.

**Verification:** Manifest identifies version/SHA/digest/config/schema/protocol and test evidence; private pull succeeds.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-17-03 - Automate staged release and compatible rollback

Stage production-configured Vercel build without domains, validate, promote exact target; roll Core/worker one component at a time.

**Verification:** Promotion/rollback rehearsal preserves correct configuration and PostgreSQL state.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-17-04 - Protect release credentials and migration ownership

Limit signing/provider/migration secrets to trusted contexts; implement environment locks and no concurrent migration/deploy races.

**Verification:** Untrusted PR cannot read secrets or release production; migrations run once under explicit authority.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-17-05 - Document real release version policy

Use milestone labels for planning, unique SemVer/build numbers for releases, tag/package equality where required and compatibility ranges for clients.

**Verification:** No reuse of V4 tag or accidental production publish from milestone documentation commits.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `component pipelines`
- `immutable release manifests`
- `schema compatibility matrix`
- `trusted native signing pipelines`
- `promotion/rollback rehearsal`

## Exit gate

G17: API/Core/worker and native artifacts can be built and released independently under schema/protocol compatibility and evidence gates.

## Abort / rollback boundary

Use previous compatible images/deployments, not database downgrade. V4 tags/workflows remain retained; never overwrite an immutable release.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
