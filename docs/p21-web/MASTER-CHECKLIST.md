# Mega XOXO — P21 Website & Browser Game Master Checklist

**Canonical website:** https://megaxo.online  
**Development branch:** V5.2 (active release integration; V5.1 is frozen historical evidence)  
**Product:** One Mega XOXO identity, inventory, wallet, competitive authority, matchmaking pool, and social graph across web, iOS, and Android.  
**Visual master:** user-uploaded desktop mockup (1672 × 941) / Generated Image 1.  
**Brand reference:** user-uploaded official Mega XOXO logo artwork (1600 × 1600), archived unchanged; the name is approved for web/iOS/Android.  
**Historical execution status — 12 October:** Tested local website payload: source `681f06bfad5e929cdda929cdf6d4486f5fff89ec`, bundle `9cfa78636df78528c6ae1fb95ee5afc845b787f796f17d91be5258d4b283aeef` (151 files / 3,474,873 bytes). Local UI automation passed 915/915 in [Chromium](../../tests-output/p21-web/9cfa78636df7/browser-qa.json), [Firefox](../../tests-output/p21-web/9cfa78636df7/firefox/20261012172200567-41942/browser-qa.json) and [WebKit](../../tests-output/p21-web/9cfa78636df7/webkit/20261012172405329-42892/browser-qa.json); axe passed 137/137 with zero violations and 116 incomplete manual views. Chromium 151 browser-offline QA passed 33/33; Firefox/WebKit browser-offline emulation remains incomplete. Origin-drop simulations passed 33/33 in Firefox/WebKit and Chromium 145; these are not physical offline acceptance. Codex local affected website/bot Node checks passed 138/138 ([saved log](evidence/20261012-recovery-validation/website-138-pass.log)). CUA verified the Main-hosted tailnet frontend 140/140 against source `f4851a568524846d981b351c659af4a9ee7479be` / bundle `8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3`; API/server boot SHA and authenticated flows remain unverified. Owner-reported account timeout is `OWNER_REPORTED_NOT_REPRODUCED`; R15 remains `AUTHENTICATED_ACCEPTANCE_PENDING`. See [staging evidence](evidence/20261012-staging-review/STAGING-READONLY-20261012.md), [detailed status and limitations](EXECUTION-STATUS-20261012.md), and [timeout receipt](evidence/20261012-staging-review/ACCOUNT-TIMEOUT-20261012.md). These results do not establish physical-device, screenreader, provider, production or release acceptance; website/provider/device/production release remains OPEN.

## How to maintain this file

The owner annotation iteration adds cinematic `/game`, Store, Sponsors and full themed legal routes, an in-site standings table, server-selected personal ranks, eleven badge images and generated currency artwork. Track all fourteen comments and remaining live-service/provider gates in [ANNOTATION-CHANGES.md](ANNOTATION-CHANGES.md). The earlier `99e65bd` checkpoint below remains historical evidence.

The subsequent `/game` annotation authorizes **Mega XOXO Neon** (`cinematic`) as a fifth browser-only theme and default. [Theme and artwork handoff](BROWSER-NEON-THEME.md) records its implementation and the owner's future paid app-theme intent. The four retained theme IDs and native catalog remain intact.

- This is the **living** P21 build ledger, not a conceptual wish list. New work targets **V5.2** under the owner's 14 October release mission. Preserve V5.1 evidence; update checkboxes only after evidence-backed delivery, with paths, tests, SHAs and open decisions.
- Check an item only when the asset/code/doc actually exists in the repository and is validated. Concept artwork is **not** a shippable, layered, licensed, responsive or accessible replacement.
- Retain original references and source files; create separately optimized web exports. Never bake UI controls, text, live metrics or grid logic into a flat hero background.
- Every visual deliverable requires source/master, format, dimensions, alpha/bleed, color profile, light/dark treatment, responsive variants, optimized exports, fallback and ownership/license record where applicable.
- Owner-approved product contracts take precedence over literal placeholder numbers/copy in the image. No accidental changes to rank ranges, four game themes, season clocks, economy, Crown utility or game mechanics.
- Phase IDs are P21.01–P21.10 and are **subphases of original P21**, not new phases of the 0–24 V5 program.
- All entries start open unless marked otherwise below. Use the phase exit gates and the final production checklist; skip no class of asset simply because generative or 3D workflows are available.
- Evidence index: [REFERENCE-AUDIT.md](REFERENCE-AUDIT.md), [BRAND-SYSTEM.md](BRAND-SYSTEM.md), [DECISIONS.md](DECISIONS.md); [ASSET-REGISTRY.md](ASSET-REGISTRY.md) to track generated images, deterministic variants, provenance and checksums.

## Global deliverable gates

- [x] P21-G001: create isolated V5.1 branch from V5-platform; leave main / V4 / V5 / production untouched.
- [x] P21-G002: exact uploaded website screenshot and logo stored as original binary PNGs in `assets/p21/reference/`, SHA-256 verified (`a158389`).
- [x] P21-G003: owner approved **Mega XOXO** for website, Android, iOS and user-facing content; original screenshot remains a pre-rebrand visual reference.
- [x] P21-G004: confirm all 39 website routes inherit cinematic chrome; local practice defaults to browser Neon and retains the four approved palette IDs. Retained `src/` theme definitions are byte-identical to entry HEAD.
- [ ] P21-G005: confirm live website shares V5 session identity, rank, wallet, friend, tournament, season and game authority with native apps.
- [ ] P21-G006: capture desktop/tablet/mobile visual-diff evidence against approved reference variants and functional browser-game acceptance.
- [ ] P21-G007: production deploy authorized separately; **none** of the design/asset commits auto-cut over or deploy.

