# Codex LR22 - commerce/auth lane checkpoint (2026-10-16)

Trunk: V5.2 @ cc9f2e5 (this doc lands on top). Owner-reported lane: crown power-up purchase
bug, Mega Pass recurring redesign, account-link completion, store/art assets, device refresh.

## Landed

1. **Crown power-up purchase fixed** - src/app.js spend adapter passed ('crowns', cost) into
   D.spendCurrency's (id, currency, amount) - every purchase threw INVALID_CURRENCY and showed
   the generic toast. Fixed arg order; verified in-browser: 0-crown path shows the truthful
   "Not enough Crowns" message, funded path banks the charge, debits 2, ledger entry recorded.
2. **Account-link choice flow, end to end** (8b8d811) - decided UX + Sol (Sagan, xhigh) security
   review verdicts: ownership proof required for BOTH link and deletion scheduling; ambiguous
   email matches refuse link; single-use/expiry/session-bound decisions persisted on the consumed
   attempt (decision columns incl. decision_subject); cancellable 30-day scheduled deletion with
   busy-postponing sweep; Google authorization now requests the email scope; verify() returns
   the provider email only when email_verified is exactly true (Apple "true" string accepted).
   Web + native decision routes, callback choice redirect, community.js dialogs. Tests:
   tests/v52-account-link.test.js 6/6; community 18/18; community-http 10/10 (known exit hang);
   account-deletion 4/4; operator-service 9/9; privacy-export 4/4; v5-migration-extract ok.
3. **Mega Pass recurring** (5977dcf) - Planck (Sol 6.1 xhigh) priced: $3.99/mo, 150 Crowns/month
   as 50+50+50 on billing days 1/11/21, 2x bot-win Coins before the daily cap, 8:1 exchange
   capped at 200 Coins/month, 15% off two packs/month, automatic ads off (rewarded optional).
   src/monetization.js PASS + helpers (policy tests 8/8, store tests 13/13); legacy-server
   v52_pass entitlement (only created when Polar is configured), signature-verified Polar
   subscription webhook (/api/monetization/polar/webhook), status pass block, removeAds while
   active, durable per-period installment sweep in the maintenance loop.
4. **Store art + emblem** (cc9f2e5) - generated gold-crown banner (assets/p21/art/mega-pass.png
   -> assets/art/mega-pass.png in the site build), full-width pass panel on the P21 store page
   with benefits/price/subscribe state and honest auto-renew copy; app store card shows the
   crown-ticket SVG emblem (MegaIcons.pass) and Active state.
5. **Devices** - OnePlus 5199676e: lr21.2 (versionCode 10) installed via adb install -r
   (data preserved). APK: native/android/app/build/outputs/apk/online/debug/app-online-debug.apk.

## Open (next lane)

- iPhone lane: reconnect, port lr21.2, then the F1-F5 session-manager audit ports to
  MegaNativeSession.swift (unchanged from the LR21 register).
- Native store subscription products: Google Play Billing + Apple auto-renewable for mega_pass,
  then RTBN/ASSN verification wiring into the same v52_pass row (PG commerce parity for
  subscriptions lives in packages/services/commerce.js - the legacy lane is authoritative today).
- Conversion (8:1) and pack-discount (15%) ENFORCEMENT points: the entitlement + allowances
  ledger ship and status exposes them; the Core convert command and Cashfree/Polar price
  selection must read the pass block to apply member rates (documented, not yet wired).
- Polar: create the recurring monthly price for mega_pass, set POLAR_PRICE_MEGA_PASS +
  POLAR_PRICE_CENTS_MEGA_PASS; Cashfree subscription mandate flow stays deferred (Polar is the
  Indian fallback per the owner decision).
- Web preview for owner review: run "node scripts/p21/build-web.js --output
  .artifacts/lr21-review-web && node scripts/p21/serve-web.js --port 4195 --directory
  $PWD/.artifacts/lr21-review-web" (the game app with the purchase fix + account-link prompt
  is under /legacy-game/).
- LR02 final CI re-verification stays LAST per the standing register.
