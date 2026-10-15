# Google sign-in: exactly what must be configured (priority 1, 2026-10-15)

Codex is setting up the Google Cloud project for Google sign-in. This records the **exact** values to
enter and the **code gaps** that must be closed for sign-in to work end-to-end, all derived from the
source and verified against the live deployment rather than assumed.

## 1. Live state observed (verified, not assumed)

| Probe | Result |
| --- | --- |
| `GET https://megaxo.online/api/account/session` | `200`, `"providers":{}` — **no provider is enabled** |
| `POST https://megaxo.online/api/account/native/challenge {"provider":"google"}` | `200` (nonce/state issued) |
| `POST .../native/finish` with the matching state + any token | **`PROVIDER_NOT_CONFIGURED`** |
| `POST https://megaxo.online/api/account/start` (the web OAuth start) | **`NOT_FOUND`** |
| `GET https://megaxo.online/auth/callback/google` (no params) | `303 /?authError=INVALID_CALLBACK_PARAMS` (a contract check only) |
| In-app Google button (Android, signed-in sheet) | no-op; both Google and Apple render greyed |

## 2. What to create in Google Cloud

Use the owner's business identity/project (Codex found organisation `antimatterinnovations.com`; there
is **no** Mega XOXO project yet — do not reuse the generic "My First Project" without the owner
choosing it). Then, in **APIs & Services → Credentials**, create **one "Web application" OAuth client**
and configure:

**Authorized JavaScript origins** (these only matter if a browser SDK loads on the page; the source uses
a backend redirect flow, so list the exact page origins that will start sign-in):

```
https://megaxo.online
https://www.megaxo.online
```

**Authorized redirect URIs** (exact match required at runtime — scheme, host, path, no trailing slash):

```
https://megaxo.online/auth/callback/google
```

That is the canonical production callback the source derives as `<MEGA_ORIGIN>/auth/callback/google`.
Do **not** register the retired `play.antimatterinnovations.com/auth/callback/google` (historical V4
callback) or `staging.play.antimatterinnovations.com` — the game no longer serves from either host.

**Scopes:** the source requests only `openid profile` (no Google email scope, because the product uses
its own player identity). **PKCE S256, state and nonce** are used; `prompt=select_account`.

**Consent screen:** External audience unless the owner decides otherwise; publish the policy/support
URLs that already exist on the canonical host (`/privacy`, `/terms`, `/support`, `/delete-account`).
Add the owner + test accounts (including `mothervader693@gmail.com`) as test users while unverified.

## 3. Server environment this must feed

The web code flow reads (`server/production/config.js`):

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the Web client ID from above |
| `GOOGLE_CLIENT_SECRET` | server-only secret (never in the client, never in Git) |
| `GOOGLE_NATIVE_AUDIENCES` | the **same Web client ID** — Android Credential Manager's `megaGoogleServerClientId` must equal it, so one audience validates web and native ID tokens |
| `GOOGLE_AUTHORIZED_PARTIES` | leave empty unless a specific party is required; never a wildcard |

Android release build input: `-PmegaGoogleServerClientId=<the same Web client ID>`.
iOS uses the same Web client ID as its `GIDClientID` equivalent.

## 4. Code gaps that block sign-in today (must be closed by Codex/Main)

Registering the client alone will **not** make sign-in work. Two independent gaps exist:

1. **No web OAuth start/consume in V5.** `POST /api/account/start` returns `NOT_FOUND` on the live
   authority, and `/auth/callback/google` only validates the presence of `code`/`state` — it never
   consumes the one-use state, exchanges the code, verifies the ID token, or establishes a session.
   The working implementation exists only in the legacy `server/community-http.js`
   (`/api/account/start`, `/auth/callback/:provider`), which the V5 production server does not compose.
   → Port that flow into `apps/api/routes/account.js` (start + callback) and compose
   `IdentityProviders` in `scripts/v51/v5-production-server.cjs`.
2. **No native session mint for email sign-in.** The native transport only accepts the four
   `/api/account/native/*` credential routes without a bearer. `POST /api/account/email` issues a
   **cookie** session, which a native host cannot hold (no cookie jar), so the app's own
   "Continue with email" cannot authenticate natively. → Either add an email branch to the declared
   native token family (a server-side bearer mint) or give native guests a clear alternative. This is
   an auth-surface change and needs a deliberate decision; it was **not** made here.

## 5. Apple, for the follow-on

- Web Service ID with return URL `https://megaxo.online/auth/callback/apple` (the source uses
  `response_mode=query`, code-only, no scopes).
- `APPLE_TEAM_ID` = `D5TQJ76T44` (owner-confirmed) and a Key ID + `.p8` private key held server-side.
- Native audience = bundle id `online.megaxo.xoxo`.
- Server also expects `APPLE_CLIENT_ID` (the Service ID) and, for web, the generated client secret.

## 6. How to verify once configured (no guesswork)

```sh
# providers should stop being empty
curl -s https://megaxo.online/api/account/session | grep -o '"providers":{[^}]*}'
# the web start should return a real Google URL whose redirect_uri is the canonical callback
curl -s -X POST https://megaxo.online/api/account/start \
  -H 'content-type: application/json' -d '{"provider":"google","intent":"login"}'
# then follow the URL, sign in, and confirm the callback sets a session and lands on /?account=linked
```

Acceptance = a real browser round-trip that ends with `linked:true` and a durable actor id, plus the
same actor observed from the Android app after `MegaNativeApi.signIn('google', …)`.

## Access note

I could not enter these values: the omp browser relay is version-stale (`extensionSeen:false`, no
`Simulator.app`/Brave CDP endpoint) so the managed browser lands on the Google sign-in wall, and the
`gcloud` CLI identity (`oculusrexai@gmail.com`) has no access to the business organisation. The values
above are complete and ready to paste; entering them needs the owner's authenticated console session.
