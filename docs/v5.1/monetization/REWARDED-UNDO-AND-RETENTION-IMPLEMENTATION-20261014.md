# Mega XOXO V5.1 — Rewarded Undo, Fair Assistance and Retention Implementation Pack

**Plan date:** 14 October 2026. **Audited source:** `V5.1` at `1b94f645f82e7ffd485a998cd3a612348a32fbdb`. **Status:** engineering/product implementation plan, **not implemented features**, not production approval. **Integration branch:** `V5.1` only. Retain `main`, `V4.1`, V4 live authority, game rules, coins/crowns and all shipped themes untouched until an implementation PR has been tested.

**User input:** the uploaded *Mega-XO_Ad_Monetization_Consolidated_Notes.md* (14 October 2026, 485 lines). This private research note is **not republished** into the public GitHub repository, because it quotes purported third-party reverse-engineering excerpts. Below, "[research]" identifies an idea in the note; "[repo]" a direct check against the audited V5.1 source; "[proposal]" the new implementation; "[external]" a current official provider policy or API reference. Hypothetical eCPM/LTV/churn numbers in the note are not observed Mega XOXO metrics. No evidence proves universal forced-loss behavior by the other game.

## A. Decision and scope

**Product direction:** offer valuable, **player-initiated** rewarded assistance. **First implementation:** "Watch an ad to undo" in **eligible Vs Bot** matches. **Second, separate implementation:** unranked **online Casual** only if *both players agree* and Core implements an authoritative consent/clock/undo protocol; this is **not** the same as the local single-player rewind. Tutorial remains free and non-monetized. Keep the current Rewards & Themes cosmetic grants. Forced interstitials, if enabled at all, occur only at existing natural result-to-home breaks.

**DO NOT** manipulate offered legal moves, increase AI strength after an ad, manufacture near-misses, alter win probabilities based on ad value/geography/device, inflate Elo/Crowns/Coins, silently change bot difficulty, force an ad during a match, or let a browser client rewrite an online match. The research's `ZHI_SI_TI`, high-eCPM "death" behavior, and MAB arms are **observations/hypotheses** about another game, not Mega XOXO design specifications.

### Current game-mode applicability (verified against `src/app.js`, `src/game.js` and `src/domain.js`)

| Mode | Proposed rewarded undo | Rationale |
| --- | --- | --- |
| Guided tutorial / `practice=true` | **No ads**. Optionally teach a free undo in a separate lesson. | Keep comprehension, zero tutorial earnings and new-player experience intact |
| `mode='bot'`, signed/native, meaningful non-practice session | **Phase 1 YES**, player-initiated, bounded and local-only. | Replay authoritative *local* immutable moves; no other participant is harmed |
| Offline-only Android or offline browser practice | **No network/ad requirement.** Never block normal play. | Offline build intentionally removes INTERNET; ad SDK cannot serve inventory |
| `mode='local'` Pass & Play | **Separate free/manual undo**, if both humans agree; **not an ad placement** in initial rollout. | Both players use one device; avoid forcing player 2 to sit through player 1's ad |
| `mode='casual'` online queue (unranked) | **Phase 2 CONDITIONAL**, both players consent to a Core-authorized rewind; launch flag OFF initially. | Casual is live server PvP even though unranked and may pay Cosmetic Credits |
| Ranked, direct/friend challenges (including nonrated until separately reviewed), tournament, wagers, prizes, LAN matches, leaderboard submissions | **NO** for initial scope. | Preserve single Core authority and original multiplayer/economy contracts |
| `Impossible` optional model | Excluded until a model is independently approved; never change the model/seed as part of rewind. | Maintain pinned model and benchmark claims |

**Recommended starting limits, to test rather than assume optimal:** 1 completed turn rewind per eligible Bot match; 2 rewarded rewinds per UTC day; at least 8 legal plies before an offer; 2-minute rewarded gap, **sharing the existing 4 rewarded starts/day cap** (Credits/boost/undo together). No popup spam: show only after the player taps Undo or on a genuine Bot-caused defeat with a quiet "Undo with ad" choice and "Accept result" alongside it. Hide when consent/SDK/reward inventory is unavailable; no forced waiting, click or install. Owner may adjust these *new* limits via explicit, bounded configuration; the pre-existing 4/day cap, rules and economy do not change automatically.

**Initial assisted-result policy [proposal, owner acceptance required]:** mark any rewinded Bot run `assisted=true` and count it in a separate "assisted practice" history; do **not** mint Bot Coin payouts, ranked Elo, quest progress, streak rewards, or monetary/competitive awards from that result. The UI must disclose "Assisted match — no Coins or ranked rewards" before the rewarded ad. This avoids creating an indirect ad-to-Coin advantage while retaining an enjoyable local game; this is a proposed feature policy, not a claim that the current `D.complete` already implements it. Unassisted Bot wins keep their original rewards and limits unchanged. For future PvP Casual, decide separately how `2 Cosmetic Credits` per qualifying free game interacts with any consented undo; **default is no credit from assisted Casual matches** until the settlement contract is reviewed.

