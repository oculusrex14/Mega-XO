# P3 public signed Core edge — DEPLOYED and verified (2026-10-13)

**Decision (owner):** custom `core.megaxo.online` via the authoritative DNS provider routed through the
existing Oracle Caddy HTTPS ingress to the isolated signed V5 Core gateway. Tailscale Funnel abandoned
(upstream bug; see `CORE-EDGE-ATTEMPT-20261013.md`). `antimatterinnovations.com` is parent-company
reserved; game target architecture uses `megaxo.online` exclusively.

## Topology
```
Vercel stateless API (mega-xo-api)  --HTTPS + HMAC-->  core.megaxo.online:443
  -> Oracle Caddy edge (mega-xo-production-edge-1, additive site block)
       path /ingress/*  ->  172.18.0.1:8096   (host, production `backend` bridge gateway)
       path *           ->  404
  -> scripts/v51/core-edge-proxy.cjs  (loopback+private filter; only /ingress/* forwarded)
       -> 127.0.0.1:8085  (single existing staging Core instance; one Redis queue namespace)
            -> Neon `mega_xo_v5_staging` (core_runtime role)
```

## What was done
| # | Action | Evidence |
|---|---|---|
| 1 | Saved `megaxo.online` zone (`.artifacts/p3-dns/megaxo.online-zone-before.json`); appended `A core -> 129.80.67.164` with `--overwrite=false` (no existing record touched) | zone list before/after; `dig` = 129.80.67.164; V4 `A @` unchanged = 2.57.91.91 |
| 2 | `scripts/v51/core-edge-proxy.cjs` — loopback-only `/ingress/*` filter (404 otherwise); added `--allow-private-bind` for the Docker bridge gateway, wildcard always refused | proxy started on `172.18.0.1:8096`; `/`→404, `/ingress/leaderboard`→Core |
| 3 | Network boundary: scoped firewall rule `ufw allow from 172.18.0.0/16 to any port 8096` (Caddy edge only). No new public port; DB/internal/staging ports untouched | container→proxy works (404/401); loopback→8096 refused; public 129.80.67.164:8096 refused; ufw rule scoped to backend subnet |
| 4 | Snapshotted live Caddyfile (`Caddyfile.v4-snapshot-1791912067`); appended independent `core.megaxo.online` site block; `caddy validate` = Valid; restarted edge | validate output; block is additive and separate from `{$MEGA_HOSTNAME}` |
| 5 | Verified HTTPS + cert + V4 | `core.megaxo.online/` = 404; Let's Encrypt CN=core.megaxo.online (exp Jan 11 2027); **V4 `play.antimatterinnovations.com` `/` = 200 and `/livez` = 200** after the change |
| 6 | HMAC verification against the PUBLIC edge | 11/11 (below) |
| 7 | Vercel staging wiring (Preview + Development only; **production untouched**) | real Vercel→Core request returns live data (below) |

## HMAC verification — 11/11 (public `https://core.megaxo.online`, host harness, secret never printed)
| Case | Result |
|---|---|
| valid HMAC → `/ingress/leaderboard` | **200** + real leaderboard rows |
| missing signature | 403 `INVALID_SERVICE_SIGNATURE` |
| forged signature (wrong key) | 403 `INVALID_SERVICE_SIGNATURE` |
| expired timestamp (>30s drift) | 401 `REQUEST_EXPIRED` |
| replay (identical valid request ×2) | 200 both, identical body (idempotent aggregate read) |
| command path with empty actor | 403 |
| `GET /` | 404 (website not exposed) |
| `GET /api/v1/health` | 404 (API not exposed) |
| `GET /auth/session` | 404 |
| `POST /api/v1/queue` | 404 |

## Real Vercel → Oracle Core request (closes the P3 blocker)
Preview `https://mega-xo-gik7maifp-oculusrex14s-projects.vercel.app`
`GET /api/v1/leaderboard` → **200** with live staging data (12 rows; smoke actors Alice/Bob), i.e. the
stateless API signed with `MEGA_PROXY_SECRET` and reached the Core through `core.megaxo.online`.
Captured: `.artifacts/p3-core-edge/vercel-to-core-leaderboard.json`.

## Signing key custody
`MEGA_PROXY_SECRET` added to the Vercel project as a **sensitive** env var (Preview + Development),
piped from the host secret file and never printed. Same 64-hex key as the host Core (`core-gateway.secret`).
**Production env not set.** No production traffic, no V5 database cutover, no production deploy.

## Rollback
- Core edge: restore `/tmp/mega-release-f1e5577/deploy/Caddyfile.v4-snapshot-1791912067` and restart the
  edge container (`core.megaxo.online` then fails closed); `tailscale funnel --https=8443 off` already done.
- DNS: delete the `core` A record (zone snapshot retained) via a single `hostinger dns records delete`
  or restore the zone snapshot.
- Vercel: `vercel env rm MEGA_CORE_URL preview` / `MEGA_PROXY_SECRET preview` (no redeploy required to
  remove; production never had them).

## Residual / not done here
- Production Vercel env intentionally untouched (set at cutover).
- V4 `play.antimatterinnovations.com` retained as the browser-game facade (see
  `V4-DOMAIN-MIGRATION-AUDIT-20261013.md`); the V5 new website remains owner-deferred.
