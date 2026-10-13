# P4 native Android/iOS builds — real, verified (2026-10-13)

Built both native targets from the current V5.1 source on this Mac and verified the produced
artifacts and the shared client-bundle identity. These are unsigned development/debug artifacts (no
signing identity or store entitlement was configured), so this is **build/artifact verification, not
device or store acceptance**.

## Android

- Toolchain: Gradle 8.13 (AGP 8.13.2 requires >= 8.13), JDK 17, Android SDK platform android-35.
- Command: `gradle :app:assembleDebug` (from `native/android`, `ANDROID_HOME` = local SDK).
- Result: **BUILD SUCCESSFUL** (40 tasks). Artifact `native/android/app/build/outputs/apk/debug/app-debug.apk`,
  27,434,122 bytes, sha256 `708b88ed71406e793b38…`.
- The `stageMegaClient` Gradle task ran the shared deterministic `scripts/v5/build-client.js`:
  97 files, 2,119,947 bytes, `bundle_hash 8d3350025a14a9b5a0fd07bb54657085a5c16c15ab59eb50690f22830233ed47`.
- Kotlin compiles with three pre-existing deprecation warnings (`WebSettings.allowFileAccessFromFileURLs`
  / `allowUniversalAccessFromFileURLs` deprecated in Java; an override) — no errors.

## iOS

- Toolchain: Xcode 27.0 (Build 27A266a), Swift 6.4, iOS Simulator SDK.
- Command: `xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -configuration Debug
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`.
- Result: **BUILD SUCCEEDED**. Artifact `MegaXO.app` (bundle id `online.megaxo.prototype`,
  `IPHONEOS_DEPLOYMENT_TARGET 16.0`), with `MegaClient/` (98 files incl. the manifest) embedded by the
  "Bundle approved Mega XOXO client" run-script phase. Release signing disabled by default
  (`CODE_SIGNING_ALLOWED = NO`).

## Cross-platform bundle parity

Both platforms embed the SAME generated client bundle:

| Platform | Files | `bundle_hash` |
| --- | --- | --- |
| Android (Gradle `stageMegaClient`) | 97 | `8d3350025a14a9b5a0fd07bb54657085a5c16c15ab59eb50690f22830233ed47` |
| iOS (`MegaClient/`) | 97 | `8d3350025a14a9b5a0fd07bb54657085a5c16c15ab59eb50690f22830233ed47` |

Confirmed by the official verifier:
`node scripts/v5/verify-native-bundle-parity.js <android-manifest> <ios-manifest>` →
`Native client parity passed: hash=8d335002… files=97`.

## Native release configuration (implemented; owner signing gated)

The signed-release pipeline is fully implemented and **fails closed without owner-held signing
material**: `scripts/v5/native-release-{android,ios}.sh` require `MEGA_ANDROID_APPLICATION_ID`
(refuses the `online.megaxo.prototype` prototype ID and any non-registered package), a monotonic release
version code, and the owner-held keystore/alias/passwords; the iOS release path similarly requires a real
App ID/signing identity. `scripts/v5/native-smoke-android.sh` drives a real emulator install + launch +
`MegaXOStartup READY` assertion (not a screenshot-only check). All four scripts pass `bash -n`.
No signing identity, keystore, provisioning profile or store record exists yet, so no signed/distributable
artifact is produced — that is the owner action (P5).

## Honest limits (not claimed)

- **No physical-device acceptance**: emulator/simulator build only. Offline persistence semantics,
  Keychain/Keystore lifecycle, provider sign-in UI, StoreKit/Play Billing, ads, accessibility and
  thermal/battery behavior on real devices remain open (they need a device + provider entitlements).
- **No signing/upload**: no Apple signing identity, no Android release keystore, no App Store Connect /
  Play Console record. Release signing stays disabled until identities are configured.
- The native online target reuses the approved offline client bundle; live native
  API/session/realtime bridges await the P05/P20-03 contracts and a device.

## Reproduce

```sh
# Android (Gradle 8.13; ANDROID_HOME set)
cd native/android && gradle :app:assembleDebug
# iOS (simulator, unsigned)
xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
