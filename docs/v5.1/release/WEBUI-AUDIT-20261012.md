# Independent WebUI readiness audit - 12 October 2026

## Current checkpoint

**Release assessment: NOT ACCEPTED.** The two historical service-test failures CI01/CI02 have independently verified passing test evidence; the new independent learning-operator safety gate is RED. No production transfer, store/provider approval, physical-device acceptance or Impossible qualification is inferred.

Read [all 25 phases and all 40 acceptance dispositions](WEBUI-ACCEPTANCE-OVERLAY-20261012.md) and [exact defects, reproductions and Main handoff](WEBUI-DEFECTS-20261012.md). Those overlays supersede the explicitly identified stale status claims, but do not overwrite original contracts or silently check source-ledger items.

## Ownership and source boundary

Owner: ChatGPT WebUI. Integration owner: Main agent. Initial inspected V5.1 HEAD: `4e345fa1a90c5ba619cc2de6c8ce4eb03590d3e9`. Only V5.1 was modified; all writes append to its current head using the Contents API. No additional remote branch, force push, destructive cleanup, main/V4.1 write, deployment or model/provider mutation occurred.

WebUI owns this audit and its new evidence/defect overlays, `scripts/v51-readiness-*`, `tests/v51-readiness-*`, and `.github/workflows/v51-webui-readiness-audit.yml`. Main retains CI01/CI02 fixtures, backend/native/integration/training operator. Codex retains P21/browser/provider source. Shared source and original ledgers were read-only during this slice. The shared-register structural repair is prepared and tested, but deliberately awaits serialized Main application.

The execution container cannot resolve github.com, so local git clone was unavailable. A read-only Actions artifact supplied tracked UTF-8 source. Every included byte count, SHA256 and Git blob ID was verified. First snapshot b6b1f46: 985 text files; latest independently verified tooling snapshot **2937b4ca5c3f41f874f78f2dc6831e0ee9c7613c: 992 files**. This is not a complete release binary checkout. The only changed text paths between those snapshots are the new WebUI scripts/tests and its workflow; game, backend, native, bot implementation and website source hashes are unchanged.

Observed retained refs in both source artifacts: main `66b19db3451f5eb1af824110556aa4ab6fae138a`; V4.1 `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`. No open PRs were present in those observations. Later documentation-only checkpoints must not be called freshly fully CI-green without their actual run outcomes.

## Completed bounded work and remaining ownership

| ID | Checkpoint state | Result / residual |
| --- | --- | --- |
| R01-W01 | COMPLETE - audit inventory | All 25 phases, 117 platform tasks, 40 cases, 82 bot tasks and 230 P21 checkboxes inventoried with exact IDs/contracts, source hashes and separate validation levels. Counts below. |
| R01-W02 | COMPLETE - independent disposition; canonical repair pending | Full phase/case overlay, stale-claim reconciliation and missing R26/R28 recovery prepared. Main must serialize the lossless register patch and carry explicit supersessions into shared instructions; no acceptance case silently closed. |
| R01-W03 | COMPLETE - initial independent protocol review | Reviewed legal action/value/symmetry, datasets/teacher, paired leagues, quantization/runtime, tutorial and operator; seven negative contracts reproduced locally and in CI. Main-owned fixes and new candidate/device evidence remain OPEN. |
| R02-W01 | COMPLETE - CI01/CI02 independent verification | Reviewed 99353a6 fixes and later signed isolated composition; complete same-source service TAP and dedicated three-skip coverage verified. Not equivalent to a green final-head release suite. |
| R02-W02 | COMPLETE - audit tooling and fail-closed CI | New read-only source inventory, independent negative probes, strict paired evidence verifier, lossless register repair generator and 26 tooling tests; CI-confirmed. Model verifier integration belongs to Main and is not yet done. |
| R01 parent | PARTIAL | Shared canonical register/instruction reconciliation and future evidence updates remain; original release acceptance still belongs to its owners. |
| R02 parent | BLOCKED / PARTIAL | New source defects keep independent-model-safety RED; newer broad/native jobs have cancellations. Final exact-head complete checks/protection and Main fixes remain. |

