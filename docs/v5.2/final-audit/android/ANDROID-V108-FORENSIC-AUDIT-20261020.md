# Mega XOXO — Android direct APK 1.0.8 deep code audit

**Review time:** 2026-10-20 UTC/IST boundary; repo `V5.2@73fa00423c8af2cfb244bb08ff32437a5ed59bfe`, deployed APK's source `edbf8f4d0960`.
**Scope:** signed online direct APK and bundled web client, native Android bridges, game/AI, Core API, learning, economy, store, privacy and CI evidence.
**Mutations:** read-only Neon SQL; this branch's only functional edit repairs the client power-spend route. No live DB, provider, app, server or APK deployment is changed.

## Artifact provenance and confidence

| Field | Release evidence |
| --- | --- |
| Name/code | 1.0.8 / 9 |
| Package | `online.megaxo.game` |
| Direct binary | `/downloads/android/megaxo-1.0.8.apk` |
| SHA-256 | `de22fb91c3c7697d7bf001b15b32a2bf7466140fcbdc1b070d8450503fd87eb3` |
| Bytes | 24,000,791 |
| API origin | `https://megaxo.online` |
| Source released | `edbf8f4`; rollout receipt in `docs/v5.2/final-audit/evidence/AUDIT-DECISION-LOG.md` |
| Device confirmation | Owner reports “1.0.8 works” following 1.0.5 auth regression; not a two-user tournament/payment/ads matrix |
| Independent binary decompile | **NOT RUN** in this audit: repository and signed release receipt inspected; do not label binary parity independently verified |
| CI | Bot/tutorial, Android/native platform, P21, gameplay-capture, service/recovery/audit suites green at release; V5 PostgreSQL job on release SHA cancelled when superseded, succeeding on descendant HEAD. Not a physical-device acceptance run |

**Important:** APK client code is frozen into the signed asset bundle, not fetched from the currently running website. Fixing a `src/` file requires a new signed APK, versionCode increment, checksum validation and user-side install. Do not mark a web-only deployment as an APK fix.

## Severity-ranked confirmed findings

### APK-108-01 | P0 product objective — Impossible training collector inactive
**Direct, production-Neon read-only evidence (blue-sun-85454968 / mega_xo_v5_production):**
`learning.configuration()` = `{enabled:false,rulesHash:null,environment:null,privacyEpoch:4,sourceCommit:null,policyVersion:null}`.
`learning.metrics()`: `sealed=0,pending=0,quarantined=0,excluded=0`; the `learning.consent` table has zero rows; no learning capture/export rows. The 14-table learning schema is installed, and ordinary `match.matches` still contains two FINISHED unranked matches.
Implementation: `packages/learning/capture.js`, `worker.js`, `release-gate.js`, `scripts/gameplay-capture.cjs`; policy is deliberately fail-closed. Neither web nor APK should silently treat the presence of the schema as captured training data.
**Action:** launch a privacy-reviewed, opt-in human-gameplay canary: expose the signed-in research choice in the native APK (`GET/POST /api/account/research`, endpoints already authorized by the native wire policy), record affirmative/withdrawal, validate capture/worker/reconciler/deletion, positive eligible source, restore/restart and model export gates. Only then enable capture under exact approved rules/source/retention receipt. Do not enable or backfill without source/research authorization. Offline bot games are not an authoritative online training source; any voluntary future practice upload must be explicitly consented and marked `unverified-client-practice`, NEVER included silently as human-v-human.

### APK-108-02 | P0 roadmap — Impossible bot is not playable
`src/bot/pack.js` explicitly `APPROVED_CATALOG=Object.freeze([])`; `src/bot/pack-ui.js` tells the truth: no approved model. The optional model download UI blocks the Android `appassets.androidplatform.net` origin; the default five classical bots run via `src/game.js` / `src/bot/runtime.js`. Neural worker/contracts/search/ONNX pieces exist but *must not be equated* with a qualified release candidate. A reviewed model needs measured strength/latency/memory and an Android-safe pinned-download architecture, not an arbitrary file/catalog flag.

