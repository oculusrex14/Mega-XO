# The rewarded powers were invisible — diagnosis and fix (2026-10-15)

The owner opened the iOS and Android builds and could not see the rewarded features (undo, tactical
guidance, tactical blocks) that were supposed to be added. The complaint was correct. There were
**five** independent reasons, and all five are now fixed.

## Why they were invisible

| # | Cause | Evidence |
| --- | --- | --- |
| 1 | **The feature shipped behind an OFF-by-default kill switch.** `app.js` read `localStorage['mega_v52_powers_enabled']`, which no player has ever set, so `POWERS_ON` was false for everyone. No player could ever reach the feature. | `const POWERS_ON=(()=>{…getItem(POWERS_FLAG)==='on'…})()` |
| 2 | **The in-game UI was never built.** The only Undo entry points were the Bot-loss terminal sheet and a button buried two taps deep inside the stats sheet. There was no visible in-match control, so a player who never lost at the exact right moment saw nothing. | `offerTerminalUndo()` and `currentMatchStats()` only |
| 3 | **Tactical Power and the Blocks were not shipped at all.** The adapter declared `SHIPPED=['undo']`, so `request`/`apply` returned `POWER_NOT_SHIPPED` for the other three kinds, even though the pure module already implemented their counters. | `src/powers-ui.js:26` |
| 4 | **Codex's power UI is on the website, not in the game.** `apps/web/powers.js` is a marketing-site presentation module loaded by `apps/web/index.html`; the game client is `index.html` + `src/*`. It was never going to appear in a match. | `apps/web/index.html:27` |
| 5 | **The native client bundle needed the modules too.** Found earlier in this session: the native bundle allowlist had not been told about the two new modules, so the native apps shipped without them. | `native/client/bundle.config.json` |

## What was changed

1. **The powers now default ON** (`src/app.js`). The flag is retained as an explicit *off* switch:
   `'off'` disables them, anything else keeps them available. A player without ad inventory still sees a
   truthful unavailable state instead of a hidden feature — the reward path already fails closed.
2. **A visible control row in the match control zone** (real rendered proof below): `botundo`,
   `bothint`, `powercounters`, `rewardyes`, `rewardno`.
3. **Tactical Power is shipped** (`SHIPPED=['undo','hint']`), computed with the **existing** engine
   (`G.choose` / the local session) so the recommendation is a real legal square, shown as a highlight
   plus text, with the player still free to choose any legal square.
4. **The two counters are disclosed honestly, not faked.** `Counters` opens a disclosure explaining
   that Undo Block and Tactical Block act on *another player's* power use in the two-player Casual
   protocol, which is not built, so they are unavailable rather than silently inert. Faking them, or
   enabling them in Bot mode, would be a lie about the rules.
5. The native bundle already carries both modules (fixed earlier in this session).

## Rendered proof (not a claim)

A real Bot match in the shipped client, headless Chromium at 390×844, with the match driven to 10
plies through the real engine:

| Control | Text | Size |
| --- | --- | --- |
| `botundo` | "Undo with a rewarded ad" | 128×48, visible |
| `bothint` | "Tactical Power (rewarded)" | 134×48, visible |
| `powercounters` | "Counters" | 52×48, visible |

`window.MegaPowers.version === 'powers/v1'`; zero page errors.
Screenshot: `docs/v5.2/evidence/powers-ui-20261015/bot-match-controls-390.png`.

At **6 plies** the `botundo` control is correctly **absent** — the owner's frozen rule requires eight
committed plies before the first use, and the control appears once that threshold is passed. Verified
in the same run: `botundo: null` at 6 plies, present at 10.

## Honest limits

- **No real rewarded ad was served.** This network refuses the provider's ad endpoint, so the earned
  callback was exercised through the injected lane and `window.MegaAds` test doubles, never against a
  live SDK. That is why `canRequestAds` reports false and the copy says "rewarded" rather than
  claiming an ad is ready.
- **The controls were measured in headless Chromium**, not in the shipping iOS/Android WebView. The
  Android device pass earlier in this session confirmed the same modules load and `MegaPowers` reports
  `powers/v1` when enabled; the visual layout on a physical device is still to be re-observed.
- The two-block disclosure is a truthful placeholder for a protocol that does not exist yet; it is not
  a shipped counter mechanic.
