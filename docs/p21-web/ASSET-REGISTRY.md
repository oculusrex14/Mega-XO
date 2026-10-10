# P21 Brand Asset Registry — Mega XOXO

**Status:** Approved themed raster assets archived and reproducible. **Not** a complete brand/website art library.

## Immutable source references

| Role | Git path | Dimensions | SHA-256 |
|---|---|---|---|
| Master website concept screenshot (historically says Mega XO) | `assets/p21/reference/homepage-generated-image-1.png` | 1672×941 | `fbf558f36e67dbbc207e969e83655db59fd221f7095a52ad14c6b49bb27fc1f8` |
| Owner-provided original logo (reads MEGA XOXO) | `assets/p21/reference/brand-owner-original.png` | 1600×1600 | `af0eec08b3f554830e5a0fc95d470b20b4c8a15e3e526c99d0f07684c56cf34a` |

### Approved four-theme logo suite

Every master is a generated RGBA, transparent-background concept with alpha 0–255. Every 768px app export and 256px header mark is a transparent WebP. Mark-only variants are deterministic crops, not separately generated artwork. Reference hashes are original PNG bytes.

| Theme ID | Master | Master dimensions / SHA-256 | App export | App export dimensions / SHA-256 | Header icon | Header icon dimensions / SHA-256 |
|---|---|---|---|---|---|---|
| `vector` | `assets/p21/logos/mega-xoxo-vector.png` | 1254² PNG / 27d24c51fc10e32a3da52209255c0cbbb05d09752a0b1162f05af975d1ce1685 | `assets/p21/logos/mega-xoxo-vector-app.webp` | 768² / 5a6bdfae17c4ebd87a60f746dccb945a17c3aea9fa1d85b25c3b117fee36bd29 | `assets/p21/logos/mega-xoxo-vector-mark.webp` | 256² / 5ecf36fedc7713b04bec4921394898044d8bf62b452536e40b8258ef88c03321 |
| `midnight` | `assets/p21/logos/mega-xoxo-midnight.png` | 1254² PNG / ac052d591fe97afc98d89433134b1e3a84ce1b0df7e65b71312a337ebf6be36f | `assets/p21/logos/mega-xoxo-midnight-app.webp` | 768² / 749df0625b138994a668cfa89bb12f4817e05a826bd17243cc99da20c8fb303f | `assets/p21/logos/mega-xoxo-midnight-mark.webp` | 256² / b4becf54ff31c026b716478d9e67979277ea2b4ae373f904e4956ebcdb4f5191 |
| `paperclub` | `assets/p21/logos/mega-xoxo-paperclub.png` | 1254² PNG / a057c791f74a20f224c34421eef761a98bfde439d287c6ad0363fac007578ee3 | `assets/p21/logos/mega-xoxo-paperclub-app.webp` | 768² / 83fa3e2aa82628316c6e2b6a8732523755e685bafd08ad233e88c1f58a1ee0e3 | `assets/p21/logos/mega-xoxo-paperclub-mark.webp` | 256² / fa39ac3dc3f0fec4806c8a43d8d70d12a3cd36e719ba253c696bd12139fa8a77 |
| `afterhours` | `assets/p21/logos/mega-xoxo-afterhours.png` | 1254² PNG / caa2a8c06d0c06d9b346029c6fd22713758167a1fbf083db63c7a2762e1a4273 | `assets/p21/logos/mega-xoxo-afterhours-app.webp` | 768² / 2e4a88b52261d7f56953b6676f77d0368cfd26d859386368e833c348f10202f1 | `assets/p21/logos/mega-xoxo-afterhours-mark.webp` | 256² / 17bc84973d1c70f522541a9665caf161f94030abaf55d69ff504b82cd24a4f52 |

### Theme fidelity contracts (do not redefine or rename appearance IDs)

| Theme | Screen background/surface | X / O | Accent | Logo treatment |
|---|---|---|---|---|
| `vector` — Vector Light | `#E9ECEF` / `#F8F9FB` | `#246BFD` / `#F45669` | `#C6FF42` | Neutral silver/charcoal premium-flat mark, no glowing neon |
| `midnight` — Midnight Club | `#080B10` / `#101720` | `#6F9DFF` / `#FF7A98` | `#B9F03C` | Dark slate/indigo, green neon highlights |
| `paperclub` — Paper Club | `#B9AB8F` / `#F6EFDC` | `#2A4F9B` / `#C23A2E` | `#FFD23F` | Cream paper/black ink, warm red-orange illustrated detail |
| `afterhours` — After Hours | `#07030F` / `#0F0722` | `#2CF2FF` / `#FF4FB6` | `#FFD83D` | Arcade magenta/violet/cyan with yellow luminous highlights |

**Production integration:** the app header chooses `-mark.webp` at startup and on each theme change; the native bundle allowlist includes all eight optimized WebP files. PNG masters do **not** enter the native client. Asset IDs, player IDs, session keys and game rules are unchanged.

### Completed and pending quality gates

- [x] User confirmed name Mega XOXO and approved the four logo directions on 2026-10-10.
- [x] Original uploaded reference bytes committed unchanged in `a158389`.
- [x] Four themed 1254px masters and 768px exports committed in `fc67cfc`.
- [x] 256px transparent mark-only variants committed in `3f75527`.
- [x] Valid PNG/WebP signatures; alpha checked locally; original SHA and Git blob identities recorded.
- [x] Four theme identifiers maintained; browser and native allowlist integration committed.
- [ ] Author manually editable SVG masters; these raster concept PNGs are not vectors.
- [ ] Reconcile exact source-color tolerances in high-resolution visual QA; aesthetic approval is not pixel parity.
- [ ] Device screenshot review in real iOS/Android debug builds; source presence is not a native device result.
- [ ] Produce horizontal logo lockups, platform adaptive app icons, splash images and metadata screenshots.
- [ ] Generate clean unlettered cinematic website background, source layers and optimized/responsive exports.
- [ ] Verify app store marketing names/OAuth consent names and associated sender branding at provider level.

**Provenance:** concept imagery from the owner-supplied image and user-directed generative artwork. Model output is raster; the accompanying masters contain no editable path/source construction. Third-party fonts and logos require separate licensing/brand-guideline compliance if introduced in later phases. Do not reinterpret this document as a trademark clearance.
