# Day-one gameplay capture - living implementation record

Owner: WebUI. Base V5.1 `4e7d38584cde00dd4fe66fbd125470f6c8e74d19`. Feature branch `feat/v51-gameplay-data-capture`. Draft PR12 targets V5.1; Main alone integrates/deploys. Impossible and ALL neural training remain deferred. No V4, game rules, economy, ranks, themes, website or shared Core source was changed.

## Evidence checkpoint

`b7c18335d6f14827195a6be01f2c9e01b348e4f1` passed actual GitHub PG16/Node24 capture CI run38373759608. Retained artifact11799244557 SHA256 `3c3108befd051de253f2de356db213fd3b958bf314ac7fede5a7d65d39f95336`. This verifies full normal win/draw, direct/casual/ranked, resignation/timeout/void, repeated requests, scoped claims, expiry/fencing, missing intent reconciliation, source corruption, role denials and deletion/export invalidation. No staging or real player claim.

Earlier CI failures were fixed rather than hidden: initial schema creation ran after dropping migration privileges (fixed a558aa5); migration0034 intentionally preserves operational json rather than jsonb, including scalar receipt_reason (fixed b7c1833 with explicit decoding and casts, without changing originals). Follow-up99714b adds real process-kill/tournament/container-restart tests; its workflow initially referenced job.services from job-level env, which GitHub rejects. This checkpoint moves that reference to step env. Those new runtime tests require their own successful run before PASS.

Pure tests:31 capture/replay tests include200 complete canonical games;5 worker tests;4 authenticated-stream tests;5 deterministic export tests;4 privacy-journal tests;4 connection/release-gate tests. Exact combined CI totals supersede manual sums (the real PG file uses nested tests).

## Living checklist (DONE is the evidenced implementation scope, not production acceptance)

| ID | State | Evidence / residual |
|---|---|---|
| DC00 | PARTIAL | Feature scope and disabled defaults implemented. Owner/Main must approve actual purpose, capture/export/backup retention and storage/choice references. No invented legal approval. |
| DC01 | DONE | Actual Core/outbox/repository/privacy audit; existing0034 JSON types preserved. |
| DC02 | DONE | game-capture/v1 replay, exact b*9+c, actual symbols and timings, strict corruption bounds; line/draw separate from adjudicated/null value.200 full games tested. |
| DC03 | DONE | New0044-0046 private schema/functions, exact isolated roles, manifest, real PG apply/reapply and permission denials passed. Real deployment NOT_RUN. |
| DC04 | DONE | Deferred terminal database triggers run inside existing successful Core transaction and insert deterministic durable outbox intents; actual six-mode/outcome Core cases passed. No shared Core edit. |
| DC05 | DONE | Scoped/fenced worker, re-read/hash binding, seal+ack atomicity, quarantine/backoff, no Redis dependency. Logical expired lease passed; new actual SIGKILL test pending CI. |
| DC06 | PARTIAL | Keyset reconciliation, repair, source-drift quarantine, pruning guards, aggregate metrics implemented and PG tested. Real schedule/alerts and larger history load pending. |
| DC07 | PARTIAL | History-ordinal fixture extraction, symbol rematches and honest unavailable timing implemented. New four-attempt actual tournament test pending CI. |
| DC08 | PARTIAL | Deletion request trigger, private opt-out propagation, suppression/erasure/export revocation and encrypted journal implemented. Unit/PG subsets pass. Actual isolated journal replay, storage retention and user-facing choice delivery remain acceptance gates. |
| DC09 | DONE | Streaming encrypted archives + optional observed-position records, D4 family grouping, disk-backed state deduplication, stable seed, reserved qualification, lineage and privacy-fenced reader. Unit tests pass; real encrypted PG export/revocation added pending CI. No training execution. |
| DC10 | PARTIAL | Broad real PG capture acceptance green. Additional actual worker/process/database-restart and tournament tests now included; deployed staging/network/R2 acceptance remains NOT_RUN. |
| DC11 | PARTIAL | Paired-order move/settlement and200-full-game CPU/storage benchmark implemented; measured CI result pending. No guessed production SLA. |
| DC12 | PARTIAL | Guarded one-shot CLI, exact-role/TLS/target checks, release receipt gate and draft PR exist. Main integration, approvals and actual day-one canary remain open. |

## Shared integration boundary

Only the migration manifest and NEW0044-0046 numbered migrations affect shared platform integration. All earlier migrations are unchanged. No runtime grant widening. Capture functions use separate capture_runtime/capture_exporter/capture_privacy identities; API and Core cannot read training tables. Collection starts disabled; provisioning/activation is Main's separately approved operation.

The Core hook is a deferred database terminal trigger, not a second game service. Main must carry the full new migration chain, validate on a disposable clone, budget dedicated connections and install the private worker/reconciler/privacy/export-purge schedules. Existing workers must keep their explicit kind allowlists. The source is PostgreSQL; Redis notifications are neither capture triggers nor delivery authority.

## Important representation and scope boundaries

Match resignation/timeout overwrite state.winner; independent replay establishes boardWinner and never converts adjudication into a strategic loss value. Tournament history retains moves/players/outcome per attempt, but not every old timestamp. Use history ordinal, not a counter reset after drawn deciders; preserve unknown metadata rather than invent it. The repository deletes/reinserts fixtures during valid room saves, so pruning constraints are deferred.

Population defaults UNKNOWN unless private audited classification proves human versus bot/test. Unknown games are preserved privately but not mislabeled human training data. Raw actor lookup stays separate. utttai evaluated positions, synthetic examples and client practice cannot masquerade as observed online matches.

A development dataset withholds qualification trajectories, omits common initial positions from supervised records, and removes cross-split symmetry/transposition samples. Proof is for each immutable frozen export snapshot. Do not concatenate differently dated exports or reconstruct filtered training positions from archival games without re-running a joint leakage audit and privacy checks. No training consumer or automatic model approval is part of this work.
