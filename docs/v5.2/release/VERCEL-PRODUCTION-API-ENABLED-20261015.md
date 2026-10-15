# Vercel API production target enabled and verified (2026-10-15)

`VERCEL-AND-IDENTITY-STATE-20261015.md` recorded the real blocker: the deployed API answered
`409 {"error":"NO_DATABASE_POOL_OR_ACCOUNTS_SERVICE"}` on every real account route because its
database target was scoped to **Preview/Development only**. It also recorded that enabling a
Production target "is a cutover-adjacent action … so it belongs with the single-writer decision, not
before it." That decision is now made and executed (V4 fenced, PostgreSQL the single authority), so
this pass enables it.

## What was provisioned

Production-scoped environment variables on Vercel project `mega-xo-api`
(`prj_y2zGwwGwk3zVdP6sevw5S3z5qN65`, team `oculusrex14s-projects`):

| Variable | Source | Scope |
| --- | --- | --- |
| `DATABASE_URL` | Neon **pooled** endpoint, role `api_runtime`, database `mega_xo_v5_production` (architecture: "small bounded Vercel connection budgets with the Neon pooled endpoint") | Production |
| `MEGA_PG_TARGET_B64` | the production inventory with `nonserving` flipped at cutover (the lambda cannot read `docs/`, so the target travels inline) | Production |
| `MEGA_PG_SSL_CA` | the relevant root anchors extracted from the Neon chain (ISRG X1/X2, GTS R1/R3/R4, DigiCert G2/G3/TLS G5) — the full 121-cert bundle is too large for an env value, and the API requires an explicit anchor | Production |
| `MEGA_OTP_SECRET` | the same stable OTP/mail secret the Oracle authority uses, so one-time codes verify across both | Production |
| `MEGA_ENV` | `production` | Production |
| `MEGA_SERVICE` | `mega-xo-api-vercel` | Production |
| `MEGA_PG_POOL_BUDGET_ROLES` / `_TOTAL` | `api_runtime:16` / `16` | Production |
| `MEGA_API_DEBUG` | `1` (diagnostic; sanitized codes only, no secrets) | Production |

No secret value is printed here or anywhere in the repository; each was piped to `vercel env add`
from a mode-0600 file on the host or a temporary file, all of which were removed afterwards.

## The second, real defect this exposed

The first Production deploy still answered 409, and the (debug) runtime log made the cause exact:

```
API_POOL_CFG {"revision":"26a9a3ab1cc9","service":"mega-xo-api-vercel","role":"api_runtime",
  "label":"production","user":"api_runtime",
  "host":"ep-mute-surf-b8v94ksa-pooler.c-14.us-east-1.aws.neon.tech",
  "db":"mega_xo_v5_production","targetEnv":"production"}
API_POOL_INIT_FAILED PG_DRIVER_UNAVAILABLE PG_DRIVER_UNAVAILABLE
```

The target and credentials were correct — the **`pg` driver was absent from the function bundle**.
The handler requires `../../packages/db/pg/pool.js` (above the project's Root Directory `apps/api`),
and a CLI `vercel deploy` uploads the repository root, so a repo-root `.vercelignore` that I had to
add to keep the 4.6 GB tree under the 100 MB upload limit also stripped `packages/`. `vercel build
--prod` followed by `vercel deploy --prebuilt --prod` builds with the correct file tracing and ships
the `packages/` tree and `node_modules/pg` with the function. That is the supported path for this
layout and is what was deployed.

## Verified live (real HTTPS against the production deployment)

| Endpoint | Result |
| --- | --- |
| `GET /api/account/session` | **`200 {"linked":false,"actorId":null,"csrf":"…","expires":…}`** — a real PostgreSQL-backed session envelope, no longer 409 |
| `GET /livez` | `200 {"status":"ok","live":true,"ready":true}` |
| `GET /readyz` | `200 {"status":"ok","live":true,"ready":true}` |
| `GET /api/v1/leaderboard?metric=rating&limit=5` | `200 []` (an honest empty board, read through the production pool) |
| `GET /.well-known/assetlinks.json` | `200`, valid JSON |
| `GET /api/v1/profile` unauthenticated | `401 {"error":"AUTH_REQUIRED"}` — honest, not a crash |

## Honest limits

- **`api.megaxo.online` still has no DNS record** (`NXDOMAIN` at the public resolver), even though the
  Vercel alias exists. The API is reachable at its `*.vercel.app` production URL; publishing the
  custom hostname is a DNS action the owner controls.
- `MEGA_CORE_URL` and `MEGA_PROXY_SECRET` are still **11-character placeholders** in Preview/Development;
  the Vercel API's Core-facing routes are therefore not wired to the live Oracle Core yet. The Oracle
  V5 authority already serves the real account/API surface on `play.antimatterinnovations.com`, so no
  shipped client depends on the Vercel Core path today.
- This API is a **stateless control-plane duplicate** of the Oracle authority, not a second writer:
  it holds only `api_runtime` credentials and no Core pool.
