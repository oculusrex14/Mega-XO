# NATIVE-SESSION-ROUTES-20261014

**Date:** 2026-10-14 · **Branch:** V5.1 · **Author:** worker agent `NativeSessionRoutes`

## 1. What was wrong

`packages/contracts/routes.js` lines 55-61 DECLARE five routes. `apps/api/routes/account.js`
mounted none of them, so the cookie-free native session family answered 404 and a real native
device could not sign in.

## 2. What was mounted

All five, in `apps/api/routes/account.js`, composing the EXISTING `accounts` / `access` / `refresh`
services. No policy, price, cap, session rule or token format is re-implemented.

| Route | Method | Flags (frozen contract) | Implementation |
|---|---|---|---|
| `/api/account/native/challenge` | POST | `csrf:true`, bodyLimit 300000 | `postNativeChallenge` |
| `/api/account/native/finish` | POST | `csrf:true`, bodyLimit 300000 | `postNativeFinish` |
| `/api/account/native/token` | POST | `auth:BEARER`, `origin:NONE`, `csrf:false`, bodyLimit 300000 | `postNativeToken` |
| `/api/account/native/refresh` | POST | `auth:BEARER`, `origin:NONE`, `csrf:false`, bodyLimit 16384 | `postNativeRefresh` |
| `/api/account/native/logout` | POST | `auth:BEARER`, `origin:NONE`, `csrf:false`, bodyLimit 16384 | `postNativeLogout` |

Semantics, all against the frozen validators:

- **challenge** validates with `native-bridge.validateChallengeRequest`; the provider capability
  gate answers `PROVIDER_NOT_CONFIGURED` (V4 parity) before any network work. A caller with no
  credential gets the anonymous session the attempt must hang off, returned as `sessionToken` **in
  the body** — never a cookie. Response `{state, nonce, expires}` (+ `sessionToken` on that path).
- **finish** validates with `validateFinishRequest`, consumes the one-use attempt
  (`accounts.consume(…,'native')`), verifies the ID token for that exact nonce
  (`providers.verify(provider, idToken, nonce, 'native')`) and calls `accounts.finishVerified`.
  The rotated bearer is returned in the body; no cookie. `{linked, csrf, profile, created, actorId,
  sessionToken}` is the V4-compatible shape the shipped WebView path reads.
- **token** validates with `access-dto.validateNativeTokenGrant` — exactly one grant. The provider
  branch runs the same consume/verify/finish as `finish`, then `accounts.accessBinding` +
  `refresh.startFamily` + `access.issue(…)` produce the frozen response
  `{accessToken, refreshToken, expiresIn, actorId}`. The refresh branch rotates.
- **refresh** requires the refresh grant, then `refresh.rotate` — one durable single-flight
  rotation: the presented token dies, the successor is live, `access.verify` proves the new access
  token, and the durable family row is the only authority a concurrent second rotation can follow.
- **logout** resolves the bearer via `accounts.authenticateNative`, then
  `accounts.accessBinding`; it consumes the session FIRST (`accounts.logout`) and revokes the family
  LAST (`refresh.revokeForSession` / `revokeForActor`), because the native session projection
  (`sessions.nativeState`) requires the family to still be ACTIVE. Response `{signedOut:true}`.

**No cookie is ever set on any of the five.** `refuseNativeAmbiguity` refuses a cookie+bearer pair
with `AMBIGUOUS_CREDENTIAL` (401) on all three bearer routes, duplicating the ingress rule at the
mount so a directly-invoked handler cannot bypass it. On `challenge`/`finish` a cookie credential
still has to pass the declared CSRF check (JSON content type + `accounts.csrf`), exactly as
`/api/account/logout` does today.

**Body limits** are the contract's exact numbers, enforced by refusing:
`NATIVE_BODY_LIMITS = {challenge:300000, finish:300000, token:300000, refresh:16384, logout:16384}`.
A declared `Content-Length` over the ceiling is refused before a byte is buffered (drained, then
413); an undeclared stream is bounded by `parseJsonBody(req, limit)`. Never a truncation.

### Plumbing changed (no service logic)

| File | Change |
|---|---|
| `apps/api/routes/helpers.js` | new exported `resolveAccess(context)` (injected service, or lazy `createAccessService(context.pool, context.accessOptions)`); `resolveAuth` now uses it instead of an inline copy |
| `apps/api/routes/account.js` | the five handlers, the shared `performNativeRotation`, `resolveNativeRefresh` (composes `refresh` with the REQUIRED `mintAccess` from `access`), `nativeAudience`, dispatch entries, exports |
| `apps/api/config.js` | `nativeSessionConfig(env)` -> `{nativeAudiences, accessOptions, refreshOptions}` from `MEGA_ACCESS_ISSUER/ENVIRONMENT/KEY_FILE/PLAYER_AUDIENCES/SERVICE_AUDIENCES`, `MEGA_NATIVE_AUDIENCES`, `MEGA_REFRESH_*`; a partial configuration stays `accessOptions:null` (honest 503), never a fallback issuer/key |
| `apps/api/index.js` | `defaultHandler` passes `nativeSessionOptions(process.env)` into `createApiHandler` |

## 3. Commands and observed results

Suites are real loopback PostgreSQL 16 with the guarded `api_runtime` pool, the real
accounts/access/refresh services and a real RSA provider verifier with test-only keys. No SQLite,
no mocks, no provider/device claim.

