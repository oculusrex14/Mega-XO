# Owner annotations: Store, sponsors, tournaments and themes

Date: 2026-10-16. Status: **PLAN ONLY — implementation and acceptance pending**.
Owner request: turn browser comments 1–7 into a detailed, committed execution specification.
This document does not claim that the changes below, provider configuration, or deployment have happened.

## 1. Read this first

### Source and integration baseline

- Reviewed implementation: V5.2 at **d6086a226228be50ba7e3e58006042420a138c6a** in the owner's Test XO checkout.
- Repository instructions supplied with this request still name **V5.1 as the only integration trunk**. Its observed tip was 077bfbc0cc0dc24c4e1e9becb6c264e585108b93. Accordingly, this plan is a documentation-only commit based on V5.1; it does not merge the later implementation into that branch.
- Before executing, inspect current owner/Main integration instructions and ancestry, select the authorized implementation base, and re-anchor the symbols below. Do not implement against the older V5.1 code merely because this document is recorded there. Do not interpret this plan as permission to merge V5.2 into main or to rewrite branches.
- Preserve unrelated local work. Use detached worktrees for separate slices, one integration owner, explicit file staging, and fast-forward pushes. Keep main, V4.1 and recovery history intact.
- Read AGENTS.md and the relevant product/native commerce contracts first. The owner's seven comments authorize the specified redesign; historic instructions to defer the website are superseded. Existing rules, rank/entry requirements, economy, consent and authority boundaries remain applicable.
- The current request is to **record a plan**, not to implement it or resume phone testing during this planning turn. An executor subsequently directed here should implement the work in the order below.

### Reproducible observations, not assumptions

Read-only HTTP probes on 2026-10-16 around 23:25 IST observed:

| Target | Observed result | What it proves |
| --- | --- | --- |
| https://megaxo.online/store | 200 HTML, Store title, data-store-products present | The public route exists; it does not prove client hydration or checkout works. |
| https://megaxo.online/api/monetization/status | 404 JSON, NOT_FOUND, unauthenticated request | There is a live route/composition/deployment discrepancy to resolve. A correctly mounted protected route should give a classified auth response rather than NOT_FOUND. Recheck authenticated behavior. |
| https://megaxo.online/api/party/capabilities | 200, low/medium/high/premium table IDs | The public tournament capability catalog is reachable. |
| /tournaments, /sponsors, /themes on the public origin | 200 HTML | Routes exist; no interactive or physical-device acceptance was performed here. |

The local review server on port 4195 is primarily a static preview. scripts/p21/serve-web.js is not a full commerce/account backend. Its deliberate preview refusals must not be copied into production, and a local static preview cannot establish paid fulfillment. Do not proxy authenticated production cookies to localhost to make a demo appear functional.

### Annotation coverage

| Owner comment | Required outcome | Work packages |
| --- | --- | --- |
| 1 | Redesign the entire Store around a coherent monthly pass, Crown packs and ad removal; replace the landscape banner with a transparent object asset; verify gateway links | A, B, C |
| 2 | Collapse interests into a compact dropdown/disclosure and reclaim space for useful ad placements | D |
| 3 | Remove the duplicate privacy/disclosure panel from Sponsors | D |
| 4 | Remove the duplicated live tournament catalog; integrate its behavior into the original table cards | E |
| 5 | Join game must enter the correct tournament; roster/name/rank/friend actions left, own game center, other fixtures/watch right; equivalent native experience | E, F, G |
| 6 | Add a sixth theme-grid card reading More coming soon! | H |
| 7 | Make the live Store visible and usable, with truthful availability and recovery behavior | A, B, C, I |

## 2. Verified source map

All paths/symbols in this section refer to the reviewed d6086a2 baseline. Prefer symbols over line numbers after merging other work.

| Area | Files and entry points | Existing behavior / gap |
| --- | --- | --- |
| Website page templates | apps/web/pages.js: storePage, sponsorsPage, tournamentsPage, themesPage | Store pass is a separate full-width image block. Tournament payout cards and live controls duplicate the catalog. Sponsors uses two large preference/disclosure panels. Five theme cards leave an empty cell. |
| Website state and routing | apps/web/app.js: productIds, refreshProducts, cashfreeCheckout, pollCashfreeStatus, activate, render, updateTournamentControls, synchronizeTournamentView, tournament click delegate | productIds contains four one-time products and **omits mega_pass**. refreshProducts does not consume Polar availability or pass state. Checkout has no Polar branch. Manual Check store availability is injected on every Store render. |
| Store layout | apps/web/pages.css: pg-store-*, pg-pass-* near the store section | pg-pass-art fills the card width, object-fit:cover, landscape banner treatment; does not match small transparent currency art. |
| Existing object art | apps/web/ui.js: icon; assets/p21/art/currency/coin.webp and crown.webp | Coin/Crown images already render with alpha over the site atmosphere. These are the style references. |
| Build and static serving | scripts/p21/build-web.js: WEB_FILES, OPTIONAL_WEB_FILES, WEBSITE_ROUTES, createPlan; scripts/p21/serve-web.js: CSP, resolveStatic | Modules/assets/routes are positively allowlisted. Art WebPs are mapped from assets/p21/art to assets/art. mega-pass.png has an extra explicit copy. Production imports this server's CSP. |
| Live server composition | scripts/v51/v5-production-server.cjs | Composes V5 API, signed Core ingress and commerce on the Core role; contains Cashfree/Polar configuration. Inspect actual deployed SHA/config, do not assume this checkout is live. |
| V5 money path | apps/api/routes/monetization.js; packages/services/commerce-ingress.js; packages/services/core-gateway.js; packages/services/commerce.js; packages/services/polar.js | Session/CSRF API -> signed ingress -> Core. Existing Polar create/status/webhook path is predominantly one-time checkout handling; inspect recurring support before enabling the pass. |
| Legacy pass work | src/monetization.js: PRODUCTS, PASS and pass helpers; server/monetization-store.js; server/monetization-http.js | Monthly pass helpers and a SQLite pass implementation exist. They are **reference behavior**, not permission to restart a SQLite writer or evidence that V5 PostgreSQL subscriptions work. |
| Website tournament controller | apps/web/tournaments.js: createTournamentsController, tournamentFixture, tournamentMatch | Has member validation, revision/session fencing, retry keys, own-fixture projection. An explicit foreign fixture is intentionally rejected by the player helper. Preserve that security property. |
| Website tournament rendering | apps/web/tournaments-view.js: renderTournamentControls | Live catalog, lobby readiness, own fixture and results exist; no complete requested room workspace. |
| Tournament API/Core | apps/api/routes/tournaments.js; packages/services/tournament-http-contract.js; packages/services/core-gateway.js; packages/services/tournaments.js: eligibleAccount, view, run | Existing GET room view requires membership and returns T.view; public commands are strictly allowlisted. Eligibility is verified, not held/suspended, and at least ten completed games at this baseline. It is not an arbitrary minimum-rank check. |
| Pure tournament rules | src/tournament.js: TABLES, prize, join, view | Canonical fee/prize catalog and schedule. Player rows initially contain id/name/ready/withdrawn, **not rank**. T.view strips review-only risk/timing data; do not undo those redactions. |
| Board | apps/web/board.js: mountBoard, renderGame, createServerBoardSession integration | Online mounting requires an onMove callback today. Add a real read-only viewer rather than passing a fake participating actor or a no-op move callback. |
| Friends | apps/web/friends.js: createFriendsController, allowedActions, action; apps/api/routes/social.js | Friendship changes use /api/community/friend with actor session and one operation key in body+header. The existing page controller refuses actions on targets outside its own trusted lists; a tournament button cannot simply call action on an arbitrary ID. |
| Native shared UI | src/party-ui.js: tables, drawRoom, showRoom, fixture/game handling; src/party.css | Existing private/public lobby and Watch affordances offer a starting point. Web columns must translate to accessible phone tabs, not a desktop layout squeezed onto a phone. |

