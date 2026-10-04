# economy-1 test evidence

## Executed in this run

55 Node tests passed: 25 rules/domain tests, 21 authority tests, 5 durable-store tests and 4 HTTP tests. The rules tests also run 200 seeded complete games. Commands: `npm test`, `npm run test:balance`.

Coverage includes all 121 league price pairings, reversible/no-arbitrage conversion, idempotency conflicts, safe-integer bounds, zero-sum bounded Elo, placement/elite caps, bot caps, quest duplicate claims, weekly eligibility/pro-rating, contributor-specific refunds, direct/queue payer separation, rejected/unfunded offers, stale quotes, timeout/resignation, randomized payer-independent symbols, native receipt replay/refund holds, persistence after restart, independent SQLite connections, role isolation and authenticated HTTP routes.

Functional Chromium test passed two scenarios:
1. Offline wallet exchange both ways, no invented rank rows, five navigation tabs, local send rule, all four theme IDs preserving state, actual bot reply and straight route overlay.
2. Two authenticated TEST clients through the actual HTTP handler/SQLite authority: real fixture leaderboard, Gold-to-Diamond 26-Crown quote, challenger-funded consent, invitee zero debit, alternating validated moves, resignation settlement and Elo. Alice went from 100 to 74 Crowns; Bob from 0 to 13; 13 burned.

The browser's loopback navigation was blocked by the execution environment. The test injected the actual HTML/JS and bridged browser fetch requests to the loopback HTTP server using Python. External fonts/icons were blocked; a test-only sheet/overlay positioning shim was used with the locally available historical CSS fixture. Therefore these are FUNCTIONAL/STATE checks, not a new pixel-equivalence, font, accessibility or four-theme contrast audit. Production theme CSS/game.js/icons.js are intentionally excluded from this commit.

The balance script uses exact binomial expectations, not Monte Carlo promises: ten same-league ranked games/day, seven days, 50% win chance, no draws, complete weekly qualification and no quests/bots. Expected net Coins are positive across all leagues (+400 Wood through +1,036.64 Grandmaster). It also reports a 30% win scenario. These assumptions do not predict player behaviour, retention, revenue, within-week liquidity or profitability.

## Still required before release

Real identity integration; native store verification/billing sandbox tests; matchmaking deployment; reviewed paid-entry territories and age controls; offline-result verification; multi-process load and recovery drills; solver/collusion fraud review; native iOS/Android testing; real-font visual regression; accessibility and spending-protection audits. The SQLite snapshot design favors first-service correctness over throughput and was not load-tested for a large player population.

Run commands from the README. `.artifacts/` contains local run logs but is not a source dependency or production user data. Test identities exist only under `tests/`.
