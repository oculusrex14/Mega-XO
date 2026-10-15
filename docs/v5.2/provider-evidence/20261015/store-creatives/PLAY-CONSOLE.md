# Google Play store listing audit — 15 October 2026

This is a read-only audit of the existing Google Play Console account for the V5.2 Play listing. No developer account or app was created, no package was registered, and no assets or metadata were uploaded or changed.

## Current Console state

- Before inspection, the existing Brave tabs included App Store Connect and other work tabs, but no Play Console tab. I opened a temporary tab at Play Console and selected the existing **Antimatter Innovations** account, shown as a **Personal account**. No second developer account was created.
- The fully loaded app list says **“Create your first app”** and contains no app records or store listings. The **Create app** link is enabled. No package name or listing asset slots are present because no app record exists.
- During the initial load, the page briefly showed “Complete account verifications to create new apps” and a disabled Create app control. After the page finished loading, that message disappeared and Create app became enabled. Treat the loaded app list as the current observed state; this does not establish that any legal attestations were accepted.
- The Android developer verification page has **Package names** and **Identity** tabs and offers a **Register package name** action. I did not enter that flow or register anything.
- Prior owner handoff says the Personal account was approved and an earlier creation attempt stopped at three formal attestations. I did not open or alter those attestations. The current Console shows an enabled Create app link, so the earlier checkpoint and current UI should be reconciled by the owner before any app record is created.
- The planned package name supplied by the V5.2 integration handoff is `online.megaxo.xoxo`; it is not present in Play Console because there is no app record.

## Official listing requirements

The current [Play Console Help: Add preview assets](https://support.google.com/googleplay/android-developer/answer/9866151) page specifies:

| Slot | Requirement | Useful production target |
| --- | --- | --- |
| App icon | Required; 512 × 512 px, 32-bit PNG with alpha, at most 1,024 KB | Use the existing native Play icon if final visual review accepts it. |
| Feature graphic | Required; 1,024 × 500 px, JPEG or 24-bit PNG without alpha | Keep the board/game focal point and any key message near the center; avoid crop zones and an oversized duplicate of the app icon. |
| Screenshots | At least 2 across device types to publish; up to 8 per supported device type. JPEG or 24-bit PNG without alpha; each side 320–3,840 px, with the longest side no more than twice the shortest. | For game discovery eligibility, Google recommends at least 3 gameplay screenshots in either 16:9 landscape (minimum 1,920 × 1,080) or 9:16 portrait (minimum 1,080 × 1,920). Use real current gameplay and keep any tagline to at most 20% of the image. |
| Tablet / Chromebook screenshots | If supplied, the large-screen guidance asks for at least 4; 1,080–7,680 px and 16:9 landscape or 9:16 portrait. | Only prepare these for supported large-screen experiences. |

The documented screenshot device types are phones, 7-inch and 10-inch tablets, Chromebooks, Android TV, Wear OS, Android Automotive OS, and Android XR. The Console does not yet expose this app’s device-specific upload slots.

Google’s [Create and set up your app](https://support.google.com/googleplay/android-developer/answer/9859152) guide gives listing text limits: app name 30 characters, short description 80 characters, and full description 4,000 characters. The [metadata policy](https://support.google.com/googleplay/android-developer/answer/9898842) prohibits misleading claims and ranking, award, price, or promotional language in the title, icon, and listing. The preview-assets guidance also says screenshots should show the actual app experience; avoid store badges and unrelated device imagery. It recommends avoiding pure white, black, or dark gray for the feature graphic because those can blend into Play surfaces.

## Local icon check

The existing [play-store-512.png](</Users/oculus/.codex/worktrees/v52-provider-release/Test XO/assets/p21/icons/native/play-store-512.png>) is a 512 × 512 RGBA PNG and is 172,967 bytes, within the Play icon’s stated dimensions, format, and size limit. This checks file properties only, not visual or policy approval.

## Safe next steps

1. Prepare the feature graphic and native screenshot set offline from the current Android UI. Keep every depicted feature available in the shipped build and avoid implying unverified tutorial, bot difficulty, or commerce behavior.
2. Reconcile the earlier three-attestation checkpoint with the current enabled Create app control. After the owner resolves that account-level choice, the owner can decide whether to create the app record for `online.megaxo.xoxo`; this audit did not take that step.
3. Once an app record exists, verify the exact device-specific slots shown in its Main store listing before uploading assets. Google says listing assets can appear across test tracks and may be used for Google Play promotion, so upload only approved final assets.
