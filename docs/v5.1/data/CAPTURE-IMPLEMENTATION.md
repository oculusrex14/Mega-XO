# Day-one gameplay capture implementation

Owner: WebUI. Base: `4e7d38584cde00dd4fe66fbd125470f6c8e74d19`. Branch: `feat/v51-gameplay-data-capture`. Owner's October 13 feature-branch and training-deferral instructions supersede the older trunk-only/training instructions. Main owns integration and deployment; this branch will only propose a PR, not merge or deploy.

## Source audit and decisions

Read the architecture, implementation pack, utttai analysis/converter, deferral, original match/tournament migrations, canonical rules, Core, jobs, repositories and account deletion. Existing operational matches carry complete moves. Match resignation/timeout deliberately overwrite `state.winner`: replay must distinguish the genuine board result. Tournament `history_json` keeps every finished attempt's players/moves/reason/winner; fixture attempt counters can reset and players swap on drawn deciders. Use history ordinal, not the resettable counter, as archival attempt identity. Old tournament histories lack individual timestamps/timings; record unknown, not invented values. Their source revision is not a move count.

Only PostgreSQL is authoritative; never depend on Redis for collection. Source SHA/file hashes come from a read-only CI source receipt because local github.com DNS is unavailable. Existing migration tip is 0043. Public utttai evaluated positions are not games and remain excluded. Current APIs do not prove humans rather than bots/test accounts: default population is UNKNOWN until private, audited classification; retain trajectories but do not label them clean human training data by inference.

DC04 will use an additive terminal-row database trigger, inside the already existing successful Core transaction, rather than changing shared Core source. It inserts only a small deterministic `learning.capture` outbox intent. Replay/archive work stays in a dedicated worker. Tournament row replacement requires a deferred pruning guard, not a BEFORE DELETE rule that would break legitimate room saves. No game/economy/rank/theme change.

## Living checklist

| ID | State | Evidence / remaining |
|---|---|---|
| DC00 | PARTIAL | Scope fixed; real privacy/purpose/retention/storage authorization remains a release blocker. Default disabled; no invented retention. |
| DC01 | DONE | Current source/grants/outbox/repository/deletion audit and threat boundaries above. |
| DC02 | DONE | `packages/learning/capture.js`; `node --test tests/gameplay-capture.test.js`: 31 pass, 0 fail, 0 skip on local Node22.16; 200 complete canonical games including genuine draws. Initial two malformed tests were no-op mutations; corrected to mutate an actual value and reran all tests. |
| DC03 | NOT_RUN | Additive learning schema and exact-role grants, disposable PG validation pending. |
| DC04 | NOT_RUN | Terminal intents pending. |
| DC05 | NOT_RUN | Kind-scoped fenced capture worker pending. |
| DC06 | NOT_RUN | Reconciliation/pruning guards/metrics pending. |
| DC07 | PARTIAL | History-only archive representation tested; actual tournament extractor pending. |
| DC08 | NOT_RUN | Deletion, user-choice, retention, lineage and restore suppression pending. |
| DC09 | PARTIAL | Canonical pre-move encoder iterator exists; private deterministic exporter pending. |
| DC10 | NOT_RUN | CI/staging complete service journeys pending. |
| DC11 | NOT_RUN | Latency/storage benchmark pending. |
| DC12 | PARTIAL | Isolated read-only source CI established; explicit rollout gate pending. |

The archive forbids unknown fields, raw subject IDs in the gameplay body, impossible moves, altered boards/routing, invalid timing/symbol mappings and invented board outcomes. Restricted actor lookup is separate. Observed human actions are not search visits. Adjudicated games have null board-value labels. Native/browser telemetry, external positions and local practice are not eligible authoritative inputs.

No production data, environment secrets, raw player capture, training job or approved model is created by these commits. CI source receipts contain tracked source only and are not deployment packages.
