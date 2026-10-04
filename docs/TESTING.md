# V3.2 validation report

## Automated domain tests

`npm test`: **24 passed, 0 failed**.

Coverage includes opening 81 cells, index-zero routing, resolved/free-choice destinations, self-send after a claim, no DRAW ownership line, immediate Mega victory, invalid input, 200 seeded complete random games, legal bot output, immediate strategic wins, symmetric Elo, elite caps, small-population gates, 50/50 arithmetic, mode separation, durations, reward caps, repeated IDs, excluded reward modes, UTC claims, cosmetic overspend, top-20/privacy filters, disabled paid stakes, atomic two-wallet reservation, void refunds, stale turns/revisions, idempotency conflicts and server timeouts.

This does not establish a statistically measured Elo difference between bot levels. The bots have distinct increasing search budgets and tactical tests; large-scale strength calibration is future work.

## Browser validation

Headless Chromium rendered the actual app source. All four themes were exercised through the settings UI, including bot replies, persistent cell geometry and settings changes during a game. Viewports: 320x568, 360x640, 390x844, 430x932 and 768x1024. A complete pass-and-play match was clicked through without board size changes on claims and without personal-stat pollution. No JavaScript page errors were recorded.

Additional UI tests passed: mode-filtered wins/time/rate, quest claiming and disabled re-claim, cosmetic duplicate-spend protection, global/league/country top-20 filtering, friend and leaderboard quote math, preserved turn timer after a theme change, a bot-first opening, the four-mode home flow, chip-based setup controls, and the restored bottom-sheet Settings/Tutorial interactions.

`tests/contrast.py`: **44 semantic color-pair checks passed**. See THEMES.md.

## Test-environment limitation

The environment blocks browser URL navigation, including localhost and file URLs. Browser tests therefore inject the real HTML/CSS/JS into Chromium and use a small controlled localStorage adapter. Serialization and reinitialization were tested. This is not a claim that native device storage, real HTTP delivery, App Store behavior, web payments or production networking were tested.

To rerun UI tests, install Python Playwright and Chromium. Set CHROMIUM_EXECUTABLE when using a non-default browser path. Test artifacts are intentionally not committed.

## Manual release checklist still open

- Actual iOS/Android devices, safe areas, font scaling and screen readers.
- Native-store receipts, entitlement restoration, refunds and regional billing.
- Auth/session expiry, WebSocket/SSE recovery and multiplayer outage refunds.
- Durable DB concurrency, kill-switch operation and ledger reconciliation.
- Legal classification and age/jurisdiction policy for any stake feature.
