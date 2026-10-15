# iOS real-device acceptance — the app RUNS on the physical iPhone (2026-10-15)

The blocker recorded on 2026-10-14 was real and is now cleared. This is the first time in the project
that the iOS app has been **launched and observed running on the owner's physical iPhone**.

## What unblocked it

The owner connected the phone and trusted the free-provisioning developer app on the device
(Settings → General → VPN & Device Management). After that:

```
xcrun devicectl device info details --device 00008140-0019711E2260801C
  • Device State: connected

xcrun devicectl device process launch --device 00008140-0019711E2260801C online.megaxo.prototype
  → Launched application with online.megaxo.prototype bundle identifier.

xcrun devicectl device info processes --device 00008140-0019711E2260801C
  → 13333  …/MegaXO.app/MegaXO      (process alive)
```

## Build under test

| Field | Value |
| --- | --- |
| Device | **Naraharikripa's iPhone**, iPhone 16 Pro (`iPhone17,1`), UDID `00008140-0019711E2260801C`, iOS **27.0.1** |
| Source | **final V5.2 HEAD `bb54b7b`** (rebuilt and reinstalled for this test) |
| Signing | `Apple Development: oculusrexai@gmail.com (HTG9867RG9)`, team `D5TQJ76T44`, free personal provisioning |
| Bundle id | `online.megaxo.prototype` |
| Embedded client bundle | 102 files, and **`src/gameplay-rewind.js` + `src/powers-ui.js` are present** (the native-bundle allowlist fix) |
| Install | `xcrun devicectl device install app` → `App installed: bundleID online.megaxo.prototype` |

## Observed on the device

| Check | Evidence |
| --- | --- |
| Launches and renders full screen | screenshot `launch-home-afterhours.png` (and `launch-home-first-run.png` from the earlier install) |
| Real UI, not a blank WebView | logo, wallet (150 Coins / 0 Crowns), ranked-journey card, all six mode entries, five-tab bottom nav |
| Status bar follows the theme | the afterhours bar strip is the theme colour, not black |
| Connectivity state is honest | "Connection interrupted — Online services are temporarily unavailable. Offline modes still work." with **Try again** — the app is not pretending to be online |
| **Zero crashes** | `idevicesyslog` capture across launch (38 474 lines) contains **0** crash/fatal mentions for MegaXO; the app also survives re-launch |

Reproduce: `/opt/homebrew/bin/idevicesyslog -u <udid> > /tmp/ioslog.txt` while launching with
`xcrun devicectl device process launch`.

## What the device run found (again)

The previously installed build predated the native-bundle fix, so it was rebuilt from the final SHA
before this test. The rebuilt bundle now contains both powers modules (see the manifest check above),
which is exactly the defect the Android device run had exposed — the same allowlist omission affected
**both** platforms.

## Honest limits

- **No interactive session was driven on iOS.** `ios_webkit_debug_proxy` 1.9.2 (the current release)
  drops the connection to this device's Web Inspector ("ssl send failed: Broken pipe" /
  "Unable to report to inspector"), which is a known incompatibility with iOS 17+ / this Xcode, not an
  app fault. So the runtime *state* (globals, `MegaAds`, `MegaPowers`, a played match) is verified on
  **Android**, where CDP works, and iOS is verified as launch + render + no-crash + correct bundle.
  Claiming more on iOS would be fabricated.
- **No earned ad on iOS** — same network limitation as Android (no ad inventory).
- Debug free-provisioning build, profile valid until **2026-10-21**; not a distributable build.
- Owner reports Codex is handling App Store submission; nothing is claimed here about that flow.