**Release posture:** this is new work on V5.1, **not automatically day-one release-critical** simply because this document was commissioned. The owner or Codex must record `AD_LAUNCH_SCOPE` = `off` | `rewarded_solo_beta` | `full_reviewed` in the existing exact-build launch record. Until that decision and all eligible test/provider gates pass, retain `MEGA_AD_MODE=off` and no live ad serving. If owner explicitly includes solo undo in day one, the mandatory release dependency includes tasks AM00–AM18 and the product acceptance gate.

## B. Actual repository audit — what already exists and what does not

| File or boundary | Verified finding and required delta |
| --- | --- |
| `src/game.js` | Canonical `G.create/`G.legal/`G.apply` already returns immutable board/move snapshots. A rewind must reconstruct from the **saved legal ply list** and compare replay with current state; do not add a hidden rule exception or mutate prior `G.apply` outputs. |
| `src/app.js` | Local `startGame` at ~224, `move` at ~269, `scheduleBot` ~275, `finish` ~300, `save` ~31 and `resumeOffline` ~360. **`finish` currently marks `recorded=true` and calls `D.complete` immediately**; post-loss undo therefore needs an explicit pre-finalization state and crash-safe recovery to avoid a previously settled outcome being replayed. The bot Worker/Neural runtimes also require cancellation/revision fencing before rewind. |
| `src/domain.js` | `D.complete` awards bounded Bot Coins, quest progress and records; only called at most once for a finalized result. **Do not** use an ad to change `elo`, rating, wealth or Crown conversion. Add an explicit assisted-result disposition with regression tests instead of bypassing `D.complete` checks. |
| `src/monetization.js` | Existing `POLICY`: first auto-ad age **24h**, first **5 qualifying Bot games**, **3 games + 8 active minutes** between interstitials, global full-screen gap **8 min**, max **2/session/6/day** automatic, rewarded **4/day** and **2 min** gap. Interstitials are currently Bot result-to-home only. **Keep these defaults.** The research's 3/4/5/7-minute options are optional hypotheses for later A/B; do not silently reduce existing protections. |
| `src/monetization-ui.js` | Existing Rewards & Themes offers **5 Cosmetic Credits** or **10-minute 2x Casual Cosmetic Credits**; needs app-level undo CTA, lifecycle and accurate feedback. `M.noteFullScreen` currently occurs before awaiting SDK `show` (both rewarded and interstitial); separate **shown** vs **earned** callbacks before changing timestamps, adding limits or analyzing impressions. Current `lastFullScreenAt` is shared, so introduce distinct rewarded-completed and interstitial-shown times while preserving a global spacing guard and migrating saved v1 cadence state. |
| `native/android/.../MegaAndroidAds.kt` | Has UMP, GMA **Next-Gen** rewarded/interstitial wrappers. They are not instantiated in `MegaXOActivity.kt`. `showRewarded` uses an empty `OnUserEarnedRewardListener` and returns a Bool, which cannot prove a reward was earned. Add a typed, non-forgeable event/bridge (offered, started, earned, closed, failed) and real test-unit wiring without weakening WebView origin restrictions. |
| `native/ios/MegaXO/MegaIOSAds.swift` | Has GoogleMobileAds/UMP wrapper, but `MegaXOApplication.swift` does not instantiate it. Reward callback is empty; `Bool` represents presentation, not earned state. iPhone physical signing is still unverified (newer 14 Oct simulator work fixes layout; does not prove actual phone install). Implement matching typed bridge and test with real signing later. |
| `packages/migrations/migrations/0014_monetization_credits.sql` | `monetization.reward_tickets.kind` is CHECK-restricted to `credits` / `boost`. A *server-verified* new reward kind needs an **additive** migration and exact role/manifest/update tests. Do not loosen the CHECK without an explicit data contract. |
| `packages/services/commerce.js` | V5 PostgreSQL Core commerce successor already checks provider transaction ID, ticket, actor, ad unit and reward kind; only knows Credits/boost. Extend only through the **Core authority** with a new action-specific ticket, immutable context, idempotent settlement, replay rejection, per-actor cap and zero economic credit for an undo. |
| `apps/api/index.js` / `apps/api/routes/*` | V5 public stateless API mounts well-known, compatibility, account, social, competitive routes; **no active `/api/monetization/*` router** in this audited code. The V4 `server/monetization-http.js`/`server/admob-ssv.js` exist but **must not be casually rehosted** with SQLite/economic authority in Vercel. Create a V5 API verification/control-plane adapter and signed Core ingress, with provider callback verification and least-privilege routing. |
| `server/production/main.js` | V4's legacy SQLite monetization/server config is not V5's production API; leave the live V4 path untouched. |
| `docs/p21-web/PROVIDER-EXECUTION-20261014.md` | Real AdMob Android/iOS unit IDs have been created for **`cosmetic_reward` amount 1**, but app review/store linking, UMP consent and public SSV callback are **not accepted**. **Do not silently repurpose** their reward metadata as "Undo": register/verify an appropriately labeled new unit or formally approve a consistent generic-reward contract with matching displayed reward. |
| `docs/v5.1/release/FINAL-V51-DEPENDENCY-ORDER-20261014.md` | Existing launch dependency tracker. AM tasks are added there, preserving original numbered release tasks. |

