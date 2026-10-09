# Mega XO V5 — unified co-development handoff

**Canonical branch:** `co-dev/v5-integration`  
**Integration target:** `V5-platform` (main execution agent owns that branch)  
**Owner:** independent co-developer; **status:** preparatory implementation, NOT formal phase acceptance  
**Started:** 2026-10-09 UTC  
**Pinned starting V5 base:** `e8d049bf50862897f546e531def12715a36c670c` (other agent's latest P06 checkpoint when branch was created)  
**Upstream sync:** accepted G06 (`42db7e0`) merged via `dc579856d8c4`; accepted G07 (`045d5f94a134`) via `41190f99feaa`; accepted G08 (`a09c1578e8dc`) via `1638ab671c66` (22 primary-owned files, zero path overlap). These are conflict-free two-parent merges into THIS branch; `V5-platform` was not edited. **Current primary phase P09**, with G00–G08 accepted (46/117 tasks).
**Work policy:** only this branch receives new co-development commits. Do not ask the integration agent to inspect/merge individual phase PRs.

## Quick start for the primary agent

1. Review the **single unified PR** from `co-dev/v5-integration` to `V5-platform`. Its commits preserve the entire incremental history from the original branches via two-parent Git merges, rather than dropping previous work into one squash.
2. Read this file, then the phase-specific notes linked below. This file is updated whenever a meaningful co-dev work unit lands.
3. Run read-only PR CI and isolated tests. **Merge only after current `V5-platform` contracts and tests pass** and dependent P06–P14 changes are accounted for. Pull in changes via Git only; no live staging or production rollout is implied by merge.
4. Do **not** close G15/G16/G17/G18/G19/G20/G22/G23/G24 based solely on this source. The master ledger `docs/v5/progress.json`, its generated `TODO.md`, and runtime/Neon/Redis credentials remain the primary agent's authority.

## Latest full integration audit — 2026-10-09

**Read the [complete 25-phase cross-agent audit](docs/co-dev/V5-FULL-INTEGRATION-SWEEP-2026-10-09.md) before merging.** The user-supplied implementation pack passed its full integrity validator (25 phases, 117 tasks, 40 acceptance cases). At the audit's original checkpoint: **41/117 tasks and G00–G07 accepted, P08 active**. **Now:** G08 accepted, 46/117 tasks, P09 active; V4 SQLite remains the sole live authority. G15–G20/G22 are **NOT** accepted.

Audited all 95 previously changed JS/CJS files for parse errors and tracked relative imports (none found), native Gradle/Xcode source inclusion, source-only backup/release/staging/load/cutover boundaries and merge ancestry. **Found and fixed three cross-phase CI trigger defects:** P16 did not watch P08 Core/schema or direct pushes, P22 missed gate/import/client and direct-push changes, and native host builds missed shared contracts/bundle tooling. Updated read-only trusted push/PR scopes and added `tests/v5-cross-phase-integration.test.js` to mandatory P17 source CI. Together with P16/P22 CI security tests, **11/11** exact fetched test bodies passed source-level V8 + Node stubs; **NOT** live Actions or native/PG evidence.

**CI currently blocked:** At audited source `66065ac92fef`, all nine PR workflows failed before runner allocation; all job steps were zero (downstream jobs skipped). Owner must resolve GitHub Actions runner/account/service and rerun **exact-head** tests before merging. This is not a code-test failure or success claim. Source-level and native/device phase acceptance remain dependent on actual CI/providers.
### Integration manifest (2026-10-09)

| Unit | Original PR (superseded) | Original source head | Unified merge commit | Diff |
|---|---|---|---|---:|
| P20 native foundations | [#3](https://github.com/oculusrex14/Mega-XO/pull/3) | `22d07f3488dd` | `b5aed71cbb77` | 39 additive files |
| P17 CI/release gates | [#4](https://github.com/oculusrex14/Mega-XO/pull/4) | `ef3837c5a641` | `dbcfb51a0b44` | 14 additive files |
| P18 staging acceptance | [#5](https://github.com/oculusrex14/Mega-XO/pull/5) | `53e06af94232` | `736e8bc10a98` | 18 additive files |
| P19 load and chaos | [#6](https://github.com/oculusrex14/Mega-XO/pull/6) | `7f9e43989c10` | `50efe7a2ecfc` | 16 additive files |
| P15 recovery | [#7](https://github.com/oculusrex14/Mega-XO/pull/7) | `93409ac0a3ba` | `626e9e9ccd6c` | 25 additive files |
| P16 process drain (initial) | [#8](https://github.com/oculusrex14/Mega-XO/pull/8) | `d4826989e8c0` | `1b5121cdb405` | 3 additive files |
| Native bundle overwrite safety | [#2](https://github.com/oculusrex14/Mega-XO/pull/2) | `6dac51ff27c8` | `c56f9e76d6ec` | 2 modifications |

**Verified aggregate at `c56f9e76d6ec`:** 117 changed files relative to pinned V5: 115 added, 2 modified. All added paths across six phase branches are unique. Before overlaying #2, both modified files' V5 heads matched the review's common ancestor exactly; no primary-agent edits were overwritten. History is retained through Git merge ancestry; original PRs remain archives, **not** independent work streams.

**Out of scope:** [#1](https://github.com/oculusrex14/Mega-XO/pull/1) on `ops/main-ci-guard` targets **`main`** production-branch policy, not V5 co-development. It is intentionally not imported; handle it in its own main-branch guard workflow.

## Ownership, dependencies and safety

- The **primary agent** has accepted G00–G08 and owns P09–P14 online work; follow its gate ledger, provider evidence and exact interfaces. This branch **edits P07 `packages/services/queue.js`** (claim/hint/race fixes) and **P08 `packages/services/realtime-transport.js`, `packages/services/timers.js`** (HTTP auth, backlog and Redis TTL fixes) plus matching tests and workflow. Review these exact API changes before integrating. The co-dev branch does not rewrite the primary agent's `packages/services/core.js`, `packages/services/ephemera.js`, schema/migrations, live environment inventories, `deploy/compose.yaml`, Caddyfile or `docs/v5/progress.json`.
- The **co-developer** maintains P15–P20 and P22–P24 preparation, client-bundle safety, reviewed P07 queue corrections and cross-phase CI compatibility audits. All future work lands on this one branch, with small, meaningful commits and an updated README.
- **No V4 changes**, no current production authority transfer, no modifying R2/Neon/Redis/provider objects, no store submission, no new external ports, and no credentials in Git.
- P21 (new website/browser product) is **explicitly owner-deferred**; do not start it. P22 depends on P20 rather than the deferred website. P24 is measurement-gated.
- Formal proof comes from **executed** CI/staging/device/provider runs attached to the exact integrated source SHA. Standalone local/CI tests do not automatically transfer G-phase acceptance to a newer integration head.

## P07 post-gate review (pending current-head integration CI)

The primary agent passed G07 at `045d5f94a134`. This branch preserves that checkpoint and adds three isolated `packages/services/queue.js` safeguards: claim release must compare the exact opaque `claimId` before deleting Redis state; Redis match hints require requesting-actor participation in PostgreSQL; and failed PG matcher hydration releases still-owned claims without losing FIFO position. No frozen matchmaking rules, Crown economics, four-theme UI, or P08 Core authority changed.

Three real-Redis/PG regressions were added to `tests/v5-p07-queue.test.js`; existing P07 queue/match/recovery tests now supply the mandatory `claimId` to `releaseClaim`. **Caller contract change:** any new matcher must release with its own returned claim ID, never reread the latest claim ID to force a release. See [P07-POST-GATE-HARDENING.md](docs/co-dev/P07-POST-GATE-HARDENING.md).

Exact P07 source/tests passed syntax parsing and stubbed queue.js demonstrated actor-isolated hints and claim-ID forwarding. **This is not the real Redis Lua and PG suite.** Rerun existing P07 disposable-service CI with zero skips, and review P08 consumers before merge. Historic G07 evidence is not proof of this new queue SHA.

## P08 post-gate hardening (G08 remains owner-accepted; new co-dev SHA needs CI)

Accepted primary G08 at `a09c1578e8dc` is preserved, merged conflict-free into this branch. Post-gate review found and fixed three independent P08 risks: **(1)** HTTP snapshot polling previously trusted a caller's query `actor`; now requires a real host-provided `authenticateHttp(req)` verified principal and fails closed 401 without it, **(2)** one socket could queue unlimited pending transaction/envelope tasks; now 64 pending operations maximum with close 1008, **(3)** scheduling a near timer could shorten a shared Redis due-index TTL and drop later hints; now Lua preserves the maximum TTL. Approved matchmaking, game clocks, 4-theme UI and Coins/Crowns rules unchanged.

**Critical host integration:** Production P09–P11 must wire a real P05 session/bearer verifier to `authenticateHttp` for HTTP polling; `?actor=` is **never** a credential. Without the hook private polling intentionally remains 401. **Further review:** already-redeemed WebSocket session revocation/generation must be checked before sensitive later commands; the new HTTP hook does not solve long-lived socket authorization. See [P08-POST-GATE-HARDENING.md](docs/co-dev/P08-POST-GATE-HARDENING.md).

Tests added: real local HTTP and masked-TCP ingress regressions (`tests/v5-p08-http-auth.test.js`, `tests/v5-p08-ingress-bounds.test.js`), updated real PG+Redis HTTP snapshot fixtures, a new real Redis 2-hour-then-5-second TTL regression, and mandatory no-skip coverage in `v5-postgresql.yml`. The exact source's HTTP decision logic and 96-frame close policy passed V8 fake-Node behavior checks; P17 cross-phase CI guard 6/6 passed V8 tests. **These are not real Node24, PG/Redis or Actions runs** on the changed source. G08 original 36 real PG/Redis tests are only evidence for the original owner SHA; rerun current-head CI before merging.
## What each unit actually contains

### P15 — encrypted PostgreSQL backup, isolated DR

- Sources: `scripts/v5/p15/` and `tests/v5-p15-*.test.js`.
- Full encrypted pg_dump streaming without a plaintext archive, recipient-key separation, verified ciphertext manifests, checksums and R2 write-once/readback contracts. Exact environment/context receipts, independent-restore evidence, freshness/watch logic, negative failure tests and executable synthetic round-trip drills.
- `.github/workflows/v5-p15-disaster-recovery.yml` supplies tightly scoped disposable CI. Detailed record: [P15-DISASTER-RECOVERY.md](docs/co-dev/P15-DISASTER-RECOVERY.md).
- **Not done:** owner-approved recovery/retention targets, tested live off-host key custody/provider R2, actual Neon PITR plan entitlement, measured production RPO/RTO, scheduled drill delivery, G15. The suggested 15-minute freshness / 60-minute recovery values are *candidate policy*, not established SLAs.

### P16 — Core process admission, drain and failover

- **Implemented:** `packages/services/core-instance-lifecycle.js` (bounded readiness/drain), `packages/services/core-drain-connections.js` (socket lifecycle, sync-only callbacks, no false release), `scripts/v5/p16/core-failover-plan.js` (private Core A/B and ready-only routing) and `scripts/v5/p16/ci-perimeter.js` (two-job fail-closed CI scope). No P07 matchmaking or production service edits.
- **Real disposable-service harness committed:** `tests/v5-p16-process-failover.test.js` boots two genuine P06 Core OS processes on an owned PostgreSQL16/Redis7.4, creates/accepts a paid match, commits and ACKs a move, sends SIGKILL to Core A, replays safely through B without extra wallet/outbox effects, continues the match, wipes Redis and reads the unchanged truth from fresh Core C. **CI currently cannot execute due runnerless failures; do not count this harness as a passing test.**
- **Pure/transport coverage:** `tests/v5-p16-lifecycle.test.js`, `tests/v5-p16-connections.test.js`, `tests/v5-p16-real-sockets.test.js`, `tests/v5-p16-topology.test.js`, `tests/v5-p16-ci-perimeter.test.js`. The behavior of four selected lifecycle/topology/TCP checks and the async-callback rejection contract was independently re-created on local Node22 and passed; this is not exact-branch test evidence.
- **CI:** `.github/workflows/v5-p16-core-failover.yml` has read-only V5 push/PR Node24 no-skip jobs, with pinned disposable PG16/Redis, loopback ports, no provider credentials, nonpersistent checkout tokens, and a regression-tested full-workflow perimeter.
- **Operator handoff:** [P16-CORE-FAILOVER-FOUNDATIONS.md](docs/v5/co-dev/P16-CORE-FAILOVER-FOUNDATIONS.md) and [P16-OPERATIONS-AND-ACCEPTANCE.md](docs/v5/co-dev/P16-OPERATIONS-AND-ACCEPTANCE.md) describe the integration contract, real failover exercise, single-edge routing, process-only HA scope, rollback, evidence matrix and untested cases.
- **Dependent G16 work still OPEN:** P08–P10 real Core WebSocket/ticket/durable turn and tournament runtimes, separate staging A/B processes with private health-aware ingress, kill during post-commit/pre-publish and mid-transaction windows, real client reconnect plus deadline arbitration, provider/device/revocation scenarios and measured failover time. Nothing here proves those or authorizes live deployment.

### P17 — independent release engineering

- Sources: `scripts/v5/ci-impact.js`, `scripts/v5/release-*.js`, `scripts/v5/ci-safety-audit.js`, matching `tests/v5-*.test.js`, `.github/workflows/v5-release-engineering.yml`.
- Conservative impact planning, immutable source candidate and migration digest, independent service artifact reference/compatibility verification, GitHub CI provenance checks and PR workflow privilege/secret/output-path audit.
- Detail: [P17-RELEASE-ENGINEERING.md](docs/co-dev/P17-RELEASE-ENGINEERING.md). **Not done:** authenticated private GHCR release, actual ARM64 image deployment, production staged Vercel promotion, live rollback evidence, G17.

### P18 — full staging acceptance scaffolding

- Sources: `scripts/v5/p18/`, `tests/v5-p18-*.test.js`, `.github/workflows/v5-p18-acceptance.yml`.
- Explicit nonproduction topology validation; private/test-only public HEAD probe; acceptance/evidence source pinning; real disposable PG/Redis journey suites (SQLite import/reconciliation, P04 economic differential, P05 identity flows and loss durability); cutover simulation, UI baseline and strict gate refusal.
- Detail: [P18-STAGING-ACCEPTANCE.md](docs/co-dev/P18-STAGING-ACCEPTANCE.md). **Not done:** fully integrated live private Vercel+Core+worker staging; qualified real player/device journeys; owner cutover rehearsal, G18.

### P19 — bounded load and chaos

- Sources: `scripts/v5/p19/`, `tests/v5-p19-*.test.js`, `.github/workflows/v5-p19-load-chaos.yml`.
- Seeded workloads with explicit limits, monotonic latency/throughput metrics, real disposable PG/Redis tests for exact-once economic and outbox invariants, Redis loss and PG stall/reopen fault tests. Fail-closed source checkout/secret and artifact perimeter; synthetic capacity report is **evidence, not a launch budget**.
- Detail: [P19-LOAD-CHAOS.md](docs/co-dev/P19-LOAD-CHAOS.md). **Not done:** production-scale load, measured regional p95/p99, complete multi-Core/worker chaos, approved SLO thresholds, G19.

### P20 — native Android and iOS applications

- Sources: `native/android/`, `native/ios/`, `scripts/v5/native-*`, `tests/v5-native-foundations.test.js`, `.github/workflows/v5-native.yml`.
- Android Kotlin and iOS Swift host shells package the approved same-hash offline game client, origin-bound native identity bridge, encrypted local session storage, native network policy, ads/consent and store billing flows, emulator/simulator/device smoke scripts, and signed-artifact operator procedures.
- Detail: [native/README.md](native/README.md) and [RELEASE-OPERATIONS.md](native/RELEASE-OPERATIONS.md). **Not done:** authorized physical device/store provisioning, final application bundle IDs/team/keystores, real purchase and Sign in with Apple/Google acceptance, native visual parity and G20. Never grant player Crowns locally on a store callback; backend verifies and commits first.

### P22 — production cutover readiness safeguards (PREPARATION ONLY)

- **Scope:** G22 is OPEN. No production authority transfer, frozen V4 writer, provider mutation or deploy was performed. P22 requires P20 completed and all appropriate G00–G20 production/device/recovery evidence. The new P21 website remains deferred.
- **Code and tests:** `scripts/v5/p22/readiness.js` (G00–G20 missing gates, pinned artifact/owner evidence, cannot self-authorize); `writer-fence.js` (16 minimum mutation classes, frozen V4/disabled V5 and retryable no-ACK callback policy); `import-reconciliation.js` (frozen P03 model/run/schema and 12-family digest/count parity); `rollback-policy.js` (P18 pre/post-write cases, UNKNOWN quarantines, no stale SQLite restore); `compatibility-map.js` (retained old-origin browser, origin-bound cookies, old callbacks, Android/iOS and one PG authority). Regression suites: `tests/v5-p22-*.test.js`.
- **CI:** `.github/workflows/v5-p22-cutover-readiness.yml` runs on trusted V5 pushes and review PRs, read-only with pinned checkout with no credentials persisted, zero-skip Node24 tests and the actual owner-ledger no-cutover check. No external provider access.
- **Verification performed:** 31/31 exact fetched pure JavaScript test bodies passed a temporary V8 harness with Node module stubs, **not** an actual Node24/GitHub Actions run. The harness found and prompted fixes to the UNKNOWN-first-write classification and malformed event fixture before rerun; exact-head CI remains required. No G22 acceptance inferred.
- **Detailed handoff:** [P22-CUTOVER-READINESS.md](docs/co-dev/P22-CUTOVER-READINESS.md), covering all V5-22-01 through 06, writer inventory, final consistent-source capture, P03 real importer/reconcile run, historical actor continuity, first-write epoch, rollback classes and post-cutover checks.
- **Remaining owner-executed tasks:** real freeze with tested V4 restart fence, final production snapshot/zero-difference import, actual nonserving deployment, supported-client cookie/callback forwarding, first-write authority transfer, real provider/PG failover, backup/alert delivery and G22 sign-off.

### P23 — V4 retirement, evidence retention and compatibility sunset (PREPARATION ONLY)

- **Blocking prerequisite:** Owner **G22 is OPEN**, with V4 Node/SQLite still the sole live production writer. P23 cannot retire anything now. G00–G20 and G22 are required; owner-deferred G21 is intentionally not required.
- **Four offline contracts:** `scripts/v5/p23/retirement-readiness.js` (same P22 first-write epoch, 16 V4 mutation classes, 6 restart/reboot vectors, permanent PG-only authority); `retention-manifest.js` (8 immutable recovery/history/key-custody artifacts, minimum private retention and 7 alert migration classes, no deletion); `compatibility-sunset.js` (10 browser/native/provider paths, old-origin actor and cookie continuity, ≥90 days zero *complete* telemetry before an **operator-only candidate**); `delivery-report.js` (distinct code, CI, device, signed, store-submitted, store-approved and production-enabled statuses). All return **non-authorizing** review-only results.
- **CI diagnostics:** `scripts/v5/ci-runner-diagnostic.js` distinguishes real test failures from zero-step unallocated jobs without inventing a root cause. `tests/v5-ci-runner-diagnostic.test.js` plus `tests/v5-p23-*.test.js` cover negative cases. `.github/workflows/v5-p23-retirement-foundations.yml` is read-only, pinned, no-secrets, zero-skip and watches both trusted V5 pushes and review PRs. P17's cross-phase CI test also watches P23 dependency triggers.
- **Verification:** 34/34 exact fetched P23/CI test bodies plus 5/5 cross-phase trigger assertions passed a V8 harness with stubbed Node APIs. **Not** Node24 Actions, host reboot, backup retrieval, native build, provider callback or production evidence. GitHub Actions remains blocked before runner allocation.
- **Full handoff:** [P23-RETIREMENT-HANDOFF.md](docs/co-dev/P23-RETIREMENT-HANDOFF.md) and [CI-RUNNER-INCIDENT-2026-10-09.md](docs/co-dev/CI-RUNNER-INCIDENT-2026-10-09.md). No V4 service stop, SQLite deletion, DNS/Vercel/Neon/Oracle/R2 mutation or provider deregistration performed. G23 OPEN.
### P24 — evidence-led capacity/scale reviews (MEASUREMENT-GATED PREPARATION ONLY)

- **Phase picked:** P24 is the next independent remaining phase while the primary agent works through P09–P14. **Hard prerequisite:** real G23 accepted; in the current owner ledger, only G00–G08 are accepted and V4 remains live authority.
- **Baseline:** `scripts/v5/p24/capacity-baseline.js` tracks ten typed aggregate signals across API, Core/WebSocket, matchmaking, PG, worker, Redis and Oracle. Unknowns stay `null`, and P19 synthetic disposable measurements are explicitly not production capacity. No invented player forecast, p95 SLO, or server/price threshold.
- **Costed triggers:** `scripts/v5/p24/scale-policy.js` defines ten conservative, fixed first-remedy actions; every numeric trigger needs a sustained duration, metric-query proof, monthly incremental cost estimate and rollback reference. Owners must approve the policy. Same-host Core A/B does **not** count as host HA; no Kubernetes/Kafka or multi-primary Crown writers.
- **No speculative changes:** `scripts/v5/p24/scaling-review.js` requires G23, declared complete real production observations, at least three adjacent fresh windows above the threshold, and owner-reviewed budget/rollback before returning a **review candidate only**. All outputs explicitly deny production mutation and G24 acceptance. `scripts/v5/p24/review-cli.js` prints unknown/NULL templates and reads only sanitized local `.artifacts/p24-review.json` plus checked-out owner ledger; no provider actions.
- **CI/tests:** `.github/workflows/v5-p24-scale-readiness.yml` is read-only, pinned exact-PR-source SHA, no secrets/deployment and zero-skip on V5 push/PR with P19/P23/PG/Core/topology watchlists. Five test suites plus P17 cross-phase guard. **36/36 P24 and 7/7 cross-phase fetched test bodies passed V8 with stubbed Node modules/virtual FS; NOT real Node24 CI.** GitHub Actions still fails before runner assignment; current-head run and real telemetry/cost/staging gates remain unverified.
- **Owner reference:** [P24-SCALING-HANDOFF.md](docs/co-dev/P24-SCALING-HANDOFF.md) provides the ten-signal capacity inventory, action/validation/rollback plan, recommended weekly owner review, CLI usage and open G24 blockers. **No infrastructure upgrades, resizing, paid services or production changes.**
### Client bundle safety (separate two-file review)

- `scripts/v5/build-client.js` and `tests/v5-client-bundle.test.js` now preflight invalid dependency sources and reject occupied/unexpected/changed output before destructive rebuild. Both upstream base blobs were matched before this review was consolidated; this is not a gameplay/UI change.

## Verification commands and release sequencing

**Read-only/portable:** from the branch checkout with Node >=24 and locked dependencies:

```sh
npm ci
node --test tests/v5-p16-lifecycle.test.js tests/v5-p16-connections.test.js tests/v5-p16-real-sockets.test.js tests/v5-p16-topology.test.js tests/v5-p16-ci-perimeter.test.js
node --test tests/v5-native-foundations.test.js tests/v5-client-bundle.test.js
node --test tests/v5-release-*.test.js tests/v5-ci-*.test.js
node --test tests/v5-p15-archive-manifest.test.js tests/v5-p15-sealed-archive.test.js tests/v5-p15-recovery-policy.test.js
node --test tests/v5-p18-acceptance-registry.test.js tests/v5-p18-isolation.test.js tests/v5-p18-stage-evidence.test.js
node --test tests/v5-p19-workload-profile.test.js tests/v5-p19-metrics.test.js
node --test tests/v5-p08-http-auth.test.js tests/v5-p08-ingress-bounds.test.js # local Node, no providers
node --test tests/v5-p22-*.test.js
node --test tests/v5-p23-*.test.js tests/v5-ci-runner-diagnostic.test.js
node --test tests/v5-p24-*.test.js # pure/offline, no PG, Redis or provider secrets
node scripts/v5/p24/review-cli.js --templates "$(git rev-parse HEAD)" # unknown metric values, NULL thresholds
node scripts/v5/p22/readiness.js --sha "$(git rev-parse HEAD)" # must report BLOCKED until all owner gates and observed evidence are proven
```

**P16 process-kill integration (CI-managed disposable-only):** `tests/v5-p16-process-failover.test.js` requires `V5_PG_URL`, `V5_PG_DISPOSABLE=1`, `V5_PG_REQUIRED=1`, `V5_REDIS_REQUIRED=1`, and a *loopback* `REDIS_URL`. The dedicated P16 workflow supplies these; never run against Neon/managed production Redis. The test is not accepted until it actually runs with zero skips.

**Disposable-only:** `tests/v5-p15-real-roundtrip.test.js`, `tests/v5-p18-disposable-journeys.test.js`, `tests/v5-p19-real-services.test.js`, `tests/v5-p19-real-chaos.test.js` require owned isolated PostgreSQL16 and/or Redis with their workflow's exact environment guards. Use their dedicated CI workflows and read the test files before local execution. **Never** point a disposable harness at a live Neon branch or managed production Redis.

Every PR update must verify the exact source head CI. Keep V5 retained regressions, economy and four-theme UI checks. A green synthetic test is not authority to deploy, purchase anything, activate email/billing, rotate operational keys, change V4 DNS/edge or tick a gate.

## Chronological co-dev checkpoint log

- **2026-10-09 P24 capacity/scale:** Picked the final measurement-gated phase, built offline ten-signal observed baseline (`76f4227`), strict budget/rollback/approval policy (`1e9e6f6`), G23-prerequisite sustained-demand review (`bac8382`), safe local source-scoped CLI (`be4424e`) and no-skip read-only CI (`9365a2f`). Five negative-test suites, and P17 cross-phase compatibility watcher (`f03e95d`). **36/36 P24 + 7/7 cross-phase source-level V8/stub checks passed; NOT GitHub/Node24/actual provider evidence.** G24 OPEN, no production capacity provisioned. [P24 handoff](docs/co-dev/P24-SCALING-HANDOFF.md).


- **2026-10-09 G08 sync and P08 hardening:** Merged accepted primary G08 `a09c1578e8dc` in two-parent `1638ab671c66` (22 files, zero overlap), leaving the owner branch/ledger unchanged. Corrected URL-actor HTTP snapshot disclosure (`99bd99d`), bounded socket pending envelopes to 64 (`c759950`), made Redis due-index TTL monotonic (`222652c`), updated authenticated real-PG recovery fixtures and added standalone HTTP/TCP/real Redis regressions and zero-skip CI coverage. Source-level HTTP decisions and 96-frame 1008 close reproduced in V8 stubs, P17 cross-phase tests 6/6. **Current-head Node24 PG+Redis CI still unexecuted.** Host must wire an actual authenticated HTTP principal; [P08 handoff](docs/co-dev/P08-POST-GATE-HARDENING.md).


- **2026-10-09 P23 preparation:** Added 4 separate source-only modules and negative suites: retirement/G22 lineage + P22 first-write and six reboot vectors (`2ee9ce9`, `3808b95`, `eb7f998`); immutable V4/PG archives and legacy monitors (`1696804`, `7d63f7d`); 90-day, provider-safe old-client/callback sunset advisory (`f0d3c2c`, `12ba54c`); truthful delivery milestones (`49ec22d`, `9d00bbd`). G21 remains deferred, no V4 teardown.
- **2026-10-09 P23 final QA:** Repaired an escaped GitHub concurrency expression in the new workflow (`89bcb7a`), added a regression denying that malformed expression (`db488be`), and reran its actual fetched workflow guard (3/3 source-level tests passed). Exact GitHub runner execution remains blocked; no change to P22/G23 authority.
- **2026-10-09 CI resilience:** Added offline zero-step GitHub Actions triage (`e8f913f`, `0cfa8cf`); new protected P23 CI workflow and guard (`9b45e98`, `53620e4`), source-G22 boundary and cross-phase release CI watch (`0f0c8da`). Verified 34/34 P23+CI and 5/5 cross-phase fetched source test bodies in V8 with Node stubs, **not executed Node24 GitHub CI**. [Incident](docs/co-dev/CI-RUNNER-INCIDENT-2026-10-09.md): zero allocated runners, zero steps, 0ms billed at observed workflow run; account/policy/service root cause unverified.


- **2026-10-09 full integration sweep:** Verified the uploaded original implementation pack's 25-phase/117-task/40-acceptance matrix; reviewed co-dev source graph (95 pre-audit JS/CJS files without syntax or relative-import errors), native Android/iOS source membership, P00–P07 owner state and phase 15–20/22 foundations. Fixed P16/P22/native CI dependency scopes (including real Core/PG changes and direct V5 pushes), added 4 cross-phase regression tests and wired to P17 source CI. **11/11** P16/P22/CI tests passed V8 source evaluation with Node stubs, not Actions. [Detailed audit](docs/co-dev/V5-FULL-INTEGRATION-SWEEP-2026-10-09.md). Observed **9/9** current-head workflows failing at zero runner steps; no production or G-gate completion claimed.


- **2026-10-09 P22 preparation:** Created fail-closed readiness (`031d292`, tests `230c0ebe`), writer catalogue/restart fence (`3808daa`, tests `80c64bfe`), UNKNOWN-first-write-safe rollback classifier (`c1ef7b1`, corrected `69233a9f`, tests `a0250b15`), frozen-source/P03 per-family reconciliation (`0f2041a`, tests `7fb18a34`), retained browser/native/callback compatibility (`8139739`, tests `e629c3db`), PR-only zero-skip workflow (`481f2fb3`, guard tests `43bff773`), and full operator runbook (`da73f4cf`). Later safety fixes refuse parent-traversal evidence refs and symlinked artifact directories. No live service changes.
- **2026-10-09 P22 source verification:** 31/31 exact fetched pure source/test assertions passed with a V8/Node-module-stub harness after repairing three test/policy failures. Not Node24 CI execution or provider evidence. G22 OPEN; missing G08–G20 and runtime cutover.
- **2026-10-09 G07 synchronization:** Merged G07-accepted upstream source SHA `045d5f94a134` into this branch at `41190f99feaa`; 17 files, zero co-dev conflicts, primary branch unchanged.
- **2026-10-09 P07 co-dev hardening:** Fixed Redis claim ABA stale-delete (`a0e6e9e4e6`), actor-scoped match hints (`4a71df36cf`) and PG hydration release (`18362c96da`), updated P07 integration caller IDs and added 3 real-provider regressions. [Handoff](docs/co-dev/P07-POST-GATE-HARDENING.md). Await real source-head Redis/PG CI and P08 compatibility review.


- **2026-10-09 P06 synchronization:** Two-parent merge `dc579856d8c4` integrated the actual G06-passed Core match-observer interfaces from `V5-platform` at `42db7e0ec401` without a conflict or primary branch edit. G06 is accepted in the primary ledger; its exact-head GitHub runs `37900949040` and `37900949132` failed before any runner steps, so there is no claim of new exact-head green CI.
- **2026-10-09 P16 service crash proof and CI:** Added genuine disposable Core A SIGKILL/B resume/C Redis-wipe harness `d1f5cf7194af`; expanded P16 workflow to a pinned PG16/Redis 7.4 second job `2484f43997`. Tests are committed but **not executed** in current runnerless GitHub Actions.
- **2026-10-09 P16 correctness/security:** Fixed rejected Promise-valued transport drain callbacks `ccb8d4934` and added regression `b60237fa2`; introduced full dual-job CI perimeter `e4490864ad`, replacing earlier partial self-audit `125aa1cc9c`, negative tests `c5af24feff`, mandatory nonpersistent checkout `ce7d532048`, guard and tests `2d02eac120`, `1439b0de0b`, test job inclusion `fc91fcbd4e`. Current CI jobs remain blocked before running; no G16 claim.


- **2026-10-09:** Created the unified branch from pinned P06 head; integrated P20, P17, P18, P19, P15 and initial P16 in six separate two-parent merge commits; integrated nonconflicting client bundle safety as a seventh merge commit. Original commits/history preserved.
- **2026-10-09:** Added this consolidated agent handoff and opened [unified PR #9](https://github.com/oculusrex14/Mega-XO/pull/9). Marked old PRs #2–#8 as superseded and closed them; `ops/main-ci-guard` #1 remains separate because it targets `main`.
- **2026-10-09 P16:** Added transport drain registry `9028554f4`, callback/lease tests `eaff8513a`, real local TCP test `626007866`, isolated P16 CI `9bb75de4b` and self-audit correction `8bab7a90f`, private A/B readiness and topology validator `3ced88335` with tests `974f52c08`, workflow coverage `28cb1e3fd`, socket FIN handling `dbc712c4e`, portable error-code assertion `9651fd9fd`, and execution/rollback runbook `7cbdfb78a`. All committed on the single branch.
- **2026-10-09 CI access warning (NOT a source-test pass):** GitHub Actions jobs at head `9651fd9fd` across the eight PR workflows ended `failure` **with zero executed steps and an empty runner name**, e.g. [P16 run 37895373477](https://github.com/oculusrex14/Mega-XO/actions/runs/37895373477) job `113705409649`; logs could not be downloaded (404 missing log blob). The same symptom also appeared at `7cbdfb78a`. Earlier [P17 run 37895127616](https://github.com/oculusrex14/Mega-XO/actions/runs/37895127616) completed successfully at an older source head. **Do not label integrated CI green or diagnose a code failure from jobs that never received a runner.** Ask the repository owner to inspect GitHub Actions billing/runner availability/account notices and rerun current-head PR CI; root cause remains unverified.

## Minimum handoff / merge criteria

- One PR only, containing additive co-dev changes and original merge ancestry; primary agent can review by phase commits.
- PR CI green for current head; negative permission and no-secret checks still active. Treat flaky/skip/force-exit results by source evidence, not assertion.
- Migrate any staging deployment plans to the *actual* P08/P11/P14 service contracts before activation. Do not merge placeholder runtime assumptions into authority.
- Record provider/device/host blockers with owner action in `docs/v5/OPEN-ITEMS.md` **only by the primary agent**, preserving its ledger and evidence provenance.

\n