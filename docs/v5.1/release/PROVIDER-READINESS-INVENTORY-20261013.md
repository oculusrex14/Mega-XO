# Provider / store readiness inventory (P5, R12–R14) — 2026-10-13

Read-only inventory of every provider-facing surface in the repository plus the local
signing/entitlement material that is present on this workstation. Nothing was submitted,
purchased, registered, enrolled, uploaded, or created. No provider console was opened. Only
presence — never content — of credentials, keys and profiles was checked.

Evidence snapshot: repository HEAD `28f2caa9db2c4f914ca23f25d65cbd6bba849eee` on branch `V5.1`,
observed at 2026-10-13T10:28Z. `origin/V5.1` was `c5c5aefd0ae20ad793f624c23ac73bf4a19d0fac` at
observation time; local HEAD had 3 unpushed commits (siblings committing concurrently).

Status vocabulary used below (exactly one per surface):

| Status | Meaning |
|---|---|
| `CONFIGURED_IN_REPO` | Real, complete source/config wiring exists in the repository. Says nothing about provider approval. |
| `IDENTIFIER_PRESENT` | A concrete identifier/record exists (in repo or in public DNS) but the owning provider has not verified or approved it. |
| `NOT_CONFIGURED` | The surface has no value at all — placeholders, empty fields, or absent keys. |
| `OWNER_ACTION_REQUIRED` | Progress is impossible without an owner-only action (identity, membership, payment, legal attestation, console record, or held secret). |

`CONFIGURED_IN_REPO` and `IDENTIFIER_PRESENT` are **code/record presence**, never
provider approval. No surface below is provider-approved.

---

## 1. Primary matrix

| # | Provider surface | Status | Code present | Provider-approved | Decisive evidence |
|---|---|---|---|---|---|
| 1 | **Google Play** (developer account, app record, Play Billing) | `OWNER_ACTION_REQUIRED` | Yes (adapter) | **No** | Play package is the refused prototype `online.megaxo.prototype`; no Play membership/app record was ever verified |
| 2 | **App Store** (Apple Developer, App Store Connect, StoreKit) | `OWNER_ACTION_REQUIRED` | Yes (StoreKit 2 adapter) | **No** | Bundle ID is the prototype; `CODE_SIGNING_ALLOWED = NO`; 0 codesigning identities locally; no product-ID mapping |
| 3 | **AdMob** (publisher account, app/unit IDs, UMP consent) | `OWNER_ACTION_REQUIRED` | Yes (UMP + GMA adapter) | **No** | Checked-in app IDs are Google **test** placeholders; `MEGA_AD_MODE=off`; ATT/`NSUserTrackingUsageDescription` and `*.xcprivacy` absent |
| 4 | **Email** (Resend transactional + Google Workspace) | `IDENTIFIER_PRESENT` | Yes | **No** | From-domain and all public DNS auth records exist and resolve; no `RESEND_API_KEY` in any reviewed environment; DMARC is `p=none` |
| 5 | **DNS / domain** (canonical `megaxo.online`, callbacks, asset links) | `OWNER_ACTION_REQUIRED` | Partly | **No** | `megaxo.online` is a Hostinger parked page with parking NS, no TXT/MX/DMARC; not attached to the deployed app |

### 1.1 Google Play — `OWNER_ACTION_REQUIRED`

Evidence:

- `native/android/gradle.properties:5` → `megaApplicationId=online.megaxo.prototype` (comment on `:4`:
  "Debug-only placeholder. Replace only after actual package/signing identities are verified.").
- `native/android/app/build.gradle.kts:67` → `namespace = "online.megaxo.prototype"`.
- `native/android/app/build.gradle.kts:129-146` → release tasks (`packageRelease`, `bundleRelease`,
  `assembleRelease`) `check()` that the app ID is **not** `online.megaxo.prototype`, that versionCode is
  positive with an approved versionName, and that all four `MEGA_ANDROID_RELEASE_*` values plus an
  existing owner-held keystore are set. The build therefore refuses to produce a release AAB as checked in.
- `native/android/app/src/main/java/online/megaxo/prototype/MegaPlayBilling.kt:23-32` → Play Billing 9
  adapter over exactly `crowns_100, crowns_525, crowns_1100, remove_ads`; the product mapping collapses to
  `emptyMap()` unless all four IDs are supplied, non-blank and distinct (i.e. disabled by default).
  Header comment `:20-21` states the provider is disabled "until real Play Console product IDs ...
  are established".
