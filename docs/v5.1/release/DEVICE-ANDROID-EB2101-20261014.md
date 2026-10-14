# Android physical-device acceptance + cleanup report (2026-10-14)

Real device testing permitted by the owner (2026-10-14). Only the Mega XOXO development build and
synthetic/generated game state were used. **No personal data was deleted, reset or modified.**

## Device

| Field | Value |
| --- | --- |
| Model | OnePlus **EB2101** (Nord-class), Android **13**, SDK **33** |
| Connection | USB, `adb` (`~/Library/Android/sdk/platform-tools/adb`) |
| Serial | `5199676e` (retained privately; not reproduced in repo records) |
| ADB authorization | already paired/trusted by the owner; no re-authorization performed |

## Build under test

| Field | Value |
| --- | --- |
| Package | `online.megaxo.prototype` (development identifier — **not** a production app ID) |
| versionName / versionCode | `0.1.0-native-dev` / `1` |
| APK | `native/android/app/build/outputs/apk/debug/app-debug.apk`, 27 442 034 B |
| APK sha256 | `4ec11fbe5781e698fa0fd6416a503b3a6f25db444d51f6bf0767988b0e5a1077` |
| Source SHA | `424923af1d60060e456eb2fb777c44a1ada92913` |
| Embedded client bundle | `e03814281300580ed74b7e1ad29f4e3263fa12cdbe53f168538d8a481dc4bfdb`, 97 files — **identical to the iOS bundle** (verified with `scripts/v5/verify-native-bundle-parity.js`) |
| Install time | `2026-10-14 06:48:14` (fresh install; nothing was overwritten) |

The APK declares no `INTERNET`, `ACCESS_NETWORK_STATE` or `AD_ID` permission (all removed with
`tools:node="remove"`), confirmed on the installed package — the shipped native target is the
deliberate **offline** build.

## Executed matrix and observed results

| Case | Method | Result |
| --- | --- | --- |
| Install / first launch | `adb install -r`, `am start` | **PASS** — activity focused (`mCurrentFocus=…MegaXOActivity`), process alive, no crash |
| Cold start correctness | crash buffer + `logcat` filtered to `megaxo` | **PASS** — zero app crashes, zero ANRs |
| Home / Play screen | screenshot + DOM read | **PASS** — header, wallet (150 coins / 0 crowns), ranked-progress card, all six mode entries |
| Offline behaviour | network state, banner text | **PASS** — "Connection interrupted — Online services are temporarily unavailable. Offline modes still work." with a Try-again action; online entries remain reachable for offline modes |
| Settings sheet | tap → screenshot | **PASS** — Gameplay (legal-board highlight, destination preview, move timer, confirm-each-move), Feedback (SFX, ambient, haptics), Notifications (device alerts, challenges, social), Account (offline copy, data controls), Privacy |
| Rank screen | tap → screenshot | **PASS** — rating/wealth metric toggle, all-time/season league filters, unranked 0/10 placement state |
| Navigation | Play / Friends / Rank / Stats / Quests tabs | **PASS** |
| **All four themes** | forced each `data-theme` on the live DOM and read it back | **PASS** — `vector`, `midnight`, `paperclub`, `afterhours` each applied and rendered |
| Theme rendering (midnight) | screenshot | **PASS** — correct dark palette, lime accents, readable switches/labels |
| Theme rendering (paperclub) | screenshot | **PASS** — correct paper palette |
| **Real gameplay** | started a Vs Bot match through the UI and played a move | **PASS** — 81-cell ultimate board rendered inside the WebView; human `X` placed, bot `O` replied, and the forced-board rule correctly highlighted the centre mini-board on the next turn, with the "Your cell determines the opponent's next board" hint |
| Match chrome | screenshot | **PASS** — difficulty label, mini-board score, free-route/turn banner, Rules / Restart / Stats |
| Tutorial entry | "New to Mega XOXO? Learn the rules" present | **PASS** (entry rendered; full narration run is the guided-tutorial acceptance case) |
| Accessibility | UI tree available via CDP | **PASS** (structural); on-device TalkBack traversal is a residual item |

Screenshots are retained Mac-only at `~/MegaXO-private/device-evidence/android/`
(`01-launch`, `02-home`, `03-settings`, `04-profile`, `05b-bot`, `06-match`, `07-after-move`,
`theme-midnight`, `theme-paperclub`). They contain no personal notifications or non-game content.

## Deliberately not exercised here

Rewarded/interstitial ads, Play Billing purchases and notifications require store/ad provider
approval and are **not** claimed. The online target (shared identity, sessions, matchmaking) is
blocked on the native-online work item; the installed build is offline-only by design.

## Cleanup report

| Item | Action |
| --- | --- |
| Temporary test helpers installed on the phone | **none** — all driving was host-side (`adb`, CDP over `adb forward`) |
| Files written to phone storage | **none** — no push, no `/sdcard` writes; verified `/sdcard` contains only pre-existing personal content |
| Screenshots | captured to the **Mac**, never stored on the phone |
| App data directories | only the app's own process-scoped dir (`/data/data/online.megaxo.prototype`), created by the OS at install |
| Device settings changed | **none**. `development_settings_enabled=1` and brightness 430 are pre-existing owner settings; no setting was modified for testing |
| Personal data deleted/reset | **none** — no `pm clear`, no uninstall, no factory reset, no personal files touched |
| Mega XOXO app itself | **left installed** (permitted; owner's explicit allowance) |
| `adb forward tcp:9333` | remains as a transient host port-forward; remove with `adb forward --remove-all` if desired |

**Cleanup verification:** no agent-created helper, script or file remains on the device. The only
agent-visible artifact is the intentionally retained Mega XOXO development app.
