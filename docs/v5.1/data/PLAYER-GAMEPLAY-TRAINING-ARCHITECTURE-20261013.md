# Mega XOXO V5.1 — Day-one real-gameplay capture architecture

Status: DESIGN / NOT IMPLEMENTED. Decision date: 2026-10-13. Owner: independent WebUI engineering; schema and runtime execution must be serialized with the current V5.1 integration owner. Production is untouched.

## Decision in one sentence

Preserve every authoritative, completed V5 online match as a complete, verifiable game trajectory before launch, via an idempotent, worker-driven, privately stored archive; train nothing yet. Keep the original game/actor/economy authority unchanged.

## Verified source inventory

- Canonical legal game: `src/game.js`, which retains an ordered `state.moves` array of `{b,c,player}`; each legal move routes the next board. `src/authority.js:123-144` increments match revision, stores server-measured `_moveTimings`, and settles line/draw/resign/timeout/void with distinct reasons.
- Existing PostgreSQL: `packages/migrations/migrations/0012_match.sql` persists `match.matches.state_json`, revision, state/status, participant/symbol mapping, timestamps, `move_timings`, receipt and risk flags. `match.move_outcomes` is an idempotency ledger, NOT a complete decision-by-decision research dataset.
- `packages/migrations/migrations/0013_tournament.sql` has durable fixture state, revision, timing, history and outcome fields. Tournament fixture gameplay needs a separate extractor; do not mislabel its winner from a match receipt.
- `packages/services/core.js:458-479` commits the authoritative transaction and a sanitized `ops.outbox` event together. The event includes operation type and optional match ID. `packages/services/worker-workflows.js` already has durable, kind-scoped job processors.
- `training/bot/generate.cjs` and `training/bot/validate-data.cjs` implement canonical rules, legal masks, game-level splits and terminal labels for offline synthetic research. They are not wired to capture actual V5 users.
- `docs/v5.1/research/utttai-analysis.md` validated 16,005,010 upstream positions with compatible rules and canonical policy index `b*9+c`. That source is search-labelled POSITIONS, with no observed played move, game ID, complete game or terminal outcome. Never pass it off as human games.
- Existing policies: `docs/legal/DATA-INVENTORY-RETENTION.md` is a DRAFT; `packages/services/accounts.js` has export/deletion/tombstones; worker_runtime currently has no broad match/tournament read grants. Do not widen API/Core economic privileges for analytics.

**Gap:** Operational play data is already durable in the live-match model, but there is no purpose-built immutable, verified, privacy-aware real-player training archive, completeness audit, retention/deletion propagation or offline export. An eventual schema/export conversion cannot recreate a match if the source match record is later pruned. The day-one guarantee is NOT satisfied yet.

## Capture architecture

```text
Player web/native -> authenticated API or WSS -> Core command transaction -> PostgreSQL (sole truth)
                                                    |
                                                    +-- terminal-capture intent in ops.outbox
                                                                            |
                                                            kind-scoped trusted capture worker
                                                                            |
                                                     verify complete source + canonical replay
                                                                            |
                                                 private learning.capture_games + subject index
                                                                            |
                                                  encrypted, checksummed OFFLINE dataset export
                                                                            |
                                             future research/training on DGX (not during V5.1 launch)
```

### Guarantees and transaction boundary

1. Keep current `match.matches` and `tournament.fixtures` as the sole competitive authority. NO client analytics endpoint becomes an economic or game writer; browser telemetry cannot assert a real move or winner.
2. In the same successful Core transaction that first marks a match FINISHED or VOID with settlement, enqueue exactly one small, sanitized `learning.capture` outbox intent using a deterministic source identity (for example `learning.capture:match:<match_id>`). The actual archive does not run inside move/settlement latency. Do not emit on a mere WS ack or an idempotent replay. Terminal transitions may occur on a move, resignation, timeout or operator void; do not key the logic solely on a command name.
3. A dedicated kind-scoped worker rereads POST-COMMIT durable state, constructs the minimal game archive, verifies it, and commits the archive idempotently. Never claim another worker's jobs. A restarted worker can process a stale intent safely.
4. Add a bounded reconciliation sweep: independently discover terminal source records not yet archived, regenerate missing intents, and alert if a terminal record is pending too long. Source retention/pruning must not remove uncaptured eligible games. This repair path is essential even if Redis and notification delivery fail.
5. Prefer a tightly scoped SECURITY DEFINER projection returning only permitted match/fixture fields to worker_runtime, with fixed `search_path` and a narrow caller privilege. Do not grant generic SELECT on all identity/economy/match tables, share core_runtime credentials with the worker, or expose capture via public API/Vercel.
6. A repeated source key and identical content hash is a no-op; the same key with a different canonical hash MUST quarantine/alert (never silently overwrite an audited game). Backfill historical V5 staging records only with explicit provenance. No V4 production modifications.

