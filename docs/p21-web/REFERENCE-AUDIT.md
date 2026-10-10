# P21 Source Reference Audit

Source files are attached to the 2026-10-10 P21 website conversation. Their exact original bytes must be preserved in Git once a binary-compatible transfer path is available. The PNGs are **opaque** (RGBA alpha = 255 everywhere).

| ID | Role | Original filename | Dimensions | SHA-256 |
|---|---|---|---|---|
| P21-REF-001 | **Canonical visual target** — Generated Image 1 desktop screenshot | `47339619-edc5-4acd-8829-1ddecf36363f.png` | 1672 × 941 | `fbf558f36e67dbbc207e969e83655db59fd221f7095a52ad14c6b49bb27fc1f8` |
| P21-REF-002 | **Owner-supplied canonical brand-art reference** | `designarena_image_bncn899p.png` | 1600 × 1600 | `af0eec08b3f554830e5a0fc95d470b20b4c8a15e3e526c99d0f07684c56cf34a` |

## Visual analysis

### P21-REF-001 (site)
- Deep midnight/navy star field; mountain silhouettes along left/right/lower horizon; blues and purples reflect on the mountains; **real background artwork is mandatory**.
- Header at top with neon **MEGA XO** logo, six navigation labels, coin and crown balances, player avatar.
- Left column: spaced tagline, massive white headline, gradient blue-to-purple “Think bigger.”, supporting lines, glowing CTA pair and platform device row.
- Center: glass game frame containing 9×9 total cells in 3×3 miniboards; X blue, O neon pink; one bright-blue active board; header/player HUD; blue instruction ribbon.
- Right: queue tabs, large iridescent blue/purple winged crystal rank emblem, rating bar, season chip and blue Find Ranked Match CTA.
- Lower three feature cards: golden trophy/arena, laptop-tablet-phone group with matching Mega XO UI, neon cosmetic/theme plates and reward chips.
- Master coordinate basis: **1672 × 941** screenshot; retain content proportions and relative spacing at this reference width but make mobile layouts distinct.
- Approximate dominant background sampled from the image: `#070F23`; other sampled tones include `#152554`, electric blue `#1E67F1`, pale copy `#EFF0F2`, violet `#9C57F1`. These are **draft sampling cues**, not approved final color values.
- All copy, buttons, counters and functional boards must be built as DOM/vector/CSS; do not crop a screenshot into an interactive interface.
- A **clean plate** and separate foreground/midground atmospheric layers are needed; simply applying gradient CSS cannot recreate the mountain silhouettes, environmental lighting, fog and star details.

### P21-REF-002 (brand art)
- Illustration: prominent cyan/teal crystalline-style X, hot-magenta/pink O, indigo/navy cutout/outline, orbit arcs/dots and small repeated X motifs on a deep purple-black background.
- Under emblem: spaced “MEGA” then very large **“XOXO”** in white. This differs from the established **“Mega XO”** game/product name and reference website header.
- Source is not transparent despite its RGBA container; vector master/transparency must be manually prepared or correctly matted, preserving geometry.
- Approximate sampled brand tones: `#100F1F`, `#0EE3D5`, `#EF2B90`, `#221955`, `#F7F7F7`. They complement but are not identical to the hero preview color palette.
- Do not replace/alter the uploaded logo in-place. Use the emblem as the brand identity source; create a harmonized header lockup **only after approval** of MEGA XO vs MEGA XOXO spelling.

## Functional deviations required by actual game specification

| Screenshot depiction | Approved game contract | Decision |
|---|---|---|
| Diamond II rank at 1620 | Game tier thresholds include Gold ≥1500, Diamond ≥1700; no generic “Diamond II” established | Dynamic server-driven real league |
| Season 3 Oct–Dec 2024 | Ranked seasons are quarterly UTC with dynamic season/current date | Never hardcode old mock season |
| Demo wallet Coins 2,450/Crowns 12 | Authenticated wallet source of truth is backend | Render actual balances; placeholders only in clearly marked demos |
| A visually placed X/O set with one glowing board | Legal move routing and board states are authoritative domain rules | Build a valid fixture for showcase and playable UI |
| Dark neon page-wide look | Gameplay has four established themes | Separate cinematic website shell from four selectable gameplay themes |

## Source precedence
1. User-provided original artwork and master generated homepage for **visual language**.
2. `docs/PRODUCT.md` and its amendments for gameplay, ranks, economics and seasons.
3. `docs/THEMES.md` and current game source for existing four-theme invariants.
4. `apps/api`, `packages/contracts` and V5 guides for actual auth/API/Core integration.
5. Newly introduced P21 UI specs **only for new website/browser product**, not as an implicit rewrite of native UX.

## Source storage and QA protocol
- Desired tracked paths: `assets/p21/reference/homepage-generated-image-1.png`, `assets/p21/reference/brand-owner-original.png`.
- Store original PNGs as immutable binary references; add a sidecar manifest with SHA-256.
- Derivative SVG/art must never be described as exact source or original vectorization without manual QC.
- Do side-by-side comparison at source resolution, normalized sRGB display and multiple web viewports.
- Existing `docs/v5` P21 `DEFERRED_BY_OWNER` ledger is an archived V5 foundation statement. This newer owner-authorized site work is tracked independently on `V5.1` until accepted; don't retroactively mark the original integration gate completed.
