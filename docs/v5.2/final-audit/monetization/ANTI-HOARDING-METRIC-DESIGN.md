# Anti-hoarding metric & enforcement design (Sol 6.1 — Copernicus, read-only review of 9fa5454)

Status: DESIGN — the SQL is source-derived and must be validated against a database before any enforcement use. No production data was touched.

## Verdict

Publish and enforce a PROSPECTIVE promotional purchase cap. Use stockpiling metrics to trigger review; revoke only benefits attributable to a proven breach of the accepted promotion rules. A large balance or low spend alone cannot distinguish abuse from legitimate buying.

## Constraints found in the code

- Web settlements credit `crowns` + journal the purchase but do NOT increment `purchasedCrowns` (commerce.js:912) — `purchased_crowns` cannot yet prove how many promo Crowns remain. Reconcile before enforcement.
- The account-wallet power debit (MXA-WALLET-PATH, same release) writes ledger `source='power'` — the CURRENT ledger CHECK (0010) excludes it; the migration in this release must add the source value before the lane goes live. Verify before relying on power-spending evidence.
- Pass installments credit 150/period; preferential exchange converts up to 200 earned Coins per period. These are not a max legitimate balance.
- The recorded intro end (2026-11-18T20:29:59Z) is display metadata; expiry does not itself change provider prices.

## Signals (thresholds are operational proposals, not validated boundaries)

| Signal | Threshold | Consequence |
|---|---|---|
| S1 acquisition volume | ≥11,000 credited non-refunded pack Crowns from launch-window checkouts | Informational notice; review eligibility for further discounts |
| S2 purchase velocity | ≥4 purchases AND ≥4,400 Crowns within any inclusive 60-minute interval | Review payment/order evidence; no automatic restriction |
| S3 persistent stock | S1 met + ≥14 days since first credit + Crown-equivalent holdings ≥90% of qualifying purchases + holdings cover ≥180 days at the last-14-day net depletion rate | Stockpiling review only; disabled while spending coverage is incomplete |
| S4 grant integrity | Any paid-period journal/installment mismatch, non-50-Crown installment, or preferential exchange consumption >200 Coins | Investigate a service defect FIRST; never presume player fault |

## Prevention cap

A 22,000-Crown promotional allocation cap per permanent actor, prospective from the policy effective time (twenty largest packs / 110 premium entries). Reserve capacity BEFORE creating a checkout, across all providers and pack sizes; spending, conversion and refunds must not replenish the allocation. Existing purchases stay valid; a server-approved checkout above a newly introduced cap is initially a service failure, not proof of cheating.

## Revocation mechanism (required before any enforcement)

1. A new PRIVATE operator command (e.g. confiscatePromotionBenefits(caseId, targetActor, approvedAmounts, policyVersion, reasonCode, evidenceHash, decisionReference)) — never exposed via player commerce commands; register the TARGET actor for wallet locking.
2. Reuse Core transaction + idempotency boundaries (case identity, eligibility/occupancy/wallet locks, durable outcome, wallet + journal + outbox committed together).
3. Debit an explicit delta, never "set balance to zero"; limit recovery to the abusive allocation still HELD; exclude legit purchases, earned rewards and pass benefits.
4. Append-only journal entries (e.g. confiscation:<caseId>:crowns, negative, source='spend', reason with the case ref) — the existing source vocabulary supports it; no ledger enum change.
5. Correct purchased provenance only for the attributable portion; converted lots need an evidenced Coin debit, never a second charge.
6. Never alter opponent balances, reverse games, create negative balances or debt; keep payment records truthful (no fake refunded_at); appeals restore via compensating entries.
7. Audit: commit the enforcement event + outbox reference with the debit, append to audit via audit_runtime (Core has no direct audit grant); serialize chain appends.

## Due process (all required before any revocation)

- A published, versioned rule accepted before the affected purchase; the cap and remaining allowance shown before checkout; excess blocked before payment.
- Notice (in-account + email where verified) stating rule, transactions, figures, proposed amount, appeal route; 10 days from documented delivery; silence is not admission.
- Operator review with a second reviewer for forfeiture; a reasoned decision with the exact amount; ≥30 days to appeal; compensating entries on success.
- The evidence packet: policy/acceptance hashes, provider order refs + verified price, matching grant ids, exact SQL + params + source SHA + snapshot time, frozen rows/totals, provenance, notice delivery, response, decision, resulting journal ids — hashed and retained. Current balances alone cannot reproduce an old decision.

## Terms

Shipped in public/terms.html (2026-10-19): the promotional-prices paragraph (temporary, changeable with email/website notice) and the fair-promotion paragraph (objective thresholds, revocation without refund for proven breaches, notice + response + appeal, mandatory rights unaffected).

## What exists vs what must be built

| Queryable today | Needed before enforcement |
|---|---|
| Orders + prices + settlement/refund timestamps; matching journal credits; balances/reservations; pass periods/allowances | Versioned campaign rules + price eligibility; campaign allocation reservations across all lanes |
| price_snapshot JSONB | Campaign/policy ids + disclosed allowance in the snapshot (JSON fields, no migration) |
| Command outcomes + outbox | Policy-acceptance records; enforcement case/event records (notice, evidence hash, decision, compensation) |
| Journal + Core wallet writer | The operator command + authorization + target locking; no direct operator DB edits |
| Aggregate purchased counters | Reconciliation; promotion-lot records for precise attribution |
| identity.identities | Verified linkage evidence for cross-account evasion (no reliable ownership inference exists) |
| audit tables/logger | Durable audit delivery + serialized appends; no widened Core audit credentials |

Full S1–S4 SQL and the S4 integrity query are preserved in the audit decision log entry (2026-10-19, Sol 6.1 Copernicus session) and can be re-derived from this design.

