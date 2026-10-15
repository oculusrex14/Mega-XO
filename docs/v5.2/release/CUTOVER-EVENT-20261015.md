# Production Cutover Event: Mega XO V5 Authority Transfer

**Date:** 2026-10-15  
**Time:** 04:13:22 UTC  
**Authority Epoch:** `v5:1792037113917:153a8543d555682d`  
**State:** `ACCEPTED` (Durable single authority on Neon PostgreSQL)  
**Execution Base:** Commit `bb659df3951f251c6b1aee09d94943714b7e9b0d` (branch `V5.2`)  
**Authorization:** Owner explicit instruction: *"Cutover is explicitly authorised once you deem it ready, no issues from my side."*

---

## 1. Summary of Actions Taken

1. **Quiesce & Fence V4 SQLite Writer:**
   - Stopped Docker container `mega-xo-production-app-1` with 30s graceful timeout.
   - Set container restart policy to `no` (`docker update --restart=no mega-xo-production-app-1`).
   - Verified container state: `Exited (0)`.
   - Captured final post-stop SQLite WAL checkpoint & archive:
     - Path: `/opt/mega-xo/cutover-archive/v4-final-fenced-20261015T040452Z.tar.gz`
     - SHA-256: `f6c5fbea57dd0ee3538abd1f70845011809d31568173fef2983041471242e90d`
     - Size: 362,443 bytes (8570 total rows across 35 tables; 2 real actors; verified off-box with `PRAGMA integrity_check=ok`).

2. **Arm V5 Authority Service on Host:**
   - Database: Neon PostgreSQL `blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production` (55 migrations applied).
   - Redis: Aiven Managed Redis `prdb4781` namespace (`mx:prd:prdb4781:`).
   - Authority Epoch: `v5:1792037113917:153a8543d555682d`.
   - Target configuration updated: `nonserving: false` in `docs/v5/environments/production.json`.
   - Systemd Service: `mega-xo-v5-production.service` enabled and started on Oracle host.
   - Serving Status: `serving: true`, bound to `172.18.0.1:8080`.
   - Production Web Bundle: deployed from current V5.2 build to `/opt/mega-xo-v5-production/web-build`.

3. **Switch Caddy Edge Ingress:**
   - Updated `/tmp/mega-release-f1e5577/deploy/Caddyfile` line 27:
     `reverse_proxy 172.18.0.1:8080` (replacing legacy `reverse_proxy app:8080`).
   - Edge container `mega-xo-production-edge-1` restarted and active.
   - Traffic for `https://play.antimatterinnovations.com` seamlessly routed to V5.

4. **Automated Disaster Recovery (Backups):**
   - Automated 5-minute R2 encrypted backups active via `mega-v5-backup.timer` and `mega-v5-backup.service`.
   - Neon continuous PITR active.

---

## 2. Public Surface Verification (Observed Live)

| Endpoint | Method | Response Code | Observed Payload / Behavior |
|---|---|---|---|
| `https://play.antimatterinnovations.com/livez` | GET | `200 OK` | `{"status":"ok","live":true,"ready":true,"time":1792037602479}` |
| `https://play.antimatterinnovations.com/readyz` | GET | `200 OK` | `{"status":"ok","live":true,"ready":true,"time":1792037614023}` |
| `https://play.antimatterinnovations.com/health` | GET | `200 OK` | `{"status":"ok","live":true,"ready":true,"time":1792037683891}` |
| `https://play.antimatterinnovations.com/api/v1/leaderboard?metric=rating&limit=5` | GET | `200 OK` | `[]` (PostgreSQL query, cached headers) |
| `https://play.antimatterinnovations.com/.well-known/assetlinks.json` | GET | `200 OK` | Valid Android App Links JSON |
| `https://play.antimatterinnovations.com/.well-known/apple-app-site-association` | GET | `200 OK` | Valid Universal Links JSON |
| `https://play.antimatterinnovations.com/` | GET | `200 OK` | Complete V5 powered web application bundle |

---

## 3. Rollback Policy After Cutover

Per V5 Invariants:
> *"First post-import production application write, including auth/background/webhook writes, ends SQLite rollback eligibility. Thereafter preserve PostgreSQL authority and forward-fix or use a tested PostgreSQL-compatible previous build."*

- **Rollback Class:** `FORWARD_FIX_ONLY`.
- SQLite authority is terminated.
- In case of incident, use PostgreSQL Point-In-Time-Recovery (PITR) or restore from the continuous R2 snapshots in `mega-xo-v5-dr-archives`.
- The final V4 SQLite snapshot `f6c5fbea57dd0ee3538abd1f70845011809d31568173fef2983041471242e90d` remains preserved on the Oracle host at `/opt/mega-xo/cutover-archive/` for permanent auditability.
