# iOS Mega XOXO native host (P20 co-development)

A checked-in Xcode application target embeds the approved client bundle. It does **not** load the deferred megaxo.online website. Swift WebKit hosts the offline game inside a restricted signed `MegaClient/` resource directory.

## Build

Requirements: Xcode 16+, Node 24, iOS Simulator SDK. From repository root:

```sh
xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO \
  -configuration Debug -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO build
```

The authenticated online target needs a named origin. Without it the native session host is not
installed at all and the app is the offline host:

```sh
xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -configuration Debug \
  -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO \
  MEGA_API_ORIGIN=https://<approved-api-origin> build
```

`MEGA_API_ORIGIN` is empty in both checked-in configurations, so no host is ever baked in by
default. `MEGA_APPLE_NATIVE_ENABLED=NO` still gates the Sign in with Apple capability.

The Xcode shell phase invokes the shared deterministic `scripts/v5/build-client.js` generator and copies the generated files into the app's resource bundle before codesigning. No unapproved game logic, remote font, or asset dependency is introduced.

## Current security/feature boundary

- Only signed `file://` resources **inside MegaClient/** may navigate inside WKWebView; external HTTPS links open only from direct user navigation. Redirects, additional windows, untrusted iframes and JavaScript dialogs are restricted.
- No arbitrary `WKScriptMessageHandler` is attached. Two typed, main-frame-only handlers exist and
  each checks that the sender is the exact signed `bundle-index.html`:
  `megaNativeNotifications` (opt-in local alerts) and — only when `MEGA_API_ORIGIN` is set —
  `megaNativeApi`.
  The API handler exposes `session()`, `refresh()`, `signOut(allDevices)`,
  `signIn(provider,intent)` and `request(path, method, body, key)`. It is **not** a fetch proxy:
  JavaScript cannot name a host, scheme, header, redirect target or `Authorization` value. The
  access token lives in `MegaNativeSession`'s memory and the refresh credential in
  `MegaNativeSecretVault` (Keychain, this-device-only, non-synchronizing); a provider ID token is
  exchanged to the bearer inside Swift. The WebView's blanket `https?` content-block rule is
  unchanged, so the page itself still has no network path.
- `POST /api/account/native/{challenge,token,refresh,logout}` is the cookie-free credential path this
  client speaks. Those routes are declared in `packages/contracts/routes.js` and validated by
  `packages/contracts/access-dto.js`, but the live API does not mount them yet, so a real sign-in
  cannot complete. See `docs/v5.1/release/NATIVE-ONLINE-TARGET-20261014.md`.
- iOS file-origin storage semantics require real simulator/device acceptance; a passing compile does not prove offline persistence on every supported OS.
- Temporary `online.megaxo.prototype` bundle ID has no known App Store entitlement. Signing identities, associated domains, StoreKit/ads, app icons, privacy consent and physical-device acceptance remain separate tasks. Release signing is disabled by default until authorized configuration exists.
- The shared asset manifest must match Android's bundle hash for the same source revision.

No store upload, real device execution, login, purchasing or notification delivery is claimed here.

## Compiled Apple provider adapter (not activated)

The existing `native/ios/MegaAppleIdentity.swift` is included directly in the Xcode target and is
reachable from `MegaNativeIdentity.getCredential({provider:'apple',nonce})` (page path) and from
`MegaIOSIdentityBridge.credential(nonce:)` (the native `signIn` path, where the ID token never enters
JavaScript). It uses Apple's real AuthenticationServices request and a server-issued nonce, but has
no configured App ID capability yet. Successful compilation is not Apple provider verification or an
App Store entitlement.

## Existing optional local notifications

The approved user-enabled notification preference now has a guarded `MegaNativeNotifications` implementation on iOS. The handler accepts calls only from the app-signed **main** `bundle-index.html`, requests system permission only when the existing UI calls `requestPermission()`, and posts validated local alerts only while the app is not active and permission exists. This is not APNs registration or proof of background push delivery; those depend on backend identity/device-token registration and approved provider configuration. No new notification campaign or unsolicited system prompt is introduced.

## Native Apple sign-in UI bridge (configured App IDs only)

The real `MegaAppleIdentity` SDK helper now serves `MegaNativeIdentity.getCredential({provider:'apple',nonce})` through `WKScriptMessageHandlerWithReply` restricted to the **exact signed main** `bundle-index.html`. It remains off with `MEGA_APPLE_NATIVE_ENABLED=NO` until the owner verifies the bundle/App ID, Apple Sign in capability and server-side native audience/challenge flow. An ID token is only provider evidence; the app does not create a new account or grant a success result until the common backend authenticates the permanent actor. Neither this feature flag nor an iOS Simulator build proves live Apple sign-in.