### APK-108-03 | P1 broken current feature — signed-in Crown power purchase
`src/app.js:84` calls `NET.powersSpend(kind,id)`; released `src/network.js` constructed `POST /api/v1/monetization/powers/spend` with `{kind}`. Current API only mounts `POST /api/monetization/powers/spend` with `{itemId}`, dispatching to `op:'power_spend'`. This is a source-proven path + DTO mismatch, not an inferred server failure. **Fixed in this PR in the client adapter only**, with cross-layer route/idempotency contract unit tests. Requires a new APK build, Codex review and actual signed-in balance/charge test. Do not modify rewards amounts or grant rules.

### APK-108-04 | P1 conditional feature — Bot Undo/Hint rewarded ad ticket incompatible
`src/powers-ui.js` requests `reward-ticket` for `kind:'undo'|'hint'`, whereas `packages/services/commerce.js` currently accepts only `'credits'|'boost'`. Consequently no Core-issued ticket supports these power kinds, even if the native AdMob bridge is compiled. The real deployment receipt says ad mode off; do not turn it on until design/SSV, per-match entitlements and negative tests are aligned end-to-end. Earned callback itself is **not** wallet/grant authority. Cosmetic Credits rewards are a different contract.

### APK-108-05 | P1 legacy gameplay economy — archival Coin cosmetic action still exposed
`src/app.js:784` invokes `NET.cosmetic`; the adapter constructs `/api/v1/cosmetic`, which `packages/contracts/routes.js` explicitly documents as an archived 404 route. The modern `/api/monetization/cosmetic` uses Cosmetic Credits and `{itemId}` rather than old Coins/legacy display names. **Do not redirect automatically**: it would silently change product economics and entitlements. Owner/agent should retire/migrate legacy UI or implement a correct legacy fulfillment contract with clear wallet semantics.

### APK-108-06 | P1 future Play Store path — restore URL missing
The in-client `src/monetization-ui.js:120` sends `POST /api/monetization/restore`. The Core monetization router declares only `/api/monetization/purchase` with body `{evidence,restore}`; no mounted `/restore` route is found. The current DIRECT APK intentionally sends purchases to the website instead of Google Play, so this is a **store-submission/Play build blocker**, not evidence of an observed direct-APK refund or purchase failure. Reconcile restore request with the verified provider contract before Google Play launch, with idempotency/account-bound purchase proof and refund negative tests.

### APK-108-07 | P2 legacy friend routes
`src/network.js` still has `/api/v1/friend` and `/api/v1/accept-friend`, while the mounted `apps/api/routes/social.js` serves `/api/community/friend` and the live community UI uses that newer path. `apps/api/routes/competitive.js` does not dispatch these legacy paths. Review whether any rendered legacy buttons still reach them; remove dead handlers or consolidate to the current actor-authorized social API. Avoid duplicating friend mutation semantics.

### APK-108-08 | P2 transfer/free-tier efficiency
Signed-in community client polls presence/friends about every 15s while foregrounded; active queue polls queue status/invitations every 1s (`src/app.js:480–484`). These are **not zero-user idle polls**, but multiple active phones can amplify Neon transfer. Benchmark per-session payload/SQL counts, use request dedupe or trustworthy event notification when justified. Never give up match correctness or prompt incoming requests to save quota.

## Feature inventory: code state versus real-world proof

