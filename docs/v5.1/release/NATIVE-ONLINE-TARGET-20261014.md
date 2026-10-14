# Native authenticated online target — 2026-10-14

**Scope:** enable and wire the authenticated **online** Android target behind the preconditions its
manifest named, give the same lifecycle to iOS, keep a real offline-only build, align the association
files to the *built* app ids, and prove on the already-connected phone only what was actually run.

**Headline:** the online target is built, installed and **live on the physical device** with the
native session host, the JS bridge and the vault in place, and the WebView API surface still
hard-blocked. **A real provider sign-in was NOT executed**, because the cookie-free native routes this
client speaks to are declared in `packages/contracts/routes.js` but never mounted in
`apps/api/routes/account.js` — they answer **404** on both live origins. That mount is owned by the
main agent; this report states exactly where the client stands and what remains.

---

## 1. What changed

### Server (association / continuity)

`apps/api/routes/well-known.js` — both association defaults now name the **built** application ids
instead of an unregistered production identity:

| File | Before | Now |
| --- | --- | --- |
| `assetlinks.json` `package_name` | `com.antimatterinnovations.megaxo` | **`online.megaxo.prototype`** (`megaApplicationId` default) |
| `assetlinks.json` `sha256_cert_fingerprints` | a real-looking hardcoded digest | **zero placeholder**, named `ASSOCIATION_PLACEHOLDER_FINGERPRINT` |
| `apple-app-site-association` `appIDs`/`apps` | `TEAMID.com.antimatterinnovations.megaxo` | **`TEAMID.online.megaxo.prototype`** |

`TEAMID` and the fingerprint stay **labelled placeholders**. No release keystore and no Apple Team ID
exist, so a fabricated fingerprint would be a falsified claim; a placeholder statement associates
nothing and is the honest state. `tests/v5-p11-website-foundations.test.js` was updated to pin the new
package id and to assert the fingerprint is well-formed SHA-256 **even while a placeholder**.

### Android — session lifecycle

| File | Change |
| --- | --- |
| `MegaNativeSessionManager.kt` | **new.** The only holder of access (memory) + refresh (Keystore vault). Provider grant, server-issued challenge, single-flight refresh, best-effort logout, strict frozen-shape response validation, terminal-revocation teardown. All vault I/O runs on its own single-thread executor with completions posted back to the main thread, so a Keystore key lookup never blocks the UI thread that WebView callbacks arrive on. |
| `MegaNativeHttpClient.kt` | Split into two disjoint surfaces: `request(...)` (game calls; bearer is **the token the session installed**, never a parameter) and `authRequest(...)` (the four cookie-free native routes; bearer supplied deliberately by the session owner, or absent for a first sign-in). No `Cookie` header is ever composed. Existing host/scheme/path/redirect refusals unchanged. |
| `MegaNativeApiBridge.kt` | **new.** The JS→native API bridge: path/method/body/key only — no token, cookie, header or host parameter. Runs the whole sign-in (`challenge` → provider SDK → `token`) inside Kotlin. Origin-scoped, main-frame only, pinned to the signed entry document. |
| `MegaAndroidIdentityBridge.kt` | Added `credential(provider, nonce, complete)` so the transient ID token need not pass through JavaScript. |
| `MegaXOActivity.kt` | Installs the session host **only** when `MEGA_ONLINE_TARGET && MEGA_API_ORIGIN.isNotEmpty()`. `/api/*` interception stays hard-blocked in **both** flavors. |
| `app/build.gradle.kts` | **Additive only:** `megaApiOrigin` Gradle property → `BuildConfig.MEGA_API_ORIGIN`, default **empty**, validated as an absolute credential-free/path-free/query-free HTTPS origin. |

### iOS — same lifecycle (parity, compiled but not device-run)

`MegaNativeSession.swift` (new), `MegaIOSApiBridge.swift` (new), `MegaNativeHTTP.swift`
(`authRequest`, `isConfigured()`), `MegaIOSIdentityBridge.swift` (`credential(nonce:)`),
`MegaXOApplication.swift` (installs both when `MegaApiOrigin` is non-empty), `Info.plist` +
`project.pbxproj` (`MEGA_API_ORIGIN = ""` default, two new files registered in the target).

