# Mega XO - V3.4

V3.4 is the current game-system hardening and balance branch. It closes economy/design gaps, introduces quarterly Ranked seasons with inactivity protection, adds aggregate tournament records, and locks the core rules behind executable invariants.

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

Node 22.13+ is required for the Node services.

- `npm start`: static browser app.
- `npm run start:lan`: free same-Wi-Fi party host on port 8081.
- `npm run start:accounts`: combined identity/community/game/party server.
- `npm test`: full Node regression suite.
- `npm run test:balance`: ranked expected-value report.
- `npm run test:economy-sim`: deterministic 90-day economy simulation.
- `npm run test:invariants`: executable game-design invariant contract.
- `npm run test:ui`, `npm run test:party-ui`, `npm run test:account-ui`: browser functional suites where their environment dependencies are available.

The V3.4 GitHub Actions workflow runs the Node regression, invariant suite, balance report and population simulation on every push to `V3.4`.

## Release boundaries

This repository contains implemented development code. It does not claim:
- production deployment or store approval;
- legal clearance for paid-entry operation in every jurisdiction;
- native phone-hosted Bluetooth/Nearby transport;
- real-user retention/conversion/revenue validation.

Paid-entry operation remains disabled unless the server is explicitly configured with the required identity, eligibility, platform and jurisdiction controls.

## Current design references

- [Canonical product rules](docs/PRODUCT.md)
- [V3.4 game-design closure](docs/V3.4-GAME-DESIGN.md)
- [V3.4 economy results](docs/V3.4-ECONOMY-RESULTS.md)
- [Game-design invariants](docs/GAME-DESIGN-INVARIANTS.md)
- [Deferred roadmap](docs/FUTURE-ROADMAP.md)
- [Security](docs/SECURITY.md)
- [Themes](docs/THEMES.md)
