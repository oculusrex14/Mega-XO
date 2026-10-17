# Build Artifact Manifest

## Release artifacts (verified this audit)

| Artifact | SHA-256 (prefix) | Size | Package / id | Notes |
|---|---|---|---|---|
| Website-served Android release APK | d01d35ee54620bc7... | 23,982,197 bytes | online.megaxo.game v1.0.0, minSdk 28 | API origin https://megaxo.online baked in; upload-key cert 961cc054... verified; ships from /downloads/android/megaxo-1.0.0.apk |
| App review bundle (dev) | d3e3ff60687d65bb... | - | online.megaxo.xoxo | matches both phones dev installs |
| Web bundle (final audit head) | tracked in .artifacts/final-review-web manifest + p21 manifest (bundle_sha256 recorded per CI run) | - | website + retained client | 170 files at the 24cfb21+ build; revalidated every CI browser lane |

## CI-verified artifact checks

- "Verify exact Android/iOS client bytes" — pass (run set on 446b68b).
- "Source provenance and conservative impact" — pass (exact-SHA provenance).
- assetlinks association covers BOTH application ids (p11 + native-online-target contracts).

## Signature chain

- Android upload key fingerprint: 96:1C:C0:54:74:57:0E:60:58:4A:14:14:2B:B0:E3:D6:45:80:4B:CB:4C:16:88:62:A6:94:5E:41:75:32:93:37 (owner-held; served in assetlinks).
- Play App Signing certificate: unknown until first AAB upload — add it to assetlinks afterwards (both may be listed).
- iOS identity C4A58D40FBAA9083E6F12B863097CFF1E586453A (team D5TQJ76T44); profile expires 2026-10-21.

## Not produced this audit

- Android AAB (Play upload requires it; the APK covers direct distribution).
- iOS IPA/archive for TestFlight (profile renewal first).
- No artifact was uploaded to any store; no store console was touched.
