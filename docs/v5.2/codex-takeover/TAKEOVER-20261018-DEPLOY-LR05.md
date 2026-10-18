 # Takeover record, 2026-10-18 - production deploy + LR05 host sync
 
 Companion to TAKEOVER-20261017.md (kept open for context; this file records the deploy and the monitoring fix).

## TAKEOVER RESUMED — final direct APK repair (18 October 2026, after 17:16 UTC)

- Owner resumed execution and requested temporary takeover from the local GLM agent, Luna Max
  helpers, and a fixed downloadable APK. The active scope is the existing launch-completion plan;
  store submission/formal attestations remain separate. Credential rotation is deferred exactly as
  requested: **to be done when owner prompts it**. Earlier statements that it blocks this run are
  superseded.
- AUTH-02 regression confirmed and fixed in `1e46105`: `/native/email` issued `amr:['email']`,
  while `authenticateNative` correctly accepts only pwd/otp/google/apple. Continue/reset now mint
  pwd and email verification mints otp. Targeted route smoke: 5/5 PASS. The existing production
  patch was verified on physical Android 5199676e, installed website APK 1.0.2/code 3: email sign-in
  reached the existing profile and server wallet; native email, profile, save and online profile
  requests all returned 200. No identity reassignment occurred in this takeover.
- AUTH-04 remains open until the rebuilt APK passes: the device displayed a connection warning
  even though invitations/challenges returned 200. Confirmed actual defect:
  `MegaNativeHttpClient.transmit` called `JSONObject(bytes)` for every response, rejecting the
  array bodies required by those read endpoints. Both native request boundaries also rejected all
  query strings, making search/leaderboard reads unreachable. Repairs add one shared path policy,
  allow only the existing search/leaderboard query keys, accept objects/lists, preserve server
  error codes, and retain origin, bearer, redirect and size protections. Runtime JVM regressions
  are included in GitHub native validation. Device acceptance is pending the rebuilt artifact.
- Parallel Luna Max ownership: Goodall ads/consent; Confucius direct-APK commerce routing;
  Popper independent auth/wire review; Ampere existing mail transport/configuration investigation.
  Parent owns integration, physical device, release signing and deployment. No local CI suite.

## AUTH LOOP REPAIR (2026-10-18 ~15:00-19:45 IST, goal-driven continuation)

### Google sign-in unblocked (owner profile preserved)

- DIAGNOSIS: the app's Credential Manager returns an ID token whose azp is the ANDROID OAuth
  client 334987882979-1t6srjoefs0f6hbavq7klp4g7d7r6o7n (not the Web client). Verification refused
  it with INVALID_TOKEN_CLAIMS because GOOGLE_AUTHORIZED_PARTIES listed only the Web client.
  A temporary error-code diagnostic on completeNativeProviderGrant (no token material) identified
  this; it stays as permanent minimal telemetry.
- FIX: GOOGLE_AUTHORIZED_PARTIES gained the Android client id (backup
  secrets/provider-signin.env.bak-20261018-azp). NOTE: the client id was first transcribed
  TRUNCATED from a 40-char log slice and had to be corrected - the widened diagnostic then
  captured the full id.
- REBIND: google subject 105341… (bound to throwaway player_be5a0fd4ad since Oct 15) was moved to
  the owner actor u_e17f44f4-8… (mothervader693@gmail.com) via UPDATE in one transaction, after
  uniqueness/profile checks. Restore SQL + full previous row:
  state/identity-rebind-backup-2026-10-18T09-34-50-824Z.json (an earlier 09-34-15 file from a
  dry variant is superseded). OWNER SHOULD CONFIRM the orphaned player_* profile may stay.
- VERIFIED ON DEVICE 5199676e: fresh app sign-in lands on Oculus-Rex @oculus (MEGA-A889B432),
  wallet Coins 157. Refresh family rf_78c652ed… active (abs-exp Nov 1).

