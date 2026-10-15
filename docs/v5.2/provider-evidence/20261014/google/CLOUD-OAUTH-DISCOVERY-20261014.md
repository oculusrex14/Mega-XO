# Google Cloud / OAuth discovery — Mega XOXO V5.2

**Observation:** 2026-10-14 17:32 UTC. **Source checkout:** `/Users/oculus/.codex/worktrees/v52-provider-release/Test XO`, HEAD `599dcf9882485983340e19b4063d0b85f8eb0883`.

This is a sanitized read-only discovery and source-readiness record. Console inspection used the owner-approved browser identity, not the separate gcloud CLI identity. Browser tabs: Google Auth Platform overview `1438672373`; read-only IAM/credentials inspection `1438672384`. The primary overview tab is left available for Main/root handoff. No secrets, OAuth codes/tokens, client-secret payloads, OTPs, account-holder name, or unrelated principal data are recorded.

## Existing Google Cloud project and access

- The organization selector showed `antimatterinnovations.com`, organization ID `437979300825`. The only project visible there was the generic **My First Project**, project ID `silken-obelisk-511505-b2`. Project-selector searches for “Mega” and “Antimatter” returned no resources. No Mega XOXO-specific project was found. Do not treat the generic project as the final Mega XOXO project without Main/owner selection; do not create a duplicate.
- The project IAM page showed the approved business principal with direct **Owner** role on this project and **Organization Administrator** granted through the organization. This establishes broad existing access to this generic project, not selection/approval of it as Mega XOXO’s project. No IAM change was made.
- The authenticated console navigation succeeded without a device-verification, MFA, or reauthentication challenge. The observed pages did not provide a separate security/device-verification completion receipt, so that status is **not independently confirmed**.
- A “Start your Free Trial with $300 in credit” banner was present. “Start free” was not clicked; no billing profile, trial, payment, or paid service was started.

## Existing credentials and Auth Platform state

Read-only `APIs & Services → Credentials` in `silken-obelisk-511505-b2` showed:

- API Keys: **No API keys to display**.
- OAuth 2.0 Client IDs: **No OAuth clients to display**.
- Service Accounts: **No service accounts to display**.

Google Auth Platform Overview showed **“Google Auth Platform not configured yet”** and a **Get started** link. Get started was not clicked. No app branding, audience, data-access scopes, client, verification request, key, service account, or OAuth consent screen was created or published.

**Observed state:** existing generic Cloud project and owner access only. **Not configured / not registered / not tested / not submitted / not verified / not live.**

## Source-grounded OAuth design draft

The current provider implementation defines a server-side Google authorization-code flow at `server/identity-provider.js` and `server/community-http.js`:

- `server/identity-provider.js` requests scope `openid profile`, `response_type=code`, state, nonce, PKCE `S256`, and `prompt=select_account`; it does not request the Google email scope. The verifier checks Google issuer, configured audience, nonce and token timing and returns provider subject rather than email-based linking (`server/identity-provider.js:15-34`).
- The server-side web client inputs are `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; the secret is server-only. The native verifier reads the exact configured `GOOGLE_NATIVE_AUDIENCES` and optional `GOOGLE_AUTHORIZED_PARTIES` (`server/production/config.js:63-64,108`; `server/identity-provider.js:17-20,32-34`). No values were read from local or deployment environments.
- The Android Credential Manager adapter calls `GetSignInWithGoogleOption.Builder(serverClientId)` with a server-issued nonce. Its Gradle input `megaGoogleServerClientId` defaults empty (`native/android/MegaGoogleIdentity.kt:11-28`; `native/android/app/build.gradle.kts:11-16,75-85`). Google’s Android implementation guide says this value is the OAuth **Web Client ID**. Therefore the source-aligned native plan is to keep `megaGoogleServerClientId`, backend `GOOGLE_CLIENT_ID`, and the native token audience aligned to the same exact Web client ID unless Main deliberately specifies another audience. Keep `GOOGLE_AUTHORIZED_PARTIES` exact and empty unless Main identifies a required party; no wildcard is justified.
- The native source path is `POST /api/account/native/challenge` followed by `POST /api/account/native/finish`, with a server-issued nonce and server-side ID-token verification (`apps/api/routes/account.js:633-685`). This is source capability only; no configured audience/client or verified production deployment was found.

### Web client origin and redirect are not ready to register

- The previous provider setup note records `https://megaxo.online/auth/callback/google` as the **planned** production callback, not as a registered client or verified live route (`docs/p21-web/PROVIDER-SETUP-20261012.md`).
- In the fuller `server/community-http.js` flow, `/api/account/start` constructs the redirect as `<origin>/auth/callback/google`; the callback consumes state, exchanges the code using that exact URI plus the PKCE verifier, verifies the token, and sets the session cookie (`server/community-http.js:25-26,83-87`). This is a separate server handler; the release evidence does not establish it as the current production route.
- The V5.2 Vercel API’s `apps/api/routes/account.js` implements native challenge/finish but has no web `/api/account/start` branch. Its `apps/api/routes/well-known.js` callback only checks that `code` and `state` are present and redirects; it does not consume state, exchange code, verify the token, or set a session (`apps/api/routes/well-known.js:207-258`). The static `apps/web/vercel.json` has no `/auth/callback/google` rewrite. This makes the old planned apex callback nonfunctional in the current V5.2 route map.
- The V5.2 public-host plan has web origins `megaxo.online` / `www.megaxo.online` and API host `api.megaxo.online`, but DNS still points to parking and the Vercel domain evidence says no production alias or public cutover occurred (`docs/v5.2/release/EXECUTION-BOARD-AND-CONTRACTS-20261014.md`; `docs/v5.1/release/VERCEL-DOMAIN-PREPARED-20261014.md`). There is no verified production HTTPS OAuth origin or callback.
- **Draft only, not entered in Cloud Console:** use a Web application OAuth client for the server code flow. Main must choose the served frontend origin(s) and implement/confirm which exact HTTPS host owns the callback before registration. Do not add `api.megaxo.online` as a JavaScript origin unless browser JavaScript is actually served from that host. Do not register both apex and `www` automatically. Exact scheme, host, path and trailing slash must match at runtime. For the legacy source shape the redirect would be `<MEGA_ORIGIN>/auth/callback/google`; neither the intended public `MEGA_ORIGIN` nor its working deployed handler is presently confirmed.
- The source uses backend redirects rather than a Google browser JavaScript SDK, so an authorized-JavaScript-origin list is not currently source-required. If Main adds a browser GIS flow, list only the exact HTTPS page origin(s) that will load that code. Branding/authorized-domain values also wait for verified public-domain ownership and live policy/support pages.
- Main must also settle whether OAuth audience is public/external or otherwise constrained and name the monitored support contact. Do not guess tester accounts, age/privacy responses, audience or consent declarations. Current source requests only `openid profile` and makes no Google email API request; verification status will depend on the final published configuration and Google’s review requirements.

