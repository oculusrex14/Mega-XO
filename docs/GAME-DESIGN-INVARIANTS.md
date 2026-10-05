# Mega XO game-design invariants

These are contract rules, not balancing suggestions. `tests/design-invariants.test.js` must stay green before a change is accepted.

1. A cell position routes the next player to the Mini Board at the same position.
2. If that destination is resolved, the next player gets a Free Route to any unresolved Mini Board.
3. Claiming three Mini Boards in a line wins the Mega Board.
4. Elo is skill-only. Currency, purchases and stake size never enter the Elo formula.
5. Matchmade Ranked uses equal Coin entries; 50% of the combined pot is retired and 50% is the winner payout.
6. Ranked direct challenges are funded entirely by the challenger; the invited player pays zero. The pot is split 50/50 between payout and retirement.
7. Coin/Crown conversion is 10:1 both ways with no wealth spread.
8. Public tournament prizes conserve the 10-player pool, retire 10%, and make fifth place break even.
9. Paid public tournament cohorts never exceed a 200-Elo spread.
10. Quarterly requalification requires five meaningful rated games, including three matchmade games against at least three unique opponents.
11. Direct ranked challenges can contribute to activity but can never replace the required matchmade games.
12. Elite seats require continuing recent rated/matchmade activity; paid direct challenges are not mandatory.
13. Online results and matchmade opponents remain server-authoritative.
14. Tournament stats are aggregate records. Match-history/replay data remains a future feature.

If a product decision intentionally changes one of these, update the design specification, tests and migration together in one reviewed change.
