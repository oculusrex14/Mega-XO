# V5 authority armed, first write recorded, production smoke and ops checks (2026-10-15)

The final cutover step: V5 started, the authority epoch and the first production application write
recorded, and the production surface plus the backup/alert chain exercised.

## Authority identity

| Field | Value |
| --- | --- |
| Authority epoch | **`v5:1792037113917:153a8543d555682d`** (`/opt/mega-xo-v5-production/state/authority-epoch.txt`) |
| Service | `mega-xo-v5-production.service` → `ActiveState=active`, `SubState=running` |
| Binding | `172.18.0.1:8080` behind the co-located Caddy edge |
| Database | Neon `blue-sun-85454968` / `mega_xo_v5_production`, 55 migrations |
| Redis | Aiven managed, namespace `mx:prd:prdb4781:` (isolated from staging by derivation) |

## The first production application write

`identity.signing_keys` holds exactly one row:

| kid | environment | state | created_at |
| --- | --- | --- | --- |
| `mxv5-prd-2026Q4-1-79` | `prd` | **active** | `2026-10-14T02:44:56.263Z` |

This is the deliberate switch the production entry point refuses to boot without
(`EXISTING_SIGNING_KEY_CUSTODY_REQUIRED`) and never mints implicitly: the operator's access-service
bootstrap created it with the private half already sealed in `keys.sealed.json`. Per the invariants,
this first application write ends SQLite rollback eligibility; the rollback class is now
forward-fix-only on PostgreSQL.

## Production smoke — every public endpoint, real HTTPS

| Endpoint | Status |
| --- | --- |
| `/` | `200` (the generated V5 bundle) |
| `/livez` | `200 {"status":"ok","live":true,"ready":true}` |
| `/readyz` | `200 {"status":"ok","live":true,"ready":true}` |
| `/health` | `200` |
| `/opsz` | `200 {"ok":true}` — backup-aware and queue-aware, not a liveness echo |
| `/api/account/session` | `200 {"linked":false,…}` — a real PostgreSQL session |
| `/api/v1/leaderboard?metric=rating&limit=5` | `200 []` through the production pool |
| `/.well-known/assetlinks.json` | `200` valid JSON |
| `/.well-known/apple-app-site-association` | `200` valid JSON |
| `/nope.jsx` | **`404`** — a real 404, not an SPA fallback |

## Backup and alert checks

| Check | Result |
| --- | --- |
| `mega-xo-v5-backup.timer` | active; last run `2026-10-15T05:07:05Z`, next in ~2 min (5-minute cadence) |
| R2 receipt format | `mega-v5-p15-r2-upload-readback/v1`, with `readbackCheckedAtUtc` — upload + independent readback, not a mere upload |
| `mega-xo-v5-freshness.timer` | active; `{"state":"fresh",…,"consecutiveUnhealthy":0}` |
| Forced alert delivery | a forced stale backup flipped the host monitor to `unhealthy` and **delivered** the alert; restoring produced the recovery alert. The Resend key path defect found by this test was fixed (`8b4220c`). |

## Standing limits (unchanged, restated)

- No real rewarded ad has been served on any platform (`MegaAds.isReady('rewarded')` is false on this
  network).
- The Vercel API is live and PostgreSQL-backed, but `api.megaxo.online` still has no DNS record and its
  `MEGA_CORE_URL` is a placeholder, so its Core-facing routes are not wired.
- No store submission, no provider-approved commerce, no host-level HA proof (two same-host Core
  processes are process failover, not host HA).
