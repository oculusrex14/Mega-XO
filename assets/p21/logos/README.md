# Mega XOXO official themed brand art

**Approved product name:** Mega XOXO; **website domain remains** `megaxo.online`.

The four theme variants match the existing `docs/THEMES.md` contracts. Original generated transparent 1254px PNGs, app-optimized 768px WebPs, and 256px **mark-only** WebPs are all preserved on V5.1.

| Theme | Full master | Full UI image | Small mark | Small mark SHA256 |
|---|---|---|---|---|
| vector | `mega-xoxo-vector.png` | `mega-xoxo-vector-app.webp` | `mega-xoxo-vector-mark.webp` | `5ecf36fedc7713b04bec4921394898044d8bf62b452536e40b8258ef88c03321` |
| midnight | `mega-xoxo-midnight.png` | `mega-xoxo-midnight-app.webp` | `mega-xoxo-midnight-mark.webp` | `b4becf54ff31c026b716478d9e67979277ea2b4ae373f904e4956ebcdb4f5191` |
| paperclub | `mega-xoxo-paperclub.png` | `mega-xoxo-paperclub-app.webp` | `mega-xoxo-paperclub-mark.webp` | `fa39ac3dc3f0fec4806c8a43d8d70d12a3cd36e719ba253c696bd12139fa8a77` |
| afterhours | `mega-xoxo-afterhours.png` | `mega-xoxo-afterhours-app.webp` | `mega-xoxo-afterhours-mark.webp` | `17bc84973d1c70f522541a9665caf161f94030abaf55d69ff504b82cd24a4f52` |

The mark-only asset is a true-alpha, deterministic crop of the matching generated PNG, rather than new image generation. Native bundles should include only the eight optimized WebP files, not the high-resolution source masters. These are artwork renders, **not** a manually traced editable vector master. The app's existing appearance IDs are unchanged: `vector`, `midnight`, `paperclub`, `afterhours`.

**Note:** Native app launcher icons, splash screens, store listings and horizontal header lockups are separate assets/acceptance tasks. A transparent PNG does not itself satisfy platform launcher adaptive-icon requirements.
