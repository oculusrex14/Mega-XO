# Mega XOXO V5.2 — Codex execution board (2026-10-16)

**Role split (owner directive 2026-10-16):** Codex app = primary implementation, testing, browser/provider-console and PR authoring agent. Main = merges, production deployments, independent security audit. WebUI = independent audit/fix PRs only.

**Owner ordering directive (2026-10-16):** LR02/A01 **CI-failure resolution is DEFERRED TO LAST** — Main is actively resolving the native-host-build verification failure. All CI-independent work proceeds first. At end of run, re-verify all workflow families on the final exact head; Codex takes over remaining failures only if still unresolved then. Never weaken security checks to turn CI green.

**Baseline:** PR #20 dependency order (LR01–LR23, AR01–AR08) + owner V5.2 autonomous-development brief (2026-10-16). Trunk V5.2 @ d8d304b. Canonical id online.megaxo.xoxo. Canonical domain https://megaxo.online.

## Phase 0 — Reconciliation (DONE 2026-10-16)

- [x] Fetched remote. PR #18 (provider sign-in / iOS signing) MERGED. PR #19 (Cashfree INR web checkout) MERGED. PR #20 (HLD/LLD audit + dependency order) OPEN — used as baseline, not duplicated.
- [x] CI inventory: V5 native host build verification FAILED @ 52a36db (iOS simulator launching stale online.megaxo.prototype id); stale old-origin CORS/CSRF assertions partially addressed by d8d304b; several workflows still pending on d8d304b; V5 release engineering green.
- [x] Secured stray AuthKey_7MKUDPNAVR.p8 / AuthKey_YRCA4QUSF7.p8 from the repository root into ~/Downloads/Mega-XO-private-evidence/20261016-ios-signing/ (mode 600, outside Git) and removed the empty immutable=1 artifact.
- [x] Read PR #20 FINAL-OPEN-WORK-DEPENDENCY-ORDER-20261016.md, docs/v5.2/PR-REVIEW-20261016.md, docs/v5.2/MAIN-AGENT-HANDOFF-MONETIZATION-20261016.md.

## Stage 1 — Source/config hardening (CI-independent, start immediately)

