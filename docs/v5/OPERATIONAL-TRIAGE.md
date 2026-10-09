# V5 Operational Triage & Alert Response Guide

**Milestone:** V5.5 | **Phase:** P14 (Observability, Telemetry & Triage) | **Gate:** G14  
**Scope:** Trace propagation, operational alert thresholds, player-safe support triage, and runbooks across `apps/api`, `apps/game-core`, and `apps/worker`.

---

## 1. Core Invariants & Architecture

Phase 14 establishes unified observability and operational response boundaries across all V5 distributed roles:

1. **Player-Safe Support Identity:** Errors exposed to players display a privacy-safe support code in format `MX-[A-Z0-9]{4}-[A-Z0-9]{4}`. This code carries sufficient entropy for operational correlation without encoding usernames, emails, actor IDs, IP addresses, or raw timestamps.
2. **Deterministic Trace Propagation:** Distributed requests propagate three standard HTTP headers:
   - `x-trace-id`: Distributed trace span identifier across API, Core, Worker, and DB.
   - `x-request-id`: Edge ingress request identifier.
   - `x-support-id`: Customer-facing support token.
3. **Zero Secret Leakage in Logs:** Structured JSON log formatters enforce automated recursive sanitization. Passwords, auth tokens, session cookies, OTP codes, ciphertexts, and private keys are redacted to `[REDACTED]` prior to serialization.
4. **Role-Specific Probing (`livez` vs `readyz` vs `opsz`):**
   - `/livez`: Evaluates process responsiveness.
   - `/readyz`: Evaluates immediate database pool connectivity.
   - `/opsz`: Evaluates deep operational pipeline health (backup freshness, worker stall, outbox backlog, and DLQ == 0).

---

## 2. Operational Alert Thresholds

The following thresholds govern automated alerts delivered to operator channels (Slack/PagerDuty/Webhooks):

| Alert Name | Metric / Condition | Severity | Description | Target SLA |
|---|---|---|---|---|
| **WorkerDeadLettersPresent** | `worker_outbox_dead_letter_count > 0` | **P1 - HIGH** | Messages in `ops.outbox` exhausted all retry attempts (`state = 'failed'`). Payloads sealed to `NULL`. | Triage within 15m |
| **WorkerLoopStalled** | `now - worker_last_heartbeat > 60s` | **P0 - CRITICAL** | Worker daemon has ceased processing outbox, finalization, or maintenance cycles. | Triage within 5m |
| **BackupStalenessAlert** | `now - last_backup_timestamp > 24h` | **P1 - HIGH** | Lakebase/Neon durable snapshot is older than 24 hours or backup metadata missing. | Triage within 30m |
| **DatabaseErrorRateSpike** | Database error rate `> 1%` over 3m window | **P1 - HIGH** | Connection pool exhaustion, lock contention, or query timeouts on PostgreSQL 16. | Triage within 15m |
| **OutboxBacklogHigh** | `worker_outbox_queued_count > 100` for 5m | **P2 - WARNING** | Message delivery queue backlog growing; downstream mail/notification provider delay. | Triage within 1h |
| **StoreFinalizationStall** | `worker_store_finalize_pending_count > 50` for 15m | **P2 - WARNING** | Google Play / App Store purchase acknowledgments accumulating without consumption. | Triage within 2h |

---

## 3. Player-Safe Support Triage Procedure (`MX-...`)

When a player reports an incident or receives a user-facing error dialog, they are provided an incident code such as:
```text
Support Code: MX-7E3K-9B1X
```

### 3.1 Privacy Guarantee
- The support ID format `MX-[A-Z0-9]{4}-[A-Z0-9]{4}` is generated from cryptographically secure random bytes (`crypto.randomBytes`).
- It contains **zero PII**, zero embedded timestamps, and cannot be reverse-engineered by players to discover internal IDs or database sequences.

### 3.2 Private Triage Procedure (Operators Only)
Operator triage tools are **strictly excluded from public ingress** (enforcing `isOperatorRoute()` 403 on public API edge). Operators invoke triage via secure administrative CLI or internal operator endpoints:

```javascript
const { triageSupportIncident } = require('@test-xo/services');

// Query using internal operator pool and service log aggregator
const incident = await triageSupportIncident('MX-7E3K-9B1X', {
  pool: operatorPool,
  logs: internalLogBuffer,
});

console.log(incident);
```

**Output format:**
```json
{
  "supportId": "MX-7E3K-9B1X",
  "found": true,
  "service": "worker",
  "component": "mail_outbox",
  "timestamp": "2026-10-10T14:32:01.120Z",
  "errorCode": "SMTP_RECIPIENT_REJECTED",
  "metadata": {
    "jobKind": "account_verify",
    "attemptCount": 3
  }
}
```

*Note:* All player personal identifiers (`email`, `username`, `phone`, `actorId`, `ip`, `tokens`) are automatically stripped and never exposed in the triage report.

---

## 4. Runbooks for Critical Alerts

