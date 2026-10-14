# V5.2 powers presentation evidence — 14 October 2026

Owner: Codex/Sol UI slice. Integration owner: Codex root; Main retains power/replay/entitlement/native/Core authority. Baseline source commit: `36c982fab6ca59e5ed0744d585175605050f9a9d`, local branch `codex/v52-provider-release`. The UI changes are uncommitted at handoff. Exact changed-file hashes are in `source-receipt.json`; these hashes, rather than the baseline commit alone, identify the tested source.

Status: **IMPLEMENTED / LOCAL TESTED, fail-closed presentation.** This is not a live powers implementation, provider acceptance, native acceptance, released bundle or production approval. `window.MegaPowers` remains absent from current browser source. No endpoint, ad placement, local entitlement grant or browser game rewind was added. No commit, push, build, payment, deployment or provider change was performed by this slice.

## Implemented presentation and integration

- `apps/web/powers.js` exposes the standalone `globalThis.MegaWebPowers` presentation helper. The helper uses the exact `powers/v1` reader names: `version`, `inventory`, `eligibility`, `request`, `apply`, `pacing`.
- `apps/web/powers.css` inherits the board palette/font tokens for browser Neon and all four retained themes. It includes visible keyboard focus, 44-pixel controls, narrow layouts and forced-colors support.
- `apps/web/board.js` mounts a compact Bot Undo panel below local Bot practice. The home preview, guided lesson, same-screen game and all current online matches exclude it. Normal move, tutorial, theme and keyboard behavior remains covered by existing tests. Refresh retains the open drawer and restores button focus.
- `apps/web/board.css` adds a container-responsive fallback matching the existing mobile practice layout. This prevents a zoomed/embedded page heading and help column from forcing horizontal scrolling.
- The panel describes two **earned** Bot decision charges, the bank, optional rewarded ads, Remove Ads, the shared 10 shown exposures per UTC day and 2-minute spacing. Unknown charges/inventory/pacing are shown as unavailable, never fabricated as zero or an earned item. The disabled Casual selector discloses ordinary no-power and powered rules. Undo Request, Undo Block, Tactical Power and Tactical Block remain distinct and counterable actions never promise success.
- Local practice never supplies a verified actor/match gate and does not wire request/application buttons. Even an injected valid reader cannot activate a local write or expose unverified actor inventory. The missing-adapter state remains disabled.

## Prepared adapter boundary

`createController` accepts private host integration callbacks; these are **not additions to the frozen remote protocol**. `verifyContext` defaults to false. A future Main integration must verify the permanent actor, current match/revision, exact reader identity, feature/consent/age eligibility and inventory ownership before returning true. An arbitrary signed-in flag is insufficient.

The fixture-only verified host tests exercise forwarding the caller's exact context into `request('undo', context)` and `apply('undo', context)`. The frozen contract only supplies a concrete Undo eligibility shape, so hint/counter writes remain closed. No request result increments inventory/charges, changes pacing, applies a move, reveals advice or uses an item automatically. All counts are reread from the adapter. Async responses are fenced by reader identity, actor/match/revision and the entire supplied match summary, and by destruction. Retired/unverifiable context masks counts before the next refresh. Rated, staked, direct/challenge, tournament, LAN and unsupported modes exclude the panel, including contradictory Casual summaries with stake/rated terms.

No-fill, failed-to-present, skipped, pending, reconnect and technical failure messages stay distinct. Unresolved pending/reconnect/malformed responses prevent additional rewarded requests. After a confirmed application, another application stays closed until the host supplies a new authoritative context. Technical reservation recovery is Main's responsibility; the UI never consumes or refunds an item locally. No automatic retry is sent.

`inventory` accepts only the four frozen direct item entries with nonnegative integer available/reserved counts; if a `version` tag is supplied, it must be `powers/inventory/v1`. This validates the fields frozen in the execution board without inventing an envelope. Bot Undo charges are restricted to 0–2. Pacing requires the owner-approved cap of 10. Invalid/missing readers or incomplete results fail closed.

