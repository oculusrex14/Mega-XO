# V5.2 security and backend audit — Planck

Audit baseline: codex / PR #30 → V5.2, **7f582b749a1128b86e53ddcbcda57b569b0953cf**. Observations: 17 October 2026 UTC. This is a workstream assessment; the integrator owns the final release verdict.

Only this report, the two assigned companion reports and evidence/planck-findings.csv were written. No local tests, build, commit, checkout, push, production mutation, provider transaction or account creation was performed. APK signature/manifest inspection is static inspection, not device acceptance. GitNexus has no index for this repository; no index was created.

The shared checkout advanced during the audit to a385774ef24ebbecb71ec9d73cd2e658d6a0665d and other lanes have uncommitted work. Findings and source line numbers refer to **7f582b7**, not an inferred final integration state. The intervening source changes observed were website reflow and Android association changes; this audit did not make them. A later source fix is explicitly distinguished from a live fix.

## Findings and disposition

Full descriptions, primary file/symbol/line, commands, owner and permitted status are in [the finding register](evidence/planck-findings.csv). None of the proposed remediations was implemented by this workstream.

| ID | Priority / status | Evidence and required action |
|---|---|---|
| MXA-SEC-001 | P1 VERIFIED_DEFECT | account.js:296-300 emits the same token in a non-Secure development cookie on production paths; helpers.js:214 accepts it. Production must issue only the host-prefixed secure credential. |
| MXA-SEC-002 | P1 VERIFIED_DEFECT | Live HTML/API lack the four headers set by production-server:990-993. Reconcile the real serving build/edge and verify headers after authorized deployment. |
| MXA-SEC-003 | P2 SUSPECTED_RISK | accounts.bootstrap:682 calls issue:370-375 without source admission when no live token exists. Rate-limit explicit bootstrap; do not add lazy sessions to other routes. No flood was attempted. |
| MXA-SEC-004 | P1 VERIFIED_DEFECT at baseline/live | Published APK package online.megaxo.game differs from live assetlinks online.megaxo.xoxo. Integrator commit a385774 is a source follow-up, not proof of deployed correction. |
| MXA-SEC-005 | P2 VERIFIED_DEFECT | Live AASA contains TEAMID; iOS entitlement file lacks associated domains and Android manifest lacks a VIEW/App Link filter. Association JSON alone does not prove native deep-link support. |
| MXA-SEC-006 | P2 SUSPECTED_RISK | Native workflow uses mutable emulator/artifact action tags. Pin release-path actions and retain provenance. |
| MXA-SEC-007 | P1 SUSPECTED_RISK | Live systemd service User=root; API/Core/worker pools coexist in one process. SQL capability separation is not process isolation. |
| MXA-SEC-008 | P2 NOT_RUN | Live two-account authn/authz, revocation and CSRF negatives require sanctioned test identities/operations. |
| MXA-SEC-009 | P2 NOT_RUN | No exact-SHA dated dependency advisory result obtained; yesterday's report is historical. |
| MXA-SEC-010 | P2 VERIFIED_DEFECT | Sponsors handler is not imported/dispatched in API index:138-167; reports cannot reach that operational backend. |
| MXA-SEC-011 | P2 NOT_RUN | Physical-device storage, trusted-frame rejection, interrupted identity and profile/link acceptance not repeated for exact signed artifacts. |

Infrastructure P0s MXA-INF-001/002 and monetization P1s MXA-ECO-001–012 also affect security/launch acceptance. They are counted once under their own IDs, not duplicated here.

## Evidence tiers and live boundary

- **Observed live:** retired host /game → 308 to https://megaxo.online/game → 200; www → 301 to apex → 200; /livez 200; guest /api/account/profile 401; guest /api/monetization/status 404; /opsz 503; unsigned core.megaxo.online/ingress/command 401. No player response body was collected.
- **Observed source:** controls and gaps described below. Source existence does not mean deployed or provider-approved.
- **Observed GitHub:** exact-baseline audit/PG service jobs succeeded; native gameplay and browser presentation had failures. See infrastructure report for exact run/job IDs and cancelled retry.
- **Not executed:** authenticated production probes, receipt/ad replay against providers, economic writes, exploit traffic, physical device acceptance, DB catalog queries and a new vulnerability scan.

## Identity, authentication and authorization

The API strips untrusted x-actor-id/x-test-actor/x-forwarded-for at index:68-73 and security.sanitizeHeaders:167-180. resolveAuth (helpers.js:207-246) authenticates a live linked session or explicitly configured native verifier; an arbitrary actor header cannot create identity. Missing credentials return no actor; ordinary profile/wallet/commerce reads do not bootstrap a session.

