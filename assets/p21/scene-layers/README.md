# Independent scene source layers

These are separate compositing sources for the commissioned P21 pack. The existing site's hero plate and default composition are unchanged. Foreground, midground and atmospheric haze were derived through the built-in imagegen tool from `assets/p21/art/hero-source.png`; they are generated derivatives, not guaranteed pixel-exact extractions.

Each raster master retains the original 1672×941 canvas and real alpha. WebP exports preserve alpha exactly and embed an sRGB ICC profile; PNG masters are unchanged and have no embedded ICC profile. Stars and left/right/center lighting masks are editable, static SVGs with a recorded placement map and intensity limits. No UI, account values or game logic are baked into these layers.

Run `python3 scripts/p21/export-scene-layers.py` with Pillow to reproduce the WebP and procedural SVG exports and checksum metadata. The three source PNGs are immutable generation outputs; rerunning the exporter does not regenerate or alter them. It checks canvas, alpha/profile preservation and standalone SVGs. `PROVENANCE.json` contains the exact three generation prompts, source/export hashes, formats, dimensions and fallbacks.

The positive website build allowlist deliberately does not ship this directory yet. It needs a visually approved composite, edge checks against dark/light surfaces and responsive art direction before consuming these sources. Current `hero-wide.webp` / `hero-small.webp` remain the website's still fallback. Far-ridge/cloud/vignette isolation and the rest of the 3D, motion and audio pack remain open; these assets do not close the full scene-family or release gates.