## 3. Execution boundaries and order

1. **I0 preflight:** freeze current integration SHA, identify live-vs-source discrepancy and provider/catalog state read-only. Capture current screenshots and sanitized route results.
2. **A + B contract first:** freeze Store state/offer DTO and recurring subscription authority. One owner serializes API/Core/schema changes.
3. **C/D/H in parallel:** Store presentation/asset, Sponsors and the theme placeholder can proceed after the contracts are agreed. Assign disjoint files or serialize edits to pages.js/pages.css/app.js.
4. **E/F/G:** consolidate tournament catalog, then room/player/spectator/friend behavior, then native presentation using the same server projections.
5. **I acceptance:** exercise full routes on a disposable V5 stack, browser and physical phones. Main owns any production deployment. LR02 final CI re-verification stays last per the owner's standing order.

Use small commits: (1) contracts/service changes, (2) Store UI/asset and checkout, (3) Sponsors, (4) tournament catalog, (5) workspace/read-only viewing/friends, (6) native presentation, (7) theme placeholder, (8) final evidence. Do not commit generated builds, credentials, player records or authenticated traces. Do not change pricing/benefits as a side effect of layout work.

## A. Store visibility, catalog and checkout state (comments 1 and 7)

### A1. Diagnose the live discrepancy before editing around it

- Inspect the live process/artifact SHA and API composition read-only using Main's deployment receipts. Locate handleMonetizationRoute registration in apps/api/index.js and context.monetization wiring in v5-production-server.cjs. Compare against the currently serving files; 404 is not proof that the route is absent in source.
- Recheck guest and signed-in requests. Classify NOT_FOUND vs AUTH_REQUIRED vs MONETIZATION_UNAVAILABLE; inspect browser console/module/CSP failures without saving secrets. Also test direct /store navigation, SPA navigation and back/forward.
- Capture only status/error codes, build SHA, provider-enabled booleans and public catalog IDs; never save cookies or full personal/provider payloads.
- Restore the existing V5 composition through a normal reviewed change if missing. Do not substitute server/monetization-http.js or enable the legacy SQLite service.

### A1b. Repair these specific transport defects before UI checkout testing

Sol 6.1 xhigh performed an independent read-only source review and file-free probes against d6086a2. Its findings below are source/local evidence, not live provider verification:

| Defect | Required edit | Required regression |
| --- | --- | --- |
| Monetization player routes assume req.body is already an object, but the mounted API passes raw JSON strings | In apps/api/routes/monetization.js use the existing parseJsonBody helper for player POST routes before validating product/customer or resolving body operation keys. Leave callbacks on the exact raw bytes. | Send actual streamed HTTP requests through createApiHandler: valid Polar/Cashfree bodies reach Core; malformed JSON is classified; webhook bytes stay unchanged. Do not test only with a pre-populated object body. |
| Polar optional-email route permits an omitted customer while commerce-ingress OPS.polar_create requires customer | Freeze a consistent shape (e.g. customer:{} when email is absent), validate optional contact fields and use the same shape route -> gateway -> ingress -> service. | Omitted email, empty customer, valid email and invalid email each have a deliberate outcome; no unclassified dispatch failure. |
| createPolarCheckout receives checkoutUrl but drops it from initial and replay replies | Return a validated checkoutUrl and expiry from the durable creation result to the owning actor; reuse that result on retries without another provider create. Inspect monetization.commerce_create_requests response storage and the existing reservation fence. | Initial response and replay lead to the same checkout; cross-actor lookup denied; expired link requires safe reconciliation; unknown result cannot create a second charge. |
| Standard Webhooks signature framing is not accepted by current Polar verifier | Correct versioned v1 signature parsing or use the current supported verifier; preserve timing-safe comparison/raw-body binding. Current synthetic tests accept a bare HMAC and conceal the version-prefix problem. | Realistic v1,<signature>, rotation/multiple signatures, timestamp window, bad version/body/secret all tested independently. |
| Native-only purchasesAvailable and absent web catalog/pass state | Extend the V5 projection and normalize it separately as specified in A2; never require MegaBilling for web checkout. | Browser with no native bridge still receives configured web offers, unavailable reason and dated pass state. |
| Cashfree SDK is excluded by the imported preview CSP; mode is hardcoded production | Use a narrow environment-aware CSP/config contract for the real provider paths. Sandbox provider creation and SDK mode must agree. | Actual browser checkout can load the allowed SDK in the intended environment; unapproved hosts remain blocked. |
| Polar composition is guarded only by process.env.POLAR_ACCESS_TOKEN, so token-file-only config never reaches the secret reader | Make presence detection and secret resolution consistent for approved _FILE configuration, with no secret logging. | Inline-token and file-token setups configure the same adapter; absent/partial/invalid configuration has deliberate fail-closed behavior. |

