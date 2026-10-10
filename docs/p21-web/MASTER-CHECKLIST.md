# Mega XO — P21 Website & Browser Game Master Checklist

**Canonical website:** https://megaxo.online  
**Development branch:** V5.1 (created from V5-platform, not the divergent main branch)  
**Product:** One Mega XO identity, inventory, wallet, competitive authority, matchmaking pool, and social graph across web, iOS, and Android.  
**Visual master:** user-uploaded desktop mockup (1672 × 941) / Generated Image 1.  
**Brand reference:** user-uploaded logo artwork (1600 × 1600); keep untouched until the wordmark decision is approved.  
**Execution status:** PHASE 1 IN PROGRESS; PHASES 2–10 NOT STARTED. Nothing in this checklist means production deployed.

## How to maintain this file

- This is the **living** P21 build ledger, not a conceptual wish list. On **V5.1 only**, update checkboxes after evidence-backed delivery, link file path(s), test(s) and commit SHAs, and keep open decisions explicit.
- Check an item only when the asset/code/doc actually exists in the repository and is validated. Concept artwork is **not** a shippable, layered, licensed, responsive or accessible replacement.
- Retain original references and source files; create separately optimized web exports. Never bake UI controls, text, live metrics or grid logic into a flat hero background.
- Every visual deliverable requires source/master, format, dimensions, alpha/bleed, color profile, light/dark treatment, responsive variants, optimized exports, fallback and ownership/license record where applicable.
- Owner-approved product contracts take precedence over literal placeholder numbers/copy in the image. No accidental changes to rank ranges, four game themes, season clocks, economy, Crown utility or game mechanics.
- Phase IDs are P21.01–P21.10 and are **subphases of original P21**, not new phases of the 0–24 V5 program.
- All entries start open unless marked otherwise below. Use the phase exit gates and the final production checklist; skip no class of asset simply because generative or 3D workflows are available.
- Evidence index: [REFERENCE-AUDIT.md](REFERENCE-AUDIT.md), [BRAND-SYSTEM.md](BRAND-SYSTEM.md), [DECISIONS.md](DECISIONS.md); future [ASSET-REGISTRY.md](ASSET-REGISTRY.md) to track generated images, deterministic variants, provenance and checksums.

## Global deliverable gates

- [x] P21-G001: create isolated V5.1 branch from V5-platform; leave main / V4 / V5 / production untouched.
- [ ] P21-G002: publish exact uploaded image and logo masters as versioned **binary assets** in the repository, with SHA-256 and unmodified original bytes.
- [ ] P21-G003: approve exact public wordmark: uploaded artwork currently says “MEGA XOXO”, whereas product/UI says “Mega XO”.
- [ ] P21-G004: confirm all pages inherit the new cinematic chrome without modifying four existing gameplay theme definitions.
- [ ] P21-G005: confirm live website shares V5 session identity, rank, wallet, friend, tournament, season and game authority with native apps.
- [ ] P21-G006: capture desktop/tablet/mobile visual-diff evidence against approved reference variants and functional browser-game acceptance.
- [ ] P21-G007: production deploy authorized separately; **none** of the design/asset commits auto-cut over or deploy.

---

## P21.01 — Brand foundation & exact-look visual system

**Exit:** faithful, documented master design system; usable isolated code tokens; approved identity; reusable brand source artwork.

### Brand identity and provenance
- [x] Record uploaded logo and screenshot filenames, dimensions, SHA-256 and roles in reference audit.
- [ ] Copy unmodified originals into version-controlled reference-art directory.
- [ ] Confirm MEGA XO vs MEGA XOXO lettering with owner before final lockups.
- [ ] Preserve the brand emblem’s cyan X / hot-pink O / indigo outlines / circular motifs.
- [ ] Official primary horizontal header wordmark, as approved.
- [ ] Official full emblem + stacked wordmark, as approved.
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
- [ ] Typography: Space Grotesk/approved display + body; IBM Plex Mono for telemetry; local fallback and license record.
- [ ] Fluid type ramp from 320px mobile to 4K desktop, optical heading tracking and line-height.
- [ ] Foreground-on-surface contrast audit for text, icons, outlines and disabled states.
- [ ] Semantic palette: focus, success, warning, danger, informative, rank, X, O.
- [ ] Gradient orientation, linear-to-sRGB consistency, color-management sample sheet.
- [ ] Spacing, container width, z-index, border radii, elevation, glass, neon glow and motion token spec.
- [ ] Texture/noise/scanline rules, reduced-motion/low-power fallback and high-contrast mode.
- [ ] Brand proof sheet with approved header, buttons, panel, board, badges, hero composition and favicon variants.

## P21.02 — Product IA, routes, flows & content architecture

