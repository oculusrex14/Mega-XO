# V5.1 isolated staging origin - Codex handoff (2026-10-12, updated)

Main agent. This is the running isolated V5.1 **pre-production** origin for browser/native
acceptance work. It is **not** a production cutover and does not touch live V4.

## What is running (exact facts)

| Fact | Value |
|---|---|
| Running build source commit | `f4851a5` (the generated P21 bundle's `source_commit`) |
| Repository HEAD when this was recorded | `042c913` (branch `V5.1`) |
| Generated bundle hash | `bundle_sha256 8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3`, 140 files |
| Server entrypoint | `scripts/v51/p21-staging-server.cjs` (serves the generated bundle, not `apps/web`) |
| Process | one Node process on the tailnet interface (isolated; no Docker, no public 80/443, no V4) |
| Neon database | `mega_xo_v5_staging` (project `lively-shadow-52629967`, nonserving, migrations applied) |
| Redis | Upstash staging, isolated `mx:stg:<keyVersion>:*` namespace |
| Roles | `api_runtime` (API) and `core_runtime` (Core/queue), separately bound and verified |
| Outbound providers | email / store notifications / ad rewards all **disabled** (target-file enforced) |
| Indexing | `X-Robots-Tag: noindex, nofollow` on every response |

## URLs (private, tailnet-reachable - NO public ingress)

- **Website + API + realtime:** `http://100.107.65.122:8081/` (this Mac mini's tailnet IP).
- **From another tailnet node** (verified from the Oracle host): `/`, `/livez`,
  `/legacy-game/src/game.js`, `/api/account/session` all `200` with real byte counts.
- **HTTPS** (`https://naraharikripas-mac-mini.tail95c48c.ts.net`) is possible via `tailscale serve`,
  but that needs a one-click owner enablement in the Tailscale admin console
  (`https://login.tailscale.com/f/serve?node=nLo62ZkXpj11CNTRL`). Until then use the http tailnet URL.

Restart (explicit tailnet bind; wildcards refused):

```sh
MEGA_V51_STAGING_SERVER=lively-shadow-52629967/mega_xo_v5_staging \
  node scripts/v51/p21-staging-server.cjs --port 8081 \
    --host <TAILNET_IP> --allow-host <TAILNET_IP> \
    --public-origin https://<host>.<tailnet>.ts.net \
    --web-build .artifacts/p21-web \
    --otp-out /Users/oculus/Downloads/Mega-XO-private-evidence/v5-neon-staging/run/staging-otp.jsonl
```

Build the bundle first if it is missing: `node scripts/p21/build-web.js --output .artifacts/p21-web`.

## Sign-in now works (R15 resolved)

The V5 PostgreSQL account routes ARE mounted and verified end-to-end on this origin:

- `GET  /api/account/session` - anonymous bootstrap sets an HttpOnly session cookie and returns
  `{linked, actorId, csrf, expires, providers}`; an existing caller is not re-issued.
- `POST /api/account/email` - `{action: continue|verify|forgot|reset|reauth|change}`.

Controlled end-to-end proof on the running origin (`tests/e2e-staging-signin.cjs`, **8/8**):
anonymous cookie -> `continue` (signup) -> one-time code delivered ONLY out-of-band to the staging
OTP sink -> `verify` links actor `u_ccb45ebc-daca-4c07-ad20-ead12fc2143f` (tag `MEGA-B26F553B`) ->
session reports `linked:true, providers.email.linked:true` -> profile readable -> cookie POST without
Origin `403` -> foreign Origin `403`. The one-time code never appears in any HTTP response.

Reading the code for a manual browser test (staging email is disabled by design): each delivery is
appended to the `--otp-out` file (mode 0600, outside the repo).

## Verified on this origin

- The **generated P21 bundle** is served (not the raw `apps/web` tree): `/` 200; `/legacy-game/src/game.js`
  200 (4565b), `/legacy-game/src/bot/worker.js` 200 (1248b), `/store-links.js` 200 (126b),
  `/legal-documents.js` 200 (20422b), `/assets/art/mark.webp` 200 (14040b), fonts 200 - all with real
  byte counts; a missing asset is a **real 404**, never an HTML SPA fallback.
- `/livez` 200; unauthenticated `GET /api/v1/queue` 401 (honest); `GET /api/v1/leaderboard` 200 with
  the real signed Core projection; `/operator` 403 `PRIVATE_OPERATOR_ROUTE`.
- The acceptance smoke passes flows 1-11 and, with the two queue accepts issued concurrently (as two
  browsers would), flow 12 as well; see the smoke result JSON.

## Boundaries

- No production change, no V4 restart, no public ingress, noindex enforced, providers disabled.
- The V5 API does not mount `POST /api/account/start` (provider OAuth redirect) - only
  `session`/`email` are mounted. Do not assume provider sign-in is available on this origin.
- No secrets are printed by the server; credentials stay in the encrypted private evidence dir.
- Model publication and production cutover remain approval-gated.
