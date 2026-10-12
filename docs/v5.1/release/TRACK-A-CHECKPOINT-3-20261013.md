# TRACK A checkpoint 3 - architecture sweep; capacity is not the lever

Same strong-search-label dataset (31,854 records), DGX2 GPU, selection on validation value MSE.

| model | params | val valueMSE | val top1 | vs improvedExpert | vs tacticalUCT |
| --- | --- | --- | --- | --- | --- |
| w64b4 | 342k | 0.176 | 0.204 | 0.020 | 0.545 |
| w96b4 | 714k | **0.171** | 0.233 | **0.033** | 0.550 |
| w128b4 | 1.23M | 0.178 | 0.201 | - | - |
| w64b6 | 342k+ | (see below) | - | - | - |

**Reading:** doubling capacity (342k -> 714k) buys ~+1.3 points vs the Expert (0.020 -> 0.033) and flat
vs tactical (0.545 -> 0.550); a 1.23M model is no better on value. Capacity is NOT the lever - the
**label / search depth** is, which is where the work continues.

The candidate is a 342-714k-param CNN running in ~20 ms/move that now plays **at/above** the tactical
search (0.55) on 100 independent holdout families, while remaining far below the 0.70 promotion gate vs
the depth-12 Expert. `APPROVED_CATALOG` stays empty; nothing is published.

## Next levers (in order of expected value)

1. **Deeper teacher labels** (depth 14-16 / larger budgets) - the diagnosed bottleneck.
2. **PUCT self-play with the working value head** - bootstrap strength from the model + search.
3. Larger/longer training on the 80k DGX1+DGX2 union.
