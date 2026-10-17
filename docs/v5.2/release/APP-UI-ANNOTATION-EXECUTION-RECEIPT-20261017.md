# App-UI annotation execution receipt — APP-001…APP-022 (2026-10-17)

Executed by the Codex lane from the cumulative plan at
[APP-UI-ANNOTATION-EXECUTION-PLAN-20261017.md](./APP-UI-ANNOTATION-EXECUTION-PLAN-20261017.md).
Implementation started at the reconciliation of Main's integration work (merge of origin/V5.2
into the annotation lane at 4dc164f, which absorbed Main's 2616d68 account-script fix and the
v35 CI parse gate).

## Reconciliation

- **A0/APP-010 was already fixed by Main** (2616d68: escaped apostrophes in src/community.js;
  the v35 workflow now node --checks every legacy client script). This run added the in-repo
  gate: tests/v5-client-bundle.test.js compiles every declared native client script with
  vm.Script (34 scripts parse at execution SHA).

## Implemented (commit → items)

| Commit | Items | Summary |
| --- | --- | --- |
| d1f3f2b | APP-001/005/019, APP-002, APP-004, APP-010 (gate) | Single Settings→Purchases Store route; all sheet/Quests footer Store entries removed (.mono-entry deleted); src/public-links.js canonical megaxo.online map used by Settings + account surfaces (native same-frame, browser _blank); Reduce motion gets its own Accessibility group with an OS-preference note; vm parse gate. |
| 2c93938 | APP-011, APP-014 | renderHomeSetup() returns balanced markup — the .old-setup container is now closed (was nesting Start Match, tutorial and utility cards); utility cards live in a neutral .home-utilities section; mode/difficulty/first/timer/queue changes update #homeSetupMount + #homePrimaryCta in place, so the entrance animation no longer replays on selection. |
| 64107ce | APP-012, APP-013, APP-018 | Rank help rewritten in plain language ('beating a higher-rated opponent', no 'upset' jargon), four named sections, thresholds from D.POLICY; Quests weekly card is a structured .weekly-reward-card with 'Up to N Coins at <league>', requirement list and honest timing. |
| 6587778 | APP-003 | Explicit audio lifecycle: one shared AudioContext, generation-guarded ambient graph, stop on opt-out/hidden/pagehide with fade+cleanup; audible 220/277/330Hz quiet bed replacing the inaudible 130.81Hz/0.004 tone; Preview sound action with honest 'Tap to enable sound' / 'Sound is unavailable here.' states. Device listening still required for final audibility sign-off. |
| 43ba35b | APP-006, APP-007, APP-009 | Balance card is a neutral raised panel with accent edge (no full-bleed --accent-soft), guest state shows 'Sign in to view your balance.' instead of a fake '--'; Sol's notched-ticket + crown Mega Pass SVG (pass(large,{decorative})), theme palettes scoped to .rank-badge.pass-badge; dedicated .mono-pass-card with five M.PASS-sourced benefits, price/renewal/CTA/retention; only p.id==='remove_ads' is excluded in adMode 'off' (both pageMarkup and review); shop section retitled 'Crowns, Mega Pass & Remove Ads'. |
| 9013032 | APP-008 | B0 readable type scale across styles/community/party/monetization CSS (body 1rem/1.5, support ≥14px, metadata floor 12px, buttons 1rem), applied as end-of-file overrides with matching :root[data-theme] specificity so all four themes are covered; no zoom suppression. |
| 01e1e42 | APP-015 | Local room setup: player-count select (2-10) + one labelled input per player, draft survives back/grow/shrink, duel pins to 2, mixed+3 suggests League, blank-name focus + inline errors, seats joined in field order with stable actor IDs. |
| 32d70fd | APP-016, APP-017 | One 'Same Wi-Fi' entry → Host/Join page; Join keeps name/code/address inputs through scans (only the results mount updates); portable LAN store discover() now emits status and resolveJoin() accepts exact id or the host's 5-char code; Join-with-code resolves via discovery then an explicit host address; invites are portable text (no document origin, no asset URLs); reconnect record carries endpoint+code and restores lanBase; lanStart clears stale endpoints. |
| 825cb31 | APP-021 | Sponsors destination (guest+members, works for Pass/Remove Ads users): validated packaged catalog (honest empty list), optional interests on the website storage contract (save only after agreement, clearable), report-and-hide keyed by campaignId+creativeId+revision with durable ticket POST and honest failure states, fixed Advertise-with-us mailto + copy fallback; apps/api/routes/sponsors.js intake (no report-reading endpoint, no wallet/Core access). |
| 3d6bacc | APP-021 (web) | /sponsors and /ads gain the same Advertise-with-us panel with the fixed template. |
| bd7e364 | APP-022 | Fresh native installs default to After Hours; saved/migrated themes always win; browser and website defaults unchanged; native bundler stamps afterhours on the generated html to avoid the light first-paint flash. |
| c7f08b0 | APP-020 | Programmatic 4-theme token-pair contrast audit (script: .artifacts/contrast-check.cjs): exactly one failure — Vector's explicit :root[data-theme=vector] block muted #747b84 (4.28/4.06/3.81 on its surfaces) — fixed to #616a74 (~5.5/5.2/4.9). All 32 pairs now ≥4.5:1, including After Hours' yellow primary (13.39:1). No CTA color was removed. |
| fe6a923 | (defect fixes) | Restored the Sponsors home card (lost when a combined patch was rejected) and fixed a sponsors render hot-loop (catalog fetch now started once per page mount). |

