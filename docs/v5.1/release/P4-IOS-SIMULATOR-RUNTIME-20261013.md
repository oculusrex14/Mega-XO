# P4 iOS simulator runtime verification (2026-10-13)

Beyond the build (`NATIVE-BUILDS-20261013.md`), the iOS app was **installed, launched and observed
running** on a real iOS Simulator on this Mac. This is genuine runtime verification (still simulator,
not a physical device).

## Environment

| Fact | Value |
| --- | --- |
| Xcode | 27.0 (Build 27A266a) |
| Simulator | iPhone 17 Pro, iOS 26.3 (`UDID 598C47E9-BE2B-4498-B670-31D5D6F22057`) |
| App | `online.megaxo.prototype`, Debug-iphonesimulator, `CODE_SIGNING_ALLOWED=NO` |
| App binary sha256 | `2c11d771ef75339844ffe9c5…` |
| Command | `xcodebuild … -destination 'platform=iOS Simulator,id=598C47E9…' build`; `xcrun simctl install`; `xcrun simctl launch` |

## Observed

- `xcrun simctl install` succeeded; `xcrun simctl launch` returned a PID (app launched).
- `launchctl list` shows `UIKitApplication:online.megaxo.prototype` running (no crash loop).
- Device log shows normal UIKit/BoardServices startup; no crash, no uncaught exception.
- **Screenshot** (`.artifacts/native/ios-first-launch.png`, sha256 `a09a2d09…`) shows the real rendered
  game: "Welcome to Mega XOXO", the tic-tac-toe board with X/O marks animating, "YOUR GAME. YOUR
  PROFILE." and "Play now. Keep it with you." — the approved client bundle rendered inside the native
  WebKit host from the signed `MegaClient/` resources.
- **Relaunch reproducibility**: terminate + launch again produced the same rendered welcome
  (`.artifacts/native/ios-relaunch.png`, sha256 `38714c66…`) — the app boots cleanly and repeatedly.

## Honest limits (not claimed)

- **Simulator, not a physical iPhone**: no real-device touch/rotation/background/thermal acceptance.
- Interactive taps and the full practice/bot/tutorial flow were not driven programmatically here (the
  Android CDP gameplay smoke, `scripts/v5/native-smoke-gameplay.cjs`, is emulator-only and needs an
  Android emulator, which could not be installed — the local disk has ~4.7 GB free and the arm64 system
  image download failed with `No space left on device`). The screenshot proves render + boot, not a
  completed tutorial.
- No Apple signing identity, App ID capability, associated domain, StoreKit or push entitlement is
  configured, so this is a development-simulator artifact, not a distributable build.
- Accessibility on-device (VoiceOver), background/foreground recovery, and the provider sign-in UI
  remain open (they need a device + provider entitlements).