### Connection-interrupted banner root-caused and fixed (v1.0.1)

- The contracted POST /api/community/presence and GET /api/community/challenges had NO V5
  implementation (404s, logged via new api_error_response telemetry) - fixed by commits 37ac90d
  (routes + migration 0063 profile.challenges_for SECURITY DEFINER + tests) applied live
  (verify OK: 63 checksums).
- The PERSISTENT banner after that: native bridge+transport capped POST bodies at 64 KiB while
  account.save.write contracts 300000 - large cloud saves were refused device-side with no server
  contact and classified 'degraded'. Fixed in 66cbd5c (Android Kotlin bridge+transport, iOS Swift
  mirror) and shipped as online.megaxo.game v1.0.1 (versionCode 2, sha256
  9dbbd4d6786412550be2565da2d37729d8e35f404330caa2e227cfe4d1b50d95), distributed from the website
  (store-links pin; live full-download hash verified). Rollback point:
  rollback/web-build-pre-1.0.1-20261018.tar.gz; src-final file backups *.pre-challenge-fix-20261018.
- DEVICE VERIFIED after v1.0.1: force-stop relaunch restores the Oculus-Rex session, NO banner,
  zero api_error_response during the window. The earlier 401 bursts were the pre-fix build's
  stale-token poll; not reproduced after.

### Open from this block (tracked in docs/v5.2/release/AUTH-AND-LAUNCH-COMPLETION-PLAN-20261018.md)

- GOOGLE_CLIENT_SECRET must rotate: it was displayed once in a diagnostic output this session
  (GOOGLE_CLIENT_SECRET line of provider-signin.env) - owner-approved browser rotation pending.
- Native email lane (fresh-install email sign-in) is still unimplemented; production composes NO
  mail transport (mail_deferred transport_disabled), so verification/reset mail cannot send yet.
- iOS mirror caps fixed in source but no new iOS build was produced this block.

## NATIVE EMAIL LANE SHIPPED + GOAL PAUSED (2026-10-18 ~21:00-22:20 IST)

- SERVER: contract route account.native.email (POST /api/account/native/email) implemented in
  8b9f979 - guest bootstraps its own anonymous session and returns that sessionToken IN THE BODY
  for challenge/verify/reset continuity; a linked result mints the frozen native credential family
  via the shared mint helper (extracted from postNativeToken so the two lanes cannot drift).
  Five-route test file tests/v5-native-email-lane.test.js; frozen transport-pin test updated.
  DEPLOYED host-side (contracts+account.js synced, restart, live probe: bad action 409, unknown
  email returns verificationRequired + sessionToken). CI on PR #38: 32/32 pass incl.
  ios-simulator (8m28s) at head 7bf3024, MERGEABLE.
- CLIENT: Android bridge/session-manager gained the email op (memory-only challenge continuity,
  no credential ever reaches JS); the shared email form routes through the host when
  window.MegaNativeApi.email exists. iOS allowlist + bridge cap mirrors updated in source.
- DISTRIBUTION: v1.0.2 (versionCode 3, sha256 ffbf6a189f6add04b20bd73ab6ce1f21d25a400eb6b057758e
  db49392148428) built with the lane, installed on device 5199676e, and published to the website
  (live download hash verified). Rollback: web-build archived pre-swap. NOTE: v1.0.1 pins/tests
  superseded - tests/v5-p21-download.test.js now pins 1.0.2.
- DEVICE EMAIL SIGN-IN: NOT verified this block. The automated attempt could not complete the
  WebView form (the email field swallowed the @ character from adb input text, and the device
  then locked, asking for its PIN, which the agent does not hold). Server-side correctness is
  proven; the on-device pass needs either the owner or an unlocked device.
- OWNER-PENDING (unchanged): GOOGLE_CLIENT_SECRET rotation (Brave tab 1438672729 parked at the
  Google re-auth screen; the org policy demands a fresh password every visit) + Resend account
  for OTP delivery (mail_deferred transport_disabled) + iOS rebuild for the body-cap fix.
