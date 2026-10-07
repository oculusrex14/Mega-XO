# Economy-1 trust boundaries and release gates

This replaces the earlier cosmetic-only-Crowns restriction. Convertible Coins/Crowns, Ranked entry, Crown challenges and tournament entry are implemented as closed-loop game-economy mechanics. Bought and earned Crowns have identical gameplay utility.

## Implemented safeguards

All online changes go through a server-only Authority and DurableStore. The authenticated principal is supplied by the API's authentication callback, never JSON. Player endpoints cannot provision funds, choose a queued opponent, set rank, submit a winner, award a weekly grant, issue a refund, or invoke operator actions.

A SQLite WAL database plus BEGIN IMMEDIATE serializes wallet, escrow, rating, journal and idempotency updates. Results survive restart. A command exception rolls back all state. Returned state is cloned. Monetary values are nonnegative safe integers; currency conversion is exact and idempotent. Unique native store/transaction IDs prevent cross-account receipt replay.

Invitations expire after 10 minutes. No invitation/rejection/cancellation fee. Only mutually accepted, unchanged terms debit funds. The payer vector remains attached to escrow so refunds return to contributors, not the symbol X/O holder or the invitee by mistake. X/O is randomized independently from who funds a challenge. One live match/account prevents concurrent pre-rating settlement exploits.

Repeated ranked direct encounters: at most one per rolling 24 hours and three per UTC calendar week per pair. Queued repeated pairings: at most three per 24 hours. Challenger invitations: 20/day. Self challenges and blocked/held/suspended/unverified accounts are rejected. Friend pricing requires mutual friendship. Direct rated challenges require completed placements. These checks reduce abuse; they do not prove two accounts are distinct people.

Short direct results and direct pots of 5,000+ Crowns receive risk flags. V4.1 P1-9 extends this with repeat-rated-pair, repeat/concentrated-forfeit and extreme move-cadence review signals. These flags are evidence for review, not automatic fraud verdicts: they do not ban, de-rank, cancel a valid result or alter currency. Solver assistance, smurfing, collusion rings, purchased accounts, manufactured friendships and deliberate resignations remain risks even though legal moves/results are server-authoritative. Operator lookup can surface the review signals, while private timing samples stay out of player views.

Receipt refunds create a financial hold; held wallets cannot transact or appear on wealth rankings. The service does not automatically seize an innocent opponent's funds. Source tags and a purchase-influenced account flag provide an audit starting point, not exact unit-by-unit provenance accounting or a complete chargeback dispute workflow.

## P1-9 automated abuse gate

`npm run abuse:audit` is the V4.1 regression gate for credential stuffing, OTP abuse, recovery enumeration, purchase/ad replay, challenge/tournament collusion, leaderboard boosting and bot/solver abuse. See `docs/V4.1-P1-9-ABUSE-ACCEPTANCE.md`.

The edge limiter also applies persistent pseudonymous budgets to high-value purchase/reward, matchmaking and tournament-churn mutations. Ordinary move traffic is intentionally not subjected to those stricter persistent budgets.

## Remaining release prerequisites

Repository security controls are implemented. The remaining release work depends on external infrastructure/provider/device access:

1. deploy and validate the production/staging edge, secrets, firewall, backups, restore and monitoring;
2. configure real Google/Apple identity credentials if those login methods ship;
3. finish native StoreKit/Play Billing clients and sandbox/device acceptance before enabling purchases;
4. finish native AdMob/UMP integration and device/region consent acceptance before enabling ads;
5. approve/publish privacy, retention and moderation policies and run their live acceptance drills;
6. complete physical-device network/accessibility QA and the adversarial staging exercise.

These external gates do not create a separate bought-versus-earned Crown balance. Store receipts/refunds remain billing evidence; gameplay uses the normal closed-loop wallet.

## Test authentication

`tests/fixture-server.js` trusts X-Fixture-User ONLY for isolated loopback test identities, with an in-memory database. Never use it as deployed authentication. The production HTTP module contains no such shortcut. Test account data is not loaded into the client application or production database.
