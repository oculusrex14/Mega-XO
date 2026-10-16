# Payment gateway research and decision record - 16 October 2026

**Author lane:** Codex app (website/commerce). **Status:** Research complete; Cashfree web integration built in this same change (see `server/cashfree.js`, `server/production/config.js`, `apps/web`). **Owner decision pending:** which global MoR account to open.

## 1. The decisive policy split

Gateway acceptance does not depend on "games" as a category - it depends on WHAT is sold. Mega XO sells two product classes and the policies differ per class:

- **Crowns (virtual currency, consumable):** several MoRs explicitly prohibit in-game currency.
- **Remove Ads / premium unlock (ordinary digital goods):** accepted broadly.

On mobile this question is moot: Google Play Billing and Apple StoreKit 2 are the mandatory rails for all digital goods (15% tier for <$1M/yr on both). The gateway question applies to the WEBSITE only.

## 2. Verified provider matrix (sources checked 2026-10-16)

| Provider | Games? | Virtual currency (Crowns)? | Solo devs? | Verdict for Mega XO | Source |
|---|---|---|---|---|---|
| **Dodo Payments** | No - prohibited | No - prohibited | Yes | **Do not use** for any game-adjacent sale | Public Merchant Acceptance Policy prohibits "games of skill, online/video games, in-game currencies, digital item sales, game boosters"; matches the owner's account experience (Oct 2026) |
| **Paddle** | Yes - dedicated games solution (own games, DLC, subscriptions) | **No** - AUP prohibits "virtual currency, stored value, gift cards, vouchers" | Yes | Good fit for Remove Ads / premium unlock / game itself; NOT for Crowns | paddle.com/games; paddle.com AUP |
| **Lemon Squeezy** | Yes - ordinary digital games allowed (their own tax docs cite game examples) | Not explicitly listed in public docs - verify with sales before relying on it | Yes | Acceptable fallback; owned by Stripe | docs.lemonsqueezy.com prohibited-products |
| **Creem** | Yes - indie SaaS/games explicitly welcomed; only gambling/casino-style prohibited | Treated as "credits/rewards" - **must confirm** Crowns are not construed as redeemable points (they are not: no cash-out exists) | Yes, solo-dev friendly | Strong candidate; fee ~3.9%+$0.40 per transaction | creem.io prohibited/restricted list |
| **Polar** | Yes - "digital products" scope; no games prohibition | Same caveat - non-redeemable currency is an ordinary digital good, but confirm in writing | Yes, indie-focused | Strong candidate; fee 4%+$0.40 | polar.sh |
| **Cashfree** | Gaming is a HIGH-RISK category requiring approval; casual games with NON-REDEEMABLE virtual items are a plausible approval (PROG Act 2025 distinguishes real-money games) | Allowed if not redeemable for cash (Mega XO Crowns cannot be cashed out) | N/A (India entity) | **IN USE for India** - account live, integration in this change | Cashfree prohibited/restricted categories; docs.cashfree.com |

## 3. Recommended structure

1. **India (web):** Cashfree Payment Gateway - INR checkout via UPI/cards/netbanking. Implemented: order creation is server-to-server with our own order ledger (`v52_cashfree_orders`), the webhook signature (`Base64(HMAC-SHA256(secret, timestamp+body))`) plus an independent `GET /pg/orders/{id}` verification before ANY grant, and the idempotency family of store purchases. The browser only ever receives a `payment_session_id`.
2. **Global (web), Remove Ads / premium:** Paddle or Polar or Creem - decide by fee + approval speed; all three accept solo developers.
3. **Global (web), Crowns:** the clean path is to sell a **premium pass / bundle** (an entitlement, not stored value) rather than raw currency. Paddle cannot sell virtual currency; Creem/Polar likely can but require written confirmation. If raw Crowns are required globally, Xsolla (game-specialist) is the fallback.
4. **Mobile:** Play Billing (crowns_100/525/1100 + remove_ads) and StoreKit 2 - already implemented in `server/google-play-billing.js` / `server/apple-storekit.js`; products must be created in the consoles before `MEGA_PURCHASES_ENABLED=true` flips on.

## 4. Indian regulatory note (from docs/v5/UNIFIED-COMMERCE-READINESS.md)

The PROG Act 2025 prohibits only "online real money games" (deposit with expectation of winnings). Mega XO Crowns cannot be withdrawn; tournament Crown pools deserve a legal review question before launch - see section 2.3 of that document. Cashfree's category approval should be requested with that framing (casual skill game, non-redeemable currency).

## 5. What the owner still decides

- Open the global MoR account (recommended: **Polar or Creem** for the first integration; Paddle if the premium-pass structure is chosen and review bandwidth allows).
- Confirm Cashfree category approval once KYC completes (VCIP is pending on the account).
- Decide the premium-pass vs raw-Crowns structure for global web sales.

## 6. Evidence

- Cashfree production keys: stored on the VPS at `/opt/mega-xo-v5-production/secrets/cashfree.env` (mode 600, never committed).
- Cashfree dashboard: API key pair generated 22 Aug 2026 (App ID visible in transcript; secret revealed once via OTP and streamed to the VPS).
- Provider policies: quoted from each provider's public policy pages on 2026-10-16.
