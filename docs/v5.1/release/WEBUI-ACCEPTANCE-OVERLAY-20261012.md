# Independent acceptance overlay - 12 October 2026

This supplements, rather than silently rewrites, the original ledgers and the shared owner register. Audit source baseline: **b6b1f46121a565b06a21309fe4465df635cdbad9**. Tooling/protocol CI checkpoint: **cc2c0fd833ba84d1c775973d1a42eb0d63ce018d**. Subsequent WebUI changes are isolated audit tools/tests/documents. Full inventories are reproducible with `python3 scripts/v51-readiness-audit.py --output .artifacts/readiness/inventory.json`.

## Evidence vocabulary and limits

**IMPLEMENTED** describes source, not acceptance. **CI-SUBSET** means an observed relevant automated exercise, not the entire original acceptance contract. **OWNER-REPORTED** means recorded by Main/Codex without independent execution here. **PENDING** means the required environment/evidence has not been independently established; it does not mean the code is absent. **BLOCKED/DEFERRED** remain explicit decisions or dependencies. No row below grants production acceptance or provider approval.

Machine inventory retains each original task ID, title, verification contract, source evidence, source hash and recorded status, separately from LOCAL, CI, STAGING, PHYSICAL_DEVICE, PROVIDER_CONFIGURED, PROVIDER_SUBMITTED, PROVIDER_APPROVED and PRODUCTION_ACCEPTED. Unknown evidence is not silently converted to UNIMPLEMENTED. CI provenance must not be inherited by unrelated later changes.

## Independently inspected evidence index

| Ref | Environment, exact source and result | Scope / limitation |
| --- | --- | --- |
| E1 | Run 38267846919, b6b1f46; artifact 11755323344. PostgreSQL/Redis service TAP: 729 tests, 726 pass, 0 fail, 3 skip. TAP SHA256 `59ccfb294785081a1c8ec9000abac3ab509f51487d1f1030adb9d069a5b9a31b`. | Complete test summary and successful test/upload steps retained. Job's eventual conclusion is CANCELLED, not a green overall workflow. Source fixes CI01/CI02 are independently evidenced by the completed tests, not by calling this run globally green. |
| E2 | Run 38267846892, same b6b1f46; artifact 11756005358. Dedicated P15/P19: 3 pass, 0 fail, 0 skip. Log SHA256 `8be1ec713b42b845ba87089f5345a165c30191e34b5e8a3b40c94f4b7417dabd`. | Covers exactly the three generic-suite skips. P15 uses two independent disposable PG16 databases. Receipt explicitly leaves R2 retrieval, actual RPO/RTO, secrets/roles reconstruction, Neon PITR, backup conflict and G15 acceptance false. |
| E3 | Run 38269273204, cc2c0fd; source-evidence job 114879198961 PASS; 20 new tooling tests PASS. Model-safety job 114879199197 FAIL with all seven negative probes reproducing defects. | New research-operator safety gate is genuinely RED. Main must fix or resolve the contracts; no continue-on-error or replacement of original suites. |
| E4 | Run 38267846919, b6b1f46: Android debug compile/unit/offline bundle/emulator steps PASS; iOS unsigned simulator compile/offline first launch PASS; Firefox and WebKit tutorial reload jobs PASS. | CI/emulator/simulator only. Not signed release artifacts installed on physical phones, store approval, device accessibility or novice comprehension. |
| E5 | Run 38269273010, cc2c0fd: static-website and browser-presentation jobs PASS; desktop/tablet/mobile, automatic WCAG and keyboard steps PASS. | P21 local CI presentation evidence. Not every checklist item, deployed provider integration, screen-reader usability, owner visual acceptance, DNS/commercial eligibility or publication. |
| E6 | WebUI text snapshot, Node 22.16.0/Python 3.13.5: 17 security regressions PASS; bounded bot suite 39 total, 38 PASS, 0 FAIL, 1 dependency SKIP. New audit/model/register tool tests 26 PASS locally. | No local PG/Redis, ML training, SSH, provider or physical-device execution. Earlier larger bot batch timed out without a final summary and is NOT PASS. New 20-test tool subset also passed CI under Node24/Python3.12 (E3). |
| E7 | Main's committed production inventory, isolated-composition, online-journey, learning-cycle and teacher experiment reports. | Reviewable source claims, not WebUI SSH/DGX/provider execution. Relevant service fixtures additionally supported by E1; actual staged private topology and real provider/device acceptance remain separate. |

