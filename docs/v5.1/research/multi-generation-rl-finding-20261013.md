# Multi-generation RL finding — self-play degrades unless anchored to strong labels

3-generation neural-MCTS RL run on DGX2 (config `generations=3`, `seedDataset=multi-source.jsonl`,
CUDA, 8 epochs/gen, 160 self-play games/gen, 40-family/80-game leagues vs `tacticalUCT` + `improvedExpert`).
Every generation completed all five stages. Research gate refused (below threshold) each time.

## Per-generation league (80 games per matchup)

| Generation | policyValuePUCT vs **improvedExpert** | vs **tacticalUCT** | Training data | val value MSE |
| --- | --- | --- | --- | --- |
| **1 (seeded, multi-source)** | **0.469** (CI [0.381, 0.556]) | **0.931** (CI [0.881, 0.975]) | 431,999 strong labels | 0.122 |
| 2 (self-play of gen-1) | 0.000 | 0.394 | gen-1 self-play | - |
| 3 (self-play of gen-2) | 0.000 | 0.294 | gen-2 self-play | - |

## The finding

- **Generation 1 is the strongest candidate the programme has produced**: 0.469 vs `improvedExpert`,
  **~9x** the prior best (0.05), and 0.931 vs `tacticalUCT`. It is the champion.
- **Pure multi-generation self-play then collapses the model.** Each generation trains on the move
  distribution of the *previous* model; once the previous model is weaker than the strong-label corpus,
  the training targets get progressively weaker, and strength regresses (0.931 → 0.394 → 0.294 vs
  tacticalUCT). This is the classic "self-play without a strong anchor / sufficient improvement signal
  degrades" failure — it is a real, measured result, not an assumption.

## Implication for the RL design (correcting the plan)

The programme's premise ("mine strong label sources and distil them into a compact net") is confirmed;
the naive AlphaZero-style loop over a *weak* net is **not** the lever here. The workable loop is:

1. **Keep the strong-label corpus in every generation's training mix** (deep-search + external utttai +
   tactics), so the anchor never disappears.
2. Only **add** self-play data whose measured strength is >= the current champion (i.e. self-play from a
   model that already beats the reference), not replace the corpus with it.
3. Advance the research champion on **head-to-head vs the previous champion** (the head-to-head gate
   path), so an improvement is required to replace the champion — never a blind generation overwrite.

## State

- Champion (research only): **gen-1 of `rl3`** — 713,802-param compact CNN, 0.469 vs Expert / 0.931 vs
  tacticalUCT. `APPROVED_CATALOG` unchanged; no production/promotion.
- The `rl3` gen-2/gen-3 artifacts are preserved for provenance (they are the degradation evidence).

## Next

- Re-run with the anchored loop: seed every generation from the multi-source corpus and add only
  champion-strength self-play; evaluate head-to-head vs the gen-1 champion. This directly tests whether
  the *anchored* loop improves on 0.469, rather than the naive loop which did not.
- A quantization non-inferiority pass on the champion (the int8 regression was large on the
  external-trained net).
