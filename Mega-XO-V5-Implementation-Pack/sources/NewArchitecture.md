Yes. With **Neon now selected as the durable database layer**, this is the final V5 target I would build toward.

The central rule is:

> **Mega XO has one identity system, one authoritative PostgreSQL database, and one competitive game authority. Browser, Android and iOS are simply different clients of the same platform.**

# Final Mega XO V5 architecture

```text
                               INTERNET
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
          BROWSER              ANDROID              iOS
              │                   │                   │
              │                   │                   │
              ▼                   ▼                   ▼
       megaxo.online       api.megaxo.online   api.megaxo.online
              │                   │                   │
              └──────────────┬────┴───────────────────┘
                             │
                             ▼
                ┌─────────────────────────┐
                │         VERCEL          │
                │                         │
                │ Website                 │
                │ Browser game frontend   │
                │ CDN / static assets     │
                │ Edge routing            │
                │ Auth web callbacks      │
                │ Stateless HTTP APIs     │
                │ Profiles / Friends      │
                │ Cloud saves             │
                │ Read APIs               │
                │ API gateway             │
                └────────────┬────────────┘
                             │
              ┌──────────────┼────────────────┐
              │              │                │
              ▼              ▼                ▼
       ┌────────────┐ ┌──────────────┐ ┌─────────────────┐
       │    NEON    │ │ REDIS/VALKEY │ │ MEGA XO CORE    │
       │ PostgreSQL │ │              │ │ Oracle / VPS    │
       │            │ │ Match queue  │ │                 │
       │ DURABLE    │ │ Presence     │ │ Matchmaking     │
       │ TRUTH      │ │ Pub/Sub      │ │ Live matches    │
       │            │ │ Rate limits  │ │ Move validation │
       │ Accounts   │ │ Cache        │ │ Timers          │
       │ Wallets    │ │ Short locks  │ │ Elo settlement  │
       │ Rank       │ │ Realtime     │ │ Wallet writes   │
       │ Matches    │ │ coordination │ │ Tournaments     │
       │ Purchases  │ └──────┬───────┘ │ Anti-abuse      │
       │ Progress   │        │         │ Store verify    │
       └──────┬─────┘        │         └────────┬────────┘
              │              │                  │
              └──────────────┼──────────────────┘
                             │
                             ▼
                  ┌────────────────────┐
                  │  BACKGROUND WORKER │
                  │                    │
                  │ Email              │
                  │ Purchase retries   │
                  │ Notifications      │
                  │ Cleanup            │
                  │ Privacy jobs       │
                  │ Leaderboards       │
                  │ Scheduled work     │
                  └────────────────────┘

                             │
                             ▼
                  ┌────────────────────┐
                  │ CLOUDFLARE R2      │
                  │                    │
                  │ Independent        │
                  │ encrypted backups  │
                  └────────────────────┘
```

## Public domain layout

I would freeze these names early:

```text
https://megaxo.online
```

Canonical website + browser game. Hosted entirely on Vercel.

```text
https://www.megaxo.online
```

Permanent redirect → `https://megaxo.online`.

```text
https://api.megaxo.online
```

Public HTTP API used primarily by Android/iOS and optionally browser infrastructure. Hosted through Vercel's stateless API/control plane.

```text
wss://rt.megaxo.online
```

Realtime game transport directly to Mega XO Game Core.

That gives us a very clean separation:

```text
megaxo.online       → presentation
api.megaxo.online   → platform control plane
rt.megaxo.online    → competitive realtime plane
```

---

# Layer 1 — Vercel

Vercel becomes much more than simple static hosting, but it **does not become the competitive game authority**.

It owns:

- `megaxo.online`
- browser app bundles
- images/fonts/assets
- CDN
- web routing
- web Google/Apple OAuth callbacks
- account/session bootstrap
- profiles
- friends
- social APIs
- cloud practice saves
- public player profiles
- read-heavy statistics
- season metadata
- cosmetic catalogue
- cached leaderboards
- API gateway functionality
- preview deployments

It may initiate requests to Game Core, but it **cannot independently award Coins, Crowns, Elo, tournament prizes or match results**.

That boundary is critical.

---

# Layer 2 — Neon PostgreSQL

**Neon becomes Mega XO's durable source of truth.**

SQLite eventually leaves the production architecture.

Neon holds permanent records such as:

```text
actors
identities
credentials
sessions

profiles
friendships
blocks
cloud saves

wallets
currency ledger
escrow
purchases
entitlements
cosmetic credits

ratings
seasons
rank history

matches
match participants
match commands
results

tournaments
tournament players
fixtures
settlements

reports
moderation
privacy requests
audit records
background jobs
```

The database should be in the US-East/IAD vicinity initially because the current Game Core VPS is already there.

### Connection model

Vercel:

```text
Vercel Functions
      ↓
Neon pooled/serverless connection
```

Game Core:

```text
VPS
 ↓
persistent pooled PostgreSQL connection
 ↓
Neon
```

Workers:

```text
Worker
 ↓
persistent PostgreSQL pool
 ↓
Neon
```

