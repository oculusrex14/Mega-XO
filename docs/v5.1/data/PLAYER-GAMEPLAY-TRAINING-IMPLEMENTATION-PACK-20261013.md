# Mega XOXO V5.1 — Real-gameplay data capture implementation pack

Implementation owner: ChatGPT WebUI co-developer, with schema/Core integration serialized on `V5.1`. Status: NOT STARTED. This is a future-training DATA COLLECTION release gate, not authorization to restart neural training or enable Impossible.

Architecture of record: `docs/v5.1/data/PLAYER-GAMEPLAY-TRAINING-ARCHITECTURE-20261013.md`.
Research references: `docs/v5.1/research/utttai-analysis.md`, `docs/v5.1/research/DEFERRAL-20261013.md`.

## P0 — Deliver before public V5 day one

| ID | Milestone and actions | Proof of done |
| --- | --- | --- |
| DC00 | Lock scope and product/privacy choices: server-authoritative human Ranked/Casual/direct; tournament fixture route if available; local practice explicitly non-authoritative. Decide collection purpose, notices, opt-out and approved retention before enablement. | Documented privacy/legal review; sources enumerated; no implicit training consent. |
| DC01 | Audit current HEAD migrations, runtime grants, Core outbox consumers, game history and real deletion workflow. Produce role/data-flow threat model. | Exact source SHAs, real `ops.outbox` kind ownership, no contradictory writer. |
| DC02 | Implement a stable, bounded `game-capture/v1` serializer and independent validator. Canonical action index `b*9+c`, move/order/turn/board/required rules, hash, source revision and truthful terminal classifications. | Fixtures for legal 81-cell paths, invalid moves, corrupt boards, missing ply, resign/timeout/draw/void, O-first synthetic distinctions, hash stability. |
| DC03 | Add additive versioned PostgreSQL learning schema: private archive, restricted participant index, quarantine + manifests; review columns, checks, roles, migrations/reversion; no core economic grants widened. | Fresh PG16 migration+reapply+guard tests; live system unaffected. |
| DC04 | Emit a deterministic, sanitized `learning.capture` intent AT FIRST confirmed terminal transition in the existing Core transaction. Include terminal state caused by legal move, resign, timeout and operator void; ignore exact idempotent replays. | Concurrency and rollback tests: once-only, no lost terminal, zero unpublished source rows. |
| DC05 | Build isolated kind-scoped capture worker and internal allowlist projection. Replay source, persist checksummed minimal archive, quarantine conflicts, retry safely after crash; don't steal existing worker jobs. | Crash-before/after-archive, duplicate key, hash conflict, Redis down, stale worker fence, session denial; all deterministic. |
| DC06 | Add periodic reconciler to detect settled sources not captured, repair missing intents, expose failure count/backlog/oldest age. Block source retention from pruning uncaptured verified games. | Reconciliation recovers deliberately missed outbox and detects irreparable deletion; no silent loss. |
| DC07 | Add independent tournament fixture extractor where game history is available; distinguish fixture attempt and adjudication from standalone match results. Do not mark incomplete fixtures as complete. | One synthetic tournament match and a multi-round/failover fixture replay with strict source identity. |
| DC08 | Integrate account deletion, consent/opt-out, export lineage and backup post-restore suppression. Maintain private source-to-subject index, encrypted storage, no raw player identifiers in training exports. | Deletion removes/excludes all affected captures and previously exported shards. Legal approval and data retention manifests recorded. |
| DC09 | Produce deterministic, streaming OFFLINE export of game-level archive + replayed pre-move samples with group-safe splits and reserved untouched set. Separate human behavior from search labels and terminal vs adjudicated outcomes. | Two independent validators replay everything, hashes/manifests match; no external utttai games fabricated. |
| DC10 | Integrate with the actual isolated staging Core and two disposable actors (Codex coordinates private credentials). Full game, resignation, timeout/void, crash/retry, queue/direct, both symbol assignments, legal masks. | Counts reconcile 100%, zero invalid accepted rows, no raw credentials in evidence; checked process SHA. |
| DC11 | Benchmark capture overhead and retention. Latency of normal moves/settlements under worker outage and replay backlog must meet existing P19 budgets. Measure compressed archive size and estimated storage cost from real fixtures, not guesses. | Reproducible benchmark + bounded queue, restore test, quota/alert controls. |
| DC12 | Add non-serving CI and an explicit V5 release-readiness check requiring DC02–DC11 plus privacy authorization. Preserve V4 production, disabled model catalog and existing gameplay economy. | Green full suite, reviewed commits, manifest, rollout/rollback and day-one capture receipt. |

## Optional, after launch

| ID | Future enhancement | Boundary |
| --- | --- | --- |
| DC13 | Privacy-disclosed opted-in uploads of local practice/bot games | `unverified-client-practice` only; never equivalent to trusted Core-human play. |
| DC14 | Assisted tactical labels/MCTS analysis on the private game archive | New derived `valueTargetSource`, separate from genuine observed moves and human terminal outcomes. |
| DC15 | Dataset curation for future Impossible neural model | Frozen train/validation/holdout, champion-vs-Expert benchmark and quantization gate; owner must explicitly reactivate training. |

## Incremental commit plan

1. Commit threat model and fidelity tests (DC00–02). Do not change Core yet.
2. Commit schema and least-privilege/migration tests (DC03).
3. Commit terminal intent and idempotency tests (DC04).
4. Commit worker/reconciler/telemetry with synthetic and real-PG recovery (DC05–06).
5. Commit fixtures + privacy/deletion lineage (DC07–08).
6. Commit streaming exporter, dataset validator and benchmarks (DC09–11).
7. Commit release gate, final independent evidence and rollback notes (DC12).

At each checkpoint: source HEAD/commit SHA; exact changed paths; migration count; test counts/failures/skips; environment target; source hash; capture counts/status; privacy/deletion proof; retention/quota estimate; conflict/rollback instructions. Preserve Main/Codex local and remote work; never force-push or touch `main`/V4.1.

## Stop / reject conditions

- An online move can occur without Core authority, or capture incorrectly invents a player, game ID, played move, search visits, winner or value label.
- A capture write adds an external network call inside the game transaction, or a worker outage changes gameplay/economic correctness.
- A DB role outside the approved narrow projector/exporter can read subjects or change Core economic tables.
- A terminal source is pruned before a verified archive exists, or replay conflicts are overwritten without a quarantine record.
- The design creates a second source of economic truth, enables disabled Impossible, spends on cloud GPUs/providers or modifies production without an explicit separate release authorization.
- Privacy/legal purpose, opt-out/deletion, geographic retention or storage destination is invented instead of approved and recorded.

## Short acceptance scoreboard to maintain

| Evidence | Start state | Release target |
| --- | --- | --- |
| Immutable server-verified real human games | NOT IMPLEMENTED | Complete gameplay paths archived with no losses |
| Replay against `src/game.js` | Existing offline research validator only | 100% archived games independently legal |
| Captured terminal reasons and timing | Exists in operational tables | Exact, faithful, quality-labelled archival |
| Crash/retry/reconciliation | Existing generic outbox, not capture-specific | Exactly-once, restart-safe and backfill-safe |
| Privacy/deletion/export integration | General account workflow exists | Training archive and all shards covered |
| Production training / Impossible level | Owner-deferred | Still DEFERRED (not a release dependency) |
