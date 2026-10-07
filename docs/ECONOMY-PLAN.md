> **V4.1 clarification:** the ranked/direct/tournament economy below is active product design. Bought and earned Crowns are economically and mechanically interchangeable, and Crowns remain closed-loop game currency with no cash-out or real-world redemption.

# Delivered scope map: economy-1

| Request | Implementation |
|---|---|
| Approved Elo leagues and limited top seats | domain assignTiers + weekly server publication; no seat swapping |
| One separate paid-or-earned wealth ladder | normalized Coins + 10*Crowns, public opt-in, real API results |
| Remove fictional game data/developer clutter | fixtureRows/demo controls removed; clean empty/error/consent states |
| Friend ceiling | 20-Crown pot = 200 Coins, mutual friendship check |
| Gap-based leaderboard prices without ceiling | quadratic upward-gap minimum, even whole Crowns, no economic max |
| Ranked or free unranked direct challenge | explicit type selection, hashed terms, accept/reject/expiry |
| Challenger funds direct pot | payer vector [pot,0]; refund follows that vector |
| Both fund Find Match ranked pot | equal Coin entries; only trusted matchmaker creates pair |
| 50/50 settlement | deterministic half burn / half payout; draws refund; void no Elo |
| More play earns Crowns | reversible exact conversion, daily caps/quests, weekly ranks |
| Weekly rank reward | UTC snapshots, anti-last-minute-rank-spike median, pro-rating, durable automatic grants |
| Monetization not excessive | modest proposed Crown packs, free casual, no expiry/skill boosters; reproducible balance script |
| Anti-cheat/abuse | server moves, persistence, idempotency, payer validation, repeated-pair checks, flags, receipt binding |
| Preserve themes/restored UI | CSS, icons.js and game.js excluded from changes |

The requested economy model is coded and tested. Native store/provider activation and live deployment acceptance remain separate release work; they do not change the in-game value or eligibility of bought versus earned Crowns.
