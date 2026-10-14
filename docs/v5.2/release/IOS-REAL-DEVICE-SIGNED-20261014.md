# iOS real-device milestone (2026-10-14)

For the first time in this project the iOS app is **genuinely device-signed and installed on the
owner's physical iPhone** — not a simulator. Everything below is from real command output.

## What changed

The previous state (`docs/v5.1/release/DEVICE-IOS-IPHONE16PRO-20261014.md` and the honest gap recorded
in `IOS-SURFACE-VERIFIED-20261014.md`) was: the app had only ever run in the simulator, because no
Apple signing identity existed.

That was **out of date**. Xcode on this Mac has a **free personal provisioning team** configured
(`D5TQJ76T44`, `isFreeProvisioningTeam: 1`), which the earlier audit missed. Using it:

```
xcodebuild -project native/ios/MegaXO.xcodeproj -scheme MegaXO -sdk iphoneos -configuration Debug \
  -destination 'id=00008140-0019711E2260801C' -allowProvisioningUpdates \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=D5TQJ76T44 build
```

resulted in `** BUILD SUCCEEDED **` with a real signing step:

| Field | Value |
| --- | --- |
| Signing identity | `Apple Development: oculusrexai@gmail.com (HTG9867RG9)` |
| Provisioning profile | `iOS Team Provisioning Profile: online.megaxo.prototype` |
| Bundle id | `online.megaxo.prototype` |
| Team id | `D5TQJ76T44` |
| `codesign -dv` | `Identifier=online.megaxo.prototype`, `TeamIdentifier=D5TQJ76T44`, three-level Apple chain to Apple Root CA |
| Profile expiry | `2026-10-21T15:19:30Z` (7 days — free-provisioning profile) |

Note: the plain `xcodebuild … build` without `CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Automatic`
prints `BUILD SUCCEEDED` while exporting `CODE_SIGNING_ALLOWED=NO` — an **unsigned** `iphoneos`
product. The explicit signing flags are what produce a real signed bundle; that distinction is why
the earlier attempt looked like it worked and did not.

## Installed on the real device

```
xcrun devicectl device install app --device 00008140-0019711E2260801C MegaXO.app
→ App installed:
   bundleID: online.megaxo.prototype
   installationURL: file:///private/var/containers/Bundle/Application/A022372D-9333-42FF-AAA5-87F6BC43A539/MegaXO.app/
```

Device: **Naraharikripa's iPhone**, iPhone 16 Pro (`iPhone17,1`), UDID `00008140-0019711E2260801C`.

## The exact remaining blocker

Launching is refused:

```
Unable to launch online.megaxo.prototype because it has an invalid code signature, inadequate
entitlements or its profile has not been explicitly trusted by the user.
(FBSOpenApplicationErrorDomain error 3)
```

The device reports `Developer Mode Status: Enabled (1)`, so Developer Mode is not the issue. A
free-provisioning developer app must be **explicitly trusted by the user on the device** the first
time: **Settings → General → VPN & Device Management → Developer App → "oculusrexai@gmail.com" →
Trust**. That is a physical tap on the iPhone and cannot be performed from this host.

**Owner action, 30 seconds:** trust the developer app on the phone, then run:

```
xcrun devicectl device process launch --device 00008140-0019711E2260801C online.megaxo.prototype
```

## Honest limits

- This is a **Debug, free-provisioning, 7-day** build. It is NOT a distributable/App Store build;
  that needs a paid Apple Developer Program membership (`contact@antimatterinnovations.com`, which
  the owner reports as approved — no credentials are present on this machine yet), a distribution
  certificate, an App Store provisioning profile and an App Store Connect API key.
- No entitlement inspection succeeded from the host (`codesign -d --entitlements` returned nothing),
  so get-task-allow is unknown.
- The device test matrix (login, LAN, themes, powers, ads) has **not** been run on the physical
  iPhone — only the install is proven.
- The app was left installed (allowed by the owner's instruction). No personal data was read or
  modified.
