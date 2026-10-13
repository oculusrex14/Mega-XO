# Historical localhost V5.1 browser review — 2026-10-12

> **Superseded for the corrected tailnet origin:** This report records the earlier `http://127.0.0.1:8081/` observation only. The current read-only CUA review of `http://100.107.65.122:8081/` and verified 140-file frontend bundle is in [STAGING-READONLY-20261012.md](STAGING-READONLY-20261012.md). The updated review supersedes the blanket “no staging URL/build is verified” wording, but API/server boot SHA, authenticated account flow and Core-backed mutations remain unverified, so R15 stays open. The adjacent `01-blank-script-url.jpg` is zero bytes and is not valid screenshot evidence; no saved screenshot file is claimed here. Preserve the remaining notes below as historical localhost findings.

This is a read-only browser observation from a fresh agent-created Brave tab. It is not an authenticated user-profile acceptance, a verified build identity, or a staging release sign-off.

## Environment and limits

- Target: `http://127.0.0.1:8081/` on local loopback.
- Browser control: CUA, Brave Browser extension, user profile label `Personal`, agent-created tab `1438672148`.
- Browser version: not exposed by the supported CUA browser inventory.
- The current `docs/v5.1/release/STAGING-HANDOFF-FOR-CODEX-20261012.md` documents deployed source `c71a3be`; this review did not verify the running process SHA or a built manifest.
- No login, account creation, API form, account/session endpoint, player row, or authenticated trace was opened. Only page navigation, resource loads, visible DOM/accessibility state, and browser console errors were read.
- In the CUA tab, the rendered page appeared dark blank with the top separator and scrollbar. A later export attempt using a `data:` URL was rejected by CUA browser URL policy with the redacted reason: “The browser URL policy blocks this action. The requested URL protocol is not allowed. Allowed protocols: `http:`, `https:`.” This was a protocol-policy denial, not an automatic approval-review rejection. No export retry or alternate path was attempted; the adjacent zero-byte JPG is invalid and no screenshot file is claimed in this folder.

## Findings

### P21-STAGING-ASSET-01 — game shell renders blank because script URLs receive HTML

**Result:** FAIL for browser rendering on the observed staging origin.

**Steps:** Open `/`, then directly open `/game`, then directly open the first failing script URL `/legacy-game/src/game.js` in the same new read-only tab.

**Observed:** `/` and `/game` showed only the “Skip to content” link and empty banner/main/footer landmarks; the screenshot was a blank dark shell. At `2026-10-12T16:36:50.411Z` and again at `2026-10-12T16:37:18.687Z`, the browser console reported `SyntaxError: Unexpected token '<'` for all of:

- `/legacy-game/src/game.js`
- `/legacy-game/src/bot/contracts.js`
- `/legacy-game/src/bot/runtime.js`
- `/legacy-game/src/tutorial/lesson.js`
- `/legacy-game/src/account-client.js`
- `/legacy-game/src/network.js`

Opening `/legacy-game/src/game.js` directly displayed the app shell’s skip link and empty main instead of JavaScript source, consistent with an HTML response at that script URL. This blocks staging browser gameplay and tutorial acceptance. The likely area to inspect is static artifact composition or server routing for the `legacy-game/` asset prefix; the running build identity remains unverified, so this note does not attribute the defect to a particular commit.

On a later read-only check, navigating to `/game` returned `net::ERR_CONNECTION_REFUSED` and the tab showed the browser’s connection-error page. No retry, server restart, or write was attempted; this documents the staging server becoming unavailable during the review.

### R15-AUTH-PENDING — staging HTTP session/email journey remains unverified

No sign-in or account mutation was attempted. The handoff document says `/api/account/session` and `/api/account/email` are not mounted in the documented staging source. Verify the running candidate SHA/build manifest and the mounted V5 HTTP auth routes before attempting any browser sign-in or account setup. This is a documented pending integration condition, not a browser-observed route failure.

## Evidence boundary

The observation is local GUI evidence from the CUA tab only. It does not establish the current staging process SHA, built bundle provenance, API/auth route state, backend health, production behavior, or user-account behavior. It records a reproducible front-end asset/rendering failure against the URL and time above.