- The adapter is **not wired into the app**: `MegaXOActivity.kt` contains no reference to
  `MegaPlayBilling` (grep: 0 hits).
- `native/android/app/src/main/AndroidManifest.xml:7-9` removes `INTERNET`, `ACCESS_NETWORK_STATE` and
  `AD_ID` via `tools:node="remove"` — the checked-in Android build is offline-only, so Play Billing /
  Play verification cannot function in it even with a mapping.
- Backend refuses to run purchases without a complete Play config:
  `server/production/config.js:71-72` → `INCOMPLETE_GOOGLE_PLAY_CONFIG` unless service-account JSON,
  `GOOGLE_PLAY_PACKAGE_NAME`, all four `GOOGLE_PLAY_PRODUCT_*`, Pub/Sub audience and push service account
  are all present; `:90` → `STORE_PROVIDER_NOT_CONFIGURED` when purchases are enabled with neither provider.
- `.env.example:35-43` shows every Play/Apple store field empty with `MEGA_PURCHASES_ENABLED=false`.
- Play account access was never verified: `docs/p21-web/PROVIDER-SETUP-20261012.md` (live-access table)
  records the Play Console landing on developer-account sign-up then a 2SV gate, with **no** membership or
  app record observable; no `DRAFT/UPLOADED/TESTING/SUBMITTED/APPROVED/LIVE` state observed.

Owner action (exact):

1. Sign in to the intended Google account and complete 2SV; inventory any existing Play developer
   membership/invitation/role before creating anything.
2. Obtain Google Play Support's **written** answer on whether the India-based Udyam-registered sole
   proprietorship qualifies for an Organization account (D-U-N-S required) or must use a Personal account
   — decide the account type only after that answer.
3. Create/confirm the Play app record for a final package ID and record its real state
   (`DRAFT`…`LIVE`) against an exact build.
4. Generate the owner-held upload keystore and set the four `MEGA_ANDROID_RELEASE_*` variables on an
   owner-controlled release host (the values must never enter the repo).
5. After a real AAB exists, register the four Play products, then supply
   `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`, `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_PRODUCT_*`,
   `GOOGLE_PLAY_PUBSUB_AUDIENCE`, `GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT`.

No package ID, price, region or listing text is asserted here.

### 1.2 App Store — `OWNER_ACTION_REQUIRED`

Evidence:

- `native/ios/MegaXO.xcodeproj/project.pbxproj:80` (Debug) and `:81` (Release) →
  `PRODUCT_BUNDLE_IDENTIFIER = online.megaxo.prototype` with `CODE_SIGNING_ALLOWED = NO` in both
  configurations; Debug additionally pins `MEGA_APPLE_NATIVE_ENABLED = NO`.
- `native/ios/MegaXO/Info.plist:7` → `CFBundleIdentifier = $(PRODUCT_BUNDLE_IDENTIFIER)`;
  `:14-15` → `MegaAppleNativeEnabled = $(MEGA_APPLE_NATIVE_ENABLED)` (Sign in with Apple capability
  comment: "Enable only on the real Apple App ID with Sign in with Apple capability").
- `native/ios/MegaXO/MegaStoreKit.swift:26-45` → `MegaStoreKit(configuration:)` requires a complete
  one-to-one `MegaStoreProductIDs` dictionary; otherwise `ids = [:]`. `:38` reads that key from the app
  bundle. **`MegaStoreProductIDs` appears nowhere in the target or plist** (grep of `native/` returns only
  this reader). Consequence: `:43`, `:53`, `:78`, `:93` throw / return empty —
  `StoreError.unconfigured` — so no purchase, restore or unfinished-evidence path can execute.
- `MegaStoreKit` is **not wired into the app**: `MegaXOApplication.swift` has no reference to it (grep: 0 hits).
- Backend refuses Apple commerce without a complete config: `server/production/config.js:75-89`
  (`INCOMPLETE_APPLE_STORE_CONFIG`, `ABSOLUTE_APPLE_ROOTS_PATH_REQUIRED`, `INVALID_APPLE_STORE_ENVIRONMENT`,
  `APPLE_STORE_APP_ID_REQUIRED` for Production) and `:90` (`STORE_PROVIDER_NOT_CONFIGURED`).
