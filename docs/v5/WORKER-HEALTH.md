# V5 Service Health Checks, Metrics, and Operational Alerts

**Milestone:** V5.4 | **Phase:** P10 (Durable Workers) | **Task:** V5-10-05
**Scope:** Operational monitoring, role separation, health probe contracts, and alerting thresholds across `apps/worker`, `apps/game-core`, and `apps/api`.

---

## 1. Architectural Role Separation

V5 enforces strict separation of concerns across service boundaries to prevent resource contention, eliminate dual-scheduler race hazards, and isolate latency-sensitive user paths from background I/O.

```
+-----------------------------------------------------------------------------------+
|                                  PostgreSQL 16                                    |
|   ops.outbox  |  monetization.store_finalize  |  economy.*  |  season.*  | ...   |
+-----------------------------------------------------------------------------------+
       ^                                  ^                                  ^
       | worker_runtime                   | core_runtime                     | api_runtime
+----------------------+         +----------------------+         +----------------------+
|     apps/worker      |         |    apps/game-core    |         |       apps/api       |
|                      |         |                      |         |                      |
| * Outbox jobs & mail |         | * Realtime gameplay  |         | * Stateless account  |
| * Store finalization |         | * Matchmaker loop    |         | * Profile & social   |
| * Season maintenance |         | * Economic authority |         | * Practice archive   |
| * Privacy retention  |         | * WebSocket tickets  |         | * Read projections   |
|                      |         |                      |         |                      |
| [EXCLUSIVE SCHEDULER]|         | [NO BG SCHEDULERS]   |         | [NO BG SCHEDULERS]   |
+----------------------+         +----------------------+         +----------------------+
```

### 1.1 Disabling Legacy Duplicate Schedulers in Game Core

In V4 / legacy deployments (`server/production/main.js`, `server/jobs.js`), the Game Core process hosted multiple background timers on its primary event loop:
- `fast` (1,000 ms): Invoked `outbox.tick()` (email sending) and `service.monetization.processPurchaseFinalizations()` alongside matchmaker and room ticks.
- `slow` (15,000 ms): Invoked `maintenance(service.store)` (season/leaderboard/daily/weekly snapshots) and `outbox.cleanup()` / retention purges.

**In V5, all background schedulers and loops are completely removed from `apps/game-core`:**
1. **Background mail and outbox delivery loops DO NOT run in Game Core.** Mail is enqueued transactionally into `ops.outbox` by Core or API producers; delivery is claimed and executed exclusively by `apps/worker`.
2. **Store purchase finalization loops DO NOT run in Game Core.** Core records durable receipts and grants in `monetization.receipts`; provider consumption and acknowledgement calls to Google Play / App Store are handled exclusively by `apps/worker` via `monetization.store_finalize`.
3. **Daily snapshots and weekly payout schedules DO NOT run in Game Core.** Scheduled maintenance is driven exclusively by `packages/services/maintenance-scheduler.js` hosted inside `apps/worker`. When the worker triggers maintenance, it invokes Core's idempotent command boundary (`snapshot` / `weekly`) as the authorized operator principal `{actor: 'maintenance', scope: 'operator'}`.
4. **Privacy and retention sweeps DO NOT run in Game Core.** Data retention purges on `ops.outbox` and lapsed ephemeral rate buckets are managed exclusively by `apps/worker`.

### 1.2 Rolling Deployment Overlap Invariant

During a rolling deployment where a legacy-compatible node and a new V5 `apps/worker` run concurrently against the same PostgreSQL database:
- **Mail:** PostgreSQL `FOR UPDATE SKIP LOCKED` on `ops.outbox` ensures distinct workers claim disjoint sets of jobs. Each queued email is delivered exactly once without duplicates.
- **Store Finalization:** Monotonic lease tokens (`lease_token`) and row-level locks on `monetization.store_finalize` prevent duplicate provider contact. State transitions cleanly to `done`.
- **Maintenance & Season:** Core command outcomes (`economy.command_outcomes`) keyed by stable UTC period identities (`snapshot:<day>`, `weekly:<week>:<today>`) deduplicate concurrent executions. Exactly ONE snapshot map, ONE payout row, and ONE wallet credit occur.
- **Privacy & Retention:** Cleanup queries (`DELETE ... WHERE ...`) execute concurrently without deadlocks or operational conflicts.
- **Invariant:** Exactly ONE business effect occurs across all domains even during overlapping deployments.

