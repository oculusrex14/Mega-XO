# Mega XO - V3.2.1 / economy-1

The final Figma appearance packs and restored game UI remain intact. This update implements the revised skill/wealth economy: reversible Coins/Crowns, ranked direct challenges, challenger-funded pots, gap pricing, weekly league rewards and a clean Rank/Wallet experience.

## Run and test

Open `index.html` with `src` beside it, or `npm start` for the static UI. Node 22.13+ is needed for server/SQLite tests; Node 22.16 was used here (`node:sqlite` reports its experimental status in that release).

- `npm test`: rules, economy, authority, durable transactions and authenticated HTTP tests.
- `npm run test:balance`: reproducible mathematical balance scenarios.
- `npm run test:ui`: functional Chromium checks, including two test clients against the real local HTTP/SQLite service. Requires Python Playwright and Chromium.

Google Fonts and the existing Lucide 0.468.0 script remain the same UI dependencies. Theme CSS, game.js and icons.js are not changed by this economy pass.

## Product rules

10 Coins = 1 Crown, both directions, no fee. Skill uses K=24 Elo; wealth uses Coins + 10*Crowns, including reserved balances. Purchases count toward wealth only. Global/country and per-league top-20 lists use real server data, with no fictional rankings bundled in the application.

Matched ranked games: equal Coin contributions, half the pot burned, half to the winner. Direct ranked challenges: challenger pays the entire Crown pot; invitee pays zero. The same 50/50 split applies. Unranked games are free. Friend pot max 20 Crowns = 200 Coins. Leaderboard minimum grows with target league and upward league gap, without a business ceiling. Both players must approve the terms.

Weekly rewards are posted after completed UTC weeks from qualified play and daily rank snapshots. Grandmaster/Master/Champion caps and qualification remain the approved system, with weekly title allocation. Purchases never increase Elo, its K factor, win bonus multiplier or league eligibility.

Full formulas, examples, reward table, business assumptions and sources are in [PRODUCT.md](docs/PRODUCT.md). [ECONOMY-PLAN.md](docs/ECONOMY-PLAN.md) maps the requested changes to implementation. [SECURITY.md](docs/SECURITY.md) lists actual safeguards and outstanding release gates. [TESTING.md](docs/TESTING.md) records what was run.

## Implemented versus deployed

The static app has local conversions, bot rewards, clean league/wealth views, online challenge/consent flows, and a same-origin API adapter. The repository now includes a durable SQLite economy authority and authenticated HTTP integration surface. Tests exercise actual move validation, settlement, Elo, refunds, receipt replay and restart durability.

This does not provision or deploy identity, matchmaking or native billing. Paid entries are disabled until a server owner supplies jurisdiction/platform/account eligibility. The UI reports an unavailable service instead of inventing an opponent or purchase. Developer notes and fictional preview controls are removed from the game; necessary pricing/consent and unavailable states remain.

Offline rewards are stored on the device. They are convertible there but cannot be imported into an account wallet merely because a client reports a balance. Verified online rewards/purchases use a separate server journal. Verified bot/offline ingestion remains a release requirement, not an implemented anti-tamper claim.

## Server integration

`server/http.js` exports `createHandler({store, authenticate, origin, matchmaker})`. Authentication must resolve a real account ID from a verified session. It must NOT use the loopback test identity header.

`server/economy-store.js` exports `DurableStore(path, authorityOptions)`. The options include `paidEntryEnabled`, per-account/quote `eligibility`, and an account-bound native-store `verifyPurchase` callback. Operator provisioning is separate from player commands. Player JSON never controls actor IDs or grants.

`server/jobs.js` exports `startMaintenance(store)` for expiry/timeout processing, daily snapshots and retry-safe weekly rewards. It belongs in the deployed service, not the browser.

`src/network.js` targets `/api/v1`. Optional native bridge contract: `MegaBilling.products()` returns localized product IDs/prices; `MegaBilling.purchase(productId)` returns native evidence for SERVER verification; `MegaBilling.restore()` handles the applicable native restoration flow. A client-only success flag never grants Crowns.

## Files

- `src/game.js`: unchanged pure Mega Tic-Tac-Toe rules and offline AI.
- `src/domain.js`: versioned economic formulas, conversions, Elo, leagues, rewards, aggregation.
- `src/authority.js`: trusted match/receipt/reward state machine.
- `server/economy-store.js`: atomic durable state and idempotent transactions.
- `server/http.js`: authenticated allowlisted player endpoints.
- `server/jobs.js`: maintenance and weekly payout worker.
- `src/network.js`: client API requests, no balance uploads.
- `src/app.js`: current UI, clean live-data flows, local and authoritative game controllers.
- `tests`: deterministic unit/integration fixtures only; no fake users in product code.

This is implemented development code with tested integration boundaries, not a claim of production deployment, store approval or guaranteed profitability.
