# Main-agent handoff: monetization surfaces (16 October 2026, Codex lane)

Owner priorities this cycle: ads live, Cashfree on the website, Paddle as the final global PG (premium-pass structure accepted), and the banked-powers feature. This document is the complete takeover brief. The implementation reference is PR #19 (`codex/cashfree-web-payments`).

## 1. Authoritative state of megaxo.online

- The live process is `scripts/v51/v5-production-server.cjs` (systemd `mega-xo-v5-production`), composing `apps/api` + `packages/services` on Neon PostgreSQL. `server/production/**` is the LEGACY SQLite authority (V4.1.2) - kept for recovery, NOT the live path.
- The live API has NO monetization surface: `/api/monetization/*` 404s. That is why AdMob SSV verification fails (`HTTP 404` from Paddle-verified probe) and why the store shows unavailable.
- `packages/services/commerce.js` (P04, core_runtime-owned) is COMPLETE and unused: `ticket/claim/callback/automaticPermit/purchase/refund/status/cosmetic/processPurchaseFinalizations`. It refuses any pool whose role is not `core_runtime`.
- Role rule: `api_runtime` holds no monetization/economy DML (0021/0022). The API surface MUST reach commerce over the signed core ingress (`createCoreServiceIngress` in `packages/services/core-gateway.js`), exactly like queue/leaderboard/tournaments. Do not widen grants, do not hand the API context a Core pool.

## 2. Required work A - ads live (V5)

1. `packages/services/core-gateway.js`: add signed ingress paths mirroring the tournaments pattern - `/ingress/monetization/status|ticket|claim|permit|purchase|ssv`. The `createCoreServiceIngress` composition gains a `commerce` facade (the instantiated `createCommerceService(corePool, {...})`). Sign the SSV forwarding with a pseudo-actor; `commerce.callback` re-verifies everything itself.
2. `createCoreGateway` client: matching methods (`monetizationStatus`, `monetizationTicket`, `monetizationClaim`, `monetizationPermit`, `monetizationPurchase`); SSV is server-to-server, so the API route forwards the raw query only.
3. `apps/api/routes/monetization.js` + one line in `apps/api/index.js`: routes `/api/monetization/status|reward-ticket|claim|interstitial-permit|purchase|restore|admob-ssv` with the SAME request/response shapes as `server/monetization-http.js` (clients are unchanged). `resolveAuth` + `accounts.csrf` for session routes; the SSV route is unauthenticated (signature is the auth).
4. Env (fail-closed parser can be lifted from PR #19 `server/production/config.js` cashfree block and the ads block): `MEGA_AD_MODE=rewarded` (hybrid later), `ADMOB_ANDROID_REWARDED_UNIT=ca-app-pub-5255314563073178/9122606653`, `ADMOB_ANDROID_INTERSTITIAL_UNIT=.../5293761020`, `ADMOB_IOS_REWARDED_UNIT=.../3009633608`, `ADMOB_IOS_INTERSTITIAL_UNIT=.../5652853678`, `MEGA_AD_CONSENT_VERSION` (any `^[A-Za-z0-9._-]{3,64}$`), plus `MEGA_ACCOUNT_DELETION_ENABLED=true` + policy versions (ads gate requires the privacy release).
5. Deploy via `scripts/v51/deploy-production.cjs`; then in the AdMob dashboard set the SSV callback URL `https://megaxo.online/api/monetization/admob-ssv` on BOTH rewarded units (edit ad unit -> Advanced settings -> Server-side verification; the parameter-less probe now answers 200 per PR #19).
6. Native builds: pass the real app IDs - iOS xcodebuild `MEGA_ADMOB_APP_ID=ca-app-pub-5255314563073178~3080117498`, Android `MEGA_ADMOB_APP_ID=...~4393199164` (gradle). Ad UNITS always come from the server ticket response.

## 3. Required work B - Cashfree on V5

1. PG migration (serialized-schema lane): `commerce.cashfree_orders(order_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, product_id TEXT NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'INR', status TEXT NOT NULL, created_at BIGINT NOT NULL, settled_at BIGINT)` + grants to core_runtime only.
2. `packages/services/commerce.js`: port the three methods from PR #19 `server/monetization-store.js` (`existingCashfreeOrder/recordCashfreeOrder/settleCashfree`) - same idempotency family, amount+currency re-verified against an independent `GET /pg/orders/{id}`.
3. Route the new `/api/monetization/cashfree/*` paths through the ingress like section 2; provider keys already on the VPS at `secrets/cashfree.env` (mode 600). Register the webhook `https://megaxo.online/api/monetization/cashfree/webhook` in the Cashfree dashboard.

## 4. Paddle (final global PG) - status and next steps

- Live account exists (Antimatter Innovations, live mode). Verification (step 02) is the owner's action. The Codex plugin `paddle@paddle-agent-skills` is installed with `paddle-live` MCP (browser OAuth, starts read-only; owner grants write under Connectors > MCP at vendors.paddle.com/mcps).
- Product structure (policy-compliant; Paddle prohibits virtual currency but allows game items/entitlements): (a) Remove Ads - one-time, tax `digital-goods`; (b) Premium Pass - recurring month/year, grants ad removal + daily banked power + cosmetics (NO crowns); (c) Power Packs - consumable banked-power bundles (in-game items). Crowns stay Cashfree-India + mobile IAP only.
- Next session: authorize the live MCP in the browser, create the catalog per the `catalog-setup` skill, register webhook `https://megaxo.online/api/monetization/paddle/webhook`, wire checkout per the `checkout-web` skill.

## 5. Banked powers + opponent block feature (design agreed with owner)

- Powers are obtained two ways: Crowns (buy a banked/stockpiled power, consumable) or a rewarded ad (instant use). Banked powers persist until used.
- Casual play, when a power is initiated the opponent gets a confirm popup: "Your opponent watched an ad to use an Undo power up! Block it?" with options: use a banked block (if owned), watch an ad to block, or cancel (let it through). This needs a realtime notification channel + a server adjudicated power window (the defender's answer must be authoritative, client timers are cosmetic).
- NOT yet implemented - needs a code survey of `src/powers-ui.js`, `src/game.js` and `src/monetization.js` grant paths first, then a spec against the frozen rules (owner-approved feature; do not silently weaken ranked integrity - ship on casual only to start).

## 6. Immediate owner actions

- Paddle: complete account verification (onboarding step 02).
- Cashfree: finish KYC/VCIP, then request the casual-game category approval.
- AdMob: nothing - account verification is automatic; store links (Play/App Store) lift the limited-serving flag once apps are published.
