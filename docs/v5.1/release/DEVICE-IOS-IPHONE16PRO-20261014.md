# iOS physical-device acceptance + cleanup report (2026-10-14)

Real device testing permitted by the owner (2026-10-14). **No personal data was deleted, reset or
modified.** The installed app is a development build only.

## Device

| Field | Value |
| --- | --- |
| Model | **iPhone 16 Pro** (`iPhone17,1`) |
| Device name | `Naraharikripa’s iPhone` (owner's device) |
| Connection | USB, `xcrun devicectl` — state `available (paired)` |
| UDID | `00008140-…` (retained privately; not reproduced in repo records) |
| Xcode | 27.0 (Build 27A266a) |

## Blocker (external, owner-dependent)

| Check | Result |
| --- | --- |
| Local code-signing identities (`security find-identity -v -p codesigning`) | **0 valid identities** |
| Provisioning profiles (`~/Library/MobileDevice/Provisioning Profiles/`) | **empty** |
| Development team / App ID capability | **none configured** |

An unsigned build cannot be installed on a physical iOS device, so the on-device iOS matrix is
**NOT RUN** and is **not claimed**. This is exactly the Apple Developer enrollment that the owner
has paid for and that remains pending approval; the owner's directive states store publication is
excluded until providers approve.

## What was verified instead

| Case | Method | Result |
| --- | --- | --- |
| iOS target builds from the exact source | `xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=NO build` | **PASS** — `BUILD SUCCEEDED` |
| Bundle identity | `PlistBuddy` on the built `Info.plist` | `online.megaxo.prototype` (development identifier) |
| Embedded client | `MegaClient/client-bundle.manifest.json` of the built app | `e03814281300580ed74b7e1ad29f4e3263fa12cdbe53f168538d8a481dc4bfdb`, 97 files |
| **Cross-platform parity** | `scripts/v5/verify-native-bundle-parity.js <android> <ios>` | **PASS** — `hash=e0381428… files=97`, byte-identical to the APK's bundle |
| Simulator availability | `xcrun simctl list devices available`, `list runtimes` | 25 available devices; iOS 26.3 and 26.5 runtimes |

## What remains to run once a signing identity exists

Install/launch/cold/warm start; all four themes; tutorial narration and beginner-bot comprehension;
Android↔iPhone↔browser online match and shared-account identity; reconnection, airplane mode,
background/resume, process termination and offline recovery; session expiry/revocation; crash/ANR,
memory, CPU, FPS, battery and thermal; consent UI, test ads, notifications and sandbox commerce.

## Cleanup report

| Item | Action |
| --- | --- |
| Apps installed on the phone | **none** — no build could be installed without a signing identity |
| Temporary test helpers | **none** placed |
| Files written to the phone | **none** |
| Device settings changed | **none** |
| Personal data deleted/reset | **none** |
| Restore/backup operations | **none** |

**Cleanup verification:** the iPhone is untouched apart from the pre-existing pairing relationship
the owner already established. Nothing requires removal.

## Honest status

iOS **build and cross-platform asset parity are verified**; iOS **physical-device acceptance is
blocked on Apple Developer enrollment** and is deliberately reported as pending rather than passed.
