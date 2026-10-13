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
| P7 collector | WebUI PR #12 open — under review this session | Reviewed before first public V5 games |

## Not claimed

No device/provider/production/live acceptance is claimed anywhere it was not actually exercised.
The training programme and Impossible remain deferred.