There are **intentional** unauthenticated session-creation surfaces: GET /api/account/session (account.js:323), first-use POST /api/account/start (:637), and native/challenge (:773). Their creation is not itself an impersonation defect. The absence of a visible source-level bootstrap admission budget is MXA-SEC-003. The auditor did not call those endpoints because they write durable session state.

Browser cookie writes require an allowed Origin/Referer at security.validateCredentials:107-160 and csrf.js:86-129; a present foreign Origin cannot be rescued by a friendly Referer. Native bearer and cookie credentials are refused when combined. Cookie-sensitive logout/native-start flows additionally verify token/content type. General profile mutations rely on the origin perimeter; this report does not claim an additional per-route CSRF-token check where none exists.

The approved cookie is host-only __Host-mega_session, HttpOnly, Secure, SameSite=Lax and Path=/. Its unconditional plaintext-capable development copy is an actual source defect, not a recommended production configuration.

Identity-provider verification pins provider URLs, RS256, issuer, audience, nonce, issue/expiry timing and authorized parties (server/identity-provider.js:8-9,30-33); one-use attempts and rotation live in accounts.js. Native refresh tokens remain in device-bound host storage. Live OAuth/MFA/provider completion was not exercised.

Profile updates extract only displayName/name, avatar, statsVisibility, presenceVisibility and username (account.js:73-80); accounts.edit:765 validates the allowlist and rate limit. Save uploads use sanitizePractice and revision compare-and-swap (accounts.js:886-909). A wallet-looking practice payload is not authoritative economy state. Generic competitive commands always retain the authenticated principal; privileged commands are scope checked and purchases/refunds are excluded from generic Core.run (core.js:413-415).

## Complete mounted HTTP/API security matrix

Scope: **all endpoint patterns mounted by the baseline canonical production listener and createApiHandler**. A parameterized row covers every value of that parameter, not only a sample URL. Static public files are represented by their manifest/path family. Unknown APIs return 404; undocumented legacy endpoints are not assumed mounted.

Abbreviations: P=public; S=live session; L=linked verified actor; N=native verified access/refresh credential; H=service HMAC; V=independent provider verification. Cookie mutations inherit the global origin/credential perimeter. Private/API replies use no-store except the explicitly public leaderboard/static cache policy.

