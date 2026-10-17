# V5.2 gameplay audit

Source: `7f582b749a1128b86e53ddcbcda57b569b0953cf`. Method: read canonical rules, app/website adapters, search/worker/tutorial/power code and existing tests/CI. No matches, test suites, benchmarks, training or device smokes were run locally. This report does not alter approved gameplay/economy or supply the final release verdict.

## Canonical rules

`src/game.js` is the authority for legality and transitions. Its SHA-256 at the audit commit is `e6e14c258b4db439eedf28090ebafd0962867bab5e64709d0d4438cb145b31e0`, matching the rules hash cited by the historical leagues.

| Behavior | Source | Static determination / existing coverage |
| --- | --- | --- |
| Nine mini boards × nine cells; X/O alternation | `create`, `step`, lines 7,14-19 | Immutable transition copy; move history grows by one ply; `tests/bot/contracts.test.js`, `tests/domain.test.js` |
| Legal moves exclude occupied cells and closed mini boards | `legal`, line 9 | Destination restriction applies until it is closed; terminal states have no legal moves |
| Validated move bounds and legality | `apply`, lines 10-13 | Noninteger, out-of-bounds and illegal moves throw `ILLEGAL_MOVE` |
| Mini-board win / draw | `winner`, `step`, lines 8,16-17 | Three same marks on a line claims a mini board; a full unclaimed mini is DRAW |
| Mega-board win / draw | `step`, line 18 | Three won mini boards in a line wins; every mini closed without a line draws; no invented majority rule |
| Sending the opponent to a closed board | `step`, line 19 | `required=null` gives free choice among open mini boards |
| Terminal input | `legal` / `apply` | No post-terminal move is admitted |

