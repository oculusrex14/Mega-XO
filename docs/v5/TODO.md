# V5 todos

The mutable execution source is [progress.json](progress.json); this is its readable projection. Task actions, verification criteria and dependencies are retained in that JSON and the original [tasks.json](../../Mega-XO-V5-Implementation-Pack/tasks.json). Update both status projections after meaningful work; never tick a task without its required evidence.

**Goal:** Deliver the V5 hybrid platform and real Android/iOS applications with shared permanent actor/assets, preserved approved game and retained browser compatibility; do not build the new website/browser product.

**Integration base:** `455b8ec9ea4070b4410d78f9eea2aaa06d32c0b2`. **Active phase/task:** P02 / V5-02-01 (PLANNED). **Progress:** 11/117 tasks terminal; 2/25 phase gates passed

Required path: execute P00–P20, P22–P23; owner-deferred P21 executes nothing; P24 is measurement-gated; phase prerequisites are gates, not status assumptions, and a deferred or measurement-gated phase is never used as another phase prerequisite. The foundation gate P00–P03 passes before dependent distributed work, and V5 CI starts in the foundation rather than only at P17.

## P00 — Freeze baseline, scope and ownership

Milestone: V5.0; status: `COMPLETE`; prerequisites: none. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/00-baseline-and-architecture.md).

- [x] **V5-00-01 — Verify Git and carry local work** (`COMPLETE`).
- [x] **V5-00-02 — Inspect live operations and reconcile handoff** (`COMPLETE`).
- [x] **V5-00-03 — Create or resume V5 integration branch** (`COMPLETE`).
- [x] **V5-00-04 — Freeze product and future ownership** (`COMPLETE`).
- [x] **V5-00-05 — Capture approved UI and rule baselines** (`COMPLETE`).
- [x] **V5-00-06 — Enable immediate V5 CI and progress records** (`COMPLETE`).

**Exit gate:** G00: exact green baseline, scope freeze, environment inventory and initial CI exist; contradictory runtime claims have an evidence-based resolution or precisely scoped gap. No production data migration starts with unproven recovery.

## P01 — Extract clean service and repository boundaries

Milestone: V5.0; status: `COMPLETE`; prerequisites: P00. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/01-service-boundaries.md).

- [x] **V5-01-01 — Map write paths and implicit effects** (`COMPLETE`).
- [x] **V5-01-02 — Introduce repository and transaction interfaces** (`COMPLETE`).
- [x] **V5-01-03 — Extract pure domain behavior without rebalance** (`COMPLETE`).
- [x] **V5-01-04 — Freeze versioned contracts and adapters** (`COMPLETE`).
- [x] **V5-01-05 — Add deterministic client packaging seam** (`COMPLETE`).

**Exit gate:** G01: existing UI and game behavior remain equivalent; pure domain and contract tests run independently of HTTP/SQLite; a transaction can span multiple repository operations.

## P02 — Provision Neon and versioned PostgreSQL schema

Milestone: V5.0; status: `PLANNED`; prerequisites: P01. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/02-neon-and-schema.md).

- [ ] **V5-02-01 — Resolve provider inventory and region** (`PLANNED`).
- [ ] **V5-02-02 — Design normalized authority schema** (`PLANNED`).
- [ ] **V5-02-03 — Implement migrations and role grants** (`PLANNED`).
- [ ] **V5-02-04 — Implement connection and environment guards** (`PLANNED`).
- [ ] **V5-02-05 — Deploy nonserving schema to isolated staging** (`PLANNED`).

**Exit gate:** G02: schema builds from zero solely through migrations; environments/roles are isolated; actual plan, TLS, region, pool and recovery settings are evidenced.

## P03 — Build deterministic SQLite import and proof

Milestone: V5.0; status: `PLANNED`; prerequisites: P02. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/03-sqlite-import-and-reconciliation.md).

- [ ] **V5-03-01 — Capture consistent source snapshots** (`PLANNED`).
- [ ] **V5-03-02 — Implement pure deterministic extraction** (`PLANNED`).
- [ ] **V5-03-03 — Import all durable account/game/economy state** (`PLANNED`).
- [ ] **V5-03-04 — Implement lossless accounting reconciliation** (`PLANNED`).
- [ ] **V5-03-05 — Make reruns and resume safe** (`PLANNED`).
- [ ] **V5-03-06 — Record foundation migration proof** (`PLANNED`).

