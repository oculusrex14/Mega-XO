# Anti-hoarding service implementation and acceptance

Design: [ANTI-HOARDING-METRIC-DESIGN.md](../../docs/v5.2/final-audit/monetization/ANTI-HOARDING-METRIC-DESIGN.md).
Base: `origin/V6`, `7d76062ab6b90600304cedfab5fd960de9aabbdf`.
Environment: local authoring and GitHub Actions, owned disposable PostgreSQL 16 and synthetic actors only.
No production access, deployment, policy publication, player notices or external payment occurred.

## Contract and integration

- Migration 0065 admits `power` without changing any previous ledger source. All four purchase settlement paths increment purchased-Crown provenance exactly once. Historic balances are not retrospectively labelled as proven promotional holdings.
- Migration 0066 starts a prospective allocation at its installation time. A permanent actor shares one 22,000-Crown budget across every pack and provider. Web checkout reserves it in the existing create-request transaction, before any provider call. Allocation is append-only, independent of balances/refunds, and summed across policy versions. Pending, ambiguous and failed creates keep their allocation conservatively; no automated release can make an orphan payable checkout escape the cap.
- `commerce.status(actor).promotionAllocation` supplies cap, remaining allowance and policy/campaign metadata. Price snapshots retain the corresponding allocation/disclosure. Pass installments and non-Crown once-products consume no cap. LAUNCH50/code entry, configured provider prices and intro-product behavior are unchanged.
- Code/display expiry is metadata, not proof of a provider price change. The cap remains active until a separately verified policy retirement (`retired_at`), even after `2026-12-31T18:29:59Z`. Retirement never erases an actor's allocation.
- Native billing integrations must call `reservePromotionCheckout(actor, key, productId, 'apple'|'google', acceptanceHash)` **before** presenting promotional billing, then use that key for purchase delivery. The existing native payment-consumption path is not a pre-payment boundary. Historical or server-approved receipts are honored, never treated as evidence of an accepted cap breach. Native client/API wiring is outside the permitted write set, and is not claimed as complete.
- The policy begins **unpublished**. Before forfeiture is possible, the separate publication workflow must record the actual published rule hash/time. A trusted `verifyPromotionAcceptance` adapter must attest actual pre-checkout disclosure/acceptance; `acceptPromotionPolicy` records it, and checkout receives `customer.promotionAcceptanceHash`. Once published, missing/stale acceptance fails before provider I/O. No implicit acceptance or fabricated publication is recorded. Rendering and submitting this disclosure through the existing client/routes remain an integration prerequisite outside this write set.
- `readPromotionMetrics` is a private read-only report with exact SQL, bound parameters, source SHA, snapshot time and frozen rows. S1/S2 trigger review only; S3 stays disabled without an explicit spending-coverage evidence hash; S4 directs investigation toward a service defect first. Metric SQL is executed against disposable PG, not just inspected.

## Private operator composition

Import `createPromotionOperatorService` directly from `packages/services/promotion-operator.js`, on the guarded `core_runtime` pool, with an authenticated operator principal and mandatory authorizer. No operator method is in player commerce ingress or the generic Core command dispatcher.

1. Freeze the complete evidence packet and retain its canonical SHA-256. Include published/accepted rule hashes, independently verified provider prices/order references, matching grants, query/parameters/source SHA/snapshot, frozen rows and provenance, notice contents/figures/proposed amounts and documented delivery (account plus email where verified), response, reasoned exact decision and breach evidence.
2. `recordCase(firstReviewer, { caseId, targetActor, policyVersion, evidenceHash, packet })` records an immutable case and the authenticated first review. It requires ten elapsed days since documented notice, a delivered reasoned decision, at least thirty days to appeal from decision delivery, and amounts no greater than those noticed. Silence and a server-approved cap excess are not proof of breach. Where no verified email exists, retain the hash of that check instead of inventing an email delivery.
3. `approveForfeiture(secondReviewer, { caseId, evidenceHash })` requires the independently authenticated named second reviewer. A name in a packet alone is not an approval.
4. `confiscatePromotionBenefits(operator, { caseId, targetActor, approvedAmounts, policyVersion, reasonCode, evidenceHash, decisionReference })` serializes on the global case identity, then locks the **target** eligibility/occupancy/wallet. It commits explicit delta debits, purchased provenance, append-only `source='spend'` journals, immutable outcome/event and outbox reference together. No opponent or payment row is edited. An altered replay conflicts; identical retries return the durable result.
5. `createPromotionAuditWorker({ jobs, audit })` consumes only `promotion.audit`. Its `audit` delivery must be constructed with a separate `audit_runtime` pool and audit secret; it serializes the chain append and deduplicates on event identity before the worker seals the job. Core receives no audit grant. Events retain the outbox reference after normal outbox retention.
6. A successful appeal uses `restorePromotionBenefits` to append compensating entries and an audit event. It does not fake a payment refund, renew allocation or recreate an abusive lot.

Attribution is deliberately conservative: each debit consumes the possible held portion of every relevant lot; only necessarily attributable conversions move between currencies. Recovery also checks the complete debit journal since the grant, including writers without lot tracking. This may recover less than FIFO, but cannot convert ambiguous legitimate/earned/pass funds into confiscatable benefits. Converted Coins require matching conversion journals; the original converted Crowns cannot also be debited. Unreconstructable historical purchases are excluded.

## Verification and rollback

- Local exception: `node --test tests/v51-audit-promotion-unit.test.js`, initial seven pure tests PASS, zero fail/skip. No local database, full suite, build or workflow emulation was run. Added regressions are run in Actions.
- GitHub audit workflow is manually dispatched on the lane because the retained workflow triggers target V5.2, not V6. `v51-audit-*` discovers the new pure and PG tests; existing Dodo promo/store and Core/leaderboard checks run unchanged.
- At `8f9b49e`, [audit run 39313970922](https://github.com/oculusrex14/Mega-XO/actions/runs/39313970922) PASS, including actual migration/conformance verification, cap/provider races, refund/spend/conversion non-renewal, private command authorization, double-review, idempotency, no overdraft, rollback, opponent preservation, separate-role audit and compensating appeal. Final-source verification is recorded in the PR.
- [Extended run 39313651378](https://github.com/oculusrex14/Mega-XO/actions/runs/39313651378) SKIPPED by its existing V5.2-only job condition; it is not PASS evidence. No workflow files were edited to hide that limitation.
- Prior failures are retained in Actions: JSONB key-order identity (`39313121422`), an invalid synthetic Cashfree ID (`39313334362`), and an isolation change rejected after the guarded session probe (`39313645754`). They were fixed rather than suppressed.
- Source rollback: revert the lane's code in review. Schema is additive; do not remove append-only evidence or drop data to roll back. Runtime schema readiness requires a compatible checksummed release; an operational rollback requires a matching manifest/binary and is not authorized by this PR.

## Branch naming deviation

The requested local branch is `codex/anti-hoarding-enforcement`. GitHub already has `refs/heads/codex`, which prevents creating that slash-prefixed ref (`directory file conflict`). The remote lane is therefore `codex-anti-hoarding-enforcement`, preserving the existing `codex` branch. No branch was deleted or force-pushed.