Fix these under the existing reserve-before-create and callback admission protections. Do not relax HMAC, callback IP admission, CSRF, database roles or operation-key conflict checks to make the new UI work. Run the creation-race tests after changing the returned payload.

### A2. Freeze a provider-neutral offer contract

Introduce apps/web/store.js as the page-scoped controller, with a pure normalizer that can be tested independently. Add it to the packaging allowlist. Move refresh/checkout/return handling out of the large click delegate in app.js.

Proposed internal view model (new contract, not an existing response):

~~~ts
type ProductId = 'crowns_100' | 'crowns_525' | 'crowns_1100' | 'remove_ads' | 'mega_pass';
type StoreView = {
  status: 'loading' | 'ready' | 'error';
  actorId: string | null;
  offers: Array<{
    id: ProductId;
    kind: 'consumable' | 'non-consumable' | 'subscription';
    interval: 'month' | null;
    state: 'available' | 'owned' | 'unavailable';
    unavailableReason: string | null;
    options: Array<{
      provider: 'polar' | 'cashfree' | 'apple' | 'google';
      currency: string; amountMinor: number; localizedPrice: string; available: boolean;
    }>;
  }>;
  pass: { active: boolean; periodEnd: number | null; cancelAtPeriodEnd: boolean };
  pending: null | { actorId: string; provider: string; key: string; objectId: string | null };
  errorCode: string | null;
};
~~~

This is a type sketch for a JavaScript implementation, not a requirement to migrate the project to TypeScript. Render the actual returned offer. Currency-specific formatting comes from integer minor units + supported currency exponent. Native localized store prices remain native-authoritative. Do not show a zero price, exchange-rate estimate, or suggestedUSD as an actual charge.

- Include all five approved product IDs, including mega_pass; reject unknown product/provider rows. A subscription is not permanently owned merely because a historical receipt appears in products.
- V5 status currently returns native purchasesAvailable/storeContext but not the web catalog needed by refreshProducts. Extend Core status with sanitized web offers and current pass state. Keep native purchasesAvailable semantics intact; lack of a native bridge must not disable browser checkout.
- If guests need prices, expose a **separate public catalog projection** (e.g. GET /api/monetization/catalog) with no actor/entitlement fields, or an explicitly public branch that cannot read private state. Keep existing personalized status protected and no-store. Do not weaken status authentication for catalog browsing.
- Keep the Store shell and known product descriptions visible on loading, auth expiry, empty catalog and service error. Render an inline status/retry region; never wipe the page or hide it behind a blanket availability boolean. A guest signs in only when attempting a purchase.
- Fetch on entering Store, on relevant session changes, after checkout return and on retry. Remove the always-present Check store availability control. Retry appears only for a real failed read. Bound requests and fence replies by actor, session generation and route; avoid overlapping activation/render fetch loops.

### A3. Provider routing and pending purchase rules

- Native apps: use verified Apple/Google billing capabilities for digital goods. Do not route a native digital purchase through the web gateway because IAP is missing.
- Browser: Polar is global primary. For Indian one-time offers prefer Cashfree when healthy and configured; show Polar as the fallback with its actual currency/tax quote. Mega Pass uses Polar recurring billing in India too until a separate Cashfree recurring mandate flow exists.
- Routing must use server-validated product offers and trusted regional context. Do not create a gameplay geography restriction or silently infer a payment region from browser language alone.
- Each user checkout intent receives one durable operation key reused for retry. Disable only the affected action while pending. Store no receipt, access token or customer PII in browser storage.
- A definitive provider-unavailable response may offer the other provider. After timeout/unknown creation outcome, first reconcile the existing intent; **do not automatically start a second provider charge**. Switching provider requires a fresh visible quote and confirmation. Never migrate an existing recurring mandate automatically.
- Reuse existing /api/monetization/polar/checkout and /polar/status route spellings only after confirming them in the router; Cashfree uses /cashfree/order and /cashfree/status. Body uses internal product ID, never a client amount/price ID. Restrict redirect URLs to approved provider hosts and HTTPS; use fixed same-origin return routes.
- Checkout return/cancel URL is navigation only. Show Verifying payment, then query the actor-owned provider object/status. Display success only after durable server confirmation. Add webhook-before-return, return-before-webhook, delayed verification and user-cancel paths.
- Preserve the native finish-after-durable-delivery rule. Remove the current browser success toast immediately after starting Cashfree checkout: opening a gateway is not verified delivery.
- Scope provider CSP additions to the actual hosted checkout/SDK domains and required script/frame/connect directives; preserve object-src/base-uri/frame-ancestors restrictions. Update the canonical production header source and test it. Do not use wildcard origins to fix a CSP error.

**Done when:** direct and SPA Store navigation stay visible for guest/linked/error states; an unavailable gateway has a useful message; correct provider checkout opens; no unverified success or cross-actor result is displayed.

## B. Make Mega Pass a real V5 subscription (comment 1 backend question)

### B1. Provider-console inventory and links

This planning turn did not inspect or modify the Polar dashboard. The prior LR22 checkpoint explicitly lists monthly catalog creation/configuration as OPEN. Therefore the answer to “are the backend payment links added?” is **not yet proven, with known remaining work**.

Executor must inventory the existing organization, environment, product and recurrence before creating anything. Reuse matching objects. The current POLAR_PRICE_* variable name is potentially misleading: packages/services/polar.js sends products:[priceId]. Verify the current Polar API's product-vs-price ID semantics with actual sandbox payloads and official docs; validate the configured resource, organization, monthly interval, amount and currency rather than trusting a UUID-shaped value.

