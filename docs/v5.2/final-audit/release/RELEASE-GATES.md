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
