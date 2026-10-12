# B-series neural benchmark and promotion-gate evidence (R23/R24/R27/R28) - 2026-10-12

Main agent. Real measured numbers from actual pipelines; **no candidate is promoted**, none of these
are strength claims, and the public `APPROVED_CATALOG` stays empty / `mega_v51_search` stays `legacy`.

## Compact CNN training (approach A), local CPU

- `training/bot/generate.cjs` -> 200 games / 9,437 records (24 simulations, seed 20261012); split by
  D4 opening family so no family crosses train/validation/holdout.
- `training/bot/train.py` 64x4 (**342,282 parameters**), 30 epochs, batch 64, CPU: 228.6 s.
- Final validation: **top-1 policy agreement 16.2%**, top-3 47.1%, policy loss 2.09, **value MSE
  1.14**. Value calibration is poor in the tails (e.g. bin [-1.0,-0.6]: meanPredicted -0.89 vs
  meanTarget +0.10, absError 0.99). The compact net learns weakly on bootstrap self-play - a real
  diagnostic, not a generalization result.

## Real strength leagues (24 independent D4 holdout families, 48 games each, 20 ms / 16 sims)

| Matchup | Point score | 95% CI |
|---|---|---|
| tacticalOnly vs improvedExpert | 0.000 | [0.000, 0.000] |
| policyOnlyPUCT vs improvedExpert | 0.031 | [0.000, 0.073] |
| policyValuePUCT vs improvedExpert | 0.010 | [0.000, 0.031] |
| policyValuePUCT vs tacticalUCT | 0.365 | [0.260, 0.458] |
| int8PUCT vs policyValuePUCT | 0.542 | [0.417, 0.667] |

Interpretation, stated conservatively:

- **No neural candidate approaches Impossible.** All are far below the promotion gate (lower 95% CI
  >= 0.65 against improved Expert), so nothing is promoted.
- **The value head HURTS at this scale**: `policyValuePUCT` (0.010) is *worse* than `policyOnlyPUCT`
  (0.031) against the same opponent - a concrete diagnosis (R23/B04.11) that the value head is not
  helping. This is the failure-mining signal the plan asks for, not a scaling target.
- **INT8 vs float** (R27): 0.542, CI [0.417, 0.667] - no regression detected, but the interval
  contains 0.5, so non-inferiority is **not** established at this sample.

## Promotion gate

`evaluate_gate` (in `training/bot/champion_cycle.py`) reads the `policyValuePUCT vs improvedExpert`
summary and promotes only when the paired-bootstrap lower bound clears the league's own declared
threshold (0.65). Every measured candidate is far below it, so each cycle ends `REJECTED` with the
champion preserved (`PRESERVED_UNAPPROVED`) and `promotionApproved=false`. Training loss alone never
changes the champion.

## DGX GPU environment (approach A execution host)

An **isolated** CUDA runtime was created on `dgx-ts` without touching any system package or the
existing ComfyUI/TTS venvs: `/home/oculus-rex/mega-xo-learning/.venv` with
`torch 2.14.1+cu130` (aarch64) and `cuda.is_available() == True` (NVIDIA GB10). A static Node
`v24.12.0` (linux-arm64) was placed in the same directory for the validate/generate stages, and the
training tree was synced read-from-Git. This removes the previous "no torch on the Spark" blocker for
GPU runs; the results of the GPU training/league are recorded separately when they complete.

## DGX GPU candidate (96x5, 879,882 params) - real GPU run

Trained on `dgx-ts` GPU (torch 2.14.1+cu130, GB10): 400 games / 18,679 records, 40 epochs, batch 128,
**63.4 s, 1523.7 J (mean 24.1 W), 141 MB peak CUDA**. Export (DGX): float 3,527,415 B,
INT8 931,567 B; `floatLegalArgmaxChanges: 0`, `sizeGate: true`, `deploymentStatus: UNAPPROVED`,
`strengthGate: NOT_PASSED`. Independent league on the pulled candidate (24 families, 48 games each):

| Matchup | Point score | 95% CI |
|---|---|---|
| tacticalOnly vs improvedExpert | 0.000 | [0.000, 0.000] |
| policyOnlyPUCT vs improvedExpert | 0.010 | [0.000, 0.031] |
| policyValuePUCT vs improvedExpert | 0.000 | [0.000, 0.000] |
| policyValuePUCT vs tacticalUCT | 0.438 | [0.333, 0.542] |
| int8PUCT vs policyValuePUCT | 0.563 | [0.458, 0.667] |

