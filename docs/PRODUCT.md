# Mega XO economy-1: approved ranks, unified wealth, challenger-funded play

This supersedes the earlier V3.2 cosmetic-only Crowns and unrated-only direct-challenge proposal. The implementation lives on V3.2.1. The four Figma themes, icons, game rules and CSS are retained.

## Exact product model

Skill and wealth are independent. Ranked queue games and ranked direct challenges use the same Elo calculation. Unranked queue/direct games are free and do not alter Elo. Crown purchases increase wealth, never skill. Coins and Crowns are not redeemable for money and have no external transfer/gifting endpoint.

The retained 50/50 split is an explicit interpretation of the latest request: both queued and direct ranked pots are half burned and half paid to the winner. The difference is WHO contributes: both queue players versus only the direct challenger.

## Currency and wealth

10 Coins = 1 Crown, reversibly, without a spread or exchange fee. Coin debits must be positive multiples of 10; Crown debits must be positive integers. All currency arithmetic uses validated safe integers, not fractions. A repeated transaction key returns the original receipt; reusing that key with different terms is rejected.

Wealth score = Coins + reserved Coins + 10 * (Crowns + reserved Crowns).

Reserved funds count once while a match is in progress. Conversion cannot improve wealth. Purchases, legitimate rewards, winnings, spending and burns can change wealth. This measures CURRENT in-game holdings, not lifetime purchase volume or real-world net worth. Public wealth is opt-in. Suspended accounts and financially held wallets do not appear in wealth results. Skill and wealth each support global/country, any league and top-20 filters. No fictional players are bundled in the application.

## Elo, not position swapping

E_A = 1 / (1 + 10^((R_B - R_A) / 400))
Delta = round_to_hundredth(24 * (score_A - E_A))
R_A' = R_A + Delta; R_B' = R_B - Delta.

Score is 1 for a win, 0.5 for a draw and 0 for a loss. A paired clamp prevents ratings below zero without creating points. Coins, Crowns, pot size, purchase history, league multipliers and leaderboard position are NOT inputs. This is a game-by-game, chess-inspired Elo variant; it does not claim to reproduce FIDE's rating-period, initial-rating, K-factor or rating-difference rules.

Examples: equally rated winner gains 12; 1500 beating 2700 gains 23.98 while 2700 loses 23.98; a draw in that pairing gives the underdog 11.98. There is no 500-point single-game jackpot. Position changes are recalculated from Elo; players never exchange positions.

Ten verified ranked placements precede public skill listing/direct rated challenges. New accounts start at 600; the placement phase does not fabricate a high initial tier. All ranked accounts use K=24.

## Approved leagues and rewards

| League | Elo floor | Queue entry each, Coins | Win bonus multiplier | Full weekly Coins |
|---|---:|---:|---:|---:|
| Wood | 0 | 2 | 1.00 | 50 |
| Stone | 700 | 4 | 1.05 | 150 |
| Iron | 900 | 6 | 1.10 | 250 |
| Bronze | 1100 | 8 | 1.15 | 350 |
| Silver | 1300 | 10 | 1.20 | 450 |
| Gold | 1500 | 12 | 1.30 | 550 |
| Diamond | 1700 | 16 | 1.40 | 700 |
| Emerald | 1900 | 20 | 1.50 | 850 |
| Champion | 2200 | 24 | 1.65 | 1050 |
| Master | 2400 | 30 | 1.80 | 1300 |
| Grandmaster | 2600 | 40 | 2.00 | 1700 |

Wood through Emerald are open leagues. Elite seats are exclusive: at most 20 Grandmasters, the next 200 Masters, the next 1,000 Champions. Elite allocation activates at 5,000 verified placed players. Candidates need 50 ranked games, 10 distinct opponents, a 14-day-old account and 5 ranked games in the last 7 days, and must meet rating floors. Seats may remain vacant. Ties use rating, rating-reached time, stable account ID.

Elite titles are published weekly. Elo changes immediately; weekly allocation avoids promoting/demoting a title on every individual result. This is NOT permanent rank protection: eligibility and rating floors are checked at the next allocation. Open leagues continue to follow current Elo.

## Matched ranked pots

Both players pay the SAME Coin entry: the lower league's configured entry. The matchmaker, not the user, chooses the pairing. Search costs nothing. Both approve exact terms before either debit. Equal entries f + f create a 2f pot. Burn f; pay f to the winner. Therefore a winner breaks even on the entry before a separate reward; a loser loses f.

