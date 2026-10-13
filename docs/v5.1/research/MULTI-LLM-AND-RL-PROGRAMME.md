# Multi-LLM simulation arena + genuine RL programme (V5.1, research-only)

Owner direction 2026-10-13: the supervised compact-CNN experiments were useful but are NOT the
conclusion of neural research. Target: an extremely strong, lightweight, primarily client-side Mega
XOXO bot, discovered by rigorous research — a multi-LLM simulation arena for strategy/position mining
checked against strong search, plus a genuine iterative AlphaZero-style RL loop, alongside stronger
classical training. The LLMs are candidate-move/diversity/hard-position sources, **not** assumed
ground-truth teachers; a larger language model is not assumed to be a better player.

Status labels (never conflated): implemented · locally-tested · staging-verified · device-verified ·
uploaded · submitted · provider-approved · production-enabled. Nothing here publishes a model or
touches production.

## Hardware pool (measured, not assumed)

| Resource | Measured | Role |
| --- | --- | --- |
| DGX1 `dgx-ts` (GB10, 20 cores, 121 GB, CUDA 13, internet) | torch 2.13/cu129 + unsloth env | LLM inference, multi-agent tournaments, CPU-parallel search/label generation |
| DGX2 `dgx2-qsfp-a` (GB10, 121 GB, **no internet**) | SGLang 0.5.16 only; QSFP 200 Gb/s | neural-MCTS self-play, GPU training, export, independent evaluation |
| QSFP link | RTT ~0.39 ms avg; rsync 394 MB/s; scp 619 MB/s; iperf 45–111 Gbit/s | ship verified artifacts/datasets DGX1→DGX2 |
| Colab T4 / TPU v5e1 | subscription-included, transient FS | independent reproduction + overflow only |
| Mac mini (this host) | torch 2.12 CPU | tooling dev, smoke runs, orchestration |

## Phase 1 findings already corrected (evidence)

- **Depth propagation (fixed, `22a236e`).** `search-labels.cjs::generate()` silently dropped `depth`, so
  every "depth-16" dataset actually ran at the Expert default. Measured that even forwarded, the Expert
  node budget capped completed depth at **8**; the label generator's `mcts.policy` *was* normalised
  (committed `visitTarget` sums to 1.0), so policy labels were sound but the VALUE-search depth never
  varied. `src/bot/search.js` clamps raised to 600000 ms / 50M nodes so deeper labels are *possible*.
- **Deep classical search is expensive.** Measured on DGX1-class CPU: depth 12 needed ~4M nodes (10 s)
  and reached depth 9; depth 16 needed ~21M nodes (60 s) and reached depth 11. This is the quantitative
  reason the programme must move to **neural-guided** MCTS rather than deeper alpha-beta.
- **Label semantics separated.** `train.py` now canonicalises `valueTargetSource`, never averages
  terminal-outcome and search-root-score targets, records the mix, and can filter to one semantics.
- **Best-validation export + early stopping.** `train.py` exports the lowest-validation-loss epoch (not
  the last, typically overfit), records the selection, and supports opt-in early stopping.

## Phases 2–7 (programme)

2. **External data** (`arnowaczynski/utttai`): rules/board compatibility, licence, and a validated
   converter or an explicit rejection. Never change our rules to accept external records.
3. **Multi-LLM arena**: offline simulator over `src/game.js`; structured move responses validated by the
   canonical engine; provenance (model/revision/quant/prompt-version/seed/temperature/tokens/latency);
   LLM-vs-LLM / Expert / neural / MCTS with side and opening-family alternation. Small pilot first;
   rate models objectively.
4. **Datasets**: deep-search, compatible external, verified tactics/endgames, LLM-adversarial,
   neural-MCTS self-play — distinct provenance and target types, canonical dedup, no cross-split leakage.
5. **Genuine RL**: bootstrap → neural-MCTS self-play → balanced replay → next generation → evaluate vs
   champion/Expert/tactical/LLM → advance on measured improvement; matched-budget supervised control;
   preserve all generations. Lightweight client model + optional larger offline teacher (distillation).
6. **Allocation**: DGX1 vs DGX2 vs Colab by measured throughput; rotate when measurement says so.
7. **Reporting**: progressive multi-day runs, resumable checkpoints, periodic reports with CIs, GPU
   hours, hashes and the next-justified experiment.

## Invariants

Game rules/economy/themes unchanged; no production/live-V4/catalog/release-gate/spend changes without
owner authorization; no second identity/authority. Research candidates stay offline; the public model
catalog stays empty unless a candidate independently clears the full promotion gate.