- `.env.example:44-53` leaves `APPLE_STORE_BUNDLE_ID`, `APPLE_STORE_APP_ID`,
  `APPLE_STORE_ENVIRONMENT`, `APPLE_STORE_ROOTS_FILE` and all `APPLE_STORE_PRODUCT_*` empty.
- Apple console access was never verified: `docs/p21-web/PROVIDER-SETUP-20261012.md` records App Store
  Connect `/apps` redirecting to sign-in with `authResult=FAILED`, and Apple Developer account
  membership/team/identifiers/certificates as unverified.

Owner action (exact):

1. Sign in to the intended Apple Account, complete 2FA + identity verification, and inventory existing
   Developer Program / App Store Connect memberships and app records **before** enrollment.
2. Complete Apple Individual enrollment (the owner's declared route for a sole proprietorship); stop at
   agreement acceptance and membership payment, which remain owner-only.
3. Register/reserve a final bundle ID and the App ID capability set (including Sign in with Apple if the
   native Apple flow is to ship), then supply the numeric App Store app ID once the record exists.
4. Install a distribution certificate + App Store provisioning profile on an owner-controlled macOS host
   and set `MEGA_IOS_BUNDLE_ID`, `MEGA_IOS_TEAM_ID`, `MEGA_IOS_SIGNING_IDENTITY`,
   `MEGA_IOS_PROFILE_SPECIFIER`, `MEGA_IOS_VERSION_NAME`, `MEGA_IOS_BUILD_NUMBER`,
   `MEGA_IOS_OUTPUT_DIR` for `scripts/v5/native-release-ios.sh`.
5. Register the four StoreKit products in App Store Connect, then supply `APPLE_STORE_BUNDLE_ID`,
   `APPLE_STORE_ENVIRONMENT`, `APPLE_STORE_APP_ID`, `APPLE_STORE_PRODUCT_*` and a trusted-roots PEM path
   (`APPLE_STORE_ROOTS_FILE`).

No product price, territory or listing text is asserted here.

### 1.3 AdMob — `OWNER_ACTION_REQUIRED`

> **Status update (P20-06, same branch).** The three wiring findings below are now **superseded**:
> `MegaAndroidAds`/`MegaIOSAds` *are* instantiated by their hosts, both reward callbacks are real
> `EARNED` signals, and a typed origin-pinned bridge publishes `window.MegaAds` on both platforms
> (`MegaAdsBridge.kt` / `MegaAdsBridge.swift`). Verified on a physical Android device: the page
> reports `ads=object platform=android`, consent becomes true only after UMP answers, and every
> failure path returns a clean rejection. The remaining owner actions (real units, UMP message
> publication, SSV handler, store review) and `MEGA_AD_MODE=off` are unchanged and still required.

Evidence (as of the freeze commit, before the update above):

- `native/android/app/build.gradle.kts:79-81` → `manifestPlaceholders["megaAdMobAppId"]` falls back to
  `ca-app-pub-3940256099942544~3347511713`, the comment at `:77-78` calling it the "Official test app ID
  for a non-distributing, offline prototype. Real releases require an owner-verified AdMob registration."
- `native/android/app/src/main/AndroidManifest.xml:18-19` publishes that placeholder as
  `com.google.android.gms.ads.APPLICATION_ID`; `:9` removes `AD_ID`.
- `native/ios/MegaXO.xcodeproj/project.pbxproj:80` (Debug) pins
  `MEGA_ADMOB_APP_ID = "ca-app-pub-3940256099942544~1458002511"` — a Google test app ID. The **Release**
  configuration (`:81`) does not define `MEGA_ADMOB_APP_ID` at all, so `native/ios/MegaXO/Info.plist:16`
  (`GADApplicationIdentifier = $(MEGA_ADMOB_APP_ID)`) would be an unresolved build setting in a real archive.
- `native/android/app/src/main/java/online/megaxo/prototype/MegaAndroidAds.kt:23-31` takes nullable
  `appId`/`rewardedUnit`/`interstitialUnit`; `ready()` (`:51-53`) additionally requires `initialized &&
  canRequestAds()`. Class comment `:20-22`: "Deliberately not instantiated until actual AdMob app/unit IDs,
  approved consent flow, active actor and server tickets exist."
- `native/ios/MegaXO/MegaIOSAds.swift:5-8` → "intentionally not wired into signed client until
  actor-bound P05 transport, exact AdMob IDs and privacy declarations exist."
- Neither ads class is wired into its app entry point: `MegaXOActivity.kt` has no `MegaAndroidAds`
  reference and `MegaXOApplication.swift` has no `MegaIOSAds` reference (grep: 0 hits each).
- **Privacy declarations absent**: no `NSUserTrackingUsageDescription` key in `native/ios/**`
  (grep: 0 hits) and no `*.xcprivacy` privacy manifest file anywhere under `native/` (find: 0 hits).
  Both are required before a release build may request ads / track.
- `.env.example:55-60` → `MEGA_AD_MODE=off`, `MEGA_AD_CONSENT_VERSION=` and all four
  `ADMOB_{ANDROID,IOS}_{REWARDED,INTERSTITIAL}_UNIT` empty.
- Backend refuses any non-off ad mode without the release gates: `server/production/config.js:44-52` →
  `ADS_REQUIRE_PRIVACY_RELEASE`, `ADS_REQUIRE_CONSENT_RELEASE`, `ADMOB_UNITS_REQUIRED`,
  `INCOMPLETE_ADMOB_UNITS`; `:46` also enforces the `ca-app-pub-\d{16}/\d{10}` unit format.
- AdMob console access was never verified: `docs/p21-web/PROVIDER-SETUP-20261012.md` records the AdMob
  sign-in stopping at `/signup/info/user-age-missing`, with no publisher account, app record, ad unit or
  UMP message visible.

Owner action (exact):

1. Sign in to AdMob with the business identity, satisfy the age/DOB gate, and confirm whether a publisher
   account already exists before creating one.
2. Register the real app(s) and create the rewarded + interstitial ad units per platform.
3. Add `NSUserTrackingUsageDescription` (and the required `PrivacyInfo.xcprivacy`) to the iOS target —
   a repository change Main must make once the tracking declaration is owner-approved.
4. Approve the consent/privacy policy versions, then set `MEGA_AD_CONSENT_VERSION`,
   `MEGA_PRIVACY_POLICY_VERSION`, `MEGA_RETENTION_POLICY_VERSION`, `MEGA_ACCOUNT_DELETION_ENABLED=true`
   and the four real ad-unit variables; AdMob SSV must be configured server-side (`user_id`,
   `custom_data`) before any rewarded grant.
5. Keep `MEGA_AD_MODE=off` until physical-device UMP + SSV acceptance is recorded.

### 1.4 Email — `IDENTIFIER_PRESENT`

Evidence (presence only; no secret value was read):

- `server/email-provider.js:4` → hardcoded default sender
  `Mega XOXO by Antimatter Innovations <contact@antimatterinnovations.com>`; `:9` reads
  `RESEND_API_KEY` from the environment and disables delivery when absent (`enabled()`), throwing
  `EMAIL_DELIVERY_NOT_CONFIGURED`.
- `server/production/config.js:57` validates a Resend key shape (`INVALID_RESEND_API_KEY`);
  `:58-60` validate the from-address and enforce `EMAIL_FROM_DOMAIN_MISMATCH` against
  `MEGA_EMAIL_DOMAIN` (default `antimatterinnovations.com`).
- `.env.example:5` → `MEGA_EMAIL_DOMAIN=antimatterinnovations.com`.
- Public DNS for `antimatterinnovations.com` (queried read-only): MX `1 smtp.google.com` (Workspace
  receives mail), TXT SPF exactly `v=spf1 include:_spf.google.com ~all`,
  `google._domainkey` TXT DKIM key present, `resend._domainkey` TXT DKIM key present,
  `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:postmaster@…, mailto:dmarc@…; pct=100; adkim=s; aspf=s`.
  `send.antimatterinnovations.com` (the Resend return-path domain) resolves MX `send.forge.rmta.net`
  and TXT SPF `v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all`.
- **No `RESEND_API_KEY` and no `MEGA_EMAIL_FROM` are present in this shell environment**
  (presence check: `ABSENT`), and no `.env` / `.env.local` / `.env.production` file exists in the repo
  root. `RESEND_API_KEY` is also not listed in `.env.example`, so the deployment must inject it directly.
- The staging host holds no mail credential: `/opt/mega-xo-v51-staging/secrets/` contains only
  `ca.pem`, `credentials.json`, `keys.sealed.json`, `runtime-roles.json`, `staging-otp.secret`,
  `upstash-staging.json`, `core-gateway.secret` (names only, no Google/Resend provider key).

Why `IDENTIFIER_PRESENT` and not `CONFIGURED_IN_REPO`: the sending identity and every public
authentication record exist, but the API key that would enable delivery is absent from all reviewed
environments, and DMARC sits at `p=none` — below the `quarantine` floor the repository's own audit
expects (`deploy/MAIL-DOMAIN-SECURITY.md`, `scripts/mail-domain-audit.js`).

Owner action (exact):

1. Supply `RESEND_API_KEY` (and, if a distinct display sender is wanted, `MEGA_EMAIL_FROM`) into the
   approved deployment secret store; never into the repo.
2. Run the read-only audit — `npm run mail:audit` with `MEGA_MAIL_DKIM_HOSTS`,
   `MEGA_MAIL_RETURN_PATH_DOMAIN`, `MEGA_MAIL_APEX_SPF_INCLUDES`,
   `MEGA_MAIL_RETURN_SPF_INCLUDES`, `MEGA_MAIL_MX_SUFFIXES` set from the current console instructions —
   and record the result separately.
3. Raise the DMARC policy toward `quarantine`/`reject` when the owner judges the mail streams stable
   (a DNS change, not a code change).

### 1.5 DNS / domain — `OWNER_ACTION_REQUIRED`

Evidence (read-only DNS + HTTP):

- `megaxo.online` → A `2.57.91.91`, NS `cosmos.dns-parking.com` / `nova.dns-parking.com`, **no TXT,
  no MX, no `_dmarc`**; HTTPS returns 200 but the body is a Hostinger parking page
  (`<title>Parked Domain name on Hostinger DNS system</title>`). The owner-intended canonical domain is
  therefore not serving the application.
- `play.antimatterinnovations.com` → A `129.80.67.164`, `/` 200, but
  `/.well-known/assetlinks.json` → **404** (no Android App Links statement at that origin).
- `docs/v5.1/release/VERCEL-DEPLOYMENT-20261013.md` records that `megaxo.online` is not in the owner's
  Vercel account and that DNS/domain association plus the production alias are prepared but **not
  attached**; it also records that Vercel→Oracle Core is not a live connection because the Core ingress
  is tailnet-only and a public signed endpoint is "a DNS/domain decision the owner must approve".
- `server/production/config.js:33-35` requires an exact public HTTPS root in `MEGA_ORIGIN`
  (`PUBLIC_HTTPS_ORIGIN_REQUIRED`), and the OAuth callback is derived as
  `<origin>/auth/callback/{google,apple}`.
- The current staging origin `https://command.tail95c48c.ts.net` is **tailnet-only**
  (`tailscale serve status`: `https://command.tail95c48c.ts.net (tailnet only)` → proxy
  `http://127.0.0.1:8085`). It serves a real HTTPS origin and was reachable for this read-only check:
  `/readyz` → 200 `{"status":"ok","live":true,"ready":true}`. Its `/.well-known/*` responses come from the
  shared API handler (`scripts/v51/p21-staging-server.cjs:235-236` routes `/.well-known/` to `apiHandler`),
  i.e. the same repository defaults, not a provider registration.

Owner action (exact):

1. Decide whether `megaxo.online` (or another exact public HTTPS host) is the canonical origin, then point
   its DNS at the approved host and stop the parking NS/record set.
2. Approve a public signed Core ingress endpoint if the deployed API is to reach the Oracle Core — this is
   the DNS/domain decision noted in `VERCEL-DEPLOYMENT-20261013.md`; without it the API serves honest
   DB-backed reads only.
3. Approve attaching `MEGA_ORIGIN` and the derived Google/Apple callback URLs, then register those exact
   callback URLs in the Google Cloud OAuth client and Apple Service ID.
4. Approve the release gate (noindex/HSTS/alias) before the production alias is attached.

---

## 2. Supporting surfaces

| Surface | Status | Evidence | Owner action |
|---|---|---|---|
| Android Play Billing adapter (code) | `CONFIGURED_IN_REPO` | `MegaPlayBilling.kt:23-32` — real Play Billing 9 client, four-ID catalogue, mapping required | Wire the adapter into the app only after a real package ID + product mapping exist |
| iOS StoreKit 2 adapter (code) | `CONFIGURED_IN_REPO` | `MegaStoreKit.swift:26-45` — real `Product.purchase`/`Transaction` usage, complete-mapping requirement | Supply `MegaStoreProductIDs` in the plist after the App Store catalogue is registered |
| UMP / consent integration (code) | `CONFIGURED_IN_REPO` | `MegaAndroidAds.kt:23-56`, `MegaIOSAds.swift:25-37`; server gates `config.js:44-52` | Approve consent + privacy + retention versions before enabling any ad mode |
| Digital Asset Links (`/.well-known/assetlinks.json`) | `IDENTIFIER_PRESENT` | `apps/api/routes/well-known.js:27-39` — package `com.antimatterinnovations.megaxo` + one hardcoded SHA-256 fingerprint, served verbatim (verified live 200 on the staging origin) | Confirm the package + fingerprint belong to a **real** uploaded artifact (they match neither the current prototype ID nor the owner-selected `online.megaxo.xoxo`) and replace them from the real signing certificate |
| Apple App Site Association | `NOT_CONFIGURED` | `apps/api/routes/well-known.js:41-58` — `appIDs: ['TEAMID.com.antimatterinnovations.megaxo']` is a literal placeholder team ID; `webcredentials` repeats it | Replace `TEAMID` with the real 10-char Apple Team ID after enrollment |
| Native signing / entitlement material on this host | `NOT_CONFIGURED` | `security find-identity -v -p codesigning` → **0 valid identities found**; `~/Library/Developer/Xcode/UserData/Provisioning Profiles` → **does not exist**; no `MEGA_ANDROID_RELEASE_*` variable present in this environment | Owner generates/installs the distribution certificate(s), App Store profile and Android upload keystore on an owner-controlled host |
| Website store links | `NOT_CONFIGURED` | `apps/web/store-links.json:1-4` → `{"ios": null, "android": null}` | Populate only after real listings exist and publication is separately authorized |
| Google / Apple sign-in (web + native identity) | `NOT_CONFIGURED` | `.env.example:12-27` all empty; `config.js:63-70` (`INCOMPLETE_GOOGLE_WEB_CONFIG`, `INCOMPLETE_APPLE_WEB_CONFIG`); no provider env present in this shell | Register the web/native OAuth clients after the exact callback origin and identifiers are decided |

---

## 3. Local signing/entitlement presence check (presence only)

| Probe | Result |
|---|---|
| `security find-identity -v -p codesigning` (macOS) | `0 valid identities found` |
| `ls ~/Library/Developer/Xcode/UserData/Provisioning Profiles` | directory does not exist |
| `MEGA_ANDROID_RELEASE_KEYSTORE_PATH` / `_STORE_PASSWORD` / `_KEY_ALIAS` / `_KEY_PASSWORD` | all `ABSENT` (0 matching variables) |
| `MEGA_IOS_TEAM_ID`, `MEGA_IOS_SIGNING_IDENTITY`, `MEGA_IOS_PROFILE_SPECIFIER`, `MEGA_ANDROID_APPLICATION_ID` | all `ABSENT` |
| `RESEND_API_KEY`, `MEGA_EMAIL_FROM`, `MEGA_ORIGIN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_PRIVATE_KEY`, `MEGA_AD_MODE`, `ADMOB_ANDROID_REWARDED_UNIT` | all `ABSENT` |
| `.env`, `.env.local`, `.env.production` in repo root | none exist |

No file content, keystore, key, profile or credential value was read, printed or copied.

---

## 4. Verification boundary

- This file is an inventory, not an acceptance artifact. It does not close A34, A35, A37 or P21.10,
  and it does not advance any R12/R13/R14 item to "done".
- No store submission, upload, purchase, subscription, account creation, enrollment, fee, product
  registration, ad-unit creation, consent-message publication, DNS change, or listing publication
  occurred, and none is claimed.
- No price, territory, catalog entry, listing text, legal attestation or launch date is asserted
  or invented here.
- `docs/p21-web/PROVIDER-SETUP-20261012.md` remains the last provider-console observation set; the
  console states quoted above are from that file, not from a new console session.
- Public DNS/HTTP observations were made read-only on 2026-10-13 and reflect the resolvers used at that
  moment; they are not provider-console records.
- The only change made alongside this inventory is this documentation file. No app, backend or native
  source/configuration was modified.
