# Mega XOXO V5.1 - main-agent execution and continuous-learning plan

**Issued:** 12 October 2026. **Repository:** oculusrex14/Mega-XO. **Integration trunk:** V5.1. **Owner:** main agent in oh-my-pi, with SSH/CLI access to the two DGX Sparks and VPS. **Companion:** OPEN-WORK-AND-OWNERS.md / OPEN-WORK-REGISTER.json / V51-READINESS-AND-OWNERS.xlsx.

This is the next execution contract, not a claim that the listed work is already complete. The owner's October 12 consolidation and website instructions supersede historical instructions to resume V5-platform or defer P21. Preserve the original implementation packs as historical specifications. Never infer production permission from a branch merge.

## 1. Mission and non-negotiable boundaries

Finish the integrated V5.1 product, turn incomplete acceptance into exact-source evidence, and implement a real, bounded continuous-learning system. The two AI research approaches are (A) a compact game-specific policy/value network with tactical search and (B) an Unsloth-trained Qwen3.5-0.8B legal-option decision model, evaluated offline as a teacher and possible source of distillation. The improved classical five-tier bot ladder remains a separate measured baseline and fallback, not a neural-strength claim.

Keep only the remote branches V5.1, main and V4.1. All development integrates on V5.1; no main merge, production deployment, DNS authority switch, paid upgrade or live player-data migration without the appropriate explicit owner decision. Preserve existing local uncommitted work and local-only branches before pruning remote tracking refs. Remote branch deletion did not inspect or erase another agent's working tree. Use local detached worktrees/patches for parallel slices, not new long-lived remote trunks. The main agent serializes integration, checks the remote head before every push, and never force-pushes for tidiness.

Canonical game legality and transitions remain src/game.js G.legal/G.apply. Retain the four native/retained-client themes vector, midnight, paperclub, afterhours. Browser-only Mega XOXO Neon/cinematic remains the fifth browser default; paid native Neon is a separately specified future product. Do not change rules, Crown utility, first-five BOT_PAY values 1/1/2/4/6, daily caps, Elo, rank/season/tournament policy or matchmaking TTL to make a test pass. Tutorial and local Impossible are unpaid/unverified: no official Coin/Crown rewards, verified Elo or official leaderboard placement. Do not silently label Expert fallback as Impossible.

The last recorded production authority is V4.1.2/SQLite. Reconfirm it read-only; do not assume it changed because platform phases were marked COMPLETE. After the first V5 production application write, including auth/jobs/webhooks, a return to a stale SQLite writer is not an acceptable rollback. Preserve PostgreSQL authority and use a compatible prior build or a separately rehearsed recovery.

## 2. What has already been integrated

V5.1 includes the V5 platform, P21 website, bot/tutorial branch and independent audit PR11. Consolidation merge: 02452da428dd93eea5a66f91ffb1a71d5a543e1f. All three retired tips are ancestors of V5.1. Cleanup run 38210889855 verified and atomically deleted V5-platform, feat/v5.1-bot-ai-tutorial and fix/v51-independent-audit-20261012 while preserving main 66b19db3451f5eb1af824110556aa4ab6fae138a and V4.1 455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2. No deployment was performed.

Six feature-specific workflows were retargeted to V5.1, including PR checks. The one-time write-enabled cleanup workflow was removed in faef1da871b523cf3843c20a2b2b6bce4ad3dc93. Website workflow support was expanded in 88907f8b6f90cf06acfd45b5bd694d4e963ab188. Consult the final consolidation report for observed CI outcomes; do not copy an in-progress run as a PASS.

The integrated audit includes bounded signed ingress, HMAC time handling, APPROVED-only model selection, tutorial difficulty locks, public leaderboard filtering/decimal/privacy fixes, and API-role-only ticket issuance. Preserve these fixes. Standalone apps/game-core/ingress-server.js exists; its production deployment is not thereby complete.

## 3. Evidence model and first checkpoint

**Immediate CI work:** read `docs/v5.1/release/CI-CHECKPOINT-20261012.md`. Five fresh workflows passed, but the retained broad service artifact contains 722 pass / 2 fail / 3 skip. Repair the P08 reused-actor fixture and the P11 real signed-gateway test composition, then rerun the complete suites. Do not weaken production guards. Current documentation checkpoint: `baa9c63cd695848e271eb242bd901ba4b7ff5dca`.

Read docs/v5/{progress.json,TODO.md,OPEN-ITEMS.md,PROGRESS.md}, docs/v5.1/bot-ai/{progress.json,IMPLEMENTATION.md,BENCHMARKS.md,AUDIT-FIXES-20261012.md}, docs/p21-web/MASTER-CHECKLIST.md, the original phase/acceptance contracts and this handoff. The source snapshot underlying the inventory is 4f68720d25fe951d003df75f60c75862b4b1fee8; refresh before implementation.