All three operate on the same database but **not on the same tables indiscriminately**.

---

# Layer 3 — Redis / Valkey

Redis contains **temporary distributed state**, never financially important truth.

Use it for:

```text
matchmaking queue
presence
heartbeats
queue leases
pub/sub
short-lived locks
rate limits
session/cache hints
leaderboard cache
realtime routing
temporary reconnect information
```

Never make these exist only in Redis:

```text
Coins
Crowns
Cosmetic Credits
Elo
purchases
permanent inventory
completed matches
tournament payouts
account identity
```

A useful invariant:

> If deleting the entire Redis cluster would permanently harm a player, that information does not belong exclusively in Redis.

We should be able to wipe Redis and rebuild operational state from PostgreSQL.

---

# Layer 4 — Mega XO Game Core

This remains the most trusted execution environment.

Initially it runs on the Oracle VPS.

It owns:

```text
matchmaking policy
competitive eligibility
match creation
live game state transitions
move validation
turn timers
reconnections
ranked settlement
Elo calculation
Coin entry
Crown entry
escrow
payouts
tournaments
anti-collusion logic
anti-abuse signals
purchase verification
reward verification
competitive idempotency
```

The Game Core is the only authority allowed to say:

```text
this player won

their Elo changes by X

subtract 100 Coins

reserve 500 Crowns

pay tournament prize

this purchase grants 525 Crowns
```

Neither Vercel nor the client gets that authority.

---

# Layer 5 — Realtime game transport

Actual game traffic should eventually avoid unnecessary Vercel hops.

A client starts normally:

```text
Android / iOS / browser
        ↓
api.megaxo.online
        ↓
authenticated Mega XO session
```

When entering multiplayer:

```text
request realtime ticket
        ↓
short-lived one-use ticket
        ↓
wss://rt.megaxo.online
        ↓
Game Core
```

Then the game path becomes:

```text
PLAYER
  ↕
GAME CORE
  ↕
PostgreSQL / Redis
```

rather than:

```text
Player
 ↓
Vercel
 ↓
Game server
 ↓
Vercel
 ↓
Player
```

That keeps gameplay latency lower.

---

# Layer 6 — Durable match state

A major change from V4 is that **the process itself must not be the source of truth for a live game**.

A move should conceptually be:

```text
Move
 ↓
Authenticate actor
 ↓
Load match revision
 ↓
Lock / compare revision
 ↓
Validate legal move
 ↓
Update authoritative state
 ↓
Commit PostgreSQL transaction
 ↓
Publish new revision through Redis
 ↓
Send update to both players
```

Every command contains:

```text
match_id
actor_id
operation_id
expected_revision
command
```

This lets us guarantee:

```text
no duplicate move
no stale move
no double settlement
no split game state
```

If Game Core dies immediately afterward, PostgreSQL still knows exactly what happened.

---

# Layer 7 — Authentication

There is exactly **one Mega XO account identity**.

```text
Mega XO Actor ID
        │
        ├── Email/password
        ├── Google identity
        ├── Apple identity
        │
        ├── Browser sessions
        ├── Android sessions
        └── iOS sessions
```

Google/Apple subjects authenticate a user but do not become the Mega XO primary key.

The actor ID remains permanent.

### New session architecture

After successful login:

```text
Mega XO Identity Service
       ↓
short-lived signed access credential
       +
rotating refresh credential
```

Browser refresh credential:

```text
HttpOnly
Secure
SameSite
CSRF protected
```

Android:

```text
Android Keystore
```

iOS:

```text
Keychain
```

The access credential contains minimal claims such as:

```text
actor
session
audience
issued-at
expiry
auth-time
scopes
```

It does **not** contain authoritative wallet or rank values.

---

# Layer 8 — Background worker

V4 currently has multiple periodic tasks inside the production runtime.

Those should become a separate deployable worker.

Examples:

```text
email outbox
security notifications
expired session cleanup
privacy/deletion jobs
purchase acknowledgement retries
store notification processing
leaderboard refresh
scheduled maintenance
season jobs
moderation notifications
database housekeeping
```

Jobs should be durable in PostgreSQL.

Redis can wake workers, but PostgreSQL records whether the job actually exists and whether it completed.

---

# Layer 9 — Economy architecture

The new economy should be fully ledger-backed.

Example ranked entry:

```text
BEGIN TRANSACTION

lock wallet

verify:
coins >= entry

wallet
coins -= entry
reserved_coins += entry

ledger
- entry

match escrow
+ entry

COMMIT
```

Settlement:

```text
BEGIN TRANSACTION

lock match
lock wallets

release escrow

award winner
burn configured amount

write ledger entries

update rating
update match result

COMMIT
```

Either **everything happens or nothing happens**.

This becomes the foundation for Coins, Crowns, tournament prizes, purchases and future economies.

---

# Layer 10 — Data ownership

This rule prevents Vercel + VPS from eventually becoming two competing backends.

