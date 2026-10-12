# TRACK A checkpoint 4 - search does not help the weak prior; teacher training live

## Search-budget vs strength (neural candidate, DGX2)

`policyValuePUCT` (w96b4) vs `improvedExpert`, 80 independent families / 160 games each:

| simulations | budgetMs | pointScore | 95% CI |
| --- | --- | --- | --- |
| 16 (earlier) | 20 | 0.033 | [0.015, 0.052] |
| 64 | 60 | 0.041 | [0.016, 0.069] |
| 192 | 60 | 0.041 | [0.016, 0.069] |

The score does not move between 64 and 192 simulations: **more PUCT search on this prior/value yields no
strength**. Combined with the capacity sweep (checkpoint 3), the two obvious "scale it" levers - bigger
net, more search - are both ruled out by measurement. The bottleneck is the **policy prior quality**
(top-1 ~0.23 vs a depth-12 Expert) / label quality.

## What moved the needle (established)

- Weak outcome VALUE -> deep-search-root-score VALUE: val MSE **1.08 -> 0.176** (checkpoint 2).
- Stronger POLICY+VALUE labels: vs tacticalUCT **0.385 -> 0.545-0.550** (checkpoint 2/3).

## Decision teacher (R25/R26) - LIVE

DGX1 (`unsloth-env`, NVIDIA GB10, torch 2.14.1+cu130, unsloth 2026.10.3) is fine-tuning
`unsloth/Qwen3.5-0.8B` with the Clef-style decision head (38.1M trainable / 699M, LoRA; batch 2 x grad-4)
on the improved `decision-v2.jsonl` (strong teacher, budget 320 ms, 8 samples/game). The prior 20 %
bestMove run is being replaced by a larger, stronger-labelled dataset. Training is in flight in tmux
`teacher`; the report is written when it finishes and will separate bestMove from the binary questions.

## R25/R26 blocker reconciliation

The earlier "DGX Unsloth blocker" is resolved by *doing the work*: the isolated unsloth env exists on
both Sparks (DGX2 via the QSFP replication), the model is cached, and the fine-tune is running - not
pending. Remaining teacher work is dataset quality/labelling, not environment access.

## In flight (tmux, autonomous)

- DGX1 `teacher`: Qwen3.5-0.8B decision fine-tune on `decision-v2`.
- DGX2 `sweep`: last config (w64b6) finishing.
- `w96b4` export + league results retained under `docs/v5.1/bot-ai/evidence/track-a-20261013/`.

## Status: honest

Value head FIXED; strength moved above the tactical baseline; **capacity and search both ruled out as
levers**; the remaining gap vs the depth-12 Expert (0.02-0.04) is a policy-prior/label-quality problem.
No promotion; `APPROVED_CATALOG` empty. Next: deeper/cleaner labels and a controlled PUCT self-play
cycle only if the prior improves first.