Current source-ledger counts are 104 COMPLETE/4 IMPLEMENTED/9 PLANNED across 117 original tasks; 2 PASS/38 NOT_RUN across 40 acceptance cases; 49 DONE/24 PARTIAL/7 BLOCKED/2 DEFERRED across 82 bot tasks; 70 checked/160 unchecked across 230 website items. These are overlapping layers of evidence, not additive independent tickets and not an 89% production readiness score. Historical P20 and P18 COMPLETE labels do not establish signed-device/store or full end-to-end acceptance. A manual rejected model cycle is valid experiment evidence but does not implement an executing scheduler.

For every unit record task IDs, clean source SHA, relevant file hashes, test command, exact environment, device/OS where applicable, result, skipped conditions, evidence path and rollback. Distinguish IMPLEMENTED, TESTED_LOCAL, TESTED_CI, STAGING_VERIFIED, DEVICE_VERIFIED, SUBMITTED, APPROVED and LIVE. Never turn an unobserved provider or physical-device step green. Reconcile stale statements without deleting historical evidence. A04/A05 are already recorded PASS; preserve those records and rerun when affected.

First checkpoint: clean V5.1 inventory; preserved user work; final Actions status; current sole-writer evidence; current provider/project/signing/device inventory; corrected owner task register; no side effects on production. Commit the evidence and resolved instruction precedence as a small documentation milestone.

## 4. Execution order and parallel lanes

| Stage | Main-agent execution | Parallel owner work | Exit gate |
|---|---|---|---|
| S0 | R01-R03: source/evidence/CI and read-only production inventory | ChatGPT audits statuses; Codex inspects existing provider access | One integration SHA and one known production authority; no stale task claims |
| S1 | R04-R09: actual isolated API/Core/worker deployment, colocated online smoke, privacy, migrations/restore/load/alerts | Codex R10 and website R15; human approves actual hosting/cost choices | Full real staging journey including final offer acceptance and recovery |
| S2 | R11,R19,R20: signed native integration, classical bot ladder and device instrumentation | Codex R12-R18 accounts, stores, website; human R14/R17/R21 decisions and devices | Actual clients/services, provider states, visual/accessibility and tutorial evidence |
| S3 | CL00-CL17: diagnose weak neural results and implement the real approach-A loop | ChatGPT independent protocol/code review | Executed reproducible cycles, unbiased rejected/promoted research decisions |
| S4 | CL18-CL23: approach-B decision teacher and conditional distillation | ChatGPT reviews fairness/utility and source licenses | Actual teacher comparison; useful teacher distilled or explicitly rejected |
| S5 | CL24-CL29: quantization, package/runtime, reference devices, gated release candidate | Codex immutable assets and UI; human exact-build approval | Strong, small, responsive candidate approved separately from research |
| S6 | R29-R30: approved production window and single-writer authority transfer | Human go/no-go; Codex website/provider release coordination | Exact first-write boundary, healthy shared-client production and recovery |
| S7 | R31-R32,CL30-CL31: runtime retirement, observed scaling and bounded learning operations | Human feedback/decision review | Safe operation, no automatic unreviewed model swaps |

Do not unnecessarily serialize independent website/native/provider work behind long training. Do not let teacher research block approach A. Conversely, do not claim the full commissioned Impossible experience is ready without a model. The human decides whether a separately scoped earlier release may leave Impossible unavailable; this plan does not silently remove it.

## 5. Resolve the actual platform and native blockers

### 5.1 Signed, least-privilege service composition

Run the API with api_runtime and only its authorized ticket-issuance capability. Run Core with core_runtime and ticket redemption. Keep worker/migration/backup roles separate. Core economic writes remain authoritative; never grant API broad economy SELECT/UPDATE or place Core SQL credentials into API to bypass failed routes. Use the signed, bounded private HTTP ingress and correct TLS/reverse-proxy/process-manager configuration. Recheck forged actor/session headers, HMAC tampering/expiry/replay, oversized/chunked requests, body deadlines and cross-service tracing without logging tokens.

Exercise public leaderboard metric/scope/region/tier filters using actual JSON-string region values, hidden profiles and wealth opt-out. Privacy eligibility filters must run before LIMIT; retain exact Elo/wealth behavior. Cache keys and invalidation must distinguish the authorized result. Core unavailable must produce an honest error, not a misleading empty HTTP 200.

### 5.2 Staging flow 12: solve latency rather than changing the game

The retained record says flows 1-11 passed against actual Neon/Upstash, then OFFER_EXPIRED occurred at offer->accept. Remote database round trips around 0.7 seconds per statement, with guarded transactions, produced multi-second operations. The offer TTL is 15 seconds. Run the composed smoke from infrastructure near the staging DB, measure connect/pool/transaction/query durations and diagnose connection reuse or redundant work. Do not extend TTL, remove role checks, skip consent or return a fabricated acceptance. Prove both clients reach PLAYING, accept real moves, reconnect, settle and logout. Include two-Core failover and client polling fallback. Record actual target region and evidence, not a guessed location fix.

