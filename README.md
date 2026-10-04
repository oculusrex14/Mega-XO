# Mega XO - V3.2

A playable offline prototype with authored themes, mode-specific statistics, a league gallery and a deliberately separated cosmetic economy. The V3.2 continuity pass restores the strongest V3.1 interaction patterns instead of redesigning the whole shell.

## Run

Open `index.html` with the `src` folder next to it, or run `npm start` and visit localhost:8080. There are no JavaScript packages or image downloads required at runtime. The restored V3.1 typography loads Space Grotesk and IBM Plex Mono from Google Fonts, with system fallbacks if the font CDN is unavailable. `npm test` runs the Node regression suite.

## What works

- The complete 81-cell game, all routing/draw rules, five offline bot levels and local pass-and-play.
- Vector Light, Midnight Club, Paper Club and After Hours. Every filled control has a paired foreground token. Theme changes preserve the game and remaining timer.
- Restored V3.1 UI continuity: Space Grotesk + IBM Plex Mono, a floating island bottom bar with scroll-behind content, bottom-sheet Settings/Tutorial, four home modes, chip-based match setup, and the board-first match screen.
- Play Online is one home mode with Ranked/Casual choices; Private Match keeps its dedicated Open Private Lobby action. Quests remain accessible from the home/wallet flow without occupying the primary bottom navigation.
- Original inline SVG icons and eleven rank emblems. No emoji icon substitutes.
- Tutorial and unrewarded Beginner practice.
- Separate Bot, Ranked, Casual and Friend stat views: wins, win rate, average completed-game time, total active hours, losses and draws. Online views stay empty without verified results. Pass-and-play is excluded.
- On-device quests, capped bot rewards, a local wallet ledger, duplicate-claim protection and cosmetic ownership previews.
- All eleven league presentations, Global/Country and league filters, top-20 lists and separate skill/earned-coin/cosmetic-crown views. Fictional preview data requires an explicit click and is labelled.
- Friend and leaderboard challenge quotations, including the 50/50 burn/payout arithmetic. Quotes do not move money.

## What is NOT live

Authentication, actual online matches, live rankings, real friend invitations, purchases, notifications and coin-stake play are **not connected**. The browser never claims a payment succeeded or a bot is a human. Local balances cannot be trusted or imported as spendable server balances.

`src/authority.js` is a **server-only, in-memory reference**, not a deployable financial service. It tests consent, legal moves, revisions, idempotency, escrow, refunds and settlement. A real service still needs authenticated APIs, durable database transactions, receipt verification, jurisdiction/age controls, abuse review and operations. Stake functionality is disabled by default; paid-currency stakes are rejected.

## Product decisions

1. Elo determines skill; percentile is informational. Wood through Emerald are open leagues. Elite caps are exclusive: up to 20 Grandmasters, the next 200 Masters and the next 1,000 Champions, subject to eligibility and floors.
2. Earned **Coins** and purchased cosmetic **Crowns** are separate. No conversion, gifting or cash-out. Paid currency never enters a match pot. Any earned-coin stake system remains subject to legal review.
3. A 50% pot burn means the winner only recovers their own entry fee before a separate bonus. The UI explicitly shows this.
4. V3.1 summaries are preserved separately because they cannot reconstruct mode-specific time. No historical hours are invented.

Read [the delivery plan](docs/V3.2-PLAN.md), [economy and rank rules](docs/PRODUCT.md), [theme contracts](docs/THEMES.md), [security requirements](docs/SECURITY.md) and [test evidence](docs/TESTING.md).

## Structure

- `src/game.js`: pure rules and budgeted iterative-deepening AI.
- `src/domain.js`: tiers, Elo helper, fee quotes, stat aggregation, quests and local economy.
- `src/app.js`: rendering, pause-aware clocks, persistence and page flows.
- `src/icons.js`: original SVG icons and rank emblems.
- `src/styles.css`: all four theme contracts and fixed gameplay geometry.
- `src/authority.js`: server-only settlement reference; not loaded by the browser.
- `tests`: rules/economy, browser interaction and color-contrast regressions.

This branch is a development preview, not an App Store-ready release.
