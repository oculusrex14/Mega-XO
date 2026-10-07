# Mega XO game-design invariants

These are contract rules, not balancing suggestions. `tests/design-invariants.test.js` must stay green before a change is accepted.

**V4.1 compliance note:** invariants 5, 6, 8 and 9 describe the deterministic math of dormant pooled-stake mechanics. They are retained for migration/audit safety only and are **not production-approved**. P1-7 requires `MEGA_PAID_ENTRY_ENABLED=false`; bought and earned virtual currency are treated the same **when the approved jurisdiction/platform policy permits purchased virtual entry**; `npm run competition:audit` must continue to classify the current ranked/direct/tournament pools as prohibited pooled stakes.

1. A cell position routes the next player to the Mini Board at the same position.
2. If that destination is resolved, the next player gets a Free Route to any unresolved Mini Board.
3. Claiming three Mini Boards in a line wins the Mega Board.
4. Elo is skill-only. Currency, purchases and stake size never change the settled rating result; this is tested through real Authority consent, escrow and settlement at different direct stakes.
5. Matchmade Ranked uses equal Coin entries; 50% of the combined pot is retired and 50% is the winner payout.
6. Ranked direct challenges are funded entirely by the challenger; the invited player pays zero. The pot is split 50/50 between payout and retirement.
7. Coin/Crown conversion is 10:1 both ways with no wealth spread; money-purchased provenance follows conversion so eligibility policy can make a jurisdiction/platform decision without changing the player's visible balance.
8. Public tournament prizes conserve the 10-player pool, retire 10%, and make fifth place break even.
9. Paid public tournament cohorts never exceed a 200-Elo spread.
10. Quarterly requalification requires five meaningful rated games, including three matchmade games against at least three unique opponents.
11. Direct ranked challenges can contribute to activity but can never replace the required matchmade games.
12. Elite seats require continuing recent rated/matchmade activity; paid direct challenges are not mandatory. Weekly publication must release an inactive elite seat without deleting the player's Elo.
13. Online results and matchmade opponents remain server-authoritative.
14. Tournament stats are aggregate records. Match-history/replay data remains a future feature.
15. Store-bought Crowns/derived Coins may fund competitive entry when the active jurisdiction/platform eligibility policy explicitly permits purchased virtual entry; missing approval means deny.
16. A future paid competition approval cannot reuse player-funded payout pools: the approved baseline is a fixed registration fee with organizer-funded prizes, trusted geo/age checks and jurisdiction/platform allowlisting.
17. The production config must continue to reject any attempt to set `MEGA_PAID_ENTRY_ENABLED=true` until EXT-26 is completed.

If a product decision intentionally changes one of these, update the design specification, tests and migration together in one reviewed change.