### 5.3 Native and provider acceptance

Current debug/emulator and unsigned simulator hosts explicitly preserve an offline permission boundary. Audit production target/flavor selection before adding network, OAuth, commerce or ad SDKs. A build without INTERNET cannot prove Android online sessions; a green offline-host build is still useful but not sufficient. Implement missing approved online paths in the appropriate target; retain strict bridge origin/allowlist, secure host credential storage, process-death handling and source-bundle integrity. Validate actual Google/Apple login and account linking against the same actor as the website.

Main agent owns CLI builds, signing integration, association files, staged APIs and upload tooling. Codex owns browser-console records, provider setup, store metadata, test tracks, reviewer instructions, disclosure forms and account configuration. The user has authorized those account operations. Human handles MFA/identity checks, credentials not accessible to agents, formal attestations, fees, pricing/availability and final launch approval. Do not create duplicate business accounts when an existing account is appropriate. Record precise upload/testing/submission/review/live states.

For purchases and ads, exercise real sandbox receipts, retry/refund/restore/consumption, permanent actor bindings and SSV. Never grant currency because a client says payment succeeded. Never remint consumable grants on restore. Keep bought and earned Crowns' approved utility unchanged.

## 6. Current AI evidence: the starting point is not a strong neural bot

The improved classical Expert scored 167 wins / 54 draws / 35 losses across 256 games from 128 paired holdout families: 75.78% points, paired bootstrap 95% interval approximately 71.29%-80.08%, using scaled 20 ms budgets on one Node host. Adjacent-tier ordering also passed on 105 families. This supports continued development, not a cross-device/full-budget release claim. The scripted exploit corpus and phone calibration remain open.

The compact 342,282-parameter candidate fits a small model file, but policy/value PUCT scored 1 win / 1 draw / 208 losses against improved Expert in 210 games: 0.71% points. Policy-only scored 2 wins / 9 draws / 199 losses: 3.10%. Subsequent candidates also failed. All remain unapproved. INT8 versus float had a confidence interval spanning equal performance; this is not a proof of equivalence or an acceptable-loss bound.

The measured float ONNX was 1,375,959 raw bytes and 1,272,393 gzip bytes; INT8 was 380,957 raw and 327,182 gzip. These exclude the 11,905,541-byte WASM runtime, optional 23,824,254-byte JSEP runtime and other JS/worker/licenses. Desktop golden inference/Worker measurements are not phone battery/thermal evidence. Use the exact artifact manifests in docs/v5.1/bot-ai/evidence/dgx-experiments-20261012.json and BENCHMARKS.md; do not add approximate sizes together as a measured total pack.

Important engineering gap: training/bot/champion_cycle.py currently constructs and writes cycle-manifest.json with empty steps. Its run_cmd helper is never called. It does not SSH, generate, train, export, evaluate, schedule or resume jobs. The real earlier experiments are separate evidence. Likewise, generate.cjs has an optional neural-engine seam, but its CLI does not currently select a neural producer; labels must not claim UCT visits when only network priors were used. train.py is a small in-memory bootstrap trainer, not a production streaming/resumable training service. These are implementation tasks, not reasons to merely launch the script and report a learning loop.

## 7. Continuous-learning topology and division across the two Sparks

Use the actual verified private SSH aliases after inventory; existing records use dgx-ts and dgx2-ts, but do not assume availability or identical environments. Prefer one independent orchestrator/registry and single-device training jobs initially over premature multi-host distributed training.

**DGX1:** approach-A student training, controlled architecture/learning sweeps and export validation. **DGX2:** self-play/search data generation and independently pinned evaluation; use its GPU for optional teacher training/inference only within the resource scheduler. CPU self-play may bottleneck before GPU training: measure games/hour, positions/second, GPU utilization and disk throughput before deciding placement. Keep the final evaluator independent of the trainer's mutable configuration and data directories. Host separation alone does not make an evaluation unbiased.

Keep production game inference on the client. Vercel/CDN serves approved immutable assets; the VPS continues Core/worker responsibilities, not mandatory neural inference. No per-move external LLM call and no always-on hosted GPU is introduced. Do not change unrelated ComfyUI/system packages. Use isolated toolroots/venvs or verified containers, local suitable filesystems for active caches and owner-approved storage for final artifacts. Respect free-space/resource reservations and stop on capacity exhaustion rather than deleting unrelated files.

## 8. Implement the operator, registry and dataset contracts

### 8.1 State machine and restart safety

Implement CL06-CL07 as an actual operator with modes plan, run, resume, status and stop. The exact CLI is to be implemented; do not present those commands as already working. Validate all configuration before acquiring a job lease. Suggested lifecycle:

`CREATED -> GENERATING -> DATA_VALIDATED -> TRAINING -> EXPORT_VALIDATED -> EVALUATING -> REJECTED | RESEARCH_APPROVED -> DEVICE_VERIFIED -> RELEASE_APPROVED -> PUBLISHED`

