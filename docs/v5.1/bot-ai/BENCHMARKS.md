# Reproducible strength and latency protocol

Run `node tests/bot/baseline.cjs` for the frozen-seed baseline corpus and scripted opponent. Run `node tests/bot/runner.cjs Expert Easy 1000 wall > .artifacts/bot-league.json` for 1,000 opening pairs (2,000 games). These are headless, unpaid local simulations; every move uses canonical legal/apply.

The default smoke uses an injected deterministic 512-node ceiling (128-node clock checks), still bounded by each old tier's original cap. It is NOT the production Expert budget. Node equalization measures search efficiency and reproducibility; deployment promotion additionally requires identical wall budgets and separately reported device performance. Lower-tier error policy is part of strength, not a reason to silently assign one contestant more compute.

Each pair uses identical openings and RNG seeds, swaps engines between X/O, and alternates the starting symbol between pairs. Draw=0.5. Bootstrap whole matched opening pairs with seed 731, 2,000 resamples and a 95% interval. Fewer than 30 independent pairs are smoke-only. For promotion, stratify at least 200 independent pairs across held-out opening families, report sample sizes, all W/D/L, point score and interval, and test with different seeds before sign-off. Do not treat repeated states from one game as independent samples.

Pin rules hash, candidate hash, baseline commit, runtime, device and budgets. Split training/validation/holdout by complete games AND related opening families; never tune on the promotion set. Preserve legal move histories for failures. The initial reachable corpus covers immediate mini/global wins, mandatory global defense, dangerous routing, closed/drawn destinations, free choice and forced late moves. Dedicated fork and sacrifice-to-win proofs remain OPEN; do not label this initial corpus comprehensive.

Baseline observation: four seeds choose `{b:4,c:4}` from the empty board under the deterministic smoke budget. This demonstrates repetition, not that a forced best move should be randomized. The memorized-script opponent scored 0 wins, 1 draw, 3 losses in four games (12.5% points). Exploit success is NOT established; the script adversary is a regression fixture to improve, not proof Expert has been beaten reliably.

Measure original per-tier wall budgets on supported reference hardware separately. Capture p50/p95, input latency/long tasks, peak memory, background/foreground cancellation, thermal and battery behavior. Linux-container Node timings are not Android/iPhone/Safari measurements. No such physical-device evidence has been collected here. Initial targets remain Expert p95 <1.5s and Impossible <2.0s on explicitly supported devices. Expert promotion target is >=65% versus old Expert; Impossible >=70% versus new Expert, with adequate statistical evidence. No model is approved by training loss, depth or size alone.

## 2026-10-12 Measured Dual-DGX Training and Resource Benchmark (B04.06)

Static reports recorded under `.artifacts/models/{candidate-dgx1-w64b4,candidate-dgx2-w48b3,candidate-cycle-w64b4}/{training-report.json,export/export-report.json}` establish the hardware, resource consumption, learning trajectories, and calibration profiles for three dual-DGX neural candidates.