### Shared client

`src/account-client.js` — native-first bootstrap (`MegaNativeApi.session()` → refresh-on-expiry →
`/api/account/profile`), a `logout()` that revokes through the host, and `REVOKED` classified as an
**auth** state (sign in again), never as an outage. The cookie path is untouched and still used
whenever no native host is present.
`src/community.js` — provider sign-in prefers the native branch (no ID token in page scope) and falls
back to the existing `MegaNativeIdentity` JS bridge, then the browser redirect.

### Tests

`tests/v5-native-online-target.test.js` — **19 new assertions**. `tests/v5-native-foundations.test.js`
— the transport pin was re-pointed at the two-surface transport (31 assertions, unchanged count).
Nothing in either suite contacts a provider, device, or live origin.

---

## 2. Exact build/run commands

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
G=~/.gradle/wrapper/dists/gradle-8.13-bin/e2local/gradle-8.13/bin/gradle
JDK 17 (Temurin 17.0.20.1)

# offline-only product (the default artifact)
$G -p native/android :app:assembleOfflineDebug

# online target WITHOUT an origin: network permissions only, host still unconfigured
$G -p native/android :app:assembleOnlineDebug

# online target against a real origin (the build used for the device run)
$G -p native/android :app:assembleOnlineDebug \
   -PmegaApiOrigin=https://mega-xo-gik7maifp-oculusrex14s-projects.vercel.app

# iOS parity
xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -sdk iphonesimulator \
  -configuration Debug -derivedDataPath /tmp/megaxo-ios-dd CODE_SIGNING_ALLOWED=NO build

# suites
node --test --test-force-exit tests/v5-native-foundations.test.js \
                            tests/v5-native-online-target.test.js tests/v5-client-bundle.test.js