FAILED_RETRYABLE, FAILED_PERMANENT and PAUSED are explicit states with stage/context. Retrying never overwrites successful immutable output. Use a per-run ID, durable atomic state writes, exclusive lease with heartbeat/expiry, child-process tracking and idempotent stage outputs. Execute subprocess argument arrays, not untrusted shell strings. Record stderr and exit status, bound retries/log size, and distinguish environment/download failure from data/semantic failure. Stop must terminate child work safely and leave the last verified checkpoint resumable.

Before training, verify a clean source SHA against the checked-out Git tree, plus relevant file hashes and pinned environment. Do not trust a 40-character argument by itself; remove stale hardcoded default SHAs. Each generated data shard and model needs dataset/config/source/rules/encoding/search hashes, game/family ranges, RNG seeds, parent model, tool versions and creation status. Keep large checkpoints/raw data outside Git. Keep sanitized manifests, metrics, licensing and small regression fixtures in Git.

Implement checkpoint resume for model, optimizer, scheduler, RNG, data cursor and configuration. Explicitly distinguish a warm start from the current research champion, a resumed interrupted run and a controlled from-scratch experiment. Existing lack of resume must be fixed before unattended operation. Preserve the old research champion with compare-and-swap semantics; the research pointer cannot set the shipped catalog's APPROVED state.

### 8.2 Canonical state and learning records

Use the existing planes8-v1 encoding: own/opponent marks, own/opponent/drawn mini-boards, required board, legal cells and free-route information. Policy action index is b*9+c, not visual 9x9 row-major. Preserve macro/local D4 transforms and required-board routing. Value is+1 for a final win by the side to move in the recorded state, -1 for loss, 0 for draw. Terminal state has no action distribution and must be handled by the rules.

Each retained record should include schema/rules/encoding versions, unique game ID, normalized opening-family ID, full canonical state or replayable prefix, player-to-move, legal mask, actual root visit counts/distribution, action taken, final result/value POV, acting/search/teacher model versions, search budgets, seed and provenance class. Distinguish behavior policy, target policy, raw neural prior and temperature-adjusted played move. Off-policy labels are allowed only when explicit. A target that is merely a softmax over network logits is not an MCTS visit target.

Replay every accepted game through G.apply. Check legal actions, complete-game result, mask/tensor agreement, finite outputs and correct outcome sign at alternating turns. Reject corrupt/incomplete games or quarantine for diagnostics. Deduplicate identical trajectories and impose per-family/source caps. Split entire games and D4-equivalent opening families BEFORE augmentation; all rotations/reflections stay in the same split. Freeze a validation set for tuning and a separate untouched release-confirmation set. Known evaluation failures may enter a new research dataset only after retiring that evaluation set and replacing its confirmation holdout; never train on a still-claimed untouched test.

Use a bounded replay mixture with recent champion self-play, older champion/opponent diversity, strong tactical search and hard legal states. A starting mixture such as 50% recent, 30% archive, 20% hard-state sources is a tunable proposal, not an established optimum. Log the actual mixture. Sampling hard states must not distort outcome labels or duplicate one opening into apparent statistical power. Start with shard sizes and worker counts that fit measured memory; replace the in-memory bootstrap path with indexed/streaming data before large-scale runs.

## 9. Approach A: compact CNN plus tactical search

Execute CL04-CL17. First audit value sign/backprop, legal action gather, terminal handling, target generation, search budget accounting and training/inference parity. The existing PUCT engine negates child value during selection and alternates backups; prove the complete convention with solved deterministic fixtures instead of changing a sign based on a loss curve. Test forced macro wins, mandatory blocks, claimed/drawn destination free routing and late-game solved states. Overfit a tiny correct fixture corpus to catch plumbing defects; success there is diagnostic, not generalization evidence.

Run policy-only, policy+value, tactical-only UCT and improved-Expert comparisons with identical opening pairs and measured budgets. Profile actual completed simulations, expanded nodes, time in neural inference and critical-move filtering. A neural method with 16 simulations is not fairly characterized as weaker than all neural search merely because a fast classical engine explores many more useful nodes. Report both product-realistic wall-clock budgets and controlled simulation/compute ablations; neither substitutes for the other.

Bootstrap with stronger search labels, diverse mixed-strength opponents and more independent opening families, not just more copies of the current weak self-play. Train modest architecture candidates within the proposed 0.25M-2M range; 342k parameters is a starting configuration, not a requirement to grow. Compare validation policy loss, value MSE/proper calibration, tactical accuracy and actual league strength. Detect overfitting and value-head harm. Policy-only plus tactical evaluation remains a valid preferred product if it wins at the final device budget.

For every cycle: freeze parent champion/data/config; generate validated fresh shards; mix replay; train candidate; export/check numerical agreement; run independent league; reject or promote research champion; archive decision; schedule the next cycle only when data, resource and novelty gates justify it. A decreasing training loss alone never changes the champion. Preserve rejected candidates for diagnosis but never make them downloadable as APPROVED.

