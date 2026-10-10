# Mega XO — Unified Commerce Readiness & Regulatory Evaluation

**Prepared:** October 10, 2026  
**Status:** Architecture Specified & Verified; Provider Eligibility Audited  
**Scope:** In-Game Store, Payment Processors, Cashfree India, Dodo Global, Google Play Billing, Apple StoreKit, and Indian Gaming Regulatory Analysis.

---

## 1. Provider Eligibility & Readiness Matrix

| Dimension | Cashfree Payments (India) | Dodo Payments (Global) | Google Play Billing (Android) | Apple StoreKit 2 (iOS) |
|---|---|---|---|---|
| **Intended Scope** | India Web & Alternative Billing | Global Web Purchases | Android App Purchases | iOS App Purchases |
| **Merchant Eligibility Verdict** | **CONDITIONALLY ELIGIBLE** (Subject to Online Gaming classification) | **STRICTLY INELIGIBLE** under current public acceptance policy | **APPROVED STANDARD** | **APPROVED STANDARD** |
| **Policy Source / Reference** | Cashfree Terms & PPI Guidelines | Dodo Acceptance Policy Section 17 | Google Play Developer Distribution Agreement | Apple App Review Guidelines 3.1.1 |
| **Reason / Restriction** | Permitted for digital goods; requires compliance with Promotion and Regulation of Online Gaming Rules, 2026. | Dodo publicly prohibits "Gaming and virtual-goods environments... online games, video games, in-game currencies, digital item sales". | Standard mobile in-app purchase platform for digital goods. | Standard iOS in-app purchase platform for digital goods. |
| **Account Onboarding State** | Account accessible by owner; requires sandbox-to-production activation & merchant category sign-off. | Account held by owner; digital gaming sales prohibited without bespoke exception. | Pending Developer Console registration & merchant profile. | Pending Apple Developer Program enrollment. |
| **Implementation State** | Webhook verification & order creation abstraction ready in `packages/services/commerce.js`. | REST client interface compatible with unified commerce layer. | Fully implemented in `server/google-play-billing.js` & `native/android/`. | Fully implemented in `server/apple-storekit.js` & `native/ios/`. |
| **Sandbox Status** | Sandbox testing supported via Cashfree Test Credentials. | Sandbox operational for generic digital goods, but live gaming is prohibited. | Google Play Billing sandbox ready. | StoreKit 2 sandbox testing verified. |
| **Recommended Alternative (if ineligible)** | N/A (Cashfree is optimal for India UPI/Netbanking). | **Paddle** or **FastSpring** (Established Merchants of Record for video games and digital game currencies). | N/A | N/A |

---

## 2. Indian Gaming Regulatory Analysis: Promotion and Regulation of Online Gaming Act, 2025 & Rules, 2026

### 2.1 The Regulatory Boundary
The Ministry of Electronics and Information Technology (MeitY) notified the **Promotion and Regulation of Online Gaming Act, 2025** and **Rules, 2026**, establishing strict governance over online games in India.

The legal test hinges on whether an online game constitutes an **"Online Real Money Game" (prohibited/heavily restricted)** or a **"Permissible Online Social Game / E-Sport" (permitted digital consumption)**:
> *"Online real money game means an online game where a user makes a deposit in cash or kind with the expectation of earning winnings on that deposit."*

### 2.2 Audit of Mega XO's Economic Mechanics

| Game Mechanic | Mega XO Implementation Fact | Legal / Compliance Analysis | Risk Level |
|---|---|---|---|
| **Crown Purchases** | Players pay INR via Cashfree to acquire Crowns (`crowns_100`, `crowns_525`, etc.). | **Deposit in cash:** Purchasing in-game currency with fiat currency constitutes a cash deposit into the game system. | Neutral (Standard IAP) |
| **Cash Out / Withdrawal** | Crowns and Coins **CANNOT** be withdrawn, redeemed for cash, or exchanged for real-world monetary items. | No cash-out mechanism exists. However, lack of cash-out does **not** automatically exempt a game if "winnings in kind" or tournament prize pools are derived from paid entries. | Low-Medium |
| **Tournament Entry with Crowns** | Public and private tournament tables require Crown contributions (`crownContributions`). | If paid Crowns are pooled to form an in-game prize pool (even in Coins/Crowns), regulatory authorities may scrutinize whether players participate *"with the expectation of earning winnings on that deposit"*. | **HIGH — MUST REVIEW** |
| **Ranked Mode Entry** | Standard ranked matchmaking consumes Coins (which are earned through gameplay or converted from Crowns). | Casual/Ranked play using free Coins is permissible social gaming. | Low |
| **Cosmetics & Frames** | Frames (`vector`, `midnight`, `paperclub`, `afterhours`) and Remove Ads. | Pure digital aesthetic goods with zero utility for betting. 100% compliant digital consumption. | Zero Risk |