---

## 2. `apps/worker` Operational Specification

`apps/worker` is the dedicated background daemon responsible for outbox delivery, store finalization, scheduled maintenance, and retention cleanups.

### 2.1 Health Probes and Signals

`apps/worker` exposes internal health signals and an administrative loopback health check:

| Probe | Type | Verification | Failure Mode |
|---|---|---|---|
| **Liveness (`/livez`)** | Process responsiveness | Checks process uptime, event loop lag (< 1,000 ms), and that no unhandled rejection has faulted the daemon. | Process restart triggered by container supervisor. |
| **Readiness (`/readyz`)** | Work intake ability | Verifies active database connection pool (`worker_runtime`), verifies schema readiness (all required migrations applied), and checks that the worker is not currently draining/stopped. | Withhold traffic or task scheduling. |
| **Operations Health (`/opsz`)** | Background pipeline integrity | Validates loop heartbeat freshness (< 60s), successful lease acquisition/renewal, and absence of critical pipeline stalls. | Triggers operator PagerDuty / alert notification. |

#### Key Health Signals
1. **Database Connectivity:** Evaluates a lightweight query (e.g., `SELECT 1`) on the `worker_runtime` connection pool every tick. Connection drop or pool exhaustion marks the worker degraded.
2. **Lease Renewal & Progression:** Evaluates that active claims hold valid monotonic lease fences (`lease_token`) and that expired leases are reclaimed appropriately without deadlock.
3. **Loop Heartbeat:** A timestamp (`last_heartbeat_timestamp`) updated at the completion of every tick cycle (single-flight execution). If the gap exceeds 60 seconds, the loop is considered stalled.

### 2.2 Key Metrics

The worker service emits structured telemetry and Prometheus-compatible metrics under the `worker_` namespace:

| Metric Name | Type | Description | Target / Healthy Value |
|---|---|---|---|
| `worker_outbox_queued_count` | Gauge | Number of unprocessed mail/work items in `ops.outbox` with `state = 'queued'`. | `< 20` during steady state. |
| `worker_outbox_dead_letter_count` | Gauge | Number of failed items in `ops.outbox` with `state = 'failed'` (attempts >= maxAttempts). | `0` (any value > 0 requires triage). |
| `worker_store_finalize_pending_count` | Gauge | Count of pending Google Play / Apple store finalizations in `monetization.store_finalize` with `state = 'pending'`. | `< 10` during steady state. |
| `worker_last_scheduler_tick_timestamp` | Gauge | Epoch millisecond timestamp of the latest successful daily/weekly maintenance scheduler tick. | Updated at least once per UTC day; catches up on restart. |
| `worker_tick_duration_ms` | Histogram | Duration of each worker tick pass (expire + retention + rate buckets + mail batch). | p95 `< 500 ms`. |
| `worker_mail_sent_total` | Counter | Total successfully delivered email messages. | Monotonically increasing. |
| `worker_mail_delivery_failed_total`| Counter | Total failed email delivery attempts (retries and terminal failures). | Monotonically increasing, rate near 0. |
| `worker_retention_purged_rows_total`| Counter | Total expired outbox rows purged by retention sweeps. | Periodic increments. |

### 2.3 Operational Alerting Thresholds

