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
| LR13 | C04 | Cashfree → additive PG commerce.cashfree_orders + Core-verified idempotent settlement/refunds, raw-body webhook verification, independent provider paid-status retrieval, actor-bound access. Reuse PR #19 provider adapter; do not grant on browser return. | P0 | LR12 | TODO | — |
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
