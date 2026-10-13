# Main-agent autonomous work queue

Source of truth for the standing "continue autonomously until complete" instruction. One integration
owner (Main) serializes shared-file writes. WebUI owns `scripts/v51-readiness-*.py` and its tests; Codex
owns P21 browser/provider files. Main must not overwrite either.

Branch `V5.1`. Update status + commit + evidence on every meaningful unit. No force-push, no `main`/`V4.1`
writes, no live-V4 change, no paid provisioning, no store publication, no production cutover, no model
release.

## P0 - WebUI-reproduced safety defects (`scripts/v51-readiness-probes.py`)

| ID | Status | Commit | Evidence |
| --- | --- | --- | --- |
| WEB-AI-01a/b/c promotion gate fail-closed | COMPLETE | `b1db862` | probes exit 0; operator test; model-gate 10/10 |
| WEB-AI-02a constructor read-only | COMPLETE | `b1db862` | probe: owner bytes unchanged |
| WEB-AI-02b atomic lease | COMPLETE | `b1db862` | probe: one ACQUIRED, one REFUSED |
| WEB-AI-03 resume verifies output hashes | COMPLETE | `b1db862` | probe: tampered output not reused |
| WEB-AI-04 neural feedback wired | COMPLETE | `b1db862` | probe: injected engine reached; sync path byte-identical |
| WEB-AI-08 wall-clock heartbeat + STOP clear | COMPLETE (partial) | `b1db862` | heartbeat thread; resume clears STOP |
| WEB-AI-05 complete league receipts | COMPLETE | `324f380` | 200-family receipt; verifier enforces targets |
| WEB-AI-06 teacher-eval leakage | COMPLETE | `324f380` | family split; missing=failure; pinned revision; 3/3 |
| WEB-AI-07 label provenance + budget | COMPLETE | `324f380` | budget threaded; real option-order permutation; 6/6 |
| WEB-AI-08 two-cycle feedback PROOF | COMPLETE | `4aa03e3` | chain `3da3ed00…`->`7245a902…`; real kill/resume |
| WEB-DOC-01 register repair (R26/R28) | COMPLETE | `4aa03e3` | `73d866a0…`; audit structuralErrors 0 |
| WebUI re-verification (independent gate) | COMPLETE | `324f380`/`4aa03e3` | `V5.1 independent readiness evidence` GREEN |

## P0 - secure staging

| ID | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Staging OTP secret mismatch | COMPLETE | `b3b80bc` | e2e 8/8; cross-restart code verifies |
| HTTPS/WSS via tailscale serve | BLOCKED (owner enablement) | - | `https://login.tailscale.com/f/serve?node=nLo62ZkXpj11CNTRL` |
| Realtime auth origin = HTTPS staging origin | PENDING | - | verify after HTTPS enabled |
| Real mailbox delivery | BLOCKED (provider creds) | - | sink proves bridge only; provider disabled by design |
| Flow-12 accept latency (Neon cross-region) | BLOCKED (region-local host) | - | measured 17.4s accept / 2.5s RTT; co-located 10/10 |

## TRACK A - DGX AI research (owner standing instruction, 72h programme)

| Item | Status | Commit/Artifact | Evidence |
| --- | --- | --- | --- |
| Recon both DGX Sparks | COMPLETE | checkpoint 1 | dgx-ts + dgx2 via QSFP; CUDA/Unsloth envs |
| Value-head diagnosis | COMPLETE | `4bc55ab` | weak outcome value near-unpredictable (var 0.662/0.731) |
| Strong-search labels | COMPLETE | `4bc55ab`,`2655581` | POLICY=deep visits, VALUE=root score |
| Datasets | COMPLETE | checkpoint 2 | 48,396 (DGX1) + 31,854 (DGX2) |
| Value head fixed | COMPLETE | `38045d9` | val MSE 1.08 -> **0.176** |
| Strength vs tacticalUCT | COMPLETE | `38045d9` | **0.545** (was 0.385) |
| Architecture sweep (w96/128, b6) | COMPLETE | `b92c9be` | capacity is NOT the lever |
| Search-vs-strength (sims) | COMPLETE | `b92c9be` | more search does NOT help the weak prior |
| Combined 80k dataset | COMPLETE | `38045d9`/`5aebdfc` | big-w96b4: MSE 0.154, top1 0.252 |
| Strength: big-w96b4 | COMPLETE | `5aebdfc` | vs tacticalUCT **0.608**, vs improvedExpert **0.050** |
| LLM teacher bestMove | COMPLETE (negative) | `5aebdfc` | 0.143 = chance; R26 justified rejection |
| Depth-16 labels + d12d16 train | IN PROGRESS | - | DGX1 57,480 records |
| PUCT self-play + sp-augmented train | IN PROGRESS | - | DGX2 91,121 records |
| Model promotion (>=0.70) | NOT REACHED | - | 0.050 vs Expert; catalog empty (correct) |

## TRACK B - staging

| Item | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Flow-12 accept latency | COMPLETE | `8328b71` | co-located Oracle: 8ms Neon, 244/413ms accept, 468ms since-pair |
| Two-account multiplayer | COMPLETE | `8328b71` | co-located smoke 19/0 (34 steps) |
| Realtime ticket issuer gap | COMPLETE | `8328b71` | createApiHandler token required ticketIssuer |
| Codex URLs/SHAs | COMPLETE | `a6a7c50` | `http://100.64.128.46:8085`, SHA `8328b71` |
| HTTPS/WSS | BLOCKED (owner enablement) | - | tailscale serve one-click |


