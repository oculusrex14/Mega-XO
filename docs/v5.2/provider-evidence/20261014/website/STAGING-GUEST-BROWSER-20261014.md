# V5.2 staging guest browser pass — 2026-10-14

Observed in the dedicated Brave staging tab on 14 October 2026, approximately 17:50–17:58 UTC, using the CUA accessibility tree and screenshots. Target: `https://command.tail95c48c.ts.net`. No sign-in, account creation, credential entry, ad request, provider setup, purchase, economic action, or account change was attempted.

## Served build and browser boundary

The browser-read manifest at `/web-build.manifest.json` reports source commit `ad847dea17c8becc2ac4f3dbbd2654e05c379fe4`, bundle SHA-256 `d9e281c01003bf61082692258297fbeea692790f55daeaa19f63c0ae0cbdae31`, 160 files, and 3,685,921 bytes. Main separately records the `origin/V5.2` redeploy at `939d299`; the manifest identifies the packaged source independently. The manifest says `api.configured: false`. Main’s handoff reports `/livez` and `/readyz` as HTTP 200/ready; those health responses were not independently checked in this browser pass.

The routes loaded over HTTPS without a browser certificate interstitial. This demonstrates browser reachability and the presented certificate being accepted by Brave; it does not inspect the certificate chain or prove TLS configuration. Captured CUA console errors: zero. Warning entries in the sampled log were from an installed browser extension; no staging-origin console error appeared. The CUA inspection did not expose a network-request/static-asset failure audit.

## Anonymous route results

| Route | Observed result |
|---|---|
| `/` | Homepage loaded with the game description, Play Now and Download Now links, local practice preview, and an online Ranked sign-in link. The preview was a non-interactive prefilled practice board in this pass. |
| `/account` | The initial “Checking your account…” state resolved to a blank email/password sign-in form. Continue with email and Forgot password were visible; Google and Apple controls were disabled. No form was submitted. |
| `/game` | Local game loaded with Play against Bot, Easy, and Mega XOXO Neon selected. The UI also offered same-screen two-player mode, displayed keyboard instructions, and exposed no power, undo, tactical, reward-ad, or inventory controls in the guest game view. Online play links to sign-in. |
| `/friends` | Friends/profile/request/challenge links rendered, but the account panel remained at “Checking your account…” across a revisit and further route activity. No guest empty state or sign-in explanation replaced it. This is a staging UX defect; no friend action was attempted. |
| `/tournaments` | Public table descriptions and entry/payout values rendered, with View in game links and a sign-in gate for available tables/reservations. No table was opened or entered. |
| `/leaderboard` | The initial loading state resolved to 12 public synthetic smoke/test rows. All showed Gold and 1,500.00 rating with region “Test.” Handles are omitted here. This exposes test fixtures on an anonymous staging page and should be cleaned or isolated before using the leaderboard as release evidence. |
| `/settings` | Page rendered gameplay preferences, account/privacy links, and offline-practice controls. The text identified Mega XOXO Neon as a browser gameplay appearance. No setting, offline copy, or account/privacy control was changed. |

## Keyboard and mobile checks

With the game defaults unchanged, keyboard Enter activated Start a new game, then Enter on the focused legal board cell placed X. The offline Bot replied with O; the accessible state showed two moves and identified the Bot’s move. This was local practice only and did not touch an account, rating, wallet, or competitive match.

The documented browser viewport override was set to 390 × 844 and reset after inspection. At that width the homepage heading and primary links fit, the mobile navigation exposed Play, Tournaments, Leaderboard, Friends, and Settings, and the `/game` selectors and nine-board layout fit within the viewport without observed horizontal clipping. The account form also remained readable in the narrow view. CUA screenshots were inspected during the run; the available CUA/Node interfaces did not provide a supported way to transfer the screenshot bytes into a local file, so no screenshot artifact was written.

## Acceptance boundary

This is an anonymous frontend/staging smoke pass. Authenticated account creation/login, OAuth, friend requests/challenges, two-account WebSocket matchmaking, match settlement, tournament reservations, economic effects, real provider callbacks, production-domain behavior, device acceptance, and store acceptance remain **NOT_RUN**. The browser’s local Bot response is not evidence of online backend or competitive-state acceptance.
