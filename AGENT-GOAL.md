# Single execution goal: build and deploy Mega XO V5

You are the owner's local implementation agent operating in the Mega-XO repository. Deliver the V5 hybrid platform and complete Android/iOS applications using the implementation pack containing this file. Work through the entire authorized program, with meaningful commits and evidence at every gate. This is an implementation-and-deployment goal, not a request to produce another high-level plan.

## Outcome

Migrate the approved V4.1 product to one cross-platform platform: Vercel stateless account/social/read API, Neon PostgreSQL durable truth, managed Redis/Valkey ephemeral coordination, Oracle-hosted authoritative Game Core and background worker, direct WebSocket realtime, independent encrypted R2 backups, observable staged deployment and recovery. Android, iOS, and the retained browser client must resolve to the same permanent actor and the same wallet, rank, purchases, friendships and cloud progress.

Build real Android and iOS projects, integrate real native identity, secure sessions, billing, ads/consent and lifecycle/reconnect behavior, produce signed distributable artifacts with the available credentials, and complete internal distribution and provider/device acceptance. Prepare accurate store submissions; do not label a submission or build as store-approved until the provider actually reports approval. Preserve the game's existing experience.

**Do not build or redesign the new website or new browser product.** Establish its domains, API contracts, auth/callback foundations, association files, deployment boundaries and private test harness. Leave the new `megaxo.online` product surface dormant. Preserve the already-approved browser game and route it to V5 at cutover; it must not remain a second SQLite-backed production system.

## Authority and constraints

Read `README.md`, `CURRENT-STATE.md`, `SCOPE-AND-DECISIONS.md`, `ARCHITECTURE.md`, `EXECUTION.md`, and `ACCEPTANCE.md` in this pack. Read the original handoff and architecture in `sources/`, then the current repository's `docs/V4-OPEN-BLOCKERS.md`, `docs/PRODUCT.md`, its precedence patches, native contracts, and deployment runbooks.

The owner's latest scope overrides the old instruction to work only on Phases 0-3 and the old requirement to launch a new website before final migration. It does not remove foundation prerequisites: prove 0-3 before building the dependent distributed runtime. The final 25-phase sequence and final milestone table in `NewArchitecture.md` define phase IDs; this pack supplies execution details and explicitly recorded corrections.

Do not change UI layout, theme colors, assets, game rules, economy values, seasonal/rank rules, matchmaking policy, tournament structure, ad-placement policy or purchased-Crown utility. Bought and earned Crowns retain the same approved gameplay utility. Do not resurrect the archived frame collection, add purchase-source spending restrictions, invent new gameplay blockers, or build deferred features. Preserve review-only abuse signals as review-only. Where a native SDK requires a system dialog or unavoidable platform adaptation, make the smallest change and record why, affected files and before/after evidence. Do not disguise a redesign as refactoring.

The local environment is expected to provide Hostinger CLI, Vercel CLI, Neon access, GitHub, Cloudflare R2, Oracle SSH and native build tooling/credentials. Discover actual authenticated accounts, objects, quotas and available devices; do not assume historic access limitations still apply. Never print secrets, full environment files, private keys, passwords, OTPs, purchase tokens, raw database records or signed refresh credentials. Use existing secret files, stdin and approved provider secret stores. Do not commit `.env`, production data, signing keys, `.vercel` secret files or test traces containing credentials.

## Begin with current evidence, not stale assumptions

Inspect the checkout and remote. The review baseline was `V4.1@8a77d3f4eb95e363fb967efe9b01f814a703dbae`, with successful Actions run `37649977689`. Re-read branch and CI state; use the latest genuinely green V4.1 commit if it has advanced. Preserve local uncommitted work, including architecture files and `.agents/skills`; do not clean, reset, stash blindly, or overwrite user work. Record any carried local changes separately.

Create the long-lived branch **`V5-platform`** from the verified green baseline. Resume it rather than recreate it if it already exists. Keep `main`, V4 tags, and the active V4.1 deployment intact until the final cutover. Do not reuse a V4 tag or deploy a mutable image tag. Enable V5 CI in Phase 0/1 because the current workflow only includes V4-era branch/tag patterns.

Use `ssh command` via Tailscale for the known Oracle machine; direct public port 22 is intentionally not the access route. Inspect the actual running image digest, installed scripts, health, backup snapshot and restore evidence, Caddy port ownership, co-hosted services, and providers. The handoff says backup failure while the ledger says verified green: establish the current truth before touching recovery configuration. Fix a real backup defect before data migration/cutover; do not run destructive initialization against an existing Restic repository or mark an untested backup as proven. Preserve monitoring and the dedicated audit secret.

## Execution protocol

