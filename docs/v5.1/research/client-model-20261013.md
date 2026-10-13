# Client model candidate — champion export (2026-10-13)

The compact policy/value CNN produced by the external-label breakthrough, measured as a client-side
artifact. Research-only; `APPROVED_CATALOG` unchanged.

## Champion (research): rl3 gen-1 / the external-trained `ex1` net

| Property | Value |
| --- | --- |
| Architecture | 8-channel residual CNN, width 96, blocks 4 |
| Parameters | **713,802** |
| Float ONNX | `candidate.onnx` **2,862,040 B** (gzip 2,658,799 B) |
| INT8 ONNX | `candidate-int8.onnx` **757,104 B** (gzip 653,080 B) |
| Size gate (<= 5 MB compressed) | **PASS** (both variants) |
| Float ONNX legal-argmax changes | 0 |
| Strength | **0.469 vs improvedExpert** (CI [0.381, 0.556]) / **0.931 vs tacticalUCT** (CI [0.881, 0.975]) |
| Per-move latency (league, 80 games) | p50 30.1 ms / p95 31.1 ms at a 30 ms search budget |

## Reading

- The champion is a **lightweight client model**: 2.9 MB float / 0.76 MB int8, comfortably within the
  programme's 1–5 MB target. It is a real, measured strength improvement (9x the prior best vs Expert),
  not a size-only candidate.
- The INT8 quantization on the external-trained net shows a **large match-score regression** (int8PUCT
  vs policyValuePUCT 0.294, CI [0.212, 0.381]) — the int8 artifact is **not** ready to ship;
  quantization non-inferiority needs a dedicated pass (calibration set, per-channel, mixed precision)
  before any client pack. Float ships as the reference.
- Latency is search-budget-dominated at this config; a client would tune MCTS simulations to the device
  (B05.09), which changes p50/p95 materially.
- No offline teacher / distillation was needed: the strongest labels came from an external MCTS/NMCTS
  corpus, not a larger language model — consistent with the programme's finding that a bigger LLM is not
  automatically a better teacher (the Unsloth teacher was previously rejected on bestMove=chance).

## Not done

- No browser/WASM/WebGPU runtime latency measured (that is a device task, B05.09/B07.06).
- No quantization non-inferiority pass on the champion yet — the one real blocker to an int8 client.
