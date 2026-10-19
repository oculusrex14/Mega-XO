# Mega XOXO — sign-in repair and launch completion plan

Prepared 18 October 2026 in response to the owner's request for planning only. This document does not authorize a new account mutation, deployment, ad request, purchase, or store submission. Existing standing authorization remains subject to its original gates. No application or production change was made while preparing this plan.

## 1. What is actually known

| Area | Evidence available | What it does not establish |
| --- | --- | --- |
| Android Google sign-in | The preceding physical-device test reached the owner's existing profile and wallet after an OAuth authorized-party configuration correction and a backed-up identity reassignment. | Reliable refresh, restart, reinstall, another account, and all online services have not passed a complete acceptance run. |
| Native email sign-in | `src/account-client.js:call` requires a linked native bearer; `MegaNativeHttpClient.kt` only admits four pre-auth native routes. The email route uses the browser session path. | The visible email form is not a working fresh-install native authentication flow. Removing the guard alone would not fix it. |
| Online status | The preceding device test displayed both a linked profile and a connection warning. Public `/readyz` and `/opsz` returned 200 during this planning pass; `/opsz` reported `ok:true`. | A healthy public probe does not prove authenticated HTTP, realtime, matchmaking, or cross-device continuity. The warning remains unresolved. |
| Downloads | `/download` returned 200; `/api/download?platform=android` returned 303 to `/download?platform=android&unavailable=1`. Earlier evidence verified replacement of the stale APK. | The chooser's `unavailable=1` wording is still confusing when a direct APK is available. Online functionality needs exact-artifact acceptance. |
| Source and integration | Local lane `takeover/main-lane` is `db4ad756265e5936572f547f7ab4126aebf6dbb0`. PR #38 is open with 24 successful checks. GitHub reports `V5.2` at `196f43cadb2b686a346e47336613af55318b8358`. | PR checks do not cover the later host-only authentication edits. Production currently has several recorded source/asset/configuration changes rather than one reconciled release manifest. |
| SEO foundation | Public titles, canonical URLs and JSON-LD are present on the home, download, guide and FAQ pages. `/sitemap.xml` returns XML with 21 URLs; `/robots.txt` returns the expected text. Meaningful page content exists in the initial HTML. | Search Console ownership, index coverage, rankings, current field performance and AI-search inclusion were not checked. |
| Ad declarations | `/app-ads.txt` returns 200, text/plain, with a Google DIRECT seller declaration. `/ads.txt` returns 404. | The app seller file does not establish AdSense approval or website ad delivery. Absence of `ads.txt` is an advertising setup task, not by itself a website outage. |
| Ads and commerce | Android and iOS hosts mount `MegaAds` in configured builds. Billing adapter classes exist, but the hosts do not mount `MegaBilling`. The takeover ledger records live Polar product and discount setup. | Neither mounted ads code nor a created checkout establishes completed fulfillment, real ad serving, or store approval. Native billing has actual integration work remaining. |
| Audit records | A feature inventory, interaction inventories, dependency graph, findings register and release reports exist. | Some reports still describe older defects as current, while later summaries claim all remaining work is external. The observed email defect contradicts that claim. |

The current verdict is: production is online, but full release certification remains open. Do not assign a completion percentage from historical checklist counts.

## 2. Immediate issue: finish authentication and online recovery

### AUTH-01 — make the Google correction reproducible

1. Verify the complete Android OAuth client against the selected package and release signing certificate in Google Cloud. Check the upload/app-signing variants separately before a Play release.
2. Keep exact issuer, signature, audience, authorized-party, nonce, expiry and one-use state checks. A client identifier observed in a token is not sufficient ownership evidence by itself.
3. Remove the incomplete identifier introduced during diagnosis. Replace temporary host diagnostics with a minimal, reviewed error-code/support-ID facility that excludes tokens and personal claims.
4. Reconcile host-only changes into source-controlled deployment/configuration instructions. Preserve the backed-up identity change in a private operational record; confirm the original profile's account ownership and resulting old test-profile state. Do not generalize direct database identity moves into an account-linking feature.
5. Test sign-in, cancellation, wrong-account selection, logout, process restart, refresh expiry and reinstall of the published APK. Verify the same actor/profile and server wallet after restoration.

Exit: Google works on the exact downloadable artifact, restores reliably, and unrecognized clients/tokens still fail. No manual database intervention is needed for normal new users.

### AUTH-02 — implement a real native email lane

