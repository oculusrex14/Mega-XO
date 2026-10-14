# Apple Developer account access checkpoint — 2026-10-14

**Observed:** 2026-10-14 16:38 UTC  
**Portal:** Apple Developer account (`developer.apple.com/account/`)  
**Action:** Opened a dedicated Brave tab and entered the owner-designated account identifier into Apple's sign-in form. Apple advanced to the password step. No password, verification code, recovery credential, or legal attestation was entered or accepted.

**Owner authentication completed:** the same tab was available at the Apple Developer account home after the owner handoff. All observations below are read-only. Personal name, address, and phone details shown in the portals are intentionally omitted.

## Provider state

The initial 16:38 checkpoint stopped at the password challenge. After the owner completed authentication, these provider states were verified read-only:

- The Apple Developer portal shows an active Apple Developer Program Individual membership, Team ID `6N6C9338NX`, and renewal date 2027-10-15. The annual program fee is shown as US$99.
- The Apple Developer Program License Agreement and Apple Developer Agreement each show Accepted 2026-10-14.
- App Store Connect Users & Access lists the designated account as **Account Holder** and **Admin**, with **All Apps** access.
- App Store Connect Apps reports **No Apps**. The Apple Developer Certificates, Identifiers, Profiles, and Keys inventories each show their “Getting Started” empty state. No bundle identifier or store app is registered under this team.
- App Store Connect Business shows the **Free Apps Agreement** as Active for all regions from 2026-10-14 through 2027-10-14. The **Paid Apps Agreement** is **New**; Apple states legal-entity information must be updated before signing it. No legal details were edited, and the agreement was not opened or accepted.
- An App Store Connect Terms of Service dialog appeared once during navigation. It was not accepted; it disappeared without agent interaction before subsequent read-only pages loaded. Its acceptance state is therefore not claimed.

## Local project identifiers are not provider records

- The current iOS project and physical-device evidence use `online.megaxo.prototype` with free Personal Team `D5TQJ76T44`; the documented development profile expires 2026-10-21. This is not proof of a paid distribution team or an App Store-eligible App ID.
- Xcode Debug and Release settings both use `online.megaxo.prototype` and `CODE_SIGNING_ALLOWED=NO`. The checked-in version is `0.1.0` / build `1`; API origin is empty, Apple native sign-in is disabled, and the iOS AdMob value is a Google test identifier.
- `MegaStoreKit` requires mappings for `crowns_100`, `crowns_525`, `crowns_1100`, and `remove_ads`, but the checked-in `Info.plist` contains no `MegaStoreProductIDs` mapping. The local `native/ios` tree has no `.entitlements` file or AppIcon asset. These are local preparation gaps, not claims about ASC state.
- The native README says the cookie-free native account routes are not mounted by the live API. Enabling Sign in with Apple in Apple Developer alone would not make native authentication release-ready; Main must first verify the audience, native challenge/token path, final bundle ID, and backend deployment.
- `online.megaxo.xoxo` remains an owner-selected target from prior planning; neither availability nor registration was verified here.
- No identifier or store record was created while the provider account and the final Android/iOS identity pairing remain unresolved.

## Next unblocking step

The owner completed authentication. Main must first confirm the single accepted iOS/Android identifier pairing. The team inventory contains no existing App IDs, but global availability of `online.megaxo.xoxo` was not tested; no App ID creation flow was used as an availability probe. After Main confirms the exact ID, an authorized registration may be performed if Apple confirms it is available.

The Paid Apps Agreement is not active. Apple requires legal-entity information to be updated before it can be signed; this is an owner action, as is accepting any binding agreement. After identity reconciliation, Main must supply the accepted signed V5.2 IPA/archive and exact build number, production URLs/reviewer account, approved privacy and product mappings, server-notification target, and release acceptance before a store upload or App Review submission. Apple-side pricing, age/privacy, export-compliance, rights, reviewer, screenshot, TestFlight, and review states remain unverified and must be answered from the actual implementation/provider forms.

No screenshots or credential material are retained in this evidence packet.

## Registration, capabilities, and listing preparation (no changes applied)

### App ID and capabilities