- Required links: authenticated checkout creation; fixed https://megaxo.online/store return/cancel handling; signed https://megaxo.online/api/monetization/polar/webhook; actor-bound customer-portal session for Manage subscription; public support/privacy/terms links.
- Required configuration includes POLAR_ACCESS_TOKEN, POLAR_ORGANIZATION_ID, POLAR_WEBHOOK_SECRET and validated catalog mapping for mega_pass. Existing names POLAR_PRICE_MEGA_PASS / POLAR_PRICE_CENTS_MEGA_PASS are references, not proof production reads them. v5-production-server.cjs currently iterates PRODUCT_IDS: extend the supported catalog intentionally and avoid making an optional missing pass disable every one-time product.
- Store secrets in existing approved private secret storage only. Record public product ID, billing interval, currency, price, enabled state and redacted verification result in the release receipt. Provider verification alone does not establish approval of this exact currency-bearing game/pass product.
- Configure sandbox first; retain exact product eligibility/approval evidence. Do not make a real test charge, accept formal attestations or publish a new paid price under this plan-only request. At implementation time honor the owner's then-current pricing/release authority.

### B2. PostgreSQL/Core implementation

Use packages/services/commerce.js and the Core unit of work. Port **behavior**, not the SQLite table or connection, from server/monetization-store.js. Add an additive migration, numbered from the current manifest after coordinating with Main. Proposed Core-owned records:

- subscriptions: provider + subscription ID unique; bound actor, provider customer/product, status, paid period start/end, cancel-at-period-end, verified payment reference and reconciliation version.
- provider event inbox: provider + event ID unique, payload digest and processing/retry outcome. An existing ID with a different digest is a conflict, not a duplicate success.
- pass period/installments: unique subscription + paid period + installment index; grant due time, operation/ledger identity and delivered state.
- pass allowance usage: paid period, exchange consumption/remainder, reserved discount uses and **settled** discounted pack usage; actor-scoped locks prevent cross-request races. Reserve one of the two discount uses when creating an accepted discounted quote/order, consume it on verified settlement, and release only after a definitively resolved cancellation/expiry. Otherwise three simultaneous discounted checkouts could all be charged before detecting quota exhaustion. Bind reservation expiry to payment reconciliation, not a blind short timer. Choose a current-period ownership rule if an actor has more than one store subscription; do not stack benefits.

Reuse existing commerce tables/idempotency facilities where they express these invariants. Grant Core runtime DML and the explicitly required backup read role only; API/worker never receive wallet DML. External provider reads happen outside economic transactions; lock/revalidate the affected binding/period before committing. Route new methods through commerce-ingress OPS and signed core-gateway allowlists. No public command may accept a caller-supplied actor, paid-through time, balance or grant quantity.

Subscription lifecycle requirements:

1. Verify the exact raw-body Standard Webhooks signature before event processing. Audit current packages/services/polar.js against current Standard Webhooks framing (including v1, signature components, multiple signatures, timestamp tolerance and secret decoding); test realistic provider headers, not only self-generated simplified fixtures.
2. Reconcile provider subscription and paid order with recorded organization/product/customer/actor binding, amount/currency and interval. Do not grant from metadata.actor alone or from checkout.succeeded alone.
3. subscription.created or cycled does not by itself prove payment. Establish paid entitlement from verified successful payment; updates/cancellation/revocation reconcile access without regranting monthly Crowns.
4. Bind each renewal to its provider billing period and paid order. Duplicated, delayed and out-of-order events cannot extend an old period, regrant an installment or reactivate a revoked/refunded entitlement. Keep failed events retryable; do not ACK a processing failure as success.
5. Cancel at period end preserves access until the paid end. Immediate revocation/refund follows the existing approved refund/hold policy; do not confiscate unrelated earned balances or label a request to cancel as immediate expiry.
6. Maintenance catches up due grants exactly once after downtime. Status reads stay read-only. Paid-period allowance rollover/grants are not triggered by a browser clock or localStorage.
7. Implement an authenticated Manage subscription endpoint producing a short-lived portal session bound to the current actor's recorded provider customer. Never accept arbitrary customer IDs or portal URLs from the browser. UI says Cancel in billing portal on web; use platform subscription management on native.

### B3. Preserve the approved benefits, enforce them in authority

- Monthly price target: suggested USD 3.99, actual provider quote authoritative.
- 150 Crowns per paid billing month, as 50 on days 1, 11 and 21. Define day offsets as paid period start + 0/10/20 days, bounded by paid period end; document short-period/proration behavior before enabling any such provider option. Use fixed server time in tests.
- 2x ordinary bot-win Coins **before the existing daily cap**. No cap increase, no extra eligible bot games, no Elo effect. src/app.js's local coinBoost flag is not sufficient server proof; verify the real V5 completion/reward path and prevent caller-controlled multiplier claims.
- Effective 8 Coins : 1 Crown on at most the first 200 eligible Coins per paid month. Preserve existing approved Coin provenance/conversion policy and exact integer remainder arithmetic. The legacy additive 1/40-Crown-per-Coin bonus is a reference implementation; bind V5 operation replay and carry to the paid billing period.
- 15% discount on at most two Crown packs per paid month. Price is computed server-side, snapshotted on the order and consumed once at **settlement**, across supported web providers. Do not promise a discount on Apple/Google prices unless a real supported store offer implements it; expose platform-specific applicability honestly and retain the cross-platform entitlement rules.
- Automatic ads off during active paid access; rewarded ads remain an intentional separate choice. Preserve permanent remove_ads ownership after pass expiry. Cosmetic-only bonuses must remain cosmetic; no tournament/ranked power advantage.
- Do not reset monthly limits on UTC calendar boundaries if the copy promises billing months. Prevent duplicate subscriptions from bypassing quotas; show Already active / Manage subscription where applicable.

The base conversion, bonus grant, allowance/carry update and idempotency outcome must commit in **one Core transaction**. The legacy community-http hook runs after conversion and suppresses bonus failures; copying that hook would lose benefits on a crash. Likewise, each installment marker and Crown credit must commit together. Legacy passGrantSweep uses calendar-month days and separate marker/wallet writes; it is not an acceptable production scheduler implementation.

