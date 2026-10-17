# V5.2 annotation-lane review — Main (2026-10-17)

Independent verification of the Codex annotation lane (`7eff82e` … `635cd4e`) before integration.
Every claim below was checked against live repo state and re-run suites, not taken from the receipt.

## Scope delta

The handoff describes "13 commits based on `d6086a2`". The actual delta from Main's own last
verified head (`521e957`) is **42 commits** — it also contains the LR21/LR22 checkpoints,
migrations 0058–0060, the Hubble P1/P2 audit fixes and the commerce Decision-2 reservation fence.
The handoff undercounts; the review covers the full delta. `521e957` is confirmed an ancestor of
`635cd4e`, so nothing Main verified earlier was rewritten.

## Suites re-run independently on the exact head

| Suite | Result |
| --- | --- |
| v5-p21-pages / app / board, v52-web-tournaments, v52-polar-provider, v52-commerce-ingress, v52-commerce-create-race, monetization-policy, static-ui | 132 pass / 0 fail / 0 skip |
| v52-cashfree-v5, v52-polar-commerce, v52-pass-benefits, v52-provider-callback-rate-limit, v52-account-link, v52-tournament-http (non-PG) | 39 pass / 0 fail / 1 skip |
| v5-migration-extract | 14 pass / 0 fail / 0 skip |
| v52-tournament-http (full PG-gated website tournament journey) | 14 pass / 0 fail / 0 skip |

The only skipped test required `V5_PG_URL`; re-run against a real disposable PG16 it passed.

## Migrations 0058 / 0059 / 0060 — applied on a disposable PG16.15

- Full 60-migration chain applied cleanly (forward-only, one tx each) on a throwaway loopback cluster.
- `--verify` conformance: **ok=true**.
- Checksums: **60/60 match** under the runner algorithm `sha256(name + '\n' + sql)`.
- All three new constraints present: `pass_periods_discount_quota` (`reserved + used <= 2`),
  `…_reserved_range`, `…_used_range`. No destructive SQL anywhere in the three files.
- Role posture correct: `core_runtime` INSERT/UPDATE/SELECT on `monetization.polar_subscriptions`;
  `backup_reader` SELECT only.
- Tables present: `monetization.polar_subscriptions`, `monetization.pass_periods`,
  `monetization.commerce_create_requests`.

## Security review of the deltas

- **Polar signature verify** (`7eff82e`): tightened to `https://` on the checkout URL and accepts
  Standard-Webhooks `v1,`-framed signatures, keeping a bare-HMAC fallback for fixtures. Fail-closed.
- **Provider-callback admission limiter** (`5c87b2e`): 600/IP/UTC-minute per provider lane, IP trusted
  only through the deployment edge (socket peer in a trusted-proxy allowlist + constant-time proxy-key
  check), canonicalised and HMAC-hashed before bucketing, no raw address persisted, storage failure
  fails CLOSED. Sound.
- **core-gateway arg forwarding** (`18ea57e`) and the provider fetch wrappers: two real transport bugs
  (dropped `init`, dropped `productId`/`orderId`/`customer`) that CI fakes had hidden. Genuine fixes.
- **Spectator read-only** (`a6c7019`): seated members only, `:spectate` board identity (cannot collide
  with a participation board), server-side `spectate:true` term, and a null `actorId` downstream.
- **Member projection** (`d66c37d`): tier/rating/games only when viewer == actor or
  `stats_visibility = 'public'`; API-owned social tables never read. Correct.
- **Main's own HIGH actor-override fix** is still present (`core-gateway.js:1019`).

## Annotation claims

- **Mega Pass asset**: `assets/p21/art/mega-pass.webp` is genuinely alpha WebP; the page requests
  `/assets/art/mega-pass.webp` and the bundle ships it at that path. ✓
- **Sponsors**: 6 grid slots + 1 leaderboard banner = 7 labelled placements, one disclosure panel,
  no duplicate panel. ✓
- **Tournaments**: exactly one catalog fed from `/api/party/capabilities`, strict validation. ✓

## Documentation inaccuracies found (non-blocking; behaviour is correct/fail-closed)

1. `packages/services/polar.js` comment claims signatures may be "comma-separate[d]"; the regex only
   anchors on start/whitespace, so `v1,A,v1,B` yields only the first signature. Fail-closed, never a
   security hole — but the copy is wrong and there is **no test** for v1-framed signatures.
2. The receipt states the pass webp `sha256` is "in the receipt"; it records the APK and bundle hashes
   but **no webp hash**. (The asset's hash is `41bb979e30ae2ebcd4b722ecd4144286019d1c077b02deb066571f5aa844e325`.)

## Owner decisions recorded this session

- **Website approved for deployment** (owner completed the port-4196 UI review). This lifts the
  earlier P21 deferral for the delivered annotation bundle; deployment itself still waits on
  integration plus the pre-deploy env/webhook items in the handoff.

## Residual (owner-actionable)

- Add `POLAR_PRICE_MEGA_PASS` / `POLAR_PRICE_CENTS_MEGA_PASS` to the approved env (optional) and
  verify the Polar sandbox price ids for all five products.
- Point the Polar/Cashfree webhook endpoints at `https://megaxo.online/api/monetization/{polar,cashfree}/webhook`.
- LR02 final CI stays last per the owner's standing order.
- iPhone device-matrix pass outstanding.