| Domain | Owner |
|---|---|
| Actor identity | Account/API service |
| Google/Apple linking | Account/API service |
| Profile | Account/API |
| Friends | Account/API |
| Cloud practice | Account/API |
| Public stats reads | API/read model |
| Matchmaking | Game Core |
| Live match | Game Core |
| Ranked Elo | Game Core |
| Coin/Crown wallet | Game Core |
| Economy ledger | Game Core |
| Tournament | Game Core |
| Store grant | Game Core |
| Presence | Redis + platform |
| Queue | Redis + Game Core |
| Public leaderboard cache | Vercel/Redis |
| Durable leaderboard truth | PostgreSQL |
| Email | Worker |
| Account deletion job | Worker/API |
| Backups | Neon + R2 |

No module should bypass these boundaries.

---

# Layer 11 — Backups

We should use **two independent backup systems**.

Primary:

```text
Neon
 ↓
managed backups / PITR
```

Independent:

```text
PostgreSQL
 ↓
encrypted logical backup
 ↓
Cloudflare R2
```

And periodically:

```text
R2 backup
 ↓
temporary Neon branch/database
 ↓
restore
 ↓
run Mega XO invariants
```

A backup that has never been restored is not considered proven.

---

# Layer 12 — High availability

V5 does not need full multi-region on day one.

Start:

```text
Game Core A
     │
Postgres + Redis
```

Then move to:

```text
             Load balancer
             /           \
            /             \
     Game Core A       Game Core B
            \             /
             \           /
              Redis / Neon
```

Because match state is durable, losing Game Core A should no longer destroy the active game.

The surviving client reconnects through Game Core B.

Eventually:

```text
kill server A
     ↓
socket disconnect
     ↓
reconnect
     ↓
server B
     ↓
load latest revision
     ↓
continue match
```

That's a major improvement over the current restart → void logic.

---

# Layer 13 — Region strategy

Initially keep authoritative services close together:

```text
US East / IAD
```

because your Oracle instance is already there.

Put close to one another:

```text
Game Core
Neon
Redis
Vercel server-side API compute
```

Users worldwide still get Vercel CDN assets near them.

But database writes don't bounce across continents unnecessarily.

Do **not** make the economy globally multi-primary yet.

Later we can have:

```text
Game Core US
Game Core EU
Game Core Asia
```

while maintaining controlled durable ownership.

That's a later scale optimization.

---

# Layer 14 — Repository layout

Eventually I would move toward:

```text
/apps

  /web
      megaxo.online

  /api
      Vercel HTTP/control plane

  /game-core
      realtime multiplayer
      matchmaking
      economy
      tournaments

  /worker
      async jobs


/packages

  /domain
      game rules

  /economy
      ledger/invariants

  /contracts
      API + realtime schemas

  /auth
      token/session primitives

  /db
      PostgreSQL repositories

  /redis
      distributed ephemeral state

  /telemetry
      tracing/logging

  /testing
      common fixtures
```

That gives us a modular platform without creating twenty independent microservices.

---

# Layer 15 — Environment topology

We should have four isolation levels.

### Local development

```text
local app
local/test PostgreSQL
local Redis
```

### Pull request / feature preview

```text
Git branch
   ↓
Vercel Preview
   +
Neon database branch
```

Potentially shared development Redis namespace.

### Staging

```text
Vercel staging
Neon staging DB
Redis staging
Game Core staging
Worker staging
```

Fully separate from production.

### Production

```text
megaxo.online
api.megaxo.online
rt.megaxo.online

Neon production
Redis production
Game Core production
Worker production
R2 backup
```

No production database is ever reused by staging.

---

# Final implementation phases

## V5.0 — Architecture foundation

Create:

```text
V5-platform
```

from the latest green V4.1.

Do:

- architecture ADRs
- service ownership
- new repo structure
- shared contracts
- repository interfaces
- extract pure domain logic
- PostgreSQL schema design
- Neon project
- migration framework

Nothing user-visible changes yet.

---

## V5.1 — PostgreSQL migration

Implement:

- Neon production/staging/dev structure
- SQL migrations
- PostgreSQL repositories
- wallet tables
- ledger
- match persistence
- tournaments
- accounts
- saves
- social data
- purchase state

Then build deterministic:

```text
SQLite → PostgreSQL
```

migration and reconciliation.

V4.1 stays operational during this work.

---

## V5.2 — Platform identity

Implement:

- actor-centric sessions
- signed short-lived access credentials
- rotating refresh sessions
- browser cookies
- native secure sessions
- JWKS/public verification
- session/device revocation
- realtime ticket issuing

Preserve Google/Apple/email account ownership semantics.

---

## V5.3 — Redis/distributed infrastructure

Provision managed Redis/Valkey.

Move:

- presence
- matchmaking queue
- rate limits
- pub/sub
- cache
- ephemeral coordination

out of local Maps/SQLite.

---

## V5.4 — Distributed Game Core

Convert:

```text
matchmaking
matches
moves
timers
settlement
economy
tournaments
```

to PostgreSQL-backed distributed operations.

Add:

