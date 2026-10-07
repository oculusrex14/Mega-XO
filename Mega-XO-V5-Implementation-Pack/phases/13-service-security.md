# Phase 13 - Harden distributed trust boundaries

**Milestone:** V5.5 | **Mode:** EXECUTE | **Prerequisites:** P12

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 4](../specs/04-INFRASTRUCTURE-AND-PROVISIONING.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-13-01 - Enforce service and player authentication boundaries

Scope assertions by audience/method/path/request hash/actor context/expiry; strip forged forwarding headers and validate replay identities.

**Verification:** Direct URL knowledge, body alteration, token reuse and forged actor do not authorize a command.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-13-02 - Enforce browser/native/perimeter isolation

Implement exact origin/CORS/CSRF, credential-mode separation, body/message limits, rate fallback and safe support errors.

**Verification:** Native support does not weaken cookie-authenticated browser security or enable cross-origin bridge calls.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-13-03 - Enforce least-privilege SQL and secrets

Run negative permission tests and verify runtime no-DDL, secret references, TLS, environment isolation and signing-key rotation.

**Verification:** API/worker cannot mutate restricted economy; secrets are absent from assets/artifacts/logs.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-13-04 - Preserve audit and private operations

Migrate verifiable audit continuity with dedicated secret, safe concurrent append and private support/revoke tools; keep admin off public ingress.

**Verification:** Historical audit verifies, new concurrent entries verify, and external operator/metrics probes are rejected.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-13-05 - Run adversarial staging acceptance

Execute provider replay/account mismatch, session/ticket replay, queue manipulation and existing abuse tests without adding new gameplay gates.

**Verification:** Security flaws are fixed with evidence; review-only signals and purchased-Crown utility stay unchanged.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `service credential and replay policy`
- `database permission tests`
- `private operator/audit migration`
- `security acceptance report`

## Exit gate

G13: direct/internal/forged/replayed requests cannot bypass player and service authorization; existing security and gameplay decisions do not regress.

## Abort / rollback boundary

Rotate/revoke isolated credentials or deploy prior compatible security code; never disable authority checks to restore service.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
