# Mega XO store privacy declaration working sheet

Status: **DRAFT — VERIFY AGAINST THE EXACT NATIVE BUILD BEFORE SUBMISSION**  
Draft date: 2026-10-07

This is the working sheet for Apple App Privacy and Google Play Data safety. It is intentionally conservative and must be updated for the exact SDK versions/configuration in the submitted iOS/Android binaries.

Official references used for this draft:

- Apple App Privacy: https://developer.apple.com/app-store/app-privacy-details/
- Apple App Store Connect privacy management: https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy
- Apple account deletion: https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/
- Google Play Data safety: https://support.google.com/googleplay/android-developer/answer/10787469
- Google Play User Data/account deletion policy: https://support.google.com/googleplay/android-developer/answer/10144311
- Google Play account deletion details: https://support.google.com/googleplay/android-developer/answer/13327111

## Public URLs

Planned production URLs:

- Privacy Policy: `https://play.antimatterinnovations.com/privacy`
- Privacy choices: `https://play.antimatterinnovations.com/privacy-choices`
- Account deletion: `https://play.antimatterinnovations.com/delete-account`
- Support: `https://play.antimatterinnovations.com/support`
- Terms: `https://play.antimatterinnovations.com/terms`

The Privacy Policy and Terms remain draft/noindex until approved.

# Apple App Privacy candidate answers

Apple requires disclosure of data collected by the developer **and third-party partners in the app**. The final answers must include any data collected by Google/Apple/AdMob or another embedded SDK, even if Mega XO's own backend does not collect it.

| Apple data type | Current Mega XO first-party behavior | Linked to user? | Purpose | Tracking? | Release note |
| --- | --- | --- | --- | --- | --- |
| Email Address | collected for email sign-in/recovery/security mail | yes | App Functionality | no | disclose |
| User ID | player ID/tag/username and provider account subject used for identity | yes | App Functionality | no | disclose |
| Gameplay Content | cloud practice save, multiplayer/match state, match history, ratings/rank/season/tournament records | yes | App Functionality | no | disclose |
| Other User Content | optional player-report free text/category | yes | App Functionality / safety | no | disclose conservatively |
| Purchase History | product/transaction/entitlement/refund state | yes | App Functionality | no | disclose when store purchases ship |
| Other Diagnostic Data | MX support correlation, normalized route/status/error metadata used for support/security | no by design | App Functionality | no | disclose conservatively |
| Advertising Data | first-party reward/ad verification plus SDK data | depends on final SDK | Third-Party Advertising / App Functionality | **TBD** | only when ads ship; inspect AdMob privacy disclosures |
| Device ID | no first-party device advertising ID collection | conditional | conditional | **TBD** | depends on native advertising/SDK configuration |
| Coarse/Precise Location | Mega XO does not intentionally derive/store geographic location from IP | no first-party category planned | — | — | re-evaluate if any SDK collects/infers location |
| Payment Info | full card/bank details are entered with Apple/Google and are not available to Mega XO | no | — | — | do not declare as developer-collected solely for store payment |
| Product Interaction | no first-party tap/click behavioral analytics pipeline is implemented | no first-party category planned | — | — | re-evaluate if analytics/ads SDK collects it |
| Crash/Performance Data | no first-party external crash analytics SDK in V4.1 web/backend | conditional | conditional | no | inspect final native build/SDK manifests |

## Apple linkage/tracking position

Current first-party backend intent:

- account/profile/game/purchase records are linked to the Mega XO account because they must be;
- support-correlation rows deliberately contain no account ID;
- no first-party cross-app/site tracking exists;
- no data broker use is implemented;
- advertising tracking status cannot be finalized until the exact native AdMob/consent configuration is known.

Do not answer "Data Not Collected" merely because a data type is optional for some users; Apple requires the label to reflect data collected in the app unless an Apple optional-disclosure exception actually applies.

# Google Play Data safety candidate answers

Google Play's Data safety form describes collection/sharing across the distributed Android app and included SDKs. Verify the exact current form labels in Play Console at submission time.

| Google Play area | Candidate Mega XO declaration | Notes |
| --- | --- | --- |
| Personal info — Email address | Collected; used for account management/authentication/security | optional based on chosen sign-in method, but collected by the app overall |
| Personal info — User IDs | Collected; app functionality/account management | Mega XO ID/tag and identity-provider subject |
| App activity / other user-generated or gameplay activity | Collected; app functionality/fraud prevention | map to the exact Play Console labels available at submission |
| Purchase history | Collected if billing ships; app functionality/fraud prevention | no full card details |
| App info/performance / diagnostics | Review final native SDKs; first-party server support metadata is bounded and sanitized | do not omit SDK collection |
| Device or other IDs | No first-party advertising/device ID required by Mega XO backend; conditional on final SDK configuration | AdMob/Google Play Services may change this |
| Location | Mega XO does not intentionally request or store Android location permission/data | verify no SDK/manifest path introduces location collection |
| Messages | No player-to-player chat feature is present | reports are moderation submissions, not messaging |
| Photos/videos/audio/contacts/health | Not collected by current product | verify final native permissions |

## Google security/deletion answers

Current implementation supports these intended answers, subject to staging proof:

- Data encrypted in transit: **Yes** for production API traffic over HTTPS.
- Users can request deletion: **Yes**.
- In-app deletion path: **Yes**, behind approved privacy/retention release configuration.
- External deletion resource: **Yes**, `/delete-account`.
- Privacy policy in store listing: planned `/privacy`.
- Privacy policy accessible within app: **Yes**, linked from Settings.
- Data retention/deletion disclosure: draft exists but **not yet approved**.

## "Collected" versus "shared"

Do not infer "shared" from the fact that a processor receives data. Google Play has specific definitions/exceptions for service providers and legal/security transfers. The final answer must be based on:

- the exact provider relationship/contract;
- the exact purpose;
- whether the SDK/provider uses the data for its own purposes;
- the final Google Play definition at submission time.

The legal/store reviewer must decide the final "shared" answer for Resend, Google identity, Apple identity, app-store billing and AdMob.

# Third-party SDK/provider review checklist

Before submission, for every native dependency and service:

1. record exact SDK/package and version;
2. read its current privacy/data disclosure;
3. inspect Apple privacy manifest/signature where applicable;
4. inspect Android manifest permissions and Data safety guidance;
5. record data types and purposes;
6. confirm whether any data is used for tracking/advertising measurement;
7. update this sheet and the public Privacy Policy;
8. update consent UI before enabling any new non-essential collection.

# Submission sign-off

Do not submit the App Privacy/Data safety forms until all of these are true:

- public Privacy Policy is approved and no longer marked draft;
- `MEGA_PRIVACY_POLICY_VERSION` identifies that approved policy;
- `MEGA_RETENTION_POLICY_VERSION` identifies an approved retention schedule;
- account deletion has passed live acceptance;
- final native SDK manifests/dependencies have been reviewed;
- store purchases/ads declarations match whether those features are actually enabled in the submitted binary;
- the final answers are reviewed by the person responsible for Antimatter Innovations' legal/store compliance.
