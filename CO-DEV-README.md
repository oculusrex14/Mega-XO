# Mega XO V5 — unified co-development handoff

**Canonical branch:** `co-dev/v5-integration`  
**Integration target:** `V5-platform` (main execution agent owns that branch)  
**Owner:** independent co-developer; **status:** preparatory implementation, NOT formal phase acceptance  
**Started:** 2026-10-09 UTC  
**Pinned starting V5 base:** `e8d049bf50862897f546e531def12715a36c670c` (other agent's latest P06 checkpoint when branch was created)  
**Work policy:** only this branch receives new co-development commits. Do not ask the integration agent to inspect/merge individual phase PRs.

## Quick start for the primary agent

1. Review the **single unified PR** from `co-dev/v5-integration` to `V5-platform`. Its commits preserve the entire incremental history from the original branches via two-parent Git merges, rather than dropping previous work into one squash.
2. Read this file, then the phase-specific notes linked below. This file is updated whenever a meaningful co-dev work unit lands.
3. Run read-only PR CI and isolated tests. **Merge only after current `V5-platform` contracts and tests pass** and dependent P06–P14 changes are accounted for. Pull in changes via Git only; no live staging or production rollout is implied by merge.
4. Do **not** close G15/G16/G17/G18/G19/G20 based solely on this source. The master ledger `docs/v5/progress.json`, its generated `TODO.md`, and runtime/Neon/Redis credentials remain the primary agent's authority.

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

- The **primary agent** currently owns P06 (managed Redis/Core integration) and subsequent online platform P07–P14; follow its task ledger, real provider evidence and exact service interfaces. This branch never overwrites the primary agent's `packages/services/core.js`, `packages/services/ephemera.js`, schema/migrations, environment inventories, `deploy/compose.yaml`, production Caddyfile, or `docs/v5/progress.json`.
- The **co-developer** owns additive, phase-scoped P15–P20 foundations plus client bundle build safety. All future work lands on this one branch, with small, meaningful commits and an updated README.
- **No V4 changes**, no current production authority transfer, no modifying R2/Neon/Redis/provider objects, no store submission, no new external ports, and no credentials in Git.
- P21 (new website/browser product) is **explicitly owner-deferred**; do not start it. P22 depends on P20 rather than the deferred website. P24 is measurement-gated.
- Formal proof comes from **executed** CI/staging/device/provider runs attached to the exact integrated source SHA. Standalone local/CI tests do not automatically transfer G-phase acceptance to a newer integration head.

## What each unit actually contains

### P15 — encrypted PostgreSQL backup, isolated DR

- Sources: `scripts/v5/p15/` and `tests/v5-p15-*.test.js`.
- Full encrypted pg_dump streaming without a plaintext archive, recipient-key separation, verified ciphertext manifests, checksums and R2 write-once/readback contracts. Exact environment/context receipts, independent-restore evidence, freshness/watch logic, negative failure tests and executable synthetic round-trip drills.
- ` .github/workflows/v5-p15-disaster-recovery.yml` (remove this paragraph's leading display space when entering the path) supplies tightly scoped disposable CI. Detailed record: [P15-DISASTER-RECOVERY.md](docs/co-dev/P15-DISASTER-RECOVERY.md).
- **Not done:** owner-approved recovery/retention targets, tested live off-host key custody/provider R2, actual Neon PITR plan entitlement, measured production RPO/RTO, scheduled drill delivery, G15. The suggested 15-minute freshness / 60-minute recovery values are *candidate policy*, not established SLAs.

### P16 — Core process admission, drain and failover

- Current sources: `packages/services/core-instance-lifecycle.js`, `tests/v5-p16-lifecycle.test.js`, [P16-CORE-FAILOVER-FOUNDATIONS.md](docs/v5/co-dev/P16-CORE-FAILOVER-FOUNDATIONS.md).
- Process-local BOOTING/READY/DRAINING/STOPPED, bounded connection capacity, no new admissions while draining, idempotent release and explicit drain deadlines, no false success on active sessions.
- **Next additive units on this same branch:** transport-neutral socket drain coordinator with tested socket close/reconnect signaling; private A/B topology and health-routing contracts; failure-domain/rollout runbook; real dual-Core failover harness once P08 durable protocols exist. Do not invent acknowledged move or tournament recovery without executing it.
- **Not done:** runtime Core A/B integration, private ingress routing, actual killed-process/surviving-process proof, G16. Same-host A/B is **process availability only**, never Oracle/edge/zone HA.

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

### Client bundle safety (separate two-file review)

- `scripts/v5/build-client.js` and `tests/v5-client-bundle.test.js` now preflight invalid dependency sources and reject occupied/unexpected/changed output before destructive rebuild. Both upstream base blobs were matched before this review was consolidated; this is not a gameplay/UI change.

## Verification commands and release sequencing

**Read-only/portable:** from the branch checkout with Node >=24 and locked dependencies:

```sh
npm ci
node --test tests/v5-p16-lifecycle.test.js
node --test tests/v5-native-foundations.test.js tests/v5-client-bundle.test.js
node --test tests/v5-release-*.test.js tests/v5-ci-*.test.js
node --test tests/v5-p15-archive-manifest.test.js tests/v5-p15-sealed-archive.test.js tests/v5-p15-recovery-policy.test.js
node --test tests/v5-p18-acceptance-registry.test.js tests/v5-p18-isolation.test.js tests/v5-p18-stage-evidence.test.js
node --test tests/v5-p19-workload-profile.test.js tests/v5-p19-metrics.test.js
```

**Disposable-only:** `tests/v5-p15-real-roundtrip.test.js`, `tests/v5-p18-disposable-journeys.test.js`, `tests/v5-p19-real-services.test.js`, `tests/v5-p19-real-chaos.test.js` require owned isolated PostgreSQL16 and/or Redis with their workflow's exact environment guards. Use their dedicated CI workflows and read the test files before local execution. **Never** point a disposable harness at a live Neon branch or managed production Redis.

Every PR update must verify the exact source head CI. Keep V5 retained regressions, economy and four-theme UI checks. A green synthetic test is not authority to deploy, purchase anything, activate email/billing, rotate operational keys, change V4 DNS/edge or tick a gate.

## Chronological co-dev checkpoint log

- **2026-10-09:** Created the unified branch from pinned P06 head; integrated P20, P17, P18, P19, P15 and initial P16 in six separate two-parent merge commits; integrated nonconflicting client bundle safety as a seventh merge commit. Original commits/history preserved.
- **2026-10-09:** Added this consolidated agent handoff. Subsequent P16 units and measured CI outcomes will be appended here, with exact commits and outstanding limitations.

## Minimum handoff / merge criteria

- One PR only, containing additive co-dev changes and original merge ancestry; primary agent can review by phase commits.
- PR CI green for current head; negative permission and no-secret checks still active. Treat flaky/skip/force-exit results by source evidence, not assertion.
- Migrate any staging deployment plans to the *actual* P08/P11/P14 service contracts before activation. Do not merge placeholder runtime assumptions into authority.
- Record provider/device/host blockers with owner action in `docs/v5/OPEN-ITEMS.md` **only by the primary agent**, preserving its ledger and evidence provenance.

\n