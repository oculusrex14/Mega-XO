# P4 native app boundary + P5 identifier state (2026-10-13)

Records the exact native/app-identifier state found while taking over the native readiness work, so
the offline-only boundary and the still-open online/store items are neither overstated nor silently
skipped.

## Native builds (done)

Both targets build from the current V5.1 source (`NATIVE-BUILDS-20261013.md`): Android `app-debug.apk`
and the iOS simulator `MegaXO.app`, embedding an identical client bundle (`8d335002…`, 97 files).

## Native app boundary (verified from source)

- **Android is deliberately OFFLINE-ONLY.** `native/android/app/src/main/AndroidManifest.xml` removes
  `INTERNET`, `ACCESS_NETWORK_STATE` and `AD_ID` with `tools:node="remove"`, and there is no App Links
  `<intent-filter>` for a web host. The comment states network permissions must not be restored until
  the P05/P20-03 authenticated transport, consent, provider identity and recipient-trust checks are
  integrated. So the built APK **cannot** do shared login / online matchmaking / native↔browser
  continuity yet — that is a deliberate boundary, not a wiring bug.
- **iOS**: bundle id `online.megaxo.prototype`, `CODE_SIGNING_ALLOWED=NO`, no `.entitlements` file, no
  associated-domains capability. Offline `MegaClient/` WebKit host only.

## App identifiers / association files (mismatch recorded)

`apps/api/routes/well-known.js` serves the association files with **placeholders that do not match the
built apps**:

| File | Declared | Actual built app |
| --- | --- | --- |
| `assetlinks.json` | `package_name: com.antimatterinnovations.megaxo`, a hardcoded SHA-256 fingerprint | Android package is `megaApplicationId` (`online.megaxo.prototype` in dev); no release keystore exists, so no real signing-cert fingerprint |
| `apple-app-site-association` | `appIDs: ['TEAMID.com.antimatterinnovations.megaxo']` | iOS bundle `online.megaxo.prototype`; no Apple Team ID / App ID capability |

These are honest placeholders for a **not-yet-created** release identity. Real values require the owner
to fix the final application IDs + signing identities (P5 owner action). Until then the association
files must not be treated as configured, and the offline apps link to nothing.

## P5 provider/store readiness (from `PROVIDER-READINESS-INVENTORY-20261013.md`)

| Surface | State | Owner action |
| --- | --- | --- |
| Google Play | OWNER_ACTION_REQUIRED — no membership/app record verified; `MegaPlayBilling.kt` collapses to an empty product map and is not wired | Enroll, create app record, sign + upload |
| App Store | OWNER_ACTION_REQUIRED — no membership; `MegaStoreKit.swift` requires product IDs that exist nowhere | Enroll, App ID, StoreKit products, sign |
| AdMob | OWNER_ACTION_REQUIRED — only Google **test** app IDs; no `NSUserTrackingUsageDescription`/privacy manifest | Create real ad units + consent/ATT |
| Email | IDENTIFIER_PRESENT — real sender + live DNS (SPF/DKIM/DMARC) but no `RESEND_API_KEY` anywhere | Provide the provider key |
| DNS/domain | OWNER_ACTION_REQUIRED — `megaxo.online` Hostinger-parked | Attach at launch (`DNS-DOMAIN-ASSOCIATION-20261013.md`) |
| Store links | honestly `null` in `apps/web/store-links.json`; `/download` shows "Coming soon"; strict validator refuses anything but a real listing | Set once listings exist |

## Not claimed

No device, provider, purchase, store, or live-native acceptance is claimed. The remaining P4 online
items are blocked on the owner-authorized online native target (transport + provider identity) and the
final app IDs/signing identities, which need the owner's store accounts and devices.
