# Stronger-label breakthrough — utttai NMCTS corpus (DGX2, 2026-10-13)

The single most important result of the session. The committed supervised candidate scored **0.05 vs
`improvedExpert`**; training on the converted utttai NMCTS corpus (352,357 positions) produced a model
that scores **0.406 vs `improvedExpert`** (CI [0.319, 0.500]) and **0.900 vs `tacticalUCT`**
(CI [0.838, 0.956]) on 40 independent families, 80 paired games per matchup — an **8x** improvement over
every prior candidate, from a change in *label quality*, not capacity or compute.

## Provenance

| Item | Value |
| --- | --- |
| Dataset | `utttai-combined` (5 converted members, deduped): **352,357** rows, sha `27fb2fed…` |
| Sources | utttai NMCTS root-value 177,492 + utttai MCTS root-mean 174,257 |
| Training | DGX2 GB10, CUDA, `width=96 blocks=4`, 6 epochs, batch 512, 713,802 params |
| Best validation | epoch 5, value MSE **0.118**, policy top-1 **0.452** |
| Export | `candidate.onnx`; float legal-argmax changes 0 |

(The utttai-only validation MSE measured earlier was 0.0004 on a single member; the combined corpus is
harder because it mixes MCTS and NMCTS targets across depths.)

## Measured league (40 pairs = 80 games per matchup, budget 30 ms / 48 sims)

| Matchup | Point score | 95% CI |
| --- | --- | --- |
| policyValuePUCT vs **improvedExpert** | **0.406** | [0.319, 0.500] |
| policyValuePUCT vs **tacticalUCT** | **0.900** | [0.838, 0.956] |
| policyOnlyPUCT vs improvedExpert | 0.325 | [0.237, 0.412] |
| int8PUCT vs policyValuePUCT | 0.294 | [0.212, 0.381] |
| tacticalOnly vs improvedExpert | 0.006 | [0, 0.019] |

Prior best-ever candidate: 0.050 vs improvedExpert / 0.608 vs tacticalUCT. **So the external labels
lifted 0.05 → 0.406 vs Expert and 0.61 → 0.90 vs tacticalUCT.**

## Gate verdicts (real, on the bound model)

- **Research advancement: `RESEARCH_ADVANCE_REFERENCE_FLOOR`** — score 0.90, CI low 0.8375, 40 families
  vs the reference baseline `tacticalUCT`. The research pointer advances; `APPROVED_CATALOG` unchanged.
- **Strict public qualification: refused (`INSUFFICIENT_INDEPENDENT_FAMILIES`)** — correctly, since 40 <
  200 families. No promotion, no catalog, no production change.

## Why this matters

The diagnosis (checkpoint 1) said the value/policy labels — not the architecture — were the bottleneck.
The utttai corpus is a *stronger label of the same kind* (their own multi-simulation MCTS/NMCTS root
values), which is exactly the lever the programme needed. It confirms the plan's premise: mine strong
label sources and distil them into the compact client network.

## Caveats (honest)

- Single run, one config; not yet a multi-generation RL result. The int8 quant match-score regression
  is large here (0.294) and needs a dedicated quantization pass before any client pack.
- The corpus is off-policy and covers only X-first games; it is used as supervision, never as
  complete-game records.
- Public qualification still needs >= 200 families and the full promotion protocol.

## Next

1. Combine deep-search + external + tactics into one canonical corpus (done: 431,999 records,
   `multi-source.jsonl`, canonical) and train the champion on it.
2. A real 3-generation neural-MCTS RL pass seeded from this model, evaluating head-to-head vs the
   previous champion (the head-to-head research path) plus the reference floor.
3. Quantization non-inferiority pass (the int8 0.294 regression must be fixed or the client ships float).