The later cc2c0fd extended run 38269273069 has passing Firefox/WebKit jobs but CANCELLED Android/iOS/service jobs. It does not replace E1/E4 with complete newer evidence. Exact final-head rerun after integration remains R02 work.

## Recomputed source labels

| Ledger | Total | Source states | Independent interpretation |
| --- | ---: | --- | --- |
| Original platform tasks | 117 | 104 COMPLETE; 4 IMPLEMENTED; 9 PLANNED | Historical software progress; not 104 accepted release contracts. |
| Original acceptance | 40 | 2 PASS (A04/A05); 38 NOT_RUN | Preserve recorded labels; automated subcase coverage below supersedes the inference that nothing has been tested. |
| Bot/tutorial | 82 | 49 DONE; 24 PARTIAL; 7 BLOCKED; 2 DEFERRED | No approved Impossible inferred; operator implementation exists but fails independent safety/recovery contracts. |
| P21 website | 230 checkboxes | 70 checked; 160 unchecked | All 160 original unchecked obligations retained. Stable text-derived audit IDs avoid reassigning snapshot-relative P21-K identifiers. |

These overlapping totals must not be added into a completion percentage.

## All 25 original phases

| Phase | Source/observed state | Remaining release boundary / owner |
| --- | --- | --- |
| P00 | Historical software complete; source/branch/evidence inventory refreshed | Final accepted source/visual baseline, backup-conflict reconciliation, exact-build sign-off; WebUI/Main/Human. |
| P01 | Implemented service/repository separation; CI-SUBSET E1/E6 | Deployed process/credential separation and integration acceptance; Main. |
| P02 | Implemented schema/role framework; E1 plus owner A04/A05 PASS | Verify intended actual environments/grants and release migration compatibility; Main. |
| P03 | Implemented import/reconciliation; E1 fixture proof | Real frozen source coverage, per-actor equality, interruption rehearsal and final authorized import; Main. |
| P04 | Implemented PostgreSQL/economy adapters; E1 | Staging and final-source accounting/identity acceptance; Main. |
| P05 | Implemented actor/session/ticket lifecycle; E1 | Actual supported identity providers and signed cross-client account lifecycle; Main/Codex. |
| P06 | Implemented ephemeral coordination; E1/E2 | Target managed-service configuration, loss/rejoin behavior and operational suitability; Main/Codex. |
| P07 | Implemented multi-process matchmaking; E1 | Staged near-DB placement and full supported-client journey; 15-second offer TTL preserved; Main. |
| P08 | Implemented durable realtime Core; E1; CI01 fix verified | Deployed multi-Core/network/mobile recovery acceptance; Main. |
| P09 | Implemented durable tournaments/lobbies; E1 | Staging multi-worker/full lifecycle and approved payout/cohort behavior; Main. |
| P10 | Implemented jobs/outbox/UTC economics; E1 | Actual provider retries/delivery, observable DLQ and target-environment recovery; Main/Codex. |
| P11 | Implemented signed account/control plane; E1; CI02 fix verified | Deployed API/Core role separation, private ingress/TLS and website/shared-actor journey; Main/Codex. |
| P12 | Implemented privacy-filtered read models; E1/E6 | Deployed cache partition/invalidation, unavailable-Core semantics and privacy checks; Main. |
| P13 | Implemented trust-boundary hardening; E1/E6 | Deployed negative authorization/roles, secret rotation and private audit inspection; Main. |
| P14 | Implemented observability; E1 fixture coverage | Actual failure/recovery alert delivery, monitor IDs/access and evidence; Main/Codex. |
| P15 | Implemented recovery tooling; E2 disposable twin-DB proof | R2 retrieval, current backups, actual RPO/RTO/PITR, role/secret restoration and backup-conflict closure; Main. |
| P16 | Implemented process redundancy/drain; automated coverage E1 | Real target topology failure/drain; distinguish same-host process HA from host-failure HA; Main. |
| P17 | Implemented CI/release gates; CI01/CI02 subcases closed | New independent model-safety gate RED; cancelled newer runs; final exact-head complete runs and required checks; WebUI/Main/Codex. |
| P18 | Implemented staging fixtures and complete co-located HTTP match lifecycle; E1 | Actual deployed private composition and full WSS/session/purchase/shared-client smoke; Main/Codex. |
| P19 | Implemented load/chaos fixtures; E2 | Target-environment capacity/headroom/p95/p99, alert delivery and realistic recoveries; Main. |
| P20 | Real Android/iOS source and CI builds/offline launch; E4 | Signed physical-device builds, providers/purchases/ads/consent/accessibility and genuine store states; Main/Codex/Human. |
| P21 | Original deferred zero-task clause SUPERSEDED; website implemented, E5 | All 160 unchecked items, deployed API journeys, provider/hosting decisions, manual visual/accessibility evidence and authorized launch; Codex/Main/Human. |
| P22 | 1 IMPLEMENTED preflight task; 5 PLANNED operational tasks | No live authority transfer accepted. Exact-build authorization, freeze/import/one writer/first write and live smoke; Main/Human. |
| P23 | 4 PLANNED retirement tasks | Only after accepted cutover: permanently fence old writers, retain archives, use real compatibility usage and final report; Main. |
| P24 | 3 IMPLEMENTED scaling-policy tasks | Actual scaling is conditional on measured demand and explicit cost/operational decision; not an excuse to provision speculatively; Main/Human. |