| Method and endpoint(s) | Auth / authorization and side effect | Source at baseline |
|---|---|---|
| OPTIONS on API routes | P; CORS preflight 204 before route handlers; no actor grant | index:75; middleware/cors:100 |
| GET /api/account/session | P/S; explicit durable anonymous bootstrap/own session; no wallet | account:getSession:323 |
| POST /api/account/start | P/S; provider allowlist, one-use state/nonce/PKCE; explicit first-use bootstrap; cookie CSRF | account:postAccountStart:637 |
| POST /api/account/email | S/explicit auth bootstrap flow; validated action, OTP/address/session budgets, delivery material stripped | account:postEmail:355; accounts:583 |
| POST /api/account/logout, /auth/logout | S; own session or all-device revocation; CSRF; clear cookie aliases | account:handleLogout:253; dispatcher:928 |
| GET /api/account/profile | L; caller projection only | account:getProfile:25 |
| POST /api/account/profile | L; explicit profile-field allowlist, no wallet fields | account:updateProfile:65 |
| GET /api/account/save | L; caller practice archive only | account:getSave:92 |
| POST /api/account/save | L; sanitized practice, revision CAS; not wallet authority | account:postSave:112; accounts:891 |
| GET and POST /api/account/export | L plus service recent-auth/session gate; caller export, private no-store | account:getExport:139; accounts:exportData |
| POST /api/account/delete | L; confirmation/recent-auth and durable deletion policy; writes | account:deleteAccount:162 |
| POST /api/account/unlink | L; own provider only; last-login-method protection | account:unlinkProvider:189 |
| GET /api/account/deletion | L; own deletion availability/policy | account:getDeletionStatus:209 |
| GET /api/account/research | L; own consent record only | account:getResearch:222 |
| POST /api/account/research | L; validated own choice, CSRF; no economic write | account:postResearch:236 |
| POST /api/account/native/challenge | P/N/S; validated provider, explicit anonymous attempt if needed, no cookie response | account:773 |
| POST /api/account/native/finish | Bound attempt + verified provider ID token; rotates session, no cookie response | account:806 |
| POST /api/account/native/token | Bound provider grant or refresh secret; configured signer/audience; refuses mixed credentials | account:838 |
| POST /api/account/native/refresh | Possession of refresh-family secret, rotation/replay policy; no cookie | account:874 |
| POST /api/account/native/logout | N; verified actor/session/family; allDevices stays actor-bound | account:894 |
| GET /auth/callback/google, /auth/callback/apple | Bound browser cookie + one-use state + provider exchange V; session rotation; provider allowlist | well-known:384; account:createWebSignInLane:668 |
| GET /api/v1/profile | L; caller economy/profile projection; GET only | compat:83,473 |
| GET /api/v1/queue | L; own queue state, read-only | compat:193,482 |
| GET /api/v1/match/:id | L + participant check; no-store even terminal; no lazy settlement | compat:241,500 |
| GET /api/v1/invitations | L; own pending invitations | compat:338,491 |
| GET /api/v1/leaderboard | P; normalized filters; Core public projection excludes private/unverified/held; wealth opt-in | compat:396; read-cache:765-780 |
| GET /api/community/profile/:id | L; viewer-relative friendship/block/privacy projection, no-store | social:22,137 |
| GET /api/community/friends | L; caller relationships only | social:54,143 |
| GET /api/community/search | L; bounded validated search with service privacy projection | social:100,153 |
| POST /api/community/friend | L; explicit social action and target, actor taken from session | social:76,148 |
| POST /api/convert and /api/v1/convert | L → H Core player command; operation identity, integer/balance checks; current 10:1 | competitive:161; commands:35 |
| POST /api/queue and /api/v1/queue | L → H Core queue; eligibility, budget, occupancy checks | competitive:187 |
| POST /api/cancel-queue, /api/queue/cancel and /api/v1 equivalents | L → H; caller queue only | competitive:205,418 |
| POST /api/move and /api/v1/move | L → H; participant, turn, legality, expected revision, operation key | competitive:221; authority:126 |
| POST /api/resign and /api/v1/resign | L → H; participant/current match only | competitive:240; authority:133 |
| POST /api/offer and /api/v1/offer | L → H; caller, quoted terms, opponent eligibility, Crown escrow | competitive:257; authority:offer |
| POST /api/accept and /api/v1/accept | L → H; invited participant and terms hash | competitive:275 |
| POST /api/decline and /api/v1/decline | L → H; invited participant | competitive:291 |
| POST /api/cancel and /api/v1/cancel | L → H; caller/offer state | competitive:306 |
| POST /api/quest, /api/quest/claim and /api/v1 equivalents | L → H; qualification + one claimed reward identity | competitive:324; authority:172 |
| POST /api/ticket and /api/v1/ticket | L; API-role ticket issuer; only matchScope accepted; binding reread; no caller actor/session generation | competitive:341-375 |
| POST /api/command and /api/v1/command | L → H; Core scope dispatcher; operator/store commands cannot become player authority | competitive:382; core:413-415; commands:13-51 |
| GET /api/party/capabilities | P → H actor-free capabilities read; no paid entry | tournaments:11 |
| GET /api/party/rooms/:id | L → H; participant-scoped room view | tournaments:19-28 |
| POST /api/party/command | L → H; validated tournament command and client operation key; Core owns fees | tournaments:30-37 |
| GET /api/monetization/status | L → H Core read; no session mint; **live 404 mismatch** | monetization:87,225; commerce:1277 |
| POST /api/monetization/ticket | L → H; daily quota/spacing/outstanding ticket; **kind mismatch** | monetization:88; commerce:492 |
| POST /api/monetization/claim | L → H; qualifying casual results, durable dedupe; no arbitrary client completion | monetization:89; commerce:460 |
| POST /api/monetization/permit | L → H; hybrid mode, entitlement and busy/placement checks | monetization:90; commerce:549 |
| POST /api/monetization/purchase | L → H + V store receipt/account binding; durable outcome before finalization | monetization:91; commerce:587 |
| POST /api/monetization/cosmetic | L → H; server catalogue cost/ownership; Cosmetic Credits only | monetization:92; commerce:566 |
| GET and POST /api/monetization/admob-ssv | P + source budget → H → V exact signed bytes; actor/ticket/unit/item/amount/time binding | monetization:108-129; commerce:520 |
| POST /api/monetization/cashfree/order | L → H; server catalogue, customer validation, durable create reservation before external I/O | monetization:137; commerce:676 |
| GET /api/monetization/cashfree/status | L; own order → independent V; **can settle wallet**, not a pure read | monetization:152; commerce:850 |
| POST /api/monetization/cashfree/webhook | P + source budget → H → raw HMAC V → independent provider reread | monetization:162; commerce:832 |
| POST /api/monetization/polar/checkout | L → H; server catalogue and create reservation; identifier risk | monetization:181; commerce:916 |
| GET /api/monetization/polar/status | L; own checkout → independent V; **can settle wallet**, not a pure read | monetization:195; commerce:1157 |
| POST /api/monetization/polar/webhook | P + source budget → H → Standard Webhooks V; provider reread for lifecycle | monetization:205; commerce:1039 |
| POST /api/metrics/batch | P; anonymous aggregate allowlist; **raw-body parser defect**, not an economy source | metrics:22-37; index:122 |
| GET /.well-known/assetlinks.json | P; static registered Android association | well-known:350 |
| GET /.well-known/apple-app-site-association | P; configured iOS association; live placeholder | well-known:355 |
| GET /health, /livez, /readyz | P; minimal DB-read readiness, no-store; no actor/session mint | well-known:361 |
| GET /opsz | P; only ok boolean and 200/503, no schema/provider/queue details | production-server:1007-1012 |
| GET /privacy[.html], /terms[.html], /support[.html], /privacy-choices[.html], /delete-account[.html] | P; fixed legal file mapping | well-known:115-125,367 |
| GET /legal.css, /public/legal.css, /public/:asset | P; contained public-file path; not arbitrary filesystem access | well-known:373-379 |
| Public manifest pages/assets/download files | P; contained artifact path and actual 404 on missing file; fallback listener is not separately method-gated | production-server:1015-1029 |
| /admin[/...], /operator[/...], /metrics[/...] | Public listener denies 403; not operator access | index:61-65; security:isOperatorRoute:208 |

