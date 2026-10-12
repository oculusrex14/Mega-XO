# Mega XOXO V5.1 - Bot Intelligence and Guided Tutorial Implementation Checklist

The 82 task statements below are imported from the owner-approved implementation pack, prepared 2026-10-11 (Asia/Kolkata). Original upload SHA-256: `8a2807d0dcae20ed957e3b9f93980748004b427f92de3c637b9aad5d1be4b280`. This file is the living checklist, not a claim that the approved design is implemented. See progress.json for task-level evidence, commit/CI references, manual-device status, blockers and rollback.

Repository: oculusrex14/Mega-XO. Integration target: V5.1. Feature branch: feat/v5.1-bot-ai-tutorial. Preserve independent P21 work. No merge to main, deployment, live V4 change or V5 cutover. Canonical rules remain src/game.js; first five bot rewards and daily caps remain unchanged. Guided practice and local Impossible have no official rewards, Elo or verified ranking. Client-side optional small neural inference is the target, not an always-on cloud LLM.

Execution order: B00 -> B01 -> B03 -> B02; then B04 -> B05 -> B06, with B07 acceptance. All phases initially PLANNED. Checkboxes require evidence; partial or externally blocked tasks remain unchecked.

## B00 - Coordination, boundaries and safety baseline

- [x] **B00.01** Fetch the latest `origin/V5.1` and inspect working tree, branches, open PRs, active P21 changes and current CI. Create `feat/v5.1-bot-ai-tutorial` from the latest commit; verify it is a descendant of V5.1. Do not create a second integration trunk.
- [x] **B00.02** Record source ownership: existing `src/game.js`, `src/app.js`, `src/domain.js`, `src/styles.css`, `index.html`, native packaging, and P21 website equivalents. List likely edit collisions with P21 and nominate minimum patch points.
- [x] **B00.03** Write `docs/v5.1/bot-ai/ARCHITECTURE.md` with local-first topology, model training/serving separation, source-of-truth state, asset delivery, fallback paths and verified-play trust boundary.
- [x] **B00.04** Add this checklist as `docs/v5.1/bot-ai/IMPLEMENTATION.md` and maintain an evidence ledger with task ID, commit SHA, CI result, manual device result, remaining blockers and rollback instructions. Mark all phases as PLANNED initially.
- [x] **B00.05** Establish invariant tests confirming bot/tutor moves use the existing canonical `G.legal` and `G.apply` contracts. Define `version`, `ruleset`, `difficulty`, `modelHash`, `rngSeed` and `thinkingBudget` fields for debugging; do not expose secrets.
- [x] **B00.06** Record existing Coin/Crown reward and Elo boundaries. Confirm guided practice and unverified on-device AI cannot mint official economy rewards or verified rankings. Leave the daily caps and first five BOT_PAY amounts unchanged.

## B01 - Reproduce bot weaknesses and build strength measurements

- [x] **B01.01** Write a deterministic headless bot match runner that can control seeds, start player, opening positions and time/node budgets, run thousands of games and export result metadata. Score a draw as 0.5 and alternate X/O positions.
- [ ] **B01.02** Snapshot old `G.choose()` outcomes from a curated opening/position corpus, especially positions with identical legal alternatives, forced sends, claimed boards and opponent threats. Explicitly document where repeated games yield identical sequences.
- [x] **B01.03** Build an adversarial library of specific tactics: immediate mini wins, Mega Board line wins, mandatory defenses, forks, send-to-danger, free-route opportunities, sacrifice-to-win, drawn/closed destination and late-game forced moves. Every case has an expected legality and tactical goal, not only a fixed move if multiple choices are equally strong.
- [ ] **B01.04** Add a seeded script-playing adversary that exploits predictable Expert openings and record win/draw/loss rates for a baseline regression comparison.
- [ ] **B01.05** Benchmark current engine per level on a representative low-end Android device, current iPhone, desktop Chromium and Safari where accessible. Capture p50/p95 move time, main-thread long tasks, peak memory and responsiveness. Mark untested hardware honestly.
- [x] **B01.06** Define fair bot-league methodology: paired openings, reversed sides, fixed wall-clock or simulation budgets, holdout tactical tests, confidence intervals and repeatable model version pinning. Never compare strength only by raw win rates when different compute budgets are used.
- [x] **B01.07** Commit benchmark scripts and frozen baseline results under `tests/bot/` and `docs/v5.1/bot-ai/evidence/`; keep bulky raw training data/artifacts out of Git.

