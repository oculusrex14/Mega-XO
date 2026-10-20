# Release Gates — V5.2 (audit head ecab098, 2026-10-17)

Gate verdicts from the owner brief (Part 10.4). Evidence: MASTER-FINDINGS.csv, planck/sagan finding CSVs, TEST-RESULTS.md.

| Gate | Verdict | Evidence / blocking findings |
|---|---|---|
| No unresolved P0 vulnerabilities | FAIL | MXA-INF-002 (production retention bound to staging paths - data-safety) |
| No unresolved P0 data-integrity defects | FAIL | MXA-INF-001 (deploy rollback strips runtime-critical files - recovery claim false) |
| Core gameplay validated | PASS (engine + CI) | 25 CI lanes green on audit head incl. browser-realtime 3 engines; no device replay yet |
| Production identity and wallet authority verified | PARTIAL | PostgreSQL authority confirmed; live API is stale (404 on contracted routes) until authorized deploy |
| Purchases validated where enabled | FAIL | MXA-ECO-004/005/014 (native billing not mounted, no RTDN/ASN routes, no device purchase pass); MXA-ECO-006..013 provider/ledger defects |
| Required platform compliance | PARTIAL | Account deletion intake exists; promised cancellation does not (SAGAN-004); AASA env gap MXA-REL-002 |
| Successful production-equivalent build | PASS | validate + source-and-android + android + ios-simulator green on audit head |
| Critical end-to-end tests passing | PASS (candidate) / NOT_RUN (live) | CI green; live E2E blocked on deploy gate |
| Rollback procedure documented AND tested | FAIL | MXA-INF-001: current deploy script rollback is unsafe; plan rewritten in ROLLBACK-PLAN.md, proof pending |
| Required human approvals identified | PASS | Listed in EXECUTIVE-SUMMARY and STORE-SUBMISSION-READINESS.md |
| No unexplained critical disabled features | PASS | GUARDRAIL-INVENTORY.csv: every retained restriction explained; 1 config-drift blocker removed (MXA-REL-001) |

**Verdict at audit head: NO-GO (superseded below).** The two P0s and the commerce P1 cluster were the blockers; see FINAL-LAUNCH-VERDICT.md for the path that was followed.

## Final gate re-run at the deployed release candidate 0c4b9ac (2026-10-18)

| Gate | Verdict | Evidence |
|---|---|---|
| No unresolved P0 vulnerabilities | PASS | MXA-INF-002 closed (retention fail-closed, journal-verified); MXA-SEC-002 headers verified live (CSP, HSTS, XCTO, XFO) |
| No unresolved P0 data-integrity defects | PASS | MXA-INF-001 closed (copy-from-archive rollback semantics + rehearsal proofs); the 2026-10-18 deploy produced a complete dated archive |
| Core gameplay validated | PASS (engine + CI) | 32/32 CI checks on 0c4b9ac incl. realtime x3; device replay remains an owner item |
| Production identity and wallet authority verified | PASS | 0c4b9ac deployed to https://megaxo.online; guest /api/monetization/status 401; exchange route live (401 guest); AASA two-team appIDs |
| Purchases validated where enabled | PARTIAL | ECO-005 code-complete (live 200 requires provider env + inventory flip); ECO-004 owner-external console setup; ECO-014 device matrix owner-authorized |
| Required platform compliance | PARTIAL | Account deletion intake exists; Data Safety and rating attestations are owner actions |
| Successful production-equivalent build | PASS | validate + source-and-android green on 0c4b9ac; the same tree is deployed and serving |
| Critical end-to-end tests passing | PASS | CI green; live smoke: home full game shell, /sponsors all sections, download APK lane |
| Rollback procedure documented AND tested | PASS | ROLLBACK-PLAN.md rehearsed; rollback point rollback/2026-10-18T04-12-00Z-manual-0c4b9ac43ae |
| Required human approvals identified | PASS | STORE-SUBMISSION-READINESS.md lists owner actions |
| No unexplained critical disabled features | PASS | GUARDRAIL-INVENTORY.csv; B3 Apple-on-Android = documented HIDE; ECO-015 scoped |

**Final verdict: CONDITIONAL GO - production is live and healthy on 0c4b9ac.** Every remaining item is an owner-external dependency (store console products, Data Safety and rating attestations, ECO-014 device matrix, Polar live-mode, storeNotifications inventory flip, secret rotation), not a code or infrastructure defect. See EXECUTIVE-SUMMARY.md for the exact list.

## V6 cycle gate reconciliation (2026-10-20, trunk 0493d3d, NOT yet deployed)

Production still serves the V5.2 line (edbf8f4 bundle 6e9e1c8d…, megaxo-1.0.8.apk). The V6 trunk
is the single batch-update candidate; this table records the CYCLE's verified movement only. The
batch deploy requires the Sol 6.1 review (owner standing order) and the owner release approval.

| Gate | V6-cycle verdict | Evidence |
|---|---|---|
| No unresolved P0 vulnerabilities | PASS (unchanged) | No new P0s; PR #56/#57/#58 lanes green incl. audited-boundaries |
| No unresolved P0 data-integrity defects | PASS (unchanged) | 0065-0067 additive migrations with manifest SHA + conformance; promotion cap and deletion cooling PG-tested (39314412514, 39350358485, 39352353682) |
| Core gameplay validated | PASS (engine + CI); device replay owner item | No gameplay changes in the cycle; 1.0.9 device install verified (7228a41e→01ac4736 final) |
| Production identity and wallet authority verified | PASS (unchanged) | Oracle V5 authority untouched during the cycle; readyz healthy at every check |
| Purchases validated where enabled | PARTIAL → STRONGER | Dodo live + intro pricing + LAUNCH50 promo (auto-revert armed); power-spend contract fixed (#54); promotion cap enforced pre-billing (#55/#56); native RTDN/store notifications remain owner-external |
| Required platform compliance | PARTIAL → STRONGER | Deletion cooling-off + in-app cancellation + worker completion IMPLEMENTED (#57, SAGAN-004/F054 closed in V6); Play Data safety draft 8/11 tasks, IARC ratings issued; iOS console owner-blocked (auth) |
| Successful production-equivalent build | PASS | 1.0.9/versionCode 10 APK+AAB with production AdMob units verified in-artifact (01ac4736 APK / 45272a37 AAB); the embedded bundle carries the B4 cooling UI |
| Critical end-to-end tests passing | PASS | Audit regression, account-deletion lifecycle, promotion unit+PG, foundations suites green on merged heads |
| Rollback procedure documented AND tested | PASS (unchanged) | ROLLBACK-PLAN.md + the deployed change-aware backup gate with LSN watermarks |
| Required human approvals identified | PASS | Owner items: Play closed-test (12 testers, 14 days) before production, iOS console auth, secret rotation (deferred per owner), final batch-deploy say-so |
| No unexplained critical disabled features | PASS | Polar dormant BY OWNER DECISION (Dodo primary); Apple sign-in hidden on Android BY DESIGN; every flag documented |

**V6-cycle verdict: CONDITIONAL GO for the batch update.** Remaining before deploy: Newton's B2
forms (Data safety completion, category, listing), owner's Play closed-test + iOS console, D2
on-device rewarded-ad pass, A4 48h verdict (2026-10-21), A5 final reconciliation, Sol 6.1 review.
