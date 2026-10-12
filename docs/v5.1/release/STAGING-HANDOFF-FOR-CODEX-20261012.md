# V5.1 isolated staging origin - Codex handoff (2026-10-12)

Main agent. This is the running isolated V5.1 **pre-production** origin, ready for browser/native
acceptance work. It is **not** a production cutover and does not touch live V4.

## What is running

| Fact | Value |
|---|---|
| Git commit (deployed source) | `c71a3be` (branch `V5.1`) |
| Server entrypoint | `scripts/v51/p21-staging-server.cjs` |
| Process | one Node loopback process (isolated; no Docker, no public 80/443, no V4 containers) |
| Neon database | `mega_xo_v5_staging` (project `lively-shadow-52629967`, nonserving, 43 migrations applied) |
| Redis | Upstash staging, isolated `mx:stg:<keyVersion>:*` namespace |
| Roles | `api_runtime` (API) and `core_runtime` (Core/queue), separately bound and verified |
| Outbound providers | email / store notifications / ad rewards all **disabled** (target-file enforced) |
| Indexing | `X-Robots-Tag: noindex, nofollow` on every response |

## URLs

- **Website (local):** `http://127.0.0.1:8081/` - serves `apps/web` (the game shell + bot/tutorial).
- **API (local):** `http://127.0.0.1:8081/api/v1/...` (plus `/auth/*`, `/.well-known/*`, `/realtime/v1`).
- **Realtime:** `ws://127.0.0.1:8081/realtime/v1` (direct WebSocket; HTTP fallback snapshot paths too).

This host is a Mac mini on Tailscale. To reach it from another tailnet device (e.g. Codex's browser),
restart the server bound to the tailnet IP (explicit, never a wildcard):

```sh
MEGA_V51_STAGING_SERVER=lively-shadow-52629967/mega_xo_v5_staging \
  node scripts/v51/p21-staging-server.cjs --port 8081 --host <TAILNET_IP> --allow-host <TAILNET_IP>
```

Then the origin becomes `http://<TAILNET_IP>:8081/` for any tailnet peer (e.g. the DGX at
`100.101.152.92`). It is not published on the public internet and has no TLS - treat it as a private
staging origin.

## Access instructions

- The website loads immediately at `/`. Anonymous play and the bot/tutorial work with no sign-in.
- Public reads already work: `GET /api/v1/leaderboard` returns the real signed Core projection.
- **Sign-in caveat (important, R15):** no HTTP session/email route is mounted yet. The browser calls
  `POST /api/account/session` (anonymous bootstrap) and `POST /api/account/email` (email OTP), which
  the **V4 production perimeter** provides and the V5 API does not yet mount. Until that route is
  added, a browser cannot obtain a session over HTTP, so online play/native sign-in cannot be driven
  from the website - local tests use the service-issued synthetic sessions instead. This is the exact
  remaining V5 website↔API composition gap; do not treat the missing route as a service outage.
- `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` are served for native
  association work.

## Verified on this origin

- Website shell `200` (`mx-web-shell`), `app.js`/`bot-compat.js` `200`.
- `GET /livez` `200`; unauthenticated `GET /api/v1/queue` `401` (honest); `GET /api/v1/leaderboard`
  `200` with the real projection; `/operator` `403 PRIVATE_OPERATOR_ROUTE`; path traversal serves the
  SPA shell, never files outside `apps/web`.
- The full acceptance smoke against the same real Neon + Upstash passes **flows 1-11** (migrations,
  schema, roles, static web, native P05 JWT, profile read/update, economic read/write privilege,
  leaderboard, social graph, native queue admission/cancel) and stops at **flow 12** with
  `12_accept_refusal 409 OFFER_EXPIRED` - the measured cross-region Neon latency, not a route defect
  (a co-located accept is ~18 ms vs the preserved 15 s offer TTL).

## Boundaries

- No production change, no V4 restart, no public ingress, noindex enforced, providers disabled.
- No secrets are printed by the server; credentials stay in the encrypted private evidence dir.
- Model publication and production cutover remain approval-gated.
