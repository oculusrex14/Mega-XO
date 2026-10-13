# Codex to Main — browser realtime candidate and staging dependencies

Owner-authorized P21 coordination, 2026-10-13. This is an on-disk/Git handoff, not proof that Main has acknowledged or deployed it.

Frontend `4a9c29c789f743dcdcf76d5aea3ed4c47d4a9437` implements the scoped read-only realtime client and bounded profile/session-loading state. `e807d28b6f7eef2faf581eddd1e4028aa8f2696b` adds the exact-artifact synthetic browser runner/refusal tests and three-engine CI job. Merge `09e13826df714946388e9c610b8ddd62c3a4a604` retains your original published history through `8faf575fe7d70c4f5a321ffdc6cabdfed52f3e46` without conflicts or replaying previous P21 commits.

Reviewed bundle: **`2887b0cd9723513792af01d71412ee94040f2f2dcfc9277a52fe7612733eb9e6`**, **153 files / 3,542,005 bytes**. Integrated and feature payload inventories are byte-identical. Local affected suite **256/256**; realtime **21**, profile **18**, Friends **40** in each Chrome/Firefox/WebKit; Chromium broad **915**, automated a11y **137** (116 manual views open); retained tutorial/Worker **15**. All account/economic browser tests are synthetic. Evidence: [checkpoint](REALTIME-BROWSER-CHECKPOINT-20261013.md) and [archive](evidence/20261013-realtime-browser/archive-index.json).

## Main-owned service fixes — still source-observed

1. **R15-HTTP-WSS-PUBLISH-01:** `scripts/v51/p21-staging-server.cjs:180` constructs Core before ephemera and does not inject its publisher. Wire the owned adapter through composition and test a committed **HTTP move** reaching the other authenticated browser subscriber without polling. A direct WS-command smoke does not close this case.
2. **R15-TERMINAL-SNAPSHOT-02:** `packages/services/realtime-transport.js` suppresses hints on equal move revision; equal-revision resume can return only ack. Preserve canonical revisions and the 15-second offer TTL. Test HTTP resign, timeout and void delivering current status/receipt at the same revision, including reconnect.

The browser uses subscribe/resume plus full authenticated recovery, preserves 2.5-second HTTP fallback and never treats ack/delta as a board or settlement. Moves/resignations remain HTTP; cross-channel idempotency has not been assumed or enabled. Ticket values are not logged/stored. No backend/Core/database/native/training source was edited by Codex.

## Required deployment and private acceptance handoff

- Reconcile your active checkout and all unpublished work with the new Git checkpoint normally. Fetch/merge preserving both histories; do not cherry-pick already-integrated P21 variants, force-push, reset or clean. Your observed local `340dcbe` and untracked work remain untouched.
- Deploy the generated reviewed bundle to **isolated V5.1 staging**, keeping noindex/providers-disabled and V4 untouched. The actual HTTPS site still served old `f4851a5`/`8167f349` at this checkpoint.
- Provide website/API/WSS URLs, full **running process/boot source SHA**, start/image receipt and live **frontend manifest**. Source Git HEAD alone is not a running build receipt.
- Provide two approved disposable test actors with the owner completing credentials/code privately through your approved OTP channel. Staging outbound mail remains intentionally disabled. Never paste the OTP, password, email or authenticated trace into repository evidence.
- Confirm cookie/session refresh/logout/expiry, CSRF/Origin, ticket audience/scope and WSS/CSP admission contracts; real queue/challenge/tournament eligibility and cleanup ownership; later the tested native build for continuity.
- Reproduce the older Brave account reload delay against the **fresh serving bundle**. The new frontend watchdog bounds loading and fixes interrupted back-forward-cache restoration locally, but the earlier cookie-bearing staging delay has not been diagnosed.

Then Codex can perform actual signup/verification/login, both queue accepts, complete two-browser games, reconnect, terminal variants, profile/wallet/rating and friends/privacy acceptance. Backend CLI smokes and local fixtures remain separate evidence.

## Vercel preview architecture decision

Continue Hobby. The current reader deliberately uses the approved same-origin `/realtime/v1` ingress. For a future Vercel static preview, settle the actual reachable API/Core topology before connecting it: either a reviewed ingress serving the static site and API/WSS under one origin, or same-origin authenticated Vercel API routes plus an explicitly allowlisted reachable direct Core WSS origin. The latter needs a reviewed runtime WSS URL, ticket audience/Origin admission and CSP allowlist; the current reader does not accept arbitrary remote URLs.

Cross-origin HTTP must explicitly settle host-only cookie ownership, credentials, CORS, CSRF and trusted Origins; it is not repaired by widening CORS or forwarding private tailnet sessions through an insecure proxy. Do not put Core credentials in the frontend. The repository's current Vercel configuration packages a static site and does not implement the Core WebSocket listener. Keep automatic production deployment, noindex and DNS holds. No preview project or production operation was created here.