**Exit:** route/flow map with guest/auth/ranked/game/session boundaries and no invented API authority.

- [ ] Versioned site map and route ownership table (public marketing vs authenticated product vs game).
- [ ] Home, Play, Casual, Ranked, Tournaments, Season, Friends, Direct Challenge, Leaderboard, Rewards, Themes, Profile, Settings, Account and Support routes.
- [ ] Legal: privacy, terms, support, deletion, data controls, consent and store disclosures.
- [ ] About, How To Play, help/FAQ, patch notes/news, status page plan, 404/500/offline pages.
- [ ] Browser game launch and return flow, shareable invite URLs, challenge deep links, redirects.
- [ ] Guest visitor -> tutorial/practice -> account linking -> online matchmaking progression.
- [ ] Login/signup/verify/link-identity/refresh/revocation/session-expiry flow aligned with V5.
- [ ] Native-app deep-link / universal-link / app-association strategy.
- [ ] Player data model field provenance; never use image’s illustrative stats as live data.
- [ ] SEO/title/OG/content specification per public page (no indexing private sessions).
- [ ] Navigation, breadcrumbs, utility nav, bottom nav, responsive drawers, footer.
- [ ] API/websocket placement, auth-cookie/CSRF/CORS boundaries and trusted-source definition.
- [ ] Accessibility landmarks, keyboard map, localization and RTL-readiness policy.
- [ ] Copy deck, string IDs, error/empty/success/waiting text, UX writing review.
- [ ] Analytics consent and event naming; no raw gameplay/personally identifying data in tracking.

## P21.03 — Exact homepage reconstruction

**Exit:** the desktop reference can be rebuilt in editable DOM/components at approved screenshot size, then adapted to all breakpoints.

### Header and left hero
- [ ] Header layout at 1672×941 reference, brand placement, nav baseline and active underline.
- [ ] Play / Ranked / Tournaments / Rewards / Themes / Leaderboard nav destinations.
- [ ] Authentic Coin/Crown mini artwork; balances from account service, not hardcoded 2,450/12.
- [ ] Profile/auth state, avatar menu, notifications, responsive header.
- [ ] Eyebrow “BIGGER MOVES. BRIGHTER MINDS.” letterspacing and alignment.
- [ ] Large white “The Ultimate Tic-tac-toe.” headline with exact line wraps.
- [ ] Cyan→blue→purple “Think bigger.” typography gradient, highlight and glow.
- [ ] Two-line helper copy and exact vertical rhythm.
- [ ] Primary “Play Now” gradient/button border/glow, secondary “Play in Browser” pill treatment.
- [ ] Browser/iOS/Android platform strip with official platform icon handling.
- [ ] Logged-out/authenticated/reconnecting variants and keyboard-accessible CTAs.

### Center game preview
- [ ] Correct nine 3×3 boards (81 cells), square geometry and real X/O marks.
- [ ] Hero board panel with neon frame, soft edge lighting and inner shadows.
- [ ] Player names, rating, timers and symbolic X/O HUD with real-data or clearly labeled demo data.
- [ ] Actual valid active-board highlight and legal-move indicator (screenshot is illustrative only).
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
- [ ] Lower-card CTA arrows, hover, keyboard, focus and narrow-viewport adaptation.

### Scene/background composition — **indispensable to visual fidelity**
- [ ] **Clean cinematic hero plate:** dark starfield, deep navy sky, mountain silhouettes and blue/purple horizon haze; **no baked text, buttons, logos or board**.
- [ ] Separate silhouettes/landscape foreground with left/right edge composition.
- [ ] Separate midground ridge, far mountain, atmospheric haze and cloud/vignette layers.
- [ ] Left purple glow / right blue glow / center backlight lighting masks.
- [ ] Star and particle overlays with placement maps and intensity limits.
- [ ] Responsive crop/scene recomposition for 16:9, 21:9, tablet and portrait mobile.
- [ ] Art-directed *still* export per breakpoint, *animated* background layers and fallback.
- [ ] Visibility/dimming masks behind white copy, board and feature cards.
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
- [ ] Focus rings, keyboard and screen-reader semantics, appropriate aria-live regions.
- [ ] Responsive component demonstrations / visual snapshots with stable fixtures.
- [ ] TypeScript props, composable variants, docs/stories and component unit tests.
- [ ] Verify touch targets, forced-colors and reduced-motion behavior.

## P21.05 — Browser game presentation and real-time UX

**Exit:** actual playable product rendered inside a responsive web shell, not a decorative board screenshot.

