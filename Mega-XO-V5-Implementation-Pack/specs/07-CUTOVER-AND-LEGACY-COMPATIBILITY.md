# V4.1 to V5 cutover and legacy browser continuity

Applies to Phases 18-23. **Phase 21's new website/browser product is deferred and is not a prerequisite.** This procedure must first be rehearsed against an isolated staging copy, including abort and post-write recovery paths.

## 1. Definitions and the rollback boundary

There is one durable production authority at a time. Before cutover it is V4 SQLite. After activation it is V5 PostgreSQL. No permanent live dual write is permitted.

The critical boundary is the **first post-import production application write accepted by V5**, not the earlier offline schema creation/import/reconciliation writes. Application writes include login/session refresh, bootstrap that creates a session, profile edits, queued jobs, provider inbox events, outbox advancement, matchmaking and economic operations. It is not safe to wait for 'significant gameplay writes' before declaring the boundary crossed.

Before this boundary, a verified unchanged frozen SQLite source can be re-enabled if V5 has accepted no new production effects. After the boundary, use a compatible PostgreSQL-backed previous release, a forward fix, or a carefully reconciled PostgreSQL recovery. Do not point users back at the old SQLite snapshot. A DNS rollback or Vercel rollback does not restore data consistency.

Maintain a durable cutover epoch/authority record and independent deployment evidence. Stop/revoke the V4 writer before admitting the V5 writer. Every production mutation path must check its configured environment/authority mode; a stale old deployment must not silently resume writing after restart.

## 2. Retain the existing browser product without building a new one

The current browser game at `play.antimatterinnovations.com` is approved. Keep its visual assets and client behavior. At transition, its requests must reach a V5 compatibility facade rather than an old SQLite authority. Prefer hosting its unchanged static bundle on Vercel when feasible, with same-origin rewrites/facade preserving existing requests. An interim existing static host is acceptable if it serves assets only and has no legacy durable writer; document its eventual static-host move.

Do not replace it with a new landing page, redesign its account screens or redirect users into an unfinished `megaxo.online` experience. The future apex can remain dormant. Browser-style acceptance uses the retained client or a protected test harness.

Inventory all old API/callback URLs, cookie names and response shapes. Browser cookies are origin-bound: a host cookie on the old domain cannot simply be read at `api.megaxo.online`. Keep an old-origin cookie facade or implement a bounded, secure one-time session exchange using preserved session state. Preserve verified actor ownership and CSRF. A controlled reauthentication through the existing UI is a fallback only when secure session continuity is impossible; document its scope and test it. Never create a new actor to compensate for a lost cookie.

Retain old provider callback/notification endpoints for the compatibility window. They route to the same V5 durable dedupe and state machine after transfer. Do not have both old and new handlers independently grant purchases or rewards. Review any GET route with side effects; production read-only smoke must not accidentally create sessions or advance matches.

## 3. Go/no-go evidence

Before scheduling the actual transition, require:

- Verified current V4 release, health/backup and restore evidence; source freeze/restart method tested.
- Foundation and PostgreSQL reconciliation gates complete, including serialized-state coverage and unchanged store/account identity bindings.
- V5 staging end-to-end, four-theme UI/gameplay parity, cross-platform identity, economic concurrency, realtime failover, provider/worker replay, independent restore and security tests pass.
- Native actual builds/distribution and required device acceptance complete; store production capability flags reflect real provider readiness. Existing approved gameplay is independent from purchase SDK feature enablement.
- Version/protocol/schema compatibility matrix complete for retained browser and native builds; previous PostgreSQL-compatible images retained.
- Production Neon/Redis/API/Core/worker resources, roles, regions, secret references, public routes, alerts and backups validated. Resources can be provisioned with application writers disabled.
- Migration/reconciliation/restore duration and chosen maintenance envelope measured; ongoing matches/tournaments have an explicit policy consistent with the approved game.

Prefer stopping new offers/queue/tournament entries and allowing existing work to finish before the final freeze. Do not blanket-void valid games to simplify deployment. If carrying active games is needed, it must use the already-proven durable import/deadline policy; no improvised timer reset or payout adjustment.

## 4. Rehearsal sequence

Take a consistent isolated V4 copy with representative accounts/reservations/purchases and known hashes. Practice the entire freeze, import, reconciliation, read-only bring-up, first-write transfer and smoke sequence. Practice abort before first write and a deliberately failed deployment after first write. Demonstrate that the latter retains PostgreSQL authority and does not revert players to stale SQLite.

Use synthetic provider events and protected test actors for rehearsal. Never point staging store/email callbacks at production recipients or secrets. Record each step, operator/agent identity, exact build/config/schema IDs, start/end time and outcome in the cutover evidence template.

## 5. Production state machine

### A. PREPARED: V4 remains the only application writer

Verify the exact running image and provider/DNS inventory again. Stage production-configured V5 releases without routing public domains to them. Disable autonomous Core timer processing, workers, webhook persistence and mutating session/bootstrap endpoints on the target. Validate connectivity with explicitly read-only health/permission checks. Restore tested backup material and record the fallback assets/edge config.