| Alert Name | Condition / Expression | Severity | Impact | Runbook / Immediate Action |
|---|---|---|---|---|
| **WorkerDeadLettersPresent** | `worker_outbox_dead_letter_count > 0` | **P1 - HIGH** | Undeliverable emails or notifications (poison pills, invalid recipients, provider rejection). Payloads sealed to NULL. | Inspect via `jobService.listDeadLetters(50)`. Determine if transient or bad data. If transient provider issue, replay via `jobService.retryDeadLetter(id)`. |
| **WorkerOutboxBacklogHigh** | `worker_outbox_queued_count > 100` for 5m | **P2 - WARNING** | Message delivery delay. Potential email provider rate limiting or network latency. | Verify mail provider status (SendGrid/Postmark/Resend). Inspect `worker_mail_delivery_failed_total` rate. Check database connection pool saturation. |
| **WorkerLoopStalled** | `now - worker_last_heartbeat > 60s` | **P0 - CRITICAL** | Worker daemon ceased processing all outbox, finalization, and maintenance tasks. | Inspect container logs for unhandled errors or synchronous thread blocking. Verify PostgreSQL database availability. Restart worker container if unresponsive. |
| **StoreFinalizationBacklog** | `worker_store_finalize_pending_count > 50` for 15m | **P2 - WARNING** | Store purchases remain unacknowledged or unconsumed; risk of provider auto-refunds after 3 days. | Check Google Play Billing API quota/credentials. Verify receipt grant pipeline in `monetization.receipts`. Run `listPendingFinalizations()` to inspect stuck records. |
| **SchedulerTickDelayed** | `now - worker_last_scheduler_tick_timestamp > 86400s` | **P1 - HIGH** | Daily leaderboard snapshot or weekly settlement not executing on schedule. | Trigger manual catch-up pass via `scheduler.catchUp()`. Inspect Core logs for lock contention on maintenance commands. |

---

## 3. `apps/game-core` Operational Specification

`apps/game-core` is the authoritative state machine for realtime gameplay, matchmaking, room/tournament lifecycle, and economic mutations.

### 3.1 Role Scope and Scheduler Disablement

- **In-process background schedulers are strictly disabled.** No email dispatching, store consumption loops, or periodic maintenance cron runs in this process.
- **Connection pools:** Uses `core_runtime` exclusively; does not touch worker outbox leases or rate bucket deletion.
- **Match ticks:** Dedicated 1,000 ms loop focused exclusively on `service.matchmaker.tick()` and `service.rooms.tick()`.

### 3.2 Health Probes and Signals

| Probe | Type | Verification | Failure Mode |
|---|---|---|---|
| **Liveness (`/livez`)** | Process heartbeat | Event loop responsive; memory within container quota. | Container restarted by Docker / Kubernetes. |
| **Readiness (`/readyz`)** | Match ingress readiness | PostgreSQL `core_runtime` pool connected; Redis ticket/presence channel operational; room store hydrated. | Traffic removed from load balancer routing. |
| **Realtime Health (`/realtime/v1/health`)** | WebSocket subsystem | Confirms WebSocket upgrade handler is bound and accepting ticketed connections. | Realtime fallback routing activated. |

### 3.3 Key Metrics

| Metric Name | Type | Description | Target / Healthy Value |
|---|---|---|---|
| `core_active_matches` | Gauge | Count of ongoing rated and unranked games currently in memory/authority. | Dependent on traffic (e.g. 0–500). |
| `core_websocket_connections` | Gauge | Count of active client WebSocket connections to the game server. | Dependent on active user concurrency. |
| `core_tick_duration_ms` | Histogram | Duration of each matchmaking sweep and room settlement cycle. | p95 `< 50 ms`, max `< 200 ms`. |
| `core_command_execution_ms` | Histogram | Time taken to process authoritative moves and state commands against PostgreSQL. | p95 `< 15 ms`. |
| `core_matchmaker_queued_tickets` | Gauge | Number of active matchmaking tickets waiting for pairing. | `< 200` (bounded by `maxTickets`). |

### 3.4 Operational Alerting Thresholds

