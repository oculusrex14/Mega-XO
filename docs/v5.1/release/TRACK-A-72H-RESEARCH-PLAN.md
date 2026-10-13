# TRACK A - 72-hour serious AI research programme (DGX1 + DGX2 + Colab)

Owner: Main. Parallel, complementary streams. Non-commercial hobby project; both NVIDIA DGX Sparks
reserved for this, plus a **Google Colab** lane (T4 GPU / TPU v5e1; see
`COLAB-RUNTIME-INVENTORY-20261013.md`). Every serious candidate is benchmarked on the FROZEN,
leakage-free holdout against `improvedExpert`, the previous neural candidate and tactical baselines at
realistic client inference budgets, with paired CIs, wall-clock, energy, memory, model size and
provenance.

## Hardware pooling and placement

| Resource | Available | Placement / role |
| --- | --- | --- |
| DGX1 (`dgx-ts`, GB10) | 20 cores, 121 GB, unsloth-env + v51 venv | **Primary train/export**; teacher fine-tune; deep-search label generation (CPU-parallel) |
| DGX2 (`dgx2-qsfp-a`, GB10) | via DGX1 QSFP, no internet | **Secondary train/export + independent league eval**; unsloth env replicated over QSFP |
| Colab T4 (1.15 CU/hr) | subscription-included, transient FS | **Portability proof** + **overflow** small sweeps/labels; short notebook workflows |
| Colab TPU v5e1 | available | only TPU path; needs a JAX/torch-xla port (separate investigation) |
| Oracle `command` (us-east) | 4 cores, 23 GB | co-located staging + API/Core (TRACK B), **not** training |

Rule: **do not duplicate a DGX job on Colab**; Colab takes work the DGX pair is waiting on or cannot do
(third-runtime reproduction, TPU, notebook sharing). Colab is time-metered, so any run > a few minutes
needs owner confirmation (spend-bearing).

## Frozen holdout discipline

`training/bot/generate.cjs::splitFor` groups whole games by D4-normalized 4-ply opening family; a family
never crosses train/validation/holdout. The holdout families are frozen by seed and are **never** trained
or tuned on. Model selection uses validation; the holdout is scored once, after selection.

## Gating (progressive)

For any direction: **pilot** (minutes) -> **diagnose** (does the signal exist?) -> **stronger experiment**
(only if diagnosed) -> **substantial training** (only if the stronger experiment beats the prior
candidate on validation). A direction that shows no signal is recorded and abandoned, not scaled.

## Known bottleneck (from the compact CNN)

Policy top-1 ~0.23-0.30 against a depth-12 Expert; league ~0.01 vs `improvedExpert`; **value MSE ~1.08,
worse than predicting zero (0.73)** - the value head learned nothing. Diagnosis is the first task.

## Lane DGX1 (policy/value nets, self-play, search)

1. **Value-head diagnosis (pilot):** is the failure optimisation, capacity, or a genuinely hard target?
   A deterministic material/feature baseline plus a value-only training run establishes the ceiling.
2. **Stronger targets:** deep classical search (depth-12 Expert) + verified tactics (forced win/deny)
   + solved endgames as policy/value labels, not more weak UCT self-play.
3. **Architecture sweep:** width {64,96,128} x blocks {4,6}, residual vs plain, value-head depth; select
   on validation.
4. **Search:** PUCT/MCTS improvements (prior/value mix, dirichlet noise, visit-temperature, terminal
   short-circuit); measure strength per unit client time.
5. **Self-play:** PUCT self-play with value backup once the value head works; temperature schedule.

## Lane DGX2 (Unsloth Qwen3.5-0.8B decision teacher)

1. **Diagnose 20% bestMove:** separate best-move accuracy from the two easy binary questions; is it
   label quality, task weighting, decision formulation, or capacity?
2. **Better datasets:** deep-search gold best-moves (the `decision-dataset.cjs` teacher, budget-threaded),
   class/position balancing, hard-state mining.
3. **Fine-tuning sweep:** LoRA rank, LR, epochs, task weighting; measure bestMove specifically.
4. **Alternatives:** policy-over-legal-moves formulation, contrastive/ranking objective; keep only what
   measurably raises bestMove.
5. **Stronger-label generation:** produce verified tactic/endgame labels for DGX1 where useful.

## Benchmark protocol (every serious candidate)

`neural_league.cjs` on >= the required independent families vs `improvedExpert` and `tacticalUCT` plus the
previous candidate; record `pointScore`, paired-bootstrap 95% CI, per-engine p50/p95 move latency,
`/usr/bin/time -v` peak RSS, GPU power/energy (nvidia-smi + a wall-clock energy estimate), model size
(bytes/gzip), and full provenance (source/rules/model hashes, config, seed).

## Promotion criteria (UNCHANGED)

>= 0.70 point score AND lower 95% CI >= 0.65 on >= 200 independent families, complete paired records,
bound model/source hashes, independent verifier qualified, plus device/runtime validation and owner
release approval. **No public Impossible promotion** without independently demonstrated strength.

## Checkpoints

Roughly every 6-12 h: DGX assignment, trials completed, performance deltas, resource use, staging status,
next experiments - in `docs/v5.1/release/MAIN-AUTONOMOUS-WORK-QUEUE.md` + a dated checkpoint doc.
