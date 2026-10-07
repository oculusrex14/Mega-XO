# Android and iOS application delivery

Applies primarily to Phase 20, with early toolchain inventory and scaffolding after contracts are stable. The new website is not a prerequisite. Existing native files are adapters/contracts, not proof of complete applications [R06,R07].

## 1. Implementation strategy

Default to a real Kotlin Android host and real Swift iOS host rendering the **bundled approved HTML/CSS/JavaScript game**. Reuse existing identity adapters and `MegaNativeIdentity`, `MegaBilling`, `MegaAds` contracts. Do not rebuild the game in another UI framework or load the future website as the application. If working approved native targets now exist locally, preserve and integrate them instead of generating competing projects.

Create a deterministic asset-packaging command with an explicit allowlist derived from the current `index.html` import graph. Include only required client code and approved assets. Exclude `src/authority.js`, all server/deployment/test files, provider credentials, environment files and production data. Generate an asset manifest and verify the same client revision is used in both platforms. Store software/license attribution as required; do not bundle new unapproved visual assets.

Preserve all four themes and current UI, including the connection surface and archived cosmetic direction. Offline bot/local/practice modes must load on a clean first launch without internet. No JavaScript downloaded from an arbitrary production URL may replace the signed bundled product silently. Future browser work can reuse these assets later without being designed now.

## 2. Real project outputs

### Android

Create a checked-in application target, pinned Gradle wrapper/build configuration, Android manifest, version catalog or equivalent dependency lock, resources/icons from approved assets, debug/staging/production variants and test targets. Resolve the real package ID and signing-certificate identity from existing local/Play/Google configuration before registering anything. Keep `versionCode` monotonic and distinct from marketing version.

Use a local trusted origin such as AndroidX WebViewAssetLoader's HTTPS asset origin rather than broad `file://` permissions [E11]. Disable unnecessary file/universal access, mixed content and untrusted navigation. External links open in the appropriate system browser, without native bridges attached. Configure release network security without broad cleartext access. Preserve any approved free LAN feature through a narrowly scoped, documented transport path rather than enabling arbitrary HTTP for the entire application.

Implement activity/process recreation, saved non-sensitive UI state, Android back behavior, keyboard/safe-area configuration, audio/vibration behavior and network transitions without rewriting screen layouts. Build and retain a debug APK for testing and a signed release AAB for Play internal distribution. A simulator/emulator test is not a physical purchase/consent proof.

### iOS

Create a checked-in Xcode application project/workspace with shared build schemes, staging/production configurations, reproducible dependency resolution, bundle/version settings, entitlements, approved assets and test targets. Resolve the existing Apple team/App ID/Services ID and bundle identity first. Do not put signing keys, provisioning credentials or App Store Connect secrets in Git.

Render bundled assets in WKWebView with a defined trusted resource origin/loading policy. Constrain script-message handlers by main frame and expected origin/content context; reject untrusted frames and navigation [E12,E13]. Use native URLSession for authenticated platform requests rather than depending on cross-site WebView cookies. Configure ATS securely and any necessary local-network permission narrowly. Do not force landscape/orientation, change status-bar style or alter safe areas without preserving the baseline experience.

Build simulator and device targets, retain an `.xcarchive`, export a signed IPA using the real distribution configuration, and upload to TestFlight with available authorized credentials. Record exact build number, signing identity reference and upload/provider status, not secret values.

## 3. Native bridge and session adapter

Keep JS controllers using the existing account API. A small adapter forwards allowlisted account/game operations to a native networking service. The host controls access/refresh tokens, refresh serialization, timeouts, operation keys and TLS. Do not expose an arbitrary URL fetch proxy with bearer credentials. Check request IDs, sizes, method/path allowlists, caller origin/main frame and response schema. Encode callback messages safely, never construct executable JavaScript by concatenating untrusted strings.

Keep transient provider ID tokens out of persistent JS storage. Existing `getCredential({provider, nonce})` may return an ID token to the trusted adapter for the defined exchange; native host-owned exchange is also possible if the bridge contract is versioned and UI semantics stay the same. Never treat a user-entered email or provider user ID as authentication proof.

Implement secure storage as specified in [identity contracts](02-IDENTITY-API-AND-CLIENT-CONTRACTS.md). Test app restart, OS process kill, token rotation, logout on another device, reinstall and restore. User progress comes from the same server actor; reinstall must not mint a new wallet simply because local secure storage is empty.

Realtime uses one-use tickets, latest-revision resume and HTTP fallback. Suspending/backgrounding can close sockets; it must not keep fictitious client clocks authoritative or automatically resign/void a game contrary to the current policy. Reconnect when foregrounded and reconcile the committed snapshot.

## 4. Identity SDK integration

Android uses the currently supported Credential Manager/Google identity integration with exact server audience and signing certificate configuration. iOS uses Sign in with Apple with exact native audience, nonce treatment and linked web Services ID grouping. Preserve email/password/OTP/recovery as a first-party path. Do not add Play Games Services as another account database.

Test successful login, cancellation, provider unavailability, wrong nonce, wrong audience, linked-account conflict, reauthentication without unintended account switching, revoked credentials and reinstall. Use actual device/provider UI and record app build/device/OS. Provider-specific system UI is an expected native exception, not a game redesign.