**Not mounted by this baseline API:** /api/sponsors/report, /api/monetization/reward-ticket, /api/monetization/interstitial-permit, /api/monetization/restore, /api/monetization/google-play-rtdn and /api/monetization/apple-notifications. Existence in legacy server files does not expose them through V5. /api/download belongs to the separate preview server at scripts/p21/serve-web.js:156, not the canonical listener's explicit API dispatch.

### Signed service endpoints

All listed service endpoints are POST and require the exact HMAC over timestamp, method, normalized path, signed actor, operation key and body hash. OPTIONS receives a capability-neutral 204. The isolated core edge forwards only /ingress/*; it does not make these public player APIs.

| Endpoint | Principal / allowed effect |
|---|---|
| /ingress/command | Signed actor, player scope; Core transaction and scope allowlist |
| /ingress/ticket | Signed actor + API-owned issuer; durable session binding validation |
| /ingress/leaderboard | Signed empty actor; bounded public query fields only |
| /ingress/queue/join | Signed actor, admission/occupancy/fee rules |
| /ingress/queue/cancel | Signed actor, own queue only |
| /ingress/queue/status | Signed actor, own ephemeral status |
| /ingress/tournaments/capabilities | Signed empty actor, empty-object capability request |
| /ingress/tournaments/command | Signed actor/op key, validated player tournament command |
| /ingress/tournaments/view | Signed actor/op key, room-ID-only input, scoped view |
| /ingress/commerce/command | Signed actor/op key overwrite untrusted command fields; narrow commerce dispatcher |
| /ingress/commerce/ssv | Signed empty actor; independent provider proof supplies ticket actor |
| /ingress/commerce/cashfree/webhook | Signed empty actor + provider HMAC/reverification |
| /ingress/commerce/polar/webhook | Signed empty actor + provider HMAC/reverification |

Sources: core-gateway.js:796-1093; commerce-ingress.js:22-105. No public user route grants operator or store scope.

### Realtime and native LAN

The /realtime/v1 WebSocket upgrade creates an **unauthenticated** bounded connection; it does not authenticate via query actor or arbitrary headers. Ticket redemption must consume a one-use durable ticket before subscribe/command/resume. Each authenticated operation rechecks session generation/eligibility and scoped match membership; commands stamp match/revision from the validated envelope. HTTP recovery GET /realtime/v1/snapshot[/] and /realtime/v1/match/:id uses authenticateHttp, not a URL actor. See realtime-transport.js:46-59,190-194,314-319,1140-1190 and production-server:1033-1040. Isolated exact-SHA CI covers transport/ticket boundaries; live authenticated frame/replay tests were NOT_RUN. A successful 101 alone would not prove identity.

Native LAN traffic is a separate private-room surface, not PostgreSQL competitive authority. Android's local socket forwards /api/party/* to the signed page (MegaAndroidLanBridge.kt:425-435); other /api/* paths are refused. Private-literal/port/path restrictions constrain outbound LAN fetches. The legacy LAN handler declares capabilities, guest session, me, rooms/:id and command (server/party-http.js:13-22), with host/origin/JSON and bearer/guest admission. This is not evidence that those legacy routes are mounted on megaxo.online or that LAN outcomes grant competitive currency. Physical hostile-peer and permission-denial checks remain NOT_RUN.

## Reverification of inherited controls

| Control | Current evidence / limit |
|---|---|
| HMAC timestamp/body/actor binding | core-gateway:825-855: 30-second drift, constant-time comparison, body hash. Body reader:87-156 bounds 100 KiB and 10-second absolute deadline. Still present. |
| Nested commerce actor override | core-gateway:1016-1019 spreads untrusted input first, then forces signed actor/opKey. Earlier defect is fixed in this baseline. |
| Header-derived actor impersonation | helpers:204-246 and API sanitizer retain session-derived actor; no mint from actor headers identified. |
| Leaderboard privacy | read-cache:765-780 applies verified/not-suspended/not-held/public-profile predicates and wealth opt-in before limit. compat:396 normalizes filters; participant/profile views are no-store. No player records fetched. |
| API ticket issuer | competitive:341-375 validates narrow body and fresh binding; Core receives no ticket-issuance DB grant by convenience. |
| Approved models/unpaid local AI | local-session.js:81 filters APPROVED; pack resolution uses trusted catalogue; domain.js:115 excludes Impossible/unverified-local-ai from rewards. No model promotion inferred. |
| Provider callback admission | production-server:959-973 plus provider-callback-limit:178-225 supply bounded per-provider/source admission with proxy-secret verification. Earlier unthrottled-callback report is superseded at source. Host-managed edge configuration is not assumed verified from source. |
| Checkout external-I/O fence | commerce.reserveCreate:104-111 commits the unique actor/op-key reservation before createCashfreeOrder:702 or createPolarCheckout:940 invokes provider creation. Earlier orphan-create race is superseded; discount-specific failure handling remains ECO-012. |

## Database, native and supply-chain posture

PostgreSQL is the serving authority. PG guards assert current_user=session_user, role membership/TEMP restrictions, schema grants, target/version/TLS and transaction settings (pg/guards.js:368-405,467; pg/pool.js). Migration roles are v5_owner/migration_owner; api_runtime handles identity/profile/social/privacy plus bounded operational writes, core_runtime handles competitive/economic state, worker_runtime owns leases/sweeps/finalization, backup_reader is read-only. Runtime roles cannot become migrator/Core through SET ROLE membership. Migrations explicitly revoke runtime ledger UPDATE/DELETE (0021_grants_core.sql:24-25). The migration runner verifies ordered checksums and uses an advisory lock and one transaction per migration (scripts/v5/migrate.js:54-57,124). Live catalog verification remains INF-009.

Android source disables backup, arbitrary file/content access, mixed content and release WebView debugging; exported activity is the required launcher, not evidence of an exploit. The only XML cleartext exception is loopback; private LAN sockets enforce a separate literal/path policy. iOS uses device-only non-synchronizing Keychain storage and trusted main-frame file-entry checks; navigation responses cannot redirect the main frame to an untrusted origin (MegaIOSApiBridge:64-73; MegaXOApplication:289-315). No ATS blanket exception or custom URL scheme is declared in Info.plist.

Static published APK verification succeeded: package online.megaxo.game, version 1.0.0/code 1, minSdk 28, targetSdk 35, signer SHA-256 961cc05474570e60584a14142bb0e3d645804bcb4c168862a6945e4175329337. aapt reported no application-debuggable flag. This proves neither Google Play approval nor alignment with the source-default online.megaxo.xoxo identity.

The lockfile is v3, with 25 package records; runtime roots are pg and redis. No local advisory scan was run. Several workflows pin checkout/setup-node and PG images, but native emulator/artifact actions still have mutable tags. Source CSP prohibits objects/base/frame ancestors but permits third-party scripts including unpkg/Cashfree; review exact remote inputs and provenance rather than equating a CSP string with an XSS audit. The live missing-header observation remains the immediate defect.

## Required follow-through

Resolve the identified P0 recovery/retention controls and P1 cookie/live-hardening/commerce defects, then obtain exact-build GitHub and owner-authorized staging/device evidence. Do not widen DB grants, restore a SQLite authority, change Crown utility, suppress /opsz failures, or treat provider sign-in permission as provider approval.