## Recomputed source states

Platform: **104 COMPLETE / 4 IMPLEMENTED / 9 PLANNED of 117**. Acceptance: **2 PASS / 38 NOT_RUN of 40**. Bot/tutorial: **49 DONE / 24 PARTIAL / 7 BLOCKED / 2 DEFERRED of 82**. P21: **70 checked / 160 unchecked of 230**. These are overlapping source labels, never a production-completion percentage.

Source PARTIAL/BLOCKED does not imply unimplemented. In particular, champion_cycle.py is now executable rather than manifest-only; Main reports decision-teacher execution rather than no DGX access; dedicated service tests have concrete retained evidence; previously unmerged bot work is on V5.1. Each correction retains its remaining qualification boundary in the acceptance overlay.

## Actual test and CI evidence

| Check | Exact scope | Observed result |
| --- | --- | --- |
| New audit/model/register tool tests | Local Node22.16.0/Python3.13.5; and CI run **38270032592** at **2937b4ca5c3f41f874f78f2dc6831e0ee9c7613c**, Python3.12/Node24 | **26 PASS, 0 FAIL, 0 SKIP** (10 inventory + 10 model-evidence + 6 register tests). Retained tooling-tests.log verified. |
| New negative operator contracts | Same CI run; retained artifact **11755964028**; local independent reproduction too | **7 DEFECT_REPRODUCED, exit 2**. Gate remains RED, intentionally not suppressed. |
| Security/privacy regression subset | Local `node --test tests/v51-audit-*.test.js` against b6b1 source | **17 PASS, 0 FAIL, 0 SKIP**. No claim of deployed PG/roles from these local tests. |
| Bounded bot suite | Local contracts, encoding, neural-search, lesson, runtime, search, runner, decision-teacher and learning-operator tests | **39 total: 38 PASS, 0 FAIL, 1 SKIP** for ML prerequisite. Larger earlier batch including training-data timed out without a final summary; NOT PASS. |
| Broad disposable service suite | b6b1f46, run **38267846919**, artifact **11755323344** | Complete TAP: **729 total, 726 PASS, 0 FAIL, 3 SKIP**. Test/upload steps passed; eventual job conclusion CANCELLED. Preserve that distinction. |
| Dedicated skipped-service coverage | Same b6b1f46, run **38267846892**, artifact **11756005358** | **3 PASS, 0 FAIL, 0 SKIP** for twin-PG restore and two P19 chaos/load tests. Full live DR is not accepted. |
| Native/browser CI | b6b1f46 run38267846919 | Android debug/unit/offline/emulator PASS; iOS unsigned simulator/offline PASS; Firefox/WebKit tutorial-reload jobs PASS. Not physical/signed/store/novice evidence. |
| P21 CI | cc2c0fd run **38269273010** | Static build/delivery boundaries and desktop/tablet/mobile browser/automatic WCAG/keyboard jobs PASS. Remaining 160 unchecked entries not automatically closed. |
| Newer extended suite | cc2c0fd run **38269273069** | Firefox/WebKit PASS; Android/iOS/service jobs CANCELLED. No all-green or final-build acceptance claim. |
| Prepared owner-register patch | Local `git apply --check` on pinned source; six repair tests | PASS; restores exact R26/R28, fixes twelve overflow rows, retains entire duplicate notes and subsequent ledgers. **Not applied to shared source**. |

Latest source artifact **11756516633** (run38270032592) ZIP SHA256: `3b6cd546ba8c6abbfe9080e7fdb3d3ebaab33d8bd2745c31624def4e34f3ff55`.
Latest negative-contract artifact **11755964028** ZIP SHA256: `cc2f9fa481323cc78255d6a0719e3736e35f0f2feb93c5f6fcdfc478b1cafcc4`.

CI01 exact proof: logout after ticket redemption closes the socket with SESSION_REVOKED/1008 using an unoccupied actor pair; the single-active-match invariant was not relaxed. CI02 exact proof: read-only browser routes use the real signed Core ingress with isolated roles, plus the unconfigured-Core 503 negative case. Main's source fixes were reviewed, not overwritten.

