# Mega XO execution guidance

## Goal and authority

Deliver the V5 hybrid platform and real Android/iOS applications described in [AGENT-GOAL.md](AGENT-GOAL.md). Preserve the approved game and retained browser client. One permanent actor, one PostgreSQL durable authority after cutover, one Game Core competitive/economic authority.

Read the goal and `Mega-XO-V5-Implementation-Pack/{README,CURRENT-STATE,SCOPE-AND-DECISIONS,ARCHITECTURE,EXECUTION,ACCEPTANCE}.md`. Use the pack's `tasks.json`, `acceptance.json`, `phases/INDEX.md`, current phase and referenced specifications. Read the original sources in `sources/`; the additional owner-carried originals are under `docs/Handoff/`, not at a root `NewArchitecture.md`.

Latest owner scope overrides the original handoff's restriction to Phases 0–3 and requirement to build a new website before migration. Prove the foundation gates first, then continue Phases 0–20, mark P21 `DEFERRED_BY_OWNER`, proceed directly from P20 to P22–23, and measure P24 scaling triggers. Do not build/redesign the new `megaxo.online` website/browser product. Its domains, API/auth/callback/association foundations and private harness remain in scope.

## Resume from evidence

Read `docs/v5/PROGRESS.md`, `docs/v5/progress.json`, `docs/v5/TODO.md`, `docs/v5/DECISIONS.md`, `docs/v5/OPEN-ITEMS.md` and `docs/v5/BASELINE.md` before continuing. The JSON is the mutable execution ledger; TODO.md is its readable projection. The supplied pack remains unchanged, including its historical baseline and checksum manifest.

Inspect current Git state and relevant CI at entry; preserve user work. Selected integration base: `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`, successful Actions run `37658524961`. `V5-platform` has now been created from that base after live recovery inspection: resume it, do not recreate it. Adopt subsequent upstream changes deliberately, not silently. Never commit V5 implementation to `V4.1`/`main`, rewrite V4 history/tags, force-push for tidiness, reset/clean or blindly stash.

Owner-carried untracked inputs at entry: `.agents/`, `AGENT-GOAL.md`, `Mega-XO-V5-Implementation-Pack/`, `docs/Handoff/`, `skills-lock.json`. Preserve them. Inspect the staged set explicitly when making checkpoints; do not blanket-stage unrelated work or credentials.

Update progress, evidence, decisions and open items after each meaningful unit. Every claimed verification records task/case IDs, exact SHA, command, target/environment, result and evidence location. Commit cohesive verified units on V5, push meaningful checkpoints and inspect CI. A template, code existence, tool presence or green CI is not device/provider/production proof.

G00–G09 are passed; all 51 tasks in P00–P09 are accepted. Phase 10 (durable workers) is the active eligible phase; G10 is not passed. P09 delivered complete tournament and room persistence (packages/services/tournaments.js), user lifecycle preservation (host-leave CANCELLED, transfer, pause/resume, 200-Elo cohort cap, normal-Elo independence), fenced timer and progression claims with stale worker rejection, indivisible settlement/refund with strict global lock order, and multi-worker recovery. All 21 tests across 5 P09 suites pass with zero skips/failures on real PG16. P10 extracts reliable jobs, notifications, and provider retries driven by durable jobs and outbox rows in PostgreSQL. Keep all resources Free; Neon sole durable authority; V4 production, native and store gates untouched.

## Current production correction

v4.1.2 is shipped. Fix `79e56d6896ec372ddd585499475a045b3595f458`; release `f1e5577d42809fc3da889ba76b87ca6c87e68575`; ledger/base `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`. Release image:

`ghcr.io/oculusrex14/mega-xo@sha256:71d33a1a9893a303c5ffcbdb090caefde22d9e7e054a8c2d6c494a44919b58e4`

The full digest/application SHA were read from the GitHub release and subsequently matched to the running Oracle app. Current livez/opsz are healthy; installed deployment files and an isolated encrypted-snapshot restoration were directly verified in `docs/v5/evidence/phase00-live-operations.json`. The original release-gate/deploy observations remain owner-reported/ledger-corroborated. Keep source SHA, running app/backup image and installed deployment-script revision separate; current V4 restore proof does not claim PostgreSQL or V5 acceptance.

Preserve the shipped guest-auth behavior: online `LINK_ACCOUNT_REQUIRED` is auth state, with **Sign in to play online** action copy, not a service-outage message. Auth state clears the poller, preventing pointless repeated 401 requests. Owner reports failing-first regression coverage in `tests/static-ui.test.js` and suite 340/342; the named `opsz` backup-freshness failure also occurs on the clean tree and is pre-existing. Do not rerun to confirm that reported failure, redefine ops health, suppress it or change approved behavior to get green. New affected-path checks still need genuine evidence.

## Product and technical invariants