## Contract details required from Main before activation

These are gaps to resolve in the shared execution board, not protocol fields invented by this UI:

1. Exact `matchSummary` and `request/apply` context schemas, kind enum/mappings, feature flag and permanent actor/session/match/revision ownership. Inventory needs a verifiable ownership/freshness binding before it is displayed for another actor.
2. Explicit ruleset negotiation before Casual matchmaking, with powered/no-power acknowledgment. There is no ruleset selection operation in the frozen methods.
3. Separate eligibility, initiation/use/block caps and pending reservations for Undo Request, Undo Block, Tactical Power and Tactical Block; Bot package uniqueness and two-charge progression.
4. Authoritative counter request ID/window, pending/settled/blocked outcome and legal recommendation bound to the accepted revision. No current method returns a settled legal square. **This UI never displays or highlights a Tactical suggestion**, including unexpected advice in reader/request/apply fields.
5. Epoch/time unit and clock basis for `nextEligibleAt`, UTC rollover and actual shown-exposure timing. A verified future host must use the same time base as `now`; current practice never activates a request.
6. Reward attempt identity, confirmation/reconnection status, technical reservation return and safe retry resolution. No unresolved outcome may be treated as a new grant or retried blindly.
7. The exact authoritative board snapshot/update path after application, including rewind branches. This slice does not alter the existing server board history validator or canonical rules.

## Verification and evidence

| Check | Command / environment | Result | Evidence |
| --- | --- | --- | --- |
| V52-PW-01…12 including retirement and pending Tactical privacy additions; existing board/Bot/tutorial/app/realtime regression | `node --test tests/v52-p21-powers.test.js tests/v5-p21-board.test.js tests/v51-p21-bot.test.js tests/v5-p21-app.test.js` on local Node | **85 PASS, 0 FAIL, 0 SKIP** | `targeted-tests.txt`, `source-receipt.json` |
| Five-theme local presentation matrix | `NODE_PATH='<existing Playwright runtime>' PLAYWRIGHT_BROWSERS_PATH='<existing isolated Chromium runtime>' node docs/v5.2/provider-evidence/20261014/powers/local-fixture-qa.cjs` | **185 PASS, 0 FAIL**; 20 screenshots | `local-fixture-report.json`, `local-fixture-screenshots/` |
| Initial zoom finding | Same source-fixture runner before container fallback; original zoom coordinate comparison included | 180 PASS / 5 FAIL; preserved, superseded by corrected check + actual overflow fix | `initial-local-fixture-report.json` |
| Whitespace | `git diff --check` | PASS | terminal result / handoff |
| Real powers/provider/Core/SSV/device | Not run: implementation/authority unavailable | **NOT_RUN** | shared contract gaps above |

The local matrix uses inline source, canonical game rules, local font bytes and a fresh headless Chromium page; all network requests are blocked. It tests expanded drawer keyboard access, refresh focus/open state, accurate disabled actions, unknown charges, disabled Casual/counters, text contrast, no horizontal clipping at 320/390/1280 pixels and 200% **CSS zoom**, plus same-screen exclusion and script errors. CSS zoom is an additional automated layout probe, not physical-device/OS accessibility acceptance. Cropped screenshots carry a fixture-only visual label and show local presentation only; their directory and report also identify the fixture environment. Representative images were inspected for light-theme mobile, browser Neon mobile and Paper Club zoom.

Root owns registering `powers.js`/`powers.css` in the real builder and browser entry point, rebuilding and verifying the actual integrated bundle. The fixture runner performs no build and does not modify the root QA snapshot. Further true browser/device/provider acceptance is required when Main exposes the verified powers contract.

Rollback: remove the guarded powers references in `apps/web/board.js`, the new module/style and the two container-rule additions in `apps/web/board.css`; root can remove its module/style registration. No data, schema, authority, game rules, economy or provider configuration was changed by this slice. Preserve the evidence packet and other owners' work.
