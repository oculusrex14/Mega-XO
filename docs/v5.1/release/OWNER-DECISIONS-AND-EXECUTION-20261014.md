# V5.1: owner decisions and final execution order

Decision source: owner message dated 2026-10-14 12:32:10Z. Reviewed repository head: 4752f2b84191923129ed259e896810c491f3086f.

Status: specification and task plan, not an implementation, provider certification or runtime test. This record supersedes contrary recommendations in the earlier ad plan. Preserve main, V4.1, production data, game rules, existing economic limits and personal phone data.

## Decisions already resolved

- Google Play and Apple developer accounts: owner reports both approved under contact@antimatterinnovations.com. Enrollment is no longer an owner blocker. Agents still verify signing, application identifiers, actual builds and store-version review.
- Website and existing tutorial: owner accepted. Sol owns new power-up visual design. Do not require another website aesthetic approval or novice study. Continue technical and accessibility regression testing without calling unexecuted tests passed.
- Impossible: keep controls hidden. No day-one neural training or model release. Training-ready gameplay collection remains day-one scope.
- Launch: staged web/backend then native platforms when each is verified. ASAP; no artificial overnight window or owner-imposed downtime limit. Backup, reconciliation and single-writer protection remain necessary.
- Spending: only genuinely free tiers without another approval. No paid upgrades, paid trials, automatic overages or real test purchases without explicit approval. The previous suggested monthly allowance is revoked.
- Audience: teen/general-audience play around the requested 12-14+ range, not a blanket adult-only game. Store rating, account eligibility and permission for research/advertising are separate. No behavioral advertising or demographic research profiling of children by default.

## Power-up product contract

| Feature | Owner decision | Implementation detail |
| --- | --- | --- |
| Bot Undo | One rewarded ad earns up to two Undo presses; ten/day instead of two/day. Rewards remain normal. | One two-charge package per Bot match. Each press restores the player's preceding decision, removing a Bot reply if present. Preserve original payouts and settle the final match only once. |
| Casual Undo | Each player may initiate up to three times; only one valid undo in the match. Opponent can block using an ad-earned Undo Block. | Three requests per player; one successful undo match-wide. Core owns the event/revision. No per-request permission veto. Players enter a Casual rule set that discloses the power mechanics; preserve ordinary no-power Casual. |
| Tactical Power | Expert highlights its recommended legal square; player can choose anywhere legal. Twice per player per game; three initiations. | Do not reveal the suggestion until the counter window is resolved. The recommendation is not a guaranteed best move. |
| Tactical Block | Two successful blocks per player/game, three activations. Separate from Undo Block. | Can block a pending hint, never a hint already revealed. No block-of-a-block chains. |
| Banked powers | An earned unused power remains available for later use. | Proposed initial bank capacity: one available entitlement of each type. No silent expiry. Per-match limits still apply. Invalid technical attempts return reservations. |
| Remove Ads | Does not remove ads for powers or Undo. | It removes automatic ads only. Rewarded ads are voluntary and earn the described item. |
| Other modes | Preserve normal competitive rules. | No powers in ranked, direct/staked challenges or tournaments. Bot opponents do not secretly acquire counter powers. |

Engineering interpretation: ten/day is an aggregate rewarded-ad exposure ceiling across all reward types, replacing the incompatible old four/day ceiling. No-fill/failed-to-present earns nothing and uses no exposure slot. Skipping a shown ad uses exposure but no successful-power use. Keep the existing two-minute spacing. Two Bot Undo presses mean two player decisions, not two arbitrary marks; minimum eight plies before the first use does not strand the second charge.

A completed ad must deliver its promised item. For counterable actions, disclose the reward as an Undo Request token or Tactical token, not a guaranteed rewind or hint that the opponent may negate. Technical failure must preserve an earned item. Provider review remains an implementation requirement.

## Privacy and research implementation boundaries

The owner approves preparing useful game data from launch, including online matches, tournaments and human-vs-Bot games, for future Bot improvement and appropriate research. No day-one training job is authorized.

One onboarding choice is stored and synchronized; do not ask before every match. Necessary operational processing is explained separately. Optional research must use a valid affirmative choice where consent is required, with easy withdrawal. Do not implement a pre-ticked consent box as if failure to opt out were agreement. Protected-age users need the applicable age/guardian controls. A general 'game improvement' notice must not silently authorize separate demographic/ad research.

Real name is not required. Use optional nickname, age band where needed, and optional self-described gender with Prefer not to say for a separately authorized adult research study. Do not infer demographics. Hiding a name is not anonymization or a research opt-out. Child/unknown-age demographic and advertising profiling stays off; age-appropriate gameplay stays available.

Measure in-game strategic skill, learning and behavior, not an asserted IQ. There is no validated Mega XOXO IQ test. Publications must use properly permissioned, reviewed aggregate results, identify confounders and uncertainty, and not present age/gender associations as innate intelligence conclusions. Any future IQ study requires a separate validated instrument and research protocol. No public individual-level research export or demographic matchmaking.

Owner delegated retention selection. Proposed research schedule: consented adult game trajectories up to 24 months with annual necessity review; working exports up to 90 days and never past source expiry; raw ad analytics 90 days; local pending-upload spool 7 days; encrypted ordinary backups 35 days after pruning is implemented. Earlier withdrawal and applicable requirements override every maximum. No general claim that these are the legal maximums. Retain genuinely anonymized reviewed aggregates long term; removing names or hashing identifiers alone is insufficient. Youth research requires a separate lawful protocol and schedule, not the adult defaults.

## Required capture changes