## B02 - Replace and scale the five existing offline bots

- [x] **B02.01** Build a compact board representation (for example, per-mini bitboards and encoded macro outcomes) with fast apply/unapply, forced routing, terminal detection and hashing. Keep it behind a versioned adapter; differential-test extensively against `G.apply()`.
- [x] **B02.02** Implement an efficient legal move generator plus tactical move ordering: immediate Mega wins, compulsory global blocks, mini-board threats, opponent routing, and critical local forks. Avoid hardcoding fixed preferred openings.
- [x] **B02.03** Add transposition-table entries keyed by full canonical state (board, claimed mini-boards, required destination and side-to-move) and handle cache size, search version and per-match isolation. Verify hash collision behavior or use state verification.
- [x] **B02.04** Implement time-bounded iterative search and one or more MCTS/UCT or PUCT baselines with tactical extensions. Preserve the best fully completed search result when interrupted; return only legal moves.
- [x] **B02.05** Add per-match seeded stochasticity for comparable-quality alternatives, preserving forced wins/defenses. Record seed in local match debug state so a reported failure can be replayed exactly. Variation is quality-bounded, not indiscriminate randomness.
- [ ] **B02.06** Create explicit tier profiles for Beginner/Easy/Medium/Hard/Expert: compute budget, tactical awareness, noise/temperature, deliberate error allowance (only weaker levels), and stable strength ordering across devices.
- [x] **B02.07** Move compute off the UI thread into a dedicated Worker. Consider native Rust/C++ -> WebAssembly only when benchmarked; add cancellation tokens, match ID and revision checks so stale suggestions cannot land after resignation, rematch, pause or reload.
- [ ] **B02.08** Ensure transitions and timers remain responsive: pause/resume, background visibility, interrupted Worker, memory pressure and device thermal load. No visible board freezes or duplicated bot turns.
- [ ] **B02.09** Run the B01 opponent league and curated tactic suite; measure progressive skill with confidence intervals, opening diversity, repeated scripted exploit resistance and device latency. Tune tiers based on evidence, not arbitrary depth labels.
- [x] **B02.10** Integrate the new selector behind an internal feature flag; retain the existing `G.choose` engine as a compatible fallback during testing. Update `src/game.js` and `src/app.js` minimally, not through unrelated refactoring.
- [ ] **B02.11** Run browser, Android WebView and iOS WKWebView smoke tests; verify rule/UI parity, all supported themes, app bundle integrity, offline behavior and no unexpected new network traffic.

## B03 - Guided first-game tutorial (prioritize for beta testers)

Exactly six canonical half-moves: X {b:0,c:4}, O {b:4,c:0}, X {b:0,c:3}, O {b:3,c:0}, X {b:0,c:5}, O {b:5,c:0}. After step 6 require mini[0] === 'X', turn === 'X', required === null and no winner. Stop scripting, preserve the same live state and return to ordinary Beginner. An early advantage is not a guaranteed full-game victory.

