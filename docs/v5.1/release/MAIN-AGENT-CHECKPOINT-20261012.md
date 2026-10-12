# Main-agent integration checkpoint - 2026-10-12

Branch `V5.1` (sole shared development branch). Entered at `f0a3144`; the prior feature branch
`feat/v5.1-bot-ai-tutorial` (`682f44e`, 45 commits) was confirmed **preserved** as an ancestor of
`V5.1` (merge-base = `682f44e`). `main` and `V4.1` are untouched.

## Commits made this session (fast-forward pushes only)

| SHA | Unit |
|---|---|
| `99353a6` | CI01/CI02 service-suite repairs (P08 occupied-actor fixture; P11 real signed-Core gateway) + 5b unconfigured-Core guard |
| `09115e5` | Read-only production authority inventory + R02 register |
| `5a387b6` | Real continuous-learning operator (CL06/CL07/CL12/CL16/CL17) + `train.py` resume + operator test + CI/learning evidence docs |
| `12fe119` | R03/R22/R23 register advancement |
| `0c725c3` | R04/R05 composition + measured offer latency |
| `5dca719` | Run the operator test with real prereqs in the compact-model-validation workflow |
| `a51c875` | R27 measured INT8-vs-float league |

## Green CI (Linux, ubuntu-latest) on the repaired head

- `V5.1 isolated service and platform validation` run `38238762725` on `99353a6`: **728 tests, 725 pass,
  0 fail, 3 skip** (artifact `v51-disposable-service-evidence` `11741841423`). The two documented red
  tests are fixed; the 3 skips are the justified P15/P19 broad-service cases reconciled to the
  dedicated recovery/chaos workflow.
- `V5.1 dedicated recovery and chaos gates` run `38238763727` - success.
- `V5.1 independent audit regression` run `38238762788` - success.
- `V5.1 bot and tutorial validation` run `38238762683` - success.
- `V5.1 compact model validation` run `38240882423` on `5dca719` - success, including the operator
  test 5/5 with the **real** cycle + kill/resume (10.1 s) executed on the Linux host.
- Repo-wide: the only failing run in the last 40 is the historical `88907f8` disposable-services
  failure that this repair supersedes.

## Work completed / advanced

| Item | State | Evidence |
|---|---|---|
| R02 verify consolidated CI | repaired → green | CI-CLOSURE-20261012.md |
| R03 sole production writer | PARTIAL (read-only) | PRODUCTION-AUTHORITY-INVENTORY-20261012.md |
| R04 isolated signed Core composition | PARTIAL (local proof) | ISOLATED-COMPOSITION-AND-OFFER-LATENCY-20261012.md |
| R05 OFFER_EXPIRED | PARTIAL (root cause measured) | same (18.5 ms vs 15 s TTL) |
| R22 real resumable orchestrator | PARTIAL (implemented, 2 cycles + resume) | CONTINUOUS-LEARNING-OPERATOR-20261012.md |
| R23 neural-loss diagnosis | PARTIAL (recorded) | same |
| R27 quantization non-inferiority | PARTIAL (measured, not established) | same |
| CL06/CL07/CL12/CL16/CL17 | implemented + executed | same |

## Still gated (not this agent's authority / environment)

- **DGX-hosted training/league (CL13/CL15, R24)**: `dgx2-ts` offline (last seen 13 h); `dgx-ts` up but
  with only unrelated ComfyUI/TTS venvs and no torch/mega checkout. A CUDA environment must be created
  before GPU-scale runs. Local CPU cycles are diagnostic only.
- **Unsloth teacher (CL18-CL23, R25/R26)**: separate environment, not started.
- **Deployed acceptance (R06/R07/R09/R15)**: needs the live Vercel/Neon/staging topology (Codex).
- **Native signing/devices (R11/R20)**: needs developer identities and physical devices (human/Codex).
- **Model approval & publication (R28/R29), cutover/retire/scale (R30/R31/R32)**: owner authority.

No production change, model promotion, index change, secret exposure or branch rewrite occurred.
