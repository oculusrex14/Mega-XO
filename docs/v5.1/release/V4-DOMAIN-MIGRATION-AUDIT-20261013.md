# V4 `play.antimatterinnovations.com` → `megaxo.online` migration audit (2026-10-13)

**Scope:** inventory existing V4 references to `play.antimatterinnovations.com` (and
`staging.play.*`) and prepare their migration to `megaxo.online`, **without abruptly removing any live
endpoint**. `antimatterinnovations.com` is reserved for the parent company; game surfaces move to
`megaxo.online`.

## Current state (safe coexistence already in place)
- **New V5 web** (`apps/web/**`, `apps/web/dist/**`) already uses `megaxo.online` exclusively.
- **V4 browser game** runs at `https://play.antimatterinnovations.com` (Caddy `{$MEGA_HOSTNAME}` →
  V4 `app:8080`). Preserved, untouched.
- **V5 API** CORS/CSRF allowlists already contain **both** `https://play.antimatterinnovations.com`
  and `https://megaxo.online` (`apps/api/middleware/cors.js`, `apps/api/config.js` PROD_HOSTNAMES), so
  either origin works today.

## Reference inventory

### A. Runtime / code (migration-relevant)
| Location | Reference | Migration action | Blocking dependency |
|---|---|---|---|
| `apps/api/middleware/cors.js:16` | allowlisted origin `play.antimatterinnovations.com` | **Keep** during dual-run; remove only after V4 browser clients drain (P22/P23) | client drain |
| `apps/api/config.js:19` | `PROD_HOSTNAMES` includes it | Keep during dual-run | client drain |
| `apps/api/middleware/csrf.js` | uses `allowedOrigins` (inherits the above) | Follows CORS decision | — |
| `scripts/p21/serve-web.js:10` | `READ_API_ORIGIN = 'https://play.antimatterinnovations.com'` | Point at `https://api.megaxo.online` **when the API is served from that origin** | Vercel production domain (cutover) |
| `scripts/v5/p18/staging-topology.js:45` | host allow-check incl. `.antimatterinnovations.com` | Add `megaxo.online`; keep old until cutover | — |
| `scripts/v5/p22/compatibility-map.js` | `oldOrigin` must equal `https://play.antimatterinnovations.com` | **Unchanged by design** — it *is* the old-origin facade record | P22 |
| `scripts/v51/p21-staging-server.cjs:214`, `p21-staging-smoke.cjs:725` | staging allowedOrigins includes play.* | Staging-only; add megaxo.online (already does) | — |

### B. Callbacks / app URLs
- **Email/store/ad callbacks:** no absolute `play.*`/`megaxo.online` host is hard-coded as a callback
  URL; provider notifications arrive at the API origin and are deduped durably (P22 inbox). Migration
  = choose the canonical callback host at the Vercel/API domain step; no code constant to rewrite.
- **App links / universal links:** `assetlinks.json` and `apple-app-site-association` **do not exist
  yet** — they require the final app IDs + Apple Team ID (P5, owner-gated). When created they must use
  `megaxo.online` (never the parent domain).
- **Store/download links:** `apps/web/download-config.cjs` — destinations empty (honest null) until
  store listings exist (P5, owner-gated).

### C. Docs / runbooks (not runtime)
`deploy/{RELEASE,STAGING,VPS,MONITORING,PERIMETER}-RUNBOOK.md`, `deploy/EMAIL-LIVE-ACCEPTANCE.md`,
`docs/{V4-ARCHITECTURE,V4-OPEN-BLOCKERS}.md`, `docs/co-dev/P22-CUTOVER-READINESS.md`,
`docs/p21-web/*`. These describe the **current live V4 origin**; update them at P22/P23 when the
canonical origin changes. No change now (they would become wrong).

### D. Tests (11 files) — intentionally pin the V4 origin
`tests/v5-p11-{session-boundary,vercel-config,browser-compat}.test.js`, `v5-p13-security`,
`v5-p18-staging-topology`, `v5-p21-web-build`, `v5-p22-compatibility-map`, `v5-p23-compatibility-sunset`,
`provider-authorization`, `production-lifecycle`, `privacy-export`. Per repo rules these existing
tests are **not re-pinned** unless the behavior actually changes; they encode the deliberate dual-origin
compatibility and the P22 facade contract.

## Migration plan (prepared, not executed)
1. **Now (done):** dual-origin allowlist already accepts `megaxo.online`; new V5 web already uses it.
2. **Cutover (owner-gated):** attach the Vercel production domain `api.megaxo.online`; set production
   `MEGA_CORE_URL=https://core.megaxo.online` + `MEGA_PROXY_SECRET`; point `serve-web.js` read origin at
   the new API.
3. **After client drain:** remove `play.antimatterinnovations.com` from CORS/`PROD_HOSTNAMES`; retire the
   V4 origin facade; move cookies via the approved bounded exchange (never mint a second actor).
4. **Never:** abruptly delete the old endpoint before replacement clients and routing are verified.

## Explicitly out of scope / owner-gated
- Creating `assetlinks.json` / `apple-app-site-association` (needs app IDs; P5).
- Any V4 DNS/ingress removal, Vercel production domain change, or production traffic change.
- The owner-deferred new `megaxo.online` website/browser product.