- [x] **B03.01** Introduce a standalone, declarative tutorial controller (for example `src/tutorial/lesson.js`) with step IDs, expected state/revision, legal scripted move, on-screen explanation, optional spoken script, highlight target and acknowledgment/continuation gate.
- [x] **B03.02** Make the existing `How to Play` entry offer **Start guided practice** as the primary action, while preserving a direct Rules reference. Avoid dumping all mechanics in a modal before the first move.
- [x] **B03.03** Display a brief objective: claim three mini-boards in a line to win the Mega Board. Show mini-board vs Mega Board visually, then invite the player's first action.
- [x] **B03.04** For each guided player turn, highlight the exact legal cell and explain *why*: routing, building two marks, or completing a mini-board row. Block accidental wrong-cell moves during guided steps while offering an obvious Skip Guidance action.
- [x] **B03.05** For each guided bot turn, explain the result of the player's previous cell, render the bot move only after acknowledgment, and show the destination highlight/route. Pause until a human presses Continue when a concept needs explanation.
- [x] **B03.06** After the fifth move, celebrate the first claimed mini-board, draw its relationship to the macro 3-in-a-row goal, and after the sixth demonstrate **closed destination -> free route** explicitly.
- [x] **B03.07** On tutorial completion, remove special input restrictions and leave the current board and X's turn intact. Regular Beginner resumes from the exact live state, not a reset or newly spawned simulation.
- [x] **B03.08** Provide Back/Replay Explanation, Hint, Continue, Skip Guidance and Restart Tutorial controls. Replay Explanation should not mutate board state unexpectedly; undo/restart must be explicit and restricted to practice.
- [ ] **B03.09** Integrate optional local-device narration or pre-generated short audio clips with captions, volume/mute and no mandatory network dependency. Spoken wording must match on-screen instructions; no unreviewed dynamic AI narration during play.
- [ ] **B03.10** Suspend both turn clocks and bot scheduling while tutorial prompts are waiting. Prevent hidden/background-tab transitions and ensure `animateRoute()` is visible long enough to understand but not artificially slow outside guided practice.
- [ ] **B03.11** Persist the tutorial step, practice flag, paused/awaiting-ack state, completed moves and version alongside existing `offlineMatch` data. Resume safely after refresh, Android process death or iOS backgrounding; never repeat a committed move.
- [ ] **B03.12** Add accessibility: keyboard/touch and screen reader controls, focus restoration, captions, semantic step announcements, tap target size, reduced motion, text scaling and theme contrast. Test all currently supported product themes without renaming them.
- [ ] **B03.13** Add automated six-move scripted tests, wrong-tap and Skip tests, pause/hidden-tab tests, replay/restart, refresh-resume and test of the transition to the real Beginner AI. Include a coin/stat regression proving guided practice has no reward.
- [ ] **B03.14** Conduct moderated beta tests with new users. Measure tutorial completion, unprompted identification of the required next mini-board, and ability to explain free routing. Iterate instruction phrasing if success is below the target in B07.

## B04 - Train a compact policy/value network with DGX self-play

- [x] **B04.01** Define tensor encodings for 9x9 cells, mini-board owners/draws, required board, current player and legal-action mask. Normalize to side to move. Specify mapping of 81 policy logits to `{b,c}` and scalar value to a fixed win/draw/loss convention.
- [x] **B04.02** Implement 8 dihedral board symmetries with correct transformations of local cell indices, macro board indices, required destination and legal mask. Verify that legal moves commute with transformation (rules oracle parity).
- [x] **B04.03** Build a PyTorch small residual policy/value CNN, starting with a 0.25M-2M-parameter search range, not a huge language backbone. Use 81 policy outputs and one bounded value output. Track parameter counts and artifact sizes.
- [x] **B04.04** Build legal-state and self-play generation from canonical Mega XOXO rules. Begin with improved MCTS tactical baseline and mixed-strength opponents; vary first move, starter, and search seeds. Do not train exclusively against the old deterministic Expert.
- [x] **B04.05** Save training records as `(state, legal_mask, MCTS visit-distribution target, terminal outcome/value target, model version, game ID)`. Use complete-game train/validation/holdout separation; prevent positions from the same game appearing across splits.
- [x] **B04.06** Train a first candidate on DGX, track learning curves, outcome calibration, policy quality, GPU memory, time, energy and reproducibility settings. Keep full data and checkpoints in private artifact/object storage, not Git.
- [x] **B04.07** Run iterative self-play/improvement cycles with explicit promotion criteria. Preserve the previous champion and never automatically replace shipped models because training loss decreased.
- [ ] **B04.08** Experiment with an **Unsloth-trained Qwen3.5-0.8B decision model** as an optional teacher/evaluator on the DGX: serialize canonical states plus legal choices, train/score with published Unsloth decision-model facilities, and compare against the custom tiny network on held-out positions and actual match play.
- [ ] **B04.09** If the Unsloth teacher adds value, evaluate distillation to the compact policy network. Account for 0.8B model inference cost, selection biases and legal mask. Do not mandate Unsloth, a hosted model, or a 400MB+ model asset in the shipped game.
- [x] **B04.10** Test the learned value network inside PUCT/MCTS. If policy-only plus tactical search wins more often, retain that simpler design. Choose by paired games at equal budgets rather than assuming the value head helps.
- [x] **B04.11** Benchmark against old Expert, new Expert, tactical MCTS, random/planner bots and intentionally adversarial openings. Report win/draw/loss with confidence intervals; test novel positions not present in self-play training.
- [x] **B04.12** Version and sign-off each candidate with model file hash, rules version, training commit/data manifest, quantization settings, license/attribution audit and deployment status. No unreviewed model swap.

