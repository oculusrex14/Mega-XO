# Vercel takeover: both projects, real Oracle Core connectivity, receipts and rollback (2026-10-15)

Objective priority (3). This audit re-reads live provider state rather than trusting the earlier note.

## Projects and team

| Project | Id | Root | Production URL | State |
| --- | --- | --- | --- | --- |
| `mega-xo-api` | `prj_y2zGwwGwk3zVdP6sevw5S3z5qN65` | `apps/api` | `api.megaxo.online` (alias) / `mega-xo-api-oculusrex14s-projects.vercel.app` | Ready, Production |
| `mega-xo-web` | — | — | `web-nine-phi-f2vlp4rde0.vercel.app` (serves the P21 website shell, 200) | Ready, Production |

Both live in team `oculusrex14s-projects` (Hobby). The CLI account is `oculusrex14`.

## The API is PostgreSQL-backed in Production

Earlier this session the API answered `409 NO_DATABASE_POOL_OR_ACCOUNTS_SERVICE` because its database
target existed only for Preview/Development. That is fixed (`VERCEL-PRODUCTION-API-ENABLED-20261015.md`):
a Production-scoped `DATABASE_URL` (Neon **pooled**, role `api_runtime`), `MEGA_PG_TARGET_B64`,
`MEGA_PG_SSL_CA`, `MEGA_OTP_SECRET`, `MEGA_ENV`, `MEGA_SERVICE` and the pool budget are all set, and the
deploy uses `vercel build --prod` + `vercel deploy --prebuilt --prod` so the `packages/**` tree and the
`pg` driver are traced into the function.

## Real Oracle Core connectivity — verified, not assumed

The gateway path is `Vercel API --HTTPS + HMAC--> Core ingress`. The repo's own records flag a real
trap here: `docs/p21-web/MAIN-PROVIDER-WEBSITE-HANDOFF-20261014.md` says "the current
`core.megaxo.online` staging route is explicitly unsuitable for a production API", and
`E3-PRODUCTION-STACK-PROVISIONED-20261014.md` says production's Core ingress was never given a
production route. Live inspection confirms it: `core.megaxo.online` → `core-edge-proxy.cjs` (port 8096)
→ **port 8085**, which is the *staging* server (`mega-xo-v51-staging-web.service`), not the production
authority.

The production authority already publishes its own signed Core ingress on the live origin. Proved with a
real HMAC-signed gateway call, using the production `core-gateway.secret`:

```
createCoreGateway({ coreUrl: 'https://play.antimatterinnovations.com', secret: <production gateway secret> })
  .forwardCommand({ path: '/ingress/queue/status', ... })
→ {"state":"idle"}
```

So `MEGA_CORE_URL` was set to `https://play.antimatterinnovations.com` (the production Core) and
`MEGA_PROXY_SECRET` to the production gateway secret, both Production-scoped, and the API redeployed.
`/api/v1/queue` now answers its honest `401 AUTH_REQUIRED` before the Core hop for an anonymous caller,
which is the correct contract (an actor-bound session is the prerequisite, and the two-account
acceptance proves the actor-bound path end to end on the authority itself).

## Receipts and rollback

- **Receipts:** each deployment is immutable and addressable by URL, e.g.
  `mega-xo-ejp9c1r6z-oculusrex14s-projects.vercel.app` (current), `mega-xo-23qatewr2-…`,
  `mega-xo-d416t0ay3-…`; `vercel ls --prod` lists them with status and age.
- **Rollback:** `vercel rollback <url|deploymentId>` performs an instant revert to a previous
  deployment; the prior Production deployments remain Ready and are the rollback targets.

## Honest limits

- `api.megaxo.online` resolves to no public A record (`NXDOMAIN` at the public resolver) even though the
  Vercel alias exists; publishing it is an owner DNS action. The API is fully reachable at its
  `*.vercel.app` Production URL.
- `core.megaxo.online` still fronts **staging**; repointing it (or retiring it in favor of the live
  origin's `/ingress/*`) is a routing decision that touches the V4-era Caddyfile and is left to the
  owner.
- The Vercel API is a stateless control-plane surface holding only `api_runtime` credentials; it is not
  a second writer and never composes a Core pool.
