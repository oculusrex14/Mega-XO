# Mega XO V5 — full cross-phase integration sweep

**Review date:** 2026-10-09 UTC  
**Owner platform base:** `V5-platform` at `045d5f94a13485486d5e5ab6a3dd5f8616604008` (G07 accepted, P08 active)  
**Co-dev audit checkpoint:** `66065ac92fef034a5a79d441de2f667e07839080` before this report, in the ONE branch `co-dev/v5-integration`; [draft PR #9](https://github.com/oculusrex14/Mega-XO/pull/9).  
**Authority:** Review/compatibility work only; no application, provider, VPS, DNS, store or production database changes.

## Executive outcome

**Static integration: no unresolved JavaScript import or parse error found in the reviewed co-dev delta, and no Git merge conflict at the pinned primary head.** The architecture and explicit scope match the owner-supplied 25-phase implementation pack in the areas inspected. Three real CI-coverage gaps were found and repaired. Formal G15–G20/G22 remain OPEN and must NOT be inferred from source scaffolding. An end-to-end release readiness verdict is **BLOCKED** until GitHub Actions resumes and dependent staging/device/provider acceptance occurs.

The *uploaded owner implementation pack* was extracted and passed its bundled **full validation tool**, including 65 files, 25 phases, 117 tasks, 40 acceptance cases, 210 relative links, 64 SHA256 checksums and source-integrity verification. This is validation of the **specification package**, not runtime functionality.

At the pinned repo checkpoint, the primary agent's structured ledger reports **41/117 tasks complete**, gate acceptance **G00–G07**, active **P08**, and V4 Node/SQLite as sole live authority until gated P22. P21 is **DEFERRED_BY_OWNER**, not a prerequisite for P22. The audit neither modified the owner ledger nor marked any co-dev phase accepted.

## Sweep matrix

| Area | Inspected | Result and acceptance boundary |
|---|---|---|
| Scope/source & plan | User-supplied implementation pack and owner ledger, milestone/phase dependencies, product-freeze decisions | Consistent: defer new apex website, preserve 4 themes/economy/Crowns/retained browser, Neon sole durable authority, Redis ephemeral, Vercel API, Oracle realtime, native Android/iOS |
| P00–P05 owner foundation | Owner ledger, phase evidence summaries, P02 PostgreSQL integration workflow, critical repository/package contracts | G00–G05 accepted by primary agent's recorded evidence; production is **still V4**. This review did not replay provider/migration acceptance |
| P06 managed coordination | Core observers, Redis ephemera, real process fixture interface, P06 evidence | G06 accepted in owner ledger. P16 fixture contract reads genuine P06 Core factories; no independent failover/host HA claim |
| P07 matchmaking | ~1K-line distributed queue, new PG/Redis tests, committed G07 policy/match/recovery evidence, the post-gate co-dev patch | Matched source policy and charges unchanged. **Prior review fixes** stale claim-owner ABA, PG-scoped hint authorization, and early claim cleanup on read failures. Integration tests require rerun on new queue SHA |
| P15 encrypted DR | Eleven P15 source modules plus 12 P15 test modules, restore/backup policy boundaries | Source syntax and relative dependencies resolve. Synthetic pg_dump+encryption/R2/restore source exists; no real customer-data isolated R2 recovery, approved off-host key custody, production RPO/RTO or G15 |
| P16 process failover | Lifecycle/drain, topology/CI security, real socket and Core-A-SIGKILL PG+Redis harness, P06/P07 interfaces | Source syntax and dependency graph resolve. Process-level drain and real-crash test **authored**, not executed under current-head CI; no G16 or post-commit/pre-publish recovery claim. Same-host A/B never equals host HA |
| P17 independent release | Impact planner, immutable candidate/protocol tools, read-only provenance workflow and tests | Static release guards exist. No signed private GHCR/native artifact, actual deployment promotion or rollback evidence; G17 open |
| P18 staging | Isolation contracts, disposable PG/Redis journeys, cutover-state model and evidence code | Structured stage acceptance foundations only; no real integrated Vercel/Core/worker staging or G18 |
| P19 load/chaos | Workload, metrics, capacity, real-service chaos source and bounded PR workflow | Disposable-only coverage authored; no measured actual launch p95/p99/SLO, production-like chaos or G19 |
| P20 Android/iOS | Native tree, Android Gradle sourceSets/manifest/TLS flags, iOS PBX source membership, origin-bound bridges, bundle allowlist, billing/ads evidence handoff | Android root Google identity helper is included in Gradle sourceSet; iOS root Apple identity helper is in PBX Sources; 7 app Swift files are referenced. Bundle excludes server authority. **No signed binary/device/store/provider acceptance executed**, G20 open |
| P22 cutover | Go/no-go, writer-fence, frozen-source import parity, old-origin cookie/callback contract and first-PG-write rollback policy | Offline validations deny cutover by design; G08–G20 missing. No production V4 fence/import or G22 |
| P21 / P23 / P24 | Owner scope/sequence | Website deferred; V4 retirement **only after** P22; capacity purchases **only with measurement** |
| Source/load security | Recursive branch tree; high-risk binary/credential extension scan | No tracked APK/AAB/IPA/SQLite dump/keystore/signing certificate; tracked `.env.example` and Apple test-fixture PEMs are expected, not runtime release credentials |
| Build and source graph | All **95 JS/CJS files** in the pre-audit co-dev delta (including inherited P07 changes) | All parse as JavaScript modules and all static relative `require('...')` imports resolve to tracked paths. **Syntax/graph only**, not Node24 compile, Redis Lua execution, native SDK build or real PostgreSQL acceptance |
| Approved product/authority change perimeter | Compared all diff paths against `src/**`, `public/**`, `index.html`, `packages/domain/**`, `packages/migrations/**`, `deploy/**`, and `docs/v5/progress.json` | **Zero modifications or additions** in those owner/product paths; 6 modified base files are the P07 queue + three tests and client bundle script + test. This is evidence of unchanged source paths, **not** four-theme screenshot/device parity |
| Git ancestry | Primary head and single co-dev branch comparison | Draft #9 is mergeable, **zero commits behind** at audited base; only co-dev branch changed, not `V5-platform` |

## Compatibility defects found, fixed and regression-guarded

### F1 — Core failover was not triggered by changes to Core or PostgreSQL (high)

**Before:** `.github/workflows/v5-p16-core-failover.yml` was PR-only and watched P16-owned sources. A future P08 Core change, P06 ephemera change, migration/role change or production ingress edit could avoid the real two-Core process regression suite. The primary agent commits directly to `V5-platform`, so direct-push compatibility was also untested.

**Fix:** identical read-only **push and PR** trigger scopes on `V5-platform`, expanded to `packages/services/**`, shared contracts, DB/migrations, `apps/game-core/**`, `apps/worker/**`, `deploy/**`, domain rules and owned PG/process fixtures. P16's own CI perimeter now requires exactly these two trusted event types with identical dependency lists, denies other GitHub events, retains pinned actions, no checkout credentials, no provider secrets and zero skips. Negative attack tests updated.

**Commits:** `ac4dcadb7cdd`, `c9d41df1cd36`, `86956e255ce3`, `9eb7e030c2a5`, `cbbf5daf8ad7`, `1470df81b809`.

### F2 — Cutover preflight could miss ledger/import/identity/legacy API changes (high)

**Before:** P22 read-only validation ran only on PRs changing P22/P18-specific files, not new owner gate evidence, P03 final import framework or retained/native client contract. Direct integrations into V5 skipped it. Its concurrency group also carried a stray backslash before the GitHub expression.

**Fix:** identical trusted `V5-platform` push/PR watchlists covering `docs/v5/progress.json`, evidence, `packages/**`, migration tools, `apps/**`, `server/**`, `deploy/**`, `src/**`, `native/**`, P18/P22, bundle/release tooling and relevant tests. Removed the extraneous escape. Updated the workflow source guard to reject changed/privileged events and unequal watchlists. This is intentionally cheap, source-only and **never authorizes production**.

**Commits:** `4a41b9bdb160`, `8b2c02302812`, `45e7eb639d3d`, `243f06efd751`, `8ab4a85db61d`.

### F3 — Android/iOS builds were not triggered by all shared client contracts (medium)

**Before:** P20 CI watched native source and browser assets, but edits to `packages/contracts/**`, `packages/domain/**`, native smoke/bundle-parity scripts, `package-lock.json` or bundle tests would not trigger both host builds.

**Fix:** added these paths to both push and PR event lists symmetrically. Existing identity, gameplay, billing and consent implementation was not modified; no speculative refactor of approved UI or Crown rules.

**Commit:** `e4c2f8933221`.

### F4 — Missing automated cross-phase dependency guard (medium)

**Fix:** added `tests/v5-cross-phase-integration.test.js` and wired it into the existing P17 release-engineering checks, which already run for both V5 pushes and PRs. It asserts P16/P22/native trigger coverage and symmetry, read-only permissions, proper GitHub expression spelling, and P17's independent full-test requirements. Does not attempt providers or approve gates.

**Commits:** `4f694a303135`, `0494c1cc8ebf`, `77c90e9fa753`, `66065ac92fef`. A first source-level harness run caught a final-line newline parsing bug in the P16/P22 workflow self-auditors, corrected in `cbbf5daf8ad7` and `8ab4a85db61d`. After correction, **11/11** P16/P22/cross-phase CI audit test bodies passed **direct V8 evaluation of fetched source with stubbed Node modules**; this is not a Node24 Actions run.

## Current hard verification blocker — all workflows fail BEFORE execution

At audited head `66065ac92fef034a5a79d441de2f667e07839080`:

- All **9/9** co-dev branch workflows reported failure.
- Every inspected failing job had **no runner assigned** and **zero executed steps**. Certain dependent jobs were skipped after their preceding job failed; they likewise executed no steps. Example: [P16 Actions run 37916225060](https://github.com/oculusrex14/Mega-XO/actions/runs/37916225060) and [P22 run 37916224970](https://github.com/oculusrex14/Mega-XO/actions/runs/37916224970).
- This is a runner/workflow scheduling or account/service problem **whose cause was not verified**. It is **not evidence that code tests failed** and most emphatically **not a passing test run**.
- Repo owner: inspect GitHub Actions account billing/minutes/runner eligibility, organization/repository Actions policy and any service notices; rerun exact-current-head PR tests. Once runner is available, require real Node24 unit suites, locked deps, disposable PG16/Redis Lua tests, source bundle parity, Android compile, iOS simulator compile, source-only security guards and P07/P08 integration checks. Do not quietly disable checks, remove target isolation or treat skipped tests as success.

**Additional source-level check:** After the P17 source-only CI test command was amended, its exact workflow passed the `ci-safety-audit.js` read-only/pinned-artifact inspection and **3/3** P17 audit test bodies under V8 with stubbed Node fs/path. This adds regression confidence to the 11/11 P16/P22/cross-phase check results, but it remains **not** a GitHub Actions/Node24 run.

## Additional risks and explicit owner actions

1. **P07 API compatibility after hardening:** `queue.releaseClaim` now **requires the exact opaque `claimId`** returned by the corresponding `claimCandidates`; every known owned caller was updated. Do not implement new callers that fetch a current claim token to force-release another worker. [P07 audit](P07-POST-GATE-HARDENING.md).
2. **P08–P14 primary integration in flight:** P08 durable realtime transport, P09 tournament logic, P10 workers and P11–P14 Vercel/cache/security/telemetry are not yet implemented in primary; later-phase co-dev acceptance scripts must be rebased on the actual interfaces, not treated as integrated deployments.
3. **G15 / G16:** A real off-host encrypted R2 restore and a real in-flight Core A/B recovery behind authenticated websocket routing are still outstanding. Committed test *source* does not satisfy A17/A28/A29.
4. **G17–G20:** Actual immutable signed images/native artifacts, Stage A24/identity/callback behavior, private alert delivery, load and physical-device provider acceptance are outstanding.
5. **G22:** Freeze/verified restart fence, consistent final SQLite snapshot, full per-actor reconciliation, retained old-origin cookie routing, first production PG application-write epoch, callback dedupe and production smoke have NOT been run. Retain V4 authority until explicitly passed.
6. **P23 / P24:** Never deactivate the old writer prematurely or buy capacity without executed P22 and measured SLO evidence.
7. **Cross-platform runtime:** Static Android build.gradle sourceSet inclusion and Xcode PBX file membership were checked, but no Android SDK/iOS Xcode build/device/provider console was available through this review. **Do not label native compile or store submission successful.**
8. **Future conflicts:** As the primary agent advances P08+, recompare against its latest source SHA before merging; never overwrite new runtime work or update its G-ledger from the co-dev branch.

## Recommended merge sequence

1. Keep ONE review branch/PR. The main agent owns `V5-platform` and should not merge multiple superseded phase PRs.
2. Resolve the Actions runner issue and execute all **current-head** tests. Fix any real failures in small commits; rerun a complete zero-skip PR suite.
3. Review the six existing modified base files, especially `packages/services/queue.js` and the P07 claim-token API change. Verify any P08 new consumers against it and record source SHA.
4. Integrate additive P15–P20/P22 foundations only after CI green and current contract review. All formal gates remain owner-controlled and require their own real stage/provider/device evidence.
5. Keep [CO-DEV-README.md](../../CO-DEV-README.md) current after every meaningful co-dev unit; do not deploy production from this report.

**Conclusion:** The sweep found no static cross-branch incompatibility or product-rule change in the reviewed delta. The specific cross-phase CI blind spots have been fixed and regression-guarded. Runtime CI and real-device/staging acceptance are currently **UNVERIFIED**, so release and production readiness remain **BLOCKED**.