- [ ] Mount existing verified game domain/rules; do not fork authoritative policy.
- [ ] Render nine mini-boards and 81 cells with legal routes, wins, draws and occupied-board states.
- [ ] X/O geometry, responsive hit targets, valid-move dots and focus/hover controls.
- [ ] Local and online mode shells, game HUD, clocks, move history and help/tutorial.
- [ ] Matchmaking queue, matched opponents, invite/challenge, rematch/leave/forfeit flows.
- [ ] Rank/tournament game mode notices that reflect true backend-authoritative state.
- [ ] WebSocket lifecycle: reconnect, resume, replay/idempotency, HTTP fallback semantics.
- [ ] Visibility/background suspension/resume and clock reconciliation.
- [ ] Offline practice, protected account session, refresh handling, sign-in-required UX.
- [ ] Win/loss/draw summary, rewards, rank change and match history.
- [ ] Audio option, haptics policy (where supported), animations and accessibility toggles.
- [ ] Four existing themes **vector, midnight, paperclub, afterhours** remain functional in gameplay.
- [ ] No client-authoritative wallet, rating, gameplay, tournament or economic mutations.
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
- [ ] Rank subdivisions only if approved by actual product, not invented from screenshot “Diamond II”.
- [ ] Golden trophy + arena/mountain inset at homepage card aspect ratio.
- [ ] Cross-platform synchronized device trio illustration (laptop, tablet, phone).
- [ ] Cosmic/theme plates, palette swatches and all existing game theme thumbnails.
- [ ] Reward badges, tournaments, seasonal events, profile avatars, achievement art.
- [ ] Homepage clean background still, **independent layers**, portrait/tablet/reduced-motion fallback.
- [ ] Public-page backgrounds; social share/OG and marketing artwork.
- [ ] Icon system: navigation, friends, challenge, timer, crossed swords, trophy, cloud, palette, settings, success/error, profile, invites, alerts.
- [ ] Full-resolution source archive and web-optimized SVG, AVIF/WebP, PNG as appropriate.
- [ ] Dark-background edge/alpha-premultiplication checks, color-profile check, retina variants.
- [ ] Asset attribution, commercial reuse/license records, generated-art prompt/seed/model metadata where available.
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
- [ ] Hero ordering: copy, board, rank CTA and feature cards with no clipped UI.
- [ ] Adaptive game board square sizing, safe areas, keyboard height, fold/landscape.
- [ ] Optimized images (AVIF/WebP), responsive picture srcsets and caching/versioning.
- [ ] Motion/video budget, lazy loading, skeleton design, poster and no-JS fallback.
- [ ] Core Web Vitals targets defined and measured on real hardware/networks.
- [ ] Screen-reader semantics, skip links, WCAG 2.2 AA target, contrast verification.
- [ ] Keyboard game control, focus visibility, high-contrast/forced colors, reduced motion.
- [ ] Browser coverage: Chromium, Safari/macOS, Safari/iOS, Firefox, Android Chrome.
- [ ] PWA install manifest/service worker/offline rules, no stale authenticated data.
- [ ] SEO crawl policy, sitemap/robots/canonical URLs and indexation tests.
- [ ] 60fps targeted micro-motion with low-power exceptions; WebGL not mandatory for controls.

## P21.09 — Codebase, deployment boundaries & backend integration

**Exit:** isolated shippable browser frontend with shared V5 contracts and CI; no second writer or identity service.

- [ ] Decide frontend stack based on existing V5 code and deployment constraints (provisional: React/TypeScript + Vite or Next, hosted Vercel).
- [ ] Create apps/web as separate deployable, with source/assets/components/styles/pages.
- [ ] Packages/tokens shared safely without rewriting existing mobile/web source code.
- [ ] API SDK per V5 ownership manifest; CSRF/session credentials, auth redirects.
- [ ] Core game connectivity and realtime route using existing server contracts.
- [ ] Account, wallet, rank, friends, tournaments, season and cosmetics adapters.
- [ ] One origin/canonical domain strategy: megaxo.online; www redirect; API separate as configured.
- [ ] No shadow economy, no duplicated policy, no insecure browser secrets.
- [ ] Integrate source assets via named manifest/hash rather than fragile direct paths.
- [ ] Static asset CDN caching, immutable revisions, optimized bundle splitting.
- [ ] Semantic SEO and Open Graph for public content, protected authenticated routes.
- [ ] CI checks: lint/typecheck/unit/contract/visual/a11y/perf/playwright cross-browser.
- [ ] Preview and staging environments isolated from production writers and currencies.
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
- [ ] Final docs: assets, how to update art, Figma-equivalent references, local dev, CI, deploy/rollback.
- [ ] Explicit owner visual sign-off and production deployment permission.
- [ ] Release notes/version evidence, environment verification, monitoring and post-launch follow-up.
- [ ] Production URL and web/native shared-account smoke tests; mark P21 done only after verified.