```text
wss://rt.megaxo.online
```

with reconnect/revision semantics.

---

## V5.5 — Workers

Extract:

- mail
- purchase processing
- expiry
- maintenance
- account/privacy processing
- leaderboard materialization
- scheduled work

into a durable worker service.

---

## V5.6 — Vercel control plane

Create the actual Vercel project.

Initially preview/staging only.

Implement:

```text
api.megaxo.online
```

architecture and migrate suitable APIs:

- account
- profile
- friends
- saves
- public reads
- metadata
- web OAuth

Competitive commands remain Game Core controlled.

---

## V5.7 — Caching + read models

Introduce:

- leaderboard read tables
- profile/stat projections
- Redis cache
- Vercel caching for public data
- deterministic cache invalidation

No cached result becomes authoritative.

---

## V5.8 — Security + observability

Implement distributed:

- rate limiting
- service authentication
- support IDs
- trace IDs
- structured logs
- metrics
- database metrics
- queue metrics
- WebSocket metrics
- alerts

Keep admin/operator APIs Tailscale-only.

---

## V5.9 — Recovery + HA

Add:

- Neon PITR
- encrypted R2 database backups
- tested restores
- second Game Core instance
- load balancer
- rolling deployment
- graceful drain
- failure recovery

Prove live matches survive one core node dying.

---

## V5.10 — Full staging acceptance

Create an entirely new V5 staging environment.

Test simultaneously with:

```text
browser-style client
Android-style client
iOS-style client
```

Prove:

```text
same actor
same wallet
same rating
same friends
same purchases
same cloud save
same match history
```

across all platforms.

---

## V5.11 — Native applications

Wire Android/iOS against:

```text
api.megaxo.online
rt.megaxo.online
```

Complete:

- Google native login
- Apple native login
- secure credentials
- Play Billing
- StoreKit
- AdMob
- consent
- account deletion
- session recovery
- push/reconnect behavior

---

## V5.12 — Browser product

Only now build the final browser/web experience.

Deploy:

```text
megaxo.online
```

on Vercel.

Register final:

```text
https://megaxo.online/auth/callback/google
https://megaxo.online/auth/callback/apple
```

Browser account state is identical to mobile.

---

## V5.13 — Production migration

Final migration:

```text
V4 SQLite snapshot
        ↓
write freeze
        ↓
SQLite → Neon migration
        ↓
reconciliation
        ↓
V5 services online
        ↓
smoke tests
        ↓
enable production traffic
```

Keep a short explicit rollback window.

After accepting significant V5 writes, Neon becomes permanent authority.

---

## V5.14 — Scale based on evidence

Only after real traffic:

- add read replicas if required
- increase Game Core nodes
- regional Game Core deployment
- geographically closer realtime nodes
- dedicated worker capacity
- Redis scaling
- DB compute scaling

No speculative Kubernetes/Kafka/microservice explosion.

---

# Technology stack I would freeze

```text
Frontend / website
→ Vercel

Browser deployment/CDN
→ Vercel

Stateless API/control plane
→ Vercel Functions

Durable database
→ Neon PostgreSQL

Distributed ephemeral state
→ Managed Redis / Valkey

Authoritative game engine
→ Node.js Game Core

Initial game compute
→ Oracle VPS

Background workers
→ containers, initially VPS

Realtime
→ WebSockets

Identity
→ Mega XO actor IDs
→ Google / Apple / email as linked login methods

Native
→ Android + iOS

Independent backups
→ Cloudflare R2

DNS
→ megaxo.online
→ api.megaxo.online
→ rt.megaxo.online

CI/source
→ GitHub

Production principle
→ immutable builds + migrations + staged rollout
```

## The dependency chain

This is the sequence I would not violate:

```text
Architecture boundaries
        ↓
Neon PostgreSQL
        ↓
SQLite migration proof
        ↓
Platform authentication
        ↓
Redis
        ↓
Distributed matchmaking
        ↓
Durable Game Core
        ↓
Workers
        ↓
Vercel API
        ↓
HA / observability / recovery
        ↓
Native clients
        ↓
Browser product
        ↓
Production migration
        ↓
Scale by measurement
```

That is the architecture I would now consider the **final target for Mega XO**.

It gives us Vercel where Vercel is strongest, Neon where PostgreSQL is strongest, Redis for genuinely ephemeral distributed coordination, and keeps the integrity-sensitive competitive game engine under our control. Most importantly, it lets the browser game, Android app and iOS app behave as **three frontends to one Mega XO platform**, rather than three products that later need to be synchronized.

Yes. I’d turn the architecture into a **V5 execution program** with hard entry/exit criteria for every phase, so we never end up halfway between SQLite/VPS and Neon/Vercel.

**Base branch:** latest green `V4.1`  
**New long-lived branch:** `V5-platform`  
**Production `main`:** untouched until final V5 cutover  
**Current V4.1 staging:** remains available as rollback/reference while V5 is built.

# Phase 0 — Freeze architecture and service ownership

**Goal:** Make the architectural decisions irreversible enough that later phases do not invent competing patterns.