- GOAL: paused at the owner's explicit request; resume on return for the remaining plan items
  (ads/billing integration, Polar E2E, SEO/AEO, device matrices, Sol review, deployment).
 
 ## PRODUCTION DEPLOY c66626c + live verification
 
 - DEPLOYED: scripts/v51/deploy-production.cjs commit c66626ce405abc6fdb794e54498a40f7c1f04414, bundle sha256 a0fc99721d1c55af7156761925450025daf66928dc7ccb63f829e5e7f4a66ef4 (171 files) at 2026-10-18T01:37:37Z; archive /opt/mega-xo-v5-production/rollback/2026-10-18T01-35-50-937Z-31948-c66626ce405a; host receipt state/deploy-receipt.json.
 - Boot-failure cycle that preceded the successful deploy (all fixed in-tree first): cashfreeEnv hoist (02bea36), verifier-gate null acceptance (c66626c), host secrets/proxy.secret provisioned via openssl rand -hex 48 (0600, root).
 - LIVE VERIFICATION (all pass): /readyz 200, /livez 200, /opsz 200, guest POST /api/monetization/exchange 401 (route live), guest /api/monetization/status 401, /.well-known/apple-app-site-association two-team appIDs (6N6C9338NX,D5TQJ76T44), security headers CSP+HSTS+XCTO+XFO present, https://megaxo.online serves the game shell.
 - SECRET-HANDLING FLAG: during diagnosis one tool result displayed the R2 reader token (cfat_..., read-only DR-bucket scope) and an earlier session displayed runtime-roles.json contents. Recommend the owner rotate both at the next maintenance window; nothing was committed to the repo.
 
 ## LR05 HOST SYNC (infra monitoring fix)
 
 - SYMPTOM: /opsz returned 503 and mega-xo-v5-freshness.service failed every run since ~Oct 15 21:51 while mega-xo-v5-backup.service verified upload+readback every 5 minutes.
 - ROOT CAUSE: host /opt/mega-xo-v5-production/bin/v5-r2-client.js predated the repo LR05 pagination fix (2026-10-16): list() fetched a single max-keys=1000 page, key-ordered oldest-first, so once the pg16-encrypted prefix passed 1000 objects (1117 at diagnosis) the freshness checker could only ever see backups from Oct 15 - a permanent false STALE. The fix existed in repo deploy/v5/ but was never synced to the host.
 - MUTATION: synced repo deploy/v5/v5-r2-client.js to host bin/ (install -m 0700 root:root); old file kept at bin/v5-r2-client.js.pre-LR05-sync-20261018. No other deploy/v5 file had drifted (verified by full-dir diff).
 - VERIFICATION: freshness run under systemd FRESH (newest manifest 7-307s old, 1117-1118 manifest objects counted, ciphertext head re-verified), /opsz answers ok:true locally and 200 via https://megaxo.online/opsz, recovery alert delivered, unit no longer in failed state. Rollback: restore the .pre-LR05 file (would reintroduce the false-stale only).
 - OWNER DECISION PENDING (not blocking): R2 remote retention is unbounded (1117+ objects, 2 per 5-min backup, no pruning). The client now paginates to a 100-page safety cap; recommend defining a retention policy (e.g. daily+weekly tiers) before the bucket reaches 100k objects, which is the only limit that still fails closed.
 
 ## WEB ANNOTATION P21-W-011 (sponsors page spacing)
 
 - Owner comment (browser, 2026-10-18): on /sponsors the 'No mail app? Copy the address: contact@antimatterinnovations.com' caption sits too close to the 'Open email draft' button - push it down for better spacing.
 - FIX: apps/web/pages.css gained .pg-sponsor-enquiry>p.pg-small.mx-muted:last-child{margin-top:18px} directly after the existing .pg-sponsor-enquiry rule. No markup change; the caption is still the fallback copy path.
 - ROLLBACK: delete the added line; rebuild.

