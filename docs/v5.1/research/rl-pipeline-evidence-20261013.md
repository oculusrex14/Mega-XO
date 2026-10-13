# RL pipeline evidence - supervised-seeded GPU cycle (DGX2, 2026-10-13)

Proves the corrected pipeline runs a full generate->validate->train->export->evaluate cycle on the DGX
GPU, seeded from committed strong-search labels. Research-only: `APPROVED_CATALOG` stays empty;
production untouched.

## Run

DGX2 `repo2` (synced tree at commit `61aaa06`), config `device=cuda`, `generations=1`,
`seedDataset=/home/oculus-rex/v51-experiment/data/search-labels-combined.jsonl`,
`valueSource=deep-search-root-score`, `epochs=3`, `batch=512`, `width=96`, `blocks=4`,
`leaguePairs=20`, `pythonBin` = DGX venv, `nodeBin` = DGX node v24.

All five stages completed: GENERATING (copy seed) · DATA_VALIDATED · TRAINING · EXPORT_VALIDATED ·
EVALUATING. Decision: **REJECTED** (research gate `INSUFFICIENT_INDEPENDENT_FAMILIES`) - correct, since
20 league pairs is below the configured 40-family research floor; nothing promoted.

## Measured results

| Stage | Result |
| --- | --- |
| GENERATING | seed copied, 80,250 records, sha `a2b1e15b…` |
| DATA_VALIDATED | 80,250 records, 1,696 games, **1,508 families**, canonical=true |
| TRAINING (cuda, NVIDIA GB10) | best epoch **2/3**, best val metric 2.024 (final 2.028); val policy loss 1.865, val value MSE **0.159**, policy top-1 0.231; **713,802 params**; peak CUDA **287 MB**; **19 s**; value source `deep-search-root-score` |
| EXPORT_VALIDATED | `candidate.onnx` 2,646,685 B; `candidate-int8.onnx` 684,481 B; **float legal-argmax changes 0** |
| EVALUATING | policyValuePUCT vs improvedExpert **0.025** (CI [0, 0.075]); vs tacticalUCT **0.438** (CI [0.30, 0.562]); int8PUCT vs policyValuePUCT **0.55** (CI [0.425, 0.662]) on 40 games/matchup |

## Reading

- The machinery is real and GPU-accelerated: an ONNX artifact was produced from a CUDA-trained model
  with zero float parity changes, and a full paired league ran.
- The **3-epoch seeded model is weak** (0.025 vs Expert) - it is a pipeline bootstrap, not a research
  result. The best-validation export picked epoch 2 over the final epoch (overfit guard working).
- The research gate correctly refused: 20 pairs < 40-family floor. A real research run uses >= 40
  (head-to-head) or >= 200 (public-qualified) pairs.
- `int8PUCT vs policyValuePUCT 0.55` (CI [0.425, 0.662]) reproduces the known quantization
  non-inferiority behaviour of the architecture.

## Next (Phase 5)

Scale the same cycle to a genuine multi-generation RL run: more epochs/sims, >= 40-family leagues,
`generations>=3` so each generation self-plays the previous champion. The value MSE (0.159) is the same
order as the earlier best supervised candidate (0.154); improvement must come from the self-play loop
and stronger labels, not more epochs.