1. Define a narrow cookie-free email authentication contract for Android and iOS. Use short-lived server-bound authentication challenges before a user has an authenticated bearer.
2. Implement existing-account email/password sign-in, new-account email verification, forgotten-password and reset completion against the PostgreSQL identity authority.
3. On success, issue the same native access/refresh session family used by provider sign-in. The host vault owns credentials; the game UI receives only a safe state projection.
4. Extend only the necessary native pre-auth allowlist and bridge operations. Keep browser cookie/CSRF behavior and authenticated game APIs intact.
5. Verify production mail transport and the worker outbox. Earlier logs reported `mail_deferred: transport_disabled`; registration and recovery cannot be called working until a real message arrives.
6. Add adversarial coverage for incorrect passwords/codes, expiry, replay, enumeration resistance, rate limits, account binding, refresh revocation and cross-account state isolation.

Exit: a fresh installed APK can sign into the existing email profile, create and verify a test profile, recover access, restart and restore the same identity. Repeat on iOS.

### AUTH-03 — complete account choice, linking and recovery

1. Port the existing verified-provider-email choice design from legacy SQLite into the authoritative PostgreSQL account service, contracts and dispatchers.
2. Ask the user to link the existing profile or create a separate profile; require password or existing-account reauthentication for linking. Never merge accounts merely because an email string matches.
3. Bind the decision to its session/provider/state; expire and consume it once. Cover two concurrent decisions, repeated callbacks and cancelled choices.
4. Carry choice/proof completion through the native host session flow as well as the browser. Audit the website's linked-accounts/recovery entry point against the deployed build.
5. Audit replacement/deletion promises. If the UI promises a 30-day cancellation window, implement and test the corresponding cancellation flow or correct the promise through the agreed product decision before enabling it.

Exit: first sign-in, returning sign-in and explicit linking all reach the intended permanent profile without manual reassignment, accidental duplicates, or lost recovery methods.

### AUTH-04 — resolve the connection warning

1. Trace authenticated profile, wallet, friends, status and realtime calls independently using sanitized support IDs.
2. Find the failing request/state transition before changing the banner. Check token refresh, API origin, session projection, realtime tickets and WebView lifecycle.
3. Make the UI distinguish signed-out, offline, server failure and realtime reconnecting states; a profile read succeeding does not make every service healthy.
4. Exercise Wi-Fi loss/return, background/foreground, process restart and access-token expiry.

Exit: the warning clears when service recovery succeeds, returns accurately on a real failure, and online matchmaking/friend operations work after recovery.

### DIST-01 — publish one identifiable app build

Keep the selected Android package and signing lineage. Increment the actual release version/build identity, generate its manifest and checksums, verify its embedded API/OAuth/ads configuration, install it, then replace the website download only after acceptance. Keep technical checksums in engineering evidence rather than the consumer UI. Support APK Range/resume requests and use clear direct-download routing instead of a misleading unavailable notice.

Apple sign-in on Android should be hidden when the host has no supported adapter, consistent with the owner's earlier fallback direction. Retain Apple sign-in on its supported platforms. Previously accepted iOS border work requires regression verification only.

Exit: the website, installed package, source SHA and build manifest identify the same artifact; there is one intended app installation per phone. Product copy reflects only proven capability.

## 3. Advertising: three separate delivery tracks

### ADS-01 — Android and iOS AdMob

1. Reinspect the existing publisher/apps/units; reuse them rather than create duplicates. Refresh the historical review/serving status and store associations.
2. Verify the native `MegaAds` bridges, release app/unit identifiers and production SDK configuration on the actual signed builds. Source mounting and a configured release are separate checks.
3. Publish the appropriate UMP consent messages, update consent at launch, gate requests on `canRequestAds`, and expose required privacy choices. Test consent withdrawal, denied consent, applicable age settings and iOS tracking choices where needed.
4. Reconcile the approved reward mapping across UI, powers, server tickets and fixed provider reward metadata. Preserve the approved caps and counterplay rules; do not award two benefits for one completion accidentally.
5. Configure both rewarded units to the verified production endpoint `https://megaxo.online/api/monetization/admob-ssv`. Verify signatures, unit/platform/actor/ticket binding, timestamps and transaction deduplication before economic credit.
6. Use Google test units or registered test devices for engineering acceptance. Test earned, dismissed, failed, no-fill, delayed callback, duplicate callback, interrupted app and restart. Never click production ads as a test.
7. Verify automatic placements stay out of active games and honor Remove Ads/Mega Pass. Rewarded ads remain voluntary.
8. Link the correct supported public store listings and complete AdMob review; then verify actual serving eligibility and production metrics.

Concrete source fixes identified by Sol 6.1 and checked in the planning pass:

