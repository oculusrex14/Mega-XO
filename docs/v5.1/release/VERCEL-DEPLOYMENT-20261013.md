# P3 Vercel deployment — website + API projects, real staging-DB connectivity (2026-10-13)

Took over the unfinished Vercel work (R10/R11/P11 hosting). Discovered the owner's authenticated
Vercel account (`oculusrex14`, team `oculusrex14s-projects`, Hobby) had **no Mega XO project**;
created two, deployed previews, and proved the API reaches the real staging Neon database.

## Projects created (owner team `oculusrex14s-projects`, Hobby)

| Project | Root dir | Purpose | Preview URL |
| --- | --- | --- | --- |
| `mega-xo-web` | `apps/web` | static P21 website bundle | https://web-nine-phi-f2vlp4rde0.vercel.app |
| `mega-xo-api` | `apps/api` | stateless API control plane | (preview per deploy) |

Both created via the authenticated Vercel CLI (interactive auth already present). Deployment
Protection (SSO) was disabled **for previews only** (`ssoProtection: null`; custom domains stay
protected) so the preview is genuinely fetchable for acceptance.

## Website project (`mega-xo-web`)

- `apps/web/vercel.json` is the reviewed static config: framework Other, install `true`, build
  `node ../../scripts/p21/build-web.js --output apps/web/dist`, output `dist`, automatic Git
  deployments disabled, explicit rewrites (missing JS/fonts/API paths are real 404s), CSP/nosniff/
  noindex headers.
- Build produces the same bundle as the CLI: `source_commit` = the deploying commit,
  `bundle_sha256 2887b0cd…`, 153 files.
- Served (fetched, not local build): `/` 200 (36,269 b), `/pages/game.html` 200 (31,897 b),
  `/pages/ranked.html` 200 (14,316 b), `/legacy-game/src/game.js` 200 (4,565 b), `/store-links.js`
  200, `/legal/privacy` 200 (15,495 b), unknown path **404**.

## API project (`mega-xo-api`) — real staging-DB connectivity

Required two real fixes to the checked-in deployment config and one to the handler:

1. **`apps/api/vercel.json`** carried invalid legacy keys (`name`, `scope`, `teamId`, `orgId`,
   `projectId`) and a per-function `runtime`/pattern block Vercel rejects (`invalid_function_runtime`,
   `unused_function`). Removed; project identity lives in the Vercel project, Node functions
   auto-detect, and the project `rootDirectory` is `apps/api`.
2. **`apps/api/api/index.js`** was missing: the config's `functions`/rewrites target `api/index.js`
   under the project root, so the function is `apps/api/api/index.js`; it re-exports
   `apps/api/index.js`.
3. **`apps/api/index.js` default handler** built an *incomplete* pool (`{url, role, applicationName}`)
   which the db guard refuses (`PG_USER_REQUIRED`/`TARGET_REQUIRED`/`SSL_CA_REQUIRED`), and passed a
   40-char commit SHA as the application-name revision, which exceeds the 32-char segment limit
   (`REVISION_REQUIRED`). It now composes a full guard config from the environment, derives the DB
   label/target from the staging inventory, shortens the revision, and fails closed to an honest 503.

### Environment (isolated, least-privilege, preview)

Set as Vercel project env (never printed/committed): `DATABASE_URL` = the staging `api_runtime`
direct URL (encrypted); `MEGA_PG_SSL_CA` = the extracted Neon chain anchor (ISRG Root X1/X2 +
Let's Encrypt intermediates); `MEGA_PG_TARGET_B64` = the staging inventory; `MEGA_PG_POOL_BUDGET_*`;
`MEGA_OTP_SECRET` (staging). The API holds **only** `api_runtime` credentials — no Core pool.

### Verified against the deployed preview

| Check | Result |
| --- | --- |
| `GET /api/account/session` | **200** with `__Host-mega_session` (HttpOnly, Secure, SameSite=Lax) + CSRF, from the real staging Neon DB |
| `GET /api/account/profile` (anonymous cookie) | 401 (honest) |
| `GET /api/v1/leaderboard` | 200 `[]` (public read; no Core ingress reachable → honest empty) |
| `GET /api/v1/queue` (unauthenticated) | 401 |
| `GET /operator` | 403 `PRIVATE_OPERATOR_ROUTE` |
| `GET /.well-known/apple-app-site-association` | 200 (app-links, `TEAMID.com.antimatterinnovations.megaxo`) |
| `OPTIONS /api/account/email` from `https://megaxo.online` | 204 (CORS allowed) |
| Headers | HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` |

## Honest limits / remaining

- **Vercel → Oracle Core** is not yet a live connection: the signed Core ingress is tailnet-only
  (`http://100.64.128.46:8085`, `X-Robots-Tag: noindex`) and cannot be reached from Vercel without a
  **public signed endpoint**, which is a DNS/domain decision the owner must approve (the API is NOT
  the economic authority and must not proxy into an inaccessible private endpoint). The API therefore
  serves DB-backed reads/sessions now and an honest empty leaderboard until a public Core edge exists.
  The staging origin now loads a **stable** Core-ingress secret from a 0600 file so the wiring is
  ready the moment a public signed endpoint is approved.
- `megaxo.online` is **not** in the owner's Vercel account; DNS/domain association and the production
  alias are prepared but not attached (`megaxo.online` cutover stays under final approval).
- No production deployment was promoted; no paid subscription; Vercel Hobby.

## Reproduce

```sh
cd apps/web && vercel build --yes && vercel deploy --prebuilt --yes
cd ../.. && vercel build --yes && vercel deploy --prebuilt --yes   # mega-xo-api (rootDirectory=apps/api)
```