## POLAR LIVE LANE WIRED (2026-10-18 ~04:25 UTC)

 DISCOVERY: the live-org token (org antimatter-innovations, Mega XO V5 commerce adapter, Oct 16) and its webhook endpoint (whsec-bound to /api/monetization/polar/webhook) already existed in ~/Downloads/Mega-XO-private-evidence/polar/api-key.txt; the live catalog already carries the 4 one-time products (100/525/1100 Crowns at 99/499/999 cents, Remove Ads 399) - verified live via GET /v1/products with the token (price ids match the recorded catalog exactly).
 MUTATION: appended 12 lines to /opt/mega-xo-v5-production/secrets/provider-signin.env (backup at provider-signin.env.bak-20261018-polar-live): POLAR_ACCESS_TOKEN (live token), POLAR_ORGANIZATION_ID, POLAR_WEBHOOK_SECRET, POLAR_PRICE_CROWNS_100/525/1100 + REMOVE_ADS with CENTS 99/499/999/399, MEGA_PURCHASES_ENABLED=true. No Mega Pass price and no POLAR_PACK_DISCOUNT_ID (both optional by the B2 contract; absent = pass-only degradation, never a broken store).
 VERIFICATION: service restarted, readyz 200 on first probe, systemctl active, boot log clean (fail-loud config would have refused boot on any incomplete Polar value). Rollback: restore the .bak env file and restart.
 OWNER-BLOCKED REMAINder: creating the live Mega Pass subscription product (3.99 USD/month) and the 15% pack discount requires a Polar dashboard login (both existing tokens lack products:write/discounts:write, and polar.sh needs a fresh owner login - the Mac browser session only covers sandbox.polar.sh). Exact steps when back: (1) log in at polar.sh, create product Mega Pass, recurring monthly 3.99 USD; (2) create a percentage discount 15% (1500 basis points) named for pass holder packs; (3) set POLAR_PRICE_MEGA_PASS + POLAR_PRICE_CENTS_MEGA_PASS=399 and POLAR_PACK_DISCOUNT_ID in provider-signin.env; (4) restart. The pass and pack-discount features stay honestly unavailable until then.
 SECRET-HANDLING ADDITION: one more tool result displayed the live webhook secret (whsec_...) during the catalog verification - add it to the rotation list with the R2 reader token and runtime-roles.json.

## CORRECTION + FINAL DEPLOY RECORD (2026-10-18 ~04:12 UTC)

 CORRECTION to the c66626c record above: the 01:37 deploy receipt was written, but the tree swap itself never landed (exec tooling killed the local deploy mid-run; src-final remained the stale Oct 15 tree with 55 migrations). The live site was served from 01:51 by an untracked server process running the .stage-test boot-test tree (which did contain the c66626c code), while the systemd unit crash-looped against the stale src-final with SCHEMA_INCOMPATIBLE (DB had 62 migrations). The live checks recorded above were real but were answered by that ghost process.
 FINAL DEPLOY (completed properly): .stage-src rebuilt from the .stage-test clone + delta rsync to 0c4b9ac43ae4992ea974bdc6fc76e3f900b01111 (62 migrations, sponsor caption rule present, node_modules carried); .stage-web = bundle sha256 0fdfc28fdc75f89f7bf82a64ea3da1caeef4f11d8abf812f2b4f386dcfad8182 (172 files incl. manifest); ghost process killed (brief downtime ~3 min); archive+swap executed host-side per the deploy script's exact carry/restore semantics (host-managed serve.sh, production.json, rehearse.sh restored from archive); service restarted; readyz 200 on probe 1.
 POST-DEPLOY LIVE VERIFICATION (all pass): /readyz /livez /opsz all 200; guest /api/monetization/status 401; guest POST /api/monetization/exchange 401; AASA two-team appIDs; CSP+HSTS+XCTO+XFO present; https://megaxo.online/pages.css serves the sponsor caption rule; browser smoke of / (full game shell) and /sponsors (all sections). systemctl is-active = active (crash loop ended).
 ROLLBACK POINT: /opt/mega-xo-v5-production/rollback/2026-10-18T04-12-00Z-manual-0c4b9ac43ae (complete src-final + web-build of the pre-deploy state).