---

## P21.01 — Brand foundation & exact-look visual system

**Exit:** faithful, documented master design system; usable isolated code tokens; approved identity; reusable brand source artwork.

### Brand identity and provenance
- [x] Record uploaded logo and screenshot filenames, dimensions, SHA-256 and roles in reference audit.
- [x] Copy unmodified originals into version-controlled `assets/p21/reference/` and verify both hashes.
- [x] Confirm permanent user-facing wordmark **Mega XOXO** with owner.
- [x] Preserve the original owner-supplied XO orbital emblem unchanged; theme variants respect existing screen palettes.
- [x] Official primary horizontal header wordmark (`assets/p21/logos/mega-xoxo-horizontal-logo.png`, 2172×724 RGBA transparent PNG, SHA-256 `4a22dbc289023dc0444b7b94400fda3e3e25c6e97e44b5302964b7214704bf9e`).
- [x] Four full transparent raster emblems + stacked **MEGA XOXO** wordmarks committed (raster masters; editable vector source still open).
- [x] Official website logo pack committed into `assets/p21/logos/`: primary stacked logo, secondary stylized logo, icon-only emblem, and horizontal lockup.
- [ ] Single-color, reverse, light-background and small-size lockups.
- [ ] Minimum clear space, safe bounds, display minimums and misuse examples.
- [ ] Editable vector master (hand-correct paths; image-trace alone is not final).
- [ ] Transparent raster exports at 1×, 2×, 4×.
- [ ] Favicon (16/32/48), SVG favicon, 180 Apple icon, 192/512 PWA icons, monochrome mask icon.
- [ ] Social avatar, OG thumbnail safe-zone and app-store-safe emblem.
- [ ] Copyright/source ownership provenance and font/vector licensing manifest.

### Visual tokens and typography
- [x] Draft neon-cinematic website shell palette, gradient/shadow/blur/spacing tokens.
- [x] Draft browser-consumable design-token CSS/JSON without modifying legacy gameplay theme tokens.
- [ ] Approve swatches against the original 1672×941 mockup after side-by-side review.
- [x] Typography: Space Grotesk/approved display + body; IBM Plex Mono for telemetry; local fallback and license record.
- [ ] Fluid type ramp from 320px mobile to 4K desktop, optical heading tracking and line-height.
- [ ] Foreground-on-surface contrast audit for text, icons, outlines and disabled states.
- [ ] Semantic palette: focus, success, warning, danger, informative, rank, X, O.
- [ ] Gradient orientation, linear-to-sRGB consistency, color-management sample sheet.
- [ ] Spacing, container width, z-index, border radii, elevation, glass, neon glow and motion token spec.
- [ ] Texture/noise/scanline rules, reduced-motion/low-power fallback and high-contrast mode.
- [ ] Brand proof sheet with approved header, buttons, panel, board, badges, hero composition and favicon variants.

## P21.02 — Product IA, routes, flows & content architecture

**Exit:** route/flow map with guest/auth/ranked/game/session boundaries and no invented API authority.

- [x] Versioned site map and route ownership table in [ROUTES-AND-FLOWS.md](ROUTES-AND-FLOWS.md); guest presentation and retained-game gateway boundaries explicit.
- [x] Home, Play, Casual, Ranked, Tournaments, Season, Friends, Direct Challenge, Leaderboard, Rewards, Themes, Profile, Settings, Account and Support routes.
- [ ] Legal: privacy, terms, support, deletion, data controls, consent and store disclosures.
- [ ] About, How To Play, help/FAQ, patch notes/news, status page plan, 404/500/offline pages.
- [ ] Browser game launch and return flow, shareable invite URLs, challenge deep links, redirects.
- [ ] Guest visitor -> tutorial/practice -> account linking -> online matchmaking progression.
- [ ] Login/signup/verify/link-identity/refresh/revocation/session-expiry flow aligned with V5.
- [ ] Native-app deep-link / universal-link / app-association strategy.
- [x] Player data model field provenance; never use image’s illustrative stats as live data.
- [x] SEO/title/OG/content specification per public page; private/play routes noindex. Shared raw/client metadata is locally verified in [download/discovery evidence](evidence/8520f1c/verification.json).
- [ ] Navigation, breadcrumbs, utility nav, bottom nav, responsive drawers, footer.
- [x] API/WebSocket/session/CSRF/CORS integration requirements documented in [DEVELOPMENT-AND-RELEASE.md](DEVELOPMENT-AND-RELEASE.md); adapters have local/synthetic evidence; live same-origin provider/service integration remains open.
- [ ] Accessibility landmarks, keyboard map, localization and RTL-readiness policy.
- [ ] Copy deck, string IDs, error/empty/success/waiting text, UX writing review.
- [ ] Analytics consent and event naming; no raw gameplay/personally identifying data in tracking.

## P21.03 — Exact homepage reconstruction

**Exit:** the desktop reference can be rebuilt in editable DOM/components at approved screenshot size, then adapted to all breakpoints.