### Actions
- Create `V5-platform` from latest green V4.1.
- Add `docs/V5-ARCHITECTURE.md`.
- Freeze public domains:
  - `megaxo.online`
  - `api.megaxo.online`
  - `rt.megaxo.online`
- Freeze initial primary region around US-East/IAD.
- Document ownership of every existing API route.
- Categorize every mutable domain as:
  - Account/API-owned
  - Game-Core-owned
  - Worker-owned
  - ephemeral Redis state
- Define the rule that Neon/Postgres is authoritative durable state.
- Define Redis as non-authoritative.
- Define Game Core as sole competitive/economy authority.
- Document browser/Android/iOS auth flow.
- Document failure behavior for Vercel, Game Core, Postgres and Redis outages.
- Produce data-flow and trust-boundary diagrams.

### Tests
- Architecture consistency review.
- No existing production code changed.

### Done when
Every current server route and table has a future owner and there are no unresolved “Vercel or VPS?” responsibilities.

---

# Phase 1 — Create clean code/service boundaries

**Goal:** Separate domain logic from SQLite, HTTP and process-local state before replacing infrastructure.

### Actions
Move toward:

```text
/apps
  /web
  /api
  /game-core
  /worker

/packages
  /domain
  /economy
  /contracts
  /auth
  /db
  /redis
  /telemetry
  /testing
```

Initially this can be incremental rather than physically moving everything.

Extract interfaces for:

```text
AccountRepository
ProfileRepository
SessionRepository
CloudSaveRepository
WalletRepository
LedgerRepository
MatchRepository
TournamentRepository
PurchaseRepository
JobRepository
```

Extract pure logic for:

- game rules
- move validation
- Elo
- rank/season logic
- economy calculations
- tournament rules
- anti-abuse policy
- store product mappings

Define versioned contracts:

```text
/api/v1
/realtime/v1
```

Use shared validation schemas for browser/native/server communication.

### Tests
- Existing `npm test` remains green.
- Domain tests run without SQLite or HTTP.
- Contract validation tests added.

### Done when
The existing game behaves identically, but persistence and transport are replaceable through adapters.

---

# Phase 2 — Provision Neon and design PostgreSQL schema

**Goal:** Establish the future durable source of truth.

### Actions
Create Neon environments:

```text
production
staging
development
preview branches
```

Production:
- region near IAD
- TLS required
- autoscaling enabled
- scale-to-zero disabled
- PITR/backups enabled

Design proper PostgreSQL schema for:

```text
actors
identities
email_credentials
sessions
profiles
profile_saves

friendships
friend_requests
blocks

wallets
ledger_entries
escrows

ratings
seasons
season_history

matches
match_players
match_commands
match_results

tournaments
tournament_players
fixtures
tournament_settlements

purchases
entitlements
cosmetic_balances
reward_grants

reports
privacy_requests
audit_events
support_events

background_jobs
outbox_events
```

Add:
- foreign keys
- unique constraints
- indexes
- transaction boundaries
- integer currency types
- revision fields
- idempotency constraints

Stop creating schema dynamically in application constructors.

Introduce real migration files.

### Tests
Run complete database integration tests against disposable Neon/Postgres databases.

### Done when
Mega XO's schema can be created from zero exclusively through migrations.

---

# Phase 3 — Build SQLite → Neon migration tooling

**Goal:** Guarantee that V4 data can safely become V5 data.

### Actions
Build a migration tool that:

```text
V4 SQLite
   ↓
validate schema
   ↓
extract
   ↓
transform
   ↓
PostgreSQL
   ↓
reconcile
```

Migrate:
- actors
- usernames/tags
- identities
- credentials
- saves
- friends
- wallets
- Coin/Crown balances
- reservations
- ratings
- seasons
- match history
- tournament records
- purchases
- cosmetics
- reports
- privacy state

Generate reconciliation reports for:

```text
actor count
Coin total
Crown total
reserved balances
ledger totals
purchase count
identity count
profile count
friend graph
match count
rating state
tournament state
```

Make migration repeatable against copies of staging data.

### Tests
- Migration twice produces equivalent state.
- No duplicate actors.
- No currency creation/destruction.
- No identity reassignment.
- All invariants pass after import.

### Done when
A V4.1 staging snapshot can be imported into Neon with **zero unexplained reconciliation differences**.

---

# Phase 4 — Move server persistence to PostgreSQL

**Goal:** Make V5 operate natively on Neon rather than treating it as a backup database.

### Actions
Implement PostgreSQL repository adapters.

Move:
- accounts
- profiles
- saves
- social state
- wallet
- ledger
- matches
- seasons
- tournaments
- monetisation state

away from SQLite.

Use transactions for all multi-record mutations.

Economy transaction example:

```text
BEGIN
lock wallet
validate balance
reserve entry
write ledger
create/update match
COMMIT
```

Settlement:

```text
BEGIN
lock match
lock players
release escrow
award payout
burn amount
update Elo
write ledger
complete match
COMMIT
```