**Conclusion (decisive, not a strength claim):** growing the model (342k -> 880k) and training on the
GPU **improved `policyValuePUCT vs tacticalUCT` from 0.365 to 0.438**, but left **every** matchup
against `improvedExpert` at 0.0-1.0% - the Expert gap is essentially unchanged. Therefore the binding
constraint is the **data and label quality** (bootstrap self-play with a mixed-strength behavior
policy), not model capacity - exactly the lever the plan's CL10 ("bootstrap with stronger teachers and
diverse opponents") targets, and not more of the same self-play. The value head continues to
underperform policy-only vs Expert at both scales. No promotion; the approved catalog stays empty.

## CL10 stronger-teacher dataset - measured effect

The enhanced generator (`training/bot/generate.cjs`, CL10 profile: larger target search than the
behavior move, frozen tier roster, explicit exploration fraction, hard-state flags/provenance) produced
80 games / 3,708 records with **2,821 hard-state positions (76%)**. A 64x4 student trained on it (25
epochs, batch 64, CPU):

| Metric | Old bootstrap labels | CL10 stronger-teacher labels |
|---|---|---|
| top-1 policy agreement | 16.2% | **23.9%** |
| top-3 policy agreement | 47.1% | **60.9%** |
| value MSE | 1.14 | **0.71** |
| policy loss | 2.09 | 1.92 |

So stronger labels measurably improve what the student learns. Match strength (24 families, 48 games
each):

| Matchup | old bootstrap | CL10 |
|---|---|---|
| policyValuePUCT vs improvedExpert | 0.010 | **0.000** |
| policyOnlyPUCT vs improvedExpert | 0.031 | 0.042 |
| policyValuePUCT vs tacticalUCT | 0.365 | **0.500** |
| int8PUCT vs policyValuePUCT | 0.542 | 0.490 |

**Interpretation (decisive):** CL10 made the model stronger relative to the UCT tactical reference
(0.365 -> 0.500, now even) and improved learning, but the gap to `improvedExpert` is still ~0%. The
bootstrap labels come from a UCT teacher that is itself far weaker than Expert, so no amount of the
same self-play can teach Expert-level play. The binding constraint is a **genuinely stronger label
source** - Expert search / solved positions - which is exactly CL18-CL23 (approach B teacher and
conditional distillation). No promotion; catalog stays empty.

## Stronger-LABEL experiment (expert behaviour cloning) - the decisive result

Following the CL20-CL21 finding (weak UCT labels cap everything), the generator gained an
`expert` **labelSource**: instead of UCT visit distribution, the target is the strongest classical
engine's move (one-hot behaviour cloning). 100 games / **4,633 records**; a 64x4 student trained 30
epochs:

| | weak-UCT labels (CL10) | Expert BC labels |
|---|---|---|
| top-1 policy agreement | 23.9% | **29.9%** |
| top-3 agreement | 60.9% | **68.3%** |
| value MSE | 0.71 | 1.26 |

So the student learns the Expert move policy better (top-1 29.9%). But the independent league:

| Matchup (24 families, 48 games) | Expert-BC |
|---|---|
| policyValuePUCT vs improvedExpert | **0.000** |
| policyOnlyPUCT vs improvedExpert | 0.031 |
| policyValuePUCT vs tacticalUCT | 0.406 |
| int8PUCT vs policyValuePUCT | 0.521 |

**Conclusion (the sharpest result of this work):** better move-*labels* alone do not close the Expert
gap. Imitating a DEEP-SEARCH engine's individual moves with a student that is used only as a prior in a
SHALLOW search (16 sims / 20 ms) cannot reproduce that engine's strength - the missing ingredient is
the **search depth/compute at inference**, not the label or the network size. Therefore:

- Impossible (> Expert) is not achievable by the compact CNN at the current client inference budget,
  regardless of dataset size or label source.
- The realistic paths are (a) a much larger inference/search budget on capable devices (contradicts the
  <1500 ms client target), or (b) an AlphaZero-style loop where the network is trained on its OWN
  deep-search self-play over many iterations - far beyond this session's budget and not provable here.
- **No promotion.** `APPROVED_CATALOG` stays empty; `mega_v51_search` stays legacy; the public ladder is
  the measured classical five tiers.