### Header and left hero
- [x] Header layout at 1672×941, approved horizontal logo, nav baseline and active underline implemented; exact aesthetic sign-off pending.
- [x] Play / Ranked / Tournaments / Rewards / Themes / Leaderboard nav destinations.
- [ ] Authentic Coin/Crown mini artwork; balances from account service, not hardcoded 2,450/12.
- [ ] Profile/auth state, avatar menu, notifications, responsive header.
- [x] Eyebrow “BIGGER MOVES. BRIGHTER MINDS.” letterspacing and alignment.
- [x] Large white “The Ultimate Tic-tac-toe.” headline with exact line wraps.
- [x] Cyan→blue→purple “Think bigger.” typography gradient, highlight and glow.
- [x] Two-line helper copy and exact vertical rhythm.
- [x] Primary “Play Now” gradient/button border/glow, secondary “Play in Browser” pill treatment.
- [ ] Browser/iOS/Android platform strip with official platform icon handling.
- [ ] Logged-out/authenticated/reconnecting variants and keyboard-accessible CTAs.

### Center game preview
- [x] Correct nine 3×3 boards (81 cells), square geometry and real X/O marks.
- [x] Hero board panel with neon frame, soft edge lighting and inner shadows.
- [x] Clearly labeled interactive practice HUD and X/O symbols. Illustrative opponent rating/timers removed; no live match claim.
- [x] Actual valid active-board highlight and legal-move indicator (screenshot is illustrative only).
- [ ] Match-preview controls, turn info strip, tooltip and footer.
- [ ] Static screenshot fallback for users without scripted/hardware-accelerated effects.
- [ ] Inactive/hover/drag/tap/focus/reduced-motion visual states.

### Right ranked panel and feature row
- [ ] Ranked/Casual/Friends tabs, underlines, fills, loading states and accessible tab order.
- [ ] Diamond-style crystalline rank badge that matches screenshot, **plus actual product tiers**.
- [ ] Rank name/rating/season progress/percentile using approved product thresholds.
- [ ] Season summary, reward status pill, rank progress bar and action button.
- [ ] “Find Ranked Match” queue CTA, not a pretend action.
- [ ] Card 1: golden trophy scene, cinematic arena/mountain inset, season pill.
- [ ] Card 2: cross-platform laptop + tablet + smartphone mockups showing coherent real product screens.
- [ ] Card 3: two neon board-theme plates, palette icon, rewards and cosmetic row.
- [x] Lower-card CTA arrows, hover, keyboard, focus and narrow-viewport adaptation.

### Scene/background composition — **indispensable to visual fidelity**
- [x] **Clean cinematic hero plate:** dark starfield, deep navy sky, mountain silhouettes and blue/purple horizon haze; **no baked text, buttons, logos or board**.
- [ ] Separate silhouettes/landscape foreground with left/right edge composition.
- [ ] Separate midground ridge, far mountain, atmospheric haze and cloud/vignette layers.
- [ ] Left purple glow / right blue glow / center backlight lighting masks.
- [ ] Star and particle overlays with placement maps and intensity limits.
- [ ] Responsive crop/scene recomposition for 16:9, 21:9, tablet and portrait mobile.
- [ ] Art-directed *still* export per breakpoint, *animated* background layers and fallback.
- [x] Visibility/dimming masks behind white copy, board and feature cards.
- [ ] Seamless transition between sky/hero and lower feature-card background.

## P21.04 — Production UI component system

**Exit:** documented, accessible components with functional states and screenshot-matched skins.

- [ ] Foundation: container, section, 12-column grid, stack, cluster, separator, scroll region.
- [ ] Buttons: solid, glow, secondary/outline, quiet, destructive, icon-only and loading variants.
- [ ] Header/nav, mobile menu, active links, tabs, segmented controls and breadcrumbs.
- [ ] Card, feature panel, glass panel, backdrop overlay, tile, sheet, modal and drawer.
- [ ] Wallet pill, Crown pill, player badge, notification badge, toast/status chip.
- [ ] Tooltips, popovers, select, dropdown, context menu, inline help.
- [ ] Progress bars, stat/metric cell, countdown timers, leaderboard row, data grid.
- [ ] Inputs, labels, validation, switches, checkboxes, radio controls and form group.
- [ ] Avatar, rank emblem component, achievement, season card, tournament bracket block.
- [ ] Skeleton, shimmer, lazy-image, empty, error, unauthorized, offline and success states.
- [x] Focus rings, keyboard and screen-reader semantics, appropriate aria-live regions.
- [ ] Responsive component demonstrations / visual snapshots with stable fixtures.
- [ ] TypeScript props, composable variants, docs/stories and component unit tests.
- [ ] Verify touch targets, forced-colors and reduced-motion behavior.

## P21.05 — Browser game presentation and real-time UX

**Exit:** actual playable product rendered inside a responsive web shell, not a decorative board screenshot.