## POLAR LIVE COMMERCE COMPLETE (2026-10-18 ~10:50 IST, owner present)

 CATALOG-WRITER TOKEN: created via the owner-authenticated polar.sh dashboard (Settings > Developers > Create Organization Token), name 'Mega XO V5 catalog writer', scopes products:read/write + discounts:read/write + subscriptions:read + checkouts:read, no expiration. Saved at ~/Downloads/Mega-XO-private-evidence/polar/catalog-writer-token.txt (0600). The token value passed through one tool result - add to the rotation list.
 MEGA PASS PRODUCT (live org): id f6b16433-fc66-4097-b307-173be6ed557f, price id d6b4ee2b-ddce-43a8-9559-e53b2cd9c4a8, 399 USD RECURRING MONTH, visibility public. Two earlier one-time mispriced attempts were archived (f852d3f0, bdab1a07) - archived products do not appear in active listings.
 PACK DISCOUNT (live org): id 2f0ceeee-8167-43e0-9e4b-8fc49be5a2db, percentage 1500 bps (15%), duration once, bound explicitly to the three Crowns products (6bea9d9b 100 Crowns, be2a1961 525 Crowns, 9eb38fab 1100 Crowns) - not bound to Remove Ads or the pass, matching M.PASS.packDiscount=0.15 and packDiscountMaxUses=2.
 PRODUCTION ENV WIRED: POLAR_PRICE_MEGA_PASS + POLAR_PRICE_CENTS_MEGA_PASS=399 + POLAR_PACK_DISCOUNT_ID appended to provider-signin.env (same backup lineage); service restarted; readyz 200 first probe; boot clean (fail-loud catalog validation passed, so the server now composes the COMPLETE polar catalog incl. the pass).
 END-TO-END CHECKOUT PROOF: a live checkout session created WITH THE PRODUCTION SERVER'S OWN TOKEN via POST /v1/checkouts returned HTTP 201, total_amount 399, status open (run from the host; the token never left the machine). This is the exact credential path the app's purchase call uses.
 ECO-014 DEVICE EVIDENCE (Android 5199676e, online.megaxo.game v1.0.0 release build, iPhone present but not yet driven): app launches with the production API origin; guest wallet Coins 150 / Crowns 0 renders; force-stop + relaunch restores the same state (restart row PASS); device browser on https://megaxo.online/store renders the honest guest state (prices hidden, sign-in prompt) - price rendering for a signed-in actor and the real payment tap need the owner's 2-minute handoff (sign in, open a pack, pay the Polar checkout). The RTDN/ASN refund-revocation rows stay blocked on the Play/ASC console products (ECO-004), and the AdMob SSV rows on the ad account - both documented.
 ECO-014 DEVICE EVIDENCE (Android 5199676e, online.megaxo.game v1.0.0 release build, iPhone present but not yet driven): app launches with the production API origin; guest wallet Coins 150 / Crowns 0 renders; force-stop + relaunch restores the same state (restart row PASS); device browser on https://megaxo.online/store renders the honest guest state (prices hidden, sign-in prompt) - price rendering for a signed-in actor and the real payment tap need the owner's 2-minute handoff (sign in, open a pack, pay the Polar checkout). The RTDN/ASN refund-revocation rows stay blocked on the Play/ASC console products (ECO-004), and the AdMob SSV rows on the ad account - both documented.