Native recurring SKU/StoreKit/Google notification integration is a separate dependent slice if missing. Do not sell an old one-time SKU as a monthly product by changing its label. Validate actual product types and store binding, and do not claim iOS/Android billing acceptance from the browser sandbox.

**Done when:** sandbox subscribe -> paid access -> all benefits -> scheduled grants -> renewal -> cancellation/expiry/refund work on PostgreSQL with replay/concurrency tests; web portal and return links work; actual live configuration is separately recorded and verified after authorized deployment.

## C. Full Store redesign and pass object asset (comments 1 and 7)

### C1. Visual specification

Keep existing site fonts, translucent navy panels, cyan/violet outlines, currency artwork and atmosphere. Replace the unrelated gold landscape banner with a coherent purchase hierarchy:

1. Compact heading: Store; supporting copy includes monthly Mega Pass, Crown packs and permanent ad removal.
2. Wallet/profile strip with current pass status and account action; prices/products stay browsable when signed out.
3. Featured Mega Pass panel: contained transparent ticket/emblem on the left; title, provider price/month, five concise benefit rows and one Subscribe/Manage action on the right. It is a merchandise object, not a second landscape hero.
4. Three equal Crown-pack cards, then the permanent Remove Ads card/section with clear overlap explanation for active pass owners. Price/action baselines align; no enormous blank panel or full-width background image.
5. Compact purchase help and delivery/refund explanation, linking to support and subscription management; avoid repeating three large marketing panels below the catalog.

At >=1100px: pass art column about 220–280px, copy flexes; pack row three columns. At 700–1099px: pass two columns where text fits, packs two columns. Below 700px: art above copy, one-column cards, full-width primary action. At 320px: no horizontal page overflow, no clipped price/benefits/actions; preserve >=44px touch targets. Maintain keyboard order, visible focus, reduced motion and forced-color legibility.

### C2. Use the delivered Mega Pass asset (generation complete)

- **Owner follow-up: asset generation remains Codex's responsibility. Completed:** assets/p21/art/mega-pass.webp is now supplied with this plan. Use this asset rather than asking a smaller executor to generate it. It is a violet crystal-crown ticket with gold trim, styled beside the existing currency artwork, no baked-in words, landscape or banner background.
- Delivered image: 768 x 481 RGBA WebP, 54,176 bytes, genuine alpha. SHA-256: 41bb979e30ae2ebcd4b722ecd4144286019d1c077b02deb066571f5aa844e325. The wider aspect ratio is intentional for the ticket object; preserve it rather than stretching it into a square.
- Read [the asset receipt](MEGA-PASS-ASSET-20261016.md) for the final generation prompt, export settings, alpha measurements and visual checks. Codex inspected it beside the existing coin/crown at 96px and 240px over navy/light surfaces and a CSS checkerboard. These checks establish asset suitability, not completion of the Store redesign or live checkout.
- Future genuinely required raster additions remain Codex's asset task; use the imagegen skill and true transparent output. Existing rank/friend/watch/theme-placeholder UI should reuse the established SVG/code-native artwork. No additional raster asset is currently required by these seven annotations.
- Build-web already picks up root art WebPs; replace the explicit mega-pass.png copy/reference with the canonical WebP path. Inspect the duplicate apps/web/assets/mega-pass.png and apps/web/assets/p21/art/mega-pass.png before removing anything; delete only proven redundant task-owned assets after reference checks.
- Replace pg-pass-art banner styling with a bounded object area and object-fit:contain. Preserve image dimensions/aspect ratio; decorative art gets empty alt when the adjacent heading already names the product. Do not turn the object into a giant card background.
- Native pass SVG already exists through MegaIcons.pass(); keep it vector-based, adapt its colors/spacing for the redesigned native card if necessary. Do not bundle the website landscape into native UI.

**Done when:** Store looks like one purchase system at 1625x984 and mobile widths, has the transparent pass object, no old banner, and all state variants remain understandable.

## D. Sponsors: compact controls and real ad inventory (comments 2 and 3)

### D1. Layout

- In sponsorsPage remove the large Your game. Your choice. panel entirely. Preserve /privacy-choices via the global footer and a short inline link in the compact preference control.
- Replace the large preferences panel with native details/summary: Ad interests (optional), collapsed by default, one-line summary with saved topic count. Put the existing form inside; keep explicit opt-in, save and clear actions and the same allowlisted topics/local storage key. Focus remains in the disclosure after saving or clearing; a full re-render must not immediately close it or move focus to the page top.
- Never interpret saved interests as consent to personalized advertising/tracking, and do not connect them to research consent or gameplay records. The existing data is browser-local; feeding it to a network needs a separate correctly implemented choice.
- Proposed inventory: one responsive horizontal placement below the introduction and two rows of up to three distinct responsive sponsor/display placements. This is a **capacity layout**, not an instruction to fill every pixel or exceed the provider's permitted density. Include useful original sponsor/editorial content; retain only placements with appropriate content balance and approved demand. At <=900px use two columns; <=650px use one column. Reserve dimensions to avoid layout shifts.

### D2. Do not confuse an empty box with live revenue

The current page renders three static No active sponsor placeholders. No browser ad network is proven active by those cards, and native AdMob units cannot be inserted as website display units.

Introduce apps/web/sponsors.js with a page-scoped mount/destroy controller and a small explicit slot configuration. Initial supported types: approved direct-sponsor creative (image/title/HTTPS link + Advertisement label) and an approved web display adapter. Keep network configuration disabled until the existing publisher account/site/units are verified. Add new module(s) to build allowlists.

