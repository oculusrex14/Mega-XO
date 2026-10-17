# V5.2 UI audit — website, Android and iOS

Source: `7f582b749a1128b86e53ddcbcda57b569b0953cf` (PR #30 input head), 2026-10-17. Scope: static source/route/interaction analysis and existing GitHub Actions evidence. No local product tests, live account writes, device sessions, screenshots, app builds or browser automation were performed by this specialist. This is a workstream report; final release certification belongs to the integrator.

## Inventory coverage

| Inventory | Rows | Meaning |
| --- | ---: | --- |
| Website pages | 37 | Expanded `WEBSITE_ROUTES`, including legal aliases and `/404` |
| Mobile screens | 87 | 37 shared WebView screen/state families × 2 platforms, plus 7 Android and 6 iOS SDK/system surface families |
| Web interactions | 568 | 298 website/public-document declarations and helper call sites + 270 retained `/legacy-game/` interaction records |
| Android interactions | 277 | 270 shared signed-WebView records + 7 platform integration interactions |
| iOS interactions | 276 | 270 shared signed-WebView records + 6 platform integration interactions |

These are **source interaction records**, not 568 unique visible buttons or an exhaustive runtime DOM count. The extractor includes buttons, links, forms, fields, disclosures and board-cell families; loops/dynamic selectors are not expanded into fabricated users, rooms or 81 repeated cell rows. Helper definitions and helper call sites can both appear. Rows preserve real file/line/selector/value/handler evidence and default to unverified. Runtime labels in conditional templates require browser expansion.

Mobile screens identify shared web UI versus native system/SDK UI explicitly. An SDK purchase/permission surface is a source integration family, not evidence that its dialog was presented or accepted. Android and iOS each ship the shared `src/*` app, whereas the website `/game` uses `apps/web/board.js`. The review server in `scripts/v5/serve-client-review.cjs` serves the app bundle; it is not interchangeable with `scripts/p21/build-web.js`.

## Page and navigation audit

All 37 build-listed paths have a renderer/shell or trusted public-document route. There is no confirmed wholly unrendered build-listed page. `/ads` aliases sponsor content, `/help` uses support rendering, `/rewards` and `/store` are related but distinct pages, and five `/legal/*` paths mirror maintained public documents.

Legal precedence matters: the build supplies sanitized `<main>` content from `public/{privacy,terms,support,delete-account,privacy-choices}.html`. `renderPage()` returns those documents before corresponding fallback functions in `pages.js`. A fallback CTA is not proof of what the built legal route displays. Those retained public document links are included in the web interaction CSV.

**Confirmed P1 unreachable action: SAGAN-003.** The signed-in `/account` card's **Linked accounts & recovery** helper at `apps/web/pages.js:314` targets `/game`. The website shell opens the local Bot workspace there. `apps/web/index.html` does not load `src/community.js`, and no security-control opening action is passed to the board. Consequently the CTA cannot reach its named destination. The website must expose real linked identities, reauthentication, session management, export and deletion controls or navigate to an explicitly opened retained control surface.

Do not classify documented placeholders as working features: the service-information page does not probe live uptime; empty sponsor slots explicitly say no active sponsor; future-theme cards are not purchasable themes; website avatar selection is explicitly unavailable.

## Themes — separate website and app checks

| ID | User-facing name | Website | Android/iOS app |
| --- | --- | --- | --- |
| `cinematic` | Mega XOXO Neon | Default in `apps/web/board.js:17-21`; CSS default/presentation exists | Not in native retained palette; paid native Neon is not activated |
| `vector` | Vector Light | Retained selectable palette | Retained selectable palette; saved choice overwritten on restart under SAGAN-001 |
| `midnight` | Midnight Club | Retained selectable palette | Retained selectable palette |
| `paperclub` | Paper Club | Retained selectable palette | Retained selectable palette |
| `afterhours` | After Hours | Retained selectable palette | Intended fresh-install default |

Exactly five browser entries and four retained native entries are present. The phrase “four themes” must not cause cinematic to be omitted from the web inventory or silently added as paid native content.

**SAGAN-001, P1:** `src/app.js:38` applies After Hours whenever the loaded theme is Vector, no old `mega_v3_settings` exists and transport is native. It does not check whether the current `mega_v32_state` already existed. Thus a valid Vector preference saved by the player is overwritten on next native launch. Fix first-run detection rather than suppressing Vector, and check cloud-save adoption as a separate path.

Native system-bar bridges use the active theme's darkness/surface and validate the four native IDs. These are implemented source behaviors. Physical status/navigation-bar contrast, gesture-area rendering, rotations and large-font acceptance remain NOT_RUN.

## Power controls and state honesty

Required visible control names are **Undo**, **Undo Block**, **Tactical Hint**, **Hint Block**. Both app cards (`src/app.js:259-263`) and the website's main card rows (`apps/web/powers.js:152`) use those four names.

- App Undo/Tactical Hint have Bot-only eligibility, revision fencing, earned charge/Crown paths and explicit failure copy.
- App Undo Block/Hint Block are disabled and labeled unavailable. `src/powers-ui.js:29` ships only `undo` and `hint`. These are truthful disabled controls, not falsely reported dead enabled buttons.
- Browser power writes remain fail-closed: `apps/web/board.js:353` supplies no verified binding to a controller whose default gate is false (`apps/web/powers.js:58`). Therefore native Bot power functionality cannot be claimed as website parity. Record PARTIALLY_IMPLEMENTED and retain the closed state until the real service integration exists (SAGAN-010).
- Website bank details still render `Undo / Undo Request`, `Tactical Power`, `Undo Block`, `Tactical Block` from `apps/web/powers.js:5`. This copy drift is SAGAN-005, P2. Normalize displayed names while retaining protocol IDs internally.
- The app primary wallet can show the linked account balance, while power purchases spend the device wallet. The Store discloses that spending source, but balance/error feedback can still conflict (SAGAN-009, P2). This is handed to the economy owner; no authority changes were made.

## Account screens and platform capabilities

The shared app includes collision choice, proof and new-profile confirmation screens. Their existence is not proof that production can reach them. `tests/v52-account-link.test.js` instantiates SQLite `CommunityStore`; the production server composes PostgreSQL `packages/services/accounts.js`. That service and the production account dispatcher lack the decision endpoints/state machine. This is **SAGAN-002, P1**, not a passed PostgreSQL journey.

**SAGAN-004, P1:** confirmation at `src/community.js:67` promises “Cancel deletion.” No cancellation button/action, HTTP route or store transition exists in the pinned source. The scheduler can delete due records; postponing a busy actor is not user cancellation. Complete authenticated cancellation before displaying that promise.

**SAGAN-012, P1:** `src/account-client.js:65-67` derives native capabilities from linked identity names after fetching a profile, discarding host-supported providers. `src/community.js:202-214` then uses that map for Link/Verify controls. Android compiles only Google (`MegaXOActivity.kt:172`) and explicitly rejects unsupported sign-in providers (`MegaNativeApiBridge.kt:136`). A cross-platform account linked to Apple and Google can therefore get an enabled Apple Verify action on Android which the host rejects; a supported but not-yet-linked provider can instead remain unavailable. Preserve compiled capabilities independently from linked identities.

**SAGAN-013, P2:** Android has no native Apple adapter in this snapshot; its guest capability list correctly exposes only Google. This is a missing parity feature rather than a broken enabled guest Apple button. iOS contains Apple and a separately configured Google web-auth lane. Provider configuration and actual device authentication remain unverified here.

## Existing CI evidence and its limits

| Evidence | Observed result | Scope / limitation |
| --- | --- | --- |
| [P21 static website job](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320655996) | SUCCESS | Static tests/build; not live/device acceptance |
| [P21 Chromium transport](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320707063), [Firefox](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320707055), [WebKit](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320707058) | SUCCESS | Synthetic HTTP plus loopback WS/WSS; not real provider/account/economy traffic |
| [Browser presentation](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747099/job/117320707075) | FAIL, 2 of 935 checks | `/sponsors` and `/ads`, 320px viewport, document width 327px. Automatic accessibility step was skipped after this failure. |
| [Android emulator first launch](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747061/job/117320920404) | FAIL on observed attempt | App UI initialized; `NATIVE_GAMEPLAY_SMOKE: phase=move-confirm; CDP_COMMAND_TIMEOUT`. Does not prove a game-rule defect or physical phone failure. |
| [Native generated-byte verification](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747061/job/117321513343) | SUCCESS | Bundle byte consistency only |
| [iOS simulator job](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747061/job/117320656115) | SUCCESS | Simulator evidence, not real iPhone/provider/store acceptance |

`gh run view 39006747099 --json headSha` identifies PR input head `7f582b7`. The browser artifact identifies executed synthetic merge source **`b645f404cdd512a87e00ef0f31318b6bc8de6894`**, bundle SHA-256 **`bddc85e27c76b0356d89779ea333d5a1db7d2953ba36c34f0437783eb2e50e07`**, Chromium **151.0.7922.34**, Node **24.21.0**, and synthetic unauthenticated loopback contexts. These identities are deliberately not collapsed.

The browser report was read directly from GitHub artifact **12091253392**, entry `bddc85e27c76/browser-qa.json`, in memory without writing an archive. Both failing records are `P21-BROWSER-REFLOW`, with an overflowing `strong` element. There were no missing local resources or JavaScript errors reported in that artifact. This does not erase the reflow failure or certify other interactions.

The integrator's later `bdc4af4` adds sponsor email wrapping. Record SAGAN-006 as baseline failure / source-fixed pending CI. Android reruns initiated by another lane must be evaluated at their own job/attempt and exact source; this specialist did not rerun a workflow or hide the observed timeout.

## Remaining manual acceptance

NOT_RUN by this workstream: fresh-install and remembered-theme tests on physical Android/iPhone; genuine OAuth/link/reauth/recovery; live purchase/refund/restoration; rewarded ad earned/no-fill/skip; LAN pairs; local network/notification permission denial; TalkBack/VoiceOver; 200% zoom/large text; orientation, safe areas, reduced motion, background/resume/process death; and unaided novice tutorial comprehension. Existing screenshots and unit tests do not close these cases.

Dead enabled controls and unreachable named destinations are P1 in `evidence/sagan-findings.csv`. Intentional disabled states and explicit unavailable integrations are separately classified. Findings remain open at the pinned source unless a later exact-build result is explicitly cited.