## B05 - Lightweight on-device inference and optional asset pack

- [ ] **B05.01** Export candidate to ONNX with static and dynamic shape checks; verify numerical agreement with PyTorch on hundreds of frozen states, especially action rankings and legal masks. Build an INT8 or mixed-precision variant and measure actual score regression.
- [ ] **B05.02** Target a **1-5 MB compressed model file**, pending benchmark results. Record separately WASM inference-library, Worker, search module, unpacked runtime and memory sizes. Fail the size gate visibly if it cannot be met without unacceptable skill loss.
- [ ] **B05.03** Build a browser model loader using ONNX Runtime Web: WebGPU only if supported and healthy, then WASM CPU fallback. Detect support/capacity at runtime and avoid breaking iOS Safari or embedded Android/iOS WebViews.
- [ ] **B05.04** Run neural inference and search away from the UI thread (Worker/WASM), with bounded memory/simulations per device class, backpressure, cancellation, stale match/revision checks and safe unload on route change.
- [x] **B05.05** Implement an **optional AI pack download**: visible file size, consent on mobile data, progress, pause/retry, integrity hash, version pinning, cache update, offline availability check and clear remove/re-download UI. Downloaded model weights are static non-executable data where feasible.
- [ ] **B05.06** Configure Vercel/P21 static asset delivery for versioned immutable model artifacts (and reasonable CDN/cache headers) without routing gameplay inference through Vercel functions or introducing new Oracle load. Coordinate asset URLs with P21 owner.
- [ ] **B05.07** For Android, evaluate the same ONNX WASM path in the WebView first; compare an optional LiteRT native bridge only if real device benchmarks justify it. For iOS, test WKWebView WASM first and benchmark Core ML native inference for additional acceleration.
- [x] **B05.08** Ensure downloaded pack survives app restarts, upgrade migrations and offline launches. On incompatible/corrupt model, show actionable status and allow recovery or use explicitly labeled Expert fallback, **never silently claim full Impossible**.
- [ ] **B05.09** Profile speed, RAM, thermal behavior and battery on reference low/mid/high phones and desktop browsers. Dynamically tune MCTS simulations based on real measured speed; user-visible 'thinking' affordance must not freeze controls.
- [x] **B05.10** Run cross-runtime golden inference comparisons, all supported themes, bundle parity, accessibility, airplane-mode smoke, interrupt/resume and asset-integrity tests.

## B06 - Impossible mode product and optional verified challenge

