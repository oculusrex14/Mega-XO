# iOS Mega XO native host (P20 co-development)

A checked-in Xcode application target embeds the approved client bundle. It does **not** load the deferred megaxo.online website. Swift WebKit hosts the offline game inside a restricted signed `MegaClient/` resource directory.

## Build

Requirements: Xcode 16+, Node 24, iOS Simulator SDK. From repository root:

```sh
xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO \
  -configuration Debug -sdk iphonesimulator \
  CODE_SIGNING_ALLOWED=NO build
```

The Xcode shell phase invokes the shared deterministic `scripts/v5/build-client.js` generator and copies the generated files into the app's resource bundle before codesigning. No unapproved game logic, remote font, or asset dependency is introduced.

## Current security/feature boundary

- Only signed `file://` resources **inside MegaClient/** may navigate inside WKWebView; external HTTPS links open only from direct user navigation. Redirects, additional windows, untrusted iframes and JavaScript dialogs are restricted.
- No arbitrary `WKScriptMessageHandler` is attached. Native login, backend API, Keychain session and realtime bridges await the P05/P20-03 contracts.
- iOS file-origin storage semantics require real simulator/device acceptance; a passing compile does not prove offline persistence on every supported OS.
- Temporary `online.megaxo.prototype` bundle ID has no known App Store entitlement. Signing identities, associated domains, StoreKit/ads, app icons, privacy consent and physical-device acceptance remain separate tasks. Release signing is disabled by default until authorized configuration exists.
- The shared asset manifest must match Android's bundle hash for the same source revision.

No store upload, real device execution, login, purchasing or notification delivery is claimed here.

## Compiled Apple provider adapter (not activated)

The existing `native/ios/MegaAppleIdentity.swift` is included directly in the Xcode target. It uses Apple's real AuthenticationServices request and a server-issued nonce, but has no configured App ID capability or connected JS/Keychain session exchange yet. Successful compilation is not Apple provider verification or an App Store entitlement.