### Exact existing test neighborhoods

`tests/monetization-policy.test.js`, `monetization-http.test.js`, `monetization-store.test.js`, `monetization-ui-contract.test.js`, `tests/v5-p04-services.test.js`, `v5-p05-access.test.js`, `v5-native-foundations.test.js`, `v5-native-online-target.test.js`, existing V5 PG/Redis services, P20 native and P21 browser QA. Add new suites rather than changing assertions to make unwanted behavior look correct.

## C. Solo "Watch an ad to undo" — product and deterministic state machine

### C1. User-facing flow

1. Player starts a normal Bot game; **no prompts in tutorial** or first-user protected flow.
2. After at least 8 plies, a small `Undo` control may appear in the match control zone, **not on the 9x9 board**. If there is no ad, privacy permission, capability or remaining quota, show unavailable without delaying play. This is an optional action, not required navigation.
3. If the Bot genuinely wins with the **last completed Bot move**, the result UI may show a secondary **"Watch ad to undo last turn"** option alongside **"Accept loss"**. No synthetic/ad-induced defeats and no autoplay. Consent and a genuinely ready ad are prerequisites.
4. The confirmation sheet says: **"Watch one optional ad to rewind your last move and the Bot's reply. One rewind per match, up to two per day. Assisted games earn no Bot Coins or ranked rewards. Cancel to keep the result."** Then buttons **"Watch ad"** and **"No thanks"**. Respect sound mute, screen reader, focus restoration and safe areas.
5. **Only on SDK-confirmed earned reward** perform a deterministic full-turn rollback. Paint the restored board and ask the player for the next move. Never resume onto an invalid/suddenly finished mini-board. If ad is skipped/failed, keep original state/result and offer the normal no-ad exit.
6. The UI may state "Waiting for verification" only for **server-persistent rewards**. A zero-economic local Solo undo can complete on the trusted native earned callback and persist a device-scoped one-shot receipt; do not falsely report SDK presentation as a completed watch.
7. After rewind, do not insert an automatic interstitial; reset the interstitial cooldown after a **completed** rewarded ad.

### C2. Exact undo rules, replay invariants

- **Eligible state:** `match.mode==='bot'`, `!match.practice`, `!match.online`, not ranked/queued/party, non-neural until explicitly qualified, 8+ committed plies, stable on-device state, `match.recorded===false` or a **provisional** terminal loss, quota available, no concurrent in-flight Bot decision, and no existing undo for this match.
- **Turn semantics:** preserve human `X` and Bot `O` from `src/app.js`, even when `match.first==='O'` on rematches. For a post-loss rewind, require last two plies to be `X` then `O` and the terminal result to have been caused by Bot `O`. Remove exactly that pair, **not a whole mini-board**. For a nonterminal human-turn undo, remove the most recent complete `X/O` pair, so the state ends at human turn `X`. Do **not** remove an unmatched Bot opening move or a human winning move.
- **Rebuild:** `G.create(match.first)` then replay every retained `{b,c}` through `G.apply`. Refuse if any original move/player sequence differs, if computed game state fails deep equality to the expected prefix, if terminal/timer/model generation does not match or if any canonical legal constraint is violated. Preserve mini-claimed boards and required-board/freeroute semantics from the pure engine; no manual cell mutation.
- **Async safety:** before undo, clear `botTimer`, `A.cancel()` and `localSession.cancel()`; increment `gameGeneration`/`revision`; after undo reject any outstanding Worker result whose matchId/revision/seed/modelHash is stale. Restore deterministic local bot metadata without changing difficulty or reassigning a stronger/weaker Bot due to the ad.
- **Terminal safety:** change `finish(reason)` into `prepareTerminalResult` then `finalizeTerminalResult` for eligible Bot `O` losses. During the choice/ad the match is **pending-finalization**: no `D.complete`, no record/Coins/quest/day-cap increment, no auto-interstitial eligibility. On "No thanks," decline, app session exit, or other completed terminal resolution, call existing `D.complete` **once**, save result once, then show the normal result. An undo returns to active game without awarding the discarded result.
- **Restart recovery:** `save` must preserve the pending terminal loss + original plies, match ID, quota use and nonce/SDK state for resumed UI; current `save` removes finished matches, so version and migrate the local snapshot. On process death mid-ad, do not assume the ad completed. Re-read durable earned evidence from the native host where available, otherwise allow "Accept loss" with zero grant. If an actually earned local reward cannot be applied after crash, persist a **single** equivalent solo undo entitlement for a future eligible local game rather than silently consuming the promised reward; cap and expire it.
- **Reward isolation:** record `assisted=true` and `undoCount=1` on eventual finalized Bot match; distinguish in personal history. The proposed default is no bot payout/quest progression for an assisted game; do not change payouts for unassisted matches. Client-set `assisted` is never accepted as an authoritative online result.
- **Time limits:** no timer decay while a rewarded ad or result choice is shown. Real gameplay timers resume normally after restoring state. No undo for timeout/resignation; never forgive timed or monetized online forfeits.

