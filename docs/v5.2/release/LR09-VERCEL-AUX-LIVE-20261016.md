# LR09 - Vercel auxiliary routing live verification (2026-10-16)

**Method:** external HTTPS probes against the two known Vercel project subdomains and the canonical origins. No console login, no config change.

## Findings

| Surface | Result | Meaning |
| --- | --- | --- |
| mega-xo-api.vercel.app/* | 404 DEPLOYMENT_NOT_FOUND (all probed paths) | No live production deployment on the project's default domain. |
| mega-xo-web.vercel.app/* | 404 DEPLOYMENT_NOT_FOUND | Same. |
| https://megaxo.online/ | 200 | The canonical Oracle origin is unaffected. |
| https://core.megaxo.online/ingress/health | 401 unsigned (fail-closed) | The Core edge posture is unchanged. |

## Interpretation

1. **No live auxiliary commerce surface exists.** The DEPLOYMENT_NOT_FOUND answer means the Vercel projects either have no current production deployment or the default domains were detached. Either way, there is no reachable Vercel API that could forward economic commands or serve the game - the auxiliary lane is OFF by default, exactly the posture the dependency audit wanted until a decision was made.
2. **The canonical origin is the only game/API surface**, so no Vercel-to-Core routing can bypass the signed ingress or the canonical-host checks in the API composition (the MEGA_PG_TARGET/MEGA_ENV_LABEL handling in apps/api/index.js still requires an explicit environment match - a misconfigured deployment fails closed).
3. **The Hobby-plan noncommercial constraint** (owner decision 9) is moot while no deployment is live: no commercial Vercel use is occurring.

## Decision recommendation for Main (no rush; the canonical origin does not depend on it)

- Keep the Vercel projects PARKED (no production deployment) until a concrete need exists (e.g., a preview lane for the website, or the deferred Vercel API role).
- If the auxiliary API role is ever activated: it must attach the production capture/env (MEGA_PG_TARGET_B64 from the production inventory), hold the same gateway secret, and re-verify the least-privilege suite against the deployed role split. Until then, the signed-ingress-only rule stands.
- If the projects are never needed: deleting them removes the DEPLOYMENT_NOT_FOUND noise; the repo's vercel.json (automatic deployments disabled) is the durable record of the posture.

## Honest limits

- Whether the projects still exist in the Vercel console (vs deleted) requires a console login - not attempted.
- The probes were HTTP-only; a Vercel deployment behind auth or a different subdomain would not be visible to this pass.
