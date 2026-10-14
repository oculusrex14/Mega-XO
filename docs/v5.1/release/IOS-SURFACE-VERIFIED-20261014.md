# iOS surface — what was and was not tested (2026-10-14)

The owner asked: *"I can [use] Mega XOXO on my android phone, but not the iOS — was the iOS testing
done?"* The honest answer at the time was **no**: the iOS app had been *compiled* and its LAN bridge
exercised from a macOS harness, but it had never been installed or run. This records that gap, what
closed it, and what remains.

## The gap, and why it looked like it worked

| Claim | Reality at the time |
| --- | --- |
| "iOS builds" | True: `xcodebuild … BUILD SUCCEEDED` |
| "the LAN bridge works" | Only a macOS harness had driven the Swift; no iPhone or simulator had run the app |
| "iOS reaches parity" | **Untested.** No install, no launch, no screenshot |

No Apple signing identity exists, so the *physical* iPhone cannot be installed to. But the
simulator needs no signing, and it had simply never been used.

## What running it actually found — four real defects

The app had never filled an iPhone display, and three build settings had been hiding behaviour:

1. **Letterboxed, never full screen.** `Info.plist` declared no `UILaunchScreen`/`UILaunchStoryboardName`,
   so iOS ran the app in legacy compatibility mode at a reduced size. Measured on the simulator: the
   status-bar and home-indicator strips were `#000000` and the whole page was inset. Fixed with an
   empty `UILaunchScreen`; the WebView then stays inside the safe area (matching Android, where the
   system insets pad it) so page content clears the notch and gesture bar.
2. **`DEBUG` was never defined** for the app target, so every `#if DEBUG` block compiled out —
   including `WKWebView.isInspectable`. The bundled page could not be inspected at all, unlike the
   Android host which enables WebView debugging. The Debug configuration now sets the condition.
3. **No readiness diagnostics.** A DEBUG-only probe now reports what the page has, mirroring
   Android's `MegaNativeRenderProbe`, so a missing primitive is visible in the device log.
4. **`UILaunchScreen` + edge-to-edge interaction** (found while fixing 1): letting the WebView run
   edge to edge made page screens that have no top inset collide with the clock, so the safe-area
   constraint was kept.

## Verified on the running simulator

iPhone 17 Pro, iOS 26.3, `MegaXO.app` built unsigned and installed with `simctl`.

| Check | Result |
| --- | --- |
| App launches | yes (pid reported, screen renders) |
| Bars painted the theme (pixel read) | vector `#f8f9fb`, midnight `#101720`, paperclub `#f6efdc`, afterhours `#0f0722` |
| Full screen, no letterbox | the bar strips are theme colour, not `#000000` |
| LAN primitives exist | `window.MegaLanRoom`, `MegaLanSocket`, `MegaLanDiscovery`, `MegaLanHost` — all `object` |
| LAN host auto-resumes | after seeding the host intent, the app listens (`lsof`: `MegaXO … TCP *:8123 (LISTEN)`) |
| Mac reaches the iOS host | `GET /api/party/capabilities` → `{"online":false,"lan":true,"publicEnabled":false,…}` |
| Impossible hidden | `[data-action="aipack"]` count **0**; `IMPOSSIBLE` setup chip count **0** |
| Lobby renders | 5 party choices |
| Board builds | 81 cells |

`Screenshot evidence`: the app running full screen in `vector` and in `afterhours`, both with the
status bar painted the theme colour.

## Still not claimed

- **No physical-iPhone install.** That needs an Apple Developer signing identity, which does not
  exist. Everything above is simulator evidence.
- **No iOS↔Android LAN pairing.** The iOS listener was reached from this Mac over the shared loopback;
  the Bonjour discovery path was exercised in a macOS harness, not between two phones.
- The probe is DEBUG-only diagnostics; a release build logs nothing.