### C3. Example unit tests (must all pass)

Legal 9x9 routing after pair removal; winning mini-board restored; free-route restored when target mini is complete; first-move `O` rematch; 8th ply boundary; Bot-terminal loss vs player victory vs draw vs timeout; stale Worker move arrives after rewind; two concurrent ad completion callbacks; app crash before and after `EARNED`; no `D.complete` before final result; one and only one record after finish; existing Bot Coin caps unchanged; assisted runs never mint ad-to-competitive currency; immutable board snapshots not mutated; callback retries cannot double-grant or consume quota twice.

## D. Reward and provider integrity — two deliberately separate trust lanes

### D1. Solo *non-economic* native undo (MVP)

The 9x9 Bot state and its history already reside locally. For a Solo-only action that creates **zero account balance, Coins, Crowns, Elo or online match mutation**, it is acceptable to apply the rewind on an origin-restricted **native SDK `EARNED` callback**; a web page's arbitrary `watched=true` value is never proof. Bind the local action to `match.id`, expected revision/history hash, one-time native-issued nonce, product flavor, private device-scoped consumed marker, daily caps and the exact action type. A successful `show` call or ad dismissal without `EARNED` must **never** grant. This makes guest solo players eligible without inventing a permanent account. The native bridge is already origin/scoping-restricted—preserve those checks. Server-side verification may independently corroborate a signed-in player's attempt, but must not turn this local benefit into a durable economic grant.

For any *account-persistent* hint tokens, cosmetic trials, multiplayer/online rewind or cross-device reward, **native callback alone is insufficient**; use D2.

### D2. V5 signed SSV + Core settlement (persistent / online actions)

1. Create a named ad product (`solo_rewind`, later `tactical_hint` and `casual_rewind`), an accurate player-visible disclosure, matching AdMob reward-unit metadata, and an immutable per-placement allowlist of platform/adUnit/rewardItem/amount. Preserve `cosmetic_reward` units for Credits/boost; do not silently reinterpret them.
2. Add compatible routes to `packages/contracts/routes.js` and mounted V5 `apps/api`. Browser/native authenticated commands use cookie+CSRF or bearer as appropriate; SSV is a provider-authenticated **GET** without user cookie/CSRF, with request size bounds, raw canonical query and ECDSA signature verification against AdMob published keys.
3. A requested reward yields one opaque ticket with `actorId` (where applicable), platform, adUnit, action kind, eligible mode, match/session ID, expected revision/hash, issue/expiry timestamps, retry key and **no privileged client-supplied actor header**. V5 public API cannot directly mutate economy. Forward an authenticated, body-signed command to Core; Core validates occupancy/mode/caps and owns the transaction.
4. Add a dedicated V5 migration (suggest next free number **after live head 0051**, verify current head before authoring) to represent new ticket kind/context and per-(actor,match,kind)/UTC-day consumption without weakening historical import. Migrate within least-privilege `monetization` permissions, update migration manifest/checksum and PG restore tests.
5. The SSV receiver verifies ECDSA, key ID, timestamp, `transaction_id` uniqueness, exact ad unit/reward item/amount, correct pending ticket/actor/action, expiry + documented provider callback grace, and approved policy epoch. Callback can arrive late/out of order/duplicated; durable one-time transition remains idempotent. No raw device identifiers enter wallet rows. Provider I/O and callback arrival are **not** proof of a guaranteed transaction until Core has committed.
6. For **solo local** rewards, do not route through economic credit grants. For **future Casual online** effects, only Core may authorize a revised match timeline; SSV settlement alone never rolls back an online move or invents a win.
7. If the user chooses to remove automatic ads via existing `remove_ads` entitlement, continue allowing explicitly opted-in rewarded offers per the already disclosed contract. Honor provider refund/restore state without creating second grants.
8. Add negative tests for unsigned callback, invalid ECDSA, wrong platform/unit/actor/match/epoch, mismatched reward amount, stale ticket, duplicate `transaction_id` across actors, duplicate delivery, missing provider config, bypassed quota, replay after logout/deletion and crash between SSV receipt and Core commit.

**Official provider references [external]:**
- AdMob rewarded Android, including test ad unit policy: https://developers.google.com/admob/android/rewarded
- AdMob rewarded iOS: https://developers.google.com/admob/ios/rewarded
- AdMob SSV verification and `custom_data`: https://developers.google.com/admob/ios/ssv
- Reward ad disclosures, opt-in and faithful granting: https://support.google.com/admob/answer/7313578
- Play disruptive/interstitial ads policy: https://support.google.com/googleplay/android-developer/answer/9857753
- Android UMP/consent: https://developers.google.com/admob/android/next-gen/privacy/gdpr
- iOS ATT/ad privacy, when tracking is actually used: https://developers.google.com/admob/ios/privacy/strategies
- Impression-level ad revenue is **post-impression** (do not assume a pre-show winning bid): https://developers.google.com/admob/android/impression-level-ad-revenue

