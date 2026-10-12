# Main fixes for the independently reproduced WebUI safety defects (WEB-AI-01 - 04)

Owner: Main. Source: `docs/v5.1/release/WEBUI-DEFECTS-20261012.md`. Verification:
`python3 scripts/v51-readiness-probes.py` (exit 0, all seven probes `NEGATIVE_CONTRACT_PASSED`).

## WEB-AI-01a/b/c - promotion safety (fail-closed gate)

`training/bot/champion_cycle.py::evaluate_gate` no longer selects "the first matchup" and no longer
promotes on a bare interval. It now:

- requires EXACTLY ONE `policyValuePUCT` vs `improvedExpert` matchup (absent/duplicate/unrelated refused);
- requires a valid 64-hex candidate model SHA and 40-hex source SHA binding;
- delegates the numeric verdict to the INDEPENDENT verifier already in the repo
  (`scripts/v51-readiness-model-gate.py::evaluate`), which recomputes the point score and paired-family
  bootstrap from the raw game records, rejects reversed/non-finite/bool statistics, requires exactly
  reversed pairs per opening family, and enforces BOTH the 0.70 point target and the 0.65 lower-CI
  target on >= 200 independent families;
- `productionApproved` is always false.

WEB-AI-01a probe: a `random` vs `beginner` result now returns `promote:false`. 01b: the 0.69/[0.66,0.8]
case is refused (no bound records). 01c: the reversed interval is refused.

## WEB-AI-02a - constructor no longer mutates another active run

`Operator.__init__` performed `self.state["config"] = ...; self._write_state()`. It is now READ-ONLY
with respect to the shared run files: it computes the effective config in memory, refuses a frozen run
whose explicit overrides disagree (`CONFIG_FROZEN:...`), and only persists inside an owned transition
(`_acquire_lease` -> `_commit_pending_config`). Probe: the active owner's `run.json` bytes are unchanged.

## WEB-AI-02b - atomic lease acquisition

Replaced the check-then-write race with `os.open(O_CREAT|O_EXCL)` as the mutual-exclusion primitive,
plus an owner nonce, ownership-checked renew/release (fencing), and stale-lease reclamation only when
the holder pid is provably dead or the TTL lapsed. Probe: exactly one of two contenders reports
`ACQUIRED` (the other `REFUSED`).

## WEB-AI-03 - resume verifies frozen output hashes

A completed stage is skipped only when every recorded output still matches its recorded size and
SHA-256 (`_stage_outputs_intact`); a missing/altered/never-recorded output invalidates the stage and
forces a rebuild. Probe: a tampered output is no longer silently reused.

## WEB-AI-04 - neural feedback wired, null dereference removed

`training/bot/generate.cjs` set `analysis = null` for any `neuralEngine` and then dereferenced
`analysis.move`, throwing before the injected engine ran. The producer is now invoked directly
(`neuralProducer`), a non-move result is a hard error, and a real async producer is supported via the
new `gameAsync`/`generateAsync` (shared `finishMove`, identical RNG order). The sync path is
byte-identical for every tested seed. Probe: the injected engine now throws its own sentinel
(`PROBE_STOP_AFTER_FEEDBACK_ACCEPTED`), i.e. it is reached.

## WEB-AI-08 (partial, in this unit)

- lease heartbeat moved from stdout volume to a wall-clock daemon thread, so a quiet long stage cannot
  lapse its lease;
- `resume` explicitly clears a prior STOP;
- CPU is still hard-coded in the train argv (tracked in the work queue, not a safety defect).

## Not yet closed (tracked, not claimed)

League receipts (05), teacher-eval leakage (06), stronger-label provenance/budget (07) and the remaining
08 items plus the two-cycle feedback PROOF are the next queue items. The gate stays `productionApproved:
false`; `APPROVED_CATALOG` remains untouched.

## WEB-AI-05 - complete league receipts (`training/bot/neural_league.cjs`)

The final report truncated to `games.slice(0, 10)` and dropped worker shards, so it could not be
independently replayed. Now every game is retained with its `openingFamily`, both seating seeds,
`aVersion`/`bVersion`, the canonical terminal move trace (`moves`), and per-engine latency kept
SEPARATE (never summed). The report binds `modelSha256`, `sourceSha`, `rulesSha256`, engine versions,
budgets and the full `holdoutFamilies` list (no 10-item sample).

Proof: a 200-family run (`--matchup policyValuePUCT:improvedExpert`, 400 games) produced a complete
receipt; the independent verifier accepted its structure and returned
`independentFamilies: 200, reasons: [POINT_TARGET_NOT_MET, CONFIDENCE_TARGET_NOT_MET]` for the current
unqualified model (0.015). A 4-family run returns `INSUFFICIENT_INDEPENDENT_FAMILIES`. The verifier
refuses truncated/unbound reports. `scripts/v51-readiness-model-gate.py` remains a SEPARATE approval
gate; green process exit is not qualification.

## WEB-AI-06 - teacher evaluation leakage (`training/bot/unsloth_teacher.py`)

Evaluation pooled validation+holdout and calibrated on that pool, so the holdout was not untouched.
Now `split_evaluation` gives train / calibration (validation ONLY) / confirmation (the frozen holdout,
never calibrated on); `score_answers` scores ONCE on the confirmation families, counts a missing or
invalid answer as a FAILURE, and keeps every independent family as a denominator with per-question and
family detail (the binary-question aggregate can no longer hide the choice accuracy). The model
revision is pinned via `--model-revision` and loaded with `revision=`; the license is READ from the
model card (not hardcoded) and an unpinned revision is flagged. Tests:
`tests/v51-readiness-teacher-leakage.test.py` (3/3).

## WEB-AI-07 - label provenance and budget threading (`training/bot/decision-dataset.cjs`)

`--budget-ms` never reached `teacherMove` (it stayed at the 20 ms default); the receipts now record the
actual `budgetMs` per row (`gold.bestMove.budgetMs`). The "invariance" check re-derived the same
deterministic shuffle and compared it to itself - a tautology - and is replaced with a real
INDEPENDENT-seed option-order permutation whose gold move id must be present and identical as a set.
Proof: budget 20 vs 400 recorded distinctly; permutation invariance true; `tests/bot/training-data.test.cjs`
6/6.

## Not yet closed

WEB-AI-08 two-cycle feedback PROOF and the remaining 08 items; WEB-DOC-01 register repair (R26/R28);
WebUI re-verification handoff. The gate stays `productionApproved: false`; `APPROVED_CATALOG` untouched.
