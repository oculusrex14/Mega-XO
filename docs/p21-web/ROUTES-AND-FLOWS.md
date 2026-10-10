# P21 website routes and flows

This document describes the V5.1 website implementation in `apps/web/`. It is a local website build, not production deployment evidence. `apps/web/pages.js` exports the route metadata and pure HTML rendering interface. `pages.css` owns only secondary-page styling with the `pg-` prefix. The homepage, shared chrome, client navigation and playable local board are integrated separately.

The supplied cinematic screenshot governs the website composition and atmosphere. Its example balances, rank subdivision, player names and season are not live product data. Canonical gameplay, identity, rank, economy and themes remain governed by `docs/PRODUCT.md`, its V3.5.1 account/cosmetic and email-verification patches, and `docs/THEMES.md`.

## Route ownership

| Route | Page and main action | State/source boundary |
|---|---|---|
| `/` | Screenshot-inspired landing page; launch practice or browser game | Decorative game preview; guest wallet placeholders |
| `/play` | Ranked, Casual, friends and local-practice selection | Online actions open retained `/game/` |
| `/play?mode=practice` | Actual local playable board | Shared pure rules and AI; no account rewards or authoritative writes |
| `/casual` | Casual explainer and online/local choices | Normal Ranked Elo remains unchanged |
| `/ranked` | Placement explanation, canonical league/fee/reward table | Product rule table; personal rank remains in signed-in game |
| `/tournaments` | Four approved paid public table rules and prize places | Static published rules; no fabricated open tables or reservations |
| `/season` | UTC quarter, seasonal and weekly qualification, elite-seat rules | Calendar quarter computed from UTC; personal progress in game |
| `/friends` | Permanent-tag identity card, Friends/invitations gateway | Guest prompt; optional escaped identity metadata; game owns social operations |
| `/challenge` | Free-friend and rated direct-challenge terms | Game owns target resolution, eligibility, quote, invite and settlement |
| `/leaderboard` | Skill/wealth distinction and shared leaderboard gateway | No fabricated player rows, positions or percentile |
| `/rewards` | Currency meanings, approved earn routes and weekly rules | No balance/claim/purchase simulation; game owns economic operations |
| `/themes` | Four scoped palette/board previews | Approved palette IDs; game owns saved appearance |
| `/profile` | Profile overview and edit/privacy gateways | Guest or escaped optional `profile.displayName`, `username`, `tag` |
| `/settings` | Gameplay settings, system reduced-motion explanation and privacy links | Game owns saved gameplay preferences |
| `/account` | Continue/recovery explanation and retained account gateway | No second credential collector or identity system |
| `/how-to-play` | Small-board win, destination routing and macro-board win tutorial | Static shared-rule explanation; actual local-practice CTA |
| `/support` | Support contact, native disclosure and FAQ | `mailto:` link is explicit user action; no auto-sent message |
| `/help` | Alias of Support content with Help metadata | Same content and account boundaries as `/support` |
| `/accessibility` | Actual keyboard/motion/control descriptions and support path | Documents implemented controls; no certification claim |
| `/about` | Product premise and developer identity | Antimatter Innovations; no native-store launch claim |
| `/privacy` | Privacy overview with prominent draft notice | Full unchanged maintained document at `/legal/privacy` |
| `/terms` | Terms overview with prominent draft notice | Full unchanged maintained document at `/legal/terms` |
| `/privacy-choices` | Visibility, export, advertising and deletion guidance | Sensitive controls in game; full source at `/legal/privacy-choices` |
| `/delete-account` | Permanent deletion process and privacy links | No destructive website action; verified in-game process |
| `/status` | Honest connection guidance and game/support gateways | No unconnected uptime, healthy-state or incident claim |
| `/news` | Shipped v4.1.2 baseline and four-appearance notes | No fabricated release date, launch announcement or native availability |
| `/offline` | Loaded-site local-practice path and retry game | No claim of offline caching until independently verified |
| `/404` | Not-found recovery, Home and Play actions | Unknown client paths render this page |