## E. Casual online rewind (proposed phase 2; OFF until separately accepted)

**Reason it cannot simply reuse Solo `G.apply`:** the existing Casual queue is an **authoritative live PvP match** with real turns, potential Cosmetic Credit entitlements and a second player. A viewer-controlled JavaScript rollback would desynchronize Core, violate settlement and impose a paid advantage on an unsuspecting opponent.

A separate Core feature must use a **new versioned protocol**, with these minimal transitions:

`ACTIVE` → `UNDO_REQUESTED(actor, expectedRevision, lastCompleteTurnHash, expiresAt)` → opponent explicitly `ACCEPT` or `DECLINE` → if accepted, optional rewarded completion/SSV with bounded clocks → `UNDO_COMMITTED(newRevision, supersedesMoveIds, preservedAuditTrace)` → `ACTIVE`.

Rules: only unranked, entry-free verified Casual; both participants opted in at match start or at request; no invitation, wager, rated, tournament or result-finalized match; no pending move/timeout/resign/settlement; one request per match; no forced opponent ad; preserve opponent clocks and prevent stalling by bounded request deadlines and explicit cancel; request fails cleanly on disconnect, game completion or new move; **do not delete historical moves**, append an authoritative correction with old/new revision and exactly replayable projection. Notify both players via signed realtime and HTTP snapshot; idempotent revision-tied retries. Preserve one authoritative settlement and reconsider qualification for Casual Cosmetic Credits before enabling. These are **new game protocol semantics** and should receive a separate owner approval, new contract tests and an independent staging two-device proof.

If this becomes too complex or damages match flow, ship **Solo rewind only** and keep PvP Casual without undo. The user request is preserved as a scoped follow-on rather than silently implementing an unfair online shortcut.

## F. Additional opt-in features (after Solo undo proof)

- **Threat Vision (`tactical_hint`):** a bounded, deterministic local analysis of legal moves, no opponent-side secret. Existing `data.settings.legal` and destination preview already explain routing; keep those **free**. Add extra transparent tactical evaluations, not an ad gate on basic rules. Label risk in text plus accessible color (`safe`/`free route`/`immediate tactical threat`), derived from `G.legal` and tested forced-win/threat detection, with equal budgets/seeded tests across bot difficulty and low-end phones. Example: 1 free advanced hint per Bot match; later 3 rewarded hints under shared 4/day cap (hypotheses, not shipped constants). Absolutely no hints in online competitive or rewards-bearing PvP.
- **Casual streak shield:** if separately approved, it protects only a *clearly labelled noncompetitive personal streak*. No Elo, season placements, ranking awards, Coin/Crown economics or matchmaking weighting; no fear-pressure timer.
- **Temporary cosmetic trial:** a time-limited theme/frame preview visible to the player but never a competitive perk, with truthful expiry and accessibility fallbacks. Permanent ownership/currency still needs Core SSV verified settlement. Existing four native themes and fifth browser-only Neon remain untouched.
- **Ad-free purchase:** existing `remove_ads` non-consumable remains the entitlement for **automatic** ads, not voluntary rewarded prompts. Do not change posted store price or launch a new product without owner/store acceptance.

## G. Pacing, consent, UX and telemetry

### G1. Preserve baseline; test change rather than assume it wins

Start with `src/monetization.js` v1 thresholds unchanged: 24h+5 meaningful Bot games before a forced ad; at least 3 games and 8 active minutes since last interstitial; 8-minute global full-screen gap; session 2/day 6; rewarded 4/day, gap 2 minutes. Never fire an interstitial on game start, while playing, after tapping "Play Again", during matchmaking, in tutorials or at device/app exit. When a rewarded ad completes, reset forced-ad pacing. If no ad ready, return to the app without interruption.

Change accounting only where necessary: record `lastInterstitialShownAtMs` **on SDK shown/impression**, `lastRewardedCompletedAtMs` **only on earned**, and separately retain `lastFullScreenShownAtMs` for spacing; remember an unsuccessful start without mislabeling it an impression. Version cadence storage (`mega_v35_ad_cadence`) and test migration from earlier `version:1`. Duplicate `mega:local-save` events must not advance counters. Restore ad-removal entitlement before show. Do not ship the notes' speculative high-bid cooldown override; SDK paid callbacks report impression value **after** display, not a guaranteed pre-show bid.

### G2. Consent and privacy

Collect only what is needed for consent, reward correctness and cohort analysis. Google UMP request on each app launch, privacy options accessible in Settings; on iOS request ATT only if using tracking functions that require it, and respect refusal. The existing `canRequestAds` flag must be truthful. Update public Privacy/Terms/Play Data Safety/App Privacy to describe actual ads, analytics, optional gameplay assistance, privacy choices and any third-party processors/regions. Keep ad telemetry separate from the day-one **gameplay training capture** consent/retention lifecycle (DC00); the two cannot silently share a consent flag. No raw high-cardinality device model, full IP or per-player high-eCPM score should control difficulty.

