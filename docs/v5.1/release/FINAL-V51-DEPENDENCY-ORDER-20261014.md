# Mega XOXO V5.1 — final task list, dependency order

**Revision:** owner decisions of 14 October 2026, 12:32:10Z. **Current specification:** [Owner decisions and execution contract](OWNER-DECISIONS-AND-EXECUTION-20261014.md). This supersedes contradictory recommendations in the earlier ad plan and previous questionnaire. All new capabilities below are PLANNED unless separately evidenced as implemented.

The original 24 task identities are retained; suffixes group parallel power-up/data work. Previous version is preserved in Git at `4752f2b84191923129ed259e896810c491f3086f`. Do not present this documentation update as a deployment or a runtime PASS.

## Closed owner decisions — do not ask again

| Item | Current status |
| --- | --- |
| Website and visual design | OWNER_ACCEPTED. Sol delegated to design new Undo/tactical controls. Ordinary functional/security/accessibility regression remains. |
| Existing guided tutorial | OWNER_ACCEPTED. Extra novice study waived; no fabricated 80% study result. |
| Google Play / Apple accounts | OWNER_REPORTED_APPROVED under contact@antimatterinnovations.com. Enrollment wait removed; verify actual accounts and perform signing/app review. |
| Impossible | Keep all UI hidden; no day-one neural training/model promotion. Training-ready gameplay collection stays in scope. |
| Capture purpose | Owner approves day-one game-improvement/future-Bot data preparation and delegates retention. Legal implementation, informed player/guardian choices and privacy controls still must work. |
| Deployment window | ASAP once applicable technical/data gates pass; no artificial overnight wait or 30-minute maximum. |
| Payments | No new payment, paid tier/trial/add-on or automatic paid overage without explicit approval. Previous suggested monthly budget is revoked. |
| Core game/economy | Existing rules, Crown utility and payout caps retained. Undo does not remove ordinary Bot rewards. Pay each finalized game once. |

## Known repository/runtime evidence boundary

The latest inspected source before this plan was `4752f2b84191923129ed259e896810c491f3086f`. Old feat/fix branches were already merged via PRs #12/#13; their names remaining visible do not represent missing source. Preserve main/V4.1. Branch deletion, if wanted, is a separate ancestry-checked cleanup and not another merge.

Main's recorded evidence includes 51 migrations on a nonserving V5 target, reconciled V4 import, encrypted R2 retrieve/restore and backup alerting. This is not a current live-server probe by WebUI. Last recorded live authority remains V4.1.2/SQLite; reverify before deployment. Android physical tests and later iOS simulator work do not substitute for signed physical-iPhone acceptance. The previously recorded 14 PASS/15 RUNNING/11 BLOCKED acceptance ledger remains historical until each case is reconciled; owner visual/study acceptance is a different evidence category.

## A. Resolve infrastructure and privacy prerequisites in parallel

| ID | State | Required action / finish line | Owner | Dependency |
| --- | --- | --- | --- | --- |
| **01** | PARTIAL | Fresh source/ref/CI inventory; preserve main/V4.1 and every agent commit; confirm required-check settings. Record the new decision precedence without resetting history. | WebUI + Main/Codex | None |
| **02** | OWNER_DECIDED | Staged backend/web then native platform release; rewarded-first, worldwide English where supported. Keep unavailable ad/provider features disabled without delaying unrelated accepted functionality. No more blanket launch-approval question. | Main + Codex | 01 |
| **03** | OWNER_PURPOSE_APPROVED; IMPLEMENTATION_OPEN | Implement one-time purpose/age choices and withdrawal. Optional research is not mandatory operations. Use affirmative/guardian permission where required; no default-consent fiction, minor ad profiling or unsupported IQ labels. | Main + Codex | 01 |
| **04** | ENROLLMENT_RESOLVED; SIGNING_OPEN | Inspect the already approved Apple account; create verified Team/App ID, certificate/profile and native signing. Do not pay another enrollment fee. | Codex + Main | 01 |
| **05** | ACCOUNT_APPROVAL_REPORTED; CONFIG_OPEN | Inspect existing Play account; verify final package/bundle IDs, Google/Apple provider clients, signing fingerprints and association files. Retain account/actor continuity. | Codex + Main | 04 for Apple only |
| **06** | PARTIAL | Real V5 verification/reset/change email using protected existing Resend credentials; actual inbox, expiry, consumed-token and honest-error tests. Preserve V4 mail. | Main + Codex | 01 |
| **07** | PARTIAL | Complete reachable HTTPS API/signed Core/public ticketed WSS and separate production/staging roles/secrets. No Core database credentials in Vercel; no production API pointing to staging. | Main + Codex | 01 |
| **08** | PREPARED_NOT_LIVE | Prepare Vercel/site/API routing, TLS and DNS release configuration. Inspect actual plan eligibility: genuinely free does not mean commercially permitted. No paid upgrade; obtain explicit approval if a required permitted option costs money. Public switch occurs with 23, not merely for testing. | Codex + Main | 07 |

