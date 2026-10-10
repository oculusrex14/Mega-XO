# Mega XOXO - V3.5.1

V3.5.1 builds on the V3.5 monetisation layer with a single first-party **Continue with email** account flow backed by mailbox OTP verification and password recovery, clearer self-profile access from Friends, and a revised cosmetic direction. The V3.5 board-frame collection is archived; Cosmetic Credits remain account-bound and are reserved for future full-theme releases. **Live ads and purchases are still disabled by default.**

Current patch reference: [V3.5.1 account and cosmetic patch](docs/V3.5.1-ACCOUNT-COSMETIC-PATCH.md).

Retained monetisation references: [Research](docs/V3.5-MONETISATION-RESEARCH.md), [Implementation and release contract](docs/V3.5-MONETISATION-IMPLEMENTATION.md), and [Validation evidence](docs/V3.5-TESTING.md). Where the V3.5 implementation document still describes the archived frame catalogue, the V3.5.1 patch takes precedence.

`Continue with email` signs into an existing verified profile when the password matches. For a new or previously unverified email, Mega XOXO sends a 6-digit one-time code and does not activate the email identity until that code is confirmed. Forgot Password uses the same verified-mailbox channel and revokes older sessions after reset. Production delivery is configured through Resend from **Mega XOXO by Antimatter Innovations <contact@antimatterinnovations.com>** after the Antimatter Innovations domain is verified. See [email verification and recovery](docs/V3.5.1-EMAIL-VERIFICATION.md).

Run `npm test`, `npm run test:monetization`, `npm run test:monetization-model` and `npm run test:monetization-ui`. Browser tests require Python Playwright/Chromium and use isolated test providers, never live ad inventory or real payments.

## Retained V3.4 baseline

V3.4 is the retained game-system hardening and balance baseline. It closes economy/design gaps, introduces quarterly Ranked seasons with inactivity protection, adds aggregate tournament records, and locks the core rules behind executable invariants.

For current product rules, use **[docs/PRODUCT.md](docs/PRODUCT.md)**. Older V3.2/V3.3 documents are historical implementation records and may contain superseded values.

## What V3.4 changes

- Rebalanced recurring Coin issuance and tournament stakes.
- Deterministic 5,000-player / 90-day economy simulation with CI guardrails.
- Quarterly Ranked seasons while preserving underlying Elo.
- 5-game seasonal requalification with 3 matchmade games and 3 unique opponents.
- Weekly elite-seat activity requirements so Champion/Master/Grandmaster cannot be parked indefinitely.
- 28-day public leaderboard inactivity rule for non-elite players.
- Public tournament cohort hard cap of 200 Elo.
- Aggregate tournament records in profiles/stats.
- Executable game-design invariant suite.
- Replay/history product and tactical puzzles explicitly deferred to future updates.

## Current economy

- Starting wallet: **150 Coins**
- 10 Coins = 1 Crown both ways
- Daily quests: maximum **30 Coins/day**
- Bot reward cap: **20 Coins/day**
- Ranked queue bonus: **60% of pre-match league fee**, capped at **50 Coins/day**
- Weekly rewards: 20 / 25 / 30 / 40 / 50 / 65 / 85 / 110 / 150 / 220 / 300 Coins
- Tournament entries:
  - Low: 100 Coins
  - Medium: 400 Coins
  - High: 1,200 Coins
  - Premium: 200 Crowns

Ranked queue pots and direct rated challenges keep their existing 50/50 retirement/payout logic. Purchases never enter Elo calculations.

See [V3.4 economy results](docs/V3.4-ECONOMY-RESULTS.md) for the corrected population model and current balance guardrails.

## Ranked seasons

Seasons are calendar quarters in UTC. Elo is retained at rollover; seasonal qualification, record, peak and leaderboard participation reset.

Current-season publication requires:
- 5 rated games;
- 3 matchmade Ranked games;
- 3 unique rated opponents.

Elite seats are published weekly and additionally require recent rated/matchmade activity. Inactive elite players release their scarce seat while keeping Elo.

See [V3.4 game-design closure](docs/V3.4-GAME-DESIGN.md).

## Tournaments

Public paid tournaments:
- require 10 players;
- enforce a maximum 200-Elo cohort spread;
- burn 10% of the original pool;
- pay 36% / 20% / 13% / 11% / 10% to places 1-5;
- leave normal Ranked Elo unchanged.

Profiles expose aggregate tournament records, not replay payloads.

Private room/LAN implementation history is documented in [V3.3 parties](docs/V3.3-PARTIES.md); that file is historical where V3.4 values differ.

## Run and validate

Node 24+ is required for the Node services.

- `npm start`: static browser app.
- `npm run start:lan`: free same-Wi-Fi party host on port 8081.
- `npm run start:accounts`: combined identity/community/game/party server.
- `npm test`: full Node regression suite.
- `npm run test:balance`: ranked expected-value report.
- `npm run test:economy-sim`: deterministic 90-day economy simulation.
- `npm run test:invariants`: executable game-design invariant contract.
- `npm run test:ui`, `npm run test:party-ui`, `npm run test:account-ui`: browser functional suites where their environment dependencies are available.

The V4.1 GitHub Actions workflow runs the full Node regression, game-design invariants, balance/economy models, seeded workload, P1-9 abuse acceptance, deployment syntax, Chromium accessibility and monetisation browser flows on every push to `V4.1`.

## Release boundaries

This repository contains implemented development code. It does not claim:
- production deployment or store approval;
- native phone-hosted Bluetooth/Nearby transport;
- real-user retention/conversion/revenue validation.

Ranked Coin entry, Crown challenges and public tournaments are closed-loop game-economy mechanics. Bought and earned Crowns have identical gameplay utility; Mega XOXO does not provide Crown cash-out or real-world redemption.

## Current design references

- [Canonical product rules](docs/PRODUCT.md)
- [V3.4 game-design closure](docs/V3.4-GAME-DESIGN.md)
- [V3.4 economy results](docs/V3.4-ECONOMY-RESULTS.md)
- [Game-design invariants](docs/GAME-DESIGN-INVARIANTS.md)
- [Deferred roadmap](docs/FUTURE-ROADMAP.md)
- [Security](docs/SECURITY.md)
- [Themes](docs/THEMES.md)