```
node --test --test-force-exit tests/v5-p11-native-session.test.js                 # new suite
node --test --test-force-exit tests/v5-p11-session-boundary.test.js tests/v5-p11-vercel-config.test.js
node --test --test-force-exit tests/v5-p11-account-session-email.test.js tests/v5-p11-account-social.test.js
node --test --test-force-exit tests/v5-p11-browser-compat.test.js
```

Environment used for the two lab-backed runs (the lab cluster at `127.0.0.1:55471` is provided by
the machine's staging lab, plus Redis at `redis://127.0.0.1:6391`):

```
V5_PG_URL=postgres://postgres@127.0.0.1:55471/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
REDIS_URL=redis://127.0.0.1:6391 V5_REDIS_REQUIRED=1 V5_TARGET=test \
node --test --test-force-exit <suite>
```

**`tests/v5-p11-native-session.test.js` (new, 8 tests) — PASS 8 / FAIL 0**

```
✔ all five contract routes are mounted (not 404) and answer their own contracts
✔ no native route ever sets a Set-Cookie header, on success or on failure
✔ a cookie+bearer pair on token is refused with AMBIGUOUS_CREDENTIAL
✔ refresh rotates the family once; the old secret dies and a replay cannot fork it
✔ logout revokes the presenting family and the refresh credential stops working
✔ the contract body limits refuse an oversize payload instead of truncating it
✔ Origin and CSRF still bind cookie credentials; bearer credentials stay exempt
✔ an unconfigured P05 deployment refuses bearer issuance rather than inventing one
tests 8 · pass 8 · fail 0 · duration_ms 4160.9
```

Assertions actually exercised (not merely declared):

- All five routes answered `!= 404`, each on its own contract: challenge 200 with a
  43-char base64url state and integer `expires`; finish 200 with `linked:true`, `created:true` and a
  body-only `sessionToken`; token 200 with a 3-segment access JWT, a 43-char refresh secret and
  `expiresIn:300`; refresh 200 with a DIFFERENT successor secret; logout 200 `{signedOut:true}`.
- `Set-Cookie` was `undefined` on 13 distinct responses (10 probe shapes plus the four success
  paths), and no response echoed a cookie back in the body.
- cookie+bearer on token/refresh/logout -> 401 `AMBIGUOUS_CREDENTIAL` (all three routes).
- rotation: `access.verify` accepted the new token for `aud: mega-android`, `sub`/`sid` matched;
  `accounts.authenticateNative` accepted it as the same session; two CONCURRENT rotations of the
  same secret both answered 200 with the SAME single successor and left exactly
  `count(*) active families = 1`; after the bounded retry window was spent, presenting the dead
  secret again answered 401 `SESSION_REVOKED` and drove the durable family to `state='revoked'`
  with 0 active; the successor then also answered 401; an unknown secret answered 401.
- logout: the route-minted family's durable row read `state='revoked'`, the refresh secret answered
  401 `SESSION_REVOKED`, the consumed access token answered 401, and a sibling actor's family still
  rotated (200, `actorId:'svc_bob'`).
- limits: 1 byte over 300000 on challenge/finish/token -> 413 `BODY_TOO_LARGE`; over 16384 on
  refresh/logout -> 413 `BODY_TOO_LARGE`; EXACTLY 16384 bytes -> fully read and answered 401
  `SESSION_REVOKED` (a ceiling, not a margin; not truncated).
- boundary: foreign-origin and no-origin cookie POST -> 403 `ORIGIN_OR_CONTENT_TYPE`; an allowed
  origin passes the ingress (200) — the same rule `tests/v5-p11-browser-compat.test.js` pins for
  `/api/account/profile`; a cookie challenge with a wrong `x-csrf-token` -> 403 `CSRF_FAILED`, and
  with the genuine one -> 200 with no `sessionToken`; a cross-origin bearer refresh -> 200
  (bearer is CSRF-exempt by design); a bad intent -> 409 `INVALID_AUTH_REQUEST`.
- unconfigured deployment: refresh -> 503 `NATIVE_SESSION_UNAVAILABLE`, logout -> 503, no cookie.

**Pre-existing p11 suites — PASS**

```
tests/v5-p11-session-boundary.test.js + tests/v5-p11-vercel-config.test.js
  tests 28 · pass 28 · fail 0 · duration_ms 75.9
tests/v5-p11-account-session-email.test.js + tests/v5-p11-account-social.test.js
  tests 11 · pass 11 · fail 0 · duration_ms 3644.9
tests/v5-p11-browser-compat.test.js
  tests 8 · pass 8 · fail 0 · duration_ms 4046.9
```

## 4. Environment incident during verification

Mid-run the machine hit **"No space left on device"** on the Data volume (0 bytes free) and the
shared lab cluster on `127.0.0.1:55471` died (connection refused; it had already been down before
any cleanup). Ten orphaned `v5-p05lab-pg-*` clusters under `$TMPDIR` (all reparented to PID 1,
started Oct 12, no live parent) were stopped and removed; free space went ~0 -> 1.4 GiB. Main was
notified. The 55471 URL is no longer served by anything on this machine, so the final re-runs were
done with the lab's own self-spawned PG16 (`V5_PG_REQUIRED=1`, no `V5_PG_URL`), which needs no
shared cluster — the new suite was green in BOTH modes.

## 5. Not proven

- No live provider (Google/Apple), no real device, no staging origin, no deployed Vercel function
  was exercised. The provider verifier used real RSA signatures with repository test keys.
- No `native/**` file was touched; the Android/iOS clients' expectations were read only as the
  contract they freeze.
- Not committed, per instruction.
