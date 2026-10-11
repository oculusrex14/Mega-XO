# V5.1 bot intelligence and guided tutorial handoff

> **2026-10-11 updated owner handoff:** Read [P21 verification, cross-client integration obligations, dual-DGX assignment and main-agent prompt](P21-VERIFICATION-AND-MAIN-AGENT-HANDOFF.md) first. This earlier handoff is an immutable implementation checkpoint, **not** the newest V5.1 tree. At audit, V5.1 had advanced to `9c651cc` with four newer P21 commits; the tutorial/bot branch diverged and must be reconciled without overwriting the independently owned P21 website/SEO work. Main agent now owns safe remaining B01–B07 code, dual-DGX training, model benchmarking and real-device/staging acceptance. A dedicated website controller still needs the guided lesson and Worker integration. Production, official rewards, cutover and P21 site release remain separately gated.

## Boundary and current product state

Feature branch: `feat/v5.1-bot-ai-tutorial`. Base and rechecked V5.1 head:
`f8913fd36566f0c96d0b755b1e4e57be1795a266`. No main merge, deployment, V5
cutover, production database operation or live V4 change was performed.
All 82 approved tasks remain explicit in IMPLEMENTATION.md/progress.json.
A partial task is not checked merely because one component was implemented.

The six-move guided tutorial is integrated into the real practice match. It
teaches Mini versus Mega wins, routing, a claimed Mini Board and free choice,
then hands the same state to the original Beginner. Instructions pause clocks
and bot scheduling; skip, hints, replay, explicit restart and versioned resume
are included. Four original themes and the first five bot reward amounts/caps
are preserved. Physical narration, assistive technology and user comprehension
are not established by browser automation.

The new search is experimental, NOT the default. Set `mega_v51_search` to
`experimental` in localStorage for new non-practice matches to evaluate it.
Per-match engine and seed remain pinned across reloads. Original decisions
remain the default, moved into a cancellable Worker with canonical legality and
match/revision fencing. Unsupported Workers have an explicit standard-bot
recovery path. See ROLLBACK.md before changing rollout.

The setup screen accurately says no approved Impossible model is available.
It does not download automatically, add an undefined reward tier or pretend
Expert is Impossible. Optional-pack consent/integrity/cache/removal and a
separate unverified-result contract are implemented. A full playable Impossible
match lifecycle, approved model catalog, production inference-library delivery
and separate local statistics UI are NOT complete. Those are remaining
engineering, not merely external-access blockers.

## Measured results, not promotion claims

The current measured set is recorded in [BENCHMARKS.md](BENCHMARKS.md) and
[evidence/dgx-experiments-20261012.json](evidence/dgx-experiments-20261012.json).
The table below is the earlier checkpoint's numbers; the newer independent-family
runs supersede the two league rows.

| Measurement | Observed result | Limitation |
| --- | --- | --- |
| Improved Expert versus legacy Expert (current) | 128 held-out D4 families, 256 games, 167 W / 54 D / 35 L, 75.78% points, CI [0.7129, 0.8008] | One Node runtime/host; cross-device remains open |
| Adjacent tiers, 105 independent families (current) | Easy>Beginner 0.9690, Medium>Easy 0.9643, Hard>Medium 0.8905, Expert>Hard 0.5833; all strictly monotonic, intervals exclude parity | One runtime; not a device matrix |
| Policy/value CNN vs improved Expert (DGX) | 0.0071 (CI [0, 0.019]); policy-only 0.0310; INT8 vs float CI contains 0.5 | All neural candidates REJECTED; catalog stays empty |
| Compact CNN | 342,282 parameters (w64b4) | CPU/GPU research candidate, not an approved Impossible champion |
| Float ONNX | 1,375,959 raw / 1,272,393 gzip bytes | Model only, excluding the separate 11.9 MB ORT WASM runtime |
| INT8 candidate | 380,957 raw / 327,182 gzip bytes; 17/512 legal top actions differ | Match-strength regression measured as no detected difference, not parity |
| Actual WASM golden inference | 512 states, zero illegal probabilities; p50 4.0 ms / p95 7.5 ms; real Chromium neural Worker turns 31-46 ms on WebGPU | CI/desktop, not phone performance |
| Separate baseline ORT WASM binary | 11,905,541 bytes | Runtime slimming and device memory remain open |