Full original public HTML is retained separately under `/legal/{privacy,terms,support,privacy-choices,delete-account}`. The cinematic legal overview does not replace or approve those source documents. They retain their policy-status notices and review requirements.

## Interaction contracts

All secondary-page actions are regular semantic links. There are no disconnected reward claims, match-entry confirmations, editable account forms, fake search results or pretend appearance saves. The support FAQ uses native `details` / `summary` disclosure controls.

`renderPage(path, context = {})` returns a rendered page string or `null` for an unsupported path. A supported `/404` is available to the parent router. `routes` entries provide `{path, title, description, private?}` for document metadata and indexing policy. `private: true` marks Friends, Challenges, Profile, Settings and Account; the shared delivery shell must apply the actual noindex policy. It is metadata, not an authentication check.

The optional `context.profile` changes only safe identity labels and gateway copy. All player-provided labels are escaped. It never grants authorization or causes competitive/economic mutations. `context.now` optionally fixes a test date for the UTC calendar-quarter display. UTC quarter labels are calendar facts, not fetched personal season progress.

The parent router mounts actual local practice directly for `/play?mode=practice`. A pure-render fallback also supports `context.practice` / `context.query.get('mode')` with a `#practice-mount` placeholder, but the placeholder by itself is not a playable game. The integrated route must use the actual `renderPractice` / `mountBoard` implementation.

## Primary flows

1. **Guest to play:** Home → local practice, or Play → choose mode → retained `/game/` → approved account continuation → actual online mode selection.
2. **Rules to practice:** How to play → local practice → shared board rules / legal moves → return to Play or online game.
3. **Account access:** Account → game continuation → email/Google/Apple sign-in or verified email creation. Recovery and sensitive method changes stay in the retained account flow.
4. **Social:** Friends → game Friends screen → actual server search/request/invite. Direct Challenge explains authoritative terms before the existing game quote/confirmation flow.
5. **Competitive:** Ranked/Season/Tournaments/Leaderboard → published rules or gateway → real account state and authoritative action inside the game.
6. **Rewards and appearance:** Rewards → actual balances/earn progress in game. Themes → palette previews → actual game settings; no new theme catalogue or unlock economy.
7. **Data and deletion:** Privacy choices → maintained instructions → verified in-game privacy controls. Deletion requires the permanent player-tag confirmation and current approved release configuration.
8. **Connectivity:** Offline/Status → local practice or game retry → support if persistent. Guest sign-in requirement is auth state, not service outage.

## Layout and accessibility

Secondary pages use the cinematic navy/cyan/violet chrome with readable opaque glass surfaces, consistent headings, semantic sections, tables, links and disclosures. Desktop layouts use two-column, three-column or sidebar compositions; narrow screens collapse to a single column with touch-sized actions. Scoped four-theme cards preserve exact canvas/X/O palette colors without leaking into game or website tokens.

Tutorial boards and illustrative ranks are decorative, marked `aria-hidden`, and contain no fake focusable cells. The live practice board is separate. The accessibility page documents its actual roving keyboard focus, full 9×9 arrow navigation, Home/End row navigation, native button activation, descriptive cells and polite live status. Shared chrome provides Skip to content; mobile menu Escape closes and returns focus.

Reduced motion disables nonessential transitions, and forced-colors rules retain boundaries, text, active outlines and distinct X/O shapes. Native FAQ disclosures remain keyboard accessible. The full table uses proper row/column headers and a caption, with a scroll wrapper when required.

## Implemented and remaining boundaries

The local site has complete layouts and useful, honest guest states for the route set above. Online account/social/economic operations open the approved retained client. Direct website API read-state wiring, signed-in live cards, provider proof, native store approvals, public legal approval, production DNS/deployment, incident telemetry and production acceptance remain distinct gates. No static page, product rule table or green render test proves any of those gates.

This route work covers P21.02 and P21.07 implementation slices and supports P21.04 accessibility/empty-state components. Checklist completion and evidence are maintained by the parent integration owner after the whole build is verified at its exact checkpoint SHA.