- [x] **B06.01** Extend public mode metadata to include `Impossible` only when the pack is available or clearly shows download/setup state. Ensure every caller of `G.LEVELS` tolerates a new value (difficulty picker, statistics filter, quests/rewards views, persistence and native packaging). Avoid adding undefined Coin reward rows.
- [x] **B06.02** Treat Impossible as a distinct **local AI match type or difficulty with an unverified result class**. It has no new coin minting, Elo or official leaderboard placement; user progress UI may show separate local wins/draws/losses.
- [ ] **B06.03** Build the move pipeline: canonical state -> tensor -> legal mask -> policy/value inference -> PUCT/MCTS -> tactical verification -> original `G.apply` legality check -> UI result. Never allow an ML output to bypass canonical rules.
- [ ] **B06.04** Pin the loaded model version at match start, persist it in resumed matches, and expose a benign technical identifier for bug reports. Updates affect new matches rather than midgame moves.
- [ ] **B06.05** Give Impossible substantial tactical strength and quality-bounded opening variety, but preserve forced correct actions. Surface training/version labels only where they improve user trust and clarity.
- [ ] **B06.06** Add an optional online **verified Impossible challenge** design only if needed for official rewards, achievements or cross-device records. Oracle Game Core must independently own state and generate/verify bot moves. Never trust a client-uploaded bot result as authoritative.
- [ ] **B06.07** If a verified mode is actually commissioned, benchmark a small isolated CPU-only AI worker on Oracle; set per-match CPU/memory quotas, concurrency limits, authenticated Core-only requests, timeouts, retry/fencing and no wallet-write permissions. Reject or defer this mode if it threatens ordinary PvP latency.
- [ ] **B06.08** Decide whether verified Impossible is in initial scope after B05 measured results. Prefer shipping local first; no always-on GPU and no coupling DGX availability to player sessions.
- [ ] **B06.09** Add clear states and telemetry for pack unavailable/downloading/corrupt, inference failure, device unsupported, slow thinking, cancellation and fallback. Failure must never fabricate a win, lose a valid human move or change existing currency rules.
- [ ] **B06.10** Add match resume, device rotation, background/foreground, rematch, resign, timeout and offline reliability tests. Verify that opening choice and move order are not trivially replayable while forced best moves remain stable.

## B07 - Complete acceptance, beta feedback, integration and handoff

- [ ] **B07.01** Formalize a release matrix across supported Chrome/Edge/Firefox/Safari desktop, representative Android browsers/WebViews and iOS Safari/WKWebView. Record exact hardware, operating system and versions. No pretend pass for absent devices.
- [ ] **B07.02** Run canonical-rule differential/property-based tests over random legal states and complete games. Require **100% legal AI moves**, correct terminal outcomes and correct forced routing; seed failing states and preserve artifacts.
- [x] **B07.03** Run a curated critical-tactics gate with no missed one-ply forced Mega wins or mandatory defenses (where mathematically identified). Flag edge cases and avoid asserting incorrect unique best moves.
- [ ] **B07.04** Run paired bot tournaments with balanced openings/starting sides and fixed time budgets. Proposed candidate gates: new Expert **at least 65% point score** versus old Expert, and Impossible **at least 70% point score** versus new Expert, both with statistical reporting; these are targets, not existing results or an automatic shipping guarantee.
- [x] **B07.05** Validate adjacent difficulty tiers show meaningful strength ordering; collect repeated-opening diversity, frequency of deterministic ties, tactical quality and adversarial exploit success. Avoid randomizing away quality to inflate diversity metrics.
- [x] **B07.06** Set provisional performance goals: Expert p95 move time under **1.5 s**; Impossible p95 under **2.0 s** on explicitly chosen supported reference devices; no long main-thread search stalls. Adjust only with real measurements and documented device support.
- [ ] **B07.07** Run guided tutorial automation: scripted six-move legality, correct one-mini-board advantage, pauses, explicit Continue, bot scheduling, focus, voice captions, skip, restart, offline resume and no reward/stat side effects.
- [ ] **B07.08** Conduct fresh beta onboarding tests (not developer-led scripted playback). Target **at least 80% of test participants identifying the required next mini-board without hints** after the lesson; track tutorial completion and confusion with the 3-mini-board macro objective.
- [ ] **B07.09** Run all existing repository CI plus V5/V5.1 bot, browser, native bundle, economy, abuse, accessibility and staging tests. Preserve logs, sample model manifests and device screenshots/videos where permitted.
- [ ] **B07.10** Validate P21 compatibility on the latest `V5.1` head immediately before integration. Rebase or merge carefully; never overwrite changed website assets, theme tokens, auth API, account screens, legal pages or native build configs. Commit coherent changes and show exact diff.
- [ ] **B07.11** Produce a rollback plan: old local bot engine feature flag, model pack invalidation, safe fallback labels, migration-safe saved games and no required database schema migration for purely local bot play.
- [x] **B07.12** Produce final handoff report: completed/blocked task IDs, commit SHAs, test results, strength league graphs/tables, actual model size, reference-device performance, file-change inventory, license notes, unresolved risks, and what requires owner authorization.
