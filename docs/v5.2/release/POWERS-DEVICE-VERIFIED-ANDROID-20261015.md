# Rewarded powers device-verified on the physical Android phone (2026-10-15)

The owner's complaint was that the rewarded features were invisible in the native builds. The fix
(`POWERS-VISIBILITY-FIXED-20261015.md`) was proven in headless Chromium. This pass proves it **on the
physical device**, in the shipping WebView, in a real Bot match — the limit that record explicitly
left open.

## Build and install

| Field | Value |
| --- | --- |
| Device | OnePlus **EB2101** (Nord CE), Android 13 / SDK 33, serial `5199676e` |
| Flavor | `online` (`MEGA_ONLINE_TARGET=true`), debug, Gradle debug-signed |
| Application id | `online.megaxo.xoxo` (activity `online.megaxo.prototype.MegaXOActivity`) |
| `megaApiOrigin` | `https://play.antimatterinnovations.com` |
| APK sha256 | `549baff9c65b9e3afff904392f091e22f414a533fc90b7fcf00e9eff65377554` |
| Source | V5.2 `c172aa57` (the frozen cutover SHA) |
| Installed bundle | 102 files, including `src/powers-ui.js` and `src/gameplay-rewind.js` |
| Install | `adb uninstall` then `adb install` (a stale earlier APK had to be removed: an
`assembleOnlineDebug` re-run had reused the previous `generateMegaClient` output, so the installed
bundle still carried the old `POWERS_FLAG === 'on'` gate. `--rerun-tasks` fixed it and the APK was
re-verified by extracting `assets/mega/src/app.js` before install.) |

## Observed live, via Chrome DevTools Protocol against the device WebView

The served client is confirmed to be the fixed one before driving the match:

```
fetch('src/app.js') -> POWERS_ON=(()=>{ /* The emergency switch is authoritative: a stored 'off' … */ })
window.MegaPowers   -> "object"        (undefined on the stale build)
```

Then a real Bot match (mode selector `bot`, first move `X`) was started and played through the real
engine, clicking only legal cells, waiting for the Bot between plies. The control row was sampled every
ply. The controls are `data-action` buttons inside `.match-controls .powers-slot`:

| Committed plies | Controls rendered |
| --- | --- |
| 1 | `powercounters` |
| 2 | `bothint`, `powercounters` |
| 4 | `bothint`, `powercounters` |
| 6 | `bothint`, `powercounters` |
| **8** | **`botundo`, `bothint`, `powercounters`** |

At 8 plies the row reads exactly `"Undo with a rewarded ad" / "Tactical Power (rewarded)" / "Counters"`.
`botundo` is correctly **absent** before the eighth committed ply — the owner's frozen rule — and
appears at exactly 8, which is the same threshold the headless run measured.

Screenshot: `docs/v5.2/evidence/powers-device-20261015/android-online-bot-powers-8plies.png`
(1080×2400, captured host-side with `adb exec-out screencap`).

## Honest limits

- **No real rewarded ad was served.** `MegaAds.isReady('rewarded')` remains false on this network, so
  the buttons show their truthful "rewarded" offer state; the earned callback itself was not exercised
  against a live ad here (it is covered by the injected-lane tests, not by this device run).
- The screenshot is one match state; the per-ply table above is the fuller record.
- This is a debug-signed development artifact, not a store submission. The signed AAB path and the
  permanent package identity are separate, still-open items.
