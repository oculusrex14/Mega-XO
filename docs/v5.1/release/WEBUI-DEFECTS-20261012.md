# Independent defects and execution handoff - 12 October 2026

Owner: WebUI for reproduction/evidence; **Main for shared training/operator implementation**. Codex retains browser/provider ownership. Source examined: `b6b1f46121a565b06a21309fe4465df635cdbad9`; the same operator/generator hashes were exercised in CI at `cc2c0fd833ba84d1c775973d1a42eb0d63ce018d`.

## Confirmed executable failures

Run `python3 scripts/v51-readiness-probes.py --output .artifacts/readiness/probes.json`.

Observed locally: seven `DEFECT_REPRODUCED`, exit 2, Python 3.13.5 / Node 22.16.0. Independently observed in GitHub Actions run **38269273204**, job **114879199197**: the same seven failures, exit 2, Python 3.12.15 / Node 24.21.0. Artifact **11755244235**, SHA256 `79af6c7b5cf3c968082e9e81de754a9a618601ca92ebc6ce60c09c7f2fca975c`. The workflow is correctly RED; do not suppress it or describe it as a random CI failure.

Source hashes: `training/bot/champion_cycle.py` = `30a1397ecdb3aa398d691a481290304f0744996152ea46443286137c9c51add8`; `training/bot/generate.cjs` = `9914562858224041c9a216fa80adaa50e85c2552fca985cdb75e3c7d907679ac`.

| ID | Severity / affected requirement | Exact location and reproduction | Main fix and closure evidence |
| --- | --- | --- | --- |
| WEB-AI-01a | HIGH research-integrity; R22/R28, CL promotion | `champion_cycle.py:454` `evaluate_gate`: a sole `random` vs `beginner` result, pointScore .9 and CI [.8,.99], returns promote=true because the gate falls back to the first matchup. | Require exactly one exact candidate/reference pairing with frozen identities; reject absent, duplicate and unrelated matchups. Keep production approval separate. Probe must reject. |
| WEB-AI-01b | HIGH research-integrity; R22/R28 | Same function accepts policyValuePUCT vs improvedExpert at .69 points, CI [.66,.8], despite the league's declared >=.70 point target. | Enforce BOTH point target and independently agreed lower-bound target; require qualification sample size. Probe must reject. |
| WEB-AI-01c | HIGH research-integrity; R22/R28 | Same function accepts a reversed confidence interval [.9,.1]. Counts, finite statistics and complete paired evidence are not verified. | Validate finite non-boolean statistics, counts, ordered bounded intervals, pair records and model/source hashes. Recompute statistics. New `scripts/v51-readiness-model-gate.py` and ten passing tests provide an independent integration helper, not a replacement for physical/runtime approval. |
| WEB-AI-02a | HIGH recovery/concurrency; R22 | `champion_cycle.py:143-164`: constructor writes run.json before acquiring any lease. Creating a second Operator with explicit overrides changes the active owner's frozen config. | Read-only construction/status; acquire ownership before mutation; reject changed run identity/config/source on resume or require a new run. Active owner's bytes must remain unchanged. |
| WEB-AI-02b | HIGH recovery/concurrency; R22 | `champion_cycle.py:204-208`: check-then-write lease acquisition is not atomic. A barrier between both holder reads deterministically lets two operators report ACQUIRED. | Atomic lock acquisition with owner nonce/fencing, safe expiry/reclamation and ownership-checked renew/release. Demonstrate one winner using separate processes too. |
| WEB-AI-03 | HIGH provenance/recovery; R22 | `champion_cycle.py:277-279`: completed stages are skipped solely when outputs exist. Modify an output after its hash was recorded; resume returns normally and silently reuses the tampered artifact. | Verify every output's size/hash and frozen source/config on resume. Refuse or explicitly invalidate/rebuild downstream stages; never preserve a false completion. |
| WEB-AI-04 | HIGH learning-loop implementation; R22/R24 | `generate.cjs:46-48`: neuralEngine makes analysis=null, followed by analysis.move. The neural feedback probe throws TypeError before the injected engine is called. CLI also does not wire the producer. | Wire a real approved-research champion/PUCT producer and its policy/visit targets, keeping behavior policy separate; avoid null analysis; bind producer hash/version. Prove two cycles where cycle 2 consumes cycle 1's chosen research artifact. |

These defects affect the **research operator**, not proof of a currently published unsafe app model. No public model was approved or released by this audit. The independent gate helper always returns `productionApproved: false`.

## Additional source-review defects and unproven claims

### WEB-AI-05 - incomplete benchmark receipts (HIGH for qualification)

`training/bot/neural_league.cjs:417-450` retains only the first ten games in the final report and removes worker shards; the final report does not bind complete paired opening-family records to source/model hashes. `summarize` combines both engines' move latencies. That is insufficient for independent replay, paired-family resampling or candidate-only device latency.

Main: retain all games and opening-family IDs, seeds, both seating assignments, source/rules/model/runtime hashes, budgets, per-engine timings, inference/fallback diagnostics and canonical terminal traces. The new verifier deliberately refuses truncated old reports. Green process exit means league execution, not candidate qualification. The >=200 independent-family protocol in BENCHMARKS.md must be honored; 24-family/48-game experiments are diagnostics, not promotion evidence. Use an untouched confirmation set after model selection, rather than repeatedly tuning against the same final seeds.

