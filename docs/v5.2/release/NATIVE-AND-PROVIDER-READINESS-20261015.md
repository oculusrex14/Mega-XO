# Native engineering + provider readiness audit (2026-10-15)

Objective priorities (4) and (5), audited against current artifacts and live provider state.

## (4) Native engineering

### Builds and signing

| Artifact | Reference | Verified how |
| --- | --- | --- |
| Android online debug APK | sha256 `549baff9c65b9e3afff904392f091e22f414a533fc90b7fcf00e9eff65377554`, from `c172aa57`, 102-file client bundle | built by Gradle; **installed and driven on the physical OnePlus** (real Bot match, powers row rendered at 8 plies) |
| Android signed AAB | `app-online-release-online.megaxo.xoxo-v1.aab`, 10 200 224 bytes, sha256 `8c53c5e440aba75f0d5de41e9bc5e2c70d365581da7c0517853274d36b0604b8` | `jarsigner -verify` → **"jar verified."**; cert `CN=Mega XO, OU=Engineering, O=Antimatter Innovations` |
| iOS app (device) | signed `Apple Development: oculusrexai@gmail.com (HTG9867RG9)`, `TeamIdentifier=D5TQJ76T44`, bundle `online.megaxo.prototype` | signed, installed and launched on the physical iPhone 16 Pro; client bundle byte-identical to the Android one |
| iOS app (simulator) | same project, `Debug-iphonesimulator` | **built, installed and launched** on a booted iPhone 17 Pro simulator; screenshot `docs/v5.2/evidence/ios-simulator-launch-20261015.png` shows the full first-run UI (all four auth choices, the board graphic, the theme) — not a blank WebView |

### Simulator/emulator status, stated plainly

- **iOS simulator: verified.** Build + install + launch + rendered UI, with a screenshot.
- **Android emulator: NOT verified in this session.** The `system-images;android-35;google_apis;arm64-v8a`
  package on this machine is an installer stub only (`du` = 4 KB, no `kernel-ranchu`); the emulator
  refuses to boot it, and the re-install crashed inside `unzip` because the host volume is at 100% with
  ~555 MB free. Installing the ~1.5 GB image needs the owner to free space or authorize the T9 volume
  (mounted, 860 GB free) as the SDK/cache root — the owner's stated policy keeps native SDK caches off
  T9, so this is left to them. The Android evidence that *does* exist is stronger than an emulator:
  the real physical-device pass and the signature-verified AAB.

## (5) Provider / store / account readiness

### Identifiers published live (from the production origin)

`GET /.well-known/assetlinks.json` → `online.megaxo.xoxo`, one fingerprint
`96:1C:C0:54:74:57:0E:60:58:4A:14:14:2B:B0:E3:D6:45:80:4B:CB:4C:16:88:62:A6:94:5E:41:75:32:93:37`
(the owner-held upload key's own fingerprint, verified in `ANDROID-RELEASE-SIGNING-20261014.md`).

`GET /.well-known/apple-app-site-association` → `appIDs: ["TEAMID.online.megaxo.xoxo"]` with
`/auth/*`, `/community/*`, `/legal/*` components.

### A real defect this audit found and fixed: OAuth callback false success

Live production answered a bogus `/auth/callback/google?state=fake&code=fake` with
`303 → /?account=linked`. The handler validated the parameters and then declared success without any
provider exchange, one-use-attempt consumption, identity verification or session rotation — while the
route inventory requires exactly those and the V5 production entry composes no identity provider at all.
It is now fail-closed (`?authError=PROVIDER_SIGNIN_UNAVAILABLE`) unless a composed web sign-in lane is
supplied, in which case the real exchange runs and only its success links (`d61e5ed`). Both the Oracle
authority and the Vercel API were redeployed and re-verified live.

### Remaining provider items (owner-scoped)

| Item | State |
| --- | --- |
| Apple Team ID in the association file | still the literal `TEAMID`; the team that signs the current build (`D5TQJ76T44`) is free personal provisioning, not necessarily the store team. The owner must supply the permanent Team ID. |
| Android upload keystore behind the published fingerprint | the AAB is signed by the owner-held key whose fingerprint is published; the keystore lives off-tree. Confirmed consistent. |
| Store listings / submission | none performed; no listing, no review. |
| Ads / SKUs | AdMob test IDs only; no live inventory, no purchase SKU configured, no provider approval. |
| Email | the production authority composes no outbound mail provider (`outbound.email: disabled`), by design. |
| Privacy/consent | DC00 research-consent and retention lane deployed and gate-passed on staging. |
