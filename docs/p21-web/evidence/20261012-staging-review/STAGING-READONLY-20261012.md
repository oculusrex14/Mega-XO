# P21 tailnet staging browser review — 2026-10-12

Observed 2026-10-12 approximately 16:58–17:04 UTC in a fresh CUA Brave tab. This is a sanitized, read-only browser/evidence record. Target was the isolated pre-production tailnet origin `http://100.107.65.122:8081/`; no production origin was used. No player identifiers, credentials, OTPs, cookies, or private traces are recorded.

## Frontend identity and public responses

- CUA Brave tab loaded `/` with the expected populated Mega XOXO home page (hero, practice preview, navigation, and footer).
- Local generated manifest `.artifacts/p21-web/web-build.manifest.json` identifies source commit `f4851a568524846d981b351c659af4a9ee7479be`, bundle SHA-256 `8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3`, 140 files, 3,096,081 bytes.
- A cookie-free read-only fetch of every listed public file from the tailnet origin matched the manifest's HTTP 200 status, byte length, and SHA-256 for **140/140 files**. This verifies the served frontend bundle. It does not prove the running server process or backend boot SHA.
- Response samples: `/` 200 `text/html; charset=utf-8`; `/app.js` 200 `text/javascript; charset=utf-8` (24,805 bytes); `/legacy-game/src/game.js` 200 `text/javascript; charset=utf-8` (4,565 bytes); `/board.css` 200 `text/css; charset=utf-8` (17,376 bytes). Each returned `X-Robots-Tag: noindex, nofollow`.
- CUA direct navigation to `/app.js` returned `net::ERR_BLOCKED_BY_CLIENT`; the separate cookie-free response check above confirmed correct server MIME and bytes. This is recorded as a browser direct-script navigation limitation, not a server asset failure.

## Account boundary

- CUA opened `/account` and displayed the anonymous email/password continuation form. Google and Apple controls were disabled, consistent with the handoff's statement that provider OAuth is not mounted on this staging origin.
- No email or password was entered and no account signup/login form was submitted. The available connected tools expose no supported private OTP/credential-handling API; the OTP sink was not read. R15 browser authentication therefore remains **pending human credential/OTP handoff or a supported local helper**.
- Main's source review of `apps/api/routes/account.js` flags that `sessionCookieHeaders()` emits a non-`Secure` `mega_dev_session` cookie alongside the `__Host-` cookie without an environment guard. This is a source-review risk, not a browser-observed cookie result; Main owns the production review. No cookie values or raw headers were inspected, and no production endpoint was tested.

## Owner-reported account timeout — not reproduced by this agent

See the separate [sanitized account-timeout receipt](ACCOUNT-TIMEOUT-20261012.md). The CUA inventory exposed no `/account` tab when I checked, so I could not independently observe the UI error or inspect request status/timing. No retry, navigation, form read, credential entry, or submission was performed. Treat the reported timeout as **OWNER_REPORTED_NOT_REPRODUCED**, not a confirmed browser/network cause.

## Screenshot artifact classification

The older detached-worktree file `docs/p21-web/evidence/20261012-staging-review/01-blank-script-url.jpg` is empty (0 bytes; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; untracked; modified 2026-10-12 22:12:04 IST). It is not valid image evidence. It was left unmodified; this review does not claim a screenshot proof.
