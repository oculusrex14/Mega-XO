# Mega XO - V3.3.3

Private rooms and ten-player tournaments, added on top of the approved V3.2.1 Figma themes and economy. V3.3.1 is a UI polish pass for the new party surfaces: more spacing, clearer table hierarchy, and larger private-room choices across all four themes. The existing game rules, bot engine, icon adapter, theme CSS and normal app controller are unchanged.

## New play flows

**Private Match** opens a free room hub: One device, Same Wi-Fi, Online, or **Challenge a friend (1v1)**. Hosts choose League, Knockout, Mixed or a two-player duel. Up to ten people can join, ready, view fixtures/standings, play and reconnect. Private events do not charge currency or affect global Elo.

**Tournaments** is the fifth home game mode. Public tables require ten equal entries: Low/Medium/High in Coins, Premium in Crowns. Mixed format gives everyone group games and an actual placement game. Payouts are 36/20/13/11/10 percent of the original pool to places 1-5; 10 percent burns. Fifth breaks even, the top four profit, the bottom five lose their entries. These tournament rules do not alter the existing two-player 50/50 economy.

See [V3.3 rules, payouts and transport decisions](docs/V3.3-PARTIES.md) and [executed tests and limits](docs/V3.3-TESTING.md).

## Run

Node 22.13+ is required for the SQLite services.

- `npm start`: static browser app. One-device tournaments work without a server API.
- `npm run start:lan`: real free same-Wi-Fi host on port 8081. Open the printed LAN URL on each phone, create a room and share its code. Keep the hosting computer awake. `PARTY_PORT` and `PARTY_DATA_DIR` are optional overrides.
- `npm run test:parties`: 76 new tournament, wallet/room and HTTP tests.
- `npm run test:party-ui`: two-client party browser checks; Python Playwright and Chromium required.
- `npm test`: all repository Node tests.
- `npm run test:balance`: existing ranked economy scenarios.
- `npm run test:ui`: existing economy/browser flow suite, updated to load the additive V3.3 modules.

Keep the complete `src` and `server` folders. This is not a single-file HTML game.

## Offline means what here?

The shipped multi-phone offline path is a local Node host on a laptop or other capable device, with Android/iOS browser clients on the same trusted Wi-Fi. Internet is not required. The LAN server serves local assets and uses offline icon/font fallbacks.

Phone-only native hosting over Nearby Connections is a documented next integration, NOT a working Bluetooth/NFC feature in this browser build. One-device pass-and-play tournaments are available without that integration. Physical ten-phone hotspot interoperability still needs testing.

## Public money and deployment

`server/rooms.js` shares the existing economy database for atomic ten-player reservations, contributor-specific refunds and final placement payments. Quotes are fixed before readiness; all ten must accept. Public operation requires real identity, placements, balances, the existing paid-entry eligibility gate and a deployed HTTPS service. Paid operation is disabled by default. The LAN executable cannot enable it.

Mount `server/party-http.js` at `/api/party` ahead of the existing economy handler, using the same authenticated account resolver and database path. Start the room tick worker and call recovery once at service boot. The full integration example and security limitations are in the V3.3 documentation.

No fake online entrants, purchased success flags or client-reported winner endpoints are introduced. The public service, stores, native app and paid-entry jurisdiction review are not provisioned by this branch. Currency has no cash-out; that does not by itself establish legal/platform clearance.

## Existing V3.2.1 systems retained

- All four final Figma themes, prior targeted logo/icon fixes, floating navigation, Settings/tutorial sheets, Friends layout, cell hover and routing visualization.
- Complete 81-cell game and five bot levels.
- Ten Coins equals one Crown in both directions; independent skill and wealth leaderboards.
- The earlier K=24 Elo, leagues, elite seat limits, ranked/direct challenge rules, weekly rewards and consent/refund protections.
- Existing local stats/quests/wallet and authenticated economy integration.

Those earlier rules remain in [PRODUCT.md](docs/PRODUCT.md), [SECURITY.md](docs/SECURITY.md) and [THEMES.md](docs/THEMES.md). Public tournament results in this release do not alter normal Elo or mint regular ranked bonuses/quests/weekly rewards.

## Added modules

- `src/tournament.js`: pure schedules, standings, placement brackets, clocks and payout tables.
- `src/party-ui.js`, `src/party.css`: additive lobby/event/play interface using the existing visual tokens.
- `src/lan-icons.js`: inline SVG fallback for an internet-free LAN visit.
- `server/rooms.js`: durable lobby and monetary authority sharing the economy SQLite file.
- `server/party-http.js`: authenticated/guest-scoped room commands and snapshots.
- `server/party-server.js`: runnable, free-only local network host.
- `tests/tournament.test.js`, `tests/rooms.test.js`, `tests/party-http.test.js`: deterministic rules and actual SQLite/HTTP regression coverage.
- `tests/party-browser.py`: two-client functional checks, with environment limitations recorded.

This is implemented development code, not a claim of production deployment, native radio compatibility, store approval or guaranteed player profit.


## V3.3.2 matchmaking

V3.3.2 adds bounded server-side matchmaking for Ranked and Casual queues plus stricter public-tournament cohort assembly. Ranked keeps the approved visible Elo; Casual uses a hidden matchmaking-only rating. Search windows widen with wait time but retain hard caps, recent rematches and ranked friends are avoided, queued opponent identity stays hidden until both players accept, and public ten-player tables are assembled within a 200-Elo spread with deterministic seeding. Full rules and research basis: `docs/V3.3.2-MATCHMAKING.md`.


## V3.3.3 - profiles and friends

Guest-first landing/startup, unique usernames and immutable tags, Google/Apple identity and explicit linking/recovery, versioned practice backups, real friendship/search/profile-stat/challenge flows, leased presence and four theme-specific loading/waiting states. Existing palettes and game/economy/tournament rules are preserved.

- `npm run start:accounts`: combined same-origin identity/community/game/party server.
- `npm run test:accounts`: signed-token, SQLite and actual HTTP identity/social tests.
- `npm run test:account-ui`: two-client full UI flow (Python Playwright/Chromium required).
- `npm test`: full existing plus new Node regressions.

Provider sign-in is configurable, not fake: set the real Google/Apple app credentials and callback origin from `.env.example`. Unconfigured sign-in stays unavailable while guest offline play remains usable. Native credential adapter sources are in `native/`, not a compiled mobile project. Read [V3.3.3 account contracts and release boundaries](docs/V3.3.3-ACCOUNTS.md) and [test evidence](docs/V3.3.3-TESTING.md).
