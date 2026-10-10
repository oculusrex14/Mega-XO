# Mega XOXO | P21.01 Visual Brand and Web Shell System (draft v0.1)

**Status:** Implemented draft reference specification, **awaits visual owner approval and finalized lockup**. Applies to `megaxo.online` chrome/marketing front end. It must not overwrite the four retained gameplay theme contracts.

## 1. Brand direction and fidelity strategy
- Master composition: the supplied 1672×941 screenshot, not arbitrary cyberpunk reference art.
- Mood: premium competitive strategy game; midnight starfield with cinematic mountainous foreground; electric blue interaction and blue/purple/magenta iridescence.
- Existing owner-provided emblem: teal crystalline X and pink orb O with fine orbit decoration. Honor geometry and use source unchanged in archive.
- **Approved brand name: Mega XOXO** (owner decision 2026-10-10). Historical screenshot header says MEGA XO and must be reconstructed with MEGA XOXO text while retaining its visual proportions.
- High fidelity must come from **native scalable components + isolated art layers**, not placing a static image under clickable hotspots.
- All game/state figures (rank, season, timers, wallet) must remain truthful to product state.

## 2. Composition at the 1672×941 reference viewport
Top band (approx. first 70px): logo/navigation/currencies/profile. Main hero begins below with:
- Left content rail ~38%: 2-line white headline with oversize gradient third line, two-line explanatory copy, primary luminous gradient CTA, outlined secondary CTA, platform compatibility strip.
- Center game rail ~33%: narrow neon outer frame, inset 3×3 macro-board, X and O top HUD, active-board blue ring, bottom explanatory ribbon.
- Right rank rail ~23%: tabs, heraldic crystal emblem, statistics/rank progress, season chip and CTA.
- Below hero: 3 equal-feature cards in dark translucent frames showing golden trophy, device trio and neon theme plates.
- Mountaintop/star/haze environment remains visible **behind** left copy and cards. Fog must never reduce text contrast.
- Start with native responsive CSS grid; use viewport-dependent clamp() sizing, not fixed coordinate position at every width.

## 3. Color intent / tokens
| Token | Draft | Role |
|---|---|---|
| canvas | #070F23 | dominant sky/deep navy |
| darker | #050A18 | header/underglow |
| panel | #0B1429 | panel glass foreground |
| panel-elevated | #111D36 | nested interaction |
| line | #28446E | muted border |
| text | #F6F8FF | primary text |
| text-muted | #B9CBE6 | instructions |
| blue | #1E85FF | functional UI |
| cyan | #23D8FF | highlights / X neon |
| violet | #7657FF | gradient midpoint |
| purple | #BF4EF8 | CTA end |
| pink | #FF58AD | O / reward accents |
| gold | #F7B637 | Coins/trophies |
| brand-teal | #0EE3D5 | canonical logo X art |
| brand-pink | #EF2B90 | canonical logo O art |

These are provisional design palette values sampled/interpreted from the source. Future work must include extracted-region color sampling and a rendered comparison, not aesthetic guessing.

## 4. Gradient hierarchy
- Brand-gradient: teal `#0EE3D5` → blue `#138FFA` → pink `#EF2B90` **for compatible logo-derived art only**.
- Hero headline: bright cyan → saturated blue → violet/magenta, left-to-right.
- Primary action: blue `#069FFD` → `#486CFF` → purple `#C149EF`.
- Rank bar: electric blue → violet.
- Glow: multiple semi-transparent shadow rings (tight cyan edge / medium blue halo / broad purple scattering).
- Hover effects are subtle and clearly subordinate to focus accessibility.
- X uses blue/cyan mark palette; O uses saturated pink glow. Preserve accessible non-color differences.

