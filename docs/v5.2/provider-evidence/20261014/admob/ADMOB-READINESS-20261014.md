# AdMob readiness revalidation — 14 October 2026

## Scope and evidence boundary

Read-only inspection of the existing AdMob publisher in the existing Brave AdMob tab, plus unauthenticated HTTPS GETs to the production-domain seller and privacy paths. The browser inspection was completed during the 2026-10-14 16:39–16:45 UTC window. The public GET response headers provide exact UTC timestamps below. Current repository source was inspected at `05c0064055b89178d07ddea0bd4ced7974fb9820`.

The publisher code shown by the AdMob UMP embed was `pub-5255314563073178`. The app selector showed the two expected records, Mega XOXO Android and Mega XOXO iOS. No app, unit, store association, message, callback, or serving setting was added or changed. The Publisher data page was not opened; no account agreement, legal attestation, MFA, or payment action was taken.

## Live console records

| Platform | Existing AdMob app | Placement | Existing unit ID | Console configuration |
| --- | --- | --- | --- | --- |
| Android | `ca-app-pub-5255314563073178~4393199164` | Rewarded | `ca-app-pub-5255314563073178/9122606653` | Reward amount `1`, item `cosmetic_reward`; SSV callback not set |
| Android | `ca-app-pub-5255314563073178~4393199164` | Interstitial | `ca-app-pub-5255314563073178/5293761020` | Interstitial; no reward configured |
| iOS | `ca-app-pub-5255314563073178~3080117498` | Rewarded | `ca-app-pub-5255314563073178/3009633608` | Reward amount `1`, item `cosmetic_reward`; SSV callback not set |
| iOS | `ca-app-pub-5255314563073178~3080117498` | Interstitial | `ca-app-pub-5255314563073178/5652853678` | Interstitial; no reward configured |

Each app’s unit list contained exactly these two rows (`1–2 of 2`); no duplicate app or unit was visible. The rewarded-unit editor’s “Set up and verify callback URL” dialog was opened for each rewarded unit and then canceled without saving. Both callback URL, optional test user ID, and optional test custom-data fields were empty, and both **Verify URL** and **Use verified URL** controls were disabled. No callback is configured or verified in AdMob.

Both app overviews showed **Requires review**. The current overview comparison (Last 7 days vs previous 7 days) displayed `$0.00`, zero requests, and zero impressions for both periods. The overview’s today/yesterday/month/last-month earnings were also `$0.00`. Both App settings pages showed App store details as `—` with an **Add** action; no Android or iOS store listing is linked. These are current dashboard observations, not a claim of lifetime statistics or store approval.

## Consent messages and settings

The Privacy & messaging overview surfaced only **Create a new message** for European regulations, US state regulations, and the iOS IDFA explainer. No existing published message or editable draft was surfaced for any of these message types. No message was created.

The European-regulations settings page showed `0 purposes selected` and a disabled Save button. Visible account settings were: “Automatically add ad sources as ad partners” off; “Allow Google to maximize message coverage” on; RTB creative consent check off; legitimate-interest controls on with “Enable by default” on; advertising consent mode off; special feature 2 off; and no consent-sync apps. The separate US-state settings page showed 335 active ad partners and disabled Save/Undo controls. No setting was changed. No account-specific age/guardian declaration or test-device/forced-geography result was established by these pages.