- `src/monetization-ui.js` unconditionally calls privacy options before preparing an ad. Separate ad preparation from the optional privacy form so a missing/not-required form does not prevent ad loading.
- Both `MegaAdsBridge` implementations can refuse privacy options while `canRequestAds` is false. Make required consent/privacy reconsideration reachable in that state, synchronize returned consent state with JavaScript, and verify iOS consent refresh on every startup.
- Reconcile native power-reward names with the Core ticket dispatcher, which currently accepts `credits`/`boost`. This is a code contract gap, not a missing AdMob console value.
- Verify the canonical V5 launcher enforces the approved consent/privacy release configuration; the equivalent check existing in `server/production/config.js` does not prove that the V5 composition executes it.

Exit: the exact signed app shows a test ad with correct consent, a verified completion grants the promised reward exactly once, failures grant nothing, entitlements suppress automatic ads, and live serving has provider approval.

External dependency: Google requires a supported published store listing for app-readiness review and full serving. A website-hosted APK alone does not complete AdMob readiness. Provider review/available inventory cannot be guaranteed on a fixed date.

### ADS-02 — website programmatic ads

Confirm whether a website advertising account/site is already approved. Use the provider's web integration; native AdMob units are not browser ad units. Finish site ownership, domain approval, consent/CMP, accurate privacy disclosures and the provider's exact `/ads.txt` entry. Add responsive, explicitly labelled placements with reserved space, lazy loading and honest no-fill behavior. Review CSP against the chosen provider rather than opening it broadly.

Exit: the website has an approved web-ad integration, appropriate consent, valid seller declaration, stable layout, and an observable allowed impression. No browser SDK callback mints currency without the separately approved verification contract.

### ADS-03 — direct Sponsors page

The current page renders `No active sponsor` placeholders and a prepared email enquiry. Complete the approved sponsor record/creative pipeline, image/link validation, activation/expiry, moderation and report intake. Reporting should conceal/blur the reported creative until a different approved creative replaces it. Preserve the owner-requested voluntary Sponsors entry independently of automatic ad removal.

Exit: an approved real sponsor renders correctly, a report hides the correct creative, replacement works, and the mail draft has the intended address/body. Programmatic ads still respect privacy choices, provider rules, blockers and no-fill; do not promise guaranteed 24/7 inventory or ad-blocker bypass.

## 4. Commerce and economy closure

### PAY-01 — browser/Polar

Revalidate the already configured live products, Mega Pass and two-pack discount; do not recreate them. Run the complete checkout-to-webhook-to-Core-to-wallet path in the supported test environment, then record the separately authorized production proof where needed. Cover cancellation, pending payment, duplicate delivery, refund/revocation, expiry, renewal, paid-period installment accounting, no stacking and interrupted finalization recovery.

Exit: payment and wallet/entitlements reconcile exactly once with receipts and recover after interruption. A checkout-session creation response alone is insufficient.

### PAY-02 — native stores and direct APK behavior

Mount the missing origin-restricted `MegaBilling` bridge in both native hosts. The existing Play/StoreKit catalogues contain four one-time products; add the actual monthly pass and subscription lifecycle before treating the five advertised products as available. Create/map Play and StoreKit console products and validate regional prices. Configure and verify RTDN/App Store notifications before enabling their live outbound/inbound path. Test consumables, non-consumable restore, subscription renewal, pending/cancelled purchases, refunds and app-account binding on actual devices.

Repair the two observed client/API mismatches before provider testing: `src/monetization-ui.js` sends a purchase without the `restore` argument required by commerce ingress, and its Restore action calls `/api/monetization/restore`, which is absent from the mounted route table. Define one explicit purchase/restore contract, align the client/route/ingress, and test the complete request path. Do not widen the generic command validator to conceal the missing argument.

Document the supported payment behavior of the directly downloaded Android APK separately from the Play build. Do not promise Play Billing works on every sideloaded installation or silently route native users around platform rules. The browser's Polar lane is a separate surface.

Exit: every enabled purchase path grants only verified value, restores correctly, handles revocation and reports truthful availability. Server-owned wallet and local practice/power-bank scope are unambiguous.

## 5. SEO: validate the existing foundation, then improve discovery

### SEARCH-01 — crawl/index readiness

- Verify the existing Google Search Console and Bing Webmaster properties, or configure ownership in the authorized accounts. Submit the existing canonical sitemap.
- Audit all 21 sitemap URLs, redirects, status codes, canonical aliases, HTTP/www normalization and index directives. Keep private/session/API content excluded; verify robots blocking and `noindex` behavior deliberately rather than assuming both together prove deindexing.
- Compare initial HTML, hydrated content and a rendered crawler inspection. Check unknown routes produce real 404s and that soft-error/account-loading states are not the only useful public content.
- Correct unsupported platform/version claims. Verify public guide/FAQ/download/store/about/support/privacy pages and their internal links.

