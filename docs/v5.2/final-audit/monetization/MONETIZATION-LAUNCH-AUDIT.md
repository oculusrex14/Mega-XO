# V5.2 monetization and economy launch audit — Planck

Baseline: **7f582b749a1128b86e53ddcbcda57b569b0953cf**, PR #30 → V5.2; 17 October 2026. Source findings are pinned to that revision even though the shared checkout advanced during this audit. No code, production state, purchase, advertisement, account, subscription, refund or provider configuration was changed. No local test suite was run.

This report distinguishes reviewed implementation, isolated GitHub evidence, observed live behavior and provider/device acceptance. It does not certify store/provider approval. Finding statuses and exact primary anchors are in [planck-findings.csv](../evidence/planck-findings.csv); the full route matrix is in [SECURITY-AUDIT.md](../SECURITY-AUDIT.md).

Economy/monetization register: 17 P1 entries — 13 VERIFIED_DEFECT, 2 SUSPECTED_RISK, 1 UNTESTED_ASSUMPTION and 1 NOT_RUN. Non-executed provider acceptance is not represented as a verified vulnerability.

## Launch-relevant findings

| ID | Priority / status | Evidence-backed finding |
|---|---|---|
| MXA-ECO-001 | P1 VERIFIED_DEFECT | Required guest status call returns 404 live rather than 401. Candidate API dispatch and live implementation are not interchangeable. |
| MXA-ECO-002 | P1 VERIFIED_DEFECT | Client reward-ticket/interstitial-permit names do not match mounted ticket/permit routes. |
| MXA-ECO-003 | P1 VERIFIED_DEFECT | Ingress ticket validator accepts rewarded/interstitial; commerce requires credits/boost. The accepted sets do not intersect. |
| MXA-ECO-004 | P1 VERIFIED_DEFECT | Native billing classes have no host-mounted MegaBilling bridge; catalogues contain four one-time products and no Mega Pass; Android requests INAPP only. |
| MXA-ECO-005 | P1 VERIFIED_DEFECT | Google RTDN and Apple notification handlers are present only on the legacy HTTP surface, not the canonical V5 API. |
| MXA-ECO-006 | P1 VERIFIED_DEFECT | Polar period parser expects nested current_period; current documented response uses top-level period fields. |
| MXA-ECO-007 | P1 SUSPECTED_RISK | Configured priceId is passed as a product ID to Polar; actual console identifier mapping is unverified. |
| MXA-ECO-008 | P1 VERIFIED_DEFECT | Trialing/past_due states become active grantable periods without a required paid-order identity. |
| MXA-ECO-009 | P1 VERIFIED_DEFECT | Grants iterate every active subscription, contradicting the actor-level no-stacking rule used in the entitlement projection. |
| MXA-ECO-010 | P1 VERIFIED_DEFECT | Installment journal IDs repeat in subsequent months; append-only ledger conflict handling can silently discard the new record while wallet credit commits. |
| MXA-ECO-011 | P1 VERIFIED_DEFECT | Promised bot booster, bounded 8:1 conversion and pack discount are not fully wired into V5/all purchase paths. |
| MXA-ECO-012 | P1 VERIFIED_DEFECT | Cashfree releases the discount reservation on ambiguous outcomes before classifying UNKNOWN; settlement does not name its reserved period. |
| MXA-ECO-013 | P1 SUSPECTED_RISK | Web refund rows do not demonstrate recovery/review of credited Crowns; native and web remedies differ. |
| MXA-ECO-014 | P1 NOT_RUN | Actual store/SSV/subscription/pending/refund/renewal acceptance not executed for the exact signed release. |
| MXA-ECO-015 | P1 UNTESTED_ASSUMPTION | Power-bank debit uses the device save; authoritative purchased-Crown consumption/cross-device inventory is not established. |
| MXA-ECO-016 | P1 VERIFIED_DEFECT | Production has no caller for the available purchase-finalization retry sweep. |
| MXA-ECO-017 | P1 VERIFIED_DEFECT | Async PG store facade is consumed synchronously by legacy verifiers; a Promise is treated as a revocation row. |

These are not claims of successful exploitation against production. Several candidate features are not reachable in the currently observed live build, and their source defects remain relevant before commercial activation.

## Actual browser/native commerce status

