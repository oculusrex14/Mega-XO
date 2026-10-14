# Android ONLINE flavor — real physical-device acceptance (2026-10-14)

The **online** flavor had never been run on a physical device; the prior pass covered the offline
build only. This closes that gap on the owner's phone, using only synthetic state and host-side
tooling. **No personal data was read, changed, deleted or exported.**

## Device and build

| Field | Value |
| --- | --- |
| Device | OnePlus **EB2101** (Nord CE), Android 13 / SDK 33, serial `5199676e` (retained privately) |
| Connection | USB, `adb` |
| Flavor | **`online`** (`MEGA_ONLINE_TARGET=true`), debug, unsigned |
| Package | `online.megaxo.prototype` |
| APK sha256 | **`795678f4bf6d6f348bd213144f4bcede1ebd6db2d2514c93bac7b37e135895e6`** |
| Source | V5.2 at `5cb9333` (after the native-bundle allowlist fix) |
| Install | `adb install -r`, Success; nothing pre-existing was overwritten or removed |

Synthetic guest state only. The app was left installed; no `pm clear`, no uninstall, no settings
changed, no `/sdcard` writes, screenshots taken host-side.

## Results (real, via `adb` + Chrome DevTools Protocol against the live WebView)

| Check | Result |
| --- | --- |
| Cold launch | **PASS** — `mCurrentFocus=…MegaXOActivity`, process alive |
| Crash / ANR | **PASS** — 0 `FATAL`/`ANR` in the crash buffer and logcat |
| Served page | `https://appassets.androidplatform.net/assets/mega/bundle-index.html` |
| Client globals | 29 `Mega*` globals, including `MegaRewind` and `MegaPowersAdapter` **after the fix** |
| `window.MegaAds` | **`object`**, `platform === 'android'` — the bridge the native host publishes |
| `MegaAds.privacyState()` | `{"canRequestAds":false,"privacyOptionsRequired":false}` — honest: no UMP consent gathered on this run |
| `MegaAds.isReady('rewarded')` | `false` — honest: no ad inventory on this network |
| Board | 81 cells rendered |
| **Real gameplay** | **PASS** — one human move plus the Bot reply advanced `moves.length` 0 → **2** |
| Themes | `paperclub` active |
| Powers kill switch | **off by default**: `window.MegaPowers === undefined` |
| Powers when enabled | `powers/v1`, inventory `{undo:{available:0,reserved:null}, …}`, pacing `{rewardedShownToday:0,rewardedDayCap:10,nextEligibleAt:0}` |
| Fail-closed behaviour | `eligibility(null)` → `NO_MATCH`; `request('undo',{})` → `{earned:false, reason:'NO_MATCH', entitlement:null}` — rejects rather than throwing |

## The defect this found

`window.MegaAds` worked, but `window.MegaRewind`/`window.MegaPowersAdapter` were missing: the native
client bundle is built from an explicit allowlist (`native/client/bundle.config.json`) that had never
been taught about the two new modules, while the website build (`scripts/p21/build-web.js`) had. The
native apps were silently shipping without the powers feature. Fixed in `5cb9333`; the device then
showed the globals and a functioning `MegaPowers`.

## What is still not proven

- **No earned reward on the device.** `canRequestAds:false` and `isReady('rewarded'):false` are the
  honest state; this network refuses Google's ad endpoint, so the SDK's earned callback was never
  observed firing on hardware. That positive path remains proven by construction and by the negative
  branches only, exactly as the ad-bridge work reported.
- **No live online matchmaking/LAN pairing** in this pass — a single-device Bot session was driven.
- TalkBack traversal is still structural only, as before.
