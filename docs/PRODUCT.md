# V3.2 product decisions: progression, statistics and economy

All economic amounts and rating boundaries below are initial tuning values, not empirical balance claims. Product version: 3.2. Rules must eventually be versioned and signed by the authority.

## Home

MEGA XO has no secondary product subtitle.

**Tic-tac-toe. Think bigger.**

Win the small boards to win the big one. Every move also decides where your opponent plays next.

There is no bottom relay-rule box. The tutorial remains available from home, settings and a match.

## Statistics

Keep Bot, Ranked, Casual and Friend records separate. Bot includes a difficulty filter. Pass-and-play cannot reliably identify the account holder, so it has no personal win rate, ranked effect or reward. Tutorial practice is also excluded.

Win rate is wins / completed games, including draws in the denominator. Average game time uses completed eligible games with known active time. Total hours also include unfinished eligible sessions. Hidden tabs, open dialogs and inactivity beyond 60 seconds do not accrue playtime; a visible turn clock still expires normally. Offline dialogs pause the clock and bot. Theme changes do not reset clocks or start a new match.

New timing begins in V3.2. The V3.1 summary is retained in a separate legacy field; it does not contain enough evidence to reconstruct old per-mode durations. Never replace unknown historical hours with invented estimates.

## Elo plus leagues

Elo changes from the opponent's rating and the result, not rank color, entry fee, playtime, coins or purchases. Expected score: E = 1 / (1 + 10^((opponent - self)/400)). Delta = round(K * (score - E)), score 0/0.5/1. The supplied helper defaults to K=24; an authority may use a shared K=40 for placement pairings, then 24. Apply equal/opposite deltas from one pre-game snapshot. Ten placements precede a public league. Starting server rating proposal: 1000; never show a fake Gold rank before play.

Use percentile only as descriptive context within the eligible rated population. It should not move someone from Silver to Gold merely because weaker players joined. No hard seasonal reset; store peak separately. Award elite titles from a scheduled, transactional leaderboard snapshot.

| League | Open threshold or elite floor | Ticket per player | Ranked win multiplier |
|---|---:|---:|---:|
| Wood | 0-699 | 2 | 1.00x |
| Stone | 700-899 | 4 | 1.05x |
| Iron | 900-1099 | 6 | 1.10x |
| Bronze | 1100-1299 | 8 | 1.15x |
| Silver | 1300-1499 | 10 | 1.20x |
| Gold | 1500-1699 | 12 | 1.30x |
| Diamond | 1700-1899 | 16 | 1.40x |
| Emerald | 1900+ | 20 | 1.50x |
| Champion | 2200+ and a seat | 24 | 1.65x |
| Master | 2400+ and a seat | 30 | 1.80x |
| Grandmaster | 2600+ and a seat | 40 | 2.00x |

Elite caps are **exclusive**, not inclusive: highest eligible Grandmasters up to 20, next eligible Masters up to 200, then Champions up to 1,000. The population must first reach 5,000 verified placed players. Individual eligibility: at least 50 ranked games, 10 unique opponents, account age 14 days, five ranked games in the preceding seven days, no suspension. Rating floors still apply and seats may be empty. Unfilled seats are not handed to low-rated launch users.

Sort by rating, then time that rating was reached, then immutable account ID. A country leaderboard never confers global elite status. Eligibility loss removes an elite title but does not arbitrarily delete Elo. Opening qualification games and anti-collusion review still need to be run by the real server.

## Rank UI

Every league has its own emblem: Wood grain, Stone facets, Iron anvil, Bronze medal, Silver wings, Gold crown, Diamond cut, Emerald cut, Champion star, Master wings and Grandmaster crowned laurels. Badge ink/background colors are paired separately for light and dark themes. League cards show qualification, ticket proposal and reward multiplier, never a fake number of live members.

Rank view: Skill / Coin vault / Crown vault; Global / selected country; All leagues / any specific league. Exactly up to 20 rows per query. The current player gets a separate position card when a live profile exists, even outside the top 20. The current build is Unranked and explains its placements instead. Preview data is fictional and opt-in.

Vaults are separate from skill. Coin vault ranks earned spendable server Coins. Crown vault ranks verified current cosmetic-Crown balance. Neither counts local preview balances, pending receipts or refunded purchases. Public vault participation is opt-in; never disclose real-money spend. Server privacy and age policies must decide eligibility for a public vault.