| APK feature | Code verdict | Acceptance still needed |
| --- | --- | --- |
| Offline ultimate tic-tac-toe, legal moves, mini/Mega victory | Canonical `src/game.js`; high-confidence implementation and tests | Device game completion and restore across process kill |
| Bot Beginner/Easy/Medium/Hard/Expert | Five classical levels, worker results revision-fenced, time-bounded | Real phone latency, strength benchmarks, both X/O starts |
| Impossible | Core components exist, no approved pack | Reviewed model, appassets download/runtime and device benchmarks |
| Guided practice/tutorial | Six-move guided route, captions, optional device voice, resume logic | Cold-start tutorial, skip/resume, optional voice on hardware |
| Pass & Play | Local deterministic rules; no trusted network economy | Complete match and rematch on physical devices |
| Ranked/Casual online | Authenticated client queue, invite/move/resign, authoritative Core contracts | Two real identities, both turn orders, reconnect, expiry, duplicate move |
| Friends/challenges/blocked accounts | Current `/api/community/*` code implemented | Two-actor permission/privacy/notification test |
| Private LAN party | Android LAN socket and NSD components exist | Two phones on same Wi-Fi, Android permission variants, replay/leave |
| Public tournaments | Core/worker rule/state code exists | Ten real/simulated entrants, settlement/timeout/refund proof |
| Undo and Tactical Hint | Local adapter shipped with guards; Crown paid path broken in released 1.0.8 | Corrected APK, bank/use/undo-turn and refund/error tests |
| Undo Block / Hint Block | Explicitly disabled: authoritative PvP counter protocol absent | Design+implementation; do not misrepresent as active |
| Themes | Four shipped in APK (`vector,midnight,paperclub,afterhours`) | Device screenshots at small/large DPI; saved theme across restart |
| Stats/quests/rating/Coins/Crowns | Implemented with authoritative server vs offline local wallet split | Currency provenance, repeated intents, week/season boundaries |
| Cosmetics | Modern Credit catalog exists; old Coin action obsolete | Resolve migration of legacy UI and credits |
| Direct APK website purchases | Routes to external website store; no native token transfer | Same profile linking across website/browser; provider settlement |
| Google Play Billing/restore | Native Billing class exists, but direct APK uses website | Store-bound AAB, real provider purchase/restore/refund, route mismatch |
| Ads/rewarded power/cosmetic credits | UMP/AdMob SDK integration present; deployment ads off; power tickets incompatible | Live ad units, SSV, consent, privacy, restoration after interruption |
| Email/Google native sign-in | Native secure bridge, cookie-free HTTP, Keystore vault; owner reports 1.0.8 works | Sign-out/reinstall, 5-min token expiry, 401 recovery, OTP/reset on device |
| Local notifications | Android permission opt-in and device-alert bridge | Android 13+ prompts, background/denial/re-enable |
| Accessibility, sound, reduced motion | Settings, semantic labels, local voice as available | TalkBack, contrast, keyboard, accessibility service tests |
| Data export/account deletion | Routes/UI included | Authenticated delete/export E2E and backup/retention propagation |
| Human gameplay ML capture | Schema/service installed, OFF, no archived games/consent | Consent, enabled worker/reconciliation/export and audit receipt |
| Physical APK security boundary | AssetLoader signed origin, TLS-only configured host, no JS bearer, redirects blocked, release no WebView debug, file access off | Binary inspection, actual merged manifest and dynamic negative tests |

## Evidence limitations and release decisions

- CI at `edbf8f4`: bot/tutorial tests green, P21 web/native lane green, gameplay-capture contracts green, service/recovery/audit checks green. PostgreSQL job cancelled on that SHA due to supersession; on later source HEAD `73fa004` the integration job passed. Component/contract tests are not full physical Android E2E.
- Signed binary digest/bytes and live delivery are grounded in pinned manifest and deploy receipt, not an independent APK byte-by-byte decompile in this audit.
- No broad unauthorized production request traffic, paid purchase, device ad view, provider login, private-account read, quota-changing Neon action or mutation was performed.
- Owner's “1.0.8 works” confirms restored normal APK sign-in/play, not Impossible/ads/economy/2-player correctness.
- Deployment of this PR's client correction needs versionCode **greater than 9**, same signing lineage, exact manifest/hash/digest and real-device acceptance. Do not silently overwrite or call the current 1.0.8 artifact “fixed.”

**Independent readiness verdict:** 1.0.8 is a credible stable test build for basic offline/online play, but **NOT feature-complete for Impossible training/model, paid Bot powers, future store restore and unavailable counters**. Preserve its working authentication; close source-confirmed cross-layer mismatches with tests and measured device validation before marking launch-ready.