| Alert Name | Condition / Expression | Severity | Impact | Runbook / Immediate Action |
|---|---|---|---|---|
| **CoreTickDegraded** | `core_tick_duration_ms{quantile="0.95"} > 200ms` for 2m | **P1 - HIGH** | Gameplay latency, delayed move responses, match timer skew. | Check PostgreSQL query latency for command outcomes. Inspect CPU utilization on Core host. |
| **WebSocketDisconnectSpike** | Rate of abrupt socket closures `> 100/s` | **P1 - HIGH** | Mass disconnect of active players; network partition or proxy termination. | Inspect edge load balancer (Caddy/Cloudflare) logs and TLS certificates. Check host network saturation. |
| **MatchmakerStalled** | `core_matchmaker_queued_tickets > 100` and pairing rate = 0 for 2m | **P2 - WARNING** | Players stuck in matchmaking queue without being paired. | Inspect matchmaker tick errors. Verify Redis presence / queue state. |

---

## 4. `apps/api` Operational Specification

`apps/api` provides the stateless HTTP interface for account management, authentication, profile/social interactions, practice game archives, and read-side projections.

### 4.1 Role Scope

- **Completely Stateless:** Holds no durable timers, background intervals, or worker queues.
- **Connection Pools:** Operates under `api_runtime`. Authorized to read player state, manage account credentials, and enqueue work into `ops.outbox` via standard SQL INSERT. Holds no authority to modify wallets or mutate game balances directly.

### 4.2 Health Probes and Signals

| Probe | Type | Verification | Failure Mode |
|---|---|---|---|
| **Liveness (`/healthz`)** | HTTP response | Returns HTTP 200 `{ ok: true }` if node process is running. | Process restart. |
| **Readiness (`/api/v1/ready`)** | Dependency health | Executes `SELECT 1` on `api_runtime` pool; validates Redis read-cache access. | Node drained from HTTP gateway. |

### 4.3 Key Metrics and Alerting Thresholds

| Metric Name / Alert | Condition / Expression | Severity | Impact | Runbook / Immediate Action |
|---|---|---|---|---|
| `api_http_request_duration_ms` | p95 latency `> 250ms` for 5m | **P2 - WARNING** | Degraded user experience on login, profile, and inventory views. | Check database read query performance; check connection pool waiting count. |
| **ApiHigh5xxErrorRate** | HTTP 5xx responses `> 1%` of total traffic for 3m | **P1 - HIGH** | User authentication or profile operations failing. | Inspect application error logs. Check database connection limits on Neon. |
| **ApiPoolSaturation** | `api_pool_waiting_clients > 10` for 1m | **P1 - HIGH** | Connection starvation on PostgreSQL. | Increase connection pool size or investigate long-running read transactions. |

---

## 5. Operations & Incident Runbook Summary

### 5.1 Dead Letter Recovery Procedure
When `WorkerDeadLettersPresent` triggers:
1. Connect to production or worker administrative shell.
2. Query dead letters:
   ```javascript
   const deadLetters = await jobService.listDeadLetters(50);
   console.table(deadLetters);
   ```
3. Examine the `last_error` and `kind` fields for each job.
4. If failure was caused by transient external outage (e.g., mail provider downtime resolved):
   ```javascript
   await jobService.retryDeadLetter(deadLetters[0].id);
   ```
5. If failure was caused by invalid recipient address or corrupt payload, record diagnostic event in support log and leave job in terminal failed state (payload is already sealed to `NULL`).

### 5.2 Worker Loop Stall Recovery
When `WorkerLoopStalled` triggers:
1. Verify container process status (`docker compose ps worker` or Kubernetes pod status).
2. Check PostgreSQL active queries for locks held by `worker_runtime`:
   ```sql
   SELECT pid, query, state, age(clock_timestamp(), query_start)
   FROM pg_stat_activity
   WHERE usename = 'worker_runtime' AND state != 'idle';
   ```
3. If a query is blocked or exceeding timeout, investigate lock blockers.
4. Restart worker service container:
   ```bash
   docker compose restart worker
   ```
5. Following restart, worker will automatically catch up on pending outbox items and resume single-flight interval execution.
