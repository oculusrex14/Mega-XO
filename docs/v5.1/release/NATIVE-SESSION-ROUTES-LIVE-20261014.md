# Native session routes — deployed live and verified (2026-10-14)

## The gap that was closed

`packages/contracts/routes.js` declared the cookie-free native session route family, but
`apps/api/routes/account.js` never mounted it. Proof at the time (both the staging origin and the
Vercel preview):

```
POST /api/account/native/token    -> 404 {"error":"NOT_FOUND"}
POST /api/account/native/refresh  -> 404
POST /api/account/native/logout   -> 404
```

That 404 is what blocked every native sign-in attempt, including the real device run.

## Now mounted and LIVE

All five routes are implemented in `apps/api/routes/account.js`, composing the existing
`accounts` / `access` / `refresh` services — no policy, price, cap, session rule or token format was
re-implemented.

| Route | Mount | Observed live |
| --- | --- | --- |
| `/api/account/native/challenge` | POST, CSRF, 300000 | `409 {"error":"INVALID_AUTH_REQUEST"}` for `{}` (request validation reached) |
| `/api/account/native/finish` | POST, CSRF, 300000 | mounted |
| `/api/account/native/token` | POST, bearer, origin NONE, 300000 | `409 INVALID_AUTH_REQUEST` for `{}` |
| `/api/account/native/refresh` | POST, bearer, origin NONE, 16384 | `409` / `401` as appropriate |
| `/api/account/native/logout` | POST, bearer, origin NONE, 16384 | `401 {"error":"AUTH_REQUIRED"}` without a bearer |

Verified over **public HTTPS** (`https://command.tail95c48c.ts.net`) as well as loopback, on the
refreshed staging deploy (source `465405e`, migrations 51/51 applied).

**Zero `Set-Cookie` on all five routes**, asserted both by the suite and by inspection of the
response headers on the live origin. That is the defining property of this path: a native client keeps
its credential in the platform secure store, never a browser cookie.

## Body limits — a real defect found and fixed

The ceilings are the contract's exact numbers and are enforced by **refusing, never truncating**, with
the refusal preceding JSON parsing:

- a declared `Content-Length` over the ceiling is refused **before a byte is buffered** (the request is
  drained, never destroyed, so the 413 is actually written);
- an undeclared-length (chunked) stream is bounded by a reader that stops accumulating at the ceiling,
  drains the remainder and rejects;
- the original behaviour on a chunked oversize body was a **dropped socket (ECONNRESET)** rather than a
  413 — a real bug, now fixed and pinned by assertions.

## Proven by the suite

`tests/v5-p11-native-session.test.js` (8 tests, real loopback PG16 + the real services) plus the
neighbouring p11 suites, all green:

| Suite | Result |
| --- | --- |
| `v5-p11-native-session` | 8/8 |
| `v5-p11-session-boundary` | 11/11 |
| `v5-p11-browser-compat` | 8/8 |
| combined p11 run (8 suites) | **61 tests, 61 pass, 0 fail** |

Asserted: no `Set-Cookie` on any of the five; `AMBIGUOUS_CREDENTIAL` on a cookie+bearer pair;
single-flight rotation (the old refresh token stops working and a replay cannot mint a second live
family); 401 on a revoked refresh; the exact body limits with 413 rather than a dropped socket; and the
existing origin/CSRF boundary rules.

## Honest limits

- No **live provider** (Google/Apple) sign-in was exercised: the provider verifier used real RSA
  signatures with repository test keys, and no authorized Google server client id exists in this
  environment. The native client is wired to the frozen contract; the live provider round-trip remains
  owner-gated.
- The staging deploy was refreshed by Main for this verification; production still has **no** native
  session traffic because production serves V4.