## 5. Purchases: preserve the existing four-product contract

Server catalogue IDs remain `crowns_100`, `crowns_525`, `crowns_1100`, `remove_ads` [R07]. Real store IDs map immutably to these identifiers. Show localized store prices from the SDK; do not trust client-supplied quantities or prices for grants. Purchased and earned Crowns retain identical gameplay utility.

**Android:** set Play Billing obfuscated account ID to the server's persisted `storeContext.googleAccountId`; submit only verified purchase evidence shape `{store:'google', purchaseToken}`. The backend verifies state, package/product/account binding and replay. Pending purchases grant nothing until verified purchased. The backend consumes/acknowledges only after the authoritative grant commits and retries finalization durably. The device must not consume first [R07,E15,E16].

**iOS:** attach the persisted `storeContext.appleAppAccountToken`; submit `{store:'apple', signedTransactionInfo}`. The backend verifies signed transaction chain/claims, bundle/product/environment/account binding and revocation. Device `finish` happens only after the server confirms delivery. Recover unfinished transactions across restart using the same idempotent server flow.

`remove_ads` restoration is non-consumable entitlement restoration. Do not restore Crown consumables as new currency or mistake historical transactions for undelivered purchases. Shared wallet/entitlement reads across platforms remain actor-based while provider receipt ownership stays immutable. Test notification-before-client, client-before-notification, duplicated, out-of-order, canceled, pending, interrupted, refunded and revoked events. Preserve existing refund/account-review behavior unless an approved product change exists; do not invent new automatic debt mechanics.

## 6. Ads and privacy integration

Implement the existing `MegaAds` contract with real Mobile Ads and UMP integration. Consent information/form evaluation precedes all ad requests/preloading; expose privacy options when the SDK requires it. Do not fabricate `canRequestAds`. Evaluate any platform tracking permission based on actual SDK/data use and current requirements; do not show tracking prompts simply because an SDK exists [E17].

Rewarded presentation uses the exact server ticket's platform/unit, `user_id=actor`, `custom_data=ticket`, `rewardItem=cosmetic_reward`, `rewardAmount=1`. The local watched callback never grants Cosmetic Credits. Only verified backend AdMob SSV updates the balance. Test delayed callback, replay, wrong account/unit/ticket and app termination before callback.

Preserve existing interstitial eligibility: approved bot-result-to-home transition, never live online play/queue/party/modal/background, existing first-use thresholds, cooldown/caps, consent and Remove Ads behavior. Do not add ad placements or new monetization mechanics as part of SDK integration.

Reuse approved privacy/terms/retention/deletion content and version identifiers. Validate real in-app and external deletion flows and accurate store declarations. If existing approval evidence is not found, flag the precise missing fact instead of inventing a policy or turning every game currency action off. Provider features should be production-enabled only after their own evidence is complete.

## 7. Platform foundations without website work

Host required `assetlinks.json` and Apple association resources at exact registered HTTPS domains with the correct release signing identities and route scopes. Verify content type, reachability and association behavior. Keep callback/deep-link return targets allowlisted; do not let arbitrary links open a bridged WebView. These technical files can exist on a minimal API/technical surface while the marketing website remains deferred.

Provide stable app-version/protocol compatibility metadata and minimum supported version behavior through the existing error/update surface where possible. Avoid creating an unnecessary mandatory-update screen during architecture work. Provide notification-registration and return-to-game foundations alongside reconnect: a versioned actor/session-bound device-token registry, platform-specific delivery adapter, durable notification jobs, token rotation/removal on logout, and allowlisted deep-link routing. Wire only existing approved notification purposes; test foreground/background return and revoked-device behavior. Where no approved notification permission flow exists, deliver the technical capability and controlled test evidence without inventing a new product prompt or campaign. Do not label public push delivery enabled until the actual platform configuration and permission behavior are verified.

## 8. Build, device and distribution acceptance

Retain unsigned build/test evidence separately from signed distribution evidence. CI runs reproducible native compilation/tests on appropriate runners; secret-bearing signing jobs run only on reviewed trusted branches/protected release environments. Build artifacts and crash traces are private and scanned for credentials. Do not upload signing material as an artifact.

Device matrix: representative supported Android/iOS versions, small/large screen, notched/safe-area devices, light/dark OS settings across all game themes, keyboard, reduced motion, VoiceOver/TalkBack, clean install/update/reinstall, airplane/offline-first start, Wi-Fi/mobile transition, server restart, refresh expiry and receipt/SSV recovery. Use actual supported OS/SDK versions resolved at implementation time, not a stale hardcoded list.

Cross-platform acceptance must demonstrate: same linked actor logs in on Android, completes a ranked match and wallet update, opens iOS and sees the same state, then a protected browser-style/retained-client test sees it too. Prove no consumable remint, no separate mobile account, no layout/gameplay changes and no ad during live play.

Delivery evidence: Android APK/AAB hashes and version code, iOS archive/export hashes and build number, exact code/asset/API/protocol/schema versions, real device test references, internal-track/TestFlight IDs, store submission state and any unresolved review. Public store approval is not guaranteed by a successful upload; do not claim it until recorded by the provider.