## New defects and safe improvements delivered

WEB-AI-01a/b/c: research promotion accepts unrelated opponents, a below-target score and a reversed interval. WEB-AI-02a/b: constructor changes active leased state and lease acquisition races. WEB-AI-03: resume silently reuses tampered outputs. WEB-AI-04: neural feedback dereferences null analysis. All seven are executable and CI-reproduced; Main owns fixes.

Additional protocol findings: final league truncates raw games and omits qualification bindings; teacher calibrates on pooled validation/holdout and undercounts missing answers; requested teacher budgets and actual engines diverge; repeated deterministic option shuffle is not an invariance evaluation. Full paths, line locations, severity, suggested fixes and closure tests are in WEBUI-DEFECTS-20261012.md.

Implemented safe additions: a complete source/evidence inventory; strict independent research verifier with exact model/source/opponent/family binding and recomputed paired bootstrap; read-only reproducible CI receipts; negative regression contracts; and a hash-bound lossless owner-register repair generator. The strict model verifier **is not wired into the Main operator yet** and always says productionApproved=false.

## Incremental commit receipts before this documentation checkpoint

| Commit | Change |
| --- | --- |
| 58b578a9f79fe139072e6367b8d3219db667ac02 | Claim isolated audit ownership and initial observations. |
| b6b1f46121a565b06a21309fe4465df635cdbad9 | Read-only exact tracked-source and CI metadata evidence workflow. |
| dc4eda23aeeef7c294e5b3c66016d23d32ae5de7 | Complete historical-ledger inventory with evidence levels. |
| 4194e069a961fa9003694bf011d70b017f9424d5 | Ten inventory/status/schema regression tests. |
| 9e7e6b31cbf17c4394baeafc2ae38b026965fd43 | Seven executable source-defect probes. |
| 4bce43725be5c7e38cedcb7c3e20f70efa6250fc | Fail-closed paired-model research evidence verifier. |
| 2b7b82795fce13156f3b643d387db87950f4cb05 | Ten verifier tests including Node bootstrap parity. |
| cc2c0fd833ba84d1c775973d1a42eb0d63ce018d | Execute tooling and honest failing model-safety gate in CI. |
| 2c70dbd20d0753aaf099ec633adbf63e49e422e5 | Lossless R26/R28 register repair generator. |
| 2937b4ca5c3f41f874f78f2dc6831e0ee9c7613c | Six preservation/identity/idempotency repair tests. |
| b17dbe118ef88ffc48abdc32ec99ac28452e32b7 | Detailed actionable Main-owned defect handoff. |
| 6fbe40db62f01271e6e21478be1a471a36e7cd52 | All-phase/all-acceptance overlay and full remaining-scope reconciliation. |

## Reproduction and handoff

```sh
for test in tests/v51-readiness-*.test.py; do python3 "$test" || exit; done
python3 scripts/v51-readiness-audit.py --output .artifacts/readiness/inventory.json
python3 scripts/v51-readiness-probes.py --output .artifacts/readiness/probes.json
# The preceding command currently exits 2 because real source defects remain.
python3 scripts/v51-readiness-register.py --output-dir .artifacts/register-repair
# Main reviews source hash and patch, then uses git apply --check before serialized application.
```

Main: fix new operator defects, integrate strict full-evidence verification, serialize register repair, then freeze/revalidate exact candidate. Continue deployed Core/account/economy, recovery and native/DGX work. Codex: P21/browser/provider/account eligibility and real console states, not app-side implementation assumptions. Human: phone/novice acceptance, exact launch scope and artifact approval, MFA/formal attestation/cost decisions where genuinely required. A full Impossible launch needs a qualified candidate; an explicit scope decision must never silently relabel Expert or bypass approval.

Original initial coordination checkpoint retained in commit 58b578a9f79fe139072e6367b8d3219db667ac02. At that point no local tests had run; the later verified evidence above explicitly supersedes that initial NOT_RUN observation.