### G3. Creative, audio and four/five-theme UI

Native board controls should not move or shrink to create a banner slot. Initial rollout uses **no in-match banner**; prototype placements outside the board only after real 320px/safe-area/touch testing. Draw Undo/Hint with existing themed CSS tokens in Vector, Midnight, Paper Club, After Hours; browser Neon uses its own palette, not a fifth native theme. Ensure high-contrast state, VoiceOver/TalkBack descriptions, focus return after full-screen SDK, reduced motion, haptics/sound preference respect, empty/loading/errors, airplane mode and early-close states. Ad opt-in text must be explicit and truthful; no deceptive close button or accidental-click hotspots.

### G4. Event schema (analytics are off unless authorized)

Minimum versioned events:
`session_started`, `solo_match_started`, `match_completed_confirmed`, `rewind_eligible`, `rewind_offer_displayed`, `rewind_tapped`, `ad_requested`, `ad_loaded`, `ad_show_started`, `ad_impression`, `ad_earned`, `ssv_received_verified`, `rewind_applied`, `rewind_unavailable`, `ad_failed`, `ad_closed_no_reward`, `interstitial_permit_refused`, `interstitial_shown`, `remove_ads_restored`, `complaint_category` and `device_crash`. Include schemaVersion, anonymous cohort ID or permitted actor pseudonym, mode, platform, release/rules hash, UTC time, experiment arm, placement, reason code and policy version. No raw token, provider signature, phone contacts, precise hardware profile or sensitive player game state in ad events. A single event must never be double-counted across app resume.

Define **explicit denominators**:
- eligible → offered → tapped → started → impression → earned → applied (distinguish each);
- `rewardedCompletionRate` = earned / started (zero-safe; no division by 0);
- `rewardFulfillmentRate` = applied / earned;
- ads/day and ads/hour from verified **shown** events (not failed requests);
- D1/D7/D30 retention, post-ad exit, session length, involuntary ad frequency, tutorial abandonment, crashes and consent withdrawal;
- estimated ad revenue in currency micro-units only where the provider's paid-event callback actually supplies it (post impression).
- cohort LTV and revenue estimates are **hypotheses** until measured; do not copy Block Blast or source eCPM numbers into production forecasts.

Pre-register an A/B experiment with a **no-ad / existing-reward control**. Only after telemetry and retention cohorts are sound, test UI placements and the 3/4/5/7-minute cooldown hypotheses *subject to a hard existing minimum unless separately reapproved*. A contextual bandit, per-device ad-value model, changing bot difficulty and any creative-price driven loss/ad timing are excluded from initial release.

### G5. Operation and rollout

Remote config is signed/versioned, scoped by platform and build with defaults **OFF**, an emergency kill-switch for each placement and per-account or installation deterministic assignment. Consent missing, provider unit missing, SSV unavailable, client identity mismatch or test coverage missing => fail closed, keep the game fully playable. Server and native callback traces must correlate using a **non-secret** attempt ID. Minimum monitoring: reward callbacks vs fulfilled actions, invalid signature rate, duplicate transactions, callback latency, ad fill and load-error rates, ad-influenced crash/ANR, interrupted matches, conversion/retention by cohort and revenue by verified paid event. Disable a problematic arm without a new app build.

## H. Actionable developer worklist, owners and acceptance gates

Every task is independently committable. Main owns core rules/native/backend and DB; Codex owns ad-console, privacy copy, web/UI/accessibility and user-facing provider controls; WebUI can independently audit tests/CI/plan; human approves final product limits, disclosures and releases. No PR may deploy V4, modify `main` or cut over PostgreSQL merely by implementing this plan.