Exit: intended public pages are accessible and submitted without critical indexing errors; private content remains protected. Record actual indexing separately because search-engine inclusion is external.

### SEARCH-02 — content and site identity

- Give each public page a distinct intent, title, useful description and heading. Use one consistent Mega XOXO/Antimatter Innovations identity, official origin, logos and real contact information.
- Strengthen the rules guide, beginner strategy, free browser play, offline/practice explanation and Android installation/support content. Derive rules from `src/game.js` and explain coins versus premium Crowns accurately.
- Add useful contextual links and breadcrumbs. Review social share previews, image alt text, favicon/app icons, readable mobile copy and real screenshots.
- Validate existing Organization/WebSite/WebPage/VideoGame/Breadcrumb schema against visible content. Add platform/download facts only when verified. Avoid invented ratings, download counts, prices or reviews.

Exit: public pages answer real player questions with accurate product facts and valid corresponding metadata; no duplicate doorway pages or marketing claims ahead of the product.

### SEARCH-03 — speed and measurement

Measure the current production pages before optimizing. Set targets of LCP <= 2.5 s, INP <= 200 ms and CLS <= 0.1 at the 75th percentile when field data exists. Use lab measurements initially and label them as lab evidence. Optimize hero/image sizing, fonts, critical assets, unnecessary startup work and ad layout reservation based on measured causes.

Record aggregate discovery-to-play-to-account-to-download funnels with appropriate consent and no raw credentials/player data. Establish query, impression, click, indexed-page and performance baselines; review results after real traffic accumulates.

Exit: measured page performance and stable layout, an initial reporting baseline, and no claim that a lab score guarantees ranking.

## 6. AEO: make the product easy to understand and cite

Provide concise answer-first content for: what Mega XOXO is; how Ultimate Tic-tac-toe works; where the next move goes; how wins/draws work; free/offline/browser access; account continuity; official Android installation; iOS availability; Coins/Crowns; and optional ads/pass behavior. Use the existing FAQ and guide first, then add standalone pages only where there is a distinct useful topic.

Keep those answers visible in HTML, internally linked, attributed to the real publisher and consistent with the current release. Review search-crawler access without exposing authenticated areas. Use representative search/answer queries to record whether the official page is discoverable/cited, and fix factual mismatches at their source.

`/llms.txt` currently returns 404; it is optional, not an AEO release blocker. Google says its AI search features require no special AI file or schema. Do not sell special markup, FAQ rich results, ranking or AI citations as guaranteed outcomes.

Exit: core product questions have accurate, directly accessible answers; technical eligibility is checked and observed search outcomes are recorded honestly.

## 7. Finish product, reliability and the original audit

### QA-01 — exact-build cross-platform acceptance

Exercise Android, iPhone and browser accounts against the same backend: authentication/recovery, profile/wallet/rank continuity, matchmaking, friend invitations, private matches, LAN host/join by discovery and code, tournament flows, reconnect/forfeit/timers, and account deletion/export. Use isolated test actors for economic and destructive scenarios.

Review all original annotation IDs against their implementation receipts, including guest-store wording, Mega Pass layout, sponsors spacing and all four native themes. Verify Undo, Undo Block, Tactical Hint and Hint Block names/eligibility. The owner accepted the iOS border appearance; test regression rather than redesign it.

Run native accessibility, small-screen, keyboard/screen-reader and background-resume checks. Guided tutorial comprehension and measured bot evidence stay separate from implemented UI. Keep optional Impossible/learning claims unverified until their actual acceptance evidence exists.

### OPS-01 — security and operations

Reconcile the running process/source/web/APK/configuration/migration identities. Rotate credentials that appeared in diagnostic output, including the newly exposed Google OAuth secret as well as the already recorded provider/infrastructure rotation list. Preserve service-role separation and avoid printing replacement credentials.

Verify current mail delivery, purchase-finalization workers, subscription grants, backup freshness/alerts and operational monitoring. Perform recovery, bounded load/soak and failure tests in an isolated environment. Define and rehearse backup retention before enabling destructive pruning. Never restart a stale SQLite writer after V5/PostgreSQL writes.

Exit: one reproducible release manifest, tested compatible rollback, confirmed alerts/delivery, current dependency/SBOM/security evidence and measured performance. No unexplained production source drift.

