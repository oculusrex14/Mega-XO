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
| Architecture sweep (w96/128, b6) | IN PROGRESS | - | DGX2 tmux `sweep` |
| PUCT self-play + working value | PENDING | - | next after best architecture |
| Decision teacher fine-tune | IN PROGRESS | - | dataset building on DGX1 |
| Model promotion (>=0.70) | NOT REACHED | - | 0.020 vs Expert; catalog empty (correct) |

## TRACK B - staging

| Item | Status | Commit | Evidence |
| --- | --- | --- | --- |
| Flow-12 accept latency | COMPLETE | `8328b71` | co-located Oracle: 8ms Neon, 244/413ms accept, 468ms since-pair |
| Two-account multiplayer | COMPLETE | `8328b71` | co-located smoke 19/0 (34 steps) |
| Realtime ticket issuer gap | COMPLETE | `8328b71` | createApiHandler token required ticketIssuer |
| Codex URLs/SHAs | COMPLETE | `a6a7c50` | `http://100.64.128.46:8085`, SHA `8328b71` |
| HTTPS/WSS | BLOCKED (owner enablement) | - | tailscale serve one-click |

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