| ID | Priority | Accountable | Action / exact deliverable | Definition of done | Depends |
| --- | --- | --- | --- | --- | --- |
| **AM00** | P0 | Main + WebUI | Freeze inspected V5.1 ad/mode/API inventory and baseline tests; record exact source SHA, original caps, disabled ad-mode and all four themes. | Authored baseline with reproducible tests, original economy and gameplay unchanged. | none |
| **AM01** | P0 | Human + Codex | Approve Solo-first behavior, quota draft (1/match, 2/day, shared 4/day), 8-ply threshold, assisted-match rewards rule, full-mode matrix and launch inclusion vs phased beta. | One explicit versioned product decision; PvP mutual consent separate. | AM00 |
| **AM02** | P0 | Main | Write pure `gameplay-rewind` module with canonical replay/immutable history/expected revision hash; no DOM or provider access. | Deterministic legal-state/property tests incl mini-board routing, terminal/draw/starting O, full-turn semantics. | AM01 |
| **AM03** | P0 | Main | Split `finish` into provisional loss vs final settlement. Preserve existing `D.complete` exactly once for unassisted results; add `assisted` recording/disposition. | Crash/replay/restart shows one final result, zero intermediate reward/quest inflation and unchanged normal Bot payouts. | AM02 |
| **AM04** | P0 | Main | Fence Worker/Neural requests and timers around undo; match version/revision persisted and restored on app resume. | Kill/restart/stale-worker tests, no ghost moves or double Bot output. | AM03 |
| **AM05** | P0 | Main + Codex | Build accessible match/result Undo UX in 4 app themes + browser Neon; confirm exact optional reward/caps before ad. | Screenshots, text, focus, keyboard/AT and 320px checks, no board overlap. | AM03 |
| **AM06** | P0 | Codex | Confirm exact AdMob rewarded units or request a **new accurately labeled Undo unit**, UMP privacy messaging, test inventory and publisher approval; leave live serving OFF. | Saved provider console state with verified reward item/amount/unit and no guessed IDs. | AM01, native store records |
| **AM07** | P0 | Main | Wire native `MegaAndroidAds` / `MegaIOSAds` into signed online build hosts; expose typed SDK `EARNED` and distinct shown/dismissed/failure callbacks over origin-pinned bridges. | Device/simulator test IDs; callback truth table; no WebView-spoofed grant, no JavaScript token leak. | AM05–AM06 |
| **AM08** | P0 | Main | Implement device-scoped guest Solo grant and idempotent pending reward/restore. Do **not** write Core economic ledgers. | Exactly one local rewind per earned event, no grant from show/close-only, survives app resume. | AM04, AM07 |
| **AM09** | P0 if persistent/online | Main | Introduce additive PG schema + role grants for bound new ticket kinds/undo counts; preserve old Credits/boost tickets and 51-migration import/restore. | Fresh + upgraded PG16 migrations and role isolation pass; forged kinds refused. | AM01, AM06 |
| **AM10** | P0 if persistent/online | Main | Mount V5 monetization/public SSV adapter and signed Core command mapping; verify exact provider event to ticket to settlement. | Real V5 staging signed callback, duplicate/out-of-order, replay, missing provider, wrong actor/unit/amount all safely handled. | AM09, production API/Core routing |
| **AM11** | P0 | Main + Codex | Upgrade pacing state: separate SDK shown vs reward earned, interstitial vs rewarded timestamps; migrate `mega_v35_ad_cadence` and preserve current caps. | Existing tests pass; never count a refused/not-shown ad as an impression; no unexpected result-to-home interruption. | AM00, AM07 |
| **AM12** | P0 | Main + Codex | Integrate user choice, quotas and trusted earned callback into `src/app.js` and native UI, including no-provider/offline errors and ad-free purchase semantics. | Bot undo works with 1/match, 2/day, current rewarded global cap and cooldown; no ads in tutorial or PvP. | AM03–AM08, AM11 |
| **AM13** | P0 | Codex + Main | Privacy/consent/disclosures/age treatment by platform; explicit settings options and data minimization; distinguish ad consent from DC00 training capture choice. | Current provider/store rules reviewed, UI demonstrated, no unapproved collection; rollback. | AM06–AM07, product decisions |
| **AM14** | P0 | Main + WebUI | Regression suites: canonical rules/finance, app lifecycle and ad reward gate; include SQL, UI and native negative cases. | CI passes real negative controls; impossible to mint or remint coins/crowns/rating via ad callback. | AM02–AM13 |
| **AM15** | P0 | Main + Codex | Test on owner’s **Android** and signed **iPhone** (only app-test scope, no personal data deletion), with SDK test units, multi-theme UI, force-close/airplane/network failure and cleanup ledger. | Model/OS/build hashes, no helper files/settings left behind, screenshots host-only, app may stay installed. | AM12–AM14, Apple signing |
| **AM16** | P0 | Main + Codex | V5 provider integration rehearsal: actual signed SSV for any account-persistent grant, no provider callback grant if unavailable, released URLs and nonce/config rotation. | Exact-sha, exact-unit, real staging evidence; production ads OFF until provider gate. | AM10, AM15 |
| **AM17** | P0 | WebUI + Main | Telemetry event spec, dedup + data minimization, dashboard queries for funnel/revenue/retention and abort/creative quality. | End-to-end synthetic events with correct zero-safe denominators, no unverified financial benchmarks. | AM11–AM12 |
| **AM18** | P0 | Human + Main | Complete Solo beta go/no-go and release packet, including product fairness, ad-policy, CI/native, callback/consent, provider account and rollback. | Explicit `AD_SCOPE_REWARDED_SOLO_BETA` approval; kill-switch verified. Or remain OFF and record deferral without blocking V5 cutover. | AM13–AM17 |
| **AM19** | P1 optional | Main | Threat Vision deterministic tactical evaluator + test corpus; preserve free rules guidance and honest color+text. | Tactical correctness on forced-win/block tests, budget/latency on actual low-end phone. | AM02–AM04 |
| **AM20** | P1 optional | Codex + Main | Offer bounded free then rewarded hints, only in Solo; SSV for persistent inventory; four themes and accessible descriptions. | Usage and replay caps, no competitive hints and no false-positive threat text. | AM19, AM06–AM16 |
| **AM21** | P1 conditional | Human + Main | Approve PvP Casual rewind rules and reward/clock/settlement effect separately (consent from both humans). | Versioned protocol proposal, abuse/rate/timeout budgets and no competitive economics impact. | AM18, current Casual/Core match contract |
| **AM22** | P1 conditional | Main | Implement Core-only Casual pending/revision-correction protocol and signed client state. | Real two-client staging with consent/decline/disconnect/conflict/settlement/replay tests and no unilateral undo. | AM21, AM09–AM10 |
| **AM23** | P1 optional | Codex + Main | Try cosmetic trials / noncompetitive streak protection, keeping Coins/Crowns/Elo unchanged. | Named product decision, exact cosmetic-only entitlements and clean revocation. | AM18 |
| **AM24** | P1 experiment | WebUI + Main | Run randomized rewarded-first vs control/retention tests, then optional **non-deceptive** UI placement experiments; only evaluate relaxed interstitial cooldowns under separately approved hard bounds. | Pre-registered primary metric + non-inferiority/retention stop criteria + signed arm allocation + data quality checks. | AM17–AM18, live cohorts |
| **AM25** | P2 deferred | Human + Codex | Consider AdMob bidding/mediation vendor assessment from **real** local yield/complaint data; no unsupported bid-eCPM predictor, forced-loss Trait or bot manipulation. | Evidence-backed cost/quality choice, separate vendor consent, explicit approval. | AM24 |

