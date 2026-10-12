# R19 - frozen classical baselines, tactical preservation and scripted-exploit bound

All on this host, `src/bot/search.js` + `src/game.js` hashes bound in each artifact; no model, no
provider, no production write.

| Requirement | Evidence |
| --- | --- |
| Freeze legacy `G.choose` outcomes over the curated corpus | `docs/v5.1/bot-ai/evidence/baseline.json` (11 cases; deterministic 512-node + original full-budget choices side by side) |
| Explicitly document identical/repeated sequences | `repeatedOpeningDeterministic: true`; `repeatedExpertSequences.identicalSequencesAcrossDifferentSeeds: true` (Expert vs Expert, seeds 101 vs 999, identical move list) |
| Scripted predictable-opening adversary, W/D/L vs Expert | 32 paired families / 64 games: **W0 D2 L62, pointScore 0.0156, paired-bootstrap 95% CI [0, 0.039]** - Expert is NOT exploitable by this adversary (the earlier 4-game "0-1-3" was capped-budget, not a bound) |
| Forced tactics / legal-move preservation | `tests/bot/tactics.test.cjs` 6/6 |
| Adjacent-tier ordering at intended device budgets, paired families | `docs/v5.1/bot-ai/evidence/profiles-league.json` (see `calibration`) |

**Honest scope:** this is one runtime (Node v26.8.0, Apple Silicon). It is NOT cross-device calibration
and NOT a 65%-Expert claim for any neural candidate. `promotionApproved` stays false; `APPROVED_CATALOG`
is untouched. The 75.78%-on-128-families number is `improvedExpert` (a deep search), not a learned model.
