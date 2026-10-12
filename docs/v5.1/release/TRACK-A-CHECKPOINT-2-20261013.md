# TRACK A checkpoint 2 - strong-search labels fix the value head (2026-10-13)

## The finding

The compact CNN's value head was **unlearnable** because the training VALUE target (the eventual winner
of a weakly-played game) is near-unpredictable. Replacing the target with the **deep search's root
score** (a bounded look-ahead evaluation) fixes it:

| Value target | validation value MSE | note |
| --- | --- | --- |
| weak self-play terminal outcome | **1.00-1.15** | worse than predicting 0 (0.73) - memorises train (0.010) |
| **deep-search root score** | **0.176** | far below predict-zero; the head now generalises |

Same compact CNN (342,282 params), trained on DGX2 GPU (87 s; peak CUDA 110 MB; 1,506 J at 17.3 W mean).

## Strength movement (100 independent holdout families, 200 games each)

| Opponent | Candidate | pointScore | 95% CI |
| --- | --- | --- | --- |
| `tacticalUCT` | sl-dgx2-w64 | **0.545** | [0.490, 0.603] |
| `improvedExpert` | sl-dgx2-w64 | 0.020 | [0.007, 0.035] |

The candidate moved from **below** the tactical search (0.385 previously) to **at/above** it (0.545), a
concrete strength gain from the label change, on a leak-free holdout. It is still **far below the 0.70
gate** vs the depth-12 Expert (0.020), so the model stays unpublished and `APPROVED_CATALOG` empty.

## Datasets produced (family-safe, leakage-free)

| Node | shards x games | records | train / val / holdout |
| --- | --- | --- | --- |
| DGX1 (`search-labels-1000`) | 16 x 64 | 48,396 | 37,953 / 5,229 / 5,214 |
| DGX2 (`search-labels-dgx2`) | 14 x 48 | 31,854 | 24,567 / 3,973 / 3,314 |

## In flight

- DGX2 architecture sweep: w96b4, w128b4 (60 epochs) and w64b6 (80 epochs) on the same labels; selection
  on validation (value MSE + top1), then a strength benchmark of the best.
- DGX2 unsloth env ready + HF Qwen cache present for the decision teacher next.

## Export gates

`candidate.onnx` 1.376 MB / 1.276 MB gzip; INT8 381 KB / 323 KB gzip; **floatLegalArgmaxChanges 0**;
sizeGate true.

## Honest status

Value head FIXED; strength vs tactical baseline improved; distance to the Expert gate still large. No
promotion. Next: best architecture → PUCT self-play with the working value head → stronger training.