This is recorded as the top AI open item with the exact evidence chain: model size (0%), label volume
(0%), label quality (0%) all fail to move the Expert gap; only inference search depth remains.

## Inference-budget / value-head ablation (matched openings, held-out families)

Same exported model (`expert-BC`), same 24 held-out families (48 games), same `improvedExpert` and
`tacticalUCT` references; only the neural bot's search budget changed:

| config | policyValuePUCT vs improvedExpert | policyOnlyPUCT vs improvedExpert | policyValuePUCT vs tacticalUCT |
|---|---|---|---|
| 16 sims / 20 ms | 0.010 | 0.010 | 0.438 |
| 64 sims / 100 ms | 0.010 | 0.000 | 0.260 |
| 256 sims / 400 ms | 0.021 | 0.021 | 0.167 |

Three honest findings:

1. **The Expert gap is NOT a compute-budget gap.** 16x more search (16 -> 256 sims) moved the score
   from 0.010 to 0.021 - still ~1-2%, nowhere near a competitive result. So the earlier claim that
   "inference compute is the only remaining bottleneck" is **refuted**: adding inference budget does
   not close the gap.
2. **More search with a weak network is WORSE vs the classical engine.** vs `tacticalUCT` the score
   FALLS monotonically as budget rises (0.438 -> 0.260 -> 0.167). The compact net's prior is
   genuinely useful at very low budget; at higher budgets noisy MCTS with a weak value head dilutes
   that prior and plays worse. This is a design/quality limit of the network, not a compute limit.
3. **The value head does no work here.** policyValuePUCT and policyOnlyPUCT are identical within noise
   (0.010 vs 0.010; 0.021 vs 0.021). At these budgets the learned value adds nothing over the policy.

Conclusion: **do not scale AlphaZero-style training on this evidence.** Neither label quality (the
generator now labels with the SAME `improvedExpert` the league uses, `042c913`), model size, nor
inference budget closes the Expert gap, and raising budget regresses. The honest disposition remains
no promotion, catalog empty; the realistic routes (a genuinely stronger label source, or a much larger
network trained by self-play over many iterations) are not supported by any evidence gathered here.

Latency note for phone feasibility: 256 sims / 400 ms per move is already the top of the intended
< 1500 ms client budget once ONNX Runtime load + first-move compile are added, and it is the WORST
configuration vs tacticalUCT - so there is no budget at which this design both fits a phone and
approaches Expert.

## Teacher-equivalence correction and matched re-test (authoritative result)

The earlier expert-BC labels came from the weak heuristic `G.choose` while the league benchmarks
`improvedExpert = S.choose({difficulty:'Expert'})` - a **depth-12 alpha-beta search, 350k nodes**
(`src/bot/search.js` PROFILES.Expert). That mismatched teacher/benchmark pair made the earlier number
weak evidence. Corrected (`042c913`): the generator's `expert` labelSource now labels with EXACTLY the
benchmarked `S.choose` Expert.

Corrected dataset: 1,911 records / 40 games; student trained 30 epochs.

| metric | value |
|---|---|
| policy top-1 agreement with the real Expert | 0.230 (vs 0.299 when imitating the weak heuristic teacher) |
| policy top-3 | 0.634 |
| value MSE | 1.08 |

Matched league (same 24 held-out families, 48 games, 16 sims / 20 ms), teacher == benchmark teacher:

| matchup | score |
|---|---|
| policyValuePUCT vs improvedExpert | 0.010 |
| policyOnlyPUCT vs improvedExpert | 0.000 |
| tacticalOnly vs improvedExpert | 0.000 |
| policyValuePUCT vs tacticalUCT | 0.385 |

**Conclusion (matched, confound removed):** the ~1% vs Expert and the inference-budget plateau are
NOT artifacts of the teacher mismatch. Behaviour-cloning a depth-12 search engine's *moves* (23% top-1)
does not reproduce its strength when the student is used only as a shallow-search prior, and raising
the budget does not close the gap (and regresses vs tacticalUCT). Note the real Expert is *harder* to
imitate (0.230) than the weak heuristic was (0.299), so the earlier 0.299 was a soft label artifact.

No promotion; `APPROVED_CATALOG` stays empty. Scaling AlphaZero-style training is not supported by any
evidence gathered; the honest routes remain (a) a much larger network trained by long self-play, or
(b) accepting the classical ladder as the shipped strength - neither is proven here.
