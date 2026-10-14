# E5 rehearsal — production V5 stack runs against production Neon (2026-10-14)

Executed by Main under the owner's 2026-10-14 authorization. This is the **strongest reversible
rehearsal** of the cutover: the real production composition was started on the production host,
pointed at the real production database and the real production Redis, and driven to a live HTTP
surface — **without** the authority epoch, so it was structurally incapable of becoming the serving
authority.

## What was started

```
MEGA_V5_PRODUCTION_SERVER=blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production \
MEGA_V5_PRODUCTION_SECRETS=/opt/mega-xo-v5-production/secrets \
MEGA_V5_PRODUCTION_REDIS_CREDENTIALS=/opt/mega-xo-v5-production/secrets/redis-production.json \
  node scripts/v51/v5-production-server.cjs --host 127.0.0.1 --port 8090 --web-build /tmp/p21-final-web
```

It reported:

```json
{"ok":true,"origin":"http://127.0.0.1:8090","binding":"blue-sun-85454968/br-dawn-dawn-b8f9n7zq/mega_xo_v5_production",
 "database":"mega_xo_v5_production","environment":"production","nonserving":true,"serving":false,"servingEpoch":null}
```

`serving:false` with `servingEpoch:null` is the point: the process composed the real production
pools and answered HTTP, but the binding validator **refuses an authority epoch while the target is
still `nonserving`**, so this could not become the recorded writer by configuration drift.

## Live verification (real HTTP against production data)

| Check | Result |
| --- | --- |
| `GET /livez` | `200 {"status":"ok","live":true,"ready":true}` |
| `GET /readyz` | `200 {"status":"ok","live":true,"ready":true}` |
| `GET /` (website bundle) | **200** |
| `GET /app-ads.txt` (Codex's seller declaration) | **200** |
| `GET /nope.jsx` | **404** — a real 404, not an SPA HTML fallback |
| `X-Robots-Tag` | `noindex, nofollow` (release hold intact) |
| `GET /api/v1/leaderboard?metric=rating&limit=5` | **200**, `[]` — an honest empty board for the 2 real actors, sourced through the **production** API pool |
| `GET /api/v1/profile` unauthenticated | **401** `{"error":"AUTH_REQUIRED"}` |

## Production state after the rehearsal (real query)

| Measure | Value | Meaning |
| --- | --- | --- |
| `identity.signing_keys WHERE environment='prd'` | **1** | the operator bootstrap minted exactly one active EdDSA key |
| `identity.signing_keys WHERE environment='stg'` | **0** | **no staging crossover** in the production database |
| `identity.actors` | 2 | V4 data intact |
| `economy.ledger` rows | 0 | no economic write occurred |
| `ops.outbox` rows | 0 | no outbox write occurred |
| `meta.migrations` | 51 | schema head unchanged |
| wallet coins | 307 | the audited total, unchanged |

## Real defects found and fixed by this rehearsal

1. **`await` missing on `createEphemeraService`.** The production entry called it synchronously, so
   `ephemera.healthy` was `undefined` and the process aborted with `ephemera.healthy is not a
   function`. The staging server awaits it; the production entry did not. Fixed.
2. **The server pre-checked for an active signing key before constructing the service that mints
   one**, so a first boot could never succeed. Resolved by running the access-service bootstrap as
   the explicit operator step it is designed to be (`prd` key `mxv5-prd-2026Q4-1-79`, active, EdDSA).
3. **Redis credential envelope shape.** The production host had been given a bare URL where the
   audited P06 guard requires the frozen envelope (`provider/environment/serviceId/url[/ca]`) with a
   `rediss://` endpoint whose host and port match the inventory. Corrected; the guard then passed.

## Cleanup and safety

- The rehearsal process was **stopped**; `127.0.0.1:8090` no longer listens.
- V4 production was never touched: `play.antimatterinnovations.com/livez` = **200** throughout, and
  all three `mega-xo-production-*` containers are running.
- No image tag was deployed; the run used the immutable local digest built in E3.

## What this does NOT claim

- No authority epoch was written; no first production application write occurred; the V4 SQLite
  writer was never fenced. E4 and the epoch switch are still ahead.
- This ran the API/static surface on loopback. It did **not** exercise a real browser↔Core match on
  production, because that requires the Core ingress repointed from staging — a cutover step.