### B. DRAINING: preserve existing gameplay

Announce maintenance using existing product surfaces and available support channels, without UI redesign. Block new competitive starts through the approved maintenance mechanism, allow existing work to settle, and stop creating new ad tickets/purchase attempts where required by the transition. Preserve in-flight provider evidence and its retry/finalization deadlines. Do not acknowledge a provider callback whose event was neither durably persisted nor processed.

### C. FROZEN: no V4 mutations

Disable all V4 write routes, timers/jobs, operators and provider mutation paths. Fence old containers against restart, while preserving the single Caddy edge and safe maintenance/static responses. Capture the final consistent SQLite backup and its checksum/schema/release identity. Verify no source application writes occur during capture/import. Retain source and backup read-only with existing recovery keys.

During the short freeze, handle external callbacks using a proven retry strategy; return a retryable failure rather than false success if no durable inbox is active. If V5 starts durably accepting production provider inbox records, that is already a post-import application write and crosses the boundary. Do not claim a pre-write rollback window while accepting new events into PostgreSQL.

### D. IMPORTED_AND_VERIFIED: target is not yet a live writer

Import the exact final snapshot into the intended target with the migration run identity. Reconcile every required category and run all invariants. Reconcile pending jobs/provider events and preserved revocations; do not replay grants automatically during import. Configure role ownership, migration schema and environment IDs. Produce the signed/checksummed transfer manifest. A mismatch stops activation and leaves the original source frozen or safely restored as the sole writer.

### E. ARMED: read-only production validation

Start API/Core/worker processes in a verifiable nonmutating mode. Worker process liveness is permitted; claiming/completing real jobs is not. Test TLS/routing, private-path rejection, DB permissions, configuration/version reporting and read-only known-state probes. Do not call `GET /api/account/session` if it creates a session, or a queue/match GET that advances state. Verify staged Vercel build uses production config and correct target IDs.

### F. V5_AUTHORITY: irreversible by simple SQLite rollback

Record the authority transfer epoch, maintain V4 write fencing, and enable V5 application writes in a controlled order. Enable Core authority, then API admission, verified provider inbox processing and workers with their idempotent state machines. Capture the first-write boundary time/identity; from this point onward every rollback remains PostgreSQL-backed.

Route the existing browser facade and native endpoints to the same V5 authority. Promote the already-tested production Vercel deployment and switch/reload the planned edge/DNS configuration. DNS propagation must not expose two independent writers: old addresses serve maintenance or the compatibility facade, not mutable V4 state. Update canonical provider endpoints while retaining safe old forwarding paths.

### G. ACCEPTED: validate real flows and monitor

Run controlled real smoke: existing account/login, cross-platform profile/wallet/rank read, ranked match completion, tournament entry/settlement, reconnect to another Core, session revoke, supported provider sandbox/production-safe evidence, save sync, privacy export and monitoring. These smokes are writes; failure triggers PostgreSQL-compatible recovery, never stale SQLite activation.

Create a fresh independent PostgreSQL backup and verify its retrieval/restore path. Confirm ops-health and external alerts with actual delivery. Inspect error rates, DB pools/locks, queues, provider retries, outbox lag and support IDs against the accepted envelope. Record exact rollout evidence and any disabled optional native capability truthfully.

## 6. Abort and recovery matrix

| Point | Safe response |
|---|---|
| Before final freeze | Cancel preparation; V4 continues unchanged |
| Frozen/import incomplete, no V5 application writes | Remove nonserving target changes as appropriate, re-verify source checksum/consistency, restore V4 write service as sole authority |
| Read-only V5 smoke fails | Keep or restore sole V4 authority; record why no V5 application writes occurred |
| Any post-import production V5 write accepted | Keep V4 fenced. Roll back app/API to a tested PostgreSQL-compatible release or forward-fix; reconcile any recovery point before admission |
| New database restore required | Quarantine writers, choose verified recovery point, reconcile purchases/deletions/notifications and possible missing accepted operations, then reopen PostgreSQL authority |
| Redis lost | Rebuild ephemera/rejoin clients; no database rollback |
| Core process lost | Reconnect to another Core, recover revision/deadline; no forced void |

A permanent reverse migrator to V4 is not in the default plan. Do not claim one exists. Explicit business/data-loss decisions cannot be hidden inside a rollback script.

## 7. V4 retirement

After the agreed observation/retention window and successful recovery proof, remove V4 application writers and obsolete scheduling. Keep immutable tags, source snapshots, migration manifests and required encrypted backups according to policy. Archive SQLite as nonserving forensic/recovery material; never leave it writable and routable. Retire old endpoints only after compatibility/version evidence says supported clients and providers no longer need them. Update runbooks, monitors and on-call inventory before deleting old infrastructure.

The new website remains Phase 21 deferred. Production success is one shared backend plus working native/retained clients, not a newly designed apex website.
