# Game domain cutover: play.antimatterinnovations.com -> megaxo.online (2026-10-15)

**Owner directive (15 October 2026):** the game is **https://megaxo.online**. The antimatter domain
"should not be used anywhere for the app, vercel etc."; only its `contact@` email may appear in product
copy, because the owner is using that domain for the parent-company website. Beta testers were told the
service is on a maintenance break, so a short switch window was accepted.

**Executed on integration branch `V5.2`**, source commit `0857ba5` (domain config) on top of the
`93b01fa` merge of PR #16 and PR #15.

## Why the Oracle edge, not Vercel

The owner chose the Vercel target (`mega-xo-web` + `mega-xo-api`). That cannot serve the game, and this
was verified rather than assumed:

- the browser client reads `/api` with `credentials:'same-origin'` (`apps/web/data.js:31`,
  `src/account-client.js:52,131`) and opens `new URL('/realtime/v1', page.origin)`
  (`apps/web/realtime.js:39-40`);
- the session cookie is `__Host-mega_session`, which by definition has **no `Domain` attribute and is
  host-only**, so the API must answer on the same hostname as the page;
- the `mega-xo-web` project does **not** proxy `/api`: `GET /api/account/session` and
  `GET /api/party/capabilities` both return `404` there;
- the `mega-xo-api` project answers for the account/leaderboard routes but returns `404` for
  `/api/party/capabilities`, so it is not wired to the Oracle Core.

The Oracle V5 authority already allowed `https://megaxo.online` as an origin and serves the bundle, the
API and the Core from one process, so `megaxo.online` is served by that edge. This is the same
application on the canonical hostname, not a rebuilt website.

## Changes

| Item | Before | After |
| --- | --- | --- |
| DNS `megaxo.online` `@` A | `2.57.91.91` (Hostinger parking) | `129.80.67.164` (V5 edge) |
| Edge site blocks | `{$MEGA_HOSTNAME}` = play.antimatter + `core.megaxo.online` | explicit `megaxo.online` (app), `play.antimatterinnovations.com` (308 to apex), `www.megaxo.online` (301 to apex), `core.megaxo.online` |
| `apps/api/middleware/cors.js`, `apps/api/config.js` | old host in allowlist / prod hostnames | canonical hosts only |
| `scripts/p21/serve-web.js` | reader API origin = old host | `https://megaxo.online` |
| `scripts/v51/{v5-production,p21-staging}-server.cjs` | allowlist included old host | `megaxo.online`, `www.megaxo.online` |

`308` (not `301`) for the retired host because installed beta Android builds still POST to it and a
`301` would rewrite those API POSTs to GET.

## Verified live (observed)

| Check | Result |
| --- | --- |
| `https://megaxo.online/{,livez,readyz,health}` | `200` |
| `https://megaxo.online/api/account/session` | `200`, real PostgreSQL session envelope |
| `https://megaxo.online/{api/v1/leaderboard,api/party/capabilities}` | `200` |
| `https://megaxo.online/.well-known/{assetlinks.json,apple-app-site-association}` | `200` |
| `https://megaxo.online/{game,friends,store,play,leaderboard,download,how-to-play}` | `200` |
| `megaxo.online` TLS | Let's Encrypt, subject `CN=megaxo.online`, valid to 2027-01-13 |
| served `app.js` | `fb04cc44b5fa4b90`, byte-identical to the built bundle |
| `https://play.antimatterinnovations.com/{,livez}` | `308 -> https://megaxo.online/...` |
| `https://www.megaxo.online/` | `301 -> https://megaxo.online/` |
| `https://core.megaxo.online/ingress/leaderboard` (unsigned POST) | `401` (isolated ingress intact) |
| two-account online acceptance vs `https://megaxo.online` | **31/31 PASSED, 0 observed** (`docs/v5.2/release/evidence/online-acceptance-megaxo-20261015T154314Z.json`) |

## Rollback

DNS: restore the Hostinger zone from `docs/v5.2/release/dns-backup/megaxo.online-20261015T152602Z.json`
(the pre-change snapshot; apex `A 2.57.91.91`, `www` CNAME to the apex, `core` unchanged). Config: the
edge Caddyfile is backed up on the host as `Caddyfile.bak-premerge*` next to the deployed one; restore
and restart `mega-xo-production-edge-1` (it has `admin off`, so a container restart is required to
re-read the config). Application rollback: `/opt/mega-xo-v5-production/rollback/2026-10-15T15-02-02-703Z-93b01fa6ffad/`
holds the pre-deploy source (`v5-production-server.cjs` sha `5dba48f9194cdac2`) and web bundle.

## Incidents during the cutover (both contained, recorded)

1. The first `deploy-production.cjs` run replaced the live tree but the swap aborted before restart
   because the repo has no `serve.sh` (a host-local launcher) — so the old process kept serving (no
   outage) while the new tree lacked the unit's `ExecStart` target. Restored `serve.sh` from the
   archive; the script now carries host-local files and hard-fails if `serve.sh` is missing.
2. Restoring the repo's `docs/v5/environments/production.json` overwrote the host's cutover-toggled
   copy (`nonserving:false`) with the checked-in default (`nonserving:true`), and the server refused
   with `SERVING_EPOCH_BEFORE_CUTOVER`, leaving production returning `502` until the host copy was
   restored from the archive. The deploy script now unconditionally restores that file from the
   archive. Total measured downtime: the window between the restart and the restore in that step.
