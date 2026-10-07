# Execution order and milestone gates

The original architecture contains several summaries with different minor-version labels. This pack uses its **last milestone table, lines 2439-2451**, and the detailed Phase 0-24 IDs. Milestone labels describe work; they are not instructions to publish a release tag for every phase. Release tags and app build numbers follow a separate explicit version policy.

## Dependency path

```text
0 baseline / CI / ownership
  -> 1 boundaries -> 2 Neon/schema -> 3 deterministic migration proof
  -> 4 PostgreSQL runtime -> 5 shared identity
  -> 6 managed Redis -> 7 distributed matchmaking
  -> 8 realtime Core -> 9 tournaments -> 10 durable worker
  -> 11 Vercel API -> 12 reads/cache -> 13 security -> 14 observability
  -> 15 backups/restore -> 16 Core process failover -> 17 full CI/CD
  -> 18 integrated staging -> 19 load/chaos -> 20 real native apps
  -> 22 production authority transfer -> 23 retire V4 writer
  -> 24 measured review / conditional scaling

21 new website/browser product = DEFERRED_BY_OWNER (not a dependency of 22)
```

## Milestone interpretation

| Milestone | Phases | Required result |
|---|---:|---|
| V5.0 Foundation | 0-3 | Baseline preserved; CI active; schema and source migration proved |
| V5.1 Persistence | 4 | V5 runs on PostgreSQL, not SQLite |
| V5.2 Identity | 5 | Shared actor/session/ticket model |
| V5.3 Distributed state | 6-7 | Managed ephemera and concurrency-safe matchmaking |
| V5.4 Game Core | 8-10 | Durable live games/tournaments and jobs |
| V5.5 Hybrid cloud | 11-14 | Vercel control plane, safe reads, security and diagnosis |
| V5.6 Reliability | 15-19 | Proven recovery, process failover, releases, staging and capacity |
| V5.7 Cross-platform | 20 | Real signed Android/iOS targets and accurate provider/device evidence |
| V5.8 Web | 21 | Intentionally deferred; technical foundations delivered earlier |
| V5.9 Production | 22-23 | One production PostgreSQL authority and V4 retirement |
| V5.10 Scale | 24 | Measured triggers and justified capacity only |

## Work that starts earlier than its completion milestone

Basic V5 CI, source/UI baselines and environment inventory start in Phase 0. Database staging and integration CI start in Phase 2. Security/telemetry are included in every service as it is extracted; Phases 13/14 close the cross-service acceptance. Backups are configured before real data is put at risk; Phase 15 proves independent reconstruction. Native toolchain/identifier discovery starts in Phase 0, and scaffold compilation may start after shared contracts/identity are stable. Phase 20 is full native integration and device acceptance, not a reason to defer discovering an Xcode problem until the last week.

This order avoids simultaneously inventing the database, identity and distributed runtime. Parallel work may begin once its interfaces are stable and does not bypass the referenced gates. Keep one migration/contract integration owner. Test or native-host subagents may use separate feature branches/worktrees; no shared-worktree concurrent edits or unreviewed schema conflicts.

## Meaningful commit protocol

For every task: inspect current progress and code; implement one cohesive change; run targeted tests; run relevant regression/contract suites; update evidence/progress; commit with a task ID; push and inspect CI; then advance. Suggested message shape: `V5 P03: preserve persisted store bindings in importer`. A failing test is recorded and fixed, not hidden by altering expected game rules. Large phases should have multiple commits.

Suggested first six checkpoints: baseline/scope/provenance documents; V5 CI trigger and unchanged tests; route/data ownership inventory; pure-domain and repository interfaces; Neon schema/roles integration; deterministic importer and reconciliation fixtures. The actual commit boundaries follow meaningful tested changes, not arbitrary line counts.

Maintain `docs/v5/PROGRESS.md`, `DECISIONS.md`, `OPEN-ITEMS.md`, and structured progress/evidence. On restart, read these plus Git status/log/CI before resuming. Never assume a task completed merely because its source file exists. Distinguish code, tests, real devices, external approval and production enablement.

## Handling gaps and scope

Resolve provider/local evidence with the available authenticated tools. A real error should name the exact action, target and missing permission/configuration, not a generic third-party blocker. Continue independent work. Preserve existing approved policy and UI; report factual evidence gaps without reopening product design.

Do not hardcode this review's branch SHA as forever current. Re-resolve latest green V4.1 once at entry, record it, then pin all work to the selected integration base. Do not follow later upstream changes silently during migration; adopt them via reviewed commits and regenerate parity evidence as needed.

All tasks begin unexecuted in `tasks.json`. The dependency graph intentionally omits Phase 21 as a prerequisite to production. The stop condition is a truthful delivery of the in-scope platform, actual native artifacts/acceptance and production state, with precisely recorded external pending items and no claim that the deferred product was built.