## All 40 original acceptance cases

Original expected outcomes remain authoritative, except A40's historical website-deferral clause is superseded by authorized P21. 'CI-SUBSET' never closes a device/provider/deployed obligation in the same case.

| ID | Independent disposition | Evidence and exact remaining acceptance |
| --- | --- | --- |
| A01 | SOURCE REVIEW + CI-SUBSET; physical visual acceptance PENDING | E1/E4/E6 and source hashes; final four-theme representative-device screenshots, exceptions and Human approval still required. |
| A02 | CI01/CI02 VERIFIED; overall release CI BLOCKED | E1/E2 close documented service failures/skips; E3 exposes new real failures. Final-head workflows/ancestry/protection evidence pending. |
| A03 | OWNER-REPORTED inventory; recovery PENDING | E7 is not independent fresh R2 retrieval/restore. E2 explicitly does not close the reported backup conflict. |
| A04 | OWNER PASS retained; CI role checks observed | E1 role/grant negative tests. Preserve actual-environment scope; do not infer all production/provider accounts verified. |
| A05 | OWNER PASS retained; CI schema framework observed | E1 migrator/create/upgrade/locking evidence. Final release-compatible target revision still must be pinned. |
| A06 | IMPLEMENTED / CI-SUBSET | E1 import fixtures; final frozen SQLite schema plus every serialized variant coverage and explained exceptions pending. |
| A07 | IMPLEMENTED / CI-SUBSET | E1 per-actor/anti-swapped-wallet fixtures; actual source-linked reconciliation and sanitized zero-difference receipt pending. |
| A08 | IMPLEMENTED / CI-SUBSET | E1 restartable deterministic import fixtures; pin realistic source, interruptions and quarterly/non-UUID boundary receipt. |
| A09 | IMPLEMENTED / CI-SUBSET | E1 economy/ledger fixtures; full source-linked liquid/reserved/escrow accounting baseline pending. |
| A10 | IMPLEMENTED / CI-SUBSET | E1 concurrent wallet/occupancy tests; staged supported-client entry/challenge/conversion/tournament races pending. |
| A11 | IMPLEMENTED / CI-SUBSET | E1 transaction/settlement tests; target-environment fault-injection and exactly-once result/payout receipt pending. |
| A12 | IMPLEMENTED; real providers/devices PENDING | E1 session/actor fixtures and E7 local journey are not actual Google/Apple/email linking across signed phones/browser. Main/Codex/Human. |
| A13 | IMPLEMENTED / CI-SUBSET | E1 includes revoked socket 1008 regression. Physical lifecycle, actual key rotation and measured revocation delay pending. |
| A14 | IMPLEMENTED / CI-SUBSET | E1 durable one-use tickets and E6 issuer boundary; deployed cross-node wrong-audience/session and Redis-loss rehearsal pending. |
| A15 | CI disposable loss/recovery observed | E2 dedicated destructive Redis test passed; final isolated staging topology and invariants/metrics still required. |
| A16 | IMPLEMENTED / CI-SUBSET | E1 matcher/occupancy tests; staging multi-matcher cancellation/death/load and paid reservation receipt pending. |
| A17 | IMPLEMENTED / CI-SUBSET | E1/E2 durable move/Core reopen exercises; actual two-Core before/after-commit failover demonstration pending. |
| A18 | IMPLEMENTED / CI-SUBSET | E1 exact timer/acceptance fixtures; staged deadline disruption/reconnect and durable clock evidence pending. |
| A19 | IMPLEMENTED / CI-SUBSET | E1 transport/revision tests, E4 CI native launch; real phone background/network loss/WSS/HTTP fallback still pending. |
| A20 | IMPLEMENTED / CI-SUBSET | E1 tournaments/escrow; staged host-leave, concurrent timers and worker death over full lifecycle pending. |
| A21 | IMPLEMENTED / CI-SUBSET | E1 jobs/outbox fixtures; real provider idempotency, delivery, private retry audit and visible DLQ pending. |
| A22 | IMPLEMENTED / CI-SUBSET | E1 UTC duplicate-worker/boundary fixtures; exact target deployment/config and operation receipt pending. |
| A23 | IMPLEMENTED / CI-SUBSET | E1 signed Core harness and E6 forged/body-boundary regressions; deployed private Core/API network/grants/TLS pending. |
| A24 | IMPLEMENTED / CI-SUBSET | E1 browser compatibility and E5 static website checks; actual hosted website/API account and economic journey pending. |
| A25 | IMPLEMENTED / CI-SUBSET | E1/E6 privacy/cache regressions; deployed public/private cache scope, region/tier/wealth filters and invalidation pending. |
| A26 | IMPLEMENTED / CI-SUBSET | E1/E6 security/private audit fixtures; deployed redaction/access isolation/rotation inspection pending. |
| A27 | IMPLEMENTED; actual alert delivery PENDING | Test fixtures are not received failure/recovery alerts with monitor IDs and authorized target access. Main/Codex. |
| A28 | DISPOSABLE RESTORE VALIDATED; full DR BLOCKED | E2 twin-PG restore is real but its receipt explicitly leaves external retrieval/RPO/RTO/PITR/role secrets/G15 false. Main. |
| A29 | IMPLEMENTED / CI-SUBSET | E1 process recovery/drain tests; actual deployed two-Core and host-failure scope must be demonstrated and labeled accurately. |
| A30 | IMPLEMENTED release tooling; exact deployment PENDING | Artifact/compatibility fixtures do not establish an immutable approved deployed component set and tested rollback. Main. |
| A31 | DISPOSABLE load/chaos observed; target capacity PENDING | E2 three dedicated tests; production-shaped load profile, headroom, p95/p99/resource and alert outcomes pending. |
| A32 | CI native build/offline launch VALIDATED IN SCOPE | E4 Android debug/emulator and iOS unsigned simulator. Signed candidate hashes, physical clean install/offline launch pending. |
| A33 | IMPLEMENTED bridge; device security PENDING | Source/automated bridge boundaries do not establish real host token storage/backups/untrusted-navigation behavior on signed devices. Main/Codex. |
| A34 | IMPLEMENTED contracts; sandbox purchases PENDING | Genuine store pending/cancel/success/crash/replay/refund/restore and exactly-once backend grants required. Main/Codex/Human. |
| A35 | IMPLEMENTED contracts; real consent/ads PENDING | Actual consent-before-preload, rewarded SSV/replay and Remove Ads/interstitial device receipts required. Main/Codex. |
| A36 | CI/browser subset observed; physical accessibility PENDING | E4/E5 do not replace TalkBack/VoiceOver, notches/keyboards/small screens/network lifecycle in all themes. Human/Codex. |
| A37 | Provider state NOT INDEPENDENTLY ESTABLISHED | No inference from code/build to uploaded/submitted/approved/live. Record each platform's authorized identity, build and actual console state. Codex/Main/Human. |
| A38 | PLANNED / BLOCKED AUTHORIZATION | E7 read-only V4 authority inventory is not a V5 cutover. All writers, frozen import, epoch, first-write record and propagation rehearsal required. Main/Human. |
| A39 | IMPLEMENTED rehearsal tooling; operational acceptance PENDING | Demonstrate both pre-first-write abort and post-first-write PostgreSQL-preserving recovery on the approved exact release. Main. |
| A40 | PLANNED retirement / CONDITIONAL scaling | V4 runtime retirement depends on accepted transfer; archives remain; scale only on measured demand. Website is in scope, not deferred. Main/Human. |

