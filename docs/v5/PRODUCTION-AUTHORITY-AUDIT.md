# Mega XO Production Authority and Cutover Reconciliation Report

**Priority:** P0 Critical
**Status:** COMPLETED & RECONCILED
**Result:** **One Verified Production Authority (V4 / SQLite). Zero Conflicting Writers.**
**Audited Date:** 10 October 2026 (Live Oracle host and Neon inspection)

---

## 1. Executive Summary & Verdict

| Dimension | Live Finding | Basis & Evidence |
|---|---|---|
| **Active Production Authority** | **V4.1.2 / SQLite** (`/opt/mega-xo/data/mega.sqlite`) | Direct Oracle host inspection: WAL active, 5,056 support events, last write Oct 9 22:45 UTC. |
| **V5 / PostgreSQL Production Status** | **Dormant / Uncutover** (`written_data_bytes: 0`) | Neon API query for project `blue-sun-85454968`: endpoint `idle`/`suspended`, 0 written bytes. |
| **Writer Conflict Status** | **ZERO conflicting writers** | Exactly one writer exists: `mega-xo-production-app-1`. V5 has 0 production traffic and 0 writes. |
| **Public Serving Domain** | `https://play.antimatterinnovations.com` | Caddy reverse proxies to `app:8080`; `/livez` 200 `{"ok":true}`, `/opsz` 200 `{"ok":true}`. |
| **Root Cause of Contradiction** | Rehearsal vs Live Conflation | Tasks V5-22 and V5-23 were verified in **synthetic test harnesses** (`tests/v5-p22-cutover.test.js`), but ledger notes overclaimed that live V4 had been permanently retired on the host. |

---

## 2. Live Production Host Audit Evidence

Inspected live Oracle machine `openclaw-host` (`129.80.67.164`, Tailscale `100.64.128.46`, alias `command`):

### 2.1 Running Containers & Sockets
- **Edge Proxy:** `mega-xo-production-edge-1` (Up 2 days)
  - Owns public host ports `0.0.0.0:80` and `0.0.0.0:443`.
  - Upstream Caddyfile routes all traffic to `app:8080` with proxy secret.
- **Application:** `mega-xo-production-app-1` (Up 2 days, healthy)
  - Image: `ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`
  - Release SHA: `f1e5577d42809fc3da889ba76b87ca6c87e68575` (v4.1.2 with guest-auth prompt fix).
  - Environment: `MEGA_DB=/data/mega.sqlite`, `MEGA_ORIGIN=https://play.antimatterinnovations.com`.
  - Host mount: `/opt/mega-xo/data` bound to `/data`.
- **Backup Runner:** `mega-xo-production-backup-1` (Up 2 days).
- **Systemd Timers:** `mega-xo-health.timer` and `mega-xo-db-integrity.timer` actively executing.

### 2.2 Live SQLite Database Integrity & Mutation State
Querying `/opt/mega-xo/data/mega.sqlite` directly on `command`:
- **Files & Timestamps:**
  - `mega.sqlite`: 1,122,304 bytes
  - `mega.sqlite-shm`: 32,768 bytes
  - `mega.sqlite-wal`: 4,301,312 bytes (modified `2026-10-09 22:45 UTC`, active WAL writes).
- **Maintenance Status:** `v4_controls.maintenance = 0` (actively serving live traffic, NOT in maintenance mode).
- **Active Table Counts:**
  - `account_sessions`: 5
  - `commands`: 49
  - `community_limits`: 138 (active player rate limiting)
  - `v41_support_events`: 5,056 (live incoming player events)
  - `profiles`: 2
  - `email_credentials`: 2
  - `party_rooms`: 1
  - `v4_outbox`: 2

---

## 3. Neon Production PostgreSQL Status

Querying Neon organization `org-wandering-sea-53820697`:
- **Production Project:** `blue-sun-85454968` (`mega-xo-v5-production`)
- **Region:** `aws-us-east-1` (PG 16.15)
- **Endpoint:** `ep-mute-surf-b8v94ksa.c-14.us-east-1.aws.neon.tech`
- **Current State:** `idle` (suspended since `2026-10-08T02:00:31Z`)
- **Written Data Bytes:** **`0`** (zero writes)
- **Tables:** Empty default PostgreSQL catalog (0 player data tables)

---

## 4. Resolution of Contradictory Records

### 4.1 What Caused the Contradiction
In Phase 22 (`V5-22-01`–`V5-22-06`) and Phase 23 (`V5-23-01`–`V5-23-04`), the test suites `tests/v5-p22-cutover.test.js` and `tests/v5-p23-retire.test.js` verified the **cutover state machine contract and retirement rules in synthetic rehearsal environments** (`scripts/v5/p18/cutover-state-model.js`).

However, the ledger progress notes recorded these tasks as having executed live cutover on the production host, asserting:
- *"V4 writer permanently fenced; systemd/cron mutation paths eliminated."*
- *"V4 SQLite converted to read-only archive with immutable checksum."*
- *"G23 PASSED: V4 writer retired and fenced forever; single PostgreSQL authority active."*

These statements contradicted live reality because **no live cutover was executed against the Oracle production container or Neon production database**.

### 4.2 Reconciled Posture
1. **Live Authority:** V4 / SQLite remains the active, unfenced, and sole production authority.
2. **Conflicting Writers:** Confirmed **FALSE / NONE**. Because V5 is not deployed to the live production VPS and Neon production has 0 bytes written, there is zero risk of split-brain or overlapping writers.
3. **P22 / P23 Classification:** Tasks V5-22 and V5-23 represent **REHEARSAL_VERIFIED** software contracts, proving that the cutover state model, pre-write rollback class, and post-write PostgreSQL recovery class function correctly when cutover is triggered.
4. **Live Cutover Prerequisite:** The actual cutover of production traffic from V4 SQLite to V5 PostgreSQL requires an explicit operator-authorized maintenance window.
