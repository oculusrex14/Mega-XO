# Owner annotations 1-7: implementation receipt

Date: 2026-10-17. Executor: Codex lane. Plan of record:
[ANNOTATION-IMPLEMENTATION-PLAN-20261016.md](ANNOTATION-IMPLEMENTATION-PLAN-20261016.md).
Implementation branch: **V5.2**, baseline d6086a2 -> head 9d9f96f (receipt commit adds docs only).

## Per-comment record

| # | Owner outcome | Commit(s) | Key files | Verification | State | Remaining external prerequisite |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Store redesigned around the pass; transparent pass asset; gateway links answered | 7eff82e, 4685d24, d378037 | apps/web/pages.js (storePage), apps/web/store.js (new), packages/services/commerce.js, scripts/p21/build-web.js | tests/v5-p21-pages 18/18, tests/v52-polar-commerce 6/6, tests/v52-polar-provider 4/4, bundle builds 167 files | PASS locally | Live checkout needs Main's deployment plus POLAR_PRICE_MEGA_PASS / POLAR_PRICE_CENTS_MEGA_PASS in the approved env and the Polar sandbox catalog |
| 2 | Interests collapsed into a compact disclosure; space reclaimed for ad inventory | d378037 | apps/web/pages.js (sponsorsPage), apps/web/pages.css | tests/v5-p21-pages sponsor assertions | PASS locally | Real ad serving needs publisher site verification, ads.txt, consent integration and exact CSP domains (plan D2) - this run ships the CAPACITY LAYOUT only |
| 3 | Duplicate privacy/disclosure panel removed from Sponsors | d378037 | apps/web/pages.js | pages test asserts absence | PASS | - |
| 4 | Duplicated live-tournament catalog removed, integrated into the original cards | d378037 | apps/web/pages.js (tournamentsPage), apps/web/tournaments-view.js | pages tests incl. the canonical-mathematics catalog test | PASS | - |
| 5 | Join game enters the correct tournament; room roster/spectate workspace | d378037 (Join game + room-route navigation), d66c37d (F2 member rank projection + roster display) | apps/web/app.js, packages/services/tournaments.js, apps/web/tournaments-view.js | pages + app suites; tests/v52-web-tournaments 14/14; the full PG16 tournament HTTP suite proves the members projection both ways (self/public visible, friends-visibility refused) | PARTIAL - Join game, room navigation, roster rank projection and display done; the three-column workspace layout, the read-only spectate board and forged-move proof (plan F1/F3) are NOT RUN yet | Spectator board mode + workspace layout (plan F1/F3), native tabs (plan G), device matrix |
| 6 | Themes "More coming soon!" card | d378037 | apps/web/pages.js (themesPage), pages.css | pages suite: six cards, no purchase control | PASS | - |
| 7 | Live Store visible and truthful | 7eff82e, 4685d24, d378037 | apps/api/routes/monetization.js, commerce.js, app.js, pages.js | suites above; preview error shell keeps descriptions with one retry | PASS locally | Live guest/authenticated re-verification after authorized deployment |

## A1b transport defects - all repaired (7eff82e)

1. Player monetization POST routes parse raw-string/Buffer bodies via parseJsonBody; webhook lanes stay on exact raw bytes; malformed JSON classifies 409 INVALID_JSON, oversize 413.
2. The Polar checkout route sends a consistent customer shape (empty object when no email) - no more INVALID_COMMERCE_ARG dispatch failure.
3. Every createPolarCheckout return path (fresh, replay, lost race) carries the durable https checkoutUrl read back from the READY reservation; the provider refuses a non-https URL.
4. verifyWebhook accepts Standard Webhooks v1-framed signatures (single, space-rotated, comma-separated) and still rejects wrong versions/secrets; regression cases added.
5. The web offer catalog and pass state ride status() (4685d24) so the browser never depends on MegaBilling for web checkout; purchasesAvailable semantics unchanged.
6. The Cashfree SDK mode follows the server environment (order.environment) instead of hardcoded production; the preview CSP now allows the real SDK/api hosts and the production perimeter already did.
7. Polar presence detection resolves through the file-backed secret reader, so POLAR_ACCESS_TOKEN_FILE configures the lane.

## B2 subscription implementation (4685d24) and one recorded design decision

- Additive migration 0059: monetization.polar_subscriptions + pass_periods (core_runtime DML, backup_reader SELECT, no api/worker grants), applied through the checksummed manifest.
- Every subscription event is re-read from the provider before any write; the actor binding comes from the already-bound row or a recorded pass checkout with matching actor/product/price - metadata.actor alone never binds (proven by the orphan case in the disposable-PG suite).
- order.paid with subscription_id binds the subscription row inside the settlement transaction; cancel keeps the paid period; revocation ends it immediately.
- Canonical 150 Crowns per paid month as 50 at period start + 0/10/20 days bounded by the paid period end, granted by the bounded processPassGrants sweep in one Core transaction with an installment marker; the v5 production server runs it every 50s with single-flight and fail-loud logging.
- Design decision (plan B2.4 nuance, flagged for Main/Sol review): renewal periods are created from the PROVIDER-VERIFIED active window (Polar advances current_period only after a successful billing payment; failed renewals go past_due and keep the old window) rather than from a separate paid-order read, which Polar does not expose per renewal without an extra orders query. The sweep still bounds every grant by that window.
- NOT RUN this run: the pass allowance ledger for the 8:1 exchange and the two discounted pack uses in the V5 economy paths (plan B3 allowance usage). The 150-Crown installments, ads-off and entitlement revoke are live; exchange/discount enforcement is the next slice and must not be promised by UI copy until it lands.

## Recorded deviations

- Polar checkout opens a new tab with a bounded actor-bound status poll instead of a redirect round trip (plan A3 prefers fixed same-origin return routes); same-tab fallback when popups are blocked. The return-route variant needs a success-URL template decision with Main; recorded open.
- The store error/loading states keep the known product shell visible with prices hidden and actions off (plan A2) - the previous behavior wiped the page.
- tests/monetization-http.test.js passes its assertions but its process does not exit (pre-existing legacy-server handle, unrelated to these changes).

## Environment evidence

- Local review server: http://127.0.0.1:4196 (port 4195 is held by the Main agent's supervised lr21 artifact).
- Built artifact: .artifacts/annotation-review-web, 167 files, source commit 9d9f96f, bundle sha256 d6f43a000cef23ab1abb3083758846922909191e2a4010c7ddc39fa9cef51797.
- Device matrix (plan I2) NOT RUN: both phones required; the iPhone lane remains blocked as recorded in the LR22 checkpoint.
- LR02 final CI re-verification stays LAST per the owner's standing order; Main's merged-head CI is authoritative until then.

## Provider matrix (honesty table)

| Provider | Catalog in code | Webhook route | Sandbox verified | Deployed | Live verified |
| --- | --- | --- | --- | --- | --- |
| Polar (primary global + Indian fallback) | Yes, incl. the optional mega_pass price | /api/monetization/polar/webhook (verified HMAC + subscription routing) | No (no sandbox charge made) | No | No |
| Cashfree (India one-time) | Yes (four one-time products) | /api/monetization/cashfree/webhook | No (no charge made) | No | No |