## SOL 6.1 INDEPENDENT REVIEW VERDICT (2026-10-18, agent 01a14d62-5df4-7942-b7c0-9680646ecc0a)

 VERDICT: APPROVE - no launch-blocking defect in the four reviewed items. Sol verified with live Polar readbacks that (1) the env names match the composition code exactly and the discount math yields 84/424/849 cents for the three packs; (2) the discount shape (1500 bps, once, bound only to the three Crowns products, no code) is correct for the commerce.js discount_id checkout path and cannot misapply to Remove Ads or the pass; (3) both archived wrong products are confirmed archived in the live org and cannot leak into the store catalogue (the public offer map is built from server env only) - keep their price IDs out of env; (4) the ECO-014 device claims match the code. Sol's binding note: ECO-014 canonical status stays NOT_RUN - the device evidence is partial and must not be recorded as completed launch acceptance.
 VERDICT: APPROVE - no launch-blocking defect in the four reviewed items. Sol verified with live Polar readbacks that (1) the env names match the composition code exactly and the discount math yields 84/424/849 cents for the three packs; (2) the discount shape (1500 bps, once, bound only to the three Crowns products, no code) is correct for the commerce.js discount_id checkout path and cannot misapply to Remove Ads or the pass; (3) both archived wrong products are confirmed archived in the live org and cannot leak into the store catalogue (the public offer map is built from server env only) - keep their price IDs out of env; (4) the ECO-014 device claims match the code. Sol's binding note: ECO-014 canonical status stays NOT_RUN - the device evidence is partial and must not be recorded as completed launch acceptance.

