> **V3.5.1 patch:** Unified email/password continuation with OTP mailbox verification and recovery, Friends-page self-profile access, visible Cosmetic Credit balance, Antimatter Innovations developer identity, and the archived board-frame collection are governed by [V3.5.1-ACCOUNT-COSMETIC-PATCH.md](V3.5.1-ACCOUNT-COSMETIC-PATCH.md) and [V3.5.1-EMAIL-VERIFICATION.md](V3.5.1-EMAIL-VERIFICATION.md). They supersede conflicting earlier V3.5.1 email and V3.5 frame-catalogue language.

> **V3.5 addendum:** The competitive rules below remain the V3.4 baseline. For the current additive purchase, cosmetic-credit and ad rules, use [V3.5-MONETISATION-IMPLEMENTATION.md](V3.5-MONETISATION-IMPLEMENTATION.md). That addendum governs V3.5 monetisation; it does not enable paid-entry operation or change Elo/tournament currency rules.

# Mega XO V3.4 — canonical product rules

This document is the **current V3.4 product contract**. Historical V3.2/V3.3 documents remain in the repository for implementation history, but where they disagree with this file or the V3.4 design/economy documents, V3.4 wins.

## Core competitive model

Mega XO keeps skill and wealth independent.

- Rated matchmaking and rated direct challenges use the same K=24 Elo formula.
- Coins, Crowns, stake size, purchase history, league multiplier and wealth are never Elo inputs.
- Casual, free-friend and local play do not alter Elo.
- Public tournaments do not alter normal Ranked Elo.
- Purchased Crowns can change spending capacity and wealth, never skill.

Elo is stored to hundredths. New accounts begin at 600 rating. Ten lifetime rated placements are required before normal public skill publication/direct rated challenges.

## Ranked seasons

Ranked uses **quarterly UTC seasons**:
- Q1: Jan-Mar
- Q2: Apr-Jun
- Q3: Jul-Sep
- Q4: Oct-Dec

At rollover, underlying Elo is retained. Seasonal qualification, record, peak and leaderboard participation reset.

To requalify for the current season a player needs:
- 5 rated games;
- at least 3 matchmade Ranked queue games;
- at least 3 unique rated opponents.

Open-league players disappear from public skill leaderboards after 28 days without rated activity but retain Elo.

### Elite seats

Champion, Master and Grandmaster are scarce weekly-published seats:
- Champion: max 1,000
- Master: max 200
- Grandmaster: max 20

Elite allocation activates once the eligible population reaches 5,000.

A candidate must also have:
- at least 50 lifetime rated games;
- at least 10 lifetime unique rated opponents;
- account age of at least 14 days;
- current-season qualification;
- at least 5 rated games in the last 14 days;
- at least 3 matchmade Ranked games in the last 14 days;
- at least 3 unique rated opponents in the last 14 days;
- at least one rated game in the last 7 days.

An inactive elite player releases the scarce seat at the next weekly publication. Their Elo is preserved and they display at the highest open league supported by that Elo until elite eligibility returns.

## Leagues and current economy

| League | Elo floor | Queue entry each | Full weekly reward |
|---|---:|---:|---:|
| Wood | 0 | 2 Coins | 20 Coins |
| Stone | 700 | 4 Coins | 25 Coins |
| Iron | 900 | 6 Coins | 30 Coins |
| Bronze | 1100 | 8 Coins | 40 Coins |
| Silver | 1300 | 10 Coins | 50 Coins |
| Gold | 1500 | 12 Coins | 65 Coins |
| Diamond | 1700 | 16 Coins | 85 Coins |
| Emerald | 1900 | 20 Coins | 110 Coins |
| Champion | 2200 | 24 Coins | 150 Coins |
| Master | 2400 | 30 Coins | 220 Coins |
| Grandmaster | 2600 | 40 Coins | 300 Coins |

Starting wallet: **150 Coins**.

10 Coins = 1 Crown in both directions with no spread. Wealth score is current liquid/reserved holdings expressed in Coin-equivalent, not lifetime purchase volume.

### Ranked queue

Both players contribute the same Coin fee, using the lower configured fee of the pairing. The combined pot is split:
- 50% retired;
- 50% returned as winner payout.

That means the winner breaks even on the entry before the separate Ranked win reward.

