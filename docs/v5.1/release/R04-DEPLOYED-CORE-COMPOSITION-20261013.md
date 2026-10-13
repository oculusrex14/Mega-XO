# R04 — deployed isolated signed Core composition (2026-10-13)

**R04 criterion:** prove the *staged process-manager / TLS / private-ingress wiring in a deployed
topology* (the earlier proof was local composition only: `docs/v5.1/release/ISOLATED-COMPOSITION-AND-OFFER-LATENCY-20261012.md`).

## Deployed topology (now proven live)

```
Vercel stateless API  (project mega-xo-api; holds ONLY api_runtime; NO Core pool)
   │  POST /ingress/*  +  x-service-{timestamp,actor,opkey,signature}  (HMAC-SHA256, shared secret)
   ▼  HTTPS (Let's Encrypt CN=core.megaxo.online)
Oracle Caddy edge (sole 443 listener; independent additive site block for core.megaxo.online)
   │  only /ingress/*  →  172.18.0.1:8096     (host side of the production `backend` bridge)
   │  everything else  →  404
scripts/v51/core-edge-proxy.cjs   (loopback-or-explicit-private bind; forwards ONLY /ingress/*)
   ▼  127.0.0.1:8085
Game Core ingress (packages/services/core-gateway.js createCoreServiceIngress)
   │  verifies HMAC + 30s drift + bounded body; routes queue/command/ticket/leaderboard
   ▼  core_runtime pool  →  Neon mega_xo_v5_staging
```

## Separation properties verified
| Property | Evidence |
|---|---|
| **API holds no Core credentials/pool** | Deployed `/api/v1/leaderboard` returns Core data only by signing through the gateway (`apps/api/index.js` installs `context.leaderboard` from the resolved gateway; no core pool in the deployed composition) |
| **TLS termination** | Let's Encrypt cert `CN=core.megaxo.online` (exp 2027-01-11) issued on first hit |
| **Private ingress** | Caddy routes only `/ingress/*` to the host proxy; all other paths 404; proxy binds the production-bridge gateway (ufw-scoped to `172.18.0.0/16`), not public |
| **Least-privilege roles** | API = `api_runtime`; Core = `core_runtime`; Core pool `describe().role === 'core_runtime'` is enforced by the ingress constructor |
| **Fail-closed** | missing/forged signature → 403; expired → 401; non-ingress paths → 404; unconfigured Core → the API keeps an honest behavior (503 on transport failure, never a false empty board) |
| **One Core / one queue namespace** | the proxy forwards to the single existing Core (`:8085`); no second Core process was created |

## Verification runs
- **P3 edge HMAC suite — 11/11** on the public endpoint (`CORE-EDGE-DEPLOYED-20261013.md`).
- **R06 leaderboard correctness/privacy — 14/14** through the deployed signed Core
  (`R06-LEADERBOARD-PRIVACY-20261013.md`).
- **R05 co-located full online acceptance — 31/31, ok:true** against the deployed stack
  (`R05-ONLINE-ACCEPTANCE-20261013.md`).

## Status
R04's remaining gap ("actual staged process-manager/TLS/network wiring is not proven") is now closed
by the deployed `core.megaxo.online` composition above. Production authority is still V4.1.2; this is
the **staging** deployed composition (plus the Vercel API preview), not the production cutover.
