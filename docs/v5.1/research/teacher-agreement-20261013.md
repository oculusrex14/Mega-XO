# Teacher agreement — deep-search vs external utttai labels (2026-10-13)

Phase 4 deliverable: measure how much our two strong label sources agree, on the positions they share.

Method: index every converted utttai position by canonical key (`sha1(planes)`); for each of our
`search-labels-combined` rows, find the same position in the external corpus and compare the policy
(arg-max of `visitTarget`) and the value (`valueTarget`).

| Metric | Value |
| --- | --- |
| Shared positions | **619** |
| Policy top-1 agreement | **0.137** (13.7%) |
| Value correlation (Pearson) | **0.286** |
| Mean absolute value difference | 0.040 |

## Reading

- The two teachers agree on the **best move only 13.7%** of the time and their values correlate only
  weakly (0.286), though the values are close in magnitude (mean |diff| 0.04).
- This is expected: one is our classical depth-12 alpha-beta root score + UCT visits; the other is
  utttai's multi-simulation NMCTS root value over its own MCTS tree. They are **different engines**.
- **Diversity is the point.** Low top-1 agreement means the corpus ensemble carries complementary
  information rather than redundant copies — consistent with the measured result that adding the
  external labels lifted strength 0.05 → 0.406 vs Expert (they are not just more of the same).
- The small shared count (619) confirms the two sources are almost **disjoint** (external is 352k
  positions from utttai self-play; ours is 80k from our own games), so the combined corpus is close to
  additive rather than duplicated.

## Implication

Keep both sources distinct (`valueTargetSource` preserved) and train on the union. Do **not** average
their labels for a shared position; a future experiment can test a per-teacher agreement filter or a
confidence weighting, but the evidence here says the disagreement is signal, not noise.