### Tests
- Concurrent spending test.
- Duplicate command test.
- Transaction rollback test.
- Settlement exactly-once test.
- Tournament payout exactly-once test.

### Done when
The V5 server test suite has **no production-path dependency on SQLite**.

---

# Phase 5 — Build the new cross-platform identity/session system

**Goal:** Browser, Android, iOS, Vercel and Game Core all recognize the same Mega XO actor securely.

### Actions
Keep:

```text
Mega XO actor ID = permanent identity
```

Google/Apple/email remain linked authentication methods.

Implement:
- short-lived signed access tokens
- asymmetric signing keys
- public JWKS
- rotating refresh sessions
- session/device IDs
- session revocation
- all-device logout
- recent-auth tracking
- scopes/audiences
- realtime ticket issuance

Browser:
- HttpOnly
- Secure
- SameSite
- CSRF protection

Android:
- refresh secret stored in Keystore

iOS:
- refresh secret stored in Keychain

Keep existing Google/Apple protections:
- nonce
- state
- PKCE
- issuer
- audience
- provider `sub`

### Tests
Simulate three clients:

```text
Browser
Android
iOS
```

All log into the same identity and resolve to the same actor.

### Done when
Services can verify a player's identity without querying the authentication database on every request.

---

# Phase 6 — Introduce managed Redis/Valkey

**Goal:** Remove process-local state that prevents horizontal scaling.

### Actions
Provision separate Redis environments for:
- staging
- production

Define key namespaces and TTLs.

Move:
- rate limits
- presence
- session presence leases
- matchmaking queue
- queue heartbeats
- reconnect hints
- realtime routing
- pub/sub
- safe caches

out of local Maps/SQLite.

Do **not** move:
- wallets
- Elo
- purchases
- completed matches
- permanent progress

to Redis.

### Tests
Delete all Redis data during staging.

Expected result:
- durable player state remains intact
- wallets/rank remain correct
- queues/presence rebuild

### Done when
Redis loss means temporary operational disruption, never permanent player-data loss.

---

# Phase 7 — Distributed matchmaking

**Goal:** Allow multiple matcher processes without duplicate matches.

### Actions
Replace current process-local queue Maps.

Implement:
- queue join
- cancel
- heartbeat
- expiration
- skill-window expansion
- candidate claiming
- atomic match reservation
- duplicate prevention
- dead-worker recovery

Ensure:
- actor cannot occupy incompatible queues
- two workers cannot claim the same player
- match is committed to Postgres before clients receive it

Preserve all existing:
- rank rules
- placement rules
- recent-opponent rules
- anti-collusion behavior

### Tests
Run multiple matchmaking workers concurrently against the same queue.

Hammer with synthetic players.

### Done when
No duplicate matches, lost players, double entries or conflicting queue state occur under concurrency.

---

# Phase 8 — Build durable realtime Game Core

**Goal:** Make live multiplayer survive process failures.

### Actions
Expose:

```text
wss://rt.megaxo.online
```

Flow:

```text
authenticated player
      ↓
request one-use realtime ticket
      ↓
connect WebSocket
      ↓
redeem ticket
      ↓
Game Core
```

Each command contains:

```text
operation_id
match_id
expected_revision
actor
command
```

For every move:

```text
authenticate
↓
load authoritative match
↓
check revision
↓
validate move
↓
commit PostgreSQL transaction
↓
publish revision via Redis
↓
notify players
```

Implement:
- reconnect
- missed revision recovery
- heartbeat
- session replacement
- stale command rejection
- duplicate command idempotency

Retain HTTP polling fallback initially.

### Tests
Kill Game Core during a live match.

Restart/connect another process.

Match resumes from the latest committed revision.

### Done when
Game Core memory is a performance optimization—not the authoritative game state.

---

# Phase 9 — Rebuild tournaments for distributed execution

**Goal:** Remove single-process tournament ownership.

### Actions
Move tournament state into PostgreSQL.

Persist:
- room
- roster
- readiness
- rules
- fixtures
- clocks
- match results
- ranking
- escrow
- payout
- settlement

Use transactional locking/revisions.

Multiple tournament workers must safely process timers using claim semantics such as:

```text
FOR UPDATE SKIP LOCKED
```

Redis publishes UI updates only.

### Tests
- simultaneous workers
- worker death mid-tournament
- timeout processing race
- settlement race
- refund race
- duplicate command race

### Done when
No tournament can double-pay, double-refund or lose escrow because a worker crashed.

---

# Phase 10 — Extract durable background workers

**Goal:** Stop using one production process for every periodic job.

### Actions
Create:

```text
apps/worker
```

Move:
- email outbox
- security notifications
- purchase finalization
- provider retry work
- expired-session cleanup
- privacy/deletion jobs
- leaderboard materialisation
- database cleanup
- scheduled season operations
- moderation notifications

into durable jobs.

Use PostgreSQL job/outbox tables.

Each job gets:
- unique idempotency key
- retry policy
- backoff
- failure state
- visibility
- dead-letter/manual retry capability

