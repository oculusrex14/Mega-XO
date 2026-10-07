# Phase 11 - Deploy Vercel account and stateless control plane

**Milestone:** V5.5 | **Mode:** EXECUTE | **Prerequisites:** P10

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 7](../specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-11-01 - Create isolated Vercel API project and previews

Verify team/project/root/env/region and repository integration; use protected previews/stable staging with correct nonproduction connections.

**Verification:** Deployment metadata matches commit/environment; no automatic production promotion or production secrets in PR builds.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-11-02 - Move account/social/practice/read APIs

Implement frozen route contracts using PostgreSQL ownership grants and privacy-aware views; retain auth/callback and account flows.

**Verification:** Same actor sees consistent profile/friends/save state through API and Core.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-11-03 - Route competitive effects to Core

Implement explicitly reachable HTTPS service ingress with signed request-bound credentials; handle timeouts/retries with stable operation keys.

**Verification:** API role cannot award currency or settle results; forged service/actor requests fail.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-11-04 - Implement old-origin browser compatibility

Keep the approved client and existing /api/v1 semantics with cookie/CSRF and callback continuity; audit lazy mutating GETs.

**Verification:** Retained client works against V5 staging without changing its UI or writing SQLite.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-11-05 - Establish future website foundations only

Reserve apex/www project/domain boundaries, exact origin/callback contracts and minimal association/legal technical resources; keep new product dormant.

**Verification:** Browser-style harness authenticates to the same platform; no new website/browser UI is built.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `apps/api Vercel project/config`
- `route ownership manifest`
- `service-authenticated Core gateway`
- `retained-browser compatibility facade`

## Exit gate

G11: Vercel and Core serve the same staging actors with no overlapping economic authority; old client routes remain compatible.

## Abort / rollback boundary

Roll back only the nonproduction API deployment or a PG-compatible production API. No database rollback accompanies Vercel domain changes.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