A qualifying queue win mints **floor(60% of the winner's pre-match league fee)**, capped at **50 Coins per UTC day** per player. Direct challenges do not mint this bonus.

### Daily earn routes

Bot rewards:
- Beginner 1
- Easy 1
- Medium 2
- Hard 4
- Expert 6

At most 3 rewarded wins per difficulty and 20 bot Coins total per day.

Daily quest rewards are 2 / 4 / 5 / 3 / 5 / 5 / 6 Coins, for a maximum of **30 Coins/day** if all are completed.

Normal anti-farming qualification still applies to reward-bearing full games.

### Weekly reward qualification

Week is Monday 00:00 UTC through the following Monday.

A weekly payment requires:
- 5 qualifying rated games;
- 3 matchmade queue games;
- 3 unique opponents;
- activity on 3 days;
- at least 3 valid daily tier snapshots.

The paid tier is the lower of the end-of-week tier and the lower median observed tier. Reward is prorated by valid snapshot days out of seven. Missing snapshots are never fabricated.

## Direct rated challenges

All rated direct challenges use **Crowns** and are challenger-funded. The invitee contributes zero.

Settlement on a decisive result:
- 50% of the challenger-funded pot is retired;
- 50% is paid to the winner.

A draw or trusted server void returns the challenger contribution.

Friend-stake challenges:
- minimum 2 Crowns;
- maximum 20 Crowns;
- mutual server-recorded friendship required.

Leaderboard challenge minimum:
- let g = max(0, target tier index - challenger tier index);
- let B = target league queue fee;
- minimum = 2 * ceil(B * (8 + 4g + g^2) / 16) Crowns.

Leaderboard offers may exceed the minimum if the challenger chooses, subject to balance/safe-integer rules. Higher stakes never change Elo.

## Public tournaments

Public paid tournaments require exactly ten players and use a hard maximum **200 Elo spread** for the assembled cohort.

Current tables:

| Table | Entry each | Pool | 1st | 2nd | 3rd | 4th | 5th | Burn |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Low | 100 Coins | 1,000 | 360 | 200 | 130 | 110 | 100 | 100 |
| Medium | 400 Coins | 4,000 | 1,440 | 800 | 520 | 440 | 400 | 400 |
| High | 1,200 Coins | 12,000 | 4,320 | 2,400 | 1,560 | 1,320 | 1,200 | 1,200 |
| Premium | 200 Crowns | 2,000 | 720 | 400 | 260 | 220 | 200 | 200 |

Shares are 36% / 20% / 13% / 11% / 10%, then zero for places 6-10. Ten percent of the original pool is retired. Fifth place breaks even.

Tournament placement does not change normal Ranked Elo and tournament fixtures do not mint normal Ranked win bonuses.

Profiles expose aggregate tournament records only:
- entered;
- wins;
- runner-up;
- top 3;
- top 5;
- best finish;
- average finish;
- Premium wins.

## Economy balancing target

V3.4 intentionally makes Ranked sustainable but not a currency printer. The deterministic 5,000-player / 90-day pressure model currently reports approximately:
- 38.89 Coins generated/player/day;
- 25.92 Coin-equivalent burned/player/day;
- 66.65% burn/new-mint ratio;
- 1,296 median liquid wealth after 90 days;
- 5.46% ever below 25 Coin-equivalent liquid wealth;
- 11.00% ever unable to fund a chosen Ranked ticket;
- 11.30% ever reaching a core Ranked purchase decision;
- 13.94% simulated purchaser share under the model assumptions.

These are design-pressure outputs, not retention, conversion, ARPU or revenue forecasts. See `V3.4-ECONOMY-RESULTS.md` for definitions and guardrails.

## Monetization boundaries

Suggested Crown catalogue quantities remain 100 / 525 / 1,100 Crowns. Localized prices must come from the native store. Server credit requires a verified account-bound Apple/Google transaction; client-declared purchase success is never sufficient.

No:
- cash-out;
- paid Elo modifier;
- paid move/board advantage;
- loot-box outcome randomness;
- artificial currency expiration;
- purchase-dependent elite qualification.

Paid-entry operation remains gated behind deployment, platform and jurisdiction review.

## Deferred from V3.4

V3.4 does **not** ship:
- a user-facing replay/match-history product;
- tactical puzzles.

Both are recorded in `FUTURE-ROADMAP.md`.

## Canonical implementation references

- `src/domain.js`: economy, Elo, seasons, tiers, weekly rules and conversion.
- `src/authority.js`: authoritative ranked settlement, season accounting and league publication.
- `src/tournament.js`: public/private tournament rules and payout mathematics.
- `server/matchmaking.js`: matchmaking limits including the 200-Elo tournament cap.
- `server/rooms.js`: tournament reservation/settlement and tournament-record updates.
- `docs/V3.4-GAME-DESIGN.md`: design rationale and season policy.
- `docs/V3.4-ECONOMY-RESULTS.md`: deterministic balance model and current results.
- `docs/GAME-DESIGN-INVARIANTS.md`: executable design contract.
