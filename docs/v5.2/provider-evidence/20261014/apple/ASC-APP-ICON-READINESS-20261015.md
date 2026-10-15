# App Store Connect icon and build readiness — 2026-10-15

Observed 2026-10-15 02:11:49 UTC in the existing App Store Connect tab for Mega XOXO, Apple ID 6822833387. No records were edited.

The iOS version page shows version **1.0.0** with status **Prepare for Submission**. Its Build section has no selected build or build row; it shows the instruction “Upload your builds using one of several tools.” The current provider record therefore does not expose an uploaded binary for this version, so its shipped App Store icon cannot yet be verified from App Store Connect.

The page’s visible asset drop zone is for product-page media (screenshots/previews). No separate app-icon upload control appears on this version page. A navigation image labeled “Mega XOXO” is present, but without an uploaded build it does not establish the icon that will ship.

Apple’s App Store Connect help says the app icon is created in Icon Composer or added to the Xcode asset catalog, then included by uploading the build to App Store Connect. Apple’s Xcode documentation says iOS/iPadOS icon variations can be auto-generated from one 1024×1024 image in a single-size asset catalog. Thus the native release owner must place the approved icon in the native AppIcon asset catalog, produce and upload the signed build, then verify the icon extracted from that build before review. This provider observation does not establish native icon resources or physical-device correctness.

Sanitized screenshot crop: `.artifacts/v52-provider/screenshots/apple-app-readiness.jpg` (version header, Prepare for Submission status, blank Build section, and upload-tools instruction; top account header excluded).

Sources:
- [Apple: Add an app icon](https://developer.apple.com/help/app-store-connect/manage-app-information/add-an-app-icon/)
- [Apple: Configuring your app icon using an asset catalog](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)
