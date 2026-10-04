# Economy-1 trust boundaries and release gates

This replaces the earlier cosmetic-only-Crowns restriction. The requested convertible currency and paid direct challenge mathematics are implemented. They are NOT automatically legally cleared or enabled for production.

## Implemented safeguards

All online changes go through a server-only Authority and DurableStore. The authenticated principal is supplied by the API's authentication callback, never JSON. Player endpoints cannot provision funds, choose a queued opponent, set rank, submit a winner, award a weekly grant, issue a refund, or invoke operator actions.

A SQLite WAL database plus BEGIN IMMEDIATE serializes wallet, escrow, rating, journal and idempotency updates. Results survive restart. A command exception rolls back all state. Returned state is cloned. Monetary values are nonnegative safe integers; currency conversion is exact and idempotent. Unique native store/transaction IDs prevent cross-account receipt replay.

Invitations expire after 10 minutes. No invitation/rejection/cancellation fee. Only mutually accepted, unchanged terms debit funds. The payer vector remains attached to escrow so refunds return to contributors, not the symbol X/O holder or the invitee by mistake. X/O is randomized independently from who funds a challenge. One live match/account prevents concurrent pre-rating settlement exploits.

Repeated ranked direct encounters: at most one per rolling 24 hours and three per UTC calendar week per pair. Queued repeated pairings: at most three per 24 hours. Challenger invitations: 20/day. Self challenges and blocked/held/suspended/unverified accounts are rejected. Friend pricing requires mutual friendship. Direct rated challenges require completed placements. These checks reduce abuse; they do not prove two accounts are distinct people.

Short direct results and direct pots of 5,000+ Crowns receive risk flags. These flags are evidence for review, not claims of an automatic fraud classifier. Solver assistance, smurfing, collusion rings, purchased accounts, manufactured friendships and deliberate resignations remain real risks even though legal moves are server-validated. Money cannot increase K, but opponent selection still needs abuse monitoring.

Receipt refunds create a financial hold; held wallets cannot transact or appear on wealth rankings. The service does not automatically seize an innocent opponent's funds. Source tags and a purchase-influenced account flag provide an audit starting point, not exact unit-by-unit provenance accounting or a complete chargeback dispute workflow.

## Production prerequisites not supplied by this commit

1. Actual identity-provider sessions, account recovery, ownership binding, TLS, CSRF/session configuration and edge rate limits.
2. A deployed matchmaker with skill windows, queue health and anti-repeat controls. The API currently accepts an injected matchmaker; it cannot pretend to find a player when absent.
3. StoreKit/Play Billing UI and verification against real signed store evidence or server API results. `MegaBilling` is a native integration contract, not a fake payment processor. Avoid network receipt lookups inside a long-held database write lock; verify first, then bind trusted verification to the atomic grant.
4. Per-territory/platform/account eligibility, including applicable age controls and spending protections, approved by qualified counsel and platform review. `paidEntryEnabled=false` and an eligibility callback denying by default are intentional. Both queue Coin entries and Crown direct pots use this gate, including Coins converted from purchased Crowns.
5. A verified offline-result/attestation pipeline before any device-local bot balance becomes server-spendable. No client wallet import endpoint exists.
6. Durable deployment, backups/restore drills, observability, privacy/deletion controls, fraud investigation and refund workflows. SQLite snapshot serialization is an auditable starter design, not a throughput claim for a large service; shard/normalize for scale after correctness and load testing.

## Platform risk, not a blanket legal classification

Apple 5.3.3 disallows IAP currency for real-money gaming. Google Play restricts money/purchased-item stakes for prizes of real-world monetary value. Whether this non-redeemable closed-loop implementation falls into a prohibited or regulated category requires the actual jurisdictions, terms and distribution model. Skill, calling it Crowns, or converting it into earned-looking Coins does not establish compliance. Do not misrepresent the stake functionality during app review.

Sources checked 5 October 2026:
https://developer.apple.com/app-store/review/guidelines/
https://support.google.com/googleplay/android-developer/answer/9877032/

## Test authentication

`tests/fixture-server.js` trusts X-Fixture-User ONLY for isolated loopback test identities, with an in-memory database. Never use it as deployed authentication. The production HTTP module contains no such shortcut. Test account data is not loaded into the client application or production database.
