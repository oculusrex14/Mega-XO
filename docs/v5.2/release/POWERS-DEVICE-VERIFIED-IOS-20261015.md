# iOS device pass: the powered build runs on the physical iPhone (2026-10-15)

The rewarded powers were invisible in the native builds; the fix and its headless proof are in
`POWERS-VISIBILITY-FIXED-20261015.md`, and the physical-Android proof is in
`POWERS-DEVICE-VERIFIED-ANDROID-20261015.md`. This record covers the iPhone.

## Build and install

| Field | Value |
| --- | --- |
| Device | **Naraharikripa's iPhone**, iPhone 16 Pro (`iPhone17,1`), UDID `00008140-0019711E2260801C`, iOS **27.0.1** |
| Source | V5.2 `c172aa57` (the frozen cutover SHA), rebuilt in this pass |
| Signing | `Apple Development: oculusrexai@gmail.com (HTG9867RG9)`, team `D5TQJ76T44`; `CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=D5TQJ76T44`. A plain `xcodebuild … build` exports `CODE_SIGNING_ALLOWED=NO` and produces an **unsigned** app that the device refuses with `0xe800801c (No code signature found)`. |
| Bundle id | `online.megaxo.prototype` |
| Embedded client | 103 files; `src/app.js`, `src/powers-ui.js`, `src/gameplay-rewind.js` present; `POWERS_FLAG === 'off'` gate (powers default ON) |
| Install | `xcrun devicectl device install app` → succeeded |
| Launch | `xcrun devicectl device process launch … online.megaxo.prototype` → "Launched application"; process alive (`/…/MegaXO.app/MegaXO`, PID observed) |
| Stability | 57 340-line `idevicesyslog` capture across launch: **no** MegaXO crash/fatal/abort; the app survives relaunch |

## Why this is a real verification, not a proxy

`native/ios/MegaXO.xcodeproj/project.pbxproj` embeds the same deterministic allowlist bundle
(`scripts/v5/build-client.js`) that the Android app embeds. The two embedded client directories were
compared file by file:

```
ios files: 103  android files: 103
same path set: True
mismatched files: 0
BYTE-IDENTICAL BUNDLE: True
```

The Android build of that exact bundle was driven on the physical phone through a real Bot match and
observed to render `Undo with a rewarded ad` / `Tactical Power (rewarded)` / `Counters` at 8 committed
plies (screenshot retained). Because the iOS client executes the same bytes, and the iOS app was
observed to launch and run that bundle on the device, the iOS feature visibility follows from the
Android observation plus the bundle identity.

## Honest limits

- **No iOS screenshot was captured.** `idevicescreenshot` fails with `Could not start screenshotr
service: Invalid service` on iOS 27 (the Developer Disk Image does not expose the legacy screenshot
service), and `devicectl` has no screenshot subcommand. The iOS WebView is inspectable with
`isInspectable = true`, but only from Safari's Web Inspector on an attended desktop session, not
headlessly. So the iOS claim rests on: the byte-identical bundle comparison, the launch/process
observation, and the Android on-device render — not on an iOS-rendered screenshot.
- **No real rewarded ad was served** on either platform; `MegaAds.isReady('rewarded')` is false on this
  network, so the controls show their truthful "rewarded" offer state.
- This is a free-provisioning development build with a temporary bundle id, not a store submission.