### Proposed versioned storage (design, not yet SQL)

Migration 0044+ in the normal `packages/migrations/migrations` sequence, after checking the current tip and migration owner:

| Table | Key fields and purpose |
| --- | --- |
| `learning.game_captures` | PK `(source_kind, source_id, source_attempt)`; `schema_version`, `rules_hash`, `source_revision`, `source_sha256`, `payload_sha256`, `source_status`, `captured_at`, `quality_status`, `quality_flags`, `capture_jsonb`. Store the complete bounded trajectory and result; private server-only reads. |
| `learning.capture_subjects` | `(capture_id, actor_id, seat)` restricted reverse index for deletion/consent propagation. Never copy raw actor IDs to a public dataset. |
| `learning.capture_rejections` | Small bounded reason codes, source key, replay version, first/last attempt, retry/quarantine state. No raw passwords, profile, IP, auth headers or sensitive trace. |
| `learning.export_runs` | Dataset manifest ID, schema/validator version, source high-water mark, exact counts, exclusion reasons, SHA256, encryption/retention policy and deletion-purge watermark. No public export. |

Use bounded JSONB with strict constraints (81 maximum legal moves, expected index/length fields), indexes on source and capture status, immutable source/hash fields and an explicit controlled deletion/purge path. Access plan: Core keeps game authority; only a narrowly approved internal capture service writes the learning schema; no API role visibility; a restricted offline exporter reads only validated, privacy-eligible projections. Schema/grants are a new additive migration, not an edit to original 0012/0013 or to V4.

### Versioned archive document (`capture_jsonb`)

```json
{
  "schemaVersion": 1,
  "origin": "server-authoritative-human-match",
  "source": {"kind": "match", "id": "scoped-match-id", "attempt": 0, "revision": 54},
  "rules": {"id": "ultimate-3x3x3-v1", "sourceSha256": "pinned-src-game-sha256", "policyIndex": "board*9+cell"},
  "game": {"mode": "ranked", "firstSymbol": "X", "status": "FINISHED", "settlementReason": "line", "boardWinner": "X", "adjudicatedWinner": "X"},
  "moves": [{"ply": 0, "symbol": "X", "b": 4, "c": 2, "thinkMs": 3500}],
  "provenance": {"verification": "server-authoritative", "population": "human-v-human", "source": "core-v5", "qualityFlags": []}
}
```

Example is illustrative only: a real archive must have ALL 54 moves if revision is 54, not the one shown. Actor identity, email, device fingerprint, IP, chat, precise location, wallet balances, OTPs and access tokens are not part of this gameplay payload. A separate restricted participant index ties the archive to deletion/opt-out rights. Server timestamps, mode/rated/clock, outcome reason and source version live in bounded metadata. If a field does not exist, record null/unknown; never fabricate it.

### Source fidelity and validator

- Replay every observed `(b,c)` using canonical `src/game.js` from the stored first symbol. Derive every pre-move position, side to move, mini-board, required board and legal mask. Require that the actual move is legal. Never trust a client-supplied move list over Core.
- Require contiguous ply numbers and no duplicates, `state.moves.length === match.revision` (for supported match records), consistent stored board/mini/turn/winner, valid symbol-to-actor mapping, bounded move timings, and source/receipt consistency. A match with inconsistent data is quarantined, NEVER repaired silently.
- Distinguish (a) board decided by three macro boards, (b) genuine full-board draw, (c) resign, (d) timeout/no-show, (e) void/refund, (f) unfinished. Keep all these records for integrity where policy permits, but mark which may be used for specific labels.
- For a legal line/draw ending, terminal value for an earlier ply is `+1/0/-1` from THAT ply's side-to-move perspective. For resignation/timeout, the account winner is an ADJUDICATED winner and NOT proof that the board was strategically winning: exclude from terminal-board value supervision by default. Void/unfinished are not outcome-value labels. Preserve observed human move separately from any later search-derived policy label.
- Game policy target from humans is observed action (one-hot/behavior) only. It is NOT a strong search visit distribution or an optimal move. Future research may add new MCTS labels in separate derived artifacts with explicit `valueTargetSource`.
- Source X-starts are compatible with the upstream utttai X-first data; do not invent an O-first match. Augment rotations/reflections only after complete-match replay and preserve each game's validation split.

### Population and selection

- Launch-critical capture: server-authoritative human-v-human Ranked, Casual and rated/unrated direct matches, including legitimate early exits. If supported, include the tournament fixture path with separate source identity and full replay.
- Preserve source category (`human-v-human`, `server-bot`, `client-reported-practice`, `test-fixture`, `unknown`), verified gameplay and result reason. Server-generated demo/smoke actors, QA tests, developer fixtures, suspicious farming/collusion and intentionally seeded bots MUST NOT silently join a clean human training corpus. A human is not automatically a strong teacher.
- Local/offline practice is not authoritative Core play. Do not misrepresent it as verified human gameplay. A later OPTIONAL, privacy-disclosed upload flow may accept consented practice traces tagged `unverified-client-practice`; these are excluded from release-quality datasets until separately reviewed. Avoid uploading full local browser storage.
- Preserve coverage of skill bands, both symbols, opening families, clocks, modes, match lengths, move depth, board routing and results. Use a documented sampling plan to prevent beginners, short resignations and high-volume pairs from dominating the corpus.