- Each placement has a unique stable slot ID, fixed responsive container and loading/filled/no-fill state. Validate direct sponsor URLs/assets; use safe external-link attributes. Do not render arbitrary supplied HTML.
- Load the approved SDK once. Mount a slot at most once per page generation and request it only when appropriate for visibility/consent/provider rules. SPA re-renders, theme changes, focus events and disclosure toggles must not multiply impressions.
- Destroy observers/listeners on route exit. Handle no-fill/ad blocking/offline without timers repeatedly retrying or replacing the page. Never invent an impression from a placeholder or background page.
- The owner's “24/7” goal means inventory is available whenever real visitors use the page. It does not authorize hidden ads, synthetic traffic/clicks or automatic refresh loops. Google AdSense prohibits unrequested page/element refresh; any other network refresh mode requires its actual supported and approved implementation.
- For Google display ads use the permitted Advertisement label; avoid “support us by clicking” copy and decorative content that looks like the creative. Keep disclosure/dropdown controls well separated from creatives. Do not generate sponsor names or imply a signed sponsor contract.
- Resolve actual web publisher site verification, ads.txt (distinct from native app-ads.txt), applicable consent integration and exact CSP domains as an operational subtask. Do not enable ads in an unapproved native WebView or treat installing the app as permission for all web tracking.
- Honor verified remove-ads/pass placement policy; if an explicit voluntary Sponsors destination remains available to those users, keep it deliberate and free of forced ads elsewhere. Do not silently change the purchase promise.

**Done when:** preferences are a compact disclosure, duplicate panel is gone, additional useful inventory fits, and configured ads/direct sponsors genuinely render under approved conditions. Separately report layout implemented vs publisher approved vs live fill; do not promise a revenue amount or permanent fill.

## E. One tournament catalog with correct Join behavior (comments 4 and 5)

- Remove the static hard-coded tables array from tournamentsPage and the second Live tournaments catalog. Render one table-card set from the validated /api/party/capabilities catalog via a shared catalog renderer in tournaments-view.js. Preserve the original detailed payout comparison in those same cards, using all server-returned payouts and burn/entry values.
- Keep a small shared status/sign-in/retry region and an active-room summary. Removing the duplicate panel must not remove the only controller mount or feedback region. Split renderTournamentControls into catalog/status, lobby, workspace and results functions rather than appending a second full catalog.
- Each card's primary action reads **Join game** with accessible name including the table. A linked click calls tournamentController.action('join', tableId) -> publicJoin. A guest signs in with a validated same-origin return intent, then confirms the selected table; do not charge or silently ready the player after OAuth return.
- Join does not immediately reserve funds at this baseline: readiness approves the entry, all ten ready starts reservation. Keep the quote/readiness confirmation visible before economic commitment. Entry, player count, 200-Elo spread, prize curve, burn and non-rated outcome rules remain canonical.
- On successful join navigate to the tournament room route, not /play or generic /game. Reuse the existing route **/game?tournament=<roomId>&fixture=<fixtureId>** for the full room workspace. /tournaments stays the catalog/active-seat entry. This avoids a second competing game route.
- Add a recoverable Return to tournament action when a seat already exists. ALREADY_QUEUED, insufficient funds, full table, changed rules, pending outcome and auth expiry receive specific messages; retries reuse the original operation key.
- Re-read actual eligibility failures. At this baseline eligibleAccount requires verification, no hold/suspension and ten games; it does not test a named rank tier. Explain the real requirement and progress using self data. Do not delete eligibility checks to enable testing. Add a clearly labeled, read-only tournament preview for review before eligibility, backed by static/demo fixtures only; it never sends join/move/reward calls and never appears as a real live event.

**Done when:** exactly four canonical table cards render once; Join game leads to the correct lobby/room; login return and active-seat recovery work; entry approval and balances remain server-authoritative.

## F. Tournament room: roster, own game, other games and watching (comment 5)

### F1. Desktop and responsive layout

Implement a dedicated tournament workspace shell, optionally in new apps/web/tournament-workspace.js and a scoped stylesheet. Register every module in build-web.js. In app.js branch the tournament /game route into this shell while keeping existing casual/ranked game behavior intact.

Desktop >=1200px: CSS grid minmax(220px, .8fr) minmax(440px, 2fr) minmax(240px, .9fr), constrained to viewport/page width; collapse before the center board becomes cramped. Use min-width:0 and board sizing within its column. Order:

- **Left — Players:** semantic table, Player / Rank / Status / Action. Display all tournament members, mark You, group/standing where useful; Add friend state is described below.
- **Center — Your match:** lobby readiness/quote until play; active board, opponent labels, authoritative clock and move status during play; waiting/next-round/results after settlement. If watching another fixture, show Spectating, its players, and an always-visible Return to your game. Your own ready deadline/clock remains visible.
- **Right — Other games:** current round and fixture cards with player names, state, result/clock where available, Watch for active and View result for complete. Do not expose internal IDs as labels or show TBD slots as actual players.

At tablet widths: board first, roster/fixtures below or in a two-tab rail. On phones: Match / Players / Games tabs with counts; Match default, full-width usable board, no horizontal page overflow. Keyboard focus and tab aria-selected/controls must work. Do not steal focus when polling updates a clock/roster row.

### F2. Participant metadata, rank and friendship

- Current room players lack rank. Add a read-only **member presentation projection** in the Core tournament view/service, using existing authoritative public profile/rank/social policy. Return minimal name/tag/avatar/tier (rating only when visible), self/relationship/action capability flags and current readiness/fixture status. Do not persist a new copied rank on every move or mutate competitive state from a GET.
- Add the same projection to command replies or refresh the read projection immediately after a command, so join replies and GET room views agree. Choose one frozen DTO; optional absent rank renders Rank unavailable rather than a guessed Wood rank. Use published tier/elite allocation, not a client rating-to-tier guess.
- Keep auth emails, provider IDs, wallet, holds, birth/consent data, raw abuse scores and blocked-user reasons out of the roster. Public table membership is not blanket permission to disclose a player's private stats. Reuse existing visibility/redaction policy before limit/fanout.
- Add a small tournament social adapter rather than bypassing friendsController.allowedActions. Trust only a server-projected room member and fresh relationship capability, then call the existing /api/community/friend endpoint with action=request and one body/header operation key. The server still decides permissions.
- Support You, Friends, Request sent, Accept request and unavailable/blocked presentation without revealing another user's private block choice. Handle crossed requests, duplicate clicks and actor/session changes. Adding a friend must not reserve entry, reset the board, affect rank or stop the clock. Friendship does not remove players already seated; frozen matchmaking policy still applies to new table selection.

### F3. Read-only spectating without weakening player controls