**Exit gate:** G03: representative V4 snapshots import with zero unexplained per-actor/data differences; reruns and interruption recovery preserve identical canonical state and all financial/identity invariants.

## P04 — Replace production persistence with PostgreSQL adapters

Milestone: V5.1; status: `PLANNED`; prerequisites: P03. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/04-postgresql-runtime.md).

- [ ] **V5-04-01 — Implement account/social/save repositories** (`PLANNED`).
- [ ] **V5-04-02 — Implement Core-owned asset/ledger repositories** (`PLANNED`).
- [ ] **V5-04-03 — Implement match/tournament/provider persistence** (`PLANNED`).
- [ ] **V5-04-04 — Move schema setup out of constructors** (`PLANNED`).
- [ ] **V5-04-05 — Run differential and contention acceptance** (`PLANNED`).

**Exit gate:** G04: the V5 production path has no SQLite dependency; concurrent spends/settlements/payouts and rollback tests pass with approved behavior.

## P05 — Implement actor-centric sessions and credential lifecycle

Milestone: V5.2; status: `PLANNED`; prerequisites: P04. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/05-cross-platform-identity.md).

- [ ] **V5-05-01 — Implement account readiness and linking semantics** (`PLANNED`).
- [ ] **V5-05-02 — Implement access signing and public verification** (`PLANNED`).
- [ ] **V5-05-03 — Implement refresh rotation and device revocation** (`PLANNED`).
- [ ] **V5-05-04 — Implement browser and native credential paths** (`PLANNED`).
- [ ] **V5-05-05 — Issue durable one-use realtime tickets** (`PLANNED`).
- [ ] **V5-05-06 — Prove compatibility and session transition** (`PLANNED`).

**Exit gate:** G05: browser-style, Android-style and iOS-style clients resolve to the same permanent actor; refresh, revocation, provider linking and ticket replay tests pass.

## P06 — Introduce managed ephemeral coordination

Milestone: V5.3; status: `PLANNED`; prerequisites: P05. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/06-managed-redis.md).

- [ ] **V5-06-01 — Select and provision the actual managed service** (`PLANNED`).
- [ ] **V5-06-02 — Implement namespaced bounded primitives** (`PLANNED`).
- [ ] **V5-06-03 — Remove local-only operational state** (`PLANNED`).
- [ ] **V5-06-04 — Test full wipe and dependency failure** (`PLANNED`).

**Exit gate:** G06: Redis loss is temporary disruption only; all player assets/results/identity remain durable and queues/caches recover.

## P07 — Make matchmaking safe across multiple processes

Milestone: V5.3; status: `PLANNED`; prerequisites: P06. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/07-distributed-matchmaking.md).

- [ ] **V5-07-01 — Port existing queue policy unchanged** (`PLANNED`).
- [ ] **V5-07-02 — Implement join/cancel/heartbeat/expire** (`PLANNED`).
- [ ] **V5-07-03 — Commit assignments transactionally** (`PLANNED`).
- [ ] **V5-07-04 — Exercise distributed recovery** (`PLANNED`).

**Exit gate:** G07: multiple matchers cannot double-assign, double-charge or lose committed entrants; current matching and charge timing remain unchanged.

## P08 — Deploy revision-based durable realtime Game Core

Milestone: V5.4; status: `PLANNED`; prerequisites: P07. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/08-durable-realtime-core.md).

- [ ] **V5-08-01 — Implement authenticated WSS transport** (`PLANNED`).
- [ ] **V5-08-02 — Implement command revision transactions** (`PLANNED`).
- [ ] **V5-08-03 — Implement durable clocks and scheduled expiry** (`PLANNED`).
- [ ] **V5-08-04 — Implement snapshot/delta recovery and polling** (`PLANNED`).
- [ ] **V5-08-05 — Remove memory-authoritative restart recovery** (`PLANNED`).

**Exit gate:** G08: acknowledged moves survive process death and resume from committed state on another process; no reset deadline, duplicate effect or split match.