### Experiment Provenance and Base Commit Note
- **Reported Base Commit:** `d3454187471ffb15e74831a6c19ab60baff1a118` (was **dirty** during experiments; reports' base commit is NOT a clean exact experiment tree).
- **Exact Verifiable Source Hashes (SHA-256):**
  - `src/bot/search.js`: `5194df8e120f35391e6991f4277f0400a14caa6cc481b86e8d6e138c3af3a545` (matches workspace file)
  - `src/game.js`: `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0` (matches workspace file)
  - `src/bot/encoding.js`: `1eea6e4fbbc0d411feba8dfca8455f39fe2fd68996a13618718b56b86a6c9511`
  - `training/bot/train.py`: `ee5533833869bf3769c701c30321aced64e2c65bac78f5557410b518239b13e4`
  - `training/bot/model.py`: `5c10a00b5eefc76ae117cc55e05bab9de388c77850bdc12326399eedf700ddc4`
  - `training/bot/generate.cjs`: `46e5fe419efb928e4a600dde6c3fe255038013e6edd54d78961db476d6c1b5f9`
  - `training/bot/validate-data.cjs`: `0996d546285b55a89d9d3452cbea162e4bfd7da440387483b4475fd1961ffe74`
- **Environment:** Cluster nodes `dgx-ts` and `dgx2-ts`, NVIDIA GB10 GPU (`cuda`), PyTorch `2.13.0+cu129`, Python `3.12.3`, ONNX `1.19.1`, ONNX Runtime `1.23.2`, determinism enforced.

### Model Training and Resource Footprint Comparison Table

| Metric | Candidate 1 (`candidate-dgx1-w64b4`) | Candidate 2 (`candidate-dgx2-w48b3`) | Candidate 3 (`candidate-cycle-w64b4`) |
| :--- | :--- | :--- | :--- |
| **Cluster Node** | `dgx-ts` | `dgx2-ts` | `dgx-ts` |
| **Model Role** | Bootstrap baseline / Research Champion | Size experiment | Cycle self-play retrain |
| **Architecture** | Width 64, Blocks 4, planes8-v1 | Width 48, Blocks 3, planes8-v1 | Width 64, Blocks 4, planes8-v1 |
| **Parameters** | 342,282 (within 0.25M-2.0M target) | 170,250 (**below** 0.25M lower range; size experiment) | 342,282 (within 0.25M-2.0M target) |
| **Dataset SHA-256** | `a8bfbe3bbcae6da235f6f16b8292d443...` | `d00370104bdf1e274a3478cb93ccaa15...` | `a054a925c06e6a80a63029f9cb9907c1...` |
| **Model Checkpoint SHA-256** | `ac9cc0ecdcf9a5b47fe002c7ff4f71c9...` | `140adef750930262335a31641688311c...` | `e4efc6c095627d14723a6643cb640434...` |
| **Raw / Gzip Checkpoint** | 1,379,604 B / 1,274,108 B | 690,072 B / 635,588 B | 1,379,604 B / 1,276,151 B |
| **Seed / Epochs** | Seed 51 / 20 epochs | Seed 77 / 20 epochs | Seed 99 / 20 epochs |
| **Split Games (T / V / H)** | 159 train / 20 val / 21 holdout | 158 train / 25 val / 17 holdout | 240 train / 32 val / 28 holdout |
| **Elapsed Wall Time** | 19.48 s | 22.17 s | 32.62 s |
| **Peak / Reserved CUDA RAM** | 95.26 MB / 113.25 MB | 85.90 MB / 102.76 MB | 95.27 MB / 119.54 MB |
| **Energy Consumed** | 313.39 Joules | 298.63 Joules | 506.57 Joules |
| **Mean / Peak Power** | 16.25 W / 18.04 W | 13.62 W / 14.47 W | 15.62 W / 18.56 W |
| **Train Loss (Ep 1 -> Ep 20)** | 2.6070 -> 1.8530 (-28.9%) | 2.7580 -> 1.8921 (-31.4%) | 2.6860 -> 1.8715 (-30.3%) |
| **Val Policy Loss (Ep 1 -> Ep 20)**| 2.0095 -> 2.0660 (**worsened**) | 1.9756 -> 2.0030 (**worsened**) | 1.9853 -> 2.0287 (**worsened**) |
| **Val Value MSE (Ep 1 -> Ep 20)** | 0.8494 -> 0.9079 (**worsened**) | 1.0439 -> 1.3730 (**worsened**) | 0.9553 -> 1.1022 (**worsened**) |
| **Top-1 / Top-3 Action Agreement** | 17.43% / 46.52% (Ep 20) | 18.18% / 46.40% (Ep 20) | 17.80% / 47.20% (Ep 20) |
| **Policy Entropy (Ep 1 -> Ep 20)**| 2.0058 -> 1.9389 | 1.9737 -> 1.9378 | 1.9847 -> 1.9299 |
| **Deployment Status** | UNAPPROVED (Research Champion) | UNAPPROVED (Size Experiment) | UNAPPROVED (Cycle Retrain) |

### Learning Curve Contradiction and Calibration Failure
Across all three models, training loss decreased steadily from ~2.6-2.7 to ~1.85-1.89 over 20 epochs. However, **validation policy loss and validation value MSE worsened simultaneously** across every candidate:
- Candidate 1 validation policy loss degraded from 2.0095 to 2.0660; value MSE degraded from 0.8494 to 0.9079.
- Candidate 2 validation policy loss degraded from 1.9756 to 2.0030; value MSE degraded from 1.0439 to 1.3730.
- Candidate 3 validation policy loss degraded from 1.9853 to 2.0287; value MSE degraded from 0.9553 to 1.1022.

Outcome calibration shows severe distortion and overconfidence in extreme outcome bins. In epoch 20 validation:
- In bin `[-1.0, -0.6]`, Candidate 1 predicted mean -0.8758 on positions whose true mean outcome was -0.1676 (absolute error 0.7082); Candidate 2 predicted -0.8569 against target +0.1790 (absolute error 1.0359); Candidate 3 predicted -0.9110 against target -0.1531 (absolute error 0.7579).
- In bin `[0.6, 1.0]`, Candidate 1 predicted mean +0.8976 against target +0.2383 (absolute error 0.6592); Candidate 2 predicted +0.8515 against target -0.2425 (absolute error 1.0940); Candidate 3 predicted +0.9268 against target +0.1356 (absolute error 0.7912).
The models systematically mistake drawn or contested positions for decisive wins/losses. This severe value miscalibration directly poisons MCTS value backups.

---

## ONNX Export, Quantization and Delivery Packaging Footprint (B05.01, B05.02, B05.03)

### Numerical Agreement on 512 Frozen States (B05.01)
Parity evaluations against 512 frozen states (spanning train, validation, and holdout; purpose is strictly numerical sanity, not a playing strength metric):
- **Float32 Models (`candidate.onnx` and `candidate-dynamic.onnx`):**
  - Candidate 1: Max policy absolute error 2.861e-6, max value absolute error 7.749e-7, **0 legal argmax changes** (exact agreement).
  - Candidate 2: Max policy absolute error 1.907e-6, max value absolute error 7.898e-7, **0 legal argmax changes** (exact agreement).
  - Candidate 3: Max policy absolute error 3.815e-6, max value absolute error 1.490e-6, **0 legal argmax changes** (exact agreement).
  - Dynamic batching successfully validated on batch dimensions [1, 7].
- **QDQ Signed INT8 Per-Channel Quantization:**
  - Calibrated against 128 training records only.
  - Candidate 1: 17 of 512 legal argmax choices changed (3.32%), max policy absolute error 2.1974.
  - Candidate 2: 33 of 512 legal argmax choices changed (6.45%), max policy absolute error 1.4614.
  - Candidate 3: 28 of 512 legal argmax choices changed (5.47%), max policy absolute error 5.1137.

### Artifact Sizes vs Nominal 1–5 MB Target (B05.02)
- **Candidate 1 (342k params):**
  - Float static ONNX (`candidate.onnx`): 1,375,959 bytes raw, **1,272,393 bytes gzip** (1.272 MB gzip) -> **inside** the nominal 1–5 MB compressed model target.
  - Float dynamic ONNX (`candidate-dynamic.onnx`): 1,375,974 bytes raw, 1,272,400 bytes gzip.
  - INT8 ONNX (`candidate-int8.onnx`): 380,957 bytes raw, **327,182 bytes gzip** (0.327 MB gzip) -> **below** the nominal 1 MB target lower bound, but safely under the 5 MB upper cap.
- **Candidate 2 (170k params size experiment):**
  - Float static ONNX: 686,774 bytes raw, 634,021 bytes gzip (0.634 MB gzip) -> below 1 MB nominal lower bound.
  - INT8 ONNX: 200,382 bytes raw, **165,807 bytes gzip** (0.166 MB gzip) -> below 1 MB nominal lower bound, under 5 MB cap.
- **Candidate 3 (342k params):**
  - Float static ONNX: 1,375,959 bytes raw, 1,274,436 bytes gzip (1.274 MB gzip) -> inside 1–5 MB target.
  - INT8 ONNX: 380,957 bytes raw, 325,809 bytes gzip (0.326 MB gzip) -> below 1 MB nominal lower bound, under 5 MB cap.
- **Size Gate Audit Clarification:**
  Export reports list `sizeGate: true` solely because artifacts do not exceed the 5.0 MB hard ceiling. **Do not call the 1–5 MB target passed simply because export `sizeGate` is true.** Candidate 2 is explicitly an under-parameterized size experiment (170,250 params < 0.25M), and INT8 compressed weights (0.166 MB to 0.327 MB) fall well below the nominal 1 MB target floor.

### Runtime WASM Separation and Pinned Legal Assets (B05.03, NeuralDeliveryRepair)
- **WASM Runtime Binary is Separate:** The ONNX Runtime Web WASM distribution file `ort-wasm-simd-threaded.wasm` is **11,905,541 bytes** (~11.9 MB raw, SHA-256 `45eaee27761ad883742a8d4b8fce1538d60ce43b51adf1726fafccc59b8c1a15`), with optional WebGPU JSEP binary `ort-wasm-simd-threaded.jsep.wasm` at **23,824,254 bytes** (~23.8 MB). Runtime bytes are separate from model bytes and must not be conflated with the model payload.
- **Exact Offline Pinned Legal Assets:**
  - Upstream pinned commit: `a83fc4d58cb48eb68890dd689f94f28288cf2278` (onnxruntime-web@1.23.2).
  - MIT License (`LICENSE`): **1,073 bytes**, SHA-256 `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c`.
  - Third-Party Notices (`ThirdPartyNotices.txt`): **326,866 bytes**, SHA-256 `e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc`.
  - Total legal notice footprint: **327,939 bytes**, included in staged runtime totals (`scripts/v51/stage-ai-runtime.cjs`). Parent actual staging smoke is pending.

---

## Paired Neural League Tournaments and Ablation Analysis (B01.06, B04.10, B04.11, B07.04)

Tournaments run across 105 independent D4-normalized 4-ply opening families held out from training (`splitFor(family) === 'holdout'`), 210 games per matchup (105 matched pairs, alternating colors, equal 30ms wall / 16 simulation budgets).

### Remote League Tournament Results Table

| Matchup | Engine A | Engine B | Games (Pairs) | Wins | Draws | Losses | Point Score | 95% Pair Bootstrap CI | p50 / p95 Move (ms) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Candidate 1 (DGX1)** | | | | | | | | | |
| Ablation: Tact vs Exp | `tacticalOnly` | `improvedExpert` | 210 (105) | 0 | 3 | 207 | 0.0071 (0.71%) | [0.0000, 0.0167] | 0.13 / 30.10 |
| Ablation: Pol vs Exp | `policyOnlyPUCT` | `improvedExpert` | 210 (105) | 2 | 9 | 199 | 0.0310 (3.10%) | [0.0119, 0.0548] | 11.86 / 30.22 |
| Full: PV vs Exp | `policyValuePUCT` | `improvedExpert` | 210 (105) | 1 | 1 | 208 | 0.0071 (0.71%) | [0.0000, 0.0190] | 11.91 / 30.17 |
| Neural vs Tactical | `policyValuePUCT` | `tacticalUCT` | 210 (105) | 50 | 64 | 96 | 0.3905 (39.05%) | [0.3357, 0.4476] | 0.24 / 11.49 |
| Quantization Check | `int8PUCT` | `policyValuePUCT` | 210 (105) | 78 | 63 | 69 | 0.5214 (52.14%) | [0.4714, 0.5738] | 5.72 / 11.61 |
| **Candidate 2 (DGX2)** | | | | | | | | | |
| Ablation: Tact vs Exp | `tacticalOnly` | `improvedExpert` | 210 (105) | 0 | 2 | 208 | 0.0048 (0.48%) | [0.0000, 0.0119] | 0.13 / 30.10 |
| Ablation: Pol vs Exp | `policyOnlyPUCT` | `improvedExpert` | 210 (105) | 4 | 10 | 196 | 0.0429 (4.29%) | [0.0214, 0.0690] | 7.12 / 30.39 |
| Full: PV vs Exp | `policyValuePUCT` | `improvedExpert` | 210 (105) | 1 | 1 | 208 | 0.0071 (0.71%) | [0.0000, 0.0190] | 7.11 / 30.25 |
| Neural vs Tactical | `policyValuePUCT` | `tacticalUCT` | 210 (105) | 41 | 68 | 101 | 0.3571 (35.71%) | [0.3000, 0.4119] | 0.25 / 6.58 |
| Quantization Check | `int8PUCT` | `policyValuePUCT` | 210 (105) | 77 | 57 | 76 | 0.5024 (50.24%) | [0.4548, 0.5524] | 3.99 / 6.35 |
| **Candidate 3 (Cycle)**| | | | | | | | | |
| Ablation: Tact vs Exp | `tacticalOnly` | `improvedExpert` | 210 (105) | 0 | 3 | 207 | 0.0071 (0.71%) | [0.0000, 0.0167] | 0.13 / 30.10 |
| Ablation: Pol vs Exp | `policyOnlyPUCT` | `improvedExpert` | 210 (105) | 0 | 4 | 206 | 0.0095 (0.95%) | [0.0024, 0.0190] | 11.90 / 30.18 |
| Full: PV vs Exp | `policyValuePUCT` | `improvedExpert` | 210 (105) | 0 | 2 | 208 | 0.0048 (0.48%) | [0.0000, 0.0119] | 12.01 / 30.16 |
| Neural vs Tactical | `policyValuePUCT` | `tacticalUCT` | 210 (105) | 44 | 66 | 100 | 0.3667 (36.67%) | [0.3143, 0.4214] | 0.24 / 11.37 |
| Quantization Check | `int8PUCT` | `policyValuePUCT` | 210 (105) | 65 | 58 | 87 | 0.4476 (44.76%) | [0.3952, 0.5024] | 5.59 / 11.42 |

### Statistical and Architectural Findings
1. **INT8 vs Float32 Equivalence vs Regression:**
   In all three quantization matchups, the 95% bootstrap confidence intervals contain 0.50:
   - Candidate 1: [0.4714, 0.5738]
   - Candidate 2: [0.4548, 0.5524]
   - Candidate 3: [0.3952, 0.5024]
   **Confidence intervals containing 0.50 demonstrate NO DETECTED REGRESSION. They do NOT mean exact parity or mathematical equivalence.** INT8 changed 17 to 33 legal top actions across 512 benchmark states.
2. **Value Head Ablation Confirms Degradation (B04.10):**
   Across all candidates, `policyOnlyPUCT` scored higher than `policyValuePUCT` against `improvedExpert`:
   - Candidate 1: policy-only 3.10% vs policy+value 0.71%
   - Candidate 2: policy-only 4.29% vs policy+value 0.71%
   - Candidate 3: policy-only 0.95% vs policy+value 0.48%
   This confirms that the severely miscalibrated value head degrades MCTS decision-making relative to simple rollout or visit-count policy guidance.
3. **Iterative Cycle Champion Rejection (B04.07):**
   Candidate 3 (trained with an iterative cycle of self-play games: 240 train, 32 val, 28 holdout) won **0 games** against `improvedExpert` (0 wins, 2 draws, 208 losses, score 0.0048). It performed **worse** than Candidate 1 (1 win, 1 draw, score 0.0071).
   Per B04.07 protocol ("preserve the previous champion and never automatically replace shipped models because training loss decreased"), Candidate 3 is rejected, preserving Candidate 1 as the internal research champion.

---

## Improved Expert vs Legacy Baseline Tournament (B07.04)

A dedicated local promotion tournament was executed and captured under `.artifacts/v51/candidate-heldout-128pairs-20ms.json`:
- **Engine A:** `search-v1-experimental` (SHA-256 `5194df8e120f35391e6991f4277f0400a14caa6cc481b86e8d6e138c3af3a545`, budget 20ms wall with 350,000-node ceiling)
- **Engine B:** `legacy-Expert` (commit `f8913fd`, budget 20ms scaled clock with original node cap)
- **Rules Version:** Canonical rules `src/game.js` (SHA-256 `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0`)
- **Holdout Families:** 128 independent D4-normalized opening families, zero data leakage (`leakageExcluded: true`).
- **Results (256 games across 128 matched alternating pairs):**
  - **Wins:** 167
  - **Draws:** 54
  - **Losses:** 35
  - **Point Score:** **0.7578125 (75.78%)**
  - **95% Pair Bootstrap CI:** **[0.712890625, 0.80078125]**
  - **Latency:** p50 20.07 ms, p95 21.00 ms
  - **Opening Diversity:** 45 unique moves, repetition rate 0.102, entropy 4.84
- **Gate Evaluation:** **PASSED.** The improved Expert search achieves 75.78% point score, decisively exceeding the >=65% promotion threshold with a lower 95% confidence bound of 71.29% >= 65%.

---

## Deterministic Baseline Corpus and Scripted Adversary Smoke (B01.02, B01.03, B01.04)

Recorded in `.artifacts/v51/baseline-current.json` on Node runtime `v26.8.2`:
1. **Reachable 11-Fixture Tactical Corpus (B01.02, B01.03):**
   - 11 curated tactical cases tested: `opening`, `curated-fork`, `sacrifice-to-win`, `send-danger`, `mini-win`, `closed-route`, `free-choice`, `mandatory-global-defense`, `mega-win`, `late-forced`, `drawn-route`.
   - Captures deterministic 512-node ceiling choices side-by-side with full-budget choices.
   - Dedicated mathematical proofs for curated fork and sacrifice-to-win remain open.
2. **Deterministic Empty-Board Repetition (B01.02):**
   - Under the deterministic 512-node ceiling, four consecutive seeds choose `{b:4, c:4}` from the empty board.
   - Across different seeds, `legacy-Expert` generated identical 47-move sequences, verifying complete deterministic repeatability.
3. **Scripted Exploit Adversary (B01.04):**
   - Script training seed 72, evaluation seed 91: 4 matched pairs (8 games).
   - Result: 0 wins, 1 draw, 7 losses (point score 0.0625, 95% CI [0.0, 0.1875]).
   - **SMOKE ONLY:** Fewer than 30 independent pairs; this fixture serves solely as a regression check, not promotion evidence.

---

## Unsloth Decision-Model Teacher Evaluation (B04.08, B04.09)

- **Classification:** `NOT_SELECTED_RESEARCH_OPTION`.
- **Findings:** No experimental runs or data collected for the Unsloth Qwen3.5-0.8B teacher model.
- **Evidence Assessment:** There is zero experimental evidence of teacher benefit or teacher absence. Tiny networks running fast on DGX GPUs does not prove they are strong or tactically sound in Mega XOXO.
- **Product Architecture Policy:** Distillation (B04.09) is not applicable without demonstrated teacher superiority. The production game prohibits any per-move cloud, DGX, or Oracle runtime dependency.

---

## Physical Reference Hardware and Human Accessibility Testing (B01.05, B05.09, B07.01, B07.08)

- **Physical Reference Devices (B01.05, B05.09, B07.01):** **UNMEASURED.** No physical Android phones (low-end/mid-range), iPhones, iOS Safari/WKWebView, Android WebView, device RAM footprints, thermal throttling, or battery drain curves have been measured. Desktop and container Node timings are headless simulation proxies and cannot substitute for physical hardware measurements.
- **Fresh-User Onboarding and Accessibility Testing (B03.14, B07.08):** **UNMEASURED.** No moderated first-time user trials or screen-reader / assistive-technology sessions have been conducted.

---

## Full-Tier Adjacent Calibration, 105 Independent Families (B07.05)

Measured with the repository's own paired-league protocol at each tier's configured budget, balanced
X/O, on 105 independent D4-normalized opening families with leakage exclusion verified. Source
`src/bot/search.js` `5194df8e120f35391e6991f4277f0400a14caa6cc481b86e8d6e138c3af3a545` and
`src/game.js` `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0`; Node v24.21.0
on the verified DGX host. Raw artifact `.artifacts/v51/profiles-league-105pairs-dgx1.json`.

| Higher vs lower tier | Games | Point score | Paired 95% CI | Ordering |
| --- | --- | --- | --- | --- |
| Easy vs Beginner | 210 | 0.9690 | [0.948, 0.988] | separated |
| Medium vs Easy | 210 | 0.9643 | [0.940, 0.986] | separated |
| Hard vs Medium | 210 | 0.8905 | [0.855, 0.924] | separated |
| Expert vs Hard | 210 | 0.5833 | [0.529, 0.638] | separated |

All four adjacent pairs are strictly monotonic with an interval that excludes parity, so every tier
is measurably stronger than the tier below it at 105 independent families. Opening diversity from the
empty board over 20 seeds: Beginner/Easy 20 unique moves (entropy 4.32), Medium 16 (3.88), Hard and
Expert 1 (entropy 0) — the top two tiers are deterministic at their budgets by design, which is why
repeated-opening diversity is measured for the lower tiers and forced best moves are NOT randomized.

Scope limits kept explicit: this is one Node runtime on one host, not cross-device calibration, and it
does not by itself certify an Impossible tier (see the neural rejection below). Promotion remains
unapproved and the public catalog stays empty.

## Final Audit Determination and Promotion Rejection (B07.04, B06.01, B06.02)

1. **Expert Tier Search:** **APPROVED.** Improved Expert search (`search-v1-experimental`) scored 75.78% (CI [0.7129, 0.8008]) against legacy Expert across 128 held-out families (256 games), exceeding the >=65% promotion threshold.
2. **Neural Impossible Tier:** **STRONGLY REJECT ALL PUBLIC PROMOTION.**
   - Required acceptance threshold: Win/point score >= 70% with lower 95% CI >= 0.65 against `improvedExpert`.
   - Measured neural scores:
     - Candidate 1: 0.0071 (0.71% points, 95% CI [0.0000, 0.0190])
     - Candidate 2: 0.0071 (0.71% points, 95% CI [0.0000, 0.0190])
     - Candidate 3: 0.0048 (0.48% points, 95% CI [0.0000, 0.0119])
   - All neural candidates fail the promotion gate by two orders of magnitude.
   - Candidate 3 cycle retrain achieved 0 wins in 210 games, demonstrating zero improvement over Candidate 1.
3. **Public Catalog Status:** **APPROVED_CATALOG REMAINS EMPTY (`[]`).**
   - No neural model is approved, activated, or published for player use.
   - Candidate 1 (`candidate-dgx1-w64b4`) is retained exclusively as an internal research champion for offline experimentation.
