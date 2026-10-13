# Multi-LLM arena + RL programme — final report (2026-10-13)

Owner direction: expand the supervised experiments into a multi-LLM simulation arena + a genuine
iterative RL programme, to discover an extremely strong, lightweight, primarily client-side Mega XOXO
bot — mining strong label sources and distilling them into a compact net. This is the honest final
status; **research-only**, `APPROVED_CATALOG` unchanged, no production/promotion/spend change.

## Headline result

The compact client net improved from **0.050 → 0.469 vs `improvedExpert`** (~9x) and **0.608 → 0.950 vs
`tacticalUCT`**, by training on a **stronger label source** (utttai's multi-simulation MCTS/NMCTS corpus),
not by more capacity or compute. A measured, anchored 3-generation RL loop then held and slightly
improved that strength. This confirms the programme's premise: **label quality was the bottleneck.**

## Deliverables (all committed, pushed, evidence-backed)

| Phase | Result | Key evidence |
| --- | --- | --- |
| 1 pipeline corrections | 7 fixes + regression tests | depth propagation, best-val export, label separation, dedup/qualification, decoupled research gate, GPU multi-gen, dataset reconciliation |
| 2 external utttai | rules identical (16M rows); validated converter | `utttai-analysis.md`, `utttai-converter.py` (355,102 rows verified, 18/18 corruptions rejected) |
| 3 multi-LLM arena | real games over canonical rules; honest pilot | `llm-arena.cjs`, `llm-arena-pilot.md` (both LLMs lost 0-4 to Expert; Gemma = reliable generator) |
| 4 datasets | multi-source corpus; teacher agreement | 431,999 records canonical; 13.7% top-1 agreement (diverse, not redundant) |
| 5 RL | breakthrough + anchored loop | 0.469 vs Expert; anchored 0.931→0.950→0.906 (naive collapsed 0.394→0.294) |
| 6 allocation | measured DGX1/DGX2/Colab | Nemotron 65→262 tok/s; QSFP 394 MB/s; Colab T4 reproduced the pipeline |
| 7 reporting | this + 8 checkpoints/docs | see `docs/v5.1/research/` |

## Champion (research only) and client fit

- **rl4 gen-2**: compact residual CNN, **713,802 params**, float ONNX **2.86 MB** / int8 **0.76 MB**
  (both <= 5 MB gate), **0.95 vs tacticalUCT** (CI [0.9, 0.988]).
- **Blocker to an int8 client**: a large quantization match-score regression (int8 0.294 vs float) — a
  dedicated quantization non-inferiority pass is required. Float ships as the reference.

## Key measured findings

1. **Stronger labels win**: external utttai MCTS/NMCTS labels lifted 0.05 → 0.469 vs Expert.
2. **Deep classical search is expensive**: depth 16 ≈ 21M nodes / 60 s, only reached depth 11.
3. **Naive multi-generation self-play degrades** (0.931 → 0.394 → 0.294); **anchored** self-play is
   stable/improving (0.931 → 0.950 → 0.906) — the measured correction to the RL design.
4. **A bigger LLM is not a better teacher**: the Unsloth teacher scored bestMove=chance; the arena showed
   both LLMs losing to bounded search. The useful signal came from an external MCTS corpus.
5. **The public-Impossible bar (0.70 vs improvedExpert) remains unmet**; the realistic research baseline
   is `tacticalUCT`.

## Residual items (honest, not fabricated)

- **Head-to-head champion replacement**: the gate advanced gen-3 (0.906) over the better gen-2 (0.950)
  because `neural_league.cjs` has no "vs previous champion" matchup. Next refinement; all generations are
  preserved, so nothing is lost.
- **Quantization non-inferiority** on the champion (int8 regression) — the one blocker to an int8 client.
- **Browser/WASM/WebGPU device latency** and full promotion (>= 200 families + device/production gates)
  remain separate, owner-gated tasks.

## State

Branch `V5.1`, all commits pushed. Research artifacts are local/offline; no model published, no catalog
entry, no production or spend change. The strongest candidate is preserved for a future, owner-gated
promotion process.