## I. Milestone commits and test commands

1. **Pure logic first:** AM00–AM04. Small separate commits for replay rules, result finalization and lifecycle/persistence. Run `node --test tests/domain.test.js tests/gameplay-connection.test.js tests/monetization-policy.test.js` plus new `tests/solo-rewind*.test.js`; original product rules stay unchanged.
2. **SDK and rewards:** AM05–AM13. Commit native bridge, server ticket schema/router/SSV, then UI. Run `node --test tests/monetization-*.test.js tests/v5-native-foundations.test.js tests/v5-native-online-target.test.js` plus dedicated negative tests and disposable PostgreSQL 16 / Redis integration. Never weaken skipped-service gates to claim green.
3. **Hardware and release:** AM14–AM18. Run Android ADB and Xcode signed iPhone/simulator; verify all four app themes, browser Neon, privacy/consent and host-only evidence cleanup. Independently replay SSV failure/duplicate/restore cases; test kill switches. Real ad units only on authorized test devices/track after provider review.
4. **Optional/P1:** AM19–AM25 after accepted Solo result and metrics. PvP Casual requires a separate protocol review, not just a CSS or UI patch.

**DoD for all stages:** no changes to `src/game.js` legal moves, standard bot difficulty behavior, quarterly ranking/Elo, direct/tournament Crown stakes, current economic payout caps, privacy-capture policy, approved model catalog or live V4 serving writer; all features default OFF until explicitly enabled and proven. Every milestone records commit SHA, environment/build, tests, observed provider state, exact rollback and remaining open items.

## J. Relationship to the V5.1 launch critical path

- **Already completed / do not redo:** previous V5.1 feature PRs #12/#13 merged; production PG16 migrations 51/51 on nonserving target, E1/E2/E3 dry runs, signed **staging** Core edge, V5-only encrypted backup/retrieve and tested recovery, Android offline physical game test. These are not permission to start a new V5 writer.
- **Existing mandatory blockers unaffected:** Apple signing/iPhone hardware, live V5 email, actual production API/Core/WebSocket separation, authoritative website/native identity acceptance, 15/15 DC00 proof including controller purpose/retention, P22 independent operator evidence, exact-final-source/image freeze and E4/E5 transfer.
- **Ad launch dependency:** AM00/AM01 now → AM02–AM08 in parallel with native/service work → AM09/AM10 if persistent/online → AM11–AM17 → AM18 beta approval. These ad tasks become **mandatory for ad serving**, not automatically for a core game release with ads OFF.
- **Production must remain honest:** V4.1.2/SQLite stays the sole writer; never cut over, delete personal device data or claim store/AdMob approval based on documentation.

## K. Source and policy provenance

User-uploaded consolidated research *Mega-XO_Ad_Monetization_Consolidated_Notes.md*, 14 October 2026: ``1–4 reverse-engineering and economy hypotheses; ``5–6 Mega XOXO translation and illustrative ad-controller state; ``7–9 experiments, risks and implementation suggestions. It explicitly warns that third-party game causality, eCPM values, ARM selection and current Mega XOXO code were **not** independently verified. This plan adds that missing repo-specific audit and distinguishes external official provider contracts from speculative uplift.

Provider policy links in D2 are public, sourced from their publishers and checked 14 October 2026. Recheck them at implementation/release; SDK APIs can change and the current Android wrapper uses the GMA **Next-Gen** namespace whereas many public snippets use the legacy API.