## 10. Approach B: Unsloth decision teacher and measured distillation

Execute CL18-CL23 in a separate environment. Verify the actual Qwen3.5-0.8B model revision, license, Unsloth decision-head API and ARM64/GB10 dependencies. Official Unsloth documents FastDecisionModel/DecisionTrainer-style legal-option scoring; verify current signatures before implementation. Generic decision-classification benchmark improvements do not establish Mega XOXO strength. Pin the working environment after a small smoke instead of blindly upgrading shared packages.

Serialize canonical states compactly and consistently. Supply ALL legal move options with unambiguous action IDs; never allow free-form generated text to invent a move. Include forced board, player-to-move and mini-board ownership/draws. Test serialization invariance and shuffled option order to detect position-label shortcuts. Use stronger search/solved labels with uncertain alternatives represented honestly. Do not claim the played move from a weak self-play game is necessarily the best label.

Preserve the game's family-level train/validation/confirmation split rather than using a convenience random-row split. Fine-tune a legal-choice head with small adapters as supported; calibrate scores on validation families. Optional RL is a second experiment, not an assumed supported production shortcut: validate library/hardware support and reward semantics first. Rewards should measure actual legal game outcome or verified search value, not a model grading its own answer. Keep track of teacher cost per accepted labeled position and decision latency.

Evaluate the teacher against search and the custom CNN on held-out legal choices, tactics, calibration and actual paired matches. It may be useful as a high-budget offline evaluator even when too slow for client play. Alternatively it may be weaker or too expensive; record that outcome and continue approach A. CNN inference already being fast is not a valid reason to skip this owner-requested utility test.

Distill ONLY a useful teacher. Generate training-only calibrated soft legal-policy targets, mixed with trusted search targets. Start with a controlled objective such as `L = L_search_policy + lambda_T * KL(teacher_policy || student_policy) + lambda_V * L_value`; lambda values and temperature are validation-selected and recorded. Distill value only if teacher value calibration is independently demonstrated. Compare otherwise identical student architecture/data/compute with and without teacher information; measure final-runtime strength, not just imitation accuracy. Neither the 0.8B weights nor a mandatory teacher API ships in the game.

## 11. Evaluation, promotion and stopping rules

The original acceptance targets are new Expert>=65% score against legacy, Impossible>=70% score against improved Expert,100% legal moves, reference-phone Expert p95 < 1.5 seconds, Impossible p95 < 2 seconds, roughly 1-5 MB compressed model, and tutorial>=80% unaided routing comprehension. A model smaller than 1 MB should not be padded; the upper bound and sufficient strength matter. Runtime/worker/installed bytes and RAM remain separate budgets requiring actual measurement.

Before final evaluation preregister openings, opponent versions, starting side, budget interpretation, sample size, maximum looks and decision rules. Pair identical openings with reversed sides. Compute points as(win+0.5draw)/games. Use opening family as the resampling/uncertainty unit, not correlated positions or each half of a pair independently. Report W/D/L, both-color behavior and tactical failures as well as score. There must be no repeated peeking until a favorable interval appears.

A conservative proposed promotion policy is a lower 95% family-bootstrap score bound at or above the original65%/70% targets, no critical tactical regressions, and all device/runtime gates. This is stricter than the original point-score requirement and must be recorded as the chosen engineering policy rather than falsely attributed to the original pack. Choose a fixed sample size from a pilot/power analysis; 200 or more independent families is a reasonable starting proposal, not a guarantee of adequate power. Reserve untouched confirmation families when comparing many candidates. Record unsuccessful and inconclusive experiments.

For quantization, predeclare a maximum acceptable score loss; a proposed margin is 2 percentage points versus float. Accept only when the appropriate paired confidence bound excludes a worse loss than that margin and tactical/legal tests pass. An interval containing equal performance proves neither equality nor non-inferiority. Check action-rank changes, 512 or more frozen states where appropriate, near ties, terminal masks and actual browser inference. Compare overall search, not isolated logits only.

If a candidate fails, preserve champion and stop publication. After several cycles without useful validated improvement, stop automatic retries and open a diagnostic task: data quality, search teacher, exploration, value calibration, throughput or architecture. Do not burn indefinite GPU time by automatically increasing model size. Measure elapsed time, memory and energy where instrumented; report NOT_MEASURED instead of estimates disguised as readings.

## 12. On-device runtime and optional model delivery

Keep inference/search off the UI thread with cancellation, bounded queues/memory/nodes, match ID and revision checks. Measure cold load/compilation as well as warmed execution. Feature-detect WebGPU and validate a small healthy inference; use WASM CPU where unsupported/unhealthy, including real Safari/WebViews. Runtime-specific capability detection must not be inferred from a desktop Chromium result. Compare optional LiteRT/CoreML bridges only when actual device data justifies complexity.

