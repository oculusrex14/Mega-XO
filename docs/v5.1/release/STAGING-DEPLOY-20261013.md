# P1 staging website deployment — verified served bytes (2026-10-13)

Deployed the current V5.1 source + freshly generated P21 bundle to the isolated Oracle staging
origin and verified the **served bytes over the public HTTPS origin**, not just a local build.

## Identity

| Fact | Value |
| --- | --- |
| Source commit (deployed) | `9628ed78f214eef984caba2f610396b7630346c0` (V5.1) |
| Bundle `source_commit` | `9628ed78f214eef984caba2f610396b7630346c0` |
| Bundle `sha256` | `2887b0cd9723513792af01d71412ee94040f2f2dcfc9277a52fe7612733eb9e6` |
| File count | 153 (was 140 — old `f4851a5` bundle) |
| Total bytes | 3,542,005 |
| Generator | `scripts/p21/build-web.js` |
| Deploy script | `scripts/v51/deploy-staging.cjs` (new) |
| Staging root | `/opt/mega-xo-v51-staging/{repo,p21-web}` on Oracle host `command` |
| Origin | `https://command.tail95c48c.ts.net` (tailscale serve → 127.0.0.1:8085) |
| Server | `scripts/v51/p21-staging-server.cjs`, tmux session `v51stg` |

## Served-byte verification (fetched from the HTTPS origin, not local)

- `web-build.manifest.json` → `source_commit 9628ed7`, `bundle_sha256 2887b0cd…`, `file_count 153` — matches the deploy receipt.
- `/` → 200 (36,269 b shell); `/livez` → 200.
- Module/asset paths with real byte counts: `/legacy-game/src/game.js` 200 (4,565 b), `/legacy-game/src/bot/worker.js` 200 (1,248 b), `/store-links.js` 200 (126 b), `/legal-documents.js` 200 (20,422 b), `/assets/art/mark.webp` 200 (14,040 b), `/pages/game.html` 200 (31,897 b), `/pages/ranked.html` 200 (14,316 b).
- Missing asset `/legacy-game/src/does-not-exist.js` → **404** (never an HTML SPA fallback).
- `X-Robots-Tag: noindex, nofollow` present on every response.

## Session / CSRF / cookies / boundaries

- `GET /api/account/session` → 200, sets `__Host-mega_session` (HttpOnly, Secure, SameSite=Lax) and a dev cookie; body `{linked:false, actorId:null, csrf, expires, providers}`.
- `POST /api/account/email` without `Origin` → **403** (CSRF enforced).
- `GET /api/v1/queue` (unauthenticated) → **401** (honest).
- `/operator` → **403** `PRIVATE_OPERATOR_ROUTE`.
- `GET /api/v1/leaderboard` → **200** (public signed Core read projection).

## Realtime (WSS) — real RFC6455 handshake

- Raw HTTPS `Upgrade: websocket` to `/realtime/v1` over the public origin → **101 Switching Protocols** (the earlier 404 was curl sending pseudo-upgrade headers as plain HTTP).
- A malformed/invalid ticket frame → server replies `{"protocol":"realtime/v1","operation":"error","code":"TICKET_INVALID"}` — auth is enforced inside the protocol, not just at the HTTP layer.
- HTTP snapshot fallback `GET /realtime/v1/snapshot` unauthenticated → **401**.

## Old bundle retired

The previously served `f4851a5` / 140-file bundle is no longer served: the live manifest now reports
`9628ed7` / 153 files. No V4 service, port 80/443 ingress, or production container was touched; the
production `mega-xo-production-*` stack remains as-is.

## Reproduce

```sh
node scripts/p21/build-web.js --output .artifacts/p21-web
node scripts/v51/deploy-staging.cjs --commit $(git rev-parse HEAD)
curl -s https://command.tail95c48c.ts.net/web-build.manifest.json | jq '{source_commit,bundle_sha256,file_count}'
```