| Capability | Reviewed implementation | What remains unproven or defective |
|---|---|---|
| Crown packs 100/525/1100 | Shared catalogue; server decides quantity and actor, not client amount | Live status mismatch; native bridge/facade defects; actual approved store catalogue and checkout acceptance |
| Remove Ads non-consumable | Owned-once receipt projection; optional rewarded ads retained | Native purchase/restore and live hybrid interstitial suppression not demonstrated |
| Mega Pass monthly | Shared $3.99 contract; Polar subscription/period tables; installment timer | Native subscription missing, provider field mismatch, paidness/stacking/ledger/perk gaps |
| Google Play Billing | Kotlin BillingClient and backend REST verification/finalization code | Four-item INAPP-only catalogue; no mounted bridge; async adapter bug; no V5 RTDN; finalization retry uncomposed |
| StoreKit 2 | Verified JWS/app-account-token flow; finish only after backend acceptance in class | No mounted host billing bridge/catalogue; async revocation adapter bug; no V5 notification entrypoint |
| Cashfree web | Server catalogue, durable create reservation, independent paid-order check | Exact provider approval/settlement/refund not tested; discount reservation error path defective |
| Polar web | Actor-bound recorded checkout, Standard Webhooks HMAC, independent reread | Product/price identifier proof missing; subscription period parser incompatible; member discount path absent |

The existence of a signed APK or successful native compilation is not proof of native IAP. The inspected APK signature is valid and no debug application flag was reported; its package mismatch is tracked under SEC-004.

### Async provider boundary defect

The production constructor passes createPgStoreDb directly into GooglePlayBilling/AppleStoreKit (production-server:757-758). The facade's get/all/run methods return Promises (store-pg-adapter.js:46-57). Apple validateTransaction (:39) and Google normalize (:48-49) evaluate get() immediately as a boolean revocation record. Even Promise.resolve(undefined) is truthy, so the valid-receipt path is rejected before grant. Other synchronous finalize consumers expect arrays/rows and do not await facade writes.

This is an integration defect, not evidence of an actual refunded receipt. Preserve role separation while making the entire provider/DB contract asynchronous; do not give API/Core a broader credential to make an old synchronous adapter appear to work.

## Verification, replay, pending and refund integrity

Positive controls present in candidate source:

- commerce.js:178-195 requires core_runtime and verifies schema readiness; API reaches it through signed ingress.
- purchase:590-609 obtains actor eligibility/store binding in a read-only preflight and performs provider verification outside the economic transaction.
- purchase:610 rejects an invalid/refunded receipt, wrong account, store or transaction identity. Quantity comes from the server catalogue.
- Receipt identity is locked before eligibility/wallet (:385-387). Receipt/tombstone checks use their own durable row rather than a globally capped aggregate (:620-629). A new operation key cannot make the same provider transaction a new purchase.
- Duplicate receipts bound to a different actor/product are refused; duplicate owned-once products do not mint (:624-635). Restore accepts only once-products (:612), so consumable Crown packs cannot be restored as new grants.
- Wallet, receipt, journal, business outcome and outbox commit through the Core transaction boundary (:377-430). Generic player Core.run excludes purchase/refund (core.js:415).
- Google checks purchased state/account binding through the provider; Apple pins ES256 JWS roots/chain, bundle, environment, quantity and app-account token (server/google-play-billing.js:normalize/verify; server/apple-storekit.js:18-44).
- Native Kotlin treats PENDING as STORE_PENDING (:137-138), not success. Both native classes produce evidence only. Neither a client success flag nor SDK display callback is a server mint.

These source controls do **not** close ECO-017 or actual store acceptance. Isolated CI associated with the baseline tests separate components; it does not establish the real async-provider composition. Preserve the run-head and checkout/build identities separately as noted in the infrastructure report.

Finalization is intended after durable receipt credit (commerce.js:645-663). On failure purchase returns finalizationPending. The candidate exports processPurchaseFinalizations but the production entry/worker never calls it (ECO-016); a compiled retry method is not a running recovery service.

Native refund (:1216-1268) takes the same receipt mutex, writes a permanent revocation tombstone even when the receipt is unknown, then applies the existing review-hold policy for a known Crown purchase. This preserves the ledger and does not claw funds from an opponent. The V5 notification ingress needed to trigger this path is missing (ECO-005).

Web refunds (:877-897,1182-1198) mark refunded_at and emit events. They do not demonstrate an equivalent economic recovery/review outcome, and an unsettled refund returns UNSETTLED rather than establishing an equivalent native-style receipt tombstone. Track this as ECO-013 risk, not an invented rule that bought Crowns are unusable in competition.

