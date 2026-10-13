# P21 browser realtime and account restoration — 2026-10-13

Evidence ID **P21-RT-20261013**. Codex owns this frontend slice; Main retains backend, integration, native and training ownership. This is an implemented, locally verified browser milestone. It does not establish authenticated staging or release acceptance.

## Source and preservation

- Fresh integration base: `b275b89678238f8c7a6a694953527c13c6026f8d`.
- Frontend feature: `4a9c29c789f743dcdcf76d5aea3ed4c47d4a9437`.
- Browser runner, artifact refusal tests and three-engine CI job: `e807d28b6f7eef2faf581eddd1e4028aa8f2696b`.
- Conflict-free merge of Main's published `8faf575fe7d70c4f5a321ffdc6cabdfed52f3e46`: `09e13826df714946388e9c610b8ddd62c3a4a604`.
- Both feature and integrated builds contain **153 files / 3,542,005 bytes**, bundle **`2887b0cd9723513792af01d71412ee94040f2f2dcfc9277a52fe7612733eb9e6`**. Every payload path, size and digest is identical across those builds. Manifest provenance differs correctly.

Work used the existing detached `v51-website-publish` worktree. Main's active checkout, its unpublished `340dcbe` observation, and its four untracked top-level work areas were left intact. The original readiness worktree's three paused 3D drafts and empty historical JPG retain their recorded hashes. No backend, training, model, native identifier, `main`, `V4.1`, production, DNS or provider configuration was edited. Merging already-published Main history preserves those original commits; it is not Codex training work.

## Resulting browser behavior

`apps/web/realtime.js` is a read-only `realtime/v1` reader wired into the current game controller and positive build allowlist. It obtains a fresh match-scoped ticket through `MegaAccount.request`, redeems it only at the same-origin socket, subscribes, resumes using the last applied snapshot revision and requests a full authenticated HTTP recovery snapshot. Tickets remain in the pending attempt's memory and are not stored or logged. Heartbeats, bounded connection/recovery waits, capped reconnect backoff and explicit teardown keep one active connection lifetime.

Acknowledgments and deltas never become board or economic state. Both HTTP and socket presentation check participant identity, match identity, revision, state shape, move history and terminal continuity. Stale reads cannot remount an older game. Same-revision FINISHED/VOID snapshots retire inputs, socket and polling, then refresh the real server profile once; displayed wallet/rank remains server supplied. HTTP remains the only move/resign channel, with its existing operation keys and polling fallback. There is no uncertain socket mutation replay over HTTP.

Callbacks are fenced by actor, opaque in-memory session identity, match, route/account epoch and connection generation. Shared HTTP clearing its cached session before an auth refusal is handled explicitly. A delayed recovery refusal after a newer applied snapshot does not invalidate that newer state. Generic socket close 1008 retries with a new ticket; only an explicit current authentication refusal retires identity.

The profile read model now has an independent **8,000 ms** deadline, releases superseded/logout/destroyed reads and rejects late results even when a stalled client/body ignores abort. Returning from back-forward cache restarts interrupted loading/error checks. The browser fixture observed retry UI 8,316–8,353 ms after its deliberately stalled request, with an explicit 500 ms scheduling tolerance. This validates a bounded frontend state; it does not prove the cause of the older staging reload delay.

## Verification

| Check | Exact target | Result |
|---|---|---|
| Affected Node suite | Integrated `09e1382`; Node 26.8.2; `node --test tests/v5-p21-*.test.js tests/v51-p21-bot.test.js` | **256 PASS**, zero fail/skip/cancel |
| New realtime browser scenarios | Feature `4a9c29c` / `2887b0cd`; Playwright 1.62.1; same helper `b42e8d13711c913362f9b1e964cdc414e4de5f43172664c25320234a1540059f` | **21 PASS each** in Chromium 151.0.7922.34, Firefox 153.0 and WebKit 26.5 |
| Existing protected profile scenarios | Same `4a9c29c` artifact; synthetic actors | **18 PASS each** in all three engines |
| Existing Friends scenarios | Same artifact; synthetic graphs/actions | **40 PASS each** in all three engines |
| Broad presentation/mobile | Same artifact; Chromium 151; desktop/tablet/390/320 | **915 PASS**, zero failures |
| Automated accessibility | Same artifact; Chromium; axe 4.14.0 | **137 PASS**, zero violations; **116 views still require manual review** |
| Guided tutorial / bot Worker / five themes | Integrated byte-identical payload; retained `tests/bot/p21-browser.cjs` | **15 PASS**, including six moves, state-preserving Beginner handoff and teardown |
| CI configuration | Parsed `.github/workflows/p21-web.yml` | Valid YAML; new synthetic realtime matrix for all three engines; remote run result recorded separately after push |

The realtime runner verifies every explicitly named artifact byte before copying it to an isolated loopback server. It uses real browser RFC 6455 connections and a separate temporary local TLS/WSS origin under the shipped `connect-src 'self'`. Keys are deleted and are not archived. HTTP responses, actors, tickets, settlement and wallets in that runner are synthetic. It proves reader/UI/CSP behavior, not live account authentication or Core settlement. Deliberate document visibility and cache lifecycle events are fixture controls, not real-device lifecycle evidence.

Earlier fixture failures, missing-engine launch failures, a Firefox measurement-baseline error and uncommitted development failures remain in the archive. They are not relabeled as passes or attributed to the final helper. Final reports and exact commands are indexed in [the persistent archive](evidence/20261013-realtime-browser/archive-index.json).

## Actual staging and provider observations

The read-only HTTPS manifest at `https://command.tail95c48c.ts.net` still identified source **`f4851a568524846d981b351c659af4a9ee7479be`**, bundle **`8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3`**, 140 files / 3,096,081 bytes. `/livez` returned 200 and ready. A fresh Brave account route/reentry showed the anonymous form. Reload displayed session restoration at 6.6 seconds; the form had returned at the next bounded observation about 26.6 seconds after reload. A separate cookie-free session probe returned 200 in 752 ms. Cookie-bearing request timing/cause and the running process boot SHA remain unverified.

Google Cloud is open in a dedicated Brave handoff tab with the account chooser ready. The current identity is personal; the existing business Workspace sign-in option is visible. The owner must complete its private password/MFA step before business projects/OAuth clients can be inspected. No project or account was created. Current Play/AdMob/Apple membership, application IDs and store records remain unverified. The selected `online.megaxo.xoxo` targets are not registration evidence.

Vercel Hobby remains the approved non-commercial plan. Existing `apps/web/vercel.json` prepares the dedicated static preview, disables automatic Git deployments and retains noindex. No project/deployment/plan change was made. A private tailnet API is not exposed through a public proxy.

## Open acceptance and next milestone

The master checklist remains **71 checked / 159 open**. None of the compound live realtime, account/native, provider, device or owner gates closes from these fixtures. Main must deploy the reviewed integrated bundle, provide its exact process/build receipt, fix the two service defects and provide two approved disposable actors plus the private OTP handoff. See [the precise Main handoff](CODEX-REALTIME-HANDOFF-20261013.md).

Next independently executable P21 slice: verify the challenge/tournament/transaction read contracts and add the missing protected invitation/eligibility/error presentation incrementally. Real creation, both accepts, complete gameplay, reconnect, resignation/timeout/void, wallet/rating settlement, friends privacy and native continuity remain acceptance-open. No balances, quotes, listings or tournaments should be invented to fill those states.

Rollback is an ordinary reviewed revert of the frontend feature and/or runner/CI milestone, preserving Main's history and all evidence. Rebuild and redeploy only isolated staging through Main. Production and indexing holds remain active.