## Android package and signing dependencies

The owner-selected Android target remains `online.megaxo.xoxo`, available in the Play create-app form but not registered. The signed AAB documented for this release is package `online.megaxo.game`, SHA-256 `3e61f4d05842acd38bfa123186727fd350fbca95ecd629c4911e8ea7e6498933`, so Main’s artifact/package alignment is still blocking. The source namespace remains `online.megaxo.prototype` and `megaGoogleServerClientId` is empty by default.

The documented local upload certificate fingerprint is SHA-256 `96:1C:C0:54:74:57:0E:60:58:4A:14:14:2B:B0:E3:D6:45:80:4B:CB:4C:16:88:62:A6:94:5E:41:75:32:93:37`; it is an **upload certificate**, not a Play app-signing certificate. The Play app-signing certificate is unavailable until the app record/Play App Signing setup exists. Google's Play App Signing guidance says API providers should receive the Play-held app-signing certificate fingerprint for distributed builds. Google's Android OAuth client setup separately requires final package name plus SHA-1 when an Android client type is actually needed. The current Credential Manager implementation instead uses a Web client ID; Main should confirm whether a separate Android OAuth client is necessary before creating one. Do not substitute the upload SHA-256 for the Play signing fingerprint or infer SHA-1 from it.

No Android OAuth client can be safely registered yet: final package/artifact alignment is unresolved, Play App Signing is not configured, and this project has no existing clients. No Play build or app record was changed. Cross-reference: `docs/v5.2/provider-evidence/20261014/play/CONSOLE-AND-LISTING-DRAFT-20261014.md`.

## Exact remaining inputs before configuration

1. Main’s acknowledgment/aligned release package and a final Android artifact for `online.megaxo.xoxo`.
2. Main’s explicit production deployment contract: exact public `MEGA_ORIGIN`, frontend origin(s), callback host/path, and a working V5.2 handler that consumes one-use state, exchanges/verifies the code, checks nonce/PKCE and establishes the session.
3. Main’s planned identity architecture: whether only a Web client will serve both web and native sign-in (as current Android Credential Manager source expects), whether a separate Android OAuth client is truly required, exact allowed native audience(s), and any exact authorized party.
4. Owner/Main selection of the appropriate existing Cloud project and truthful branding/support/audience/policy answers. Do not start Auth Platform setup, publish consent branding, create a client or transmit secret material before this is settled.
5. If a separate Android client is required: exact final package plus required SHA-1 certificate(s), including the Play app-signing certificate after Play setup.

## Official Google sources checked 2026-10-14

- [Google Auth Platform setup and app configuration](https://support.google.com/cloud/answer/15544987?hl=en) — branding, audience, client and scope areas.
- [OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server) — Web application credential type, exact authorized redirect URI matching, server-side client-secret custody, state verification.
- [Google Auth Platform credential setup](https://support.google.com/googleapi/answer/6158849?hl=en) — origins for browser JavaScript clients; redirect URIs for server applications; Android client package plus SHA-1 requirements.
- [Android Credential Manager Sign in with Google](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation) — `setServerClientId` is the Web Client ID.
- [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en) — use the Play-held app-signing certificate fingerprint with API providers.

## Actions taken

Read-only browsing, IAM metadata inspection, source/docs review, and creation of this local evidence record only. No project/client/service account/key/consent configuration created or changed; no access scope expanded; no trial or payment action occurred; no API endpoint or OAuth callback tested against a live service; no legal or policy declaration accepted; no upload, submission, build, application-source edit, commit or push occurred.