### Privacy and retention are launch gates, not afterthoughts

- Update the data inventory, privacy copy, user choice/legal review and Apple/Google declarations BEFORE enabling new training-purpose collection. The existing legal inventory is still a DRAFT. Match play data tied to a pseudonymous ID can remain personal data. Do not promise indefinite training use.
- Do not include email, tags, display names, IP, auth/session/CSRF, precise geography, financial amounts or chat in the training dataset. Keep actor-to-game links ONLY in a tightly restricted deletion/consent index. Encrypt private archives and offline exports at rest and in transit.
- Respect account deletion and any applicable opt-out: invalidate capture eligibility, delete/replace affected private captures where required, regenerate/revoke affected exported shards/manifests, and maintain a deletion watermark checked before EVERY training/export. Protect backups with the approved expiry and post-restore deletion replay.
- Do not put any private player record, actor lookup index, exported dataset, model input trace or sensitive incident payload in Git, public CI artifacts, console output or a Vercel static site. Define bounded, owner/legal-approved retention windows; do not invent one in code.

### Safe future training export

Produce two distinct artifacts: (1) game-level archive manifest with signed/checksummed provenance; (2) streamed training rows reconstructed at each pre-move state using our own `src/bot/encoding.js` (648 planes/81 legal cells), `playedMove`, game ID, opening family, player turn, truthful outcome, and `valueTargetSource`. Keep `utttai` EXTERNAL position-only supervision completely separate.

All positions from the same game and all rotational/reflection variants stay in one split. Record a deterministic frozen split/seed and reserve an untouched future qualification set; additionally test repeated opponents/players, season and time-window leakage before claiming generalization. Model labels and research/validation/holdout data must have disjoint provenance; never average terminal outcomes with search root values. Dataset export should be deterministic/streaming, hash-pinned and independently replay-validated; do not train models as part of the data-capture rollout.

## Release acceptance criteria (day-one non-negotiable)

1. Two authenticated staging accounts complete a full match, a resignation and timeout; each produces exactly ONE sealed, replay-valid capture with correct actual outcome reason and symbol map. Also exercise double-submission, concurrent retries, Core/worker restart, Redis outage and repeated outbox processing.
2. Zero additional critical-path network dependencies; authorized match moves still commit if the capture worker/offline store is stopped. A dead capture worker creates observable backlog, never silently lost training records. Measured added move/settlement latency must stay within the existing P19 performance budget.
3. For every server-authoritative accepted capture: no missing/illegal plies, no invented terminal labels, `source hash == archive provenance`, no unverified synthetic actor masquerading as real human, and aggregate counts reconcile with eligible settled source matches (document exclusions explicitly).
4. The sanctioned privacy/deletion job can identify all affected archive rows and exported shards, purge/revoke them, and prove they stay erased/excluded after a simulated backup restore.
5. Strict DB role denial tests: API, unauthenticated client and unrelated worker cannot read private training captures or subject lookup; no economy writer grants widened. A full staging security/CI smoke and exact SHA/manifest receipt pass.
6. The live V5 cutover checklist explicitly blocks launch if capture acceptance is not passed or if legal-purpose/retention approval is missing. No model promotion, public Impossible or DGX training is required for this gate.

## Explicit non-goals

No gameplay/economy/rank/theming change; no extra user-facing telemetry requirement, behavioral advertising, realtime analytics SDK, cloud inference or ML training. No public object bucket or third-party paid provider. No V4 production modification. This document is a specification; every SQL/schema/service/privacy change still needs its own reviewed, tested commit.

## Sources

- `docs/v5.1/research/utttai-analysis.md` and `docs/v5.1/research/utttai-converter-20261013.md`
- `docs/v5.1/research/DEFERRAL-20261013.md` (owner pauses training and Impossible)
- `src/game.js`, `src/authority.js`, `packages/services/core.js`, `packages/services/worker-workflows.js`
- `packages/migrations/migrations/0012_match.sql`, `0013_tournament.sql`, `0017_privacy_support_audit.sql`, `0022_grants_worker.sql`
- `training/bot/generate.cjs`, `training/bot/validate-data.cjs`
- `docs/legal/DATA-INVENTORY-RETENTION.md` and `packages/services/accounts.js`
- Upstream: https://github.com/arnowaczynski/utttai (repository Apache-2.0; separate dataset-specific grant still needs confirmation before redistributing external data)