## P09 — Make tournament and lobby execution durable

Milestone: V5.4; status: `PLANNED`; prerequisites: P08. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/09-durable-tournaments.md).

- [ ] **V5-09-01 — Persist complete room and fixture state** (`PLANNED`).
- [ ] **V5-09-02 — Preserve user lifecycle behavior** (`PLANNED`).
- [ ] **V5-09-03 — Implement fenced timer and progression claims** (`PLANNED`).
- [ ] **V5-09-04 — Make settlement/refund indivisible** (`PLANNED`).
- [ ] **V5-09-05 — Prove full multi-worker tournament recovery** (`PLANNED`).

**Exit gate:** G09: crash/concurrent workers cannot double-pay, double-refund or lose escrow; approved tournament and private lobby behavior remains.

## P10 — Extract reliable jobs, notifications and provider retries

Milestone: V5.4; status: `PLANNED`; prerequisites: P09. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/10-durable-workers.md).

- [ ] **V5-10-01 — Implement durable job and outbox primitives** (`PLANNED`).
- [ ] **V5-10-02 — Extract email/security/privacy work** (`PLANNED`).
- [ ] **V5-10-03 — Extract provider notification and finalization work** (`PLANNED`).
- [ ] **V5-10-04 — Extract season/leaderboard/maintenance scheduling** (`PLANNED`).
- [ ] **V5-10-05 — Remove legacy duplicate schedulers** (`PLANNED`).

**Exit gate:** G10: unrelated jobs survive API/Core restarts; at-least-once delivery produces idempotent authorized effects and visible recoverable failures.

## P11 — Deploy Vercel account and stateless control plane

Milestone: V5.5; status: `PLANNED`; prerequisites: P10. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/11-vercel-control-plane.md).

- [ ] **V5-11-01 — Create isolated Vercel API project and previews** (`PLANNED`).
- [ ] **V5-11-02 — Move account/social/practice/read APIs** (`PLANNED`).
- [ ] **V5-11-03 — Route competitive effects to Core** (`PLANNED`).
- [ ] **V5-11-04 — Implement old-origin browser compatibility** (`PLANNED`).
- [ ] **V5-11-05 — Establish future website foundations only** (`PLANNED`).

**Exit gate:** G11: Vercel and Core serve the same staging actors with no overlapping economic authority; old client routes remain compatible.

## P12 — Introduce safe read models and caching

Milestone: V5.5; status: `PLANNED`; prerequisites: P11. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/12-read-models-and-cache.md).

- [ ] **V5-12-01 — Classify every read and sensitivity** (`PLANNED`).
- [ ] **V5-12-02 — Build versioned projections and indexes** (`PLANNED`).
- [ ] **V5-12-03 — Add bounded cache invalidation** (`PLANNED`).
- [ ] **V5-12-04 — Measure actual read-load reduction** (`PLANNED`).

**Exit gate:** G12: cache/projection loss affects speed, not correctness; private state is never shared-cached or used stale for economic authorization.

## P13 — Harden distributed trust boundaries

Milestone: V5.5; status: `PLANNED`; prerequisites: P12. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/13-service-security.md).

- [ ] **V5-13-01 — Enforce service and player authentication boundaries** (`PLANNED`).
- [ ] **V5-13-02 — Enforce browser/native/perimeter isolation** (`PLANNED`).
- [ ] **V5-13-03 — Enforce least-privilege SQL and secrets** (`PLANNED`).
- [ ] **V5-13-04 — Preserve audit and private operations** (`PLANNED`).
- [ ] **V5-13-05 — Run adversarial staging acceptance** (`PLANNED`).

**Exit gate:** G13: direct/internal/forged/replayed requests cannot bypass player and service authorization; existing security and gameplay decisions do not regress.

## P14 — Unify traces, metrics and alert delivery

Milestone: V5.5; status: `PLANNED`; prerequisites: P13. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/14-observability.md).

- [ ] **V5-14-01 — Propagate sanitized request/trace/support identity** (`PLANNED`).
- [ ] **V5-14-02 — Instrument role-specific health and metrics** (`PLANNED`).
- [ ] **V5-14-03 — Configure actionable alerts** (`PLANNED`).
- [ ] **V5-14-04 — Document operational triage** (`PLANNED`).