### WEB-AI-06 - teacher evaluation leakage and provenance (HIGH for research conclusions)

`training/bot/unsloth_teacher.py:104,140,148-160` pools validation and holdout for evaluation, then calibrates on that pooled set before reporting decisions. Holdout therefore is not untouched confirmation. Per-question denominators advance only for returned question names, so missing answers can disappear from accuracy denominators. `:82` hardcodes an Apache license while `--model` can vary; the loaded model revision is not pinned/verified in the receipt.

Main: split train/calibration/confirmation by full canonical family; calibrate only on validation; freeze before holdout; score missing/invalid responses as failures; record exact model revision and verified license. Report each question, decision validity and a matched game league, not a binary-question-dominated aggregate. Preserve failed experiment evidence; do not distill a teacher without demonstrated utility.

### WEB-AI-07 - stronger-label provenance and budget mismatch (MEDIUM/HIGH for experiments)

`generate.cjs:54-59` calls legacy `G.choose`, with both branches of its teacher selector equal to Expert; it does not select the newer `src/bot/search.js` Expert. Conversely `decision-dataset.cjs:49-50,70` really uses the newer `S.choose` for gold decisions, not the weak UCT labels. Its exposed build budget (`:103,132,138`) is not passed through `buildRow` to `teacherMove`, which stays at its default. The documented option-invariance check at `:81-84` reuses the same deterministic shuffle; it is not a model invariance test across independently permuted options.

Main: bind labels to the actually selected engine/version/budget; thread and assert the requested budget; add independently permuted option-order evaluation. The current claim that the decision teacher's failure is caused by inheriting weak UCT labels contradicts its implementation. A small failed study does not establish that additional search depth is the only remaining path, or a general ceiling on learning. Keep those as hypotheses and run controlled ablations.

### WEB-AI-08 - operator recovery acceptance remains incomplete (HIGH for R22)

Further source observations: lease renewal follows stdout-volume rather than a wall-clock heartbeat, so a quiet long stage can outlive the lease; explicit overrides and source changes are not reconciled against frozen outputs; STOP is checked between stages and is not cleared by resume; CPU is hard-coded into generated train argv. The test titled `a bounded real cycle completes and a killed cycle resumes` in `tests/bot/learning-operator.test.cjs:97` does not itself kill and resume a worker. Main's separately reported manual kill/resume run may be useful evidence, but the CI test name is not that evidence.

Closure: real two-cycle feedback; kill during generation/training/validation/promotion; quiet-stage lease test; two-process contention; stale-worker fencing; tampered-output refusal; bounded stop/restart; exact frozen config/source/model lineage; rejected candidate leaves approved catalog unchanged. Avoid scaling expensive training before these invariants are stable.

### WEB-DOC-01 - owner register loses contracts (HIGH audit integrity)

`OPEN-WORK-AND-OWNERS.md:21-46` has twelve rows with more than eleven columns, duplicate R24/R25, and absent R26/R28. R02 also has repair prose inside its Original IDs cell. Original R26 is useful-teacher distillation; original R28 is actual model qualification/distribution. Both exact contracts were recovered from `99353a6bcf65bcd9039114bdeece4530af1fe3fa`.

`python3 scripts/v51-readiness-register.py --output-dir .artifacts/register-repair` produces a full proposed file, unified patch and source/proposed hashes. Six tests verify complete IDs, preservation, schema, idempotency and fail-closed handling of unfamiliar corruption. It preserves the duplicated source notes verbatim and every later ledger table. It **does not modify the shared register**. Main should review/serialize its application:

```sh
python3 scripts/v51-readiness-register.py --output-dir .artifacts/register-repair
sha256sum docs/v5.1/release/OPEN-WORK-AND-OWNERS.md
# Compare against manifest.json, review repair.patch and any newer owner edits.
git apply --check .artifacts/register-repair/repair.patch
git apply .artifacts/register-repair/repair.patch
python3 scripts/v51-readiness-audit.py --strict --output .artifacts/readiness/inventory.json
```

The prepared baseline has source SHA256 `bb9a688a282592edba15b80dee0113460f62f8c2341f64a1b6e71c578ff7c500`. Regenerate/review rather than applying stale hunks over active owner work. This structural repair does not close any acceptance case.

## Execution order and lane separation

Main should first consume these independent probes, fix WEB-AI-01 through 04 in small commits, rerun both original suites and the new negative contracts, then integrate complete league receipts and the independent verifier. Address 05-08 before accepting research results or claiming R22 complete. The independent verifier is presently **implemented/tested but not wired into the operator**; wiring and final policy agreement belong to Main. Keep approved deployment selection closed throughout.

In parallel, Main continues R03-R09/R11/R19-R20 and operational acceptance; Codex continues R10/R12-R18/P21/provider/browser work. Human retains novice studies, physical-phone feedback, exact launch scope/build/cutover and formal cost/identity decisions. None of these audit findings authorizes gameplay/economy/theme changes, paid provisioning, publication or live cutover.