1. Preserve game-capture/v1 and add a versioned event envelope for moves, undo requests/blocks/applications, hint requests/blocks/reveals, actual human choices, pauses and final result.
2. Never erase superseded moves. Keep parent/prefix/branch identity and monotonically increasing stateVersion; active ply count may decrease. Preserve canonical b*9+c encoding.
3. Record actual human action separately from Expert advice and Bot actions. Do not assign the eventual result to an abandoned/undone branch as if that result occurred there.
4. Online/tournament histories remain Core-authoritative. Local Bot uploads are client-replay-validated, not falsely server-authoritative or proof that a human made every move.
5. Respect each participant's applicable research eligibility at capture and export, without per-match prompting. Operational histories and economic receipts are separate from optional research.
6. Keep all branches, symmetries and duplicates of one root game together in one dataset split. Use held-out participant/time cohorts for skill studies. Preserve untouched qualification data.
7. Extend deletion, export revocation, retention sweeps and backup-journal replay to new events/optional research fields. Build no demographic/difficulty/ad-targeting cross-over.

## Final dependency order

| Order | Work | Owner | Depends on |
| --- | --- | --- | --- |
| 1 | Record these decisions; replace stale enrollment/website/tutorial/window blockers. Recheck branch ancestry and exact-source CI. | WebUI + Main | None |
| 2 | Verify approved developer accounts, IDs, signing identities and native provider configuration; no new fees. | Codex + Main | 1 |
| 3 | Implement one-time purpose choices, age-appropriate access, withdrawal and the approved privacy/retention controls. | Main + Codex | 1 |
| 4 | Extend capture to all eligible online/tournament and local-Bot sources with truthful provenance and immutable power-event history. | Main | 3 |
| 5 | Prove real email, API/Core/WSS routing and shared identities on a reachable nonproduction environment. | Main + Codex | 2 |
| 6 | Implement two-charge Bot Undo, single result finalization and preserved normal reward limits. | Main | 1 |
| 7 | Implement earned-token inventory, banking, shared ten/day limit, native callbacks and verified Core/SSV settlement. | Main + Codex | 2, 5, 6 |
| 8 | Implement Expert Tactical Power, separate shield types and bounded Casual request/counter protocol. No hint leaks before blocking resolves. | Main | 4, 7 |
| 9 | Sol integrates the accepted themed UI and new controls; run functional/accessibility regression, not repeat aesthetic approval. | Sol/Codex | 6-8 |
| 10 | Validate capture replay, consent changes, backups, exported-data lineage and complete release receipts on the current schema. | Main + WebUI | 3, 4 |
| 11 | Signed Android/iPhone tests: normal play, shared accounts, powers, lifecycle, quota races, LAN, screenshots and cleanup. | Main + Codex | 2, 5, 7-9 |
| 12 | Reconcile provider/store disclosures and true ad availability. Confirm permitted hosting; no automatic paid upgrade. | Codex + Main | 3, 7, 11 |
| 13 | Freeze exact build/image, capture receipts, role isolation, recovery and actual pre-write evidence. | Main + WebUI | 5, 10; 11-12 for affected native/ads release |
| 14 | ASAP controlled V4 freeze, fresh backup/import and per-actor reconciliation; fence old writer before V5's first write. | Main | 13 |
| 15 | Enable sole V5 authority, coordinate public routing and run smoke/backup/alerts. After first V5 write, recover on PostgreSQL, never stale SQLite. | Main + Codex | 14 |
| 16 | Publish each native build only when its app review and physical acceptance pass; enable rewarded powers only after their feature gate. | Main + Codex | 11, 12, 15 |
| 17 | Retire V4 runtime only after verified V5 stability; retain Git refs/recovery artifacts. | Main | 15 |
| 18 | Future adult research: aggregate strategy/retention studies, further cosmetics and revenue-aware difficulty proposals. No day-one implementation or unapproved model promotion. | Main + research reviewer | 10, real data and separate study review |

Base-game/backend release need not wait for experimental power-up serving if those capabilities remain disabled. Day-one capture for the actually released game modes is required. Store/native release and monetized power-ups each require their own real evidence. Future revenue-aware difficulty is documented as a separate research proposal, not permission for hidden forced losses, child profiling, or changing a named fixed Bot level behind the user's back.

## Mandatory regression checks

Legal replay including first side O; two Undo presses; stale Worker response; duplicate ad/SSV callbacks; bank full; account switch; UTC rollover; skipped/no-fill ad; simultaneous move/undo/timeout/resign; already finalized result; hints never revealed before counter outcome; separate block caps; no double reward/quest progression; withdrawal during match/export; local forged Bot history; source expiry not extended by copying; all branches stay in one split; old backup cannot resurrect withdrawn research data.

## Evidence and sources

Source audit and original file paths remain in the earlier monetization pack at repository commit 4752f2b84191923129ed259e896810c491f3086f. This revision changes product recommendations; it does not claim those changes were tested or implemented.

Official references reviewed 14 October 2026:
- Google rewarded ads: https://support.google.com/admob/answer/7313578?hl=en
- ICO valid consent: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/consent/what-is-valid-consent/
- EU children's consent: https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/legal-grounds-processing-data/are-there-any-specific-safeguards-data-about-children_en
- ICO children/profiling: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/children-and-the-uk-gdpr/what-if-we-want-to-profile-children-or-make-automated-decisions-about-them/
- ICO research retention: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/the-research-provisions/principles-and-grounds-for-processing/
- Apple age ratings: https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/
- India DPDP Act and phased commencement: https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf ; https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf
- Vercel Hobby terms: https://vercel.com/docs/plans/hobby

India's substantive DPDP obligations have a phased commencement under the official November 2025 notification; verify effective dates rather than claiming all provisions were already effective on 14 October 2026. Store ratings do not establish data-processing consent. No provider can be assumed to permit monetization just because its tier is free.
