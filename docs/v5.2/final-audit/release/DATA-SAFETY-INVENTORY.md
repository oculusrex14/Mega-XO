# Play Data Safety / iOS Privacy Inventory (draft for owner attestation)

**Every OWNER-ATTESTATION marker below is a human declaration the store consoles require; the
agent cannot submit these. The data inventory itself is derived from the actual schema and code
paths cited, not from intent.**

## 1. What the product actually collects (schema + code evidence)

| Data | Where it lives | Source of truth | Why |
|---|---|---|---|
| Email address (sign-in identity) | identity.actors / credential tables | Google / Apple / email sign-in (server-verified only) | Account, sign-in, receipts binding |
| Display name + avatar | identity profile tables | User input | Profile page, leaderboards |
| Gameplay record | match/season/leaderboard tables | Play only (server-officiated) | Ranked mode, stats, leaderboards |
| Wallet balances + ledger | economy.wallets, economy ledger | Core only | Coins/Crowns integrity, append-only audit |
| Purchase records + receipts | monetization.cashfree_orders, polar_orders, receipts, store_revocations | Provider-verified only | Entitlements, refunds, fraud prevention |
| Reward events | monetization.reward_events | Core | Abuse accounting for ad rewards |
| Store binding identifiers | monetization.store_bindings (obfuscated Google account id, Apple app-account token) | Obfuscated per Play/App Store guidance | Receipt-to-actor binding; never a device identifier |
| Device data (ads only) | AdMob SDK on-device | Google AdMob (third party) | Ad serving; the app never receives it. UMP privacy options are exposed via window.MegaAds.privacyOptions |

NOT collected: precise/coarse location, contacts, photos, microphone/camera content, health,
browsing history. The LAN party feature uses local-network discovery only and stores nothing
server-side.

## 2. Play Data Safety form answers (DRAFT - owner attests)

- Collected: Yes. Shared: No (the AdMob SDK shares device data with Google for ads - answer in
  the Ads SDK section, not as first-party sharing).
- Personal info > Email address: collected, app functionality, not optional.
- Financial info > Purchase history: collected, app functionality (receipts), not shared.
- App activity > App interactions / in-app actions: collected (gameplay records), app functionality.
- All of the above: transmitted over TLS; encrypted in transit = Yes.
- Deletion: account deletion path + support-mediated per current policy (see the SAGAN-004
  decision in the takeover ledger); data removal on verified request.
- OWNER-ATTESTATION: confirm the deletion wording matches what the app actually offers before
  submitting (never claim in-app subscription cancellation - the B2 decision).

## 3. iOS privacy manifest / App Privacy (DRAFT - owner attests)

- App Privacy: Email (app functionality), Purchase History (app functionality),
  Gameplay/Usage (app functionality). Not used for tracking; no third-party tracking domains.
- AdMob: declared in the ads SDK section; no ATT prompt is shown because the app does not track
  across apps (confirm with the owner before submission).
- OWNER-ATTESTATION: the privacy manifest (PrivacyInfo.xcprivacy) needs the AdMob
  required-reason API entries from the Google checklist - listed in IOS-RELEASE-CHECKLIST.md.

## 4. Open owner questions

1. Support email for the deletion path: the product copy permits only
   contact@antimatterinnovations.com (parent-company domain rule, AGENTS.md 15 Oct).
2. Whether ranked data (ratings, opponents) is deletable on request without corrupting season
   history - engineering recommendation: delete actor rows (CASCADE) and anonymize the
   leaderboard row, never rewrite append-only ledgers.
