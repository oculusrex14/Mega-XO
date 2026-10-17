# Native app UI annotation execution plan — cumulative

Updated: 2026-10-17, after the owner's final batch. Authoring state: **ANNOTATIONS COMPLETE — EXECUTOR HANDOFF READY**. Implementation has not started under this plan.

This is the executor handoff for **22 app UI annotations in two batches** on `http://127.0.0.1:4197/bundle-index.html`. It is separate from the earlier P21 **website** annotation receipt at `docs/p21-web/ANNOTATION-IMPLEMENTATION-RECEIPT-20261017.md`. The owner finished annotation with the second batch and will switch to an executor. This authoring turn updates the plan only; it does not implement fixes, rebuild the review bundle, reset its storage, or change the owner's browser view. Section 24 contains the final implementation order and handoff prompt.

## 1. Baseline, authority and how to extend this plan

- Inspected source: `81e12162e57d38ac79103c9ab3bab1f507ef2876`, local branch `V5.2`; working tree was clean before this document was added.
- Local tracking observation: `V5.2...origin/V5.2 [ahead 1, behind 2]`. The tracking reference contained Main's review `d37b0e6` and Polar signature fix `811c349`. No fetch, merge, reset, branch cleanup, production change or push was performed for this plan. This observation is not a current remote-head guarantee.
- Final-batch local tracking observation: **ahead 1, behind 7**; Main's work continues. All source findings below are pinned to the inspected local SHA, not asserted against newer integration code. Check for fixes already landed before implementing each item.
- Current supplied `AGENTS.md` names `V5.1` as integration trunk, while the existing annotation work is on `V5.2`. **Do not resolve this discrepancy by moving/recreating branches.** Before later implementation, follow the latest owner/Main integration instructions. A detached local worktree from the agreed source SHA is the safe implementation workspace; hand off small commits to the integration owner. Preserve `main`, `V4.1` and unrelated work.
- Product constraints remain in `AGENTS.md`, `docs/PRODUCT.md`, its precedence patches and `native/COMMERCE-AND-ADS.md`. The current annotations authorize the UI changes described here. They do not change game rules, economy, ad-consent requirements, competitive state authority, identity proof, billing verification or release authority.
- The static review server has **no account API, billing provider or native bridge**. Its inability to authenticate or sell products is expected. Its controls must still open usable screens, explain missing services, and avoid dead clicks. Do not connect it to production using embedded credentials or grant permissive CORS to disguise its limitations.
- The source game entry is root `index.html`; the generated entry is `bundle-index.html`. App UI is under `src/`, not the distinct website components under `apps/web/`.

### Batch protocol

Use global IDs `APP-001`, `APP-002`, etc. Browser comment numbers may restart in the next message; never overwrite an earlier row with a later “Comment 1.” Record the batch, original number, page/context, requested outcome, source findings, implementation and acceptance criteria. Append batches of 10–15. If later feedback changes an earlier choice, add a dated superseding decision and retain the earlier evidence. Keep pending visual evidence pending; do not infer it from a screenshot of a different theme.

Statuses: `PLANNED` → `IMPLEMENTED` → `LOCAL_VERIFIED` → `DEVICE_VERIFIED` → `OWNER_REVIEWED`, with actual commit/build/evidence references. All items below are **PLANNED**. Diagnostic checks are not implementation acceptance.

## 2. Batch 1 register — owner comments 1–10

| Global ID | Comment | Context | Required outcome | Work package |
| --- | --- | --- | --- | --- |
| APP-001 | 1 | Settings/Wallet footer “Store” | Remove redundant appended entry; keep the intentional Purchases route | B1 |
| APP-002 | 2 | Settings About / legal links | Open correct public `https://megaxo.online` documents from app and review bundle | B2 |
| APP-003 | 3 | Settings Ambient sound | Make enable/disable produce an audible, reliable result with truthful failure feedback | B3 |
| APP-004 | 4 | Settings Reduce motion | Give the accessibility option a clear purpose and its own discoverable section | B4 |
| APP-005 | 5 | Second redundant “Store” footer | Same underlying fix as APP-001; verify both Settings and Wallet | B1 |
| APP-006 | 6 | Store Cosmetic Credits summary | Stable, readable surface and foreground across all four themes and theme switches | B5 |
| APP-007 | 7 | Store Mega Pass emblem | Implement Sol's crown-ticket SVG specification, aligned and legible | B6 |
| APP-008 | 8 | Cosmetic Credits label; app-wide small text | Adopt a researched readable scale and audit all app text, not only this label | B0 + B5/B6 |
| APP-009 | 9 | Store Mega Pass card | Dedicated spacious subscription layout; correct availability and entitlement states | B6 |
| APP-010 | 10 | Home Save your progress → Sign in | Restore account-module loading and make every sign-in entry open the account screen | A0 |

## 3. Verified diagnostics and limits

### Confirmed launch-blocking JavaScript error (APP-010, highest priority)

`node --check src/community.js` **FAILS** at baseline line 48 with `SyntaxError: Unexpected identifier 't'`. The owner's existing review tab also logged the same error from `http://127.0.0.1:4197/src/community.js`. `decisionChoice()` contains `We couldn't` and `We'll` inside single-quoted JavaScript strings. Additional similarly unsafe copy appears in `decisionProof()` (`profile's`, `we'll`) and `decisionConfirmNew()` (`won't`). Inspect the complete account decision section, not just the first reported token.

This is a parse failure: none of the module executes, so the delegated `[data-c]` click listener, `MegaCommunity.login`, profile decoration and provider refresh are never installed. `home()` already emits the correct `data-c="login"` attribute. Adding another Home click handler would conceal the cause and create duplicate ownership.

### Source-confirmed UI issues

- `src/monetization-ui.js:decorate()` unconditionally appends `.mono-entry` to both `wallet` and `settings` sheets. The Settings Purchases group already has `Get Crowns` and `Remove Ads / Restore Purchases` routes. These are additive routes to the same Store.
- `src/app.js:settings()` uses relative `/privacy`, `/privacy-choices`, `/terms`, `/support` links. `src/community.js:landing()` and the account-deletion decision copy do too. Runtime strings are not localized by the bundle builder's HTML rewrite. Relative links therefore use the local/native bundle origin.
- Absolute URLs alone are insufficient for native links that retain `target="_blank"`: iOS `MegaXOApplication.swift:createWebViewWith` rejects popups; its external-link handler accepts deliberate main-frame HTTPS navigation. Android similarly expects a main-frame navigation with a user gesture.
- `src/app.js:syncAudio()` creates one 130.81Hz oscillator at gain `.004`, ignores rejected `AudioContext.resume()`, and swallows all failures. This is a plausible cause of an inaudible/no-op control, **not proof of one device-specific audio failure**. Audibility remains a physical-device check.
- `.mono-balance` fills a large panel with `--accent-soft`, and uses `--muted` at 9px/12px for label/body. Its paired contrast is not a reliable reading surface in every theme. Example: Vector's `--muted:#747b84` is weak even against its light surfaces and needs explicit measurement for small text. The owner will add more theme evidence; do not invent a transition/timing root cause before reproducing it.
- `.mono-product` allocates an automatic-width CTA column capped at 145px, beside a 10px description. That makes a long subscription paragraph extremely narrow inside the app's approximately phone-width shell even on a wide browser viewport.
- `pageMarkup()` **and** `review()` use `p.removeAds && status.adMode !== 'hybrid'` as a purchase exclusion. Since `mega_pass` has `removeAds:true` plus other benefits, it inherits the standalone Remove Ads exclusion. In guest/unknown state it can even display “No automatic ads in this mode.” Correct both guards, not only the text.

### Investigation tools

GitNexus debugging skill was consulted, but the graph server does not index this repository. Its query returned repository-not-found. Findings above come from direct source reads, the parser diagnostic and the review-tab console. Do not claim a dependency-graph audit was completed.

## 4. A0 — restore account UI loading (APP-010)

Files: `src/community.js`, `tests/community-ui.py`; extend `tests/v5-client-bundle.test.js` for the script-parse gate. Root `index.html` and the generated manifest determine the actual script set.

Implementation:

1. Repair JavaScript string boundaries in `decisionChoice()`, `decisionProof()` and `decisionConfirmNew()`. Prefer short double-quoted JS literals for English copy containing apostrophes, with HTML attribute quotes escaped, or clearly escaped apostrophes in the current style. Do not interpolate unescaped profile/provider data. Retain `esc(...)`, identity-proof requirements, the distinct confirmation screen and 30-day deletion semantics.
2. Run the parser immediately and continue through every reported syntax error until the whole file parses. Do not remove decision flows or rewrite their architecture to avoid escaping text.
3. Add a meaningful parse check over **all** `client_scripts` in `native/client/bundle.config.json`. These are classic scripts: `new vm.Script(source,{filename})` checks syntax without executing or needing a DOM. Use separate compilation per file; concatenation can hide or create scope problems. If future entries are ES modules, use their declared parser mode rather than treating them as classic scripts.
4. In the existing browser fixture, enter Guest, click `.home-account [data-c="login"]` through its visible button, and assert `#identityScreen[data-kind="signin"]` opens once with email/Google/Apple options. Close and reopen it; verify Settings, Friends and Store sign-in entry points too.
5. The static preview must open the same screen with a useful offline/service explanation. Provider capability checks may disable unavailable authentication methods; **the entry button itself must not do nothing**. Preserve error/guest paths without waiting indefinitely for an absent API.
6. Preserve the existing single delegated `community.js` capture listener. Check focus entry into the account dialog, Escape/close and focus return. Avoid re-rendering a newly opened dialog behind another sheet.

Acceptance: no account script parse/page errors; each sign-in entry opens once; linked users see their real profile action; unavailable service state offers Guest/back without claiming a completed login. Real Google/Apple identity acceptance still requires the proper backend and signed host.

## 5. B0 — readable type system across the app (APP-008)

### Research and project decision

These are design starting points, not a claim that pt, sp and CSS px are universally interchangeable:

- [Apple: Designing for games](https://developer.apple.com/design/human-interface-guidelines/designing-for-games) gives iOS/iPadOS a 17pt default and 11pt minimum; the floor is not a sensible default for reading paragraphs.
- [Android: Material 3 typography](https://developer.android.com/develop/ui/compose/designsystems/material3#typography) lists body large 16sp/24, body medium 14sp/20, body small 12sp/16 and label large 14sp/20.
- [W3C: Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) calls for 200% text enlargement without losing content/function. [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) and [Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) supply complementary layout/contrast checks; WCAG does not prescribe a universal minimum font size.

**Chosen CSS baseline:** root 100% (normally 16px), paragraph/body 1rem with 1.5 line height; supporting/helper text `.875rem` (14px); short metadata `.75rem` (12px); buttons 1rem; ordinary form labels `.9375rem`–1rem; section headings 1.125rem–1.25rem; screen headings 1.5rem–1.875rem; balances 2.5rem–2.75rem. No meaningful app text below 12px at default size. Long instructions, purchase conditions and helper paragraphs must be at least 14px. Preserve recognizable display faces, but increase sizing for thin, wide or handwritten fonts when necessary. Essential terms use a foreground with measured >=4.5:1 contrast.

This supersedes the 13px renewal/retention suggestion in the Sol card specification; use **14px** here. A short badge/metadata token is not a license to shrink a full description.

Implementation guidance:

1. Introduce semantic size/line-height variables alongside the shared typography foundation in `src/styles.css`, e.g. `--text-body`, `--text-secondary`, `--text-meta`, `--text-action`, `--text-section`. Use `rem` and unitless line heights. Do not globally force every element to a minimum font size: icons, SVG text-free glyphs and board marks have separate geometry.
2. Audit **computed** visible text, including theme-specific overrides and `font:` shorthands, not only raw `font-size` declarations. Record affected selectors and intentional non-text exceptions in the execution receipt.
3. First replace undersized Store/Settings roles in `src/monetization.css` and `src/styles.css`: `.mono-balance-label`, `.mono-kicker`, `.mono-page-head>p`, `.mono-section>p`, `.mono-reward-card`, `.mono-product`, `.setting-group h4`, `.setting-row label/small/select`, `.theme-card b/small`, `.caption`, `.button`, `.legal-link`.
4. Cover the rest of the app in the same typography slice: Home/setup/nav/quests/rank/stats; account/friends/notifications in `src/community.css`; private lobby/tournaments/roster/tables in `src/party.css`; powers and match instructions in `src/styles.css`; `src/tutorial/tutorial.css` and `src/bot/pack.css`. Specific small-text hotspots include `.setup-title span`, `.setup-chip`, `.setup-note`, `.nav-button`, `.network-status-copy span`, `.rank-season-progress`, `.party-kicker`, `.party-currency`, `.party-table-stats span`, `.party-choice-copy small`, `.profile-fields small`, `.signin-foot`, `.identity-status`, `.board-note`, `.power-card small`, `.guided-progress`.
5. Remove or update conflicting per-theme size overrides near the ends of these stylesheets. Do not stack an endless new override layer while leaving an obsolete 8px `font:` shorthand authoritative. Existing static tests assert some exact old sizes; replace only the superseded size expectations with meaningful readability/fit checks and preserve the theme/behavior assertions.
6. Let content wrap and panels grow. Use `minmax(0,1fr)`/`min-width:0`; stack long label/control rows or product actions when necessary. Keep actual form inputs >=16px to avoid unwanted focus zoom on iOS. Do not shrink fonts again at narrow breakpoints.
7. Keep touch targets at least 44px high/wide for standalone actions; use 48px where comfortable. A small visible switch can live inside a sufficiently large labeled tap row. Board-cell target constraints are a separate geometry issue; do not enlarge all 81 cells or alter rules to apply a generic button size.
8. Preserve the existing viewport's ability to zoom; do not add `user-scalable=no`, `maximum-scale=1` or text-size suppression. Verify native OS text enlargement separately: rem units alone do not prove WKWebView Dynamic Type integration. If host scaling is absent, record the actual result and implement a narrow text-scale adaptation with Main rather than claiming support. Do not apply device pixel ratio as a font multiplier.

Acceptance: all app screens sampled across the four retained themes; paragraphs >=16px and supporting copy >=14px by their intended roles; no unexplained readable UI below 12px; 200% text size and 320px effective content width remain usable without lost buttons or covered content. Match board labels remain legible and semantic data unchanged. Collect before/after captures at the **same theme, content width and state**.

## 6. B1 — remove duplicate Store entries (APP-001 / APP-005)

Files: `src/monetization-ui.js:decorate()`, `src/app.js:settings()` and `wallet()`; existing browser UI checks.

1. Remove the branch in `decorate()` that appends `.mono-entry` whenever `sheetKind` is `wallet` or `settings`. **Final batch APP-019 also removes the Quests-page Store entry**, superseding Batch 1's provisional decision to keep it. Remove that injection too; if the decorator then has no work, remove its listeners/observer and unused CSS, preserving unrelated monetization event handlers.
2. Keep a single deliberate `Store` entry under Settings → Purchases. Route it through `data-monetization="open"` so the current Store opener owns the sheet-close/navigation sequence. Put it in the Settings markup, not a MutationObserver decorator.
3. Remove the old `Get Crowns`/`Remove Ads / Restore Purchases` Settings shortcuts if they duplicate that new single entry. Put a brief “Crowns, Mega Pass and purchase restoration” helper under Purchases. Restore itself remains the real action on the Store page; do not create an inert restore button in Settings.
4. Wallet retains its relevant balances/exchange UI and an intentional Get Crowns/Store route if already present in `wallet()`. No additional footer copy of the same route. Check the existing `[data-action="buy"]` and `[data-action="billing"]` capture handling before altering action attributes.
5. Preserve `mega:sheet` event handling for the remaining decorators. Reopening/switching sheets must not add entries or observers.

Acceptance: exactly one intentional Store route in Settings Purchases, none appended after About; no duplicate footer Store route in Wallet; no Store footer on Quests (APP-019); reopening each sheet/page five times does not accumulate DOM entries. Home Store remains. Opening Store closes the sheet, does not unexpectedly start a purchase, and supports Back to Play.

## 7. B2 — public legal/support links (APP-002)

Files: `src/app.js:settings()`, `src/community.js:landing()/decisionConfirmNew()` and any other app-owned public policy anchors found by search; `index.html`, `native/client/bundle.config.json`, `tests/legal-pages.test.js`, `tests/v5-client-bundle.test.js`.

Canonical map:

| Action | Destination |
| --- | --- |
| Privacy Policy | `https://megaxo.online/privacy` |
| Privacy choices | `https://megaxo.online/privacy-choices` |
| Terms | `https://megaxo.online/terms` |
| Support / purchase help | `https://megaxo.online/support` |
| Account deletion documentation, where already linked | `https://megaxo.online/delete-account` |

Implementation:

1. Prefer a small shared `src/public-links.js` contract (`window.MegaPublicLinks`): frozen canonical origin and fixed named URL map; a helper returns safe anchor attributes for known keys. No caller-supplied arbitrary origins, redirect destinations or account data. Escape labels as the existing renderers do.
2. Load it before `src/app.js` and `src/community.js` in root `index.html`, and include it in `native/client/bundle.config.json:client_scripts`. Follow the repository's classic-script/CommonJS testable pattern. Do not use an unbundled remote JS dependency.
3. Detect the already-defined native bundle declaration `meta[name="mega-account-transport"][content="native"]`. In native bundles use **same-frame** absolute HTTPS anchors (omit `target` or use `_self`) so the existing deliberate-link navigation delegates open the system browser. In ordinary browser UI use `_blank` with `rel="noopener noreferrer"` to preserve the game tab. This avoids broadening native popup/navigation permissions.
4. Replace relative policy/support paths consistently in Settings and account surfaces, including the deletion confirmation explanation. Retain bundled legal HTML as offline/reference assets; do not delete it or globally remove the builder's route-rewrite logic. Never replace account API, OAuth, party, CSRF or realtime URLs with the public-document origin.
5. Update `tests/legal-pages.test.js`'s existing assertion that app markup contains relative `href="/privacy"`, etc. Its HTTP route/content assertions remain valid and must stay. Add coverage for the actual canonical app link map and native/browser target choice.
6. Verify each destination on the public site read-only. A 200 response is necessary but inspect page title/content too; a generic SPA shell is not document verification. Use native taps to prove the system browser opens and returning preserves game state. No auth headers, session tokens or profile details go into these URLs.

Acceptance: all listed Settings actions open their named `megaxo.online` document from browser, Android and iOS; no navigation to `127.0.0.1/privacy`, `mega://.../privacy` or an Android asset-host policy path; no blocked iOS popup. Failure to reach the internet yields the browser's honest network state, not a swallowed tap.

## 8. B3 — functional ambient sound (APP-003)

Files: `src/app.js` audio state/`tone()`/`syncAudio()`/settings-change handler/visibility handler; targeted audio-lifecycle test, plus manual browser/device checks. Keep persisted `data.settings.music` for compatibility.

1. Reproduce from an explicit user gesture at normal media volume. Note the difference between Sound effects (`sound`) and Ambient sound (`music`). Do not require both switches to be on.
2. Replace fire-and-forget resume with an explicit lifecycle: `ensureAudioRunning()` → start exactly one ambient graph when opted in and visible; stop/disconnect on off, hidden/pagehide or teardown. Reuse the existing single AudioContext for effects/ambient. Keep live nodes and a generation counter so a delayed resume cannot start audio after the user switched it off.
3. Await `ctx.resume()` and inspect `ctx.state`; do not display successful playback when still suspended. Trigger the initial unlock synchronously from a click/change gesture before awaiting unrelated work. If automatic foreground resume is blocked, leave the saved preference intact and offer a small “Tap to resume sound” action.
4. Improve the existing extremely quiet sub-bass tone into a quiet, actually audible ambient bed using Web Audio (e.g. a few soft sine tones in a phone-speaker-friendly midrange). Use conservative master gain and short fade-in/fade-out ramps to prevent clicks. Start quietly, test on both phone speakers, and tune by listening; do not solve inaudibility with a sudden large gain jump. No autoplay before opt-in, downloaded music, microphone access or new content license dependency.
5. Add a short **Preview sound** button to Sound & feedback. It performs a brief bounded preview on deliberate tap even when the persistent ambient preference is off, then cleans up. Its accessible name must distinguish a preview from turning on continuous sound.
6. On unsupported/failed audio, show “Sound is unavailable here” or “Tap to enable sound” as appropriate. Avoid an unchecked exception, repeated toast loop, false “playing” state or reverting unrelated settings.
7. Preserve effect timing, match clocks, bot cancellation and the existing visibility handling. Disconnect stopped gain/oscillator nodes; repeated toggles must not leak graphs or stack louder copies. Audio state changes do not rerender the whole app.

Automated checks: one graph after repeated enables; zero after disable/hidden; stale pending resume cannot restart it; rejected resume is reported; effect and music settings remain independent. Fake Web Audio can prove lifecycle, **not audibility**.

Manual acceptance: audible but quiet preview/ambient on review browser and both physical phones; off is silent immediately after the short fade; background is silent; resume works without duplicated sound; denied/suspended/unavailable states have a usable recovery. Record device OS/media-volume and mute/audio-session behavior without changing system settings automatically. Do not claim iPhone audio acceptance from a desktop trace.

## 9. B4 — place and explain Reduce motion (APP-004)

Files: `src/app.js:settings()/applyTheme()`, `src/styles.css` Settings layout and motion rules, `src/community.css` loaders if motion checks reveal a gap.

Decision: retain the accessibility function and make it understandable. It reduces movement for comfort and motion sensitivity; it is not a theme option. The owner's question does not require deleting accessibility support.

1. Move `toggle('motion',...)` out of the tail of the Appearance theme grid into a separate **Accessibility** Settings group, immediately after Sound & feedback and before Notifications/Appearance. Keep its own padded row and heading, rather than sharing a cramped edge with a theme card.
2. Label **Reduce motion**, helper **Limit animated transitions and moving effects.** Maintain `data-setting="motion"`, `id="setting-motion"` and the existing saved boolean (`true` means reduced).
3. Preserve both the explicit root `data-motion="reduced"` rules and `prefers-reduced-motion:reduce`. OS preference still applies when the app switch is off. If OS reduce-motion is active, show a concise explanation that the device setting also limits animations; don't present Off as overriding the OS or silently mutate the saved app preference.
4. Ensure row label/switch spacing and readable type follow B0. Give switches a real label and adequate tap area. No animation preview or additional modal is needed.
5. Verify route-draw/pulses, loaders, theme/page transitions and press movement obey the effective reduced preference. Essential status remains visible as a static shape/text; do not hide route information, progress or game feedback when animation is removed.

Acceptance: easy to find near the top of Settings, distinct from themes; immediate visible reduction of decorative motion; persisted after reload; OS preference honored; gameplay, clocks, audio and routing rules unchanged.

## 10. B5 — theme-safe Cosmetic Credits summary (APP-006 / APP-008)

Files: `src/monetization-ui.js:pageMarkup()` balance branches, `src/monetization.css`, narrowly scoped Store tokens in `src/styles.css` only if necessary.

1. Use a neutral raised/surface panel with a clear border and a **small** accent detail (edge/icon), instead of filling the entire reading surface with `--accent-soft`. Set explicit foreground/background pairs for label, amount, explanation and CTA. Do not change global accent tokens to repair one panel.
2. Proposed layout: `.mono-balance-copy` containing “Cosmetic Credits” and a tabular amount; `.mono-balance-description` below/alongside as width allows; guest sign-in CTA on its own row. At narrow app widths use one column. Label 14px, amount 40–44px, body 16px/1.5; allow content-driven height and preserve spacing around the action.
3. Separate guest/authenticated/error/loading states. Keep `0` as the actual zero balance. A guest can show “Sign in to view your balance” rather than a large misleading `--` amount; a signed-in failed status load must show balance unavailable/retry, not pretend the user is a guest or has zero. `who()`/`API.peek()` determines identity, not `!!status` alone. Retain the existing working sign-in action.
4. Keep currency naming/meaning: Cosmetic Credits are not Coins or Crowns. Preserve earnings caps and the future cosmetic-release wording. Do not substitute wallet totals or move currency locally.
5. Measure computed contrast of actual paired colors for all four themes. Prefer a scoped `--store-muted` adjustment when a theme's global muted token fails; review the wider text audit separately rather than blindly recoloring the whole app. Essential copy >=4.5:1; focus/meaningful boundary contrast remains visible.
6. Reproduce switching through Vector → Midnight → Paper Club → After Hours → Vector while Store is visible, with Settings open/closed as applicable. Capture the owner-reported mixed-color state if it persists. Remove stale inline colors/classes only if demonstrated; don't add timeouts, global animation suppression or a forced page reload to mask it.
7. Preserve Paper Club's corner style but keep paper texture/rules outside the text's solid reading surface. Keep the After Hours atmosphere outside the balance content; no low-opacity text over bright textures. Do not introduce cinematic website artwork into native themes.

Acceptance: guest, true-zero, positive, loading and failed-status summary readable in every theme; no stale colors after repeated theme changes; no clipped label/button, overlapping texture or horizontal overflow at 320/360/390px and 200% text size. The additional owner theme screenshot can refine this item in the next batch.

## 11. B6 — Sol's Mega Pass emblem and subscription card (APP-007 / APP-009)

Sol 6.1, xhigh, supplied this planning specification on 2026-10-17. No asset/code implementation or visual acceptance has occurred. Actual entry points are `MegaIcons.pass(large=false)` in `src/icons.js`, `pageMarkup()/passDetails()/review()` in `src/monetization-ui.js`, and `.mono-product` in `src/monetization.css`. There is no `renderShopStore()` or `passBadgeSvg()` at this baseline.

### B6.1 SVG specification

Replace the current star-with-dashed-dividers ticket with a broad notched membership ticket containing a three-point crown. Keep the rank icon family's rounded two-color strokes but a distinct membership silhouette. Do not modify the rank badges.

Use this geometry as the implementation starting point:

```svg
<svg xmlns="http://www.w3.org/2000/svg" class="rank-badge pass-badge"
     viewBox="0 0 64 64" width="64" height="64"
     aria-hidden="true" focusable="false">
  <path d="M14 10H50Q58 10 58 18V26C51 26 51 38 58 38V46Q58 54 50 54H14Q6 54 6 46V38C13 38 13 26 6 26V18Q6 10 14 10Z"
        fill="var(--pass-bg,var(--badge-bg,#f5e7b2))"
        stroke="var(--pass-ink,var(--badge-ink,#805b0c))"
        stroke-width="2.4" stroke-linejoin="round"/>
  <g fill="none" stroke="var(--pass-ink,var(--badge-ink,#805b0c))"
     stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 24 26 30 32 20 38 30 46 24 42 40H22Z"/>
    <path d="M24 46H40"/>
  </g>
</svg>
```

Scope palette variables to `.pass-badge`:

| Theme | `--pass-bg` | `--pass-ink` |
| --- | --- | --- |
| vector | `#f5e7b2` | `#805b0c` |
| midnight | `#4c4123` | `#f2d88d` |
| paperclub | `#ead6aa` | `#6f4d14` |
| afterhours | `#4c4123` | `#f2d88d` |

These derive from existing Gold/Paper badge colors. Measure contrast in the implemented result; don't treat proposed colors as a completed visual test. No SVG IDs, embedded fonts, raster content, filters, gradients, animation or fine dashed details. Proportional strokes should be clear at 32/48/64px; do not add `vector-effect="non-scaling-stroke"`.

Preserve `MegaIcons.pass(large=false)` compatibility. An optional second `{decorative:true}` argument may request `aria-hidden="true"` beside the heading; standalone default remains an image with accessible name “Mega Pass.” `display:block`, `flex:none` and a `--pass-size` variable control size. Rules for `.rank-badge.pass-badge` must override inherited rank width, including `.large`; preserve the existing large fallback for other callers. Forced colors use `Canvas`/`CanvasText`.

### B6.2 Dedicated card structure

In the existing product rendering map, route only `p.id==='mega_pass'` to `renderMegaPassCard(...)`. Keep other product IDs/order; ordinary rows also receive the B0 readability adjustment. Rename the section to **Crowns, Mega Pass & Remove Ads** or a comparably clear short heading, rather than omitting its subscription.

```html
<article class="mono-product mono-pass-card" aria-labelledby="mega-pass-title">
  <header class="mono-pass-head">
    <span class="mono-pass-emblem"><!-- decorative SVG --></span>
    <div class="mono-pass-heading">
      <h4 id="mega-pass-title">Mega Pass</h4>
      <p class="mono-pass-subtitle">Monthly subscription</p>
      <!-- verified Active status when known -->
    </div>
  </header>
  <ul class="mono-pass-benefits"><!-- one benefit per li --></ul>
  <footer class="mono-pass-purchase">
    <div class="mono-pass-price"><!-- actual localized price + period --></div>
    <p class="mono-pass-renewal" id="mega-pass-renewal"><!-- terms --></p>
    <!-- existing review action, class mono-pass-cta -->
    <p class="mono-pass-retention"><!-- lapse behavior --></p>
  </footer>
</article>
```

Layout contract:

- `.mono-product.mono-pass-card`: one column (`minmax(0,1fr)`), `align-items:stretch`, 20px padding/gap, automatic height, `min-width:0`. Do not inherit the generic side CTA column.
- `.mono-pass-head`: grid `64px minmax(0,1fr)`, 14px gap, centered vertically. Emblem is outside the heading, so text baseline wrapping cannot displace it.
- Title: 22px/1.2; subtitle: 14px/1.45, 6px top gap. Benefit list: semantic list, 14px row gap; each primary benefit 16px/1.45, support text 14px/1.5. Decorative checks, if used, have no accessible name/focus.
- Purchase footer: 18px top padding, 1px `--line` border, 10px grid gap. Price 24px/1.2, period 14px; renewal/retention 14px/1.5. Full-width CTA, `max-width:none`, margin 0, >=50px high, 16px text, wrapped label.
- <=359px: 16px card padding, 18px section gap, 48px emblem/header column, 12px header gap. Keep text sizes; stack further only if needed. Judge the **actual app content width**, which can be much narrower than the 1108px outer viewport.
- Use `--raised`, `--ink`, `--line`, `--cta`, `--on-cta` and scoped accessible secondary text. Preserve native Paper Club irregular corners and After Hours card geometry. No fixed heights, line clamping, sticky CTA or absolute-positioned text.
- Keep price/terms/action below benefits at every width. The entire card scrolls naturally above the bottom nav and safe area.

### B6.3 Benefits and truthful commerce state

Read numeric values from `M.PASS`, not duplicate magic numbers. Preserve the current intended policy: 150 Crowns per paid month as 50/50/50 on billing days 1/11/21; 2× qualifying bot-win Coins with existing daily caps; 8:1 exchange for the first 200 Coins per billing month; 15% off up to two Crown packs per billing month; automatic ads off with optional rewarded ads. Do not change price, economic policy or paid/earned Crown utility in this UI slice.

**Important readiness limit:** constants and copy do not prove the benefits are implemented on a particular provider. The earlier receipt records gaps in V5 exchange and Polar discount enforcement. Sol also found native bridges enumerating the four older products and Android querying `INAPP`, not a verified `mega_pass` subscription. Do not ship a purchasable native subscription advertising unavailable benefits. Carry these as a separate commerce integration handoff to Main, with actual provider/build evidence; a layout commit cannot close that work. In preview, show the product and accurate unavailability explanation.

1. Correct the standalone ad-removal exclusion in **both** `pageMarkup()` and `review()` to apply to `p.id==='remove_ads'`, not every `p.removeAds` product. `adMode:'off'` does not by itself make all Mega Pass benefits unnecessary.
2. Derive product presentation state consistently; a helper such as `purchaseState(p,status,price,identity,bridge,busy)` can serve card and review guards. `mega_pass` active state comes from verified `status.pass.active`, not lifetime membership in `status.products`. Unknown/missing status does not imply owned, guest or no-ads mode.
3. States: guest → working sign-in action; linked loading → checking availability; genuine product/bridge/availability missing → price unavailable + useful visible explanation; eligible → localized price + **Review subscription**; busy → disabled with progress wording; verified active → **Active**, no second subscription purchase. Use a real subscription-management action only if supported, otherwise accurate device-settings guidance.
4. Display the actual `price.price` intact and escaped, preferably in `<bdi>`, with a separate monthly-period label. Suggested USD values are not device-store prices. Never synthesize currency conversions or discounts.
5. Before the CTA disclose **Auto-renews monthly until cancelled. Cancel through your device store's subscriptions.** Below: **Crowns, Coins and banked power-ups already received are kept if your Pass expires.** Ensure supported billing semantics match this text.
6. Reuse `data-monetization="review" data-value="mega_pass"` and the existing two-step review/confirm pipeline. The review screen should also use readable benefit/renewal structure, not fall back to a cramped 10px paragraph. Recheck eligibility before purchase; preserve actor binding, backend verification and finish-after-durable-delivery.
7. Do not insert Polar/Cashfree or browser checkout in native UI. Do not fake native products, completed payments, entitlements or economic benefits to enable the button. Restore non-consumables/subscriptions only through supported verified lanes; never restore consumables as new grants.
8. Associate action with renewal description using `aria-describedby`. Keep focus stable on availability updates; avoid wholesale Store replacement while its button is focused. Announce only changed status, not the whole card.

Acceptance: aligned icon/header; readable five-benefit list and price/terms/action hierarchy; all presentation states covered, including `mega_pass + adMode:'off'`; standalone Remove Ads retains its existing exclusion. 32/48/64px emblem previews in every theme, effective content widths 320/360/366/390/440px and 200% text enlargement; long localized price/button text wraps. Screen-reader order: heading, monthly period, benefits, price, terms, action, retention. Other ranks and game/economic behavior unchanged.

## 12. Execution order and cohesive checkpoints

The owner has finished annotation. Start when the executor is instructed to implement this plan. **The final order in section 24 supersedes this Batch 1-only sequence** and includes the final twelve annotations.

1. Re-read this entire cumulative plan and latest integration ownership; inspect user work and source SHA. Do not overwrite Main's intervening changes with old file copies.
2. **A0** parse repair + parse gate + account entry behavior. This unblocks reliable Store sign-in and authentic UI fixtures.
3. **B0** shared typography roles and Settings/Store foundations; include app-wide computed-text inventory. Coordinate overlapping CSS with later batches before finalizing.
4. **B1/B2/B4** Settings structure, deduplicated Store navigation, canonical document links and accessible motion placement.
5. **B3** audio lifecycle and actual audibility.
6. **B5/B6** balance surface/state and Pass SVG/card/availability. Shared `monetization-ui.js` changes must have one owner.
7. Build a fresh app review bundle only after changes are ready; leave the existing owner annotation session intact until then. Reuse a suitable port; do not stop another agent's server to claim a port.
8. Browser visual/interaction verification, then Main's signed Android/iOS build and physical checks. Recheck the earlier iOS launch-crash fix against the actual new artifact before device UI acceptance. Prior nested-Mach-O signing evidence is in the earlier receipt; do not mark a new build launched based on that old evidence.
9. Record per-ID results, exact SHA, commands, environment, bundle hash, device/build, screenshots, real skips and remaining commerce items. **LR02 final CI verification stays last** under the owner's standing instruction.

Suggested commit boundaries once execution is authorized: `fix(account): restore app identity script loading`; `feat(ui): readable app type scale`; `fix(settings): simplify navigation and public links`; `fix(audio): make ambient playback reliable`; `feat(store): theme-safe balance and Mega Pass card`. Adjust to later batches and integration ownership; no history rewrite needed.

## 13. Verification recipe for the executor

These are future checks, **not recorded PASS results**. Use the repository's current supported Node/Python/Playwright runtime; don't install global packages or alter unrelated environments just to run a browser test.

```sh
node --check src/community.js
node --check src/app.js
node --check src/monetization-ui.js
node --test tests/static-ui.test.js tests/legal-pages.test.js tests/v5-client-bundle.test.js
node --test tests/monetization-ui-contract.test.js tests/monetization-policy.test.js tests/monetization-store.test.js tests/v52-pass-benefits.test.js
```

Confirm test filenames at the execution SHA; don't silently skip a missing test. Add compact behavior coverage for audio lifecycle, shared public-link attributes, Pass state decisions and the script-parse gate as described above. Existing browser fixtures `tests/community-ui.py` and `tests/monetization-ui.py` exercise real **local** service calls with test providers. Extend them rather than creating an unrelated second harness; their file-inline script loading must include any new shared script. They do not prove real store/provider acceptance.

Fresh deterministic bundle (use an unused output directory to preserve the annotation snapshot):

```sh
node scripts/v5/build-client.js --output .artifacts/app-ui-annotations-review --check --json
```

The current `scripts/v5/serve-client-review.cjs` hardcodes the older `.artifacts/v5-client-review` directory and port 4197. It must be parameterized or replaced with an equivalently constrained static review command when switching to the new output. Do not claim the new files are being reviewed while serving the old directory. Keep the old owner's session untouched until the agreed switch.

Browser interaction matrix:

- Four retained themes × guest/linked/loading/error states for Store summary and Pass; all Settings groups and legal links.
- 320/360/390/440px effective app widths, ordinary and 200% text. On desktop also inspect the actual bounded app shell rather than inferring content width from the viewport.
- No page errors; Store routes don't duplicate; Home/Settings/Store sign-in opens once; dialogs restore focus; keyboard actions and readable disabled-state explanations.
- Repeated theme switches with Store open; actual foreground/background contrast; no full-bleed accent wash, blended texture, clipped buttons or bottom-nav overlap.
- Reduced motion by app switch and OS emulation; static route/loader/status remains meaningful.
- Audio lifecycle checks plus human/device listening; desktop audio screenshots alone do not prove audibility.

Device matrix later: Android and iOS install/launch, sign-in entry, settings/legal-browser round trip, ambient sound, text enlargement, theme changes, Store navigation and subscription state using genuine availability. Preserve the owner's saved profiles/progress. Native payment settlement, LAN cross-phone discovery, signed-in tournament flows and final production acceptance remain separately identified work; don't quietly mark them closed by this UI plan.

## 14. Collection close and superseding owner decisions

- Owner's final batch says **“Last set, I'm done now.”** Collection is complete: APP-001–APP-022, all PLANNED. Further implementation is for the executor, not this planning turn.
- **APP-019 supersedes B1's original Quests exception:** remove the Quests Store footer as well as redundant sheet footers. Keep Home and the deliberate Settings Purchases route.
- **APP-022 supersedes the old native fresh-install default:** After Hours becomes the default for a newly downloaded native app. Preserve existing saved theme choices and the distinct cinematic website default.
- **APP-011 + APP-021:** Home utilities become a separate neutral/gray section after the tutorial, in order Daily quest → Store → Save your progress → Sponsors.
- **APP-006:** the final batch does not include the promised second balance-theme screenshot. Reproduce the actual four-theme panel and follow B5; this missing extra image does not block the planned repair. Do not substitute the new tournament screenshot as balance evidence.
- **Commerce readiness:** the previously recorded native/provider Pass gaps remain separate, explicitly evidenced handoff items. No claim of provider-live, device-verified or production-ready follows from this plan.

## 15. Batch 2 register — final owner comments 1–12

Original comment numbers below refer to the **second** message, not the first ten comments.

| Global ID | Batch 2 comment | Context | Required outcome | Work package |
| --- | --- | --- | --- | --- |
| APP-011 | 1 | Home below “New to Mega XOXO?” | Put all lower utilities in a separate gray/neutral section; repair setup container nesting | C1 |
| APP-012 | 2 | Rank help “An upset” | Say “Beating a higher-rated opponent…” in plain language | C2 |
| APP-013 | 3 | Rank help before league table | Consistent headings, spacing and readable sections | C2 |
| APP-014 | 4 | Home mode switching | Remove the replayed refresh/entrance animation; keep switching stable | C3 |
| APP-015 | 5 | Private local player-name textarea | Player-count dropdown and one input per player; verify names reach fixtures/board | C4 |
| APP-016 | 6 | Android invite / host readiness / iOS discovery | Real transport-aware LAN join data and reliable cross-phone readiness/discovery | C5 |
| APP-017 | 7 | Private rooms Wi-Fi choices | Single “Same Wi-Fi” entry → Host or Join; Join supports discovery and room code | C5 |
| APP-018 | 8 | Weekly rank reward card | Structured amount, eligibility checklist and timing; readable spacing | C2 |
| APP-019 | 9 | Quests Store footer | Remove it; supersedes B1's provisional exception | B1 |
| APP-020 | 10 | Unknown private/tournament yellow CTA | Audit and repair real theme/foreground collisions in all party action states | C6 |
| APP-021 | 11 | Home Sponsors + new app page + website enquiry | Optional sponsor discovery, interests, reporting/hiding and direct sponsor email flow | C7 |
| APP-022 | 12 | First downloaded app theme | After Hours on new native installs; no overwrite of existing preferences | C8 |

## 16. C1 — Home sections outside match setup (APP-011 / APP-021)

Files: `src/app.js:home()`, `src/styles.css:.old-setup/.home-sections`, account decorator in `src/community.js` only if needed.

**Confirmed structural defect:** in the Bot/local branch, `setup` starts `<div class="setup old-setup">` and ends with the two closes for the timer's `.setup-chips` and `.setup-block`; it never closes the outer setup. The browser therefore nests Start Match, tutorial and `.home-sections` inside that box. The owner's selected ancestor in the screenshot is consistent with this source defect. The online branch separately closes its setup; don't add a blind extra `</div>` to every mode.

1. Refactor the setup markup into a bounded helper that always returns balanced markup. Match options and Start/Browse action belong in the match-setup area; the tutorial is a following sibling. Close that area **before** the tutorial. Do not rely on browser error recovery for tag balancing.
2. After the tutorial, render one `<section class="home-utilities" aria-label="More from Mega XOXO">` containing the existing `.home-sections` cards plus Sponsors. Order: Daily quest, Store, Save your progress, Sponsors. Preserve `.home-account`, its name node and `[data-c]` contract so account decoration still updates it once.
3. Use neutral gray/raised theme surfaces, not a fixed light gray on all themes. Suggested tokens: `--soft-panel` for the section, `--raised` for cards, `--line` border, `--ink` text. 16px outer padding, 12–16px card gaps, 20–24px separation from tutorial. Dark/After Hours use their neutral dark equivalents. Keep the section visually distinct from match configuration without introducing another nested accent wash.
4. Preserve Home's Store and login/quests behavior. The new Sponsors action is `data-action="nav" data-value="sponsors"` once C7 adds that page mapping. No additional bottom-navigation item is required.
5. Each utility has a heading, one short supporting sentence and a clear action. Sponsors copy: **“Support more great games”** / **“Discover our sponsors and help us keep improving Mega XOXO.”** CTA **“Explore sponsors.”** Do not promise that merely opening the page earns revenue or game currency.

Acceptance: the tutorial and utilities are siblings of the match setup in every mode; utilities are outside `.old-setup`; four cards in the specified order; no merge of gray surfaces; app-width responsiveness, readable spacing, bottom-nav/safe-area clearance, and unchanged settings selections across mode switches.

## 17. C2 — rank explanation and reward layout (APP-012 / APP-013 / APP-018)

Files: `src/app.js:rankHelp()/weeklyHelp()/quests()`, `src/styles.css`; reuse `D.TIERS` and `D.POLICY`. Do not edit Elo, qualification, snapshots or reward arithmetic.

### Rank help

1. Replace the opening ambiguous paragraph with: **“Ranked matches change your Elo rating. Beating a higher-rated opponent earns more rating points than beating an equally rated opponent. One win does not swap your leaderboard positions.”** No invented point examples or guaranteed gains.
2. Use a dedicated `.rank-help` wrapper and semantic sections: **How your rating changes**, **Quarterly seasons**, **League thresholds**, **Elite leagues and activity**. Readable paragraphs and lists should replace the undifferentiated stream of `<p class="caption">` and headings.
3. Present the existing maximum change (24 at the inspected policy) and no-money-in-Elo rule as a short note beneath the opening explanation. Use the actual policy constant where exposed; do not change calculation/rounding or copy unsupported exact numbers from this plan if policy code differs at execution.
4. Explain seasons with a short introduction and list: four calendar quarters; five requalification games; at least three matchmade Ranked games; at least three different opponents. Then a separate paragraph: Elo is retained, and requalification returns the player to the league their current rating supports. Preserve the separate lifetime placements requirement and elite seat/activity rules; do not conflate them with seasonal requalification.
5. Use 20–24px between sections; 8–12px between a heading and its body; paragraph line height 1.5–1.6. Keep notes 14px, main text 16px, headings 18–20px. The league table starts after a distinct heading and 16px gap. Existing rank emblems remain aligned in their own table/row column. No first/last paragraph margin collapse into the sheet header.
6. Keep the full rules in the same help sheet with normal scrolling. Do not solve density by deleting qualification conditions or shrinking typography.

### Weekly reward card

1. Replace `quests()`'s generic unclassed `.card` with `.weekly-reward-card`: header/amount, a short eligibility list, timing line and a distinct footer action. Keep its visible section title “Weekly rank reward.”
2. For a qualified authenticated player, show the server-backed state where available. If only the tier's nominal maximum is known, label it **“Up to 20 Coins at Wood”** (dynamic tier/amount), not a guaranteed payment: existing daily snapshots/pro-rating can lower it. Guest, placements and seasonal-requalification states have their own explanatory heading; don't portray guest fallback Wood as an earned weekly entitlement.
3. Checklist: **5 Ranked games**, **at least 3 matchmade**, **3 different opponents**, **play on 3 days**. These describe the same overlapping requirements, not five plus three additional games. Bind counts to existing trusted progress fields only if supplied; otherwise show the requirements without fabricated counters.
4. Timing: **“Qualified rewards arrive automatically after the week ends, from Monday 00:00 UTC.”** The Reward details action retains `weeklyhelp` and the snapshot/pro-rating explanation. Preserve non-expiring eligibility and unchanged backend settlement.
5. 18–20px padding, 14–16px internal gap, 16px body/14px support. Amount may be 22–24px; requirements can be a readable list or 2×2 grid, stacking when narrow or enlarged. Footer action >=44px and separated from the final line. No entire-card monospace paragraph.

Acceptance: no “upset” jargon in this explanation; all existing rules remain discoverable; consistent section rhythm; weekly requirements readable individually; no false payout/progress claim; correct guest/placements/qualified states and no overflow at 320px or 200% text.

## 18. C3 — stable mode changes without refresh animation (APP-014)

Files: `src/app.js:render()/home()/actions.mode`, `src/styles.css` around `@keyframes mega-screen-in` and `#page>*`.

**Confirmed cause:** `mode:v=>{mode=v;render();}` reconstructs all `#page` children. The unconditional `#page>*{animation:mega-screen-in .18s ...}` fades/slides each replacement, including unrelated Home cards. This is a presentation effect, not an actual page reload.

1. Remove the blanket entrance animation from Home content, regardless of Reduce motion setting. Scope any retained navigation-only effect explicitly; mode selection is not a screen-entry event. Do not force users to enable Reduce motion to fix ordinary mode changes.
2. Introduce a `renderHomeSetup()` helper shared by `home()` and a narrow `updateHomeMode()` path: update mode `.active`/`aria-pressed`, replace only the setup fragment, and update the primary Start/Browse label. Hero, mode list and utility section retain their DOM nodes. Stable named setup/CTA mounts make this straightforward and prevent collateral provider/account refreshes.
3. Keep selected difficulty, first mark, timer and ranked/casual subtype in their existing state variables. Changing mode does not start a match, clear a save, issue a queue request, or open the private/tournament screen; the primary CTA still owns those transitions.
4. Preserve scroll and focus on the selected mode button. New setup controls remain reachable by keyboard. Apply the same stable setup update to difficulty/first/timer/subtype changes if they would otherwise replay full Home rendering. Do not animate opacity, translation, height or backgrounds on selection; retain a clear instantaneous selected border/state.
5. Keep gameplay routing/pulse animations and the separately requested Reduce motion feature intact. If mode press transforms themselves contribute to the reported flicker, remove them for `.mode` while retaining focus/selected feedback.

Acceptance: repeatedly switch all five modes with no page flash/slide, scroll jump or lost focus; correct setup and CTA each time; no network/match side effects before Start; Home utilities remain mounted once; keyboard selection and B4 preferences still work.

## 19. C4 — individual local player fields (APP-015)

Files: `src/party-ui.js:setup()/createRoom()/player()/paint()` and local form state, `src/party.css`; `src/tournament.js` remains the rules oracle.

1. Replace the local-only `textarea#partyNames` with a labeled `<select id="partyPlayerCount">` and a `.party-player-fields` list of individual `<input maxlength="32" autocomplete="off">` controls. Each has a permanent label **Player 1**, **Player 2**, etc.; placeholders are hints, not the only labels. Keep network-room setup's single “Your display name” field—hosts do not invent names for remote players.
2. Maintain an in-memory `localSetupDraft={count,names,format,clock}` separate from room state. On count/format changes, read current inputs into the draft before rendering only the name-field mount. Growing preserves existing names; shrinking preserves hidden drafts for re-expansion but only the selected count is submitted. Back/Create instead shouldn't silently wipe the draft.
3. Respect existing format constraints: duel exactly 2; Groups + Knockout at least 4; League/Knockout 2–10. On a fresh form prefer count 2 with duel, switching count >2 can suggest a supported format. If the user deliberately picks mixed with too few players, explain the 4-player requirement or offer an explicit format change. Do not silently change rules, increase room capacity or render impossible counts. Keep `T.create/T.join/T.start` validation authoritative.
4. Use a responsive two-column grid only when the **actual party-body width** permits two comfortable inputs; stack on small/enlarged screens. Provide 16px text, 44–48px inputs, 10–12px gaps, and a short player-count summary. No oversized empty textarea or compressed name placeholders.
5. `createRoom()` collects exactly `count` trimmed nonempty names, validates the existing 32-character bound and assigns unique generated IDs as before. Blank/invalid fields get inline errors and focus; don't silently discard them with `filter(Boolean)` and create fewer players. Preserve the existing duplicate-display-name rule (unique actor IDs are what distinguish seats); don't invent a new backend name restriction.
6. Call `T.join(room,ids[i],names[i])` in field order. Keep sequential/local rules and host/session identity. Escape names in roster, bracket, standings, `player(id)` display and board headers. User input must never become HTML or mutate actor IDs.
7. Confirm the current mapping rather than assume it: `player(id)` reads `room.players`, and party `paint()` calls it for each fixture player's header and turn text. Exercise both marks, a later round, reload/Continue saved event and final standings. No player should revert to a generated ID or “Player 1” placeholder after entering a real name.

Acceptance: counts 2/4/10, grow/shrink without lost draft, invalid blanks/long names, format minima, non-ASCII and HTML-like names, complete local creation→ready→fixture→board→saved-resume flow. Names remain attached to the correct stable IDs. Local private play still has no official economic/rank effects.

## 20. C5 — unified Same Wi-Fi flow and usable invitations (APP-016 / APP-017)

This source-traced specification includes an independent **Sol 6.1 xhigh** review of the JavaScript and both native bridges. No device or network tests were executed for this planning batch.

Files: `src/party-ui.js`; `src/lan/{lan-host.js,lan-room-store.js,lan-room-http.js}`; `native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidLanBridge.kt` and its host integration; `native/ios/MegaXO/MegaNativeLan.swift` and its host integration; relevant native manifest/Info.plist declarations and tests. Freeze one contract before parallel native edits.

### C5.1 Findings that change the previous diagnosis

The earlier receipt's successful Android self-discovery/serve observation does not prove the full app join path works. **Supersede its iPhone-only attribution with these additional source-confirmed defects**; preserve the old receipt as historical evidence.

| Finding at the inspected SHA | Source / implication |
| --- | --- |
| Copy invite uses the local document origin | `party-ui.js` copy action concatenates `location.origin + location.pathname`; it produces Android's internal `appassets.androidplatform.net` URL. `drawRoom()` also displays the wrong origin. iOS's internal document is unsuitable too. |
| Portable discovery results lack `status` | `lan-room-store.js:discover()` omits status while `party-ui.js:lanScan()` requires `r.status==='LOBBY'`; real discovered rooms are hidden. A native-bridge fixture supplies the missing field and masks this defect. |
| Short code is submitted as a room ID | `joinRoom()` sends `partyCode` as `id`, but portable `lan-room-store.js` resolves actual IDs only; its journey fixture joins by ID. Copying a correct-looking code cannot solve this. |
| No code/address inputs on native Wi-Fi Join | `lanJoin()/lanScan()` show a name and discovered cards only; a failed browse becomes an apparent empty list. |
| Reconnect forgets the host address | `showRoom()` saves `{id,transport}` only; `lanBase` is memory-only and not restored by reconnect. |
| Starting this phone as host can retain another host | `lanStart()` clears session but not `lanBase`; an old remote endpoint can still be targeted. The entered hosting name is discarded before the create form. |
| Readiness is incomplete | `MegaLanHost.open()` assumes synchronous socket start, ignores advertisement results and reports success. Native registration/discovery failures can return success or vanish; iOS prompt-based listener readiness can block the main thread. |
| Wrong-interface/IPv6 hazards remain | Both native origin selectors can fall back to non-Wi-Fi interfaces. Android selects IPv4; iOS can resolve/connect using IPv6 then reject without trying an eligible IPv4 endpoint. |

Permission denial, network isolation, VPN routing and suspension are still plausible **additional** factors in the owner's specific attempt, not established causes. Do not equate every empty scan with denied permission.

### C5.2 Navigation and form state

Use this single hierarchy (the owner's requested one-button entry):

```text
Private rooms
  Pass & play                 → local player-count/name form (C4)
  Same Wi-Fi                  → Host a room | Join a room
    Host a room               → name, format/clock, Start hosting/create
                               → verified address, room code, Copy invite
    Join a room               → name + room code, discovered rooms
                               + optional Host address fallback
  Online private room         → existing online create/join
  Challenge a friend          → existing 1v1 route
```

1. Replace separate hub Host/Join-nearby cards with **Same Wi-Fi**, subtitle **“Host or join a private room on this Wi-Fi. No internet needed.”** The intermediate page has two clear choices, not another duplicate mode list.
2. Keep name/code fields visible during scanning, empty results and permission errors. Preserve draft input through scan/retry/back; only replace the results/status mount. A discovered-room card supplies endpoint/code to the **same** join function as manual code entry.
3. Use a generation/operation ID for scanning/start/join so Back, Stop, network change or teardown invalidate late responses. Disable repeated submissions during an operation. Clear old polling and endpoint/session context when changing transport, preserving resumable records separately.
4. Plain review browsers have `MegaLanHost` because the factory is bundled, but lack actual `MegaLanSocket`/discovery transport. Check real capability, not object presence. Show **“Same-Wi-Fi hosting and scanning are available in the app.”** with Back; don't display perpetual “Starting…” or offer a code form that has no way to find a host.

### C5.3 Versioned asynchronous bridge/readiness contract

Evolve the contract jointly across `lan-host.js`, Kotlin and Swift:

```text
MegaLanSocket.start(port)              -> Promise<listener result>
MegaLanSocket.status()                 -> Promise<listener snapshot>
MegaLanSocket.stop()                   -> Promise<result>
MegaLanDiscovery.advertise(name,port)  -> Promise<registration result>
MegaLanDiscovery.browse(timeoutMs)     -> Promise<discovery result>
MegaLanHost.open/resume/close          -> Promise<result>
MegaLanHost.ready()                    -> cached state snapshot for rendering
MegaLanRoom.handle(requestJson)        -> synchronous JSON response (retain)
```

1. Define the actual result shape in one shared contract/fixture before editing hosts. Distinguish listener status from advertisement status, selected endpoint and explicit failure codes. Match both shells; don't silently change only one promise-returning API.
2. Move network operations off synchronous `prompt()` into the existing asynchronous Android `receive()` and iOS `userContentController(...)` channels. Keep trusted-frame validation, payload bounds and request IDs. The synchronous in-page room handler remains the shared rules/HTTP responder; do not reimplement tournament rules in native code.
3. `open()` awaits listener ready, learns the **actual** bound port/Wi-Fi endpoint, verifies local `/api/party/capabilities`, then awaits registration. Only then show ready/create/join data. If listener works but advertising fails, show **“Hosting — nearby discovery is unavailable. Share the room code and host address.”** Direct joining can still work.
4. Host states: `IDLE → STARTING → READY`, with separate advertisement status; `NO_WIFI`, `PERMISSION_NEEDED` only when identified, `FAILED`, `STOPPING`. Use a bounded start timeout and Retry; no endless spinner or fake success when a port is merely requested.
5. Await cold-start `resume()` with explicit failure handling. Retain paused recovery for interrupted rooms. Track and clear the `lan-host.js` tick interval on close; repeated boots must not accumulate handlers/timers. Stop cancels pending start/advertise callbacks.

### C5.4 Discovery data and real room-code lookup

1. Make the portable store's discovery DTO include actual `status:'LOBBY'` for its joinable entries; use the real `store.discover()` output in fixtures. Validate consumer DTOs and show malformed-protocol errors separately. Do not simply remove the UI's lobby filter and expose closed/running private state.
2. Add a LAN join resolver in `lan-room-store.js` that accepts an exact room ID or the emitted normalized five-character code. Uppercase **codes only**, preserve case-sensitive IDs, retain uniqueness per host and all membership/capacity/readiness/expiry/idempotency guards. Return/store the canonical room ID after lookup. Do not change the separate online code format/lookup policy.
3. `lan-room-http.js` returns accurate lookup/closed/expired/protocol errors rather than generic service failure. Prejoin discovery exposes only minimal join metadata—host/room display, code/ID, count/capacity, joinability—not guest tokens, full private rosters or match histories.
4. A short code is unique within a host's store, **not globally across every phone**. Resolve code→endpoint offline with: browse `_megaxo-v5._tcp` → resolve Wi-Fi candidates → unauthenticated bounded `/api/party/discover` reads → match code → retain `{hostId,endpoint,roomId}`. If multiple hosts match, show both host names for the player to choose; never silently join the first collision.
5. If discovery cannot resolve it, reveal **Host address** (literal address, optional port) with a clear explanation. With no supplied port, try only existing candidate listener ports 8081–8083 on that **one supplied address**. Do not scan subnets, infer an IP from the code, query a cloud code registry or silently switch to online play. Multicast-blocked Wi-Fi needs this explicit address fallback; a short code alone cannot guarantee offline discovery.

Proposed bounds: five-second scan default/eight-second maximum; at most 32 distinct discovered services and a bounded pending queue; at most two concurrent endpoint requests; at most four previously verified current-network endpoints cached; one manually supplied address × at most three ports. Preserve stricter existing request/header/response/connection limits; don't widen them merely for the new UI. Cancel stale work on Back/network change.

### C5.5 Correct network and endpoint authorization

1. Android chooses addresses/routes from `ConnectivityManager`'s actual Wi-Fi `LinkProperties`, and binds outbound connections to the chosen network where available. Do not require internet validation for an offline LAN. Listener/discovery network scoping must use API-level guards.
2. iOS constrains the appropriate Network.framework path to Wi-Fi and matches interface enumeration to it. Retry eligible IPv4 candidates rather than discarding a Bonjour service after one IPv6 resolution. For this batch make IPv4 support explicit unless both bridges and Host-header parsers also gain tested scoped IPv6 support; give IPv6-only users an accurate unsupported-address state.
3. Display/share only verified Wi-Fi address plus actual port. Never substitute asset/file origin, loopback, cellular, USB, VPN/Tailscale or an arbitrary first network interface. Keep loopback only for internal self-host operations, never a cross-device invite.
4. Tighten both native `partyFetch()` implementations around a native-issued endpoint handle from discovery/validated manual selection. Restrict access to the selected network's eligible local endpoints and required named `/api/party/*` methods. Validate URL components and reject credentials, arbitrary public hosts, metadata endpoints, unrelated paths, redirects and malformed literals. Do not broaden general native fetch/API authority.
5. Retain trusted-main-frame checks, body/header/response limits, native-generated Host header and cookie-free LAN requests. Existing intentional bearer-only LAN CORS does not justify broadening production API CORS or weakening ATS/WebView cleartext policies globally.

### C5.6 Portable invitations

Replace all copied/displayed document-origin logic with an explicit connection context (`transport`, `publicOrigin`, `hostEndpoint`, `roomId`, `code`, `hostId`). For LAN copy useful **text**, which works on both native platforms without pretending it is a browser-openable page:

```text
Mega XOXO · Same Wi-Fi
Room KM27Y
Host 192.168.1.23:8081
Open Private rooms → Same Wi-Fi → Join.
```

The address above is illustrative; the app supplies the verified host's current endpoint. Include no guest/account credentials. Add **Paste invite** parsing for this bounded format or let users paste the code/address into their fields; never automatically connect to an arbitrary pasted URL without validation and a deliberate Join action.

Android currently serves bundled assets from its LAN listener, but iOS returns 404 for non-party paths. Therefore replacing `appassets...` with `http://<host>/#party=...` is **not** a valid cross-platform fix. A browser-clickable LAN URL needs separately implemented allowlisted iOS static serving and tested secure-context capability handling before being advertised. For the current annotation, accurate portable code/address instructions plus in-app Join are the required baseline.

Online invites use the canonical public game origin and the actual supported online room route; `#party=` legacy handling must distinguish online from LAN, not derive transport from a local asset page. Preserve validated legacy links if supported, but never send public cookies/native account tokens to a private host.

### C5.7 Host-scoped reconnect, errors and permission UX

1. Replace unscoped LAN persistence with a versioned record containing `{transport,hostId,roomId,code,lastEndpoint,actor,credentialRef,expiry,lastRevision}`. Keep the guest bearer in appropriate native secure storage; the record/invite/discovery data contains only a reference, not a printed credential. Preserve ordinary local event saves separately.
2. The LAN guest credential belongs to one host. Send it only after the endpoint/host is validated, using `credentials:'omit'`; discovery probes are credential-free. No bearer in query strings, mDNS, copy/share, logs or URL. Never reuse account/provider credentials for guest play.
3. Reconnect restores the endpoint and original guest session, verifies host/protocol continuity, fetches the canonical room and rediscoveries the same host if its Wi-Fi address changed. Add a persistent random host ID/protocol version to capabilities. A host ID is continuity metadata, not cryptographic proof; do not present it as secure pairing.
4. Expired/lost credentials produce a real expired-session/rejoin explanation; don't create a new guest and pretend it owns the previous seat. Starting a new host clears stale `lanBase`/foreign session before self-host create, but retains the entered display name for the create form.
5. One in-flight poll, bounded backoff, cancellation on leave/back. Uncertain mutation retries retain their original idempotency key. Preserve authoritative deadlines/revisions and paused recovery; no duplicate moves/readies or resetting clocks on reconnect.
6. Show separate states for scan empty, discovery unavailable, no Wi-Fi, code not found, ambiguous code, connecting, room closed, reconnecting and session expired. Known native policy-denial signals can offer Settings instructions; an ordinary timeout offers Retry/address fallback. Preserve `NSLocalNetworkUsageDescription`/Bonjour declarations and handle the actual OS/target's Android permission requirements without adding speculative location access. Primary references: [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), [Android local-network permission guidance](https://developer.android.com/privacy-and-security/local-network-permission).
7. Explain **“Keep the host app open.”** A socket alone does not prove the WebView rules engine can answer while suspended. Test background/lock/resume and use honest recovery. Transferring the lobby owner does not magically transfer the physical server to another phone.
8. Existing LAN HTTP is guest-only private play, not encrypted authenticated host pairing. Keep all account/economic data out of it and do not market endpoint filtering as encryption. If the release threat model requires hostile/shared-network authentication, Main must separately implement and verify pinned native TLS/offline pairing; don't claim that extra guarantee from short codes/mDNS or silently invent a cloud relay to obtain it.

### C5.8 Failing regressions and physical acceptance

- Extend `tests/v51-lan-room-store.test.cjs` using actual portable store/handler output: discovery includes status, join by **emitted short code**, exact-ID compatibility, expiry/closed/capacity, idempotent join, paused recovery. Do not use the fixture that previously injected the missing status.
- Add focused `tests/v52-lan-client.test.cjs` for invite parsing/transport selection, async listener/advertise errors, stale scan/start cancellation, code collision, endpoint-scoped credentials, manual fallback bounds, persisted endpoint restoration/network change, and one timer after repeated open/close.
- Extend `tests/party-browser.py` with the actual portable store at **distinct endpoints**. Its existing `tests/party-browser-server.js` uses a separate Node/SQLite host; that fixture alone cannot prove parity with native-portable hosting. Include the portable `.cjs` suite explicitly: the default `npm test` glob may not include it.
- Native test coverage: listener readiness/failure and nonblocking UI, address/interface policy, candidate retry, framing/bounds, discovery failure/permission paths, cancellation, endpoint authorization and unknown-host credential refusal. Update native/bundle contract checks for the deliberately changed asynchronous interfaces.
- Physical acceptance: **Android hosts → iOS joins** and **iOS hosts → Android joins**, WAN unavailable with Wi-Fi active; discovery and code entry; manual host-address fallback with multicast unavailable; real lobby/ready/fixture/moves on both phones; third-party endpoint/token refusal; same code on two hosts; process restart/reconnect; denied/regranted permission; port conflict; VPN present; host lock/background/resume. Log sanitized statuses/builds, not player tokens or raw device traces.

Done means real cross-device play and reconnect on exact new builds, not successful Android self-discovery or a URL string unit test. Keep these device results distinct from the local/browser checks and record any still-unexecuted matrix row explicitly.

## 21. C6 — private/tournament action contrast (APP-020)

Files: `src/party-ui.js` action markup, `src/party.css`, narrowly scoped theme action rules in `src/styles.css`, native visual evidence.

The owner cannot identify the exact historical button/state. The final screenshot shows After Hours' deliberate yellow primary action, but it does **not** prove that screenshot reproduces the reported unreadable button. Treat the general CTA collision as an audit requirement, not a confirmed unique selector or a reason to delete After Hours yellow everywhere.

1. Inventory every private/tournament CTA: create/join/host/scan, room readiness, host start/pause/resume/stop, roster controls, public table join, match ready/play/watch and dialogs. Inspect normal, pressed, focus, disabled, loading and error variants in all four themes.
2. Pair each filled background with its foreground: `--cta`/`--on-cta` or `--accent`/`--on-accent`; quiet buttons use `--raised`/`--ink`. Remove inherited light text on yellow and stale hardcoded neon colors only where found. Audit SVG `currentColor`, labels inside nested spans, opacity and native/theme overrides too.
3. For essential CTA text target >=4.5:1 contrast; focus/boundary >=3:1 where required. Don't fade the entire card/button to create a disabled state that hides its explanation. A disabled action can be neutral with an adjacent readable reason.
4. Keep theme-specific shape/type character. After Hours may retain yellow with dark text; Paper Club retains ink/paper; Midnight and Vector use their own paired tokens. Do not apply the website's purple/blue gradient to native buttons.
5. Use local fixtures/eligible disposable service accounts to reach protected screens. Do not remove public rank/placement restrictions to inspect them. Capture actual combinations, record corrected selectors and compare with the owner's original report when accessible.

Acceptance: readable actions and explanations in all listed views/states; no text-color merge in host/join or public tables. This audit cannot be declared device-verified from the static selected-mode screenshot alone.

## 22. C7 — voluntary Sponsors destination and direct enquiries (APP-021)

### Product decision and provider constraints

The owner's desired experience is a permanent, optional way to support the game. Implement a **Sponsors** destination accessible to guests and members, including Mega Pass/Remove Ads users, with a clear Back to Play action. Subscription suppression of automatic ads elsewhere does not hide a sponsor directory the user deliberately opens. Keep the promise elsewhere accurate: **automatic ads off**; optional sponsor discovery remains available.

“24/7” means the destination is always available; it does not mean requests/impressions continue in the background. Do not promise to defeat user ad blockers. First-party approved sponsor cards may remain ordinary content when a network SDK is blocked; show an honest empty/network-blocked state for ads that cannot load. Visiting this page is not blanket permission for cross-app tracking or personalized ads.

Verified 2026-10-17: [Google's inventory policy](https://support.google.com/publisherpolicies/answer/11169917?hl=en) prohibits Google-served ads where ads/paid promotion exceed publisher content, and [its no-content policy](https://support.google.com/publisherpolicies/answer/11112688?hl=en) excludes empty/low-value pages. Therefore an ad-only wall cannot simply be activated with the existing Google integration. **Chosen implementation:** a curated direct-sponsor discovery page; add Google/network units only on a substantive content layout that the provider permits. Sponsor sales copy itself is paid promotional content, not a loophole for satisfying publisher-content requirements. No fake filler, rewarded-view loop or incentives for clicking sponsors.

[UMP's iOS guide](https://developers.google.com/admob/ios/privacy) requires checking `canRequestAds` before requests. [Ad Manager refresh guidance](https://support.google.com/admanager/answer/6286179?hl=en) requires accurate refresh declarations. Use actual provider rules and existing privacy choices; no fabricated consent or blind interval refresh. These are execution design constraints, not a request to pause the other annotations.

### C7.1 App and web surfaces

Files: new `src/sponsors-ui.js` + `src/sponsors.css`; `src/app.js` render mapping/navigation; root `index.html`; `native/client/bundle.config.json`; `apps/web/pages.js:sponsorsPage()`, `apps/web/app.js` sponsor handlers, `apps/web/pages.css`; `scripts/p21/build-web.js` positive allowlists.

1. Add `sponsors` to `MegaApp`'s page-render mapping and Home card. Render the page in `#page` with Back to Play, brief purpose, optional interests disclosure, sponsor cards and **Advertise with us**. No new primary bottom-nav slot. Page loading must not require a linked account or billing availability.
2. Add classic script/style to root index and native bundle config. Also update `scripts/p21/build-web.js:GAME_FILES`, which separately packages the retained app scripts; update `WEB_FILES` for new website-side modules. An omitted file here otherwise creates a working dev page and broken built artifact.
3. Native page layout: title/short support copy; compact “Interests” disclosure; one featured sponsor/card followed by a vertical feed; report action outside each creative; direct-enquiry panel near the end. Cards are labeled **Sponsored**/**Advertisement**, with advertiser name, meaningful description, accessible image/link, and clear destination. No autoplay sound or full-screen interruption.
4. Web `/sponsors` and `/ads` reuse the same data/report semantics and existing compact disclosure. Keep the earlier seven-placement layout as **capacity**, not a requirement to fill every slot with network ads. Empty slots are not fake advertisers or proof of monetization. Include direct enquiries on the website as explicitly requested.
5. Use a shared versioned **public catalog**, e.g. `assets/sponsors/catalog.json`, with public fields `{campaignId,creativeId,revision,advertiser,title,description,image,landingUrl,topics,startsAt,endsAt,kind}` and no secrets. Package the same reviewed snapshot into native/web assets using explicit allowlists. Start with an honest empty list if there are no real approved sponsors. Don't invent advertisers, paid deals, rates or audience statistics.
6. Validate schema, schedule, allowed image paths and HTTPS landing URLs; render text escaped. Reject arbitrary HTML/script creatives, `javascript:` URLs and unapproved trackers. Any later live catalog feed is read-only, HTTPS, bounded and separately configured; it does not change wallet/identity authority. Use deterministic date fixtures in tests.
7. Interests are optional local contextual filters (the existing web key is `mega-xoxo-sponsor-interests`), saved only after agreeing to save them; provide clear/undo. No automatic demographic targeting from account identity, skill, purchases or contacts. Network personalization uses the platform's actual CMP/UMP/ATT state where applicable; interests alone do not authorize it. Show contextual/direct options when network personalization is unavailable.
8. Load network inventory only when its placement is visible, the page foreground and provider consent permits. Stop observers/requests when navigating away. Do not rapidly rotate to manufacture views. Preserve provider disclosures/AdChoices and SDK-owned presentation; do not modify a third-party creative iframe to inject report controls.

### C7.2 Real report flow and immediate hiding

**Existing capability limit:** the current native `MegaAds.reportAd()` routes to Ad Inspector; iOS source explicitly describes it as unavailable in normal consumer installs. That developer tool is not a usable sponsor-report system. Build this report flow independently instead of renaming the existing button.

1. Each first-party sponsor card has **Report ad**. Open a small accessible dialog with categories **Misleading**, **Inappropriate**, **Broken link**, **Other**, optional bounded note and **Report and hide** / Cancel. Don't auto-open or click the advertised destination.
2. On confirmation, immediately mark the creative hidden locally. A blur is a visual affordance, not sufficient hiding: remove/cover actionable links, keyboard focus and accessible creative text; leave a readable overlay **“Ad hidden. Thanks for the feedback.”** The report overlay and Retry remain usable. No invisible clickable ad beneath it.
3. Key local suppression by stable creative identity (`campaignId + creativeId + revision`), not slot index or a newly generated impression ID. Keep it hidden across page changes/reloads; another impression of the same creative does not clear the suppression. Clear only when a genuinely different creative replaces it, or the user deliberately restores it. Bound local storage size and preserve it through refresh races. Keep an accessible report receipt/status separate from creative visibility.
4. A durable report must actually be delivered. Proposed endpoint: `POST /api/sponsors/report` accepting `{reportId,creativeId,campaignId,revision,reason,note}`; `reportId` is generated once and reused on retry. Resolve signed-in identity server-side where present; support guest reporting with bounded request/rate limits. Never accept a caller-supplied actor, arbitrary report destination, impression count or billing data.
5. Implement through a small `apps/api/routes/sponsors.js` handler and report service integrated into `apps/api/index.js`/the actual production composition. Reuse `parseJsonBody`, origin/CSRF/session rules, body bounds and the existing rate-limit infrastructure. Before changing handlers run the repository's route impact checks if available. Main owns any shared route/schema/role integration; verify the actual current composition rather than assuming a filename.
6. Reports are operational moderation records, not economic writes. Prefer a dedicated narrowly permissioned durable report table/service, with a unique report ID, bounded fields and limited retention. Allocate the next migration ID from the current manifest rather than hardcoding an old number. API permissions must cover only the report operation, never wallet/Core tables. Do not expose an unauthenticated report-reading/admin endpoint or log raw player records, tokens, emails or full device traces. Use existing session/privacy deletion handling for any linked reporter.
7. A successful response acknowledges a stored/queued ticket (`{accepted:true,reportId}`), not a promise the provider has removed the creative. On failure show **“Ad hidden on this device. Report couldn't be sent. Retry.”** Keep the same report ID and the creative hidden. In a static preview show a distinct unavailable report service state; never claim “report sent” just because CSS changed.
8. For network creatives where the provider exposes no stable creative ID, use provider-supported reporting/hide controls; don't claim permanent creative suppression or reset it on every reload. A bounded slot hide can be offered with accurate wording, and report metadata may use only the provider-supported identifiers. Do not replace AdChoices or tamper with protected SDK views.

### C7.3 Direct sponsorship enquiry by email (app + website)

Destination: `contact@antimatterinnovations.com` (the parent-company email remains allowed). Label **Advertise with us**; helper **“Reach Mega XOXO players with a clearly labeled sponsorship.”** This is an enquiry, not a purchase or guaranteed placement.

Use a normal mailto composer with separately percent-encoded subject/body, not an automatic send:

```text
To: contact@antimatterinnovations.com
Subject: Mega XOXO sponsorship enquiry

Hello Mega XOXO team,

I'd like to discuss a direct sponsorship for Mega XOXO.

Brand or project:
Website:
Product or service:
Preferred dates:
Target audience or regions (optional):
Budget range (optional):
Contact name:

Please share available placements and the next steps.
```

Include no automatic account tag, email, device ID, interests or private activity. The person reviews/edits and sends the message themselves. Expose the email as selectable text and a **Copy email** fallback if no mail app is installed. Do not claim successful delivery when only the composer opened.

Extend B2's public-link helper with this **fixed** mailto action if useful. Native navigation currently permits deliberate external HTTPS links, not mailto; add a narrowly scoped `mailto:` user-gesture handler for this address (with bounded subject/body) in the actual Android/iOS external-navigation delegate. Do not broadly allow custom schemes or arbitrary popup navigation. Confirm a tap opens the system email composer and returning preserves app state. Web uses a normal anchor with the same template.

Acceptance: Home Sponsors route and Back work for guest/Pass/no-ads users; real catalog or honest empty state; saved/cleared interests; report Cancel, success, retry, duplicate, reload, same-creative rerender and genuine replacement; hidden creative is not keyboard/screen-reader actionable; reported IDs stay stable. Network ads stop offscreen/background and respect real privacy/provider states. App and website email actions open the correct editable draft; no mail client has a usable copy fallback. Native/web screenshots, durable report evidence and real ad/provider acceptance are recorded separately.

## 23. C8 — After Hours default for new native installs (APP-022)

Files: `src/app.js` initial save/theme selection, root/generated index boot theme, `scripts/v5/build-client.js`, native launch/splash/theme resources as needed; `src/domain.js:fresh()` only if an explicit optional presentation default is added.

1. Apply this owner decision to **new native installations**, identified by the existing native bundle declaration and absence of a valid saved/legacy explicit theme. Set the new save's theme to `afterhours` before `applyTheme()`/initial render. Keep storage version/economic migration unchanged.
2. Preserve valid saved `vector`, `midnight`, `paperclub` and `afterhours` choices, including legacy dark/paper/neon/light mappings and cloud practice restore. An app update must not overwrite a user's chosen look. Do not clear saves or rebuild profiles to get the desired default.
3. Don't globally replace every `theme:'vector'` literal in `D.fresh()`: that shared function is used by browser/server/test saves too. Preferred small change: choose a `defaultTheme` at the **native presentation bootstrap**, then apply it only to freshly initialized settings with no explicit migrated preference. If introducing a `fresh(...,{defaultTheme})` option, keep its historical default/backward compatibility and validate theme IDs.
4. Avoid a Vector flash: set native generated HTML's initial `data-theme`/theme-color to After Hours (or a valid stored theme in an early, allowlisted preference bootstrap) before first paint. Initial Android/iOS WebView/splash backgrounds should match the new theme without changing unrelated launch behavior. Respect CSP and the deterministic bundler's positive allowlist; do not insert an untracked inline script ad hoc.
5. Keep existing theme selection options functional and continue using the same four native themes. The separate P21 website keeps its approved browser Mega XOXO Neon default. The 4197 review bundle can show the native default only in a genuinely fresh isolated storage context; don't erase the owner's annotation storage to demonstrate it.

Acceptance: fresh Android and iOS boots in After Hours without light flash; existing users retain each chosen theme through update; imported/cloud/legacy preferences migrate correctly; reload/reinstall behavior is described accurately; website default unchanged. Verify B0 readability and C6 action contrast especially carefully because After Hours becomes the first impression.

## 24. Final executor order, evidence and handoff

**22 annotation IDs, two batches, collection complete.** All work remains PLANNED until implementation evidence exists. There is no request for another annotation round or repeated scope approval before starting the authorized executor run.

1. Inspect the latest integration SHA/ownership and carried changes. Reconcile items already fixed by Main; retain this document and add precise superseding implementation evidence rather than copying stale files from `81e1216`.
2. **A0** account script parsing and actual Sign in entry; **B1** remove all redundant Store injections including Quests.
3. **C1/C3** balanced Home markup, separated utilities and stable mode selection. Add the Sponsors entry when its route exists, not as a temporarily dead button.
4. **B0/B2/B4/C2** typography, canonical public links, Settings/motion placement, rank/weekly help. Serialize shared `app.js/styles.css` edits; one owner integrates them.
5. **B3**, then **B5/B6** audio, balance card, Pass emblem/layout/state. Keep native commerce readiness accurately separated from UI verification.
6. **C4/C5** local player forms and the complete native Wi-Fi flow/transport/reconnect. Freeze the bridge contract before Android/iOS changes; do not let two agents independently invent response shapes.
7. **C7** native/website Sponsors, moderation/hiding and enquiry composer, with Main integrating any shared schema/API/host changes. Review current provider inventory before enabling network inventory.
8. **C8/C6** fresh-install After Hours and the final four-theme action/typography audit. Recheck every new sponsor/party control under the default theme too.
9. Run targeted checks from section 13 plus current `tests/tournament.test.js`, `tests/v51-lan-room-store.test.cjs`, `tests/party-http.test.js`, `tests/v52-tournament-http.test.js` and the existing `tests/party-browser.py` fixture where supported. Add behavior coverage for draft names, transport-aware invites, code lookup, report suppression/idempotency and native-only fresh-theme selection. Confirm paths/runtime and real PG prerequisites at the execution SHA; no silent skips.
10. Build native and web artifacts with all new script/style/catalog paths allowlisted; use fresh output directories and report exact hashes. After local/browser checks, Main builds/installs current signed Android/iOS artifacts. First verify iOS launch, then run physical host/join **in both directions**, airplane mode + Wi-Fi for the offline LAN case, all name/board mapping, background/reconnect, audio, document/email return, default/saved themes and report flow. Keep private-room economy unchanged.
11. Record a receipt for APP-001–APP-022: implementation commit, test command/environment/result, bundle hash, exact device/build, screenshots, skips and remaining provider/production evidence. Preserve all existing evidence. **LR02 final CI stays last**, and green CI is not a production deployment or native/provider acceptance.

Suggested additional cohesive commits: `fix(home): separate utilities and stabilize mode changes`; `feat(private): individual player setup and same-Wi-Fi joining`; `fix(rank): clarify rating and weekly reward guidance`; `feat(sponsors): optional discovery reporting and direct enquiries`; `feat(native): default new installs to After Hours`. No force-push or branch deletion for tidiness.

### Copy-ready executor prompt

> Implement all 22 app UI annotations in `docs/v5.2/release/APP-UI-ANNOTATION-EXECUTION-PLAN-20261017.md`. Annotation collection is complete. Read the whole plan, including Batch 2 and its superseding decisions, before editing. Inspect the latest integration ownership/SHA and preserve Main's work; use the approved integration workspace and small verified commits. Begin with the confirmed account-module parse failure, then follow section 24's order. Use Sol's exact Pass specification already included. Complete the shared UI, native LAN, Sponsors/reporting/email and fresh-install theme changes with the described behavior checks; don't implement only the visual portions. Keep one bridge/schema owner, preserve game/economy/identity/billing authority, and record real browser/device/provider results separately. Build current artifacts and verify Android↔iOS LAN hosting/joining in both directions; fix any launch failure before device UI tests. Keep LR02 CI verification last. Update a per-annotation implementation receipt, and do not claim production/store approval or deploy/merge main without the applicable existing release authority. Do not ask the owner to annotate these same items again before beginning.

