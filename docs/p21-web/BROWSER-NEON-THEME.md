# Mega XOXO Neon — browser theme and app handoff

The owner's 2026-10-11 `/game` annotation authorizes the homepage atmosphere as a fifth browser theme and the default browser appearance. Theme ID `cinematic`, display name **Mega XOXO Neon**. It is available in the browser game theme selector alongside `vector`, `midnight`, `paperclub` and `afterhours`, and appears in the website theme gallery.

The homepage preview and playable board share the same CSS tokens, gradients, cyan X/pink O marks, active-board glow, avatars and turn strip. Retained-palette overrides exclude `cinematic` without increasing their CSS specificity. Switching themes changes presentation only; local moves, required board, keyboard navigation and server-confirmed match state remain intact. A fresh game page defaults to Neon; this does not create a saved account preference or entitlement.

## Versioned implementation and artwork

| Component | Repository source | Optimized browser assets |
|---|---|---|
| Playable board | `apps/web/board.js`, `apps/web/board.css`; approved rules in `src/game.js` | DOM/SVG/CSS, no raster board or alternate game rules |
| Website atmosphere | `apps/web/styles.css`, `assets/p21/art/hero-source.png` | `assets/p21/art/hero-wide.webp`, `hero-small.webp` |
| Coin and Crown | `assets/p21/art/currency/{coin,crown}-source.png` | `assets/p21/art/currency/{coin,crown}.webp`, 128px, transparent |
| Wood–Grandmaster | Ten PNG masters under `assets/p21/art/ranks/`, retained Diamond master `assets/p21/art/crystal-source.png` | Eleven `assets/p21/art/ranks/*.webp`, 384px, transparent |
| Ranked and platform artwork | `assets/p21/art/{trophy,devices}-source.png` | `assets/p21/art/{trophy,devices}.webp` |
| Brand artwork | Canonical PNG masters under `assets/p21/logos/` | `assets/p21/logos/{header,mark}.webp` and existing four-theme exports |
| Fonts | Local files and OFL licenses under `assets/p21/fonts/` | Bundled WOFF2 subsets |

These source files and exports are committed on V5.1. The existing [provenance manifest](../../assets/p21/art/PROVENANCE.json) supplies 52 file hashes, byte counts, dimensions/alpha and generation/export records; [rank prompts](../../assets/p21/art/ranks/PROMPTS.json) preserve the exact rank-family prompts. The owner-supplied references remain under `assets/p21/reference/`. PNG masters are retained in Git, while the browser payload includes optimized exports. No new image generation or duplicate art is needed for this theme iteration.

## Future paid app theme

The owner intends to offer this browser appearance, including its currency and rank imagery, as a paid app theme later. That intent is recorded for the app handoff. This browser change does not add it to the native allowlist, store catalog, account appearance IDs, pricing or entitlement model. App integration will need an explicit purchase specification, backend-authorized ownership, native asset packaging and actual device/provider verification before release. No price, SKU or reward utility is inferred.

Local verification and screenshots are linked from [ANNOTATION-CHANGES.md](ANNOTATION-CHANGES.md). Browser presentation evidence does not claim native or production release.