A qualifying queued win additionally mints floor(12 * the winner's pre-match tier multiplier) Coins, capped at 120 per UTC day. Direct challenges do not mint this bonus. Qualifying games finish by a normal line win, have at least 12 total moves and 30 server-measured seconds. Timeout/resignation results still settle the pot and Elo but do not earn this bonus.

Draw: return each contribution to its original payer; Elo processes the draw. Server-voided match: full refund and no Elo change. Resignation/timeout are losses, not refund shortcuts. Ranked clock: 30 seconds per turn.

## Direct challenges

Only the challenger funds the Crown pot. The invitee pays zero and may accept or reject. Until acceptance, no currency is reserved. Both see the same hashed terms. Changed ratings/tier before acceptance require a fresh quote. Acceptance atomically reserves the entire pot from the challenger; insufficient funds leave both balances untouched.

Friends: minimum 2 Crowns; maximum 20 Crowns (200 Coins). A ranked friend challenge requires mutual server-recorded friendship; a player cannot simply label a stranger a friend to evade leaderboard pricing.

Leaderboard minimum: let g = max(0, target tier index - challenger tier index), and B = target league's queue fee.

P_min = 2 * ceil(B * (8 + 4g + g^2) / 16) Crowns.

An offer must be an even integer at least P_min. There is no commercial upper ceiling for leaderboard challenges; balance sufficiency and safe-integer limits remain mandatory. Target may reject even an offer above the floor.

Gold -> Grandmaster: g=5, B=40, minimum=266 Crowns. Challenger reserves 266; invitee reserves zero; 133 burn, 133 go to the winner. If challenger wins, their net Crown loss is 133. If they lose, it is 266. A victorious invitee gains 133. The minimum is payment for an optional challenge opportunity, not a purchased result.

Grandmaster -> Grandmaster: minimum 40 Crowns. Wood -> Grandmaster: minimum 740 Crowns. Both examples follow the same formula without a hidden ceiling.

A direct draw returns the entire pot to the challenger, not half to the invitee. Server void also returns funds to the challenger and leaves Elo unchanged. Unranked direct play has no pot and no Elo change.

## Weekly payout

Week = Monday 00:00 UTC through the following Monday. A worker captures daily post-placement tier snapshots and posts rewards automatically for completed weeks. There is no claim timer and no expiration. Missing snapshots are not invented after an outage.

Qualification: 5 qualifying ranked games, including 3 matchmade games, 3 unique opponents, activity on 3 days, and at least 3 valid daily tier snapshots. A final-day snapshot must exist. Rank used = lower of the final-day snapshot and the lower median of that week's observed daily tiers. Payout = floor(full weekly reward * observed snapshot days / 7).

A full Gold week pays 550 Coins. A qualifying first Gold week with 3 snapshots pays 235. A Sunday-only last-minute rank spike cannot earn a full higher-tier week. Unique week/account ledger keys prevent repeat payouts; interrupted jobs can retry safely.

## Daily earn routes

Bot win rewards: Beginner 2, Easy 4, Medium 8, Hard 12, Expert 18 Coins; at most 5 rewarded wins per difficulty and 100 total bot Coins/day. Normal full-game completion and the same 12-move/30-active-second minimum apply. Tutorial, local pass-and-play, timeout, resignation and restart cannot mint bot rewards.

Daily quests award 5/15/15/10 Coins for finishing 1/3 games, 10 active minutes in completed games, and 6 Mini Boards; verified casual/friend/ranked quests award 15/15/20. Daily claim IDs are unique. Server quest counters are derived from server matches, not client assertions.

Offline device rewards remain local. They can be converted locally, but are never silently imported into a paid/server wallet. A verified offline-result/attestation pipeline or server-verified bot mode is still required to make offline bot rewards account-spendable. This security boundary is not bypassed by the new conversion.

## Monetization and balance

Suggested starting catalogue: 100 Crowns at USD 0.99, 525 at 4.99, 1,100 at 9.99. These are tuning hypotheses, not live prices. UI uses the native store's localized product prices. No quantity is granted on a client's claimed purchase success: an account-bound, verified store receipt must resolve to the server catalogue and be globally unique.

No cash-out, paid skill boost, loot-box randomness, artificial currency expiration, loss-triggered purchase nag or paid extra move. Unranked multiplayer remains free. 100 welcome Coins provide an initial runway. Earned progression remains meaningful; purchases accelerate wealth/access, not the rating formula.

`node tests/balance.js` calculates exact binomial expectations for ten same-tier ranked games/day, 50% independent wins, no draws, all weekly eligibility met, and no bot/quest income. Expected NET weekly Coins after entries/bonuses/reward range from +400 Wood to +1,036.64 Grandmaster. At 30% wins the same scenario remains positive at every league. These are conditional mathematical checks, not a promise about any player's path or an empirical forecast. They do not guarantee sufficient cash balance at every point within the week.

Burning virtual Coins is not business revenue. Revenue comes from real purchases. Generous reward supply may reduce purchases, while arbitrary scarcity can damage retention. Before launch, instrument net mint/burn by cohort, purchasing share, direct challenge acceptance, queue abandonment on low balance, retention, refunds and currency concentration. No claim of profitability is made without real user data.

## Source context, checked 5 October 2026

- FIDE rating regulations, section 8.3: https://handbook.fide.com/chapter/B022024
- Apple App Review Guidelines, sections 3.1 and 5.3: https://developer.apple.com/app-store/review/guidelines/
- Google Play Real-Money Gambling, Games and Contests: https://support.google.com/googleplay/android-developer/answer/9877032/

The game-specific numbers above are authored design decisions. The sources do not endorse this economy. Paid-entry release requires jurisdiction/platform review; conversion does not remove the original monetary purchase provenance.