**Exit gate:** G14: one player-safe support ID can be traced across API/Core/DB/worker without exposing secrets; critical failure and recovery alerts actually arrive.

## P15 — Prove independent backups and disaster recovery

Milestone: V5.6; status: `PLANNED`; prerequisites: P14. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/15-backup-and-disaster-recovery.md).

- [ ] **V5-15-01 — Freeze measured recovery policy** (`PLANNED`).
- [ ] **V5-15-02 — Implement direct logical backup plus encryption** (`PLANNED`).
- [ ] **V5-15-03 — Test Neon recovery and independent restore** (`PLANNED`).
- [ ] **V5-15-04 — Schedule controlled recurring restore drills** (`PLANNED`).

**Exit gate:** G15: independently encrypted material can reconstruct the service data in an isolated PostgreSQL target, including privacy/revocation controls, within measured recovery objectives.

## P16 — Add Core process redundancy and rolling drain

Milestone: V5.6; status: `PLANNED`; prerequisites: P15. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/16-core-process-failover.md).

- [ ] **V5-16-01 — Deploy two independently managed Core processes** (`PLANNED`).
- [ ] **V5-16-02 — Implement health-aware routing and drain** (`PLANNED`).
- [ ] **V5-16-03 — Prove in-flight recovery** (`PLANNED`).
- [ ] **V5-16-04 — Document failure domains and measured limits** (`PLANNED`).

**Exit gate:** G16: losing one Core process does not destroy a valid committed match; clients reconnect to the surviving process. Same-host deployment is accurately labeled process HA.

## P17 — Complete independent component CI/CD and release gates

Milestone: V5.6; status: `PLANNED`; prerequisites: P16. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/17-independent-ci-cd.md).

- [ ] **V5-17-01 — Expand early V5 CI into full component gates** (`PLANNED`).
- [ ] **V5-17-02 — Publish independent immutable artifacts** (`PLANNED`).
- [ ] **V5-17-03 — Automate staged release and compatible rollback** (`PLANNED`).
- [ ] **V5-17-04 — Protect release credentials and migration ownership** (`PLANNED`).
- [ ] **V5-17-05 — Document real release version policy** (`PLANNED`).

**Exit gate:** G17: API/Core/worker and native artifacts can be built and released independently under schema/protocol compatibility and evidence gates.

## P18 — Complete the dedicated V5 staging platform

Milestone: V5.6; status: `PLANNED`; prerequisites: P17. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/18-full-staging-acceptance.md).

- [ ] **V5-18-01 — Verify full environment isolation** (`PLANNED`).
- [ ] **V5-18-02 — Run account/social/save and cross-service journeys** (`PLANNED`).
- [ ] **V5-18-03 — Run economic and game journeys** (`PLANNED`).
- [ ] **V5-18-04 — Run visual and behavioral parity** (`PLANNED`).
- [ ] **V5-18-05 — Rehearse final transfer and both recovery classes** (`PLANNED`).

**Exit gate:** G18: all components function together on isolated realistic data; retained browser/client-style flows and rehearsed migration/abort paths pass without affecting V4.

## P19 — Measure load, failure recovery and safe degradation

Milestone: V5.6; status: `PLANNED`; prerequisites: P18. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/19-load-chaos-and-capacity.md).

- [ ] **V5-19-01 — Define forecast and measured load tiers** (`PLANNED`).
- [ ] **V5-19-02 — Measure saturation and resource headroom** (`PLANNED`).
- [ ] **V5-19-03 — Run dependency and process chaos** (`PLANNED`).
- [ ] **V5-19-04 — Validate recovery and alert thresholds** (`PLANNED`).

**Exit gate:** G19: sustainable capacity, latency, headroom and failure behavior are measured at realistic history sizes; no integrity failure under retries, loss or concurrency.

## P20 — Build, sign and validate Android and iOS applications

Milestone: V5.7; status: `PLANNED`; prerequisites: P19. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/20-native-applications.md).

