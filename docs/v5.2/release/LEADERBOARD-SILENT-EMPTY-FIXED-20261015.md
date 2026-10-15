# P21-WEB-ONLINE leaderboard silent-empty defect: found and fixed on both surfaces (2026-10-15)

The open-items register recorded this as `V5-O016` — the public `GET /api/v1/leaderboard` route reads
through `context.pool` when no Core transport is configured, and `api_runtime` has no `economy` SELECT,
so the query fails with `42501` and `compat.js` swallows it into an empty `200`. It was still open. This
pass reproduced it on production, found the missing wiring, and fixed both live surfaces.

## Reproduction (production, real)

```
identity.actors rows : 2
economy.ratings rows : 2
api_runtime -> SELECT ... JOIN economy.ratings  =>  42501 permission denied for schema economy
GET https://play.antimatterinnovations.com/api/v1/leaderboard?metric=rating&limit=5  ->  200 []
```

`[]` is *correct today* only by coincidence: the rating metric filters `r.games >= 10` and both imported
actors have `games = 0`. The defect is the mechanism — the API pool path can never serve a real row, so
the moment a player reaches ten ranked games the board would still read `[]`. Staging exposed this
loudly: it had eligible accounts (`games: 10`) and still returned `[]`.

## Root cause

The production entry's own comment says *"queue and leaderboard go through the signed Core gateway"*.
`queue: coreGateway` was wired; **`leaderboard` was never set**, so `compat.js` fell through to
`context.pool` — the `api_runtime` role. Staging (`p21-staging-server.cjs`) carried the identical gap.

## Fix

Both entries now pass the actor-free signed transport explicitly, exactly as the queue already does:

```js
queue: coreGateway, leaderboard: (query) => coreGateway.leaderboard(query),
```

`coreGateway.leaderboard(query)` is the ONE actor-free signed call (timestamp/method/path/empty-actor/
empty-opKey/bodyHash, so the empty actor is *signed*, never omitted). The API composition assertion still
holds: it forbids a Core **pool** (`leaderboardPool`), not a Core **gateway function**, so no Core
credentials enter the API process.

## Verified live after the fix

| Surface | Result |
| --- | --- |
| **Staging** | `GET /api/v1/leaderboard?metric=rating&limit=5` → **200 with real ranked rows** (`games: 10`, tier gold, ratings 1500) — rows the broken path could never have surfaced |
| **Production** | `200 []` — correct, because the two imported actors have `games = 0` and are legitimately filtered |
| Health (production) | `/`, `/livez`, `/readyz`, `/opsz`, `/api/account/session` all still 200 |

## Honest limits

- The production board is legitimately empty until a player has ten ranked games; the fix means it will
  then show them rather than masking a permission error.
- The staged rows are smoke-fixture accounts, not real players.