- [x] Mount existing verified game domain/rules; do not fork authoritative policy.
- [x] Render nine mini-boards and 81 cells with legal routes, wins, draws and occupied-board states.
- [x] X/O geometry, responsive hit targets, valid-move dots and focus/hover controls.
- [ ] Local and online mode shells, game HUD, clocks, move history and help/tutorial.
- [ ] Matchmaking queue, matched opponents, invite/challenge, rematch/leave/forfeit flows.
- [ ] Rank/tournament game mode notices that reflect true backend-authoritative state.
- [ ] WebSocket lifecycle: reconnect, resume, replay/idempotency, HTTP fallback semantics.
- [ ] Visibility/background suspension/resume and clock reconciliation.
- [ ] Offline practice, protected account session, refresh handling, sign-in-required UX.
- [ ] Win/loss/draw summary, rewards, rank change and match history.
- [ ] Audio option, haptics policy (where supported), animations and accessibility toggles.
- [x] Four existing themes **vector, midnight, paperclub, afterhours** remain functional in gameplay.
- [x] Owner-requested **Mega XOXO Neon** (`cinematic`) is the fifth browser theme and default; the playable board shares homepage styling. Future paid app delivery remains open.
- [x] Neon checkpoint `c80663a`: 76 affected tests, 674 browser checks, 95 automatic accessibility checks, 52 Git/provenance assets and eight original-palette comparisons pass; [exact verification](evidence/c80663a/verification.json) and CI are archived.
- [x] No online competitive/economic mutation or wallet/rating simulation. Local practice uses the existing pure rules; all online authority remains backend-owned.
- [ ] Cross-browser input, keyboard navigation, touch and screen-reader board descriptions.
- [ ] Spectating only if supported by actual feature contracts; otherwise marked future/disabled.

## P21.06 — Complete art, illustration, 3D, video and audio production

**Exit:** each asset registered with source, web exports, dimensions, provenance, checksum, fallbacks and QA.

### Illustrated/vector/raster assets
- [ ] 2D official logo master/variants and correctly licensed source.
- [ ] X glyph and O glyph: normal/hover/placed/winning/disabled/vector/glow variants.
- [ ] Board dividers, active cell, valid move indicators, victory trails and match symbols.
- [ ] Gold Coins and purple Crowns: small/medium/hero, static/vector and 3D.
- [ ] Real product rank-badge family: Wood, Stone, Iron, Bronze, Silver, Gold, Diamond, Emerald, Champion, Master, Grandmaster.
- [x] Rank subdivisions only if approved by actual product, not invented from screenshot “Diamond II”.
- [x] Golden trophy transparent cutout over cinematic mountain inset at homepage card aspect ratio (generated PNG master + WebP).
- [x] Cross-platform synchronized device trio illustration (laptop, tablet, phone).
- [ ] Cosmic/theme plates, palette swatches and all existing game theme thumbnails.
- [ ] Reward badges, tournaments, seasonal events, profile avatars, achievement art.
- [ ] Homepage clean background still, **independent layers**, portrait/tablet/reduced-motion fallback.
- [ ] Public-page backgrounds; social share/OG and marketing artwork.
- [x] Icon system: navigation, friends, challenge, timer, crossed swords, trophy, cloud, palette, settings, success/error, profile, invites, alerts.
- [x] Full-resolution source archive and web-optimized SVG, AVIF/WebP, PNG as appropriate.
- [ ] Dark-background edge/alpha-premultiplication checks, color-profile check, retina variants.
- [x] Generated-art prompts, tool/model/seed availability, hashes, dimensions, alpha and local font OFL records in `assets/p21/art/PROVENANCE.json`; owner legal/trademark clearance remains separate.
- [ ] No copyrighted third-party game imagery or unlicensed Apple/Google marks.

### 3D meshes and pre-rendered outputs
- [ ] High-poly and lightweight 3D X and O glyphs, source files and exports.
- [ ] High-poly Coin and Crown, normal/roughness/metallic maps and transparent turntables.
- [ ] Crystal rank badge family + hero Diamond-style crystal; gold trophy and award chest.
- [ ] Cinematic reflective board/theme plates, visual matching reference lighting.
- [ ] GLB/GLTF web-ready outputs, LODs, low-motion stills, mobile-safe texture budgets.
- [ ] Geometry validation: pivot, consistent scale, physically based materials, UVs, normals.
- [ ] Rendered PNG/WebP sprite/still outputs for devices where realtime 3D is not justified.

### Motion/video
- [ ] Atmospheric subtle 8–12s hero WebM/MP4 loop with no hard cut / seam.
- [ ] Independent particles/starfield, glow drift, horizon fog and vignette animation.
- [ ] Active mini-board outline pulse, X/O placement, winner highlight and rank shimmer.
- [ ] Button/tab/card-hover micro-interactions, loading/skeleton and progress fill.
- [ ] Reward burst, badge reveal, trophy shine, achievement unlock and season milestone.
- [ ] Accurate match-found, queue, timer and reconnection transitions.
- [ ] Theme-switch motion without changing game rules or losing focus.
- [ ] Encoded AV1/WebM + H.264/MP4 fallback when supported; still frame and poster.
- [ ] Respect reduced-motion, save-data, battery/thermal and inactive tab policies.
- [ ] No flashes, strobe, looping autoplay audio or motion-induced layout shift.

### Optional-to-play sound assets (produce because complete pack requested)
- [ ] UI select, placed X/O, victory, loss, rank-up, invite, queue-match and reward sounds.
- [ ] Master high-quality stems + optimized small web/audio exports.
- [ ] Muted-by-default/consent-safe web playback, volume/mute and accessibility controls.

## P21.07 — Every page and state, beyond homepage

**Exit:** finished full-site page specs, assets, routes, empty/loading/error states, not just homepage.

