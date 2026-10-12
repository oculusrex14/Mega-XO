# Browser icon exports

These eight raster exports resize the approved icon-only emblem without replacing or redrawing its master. The transparent alpha bounds are cropped once, then centered on each canvas. Apple and maskable icons have an opaque `#030917` background. The maskable emblem fits inside the central 40%-radius safe circle.

`PROVENANCE.json` records source, profile and output hashes, dimensions, crop and Pillow version. Run `python3 scripts/p21/export-icons.py` with Pillow to regenerate. The frozen sRGB profile avoids timestamp-dependent export hashes. Favicon ICO contains 16, 32 and 48 pixel entries; PNG versions, a 180 pixel Apple icon and 192/512 pixel PWA icons are provided.

P21-K019 remains partial: the editable SVG favicon and monochrome mask icon have not been produced. These exports do not establish physical Safari/Android installation acceptance or alter any native launcher identity.