## 5. Type
- Starting baseline: **Space Grotesk** (existing game design-contract font; legally load via installed Google Fonts or a licensed self-hosted build). Use strong weight and compact tracking for hero display; preserve clean rounded letterforms.
- Supporting navigation/body: Space Grotesk regular/medium.
- Numeric timers/wallet/rank telemetry: **IBM Plex Mono**, tabular numerals.
- On-theme gameplay typography remains governed by `docs/THEMES.md` (Paper Club and After Hours must keep their approved fonts).
- Approximate desktop scale: tagline 12–14px tracked uppercase, h1 66–84px, hero body 20–22px, CTA 21–25px, nav 15–17px, panel headings 22–26px, utility labels 12–14px.
- The screenshot has an oversized headline; for narrower windows clamp/truncate **layout**, never silently remove information.

## 6. Shapes, strokes, panel and glow
- Header: transparent midnight with hairline blue/indigo bottom border.
- Panels: 1px cold blue thin edge + inner highlight; big card radius 18–22px, button pills 26–30px.
- Hero game panel: bright cyan outer stroke and subtle indigo-purple halo; dark inset tile borders, high-contrast active miniboards.
- Tab control: deep panel; selected tab uses blue-tinted inner gradient.
- Progress bars: thin rounded dark trough plus brightly lit fill.
- Cinematic cards: blended atmospheric scene and dark mask, independent readable UI foreground.
- Shadows must be measured; do not add bright bloom to every element simultaneously.

## 7. Authoring / export standards
- Reference master still: sRGB PNG unchanged, from attachment.
- New backdrop artwork: layered 16-bit EXR or PSD-equivalent master + unlettered WebP/AVIF still + atmospheric WebM/MP4 only when useful.
- Logo: 4 approved transparent 1254px themed raster masters and 768px WebP variants are checked into `assets/p21/logos/`; editable vectors and compact horizontal lockups remain separate open work.
- Currency/emblems: source GLB/Blender or layered raster, transparent exports and defined halo.
- All animations: still fallback, reduced-motion and low-power treatments.
- All raster source masters: color-profile tagged sRGB output, alpha clean at dark and light edges.
- Describe every AI-generated asset's model/prompt/version/approval; never imply exact extraction from raster if it is a creative redraw.

## 8. Four original game themes are protected
`vector` (Vector Light), `midnight` (Midnight Club), `paperclub` (Paper Club), `afterhours` (After Hours) are existing game aesthetics. Website shell tokens use the `mx-web-*` namespace; theme tokens must never be overwritten globally.

Web shell should wrap the game and permit the game canvas to render its proper selected theme. Theme preview marketing artwork may be more luminous but **the actual theme selection must honestly preview the actual game appearance**.

## 9. Asset-production gate
Review the first clean cinematic background plate side by side with the user-provided visual before generating animated/video and mobile variants. Confirm horizon line, mountain ridge contours, star density and primary blue-violet glow direction. Then lock export crops and effect parameters.

## 10. Completion acceptance
1. The original screenshot and emblem masters are retained unmodified (same SHA-256).
2. Header, hero, board/rank panel and feature-card silhouette match approved source at target viewport.
3. Mega XOXO spelling is fixed; final editable vectors, splash/launcher and horizontal lockups still require design QA.
4. Readability and accessibility tested over atmospheric layer.
5. Brand CSS/JSON tokens are consumed by a real component preview and visually signed off; code tokens alone are a draft, not a finished design system.

## P21.01 production branding checkpoints (2026-10-10)
- Source master PNGs: `assets/p21/reference/` (Git commit `a158389`).
- Four approved transparent thematic logo PNG/WebP sets: `assets/p21/logos/` (Git commit `fc67cfc`).
- Small 256px transparent emblem-only marks for UI: Git commit `3f75527`.
- Header selects the correct mark on initial load and theme changes; deterministic native allowlist includes eight optimized WebP files.
- Existing legacy theme token names and technical identifiers are intentionally unchanged; mobile display name is `Mega XOXO`.
- **Not completed:** manually editable SVG source master, OS launcher icons, final typographic horizontal website wordmark, theme/splash screenshots, production/store acceptance.
