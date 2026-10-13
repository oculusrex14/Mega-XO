# TRACK A checkpoint 8 — multi-LLM arena + RL programme (2026-10-13)

Owner direction: expand the supervised-CNN work into a multi-LLM simulation arena + a genuine
iterative AlphaZero-style RL programme, to discover an extremely strong lightweight client bot. This
checkpoint reports measured status. Research-only: `APPROVED_CATALOG` empty; production/V4 untouched.

## What is implemented / locally-tested / measured

| Phase | Status | Evidence |
| --- | --- | --- |
| 1 pipeline corrections | **DONE** (7 fixes + tests) | commits `22a236e`,`c1974d5`,`de92848`,`464f024`,`2a374ef`,`db7d945`; `TRACK-A-CHECKPOINT-7` |
| 2 external utttai | **DONE** | analysis `61aaa06`; converter `ac5ef83`; 355,102 rows verified |
| 3 multi-LLM arena | **DONE (pilot)** | `20a1c28`,`7e02440`; 6 real games; `llm-arena-pilot.md` |
| 6 allocation | **DONE (measured)** | `dgx-llm-probe-dgx1/dgx2.md`; QSFP 394 MB/s |
| 4 combine sources | IN PROGRESS | deep-search + external exist; combine + dedup to do |
| 5 multi-gen RL | IN PROGRESS | pipeline proven (gen-1 evaluated); scale-up pending |
| 7 reporting | IN PROGRESS | this checkpoint |

## Measured results this session

### LLM serving (DGX1, read-only pre-existing servers)
- **Nemotron-3.5-Lightning-30B (NVFP4)**: 65 tok/s single-stream; 262 tok/s at 64 concurrent; cap 108
  (mamba state cache); thinking mode must be `enable_thinking:false` or the move never arrives
  (legal-move rate 0.08 → 1.00).
- **Gemma-4-26B-A4B (FP8)**: 38 → 109 tok/s; reliable JSON (legal-move rate 1.00).
- **QGX/QSFP**: RTT 0.39 ms, rsync 394 MB/s DGX1→DGX2; DGX2 can curl DGX1 endpoints.

### Multi-LLM arena pilot (6 real games over the canonical rules engine)
- All moves revalidated by `G.legal`; 0 rule violations by any agent; 17/17 invalid attempts were
  well-formed JSON that was *illegal in the position* (rule comprehension, never format).
- LLM-vs-LLM mirrored (each model won its X game); **both LLMs lost 0–4 to Expert from both seats**.
- Gemma = reliable/fast candidate generator; Nemotron needs thinking off. No ranking claimed (n=2).

### External corpus (utttai, Apache-2.0, rules identical)
- Converter: 355,102 rows verified (0 plane/legalMask mismatches; `visitTarget` sums to 1); 18/18
  crafted corruptions rejected; per-member dedup (e.g. stage1 depth04: 12,504→7,079).
- **External-only training: val value MSE 0.0004, policy top-1 0.574** — the utttai NMCTS labels are
  far more learnable than our weak self-play labels (top-1 ~0.23–0.25).

### BREAKTHROUGH — stronger labels (the headline result)
Training on the combined utttai corpus (352,357 positions, DGX2 CUDA) produced the strongest candidate
in the programme: **0.406 vs improvedExpert** (CI [0.319, 0.500]; was 0.05) and **0.900 vs
tacticalUCT** (CI [0.838, 0.956]; was 0.608), 40 families / 80 paired games. Research gate advances
(`RESEARCH_ADVANCE_REFERENCE_FLOOR`, CI low 0.8375); public qualification correctly refused (40 < 200
families). This confirms the diagnosis: **label quality, not compute, was the bottleneck.**
Evidence: `docs/v5.1/research/stronger-label-breakthrough-20261013.md`.

### Multi-source corpus (Phase 4)
`multi-source.jsonl` = deep-search (80,250) + external utttai (352,357, deduped) → **431,999 records,
1,696 games, 351,749 external rows, `canonical:true`** with 3 distinct value-target sources.

### RL pipeline (DGX2, GPU)
- Full cycle 5/5 stages on CUDA; seeded from 80,250 strong-search rows; best-epoch export; 713,802
  params; peak CUDA 287 MB; 19 s train.
- **A 2-generation run** completed generation 1 end-to-end and evaluated it: research gate refused at
  **0.081 vs improvedExpert / 0.55 vs tacticalUCT** on 40 families — a correct weak-candidate refusal.
- Generation 2 failed on self-play data sufficiency (64 bootstrap games → degenerate split), not a code
  fault; a real run needs more games or the external/combined corpus.

## Key research findings (measured, honest)

1. **Data quality, not capacity/search**: 80k strong-search labels lifted the candidate to 0.608 vs
   tacticalUCT / 0.05 vs Expert; capacity, sim budget and depth-16 did not help.
2. **Deep classical search is expensive**: depth 16 ≈ 21M nodes / 60 s and only reached depth 11 →
   strength must come from neural-guided search, not deeper alpha-beta.
3. **The public-Impossible bar (0.70 vs improvedExpert) is unreachable**; the realistic research
   baseline is `tacticalUCT` (fixed `ee00e55`: the research floor now references it).
4. **utttai's NMCTS labels are a genuinely stronger label source** (top-1 0.574 vs our 0.25), exactly
   the "stronger target" the diagnosis called for — while remaining a Mega-XOXO-compatible game.

## Next most promising experiment (justified)

Combine the **external utttai NMCTS corpus** (learnable, 355k+ positions and growing), the committed
**deep-search labels** (80k) and **verified tactics/endgames** into one deduped multi-source dataset
(distinct `valueTargetSource` per source, `external` split never trained on our family holdout), then
run a **3-generation neural-MCTS RL pass on DGX2** (GPU) with self-play producing >=40-family leagues
against `tacticalUCT` and the previous champion. Justification: the external labels demonstrably train
the strongest signal we have measured (MSE 0.0004), the pipeline now advances on real improvement, and
the bottleneck is label strength — not compute.

## Residual / blocked

- Real-scale multi-generation RL (>=3 gens, 40–200 family leagues) — compute-hours, running next.
- Colab independent reproduction — within the existing subscription, not yet run.
- Teacher-agreement analysis (deep-search vs external vs LLM) — Phase 4.
- No promotion, catalog, production or spend change.