## Original thirteen unfinished platform tasks

`V5-22-01` is implemented preflight tooling, not Human go/no-go. `V5-22-02` needs non-serving/write-denied production-configured staging; `22-03` authorized freeze of every V4 writer; `22-04` final frozen import/reconciliation; `22-05` one-writer epoch/first-write transfer; `22-06` actual supported-client/provider/recovery smoke. `V5-23-01` fences old writers, `23-02` preserves immutable cold evidence, `23-03` retires compatibility using real supported-client usage, `23-04` produces the final operations report. `V5-24-01`, `24-02`, `24-03` have implemented policies; real trigger/scale action is conditional and not independently accepted. No operational item was executed by WebUI.

## Bot/tutorial open-ID reconciliation

All 33 non-complete IDs remain in the generated inventory with inherited checkpoint evidence resolved correctly:

- `B01.02,B01.04,B01.05,B02.06,B02.08,B02.09,B02.11`: benchmark/tactics/exploit/strength ordering requirements remain; fixtures alone do not establish adjacent-tier ordering or production-budget strength.
- `B03.09,B03.10,B03.11,B03.12,B03.13,B03.14`: source and automated lesson/reload tests exist (E4/E6); real phone/assistive-technology behavior and no-coaching novice comprehension are not established. Preserve exact subtask contracts in inventory.
- `B04.08`: old 'teacher not run/no DGX' blanket blocker is superseded by Main's reported executed/rejected decision-teacher experiment, but independent protocol problems WEB-AI-06/07 prevent qualification. `B04.09`: conditional distillation requires a useful teacher and a controlled student improvement result.
- `B05.01,B05.02,B05.03,B05.04,B05.06,B05.07,B05.09`: model numerical/export/runtime components and experiments exist; complete downloaded/installed/runtime-memory cost, quantization non-inferiority, phone budgets and actual approved delivery remain open. A confidence interval containing .5 is not proof of equivalence.
- `B06.03,B06.05,B06.08,B06.10`: qualification, integration, rollout/device requirements are not replaced by a small file or green league process. `B06.06,B06.07` remain explicitly DEFERRED, not silently completed.
- `B07.01,B07.07,B07.08,B07.09,B07.10`: final gates remain. Dedicated-service skips in B07.09 now have E2 evidence; old unmerged-PR claims in B07.10 are stale (no open PRs in observed snapshots). Co-located CI journey exists, but deployed signed-client/provider journey and novice/device approval do not.

