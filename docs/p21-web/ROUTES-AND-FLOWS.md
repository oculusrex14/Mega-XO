# P21 website routes and flows

This current implementation map supersedes the earlier gateway-only map, which remains in Git history. Candidate source `681f06b`, bundle `9cfa78636df7`, is locally tested; it is distinct from Main's served staging bundle. Canonical rules are `src/game.js`. Identity, ranks, economy, native themes and authoritative state retain their existing contracts.

## Current route map

| Route | Implemented behavior | Acceptance boundary |
|---|---|---|
| `/` | Cinematic home, interactive local board, protected personal-rank read, Play Now and device-aware Download Now | No preview economy writes; account integration pending |
| `/game` | In-site Bot/two-player board, six-move guided practice, five themes and signed-in online controls | Existing canonical Worker/lesson retained; real online acceptance open |
| `/play` | Mode introduction and in-site game/account links | `/play?mode=practice` mounts the actual local board |
| `/download` | Device-aware store availability/fallback | Real store URLs null; `/api/download` permits validated official URLs only |
| `/faq` | Answers about the game | The owner removed `/press` on 14 October 2026; company backlink remains prepared, with no live backlink/indexing claim |
| `/casual`, `/ranked` | Published rules, canonical league table, eleven rank images and server-selected tier | No invented subdivisions/rating |
| `/tournaments`, `/season` | Approved table/qualification rules and UTC quarter | Reservations, personal progress and payouts not accepted yet |
| `/leaderboard` | In-site standings, rating/wealth/scope/league filters and retry/error/empty states | No game redirect or fabricated rows; deployed correctness/privacy open |
| `/friends`, `/challenge` | Social and challenge explanations/account links | Search, requests, invites and actual challenge flows remain incomplete |
| `/rewards` | Protected balance read and approved earning/currency information | Claims and shared economy continuity pending |
| `/store` | Four approved products, wallet, provider/bridge availability and purchase/restore controls | Prices/products absent; unavailable purchasing disabled |
| `/sponsors`, `/ads` | Structured layout and explicit optional browser-local interest choices | No active ad unit, tracking or click reward |
| `/themes` | Browser Neon plus four original appearance previews | Play-theme control on board; future paid native Neon inactive |
| `/profile` | Protected identity/tag/tier/rating summary plus in-site username, display name and visibility editor | Actual staged persistence, avatar/history/stats/achievements acceptance open |
| `/account` | Email continuation, verification, recovery/reset, provider capability and logout via retained cookie/CSRF client | No second identity system; real browser acceptance and method changes/linking open |
| `/settings` | Appearance/account links, reduced-motion guidance, explicit offline Save/Remove | Saving opt-in; device/storage/update acceptance open |
| `/how-to-play` | Canonical small-board, routing and macro-board rules | `/game` provides the real six-move lesson; novice study not executed |
| `/support`, `/help` | FAQ and explicit contact link | No automatically sent message |
| `/accessibility`, `/about` | Implemented controls/product/developer information | No certification or store-launch claim |
| `/privacy`, `/terms` | Themed overviews and full-document links | Legal draft/review notices retained |
| `/privacy-choices`, `/delete-account` | Data/visibility/deletion guidance | No destructive website operation; actual controls remain open |
| `/legal/{privacy,terms,support,privacy-choices,delete-account}` | Full maintained text inside cinematic shell | Styling does not approve legal substance |
| `/status`, `/news` | Honest connection/release information | No invented uptime/healthy status |
| `/offline` | Guest-only fallback and practice recovery | Verified static copy only after Save; API/auth/private responses never cached |
| `/404` | Themed unknown-route recovery | Missing scripts/assets must return real 404, not HTML |
| `/legacy-game/` | Retained compatibility game/client entry | Separate from cinematic `/game`; links alone do not close UI requirements |

The builder produces 39 prerendered website documents plus retained assets and aliases such as `/game/`. Document, manifest-route and SEO-indexable counts differ. Canonical origin is `https://megaxo.online`. Local/staging responses retain noindex/nofollow; publication is held. Private/account/social and play routes are excluded from discovery. See [download/discovery](DOWNLOAD-AND-DISCOVERY.md).

## Interaction and authority

`renderPage(path, context)` renders known pages or returns null. The controller mounts `renderGame` / `renderPractice` / `mountBoard` for play routes. Controls use semantic links, buttons, forms and disclosures; availability comes from server/bridge replies. Player labels are escaped. Display context never grants authorization.

Browsing reads the protected profile without silently creating an anonymous account. Explicit account actions use `MegaAccount` with same-origin HttpOnly cookies and CSRF, reusing Main's V5 PostgreSQL HTTP bridge. Credentials/OTP/provider tokens are not persisted. V4 production identity is not proof of an isolated staging account.

Online acceptance uses the frozen server quote/terms. Retry retains the original operation/revision; session loss retires polling/input; stale replies cannot relink a retired actor. Core remains the competitive/economic writer. Offers, challenges, settlement, cross-platform continuity and native parity require real staging/device evidence.

## Layout and evidence

Website/legal routes inherit the navy/cyan/violet shell. Browser Neon is the fifth browser-only default; four original native theme IDs/rules remain intact. Theme changes preserve match state. The board exposes legal-move labels, keyboard navigation, focus and turn status. Narrow reflow is locally tested; physical safe-area, screen-reader and phone acceptance remain open.

[Execution status](EXECUTION-STATUS-20261012.md) records exact-source results and original checklist dispositions. [Main's handoff](RECOVERY-AND-MAIN-HANDOFF-20261012.md) distinguishes the recovered candidate from served staging and lists the missing service evidence. An attractive gateway or a game link is not completed account/social functionality.

## 2026-10-13 service boundary

New Friends actions use supported body.key and the identical shared-client request operation key; retries stay within the canonical social service. Typing removes stale search actions; refresh hides private lists until current actor verification. Profile drafts remain memory-only and freeze through same-actor identity refresh. The current private staging base is https://command.tail95c48c.ts.net; its frontend still serves f4851a5/8167. The source realtime ingress contract is wss://command.tail95c48c.ts.net/realtime/v1, while the current browser match controller still polls HTTP. A transport endpoint and service smoke are not an implemented/accepted browser WSS client or completed game settlement. See the current Main handoff and staged account-reentry defect.

See [realtime contract/source gaps](REALTIME-CONTRACT-AND-INTEGRATION-GAPS-20261013.md). Both publisher wiring and terminal-at-equal-revision behavior require Main coordination and genuine two-account reproduction.
