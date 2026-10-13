# P21 staging browser and provider readiness — 2026-10-13

## Scope and source receipts

Read-only inspection through the supported Brave browser UI. No password, OTP, sign-in submission, account classification, payment, app record, or store submission was entered or performed. No response bodies, cookies, authenticated traces, screenshots, or smoke-player names/IDs were saved.

The latest staging receipt identifies the isolated Oracle-hosted HTTPS origin as https://command.tail95c48c.ts.net. It records repository SHA 8328b71c934a5aba407daa6a1e243a3a4bdcd1f9, generated bundle source commit f4851a5, and bundle SHA-256 8167f349fb16b303c9347ac544afc3f9c73b9ea5515b0a085a7f40a6d75f3ea3 across 140 files. These are receipt facts, not values independently read from the browser.

Source records: STAGING-HANDOFF-FOR-CODEX-20261012.md and TRACK-B-HTTPS-WSS-ENABLED-20261013.md in docs/v5.1/release.

## Browser observations

| URL | Browser result | HTTP status evidence |
| --- | --- | --- |
| https://command.tail95c48c.ts.net/ | PASS — P21 home rendered over HTTPS. No TLS warning page appeared. | CUA does not expose the response code. The Track B receipt separately reports 200 from an external tailnet client. |
| https://command.tail95c48c.ts.net/account | PARTIAL — first visit rendered the anonymous email/password form; Google and Apple buttons were disabled. On the later visit, the page remained on “Checking your account… / Restoring your current session” through reload, for over 25 seconds of observed wall time. | CUA does not expose the page response code. No sign-in was attempted. |
| https://command.tail95c48c.ts.net/leaderboard | PASS — the leaderboard loaded after its initial loading state. It displayed public smoke-test fixture entries, including player names and IDs; those values are omitted here. | CUA does not expose the response code. |
| https://command.tail95c48c.ts.net/livez | BLOCKED IN BROWSER — Brave displayed “This page has been blocked by Brave” with ERR_BLOCKED_BY_CLIENT. No server result was obtained. No shield or security setting was changed and the endpoint was not retried. | No HTTP status was available because Brave blocked navigation. |

The browser address and page content confirmed HTTPS navigation without an interstitial, but the CUA surface did not expose certificate fields, response headers, or exact page status codes. The Track B receipt records 200 for /, /livez, and /api/account/session from an external tailnet client; those are receipt results, separate from the browser observations above. The account API endpoint was not opened directly, and no API body or browser cookie was read.

The first Brave tab-creation call returned “Capability is not available: visibility.” A subsequent navigation call timed out while the tab itself loaded and rendered normally. The later account navigation also timed out before the UI showed the session-restoration spinner. The documented console-log surface returned no page error entries; warn-level entries were from the Brave extension content script and their raw messages were not retained.

## Provider readiness

- Tailscale: the current receipt names node alias command and certificate domain command.tail95c48c.ts.net and records Serve enabled. The read-only Machines page redirected to Tailscale sign-in, so the exact machine ID and current Serve configuration could not be independently verified. The older node-specific link in the historical handoff was not opened because it targets the prior Mac node. No sign-in or settings change occurred.
- Apple: developer.apple.com/account redirected to Apple Sign In. Enrollment or membership status was not visible without authentication; no credentials were entered.
- Google Play: play.google.com/console opened the “Creating a developer account” page, with Organization and Yourself choices. No choice was selected and no account was created. The page states that the selected Google account will own the developer account and cannot be changed after creation; the displayed account identity is intentionally omitted from this report.
- The project is designated non-commercial hobby work; Vercel Hobby is accepted. No paid plan or store transaction was initiated.

## Human handoff and evidence boundary

The Brave tab is left open at https://command.tail95c48c.ts.net/account and marked for handoff. The original re-entry showed a session-restoration spinner; the later restricted inspection found the sign-in/recovery landing screen, not the owner's reported code screen. The currently loaded CUA policy says: “Changing a password or other authentication credential: Ask the user to take over before any new credential is entered, and have them complete the entry, confirmation, and submission steps themselves.” No existing or previously pasted password was used by the agent.

Target/environment: isolated V5.1 staging HTTPS origin on the private tailnet; production V4 was not accessed. Method: browser UI only. Result: home and leaderboard rendered; account form rendered once and later remained in session restoration; /livez was blocked by Brave; provider enrollment status is incomplete or requires owner review. Rollback: no provider or store configuration changed; no rollback action was applicable. A browser-managed anonymous session cookie may exist, but it was not inspected or recorded.

## Read-only check of the reported code-screen handoff

After the owner reported privately entering credentials and reaching a code screen, I inspected only the retained Brave account tab's form data-kind attribute, heading labels, and button labels. The tab still showed the sign-in/recovery landing screen: headings included “Continue to Mega XOXO,” “Continue with email,” “Use a linked provider,” and “Recover your account”; button labels included “Continue with email,” “Forgot password?,” “Google,” “Apple,” and “Check sign-in options.” The single form had no data-kind attribute. No code/verification heading or reset-specific form kind was present, so this tab does not confirm that the owner passed the continuation UI or whether the reported code screen is signup verification versus recovery.

This check did not navigate, reload, submit, inspect field values, email, code, challenge identifiers, page body, cookies, or screenshots. The only Mega XOXO tab visible in this subagent's Brave tab list was the retained account tab. The in-app browser was unavailable in this subagent session, so the owner's reported code screen could not be verified in another browser context.