| ID | Brief | Task | Pri | Deps | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| LR03 | A03 | Separate immutable deployment artifact from mutable epoch/serving authority state; fail-closed predeploy checks (epoch, schema, DB, host config, release image); wrong-target refusal + verified readiness with automatic rollback. | P0 | LR01 | PR OPEN | #25 |
| LR03A | A02 | Retire V4 Compose dependency: dedicated V5 edge-only orchestration; offline render test proving Caddy updates cannot recreate the SQLite app; V4 assets archived isolated. No live-host docker compose up. | P0 | LR03 | PR OPEN | #24 |
| LR04 | A04 | Selective X-Robots-Tag: indexable approved public pages, noindex retained for private/auth/staging/operator routes; external HTTP audit of robots/sitemap/canonical/redirects/404s. | P0 | LR01 | PR OPEN | #22 |
| LR05 | A05 | Live production health report complete (docs/v5.2/release/LIVE-HEALTH-REPORT-20261016.md): /opsz 503 root-caused to R2 listing truncation (fix #23), deployed-SHA drift none (2b60ed8/c172aa5 both ancestors of origin/V5.2), migration files 55=55, Redis Aiven ok, session/leaderboard/monetization surfaces verified, honest limits recorded. | P0 | LR01 | REPORT DONE | #21, #23 |

## Stage 2 — Identity, native and security preparation

| ID | Brief | Task | Pri | Deps | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| LR07 | B01 | Verify provider sign-in live end-to-end (browser, Android, iOS; same permanent actor; refresh/rotation/logout/revocation/expiry/cancellation). Fix gaps found in the integrated PR #18 implementation. | P0 | LR05 | TODO | — |
| LR08 | B03 | Align release identity online.megaxo.xoxo against real Apple/Google records; signing chains, entitlements, App/Universal Links, AdMob app IDs; reproducible signed AAB/IPA; device tests on owner phones without touching personal data. AASA placeholder fix PR'd (#26): live AASA served the literal TEAMID prefix — now substituted from APPLE_TEAM_ID fail-closed. assetlinks.json verified live (real upload-key fingerprint; Play App Signing cert to be added after first AAB). | P0 | LR07 | PR OPEN (partial) | #26 |
| LR10 | B02 | Transactional email (Resend): IMPLEMENTED as PR #27 — Resend transport (packages/services/mail-resend.js, ported from the proven V4 provider), durable OTP sink on ops.outbox (api_runtime INSERT per 0038; deterministic per-challenge ids; sealed with the worker-shared secret), policy factory extended (enabled requires the key via RESEND_API_KEY_FILE; disabled = unchanged stub), capability map for composability, enablement runbook in the PR for Main. Real-inbox delivery verification is the owner enablement step (Resend key + inventory flip). Merge order: after #26 (one-line conflict in v5-production-server.cjs). | P0 | LR05, LR07 | PR OPEN | #27 |
| LR06 | A06 | Security preparation evidence: session fixation, CSRF/CORS/origin, Core HMAC ingress, impersonation, ticket replay, rate limits, wallet integrity, idempotency, OAuth nonce/state/PKCE, payment/ad callback verification, caching, supply chain. Negative tests; Main signs off. | P0 | parallel | TODO | — |
| LR09 | — | Vercel auxiliary routing: canonical-origin HMAC path check; decide whether the two Hobby projects are needed; no commercial use on Hobby. | P1 | LR05 | TODO | — |

## Stage 3 — V5-authoritative monetization (PostgreSQL + signed Core only)

| ID | Brief | Task | Pri | Deps | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| LR12 | C01–C03 | Mount V5 monetization: DONE as PR #29 — signed commerce ingress (one allow-listed dispatcher), gateway commerceCommand/commerceSsv, apps/api/routes/monetization.js (status/ticket/claim/permit/purchase/cosmetic + actor-free AdMob SSV), commerce service composed on the Core-owned pool. ADDED (LR15 addendum commit 06f36cb): the AdMob SSV verifier (server/admob-ssv.js) composed as verifyAd whenever MEGA_AD_MODE is rewarded/hybrid, ad units from the ADMOB_* env, and the SSV route forwards the RAW signed query string; verifyAd null + ADS_UNAVAILABLE while adMode is off (fail-closed). Store verifiers remain the last enablement slice. API imports no commerce service and touches no monetization tables (asserted). | P0 | LR05, LR07 | PR OPEN | #29 |
| LR13 | C04 | Cashfree → additive PG DONE as PR #29 addendum 1221c12: migration 0056 (Core-owned monetization.cashfree_orders, api/worker get NO grant, backup_reader explicit SELECT, manifest+conformance), the db-free provider port (packages/services/cashfree.js, byte-compatible with PR 19), commerce createCashfreeOrder/settleCashfreeWebhook/cashfreeOrderStatus/refundCashfreeOrder (server-authoritative catalog price, (actor,op_key) replay fence, independent provider verification before any economic tx, receipt-mutex settlement, terminal refunded_at revoking remove_ads via the owned() projection), signed /ingress/commerce/cashfree/webhook actor-free path + session order/status routes, fail-loud composition (CASHFREE_APP_ID without the full config refuses boot). Receipts keep the ('google','apple') CHECK - the additive contract. Tests: 9/9 (offline + real disposable PG) + v5-p04 37/37 + migrations 11/11. | P0 | LR12 | PR OPEN | #29 |
| C05 | C05 | Polar (primary) / Paddle (fallback) global adapters behind feature flags: catalogs, server-side price/currency validation, signed webhooks, subscription lifecycle, sandbox evidence only. No live charge without owner authorization. | P0 | LR13 | TODO | — |
| LR15 | C06 | Entitlement semantics: Remove Ads suppresses only automatic ads (never voluntary rewarded ads); cosmetic credits; Premium Pass constraints; no Coins/Crowns rule changes; cross-device recoverable. | P0 | LR12 | TODO | — |

## Stage 4 — Gameplay powers (owner-approved limits, canonical rules preserved)

| ID | Brief | Task | Pri | Deps | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| LR14 | D01–D05 | Bot Undo (2 uses/match, canonical replay, no stale-bot regression); Casual Undo/Undo Block server adjudication (3 initiations, 1 applied undo, separate inventories, Core-owned response window); Tactical Power/Block (2 hints, 3 initiations, 2 valid blocks, block resolves before reveal, none in ranked/staked/tournament); banked powers (Crown or ad earned; idempotent bank/consume/refund/reconnect); UI labels Undo / Undo Block / Tactical Hint / Hint Block with a11y + all themes. | P0 | LR07, LR12 | TODO | — |

## Stage 5 — Research data, consent and retention

| ID | Brief | Task | Pri | Deps | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| LR17 | E01–E03 | Verify the live collector (eligible modes, provenance, immutable superseded branches, no day-one training) and one-time consent UI/withdrawal. | P0 | LR05, LR07 | TODO | — |
| LR18 | E04 | Retention/DR: real encrypted restore incl. privacy journal; enable 35-day backup prune only after safe-prune proof; 730d/90d/7d policy reconciliation; withdrawal/tombstone/export-revocation tests. | P0 | LR17 | TODO | — |

## Stage 6 — Stores and release readiness

| ID | Brief | Task | Pri | Deps | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| LR11 | B04 | Store records, assets, accurate age/audience ratings (12–14+ audience), privacy/data-safety + deletion disclosures, sandbox SKUs, signed build uploads, reviewer notes; submit review only when evidence complete. Record upload/submitted/in-review/approved separately. | P0 | LR08, LR10 | TODO | — |
| LR20 | F | Full device/browser acceptance journeys (18 listed): fresh install → guest → tutorial → accounts → bot/casual/ranked/tournaments → powers/ads/purchase sandboxes → reconnect → deletion → accessibility/themes/deep links. Exact build IDs; no simulator PASS claimed as device PASS. | P0 | LR07–LR18 | TODO | — |

## Stage 7 — Measured architecture (parallel, never a release blocker)

| ID | Brief | Task | Pri | Deps | Status | PR |
| --- | --- | --- | --- | --- | --- | --- |
| AR01–AR03 | G01–G03 | Instrument true baseline (HTTP/WS p50/95/99, event loop, pool waits, Redis RTT, sockets) → disposable realistic load/chaos harness (no public production stress) → optimize only verified bottlenecks with A/B evidence. | P1 | LR05, LR06 | TODO | — |
| AR04–AR07 | G04–G05 | Worker/outbox isolation, bounded socket backpressure, failover correctness — as measured need emerges; deployment topology changes go to Main. | P1 | AR02 | TODO | — |
| AR08 | G06 | Rust/io_uring transport experiment only if profiling proves socket handling is the dominant limit. No rewrite. | P3 | AR01–AR05 | TODO | — |

## LAST — deferred per owner directive

| ID | Brief | Task | Status |
| --- | --- | --- | --- |
| LR02 | A01 | CI failure resolution. Main is on it now. End-of-run: check all 14 workflow families on final exact head; fix only remaining failures (root-cause first, regression tests, no security weakening). Currently: iOS simulator prototype-id launch family + any stale old-origin CORS/CSRF expectations not already fixed by d8d304b. | DEFERRED (Main) |

## External holds (keep safely disabled; never claim done)

- Paddle verification "In progress" (fallback gateway) — dashboard-gated.
- Cashfree KYC/VCIP + category approval; no live charge/plan without explicit owner authorization.
- AdMob SSV callback URL saved only after live V5 endpoint exists (LR12); native builds keep real app IDs.
- Store review submission only with complete evidence package; Main owns release/cutover.
- No owner re-approval required for already accepted website look/tutorial/economy; do not repeat the V4→V5 cutover.

## Checkpoint log (append per substantial milestone — Workstream J format)

### Checkpoint 1 — 2026-10-16 (Stage 1 start)

**Completed:** Phase 0 reconciliation; LR04 implemented end-to-end (source + tests + live-probe evidence) and pushed as PR #22; board created as PR #21. Stray AuthKey_*.p8 files secured out of Git (mode 600).

**LR05 partial evidence (external HTTP, 2026-10-16 ~03:00 UTC):** apex 200; www 301→apex; retired play.antimatterinnovations.com 308→apex; unsigned core ingress 401 (fail-closed); /livez + /readyz 200 JSON; **/opsz 503 {ok:false}** (backup-freshness or outbox contract red — needs VPS read-only confirmation); /api/monetization/* 404 (expected until LR12); global noindex + missing CSP confirmed (fixed by PR #22, pending merge/deploy).

**Testing:** v5 production server 12/12 (2 new LR04 tests); web-build all pass (updated DELIVERY-01); p21-seo 6/6; production-lifecycle all pass. Node --test runner leaks zero-concurrency children in this environment — per-file direct runs used; CI on PR SHA will confirm.

**Open work:** LR05 VPS-side checks (deployed SHA vs origin/V5.2, freshness file, migration head); then LR03/LR03A; LR02 stays deferred (Main).

### Checkpoint 2 — 2026-10-16 (LR05 VPS read-only audit)

**Finding (P0, fixed by PR #23):** /opsz 503 + mega-xo-v5-freshness.service failed + mega-xo-v5-health.service failed. Backup pipeline HEALTHY (verified R2 upload+readback every 5 min). Root cause: v5-r2-client.js list() used a single max-keys=1000 page — at 500 backups (2 objects each) the key-ordered page truncated to the OLDEST backups, so freshness never saw manifests newer than 2026-10-15T21:51:31Z (consecutiveUnhealthy: 60, V5_BACKUP_STALE beyond the 900 s RPO). Fix: paginated list with fail-closed cap; 4/4 offline regression tests. Main deploys the bin script per PR #23 steps; expected /opsz to return 200 within one 5-min cycle.

**Other observations:** mega-xo-v5-production.service (the authority) stayed active/running — no player-facing impact. Legacy mega-xo-health.service unit failed (V4-era, flagged for LR03A cleanup). Backup prefix grows unboundedly until LR18 safe-prune — the 100-page cap fails closed loudly if retention lags. Host backup-policy.json RPO=900 s confirmed.

**Next:** remaining LR05 probes (deployed SHA vs source, migration head, Redis, WSS, session/matchmaking), then LR03/LR03A deployment-safety PRs.

### Checkpoint 3 — 2026-10-16 (Stage 1 complete)

**Completed:** LR05 finished (LIVE-HEALTH-REPORT-20261016.md on this PR; deployed SHA = repo ancestors, no drift; migration file parity 55=55; Redis/readyz/asset self-check green; session+leaderboard API verified; one transient 502 on /api/account/session noted, not reproducible). LR03A PR #24 (compose fence: the live host project was still loaded from the V4 file with the SQLite app defined — now edge-only + profile-fenced + real docker compose render tests). LR03 PR #25 (fail-closed deploy guards: epoch/runtime/inventory/target/schema predeploy refusals, unconditional host-managed restores, verify-or-auto-rollback swap). LR04 PR #22, /opsz fix PR #23.

**Testing:** deploy guards 4/4; compose-fence 4/4 (real docker compose config renders); r2-pagination 4/4; prod-server headers 12/12.

**Open work:** Stage 2 (LR07 provider sign-in verification, LR08 native identity, LR10 email, LR06 security prep). LR02 CI deferred to last (Main actively landing CI docs commits on V5.2: 2d08b84).

### Checkpoint 4 — 2026-10-16 (LR07 live verification + LR08 AASA fix + LR10 implemented)

**LR07:** Google sign-in verified END-TO-END on production (initiation with PKCE/nonce/state + canonical redirect, consent, callback, permanent actor player_f6ecb6a6f4, sign-out invalidation, re-sign-in restores THE SAME actor + wallet). Apple initiation verified correct (canonical Services ID, redirect, state/nonce); roundtrip blocked on owner Apple credentials (documented in LR07-PROVIDER-SIGNIN-LIVE-20261016.md). Native device lane deferred to LR20.

**LR08:** live AASA served the literal TEAMID placeholder — fix PR #26 substitutes the real team id from APPLE_TEAM_ID fail-closed (4/4 tests; p11 foundations green). assetlinks.json verified live.

**LR10:** full durable chain implemented as PR #27 (see LR10 row). 9/9 offline tests + production-lifecycle green.

**PR queue for Main:** #22 SEO/headers, #23 /opsz root cause, #24 compose fence, #25 deploy guards, #26 AASA team id, #27 email (after #26), #21 board+evidence.

### Checkpoint 6 — 2026-10-16 (LR12 commerce mount)

**LR12 implemented as PR #29** (based on origin/V5.2 @ e4e2ee4 — Main landed a monetization-browser-fixture SIGTERM fix there; that fixture exercises the legacy V4 lane and is untouched). Full chain: API route (actor resolution + client op keys) → signed /ingress/commerce/command → one allow-listed dispatcher → the Core-owned commerce service. SSV path is actor-free + signature-protected; grants fail closed until verifyAd/verifyPurchase/eligibility are configured (next slice). 4/4 ingress tests + production-server/gateway/contracts/lifecycle suites green.

**Next:** LR15 provider verification slice (AdMob SSV verifier wiring + store verifier) to make the mounted surface enableable, then LR16 flags/enablement runbook.

### Checkpoint 7 — 2026-10-16 (LR15 AdMob verifier wired; store-port plan)

**LR15 AdMob SSV: WIRED (PR #29 addendum commit 06f36cb, stacked on the LR12 mount).** verifyAd composed from server/admob-ssv.js whenever MEGA_AD_MODE is rewarded/hybrid (ECDSA vs Google's published gstatic keys, 24h cache — no secret material); ad units from ADMOB_* env; the SSV route forwards the RAW query string Google signs (the object shape would have failed the ECDSA check — fixed and tested). Fail-closed: adMode off → verifyAd null → ADS_UNAVAILABLE. Enablement for Main: set the ADMOB_* units + MEGA_AD_MODE=rewarded, register the SSV URL in the AdMob console (documented on PR #29).

**Store verifier (verifyPurchase/purchaseProvider): PORT PLAN, deliberately not half-wired.** Survey: StorePurchaseProvider({google,apple}) is db-free, but GooglePlayBilling(db,...) and AppleStoreKit(db,...) persist against V4 SQLite tables v41_store_revocations / v41_store_finalize via db.prepare. A correct V5 port needs: (1) additive PG tables for revocations/finalizations, (2) a prepared-statement adapter or rewritten statements per provider, (3) the notifications lane (GooglePlayNotifications/AppleStoreNotifications) for renewals, (4) tests incl. refund-revocation ordering. Rushing it would risk purchases without refund propagation — deferred to a dedicated slice with the schema migration.

**Next:** the store-verifier PG port slice (schema + adapter + notifications), or the native device lane if the owner prefers builds first.

### Checkpoint 8 — 2026-10-16 (store-port architecture correction)

**FINDING that changes the store-port plan:** monetization.store_revocations / store_finalize / store_notifications ALREADY EXIST in the migration chain (0015, with the V5 state machine incl. the terminal abandoned state), with a DELIBERATE grant split: worker_runtime owns the finalize/notifications sweeps (SELECT/INSERT/UPDATE, 0022), core_runtime is DENIED the finalize sweep (asserted by tests/v5-migrations least-privilege), and core holds SELECT/INSERT/UPDATE on store_revocations (0021) for the verify-path revocation check. A draft 0056 migration that re-created the tables with core grants was REVERTED after the least-privilege suite caught it — the existing schema and grants are the contract.

**Correct store-port architecture (next slice):** (1) the VERIFY path (revocation check) uses a core-pool adapter — SELECT on store_revocations is already granted; (2) the store_finalize INSERT + processDue SWEEP must run on the WORKER pool (worker_runtime grants already cover it) — so GooglePlayBilling/AppleStoreKit instances need TWO adapters or the finalize-row insert must move to the worker app's store lane; (3) no new migration is needed at all. The prepared adapter (packages/services/store-pg-adapter.js, kept untracked on disk with its 4/4 test) already maps the five provider statements to the existing monetization.* tables and refuses unknown SQL.

**Also landed (PR #29 addendum 8d2883f):** the monetization route dispatch in apps/api/index.js + the signed commerce facade on apiContext (placed outside the literal to avoid conflicts with #27/#28). Suites green: v5-migrations 2/10 fail->0 fail after revert (all pass), production-server, monetization-store.

### Checkpoint 9 — 2026-10-16 (store verifiers landed on PR #29)

**LR15 store lane LANDED as PR #29 addendum a80b00b:** GooglePlayBilling/AppleStoreKit composed under the deployed role split through packages/services/store-pg-adapter.js — revocation check on the CORE pool (0021), every store_finalize write/read on the WORKER pool (0022), legacy DELETE → the TERMINAL abandoned state (0015 state machine), created/updated aliased to the 0015 columns. The draft 0056 migration from checkpoint 8 was REVERTED (the least-privilege suite caught its core-grant hole — the existing schema/grants are the contract) and NO schema change ships. Composition: purchaseProvider built only when MEGA_PURCHASES_ENABLED=true AND the store env parses (fail-loud INCOMPLETE_*/INVALID_* otherwise). Commerce-ingress 4/4 + store-adapter 6/6 + migrations/production-server/monetization-store all green.