- [ ] Marketing/home for guests and signed-in users, complete accessible hero.
- [ ] Play hub, mode selection and real match route.
- [ ] Ranked hub, tier explanation, seasonal standings and match queue.
- [ ] Tournaments list, detail, brackets, entry and history.
- [ ] Friends, presence, profile search, challenges, invites and pending requests.
- [ ] Leaderboards, historical seasons, season progress and rankings.
- [ ] Rewards, Coins, Crowns, wallet history and eligible purchase surfaces.
- [ ] Themes gallery, ownership and preview; preserve approved four-theme gameplay.
- [ ] User profile, match history, stats, achievements and privacy controls.
- [ ] Settings, notifications, identity/linking, email/account security and support.
- [ ] Onboarding, tutorial/how-to-play, how routing works, rule reference.
- [ ] Help/FAQ, contact, reports/feedback, patch notes and announcements.
- [ ] About/community/press/social sharing/links to mobile stores.
- [ ] Terms, privacy, deletion, consent/preferences and accessibility statement.
- [ ] Offline, maintenance, age/region restrictions if actually needed, 404 and server error.
- [ ] Per-page copy, illustrations, metadata, OG, social previews and responsive visual references.
- [ ] Every page reviewed with real/fixture data, not only ideal filled states.

## P21.08 — Responsive design, accessibility & performance

**Exit:** authentic desktop match plus intentionally designed tablet/mobile versions with measured performance.

- [ ] Pixel-comparison baseline at screenshot size 1672×941 with documented approved deviations.
- [ ] Ultra-wide 2560/3440, standard 1440/1672, laptop 1280/1024 layout guides.
- [ ] Tablet portrait/landscape and mobile 320/360/390/430 layouts.
- [x] Hero ordering: copy, board, rank CTA and feature cards with no clipped UI.
- [ ] Adaptive game board square sizing, safe areas, keyboard height, fold/landscape.
- [ ] Optimized images (AVIF/WebP), responsive picture srcsets and caching/versioning.
- [ ] Motion/video budget, lazy loading, skeleton design, poster and no-JS fallback.
- [ ] Core Web Vitals targets defined and measured on real hardware/networks.
- [ ] Screen-reader semantics, skip links, WCAG 2.2 AA target, contrast verification.
- [x] Keyboard game control, focus visibility, high-contrast/forced colors, reduced motion.
- [ ] Browser coverage: Chromium, Safari/macOS, Safari/iOS, Firefox, Android Chrome.
- [ ] PWA install manifest/service worker/offline rules, no stale authenticated data.
- [x] Local SEO crawl policy, sitemap/robots/canonical URLs and production-policy fixture tests. Deployed indexing and webmaster submission remain open.
- [ ] 60fps targeted micro-motion with low-power exceptions; WebGL not mandatory for controls.

## P21.09 — Codebase, deployment boundaries & backend integration

**Exit:** isolated shippable browser frontend with shared V5 contracts and CI; no second writer or identity service.

- [x] Frontend selected: isolated static ESM/DOM/CSS with existing MegaGame rules; Vercel static target. No framework/runtime dependencies required for this presentation. See P21-D011.
- [x] Create apps/web as separate deployable, with source/assets/components/styles/pages.
- [ ] Packages/tokens shared safely without rewriting existing mobile/web source code.
- [ ] API SDK per V5 ownership manifest; CSRF/session credentials, auth redirects.
- [ ] Core game connectivity and realtime route using existing server contracts.
- [ ] Account, wallet, rank, friends, tournaments, season and cosmetics adapters.
- [ ] One origin/canonical domain strategy: megaxo.online; www redirect; API separate as configured.
- [x] No shadow economy, no duplicated policy, no insecure browser secrets.
- [x] Integrate source assets via named manifest/hash rather than fragile direct paths.
- [ ] Static asset CDN caching, immutable revisions, optimized bundle splitting.
- [x] Semantic SEO and Open Graph for public content; private routes excluded. Raw HTTP/client parity tests pass locally; live release remains open.
- [ ] CI checks: lint/typecheck/unit/contract/visual/a11y/perf/playwright cross-browser.
- [x] Loopback static preview refuses API writes and reads return unconfigured; no production writer/currency access. Remote staging remains open.
- [ ] Deployment/rollback/canary runbook, build provenance and observable releases.
- [ ] Browser-to-V5-to-PostgreSQL identity/economy proof; do not deploy without explicit release approval.

## P21.10 — Visual parity, QA, release gates and handoff

**Exit:** visually approved, accessibility/performance checked, functional cross-platform website release, explicitly authorized deployment.

- [ ] Define exact reference regions: header, hero copy, board, rank rail, scene, feature row.
- [ ] Compare approved browser screenshots to master mockup and document discrepancies.
- [ ] Asset completeness automated audit (source, export, metadata, checksum, fallback).
- [ ] Responsive screenshot matrix and goldens for all breakpoint/theme/state pairs.
- [ ] Cross-browser functional tests for game moves, turns, timers, reconnect and challenge URL.
- [ ] End-to-end signed-in account, progression, wallet and player data agreement with native clients.
- [ ] Manual mobile Safari/Android Chrome and real desktop accessibility review.
- [ ] No missing image/404, clipping, overlap, giant video download, layout jank or font flash.
- [ ] Security, privacy, auth expiry, CSP, XSS, redirects, rate-limiting and cache isolation QA.
- [ ] Budget validation for CWV, bundle/video weights, GPU/CPU/battery.
- [ ] Reduced motion, 200% zoom, 320px width, keyboard-only and screen-reader QA.
- [ ] Loading, offline, maintenance, failure and retry screenshots.
- [x] Final docs: assets, how to update art, Figma-equivalent references, local dev, CI, deploy/rollback.
- [ ] Explicit owner visual sign-off and production deployment permission.
- [ ] Release notes/version evidence, environment verification, monitoring and post-launch follow-up.
- [ ] Production URL and web/native shared-account smoke tests; mark P21 done only after verified.