Initial scope: **a seated tournament member may watch other fixtures in that same room**, as already represented in the member-authorized T.view. No new anonymous/public-room enumeration or private-lobby exposure is needed for this owner request.

- Retain tournamentFixture/tournamentMatch's own-player checks. Introduce separate tournamentSpectatorFixture/projection and a displayMode:'spectator' board session. Never make an outsider appear to be a fixture player.
- Add a genuinely read-only board path: legal-input controls, resign, ready, power/ad, reward and game-start handlers cannot execute. Pointer, keyboard, programmatic control dispatch and stale callback paths must all refuse moves in this mode. Do not satisfy mountBoard's current onMove requirement with a no-op callback.
- Server move/resign/matchReady checks continue to require the actual fixture player. Exercise a forged HTTP move against a watched fixture and prove refusal. Watching is not enrollment or a new participant role.
- Prefer the existing authorized room GET payload for same-room viewing; it already contains redacted fixtures and state. If a narrower snapshot endpoint is introduced later, bind it to room membership and fixture ID in the Core service and signed gateway. Do not broaden generic match readers or signed ticket audiences.
- Poll one active room stream/controller, not one timer/socket per fixture. Preserve current bounded refresh while visible; stop it on route exit, logout or terminal states, resume on return, and reconcile stale snapshots by actor/session/room/fixture/attempt/revision. Replayed knockout attempts need a new board identity. Use current reconnect/fallback transport rather than inventing another authority.
- While watching, the player's real match continues. Pin an active-match/ready reminder and Return to your game; never auto-ready/resign, pause a clock or grant a reward because the user switched views.
- Settled/void/paused/review states use canonical result/refund receipts. No client placement or payout calculation may be shown as a settled outcome.

**Done when:** a participant can see roster/rank and send a friend request, play their own match, watch another same-room fixture, return and reconnect; forged spectator moves fail, privacy stays redacted and clocks/settlement remain correct.

## G. Native tournament presentation (comment 5)

Use src/party-ui.js and src/party.css, preserving native bridge/session/lifecycle behavior and T rules. The existing drawRoom/watch flow is a starting point, not evidence the requested metadata or security is complete.

- Add Match / Players / Games tabs to the shared party screen with native safe-area spacing and >=44px targets. Reuse the frozen member presentation and relationship contracts; avoid a second rank/friendship implementation.
- Match shows readiness or the actual fixture; Players gives name/rank/status/friend action; Games gives watch/result actions. Spectating gets a clear banner and Return to your game and the same input restrictions.
- Preserve free private local/LAN room support. Offline/LAN-only participants have no server-authenticated rank or global friend action: display Guest / Rank unavailable and omit account actions. Do not send fabricated LAN IDs to the online social API.
- Refresh Android/iOS bundles from the exact verified source; install updates preserving the existing authorized app data. Record bundle ID, signing team, version/build and SHA. Do not claim store-signed release parity from a personal-team prototype.
- Physical acceptance includes two different phones in one private/LAN room, authoritative online tournament testing with disposable eligible accounts, switching tabs while clocks run, reconnect/background, and cross-platform friend request. Public ten-player tournament acceptance requires ten controlled accounts in an isolated stack; two phones alone cannot prove the full public event.

## H. Themes: More coming soon! (comment 6)

In themesPage append one panel **inside pg-theme-grid**, after the five existing theme cards, using the same card radius/border/padding and a restrained decorative icon. Text: More coming soon! Supporting copy may say New looks are on the way. It has no purchase/action control, price or release promise. Do not add a theme to the playable themes array, claim six playable themes, unlock a paid native Neon product, or change current theme behavior. Match existing card height at desktop; let it collapse naturally on mobile.

Verify all five existing browser appearances and four retained native themes remain intact. This small change needs visual inspection and the affected page/build checks, not a new implementation-mirroring unit-test suite.

## I. Verification, evidence, handoff and rollout

### I1. Meaningful automated coverage

Run per-file test commands; record real exit codes and existing process-hang limitations. Do not blanket-update tests to accept a new screenshot or loosen security assertions. Existing tests may expose already-failing pass/card assumptions at d6086a2: record the baseline separately from new regressions.

| Slice | Existing checks to extend/run | Required new behavior coverage |
| --- | --- | --- |
| Page/build contracts | tests/v5-p21-pages.test.js, tests/v5-p21-web-build.test.js, tests/v5-p21-static-resolver.test.js, tests/v5-p21-brand.test.js | One catalog, known offers, five products including pass, compact disclosure/no duplicate panel, packaged alpha asset and new modules, direct route resolution. |
| Store controller | tests/v5-p21-app.test.js plus proposed tests/v52-web-store.test.js | No-native-bridge web offers, provider fallback without duplicate charge, return verification, session/route fencing, cancelled/late responses, one refresh per activation, unavailable price/auth/error states. |
| Polar/V5 commerce | tests/v52-polar-provider.test.js, tests/v52-polar-commerce.test.js, tests/v52-commerce-ingress.test.js, tests/v52-commerce-create-race.test.js; proposed subscription suite | Realistic signature headers and raw-byte rejection; recurring lifecycle and authority; duplicate/out-of-order/cancel/refund; amount/currency/customer/product mismatch; unique renewals/installments; worker restart and concurrent allowance use on real disposable PG. |
| Benefit rules | tests/monetization-policy.test.js, tests/v52-pass-benefits.test.js, tests/monetization-store.test.js plus V5-specific benefit tests | Preserve arithmetic but prove the actual Core PostgreSQL path, not just legacy helpers. Cap/first-five rules, allowance rollover and refunded/revoked state. |
| Tournament | tests/v52-web-tournaments.test.js, tests/v52-tournament-http.test.js, tests/tournament.test.js, tests/gameplay-tournament.test.js, relevant V5 service tests | One canonical card set; correct join route; quote/readiness; rank privacy; friend action binding; own vs foreign fixture; readonly spectator rejects pointer/key/HTTP moves; stale room/attempt fencing and exact settlement. |
| Board/social | tests/v5-p21-board.test.js, tests/v5-p21-friends.test.js, tests/v5-p21-realtime.test.js | Existing participant board/friend behavior unchanged; explicit spectator path never executes economic/game actions. |
| Sponsors | existing page tests and proposed controller tests if an SDK adapter is added | Collapsed form save/clear/focus, no tracking consent inference, SDK loads once, slot mounts once, hidden/no-fill/route teardown, no auto-refresh timers; approved/public config only. |