**Monetization enablement (Main, after #29 merges):** ads = ADMOB_* units + MEGA_AD_MODE=rewarded + the AdMob-console SSV URL (documented on the first addendum); store = GOOGLE_PLAY_SERVICE_ACCOUNT_JSON + GOOGLE_PLAY_PACKAGE_NAME + GOOGLE_PLAY_PRODUCT_* SKUs + MEGA_PURCHASES_ENABLED=true (documented on the second addendum). Until then every grant path refuses, exactly as the brief requires.



### Checkpoint 10 — 2026-10-16 (LR14 powers audit + LR06 gaps closed)

**LR14:** the shipped powers-1 policy constants match EVERY owner-approved limit exactly (bot undo 2/match + 1 package, casual 3 initiations/1 applied, hints 3 activations/2 deliveries, blocks 3 activations/2 successes, banked capacity 1 with no expiry, the shared 10/UTC-day rewarded cap) — recorded in LR14-POWERS-AUDIT-20261016.md. Powers suites green (v52-p21-powers, staging-public-head). Remaining: the cross-device same-game pass (LR20) and the live-SSV proof (LR15 enablement).

**LR06:** both named gaps CLOSED with evidence — the session-fixation refusal is asserted in v5-p04-repositories (rotate consumes exactly one row; the rotated bearer's live() is null; replaceSession refuses on double-consume) and npm audit returned ZERO vulnerabilities across 24 prod dependencies. The matrix now has two structural gaps remaining (LR12 rate-limit negatives with the routes, device-lane security).

**LR18:** the P0 finding documented — production retention sweeps target the STAGING database (the DC00-installed units run the staging capture-job.sh); Main's six-step corrective procedure is on the report; the backup-prune gate is accidentally intact and must stay disabled until the safe-prune proof.

**Queue for Main:** #29 (LR12+LR15 commerce/SSV/store), #28 (consent UI + harness fix), #27 (email + validate fix), #26 (AASA), #25 (deploy guards), #24 (compose fence), #23 (opsz), #22 (SEO/headers), #21 (board + six evidence reports), #20 (WebUI audit).

### Checkpoint 11 — 2026-10-16 (merge-order proven by dry-run)

**The full eight-PR stack merges CLEANLY.** A throwaway worktree at origin/V5.2 (e4e2ee4) merged all eight PR heads in sequence — 29, 28, 27, 26, 25, 24, 23, 22 — every merge exited 0 with ZERO conflicts, the merged tree passes node --check on all five touched runtime files, and the five new test suites (commerce-ingress, store-pg-adapter, mail-resend, consent-ui, apple-team-association) all pass on the merged tree (EXIT 0). **Main can merge in any order; the documented order is confirmed safe.**

**LR06 final gaps:** the session-fixation and npm-audit gaps are CLOSED with evidence (the matrix updated); the two structural gaps remain (LR12 rate-limit negatives now UNBLOCKED by #29, device-lane security).

**URGENT for Main (before Mon 2026-10-19):** the LR18 P0 finding — the production retention timers run the STAGING capture-job.sh; the corrective procedure is in LR18-RETENTION-DR-LIVE-20261016.md. The next scheduled retention run is Monday.

### Checkpoint 12 — 2026-10-16 (LR09 Vercel verification + LR06 gaps closed)

**LR09:** live probes show NO live Vercel auxiliary surface — both project subdomains answer DEPLOYMENT_NOT_FOUND, so no reachable Vercel lane could bypass the signed ingress or the canonical-host checks. The canonical origin (200) and the Core edge (401 unsigned) are unaffected. The Hobby noncommercial constraint is moot while nothing is deployed. Recommendation: keep the projects parked. Report: LR09-VERCEL-AUX-LIVE-20261016.md.

**LR06:** both named gaps CLOSED with evidence — the session-fixation refusal (v5-p04-repositories: rotate consumes exactly one row; the rotated bearer's live() is null; replaceSession refuses on double-consume) and npm audit ZERO vulnerabilities across 24 prod deps. Two structural gaps remain (LR12 rate-limit negatives, device-lane security). The matrix is current.

**LR14:** the shipped powers-1 constants match EVERY owner-approved limit (recorded in LR14-POWERS-AUDIT-20261016.md); the powers/staging-head suites are green.

**URGENT for Main (before Mon 2026-10-19):** the LR18 P0 finding — the production retention timers run the STAGING capture-job.sh; the corrective procedure is in LR18-RETENTION-DR-LIVE-20261016.md.

### Checkpoint 13 — 2026-10-16 (LR19 telemetry implemented)

**LR19 telemetry LANDED as PR #29 addendum bfd1b8c:** the minimal OPTIONAL lane per the P1 brief item — daily-aggregate counters on ops.rate_buckets (one row per day per event kind; no actor column, no per-event history, no free text, no age/gender/geo/location kinds — all asserted), an anonymous POST /api/metrics/batch route (no session resolution, bounded batch, 405/400/503 shapes), and a client lane that is OFF by default (only an explicit storage flag enables it; the privacy-choices toggle is the next UI touch). ZERO schema change. Tests: metrics 4/4 + production-server/migrations/monetization-policy all EXIT 0. The counters stay EMPTY until a player opts in — dormant by construction.

**ALL IMPLEMENTABLE BACKLOG SLICES ARE NOW PR'D, including the LR19 opt-in UI (addendum 4: the privacy-choices telemetry panel + the lane lifecycle + the metrics.js build entry — the privacy-choices toggle is complete end-to-end).** The remaining lanes are: Main's merges/deploys + the LR18 retention retarget (before Mon 2026-10-19) + the DB-level passes + the independent security audit; the owner's enablement steps (Apple credentials, AdMob console SSV URL, Resend key, store credentials) and the two phones for the device pass (LR20); and the deferred CI sweep (LR02) — which Codex takes LAST on the merged head once the queue lands.

### Checkpoint 14 — 2026-10-16 (P0 SSV chain fix + LR13 Cashfree V5 port)

**P0 FIX (PR #29 addendum 3233d4b): the AdMob SSV callback chain was broken end to end.** The gateway dispatches /ingress/commerce/ssv with an EMPTY actor by design, but the ingress demanded a session actor on every op — every live callback was refused INVALID_ACTOR; worse, the API route rode the player command surface (commerceCommand), which drops the raw payload entirely and has no actor to sign with. The ssv op is now actor-free in the allow-list dispatcher, the route uses the dedicated signed commerceSsv lane, and a regression test covers the exact gateway dispatch shape.

**LR13 LANDED as PR #29 addendum 1221c12** (see the Stage 3 row). The provider order creation is server-side with the SERVER-AUTHORITATIVE catalog price (89/449/899/199 INR — the PR 19 legacy amounts), the (actor, op_key) unique fence makes creation idempotent, the settlement requires an INDEPENDENT provider PAID verification with the exact recorded amount (a captured webhook, a browser return or a replayed signed webhook alone never grants), and the refund marks the terminal refunded_at under the same order-identity mutex so a refunded remove_ads is revoked structurally. The receipts ('google','apple') CHECK is UNTOUCHED; the ledger journal keeps the frozen 0010 source vocabulary.

**Testing:** v52-cashfree-v5 9/9 (provider unit, ingress arg order incl. the actor-free webhook, and the REAL disposable-PG integration: idempotent creation, settle-once, ORDER_AMOUNT_MISMATCH, foreign-order hiding, refund revocation); the FULL v5-p04 services contract suite 37/37 over a real PG16 (the commerce service's own suite — the new lane rides the same keyed-transaction/uow machinery); migrations 11/11 on the real checksummed chain (the least-privilege suite caught a missing backup_reader grant in the draft 0056 — fixed before landing); production-server 10/10; monetization-store/policy green. One transient environment note: the machine's temp volume hit 100% during the first real-PG runs (stale datadirs from interrupted runs); all test-owned datadirs were stopped and removed (~800 MB recovered) and the harness now stops its backend on process exit.

**Next:** LR12 rate-limit negatives (the last closable LR06 structural gap, unblocked by the mounted routes), then the LR20 device lane if the phones are in scope, then review fixes from Main's audit. LR02 CI stays deferred to LAST per the owner directive.
