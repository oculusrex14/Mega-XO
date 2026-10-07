# V5 architecture and ownership

**Normative target:** [NewArchitecture.md](sources/NewArchitecture.md), with the explicit scope decisions in [SCOPE-AND-DECISIONS.md](SCOPE-AND-DECISIONS.md). This document is an implementation design, not a claim that these services already exist.

## Topology

```text
Android bundled client ----+
iOS bundled client --------+--> api.megaxo.online [Vercel account/API]
Retained browser client ---+             |
Future browser (deferred) -+             +--> Neon PostgreSQL [durable truth]
                                        |
                                        +--> authenticated Core command ingress
                                                      |
Clients -- one-use ticket --> rt.megaxo.online --> Core A / Core B [Oracle]
                                                      |       |
                                                      +-- Neon + managed Redis

PostgreSQL jobs/outbox --> Worker [initially Oracle]
                         |--> email / provider follow-up / privacy / projections
                         +--> Core commands for economic or competitive effects

Neon restore history + direct logical dumps --> encrypted R2 backup repository
Operator/Admin --> Tailscale + loopback/private interfaces, never public routing

megaxo.online / www: reserved Vercel presentation boundary; new product deferred
```

Do not proxy every game move through Vercel when direct realtime is available. Keep authenticated HTTP compatibility/fallback for retained clients and unreliable socket networks. All transports feed the same Core commands and revision/idempotency machinery.

## Deployable units and code layout

Use a modular monorepo with four main server/presentation deployment boundaries, plus native targets. Keep the approved client sources initially where they are and add a deterministic client-asset packaging step.

```text
apps/api             Vercel HTTP control plane and compatibility adapters
apps/game-core       authoritative commands, match/queue/tournament processing
apps/worker          durable jobs and outbox dispatch
apps/web             reservation/documentation only; no new product build now
native/android       real Android application target, existing adapters reused
native/ios           real iOS application target, existing adapters reused
packages/domain      extracted/re-exported pure game/rank/rule functions
packages/economy     ledger and transaction-level invariants
packages/contracts   versioned HTTP/realtime/native schemas
packages/auth        verifier/session/ticket primitives
packages/db          migrations, repositories, import/reconcile tooling
packages/redis       namespaced ephemeral operations
packages/telemetry   sanitized logging/metrics/trace propagation
packages/testing     source fixtures and shared contract tests
```

These are proposed destinations, not current paths. Do not create empty packages as a substitute for extraction. Explicit import/re-export shims may preserve current tests. No forced framework migration is required for stateless Vercel APIs.

## Durable ownership and database permissions

| Domain | Mutation authority | Other service access |
|---|---|---|
| Actor identity, linked credentials, sessions | Account/API | Core verifies principal, reads minimal eligibility/session status |
| Profiles, friendship/block graph, cloud practice | Account/API | Core reads eligibility/social facts; worker handles authorized deletion workflow |
| Wallet, reservations, journal/ledger, grants, purchases, entitlements, cosmetic balances | Game Core | API reads allowlisted current views and routes commands; worker invokes Core for grants |
| Matchmaking decisions, occupancy, matches, results, ratings | Game Core | API/read models return authorized projections |
| Tournament state, fixtures, escrow, refunds/payouts | Game Core | Worker may wake processing, not settle independently |
| Jobs, outbox delivery, projection refresh | Worker | Producers insert jobs/events transactionally within their own mutation authority |
| Reports/privacy request intake | Account/API | Authorized worker/operator workflow, audited and policy-bound |
| Audit/security records | Issuing service via restricted append mechanism | Operator has private verification/read tools; no public mutation route |
| Temporary presence/queue candidates/cache | Redis and owning service | Rebuildable from durable state or client rejoin |

Define schema grants and ownership tests. `api_runtime` must fail a direct wallet update; `worker_runtime` must fail a direct payout; `core_runtime` must not get unrestricted credential export; `migration_owner` is CI/operator-only; `backup_reader` can read required durable records without application mutation rights. Runtime roles cannot perform DDL. Restricted functions should be narrowly scoped, explicit-search-path and auditable, not generic SECURITY DEFINER SQL escape hatches.