Use `tasks.json` and `phases/INDEX.md`. Complete the tasks, tests, deploy rehearsals and evidence in each phase; update a repository-local `docs/v5/PROGRESS.md`, `docs/v5/DECISIONS.md`, `docs/v5/OPEN-ITEMS.md` and machine-readable progress file after each meaningful unit. The package's checklist is initially unexecuted; do not copy a template status as proof.

Commit after each cohesive verified change, not just at the end of a phase. Push meaningful checkpoints to the V5 branch and inspect CI results. Record exact commit SHA, command, target environment, test result and evidence location. Use small reversible increments and expand/backfill/switch/contract migrations. Never rewrite historical commits or force-push merely to tidy progress. On context restart, read progress, current Git state and the next phase's prerequisites before continuing.

Do not ask for repeated phase approvals. Advance through all eligible tasks once gates pass. Parallelize independent tests, native scaffolding or documentation only after their contracts are frozen; do not have concurrent agents independently alter shared migrations, identity ownership or economic invariants. One integration owner serializes those changes.

When a real external prerequisite is missing, record the exact attempted action, sanitized failure, required object/permission/device, independent tasks still possible, and the smallest owner action. Continue every unblocked workstream. Never substitute fixtures for real production or device proof, fabricate legal approval, accept provider terms for the owner without authority, or label a pending store review complete. Do not use generic 'third-party blocker' placeholders when authenticated execution is available.

## Non-negotiable technical invariants

- PostgreSQL is the sole production durable authority after cutover. Redis can be erased without losing player assets or finalized results. No permanent dual-write SQLite/Neon architecture.
- Actor IDs are existing text identifiers, not necessarily UUIDs. Preserve IDs, tags, provider subjects, email verification, password hashes, store bindings, purchases/refund tombstones, histories, privacy/deletion state, all currency and reservations.
- The V4 database contains both relational tables and a serialized `state.json` aggregate. Inventory and migrate both. Parse source state without invoking time-sensitive constructors that roll seasons forward or mint defaults.
- Reconcile by actor, asset, relationship and reservation, not only global totals. Zero unexplained differences. Money/credits are integer units; Elo preserves hundredths. Import reruns never mint or re-grant.
- Only Game Core authorizes competitive transitions, wallet/escrow changes, grants, Elo and tournament settlements. API and worker roles do not have unrestricted economic write permissions. External I/O is outside monetary transactions.
- PostgreSQL transactions bind mutations, idempotency outcome and outbox events. Delivery is at least once; effects are idempotent. Database revisions, unique constraints and fencing protect against duplicate workers and stale locks.
- A committed move survives process death. Reconnect can land on another Core. Keep the accepted clocks, queue/rank policy, host-leave behavior and HTTP fallback semantics; do not reset timers or void valid games just because a process restarts.
- Native apps bundle the approved client assets and work offline for approved offline modes. Host-owned credentials remain in secure native storage, not localStorage or arbitrary page JavaScript. Browser sessions remain protected cookies; native transport is explicitly separated.
- Native store/ad bridges honor `native/COMMERCE-AND-ADS.md`. Only backend-verified store events or AdMob SSV grant rewards. Do not restore consumable Crown packs as fresh purchases or finish/consume before delivery is durably committed.
- One ingress process owns host ports 80/443. New staging must not take production offline. Two Core containers on the same VPS prove process failover, not host redundancy.
- The migration rollback boundary is the **first post-import production application write**, including auth, background and webhook writes. After that, keep PostgreSQL authority and forward-fix or deploy a tested PostgreSQL-compatible previous build; never silently restore old SQLite data.

## Required program finish

Complete Phases 0-20, mark Phase 21 `DEFERRED_BY_OWNER`, then execute Phases 22-23 after acceptance. Phase 24 records measured limits and concrete scaling triggers; add capacity only when evidence justifies it. Deferred Phase 21 is not a failed dependency for Phase 22.

Deliver in the repository: architecture/ownership ADRs; working applications and packages; migrations/importer/reconciliation; versioned compatibility contracts; infrastructure manifests and scripts; independent immutable service releases; native build/signing/distribution procedures and artifacts; cross-platform, UI parity, economy, restore, chaos and device evidence; production topology and release manifest; rollback/incident runbooks; and an accurate residual-items list.

The final report must distinguish implemented, locally tested, staging-verified, device-verified, uploaded, submitted, provider-approved and production-enabled. Include service URLs, branch/SHAs, immutable digests, Android version code/AAB and iOS build/archive references, active database identity, backup/restore result, UI/gameplay parity status, and anything genuinely pending. Do not claim the new website was built. Do not claim execution is complete because code exists or CI is green alone.