## Advertisements, rewards and placement

| Lane | Intended authority / limits | Audit result |
|---|---|---|
| Cosmetic credits | Four rewarded tickets/day, two-minute spacing; +5 credits or ten-minute 2x cosmetic boost | Pure policy src/monetization.js:9 and commerce.ticket:492-513 present; client paths/kinds prevent coherent issuance |
| Casual completion | 2 credits per qualifying Casual result; base/boost daily caps; (actor,match) dedupe | commerce.claim:460-486 reads durable result history; no arbitrary client winner/completion field |
| Automatic interstitial | Hybrid cohort only; bot result→home; no live match/queue/modal/hidden state; entitlement and consent known | src/monetization.js:68-74 and UI:92-94 preserve placement safeguards; wrong permit path and live integration are unresolved |
| Rewarded powers | Client aggregate cap ten/day and spacing; explicit opt-in | Client cadence is not server-authoritative cross-device quota evidence; no coherent V5 power ticket/grant path demonstrated |
| Provider SSV | Exact signed query/body, cryptographic provider verification, ticket actor/unit/item/amount/time binding | Core callback:520-544 checks unit, actor, reward item, amount=1, timestamps, ticket use and unique transaction ID before durable grant |

Raw SSV bytes are sliced from the original request target, not URL reserialized (routes/monetization.js:118-128). Valid callback grants are not based on the native watched/earned boolean. Callback source budgets are mounted before verification/forwarding (production-server:959-973); proxy assertion is accepted only from a configured trusted peer with the shared edge proof.

The old report's unthrottled-callback finding is superseded at source. Its live host-managed proxy/admission configuration, actual ad units, consent release, SSV console registration, no-fill/cancel handling and an exactly-once real reward remain NOT_RUN. No ad was requested by this audit.

## Economy and Crown spend-path review

Crowns are premium **in-game** units with no cash redemption. Bought and earned Crowns retain identical approved utility. No cash-out, purchase-source spending exclusion, paid Elo multiplier, new geography gate or narrower gameplay policy is recommended here.

| Path | Source authority and conservation | Verification limit |
|---|---|---|
| 150 starting Coins | Core.provisionActor initializes the approved wallet once, under eligibility/occupancy/wallet locks | Source + PG CI; no account created live |
| Bot/quest rewards | domain.complete:110-127: paid first-five levels only, practice/local Impossible unpaid, daily cap; authority.claimQuest:172 prevents repeat claim | Pass bot boost is an optional opts.coinBoost=2 hook with no app caller identified |
| Coin↔Crown | Authority.convert:171 delegates integer/operation/balance checks to domain.convert:86; ordinary rate 10:1 both ways | V5 8:1 allowance enforcement explicitly future in migration 0060:6-7 |
| Friend rated challenge | domain.quote:55-69: challenger funds Crown pot, invitee contributes zero, 2 minimum/20 maximum; half burned/half winner payout | Source review; signed user flows not executed live |
| Leaderboard rated challenge | Same Crown utility; target-tier/league-gap quote, sufficient liquid balance/escrow; stake never an Elo input | No invented 20-Crown cap for leaderboard offers; friend-only cap retained |
| Ranked queue | Lower pairing league fee charged to both in Coins; pool=2f, burn=f, payout=f; qualifying win bonus separately bounded | Source/isolated tests; no queue admission or TTL change performed |
| Public tournaments | tournament.js:4,8: ten seats; Coin entries 100/400/1200 or premium 200 Crowns; 10% pool burn | Participant/escrow transactions reviewed; no actual paid tournament run |
| Coin cosmetics | Authority.cosmetic:75 checks approved price/balance/ownership | No catalogue resurrection or source restriction introduced |
| Undo/Hint bank | App.spend:75-78 calls device D.spendCurrency at 2/3 Crowns; idempotent local operation before bank write | Authoritative purchased-Crown debit and shared inventory remain ECO-015, not a verified server path |

For a full premium tournament: 10 × 200 = 2,000 Crowns; payouts are 720 + 400 + 260 + 220 + 200 = 1,800; burn=200. A 20-Crown friend challenge pays 10 and burns 10 on a decisive result; draw/void returns escrow. These are closed in-game transfers, not real-money winnings.