```

Device: OnePlus **EB2101**, Android **13** (SDK 33), serial `5199676e`, `adb` at
`~/Library/Android/sdk/platform-tools/adb`.

---

## 3. Real observed results

### Builds and effective permission sets (`aapt dump permissions` on the built APKs)

| Artifact | bytes | sha256 | INTERNET / NETWORK_STATE / AD_ID |
| --- | --- | --- | --- |
| `app-offline-debug.apk` (final) | 27 561 344 | `36ffc50ad7008c6c17e15258e53d32f00f202e75be237db60878c95d8657c6f6` | 0 / 0 / 0 |
| `app-online-debug.apk` (final, no origin) | 27 561 584 | `663e0a48e77d2fb97173cebe8e1672982f4ce1cf672d0c62b3b2b3e174f18b48` | 1 / 1 / 0 |
| `app-online-debug.apk` (device run, `megaApiOrigin` set) | — | `b4c8c967fd3953c98a346d74dcb7f9d6ebbda08fc3157f3db94a07b5c51c94ea` | 1 / 1 / 0 |

The delta between the two flavors is **exactly** the two network permissions: every other declared
permission is identical, and `com.google.android.gms.permission.AD_ID` is absent from the effective
set of both. The offline artifact declares no network permission at all.

The installed online package reports `android.permission.INTERNET: granted=true` and
`ACCESS_NETWORK_STATE: granted=true`, and **no** `com.google.android.gms.permission.AD_ID` line.
`:app:assembleOnlineRelease` still **FAILS** (prototype package / no owner keystore) — the release
guard is intact.

### Device run — installed, launched, driven over CDP (verbatim)

```
page: https://appassets.androidplatform.net/assets/mega/bundle-index.html
bridge present: object
session: {"ok":true,"linked":false,"expiresAt":0,"online":true,"providers":[],"id":5}
refresh: {"ok":false,"error":"INVALID","id":7}
token fetch: {"ok":false,"error":"ONLINE_UNAVAILABLE","status":0,"id":8}
bad path refused: {"ok":false,"error":"INVALID_NATIVE_REQUEST","status":0,"id":9}
page fetch /api/account/profile: 503 {"error":"ONLINE_UNAVAILABLE"}
home rendered: 5
token in page scope: false
logcat MegaXOStartup: READY game_initialized=true nav=5
```

Readings that are genuinely proven by this:

* the native session host and bridge are **live in the real WebView** (`bridge present: object`,
  `online: true` — the origin was compiled in and validated);
* `providers: []` is honest: no native session exists yet and no provider adapter was compiled
  (`megaGoogleServerClientId` was not supplied), so nothing advertises a capability it lacks;
* a client-chosen host is refused at the bridge (`INVALID_NATIVE_REQUEST`);
* the WebView's own `/api/*` fetch is still the fail-closed native answer, in the **online** flavor —
  the page has no network path of its own;
* no access token exists in page scope (`token in page scope: false`);
* the signed game still initializes (`READY game_initialized=true nav=5`).

The phone was returned to the **offline** artifact afterwards
(`adb install -r app/build/outputs/apk/offline/debug/app-offline-debug.apk`) and the CDP port forward
was removed.

### Suites

```
tests/v5-native-foundations.test.js + tests/v5-native-online-target.test.js + tests/v5-client-bundle.test.js
  → 66 assertions, 66 pass, 0 fail

with static-ui, v5-p21-friends, v5-p21-brand, product-copy, v5-p21-account-web,
v5-p11-vercel-config, v5-p12-read-cache, v5-p05-access, v5-contracts
  → 105 assertions, 92 pass, 0 fail, 13 skipped (PG-gated; no V5_PG_URL in this shell)
```

### iOS

`** BUILD SUCCEEDED **` (re-run after the threading change; no warning introduced) for the simulator target, with the two new Swift files compiled. No warning
introduced by this work.

---

## 4. NOT executed — and exactly why

1. **A real provider sign-in on the device. NOT RUN.** The client is built and installed and speaks
   the frozen contract, but the server never answers:
   `POST /api/account/native/{token,challenge}` → **`404 {"error":"NOT_FOUND"}`** on
   `https://command.tail95c48c.ts.net` **and** on the Vercel preview
   `https://mega-xo-giK7maifp…vercel.app`. The routes are declared in
   `packages/contracts/routes.js:59-61` and validated by `packages/contracts/access-dto.js`, but
   `apps/api/routes/account.js` does not mount them. **Main owns that mount** and is implementing it;
   the live round-trip must be re-run once it deploys. The claim here is therefore
   *"wire-shaped correctly and installed; live credential round-trip not run"*.
2. **No native Google adapter was compiled**, because no authorized
   `*.apps.googleusercontent.com` server client ID exists anywhere in this environment. Sign-in
   cannot complete even with the mount until the owner supplies that ID (build property
   `megaGoogleServerClientId`). Nothing was invented to work around it.
3. **The device cannot reach the tailnet staging origin at all** — `ping: unknown host
   command.tail95c48c.ts.net`; the phone is not on the tailnet. Any future device run must target the
   publicly reachable origin.
4. **iOS was not run on a device or simulator** — compiled only (`CODE_SIGNING_ALLOWED=NO`), matching
   the existing native boundary. No Apple Team ID, no associated-domains entitlement, no signing.
5. **No provider console, store, ad or purchase surface was touched.** Store publication stays
   excluded.

---

## 5. Still needs the owner

| # | Item | Why it blocks |
| --- | --- | --- |
| 1 | Mount `POST /api/account/native/{challenge,token,refresh,logout}` | Main agent, in progress; until then there is no cookie-free credential path to test against |
| 2 | A real Google **server** OAuth client ID (`megaGoogleServerClientId`) | Without it the Google adapter is not compiled and the button is correctly disabled |
| 3 | Real Android package id + upload-certificate SHA-256 | Replaces the labelled placeholder currently served in `assetlinks.json` |
| 4 | Apple **Team ID** + App ID with associated domains | Replaces `TEAMID` in `apple-app-site-association`; enables the iOS entitlement |
| 5 | An approved public API origin for the online build | The online flavor is origin-*opt-in* by design; nothing is baked in until one is approved |
