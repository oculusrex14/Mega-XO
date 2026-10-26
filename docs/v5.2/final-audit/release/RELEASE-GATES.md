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
| Required platform compliance | PARTIAL → STRONGER | Deletion cooling-off + in-app cancellation + worker completion IMPLEMENTED (#57, SAGAN-004/F054 closed in V6); Play forms 11/11 COMPLETE (PR #60, db071f7): Data safety all types saved, IARC ratings, category, listing with creatives; iOS console owner-blocked (auth) |
| Successful production-equivalent build | PASS | 1.0.10/versionCode 11 APK+AAB rebuilt for the Play API-36 requirement (compileSdk/targetSdk 36, commit 13086f5) with production AdMob units verified in-artifact (84c1c2b5 APK / 044ee08a AAB, direct-apk vs google-play distributions verified in dex); device 5199676e reinstalled and launched. Supersedes the 1.0.9 45272a37 build which Play REJECTED for targetSdk 35 |
| Critical end-to-end tests passing | PASS | Audit regression, account-deletion lifecycle, promotion unit+PG, foundations suites green on merged heads |
| Rollback procedure documented AND tested | PASS (unchanged) | ROLLBACK-PLAN.md + the deployed change-aware backup gate with LSN watermarks |
| Required human approvals identified | PASS | Owner items: Play closed-test (12 testers, 14 days) before production, iOS console auth, secret rotation (deferred per owner), final batch-deploy say-so |
| No unexplained critical disabled features | PASS | Polar dormant BY OWNER DECISION (Dodo primary); Apple sign-in hidden on Android BY DESIGN; every flag documented |

**V6-cycle verdict: NO-GO for the batch update (Sol 6.1 independent review, 2026-10-20,
/tmp/sol-v6-review/REVIEW.md).** The review found nine findings R1-R9 (P1): the website builder
TDZ (R1), the disclosure-HMAC composition (R2), the signed-gateway projection (R3), the native
promotion bypass (R4), the undo/hint ticket schema gap (R5), the schema-incompatible rollback
trap (R6), the dropped PR #53 protections (R7), the stale 1.0.8 download pin (R8 - FIXED in
2ee0c38), and the SDK-36 predictive-back regression (R9). The earlier "merged-head end-to-end
PASS / unchanged tested rollback" claims in this table are NOT supported for the candidate and
are superseded by the review. Deployment is blocked until every finding is fixed, a new
integration SHA is pinned, exact-SHA GitHub CI is green, and a fresh independent review passes.
Owner items unchanged: Play closed-test (12 physical testers, 14 days; internal track already
ACTIVE with release 11 (1.0.10) published 2026-10-20 11:07 IST, opt-in
https://play.google.com/apps/internaltest/4700778741227096719), iOS console auth, D2 on-device
rewarded-ad pass, A4 48h verdict (2026-10-21), A5 final reconciliation.

**Second-round update (Sol re-review of b7530b5, 2026-10-20,
/tmp/sol-v6-review/REVIEW-b7530b5.md):** R1/R2/R3/R5/R7 verified FIXED; R8 config fixed.
Remaining N1-N8 were then corrected on V6 (commits d16e76d, cd518e4, 9e2be6b, 05b3ee4, 68cc9d6):
reservation product/quantity binding, device-platform provider selection, valid manifest XML
with the compiled opt-out, pre-swap compatibility facts with fail-closed recovery, native
continuation lane, purchase-time grandfathering plus durable rejection reconciliation
(migration 0069), and the updated gateway assertion. Native artifacts REBUILT at
1.0.11/versionCode 12 (APK 20d7efb3... / AAB c79b905b...), download pin megaxo-1.0.11.apk.
Exact-candidate CI on the final source: run 39382503049 (base 05b3ee4, docs-only tip 68cc9d6)
- ALL FIVE jobs success. Verdict: PENDING the fresh independent review of 68cc9d6 and the
A4 verdict (2026-10-21); the Play internal AAB for vc12 still needs uploading (operational).
 
 ## V6 batch deployment gates at the deployed release 0a67857 (2026-10-20, live)
 
 | Gate | Verdict | Evidence |
 |---|---|---|
 | No unresolved P0 vulnerabilities | PASS | Sol final GO for f14dcba; native billing unmounted (verified twice); no secrets printed or committed |
 | No unresolved P0 data-integrity defects | PASS | Migration chain 0065-0069 verified 69/69 (SCRAM-SHA-256-PLUS) on production; the verified pre-migration checkpoint 10:46:54Z plus dated rollback archives for 2bfdf24c5529 and 0a6785782d80 |
 | Core gameplay validated | PASS | Device 1.0.11 post-deploy: launch, session persistence (wallet 157 Coins), all screens render |
 | Production identity and wallet authority verified | PASS | readyz ready:true db verified; the served APK sha256 20d7efb3 EXACT match; all 12 public routes 200; llms.txt and security.txt now live |
 | Purchases validated where enabled | PASS (scoped) | Web checkout lanes live (Dodo primary); the promotion policy PUBLISHED (rule_hash 09cfc1a1..., cap 22,000); native billing stays unmounted until N6/N7 |
 | Required platform compliance | PARTIAL | Data Safety and listing saved; the 12-tester/14-day closed test and the final submission click remain owner gates |
 | Successful production-equivalent build | PASS | CI 39409424251 all five jobs on f14dcba; deploy receipts for 2bfdf24 and 0a67857 |
 | Critical end-to-end tests passing | PASS | 28/28 in the promotion-postgres lane including the four behavioral presence cases; device email sign-in and the online-play queue verified |
 | Rollback procedure documented AND tested | PASS | Two dated rollback archives; the forward-recovery rehearsal on a Neon branch (chain verified); the failure-handler fail-safe tested |
 | Required human approvals identified | PASS | The owner standing order (deploy when ready) plus the Sol GO; the store submissions remain owner-click gates |
 | No unexplained critical disabled features | PASS | The presence noise fix documented (decision log 15:05/16:00/17:20 IST 2026-10-20); the guardrail register unchanged |
 
 A4 (Neon idle budget) sequencing live: the pre-deploy window FAILED with the root cause recorded (ambient presence writes forced full dumps, ~600MB/day); the fix is deployed and verified (durable presence rows FROZE post-deploy); the post-deploy 48h two-snapshot soak (baseline snapshot-postdeploy-baseline.json, 11:22:33Z) is the gate of record - 24h interim check Oct 21, final verdict Oct 22.
 
 Verdict at the deployed release 0a67857: the batch is LIVE and verified; the remaining owner gates are the store submissions, the on-device rewarded-ad impression, and the A4 48h measurement.

## Store payment + A4 permanent fix at the deployed release 5a524dc (2026-10-25, live)

| Gate | Verdict | Evidence |
|---|---|---|
| Independent review | PASS | Sol GO for 5a524dc (REVIEW-5A524DC.md) after two NO-GO rounds (REVIEW-8e26ec6 PF1/PF2, REVIEW-PF-20261024 PF24-R1/R2, A4-DESIGN-20261024) — all blockers closed with regression coverage |
| Exact-candidate CI | PASS | GitHub run 40126289457 on 5a524dc: all five jobs (73 wiring / 32 real-PG / 13 gates / native-contract / website-build), zero failures or skips |
| Payment recovery | PASS | Actor-bound disposition endpoint with conservative provenNonCreation; IndexedDB CAS records (stale K1 put throws, stale retire is a no-op, K2 survives); stranded create-failure test; failed payments stay resumable; verified/refunded only from the actor-bound status endpoint |
| Backup no-change proof | PASS | Migration 0070 (64 transactional lanes + ALWAYS triggers incl partitions + DDL event triggers); archive-bound sequence identities via the SAME pg_dump bytes; setval ABA counterexample refused; proofs bound to manifest+archive hashes and the live prod-source target; unavailable probe fails open to a full dump |
| Production deployment | PASS | Writers fenced 19:42Z; checkpoint archive v5-p15-...-75c5663f8f72c76c; source 5a524dc + bundle bedc18a1 (172 files) deployed; the new server REFUSED schema-69 (SCHEMA_INCOMPATIBLE, fail-closed) then 0070 applied (SCRAM-SHA-256-PLUS); change-aware scripts installed with preflight OK (rollback install-rollback-20261024T194922Z) |
| Live verification | PASS | readyz ready:true db verified; 12/12 public routes 200; served APK sha256 20d7efb3 EXACT pin; security.txt + llms.txt 200; store renders data-checkout-status |

 A4 sequencing CORRECTED: the Oct-20 root cause was incomplete — Neon's CONTROL database writes the same cluster WAL (measured: source counters static, postgres tup_updated +1, WAL +248B/46s), so a cluster LSN can never prove game-data idleness; the old snapshots also stored CU-seconds under activeTimeSeconds. The corrected v2 collector separates wall-clock active time from compute-unit seconds, and snapshot-soak-baseline-v2.json (19:50:42Z) is the gate of record: <=5% wall-clock awake and <=50MB/day over the next 48h. The first new-gate cycle (19:53Z) took a full dump to establish the watermark; subsequent idle cycles must skip. REMAINING for the compute half of A4: park the worker/matcher/commerce timers behind real deadlines per the sidecar plan (idle SQL polling every 5-30s keeps the compute awake regardless of backup skips) — not yet implemented.


## A4 compute close-out (Option B) at the deployed release da888ac (2026-10-26, live)

| Item | Status | Evidence |
| --- | --- | --- |
| Owner decision | CLOSED | "Option B sounds like the only reasonable one. As of now C and D are outright rejected." (2026-10-26) |
| Independent review | PASS | Sol GO for da888ac (REVIEW-A4-R7.md) after NO-GO rounds R4/R5/R6 (REVIEW-A4-R5.md, REVIEW-A4-R6.md) - every blocker closed with regression coverage |
| Exact-SHA CI | PASS | run 40294645431, all five jobs (promotion-postgres 35/35, promotion-wiring 100/100, post-deploy-gates, website-build, native-contract) |
| Deployment | LIVE | DEPLOY_VERIFIED 14:25-14:27 IST; readyz ready:true db verified; rollback archive 2026-10-26T08-55-17-749Z-49259-da888ac949cd |
| Backup policy | APPLIED | change-aware installer OK (preflight verified scoped TLS backup_reader LSN; rollback install-rollback-20261026T085639Z); mega-xo-v5-backup.timer DISABLED; freshness timer active; backup-policy.json idleProofWindowSeconds=9000 |
| Route/hash verification | PASS | host source hashes match the pinned tree (pool.js 60edddcd, tournament-timer.js 37e8bc4d); served APK 20d7efb3 EXACT pin; 12/12 public routes 200 + /readyz /livez /health /.well-known/security.txt 200 |
| A4 verdict | PENDING SOAK | NOT an A4 PASS: 48h soak restarted with snapshot-soak2-baseline-20261026T0858Z.json (08:58:15Z, computeTimeSeconds 142711); 24h interim check ~08:58Z Oct 27, final verdict ~08:58Z Oct 28 via v5-idle-probe.js (fail-closed) |
| Non-blocking follow-ups | DOCUMENTED | R7-F1 export the custom-service attempt-budget fallback constant; R7-F2 tournament-timer cancellation should use the injected timers object consistently |