### Tests
Kill worker halfway through processing.

Restart.

Job resumes exactly once.

### Done when
Restarting Game Core/API no longer interrupts unrelated scheduled jobs.

---

# Phase 11 — Build Vercel API/control plane

**Goal:** Introduce the Vercel half of the hybrid backend.

### Actions
Create Vercel project initially as **preview/staging only**.

Deploy:
- browser account/session bootstrap
- OAuth callbacks
- profiles
- friends
- social operations
- cloud saves
- public stats
- season data
- cosmetics/catalogue
- safe leaderboard reads
- API routing

Use Neon pooled/serverless connections.

Keep competitive writes out of Vercel.

Vercel must call/route to Game Core for things such as:
- ranked queue
- game commands
- wallet spending
- tournaments
- settlements

### Tests
Run Vercel and Game Core simultaneously against the same staging actor.

### Done when
Both environments coexist without overlapping ownership of competitive/economic writes.

---

# Phase 12 — Add read models and caching

**Goal:** Keep the system fast without making caches authoritative.

### Actions
Create optimized read models for:
- leaderboards
- player summaries
- public stats
- season standings
- tournament history

Use:
- Postgres indexes/materialized data
- Redis cache
- Vercel caching where safe

Never shared-cache private account responses.

Explicit cache classes:

```text
strong-current
short TTL
event-invalidated
public CDN cache
```

### Tests
Clear every cache.

Everything remains correct, only temporarily slower.

### Done when
Heavy reads no longer create unnecessary load on Game Core or primary queries.

---

# Phase 13 — Service security

**Goal:** Harden the new distributed trust boundaries.

### Actions
Implement:
- Vercel → Game Core service authentication
- audience-scoped short-lived credentials
- replay protection
- exact CORS/origin policies
- rate limiting
- abuse limits in Redis
- CSP
- HSTS
- secure cookies
- strict input schemas

Keep:
- operator API private
- Tailscale operator access
- secrets outside Git
- store credentials outside Vercel frontend

Propagate sanitized support IDs across services.

### Tests
Attempt:
- direct internal API calls
- replayed service token
- forged actor
- expired access token
- wrong audience
- origin mismatch

### Done when
Knowing an internal endpoint URL is insufficient to access it.

---

# Phase 14 — Unified observability

**Goal:** Make distributed failures diagnosable.

### Actions
Introduce trace/request identifiers from edge through:

```text
Vercel
→ Game Core
→ PostgreSQL
→ Redis
→ Worker
```

Metrics:
- HTTP p50/p95/p99
- API errors
- DB query latency
- DB pool usage
- Redis latency
- queue length
- matchmaking wait
- connected sockets
- active matches
- moves/sec
- settlements/sec
- worker backlog
- purchase failures
- event-loop lag
- CPU/RAM

Continue existing user-safe `MX-...` support IDs.

### Done when
One failed player action can be traced across the entire platform without inspecting raw secrets or personal data.

---

# Phase 15 — Backup and disaster recovery

**Goal:** Make Neon failure/vendor loss recoverable.

### Actions
Primary protection:
- Neon backups
- PITR

Independent:
- encrypted PostgreSQL backup
- Cloudflare R2

Schedule automated restore drills:

```text
R2 backup
↓
temporary PostgreSQL/Neon environment
↓
restore
↓
run invariants
↓
destroy
```

Define:
- RPO
- RTO
- retention
- restoration procedure

### Tests
Full simulated database loss.

### Done when
Mega XO can be reconstructed from independently held backup material.

---

# Phase 16 — High-availability Game Core

**Goal:** Remove the single Game Core process as a production dependency.

### Actions
Deploy:

```text
Game Core A
Game Core B
```

behind a WebSocket-capable load balancer.

Add:
- health checks
- graceful drain
- rolling deploy
- connection reconnect
- Redis pub/sub routing

Sticky sessions may improve efficiency but must not be required for correctness.

### Test
Kill Core A during active games.

Clients reconnect through Core B.

### Done when
No valid active match is destroyed merely because one Game Core instance dies.

---

# Phase 17 — CI/CD restructuring

**Goal:** Allow independent deployment of each platform component.

### Actions
CI pipelines for:
- domain packages
- API
- Game Core
- Worker
- migrations
- Postgres integration
- Redis integration
- realtime
- browser E2E
- security
- economy invariants

Build independent immutable Game Core/Worker images.

Vercel handles preview deployments.

Database changes follow:

```text
expand
↓
deploy compatible code
↓
backfill
↓
switch
↓
later contract/remove
```

Never require every service to deploy simultaneously.

### Done when
API, Game Core and Worker can each be upgraded independently.

---

# Phase 18 — Dedicated V5 staging platform

**Goal:** Test V5 without touching V4 staging/production.

### Provision

```text
V5 Vercel staging
V5 Neon staging
V5 Redis staging
V5 Game Core staging
V5 Worker staging
```

Import a staging copy of V4 data.

### Acceptance flows
Test:

