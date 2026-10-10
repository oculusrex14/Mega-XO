# P24 — evidence-led capacity and scaling handoff

**Status:** source-only PREPARATION, `G24 OPEN` · **Prerequisite:** genuinely accepted G23 after P22 cutover/retirement · **Canonical branch:** `co-dev/v5-integration` ([draft PR #9](https://github.com/oculusrex14/Mega-XO/pull/9)).  
**Current primary checkpoint:** G00–G08 accepted; P09 active; V4 Node/SQLite is still production authority. No postlaunch population, production saturation test or accepted real-user forecast exists in the co-dev evidence. **No paid services, server sizes or network topology changed.**

## Why P24 is measurement-gated

The original [Phase 24 program](../../Mega-XO-V5-Implementation-Pack/phases/24-evidence-led-scaling.md) explicitly says not to create extra infrastructure until demand, cost, safety and rollback evidence justify it. The prior [P19 co-dev work](P19-LOAD-CHAOS.md) measured disposable local PostgreSQL/Redis adapters on tiny synthetic fixtures, **not** real Vercel/API/Core/Oracle/Neon socket demand or sustainable player capacity.

The delivered P24 modules are pure, offline decision-support contracts. Even a synthetic *perfect* owner packet never grants a deploy or G24 acceptance. Do not treat a reference to a metric artifact as independent proof it was collected correctly. In particular:
- **G23 must be accepted** along with G00–G20 and G22. P21 is explicitly deferred and not a prerequisite.
- Baseline fields default **UNKNOWN** (null), never fabricated zero or derived from P19's eight-client illustrative load tiers.
- No threshold, cost estimate, review window, operator approval or extra capacity is auto-filled.
- A declared complete production baseline and claimed threshold event are always labeled **UNVERIFIED** and **REVIEW ONLY**.
- This code cannot deploy, scale, provision, disable V4, modify Neon, purchase capacity, resize Redis or change Vercel domains.

## V5-24-01 — measured baseline and review cadence

**Source:** `scripts/v5/p24/capacity-baseline.js` · **Tests:** `tests/v5-p24-capacity-baseline.test.js`.

Exactly ten source-scoped aggregate signals must be accounted for; any unknown data has `value:null, sampleCount:0, fullyObserved:false, evidenceRef:null`. Named signals have a unit, upper bound, evidence reference, time interval and completeness measure, not player/match/token identifiers.

| Signal (unit) | Owner component | First diagnostic / baseline requirement |
|---|---|---|
| `api_p95_ms` (ms) | Vercel/API | HTTP route mix, auth and regional network time; review p50/p95/p99 and error rate separately |
| `core_move_p95_ms` (ms) | Oracle Core | Combined queue/wait + PostgreSQL command/lock latency; distinguish CPU vs DB waits |
| `ws_active_connections` (count) | Core transport | Both instances, reconnect/disconnect/backpressure, headroom and ingress failure domain |
| `queue_wait_p95_ms` (ms) | matchmaking | Population/mode density and active queue wait; not automatically a server capacity limit |
| `pg_pool_used_pct` (%) | Neon PostgreSQL | Sum Core A+B, API, worker, migrations/backups, connection headroom and lock wait |
| `pg_lock_wait_p95_ms` (ms) | Core/PostgreSQL | Actual lock-order and index/transaction hotspots with historical table size |
| `worker_oldest_pending_s` (s) | Core worker | Durable ops.jobs age, retry/dead-letter, provider inbox lag and handler throughput |
| `redis_memory_used_pct` (%) | managed Redis | TTL, eviction, memory, pubsub delay and rate; never persistent economic authority |
| `host_cpu_pct` (%) | Oracle host | Core + worker + Caddy + co-host services together, sustained utilization and peaks |
| `host_memory_pct` (%) | Oracle host | RSS/cgroup pressure/OOM, headroom for backups and current V4 co-host workload |

**Additional non-capacity safety monitors remain mandatory** under [spec 06](../../Mega-XO-V5-Implementation-Pack/specs/06-CI-SECURITY-AND-OPERATIONS.md): Core/WebSocket p99 and errors, PostgreSQL storage and slow queries, Redis evictions and availability, purchase/SSV failures and retries, outbox DLQ/audit integrity, and independent backup age/restore outcome. A backup failure is an **incident**, not permission to scale a database blindly.

**Proposed cadence (requires owner approval):** weekly at launch and after every topology/traffic step change; monthly only after a stable measured period and approved monitoring. The policy template defaults to a 7-day review, not a system-scheduled job. Each review should capture deployment SHA, time window, synthetic/production provenance, collector coverage and gaps, p50/p95/p99, throughput, active clients/matches, failures, resource limits, safety monitor status, and the operator decision. Explicitly mark missing observations UNKNOWN.

## V5-24-02 — trigger, smallest remedy, cost, validation and rollback

**Source:** `scripts/v5/p24/scale-policy.js` · **Tests:** `tests/v5-p24-scale-policy.test.js`.

Each signal has one fixed conservative first action. A configured rule MUST include a positive finite numeric threshold within the unit's safe range, **at least 15 minutes** of sustained overload, an immutable measurement-query reference, a concrete bounded monthly incremental cost, and a rollback-proof reference. Actual numbers come from owner-approved real baselines and the chosen provider plan: no production default p95 target or price is invented.

| Signal | First permitted review action | Validate before/after | Rollback direction |
|---|---|---|---|
| API p95 | `PROFILE_API_READ_PATH` | Profile routing/cache/read-only projections with real traffic | Revert compatible query/cache path, preserve Core writes |
| Core move p95 | `PROFILE_CORE_MOVE_PATH` | Measure Core CPU vs row-lock/DB wait before replica/resource changes | Previous tested Core image/limits; never rewind durable PG results |
| WebSocket connections | `REVIEW_INDEPENDENT_INGRESS_HOST` | Test separate host + independent ingress and actual host-failure cutover before claiming HA | Route to known-good Core/ingress without another writer |
| Queue wait | `PROFILE_QUEUE_AND_MATCHER` | Rule out match-population scarcity; measure real queue demand | Restore prior bounded worker config without deleting durable queue |
| PG pool utilization | `REBALANCE_BOUNDED_DB_POOLS` | Recalculate **total** Neon/transaction-pool budget, reserve migrations/backup headroom | Revert pool fanout and limits while preserving DB |
| PG lock wait | `EXPLAIN_LOCKS_AND_INDEXES` | Review query plans, lock order, indexes under representative data | Revert compatible read/index change without touching ledger |
| Worker oldest age | `REVIEW_FENCED_WORKER_CAPACITY` | Inspect retries, provider outages, fencing and idempotent consumption | Reduce worker count via drain; keep claimed jobs durable |
| Redis memory | `AUDIT_REDIS_TTLS_BEFORE_RESIZE` | Inspect TTL/eviction/namespace and Redis-loss recovery before plan upsizing | Revert size only with safe headroom; no permanent game state in Redis |
| Host CPU | `MEASURE_HOST_CPU_AND_REBALANCE` | Profile co-hosts/Caddy/Core/worker; measure spare failure capacity | Restore prior compatible CPU limits/placement |
| Host memory | `MEASURE_HOST_RSS_AND_REBALANCE` | Examine bounded socket buffers, per-process RSS/OOM and co-host headroom | Revert compatible memory limits/placement without a kill cascade |

**Guardrails:** ONE PostgreSQL economic/competitive writer authority, Redis ephemera only, permanently fenced V4 SQLite after P22, no global multi-primary Crown balances, no generic Kubernetes/Kafka deployment, and **Core A+B on one Oracle host is NOT host HA**. A second host, independent ingress or read-only PostgreSQL projection is a separate costed architecture change that needs proven failure domains, rather than an automatic consequence of a threshold.

For every suggested upgrade, the owner must record a provider quote or official billing plan, expected monthly spend/cost envelope, capacity and SLO target, compatible version/region/data locality, staged no-side-effect load proof, rollback owner/runbook, control-plane permissions and an approval/change ticket. A rule's Boolean `operatorApproved:true` is insufficient without specific references, and the review still does not execute it.

## V5-24-03 — evidence-only decision, not speculative provisioning

**Source:** `scripts/v5/p24/scaling-review.js` · **Tests:** `tests/v5-p24-scaling-review.test.js`.

An observed threshold only reaches **`REVIEW_CANDIDATE`** after all of:
1. G23 with accepted prerequisite lineage, a complete declared real-production baseline **no more than 30 days old and not from the future**, and a configured budget/rollback/owner-approved rule;
2. at least **three adjacent** source- and scope-matched real-production metric windows at/above the threshold for the rule's minimum continuous duration;
3. complete metric inventory, each signal's reported sample count at least 20, and **no telemetry gaps** during that sustained period;
4. most recent interval ending within **15 minutes** of the supplied review instant, with no overlapping/future timestamps, forged references, synthetic substitution or source mismatch.

Otherwise the output is `BLOCKED_G23_NOT_ACCEPTED`, `NOT_TRIGGERED_...` or an explicit owner-approval queue. The strongest result is still `DECLARED_TRIGGER_REQUIRES_INDEPENDENT_APPROVAL_AND_DEPLOYMENT`. Every possible output includes `productionMutationAuthorized:false`, `actualScaleApplied:false`, `g24Accepted:false` and `independentHostHAProven:false`.

**For the actual deployer:** after independent human review of corroborated metrics and approved cost, perform the smallest reversible change in a separately authorized operational session, test current-head runtime and recovery behavior, then record pre/post metrics, change ticket, spend, rollback and alerts. If the threshold is never reached, **do nothing and record NOT_TRIGGERED**; keeping the initial architecture is an intentional compliant outcome.

## Operator commands (safe and offline)

```sh
# Working tree head only; prints UNKNOWN baseline/NULL policy scaffolds, no file writes:
node scripts/v5/p24/review-cli.js --templates "$(git rev-parse HEAD)"

# Optional LATER: local, sanitized aggregated telemetry packet only.
# .artifacts/p24-review.json is untracked; never include raw sessions or credentials.
node scripts/v5/p24/review-cli.js --review "$(git rev-parse HEAD)"

# Pure tests (no provider credentials or database needed):
node --test tests/v5-p24-*.test.js
```

The fixed review file path `.artifacts/p24-review.json` must contain exactly `{"format":"mega-v5-p24-review-input/v1","nowUtc":"...","baseline":null,"policy":null,"intervals":[]}` initially. The CLI then reads the checked-out **`docs/v5/progress.json`**; external input cannot provide a different ledger. For later observations replace the nulls with `mega-v5-p24-capacity-baseline/v1` and `mega-v5-p24-scale-policy/v1` packets matching the exported templates and model fields, and supply `mega-v5-p24-scale-interval/v1` aggregate windows. Bind all to the same exact 40-character source SHA; immutable `artifact://v5/p19/...` or `artifact://v5/p24/...` references are labels pending independent retrieval verification, not proof by themselves. The CLI refuses symlinked, non-file, oversized or arbitrary paths and never accesses a provider.

## Testing, CI and owner acceptance

- `tests/v5-p24-capacity-baseline.test.js`: unknowns, synthetic isolation, timestamps/source identity, duplicate/incomplete metrics and impossible values.
- `tests/v5-p24-scale-policy.test.js`: ten minimal domain actions, duration/threshold/budget/rollback requirements and prohibition of unfunded HA/multi-primary assumptions.
- `tests/v5-p24-scaling-review.test.js`: accepted-G23 lineage, fresh contiguous real windows, negative cases for stale/missing/overlapping data, source mismatch and no auto-scale.
- `tests/v5-p24-review-cli.test.js`: source-bound templates, fixed local-only reads, symlink/oversize/path-escape safety.
- `tests/v5-p24-workflow.test.js`: adversarial PR event, checkout/ref, privileged token, missing watchlist and false-green checks.
- `tests/v5-cross-phase-integration.test.js`: shared P17 regression enforces P24 watches P19 changes, G23 ledger/evidence and Core/PG/deploy topology.

`.github/workflows/v5-p24-scale-readiness.yml` is read-only/pinned and runs on **both** V5 pushes and PRs. It checks out the exact PR head instead of a synthetic merge SHA, requires zero-failure/zero-skip source tests, checks its real owner ledger and contains no credentials, Docker/provisioning, deploy jobs or production access.

**Source-level validation on this branch:** 35/35 fetched P24 test bodies passed a V8 harness with stubbed Node built-ins/virtual filesystem, and 7/7 cross-phase check bodies passed an analogous harness. This is **NOT** real Node24 GitHub Actions, PostgreSQL/Redis staging, true telemetry collection or independent budget validation. The GitHub runner-allocation incident remains tracked in [CI incident](CI-RUNNER-INCIDENT-2026-10-09.md).

**G24 acceptance remains OPEN:** owner must first finish P09–P23 including P19 real staging/production envelope and G23, independently verify live metrics and cost/rollback triggers, publish the review cadence, run the exact-head CI, and either record **NOT_TRIGGERED** or approve and measure one bounded change. P21 website remains deferred.

**No service was provisioned, restarted, resized, upgraded, or billed by this co-development work.**
