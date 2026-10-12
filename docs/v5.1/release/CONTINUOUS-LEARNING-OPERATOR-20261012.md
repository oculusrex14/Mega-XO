# Continuous-learning operator - status and executed evidence (CL06/CL07/CL12/CL16/CL17)

Main agent, 2026-10-12. This records what was IMPLEMENTED and EXECUTED, separate from what remains
gated. Nothing here is a strength claim or a publication.

## What was built

`training/bot/champion_cycle.py` is now a real state-machine operator, replacing the previous manifest
writer (which only wrote `cycle-manifest.json`). It runs the actual pipeline stages as subprocesses.

- **Lifecycle**: `CREATED -> GENERATING -> DATA_VALIDATED -> TRAINING -> EXPORT_VALIDATED ->
  EVALUATING -> REJECTED | RESEARCH_APPROVED`, with `FAILED_RETRYABLE`, `FAILED_PERMANENT` and
  `PAUSED` as explicit states carrying the failing stage and its context (`CL06`).
- **Configuration is validated before any stage runs**; bounds/choices are rejected up front with a
  named key (`CONFIG_INVALID:<key>`) (`CL06`).
- **Exclusive lease** with heartbeat/expiry prevents two operators on one run; durable atomic state
  writes; each stage is idempotent on its own outputs so a retry never overwrites a completed output
  (`CL06`).
- **Subprocesses are argument arrays** (no shell strings); stdout+stderr are captured to a bounded
  per-stage log; a missing tool/import/download is `FAILED_RETRYABLE` (environment) while a
  bad-data/non-finite result is `FAILED_PERMANENT` (`CL06`).
- **Provenance is measured from the actual tree** - the checked-out Git SHA plus real file hashes and
  the dirty-file set - not a caller-supplied 40-character argument (`CL06`).
- **Artifact registry**: content-addressed (sha256) stage outputs, atomic writes, parent lineage and
  source/environment metadata; the research champion pointer is updated with compare-and-swap and can
  **never** set the shipped catalog's APPROVED state (`CL07`, `CL16`).
- **Checkpoint/resume** (`CL12`, in `training/bot/train.py`): an interim checkpoint (model +
  optimizer + RNG + epoch + dataset hash + config) is written atomically after every epoch; a
  `--resume` restores the model/optimizer/RNG and continues **from the recorded epoch**, refusing a
  dataset or config mismatch. A resume reuses the run's frozen configuration, so a killed run never
  drifts onto different hyperparameters.
- **Promotion gate** matches the league's own declared threshold ("lower 95% CI >= 0.65"); a rejected
  candidate is archived, never made downloadable as approved (`CL16`).

## Executed evidence (real runs, local Apple-silicon; GPU/DGX remains gated)

The training stack used the CPU path (device `cpu`); this is bootstrap/diagnostic evidence, not a
strength result.

- **Two completed cycles** (`CL17`): `c1` (games 20, epochs 3, seed 7001) and `c2` (games 20, epochs 3,
  seed 7002). Both reached all five stages `complete` and the terminal decision `REJECTED`; champion
  `PRESERVED_UNAPPROVED`; `promotionApproved=false`. Distinct exported candidates
  (`c1` `20ded3b2...`, `c2` `ece9ccf7...`) confirm distinct data lineage.
- **One interrupted/resumed cycle** (`CL17`): a run with `epochs=400` was SIGTERM'd mid-`TRAINING`
  (status `PAUSED`, stage `TRAINING`), then `resume` completed it from the last interim checkpoint
  (`resumedFromEpoch: 3`) using the persisted `epochs=400` (397 epochs remained), reaching all five
  stages `complete` and `REJECTED`.
- **Test** `tests/bot/learning-operator.test.cjs`: 4 pass (config bounds, gate threshold + weak
  rejection, plan argv arrays, honest fresh status) + 1 gated integration test that skips with the
  reason `set V5_LEARNING_OPERATOR_PREREQS=1`.

The gate for every cycle reads the **improvedExpert** reference matchup; the untrained bootstrap
candidate scores 0 (lower CI 0 < 0.65), so nothing is promoted. A trained candidate that legitimately
clears the gate would flip `REJECTED` to `RESEARCH_APPROVED`, still without touching the shipped
catalog.

## What remains gated (not claimed)

- **CL13/CL15**: measured architecture/budget sweeps and the independent strength league on the
  intended DGX compute. `dgx2-ts` is currently offline (Tailscale: last seen 13h ago); `dgx-ts` is up
  but has only unrelated venvs (no torch in the base env, no mega checkout, ComfyUI/TTS venvs left
  untouched). A CUDA environment must be created on the Spark before GPU training/league runs.
- **CL16 promotion**: requires the trained candidate to clear the frozen gate; no candidate is
  promoted or published.
- **CL18-CL23** (Unsloth teacher/distillation): separate environment, not started.
- **CL26/CL27** (physical device matrix / tutorial usability): human/physical-device gates.
- **CL28/CL29** (release approval, staged publication): owner authority.

The public `APPROVED_CATALOG` stays empty and `mega_v51_search` stays `legacy`; the operator cannot
and does not change either.

## R27 quantization measurement (INT8 vs float)

A real INT8-vs-float league (the `int8PUCT:policyValuePUCT` matchup, 24 independent D4 holdout
families, 48 games, 20 ms/16 simulations) measured **point score 0.5417, paired-bootstrap 95% CI
[0.4375, 0.6458]**. Interpretation, stated conservatively: **no regression was detected** (the point
score is near 0.5), but because the interval contains 0.5 it does **not** establish INT8 equivalence
or non-inferiority at this sample - a larger paired league is required. The export-time numerical
gates remain: float parity is exact (`floatLegalArgmaxChanges: 0`, max abs error ~4e-7) while INT8 QDQ
changes 13/512 legal argmaxes, which is why the match-level measure is the one that matters.
