# Rewarded powers audit — 15 October 2026

Audit target: local provider worktree, `codex/v52-provider-release` at
`b5cdae26c62b1e35d032a063fce002eddf7eda3d` (includes `origin/V5.2` at
`2447ce66be2e6ca57a54b9c3dd3c7821f982502e`). Node `v26.8.2`, macOS arm64.
Read-only source audit plus local synthetic module tests. Only this evidence directory was written;
no application edits, commit, PR merge/close, provider configuration or deployment occurred.
The active consent work in `/Users/oculus/Downloads/Test XO` was not touched.

## Feature completion matrix

| Capability | Pure implementation | P21 website | Shared native/legacy client | Actual acceptance |
| --- | --- | --- | --- | --- |
| Bot Undo | Canonical replay removes the previous human/Bot pair; immutable branch history; first use ≥8 plies; one 2-charge package; second charge survives shrink | Presentation only. No adapter installation, binding, request/apply click handling, or live match mutation | Feature off by default. Terminal Bot line-loss offer, deferred settlement, rewind handler and remaining-charge action exist in `src/app.js` | Local suites pass; no real earned ad → power → rewind proof. Concrete integration/bank defects below prevent calling it complete |
| Casual Undo + Undo Block | Request counters, separate block token, 3 initiations/player and one successful rewind/match | Online board hides powers; Powered Casual selector and counters disabled | Adapter refuses online Undo; `undoBlock` is `POWER_NOT_SHIPPED` | No Core powered rule set, event/revision protocol, counter window, durable bank settlement or peer-delivery implementation found |
| Tactical Power | Request/delivery counters and explicit pending-block suppression only | Disabled button and explanatory copy | `hint` is `POWER_NOT_SHIPPED` | No Expert recommendation invocation, canonical legal-square validation, highlight, pending-window clock or player-choice flow exists |
| Tactical Block | Separate activation/success counters; clears a blocked pending hint | Disabled button | `tacticalBlock` is `POWER_NOT_SHIPPED` | No authoritative two-player counter resolution or SDK-to-entitlement/UI flow |
| Rewards/bank | Pure idempotent bank/reserve/commit/release/owed transformations; 10/day + 2-minute presentation rules | Fixture-safe disabled presentation | Native typed SDK lane exists and bundle includes shared modules, but app/Core connection and persistence have defects | Device launch/bridge presence is recorded elsewhere. Consent, filled ads, earned callback, SSV, bank continuity and actual powers were not established by this audit |

Canonical scope is the owner decision table at
`docs/v5.1/release/OWNER-DECISIONS-AND-EXECUTION-20261014.md:20` and Main's current acknowledgment at
`docs/v5.2/release/MAIN-TO-CODEX-CONTRACT-ACK-20261015.md:56`. The acknowledgment explicitly limits the
client to Bot Undo. The broader “rewarded powers implemented” wording in the older final report
must be read as pure logic coverage, not complete working product acceptance.

## Concrete gaps and smallest fixes

1. **Core cannot issue a power ticket.** `packages/services/commerce.js:313` accepts only `credits`
   and `boost`; its callback at `:353` likewise grants Credits or boost. The app asks for `kind:undo`
   in `src/app.js:94`. Native allowlisted `solo_rewind`, `tactical_hint`, `casual_rewind` names at
   `MegaAndroidAds.kt:281` / `MegaIOSAds.swift:296` are future placement reservations, not a Core
   implementation. Main must add a reviewed power-ticket/entitlement contract and durable,
   idempotent settlement; preserve separate cosmetic rewards and the configured native unit checks.
   Current failure is software as well as missing real-provider evidence.

2. **The app drops the ticket envelope.** `src/app.js:95` returns `r.ticket`, a string. Both native
   bridges require the full object containing ticket, actor, unit, item, amount, expiry and platform
   (`MegaAdsBridge.kt:311`, `MegaAdsBridge.swift:73`). Preserve the complete Core response through
   `nativeBridge` (`src/powers-ui.js:111`) and test that exact host hook against the native schema.

3. **Unearned application succeeds.** `src/powers-ui.js:175–188` grants a package even when the bank
   is empty; `applyUndo` calls it at `:202`. A fresh adapter, empty inventory, no ad request and a
   valid 8-ply match produced `applied:true`, revision 9 and one remaining charge in the local probe.
   Require/reserve an earned item before the grant and make grant/rewind/consumption atomic with
   failure release. This is currently exposed through the adapter; normal UI entry restrictions do
   not make its claimed earned-only contract true.

4. **Spent bank items return after restart.** `redeem` changes `state.inventory` at
   `src/powers-ui.js:186`; `apply` never calls `persist`. With JSON-copy storage matching localStorage,
   earned item → apply yielded memory bank 0, stored bank 1, reload bank 1. Persist consumption and
   cover restart/replay and failed-commit recovery before activation.