## TRACK A Phase 1 corrections + multi-LLM/RL programme (owner direction 2026-10-13)

| Item | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Depth propagation + real search diagnostics | COMPLETE | `22a236e` | search-labels.test.cjs 3/3; measured depth12@4M->9, depth16@21M->11 |
| Best-validation export + early stopping | COMPLETE | `c1974d5` | smoke chose epoch 2 (metric 3.12) over final 4 |
| Separated label target types (no silent mixing) | COMPLETE | `c1974d5` | test_load_records.py 3/3 |
| Dataset dedup audit + reserved qualification split | COMPLETE | `de92848` | dataset-audit-20261013.md; nested provenance measured |
| Research progression decoupled from public gate | COMPLETE | `464f024` | research-gate.test.cjs 2/2 |
| GPU device + multi-generation operator loop | COMPLETE | `2a374ef` | 2-generation CPU run; DGX2 cuda cycle 5/5 stages |
| Seed-dataset bootstrap + node-bin forwarding | COMPLETE | `db7d945` | DGX2 seeded run: 80,250 rows validated, cuda train ok |
| DGX1/DGX2 LLM serving + QSFP measured | COMPLETE | `ca93c90` | dgx-llm-probe-dgx1/dgx2.md (Nemotron 65->262 tok/s) |
| utttai compatibility assessment | COMPLETE | `61aaa06` | utttai-analysis.md (rules identical over 16M rows) |
| utttai converter (validated) | IN PROGRESS | - | agent building streaming converter |
| Multi-LLM arena + pilot | IN PROGRESS | - | agent building llm-arena.cjs + pilot |
| Multi-generation RL run (real scale) | PENDING | - | needs arena/qualification data; pipeline proven |


## TRACK A Phase 2-5 results (owner multi-LLM + RL direction, 2026-10-13)

| Item | Status | Commit/Artifact | Evidence |
| --- | --- | --- | --- |
| utttai compatibility assessment | COMPLETE | `61aaa06`/`382ec1f` | rules identical over 16,005,010 rows; Apache-2.0; supervision-only |
| Validated utttai converter | COMPLETE | `ac5ef83` | 355,102 rows verified, 0 mismatches; 18/18 corruptions rejected |
| External value-source training | COMPLETE | `ac5ef83` | external-only val value MSE 0.0004, top1 0.574 |
| Multi-LLM arena + pilot | COMPLETE | `20a1c28` | 6 real games; both LLMs lost 0-4 to Expert; Gemma reliable generator |
| Multi-source corpus | COMPLETE | `2af88de`/`34e872f` | 431,999 records, 1,696 games, canonical |
| STRONGER-LABEL BREAKTHROUGH | COMPLETE | `1e1501b` | external-trained: **0.406 vs Expert / 0.900 vs tacticalUCT** (was 0.05/0.61) |
| 3-generation RL run | COMPLETE (finding) | `73955c6` | seeded gen-1 **0.469 vs Expert / 0.931 vs tacticalUCT**; gens 2-3 self-play COLLAPSE (0.394/0.294) |
| Anchored self-play loop | COMPLETE | `7b0e46c` | keeps anchor corpus each generation; verified 633+153=786 canonical |
| Anchored multi-generation run (rl4) | RUNNING | - | on DGX2, tests whether the anchored loop holds/improves 0.469 |

**Champion (research only): rl3 gen-1** - 713,802-param compact CNN, 0.469 vs improvedExpert
(CI [0.381,0.556]) / 0.931 vs tacticalUCT (CI [0.881,0.975]). APPROVED_CATALOG unchanged; no promotion.

## R/B/CL and original acceptance

| ID | Status | Commit | Evidence |
| --- | --- | --- | --- |
| R19 frozen classical baselines + exploit | COMPLETE (host-scoped) | `15f1af4` | baseline.json (11 cases), exploit 0.016 CI[0,0.039], tactics 6/6 |
| R22 learning orchestrator (real operator) | COMPLETE | `2706408` | fail-closed gate, atomic lease, resume integrity, SIGTERM+resume test |
| R24 wire neural self-play producer | COMPLETE (loop) / PARTIAL (strength) | `2706408` | operator runs selfplay.cjs; chain proof `4aa03e3`; candidate far below gate |
| R27 INT8 quantization non-inferiority | COMPLETE (quant step) | `e421ccf` | 300 families, 0.498 CI[0.475,0.522] >= 0.45 margin |
| R23 diagnose neural losses | COMPLETE (diagnosis) | earlier | real strength gap, not a semantics bug; no scaling to conceal |
| R25 Unsloth teacher evaluation | BLOCKED (DGX venv) | `324f380` (fixes) | family-safe split + pinned revision shipped; DGX run is external |
| R26 useful-teacher distillation | BLOCKED (R25) | - | needs a demonstrated-utility teacher first |
| R28 approve/distribute model | BLOCKED_MODEL | - | no candidate meets the gate; catalog empty (correct) |
| R03/R06/R07/R08/R09/R11/R20 etc. | BLOCKED (device/provider/production) | - | see OPEN-WORK-AND-OWNERS.md per-row owner actions |

R05 (co-located smoke) is BLOCKED on a host near the Neon region; R04 (deployed process-manager/TLS) and
R10/R12/R13/R14/R18/R21 are blocked on owner/provider/device decisions. These are genuine external
blockers, recorded with the exact owner action, not Main-code gaps.