- [ ] **V5-20-01 — Freeze real native identity and build configuration** (`PLANNED`).
- [ ] **V5-20-02 — Build trusted bundled-client hosts** (`PLANNED`).
- [ ] **V5-20-03 — Implement secure session/network/realtime adapter** (`PLANNED`).
- [ ] **V5-20-04 — Integrate real native Google/Apple identity** (`PLANNED`).
- [ ] **V5-20-05 — Integrate four-product Play/StoreKit commerce** (`PLANNED`).
- [ ] **V5-20-06 — Integrate ads/consent and approved privacy resources** (`PLANNED`).
- [ ] **V5-20-07 — Complete actual device and cross-platform parity** (`PLANNED`).
- [ ] **V5-20-08 — Build/sign/upload and report store state accurately** (`PLANNED`).

**Exit gate:** G20: actual applications, not adapters alone, build and run the unchanged product against V5; required native/device/provider evidence and distribution status are explicit.

## P21 — New megaxo.online website and browser product: deferred

Milestone: V5.8; status: `DEFERRED_BY_OWNER`; prerequisites: none. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/21-new-website-deferred.md).

Owner-deferred phase: 0 tasks. No phase lists P21 as a prerequisite.

**Exit gate:** DEFERRED_BY_OWNER: no new website/browser product is built. Its infrastructure obligations are fulfilled in Phases 5, 11 and 20 and verified in 18/20.

## P22 — Execute final production authority transfer

Milestone: V5.9; status: `PLANNED`; prerequisites: P20. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/22-production-transfer.md).

- [ ] **V5-22-01 — Revalidate go/no-go and actual release identity** (`PLANNED`).
- [ ] **V5-22-02 — Stage production without admitting writes** (`PLANNED`).
- [ ] **V5-22-03 — Drain and freeze every V4 writer** (`PLANNED`).
- [ ] **V5-22-04 — Import and reconcile final source** (`PLANNED`).
- [ ] **V5-22-05 — Transfer authority and route clients** (`PLANNED`).
- [ ] **V5-22-06 — Perform production smoke and recovery confirmation** (`PLANNED`).

**Exit gate:** G22: V5 is the only live durable production application writer; existing and native clients share it; recovery and operational evidence is green. No dependency on deferred Phase 21.

## P23 — Retire obsolete V4 authority while retaining recovery evidence

Milestone: V5.9; status: `PLANNED`; prerequisites: P22. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/23-retire-v4-authority.md).

- [ ] **V5-23-01 — Permanently fence obsolete writers and schedulers** (`PLANNED`).
- [ ] **V5-23-02 — Retain required artifacts and update operations** (`PLANNED`).
- [ ] **V5-23-03 — Retire compatibility only from usage/version evidence** (`PLANNED`).
- [ ] **V5-23-04 — Publish final delivery and residual-item report** (`PLANNED`).

**Exit gate:** G23: no production service depends on V4 SQLite. Required history/backups and supported-client/provider compatibility remain available under policy.

## P24 — Set scaling triggers and act only on measured demand

Milestone: V5.10; status: `PLANNED`; prerequisites: P23. [Phase contract](../../Mega-XO-V5-Implementation-Pack/phases/24-evidence-led-scaling.md).

- [ ] **V5-24-01 — Publish baseline and review cadence** (`PLANNED`).
- [ ] **V5-24-02 — Define trigger-specific scaling runbooks** (`PLANNED`).
- [ ] **V5-24-03 — Apply extra capacity only when justified** (`PLANNED`).

**Exit gate:** G24: measured baseline and explicit scaling triggers are delivered. Additional infrastructure is conditional on evidence, not required speculative work.

## Acceptance and evidence

All 40 original acceptance cases (A01–A40) are preserved in progress.json; current statuses: NOT_RUN 40. [Acceptance contracts](../../Mega-XO-V5-Implementation-Pack/ACCEPTANCE.md) specify real integration/staging/device/provider proof; a planned checklist is not proof.

After each verified unit: record exact source SHA, command, target/environment, observed result, evidence reference and accurate evidence level; update PROGRESS/DECISIONS/OPEN-ITEMS and checkpoint on V5. Never mark uploads, submissions or reviews as approvals.