---

## Assets registry specification (mandatory for every art item)

Each asset receives an ID (for example P21-BG-001, P21-LOGO-001), target component(s), canonical source path, export path(s), owner, resolution/aspect, transparency, color space, license, model/seed/prompt (if AI-generated), checksum, completion status and visual QA evidence.

| Asset family | Example ID | Master format | Site exports | Completion |
|---|---|---|---|---|
| Source screenshot | P21-REF-001 | original PNG, unchanged | comparison-only | COMPLETE · `a158389` |
| Supplied logo | P21-REF-002 | original PNG, unchanged | reference for vector conversion | COMPLETE · `a158389` |
| **Cinematic unlettered background** | P21-BG-001 | generated PNG retained; layered master OPEN | desktop/mobile WebP | PARTIAL · `99e65bd` |
| Night-sky, stars, silhouette, fog layers | P21-BG-002…006 | independent alpha layers | WebP/PNG/video sprites | Pending |
| Horizontal logo/header/mark/favicon | P21-LOGO-001…006 | editable SVG/vector master | SVG/PNG/favicon/PWA | PARTIAL — themed raster marks integrated; vector/favicon pending |
| Coin/Crown and icon families | P21-ICON-001… | SVG/3D source | sprite/SVG/WebP | Pending |
| Game board/X/O/move indicators | P21-GAME-001… | existing pure rule module + procedural CSS | 81 interactive DOM cells | IMPLEMENTED / local tests · `99e65bd` |
| Actual 11 rank tiers | P21-RANK-001…011 | 3D/vector master | WebP/SVG/sprites | Pending |
| Trophy and decorative inset | P21-ART-001 | generated alpha PNG; editable layers OPEN | WebP/CSS mountain inset | PARTIAL · `99e65bd` |
| Device trio with app screens | P21-ART-002 | generated alpha PNG; abstract X/O art | WebP | PARTIAL · real app captures OPEN |
| Theme/rewards card artwork | P21-ART-003 | layered illustration | AVIF/WebP | Pending |
| Ambient/game/reward motions | P21-MOT-001… | CSS/Lottie/project scene | CSS/WebM/MP4/JSON | Pending |
| Sound cues | P21-AUD-001… | original WAV stems | compressed audio | Pending |

## Phase status rollup

| Subphase | Gate | Status | Evidence / next action |
|---|---|---|---|
| P21.01 Brand foundation | Approved tokens, wordmark, original art archive | PARTIAL / TESTED_LOCAL | Official header, local licensed fonts and palette implemented; vectors/icon family and owner sign-off open |
| P21.02 Architecture | Routes/flows/auth boundaries | DOCUMENTED / PARTIAL | 27 routes and gateway ownership map; live auth/session/deep links open |
| P21.03 Homepage | Editable desktop parity + adaptive page | IMPLEMENTED / TESTED_LOCAL | Reference composition, separate scene art, real legal practice board; exact approval open |
| P21.04 Components | Accessible reusable components | PARTIAL / TESTED_LOCAL | Shared chrome/cards/buttons/icons/tabs; full signed-in form/state library open |
| P21.05 Game UI | Real game with compatible rules/realtime | PARTIAL / TESTED_LOCAL | Local bot + two-player, five themes, retained tutorial/Worker; scoped snapshot reader and HTTP fallback verified in three local engines; authenticated staging acceptance open |
| P21.06 Assets/3D/motion/audio | Complete asset registry | PARTIAL | Four generated PNG masters/WebP exports + procedural art; layered scenes, 11 rank family, 3D/video/audio open |
| P21.07 All pages | Full site pages and states | DESIGNED / PARTIAL | 26 supporting routes; live account data, detail/transaction flows open |
| P21.08 Responsive/quality | Adaptive/a11y/performance | PARTIAL / TESTED_LOCAL | 320/390/768/1672 Chromium matrix; axe automatic checks; physical browsers/manual a11y/CWV open |
| P21.09 Engineering | Isolated frontend connected to V5 | PARTIAL / TESTED_LOCAL | Deterministic static allowlist, preview, Vercel config and CI; live V5 connection open |
| P21.10 Acceptance | Parity/E2E/owner go-live | OPEN | Local evidence archived; no visual sign-off, production deployment or shared-account acceptance |

## P21 current open items and gates

1. **Visual review:** inspect the rebuilt desktop homepage and all supporting pages. The approved logo replaces old Mega XO; guest balances/rank/season/timers use truthful states. Compare generated mountain/crest/trophy/device details; no pixel-perfect or owner acceptance claim.
2. **Actual signed-in website:** deploy and accept the implemented protected profile/Friends controls, bounded account states and realtime reader against current isolated staging; finish invitation/eligibility/detail/transaction states and verify shared permanent actor agreement. Local fixtures do not establish server settlement or continuity.
3. **Legal/release:** approve draft legal and retention disclosures; verify origins, callbacks, DNS/associations and intended project. Hobby is selected for the present non-commercial experiment. No dedicated Mega XOXO Vercel deployment is verified; do not invent one.
4. **Quality:** physical Safari/iOS/Android/Firefox, VoiceOver/TalkBack, image/gradient contrast review, real device/network CWV, zoom and touch acceptance remain open. Chromium automation is narrower evidence.
5. **Extended asset/brand pack:** editable vectors, app icons, actual device screenshots, independent scene layers, 3D, motion and audio remain unfulfilled; the eleven rank images are now committed. The current still reconstruction renders without WebGL/video/audio. Tool permission does not constitute provider/legal approval.
6. **Production authority:** V4.1.2/SQLite stays live. A website launch cannot silently perform the separate V5 API/Core/PostgreSQL cutover; use the existing go/no-go and operator-window gates.
7. **Historical ledger:** original pack P21 remains historically deferred. This later owner-authorized V5.1 workstream is separately recorded in `docs/v5/progress.json` and here; G22/G23/G24 and 38 original acceptance cases remain open.

