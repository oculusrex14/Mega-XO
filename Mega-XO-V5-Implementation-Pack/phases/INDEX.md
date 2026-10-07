# Phase index

| Phase | Milestone | Work | Mode |
|---:|---|---|---|
| 0 | V5.0 | [Freeze baseline, scope and ownership](00-baseline-and-architecture.md) | EXECUTE |
| 1 | V5.0 | [Extract clean service and repository boundaries](01-service-boundaries.md) | EXECUTE |
| 2 | V5.0 | [Provision Neon and versioned PostgreSQL schema](02-neon-and-schema.md) | EXECUTE |
| 3 | V5.0 | [Build deterministic SQLite import and proof](03-sqlite-import-and-reconciliation.md) | EXECUTE |
| 4 | V5.1 | [Replace production persistence with PostgreSQL adapters](04-postgresql-runtime.md) | EXECUTE |
| 5 | V5.2 | [Implement actor-centric sessions and credential lifecycle](05-cross-platform-identity.md) | EXECUTE |
| 6 | V5.3 | [Introduce managed ephemeral coordination](06-managed-redis.md) | EXECUTE |
| 7 | V5.3 | [Make matchmaking safe across multiple processes](07-distributed-matchmaking.md) | EXECUTE |
| 8 | V5.4 | [Deploy revision-based durable realtime Game Core](08-durable-realtime-core.md) | EXECUTE |
| 9 | V5.4 | [Make tournament and lobby execution durable](09-durable-tournaments.md) | EXECUTE |
| 10 | V5.4 | [Extract reliable jobs, notifications and provider retries](10-durable-workers.md) | EXECUTE |
| 11 | V5.5 | [Deploy Vercel account and stateless control plane](11-vercel-control-plane.md) | EXECUTE |
| 12 | V5.5 | [Introduce safe read models and caching](12-read-models-and-cache.md) | EXECUTE |
| 13 | V5.5 | [Harden distributed trust boundaries](13-service-security.md) | EXECUTE |
| 14 | V5.5 | [Unify traces, metrics and alert delivery](14-observability.md) | EXECUTE |
| 15 | V5.6 | [Prove independent backups and disaster recovery](15-backup-and-disaster-recovery.md) | EXECUTE |
| 16 | V5.6 | [Add Core process redundancy and rolling drain](16-core-process-failover.md) | EXECUTE |
| 17 | V5.6 | [Complete independent component CI/CD and release gates](17-independent-ci-cd.md) | EXECUTE |
| 18 | V5.6 | [Complete the dedicated V5 staging platform](18-full-staging-acceptance.md) | EXECUTE |
| 19 | V5.6 | [Measure load, failure recovery and safe degradation](19-load-chaos-and-capacity.md) | EXECUTE |
| 20 | V5.7 | [Build, sign and validate Android and iOS applications](20-native-applications.md) | EXECUTE |
| 21 | V5.8 | [New megaxo.online website and browser product: deferred](21-new-website-deferred.md) | DEFERRED_BY_OWNER |
| 22 | V5.9 | [Execute final production authority transfer](22-production-transfer.md) | EXECUTE |
| 23 | V5.9 | [Retire obsolete V4 authority while retaining recovery evidence](23-retire-v4-authority.md) | EXECUTE |
| 24 | V5.10 | [Set scaling triggers and act only on measured demand](24-evidence-led-scaling.md) | MEASUREMENT_GATED |

Start with Phase 0. The first foundation gate comprises 0-3. Continue after that gate; this is not a permanent stop. Phase 21 is deferred by the owner, and the graph proceeds from 20 directly to 22. Phase 24 adds capacity only when measured triggers justify it.
