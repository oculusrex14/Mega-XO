# P21 motion source candidate — 2026-10-12

This is a generated source candidate for the optional hero-motion asset in P21.06 and the commissioned P21/R16 pack. It is **not approved for release or connected to the website**. The existing still hero remains the default and was not changed. The website has no autoplay, audio, or runtime-motion behavior from this work.

The source came from one completed Higgsfield Seedance 2.5 text-to-video job (job `99452e30-3092-4bfe-a235-958c68c3d86f`). It requested a single 10-second, 16:9, 1080p, silent, locked-camera valley scene with only slow horizon haze motion. No reference image or other media was uploaded. The provider result URL, including its short-lived query, was not retained. The exact prompt, sanitized job metadata, options, and hashes are in [provider-metadata.json](../../assets/p21/motion/provider-metadata.json).

No third-party image, video, audio, sample, or music was supplied. The generated result uses the provider's model; its current licensing and usage terms have not been reviewed in this source pack.

| Asset | Format | Dimensions | Duration | Bytes | SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| `hero-provider-source.mp4` | HEVC source master, silent | 1920×1080 | 10.041667 s | 4,100,697 | `eec8cb77863393599d8b2b37535e363658e1dddd02b8cd5d25ac1feeb6be8a25` |
| `hero-loop.mp4` | H.264, silent | 1920×1080 | 9.666667 s | 1,144,605 | `651386705df3853fc29851b091c415814eb154c535973ab8bcac5cc6cea8e04d` |
| `hero-loop.webm` | VP9, silent | 1920×1080 | 9.667 s | 105,474 | `90471838d550ea6bb8729ada864b6c9dce21c9131277038b226797756025872e` |
| `hero-poster.png` | Lossless PNG still | 1280×720 | Still | 602,599 | `583965c90b4eb2aa252a8683a9fb6482172952a035f9d74cda5c7bad7e9bec1d` |

The local exporter is [export-motion.py](../../scripts/p21/export-motion.py), SHA-256 `690f901aa45d0fde4dd5ac04ea571cd788a28928781916821daaf4fab38d7d37`. It uses Python 3.14.4, FFmpeg/ffprobe 8.1.2, 24 fps, and a 0.4-second tail-to-head crossfade. H.264 uses `libx264` medium/CRF 19; VP9 uses `libvpx-vp9` CRF 33 with row multithreading disabled and one thread. The poster is a center frame from the exported MP4. No media-generation or encoding dependency was installed.

The exporter ran twice into ignored recovery directories after its parameters were fixed. Both runs decoded successfully and reported the same source metadata. MP4 and poster hashes matched across runs. The two WebM files had the same size (105,474 bytes) but different hashes (`904718…5872e` and `74a5ad…af717`), so byte-reproducibility of the VP9 output is **not established**. The run-1 WebM is the checked-in candidate; do not describe VP9 as byte-reproducible.

`ffprobe` verified dimensions, durations, codecs, and zero audio streams; full FFmpeg decode-to-null completed without errors for the source and all three final assets. A local first/middle/last sample and 1 fps contact sheet showed a fixed rocky valley/stream composition and slow violet horizon haze, with no visible letters, logo, camera travel, cuts, or flashes in those samples. First/last-frame SSIM was 0.977498. These checks do not establish human visual approval, device/browser acceptance, or an objectively seamless loop; those remain open.

Keep the poster and the current still hero as fallbacks. Any later optional-motion integration must be separately reviewed and honor `prefers-reduced-motion`, Save-Data, low battery/thermal state, and inactive tabs; pause while hidden and keep audio absent. R16 asset-pack closure and R17 browser/accessibility/device acceptance remain open. This source task did not edit application code, activate animation, change DNS, publish, or deploy.