## Verification evidence (local, this machine)

- Parse: node --check src/{app,community,monetization-ui,monetization-ui,sponsors-ui,icons,party-ui,public-links}.js, src/lan/lan-room-store.js, apps/api/routes/sponsors.js — all pass; bundle.config.json + catalog.json JSON valid.
- Parse gate: 34/34 client scripts compile via vm.Script.
- Test suites: static-ui + monetization-policy + monetization-ui-contract + v51-lan-room-store + v52-pass-benefits → 47 pass / 0 fail. legal-pages: the two service tests pass; the updated assertions verified inline (public-links literals + app publicLink call sites). community/tournament/party suites were started but stalled under Main-agent CI CPU contention on this machine; visible community assertions all passed and no failures were observed — **LR02 final CI re-verification stays LAST per the standing order and covers the complete suite.**
- Browser smoke (Playwright Chromium against the exact review bundle, API routes blocked for determinism): mode-list node stable across mode switches, setup mount present, utility order [Daily quest, Store, Save your progress, Sponsors], identity screen opens from Home, sponsors page + honest empty state + enquiry panel, pass card + crown SVG, guest balance has no fake amount, no appended store entries, Accessibility group present, 4 canonical legal links, no 'upset' jargon, 4 named rank sections, **zero page errors**.
- Contrast audit: ALL-PAIRS-PASS after the Vector muted fix.
- LAN store tests: code join + reconnect snapshot green.

## Artifacts

- Review bundle: .artifacts/app-ui-annotations-review — **bundle_hash 4a22cff184ad9a48d0c4cb08a5b5f69975d268a77ec2af0fd412754efa7864d6**, built from the post-fe6a923 tree; served for owner review at http://127.0.0.1:4198/bundle-index.html (the owner's 4197 annotation session was untouched).
- Android: assembleOnlineDebug rebuilt via Gradle 8.13 (homebrew gradle 9.8 is incompatible with the AGP version) — **the embedded bundle hash matches 4a22cff1… exactly**. Installed with adb install -r -d onto the OnePlus Nord CE (5199676e), replacing the previous install with data preserved; app launches, topResumedActivity confirmed, zero FATAL/crash lines in logcat.
- iOS: xcodebuild Debug build (scheme MegaXO, iPhone 16 Pro destination) with PRODUCT_BUNDLE_IDENTIFIER=online.megaxo.prototype to match the valid team profile (D5TQJ76T44, expires 2026-10-21); signed deepest-first per the lr23 recipe (MegaXO.debug.dylib, __preview.dylib, frameworks, then the app, with the profile's exact entitlements — a signature without them or with the wrong bundle id is rejected at install); installed and **launched via devicectl, process verified alive (pid 23411), no crash**.
- Note: the repo's committed bundle id is online.megaxo.xoxo; the device install used a build-time override to online.megaxo.prototype because the only valid profile (expires 2026-10-21) authorizes the prototype id. Main should either renew a profile for online.megaxo.xoxo or make the prototype id canonical for device builds before the profile lapses.

## Deliberately NOT done here (handoffs)

- Native async LAN bridge contract (MegaLanSocket/Discovery promise API), endpoint authorization hardening and permission UX remain the C5 native handoff; the JS layer is transport-ready and the device Wi-Fi join path now has working code-join + fallback inputs, but **cross-phone LAN hosting/joining was NOT re-verified this run** (needs both phones on one Wi-Fi with the host app foreground).
- The durable sponsor-report table/service is not mounted; POST /api/sponsors/report answers 503 until Main mounts context.sponsors.storeReport() — the client already degrades honestly (local hide + retry with stable reportId).
- Native mailto delegate (the enquiry opens a mailto anchor; WebView may need the narrow external-navigation allowance Main owns).
- Mega Pass native purchaseable product/bridge verification (unchanged from the prior receipt — no purchasable native subscription is advertised as live).
- Full device matrix (audio audibility, text enlargement, theme switches, report flow on device) — the phones are installed and launching; interactive owner acceptance is next.
- **LR02 final CI re-verification is LAST**, after Main's current CI run finishes; this receipt's local results are a subset, not a replacement.

