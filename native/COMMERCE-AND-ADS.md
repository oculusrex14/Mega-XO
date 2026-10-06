# Native commerce and ads contract

This file defines the exact browser/native contract for Tasks 22-24. The repository still does not contain complete Android or iOS application targets, so these adapters are integration contracts, not evidence that Play Billing, StoreKit, Google Mobile Ads, or UMP have run on a physical device.

## Shared rule

The web layer never decides a grant.

- Crown quantity comes from the server catalogue.
- Purchase validity comes from Google Play or Apple verification on the backend.
- Rewarded-ad grants come only from a cryptographically verified AdMob SSV callback.
- Consent is evaluated by the native Google User Messaging Platform integration before any ad request.
- A native bridge must never return a fabricated successful receipt or fabricated rewarded completion.

## `window.MegaBilling`

The native host exposes:

```js
window.MegaBilling = {
  products: async storeContext => [
    { id: "crowns_100", price: "localized store price" },
    { id: "crowns_525", price: "localized store price" },
    { id: "crowns_1100", price: "localized store price" },
    { id: "remove_ads", price: "localized store price" }
  ],

  purchase: async (productId, storeContext) => evidence,
  restore: async storeContext => [evidence],
  finish: async (evidence, delivered) => {}
}
```

Only the four server catalogue IDs are accepted.

### Android evidence

The Android purchase flow must set the Play Billing obfuscated account ID to:

```text
storeContext.googleAccountId
```

It returns only:

```json
{
  "store": "google",
  "purchaseToken": "<Play purchase token>"
}
```

Do not put the price, Crown quantity, package name, account email, or a client-side `valid` flag in the evidence.

The backend validates the package, product, purchase state and obfuscated account binding through Google Play Developer API. The backend performs consume/acknowledge only after the authoritative grant has committed. The native bridge must not consume the purchase before the server has accepted it.

Restore returns only active non-consumable `remove_ads` evidence. Consumable Crown packs are not restored.

### iOS evidence

The StoreKit purchase must use:

```text
storeContext.appleAppAccountToken
```

as the StoreKit app-account token.

It returns only:

```json
{
  "store": "apple",
  "signedTransactionInfo": "<StoreKit signed transaction JWS>"
}
```

The backend validates the JWS certificate chain against pinned Apple roots, signature, bundle ID, environment, product ID, transaction ID, quantity, revocation state and app-account token.

After the server confirms delivery, `finish` may finish the StoreKit transaction on-device.

Restore returns only currently verified non-consumable `remove_ads` transactions.

## `window.MegaAds`

The native host exposes:

```js
window.MegaAds = {
  platform: "android", // or "ios"

  privacyState: () => ({
    canRequestAds: false
  }),

  privacyOptions: async () => {},
  prepare: async kind => {},
  isReady: kind => false,
  showRewarded: async ticket => {},
  showInterstitial: async permit => {},
  reportAd: async () => {}
}
```

The platform value must be exactly `android` or `ios`.

## Consent

On application startup and whenever required by UMP:

1. request/update consent information;
2. show the required consent form;
3. expose `canRequestAds=true` only when the SDK says ads may be requested;
4. do not preload rewarded or interstitial ads before that point;
5. expose the privacy-options entry point whenever the SDK says it is required.

The web UI already refuses ad presentation when `privacyState().canRequestAds !== true`.

The server also refuses any non-off production ad mode unless an approved privacy/deletion release and explicit `MEGA_AD_CONSENT_VERSION` are configured.

## Rewarded ads

Before a rewarded presentation, the web app obtains a server ticket containing:

```text
ticket
actor
platform
adUnit
rewardItem
rewardAmount
expires
```

The native bridge must verify that:

- `ticket.platform` equals its own platform;
- `adUnit` is the native app's configured rewarded unit;
- `rewardItem` is `cosmetic_reward`;
- `rewardAmount` is exactly 1.

Configure AdMob server-side verification for the rewarded request with:

```text
user_id     = ticket.actor
custom_data = ticket.ticket
```

The app must not grant Cosmetic Credits after the local rewarded callback. The local callback only means the ad UI completed. The balance changes only after AdMob calls the backend SSV endpoint and the signature/ticket/unit/account/transaction checks pass.

## Interstitial ads

The web layer requests a short-lived server permit before an automatic interstitial.

The permit contains the exact platform and interstitial ad unit. The native bridge must reject a permit for another platform or another unit.

Automatic interstitials remain subject to the existing client and server safeguards:

- bot-result-to-home transition only;
- never during an online/live match, matchmaking queue, party screen, modal or hidden state;
- first-use age/game thresholds;
- full-screen cooldown;
- session/day caps;
- Remove Ads entitlement;
- consent readiness.

## Provider callbacks

Google Real-time Developer Notifications and Apple App Store Server Notifications are server-to-server routes. Native apps must not call them.

AdMob SSV is also provider-to-server. The device never calls the SSV endpoint itself.

## Physical-device acceptance

Tasks 22-24 remain externally blocked until the real app targets prove:

- localized product loading;
- successful, cancelled, pending and interrupted purchase;
- wrong-account/product and replay rejection;
- consumable finalization;
- Remove Ads purchase + restore;
- Google RTDN refund/revocation;
- Apple Server Notification refund/revocation;
- UMP consent and privacy-options behavior;
- rewarded SSV grant exactly once;
- SSV replay/wrong-unit/wrong-ticket rejection;
- no ad during live play;
- automatic ad caps and Remove Ads;
- app restart/reinstall behavior.

Record non-secret evidence in `docs/V4-OPEN-BLOCKERS.md`.