- `docs/PRODUCT.md` and its explicit precedence patches (`docs/V3.5.1-ACCOUNT-COSMETIC-PATCH.md`, `docs/V3.5.1-EMAIL-VERIFICATION.md`) govern behavior. Read `native/README.md`, `native/COMMERCE-AND-ADS.md`, `docs/V4-OPEN-BLOCKERS.md` and deployment runbooks. V4-only architecture restrictions are historical constraints on the live V4 system, not a ban on the authorized V5 topology.
- No UI layout/theme/asset/game-rule/economy/season/rank/matchmaking/tournament/ad-placement changes. Preserve all four themes: `vector`, `midnight`, `paperclub`, `afterhours`. Bought and earned Crowns retain identical approved utility. Frames remain archived; abuse signals remain review-only; no invented gameplay gates.
- Capture approved source/rule and actual UI baselines before application changes. Small unavoidable native SDK/system adaptations require requirement, files, before/after evidence and verification in `docs/v5/UI-EXCEPTIONS.md` when an exception occurs.
- Target Vercel account/social/read API; Neon PostgreSQL durable truth; managed Redis/Valkey disposable coordination; Oracle authoritative Core and initial worker; direct WebSocket realtime with accepted HTTP fallback; independent encrypted R2 backups. No second identity system, SQLite production fallback or permanent dual writer after cutover.
- Preserve existing text actor IDs, tags, provider subjects, verified email/password hashes, permanent store bindings, purchases/refund tombstones, relationships, histories, privacy/deletion state, balances and reservations. Currency is integer units; Elo preserves hundredths. Migrate both SQLite relational data and serialized `state(id=1,json)`. Never invoke time-sensitive constructors during extraction. Reconcile per actor/asset/relationship/reservation with zero unexplained differences; reruns never mint/re-grant.
- Only Core mutates competitive/economic state. Separate API/Core/worker/migration/backup roles. PostgreSQL transactions bind mutations, operation outcomes and outbox events; external I/O stays outside economic transactions. At-least-once delivery has idempotent effects, durable revisions, constraints and fencing. Committed moves/deadlines survive process death and cross-Core reconnect.
- Native apps bundle allowlisted approved client assets and support approved offline modes; do not bundle server authority or secrets. Native credentials stay in secure host storage; browser sessions use protected cookies. Only backend-verified stores or AdMob SSV grant rewards. Do not restore consumables as new grants or finish/consume before durable delivery.
- First post-import production application write, including auth/background/webhook writes, ends SQLite rollback eligibility. Thereafter preserve PostgreSQL authority and forward-fix or use a tested PostgreSQL-compatible previous build.

## Operations, access and storage

Use `ssh command` over Tailscale for the known Oracle machine, not public port 22. Production root is `/opt/mega-xo`; old staging is `/opt/mega-xo-staging`. Exactly one ingress owns host 80/443. New staging must coexist without stopping production or co-hosted services. Two same-host Core containers prove process failover, not host HA.

Preserve dedicated audit HMAC isolation, monitoring, private operator interfaces, encrypted recovery repositories and off-host key custody. Reconcile historical backup claims against current status and real restore evidence; do not assume the old handoff's outage remains current after v4.1.2. Never destructively initialize an existing Restic repository. Deploy immutable digests, never mutable tags.

Discover actual authenticated Hostinger/Vercel/Neon/GitHub/Cloudflare/native accounts, objects, quotas and devices; availability is owner-authorized but not proof of a particular permission or provider approval. Use existing secret files/stdin/provider stores. Never print/commit secrets, tokens, OTPs, private keys, full env/auth files, raw player data, signing material or authenticated traces. Provider safety prompts/legal terms and high-impact actions still require appropriate owner confirmation; do not invent legal approval.

Actual storage inventory: internal local APFS~22GB free; `/Volumes/T9` is local exFAT~922GB free, for finished artifact/log archival only, not native cache/SDK/git/DerivedData roots. DGX is verified Linux/ext4 via dgx-ts SSH with mounted SMB~2.33TB free; network SMB is not a local cache substitute. Owner permits overflow storage but not unrelated deletion/reformatting. No relocation/deletion performed.

## Delegation and completion

Owner explicitly requested subagent orchestration. One parent integration owner freezes interfaces and serializes schema/migration/identity/economic contracts, assigns substantial independent file-owned slices together and integrates/verifies once after they finish. Avoid concurrent edits to shared files; implementation may run independent slices concurrently, but recorded acceptance follows actual task/phase prerequisites. Keep exact sanitized failures and continue reachable work.

Distinguish implemented, locally tested, staging-verified, device-verified, uploaded, submitted, provider-approved and production-enabled. Final delivery must include service URLs/SHAs/digests, native artifact/build references, database identity, restore proof, UI/gameplay parity and genuine residual items. A task ledger setup is not a completed V5 phase or deployed platform.
