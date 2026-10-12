# TRACK A checkpoint 5 - combined dataset improves the candidate; LLM teacher bestMove = chance

## Compact CNN, 80,250-record combined dataset (DGX1 + DGX2), DGX2 GPU

`big-w96b4` (714k params, 60 epochs, 418 s GPU):

| metric | value |
| --- | --- |
| best validation value MSE | **0.154** (was 0.171 at 31.9k records) |
| validation top-1 | **0.252** (was 0.233) |
| vs tacticalUCT | **0.608** [0.547, 0.670] (now clearly above the tactical search) |
| vs improvedExpert | **0.050** [0.025, 0.077] (was 0.020) |

Progress is real and monotone with **data quality/quantity** (weak outcome 1.08 -> strong labels 0.176
-> combined 0.154; strength 0.020 -> 0.050 vs Expert, 0.385 -> 0.608 vs tacticalUCT). It remains far
below the 0.70 gate. Capacity and search were already ruled out as levers; more/better strong labels and
possibly a PUCT self-play cycle are the live directions.

## Decision teacher (R25/R26) - COMPLETED, and it did NOT meet the bar

`unsloth/Qwen3.5-0.8B` + Clef decision head, fine-tuned on DGX1 (38.1M LoRA params, GB10, torch
2.14.1+cu130, unsloth 2026.10.3) on the improved `decision-v2` dataset (960 rows, strong teacher,
budget 320 ms). Frozen, family-safe confirmation set:

| question | accuracy |
| --- | --- |
| winNow (binary) | **1.00** (56/56) |
| opponentThreat (binary) | **1.00** (56/56) |
| **bestMove (81-way choice)** | **0.143** (8/56) = **chance (1/7 legal)** |

This is an **honest negative result**: the 0.8B LLM teacher solves the two easy binary questions but its
best-move decision over legal options is at chance - no better than the prior 20 % run and not usable as
a stronger label source. It is NOT distilled and NOT published. The compact CNN with deep-search labels
remains the stronger approach; the useful-teacher hypothesis (R26) is not supported by this evidence.

## DGX assignment so far

- DGX1 (`dgx-ts`): depth-16 label generation (fresh, larger teacher); teacher fine-tune (done).
- DGX2 (`dgx2-qsfp-a`): compact-CNN training/export/league (this candidate).

## Files

Evidence (training/export/league/teacher reports) under
`docs/v5.1/bot-ai/evidence/track-a-20261013/`.

No promotion; `APPROVED_CATALOG` empty; nothing published; V4 untouched.