## Two currencies, not paid stakes

**Coins:** earned only, no fiat purchase, no Crown conversion, no gifting, no resale or cash-out. Local prototype grants 100 welcome coins once per local installation and tracks them in a local ledger. This grant is not a server entitlement.

**Crowns:** proposed store currency for deterministic cosmetics and profile presentation. No match entry, winnings, conversion into Coins, gifting or cash-out. Current balance is zero and purchase integration is disabled. Prices and localized currency strings must come from StoreKit/Play Billing. Never simulate a successful transaction. Restore/reconcile non-consumable entitlements and reconstruct consumable balances from the verified account ledger.

A legal review must evaluate the complete experience, not just currency names. Splitting wallets is risk reduction, not an automatic safe harbor. Do not add token exchange, cash-equivalent prizes or secondary-market transfers later without a new review.

## Earned-coin sources

Bot win rewards: Beginner 2, Easy 4, Medium 8, Hard 12, Expert 18. Shared maximum 100/day, and maximum five paid wins per difficulty/day. Clock day is UTC in the prototype; production must use authoritative server time. Reward only completed wins with at least 12 total moves and 30 active seconds. No restart, resignation, timeout, local multiplayer or practice reward. Caps apply before crediting; once a cap is hit, play remains available.

Daily quests: one finished match 5; three finished matches 15; 10 active minutes in qualifying completed games 15; six claimed Mini Boards 10; a free casual online match 15; a free friend match 15; a ranked match 20. Every quest claims once per UTC day. No streak penalty or paid streak repair. Online quests are disabled until verified events exist. No infinite idle playtime mint.

Server reward ceiling: up to 100 bot coins + 95 quest coins + 120 ranked bonus coins per account/day (315 maximum before further fraud controls). The prototype can earn only offline categories. A legitimate implementation needs match receipts and replay validation; uploading a local total is never sufficient.

## Entry, escrow and the 50/50 split

Casual online and free friend matches have zero entry fee. For random ranked pairs, use the lower player's league ticket for **both** players and disclose it before readiness. Do not charge when searching or charge a stronger player a different amount into the same pot.

For a leaderboard challenge: fee = min(200, roundUpToEven(targetTicket * (1 + 0.25 * max(0, targetTierIndex - challengerTierIndex)))). Friend stakes may be even integers from 2 to 200 per player, or free. Both must accept the exact same quote. Direct challenges never affect Elo; otherwise a paying player could buy favorable ranked opponents.

If each enters F, total pot = 2F. Burn F (50%), credit F to the winner (50%). **Winner net = 0 before bonuses.** This is not a profitable double-or-nothing wager. Showing the entire payout as profit would mislead users.

Ranked completion win bonus is a separate issuance: floor(12 * winnerTierMultiplier), capped at 120/day. Apply only to eligible verified ranked wins, never multiply the pot or apply the multiplier to bot rewards. Grandmaster maximum per eligible win: 24 bonus coins. An 80-coin pot at 40 each burns 40, pays 40 back to the winner, plus up to 24 independent bonus coins. The loser loses 40. A 50% win-rate player loses coins in expectation before rewards/quests: ticket burn is a deliberate sink, not a revenue source.

Invite creation, declined/expired invites, canceled queues and failed readiness: no burn and no fee. Both players accepting starts atomic escrow reservation. Draws and operator-voided server failures: refund both entries fully, no burn, no win bonus. A real disconnect policy must distinguish server outage from a player timeout; do not auto-forfeit during an outage. Timeouts derive from the server clock, not client timestamps.

The current UI only calculates these terms. `authority.js` is an in-memory test reference. It does not process money or expose a live backend.

## Tuning and launch gate

Before release measure coins minted/burned per active player, low-balance lockouts, free-play conversion, time-to-afford one ticket, win rates by tier and bot strength. At 50/50 skill, expected ticket loss is F/2 per match; source budgets must support the intended session length without forcing purchases. Since Coins are not purchasable, casual play must always be available to a low-balance player. Do not sell loss recovery, paid stronger moves, urgent top-ups or status shame prompts.

The tier schedule, percentile display, fees, multipliers and caps are hypotheses. Ship A/B changes only as explicit, versioned rules that cannot change mid-match.