Use a transaction/unit-of-work boundary, not independently committing repository methods. Account provisioning creates the permanent actor without user-supplied balances; starting-wallet provisioning is a Core-owned idempotent command with a defined account-readiness handshake. Deletion similarly coordinates account disablement and economic occupancy under durable locks. No two services independently race to initialize a wallet.

## State classes

**PostgreSQL:** all identities, sessions/refresh families, store bindings, eligibility flags, balances/reservations, receipts and revocations, cosmetic credits, ranks/seasons/history, matches/commands/results/deadlines, tournaments and payouts, reports/privacy/deletion receipts, durable jobs/outbox, operation responses and audit continuity.

**Redis:** presence, heartbeat TTLs, candidate queue indices, cache, rate budgets, pubsub notifications and routing hints. Paid reservations and committed match assignment are never Redis-only. Losing queue position can require rejoining; losing a paid entry cannot lose funds. Session revocation and one-use credential security cannot rely on a Redis key surviving a wipe; durable authority remains available.

**Memory:** socket objects, local connection registries and short caches. Losing them cannot change a committed result or reset a deadline.

**Client:** approved offline/practice save and UI preferences. A restored practice save's wallet-shaped fields never overwrite server competitive balances. No client receipt/price/reward callback grants authority.

## Transaction flow and recovery

For a player command, authenticate and derive actor from the session; validate schema and operation key; load an existing idempotent result before declaring a stale revision; lock the match and affected actors/wallets in stable order; validate eligibility, revision and deadline using server/database time; execute the existing pure rule; persist state, ledger, result, command outcome and outbox event atomically; commit; then acknowledge/publish.

An uncertain commit is resolved by querying the operation ID, not retrying with a new one. Pubsub notifications may be missed or repeated; clients recover by committed revision. Timer and tournament work uses transactional claims, durable deadlines and fenced completion. Workers run with at-least-once delivery and idempotent effects. Never hold a wallet lock while contacting Apple, Google, Resend or AdMob.

## Regional placement and connections

Keep Oracle Core, Neon primary, Redis primary and Vercel server-side compute close to IAD/US-East initially. Resolve each provider's actual region identifier and measure RTT; similarly named regions on different clouds are not proof of latency. Global CDN static assets do not require globally distributed economic writes.

Use small bounded Vercel connection budgets with the Neon pooled endpoint. Core/worker use bounded persistent pools; direct connections are reserved where session semantics are required. Schema migrations and logical dump/restore use direct, TLS-verified connections. Do not rely on session-level locks or settings surviving transaction-pool reuse. Set statement/lock/connection timeouts and an aggregate pool budget below the actual compute limits. Verify interactive transactions are truly one transaction with the selected driver [E01-E05].

## Failure behavior

| Failure | Required behavior |
|---|---|
| Core unavailable | Offline modes and Vercel independent reads remain usable; competitive mutation fails safely, no guessed results |
| PostgreSQL unavailable | No authoritative mutation or grant; bounded retry/read failure; no fallback SQLite writer |
| Redis unavailable | Preserve durable matches and assets; degrade presence/cache/new queue work, recover notifications through snapshots/polling; sensitive rate-limit fallback is bounded |
| Worker unavailable | Jobs remain durable; Core gameplay can continue if its own dependencies are healthy; alert backlog |
| Vercel API unavailable | Existing authenticated realtime may continue within session validity; new auth/ticket issuance can fail; offline remains available |
| Core process dies | Client reconnects to another process and latest committed match revision; same rules/deadlines |
| Oracle host dies | Same-host Core redundancy does not help; independent ingress/Core capacity is a separate host-HA upgrade |

Health endpoints distinguish liveness, readiness and operational recovery status. Old `/opsz` incorporates backup freshness; its V5 equivalent must keep that meaning rather than report green on process liveness alone. See [operations specification](specs/06-CI-SECURITY-AND-OPERATIONS.md).

## Future browser foundation without new product work

Reserve apex/www ownership in Vercel, keep static-asset routing off the VPS for the future site, establish exact allowed origins and callback contracts, host necessary association files, and verify a protected browser-style harness. The existing `play.antimatterinnovations.com` client can retain its unchanged static assets and use an origin-bound compatibility API during transition. It must stop using SQLite after the cutover. Neither a new landing page nor new browser account UI is required.