Report model raw/compressed bytes, every JS/WASM/JSEP/worker asset, network transfer, cached/installed size, peak RAM, model startup, sustained move latency, long tasks, temperature/battery and background recovery separately. Use pinned mutually compatible ORT assets, conditional imports and possibly reduced-kernel builds; benchmark the real combined package. Do not silently download both large runtime variants or say a 327 KB model means a 327 KB feature.

The production pack manifest should identify model/runtime/client/rules/encoding versions, hash/byte size for each asset, compatible client versions, signed or otherwise authenticated approval metadata, rollout class and previous stable revision. A hash alone does not authenticate a malicious manifest; the approval source must be trusted. Uploading an artifact does not approve it. Never accept arbitrary user-supplied model URLs as shipped Impossible.

Use immutable versioned assets with correct cache/content headers and bounded fetches. Keep the mutable approved-catalog pointer under separate release control. Stage assets first, verify integrity/compatibility, then atomically approve the manifest after owner sign-off. Existing matches pin the starting engine/model/budget; update only between matches. Test corrupt downloads, interrupted/resumed transfer, storage quota, denied consent, upgrade migration, offline launch, removal/re-download and rollback. Preserve a clearly labeled Expert fallback and unavailable Impossible state. Native model weights should remain data; executable JS/WASM changes follow the normal trusted client release process and current store requirements.

## 13. Tutorial and physical acceptance protocol

The guided opening is exactly six half-moves: X{b:0,c:4},O{b:4,c:0},X{b:0,c:3},O{b:3,c:0},X{b:0,c:5},O{b:5,c:0}. Assert mini[0]===X,turn===X,required===null and no winner. Remove guidance restrictions and continue ordinary Beginner from that SAME state. No reset, duplicate move, clock catch-up or claimed guaranteed full-game win.

Test narration/captions/mute,wrong taps,acknowledgment gates,Back/replay explanation,hint,skip,restart,hidden tab,Android process death,iOS background eviction,rotation,rematch,resign and reload at every stage. Bot and clocks must remain suspended while awaiting tutorial acknowledgment. Screen readers should announce the required mini-board and step meaning without flooding live regions. Check 200% text scaling,focus return,reduced motion and all four retained themes plus browser Neon. Test actual audio availability on each platform; absent local voices must fail gracefully with captions.

Run a moderated study with genuinely new players. A proposed first cohort is 20 participants, but record recruitment/sample limits and do not pretend 20 establishes universal 80% success. Predefine the three questions: overall macro goal, required next mini-board, and when free routing is allowed. Observe without coaching. Record completion and unaided correctness numerators/denominators, timing and confusion themes; iterate wording when below target, then retest fresh users. Human owns acceptance; Codex facilitates browser sessions; main agent instruments only approved minimal telemetry.

## 14. Learning feedback, scheduling and resource policy

Initially train only on synthetic/self-play/approved offline fixtures. Player game data is not automatically authorized for training because it exists in the backend. Any later replay contribution must have approved consent, minimization, retention/deletion and privacy handling. Prefer voluntary minimal board/action/model-debug data without account/email/IP/payment/chat identifiers. Local wins are unverified and may be forged: canonical replay verifies rule consistency, not truth of claimed competitive outcome. Validate, quarantine and relabel against trusted search before accepting targets. No client data grants currency or updates verified rank.

Use proposed bounded schedules selected from real workload inventory: generate batches when validated replay volume or novel failure coverage crosses a threshold; train only when data novelty and compute budget justify it; evaluate every candidate; review publication manually. The main agent implements actual systemd/cron/job orchestration on the owner-controlled host after validating time/resource windows. This document is not itself a scheduled service. Keep resumable checkpoints, quotas, maximum run times, stop controls and alerting for stuck leases/OOM/disk/invalid datasets. Never run blind loops against live game-service databases or reuse their credentials.

Track independent counters for dataset versions, research champions and shipped approved models. Measure legality, win-rate confidence, exploit resistance, tier ordering, latency and runtime failures over time. Roll back the approved pointer on a verified regression only to a compatible retained model; active games remain pinned. A newly trained model never automatically changes player difficulty, rewards or tutorial narration.

## 15. Final release and operation path

Close all applicable R01-R28 packages and original acceptance cases with exact evidence. Codex completes approved website service/page states, current provider accounts, store workflows and human-reviewed disclosures. Every full-pack art requirement remains open until actually delivered or explicitly deferred by the owner. Do not hide 160 unchecked items behind a homepage screenshot. The user chooses whether any scope is staged for later.

Before cutover: revalidate CI and immutable artifacts; confirm target costs/quotas; test independent backups and both recovery classes; stage production read-only with all lazy auth/bootstrap/jobs/webhook writes disabled; approve the maintenance window and exact rollback plan. During cutover drain/freeze EVERY V4 writer, including restarts/schedulers/operators/provider callbacks; capture consistent final source; import and reconcile all durable identity/economy/relationships/history/privacy state; transfer authority epoch; enable Core/API/provider inbox/workers in the approved order; route clients with one writer through DNS propagation. Record the first V5 application write.