## B. Build reward-preserving power-ups while capture coverage is extended

[Detailed product rules](OWNER-DECISIONS-AND-EXECUTION-20261014.md#power-up-product-contract): ten aggregate rewarded exposures/day; one Bot ad earns two Undo presses, one package/match. Casual allows three initiations/player and one successfully applied undo for the whole match. Expert Tactical Power has two valid uses/three activations; Tactical Block has two valid blocks/three activations. Undo Block is separate. Bank earned items; no ad is automatically shown. No power-ups in ranked, staked/direct challenges or tournaments.

| ID | State | Required action / finish line | Owner | Dependency |
| --- | --- | --- | --- | --- |
| **02A** | PRODUCT_DECIDED | Translate current rules to versioned constants/test cases. Remove obsolete one-press/two-per-day/four-total/no-Coins and per-request-opponent-consent designs. Document engineering interpretations rather than pretending the owner specified every parameter. | Main + WebUI | 02 |
| **07A** | PLANNED | AM02-AM04: canonical two-charge Bot rewind, provisional terminal loss, cancellation/revision fencing, persistence and normal reward single-finalization. No replayed Coin/quest grants. | Main | 02A |
| **12A** | PROVIDER_CONFIGURATION_OPEN | AM06/AM13: correct test/live ad unit reward wording, UMP/privacy controls and age-appropriate capabilities. Earned item must match disclosure; counterable request is not a guaranteed successful undo. | Codex + Main | 03-05 |
| **12B** | PLANNED | AM05-AM08: native earned/shown/closed/failure bridge plus authoritative persistent inventory/banking. Actual earned SDK/SSV signals, not a JS watched flag or show-call success. Recover earned items on technical failure. | Main + Codex | 07A, 12A, 07 |
| **12C** | PLANNED | AM09-AM10/AM21-AM22: additive PG/Core power and event schema, V5 monetization/SSV route, expected-revision requests, separate counters/shields, atomic settlement and clock/pause limits. Keep existing Core lock order and least privilege. | Main | 12B, 13A |
| **12D** | PLANNED | AM11-AM13/AM19-AM20: Expert legal-square advice, hidden until counter window resolves; players retain legal move choice. Sol integrates bank/Undo/hint/block controls in accepted themes. No need for a new human aesthetic review; regression tests still run. | Main + Sol/Codex | 12B-12C |
| **13** | IMPLEMENTATION_OPEN | RD00/RD05: optional research settings distinct from required operations; either-player withdrawal, parent/age restrictions, public nickname anonymity separate from capture opt-out. Optional adult age-band/gender research requires appropriate notice and permission. | Main + Codex | 03 |
| **13A** | PLANNED | RD01-RD04: preserve v1 and introduce immutable event/branch data for every move, undone line, hint/counter, tournament attempt and Bot response. Local Bot data is client-replay-validated, never falsely server-authoritative. No synthetic winner label on abandoned branches. | Main | 13 |
| **13B** | PLANNED | RD06-RD07: deterministic streaming datasets, root-game/symmetry/participant-time split integrity, source-expiry limits, deletion/export revocation, secure storage and restore-journal replay. Owner-delegated 24-month adult research maximum is necessity-reviewed, not a claim of a universal legal allowance. | Main + WebUI | 13A |
| **14** | REVALIDATION_REQUIRED | Current capture schema/purpose and all-mode coverage must pass fresh mode/replay/completeness/privacy/chaos receipts. Old staging 13/15 evidence is useful input, not proof the expanded Bot/power/research contract is finished. No neural training. | Main + WebUI | 13-13B |

## C. Verify real clients, provider flows and operations

| ID | State | Required action / finish line | Owner | Dependency |
| --- | --- | --- | --- | --- |
| **09** | PARTIAL | Real Android native sign-in, permanent actor and wallet/match continuation, reconnect/revocation/process death. Retain offline flavor and its permission boundary. | Main + Codex | 05-07 |
| **10** | SIGNING/DEVICE_TEST_OPEN | Install signed app on paired iPhone; verify online parity, themes, lifecycle, secure sessions, LAN, VoiceOver and performance. Preserve all personal data. No simulator-as-phone claims. | Main + Codex | 04-07, 09 for cross-platform |
| **11** | OWNER_VISUAL_PASS; TECHNICAL_REGRESSION | Retain accepted website/UI. Verify actual auth/game/API/WSS and new power/consent integration, keyboard/screen-reader behavior and responsive layouts. Sol can approve visual additions; reopen only an actual new defect. | Sol/Codex + Main | 06-08, 12D for powers |
| **12** | PROVIDER_TEST_OPEN | Verify store SKU prices, purchases/restore/refunds and ad serving states. Existing proposed Crown packs and Remove Ads semantics retained. Use provider sandboxes; no real charge without approval. Remove Ads never grants powers or eliminates opt-in power ads. | Codex + Main | 04-05, 12A-12D |
| **15** | PARTIAL | Complete V5 API/Core/worker/realtime/capture/backup monitoring and delivered incident/recovery alerts. Measure actual latency/backlog/storage and confirm genuinely free quotas or obtain explicit payment approval. | Main + Codex | 06-07, 13B |
| **16** | OWNER_ACCEPTED; STUDY_WAIVED | Existing tutorial and website user feedback accepted; no additional novice study is a release gate. Keep ordinary regression, physical accessibility and crash checks within 09-11. Do not manufacture a study result. | Main + Sol/Codex | No new human decision |
| **16A** | PLANNED | AM14-AM17: full power/counter/banking/ten-daycap/SSV/timeout-race tests on disposable PG and actual phones. No hint leak before block result, no duplicate reward, no personal-data deletion; log and remove only test-created artifacts. | Main + Codex + WebUI | 09-12D, 14 |
| **16B** | FEATURE_ACCEPTANCE_OPEN | AM18: enable rewarded powers only after provider, age/consent, gameplay, clock, evidence and kill-switch acceptance. Separate from base-game launch when powers remain disabled. No other blanket owner permission is required. | Main + Codex | 12, 16A |

## D. Release ASAP, with one real authority

| ID | State | Required action / finish line | Owner | Dependency |
| --- | --- | --- | --- | --- |
| **17** | RECONCILE | Map original acceptance IDs to actual latest source/environment and owner waivers. Distinguish owner accepted, tested, provider approved, deferred and not run. Website design and novice study cannot reappear as unanswered questions. | Main + WebUI | Relevant 03-16 gates |
| **18** | PREWRITE_EVIDENCE_OPEN | Freeze exact-final images, schema, source and pre-write operator evidence; distinguish later fence/first-write observations. The offline P22 checker is advisory and does not itself authorize a write. No circular demand for post-write observations before the write. | Main + WebUI | 14, 15, 17; 16B for power-serving |
| **19** | FINAL_SNAPSHOT_REQUIRED | Execute as soon as prerequisites pass. Quiesce all V4 writes for the final snapshot, prove fresh restore and retain a pre-write abort path; no overnight wait. | Main | 18 |
| **20** | FINAL_IMPORT_REQUIRED | Import final frozen source into nonserving PG, run per-actor identity/wallet/escrow/history reconciliation and zero unexplained checks. Rehearsal import does not replace final snapshot. | Main | 19 |
| **21** | PREFLIGHT | Verify current production-only image/roles/keys/PG/Redis, callback safety and backup/alerts; no stale staging endpoint or development credentials. | Main | 20 |
| **22** | FENCE_VERIFICATION | Prove every V4 mutation/restart path remains fenced, including auth/jobs/callbacks. First V5 write cannot coexist with a V4 writer. Abort before V5 writes if verification fails. | Main | 19-21 |
| **23** | CUTOVER_NOT_EXECUTED_BY_THIS_PLAN | Start sole V5 authority, record first write/epoch and coordinate public domain/client routing; run account/match/wallet/backup/alert smoke. After first V5 write, recover forward on PG and never resume stale SQLite writes. | Main + Codex | 22 |
| **24** | POST_CUTOVER | Verify stable V5, retain main/V4.1 refs and immutable recovery records, retire only obsolete runtime writers. Release each native app after its own review/device acceptance; no requirement to wait for both platforms together. | Main + Codex | 23 and platform gates |
| **24A** | FUTURE_RESEARCH_ONLY | Adult, permissioned aggregate game-skill/learning/ad-response research; no unsupported IQ claims or demographic matchmaking. Revenue-aware difficulty documented for a later reviewed study, not implemented on day one. No model training/promotion resumes from this row. | Main + research reviewer | RD data quality/rights and specific study review |

## New data tasks and AM provenance

RD00: consent/age/profile boundaries; RD01: immutable event schema; RD02: authoritative online/tournament hooks; RD03: local Bot provenance; RD04: hint/undo/pause labels; RD05: withdrawal/deletion; RD06: secure retention/backups; RD07: export/split integrity; RD08: validated in-game skill metrics (not IQ); RD09: aggregate adult ad analytics; RD10: expanded capture acceptance; RD11: publication privacy/methodology review.

The earlier AM00-AM25 task identities are retained as a historical worklist. Current product behavior is the owner contract, not the earlier proposals: normal Bot rewards, two Undo charges/ad, ten aggregate daily presentations, separate opponent shields, banked powers and no per-action consent veto. Additional new code must receive small meaningful commits and relevant tests; preserve existing source changes.

## Limits that remain engineering work, not repeat owner questions

- Player/guardian consent cannot be invented from owner permission; a default pre-ticked optional-research checkbox is not valid where affirmative consent is required.
- A chosen age rating does not establish permission for demographic profiling. Do not use children/unknown-age users for ad-personalization or demographic behavioral research by default.
- Vercel Hobby is documented for noncommercial use. Verify an existing paid entitlement or permitted free architecture before monetization; the no-payments directive prevents automatic upgrades.
- Pure Bot logs uploaded by clients may be replay-valid but are not proven human behavior or server authority. Tag them honestly.
- Match branches affected by powers need a new replay/capture contract; the old linear archive must not silently drop rejected/undone actions.
- None of the documentation commits claims real SSH/device/provider checks, app publication, data enablement, payment or production cutover.

## References

- [Current owner decisions, power rules and data requirements](OWNER-DECISIONS-AND-EXECUTION-20261014.md)
- `EXECUTION-BOARD-20261014.md` and `FINAL-PRODUCTION-DEPLOYMENT-REPORT-20261014.md` for historical operational evidence.
- `NATIVE-SESSION-ROUTES-LIVE-20261014.md` and `IOS-SURFACE-VERIFIED-20261014.md` for source/device limits.
- `DC00-R35-COLLECTION-EVIDENCE-20261014.md` for the earlier staging canary, not automatically the expanded contract.
- `docs/p21-web/MASTER-CHECKLIST.md` for historical compound acceptance; owner-approved scope changes must be annotated instead of fabricating test passes.
