# Annotation batch 1 — implementation and local evidence

Date: 15 October 2026. Target: local development only. Delivery: PR #16 to V5.2 for Main review.
No production/provider deployment, authority switch, schema/grant change, native AI change or merge.

## Exact implementation checkpoints

- `8648d9e995ebf992efc432d074aed24671fc3d46`: clean reconciliation with Main `5c80cdb`.
- `be5536c`: authenticated tournament API/Core adapter and bounded PostgreSQL timer.
- `1d0b3ba8c4bdc7b70c131c98494ddb1c80205d99`: all 28 website annotations and CI regression coverage.

The [28-comment register](PLAN.md) records the full requested scope. The existing PR also retains
its earlier native theme/presentation changes; no older evidence is promoted to this checkpoint.

## Local automated results

At the final implementation tree:

```sh
env -u NODE_OPTIONS node --test --test-reporter=tap tests/v5-p21-*.test.js tests/v52-public-annotations.test.js tests/v52-annotation-friends.test.js tests/v52-game-workspace.test.js tests/v52-web-tournaments.test.js
```

**272 passed, zero failed/skipped.** Covers session replacement/expiry/loading, local-game preservation,
canonical routes, mode selection, protected Friends paging and actions, public content/removals,
published rank progress, tutorial entry, strict tournament projections and stable operation keys.
Execution log: `/tmp/mega-annotations-final-web.tap`.

```sh
env -u NODE_OPTIONS NODE_PATH='/Users/oculus/Downloads/Test XO/node_modules' V5_PG_URL=postgres://postgres@127.0.0.1:63967/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 node --test --test-reporter=tap tests/v52-tournament-http.test.js
```

**13 passed, zero failed/skipped.** Real loopback HTTP and disposable PostgreSQL 16.15. Existing
tournament/gateway/composition regressions also passed **49 tests**, with no failures/skips in the
sequential rerun. See [backend evidence and its earlier disk-capacity failure](TOURNAMENT-BACKEND.md).
These are synthetic accounts and owned databases, not live players. Root repeated the new 13-test
suite successfully; execution log `/tmp/mega-annotations-final-http.tap`.

JavaScript syntax checks and `git diff --check` passed. CI now includes all four new website suites
and the new HTTP/PostgreSQL suite. Browser QA includes synthetic 23-friend pagination (10/10/3 and
back), account refresh across public routes, published player ID card, table catalog, and full tutorial.
Offline QA retains tests for previously opted-in copies after removal of the Settings page.
Those CI browser checks were authored here; their execution status must be read from the current PR.

## Build and actual browser observations

```sh
env -u NODE_OPTIONS node scripts/p21/build-web.js --output .artifacts/annotations-batch1-web
```

Source `1d0b3ba8c4bdc7b70c131c98494ddb1c80205d99`; bundle SHA-256
`fb89b2280e1bbaf798ee78929561315e18cc03bae8d1b67b741bbb3e9961aea0`;
163 allowlisted files, 3,781,702 bytes. Preview: `http://127.0.0.1:4190/game`.

Actual Codex in-app browser, 1265×720 desktop and 390×844 phone:

- Continuous fixed landscape remains behind the workspace at the bottom. Phone page width is 390px,
  with no horizontal overflow. Consistent side panels and collapsed Guided Practice are visible.
- Switched through Neon, Vector Light, Midnight Club, Paper Club and After Hours. Active borders use
  their original blue, lime, lime, yellow and yellow palettes. Shared board cells/lines no longer have
  the workspace-specific replacement styling.
- Difficulty select and options declare dark native color scheme and dark `rgb(11,25,48)` option
  backgrounds. Selection works. The browser capture omits the OS popup surface, so its rendered
  native popup was not independently captured.
- Completed all six guided moves, continuation steps and Beginner handoff using real controls.
  A separate Medium game accepted a centre move, produced an O reply, showed two moves, and routed
  the next turn to the top-left board.
- Clicked Home Play Now → `/play` → Start practicing with bots → `/game?mode=bot`.
  Switching to Ranked selects `/game?mode=ranked`, fences local cells and shows sign-in inside Setup.
- Download introduction and removed lower boxes verified in the rendered page. Sponsors preferences
  and disclosure together measure 361px on desktop; no Settings link remains in navigation.

Screenshots: [desktop game](game-desktop.png), [phone game](game-phone.png),
[compact sponsors](sponsors-desktop.png). Screenshots contain local guest data only.

## Acceptance limits and rollback

The static preview intentionally has no authenticated API. Account and signed-in Friends/tournament
UI checks use synthetic controller/CI browser fixtures; the separate local HTTP suite verifies real
API/Core/PostgreSQL behavior. Deployed browser tournaments, production sign-in and physical-device
acceptance remain for Main's reviewed integration environment.

Prior Android CI at `056771b` failed after READY at
`NATIVE_GAMEPLAY_SMOKE: phase=move-confirm; CDP_COMMAND_TIMEOUT`. It is retained as a real failure;
this batch does not change bot difficulty, AI, probe deadlines or claims about device readiness.

Before deployment, revert these two implementation commits together to restore previous website/API
behavior. After deployment, drain ongoing tournaments and disable admissions before removing a
tournament writer; preserve PostgreSQL authority and records. Do not restart a stale SQLite writer.
Settings removal does not erase an existing offline cache, browser opt-in or privacy preference.