Afterward run controlled supported-client smoke, backup retrieval, alert delivery and recovery confirmation. Keep V4.1 branch/tags/images/evidence, but permanently fence obsolete V4 runtime writers. Retire compatibility only on supported-client/provider usage evidence. Establish actual capacity metrics and trigger-duration runbooks; extra capacity is NOT_TRIGGERED when demand does not justify it. Publish final open/partial/deferred items without calling upload approval or simulation device proof.

## 16. Required checkpoint format and small commit plan

After each milestone report: completed IDs, partial IDs, source SHA/commit, commands and pass/fail/skip counts, actual environment/device, sanitized evidence paths, integration effect, rollback and next bounded task. Stop only the genuinely blocked slice and continue independent safe work. No secrets, raw private data, signing keys or authenticated traces in Git/artifacts.

Suggested cohesive commits: evidence reconciliation; service composition/flow 12 fix; native integration; canonical neural diagnostics; orchestration state machine; dataset registry/split validation; real self-play adapter; streaming/resume; candidate/evaluation registry; teacher experiment adapter; conditional distillation; runtime packaging; device acceptance fixes; release manifests/runbooks. Push each meaningful verified milestone on V5.1 with remote-head recheck. Do not create a giant untested final commit or merge into main.

## 17. Primary technical references and provenance

Repository truth for current implementation and measured results:
- docs/v5/progress.json, docs/v5/OPEN-ITEMS.md and original Mega-XO-V5-Implementation-Pack/ACCEPTANCE.md.
- docs/v5.1/bot-ai/IMPLEMENTATION.md, BENCHMARKS.md, AUDIT-FIXES-20261012.md and evidence/dgx-experiments-20261012.json.
- training/bot/{champion_cycle.py,generate.cjs,validate-data.cjs,train.py,export.py,model.py,neural_league.cjs}; src/bot/{encoding.js,search.js,neural-search.js}.
- docs/p21-web/{MASTER-CHECKLIST.md,DOWNLOAD-AND-DISCOVERY.md,DEVELOPMENT-AND-RELEASE.md}.

Primary external documentation consulted for the design (verify exact versions at implementation):
- https://unsloth.ai/docs/basics/train-your-own-decision-model-with-unsloth
- https://unsloth.ai/docs/models/qwen3.5/fine-tune
- https://onnxruntime.ai/docs/tutorials/web/deploy.html
- https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- https://docs.pytorch.org/docs/stable/notes/randomness.html
- https://vercel.com/docs/plans/hobby

The numerical protocols, operational topology, proposed replay mixture, initial study size and conservative confidence/margin gates are engineering recommendations in this plan, not claims of completed experiments or guarantees of improvement.

## 18. Executable continuous-learning worklist

Each task belongs to the main agent. Dependencies and acceptance below are required evidence, not a claim that the existing scaffold executes these stages. ChatGPT reviews implementation/protocol; the human supplies physical-study and release decisions where identified in the owner register.

