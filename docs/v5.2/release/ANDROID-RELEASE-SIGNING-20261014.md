# Android release signing and signed artifacts (2026-10-14)

Real command output. No credential value appears in this document or anywhere in Git.

## Owner-held upload key — created here

| Field | Value |
| --- | --- |
| Keystore | `~/Downloads/Mega-XO-private-evidence/android-release/mega-xo-upload.jks` (mode 0600 tree) |
| Credentials file | `…/android-release/upload-credentials.json` (mode 0600, **not** in Git) |
| Alias | `mega-xo-upload` |
| Algorithm | RSA 4096, validity 10000 days (to 2054-03-01) |
| Format | PKCS12 |
| Subject | `CN=Mega XO, OU=Engineering, O=Antimatter Innovations, L=Hyderabad, ST=Telangana, C=IN` |
| Certificate SHA-256 | `96:1C:C0:54:74:57:0E:60:58:4A:14:14:2B:B0:E3:D6:45:80:4B:CB:4C:16:88:62:A6:94:5E:41:75:32:93:37` |

Note: PKCS12 has **no separate key password**, so store and key passwords are identical. A first
attempt used different values and failed with `Get Key failed: Given final block not properly padded`
when signing the AAB; that is a keystore-format property, not a wrong password.

This is the **upload key only**. Google Play App Signing holds the app-signing key; with Play App
Signing enabled the upload key may be reset by the owner if it is ever lost, which is why creating it
is safe and reversible. It is not a substitute for the owner's own decision to publish.

## Signed artifacts (from V5.2 source)

Built with the repository's own contract — `MEGA_ANDROID_RELEASE_{KEYSTORE_PATH,STORE_PASSWORD,KEY_ALIAS,KEY_PASSWORD}`
plus `-PmegaApplicationId=online.megaxo.game -PmegaVersionCode=1 -PmegaVersionName=1.0.0`, which the
build's own guards require (the prototype id `online.megaxo.prototype` and an unapproved version are
refused).

| Artifact | Path | Bytes | SHA-256 |
| --- | --- | --- | --- |
| **Signed release AAB** | `native/android/app/build/outputs/bundle/onlineRelease/app-online-release.aab` | 10 169 469 | `3e61f4d05842acd38bfa123186727fd350fbca95ecd629c4911e8ea7e6498933` |
| Unsigned release APK (intermediate) | `…/apk/online/release/app-online-release-unsigned.apk` | 23 727 909 | `7f10d2ec228bea68143ee05ac9c30656ab811b65f44e7635d5070a27fb03f72a` |
| Debug APK (online flavour) | `…/apk/online/debug/app-online-debug.apk` | 27 968 067 | (regenerated per build) |

`app-online-release.aab` is **archived off-tree** at
`~/Downloads/Mega-XO-private-evidence/android-release/app-online-release.aab`, because
`native/android/app/build/**` is gitignored and the artifact must not be lost with the build tree.

Signature verified with `keytool -printcert -jarfile`:

```
Owner:  CN=Mega XO, OU=Engineering, O=Antimatter Innovations, L=Hyderabad, ST=Telangana, C=IN
Issuer: CN=Mega XO, … (self-signed upload certificate)
Valid:  2026-10-14 → 2054-03-01
SHA256: 96:1C:C0:54:…:93:37   (matches the keystore's own fingerprint)
```

Manifest declares package **`online.megaxo.game`**.

## Build defect fixed to get here

`assembleOnlineRelease` / `bundleOnlineRelease` failed with
`Gradle detected a problem … uses this output of task ':app:generateMegaClient' without declaring an
explicit or implicit dependency` for `build/generated/megaAssets` — first on
`generateOnlineReleaseLintVitalReportModel`, then on `lintVitalAnalyzeOnlineRelease`. The existing
`dependsOn(generateMegaClient)` only matched tasks named `merge*Assets`. Fixed by extending the same
explicit `dependsOn` to the lint family by name (`native/android/app/build.gradle.kts`, commit
`1f97910`). A first attempt hooked every task by inspecting inputs/outputs, which forced lazy task
properties to resolve during configuration and broke the debug build; it was replaced with the
name-based match.

## Still required before an actual Play submission

- The **Play Console account** must exist and be the owner's (`contact@antimatterinnovations.com`,
  owner-reported approved) — not something an agent can create or log into.
- Store listing, content rating, data-safety form, target-audience declaration, privacy-policy URL
  and the tester list — Codex's slice.
- Google's **closed-testing requirement for personal accounts** (if applicable) must be satisfied
  honestly; an internal/closed-test submission is not a production submission.
- The AAB above is **not yet uploaded**. Nothing has been submitted.

## Correction (2026-10-15) — the package id must be the OWNER's, not my inference

Codex correctly caught that the archived AAB declared `online.megaxo.game`, which was **my** choice, not
the owner's request. The owner asks for **`online.megaxo.xoxo`**. The bundle was rebuilt:

| Field | Value |
| --- | --- |
| Package | **`online.megaxo.xoxo`** |
| AAB | `app-online-release-online.megaxo.xoxo-v1.aab`, 10 200 224 bytes |
| SHA-256 | **`8c53c5e440aba75f0d5de41e9bc5e2c70d365581da7c0517853274d36b0604b8`** |
| Signed by | the same owner-held upload key, cert SHA-256 `96:1C:C0:54:…:93:37` |
| Superseded | the `.game` AAB (`3e61f4d0…`) must **not** be uploaded |

The iOS target still carries the prototype `online.megaxo.prototype`. That is **not** changed here:
the Apple bundle id is what entitlements, the association file, the well-known route and any store
record key off, so it changes once, in one commit, when the registered id is confirmed.
