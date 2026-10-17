# Bot benchmarks — existing measurements only

Audit source context: `7f582b749a1128b86e53ddcbcda57b569b0953cf`, 2026-10-17. **No benchmark, league, training run or local product test was executed for this report.** Only existing measurements in [the canonical benchmark ledger](../../../../v5.1/bot-ai/BENCHMARKS.md) and existing measured league artifacts are reproduced. Unmeasured current behavior is NOT_RUN.

## Measured provenance

| Existing artifact | Integrity / availability | Scope |
| --- | --- | --- |
| `.artifacts/v51/candidate-heldout-128pairs-20ms.json` | Read locally without changing it; SHA-256 `38b1d9405172d872e7c57d46660ecfa23483dc960271e8c2a414dcbbacb4fb40` | 128 held-out paired families, improved search vs legacy Expert, Node v26.8.2 |
| `.artifacts/v51/profiles-league-105pairs-dgx1.json` | Read locally without changing it; SHA-256 `db298b483d1132a4dd10b0bcb9cc5857ba0f27025833a55414f3193a9ad087e6` | Adjacent-tier calibration, 105 paired families, Node v24.21.0 on one DGX host |
| `.artifacts/v51/baseline-current.json` | Read locally without changing it; SHA-256 `625354dd12723fe3ae332bb19e7849011a04a4f9fcc4a587ebf8ef6fe396f876` | Deterministic baseline/tactical/script-adversary fixture; not a promotion league |
| `docs/v5.1/bot-ai/BENCHMARKS.md` | Committed measured-evidence ledger | Neural leagues, desktop harness and historical gates. Raw neural experiment artifacts were not revalidated in this audit. |

The two classical league artifacts pin experimental source SHA-256 `5194df8e120f35391e6991f4277f0400a14caa6cc481b86e8d6e138c3af3a545` and rules SHA-256 `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0`. Their `promotionApproved` flags are **false**. The Markdown ledger's “APPROVED” Expert wording is therefore a historical assessment, not proof of a current shipping/promotion authorization.

## Improved Expert versus legacy Expert

Existing 128-pair artifact, 256 games, held-out D4 opening families with leakage exclusion:

| Metric | Existing measured result |
| --- | --- |
| Wins / draws / losses | 167 / 54 / 35 |
| Point score | 75.78125% |
| Paired-bootstrap 95% interval | 71.2890625%–80.078125% |
| Candidate budget | 20ms wall; 350,000-node ceiling |
| Legacy comparison budget | 20ms scaled original clock; original node ceiling remains |
| Candidate move latency | p50 20.0712ms; p95 21.0003ms |
| Opening diversity | 45 unique moves; repetition rate 0.102; entropy 4.84 |
| Artifact promotion flag | `false` |

This is evidence that the **measured candidate at that budget on that runtime** exceeded the ledger's 65% comparison target. It is not a physical Android/iPhone result, full-production-budget result, neural result or certificate for a changed source tree. The raw artifact explicitly calls it a tuning label pending multi-device evidence.

## Adjacent classical tiers

Existing 105-family artifact; 210 alternating-color games for each matchup. Intervals resample independent pairs, not individual correlated positions.

| Higher vs lower | Wins / draws / losses | Point score | Paired 95% interval |
| --- | --- | --- | --- |
| Easy vs Beginner | 201 / 5 / 4 | 96.9048% | 94.7619%–98.8095% |
| Medium vs Easy | 200 / 5 / 5 | 96.4286% | 94.0476%–98.5714% |
| Hard vs Medium | 176 / 22 / 12 | 89.0476% | 85.4762%–92.3810% |
| Expert vs Hard | 93 / 59 / 58 | 58.3333% | 52.8571%–63.8095% |

All measured intervals exclude 50% in the expected direction. This establishes ordering for that source, protocol and one host. It does not establish current cross-device ordering. The ledger separately records empty-board opening diversity over 20 seeds: Beginner/Easy 20 unique moves, Medium 16, Hard/Expert 1; do not confuse that probe with diversity across a league's many starting positions.

## Neural Impossible candidates

The canonical benchmark ledger records 105 held-out opening families / 210 games per comparison, equal 30ms wall / 16-simulation budgets against improved Expert:

| Candidate / mode | Wins / draws / losses | Point score | Paired 95% interval |
| --- | --- | --- | --- |
| Candidate 1, policy+value | 1 / 1 / 208 | 0.71% | 0%–1.90% |
| Candidate 2, policy+value | 1 / 1 / 208 | 0.71% | 0%–1.90% |
| Candidate 3 cycle retrain, policy+value | 0 / 2 / 208 | 0.48% | 0%–1.19% |
| Candidate 1, policy-only ablation | 2 / 9 / 199 | 3.10% | 1.19%–5.48% |
| Candidate 2, policy-only ablation | 4 / 10 / 196 | 4.29% | 2.14%–6.90% |
| Candidate 3, policy-only ablation | 0 / 4 / 206 | 0.95% | 0.24%–1.90% |

These candidates failed the recorded Impossible promotion target. There is no measured justification for a public strong neural tier, or for calling an Expert fallback Impossible. An internal research champion is not a playable approved model. Model bytes, parameter counts, lower training loss and fast inference do not provide strength evidence.

The ledger's INT8-versus-float confidence intervals contain parity. That is not a non-inferiority/equivalence proof; it must not be converted into an approval claim.

## Historical desktop harness

The benchmark ledger records headless Chromium run `evidence/device-2026-10-11T23-54-01-631Z.json`, source `c28fe74126c9033bff61459400aacb942156b9a8`, explicitly `deviceClass=headless-ci`, `physicalDevices=false`:

| Measurement | Recorded value | Scope |
| --- | --- | --- |
| Legacy per-tier move time | Beginner 13.5ms; Easy 5.5ms; Medium 20.9ms; Hard 132.0ms; Expert 326.6ms | One desktop harness run; not per-tier p95 certification |
| Experimental Expert move time | 510.4ms | Same single run |
| 11-position canonical corpus | p50 79.35ms; p95 329.86ms; zero observed tactical violations | Small curated corpus |
| Frame latency, 60 samples | p50 16.66ms; p95 16.67ms | Headless desktop |
| Cold start | 326.67ms | Includes harness startup |
| Cancellation / resume | AbortError fence passed; pinned seed preserved | Harness behavior |
| Neural Impossible | Not staged/available; skipped | No approved model |

The deterministic scripted adversary in the ledger has only eight games/four pairs: 0 wins, 1 draw, 7 losses, 6.25% points, interval 0%–18.75%. It is a regression smoke, not an adequate strength/promotion experiment. Dedicated proofs for fork/sacrifice fixtures remain separate from a fixture merely having that name.

## Current acceptance classification

| Question | Status |
| --- | --- |
| Current selected engine/source equals the measured improved candidate | Not established; see source selection/hash comparison in GAMEPLAY-AUDIT.md and SAGAN-008 |
| New current-build full-budget classical leagues | NOT_RUN |
| Current Android low/mid/high physical-device p50/p95, RAM, thermal/battery | NOT_RUN |
| Current physical iPhone/WKWebView/Safari bot benchmarks | NOT_RUN |
| Current neural promotion/approved public pack | NOT_RUN / no approved pack |
| Unsloth teacher or demonstrated distillation benefit | NOT_RUN in the cited ledger |
| Executing continuous-learning service produces a stronger current candidate | NOT_RUN |
| Novice tutorial comprehension ≥80% without hints | NOT_RUN |

Guided tutorial and optional local Impossible remain **UNVERIFIED / UNPAID**. No results in this document authorize official currency, Elo, an approved model upload or a release.
