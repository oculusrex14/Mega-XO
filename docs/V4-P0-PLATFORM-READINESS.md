# V4 post-backend P0 platform readiness

This document governs the work that follows the first secure V4 backend deployment.

The first backend release may operate with verified email accounts only. Google/Apple buttons remain disabled unless their complete production configuration is present. V4.1 contains guarded backend implementations for account deletion, Google Play Billing, Apple StoreKit and AdMob SSV, but purchases and ads remain disabled until their separate provider/native/privacy gates below are complete. Paid-entry competition remains hard-disabled.

## 1. Google web and native identity

### Server identity rule

Mega XO identifies a Google login by the signed OIDC **`sub`** claim.

Never:

- use email as the Google identity key;
- merge profiles because two providers return the same email;
- accept a client-supplied Google user ID without token verification.

Current Google web flow:

- authorization-code flow;
- exact state binding;
- nonce replay protection;
- PKCE S256;
- current supported authentication scopes: `openid profile`;
- profile claims are ignored by Mega XO;
- no Google email scope is requested.

Official references:

- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation

### Production Google callback

Register this exact authorized redirect URI:

```text
https://play.antimatterinnovations.com/auth/callback/google
```

For staging provider testing, also register:

```text
https://staging.play.antimatterinnovations.com/auth/callback/google
```

Google requires the redirect URI to match exactly, including scheme, hostname, path, case, and trailing-slash behavior.

V4 server configuration:

```text
GOOGLE_CLIENT_ID=<web OAuth client ID>
GOOGLE_CLIENT_SECRET_FILE=/run/secrets/google_client_secret
GOOGLE_NATIVE_AUDIENCES=<server/web client ID expected in native ID token aud>
GOOGLE_AUTHORIZED_PARTIES=<exact Android OAuth client IDs allowed as azp, if issued>
```

The private client secret belongs only in the VPS secret file.

### Android identity

Use Android Credential Manager + Google ID credential support.

The native bridge returns an ID token only:

```js
window.MegaNativeIdentity.getCredential({provider:"google", nonce})
```

The exact server nonce must be supplied to the platform flow. The ID token then goes to `/api/account/native/finish` and is cryptographically verified by the backend.

Do not treat Play Games, Play Billing, email, package name, or a client-provided account identifier as authentication proof.

## 2. Apple web and native identity

### Server identity rule

Mega XO identifies an Apple login by the verified Apple **`sub`** claim, not the email address.

Hide My Email must not create a second Mega XO account when the Apple subject is the same.

Official references:

- https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple
- https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web
- https://developer.apple.com/documentation/authenticationservices/implementing-user-authentication-with-sign-in-with-apple

### Apple web configuration

Create/configure a Services ID associated with the primary App ID that owns Sign in with Apple.

Register domain:

```text
play.antimatterinnovations.com
```

Register exact return URL:

```text
https://play.antimatterinnovations.com/auth/callback/apple
```

If staging is used for real Apple acceptance, separately register:

```text
staging.play.antimatterinnovations.com
https://staging.play.antimatterinnovations.com/auth/callback/apple
```

Apple requires absolute registered return URLs.

V4 server configuration:

```text
APPLE_SERVICE_ID=<Services ID>
APPLE_TEAM_ID=<Developer Team ID>
APPLE_KEY_ID=<Sign in with Apple key ID>
APPLE_PRIVATE_KEY_FILE=/run/secrets/apple_private_key
APPLE_NATIVE_AUDIENCES=<real iOS bundle/App ID audience>
```

The private `.p8` key stays in the VPS secret file.

### iOS identity

Enable the Sign in with Apple capability on the real native App ID.

The Swift bridge must return the signed ID token to the same native challenge/finish API used by Android. Real-device tests must cover cancellation, reauthentication, account linking, provider unlinking, app reinstall, and credential revocation behavior.

## 3. Live provider acceptance

After configuring a provider, run:

```bash
node scripts/provider-web-smoke.js \
  https://staging.play.antimatterinnovations.com \
  google apple \
  --basic-password-file /secure/path/to/staging-password
```

This verifies server-generated authorization URLs, exact callbacks, state/nonce, and Google PKCE without needing to expose provider secrets.

Then manually complete each real consent flow in a browser:

- new login;
- returning login;
- user cancellation;
- link provider to an existing email profile;
- reauthenticate with that provider;
- unlink while another login method remains;
- confirm cross-device restoration returns the same player tag.

Do not enable a provider merely because its configuration smoke passes; a real provider login must succeed.

## 4. Store billing backend is implemented but remains release-gated

V4.1 can enable `MEGA_PURCHASES_ENABLED=true` only when account deletion is enabled under an approved privacy policy and at least one complete native store provider is configured. The default remains `false`.

The server never trusts client-supplied `valid`, price, currency quantity or entitlement fields. Store evidence is verified by the backend and bound to a stable per-account store context before any grant commits.

### Google Play Billing

Current Google guidance requires a purchase flow that verifies the purchase on the backend before granting content, then acknowledges/delivers it; consumables need the corresponding consumption lifecycle.

Official reference:

- https://developer.android.com/google/play/billing/integrate

Repository-side backend work now includes ProductPurchaseV2 verification through the Android Publisher API, immutable store-product mapping, server-generated obfuscated account binding, idempotent grants, post-commit consume/acknowledge with retry, authenticated Pub/Sub push verification, RTDN/voided-purchase revocation handling and refund holds for previously granted Crown purchases.

Remaining production work is external/native: create the exact products in Play Console, integrate Play Billing in the real Android target using the server-provided `googleAccountId`, configure the service account and RTDN subscription, then prove sandbox purchase/cancel/pending/consume/acknowledge/refund/replay and Remove Ads restore on physical devices.

Do not trust a client JSON object containing `valid:true`.

### Apple StoreKit

Use StoreKit 2 in the real iOS target and server verification of signed transaction information.

Official references:

- https://developer.apple.com/documentation/storekit/transaction
- https://developer.apple.com/documentation/appstoreserverapi/get-transaction-info

Repository-side backend work now verifies StoreKit signed transaction JWS values with ES256 and an Apple certificate chain anchored in configured trusted roots, then checks bundle ID, environment, product mapping, quantity, transaction ID, revocation state and the server-provided `appleAppAccountToken`. App Store Server Notifications V2 are independently verified/deduplicated and can revoke/refund prior grants.

Remaining production work is external/native: create products in App Store Connect, integrate StoreKit 2 in the real iOS target using the provided app-account token, configure server notifications and trusted roots/environment, then prove Sandbox/TestFlight purchase/cancel/pending/finish/restore/refund/revocation behavior on physical devices.

### Product mapping

The server catalogue currently recognizes:

```text
crowns_100
crowns_525
crowns_1100
remove_ads
```

Store-console IDs must have an explicit immutable mapping to these server IDs. Do not let a device choose the Crown amount.

## 5. Ads backend is implemented but remains disabled until native SDK + consent + SSV are proven

`MEGA_AD_MODE=off` remains the default. V4.1 permits `rewarded` or `hybrid` only when account deletion/privacy policy is enabled, an explicit consent-release version is configured, and the relevant native AdMob units are complete.

Ad rewards are never granted from a client-side "watched" flag. Rewarded tickets are bound to an exact Android/iOS rewarded unit; the SSV callback must cryptographically verify and match that ticket/unit/account/reward before Cosmetic Credits or a boost can settle. Automatic interstitial permits are likewise bound to the exact platform unit.

Official references:

- https://developers.google.com/admob/android/next-gen/rewarded
- https://developers.google.com/admob/android/next-gen/ssv
- https://developers.google.com/admob/ios/ssv

Google's SSV documentation specifies cryptographic callback verification and regularly rotating verification keys; production must fetch/cache those keys within the provider's stated rotation guidance.

Real-device acceptance must prove:

- no ad starts automatically from opening Rewards & Themes;
- optional rewarded ad grants exactly once through SSV;
- replayed SSV transaction is rejected;
- wrong ticket/account/ad unit/reward is rejected;
- no rewarded/full-screen ad during a live match;
- daily/cooldown limits survive restart;
- Remove Ads suppresses automatic ads but not user-chosen rewarded ads;
- consent/privacy controls work in applicable regions.

## 6. Privacy policy and account deletion are release blockers for native stores

Mega XO currently supports account creation, so native distribution requires a real account-deletion path.

Current platform guidance:

Apple App Store:
- apps with account creation must let users initiate account deletion in the app;
- deletion should remove the account and associated data the developer is not legally required to retain.

Official:
- https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/
- https://developer.apple.com/support/offering-account-deletion-in-your-app/

Google Play:
- apps with account creation must provide an in-app account deletion path;
- Google also requires an external web resource where users can request deletion;
- merely freezing/deactivating the account does not satisfy the requirement;
- any legitimate retention must be disclosed.

Official:
- https://support.google.com/googleplay/android-developer/answer/13327111
- https://support.google.com/googleplay/android-developer/answer/10144311

### Deletion code exists; policy approval is still mandatory

V4.1 implements a policy-gated destructive flow with recent reauthentication, exact MEGA-tag confirmation, session/identity revocation, profile/social/cloud deletion, pseudonymisation of retained integrity records, and a public `/delete-account` resource. The implementation remains disabled until Antimatter Innovations approves:

- Privacy Policy;
- Terms of Service;
- data inventory;
- which data is personal;
- fraud/security records that genuinely need retention;
- purchase/financial records that genuinely need retention;
- required retention durations and legal basis;
- deletion/anonymisation treatment for match history, ratings, leaderboards, social relationships and receipts;
- support/escalation process.

Once approved, set a versioned policy identifier and perform live staging acceptance. The repository already provides the discoverable in-app control, recent reauthentication, explicit destructive confirmation, immediate session/identity revocation, deletion/pseudonymisation machinery, the stable public `/delete-account` resource, a minimal retained deletion receipt and tests proving a formerly linked identity cannot restore the deleted profile.

The live release must still confirm provider-specific credential/revocation requirements and that the published Privacy Policy/Terms accurately disclose every retained category and duration.

## 7. Physical-device release QA

A browser CI pass is not physical-device certification.

Minimum matrix before native release:

### iOS

- current supported iOS;
- one older supported iOS release;
- small-screen iPhone;
- current large-screen/notched iPhone.

### Android

- current Android;
- at least two older supported API levels;
- compact phone;
- common mid-range device;
- large/notched device.

### Required flows

- fresh install;
- app upgrade;
- background/resume;
- forced termination/relaunch;
- Wi-Fi → mobile data transition;
- temporary offline/reconnect;
- signup OTP autofill/manual entry;
- forgot password;
- Google login;
- Apple login on iOS;
- provider cancellation;
- provider linking/unlinking;
- app reinstall + profile restoration;
- matchmaking;
- live match reconnect;
- notifications/deep links if enabled;
- store sandbox purchase;
- interrupted/pending purchase;
- restore purchases;
- rewarded ad;
- consent/privacy options;
- Remove Ads;
- accessibility text scaling;
- VoiceOver/TalkBack;
- keyboard/focus behavior where applicable.

Record device/OS/build/result without recording account secrets.

## 8. Paid-entry compliance gate

Paid-entry competitive functionality remains hard-disabled in V4 production.

Do not enable it because technical wallet/tournament code exists.

Before enabling any real-money-purchased currency in an entry/stake/prize loop, obtain a documented review covering:

- Apple App Store rules;
- Google Play rules;
- applicable contest/gambling laws;
- countries/states/territories where participation is allowed;
- age restrictions;
- geofencing/eligibility;
- refund/chargeback treatment;
- purchase and loss limits;
- anti-collusion/fraud controls;
- tax/prize reporting where applicable;
- responsible spending protections.

The resulting jurisdiction policy must be enforceable by the server, not a client checkbox.

Until then:

```text
MEGA_PAID_ENTRY_ENABLED=false
```

is mandatory and the production config refuses any attempt to turn it on.

## 9. Sequencing

Recommended sequence after V4 backend launch:

1. Google web production identity;
2. Apple web production identity;
3. approve/publish privacy/retention policy and live-test the implemented deletion flow;
4. real Android/iOS application targets and identity;
5. physical-device baseline QA;
6. configure/test the implemented Google Play Billing backend with the Android client;
7. configure/test the implemented Apple StoreKit backend with the iOS client;
8. integrate native Google Mobile Ads/UMP and prove the implemented SSV boundary;
9. store submission data/privacy declarations;
10. paid-entry review as a separate later decision.

Do not make billing, ads, account deletion, and paid-entry one giant rollout.
