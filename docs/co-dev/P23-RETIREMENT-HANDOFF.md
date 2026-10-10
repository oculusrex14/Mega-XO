# P23 — V4 retirement safeguards and owner handoff

**Canonical branch:** `co-dev/v5-integration` · **Single PR:** [#9](https://github.com/oculusrex14/Mega-XO/pull/9)  
**Original reference:** [P23 (V5.9)](../../Mega-XO-V5-Implementation-Pack/phases/23-retire-v4-authority.md) · [cutover and compatibility spec](../../Mega-XO-V5-Implementation-Pack/specs/07-CUTOVER-AND-LEGACY-COMPATIBILITY.md)  
**Phase dependency:** P22 actually accepted (G22), with durable production V5 PostgreSQL authority. **Present:** owner ledger P08, accepted G00–G07 only; G22 and G23 OPEN.  
**Completed in co-dev:** additive source-only design, strict validators, negative tests and a read-only CI job. **Not executed:** any V4 retirement, write-fence, host restart, callback reroute, archive deletion, provider endpoint change, DNS, Oracle, Neon, R2 or Vercel operation.

## Exact scope and independent acceptance

This P23 work cannot stop V4, edit deployment files or promote a worker. All validation packets carry **untrusted operator claims** and output explicit `v4RetirementAuthorized:false` / `g23Accepted:false`. The primary agent owns the master `docs/v5/progress.json` and the live P22/P23 evidence ledger. No release operator should turn a report flag into an automated live action.

### V5-23-01 — permanent V4 writer fence (safe preparatory code)

**Source:** `scripts/v5/p23/retirement-readiness.js` and `tests/v5-p23-retirement-readiness.test.js`.

The review function refuses P23 while G22 is absent; G22 itself requires accepted **G00–G20**. G21 (new website) remains **owner-deferred**, not a prerequisite. Even after a declared G22 pass, a missing restart and writer manifest is blocking; a complete, structurally valid manifest remains **`DECLARATIONS_COMPLETE_INDEPENDENT_EXECUTION_REQUIRED`**, never active permission.

The packet must bind the **same P22 first accepted application-write reference**, source SQLite snapshot digest, V4 release SHA and V5 authority epoch. It reuses `scripts/v5/p22/writer-fence.js` in V5_EXCLUSIVE mode, accounting for all **16** minimum writer classes and verifying declarations of zero independent V4 routes/timer jobs. Provider callbacks must be forwarded to **one durable V5 inbox** instead of being ACKed independently by SQLite.

Real operator G23 acceptance (not yet performed) must trace **every discovered path**, including any extra beyond the 16 minimum classes: standalone V4 API/party/community listeners; cron/outbox timers; workers; manual operator scripts; systemd/container restart policies; old VPS images; archive/maintenance jobs; third-party webhooks. In a controlled environment, demonstrate:
1. Ordinary service process restart cannot revive V4 writes.
2. Container recreation/restart cannot revive V4 writes.
3. Whole-host reboot does not revive V4 writers.
4. Systemd automatic restart or deploy replay cannot revive V4 authority.
5. Cron/timer/outbox resume cannot write old SQLite.
6. A previously signed V4 image or code rollback cannot reintroduce a second writer.

These six situations are only **required test cases in code**. No VPS instance, network route or actual database has been changed or tested by co-dev. If an unrecognized writer or a stale credential could revive SQLite, G23 remains open.

**Abort rule:** P23 does not allow a V4 writer rollback even after a V5 Core/edge failure. Use a tested PG-compatible V5 build or forward-fix, keep SQLite archive **read-only**, and preserve committed actor/match/wallet/provider events.

### V5-23-02 — immutable archive retention and monitor migration

**Source:** `scripts/v5/p23/retention-manifest.js` and `tests/v5-p23-retention-manifest.test.js`.

Requires declared immutable SHA256 + private archival locator + successful retrieval evidence + approved retention policy and dates for:
- frozen encrypted V4 SQLite snapshot, original release/tag/image and Git history;
- P03 final import/coverage manifest and migration audit-key custody reference (**not the key**);
- P22 authority epoch / first-write record;
- independently retrievable encrypted V5 PostgreSQL backup;
- retained browser/callback interface and identity contract.

Confidential artifact references require restricted operator access and declared encryption at rest. An operator-approved retention window of **at least 30 days** is a *minimum metadata-validation guard*, not the established project policy; use the actual owner/legal/data-retention decision. Retrieval declarations must be within 30 days, but only independently retrieved/verified restore evidence counts toward G23.

Map the seven monitoring classes so obsolete V4 backup/writer/restart alerts are retired with audit history while new V5 PostgreSQL backup, Core/API, inbox lag and alert delivery remain covered. No module deletes old monitors, archives, secrets, tags or provider backups.

**Acceptance:** retrieval using the actual off-host storage role, checksum verification, retention policy proof, an isolated V4 and V5 restore, alert delivery and legal/privacy deletion obligations. Do not store player data, key bytes, email or secrets in PR evidence.

### V5-23-03 — compatibility sunset only from measured clients and providers

**Source:** `scripts/v5/p23/compatibility-sunset.js` and `tests/v5-p23-compatibility-sunset.test.js`.

Reuses P22 `verifyCompatibility` for the same legacy browser origin, actor/session continuity, cross-origin cookie boundary and single PG durable authority. Requires **all ten** old-browser/native/provider surfaces to be described. The existing `https://play.antimatterinnovations.com` browser experience, host-origin session facade and Android/iOS platform entry points are explicitly **ALWAYS KEEP**. P21 website remains dormant; no redirect to an unfinished apex.

An *optional* old endpoint can become `REVIEW_CANDIDATE_KEEP_RUNNING` only if:
- no supported client version uses it;
- at least 90 continuous days of **complete** zero-traffic telemetry and no more recent usage;
- version-support evidence and operator sunset approval;
- reversible old facade preserved; and
- for provider callbacks, independently verified third-party endpoint de-registration.

These are conservative preparatory-review thresholds, **not** authority to delete a route. Traffic absence caused by broken telemetry is `KEEP_COMPATIBILITY`; old email/store/ad callbacks remain until both providers and supported clients have genuinely stopped using them. Even a candidate output reports `ownerApprovedLiveRouteRemoval:false` and `callbackDeletionAuthorized:false`. Actual sunset requires a separate, operator-scheduled compatibility release with live client and provider tests. Crowns/in-app purchases are never granted by an old callback prior to durable PG dedupe.

### V5-23-04 — truthful final delivery/residual report

**Source:** `scripts/v5/p23/delivery-report.js` and `tests/v5-p23-delivery-report.test.js`.

Preserve **independent milestone states** for retained browser, Android, iOS and V5 backend:

`codeComplete` → `ciVerified` → `signedArtifact` → `deviceVerified` → `storeSubmitted` → `storeApproved` → `productionEnabled`.

These are **distinct fields**, not one optimistic state. Backend and browser have no store-submission field; native production enablement requires executed device and store-approval evidence. Every true claim carries a source-scoped proof reference, and unresolved external items remain visible. A signed binary is not a verified Play/App Store listing; submission is not approval; backend implementation is not current production authority.

The report includes owner G22/G23 evidence status but **always** returns `reportPublished:false`, `retirementAuthorized:false`, and `g23Accepted:false`. Publishing the final report, deploying apps or closing tasks belongs to the owner after real executed evidence, not to a source-only test.

## CI implementation and diagnostics

The new `.github/workflows/v5-p23-retirement-foundations.yml` runs on trusted `V5-platform` push and review PR changes to P22/P23, owner ledger, services/deploy/browser/native/migration code. Both event watchlists match. Its jobs use **read-only contents**, pinned checkout and Node24 actions, nonpersistent checkout tokens, locked `npm ci`, no providers, no deployment, and mandatory zero failures / zero skips. `tests/v5-p23-workflow.test.js` attacks privileged events, disabled watchlists and falsely green tests.

`scripts/v5/ci-runner-diagnostic.js` and `tests/v5-ci-runner-diagnostic.test.js` classify **sanitized GitHub run/job metadata**, never guessed service causes. A completed failed run with zero steps, no allocated runners and zero billed milliseconds is `FAILED_BEFORE_RUNNER_OR_TEST_STEPS`, **not** an executed test failure. It never treats even a superficially green run as permission to release. CLI input must be explicitly local `.artifacts/v5-ci-runs.json`; no token, network call, API write or broad filesystem traversal.

As of this review, GitHub Actions on the unified PR repeatedly failed before a runner executed a job. At recorded [P19 workflow run 37916692249](https://github.com/oculusrex14/Mega-XO/actions/runs/37916692249), two jobs show **zero executed steps**, and the run timing reports **0 ms billed** for Ubuntu. This narrows the symptom, **not the root cause** (billing, repository Actions policy or GitHub-hosted runner availability remain hypotheses). [CI incident and recovery handoff](CI-RUNNER-INCIDENT-2026-10-09.md) contains precise next steps.

## Verification and source-review commands

```sh
node --test tests/v5-p23-*.test.js tests/v5-ci-runner-diagnostic.test.js
# Review installed source + current owner's actual ledger only:
node -e "const l=require('./docs/v5/progress.json');const {assessRetirement}=require('./scripts/v5/p23/retirement-readiness');console.log(assessRetirement(l,process.argv[1]))" "$(git rev-parse HEAD)"
```

The actual retrieved source/test bodies passed **34/34** focused assertions under V8 with stubbed Node built-ins; this is **not Node24, full Linux/Redis/PG or GitHub Actions CI**. The exact-head CI job must execute in a real runner before integration. Tests reflect synthetically authored retirement packets; they do not prove a V4 host restart, archive restore, callback redirection or app-store release.

## Owner checklist / explicit blockers

- **Prerequisite:** G08–G20 and G22 are not yet complete in the primary gate ledger. G23 cannot be accepted while V4 SQLite still serves as the sole production writer.
- **Provider/host:** No execution or privileges to safely test a V4 host reboot/write fence, historical encrypted repository restore or owner-operated provider callback deregistration.
- **Identity/client:** Keep old-origin session cookies, actor IDs, browser/static compatibility and Android/iOS store approval status intact until actual client acceptance.
- **Recovery:** Do not point users back at V4 after V5's first PG application write. Archive V4 read-only, retain audited evidence, measure recovery.
- **CI root cause:** repo owner must inspect GitHub Actions billing/usage, repository runner eligibility and org policy, and service health; rerun exact PR head after resolution.
- **P21:** deferred intentionally; do not add the new megaxo.online product as a completion prerequisite.

**G23 remains OPEN. No live V4 retirement or compatibility deletion occurred in this work.**