| ID | Deliverable | Dependencies | Done when |
|---|---|---|---|
| CL00 | Freeze clean source and evidence | R01,R02 | One clean V5.1 SHA plus rules/search/encoding hashes, immutable baseline manifests and negative tests; preserve all current user work. |
| CL01 | Inventory both DGX environments | CL00 | Verify actual SSH aliases, architecture, CUDA/PyTorch/Node and isolated working roots; benchmark local disk/network; record free RAM/GPU/storage and reserve other workloads. |
| CL02 | Create bounded reproducible runtime | CL01 | Pinned environment/container digest and dependency/license manifest; no changes to ComfyUI/system Python; small CPU+CUDA+ONNX smoke. |
| CL03 | Freeze evaluation and promotion protocol | CL00 | Independent D4 opening families, both sides, opponent roster, critical tactics, equal budgets, fixed sample/stopping rules, confidence method and untouched confirmation holdout. |
| CL04 | Audit oracle/encoding/value semantics | CL02,CL03 | Canonical replay, action b*9+c vs visual coordinates, D4 macro+local transforms, masks, terminal results and value POV/backprop tested with solved fixtures. |
| CL05 | Diagnose current neural failure | CL04 | Micro-overfit test, policy/value calibration, policy-only/value/UCT/Expert ablations and per-search throughput report; no scaling to conceal a semantic defect. |
| CL06 | Implement real orchestrator state machine | CL02,CL03 | Plan/run/resume/status/stop modes; validated config; actual subprocess stages, argument arrays, durable state transitions, leases, exit codes, retry classes and bounded logs. |
| CL07 | Add artifact and dataset registries | CL06 | Content-addressed shards/checkpoints/reports, atomic writes, checksums, parent lineage, source/environment metadata, retention and a last-known-good research champion. |
| CL08 | Wire neural-aware self-play generation | CL04,CL06 | CLI accepts a verified checkpoint/search config; records actual root visits, not priors mislabeled as search; captures opponent, seeds, budget, terminal outcome and behavior-policy provenance. |
| CL09 | Create leakage-safe corpus and splits | CL07,CL08 | Whole-game and D4 opening-family split before augmentation; evaluation IDs excluded from train/failure mining; validate before accepting every shard. |
| CL10 | Bootstrap with stronger teachers and diverse opponents | CL05,CL09 | Improved search teachers plus frozen opponent archive and independent openings; cap trivial/duplicate/stale games and retain representative hard states. |
| CL11 | Scale dataset I/O safely | CL09 | Streaming/indexed shards or bounded workers rather than loading all production-sized JSONL into RAM; fail safely on low disk/OOM. |
| CL12 | Add true checkpoint/resume and warm-start | CL07,CL11 | Persist model/optimizer/scheduler/RNG/data cursor; explicitly choose champion warm-start vs controlled from-scratch trial; killed run resumes without split drift. |
| CL13 | Train compact CNN candidates | CL10,CL12 | Run measured architecture/budget sweeps within0.25M-2M target range; record calibration, loss, throughput,wall time,memory and measured energy or NOT_MEASURED. |
| CL14 | Export and verify each candidate | CL13 | PyTorch/static+dynamic ONNX agreement on frozen legal/terminal states; exact action rankings and invalid-mask handling; hash/size/runtime-version report. |
| CL15 | Run independent strength leagues | CL03,CL14 | Separate validation host/process and frozen config; actual W/D/L, family-level uncertainty, tactics, paired sides and wall-clock/throughput budget evidence. |
| CL16 | Approve or reject research champion | CL15 | Atomic research-only pointer changes after all predefined gates; rejected candidate remains archived; no player-facing APPROVED status from training alone. |
| CL17 | Execute repeated cycles with failure recovery | CL16 | Two completed real cycles, one intentional interruption/resume, old champion preservation and next-cycle data lineage; scheduler skips when no useful new data/budget. |
| CL18 | Verify Unsloth decision model on DGX | CL02,CL09 | Resolve actual Qwen3.5-0.8B revision/license and ARM64/GB10 dependency support in a separate environment; one legal-choice fine-tune/inference smoke. |
| CL19 | Train and calibrate decision teacher | CL18 | Canonical serialized states and complete legal options; retain supplied family split instead of random row split; no generated free-text move parser or illegal choice fallback hiding failure. |
| CL20 | Benchmark teacher utility and cost | CL19,CL03 | Held-out proper-scoring/calibration metrics, tactical accuracy, paired games, latency/memory/energy against search/CNN teachers; generic NLP results are not game evidence. |
| CL21 | Decide teacher keep/reject | CL20 | Explicit measured utility decision. Teacher remains offline; lack of benefit does not block approach A or justify fabricated distillation. |
| CL22 | Distill useful teacher into small student | CL21,CL13 | Training-only calibrated legal-policy targets mixed with search targets; teacher/student/data lineage; no0.8B game asset or mandatory server API. |
| CL23 | Run controlled distillation ablations | CL22,CL15 | Same student architecture/data/compute with versus without teacher; compare actual final-budget match strength and calibration; adopt only worthwhile gain. |
| CL24 | Quantize with a preregistered loss margin | CL14,CL15 | INT8/mixed precision numerical+match testing; proposed max2-point score loss non-inferiority assessed with paired-family interval, not interval-containing0.5 equivalence. |
| CL25 | Minimize and measure total inference package | CL24 | Model compressed/raw, JS,WASM/JSEP,Worker,cache/installed bytes,peak RAM,cold/warm start all separate; custom kernels/conditional imports only if verified. |
| CL26 | Complete actual phone/browser inference matrix | CL25,R11 | WASM fallback and healthy WebGPU feature detection; cold/warm/airplane/restart/rematch/cancel/low-memory/thermal/battery checks on defined real reference hardware. |
| CL27 | Complete tutorial usability gates | R20,R21 | Exact six moves, paused clocks and same-state Beginner handoff; captions/voice/AT; fresh-user80% routing study with counts and failure examples. |
| CL28 | Obtain release approval and stage immutable pack | CL16 or CL23,CL26,CL27,R14 | Separate release review tied to exact model/runtime/client/rules versions; immutable assets,compatible manifest,consent,cache,hash,rollback and empty-catalog safety. |
| CL29 | Publish only in approved release scope | CL28,R29 | Owner-authorized staged/canary rollout; active games stay pinned; authenticated/trusted catalog update separate from artifact upload; no extra rewards/official Elo. |
| CL30 | Add consented failure feedback without contamination | CL29 | Default synthetic/self-play input. Player replay upload only approved opt-in,minimal board data,no identity/secrets,retention/deletion; validate,relabel and quarantine before training. |
| CL31 | Operate a bounded review-driven continuous loop | CL17,CL30 | Resource windows/data thresholds,periodic evaluation,plateau stop/diagnostics,regression alerts,operator pause and tested rollback; published model never hot-swaps mid-match. |
