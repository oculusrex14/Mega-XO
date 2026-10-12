# R27 - compact runtime and INT8 quantization non-inferiority

Same model, same runtime, same paired held-out families; only the candidate's numeric precision differs
(float dynamic ONNX vs INT8 QDQ). `promotionApproved` false throughout.

| pairs | games | pointScore | paired-bootstrap 95% CI |
| --- | --- | --- | --- |
| 24 | 48 | 0.5417 | [0.4375, 0.6458] |
| 100 | 200 | 0.512 | [0.465, 0.560] |
| **300** | **600** | **0.498** | **[0.475, 0.522]** |

## Result

At 300 independent families the INT8 candidate is **statistically indistinguishable** from float
(point 0.498). The interval still contains 0.5, so **equality** is not proven - but INT8 is
**non-inferior to float at a 5-point margin** (lower bound 0.475 > 0.450), which is the practical
requirement for shipping the smaller artifact. Recorded honestly as a bounded non-inferiority claim,
not an equality claim.

Export gates (unchanged, re-confirmed): float parity exact (0 legal-argmax changes, ~4e-7 max numerical
error); INT8 QDQ changes 13/512 legal argmaxes at the argmax level but does not degrade match outcomes
above. Package sizes: float 854101 B / 787246 gzip; INT8 248813 B (gzip ~0.327 MB).

**Scope:** one runtime (Node 26 / onnxruntime-node, Apple Silicon), one candidate model. Not device
calibration. This qualifies the QUANTIZATION STEP, not the model: the candidate remains far below the
strength gate and `APPROVED_CATALOG` stays empty.
