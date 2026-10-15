# V5.2 store key art — drafts

These are standalone marketing illustrations, **not app or gameplay screenshots**. The manifest
records `key-art-source.png` as generated with the built-in image generator. The existing approved
Mega XOXO logo was composited with its proportions retained.

`scripts/store/export-creatives.py` creates the three compositions by cropping/resizing the source
art, adding layout scrims, compositing the logo and rasterizing captions. It uses Pillow, the system
Avenir Next font and the repository's sRGB profile; the font is not redistributed.

| Draft export | Dimensions |
| --- | --- |
| Apple product-page header | 3840 × 1646 |
| Apple search-results image | 1920 × 1280 |
| Google Play feature graphic | 1024 × 500 |

`manifest.json` records RGB output properties, source provenance, captions, alt text and SHA-256
digests. `creative-preview.jpg` is a review contact sheet, not an upload asset. The three exports'
dimensions, RGB PNG type, byte counts and hashes were checked locally on 15 October 2026; source-art
and brand hashes also match the manifest.

Status: **CREATIVE_DRAFTS_NOT_SUBMITTED**. No upload, store preview acceptance, submission or approval
is established by these files. Marketing UI captures remain deferred under the owner's instruction
until the missing powers work is complete. No screenshots are included, and the drafts do not
advertise powers, ad earning, online availability, ratings, awards or store approval.