The [bot/tutorial regression job](https://github.com/oculusrex14/Mega-XO/actions/runs/39006747072/job/117320656188) passed its Node regression and browser/tutorial harness stages on the PR check source. This supports the explicitly tested rule/policy scope, not universal state-space correctness or physical-device behavior. No newly discovered canonical-rule defect is asserted by this audit.

## Actual renderer and state paths

- Website: `apps/web/board.js` uses the shared `MegaGame` loaded from `/legacy-game/src/game.js`, while rendering its own board, setup and keyboard UI. `createServerBoardSession` separates authoritative server snapshots from local practice. Online input is blocked for wrong actor/turn, uncertain writes, auth failures and stale session context.
- App: `src/app.js` owns match UI, local save/recovery, explicit restart/leave/resign, power controls and network binding. Root `index.html` supplies the app controls. Android/iOS package this UI; they do not run the P21 website renderer.
- Core: `packages/services/core.js` and the signed gateway own competitive/economic state. Browser/native boards submit commands and render accepted snapshots; a local move result is not a settlement authority.
- Realtime: `apps/web/realtime.js`, `apps/game-core/realtime.js` and request/ticket contracts retain session/match/revision fencing. The existing three-browser P21 transport CI passed synthetic HTTP and loopback WS/WSS, not live gameplay/provider/economy traffic.
- Matchmaking: preserve the 15-second offer TTL and explicit terms acceptance. A slow runner is not permission to extend it.

## Bots: selected engine versus available engine

Five classical level labels exist: **Beginner, Easy, Medium, Hard, Expert**. Native and website default difficulty settings differ; that is a presentation/default distinction, not measured strength evidence.

`src/bot/runtime.js:8-11` defaults new matches to `legacy`; `mega_v51_search=experimental` explicitly selects experimental search outside practice. `src/app.js` and `apps/web/bot-compat.js` preserve the selected/pinned engine and seed. Do not claim that the improved Expert league result describes every default shipped match.

| Level | Canonical legacy configuration (`src/game.js`) | Experimental configuration (`src/bot/search.js`) |
| --- | --- | --- |
| Beginner | Random legal move | Random legal move |
| Easy | Mini win/block heuristics and random legal choice | 8ms / 200 nodes / depth 1 profile |
| Medium | 55ms / 4,000 nodes / depth 2 | 55ms / 18,000 nodes / depth 4 |
| Hard | 140ms / 22,000 nodes / depth 4 | 140ms / 100,000 nodes / depth 8 |
| Expert | 320ms / 85,000 nodes / depth 6 | 320ms / 350,000 nodes / depth 12 |

These are **configured budgets**, not new timings or strength measurements. Actual measured evidence is confined to [BOT-BENCHMARKS.md](BOT-BENCHMARKS.md).

The classic worker validates engine, level, game ID and revision; replies carry request/game/revision; `contracts.accept` rejects a stale or illegal move. Explicit synchronous recovery is distinguished in diagnostics. Current experimental-search hash is `f06953d1c8d06666bde80d3c803baa54bd275ffdade94f18607bf76309dbf2ae`, different from the measured `5194df8e...` candidate. An unchanged `search-v1-experimental` label is insufficient provenance (SAGAN-008).

## Impossible and training boundary

`src/bot/pack.js:6` has `APPROVED_CATALOG=[]`. This is an effective publication gate, not an available powerful bot. Local neural creation requires a valid approved pin; fallback must explicitly relabel Expert and remain `unverified-local-ai`. Guided tutorial and optional local Impossible are **UNVERIFIED / UNPAID**: no official Coins, Crowns, Elo, seasonal or tournament reward authority.

The current `training/bot/champion_cycle.py` contains an actual bounded state-machine operator with generation, validation, training, export, evaluation, retry/resume and research-champion compare-and-swap. This supersedes historical statements that the file only writes a manifest. It does not establish that an always-running learning service is executing, that a current run completed or that a candidate is approved. Operational continuity and new strength are NOT_RUN here. Training remains offline on owner compute; game inference remains client-first.

## Tutorial and rewards

See [TUTORIAL-AUDIT.md](TUTORIAL-AUDIT.md). The script is six total plies: three human X moves and three bot O moves, not six human turns. It claims one mini board and demonstrates a closed destination/free choice before ordinary Beginner practice. Browser scripting success does not prove comprehension.

`src/domain.js:19-20,110-129` retains first-five-tier base payouts **1 / 1 / 2 / 4 / 6**, three paid Bot wins per level per UTC day and a 20-Coin aggregate daily base-policy cap. The current pass layer may multiply applicable Bot rewards within the approved caps; a payout table is not permission to change those rules. Qualification includes minimum 30 active seconds, 12 moves and legitimate terminal reasons. Practice/local, premature/timeout/abandoned and unverified local AI paths do not provide farmable official results. Online results require server authority.

`tests/domain.test.js:23-24` covers caps and practice/local/reward rejection; `tests/bot/local-ai.test.cjs` and `tests/bot/impossible-session.test.cjs` cover unverified/pin/recovery semantics. These tests' existence is not a new live-economy execution claim.

## Powers and assisted play

Exact UI controls: **Undo**, **Undo Block**, **Tactical Hint**, **Hint Block**. `src/powers-ui.js` ships only Undo and Tactical Hint. Counter-power rules/inventory exist, but active multiplayer counter integration does not. The disabled counters are correctly disclosed; no claim of working Powered Casual is warranted.

- Pure eligibility excludes practice/tutorial/Impossible, online/ranked/queued/direct/staked/tournament/party/LAN and busy/stale contexts as appropriate.
- Undo unlocks after eight plies; an earned package supplies at most two player decisions, with one package per Bot match under the frozen policy.
- Hint recommendations are revalidated against canonical legal moves. The UI says advice is not a guaranteed win.
- Earning depends on native SDK earned confirmation, not an ad merely opening. Shown skipped ads use an exposure slot without earning an item; no-fill/never-shown does not.
- Aggregate rewarded exposure cap is ten per UTC day with a two-minute gap. Pending ad/rewind results must remain revision-bound, and banked items must survive context changes.
- Crown purchase fallback banks after successful debit. Its device-wallet source differs from the linked wallet display (SAGAN-009); the website adapter remains closed without verified integration (SAGAN-010).

Existing `tests/gameplay-rewind.test.js`, `tests/powers-game-ui.test.js`, `tests/powers-integration.test.js`, `tests/powers-entitlements.test.js` and `tests/v52-p21-powers.test.js` exercise these boundaries. Real native ad callbacks, genuine purchased-Crown continuity and cross-device bank behavior are NOT_RUN in this workstream.

## Gameplay acceptance gaps

The observed Android emulator job initialized the signed offline app but failed at `move-confirm` with `CDP_COMMAND_TIMEOUT`; `scripts/v5/native-smoke-gameplay.cjs:77,115` bounds each evaluate and identifies that phase. This is an unresolved acceptance/infrastructure symptom, not a proven rule/search bug. The integrator initiated a retry separately. iOS simulator success is not iPhone performance or provider acceptance.

NOT_RUN: physical low/mid/high Android and iPhone response time, long tasks/input latency, RAM, thermal/battery, offline process death, rotation, interruption during ad/reward, real multi-device LAN, real paired online settlement and native screen-reader gameplay. Do not substitute the graph, static UI existence or an old simulation for these cases.