### 2.3 Regulatory Questions for Qualified Legal Review:
1. *Does pooling purchased Crowns as a tournament entry fee to award higher Crown balances to 1st/2nd place constitute an "online money game" under Rule 2(qd) of the PROG Rules 2026, even when Crowns cannot be withdrawn for fiat currency?*
2. *Should Cashfree India checkout in Mega XO be strictly restricted to non-competitive cosmetic bundles (`remove_ads`, cosmetic credits) while disabling Crown entry fees for Indian IP addresses?*
3. *Does Mega XO qualify for registration with the Online Gaming Authority of India as a "Permissible Online Social Game" under Chapter II of the PROG Act 2025?*

---

## 3. Web vs. Android vs. iOS Purchasing Architecture

```
                                  ┌───────────────────────────┐
                                  │   Mega XO Game Client     │
                                  └─────────────┬─────────────┘
                                                │
                 ┌──────────────────────────────┼──────────────────────────────┐
                 ▼                              ▼                              ▼
      ┌────────────────────┐         ┌────────────────────┐         ┌────────────────────┐
      │   Web (Browser)    │         │ Android (Google)   │         │    iOS (Apple)     │
      └──────────┬─────────┘         └──────────┬─────────┘         └──────────┬─────────┘
                 │                              │                              │
       ┌─────────┴─────────┐                    │                              │
       ▼                   ▼                    │                              │
 ┌───────────┐       ┌───────────┐              ▼                              ▼
 │ Cashfree  │       │ Global MoR│     ┌─────────────────┐            ┌─────────────────┐
 │  (India)  │       │(Paddle/FS)│     │Google Play Bill.│            │ Apple StoreKit2 │
 └─────┬─────┘       └─────┬─────┘     └────────┬────────┘            └────────┬────────┘
       │                   │                    │                              │
       └───────────────────┴──────────┬─────────┴──────────────────────────────┘
                                      ▼
                      ┌─────────────────────────────────┐
                      │    Unified Commerce Service     │
                      │   (packages/services/commerce)  │
                      └───────────────┬─────────────────┘
                                      │
                                      ▼
                      ┌─────────────────────────────────┐
                      │  PostgreSQL 16 Durable Ledger   │
                      │  - monetization.receipts        │
                      │  - monetization.store_finalize  │
                      │  - economy.wallets (Crowns)     │
                      │  - economy.ledger               │
                      └─────────────────────────────────┘
```

### Routing Policy:
1. **Android Application (Google Play):** Must use **Google Play Billing** for all digital currencies and Remove Ads. External payment gateways (like Cashfree) cannot be embedded directly in the Play Store build without enrollment in Google's User Choice Billing program (which requires merchant verification and 11–15% Google service fees).
2. **iOS Application (App Store):** Must use **Apple StoreKit 2** exclusively. No external web payment links or third-party checkouts inside WKWebView.
3. **Browser Client (`play.antimatterinnovations.com`):**
   - **India Customers (Geo-IP `IN`):** Route to **Cashfree Payments** (UPI, Netbanking, Cards).
   - **International Customers:** Route to a gaming-compliant Merchant of Record (**Paddle** or **FastSpring**), withholding Dodo until explicit policy clearance is granted.

---

## 4. Product Catalogue & Invariant Enforcement

| Product ID | Type | Price (INR / USD) | Entitlement Granted | Re-purchase Policy |
|---|---|---|---|---|
| `crowns_100` | Consumable | ₹89 / $0.99 | 100 Crowns | Repeatable |
| `crowns_525` | Consumable | ₹449 / $4.99 | 525 Crowns | Repeatable |
| `crowns_1100` | Consumable | ₹899 / $9.99 | 1,100 Crowns | Repeatable |
| `remove_ads` | Non-Consumable | ₹199 / $1.99 | Permanent Ad Removal | Single-purchase (`product.once`) |

### Invariable Guarantees:
- **No Client Minting:** Clients never dictate Crown balances or successful payments. Only verified webhook or server-to-server callbacks create ledger entries.
- **Strict Idempotency:** Duplicate payment notifications with the same transaction ID return the cached grant without minting additional Crowns.
- **Rollback Safety:** If a transaction fails or is rejected before the database write, zero wallet modifications persist.
