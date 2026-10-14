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
- No arbitrary `WKScriptMessageHandler` is attached. Three typed, main-frame-only handlers exist and
  each checks that the sender is the exact signed `bundle-index.html`:
  `megaNativeNotifications` (opt-in local alerts), `megaLanDiscovery` (the same-Wi-Fi room
  transport, synchronous half excluded — see below) and — only when `MEGA_API_ORIGIN` is set —
  `megaNativeApi`.
  The API handler exposes `session()`, `refresh()`, `signOut(allDevices)`,
  `signIn(provider,intent)` and `request(path, method, body, key)`. It is **not** a fetch proxy:
  JavaScript cannot name a host, scheme, header, redirect target or `Authorization` value. The
  access token lives in `MegaNativeSession`'s memory and the refresh credential in
  `MegaNativeSecretVault` (Keychain, this-device-only, non-synchronizing); a provider ID token is
  exchanged to the bearer inside Swift. The WebView's blanket `https?` content-block rule is
  unchanged, so the page itself has no direct network path; the one exception is the same-Wi-Fi room
  transport below, which relays only `/api/party/*` to a literal private address.
- `POST /api/account/native/{challenge,token,refresh,logout}` is the cookie-free credential path this
  client speaks. Those routes are declared in `packages/contracts/routes.js` and validated by
  `packages/contracts/access-dto.js`, but the live API does not mount them yet, so a real sign-in
  cannot complete. See `docs/v5.1/release/NATIVE-ONLINE-TARGET-20261014.md`.
- iOS file-origin storage semantics require real simulator/device acceptance; a passing compile does not prove offline persistence on every supported OS.
- Temporary `online.megaxo.prototype` bundle ID has no known App Store entitlement. Signing identities, associated domains, StoreKit/ads, app icons, privacy consent and physical-device acceptance remain separate tasks. Release signing is disabled by default until authorized configuration exists.
- The shared asset manifest must match Android's bundle hash for the same source revision.

No store upload, real device execution, login, purchasing or notification delivery is claimed here.

## Same-Wi-Fi LAN room transport (`MegaNativeLan.swift`)

The private lobby's host can be the phone itself. `src/lan/lan-host.js`, `lan-room-http.js` and
`lan-room-store.js` already ship in this bundle and own every room rule; this bridge owns only the two
things JavaScript cannot have — a real TCP listener and a Bonjour record — and publishes exactly the
frozen primitives those modules read at call time:

```js
window.MegaLanSocket.start(port)  -> {ok:true, port} | {ok:false, error:'BIND_FAILED'|'START_FAILED'}
window.MegaLanSocket.stop()       -> {ok:true}
window.MegaLanSocket.status()     -> {listening, port, origin}
window.MegaLanDiscovery.advertise(name, port) -> {ok:true} | {ok:false, error}
window.MegaLanDiscovery.stop()    -> {ok:true}
window.MegaLanDiscovery.browse(timeoutMs) -> Promise<[{name, origin, rooms}]>
```

- `start`, `stop`, `status` and `advertise` are **synchronous** in that frozen contract, so
  `lan-host.js` reads their results without awaiting anything. They are answered through the one
  synchronous page-to-host channel a WebView has: `window.prompt`, which the UI delegate answers only
  for this bridge's own prefix and only when the initiating frame is the main frame with the exact
  signed `bundle-index.html`. Any other prompt keeps the previous `nil` answer. `browse` and the
  page's own `/api/party/*` calls are asynchronous and use the `megaLanDiscovery` reply channel.
- Transport is `Network.framework` (`NWListener` on a TCP port, one `NWConnection` per peer, a small
  bounded set of live connections released on completion, watchdog, state failure and `stop()`) plus
  Bonjour via `NWBrowser` and `NWListener.service` with service type `_megaxo-v5._tcp`, identical to
  Android's NSD type. No third-party dependency and no package-manager entry.
- `0.0.0.0` is bound at the requested port; if that port is taken the next two candidates are tried
  and the port that actually bound is reported back. `status().origin` is this device's first private
  IPv4 literal and that real port, e.g. `http://192.168.0.42:8081`.
- Each accepted connection parses HTTP/1.1 itself: request line, headers lower-cased and capped at
  8 KiB (431 past that), a `Content-Length` body capped at 16 KiB (413 past that), and a chunked
  **request** body refused with 400. The parsed request is handed to the page as one JSON string and
  `window.MegaLanRoom.handle` answers it on the main thread with a 2 s ceiling; a `null`/empty answer
  is a 404 and a bare `{error}` is a 503 with that code. `Content-Type: application/json`,
  `Cache-Control: no-store` and the CORS headers `lan-room-http.js` defines are always written, and
  page-supplied response headers are passed through except this listener's own framing headers.
- A response relayed from a remote host has `Transfer-Encoding: chunked` decoded and
  `Content-Length` honoured before the body reaches the page; a body whose framing cannot be undone
  becomes an honest `502 UPSTREAM_DECODE` rather than a truncated parse.
- The page's own room traffic is carried on this listener: a `file://`-relative call while this
  device hosts, or a literal private / link-local / loopback IPv4 origin on a `/api/party/` path.
  Another scheme, path, port or a public address is refused in code. This is the only way the page
  reaches a room, because the WebView's blanket `https?` content-block rule stays in force.
- `Info.plist` adds `NSLocalNetworkUsageDescription` (one sentence) and
  `NSBonjourServices = ["_megaxo-v5._tcp"]`. **No ATS key is added at all** — not
  `NSAllowsArbitraryLoads` and not `NSAllowsLocalNetworking`: the LAN path is a raw
  `Network.framework` TCP socket that App Transport Security never sees, and the file-origin page
  makes no `URLSession` request.
- No bearer token, request body or actor id is logged, echoed into an error or stored.

This is transport only. It is not evidence that two physical phones have discovered each other, and
no physical-device acceptance is claimed here.

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