## P21.01 completed branding deliverables

- [x] Confirm user-facing product name **Mega XOXO** (owner, 2026-10-10).
- [x] Archive exact original logo and screenshot sources (commit `a158389`).
- [x] Add four transparent 1254px theme PNG masters and 768px optimized WebP exports (`fc67cfc`).
- [x] Add theme-matched 256px mark-only transparent WebP crops (`3f75527`).
- [x] Replace browser navigation, account UX, diagnostics, notifications and social share names with Mega XOXO.
- [x] Replace Android and iOS application display labels and native notification/alert names with Mega XOXO.
- [x] Update customer-facing email templates and legal/help pages; preserve crypto, package names and domain identifiers.
- [x] Wire the 4 header marks to existing saved theme IDs and include all 8 WebPs in native deterministic allowlist.
- [x] Add dedicated brand/bundle regression test coverage `tests/v5-p21-brand.test.js`; align email/legal tests.
- [x] Import official website logo pack (`mega-xoxo-primary-logo.png`, `mega-xoxo-secondary-logo.png`, `mega-xoxo-icon-only-logo.png`, `mega-xoxo-horizontal-logo.png`) into `assets/p21/logos/` and catalog in [ASSET-REGISTRY.md](ASSET-REGISTRY.md).
- [x] Enable V5.1 browser/native validation workflow triggers.
- [x] Publish versioned artwork hashes, format and theme palette notes in [ASSET-REGISTRY.md](ASSET-REGISTRY.md).
- [x] Browser validation passed on `a5549176` ([Actions 38058495832](https://github.com/oculusrex14/Mega-XO/actions/runs/38058495832)); full Node regression, Chromium accessibility and browser flow jobs green.
- [x] Native CI passed on `05a06150` ([Actions 38058145708](https://github.com/oculusrex14/Mega-XO/actions/runs/38058145708)): Android build, iOS simulator, Android emulator launch and byte-level bundle parity. No store approval implied.
- [ ] Final SVG/vector and all mobile/adaptive launch variants complete.
- [ ] Independent QA at actual supported phone viewports and physical devices.
- [ ] Complete original Phase 21 production website and browser game launch.

## CI acceptance evidence

| Check | Commit tested | Run | Result |
|---|---|---|---|
| V5.1 browser + Node regression / accessibility and UI | `a5549176` | [38058495832](https://github.com/oculusrex14/Mega-XO/actions/runs/38058495832) | **PASS** |
| V5.1 native Android + iOS host build, Android emulator and bundle parity | `05a06150` | [38058145708](https://github.com/oculusrex14/Mega-XO/actions/runs/38058145708) | **PASS** |
| Provider store submission / approval / real physical devices / release to `megaxo.online` | — | — | NOT CLAIMED |

## Commit/evidence journal

| Date | Scope | Evidence | Commit |
|---|---|---|---|
| 2026-10-10 | P21 checklist/Phase 1 foundation | All 10 subphases enumerated | `62efb725`, `8e9aeef` |
| 2026-10-10 | Original screenshot + owner logo archived | Exact SHA-256, original binary blobs | `a158389` |
| 2026-10-10 | Four approved transparent logo suites | 4 PNG masters + 4 optimized app WebPs | `fc67cfc` |
| 2026-10-10 | Cropped icon assets | Four 256px WebPs, SHA-256 verified | `3f75527` |
| 2026-10-10 | Public brand rename + provider text | Browser, Android, iOS, email, help/legal | `09d08ce` through `5e6e7ee` |
| 2026-10-10 | App mark integration + native bundler + regression tests | `src/app.js`, `native/client/bundle.config.json`, V5 bundle builder and tests | `134268a` through `d406f14` |
| 2026-10-10 | V5.1 validation activated; legal assertions corrected | Initial regression exposed stale expected legal-page names, fixed and rechecked via CI | `05a0615`, `c275fc6` |
| 2026-10-10 | Rebrand decisions and complete artwork registry | `DECISIONS.md`, `BRAND-SYSTEM.md`, `REFERENCE-AUDIT.md`, `ASSET-REGISTRY.md` | `2901c07`, `26e1c8c` |
| 2026-10-11 | Official website logo pack added | `mega-xoxo-{primary,secondary,icon-only,horizontal}-logo.png` committed to `assets/p21/logos/`; registry and checklist updated | `1938499` |

## 2026-10-11 implementation checkpoint

Code: `99e65bdc8655162cf2dcc4af26dc0b73ec203cdc`. Evidence and final CI result: [IMPLEMENTATION-AND-READINESS.md](IMPLEMENTATION-AND-READINESS.md). Checked rows above cover implemented/local verification only at the explicitly stated scope; combined production requirements remain unchecked.

| 2026-10-11 check | Exact code SHA | Evidence | Result |
|---|---|---|---|
| New static website / Chromium / axe CI | `99e65bdc8655162cf2dcc4af26dc0b73ec203cdc` | [38082099277](https://github.com/oculusrex14/Mega-XO/actions/runs/38082099277) | PASS |
| Existing browser validation | same | [38082099203](https://github.com/oculusrex14/Mega-XO/actions/runs/38082099203) | PASS |
| Native host build/launch/client byte parity | same | [38082099216](https://github.com/oculusrex14/Mega-XO/actions/runs/38082099216) | PASS; physical/store release OPEN |

All 27 affected tests, 489 local browser checks and 58 automatic accessibility checks passed. Local build manifest equals the downloaded CI manifest. No production deployment.

## Download and discovery follow-on — 2026-10-11

Source `8520f1c` implements the owner’s Download Now request with a central nullable store-link config and an official-store-only device redirect handler. Public pages render full themed content before JavaScript. Twenty-two canonical public URLs use megaxo.online; play/personal routes stay out of the sitemap and have disallow/noindex policies. FAQ answers and structured data share one source; the media kit and company project card support legitimate future links. The GitHub repository is not used as a marketing destination. [Implementation and remaining launch checks](DOWNLOAD-AND-DISCOVERY.md) distinguish local delivery from actual publication. Existing Neon/artwork records remain historical evidence.

Website and retained CI both passed on source `8520f1c`; the downloaded CI manifest is byte-identical to the local build. CI run identities and results are archived in the linked verification record.

## Realtime and bounded account checkpoint — 2026-10-13

Frontend `4a9c29c`, exact-artifact browser/CI tooling `e807d28`, conflict-free integration with Main through `8faf575` at `09e1382`. Bundle `2887b0cd9723513792af01d71412ee94040f2f2dcfc9277a52fe7612733eb9e6` has153 files/3,542,005 bytes; integrated payload is byte-identical to the measured feature build.256 affected tests pass. Realtime21, profile18 and Friends40 pass in each Chrome151/Firefox153/WebKit26.5. Chromium broad915 and automated a11y137 pass;116 manual accessibility views remain open. Tutorial/Worker15 passes. All online actors and economic responses in these local runs are synthetic; real WS/WSS/CSP is loopback only.

The read-only ticket/subscription/resume/full-snapshot reader is implemented, as are unchanged-revision terminal presentation, actual profile refresh, HTTP fallback, lifecycle/session fencing and bounded account restoration. Staging still serves old `f4851a5`/`8167f349`. Main-owned publisher/terminal defects, fresh deployment/boot receipt, private two-account handoff and complete actual settlement/native/device acceptance remain open. No compound checkbox closes:71 checked/159 open. Current observations, retained failures, exact commands and next tasks are in [the checkpoint](REALTIME-BROWSER-CHECKPOINT-20261013.md) and [archive](evidence/20261013-realtime-browser/archive-index.json).

### Owner annotation review — 14 October 2026

[OWNER-REVIEW-20261014.md](OWNER-REVIEW-20261014.md) records source `5897497`, exact staged backend/frontend identities, 256 website + 3 legal tests, 45 local three-engine checks and 10 real HTTPS desktop/mobile checks. Sponsor action spacing is fixed; the owner explicitly withdrew `/press` (superseding the press portion of the original compound scope); Privacy/Terms draft banners are removed and substantive wording completed under owner authorization. Settings is retained for offline-copy and privacy navigation. The original compound checkboxes and IDs remain intact: these visual/content passes do not close store, signed-device, legal retention/contact disclosure or production release gates.


## V5.2 continuation — 15 October 2026

The owner’s V5.2 mission supersedes the old branch restriction, without changing original phase
IDs or closing combined production/device gates. Main merged the guarded power presentation in
PR #14 and refreshed staging. Current independently probed frontend: `3752383c4f4f8343ad6aeb00d2434beec3ef96f6`,
bundle `17b1d88e423d2aa4727a086b5908c7e8317b7594bcb7f04ec89a7a06c877bfb8`, 160 files /
3,688,654 bytes; both health endpoints return 200/ready. Main’s backend authority remains separate.

- [Provider/browser checkpoint](../v5.2/release/CODEX-RELEASE-CHECKPOINT-20261014.md): actual paid
  Apple membership, app/IAP drafts and approved price schedules; Play draft/declarations; AdMob,
  mail and real synthetic alert delivery states. Neither store is submitted and no public cutover
  is asserted. PR #15 carries the follow-up source/evidence for Main integration.
- [Exact local engine evidence](../v5.2/provider-evidence/20261014/website/README.md): three engines
  at 890 assertions each, automated axe131, and explicitly retained manual/integration limits.
- [Friends error fix](../v5.2/provider-evidence/20261015/website/FRIENDS-ACCOUNT-RETRY.md): `d582dfe`,
  316 passes / 0 failures / 5 integration skips on the merged Main code. Timeout/error shows retry;
  an unverified response cannot become guest or reveal private lists.
- [Timed real staging recheck](../v5.2/provider-evidence/20261015/website/FRIENDS-STAGING-TIMED-RECHECK.md):
  the guest prompt did resolve; indefinite loading was not reproduced. The new error fix is not
  yet deployed. Anonymous/local Bot checks do not establish two-account WSS or settlement.

Authenticated current-build signup/recovery, two-account full games, authoritative wallet/rank,
provider callbacks, physical-device access, public production and store submission remain open
at their actual evidence boundaries. No readiness percentage is inferred from overlapping tests.