---

## Assets registry specification (mandatory for every art item)

Each asset receives an ID (for example P21-BG-001, P21-LOGO-001), target component(s), canonical source path, export path(s), owner, resolution/aspect, transparency, color space, license, model/seed/prompt (if AI-generated), checksum, completion status and visual QA evidence.

| Asset family | Example ID | Master format | Site exports | Completion |
|---|---|---|---|---|
| Source screenshot | P21-REF-001 | original PNG, unchanged | comparison-only | Referenced, repository binary pending |
| Supplied logo | P21-REF-002 | original PNG, unchanged | later SVG / transparent PNG | Referenced, repository binary pending |
| **Cinematic unlettered background** | P21-BG-001 | layered EXR/PSD/Blender source | AVIF/WebP + WebM/MP4 variants | Pending |
| Night-sky, stars, silhouette, fog layers | P21-BG-002…006 | independent alpha layers | WebP/PNG/video sprites | Pending |
| Horizontal logo/header/mark/favicon | P21-LOGO-001…006 | editable SVG/vector master | SVG/PNG/favicon/PWA | Wordmark approval pending |
| Coin/Crown and icon families | P21-ICON-001… | SVG/3D source | sprite/SVG/WebP | Pending |
| Game board/X/O/move indicators | P21-GAME-001… | vector/CSS procedural | DOM/CSS/SVG | Pending |
| Actual 11 rank tiers | P21-RANK-001…011 | 3D/vector master | WebP/SVG/sprites | Pending |
| Trophy and decorative inset | P21-ART-001 | layered 2D/3D | AVIF/WebP/PNG | Pending |
| Device trio with app screens | P21-ART-002 | 3D/mockup/PSD | AVIF/WebP | Pending |
| Theme/rewards card artwork | P21-ART-003 | layered illustration | AVIF/WebP | Pending |
| Ambient/game/reward motions | P21-MOT-001… | CSS/Lottie/project scene | CSS/WebM/MP4/JSON | Pending |
| Sound cues | P21-AUD-001… | original WAV stems | compressed audio | Pending |

## Phase status rollup

| Subphase | Gate | Status | Evidence / next action |
|---|---|---|---|
| P21.01 Brand foundation | Approved tokens, wordmark, original art archive | **IN PROGRESS** | Reference audit, design-system draft, tokens and no finalized wordmark yet |
| P21.02 Architecture | Approved routes/flows/auth boundaries | NOT STARTED | Crosscheck V5 endpoint contracts |
| P21.03 Homepage | Editable desktop parity + adaptive page | NOT STARTED | Recreate master sections including separate background |
| P21.04 Components | Accessible documented component library | NOT STARTED | Build after shell/token approval |
| P21.05 Game UI | Real web game, compatible rules and realtime | NOT STARTED | Preserve existing 4 themes and Core authority |
| P21.06 Assets/3D/motion/audio | Complete licensed optimized asset registry | NOT STARTED | Produce visual art masters, not just flat screenshot |
| P21.07 All pages | Complete site pages and state coverage | NOT STARTED | Route/page inventory |
| P21.08 Responsive/quality | Tested adaptive and accessible performance | NOT STARTED | Screenshot/perf matrix |
| P21.09 Engineering | Vercel-ready browser frontend connected to V5 | NOT STARTED | Await product/visual contracts |
| P21.10 Acceptance | Parity, E2E, security, owner go-live approval | NOT STARTED | No deploy authorized |

## P21 open decisions / blockers

1. **Wordmark conflict:** logo artwork says “MEGA XOXO”, original generated website and existing product say “Mega XO”; do not alter owner supplied source without explicit approval.
2. **Source binaries to GitHub:** originals exist as user uploads and hashes are recorded. Exact PNG bytes have **not yet been committed to GitHub** through text-only repo file operations; do not mark G002 complete until binaries are in git.
3. **Screenshot-only values:** “Diamond II”, 1620 rating, “Season 3 Oct–Dec 2024”, queue statistics and balances are illustration data. Real ranks, 2026+ seasons, active resources and wallet data come from accepted product contracts.
4. **Gameplay themes:** website’s cinematic shell is new; default gameplay themes remain Vector Light, Midnight Club, Paper Club and After Hours with their own assets and CSS.
5. **Production:** owner requested website on megaxo.online; deployment, DNS, auth, and V5 data authority must be verified independently and require a later explicit go-live decision.

## Commit/evidence journal

| Date | Scope | Evidence | Commit |
|---|---|---|---|
| 2026-10-10 | V5.1 branch from V5-platform; P21 checklist and Phase 1 draft started | GitHub branch inspection, original image audit | Update per completed commits |