`champion_cycle.py` is no longer manifest-only. That historical claim in AGENTS/handoff is superseded by executable source, not by an R22 completion: seven independent negative contracts fail (WEBUI-DEFECTS-20261012.md). Approved Impossible remains unqualified. Preserve both custom-network/tactical-search and offline decision-teacher avenues; reject only candidates supported by measured evidence, not the entire approach based on a small/confounded experiment.

## P21 and human-only evidence

All 160 unchecked P21 requirements are preserved in the machine inventory and original checklist; none was checked merely because E5 passed. Codex should map exact checkbox IDs to browser/provider artifacts and observed external states, preserving noindex/release holds and established themes. Main supplies signed API/shared-actor integration. Human supplies physical-device feedback, formal identity/MFA/attestations where necessary, approved commercial/cost decisions, narration/UI choices and exact-build launch scope.

For the novice study, use genuinely new players, fixed instructions/questions, no coaching, predefined routing/free-route outcomes, unique participants and separate coached retries. Report numerator/denominator, sample size, failures and uncertainty. The existing >=80% unaided routing criterion cannot be satisfied by automated six-move success or repeated attempts by the same trained testers.

## Remaining gate order

1. Fix reproduced operator/gate defects and reconcile corrupted register identities; preserve closed CI01/CI02 subcases without claiming overall green.
2. Freeze an integration candidate and obtain complete exact-head required workflows; classify cancelled/skipped jobs explicitly.
3. Main proves deployed signed/private Core composition, full near-DB journey, migration/recovery/observability and realistic capacity.
4. Codex/Main prove real provider/shared-account/native/store/website boundaries; Human completes physical-phone and novice acceptance.
5. Require independent strong-model, complete runtime and quantization evidence for any included Impossible feature; otherwise Human must explicitly decide launch scope without relabeling a weaker bot.
6. Human authorizes exact artifacts/scope/window; Main alone executes rehearsal-backed single-writer transfer, then evidence-preserving retirement and measured scaling.
