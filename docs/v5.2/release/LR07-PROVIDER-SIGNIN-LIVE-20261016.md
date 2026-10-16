# LR07 — provider sign-in live verification (web, 2026-10-16)

**Method:** Codex in-app browser against https://megaxo.online (production authority). Owner authorized completing sign-ins with their accounts. No secrets captured; OAuth URLs redacted of client IDs where printed.

## Verified live

| Check | Result | Evidence |
| --- | --- | --- |
| Provider capability load | Google + Apple buttons ENABLED on /account without any manual gate (PR #18 behavior live) | AX tree: "button Google", "button Apple" (no disabled marker) |
| Google OAuth initiation | accounts.google.com chooser with client_id 334987882979-… (configured client), redirect_uri https://megaxo.online/auth/callback/google, PKCE S256 (code_challenge + method), nonce, state, prompt=select_account, scope "openid profile" (minimal) | OAuth URL captured 03:46 UTC |
| Google consent | "Sign in to megaxo.online — Name and profile picture only" → Continue | consent screen |
| Google callback + session | Redirect to https://megaxo.online/?account=linked; homepage switched to signed-in state (Wood league, 600 rating, Find Ranked Match) | post-callback AX tree |
| Permanent actor | /account: player_f6ecb6a6f4, MEGA-AC3B0FAA Wood 600.00, Sign out button | AX tree |
| Sign out | "You are signed out." + sign-in form restored | AX tree |
| Session restore / same actor | Second Google roundtrip → ?account=linked again; /account shows THE SAME player_f6ecb6a6f4, same wallet (Coins 150, Crowns 0) and rank — cookie re-issue + actor persistence verified | AX tree |
| Apple OAuth initiation | appleid.apple.com/auth/authorize with client_id online.megaxo.xoxo.signin (canonical Services ID), redirect_uri https://megaxo.online/auth/callback/apple, state + nonce, response_mode=query; app registered as "Mega XOXO Web Sign-in" | OAuth URL captured 03:52 UTC |

## Blocked on owner (expected, non-technical)

- **Apple roundtrip:** requires the owner's Apple ID password + 2FA in the in-app browser (Apple session tab left open at the AppleID authorize URL). Everything up to Apple's own form is verified correct; after the owner completes it, verify the same pattern: callback to megaxo.online, linked session, and actor resolution (same permanent actor if the owner's Apple identity was linked before; a new actor is acceptable if this is the first Apple link — the cross-provider unification decision is separate, C-workstream).

## Not yet verified (device lane, LR07/LR08/LR20)

- Android/iOS native provider sign-in and the SAME permanent actor across browser↔native (needs device builds; owner's phones are USB-connected — schedule with the native QA pass).
- Token refresh/rotation over time, expired-credential and provider-cancellation paths (need an established session; re-check after the Apple roundtrip).
- Apple private email relay behavior (first Apple link will reveal it).

## Verdict

**Web provider sign-in is LIVE and verified end-to-end for Google; Apple is correctly wired and blocked only on the owner's credentials.** No code changes required from this pass. The "greyed buttons" defect from the pre-PR-18 era is confirmed fixed in production.