### AUDIT-01 — complete and reconcile permanent deliverables

Refresh `docs/v5.2/final-audit/MASTER-FINDINGS.csv` and the executive/verdict/release reports from current evidence. Close actual fixes with commit, CI, device and provider references; reopen source/device defects contradicted by earlier summaries. Review every original required deliverable for missing fields or untested assumptions rather than counting filenames as completion.

Regenerate feature/parity/page/control inventories and the architecture graph for the final release SHA; verify viewer and regeneration instructions. Update guardrail decisions, endpoint authorization matrix, gameplay/tutorial/bot reports, monetization, infrastructure, performance, backup-restore evidence, SBOM/advisories, artifact manifest and decision log.

Exit: every required audit deliverable reflects the same candidate and distinguishes implemented, tested, externally blocked, submitted, approved and live.

## 8. Store release and deployment

Prepare the final signed APK/AAB and iOS archive using the selected package/bundle identifiers and paid Apple team. Recheck provisioning expiry, release signing, target SDK/permissions, privacy manifests, Data Safety/App Privacy, content ratings, account deletion, screenshots, listing copy, reviewer access and store products. Perform internal-track/TestFlight acceptance before final submission.

Use small reviewed PRs into `V5.2`, GitHub Actions for the suites, and Sol 6.1 for independent review of authentication/economy/release-sensitive changes. Deployment remains conditional on the owner's standing requirement that both reviewers consider it ready. Store submission and formal account-holder attestations remain separate actions requiring their applicable approval.

Deploy one pinned candidate with its matched API, web assets and APK metadata using the repository deployment procedure. Verify public routes, authenticated flows, real devices, mail and enabled provider callbacks. Use the tested compatible rollback if critical checks fail; retain PostgreSQL authority.

Final verdict must list exact blockers per surface: website gameplay, direct APK, native purchases, mobile ads, website ads, Play submission and App Store submission. An external ad/store review can remain pending without obscuring a working website, but an enabled broken sign-in path blocks certification of the affected app.

## 9. Execution order and ownership

| Order | Main implementation owner | Parallel work | Completion gate |
| --- | --- | --- | --- |
| 1 | Codex: AUTH-01..04 and source/deployment reconciliation | Sol: independent review of native ads/billing gaps | Repeatable sign-in and recovered online services on the exact APK |
| 2 | Codex: DIST-01 and regression acceptance | SEO/Search Console/AEO content; provider console preparation | Identifiable downloadable build; no stale package/configuration |
| 3 | Codex: ADS-01 and PAY-01/02, serialized shared economy edits | Website ad/Sponsors integration and measured performance | Actual provider/device fulfillment and truthful external-review status |
| 4 | Codex: QA-01, OPS-01 and AUDIT-01 | Store listing materials and owner attestations | Complete evidence package for one candidate |
| 5 | Codex + Sol: final independent go/no-go review | Store/provider review outcomes | Exact-surface verdict, matched deployment and post-deploy acceptance |

Human input is limited to unavoidable MFA, account-holder/legal/financial declarations, real payment authorization when required, final store submission authority, and genuinely new product choices. Existing account access and prior routine setup authority should not be requested again.

## Sources reviewed

- Repository: `src/account-client.js`, `src/community.js`, `packages/services/accounts.js`, `packages/contracts/routes.js`, `apps/api/routes/account.js`, native transport/host sources, `apps/web/seo.js`, `scripts/p21/prerender-web.mjs` and existing final-audit/takeover reports.
- GitHub: PR #38 check results and the V5.2 branch ref, read during this planning pass.
- Independent read-only review: Sol 6.1, agent `01a14f2b-1ac4-72f3-9a2b-9bb5aa7c3921`; native advertising/billing findings at `db4ad75`, corroborated against the cited UI, host, route and ingress source. These are source-reviewed findings; no new runtime reproduction was performed for this plan.
- Public GETs of `megaxo.online`, guide/FAQ/download, robots/sitemap, ad seller paths and health endpoints on 18 October 2026. No authentication, purchase or ad impression was initiated.
- [Google AdMob app readiness](https://support.google.com/admob/answer/10564477?hl=en-GB).
- [Google rewarded SSV](https://developers.google.com/admob/android/ssv).
- [Google UMP Android](https://developers.google.com/admob/android/privacy) and [iOS](https://developers.google.com/admob/ios/privacy).
- [Google AdSense site status](https://support.google.com/adsense/answer/12170222?hl=en).
- [Google AI features and website guidance](https://developers.google.com/search/docs/appearance/ai-features).
- [Google Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals).