5. **Reload truncates cooldown timestamps.** `count` clamps all values to 9999 (`src/powers-ui.js:30`),
   including `lastShownAt` and `nextEligibleAt` (`:54`). The probe changed `1792065720000` to `9999`
   after reload. Validate epoch timestamps separately from bounded counters and cover same-day and
   midnight restarts. The same generic counter clamp affects stored attempt timestamps.

6. **Website and actual adapter disagree on shapes.** `apps/web/powers.js:31` requires numeric
   reservation counts; actual `src/powers-ui.js:223` returns null/token. Actual composition reports
   `invalid-inventory`. Successful adapter responses use `reason:null` (`:218`, `:270`), while the
   frozen contract and website require strings (`apps/web/powers.js:109`, `:127`); after normalizing
   reservations only, a real adapter earned item produces website `INVALID_RESULT` while bank=1.
   Freeze and align one schema, then test the two actual modules together. The two isolated test
   fixtures currently assert opposite representations.

7. **P21 is deliberately unwired.** `apps/web/index.html:20–28` loads website `powers.js` but no
   rewind/adapter/app installer; `scripts/p21/build-web.js:18` merely copies them into legacy assets.
   `apps/web/board.js:292` supplies no binding/verification/host context. `:527` forwards no request or
   apply clicks. Online matches have no powers panel (`:239`). Once Main's functional adapter and
   binding contract exist, connect a website host to its own live board, revision and entitlement
   authority; do not install shared `src/app.js` into the P21 board (it controls a different DOM and
   match closure). Existing disabled presentation is truthful but not functional integration.

8. **Native bank redemption and acquisition UI is incomplete.** `src/app.js:458` shows an in-game
   Undo only when match charges already exist. The terminal handler at `:489` always requests an ad
   when charges=0, even if inventory already contains a banked item; that request returns BANK_FULL.
   After fixing earned-item enforcement, offer direct bank redemption and distinguish earning from
   using the remaining charge. Terminal sheet always says “with a rewarded ad” (`:439`) even when
   using an earned charge. No first-package acquisition path was found during an ordinary ongoing
   8+-ply Bot turn.

9. **Aggregate pacing is one-directional.** Powers count the cosmetic ledger through `otherShown`
   (`src/app.js:45`, `src/powers-ui.js:246`), but cosmetic `watch`/offer gates do not count powers
   (`src/monetization-ui.js:24`, `:50`); powers also do not update cosmetic last-exposure time.
   The cosmetic lane still enforces its old four-ticket/day quota (`src/monetization.js:9`), and
   tickets reserve failed starts, while the owner contract describes one 10-presentation/day ceiling
   with no-fill consuming none. Use a single authority for exposure count and two-minute spacing in
   both directions; test cosmetic→power, power→cosmetic, concurrent callbacks and restart. These
   issues are dormant in real powers while power tickets remain unavailable, not resolved.

10. **Tactical/Block is a counter scaffold, not legal advice.** `hintReveal` takes any supplied
    square without a board/legal check (`src/gameplay-rewind.js:393`); the probe accepted `{b:99,c:99}`.
    It only blocks while `pending.block` is non-null, so an authoritative window/outcome still needs
    implementation. `hintBlockAttempt` does not require the blocker to be the opponent. The mode
    table at `:46` allows Casual Undo/Undo Block only, so eventual Tactical-in-Casual scope also needs
    alignment with the intended two-player contract. Add Expert advice, canonical legality and
    revision checks, hidden-until-settled advice, separate earned shield reservation, caps, deadlines,
    replay/reconnect/timeout handling, and UI highlighting without constraining other legal moves.

No new provider inspection was attempted. Main's current acknowledgment records Android native
bridge presence with `canRequestAds:false`, no filled/earned hardware ad, and no live SSV proof.
Those receipts prove launch/bridge presence only; physical powers acceptance remains NOT_RUN.

## Executed verification

- **PASS: 106/106, 0 fail, 0 skip.** Command:
  `node --test tests/gameplay-rewind.test.js tests/powers-entitlements.test.js tests/powers-integration.test.js tests/v52-p21-powers.test.js tests/v5-native-foundations.test.js tests/v51-p21-bot.test.js`
  — [targeted-tests.log](targeted-tests.log). This proves the executed local contracts and fixtures,
  not provider/device/online acceptance.
- **Gap probes reproduced.**
  `node docs/v5.2/provider-evidence/20261015/powers-audit/cross-layer-probes.cjs`
  — [source](cross-layer-probes.cjs), [observations](cross-layer-probes.json). Exit 0 means the script
  reproduced its explicitly asserted gaps; it is not a feature-acceptance PASS.
- Read source wiring/contracts plus Main's current device/provider receipts. No network, accounts,
  emulator or physical-device run. No production state or release authority changed.

Rollback: no runtime/source change was made; this uncommitted evidence directory can be removed if
the integration owner chooses. Preserve other owners' changes and PR15 review hold.