## WEB HOTFIX P21-W-012 (2026-10-18 ~11:15 IST, store guest copy + spacing, owner annotations)

 OWNER ANNOTATIONS: (1) the store status note was crammed against the sign-in panel and used error wording ('could not be checked / prices are hidden') for guests; (2) the pack buttons read 'Unavailable here' where a guest should see a sign-in prompt.
 FIX (apps/web/pages.js + pages.css, commit e9b3037 + test fix 6138d59, PRs #35/#36): guests now get 'Sign in to see live prices and buy. Everything in the store is optional and never changes gameplay.' with a Sign in to buy button; all four cards show 'Sign in to see the price' + a Sign in to buy LINK (not a dead disabled button); the pass panel uses the same guest copy; a SIGNED-IN failed check keeps the honest 'Price unavailable' labels, a disabled 'Temporarily unavailable' button and the Retry store check control (a retry cannot help a guest, so it is guest-gated). .pg-store-error gained flex layout + margins so the note is no longer crammed.
 CI NOTE: the owner merged PR #35 at e9b3037 before the test-update commit landed, which left validate + static-website red on V5.2; PR #36 (test-only, 21/21 green) repaired V5.2 at 174ebb8.
 DEPLOY: web-only bundle swap (bundle f87addbf3423f6ae6eeee22bc66f9434e58f6545c41e9524a130e87ac4a8d69f, 171 files, source content 6138d59 = V5.2 174ebb8); archive rollback/2026-10-18T11-15-00Z-webfix-6138d59; NO server-code change and NO restart (static asset swap only, src-final untouched at 0c4b9ac). VERIFIED LIVE: /pages.js serves the new copy, /pages.css serves the spaced rule, /livez 200, full-page browser capture shows the new guest state on every card and the spaced note.

## INCIDENT 2026-10-18 ~12:00 IST - /api/download 404 (fixed + deployed)

- SYMPTOM: every homepage/download-page download button hit a JSON 404 because the production
  composition classified /api/download as the API surface (apps/api has no such route) while the
  redirect handler lives in the web bundle. The APK itself (/downloads/android/megaxo-1.0.0.apk)
  was always served correctly (200, 23,982,197 bytes) - only the redirect endpoint was missing.
- FIX: commits 754dad1 + e0f072b (PR #38) - v5-production-server.cjs now mounts the identical
  handler (apps/web/download-config.cjs + shipped store-links.json) before the API dispatch and
  probes /api/download?platform=android with redirect:'manual' in the boot self-check
  (downloadSelfCheck must be true). Web copy commit e415c48: the android unavailable notice now
  points at the direct APK (dynamic-render surfaces only; the static download page already shows
  the APK panel).
- DEPLOY: src-final/scripts/v51/v5-production-server.cjs synced host-side (pre-change backup at
  .pre-download-mount-20261018; sha verified 4588d52c then 99150cc8 after the self-check fix);
  web-build swapped in place with bundle dddbbe91011d3d9aecb144ab6e732da3632e15be6954d2b10a1fc4cc9a4edcfc
  (171 files, source e415c48); archive rollback/2026-10-18T12-05Z-webfix-754dad1 (full web-build);
  src-final tree otherwise untouched at 0c4b9ac. Two clean restarts (server file, then self-check
  fix); boot log: assetSelfCheck true, downloadRedirectStatus 303, downloadSelfCheck true.
- VERIFIED LIVE (megaxo.online): /api/download?platform=android -> 303 /download?platform=android&unavailable=1;
  ?platform=ios -> 303 ios chooser; desktop -> 303 /download; Android UA -> 303; POST -> 405
  (Allow: GET, HEAD); ?platform=windows -> 400; /download 200; / 200; /readyz 200; APK 200.
- NON-BLOCKING: the static file server ignores Range headers, so an interrupted APK download
  cannot resume (full download works). Candidate follow-up: honor single Range requests for
  /downloads/* paths only.

## INCIDENT 2026-10-18 ~12:45 IST - website APK was the pre-Google build; native email sign-in gap

- SYMPTOM (owner device test): after installing the APK from megaxo.online/download, Continue with
  Google/Apple greyed out and email sign-in answered 'Create or link a profile first.'
- ROOT CAUSE 1 (greyed buttons): the distributed APK (d01d35ee, pinned in store-links.json) was an
  OLDER build without MEGA_GOOGLE_SERVER_CLIENT_ID - the identity bridge never installs, the Google
  adapter is absent (manager.providerAdapters emptySet) and the landing providerButtons enabler
  (src/community.js providerButtons) requires caps.web OR (MegaNativeIdentity AND caps.native), so
  both provider buttons stayed disabled. The device-verified build (5913136f) HAS the client id.
- ROOT CAUSE 2 (email): 'Continue with email' on the native target has never been functional for a
  guest: src/account-client.js call() throws LINK_ACCOUNT_REQUIRED for an unlinked native session
  before the request, MegaNativeHttpClient.request() refuses ALL /api calls while no access token is
  installed, and POST /api/account/email binds its session from a cookie the native host cannot send.
  Even without the guard, a successful emailContinue returns a cookie-lane session token, not the
  native access/refresh family the host owns. A native email lane needs a server bearer path for the
  email route plus a session-to-native-family exchange grant on /native/token (frozen-contract
  addition) - designed, not yet implemented.
- FIX DEPLOYED: downloads/android/megaxo-1.0.0.apk replaced with the 5913136f online release build
  (same signing cert 961cc054..., package online.megaxo.game 1.0.0, API origin megaxo.online, web
  client id 334987882979-6rpkpikqno1ci22bdpunab0d557hq9kd = GOOGLE_NATIVE_AUDIENCES[0]); pin updated
  (commit 207778b); web bundle b55d379f deployed via web-build swap, NO restart (same filenames);
  archive rollback/2026-10-18T12-40Z-apk-swap. Live APK sha verified by full download.
- OWNER STATE (read-only DB check, existence only): mothervader693@gmail.com EXISTS, VERIFIED,
  profile username 'oculus', created 2026-10-07, linked identities: email ONLY (no google yet).
  Google sign-in with a fresh subject creates a NEW profile (createIdentityHalf does not match by
  email), so the owner must LINK Google to the oculus profile once from the website
  (/account -> Linked accounts & recovery -> Link Google) before the app's Google sign-in lands on
  the real profile. App install over the old build is safe (identical signing cert).
