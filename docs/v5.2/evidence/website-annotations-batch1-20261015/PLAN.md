# Website review — first annotation batch

Owner comments: 15 October 2026, local preview `127.0.0.1:4187`. Delivery is one updated PR #16
against V5.2. Main remains the integration owner. Production, providers, training, rules and economy
are outside these edits. Existing PR #15 stays separate. Main `5c80cdb` was merged cleanly before work.

## Execution order

1. Preserve/fetch/reconcile the existing UI branch, then track every owner comment below.
2. Restore shared board presentation; standardize the workspace, continuous background and guide.
3. Consolidate play routes and mode selection. Reuse the existing six-move guided tutorial.
4. Correct shared account refresh and page rendering; implement the missing signed tournament
   API/Core adapter using the existing PostgreSQL tournament service, with actor and request fencing.
5. Reorganize Friends, leaderboard identity and public content. Remove Settings without deleting
   previously saved browser data or weakening privacy controls.
6. Run targeted unit/service tests, allowlisted builds and actual browser checks. Record local,
   synthetic-service, staging and device evidence separately. Push milestones to PR #16 for Main.

## Complete comment register

All 28 comments are implemented at `1d0b3ba8c4bdc7b70c131c98494ddb1c80205d99`.
The verification column names the acceptance focus; observed local results and remaining CI/staging
levels are recorded in [VERIFICATION.md](VERIFICATION.md). Implementation does not imply live deployment.

| Comment | Requested result | Verification focus | State |
| --- | --- | --- | --- |
| 1 | Landscape remains visible while scrolling `/game` | Desktop and phone top/bottom | Implemented |
| 2 | Consistent setup, player, power and guide surfaces/spacing | Desktop/phone visual review | Implemented |
| 3 | Dark mode menu instead of a white dropdown | Native dark color scheme and option colors | Implemented |
| 4 | Compact, collapsible Guided Practice | Native details keyboard/focus, tutorial entry | Implemented |
| 5 | Online mode/queue controls inside setup; no stale sign-in | Login/logout/refresh/expiry + queue states | Implemented |
| 6 | Restore original Neon and four retained board themes | Shared component computed-style parity | Implemented |
| 7 | Store availability button spacing | Error/ready/loading layout | Implemented |
| 8 | Useful Ranked sidebar content rather than dead space | Truthful rank/season guidance | Implemented |
| 9 | Real signed-in tournament catalog, join/readiness/fixture play | Protected API/Core + room recovery | Implemented |
| 10 | Rewards sign-in prompt disappears when linked | Account transition regressions | Implemented |
| 11 | Leaderboard player ID card, rank art and honest progress | Published/unpublished/limited-seat states | Implemented |
| 12 | Home practice points to the canonical game | Route graph/browser click | Implemented |
| 13 | Remove generic account security-note box | Copy/render assertion | Implemented |
| 14 | Public-facing download introduction | Copy/render assertion | Implemented |
| 15 | Remove download cross-client profile box | Copy/render assertion | Implemented |
| 16 | Remove download route-explanation box | Copy/render assertion | Implemented |
| 17 | Friends dominate the panel; search and 10-row pagination | 0/1/10/11/multiple pages, actor changes | Implemented |
| 18 | Challenge prompt follows authenticated state | Login/logout/refresh/expiry | Implemented |
| 19 | Remove redundant Friends navigation panel | Render assertion | Implemented |
| 20 | Home local-practice link uses canonical game | Route graph/browser click | Implemented |
| 21 | Home Play Now opens `/play`, which preselects actual game mode | bot/local/ranked/casual/friends | Implemented |
| 22 | Label bot entry “Start practicing with bots” | Copy/route assertion | Implemented |
| 23 | Rules page leads into existing guided tutorial | All six moves, handoff, no rewards | Implemented |
| 24 | Remove developer-facing sponsor narration | Public copy; no misleading active-ad claims | Implemented |
| 25 | Compact optional interest preferences | Consent/save/clear and mobile size | Implemented |
| 26 | Compact sponsor disclosure | Privacy access remains available | Implemented |
| 27 | Remove offline-settings panel | No visible preparation controls | Implemented |
| 28 | Remove Settings route and all navigation references | Static routes, SPA, SEO, stale links | Implemented |

## Findings and boundaries

Some sign-in blocks were unconditional. Account refresh also temporarily replaced the identity with
loading/empty data; changes must not make an authenticated local board reset or leak a prior actor's
data. Friends already returns bounded arrays, so ten-row client pagination needs no database change.

The PostgreSQL tournament service exists, but the V5 API/composition does not expose it. Reusing the
old SQLite party handler would cross authority boundaries. The new bridge must authenticate at the
API, derive the actor from that session, forward signed commands to Core, and let the retained
tournament service alone reserve entry and settle results. A local service pass is not live acceptance.

Known pre-existing PR evidence: Android UI initializes, but default-Medium gameplay CI reported
`phase=move-confirm; CDP_COMMAND_TIMEOUT` at `056771b`. Preserve that failure; do not lower difficulty,
extend deadlines or change AI/training to hide it. Full CI/device acceptance is not implied by this UI batch.
