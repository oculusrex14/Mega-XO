# V3.4 validation evidence

This document describes the current V3.4 validation contract. Older version-specific testing files remain historical records.

## Automated V3.4 CI

Workflow: `.github/workflows/v34-validation.yml`

Every push to `V3.4` runs:
1. full Node regression — `npm test`;
2. executable game-design invariants — `npm run test:invariants`;
3. Ranked expected-value report — `npm run test:balance`;
4. deterministic 90-day population simulation — `npm run test:economy-sim`;
5. upload of the generated economy reports from `.artifacts/`.

Validated on commit `dd08eba588851ca63de8fd50a3f4ace234d9b46e`:
- **199 tests / 199 pass / 0 fail** in the full Node regression;
- **15 tests / 15 pass / 0 fail** in the dedicated invariant suite;
- Ranked balance report passed;
- 90-day population economy simulation passed;
- `v34-economy-reports` artifact uploaded successfully.

The artifact step explicitly includes hidden files because the generated directory is `.artifacts/`.

## What the regression suite covers

The Node suite spans the shared game/domain rules, authoritative match settlement, durable SQLite stores, HTTP boundaries, matchmaking, community/account flows, private/public tournaments and V3.4 design invariants.

Important covered contracts include:
- Mega Board routing, Free Route and win resolution;
- K=24 bounded Elo and zero-sum rating updates;
- exact Coin/Crown 10:1 conversion and wealth conservation;
- queue/direct payer separation and escrow;
- timeout, resignation, draw and trusted-void settlement;
- idempotent wallet operations and receipt handling;
- verified store purchase/refund holds;
- weekly reward qualification/pro-rating;
- quarterly season rollover and requalification;
- elite-seat activity rules and leaderboard inactivity;
- matchmaking authority and public-tournament 200-Elo hard cap;
- tournament payout conservation and aggregate tournament records;
- authenticated HTTP/account/community boundaries;
- persistence and recovery behavior.

## Design-invariant hardening

`tests/design-invariants.test.js` is the product contract, not only a unit suite.

Two V3.4 invariants are explicitly integration-level:

### Money-independent Elo

The test settles two real Authority direct matches with:
- identical ratings and outcome;
- different Crown stake sizes;
- actual consent, escrow and settlement.

It asserts that the resulting Elo receipt and both player ratings are identical even though the monetary pools differ.

This protects the server settlement path, not merely the standalone `D.elo()` function.

### Elite inactivity release

The test creates an elite-eligible 5,000-player publication population, publishes a Grandmaster seat, advances across the next weekly publication boundary, and verifies that:
- the now-inactive player loses the scarce Grandmaster seat;
- underlying Elo is unchanged;
- the account remains otherwise skill-leaderboard eligible within the broader 28-day window.

This protects the real `Authority.publishLeagues()` flow rather than only the `D.eligible()` predicate.

## Ranked expected-value report

`tests/balance.js` uses exact binomial expectations for ten same-tier Ranked games/day, seven days, complete weekly qualification, no draws and no quest/bot income.

Under the V3.4 economy, Ranked is intentionally **not a Coin printer**. At a 50% win rate the modeled weekly net is negative across all tiers, from approximately:
- Wood: **-15 Coins**
- Gold: **-112.87 Coins**
- Grandmaster: **-752.73 Coins**

The script also reports the 30% win case. These calculations are deterministic conditional scenarios, not retention/revenue forecasts and not a guarantee that every player can fund every chosen stake.

## 90-day economy simulation

`tests/economy-sim.js` models 5,000 deterministic players over 90 days and mirrors the V3.4 daily Ranked bonus cap, real two-way conversion, Crown-pack-funded Coin continuation, tier-gap challenge pricing and weekly qualification rules.

Current V3.4 outputs include approximately:
- 38.89 Coins generated/player/day;
- 25.92 Coin-equivalent burned/player/day;
- 73.41% mint reduction versus the legacy comparator;
- 66.65% burn/new-mint ratio;
- 1,296 median Coin-equivalent wallet after 90 days;
- 5.46% ever below 25 Coin-equivalent liquid wealth;
- 11.00% ever unable to fund a chosen Ranked ticket;
- 11.30% ever reaching a core Ranked purchase decision;
- 40.42% ever skipping a chosen optional tournament for insufficient liquid currency;
- 13.94% simulated purchaser share.

See `V3.4-ECONOMY-RESULTS.md` for complete definitions and guardrails. Purchase metrics are scenario pressure measures, not forecasts of real conversion, ARPU or revenue.

## Browser and device validation

The repository retains browser functional suites for economy/UI, party, account/community, accessibility and monetisation flows. The V4.1 GitHub Actions workflow installs Chromium and runs the release accessibility/monetisation browser gates after the Node suites.

Passing browser functional tests does not by itself establish:
- pixel-equivalence to design references;
- real-font rendering on all platforms;
- accessibility compliance;
- native iOS/Android behavior;
- ten-device hotspot/radio interoperability;
- App Store/Play Console acceptance for native provider features.

## Still required before production release

V4.1 automated correctness does not replace production validation. Remaining release work includes:
- production identity/provider configuration;
- native Apple/Google billing sandbox and receipt lifecycle testing;
- live Oracle VPS deployment/load/recovery testing;
- adversarial staging acceptance for credential/OTP/replay/collusion/bot heuristics;
- native iOS/Android device testing;
- VoiceOver/TalkBack and real-device visual/network acceptance;
- production privacy/retention/moderation approval;
- native ad consent and store-purchase lifecycle acceptance;
- beta telemetry to replace modeled economy assumptions.

The SQLite implementation and deterministic simulations are engineering/design validation tools; they are not claims of production scale, profitability or user behavior.