Double-spend defenses are Core-owned wallet/eligibility locks, durable operation fingerprints, expected match revisions, exact escrow/settlement state and SQL constraints. Replays with a new operation key still encounter receipt/match/claim identities. The audit did not attempt a production replay or balance mutation.

## Mega Pass: implemented contract versus implementation gaps

The owner-approved shared contract is src/monetization.js:22-43: $3.99 monthly, 150 Crowns in 50/50/50 installments on paid days 1/11/21, 2x bot Coins before the existing cap, 8:1 Coin→Crown for 200 Coins per billing month, 15% off two packs, and automatic ads off. Delivered assets are kept on ordinary lapse.

Budget math remains sound **if those controls are enforced**:

- Ordinary 200 Coins produce 20 Crowns; member conversion produces 25. Round-trip benefit must therefore be capped at 5, not be an unrestricted exchange.
- With the 20-Coin bot ceiling, max additional bot Coins/day is max(min(2b,20)−min(b,20))=10; over 30 days that is 30 Crown-equivalents.
- Total intended incremental monthly budget is at most 150+5+30=185 Crown-equivalents. It is not an implemented global supply bound while actor-level stacking/allowances are unresolved.

Current paid-period rows use subscription_id plus period_start. processPassGrants polls every 50 seconds in the production composition (:1113-1124), credits and increments a marker atomically, and ordinary cancellation retains paid-window access. However:

1. The provider period parser supplies nulls for the current documented API (ECO-006). Official [Get Subscription](https://polar.sh/docs/api-reference/2026-10/subscriptions/get-subscription) exposes top-level current_period_start/current_period_end.
2. Trialing/past_due are converted to active and produce grantable rows without identifying the successful billing transaction (:1103-1112). Access grace must be separate from new premium currency.
3. The entitlement projection selects one subscription (:303-307), but the sweep grants all active subscriptions (:1128). Two paid subscriptions therefore have independent mint budgets, contradicting no stacking.
4. The operation key includes the period but ledger ID pass:subscription:index does not (:1137 vs :1146). byKey overwrites duplicate in-memory IDs; append-only ledger SQL uses ON CONFLICT DO NOTHING. Month-two wallet/ledger reconciliation can diverge.
5. The V5 conversion dispatcher still calls the normal Authority.convert without paid-period allowance accounting; migration 0060 explicitly says enforcement is future. The boost hook is not wired by the app. Polar create uses its full catalogue entry, while only Cashfree has the discounted reservation path.
6. Cashfree reserves a discount on every matching active period and releases it for ambiguous errors before distinguishing UNKNOWN from FAILED (:727,742-748). The reservation must remain attached to the exact unresolved order/period.

Polar's [Create Checkout Session](https://polar.sh/docs/api-reference/2026-10/checkouts/create-checkout-session) defines products as product IDs. Passing a field called priceId requires actual catalogue evidence; a true price ID is not interchangeable. No live provider call or identifier lookup was performed with private credentials.

## Closure evidence needed

Run these in GitHub Actions and an owner-authorized isolated/provider environment, not against real players:

| Scenario | Required evidence |
|---|---|
| End-to-end route contract | Existing client names through API→HMAC ingress→actual commerce service, including reward kinds |
| Native verified receipt | Real async PG adapter plus Google/Apple verifier; valid receipt succeeds, revoked/pending/wrong actor fails |
| Exactly once | Same/different operation key and receipt replay; interruption after provider proof/before commit and after commit/before finalize |
| Callback recovery | Google RTDN/Apple notifications, provider dedupe, refund-before-delivery and refund/settlement race |
| Ad reward | SSV wrong signature/unit/actor/item/amount/time; local forged completion cannot credit; genuine completion credits once |
| Subscription | Paid initial period/renewal, unpaid trial, payment failure/grace, cancellation, expiry, refund, duplicate subscriptions, delayed/out-of-order events |
| Ledger and perks | At least two billing periods; exact wallet/ledger conservation, 200-Coin conversion limit and two-discount limit across all devices/providers |
| Power bank | Approved server Crown debit and bank grant reconcile atomically or documented local-only practice scope is respected |
| Store approval | Exact signed artifact ID, provider product availability, physical-device purchase/restore and real approval state |

Existing isolated CI and source claims do not substitute for these outcomes. The integrator should preserve the findings at the pinned baseline and close them only against explicit new SHA/build/provider evidence.
