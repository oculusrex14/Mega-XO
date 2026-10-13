# Anchored RL loop works — measured (DGX2, 2026-10-13)

Contrast with the naive multi-generation run (`multi-generation-rl-finding-20261013.md`). Same machine,
same league protocol (40 families / 80 games per matchup); the ONLY change is the anchored self-play
loop (`selfplay-anchored.cjs` + `anchorDataset`): each generation keeps the strong-label corpus in the
training mix and **adds** self-play from the current champion, instead of replacing it.

| Generation | Naive loop (rl3): vs tacticalUCT | **Anchored loop (rl4): vs tacticalUCT** |
| --- | --- | --- |
| 1 | 0.931 | 0.931 |
| 2 | **0.394** (collapse) | **0.950** (new champion) |
| 3 | **0.294** (collapse) | 0.906 |

- **Naive**: replacing the corpus with pure self-play each generation degrades the model (0.931 → 0.394
  → 0.294). Classic self-play collapse without a strong anchor.
- **Anchored**: the loop stays strong (0.931 → 0.950 → 0.906) and the run ended **RESEARCH_APPROVED**
  (`RESEARCH_ADVANCE_REFERENCE_FLOOR`, score 0.906, CI low 0.856, 40 families). No collapse.
- The anchored run's strongest generation (gen-2, **0.95 vs tacticalUCT** / 0.35 vs improvedExpert) is
  preserved under `gen-2/`; gen-3 (0.906) is the gate-approved champion artifact.

## Reading

The measured cause of the earlier collapse was **self-play replacement**, not multi-generation RL per se.
Keeping the strong-label anchor in every generation is sufficient to make the loop stable over 3
generations. This is a genuine, measured RL result — not an assumption — and it validates the corrected
loop documented in `multi-generation-rl-finding-20261013.md`.

## Residual refinement (honest)

The research gate advanced gen-3 (0.906) over the better gen-2 (0.950): the reference-floor path advances
any candidate clearing the floor, and the league does not yet include a **head-to-head matchup against the
previous champion model**. The head-to-head path exists in `evaluate_research_progression(parent_engine=…)`
but is unwired because `neural_league.cjs` uses fixed engine ids. Next: add a "vs previous champion"
matchup and require lower-CI > 0.50 to replace the champion, so a regressing generation cannot overwrite a
stronger one. All generations are preserved regardless, so nothing is lost.
