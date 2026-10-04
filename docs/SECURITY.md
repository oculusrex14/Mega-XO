# V3.2 risk review and release blockers

## Primary product risk: purchased-coin stakes

Apple App Review Guidelines 5.3 restrict real-money gaming and prohibit IAP currency for that use. Google Play's real-money-games policy restricts staking real money, including purchased in-app items, for prizes of real-world monetary value. These rules do not by themselves settle the classification of every closed-loop virtual economy.

India's Promotion and Regulation of Online Gaming Act, 2025, section 2, defines online money games and other stakes broadly, including specified purchased virtual coins/tokens. The precise classification, current rules, enforcement, and each launch jurisdiction need qualified legal review. Do not assume "skill game" or "no cash-out" alone clears the proposed design.

For this reason V3.2 does not implement paid-currency wagering. Purchased cosmetic Crowns are segregated from earned Coins, with no conversion. Even earned-coin stakes remain off until reviewed. The prototype is not a legal compliance certification.

Sources reviewed 4 October 2026:
- Apple: https://developer.apple.com/app-store/review/guidelines/ (5.3)
- Google Play: https://support.google.com/googleplay/android-developer/answer/9877032/
- India Code, Act 32 of 2025: https://www.indiacode.nic.in/indiacode/handle/123456789/22148
- MeitY Act/rules register: https://www.meity.gov.in/documents/act-and-policies/promotion-andregulation-of-online-gaming-act-2025-and-its-corrigenda-kTMxQjMtQWa
- Mark Glickman on rating uncertainty (alternative to a future Elo implementation): https://glicko.net/glicko.html

## What the old static model cannot secure

LocalStorage, JavaScript, browser clocks, bot outcomes, account IDs supplied by a caller and claimed balances can be edited. A hidden client function, a checksum or minification is not an anti-cheat boundary. A local bot match cannot automatically mint trusted live currency. Do not import V3.2 wallet totals into a production wallet.

Server-authoritative legal moves prevent impossible moves. They do **not** prevent someone consulting an external solver, using another device, account sharing or colluding. Never advertise the game as cheat-proof.

## Implemented/tested reference controls

The browser uses the pure move validator and keeps human/bot move sources separate. Stakes and purchases fail closed. Local reward events use match IDs, daily caps, per-difficulty caps, completion thresholds, exclusions and once-per-day quest keys. These provide a correct local UX, not tamper resistance.

The server-only `Authority` reference verifies participant membership, blocks self-challenges/blocked accounts, derives quote tiers from account state, rejects purchased stake currencies, checks both balances before either debit, requires both consents, expires invitations, validates every move/turn/revision, handles duplicate command IDs and rejects mismatched retries. It derives timeout winners from its clock, settles once, refunds draws/voids and restricts staked pair frequency. It is in-memory and cannot survive restarts or coordinate multiple workers. It is NOT connected to a network or an identity provider.

## Required production controls

1. **Trust and transport:** authenticated sessions, server-resolved actor IDs, TLS, token rotation, CSRF/origin checks as appropriate, strict schemas, length limits, account and IP rate limits. Never accept a client `verified` flag or authoritative tier.
2. **Persistence:** transactional PostgreSQL or equivalent; integer minor units; currency-tagged immutable double-entry ledger; row locks on both wallets in deterministic order; unique match/settlement/receipt keys; idempotency fingerprints; outbox for realtime events. Debit, settlement, rating, reward caps and results commit atomically or not at all. Regular reconciliation: available + reserved + paid + burned = funded + minted - refunded as appropriate for the ledger model.
3. **Purchases:** server-to-store receipt verification, unique transaction IDs, durable grants, restore/reconciliation, refund and chargeback reversals, held/negative premium balances, spending suspension when necessary. Never reclassify refunded paid currency as earned. No hard-coded success UI.
4. **Match validation:** authoritative sequence and turn deadlines, input legality, board replay from the immutable log, snapshot recovery. Reconnect must not duplicate moves. Server incidents void/refund affected matches. Rated outcome is distinct from animation or connection UI state.
5. **Offline farming:** issue signed game seeds/receipts or cap offline rewards to cosmetic-only local progression; replay submissions on the server; reconcile attestations and suspicious automation. Offline totals alone are never accepted. Play Integrity/App Attest can add signals, not mathematical proof of honest play.
6. **Collusion:** flag repeated-pair concentration, reciprocal losses, rapid resignations, reward-only play, multi-account device clusters, improbable move timing, impossible growth and receipt reuse. Friend/leaderboard challenges are unrated. Do not count repeated friend games toward unlimited quests. Cooldowns and capped rewards, then review holds. Shared IP is not proof of cheating.
7. **Adjudication:** delayed payouts/held balances for flagged events, human review, appeal path, visible reasons, reversible rating adjustments and audit logs. Do not auto-ban for solver similarity or a fast move alone.
8. **Safety/privacy:** jurisdiction and age checks before gated mechanics, parental controls where required, opt-in public vaults, no real-money spend disclosure, spending history/limits, account deletion/support/block/report. No coercive loss-recovery offers or gambling-style urgency.
9. **Operational limits:** daily issuance ceilings, coin supply dashboards, outage kill switch, rollback and alerting, fraud telemetry with retention limits, moderation ownership, documented incident response. Avoid false positives from accessibility tools.

## Unimplemented release blockers

Live auth, transactional wallet service, verified online game results, matchmaking/presence, realtime recovery, receipt verification, attestation, anti-collusion analytics/review, jurisdiction and age policy, production abuse reporting and push notifications.

Do not enable the experimental earned-stake flag until these controls and a written legal classification are complete.
