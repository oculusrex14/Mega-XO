# Native launcher and store icon exports

These files package the existing owner-approved Mega XOXO emblem. The master at
`assets/p21/logos/mega-xoxo-icon-only-logo.png` remains byte-identical; no artwork
was redrawn, generated, traced or relabelled as a new native theme.

Run `python3 scripts/v5/export-native-icons.py --preview` with Pillow 12.3.0.
Use `--check` to regenerate in memory and reject missing or changed exports
without writing. The generator pins the master and frozen sRGB profile hashes;
`PROVENANCE.json` records output bytes, dimensions, modes and geometry. The
preview is saved under ignored `.artifacts/native-icons/`.

`srgb.icc` preserves the exact 588-byte frozen profile embedded in the existing
`pwa-512.png` export (SHA-256 `85ecec0f261679a58a1a9228e33abedc31c0ae56f3c4b3f783aaa791fa53f2ac`).
The historical `assets/p21/scene-layers/srgb.icc` path is absent from this tree;
the profile is copied byte-for-byte, rather than regenerated with a timestamp.

- iOS uses one opaque RGB 1024 × 1024 PNG on `#030917`, with the cropped emblem
  centered at 80% of the canvas, matching the existing Apple browser treatment.
  The asset compiler generates smaller sizes and the system applies corner masks.
- Android uses separate transparent foreground and opaque `#030917` background
  layers. Five density PNGs represent a 108dp layer; the emblem occupies 55% of the layer bounds.
  Every rendered nonzero-alpha pixel, including the halo, is checked inside the
  central **66dp diameter circle**. No PWA mask-safe-area assumption is used.
  Both launcher manifest attributes select the same adaptive icon. No new
  monochrome artwork is introduced; the existing notification icon is unchanged.
- `play-store-512.png` is a 512 × 512, 32-bit RGBA PNG, with alpha 255 everywhere,
  sRGB and a full square opaque background. Store masking/shadows remain external.

Official format references:
[Apple asset-catalog app icons](https://developer.apple.com/documentation/xcode/configuring-your-app-icon),
[Android adaptive icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive),
[Google Play listing icons](https://developer.android.com/distribute/google-play/resources/icon-design-specifications).

The preview simulates a central 72dp Android launcher viewport with circle and
squircle masks at readable sizes. It is not physical-device acceptance. Native
archive/resource compilation, signed-device appearance and store submission or
approval are separate evidence; these exports do not alter signing or app IDs.
