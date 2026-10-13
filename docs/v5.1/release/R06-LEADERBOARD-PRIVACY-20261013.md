# R06 — deployed public-leaderboard correctness + privacy (2026-10-13)

**Path verified:** the deployed signed Core ingress (`core.megaxo.online` → host proxy → Core →
staging Neon `economy.ratings`), which is the authoritative uncached read. The Vercel API layer
additionally caches the public projection (`PUBLIC_LEADERBOARD`, 60s TTL / 300s stale) by design; the
API→Core connectivity itself was proven separately (live leaderboard 200, see P3 closure).

**Harness:** `scripts/v51/r06-core-leaderboard.cjs` (seeds 4 controlled actors via api_runtime +
core_runtime, cleans up its own rows, asserts through the real signed gateway).

## Result — 14/14 PASS
| Assertion | Result |
|---|---|
| rating: public actors with games≥10 appear | PASS |
| rating: `stats_visibility='friends'` actor hidden | PASS |
| rating: actor with games<10 hidden | PASS |
| rating: ORDER BY rating DESC (1700 before 1600.25) | PASS |
| rating: Elo hundredths preserved (`1600.25`, not `1600.3`) | PASS |
| rating: `wealth` field absent on the rating projection | PASS |
| scope=local region=IN: only the public IN actor (friends out, US out, games<10 out) | PASS |
| league=gold: only gold-tier public actors (silver + friends excluded) | PASS |
| wealth: only `wealth_public=true` actor present | PASS |
| wealth: `wealth_public=false` actor hidden | PASS |
| wealth: friends-visibility actor hidden even if wealth_public | PASS |
| wealth: 64-bit-exact decimal string (`9007199254740991`) — no float precision loss | PASS |
| invalid metric rejected by the Core ingress | PASS |
| Core unavailable → transport FAILS (API maps to honest 503, never empty 200) | PASS |

## Notes
- The earlier API-path variant (`scripts/v51/r06-leaderboard-privacy.cjs`) hit the intended 60s/stale
  read cache; the uncached Core path above is the authoritative correctness/privacy verification.
- Cleanup: all seeded `r06_*` rows removed; the pre-existing `p21_smoke_*` actors were never touched
  (the first API run made that mistake impossible to repeat — assertions are subset-based).
- No production write; staging-only; no provider access.
