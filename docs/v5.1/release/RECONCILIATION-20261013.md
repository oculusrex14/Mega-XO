# V5.1 reconciliation of genuine open work (2026-10-13)

Maps the owner directive's priorities to what is genuinely open after this session's work, so stale
statuses are neither repeated nor treated as done. Sources: `docs/v5.1/release/HANDOFF-20261012.md`,
`OPEN-WORK-AND-OWNERS.md`, `MAIN-AUTONOMOUS-WORK-QUEUE.md`, `docs/v5/progress.json`, and this session's
new evidence docs.

## Now closed / advanced this session (with evidence)

| Item | State | Evidence |
| --- | --- | --- |
| Website deployed to isolated staging (was stale `f4851a5`/140 files) | **DONE** | `STAGING-DEPLOY-20261013.md` — live `9628ed7`/153 files, served-byte verified |
| Real two-account online acceptance | **DONE** | `P2-ONLINE-ACCEPTANCE-20261013.md` — 31/31 incl. full game, settlement, economy, resignation |
| Two real staging defects (matchmaker tick, Core wallet provisioning) | **FIXED** | commits `890ec4a`, `11e6f50` |
| Vercel website + API projects | **DONE (preview)** | `VERCEL-DEPLOYMENT-20261013.md` — API reaches real staging Neon |
| Native Android APK + iOS simulator app | **DONE (unsigned)** | `NATIVE-BUILDS-20261013.md` — identical bundle hash 8d335002 |
| Provider/store readiness inventory | **DONE** | `PROVIDER-READINESS-INVENTORY-20261013.md` |
| Account deletion lifecycle (real defect fixed) | **DONE** | `ACCOUNT-DELETION-LIFECYCLE-20261013.md` (fix `1a80ebc`) |
| Backend PG/Redis suites executed | **DONE (local)** | `P6-BACKEND-VERIFICATION-20261013.md` |
| CI trigger gap (10 workflows on the retired branch) | **FIXED** | commits `6e914f0`, `4f907d2`, `ae288ff` — newly-enabled workflows pass |
| Production authority read-only recon | **DONE** | `PRODUCTION-AUTHORITY-RECON-20261013.md` |
| Gameplay capture source merge and staging migrations | **DONE (source/staging schema only)** | PR #12 merge `c384b4d`; `GAMEPLAY-CAPTURE-PR-REVIEW-20261013.md` + `GAMEPLAY-CAPTURE-STAGING-DEPLOY-20261013.md`. Staging capture still OFF, no approved human cohort. |

## Genuinely open (not closed; owner/provider/device/final-approval gated)

| ID | Why still open | Exact owner/dependency |
| --- | --- | --- |
| R03/P8 cutover | Live authority is still V4.1.2/SQLite; no authority transfer | Owner go/no-go + final freeze/import |
| R04/P11 | Deployed process-manager/TLS/private-ingress real composition | Needs a public signed Core edge decision |
| R05/P7 | Full online journey near the DB | **DONE** (co-located acceptance this session) |
| R09/P14 | Provider alert delivery, monitor IDs, `read:packages` | Provider/console access |
| R10 hosting | Vercel project now exists; region/capacity/recovery plan | Owner plan approval |
| R11/P20 | Signed physical-device apps + real identity/commerce/ads | Devices + provider entitlements |
| R12 store | Play/App Store membership, listings, entitlements | Owner MFA/attestations/fees |
| R13 commerce | Product/SKU/billing/consent/ad sandbox + receipts | Provider setup |
| R14/R29 | Policy/pricing/launch-scope decisions | Owner |
| R17 | Physical browser/a11y/CWV sign-off | Device + owner review (automated a11y now exists) |
| R18 | Domain attach + indexing/crawl/backlink | Owner DNS + launch approval |
| R21 | Moderated first-time-user study | People |
| R25/R26/R27/R28 | Teacher/distillation/quantization/model release | **TRAINING DEFERRED BY OWNER** |
| R30/R31/R32 | Cutover/retirement/scaling | Owner authorization; measured demand |
| R33/R34 | Paid native Neon; rewarded online Impossible | Separate owner scope |
| P7 collector source merge | **DONE** — PR #12 merged into V5.1 at `c384b4d`, with 0044-0049 migrations and least-privilege capture functions | Main merged after independent review; no need to re-merge feature branch. Real staging schema/role probes are complete; data collection is disabled pending DC00 approval. |
| R35/DC00 gameplay consent/purpose/retention | **BLOCKED_DECISION** — owner approval and user-choice integration not evidenced | Human + Main; collection remains off until policy, disclosures, retention windows and storage approval. |
| R36/DC06 capture operations | **PARTIAL** — isolated lab worker/reconcile/recovery verified; no sustained real staging schedules/canary/alerting | Main installs and proves private worker, reconcile, metrics, erasure, purge, journal, alerting and zero-missing cohort. |
| R37/DC08 privacy restore | **PARTIAL** — isolated lab suppression/erasure/export revocation verified; actual backup replay and authenticated user choice still missing | Main + human; restore in nonserving target with latest privacy journal; retain deletion obligations during failback. |
| R38/DC10-12 collection release gate | **BLOCKED_RELEASE** — 15 receipts and exact policy/source binding not accepted on staging | Main + human; staging cohort, PG/Redis drills, latency/size, zero missing games, source and policy hashes, independent go/no-go. |
| R02/CI post-merge | **REPAIRED_PENDING_CI** — V5 PostgreSQL integration failed run 38393227603, P11 read-only queue 503 because the job omitted its Redis URL | WebUI PR #13 sets only step-scoped Redis configuration; must re-run 48 P11 tests plus full PG suite and preserve unconfigured-Core 503 negative. |

## Not claimed

No device/provider/production/live acceptance is claimed anywhere it was not actually exercised.
The training programme and Impossible remain deferred.

## WebUI post-merge evidence correction

The four new numbered owner packages R35–R38 are now part of `OPEN-WORK-AND-OWNERS.md`. The previous P7 'PR open' statement is superseded by GitHub PR #12 `merged_at=2026-10-13T11:05:55Z`, merge SHA `c384b4d8a9a640b68207e5021dc807b1436726fa`, and branch ancestry verification. `V4.1` and `main` were not merged/deployed by this reconciliation. CI is separate from live release authority; no result may be labeled PASS until an exact-SHA job actually completes. Training and Impossible remain owner-deferred.