Representative commands (adapt only to actually present tests on the selected base):

~~~sh
node tests/v5-p21-pages.test.js
node tests/v5-p21-web-build.test.js
node tests/v5-p21-app.test.js
node tests/v52-web-tournaments.test.js
node tests/v52-tournament-http.test.js
node tests/v52-polar-provider.test.js
node tests/v52-polar-commerce.test.js
node tests/v52-commerce-ingress.test.js
node tests/v52-commerce-create-race.test.js
node tests/monetization-policy.test.js
node tests/v52-pass-benefits.test.js
node scripts/p21/build-web.js --output .artifacts/annotation-review-web
~~~

Real-PG suites require their documented disposable environment/roles; never point them at production. A missing service prerequisite is NOT_RUN, not PASS. Use the repository's per-file runner conventions; do not introduce a test runner change to conceal hanging child processes.

### I2. Browser and device acceptance matrix

Capture at 1625x984, 1280x800, 768px, 390px and 320px widths, plus 200% zoom and keyboard navigation. Use screenshots of the actual implementation; no mockup may stand in for acceptance.

- Store: guest/linked/loading/error/offline; direct URL/SPA/back-forward; no-native-bridge browser; correct localized prices; alpha asset; Cashfree healthy vs unavailable vs unknown outcome; Polar global/monthly; active pass and cancellation; old permanent remove_ads; return pending/success/cancel/refund.
- Sponsors: collapsed/expanded/saved/cleared; no preference vs opted in; blocked/no-fill/live approved slot; hidden page and route return; no duplicate SDK/slot requests or layout shifts.
- Tournaments: guest -> login -> chosen table; ineligible explanation/preview; insufficient funds; joined lobby/recovery/readiness; all-ten start; own board and other fixture watch; friend states; disconnect/reconnect; route/actor switch; replayed drawn knockout; complete/void/refund/review. Check no standard Ranked rewards/Elo leak.
- Themes: six visual cards but only five playable browser themes; no dead purchase CTA; original native themes intact.
- Phones: Android/iOS Match/Players/Games, sign-in/session continuity, portrait/landscape/safe areas, background/reconnect, spectator input denial, private/LAN regression. Record physical results separately from simulator/browser outcomes.

### I3. Required completion artifacts

Create an implementation receipt under docs/p21-web with one row per comment: ID, implementation SHA, files, test command, environment, PASS/FAIL/NOT_RUN, screenshot/evidence location and remaining external prerequisite. Include a sanitized provider matrix (catalog exists / webhook configured / sandbox verified / deployed / live verified) and any native build references. Never mark provider-approved/live based on source code or placeholders.

Main receives the reviewed commits, schema/config changes, exact source/build hashes, migration order, private secret-variable **names only**, canonical webhook/return/portal links, test results and rollback procedure. Final exact-head CI is last. Main's deployment preserves host-managed serve.sh and docs/v5/environments/production.json through scripts/v51/deploy-production.cjs; do not improvise a file swap that drops either.

After separately authorized deployment, repeat the live guest/authenticated Store/API and tournament checks and a provider sandbox/approved end-to-end flow. No production-ready claim while live Store still fails, recurring delivery is unverified, or actual requested room functions are only mocked.

Rollback: revert the affected UI/controller commits and deploy a tested PostgreSQL-compatible prior artifact through Main. Pause new offers/slot activation if necessary while retaining subscription/webhook reconciliation and existing paid entitlements. Do not drop subscription/event/ledger records, replay grants, restart a stale SQLite writer, or disable already owed installment delivery to hide a UI defect.

## 4. Reference evidence and current external documentation

Repository references at the reviewed baseline:

- docs/v5.2/release/CODEX-LR22-COMMERCE-AUTH-20261016.md — prior pass work and explicitly open Polar recurring/native subscription tasks.
- docs/v5.2/release/CODEX-LR21-REVIEW-PASS-20261016.md — prior native/review context; some earlier one-time-pass claims are superseded by the monthly requirement.
- docs/v5.2/release/CODEX-EXECUTION-BOARD-20261016.md — current lane ownership and final-CI-last instruction.
- native/COMMERCE-AND-ADS.md; src/game.js; src/tournament.js; src/monetization.js — preserve authority and canonical behavior.

Official pages checked during planning (recheck relevant API version at execution time):

- [Polar webhook events](https://polar.sh/docs/integrate/webhooks/events): distinguish lifecycle notifications from verified paid orders, renewal periods, cancellation and revocation.
- [Polar subscription.created](https://polar.sh/docs/api-reference/webhooks/subscription.created): creation can precede active paid state.
- [Polar subscriptions](https://polar.sh/features/subscriptions): recurring checkout and hosted customer management.
- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md): versioned signature framing, exact message bytes and multiple-signature handling; also referenced by the independent Sol review.
- [Google ad placement policies](https://support.google.com/adsense/answer/1346295?hl=en): appropriate labeling/spacing and no unrequested ad/page refresh.
- [Google AdSense program policies](https://support.google.com/adsense/answer/48182?hl=en): publisher/traffic/content requirements; adding empty slots is not live serving approval.

## 5. Executor instruction (copyable)

Implement this plan against the currently authorized integration base after reconciling the V5.1 instructions with the reviewed V5.2 source baseline. Start by rechecking git status, provider/live-source state and the contracts in A/B; do not repeat already completed work merely because an old receipt says OPEN. Work through all seven owner annotations, serialize shared pages.js/app.js/schema edits, retain Core authority and purchase/entry policy, and make small verified commits. Continue independent UI work while a real external prerequisite is pending, recording it precisely. Do not perform a main merge, production deployment, real charge or store publication without the applicable existing authority. Finish with the per-comment receipt, actual browser/device/provider results and final CI verification; never substitute a static preview, legacy SQLite tests or a synthetic tournament for live acceptance.
