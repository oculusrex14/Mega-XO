# Compact bot training (offline, unapproved research candidates)

This path has no player-facing network calls and no connection to V4 production.
The canonical rules remain `src/game.js`. Large JSONL files, checkpoints and ONNX
exports belong under ignored `.artifacts/` or owner-controlled object storage,
not Git. Do not publish an artifact containing private user games or identifiers.

## Reproducible bootstrap

Use Node 24 and an isolated Python environment. On verified DGX hosts (`dgx-ts` aitopatom-a531
and `dgx2-ts` edgexpert-c555, NVIDIA GB10 CUDA 12.9, PyTorch 2.13.0+cu129), an isolated toolroot
and virtualenv are created under `/home/oculus-rex/v51-experiment/`:
- Official Node v24.21.0 aarch64 verified with SHA-256 (`6ad1325edbdb...`).
- Isolated Python venv reusing installed PyTorch via `.pth` pointer with pinned `onnx==1.19.1`,
  `onnxruntime==1.23.2`, `onnxscript==0.5.6`.
- Zero modifications to user ComfyUI or system packages.

```sh
# Step 1: Validate architecture and model logic
python3 training/bot/test_model.py

# Step 2: Generate canonical self-play dataset (disjoint D4 families)
node training/bot/generate.cjs .artifacts/data/seed-1000.jsonl 1000 1000 32
node training/bot/validate-data.cjs .artifacts/data/seed-1000.jsonl

# Step 3: Train policy-value CNN candidate with CUDA and GPU power sampling
python3 training/bot/train.py .artifacts/data/seed-1000.jsonl \
  --source-commit "d3454187471ffb15e74831a6c19ab60baff1a118" \
  --output .artifacts/models/candidate-1 \
  --epochs 15 --batch 64 --device cuda --width 64 --blocks 4

# Step 4: Export to static, dynamic, and INT8 QDQ ONNX with parity verification
python3 training/bot/export.py .artifacts/models/candidate-1 .artifacts/data/seed-1000.jsonl \
  --output .artifacts/models/candidate-1/export

# Step 5: Paired heldout leagues across >= 100 independent D4 opening families
node training/bot/neural_league.cjs \
  --model .artifacts/models/candidate-1/export \
  --pairs 100 --budget-ms 100 --simulations 64 \
  --output .artifacts/benchmarks/candidate-1-league.json
```
Generation refuses to overwrite an existing dataset. Training refuses to replace
an existing candidate directory. Run from the repository root and pin a clean
source commit; reports also retain exact relevant source-file hashes. Training
replays every retained move, mask and tensor through the JS oracle before fitting.
This initial trainer is a single-device in-memory bootstrap path, NOT a claimed
distributed DGX training service. Shard/index large datasets before scale-up.

Each game uses a seeded four-ply opening, alternating starting symbol and mixed
UCT/Beginner/Easy behavior. Every retained state has a UCT visit-distribution
label, including mixed-behavior positions (explicitly off-policy), a legal mask,
complete prefix, actual next move, final outcome and side-to-move value. Entire
games and D4-equivalent opening families stay together in train/validation/holdout.
A SHA-256 manifest pins data, oracle and search versions. The frozen holdout is
not used by the training loop. Avoid generating every seed from one opening
family and verify substantial independent validation/holdout coverage before
interpreting any loss curve.

## Tensor and model contract

`planes8-v1`: NCHW [N,8,9,9], own marks, opposing marks, owned mini-board,
opponent mini-board, drawn mini-board, required mini-board, legal cells, free
route. Coordinates are the visual 9x9 grid; policy index is **b*9+c**, not visual
row-major. The policy head explicitly gathers into that action order. The eight
D4 transformations rotate/reflect both macro and local indices identically.
Value is +1 for a final win by the player to move in the recorded state, -1 for
loss, and 0 for draw. A terminal board has an all-zero legal policy mask and must
be resolved by the rules, not by inventing a neural action.

Default: 64 channels, four two-convolution residual blocks, 342,282 parameters,
81 logits and one tanh value. A 24-game, 8-simulation, two-epoch CPU run is only an
executable pipeline smoke. Its validation consisted of one game and worsened;
that model is explicitly unapproved. Checkpoint compression is not the ONNX,
quantized, WASM-library, Worker, browser-memory or shipped pack size.

## Promotion / champion safety

No automatic promotion exists. Freeze the data family split before experiments.
For each candidate retain training commit+file hashes, data hash, deterministic
settings, learning/calibration curves, GPU memory, elapsed time and measured
energy (null means unmeasured), runtime/package versions and licenses. Compare
policy-only and policy/value PUCT at identical wall and simulation budgets on
held-out opening families against old/new Expert, UCT and adversarial opponents.
Preserve the champion unchanged unless the paired confidence/strength, critical
tactics, model size, numerical parity and physical-device latency gates pass.
A lower training loss or an attractive file size is never a promotion trigger.
The initial value-loss metric is not a full calibration study.

## Optional Unsloth teacher

Qwen3.5-0.8B is a separately evaluated optional teacher, never a game runtime
requirement. Compact 64-channel 4-block CNN models achieve low millisecond inference
without requiring knowledge distillation from a larger model. The option is recorded
as `NOT_SELECTED_RESEARCH_OPTION` based on lack of empirical need for larger backbones.
Distillation trials are not fabricated. DGX access, private artifact storage and training
runs are owner-operated follow-up gates, not production dependencies.
## Primary references checked 2026-10-11

- PyTorch reproducibility: https://docs.pytorch.org/docs/stable/notes/randomness.html
- Deterministic algorithms: https://docs.pytorch.org/docs/main/generated/torch.use_deterministic_algorithms.html
- ONNX exporter: https://docs.pytorch.org/docs/stable/onnx
- ORT Web: https://onnxruntime.ai/docs/get-started/with-javascript/web.html
- ORT WebGPU: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- Unsloth Qwen3.5: https://unsloth.ai/docs/models/qwen3.5
- Unsloth notebooks: https://unsloth.ai/docs/get-started/unsloth-notebooks
- Unavailable guide: https://unsloth.ai/docs/basics/train-your-own-decision-model-with-unsloth

These links describe APIs/capabilities, not evidence that a particular device or
our candidate passed. Feature-detect and run measured tests; do not treat an
upstream browser support table as this product's acceptance matrix.

## License/distribution boundary

No pretrained weights or external datasets are included. Network code is newly
written for this repository. Preserve all applicable PyTorch/ONNX/ORT notices if
shipping their libraries; audit exact pinned package artifacts and any future
teacher weights before distribution. The repository has no root LICENSE file
in the inspected base, so do not invent a license grant for its code or weights.
