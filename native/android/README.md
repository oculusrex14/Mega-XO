# Android Mega XO (P20 co-development)

This is an actual Android application target, not a WebView loading the deferred website. It packages the existing allowlisted Mega XO HTML/CSS/JS client at build time and serves it exclusively from AndroidX WebViewAssetLoader's HTTPS app-assets origin. Local bot/practice play needs no network.

## Build — two product flavors

The target has a `target` flavor dimension with two variants. **`offline` is the default and the
offline-only product is never lost**: it keeps `tools:node="remove"` on `INTERNET` and
`ACCESS_NETWORK_STATE`, so the artifact is network-isolated at the OS level.

```sh
# Offline-only product (no network permission at all)
gradle :app:assembleOfflineDebug

# Authenticated online target. Adds exactly INTERNET + ACCESS_NETWORK_STATE (AD_ID stays removed
# in BOTH flavors) and, only when an origin is named, installs the native session host.
gradle :app:assembleOnlineDebug -PmegaApiOrigin=https://<approved-api-origin>

# The same online target with NO origin: network permissions, but no host is baked in and the
# native transport stays unconfigured (fail-closed ONLINE_UNAVAILABLE).
gradle :app:assembleOnlineDebug
```

`megaApiOrigin` defaults to **empty** and must be an absolute HTTPS origin with no path, credentials
or query; the build refuses anything else. `megaGoogleServerClientId` is likewise opt-in and must be
an exact `*.apps.googleusercontent.com` server client ID, otherwise the Google adapter is simply not
compiled and the provider is not advertised.

### Store distribution

`megaStoreDistribution` is independent of the `offline`/`online` target flavor. It defaults to
`google-play`, which keeps the native billing route. Only a direct-download APK opts in to the web
store with the explicit value `direct-apk`:

```sh
gradle :app:assembleOnlineDebug -PmegaApiOrigin=https://megaxo.online \
  -PmegaStoreDistribution=direct-apk
```

Release builds use the same property together with the normal owner-approved package, version, API
origin and signing inputs. The direct build opens the fixed `https://megaxo.online/store` link in
the system browser after a user tap. The player signs in there with the same linked account; the app
does not transfer its native session. Omit the property for Google Play builds. iOS continues to
use StoreKit.

The `stageMegaClient` task runs `scripts/v5/build-client.js` from the repository root. It stages under Gradle user-home (outside the protected repository), then `generateMegaClient` syncs into `app/build/generated/megaAssets/mega`. The generated bundle is a build output, never committed. `app/build/outputs/apk/<flavor>/debug/app-<flavor>-debug.apk` is the unsigned-development/testing artifact (Gradle debug-signed).

The temporary `online.megaxo.prototype` application ID is **not** an approved Play package or signing identity. Store, ad and purchase surfaces remain unconfigured. Real package/signing identifiers must be verified from authorized provider configuration before release. A Gradle wrapper binary and signed AAB remain separate follow-up requirements.

## Trust boundary

- Main frame: only `https://appassets.androidplatform.net/assets/mega/*` is rendered internally.
- All HTTPS/HTTP remote subresources and unknown app-assets paths are refused. Only user-initiated external HTTPS links open in a system handler.
- `/api/*` requests from the **page** return `503 ONLINE_UNAVAILABLE` in **both** flavors. The
  offline APK additionally has no `INTERNET` permission, because WebView interception does not cover
  POST and OS-level egress denial is the only real guarantee there. Nothing fabricates sessions.
- **Online flavor only**, and only with `megaApiOrigin` set, the signed page receives
  `window.MegaNativeApi`: `session()`, `refresh()`, `signOut(allDevices)`, `signIn(provider,intent)`
  and `request(path, method, body, key)`. It is not a fetch proxy — JavaScript cannot name a host, a
  scheme, a header, a redirect target or an `Authorization` value. The access token lives in
  `MegaNativeSessionManager`'s memory, the refresh credential in the Keystore-backed
  `MegaSecureSessionVault`, and provider ID tokens are exchanged to the bearer inside Kotlin.
- There is still **no** `addJavascriptInterface`, and payment receipts, ad completion and any grant
  are not simulated.
- Local assets are signed as part of the APK; server authority, secrets and test code are omitted by the shared deterministic bundle builder.

## Authenticated online target (built, not yet live-verified)

`POST /api/account/native/{challenge,token,refresh,logout}` is the cookie-free credential path this
client speaks. Those routes are declared in `packages/contracts/routes.js` and validated by
`packages/contracts/access-dto.js`, but the live API does not mount them yet, so a real sign-in
cannot complete. See `docs/v5.1/release/NATIVE-ONLINE-TARGET-20261014.md` for the observed device
results and the exact remaining owner actions.

## Compiled provider adapters (not activated)

The existing `native/android/MegaGoogleIdentity.kt` is copied into generated Kotlin sources and compiled against the current stable Credential Manager 1.6.0 / Google ID 1.2.1 libraries. The provider must still use a real server-issued nonce and registered server client ID, and no JavaScript/native credential bridge is enabled until P05's secure transport exists. A green build does not imply live Google sign-in or Play account approval.

## Existing opt-in local notifications

The signed main-frame game now receives the existing `MegaNativeNotifications.requestPermission/notify` contract on supported Android WebView versions. It uses `WebViewCompat.addWebMessageListener` (exact app-assets HTTPS origin, `isMainFrame`, and exact signed entry URL), and document-start injection. Android 13+ asks for `POST_NOTIFICATIONS` **only** after the player uses the existing settings action; local alerts are emitted only with OS permission while the app is not foregrounded. Notification taps return safely to the existing game activity. This is not FCM/APNs, backend actor-linked push, or proof of device notification delivery; no such feature is enabled until P05 identity, provider credentials and explicit consent are integrated.

## Native Google identity UI bridge (not yet live)

On Android, `MegaNativeIdentity.getCredential({provider:'google',nonce})` now uses the real Credential Manager helper, **only when** the exact approved Web/server Google OAuth client ID is provided using Gradle property `megaGoogleServerClientId`. The trusted-document-start message bridge is restricted to `https://appassets.androidplatform.net`, the main frame and `bundle-index.html`; it returns an ID token, not an actor or locally accepted sign-in. No value is supplied by default. Backend native challenge/finish and its P05 actor/session validation are still required before this can work end-to-end. Never put the OAuth client secret, refresh credential or provider API keys into Gradle or the game bundle.