The rows marked (current) come from the 2026-10-12 dual-DGX runs recorded in
BENCHMARKS.md; the neural rows are pinned to those reports' candidates, not mixed
with older checkpoints. The rejected research champion is `candidate-dgx1-w64b4`
(`ac9cc0ecdcf9a5b47fe002c7ff4f71c9bc9ffb9c7a0a0d645648121ac5959f70`), retained for
offline work only. Tiny training samples demonstrate plumbing, and the measured
ablations show no neural candidate approaches the Impossible gate; no claim that a
small file, low loss or deeper search meets Impossible strength is justified.

## Verified CI and release matrix

At source `7a5e10710da92c6415b6f1e11e07b93a2c8aaa9a`:

| Evidence | Result |
| --- | --- |
| Ordinary Node 24 run 38090919154 | 1,211 tests: 922 passed, 0 failed, 289 service-gated skips |
| HTTP Chromium 154.0.8037.0 | Four-theme tutorial/reload, root/P21 Worker cancel/resume, pack controls and existing accessibility pass |
| Neural run 38090919163 | CPU model/export, actual WASM golden inference and warm Worker/PUCT lifecycle pass |
| Dedicated service run 38090919247 | All three previously skipped recovery/chaos/load tests pass; zero skips |
| Prior extended run 38088997400 | 651 passed, 0 failed; its three dedicated skips are covered above |
| Firefox 144.0.2 / Linux WebKit 26.0 | Four-theme HTTP tutorial and reload pass at 2043ceb |
| Android API 35 emulator | Build, unit tests, bundle and existing gameplay smoke pass at 2043ceb |
| iOS simulator | Unsigned build, bundle and first launch pass at 2043ceb |
| Physical phones/Safari, VoiceOver/TalkBack, thermal/battery | NOT RUN |
| Moderated first-time-user study | NOT RUN; 80% unprompted routing target unmeasured |

Do not add overlapping suite counts. Totals are specific to a commit; existing
tests enumerate workflow inputs, so deleting one-time integration workflows
changes counts. Source comparison found no lost application/tests. The newer
replay/focus and simulated-hidden UI checks are an additive final checkpoint;
their CI reference is recorded separately in progress.json.

All service disruption used disposable CI loopback services, including separate
PostgreSQL source/restore containers. It was not a staging or production test.
One-time write-enabled integration workflows have been removed. Remaining
validation workflows are read-only and do not deploy.

## Remaining engineering and external gates

Complete dedicated fork/sacrifice tactical fixtures, broader frozen baselines,
independent-opening promotion leagues, and Expert/Hard tuning before enabling
the new ladder. Finish the full Impossible product lifecycle and local records
UI, publish an approved model only after strength gates, and package a measured
small runtime without weakening native network/authority boundaries. Compare
policy-only versus policy/value PUCT and quantify INT8 match-score regression.

DGX training/champion cycles, optional Unsloth teacher/distillation, physical
reference-device performance, process-death/rotation/background reliability,
real narration/screen-reader acceptance and fresh-user comprehension require
resources not connected in this run. Model/runtime static publication requires
P21 coordination and explicit release authorization. Verified rewarded online
Impossible is deferred, not commissioned; no Oracle AI worker or always-on GPU
was introduced.

## Integration, inventory and licenses

Exactly six existing baseline files were modified: src/app.js, src/domain.js,
index.html, native/client/bundle.config.json, scripts/p21/build-web.js and
tests/production-runtime.test.js. The last change is a test-only outbox race
fix, not server business logic. All other retained changes are additive code,
tests, documentation and validation. See evidence/change-inventory.json.

The canonical src/game.js, original src/styles.css, P21 website routes/assets,
legal/account pages and native permission declarations remain unchanged.
Website build edits only include retained-game assets. New code is under
src/bot, src/tutorial, training/bot, tests/bot, scripts/v51 and feature docs/CI.
The inventory freezes the code checkpoint; final test/docs/evidence updates are
separate reviewable commits. Re-fetch V5.1 immediately before any owner merge;
resolve concurrent shared-file changes rather than copying whole old files.

No pretrained weights or third-party datasets were imported. Generated weights,
raw self-play and inference vendor binaries are excluded from Git and the user
handoff. Exact dependency/runtime notices and distribution licenses still need
review; do not infer a repository license grant from an absent root LICENSE.
See training/bot/README.md for commands, source references and reproducibility
limits. See ROLLBACK.md for recovery and progress.json for exact task IDs.
