# Owner mockup UI implementation — 15 October 2026

This is review evidence for the new UI PR, separate from provider PR #15. Main remains the integration
owner. No shared branch, production service, signing identity, game rule, economy, power entitlement,
ad callback, migration or provider account was changed.

Source verified: `948902b6a5812326554e910ad568fc5816931442`, based on Main
`59b65b0b26399d31f8ee55ac119a550a6c4a4519`. `verification.json` records bundle and image hashes.
Rollback: revert this UI PR and rebuild the website/native client; no data rollback is involved.

## Result and intentional state differences from the AI mockups

- Shared app match UI follows the four owner references: After Hours violet/gold, Paper Club warm
  hand-drawn ink, Vector Light white/lime, and Midnight Club navy/blue/lime. The player cards,
  routing HUD, board, separate four-card Power Bar and Rules/Restart/Stats controls use real state.
  CSS is scoped to the match screen; the other app screens keep their design.
- The website workspace is enabled explicitly for `/game`. Setup/players/turn appear on the left,
  board/actions in the centre, powers/guide on the right. The old `/play?mode=practice` presentation
  stays separate. Home preview HTML is byte-identical to Main's baseline; site header/footer and
  other pages were not redesigned. Phone layouts stack the workspace without horizontal overflow.
- Mock inventory values **3/2** are not hard-coded. Native Undo shows actual charges/package bank,
  Hint shows actual bank, and unavailable counters show a dash. Undo remains visible but disabled
  before eight committed plies and when exhausted, with an explanation.
- Native Undo and Hint call Main's existing actions and adapter. Undo Block/Hint Block remain
  disabled because the authoritative two-player Casual counter protocol is absent. An existing
  disclosure explains this; no block acquisition or effect is invented.
- The website powers reader/integration gate remains unchanged. Its local game has no verified
  actor/match/ad binding, so cards report unavailable inventory and the existing actions stay closed.
  This PR does not claim browser ad earning or powered Casual is complete.
- A game share link contains mode/level/theme for local play, or a clean `/game` URL for online play;
  no actor, private match ID or existing query credential is shared.

## Executed checks

**169 PASS, 0 FAIL, 0 SKIP** in `targeted-tests.tap`:

```sh
node --test --test-reporter=tap tests/v5-p21-board.test.js tests/v52-p21-powers.test.js tests/powers-game-ui.test.js tests/v52-match-redesign.test.js tests/v52-game-workspace.test.js tests/gameplay-rewind.test.js tests/powers-entitlements.test.js tests/powers-integration.test.js tests/v5-client-bundle.test.js tests/v5-native-foundations.test.js tests/v51-p21-bot.test.js tests/v5-p21-static-resolver.test.js
```

Both allowlisted builds passed (`scripts/p21/build-web.js`, `scripts/v5/build-client.js`).
`git diff --check` passed. Earlier broad web/test glob execution was stopped after 151 passing
subtests stalled without a summary; it is **not** counted as a completed suite or readiness pass.

Real CUA browser checks used the local generated website and native client bundle (no injection of
inventory or fabricated match state): desktop and 390px website layouts, 390px all-four-theme app
layouts, 320px short phone app layout, legal player move + Bot worker reply, theme changes, guided
practice launch/locked settings/focus. The board stays width-based and the app scrolls on short
screens rather than shrinking it to fit the Power Bar. Source/unit checks cover real earned-item
consumption, 8→6 ply rewind, legal Hint selection, refusal/kill switches, online snapshot authority,
request fencing and private-share isolation. Test rewarded outcomes are synthetic, not live ads.

The JPGs are **local browser QA images of the actual shared UI**, not signed-device screenshots or
marketing/store assets. They are deliberately opening/real states; they do not recreate the mock
board position or award currency. App images show the first viewport of a scrollable match.

## Main handoff

Review and merge the new UI PR when ready. Then regenerate signed iOS/Android artifacts and observe
this exact UI on hardware, especially safe areas, text scaling, small-phone scrolling, accessibility,
ad presentation/return and real reward consumption. This PR performs no deployment or store upload.
Provider PR #15 remains a separate review item and must not be auto-merged.

## Android CI harness correction

The first PR run built both Android debug flavors successfully, then both emulator jobs failed at
launch because `native-smoke-android.sh` hard-coded `online.megaxo.prototype/.MegaXOActivity`.
The application ID had already changed in Main, while Kotlin's activity namespace remained the
prototype namespace. Jobs `116268741737` and `116269224326` report `Error type 3` before render smoke.
The smoke launcher now reads the package and launchable activity from this APK's SDK `aapt` metadata,
validates both names, and uses the actual package for process lookup. It changes no native identity,
manifest or runtime setting. A local existing APK's metadata resolves to
`online.megaxo.xoxo/online.megaxo.prototype.MegaXOActivity`.
Three new regressions cover distinct ID/namespace, relative/staging activities and missing/unsafe
metadata. Together with native foundations they pass **34/34**; shell syntax passes. These are
metadata tests, not an emulator pass. CI is rerun on the pushed correction; its result must be read
from the PR rather than inferred from these local checks.
