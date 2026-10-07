# Phase 5 - Implement actor-centric sessions and credential lifecycle

**Milestone:** V5.2 | **Mode:** EXECUTE | **Prerequisites:** P04

Phase IDs follow the final execution program in the original architecture. File paths below are implementation deliverables, not claims that they exist in the baseline repository.

## Read before implementation

- [Specification 2](../specs/02-IDENTITY-API-AND-CLIENT-CONTRACTS.md)
- [Specification 6](../specs/06-CI-SECURITY-AND-OPERATIONS.md)
- [Current-state audit](../CURRENT-STATE.md) and [acceptance matrix](../ACCEPTANCE.md).

## Actionable work

### V5-05-01 - Implement account readiness and linking semantics

Preserve existing actor/provider/email ownership and add idempotent Core-owned wallet provisioning for new actors. Coordinate deletion and eligibility safely.

**Verification:** No duplicate actor/starting grant or wrong-account reauthentication under retries/races.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-05-02 - Implement access signing and public verification

Use strict issuer/audience/algorithm/key IDs and minimal claims; publish bounded JWKS and test rotation/old-key overlap.

**Verification:** Wrong audience/algorithm/issuer and retired or unknown keys fail; no wallet/rank authority in tokens.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-05-03 - Implement refresh rotation and device revocation

Persist hashed refresh families/session generation, single-flight clients, bounded legitimate retry handling and true-replay response.

**Verification:** Parallel refresh does not falsely log out legitimate clients; replay/revoke/all-device logout work.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-05-04 - Implement browser and native credential paths

Keep cookie/CSRF browser sessions and create explicit host-owned native bearer path. Preserve old MegaAccount response/error semantics through adapters.

**Verification:** Origin protections are not globally disabled; native APIs do not rely on WebView cookie availability.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-05-05 - Issue durable one-use realtime tickets

Bind actor/session/environment/audience/expiry and atomically redeem; apply admission limits and log redaction.

**Verification:** Ticket reuse across nodes or after Redis reset fails; unauthorized match subscriptions fail.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

### V5-05-06 - Prove compatibility and session transition

Test email/Google/Apple linking, recovery, session replacement, revoked WebSockets and legacy-origin continuity strategy.

**Verification:** Three client styles share identity and data; old cookie-domain boundaries are explicitly handled.

**Checkpoint:** commit the cohesive code/config/test change after its verification; record SHA, command, environment and evidence. Do not wait for the whole phase to commit.

## Required outputs

- `asymmetric token/JWKS service`
- `rotating refresh repository`
- `browser/native auth adapters`
- `one-use realtime ticket service`
- `session migration decision`

## Exit gate

G05: browser-style, Android-style and iOS-style clients resolve to the same permanent actor; refresh, revocation, provider linking and ticket replay tests pass.

## Abort / rollback boundary

Keep V4 sessions untouched in live production; stage the new credential system with isolated keys. Compatibility adapters must be versioned before activation.

## Evidence record

Use [the evidence template](../templates/evidence.template.json) and [phase report](../templates/PHASE-REPORT.md). Preserve the original source constraints and exact environment IDs. A claimed pass requires an executed test/deploy observation, not a filled checklist.