Google’s current platform setup guides require a message to be created in AdMob, UMP consent information to be refreshed at each app launch, required consent forms to be shown, ad requests to be gated on the SDK consent result, and a visible, interactive privacy-options entry point when the SDK reports it is required. The guides also describe testing with registered test devices and forced geography. References: [Google UMP setup for Android](https://developers.google.com/admob/android/privacy) and [Google UMP setup for iOS](https://developers.google.com/admob/ios/privacy) (reviewed 2026-10-14; the iOS page reported last updated 2026-10-13 UTC).

## Public declarations

The local source file `public/app-ads.txt` contains the expected seller row:

```text
google.com, pub-5255314563073178, DIRECT, f08c47fec0942fa0
```

Live HTTPS checks did not verify deployment:

| Requested path | Response observed | Result |
| --- | --- | --- |
| `https://megaxo.online/app-ads.txt` | 2026-10-14 16:38:29 UTC; HTTP/2 200; `content-type: text/html`; Hostinger `hcdn` | Body title: `Parked Domain name on Hostinger DNS system`; seller declaration is not served |
| `https://megaxo.online/privacy` | 2026-10-14 16:39:12 UTC; HTTP/2 200; `content-type: text/html`; Hostinger `hcdn` | Same parked-domain page; no usable public privacy notice |

The local seller-file bytes and the parked-domain responses are separate facts: the source file is not evidence that the public path serves it. The public `app-ads.txt` declaration and privacy notice remain unverified until a coordinated deployment/domain change and a fresh public GET confirms exact content and MIME type.

## Current-source and native integration review

This is static inspection of V5.2 source at `05c0064055b89178d07ddea0bd4ced7974fb9820`, not a build, device run, or provider acceptance test.

- Android includes UMP 4.0.0 and Google Mobile Ads Next-Gen dependencies. `MegaAndroidAds` contains consent update, required-form, privacy-options, `canRequestAds`, and ad-display methods (`native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt:17`). It is deliberately not instantiated. `MegaXOActivity` says there is no ad stub and installs no ads bridge (`native/android/app/src/main/java/online/megaxo/prototype/MegaXOActivity.kt:23`). Its manifest app ID defaults to Google’s test app ID unless the Gradle `megaAdMobAppId` property is supplied (`native/android/app/build.gradle.kts:111`).
- iOS includes the UMP and Google Mobile Ads packages. `MegaIOSAds` has consent and privacy-options methods but explicitly says it is not wired into the signed client (`native/ios/MegaXO/MegaIOSAds.swift:6`). `MegaXOApplication` wires theme, LAN, identity, and API services, but does not create or expose `MegaIOSAds` (`native/ios/MegaXO/MegaXOApplication.swift:45`). The Debug project setting uses Google’s test app ID; the Release setting does not define `MEGA_ADMOB_APP_ID` (`native/ios/MegaXO.xcodeproj/project.pbxproj:88`).
- The web monetization UI expects `window.MegaAds` for consent readiness and privacy options. Its privacy-options button is disabled when that bridge method is absent (`src/monetization-ui.js:12`, `src/monetization-ui.js:38`). Neither native host currently bootstraps `window.MegaAds`. Thus the current source contains UMP helper code but does not establish an end-user consent or persistent privacy-options flow in a signed native app.
- The Android consent request uses default `ConsentRequestParameters`; iOS uses default `RequestParameters`. No age/guardian state is passed by these current adapters. Age-appropriate consent and advertising readiness remain unverified.
- The current UI and commerce service still offer `credits` or `boost` rewards, show four rewarded opportunities per UTC day, and map the fixed AdMob item `cosmetic_reward` to those legacy reward kinds (`src/monetization-ui.js:31`, `src/monetization-ui.js:32`, `packages/services/commerce.js:310`). This source does not yet express the owner’s V5.2 power-ticket mapping or ten-per-day aggregate exposure ceiling. The console’s `1 cosmetic_reward` is therefore recorded as the provider payload only; it is not represented here as an Undo/Tactical power entitlement.
- The source defines a provider-authenticated AdMob SSV GET route and an ECDSA verifier (`packages/contracts/routes.js:116`, `server/admob-ssv.js`); the commerce callback binds verified actor, ticket, ad unit, timestamps, and provider transaction ID. Production enables the verifier only when ads mode is not `off` (`server/production/main.js`). This is code-level evidence only. No current production HTTPS callback URL, deployed-handler proof, live signature/idempotency acceptance, or current actor-to-power ticket mapping was supplied in this run. No staging or parked-domain URL was entered in AdMob.

The V5.2 execution board remains the release authority for ad serving: serving is off pending AM09–AM18 and provider review. This browser review generated no ad request or impression. Native test-device acceptance, age/privacy disclosures, the current public callback proof, and signed Android/iOS acceptance remain separate gates.

## Main handoff requirements

1. Provide a usable, truthful public privacy notice on the production domain. Recheck its exact HTTPS response before creating or publishing any consent message. The current parked page cannot be used in AdMob disclosures.
2. Freeze the authoritative V5.2 mapping from each rewarded placement’s fixed `cosmetic_reward` / amount-1 provider payload to the precise Core-issued ticket and user-visible promise. Update the current four-per-day credits/boost implementation to the owner-approved V5.2 power mapping and ten-per-day aggregate limit before calling the provider setup complete.
3. Supply the exact **production HTTPS** SSV callback URL only after the current public handler is verified for AdMob ECDSA keys/signatures, transaction idempotency, actor-ticket-platform-unit binding, timestamp/expiry checks, and the agreed ticket/reward mapping. Then configure the two existing rewarded units and capture AdMob’s verification result. Do not use a staging endpoint, the parked privacy URL, or a real ad impression for verification.
4. Wire the existing native UMP helpers into Android/iOS app lifecycle and a typed `window.MegaAds` bridge; use test app/unit IDs in non-distributing builds and the verified existing production IDs only in the authorized release configuration. Gate all requests on UMP consent state and expose privacy options according to the SDK status. Add the owner-approved age/guardian state without inferring age.
5. Run provider-sanctioned UMP forced-geography and test-ad acceptance on the actual Android/iOS builds and devices. This evidence contains no build, signed-device, app-review, or live-serving acceptance.
6. After coordinated website/domain deployment, repeat public `app-ads.txt` and privacy GETs and record the actual status, exact body, and MIME type. Do not treat local `public/app-ads.txt` as deployed proof.
7. Any AdMob Publisher data agreement, legal/account-holder attestation, or owner-only MFA step remains for the owner/root; none was accepted or attempted here.

## Actions not performed

No AdMob app/unit was added or deleted; no reward value was changed; no UMP draft or message was created, edited, or published; no callback was entered, tested, saved, or verified; no store listing was linked; no publisher agreement was accepted; no live or test ad was served; and no source file was changed or committed. No tests were run. The existing AdMob tab is left at Mega XOXO Android App settings for a future authorized continuation.
