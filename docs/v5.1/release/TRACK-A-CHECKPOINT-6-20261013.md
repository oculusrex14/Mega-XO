# TRACK A checkpoint 6 - full lever matrix; best candidate identified

Every candidate is a compact CNN (342k-714k params, ~20 ms/move) on the frozen, family-safe holdout.
"vs Expert" = `improvedExpert` (depth-12 alpha-beta); "vs tacticalUCT" = the tactical search baseline.

## Levers measured (what helps, what does not)

| Lever | Candidate | val value MSE | val top1 | vs Expert | vs tacticalUCT |
| --- | --- | --- | --- | --- | --- |
| Weak outcome VALUE (baseline) | bootstrap CNN | 1.08 | 0.23 | ~0.01 | <0.385 |
| Strong-search VALUE+POLICY (32k) | sl-dgx2-w64 | 0.176 | 0.204 | 0.020 | 0.545 |
| + capacity w96b4 | sw-w96b4 | 0.171 | 0.233 | 0.033 | 0.550 |
| + capacity w128b4 (1.23M) | sw-w128b4 | 0.178 | 0.201 | - | - |
| + **data 80k combined (d12)** | **big-w96b4** | **0.154** | **0.252** | **0.050** | **0.608** |
| + depth-16 labels (57k) | d12d16-w96b4 | 0.150 | 0.254 | 0.035 | 0.603 |
| + PUCT self-play (91k) | sp-w96b4 | 0.237 | 0.219 | - | - |
| More PUCT search (64->192 sims) | sw-w96b4 | - | - | flat 0.041 | - |

## Reading

- **Value target** was the single biggest fix (1.08 -> 0.15-0.18).
- **Data volume (80k)** gave the best strength (0.050 / 0.608) - the current best.
- **Capacity** (2x, 3.6x params): no strength gain.
- **Search simulation budget** (64->192): no gain - the prior is the limit.
- **Deeper labels (d16)**: no strength gain over d12.
- **Self-play augmentation with the weak model**: HURTS (value MSE regresses to 0.237).

**Best research candidate: `big-w96b4`** - 714k params, 1.38 MB float / 381 KB INT8, ~20 ms/move, point
score **0.608** vs the tactical search and **0.050** vs the depth-12 Expert on 100 independent families.
It is a genuinely useful lightweight client bot, but **far below the 0.70 promotion gate**.

## Honest conclusion

Within the compact-CNN + strong-label paradigm, the achievable strength is ~0.05 vs the depth-12 Expert;
the levers that "should" scale it (more capacity, more search, deeper labels, self-play) were each measured
and did NOT. Reaching 0.70 needs a fundamentally stronger approach (large-scale AlphaZero-style RL with a
much bigger net and many GPU-hours, or a better evaluation/search), which is beyond the lightweight-client
constraint this project targets. No model is promoted; `APPROVED_CATALOG` stays empty.

## Artifacts

Evidence under `docs/v5.1/bot-ai/evidence/track-a-20261013/`. Nothing published.