### Runbook 1: Dead Letter Queue Present (`WorkerDeadLettersPresent`)

**Trigger:** `worker_outbox_dead_letter_count > 0`  
**Impact:** Transactional notifications or external updates failed permanently after exponential backoff.

#### Investigation Steps:
1. Inspect dead letter jobs via administrative interface:
   ```javascript
   const { createJobService } = require('@test-xo/services');
   const jobService = createJobService({ pool });
   const deadLetters = await jobService.listDeadLetters(50);
   console.table(deadLetters);
   ```
2. Check `last_error` and `kind` fields.
   - If error was caused by a transient downstream provider outage (e.g., SendGrid/Postmark 503):
     ```javascript
     await jobService.retryDeadLetter(deadLetterId);
     ```
   - If error was caused by an invalid recipient format:
     Verify that the dead letter payload is sealed to `NULL` (GDPR/privacy requirement). Leave job in terminal failed state.
3. Verify dead letter count returns to `0`:
   ```bash
   curl -s http://127.0.0.1:4000/opsz | jq .worker.dlq
   ```

---

### Runbook 2: Worker Loop Stalled (`WorkerLoopStalled`)

**Trigger:** `now - worker_last_heartbeat > 60s`  
**Impact:** Background processing halted. Outbox emails, store purchase finalizations, and scheduled maintenance cease running.

#### Investigation Steps:
1. Check container/process status:
   ```bash
   ps aux | grep apps/worker
   ```
2. Check PostgreSQL 16 active connections for long-running locks held by `worker_runtime`:
   ```sql
   SELECT pid, query, state, age(clock_timestamp(), query_start)
   FROM pg_stat_activity
   WHERE usename = 'worker_runtime' AND state != 'idle';
   ```
3. If an unrecoverable node event loop deadlock occurred, restart the worker daemon:
   ```bash
   # Systemd / Docker
   docker restart test-xo-worker
   ```
4. Verify recovery:
   Upon restart, the worker reacquires lock leases with monotonic tokens, processes queued items via `SKIP LOCKED`, and emits fresh heartbeats within 10 seconds. Check `/opsz` endpoint:
   ```bash
   curl -s http://127.0.0.1:4000/opsz | jq .status
   # Expect: "ok"
   ```

---

### Runbook 3: Backup Stale (`BackupStalenessAlert`)

**Trigger:** `now - last_backup_timestamp > 24h` or `opsz.backup.fresh == false`  
**Impact:** Recovery Point Objective (RPO) SLA violated. Disaster recovery snapshot exceeds 24 hours.

#### Investigation Steps:
1. Check the local or S3 backup metadata file (`backup_status.json`):
   ```bash
   cat /var/data/backups/backup_status.json
   ```
2. Verify Neon / Lakebase branch and snapshot states via Lakebase CLI:
   ```bash
   neonctl branches list
   ```
3. If automated daily snapshot did not complete, trigger immediate maintenance snapshot:
   ```javascript
   const { createMaintenanceScheduler } = require('@test-xo/services');
   const scheduler = createMaintenanceScheduler({ pool, now: Date.now });
   await scheduler.catchUp();
   ```
4. Confirm backup completion timestamp is updated to current time and `/opsz` reports `{ backup: { fresh: true } }`.

---

### Runbook 4: Database Error Rate Spike (`DatabaseErrorRateSpike`)

**Trigger:** Database query error rate `> 1%` over 3-minute window  
**Impact:** Client requests returning 500/503 errors; transaction aborts; degraded gameplay moves.

#### Investigation Steps:
1. Identify failing service role by querying role-specific `/readyz` probes:
   - `GET http://127.0.0.1:3000/readyz` (`api_runtime`)
   - `GET http://127.0.0.1:8080/readyz` (`core_runtime`)
   - `GET http://127.0.0.1:4000/readyz` (`worker_runtime`)
2. Inspect PostgreSQL connection limits and pool waiting counts:
   ```sql
   SELECT count(*), state, usename FROM pg_stat_activity GROUP BY state, usename;
   ```
3. If connections are exhausted:
   - Check for connection leaks (unclosed clients).
   - Review Neon connection pooler (PgBouncer) settings.
4. If Deadlock errors (`40P01`) or serialization failures (`40001`) are spiking:
   - Check conflicting updates on `economy.wallets`. Ensure operations follow consistent lock acquisition order.

---

## 5. Health Probes Contract Matrix

| Role | `/livez` | `/readyz` | `/opsz` |
|---|---|---|---|
| **`apps/api`** | Process event loop responsive | `api_runtime` DB pool connected; Redis read cache reachable | DB connected; error rate `< 1%` |
| **`apps/game-core`** | Realtime tick responsive (`< 50ms`) | `core_runtime` DB pool connected; WebSocket transport ready | Command outcomes healthy; tick lag `< 200ms` |
| **`apps/worker`** | Process event loop responsive | `worker_runtime` DB pool connected; schema migrations valid | Backup age `< 24h`; worker stall `< 60s`; DLQ `== 0`; backlog `< 100` |
