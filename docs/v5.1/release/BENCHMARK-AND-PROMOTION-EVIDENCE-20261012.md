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