- Candidate bundle ID: `online.megaxo.xoxo` (owner-selected target, not yet accepted by Main for the V5.2 native release). The paid team inventory is empty. Availability outside this team remains unknown; the App ID creation flow was not used as an availability probe.
- App ID registration, certificate creation, profile generation, API-key creation, and ASC app creation are all pending Main's final Android/iOS identifier acknowledgment. The currently built iOS target is still `online.megaxo.prototype` and code signing is disabled.
- **Sign in with Apple: leave off for the present target.** The native adapter is compiled but `MEGA_APPLE_NATIVE_ENABLED=NO`; the native auth routes are not mounted by the documented live API. Main must confirm the audience, challenge/token routes, production deployment, and shipped feature state before this capability is enabled.
- **Associated Domains: leave off.** No iOS entitlement is present and the current app has no verified production app-link relationship. Enable only if Main confirms universal links or another required domain association, with the public AASA updated for the exact Team ID and final bundle ID.
- **Push Notifications: leave off.** The target has optional local notifications only; no APNs registration or device-token backend flow is present. Local notifications do not establish APNs readiness.
- No other App ID capability is currently evidenced as required. In-app purchases are configured in App Store Connect and are separately blocked by the Paid Apps Agreement and missing product mappings.

### App Store Connect form values

| Field | Prepared value | State / dependency |
| --- | --- | --- |
| Platform | iOS | Ready |
| App name | Mega XOXO | Matches `CFBundleDisplayName`; still validate exact release branding with Main |
| Primary language | English | Source development region is `en`; select the final store locale only after owner confirmation |
| Bundle ID | `online.megaxo.xoxo` candidate | Do not select/create until Main confirms the single release identity; no App ID exists under this team |
| SKU | Not supplied | Internal SKU is not in source or owner decisions; do not invent |
| Category | Games; Board is a candidate subcategory | Confirm available ASC choices and final product classification when creating the record |
| Price and availability | Not supplied | Free Apps Agreement is active; region/pricing decisions are not established |
| Support/privacy URLs | Production URLs not verified | Use only after Main confirms public production deployment and published policies |
| Age rating and privacy details | Not filled | Complete against exact accepted signed build, SDK behavior, audience and current Apple questionnaire |
| Description, subtitle, keywords, promotional text, screenshots, preview, icon | Not supplied/verified | Need release assets and owner-approved store copy; no iOS AppIcon asset is in the current native tree |
| IAPs | Keys only: `crowns_100`, `crowns_525`, `crowns_1100`, `remove_ads` | Actual ASC product IDs, names, prices, and review metadata absent; Paid Apps Agreement is New and legal-entity update is owner-only |
| Review notes/access | Not supplied | Needs exact production/test endpoint and dedicated working reviewer account; do not enter credentials into a draft |
| Export compliance/content rights/EU trader status | Unverified | No owner attestations submitted; the EU trader notice is visible in ASC |

No ASC app-creation or metadata form was opened or saved, and no customer-facing or legal answer was entered.

### iOS dependency and data-flow facts for privacy preparation

- The Xcode target links third-party Swift packages **Google Mobile Ads 13.2.0** and **Google User Messaging Platform 3.0.0**. The `MegaIOSAds` adapter contains UMP consent/privacy-options and AdMob rewarded/interstitial code, but `MegaXOApplication` does not instantiate/expose it. Debug uses Google's test app ID; Release does not define `MEGA_ADMOB_APP_ID`. Ad serving is not established by the linked packages.
- The target uses Apple's `AuthenticationServices`, `StoreKit`, `UserNotifications`, `Network.framework`, `WebKit`, and `Security` APIs. The native API origin is empty in checked-in Debug and Release settings, Apple sign-in is disabled, and StoreKit has no `MegaStoreProductIDs` mapping. The target requests local-network access for Bonjour/LAN rooms and supports optional local notifications. Its refresh credential vault is device-only Keychain storage.
- No ATT/IDFA API reference, analytics/crash-reporting package, `.entitlements` file, app-owned `PrivacyInfo.xcprivacy`, or native AppIcon asset is present in the inspected iOS project. This does not verify the final resolved SDK manifests or final build. Privacy labels, ATT decisions, and export answers remain **unanswered** until Main provides the final signed-build data-flow/SDK manifest.
- Current target settings are prototype Debug/Release (0.1.0 build 1, signing disabled); they are not the final V5.2 distribution binary. Store metadata and privacy declarations must be rechecked against the accepted signed artifact.
