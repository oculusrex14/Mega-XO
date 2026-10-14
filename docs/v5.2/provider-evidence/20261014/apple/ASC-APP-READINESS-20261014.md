# App Store Connect app and submission readiness — 2026-10-14

**Observed:** 2026-10-14 17:21 UTC  
**Scope:** Existing Apple Developer / App Store Connect account and existing Mega XOXO app record only.  
**Evidence:** Sanitized live-console observations; no screenshots retained because account identity details are visible in the portal.

## Verified app record

| Field | Current provider value |
| --- | --- |
| Paid Individual Team ID | `6N6C9338NX` |
| App Store Connect Apple ID | `6822833387` |
| App name | `Mega XOXO` |
| Bundle ID | `online.megaxo.xoxo` |
| Internal SKU | `MEGAXOXO-ONLINE-XOXO` |
| Primary language | English (U.S.) |
| Version | `1.0.0` |
| Version status | **Prepare for Submission** |
| Release control | **Manually release this version** selected |

The same existing app record was used throughout; no duplicate app or identifier was created. App Information showed the expected name, bundle, SKU and Apple ID. The subtitle **“Think one board ahead”** was saved. Category was saved as **Games**, with **Board** and **Strategy** game subcategories. ASC showed the save complete. The version’s local description, keywords and copyright had already been saved by Main; they remain present in the version form.

## Build, media and review readiness

- **No build is attached.** The version page has no build selected and directs the team to upload a build. TestFlight currently says **“Submit a build to start testing.”** No TestFlight group or review submission is established.
- The version page shows **0 of 1 Header Asset** and **0 of 1 Search Results Asset**. The standard preview/screenshot set is not populated in the visible version editor. The native project still needs the approved release icon and device screenshots from Main’s exact signed build.
- Support URL and Marketing URL are blank. Use only verified public production URLs after Main confirms the deployed V5.2 website and policies.
- App Review Information still has **Sign-in required** checked. Username and password are blank; reviewer contact fields and notes are blank; the optional attachment is empty. Main must provide working dedicated reviewer access and truthful instructions for the exact accepted build.
- App Information still shows **Set Up Age Ratings** and **Set Up Content Rights Information**. No age rating, privacy, encryption/export, content-rights, or EU trader answer was entered by Codex. Game Center is unchecked.
- App Store distribution/review remains **NOT SUBMITTED**. Manual release remains selected.

## In-app purchases

The ASC In-App Purchases list contains **no products**. Opening the create dialog showed the draft fields **Type**, **Reference Name**, and **Product ID**. The page states that the first in-app purchase must be submitted with a new app version. The form was cancelled without creating a record.

The source catalogue maps the intended products as follows:

| Product ID | Intended type | Source UI title |
| --- | --- | --- |
| `crowns_100` | Consumable | 100 Crowns |
| `crowns_525` | Consumable | 525 Crowns |
| `crowns_1100` | Consumable | 1,100 Crowns |
| `remove_ads` | Non-consumable | Remove Ads |

No prices, territories, product records, or purchase metadata were created. The Paid Apps Agreement remains **New**; pricing is awaiting the owner’s exact approved decisions and completion of Apple’s required legal-entity update.

## App Store Server Notifications

Both Production and Sandbox Server URL slots are unset. The production setup dialog asks for **“a URL on your server to use for in-app purchase status updates”** and accepts up to 255 characters. The frozen V5.2 route contract defines `POST /api/monetization/apple-notifications` for provider-signed JWS notifications. No verified, deployed production origin/handler is available in the evidence reviewed here, so neither URL was entered.

Main must provide and verify the production host, deployed POST route, signed-notification verification, durable idempotent processing and externally reachable HTTPS endpoint before the URL is configured. Keep sandbox and production URLs distinct.

## Owner-only and Main dependencies

- Apple Business shows **Free Apps Agreement: Active** and **Paid Apps Agreement: New**. The page says legal-entity information must be updated before the Paid Apps Agreement can be signed. It also requires the Account Holder to declare trader status for EU distribution. The separate handoff page is marked for the owner; Codex changed no identity, tax, banking, trader or agreement fields.
- Main must supply the aligned, accepted signed IPA/build number and hash, certificate/profile setup in its protected native workflow, build’s final SDK/data-flow/encryption manifest, published support/privacy URLs, screenshot/icon assets, production notification URL, and working reviewer account/instructions.
- No store price selection, paid agreement acceptance, App Review submission, public release, upload, certificate, CSR, provisioning profile, private key, or credential was created by Codex.

## Source references

- `native/COMMERCE-AND-ADS.md`: Apple purchase JWS contract, product catalogue and server-side notification boundary.
- `native/ios/MegaStoreKit.swift`: iOS product keys and StoreKit mapping requirements.
- `packages/contracts/routes.js`: `POST /api/monetization/apple-notifications` route contract.
- `apps/web/pages.js`: user-facing names for the four catalogue items.
- `ACCOUNT-ACCESS-20261014.md` and `REGISTERED-APP-20261014.md`: earlier account and registration receipts.