```text
create account
login elsewhere
cloud-save sync
profile edit
friend request
ranked matchmaking
match completion
wallet deduction
Elo update
tournament entry
tournament payout
reconnect
server restart
session revoke
purchase fixture
account recovery
```

### Done when
All platform components work together under realistic traffic.

---

# Phase 19 — Load, chaos and degradation testing

**Goal:** Establish actual production limits.

### Test
- concurrent API traffic
- WebSocket counts
- active matches
- matchmaking throughput
- database pool saturation
- Redis saturation
- worker backlog
- slow PostgreSQL
- Redis outage
- Core crash
- lost network
- Vercel retries
- duplicate commands

Target significantly above expected launch load—ideally ~10× initial forecast.

### Verify degradation
If Game Core is unavailable:
- website remains online
- profiles/public reads may remain online
- offline play remains usable
- competitive writes fail closed

### Done when
Capacity limits and alerts are measured rather than guessed.

---

# Phase 20 — Android/iOS platform integration

**Goal:** Put native clients onto the exact same V5 platform.

### Actions
Freeze:
- Android package
- iOS bundle ID

Native APIs:

```text
https://api.megaxo.online
wss://rt.megaxo.online
```

Implement:
- Google native identity
- Apple native identity
- secure session storage
- realtime ticket
- reconnection
- cloud progress
- store purchases
- ads
- account deletion
- app-version compatibility

### Acceptance
Player can:

```text
login Android
play ranked
open iPhone
see updated rank/wallet
open browser
see same account
```

### Done when
There is demonstrably no separate “mobile account” concept.

---

# Phase 21 — Build `megaxo.online`

**Goal:** Finally build the actual website/browser product.

### Actions
Attach:

```text
megaxo.online
```

to Vercel.

Build:
- landing website
- browser game
- account UI
- profile
- rankings
- rewards/themes
- legal/support
- responsive desktop/mobile experience

Register final web OAuth callbacks:

```text
https://megaxo.online/auth/callback/google
https://megaxo.online/auth/callback/apple
```

Redirect:

```text
www.megaxo.online → megaxo.online
```

Static website traffic remains off the VPS.

### Done when
Browser Mega XO works as a first-class client of the same V5 backend.

---

# Phase 22 — Final production migration

**Goal:** Move V4 production state to V5 safely.

### Procedure

```text
announce maintenance
↓
disable V4 writes
↓
final SQLite backup
↓
run importer
↓
reconciliation
↓
run invariants
↓
start V5 Worker
↓
start V5 Game Core
↓
enable Vercel/API
↓
smoke test
↓
enable players
```

Maintain a short rollback window before meaningful V5 writes accumulate.

### Verify
- actor count
- balances
- ranks
- purchases
- profiles
- identities
- friends
- saves
- tournaments
- backups
- alerts

### Done when
V5 is the only authoritative production write path.

---

# Phase 23 — Retire V4 infrastructure

**Goal:** Remove obsolete architecture cleanly.

### Actions
- mark SQLite production read-only/archive
- keep required migration evidence
- retire obsolete endpoints
- retire old deployment scripts
- remove old migration compatibility code later
- update documentation
- archive V4 branches once appropriate
- retain release tags

Do not immediately delete useful forensic/recovery material.

### Done when
No production service depends on the V4 SQLite architecture.

---

# Phase 24 — Scale only from actual measurements

After launch, evaluate:

```text
Neon read replicas
additional Game Core nodes
regional realtime servers
worker scaling
Redis scaling
regional matchmaking
analytics warehouse
```

Only add them when telemetry demonstrates a reason.

Avoid prematurely introducing:
- Kubernetes
- Kafka
- global multi-primary currency
- dozens of microservices

---

## Recommended working sequence

I would execute these as the actual V5 milestones:

| Milestone | Phases | Outcome |
|---|---:|---|
| **V5.0 Foundation** | 0–3 | Architecture + Neon + migration proof |
| **V5.1 Persistence** | 4 | PostgreSQL becomes native persistence |
| **V5.2 Identity** | 5 | Cross-platform sessions |
| **V5.3 Distributed State** | 6–7 | Redis + scalable matchmaking |
| **V5.4 Game Core** | 8–10 | Realtime + tournaments + workers |
| **V5.5 Hybrid Cloud** | 11–14 | Vercel APIs + caching + security + observability |
| **V5.6 Reliability** | 15–19 | Backups + HA + CI + staging + load testing |
| **V5.7 Cross-platform** | 20 | Android/iOS |
| **V5.8 Web** | 21 | `megaxo.online` |
| **V5.9 Production** | 22–23 | Final migration + V4 retirement |
| **V5.10 Scale** | 24 | Evidence-based scaling |

And when we actually start, I would **only begin with Phases 0–3**. We should not try to build Redis, realtime, Vercel APIs and PostgreSQL simultaneously.

First establish the architecture, extract the boundaries, provision Neon, and prove that **every piece of V4.1 player state can move to PostgreSQL without losing or inventing a single Coin, Crown, account, rank or purchase**. Once that foundation is green, the rest becomes much safer.