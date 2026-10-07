# P06 - Managed ephemeral coordination: state inventory, primitives, invariants, provider matrix, and P07/P08/P12 contracts

Read-only design report. Classification tags: **[V]** verified from repository source/docs, **[V-doc]** verified from current provider documentation (URL given), **[D]** design decision, **[P]** provider-pending (requires an authenticated console/API/CLI read or a provisioned target).

Scope guard: no provisioning, no provider API call with credentials, no secrets/tokens/OTP/connection strings/player data appear in this document. No statement below claims a Redis/Valkey resource exists. The repository's own provider evidence marks `managed_redis_valkey` **UNRESOLVED** and Vercel authentication **UNAUTHENTICATED** (`docs/v5/evidence/phase00-provider-inventory.json:852,949-955`) [V].

---

## 1. Operational-state inventory

### 1.1 Every discovered in-process / local-only operational state

| # | Location (source) | State | Current lifetime / bound | Class | Verdict for V5 |
|---|---|---|---|---|---|
| 1 | `server/matchmaking.js:12` `this.tickets = new Map()` | queue tickets `{actor,mode,joinedAt,key,region,latencyMs}` | process lifetime; cap `maxTickets` (default 5000; production `config.maxQueued` default 200, range 20..500 - `production/main.js:57`, `production/config.js`) [V] | **queue-index** | Redis candidate index + lease (V5-06-02), PG not required |
| 2 | `server/matchmaking.js:12` `this.results = new Map()` | matched-result cache `{state,mode,matchId,termsHash,expires,quality,ratingGap}` | until match leaves OFFERED/PLAYING | **cache (derivable)** | Redis short-TTL cache; authority = committed PG match (V5-06-03) |
| 3 | `server/queue-session.js:6` `this.seen` | last-activity ms per actor; 45 s staleness ⇒ `disconnected` | 45 s semantics, pruned at 300 s | **presence/heartbeat lease** | Redis (same 45 s semantics, TTL 60 s) |
| 4 | `server/queue-session.js:6` `this.terminal` + `this.terminalAt` | terminal queue results (`expired/declined/cancelled/disconnected`), 300 s retention, cap `max(1000, maxTickets*4)` | 300 s / bounded | **cache** | Redis STRING JSON + TTL 300 s, capped |
| 5 | `server/queue-session.js:6` `this.pendingTickets` | declared, only ever `.delete()`d, never read [V] | - | **dead** | delete (no migration) |
| 6 | `server/community-server.js:29` `networkLimits` | per-IP request counter, 1800/min, Map cap 4096 with oldest-first eviction [V] | 60 s windows, 4096 keys | **rate-budget (process-local)** | Redis fixed-window counter + local fallback |
| 7 | `server/monetization-http.js:6` `rates` | per-actor 60/min counter, Map cap 4096 [V] | 60 s window | **rate-budget (process-local)** | Redis |
| 8 | `server/party-http.js:5` `limits` | per-address 2400/60 s counter, Map cap 1000 [V] | 60 s window | **rate-budget (process-local)** | Redis when online mode; keep local for `lanOnly` standalone |
| 9 | `server/production/abuse-guard.js:7,10-21` `memoryBuckets` | coarse abuse counters: `all` 600/60, `guest-session` 60/60, `account-post` 30/60, `search` 120/60, `ssv` 120/60; `maxMemory` 20000 then **reject** [V] | 60 s windows | **rate-budget (process-local)** | Redis; on outage keep the same local bucket (conservative, never unlimited) |
| 10 | `server/production/abuse-guard.js:23-25` `persistent()` → `v4_limits` | HMAC-sha256(ip)[:32] scoped counters (email-*, data-export, account-delete, store-notification, store-purchase, reward-ticket, matchmaking-mutation, tournament-*, provider-auth, player-report, social-mutation) [V] | durable rows with `expires` | **rate-budget (durable today)** | Redis as the shared coordination layer **plus** a durable floor for security-sensitive scopes (see §5.3) |
| 11 | `server/community-store.js:69` `rate()` → `repositories().community.count()` → `community_limits` | fixed-window counters keyed `bucket:subject:floor(now/1000/seconds)`; **rows never expire**; cleanup deletes 1000 oldest rows only when count > 10000 [V] | immortal rows, count-trimmed | **rate-budget (durable rows, ephemeral meaning)** | Redis with TTL = window remainder + grace; keep key window semantics identical |
| 12 | `server/community-store.js:191` `heartbeat()` → `session_presence` upsert | presence `(session,actor,seen,foreground)`; read window `now-45000`; rows deleted only after 1 h [V] | 45 s semantic window | **presence** | Redis presence ZSETs; delete the table's live use |
| 13 | `server/community-store.js:186-189` `presence()` state derivation | reads `account.activeMatch`, `isQueued(actor)` (→ `matchmaker.busy`, i.e. **another process's Map**), and `party_rooms` JSON [V] | per call | **presence (needs cross-process inputs)** | Redis queue membership + PG occupancy + room service; **removes a hidden write-on-read** (§6) |
| 14 | `server/production/read-context.js:6-22` `AsyncLocalStorage` cache keyed on `total_changes:data_version` | per-request read reuse only; hits/misses counters | per request | **cache (request-local)** | keep exactly as-is; **never** promote to cross-request cache |
| 15 | `server/production/perimeter.js` `Telemetry` | in-flight, request/error counts, duration buckets, event-loop p99, per-event counters [V] | process lifetime | **cache/metrics (local)** | local counters exported to P14; Redis not required for counters (optional aggregates) |
| 16 | `server/production/passwords.js:21-24` | auth work queue with `AUTH_BUSY` timeout, `concurrency: authWorkers` (2, range 1..4) [V] | process lifetime | **socket/CPU semaphore (local)** | stays local (resource protection, not coordination) |
| 17 | `server/rooms.js` `party_guests` + `RoomStore` tick | LAN guest bearer (24 h, ≤200, LAN-only) and an in-process 500 ms/1 s tick driving durable room timers [V] | process + durable rows | **LAN-local identity / durable timers** | guests stay SQLite (LAN standalone); timers stay durable in room JSON; Redis may only *wake* (P09) |
| 18 | `server/jobs.js:4-13` + `production/main.js:73-75` maintenance | full-state scan every 15 s issuing `snapshot:*`, `weekly:*`, `expire:<id>`, `timeout:<id>:<revision>` commands | process timer | **durable scheduler (local trigger)** | PG/outbox remains the scheduler of record; Redis due-queue is an accelerator + rebuildable |
| 19 | `packages/db/context.js` `CONTEXTS`/`SCOPES` WeakMaps | per-connection transaction scope + cached `DomainGraph` | one unit of work | **must-be-durable boundary** | untouched; the Redis coordinator must not write inside it |
| 20 | `server/matchmaking.js` `sweep()` pairing loop | performs policy evaluation over the whole ticket Map and commits a durable `pair:` command | per 1 s tick | **durable decision, ephemeral input** | split: Redis gives candidates, PG commits assignment (§7.1) |

Additional per-process caches found (same class as #6-#9 but provider-facing, not per-request): `server/admob-ssv.js` JWKS cache (24 h TTL), `server/google-push-auth.js` JWKS cache (60..3600 s), `server/identity-provider.js` JWKS/`cache` Map [V]. These are **provider-key caches**: they are safe per process, must be bounded, and are explicitly **not** part of P06's coordination surface (spec 04 §4 concerns JWKS refresh budgets; keep them if they are ever centralized).

### 1.2 Must be durable ⇒ OUT of Redis (goal: "committed assignments, security-critical one-use facts, revocation")

| Fact | Current home | Why Redis may never hold it |
|---|---|---|
| Match assignment, terms/termsHash, accepted list, revision, board state, deadlines, escrow, settled flag, receipt | `state` JSON (`matches`) + `commands` | A5/A16: exactly one assignment and one financial effect; Redis claim is explicitly not a lock (spec 03 §3) |
| Wallets, reservations, ledger, burns, weekly/snapshot rewards | `state` JSON | Money must survive wipe (A15) |
| Purchases, receipts, refund tombstones, store bindings, ad-ticket context, `v35_*` outcome tables | `state`/`v35_*`/`v41_store_*` | Binding must not be a regenerable cache (inventory §4.8) and tombstones must survive wipe |
| Sessions, refresh rotation families, session generation, `signin_attempts`, `email_challenges`, `v4_email_versions` | relational | One-use/security-critical (spec 02 §2, inventory line 103) |
| One-use realtime tickets | new (P05) | Spec 02 §6: store hash and redeem in PostgreSQL so replay is rejected after Redis loss; A14 exercises exactly this |
| Operation outcomes (`commands`, `party_commands`, `social_operations`, `v35_commands`) | relational | Retry must replay the committed result with Redis absent (spec 03 §1) |
| Outbox/jobs/leases/fences, mail budget (`v4_limits` `mail-budget:*`), deletion receipts, operator audit chain, support telemetry retention | relational | Durable worker/audit truth (inventory §4.11-12) |
| Socket handles, subscriptions in memory | process | Pack ARCHITECTURE memory tier: "Losing them cannot change a committed result or reset a deadline" |

---

## 2. Key grammar

```
mx:<env>:<schemaVersion>:<group>[:<sub>...][<identifiers>]

<env>           production | staging | preview:<pr> | local      (must equal MEGA_ENV; fail closed)
<schemaVersion> v1                                                (bump on any value-shape change)
<group>         presence | queue | rate | cache | proj | bus | route | due | hint | lock
```

Rules (enforced centrally by `assertKey`, mirroring the `packages/db/pg/guards.js` style) [D]:

1. `<env>` and `<schemaVersion>` are interpolated only from validated config, never from request input; a key that does not start with the exact expected prefix is refused (`KEY_NAMESPACE_MISMATCH`). Readers refuse a foreign `<schemaVersion>` rather than guessing a shape.
2. Identifiers are charset/length validated like the existing operation-key grammar `[A-Za-z0-9:_-]{1,160}` [V - `docs/v5/ROUTE-AND-DATA-INVENTORY.md` line 7].
3. No secret/token/PII in keys: session token → `sha256` hex; IP → HMAC-SHA256 truncated to 32 hex exactly as `AbuseGuard.subject()` does today (privacy parity) [V].
4. Cluster/script safety: every key a single Lua script touches shares one hash tag. Queue keys therefore use `mx:<env>:v1:queue:{cand}:...` so `ZADD/ZREM/HSET/PEXPIRE` across modes stay in one slot. Cost: one queue shard; acceptable at ≤500 tickets (max 20..500 today).
5. Environment isolation is not namespace-only (spec 03 §2): separate services/credentials per stage + fail-closed URL/stage validation + ACL where the plan provides it.

Concrete key list (identifier shapes only):

```
mx:staging:v1:presence:all:<actor>                 ZSET member=<sessRef> score=seenMs
mx:staging:v1:presence:fg:<actor>                  ZSET member=<sessRef> score=seenMs
mx:staging:v1:queue:{cand}:<mode>                  ZSET member=<actor> score=joinedAtMs
mx:staging:v1:queue:{cand}:ticket:<mode>:<actor>   HASH {mode,joinedAt,coreId,region,latencyMs,opKey,revision}
mx:staging:v1:queue:{cand}:op:<actor>:<opKey>      STRING claimId (idempotent join/cancel)
mx:staging:v1:queue:{cand}:claim:<claimId>         HASH {actors,coreId,fence,expiresAt}
mx:staging:v1:queue:{cand}:term:<actor>            STRING JSON terminal result
mx:staging:v1:rate:<scope>:<subjectHash>:<winIdx>  STRING counter
mx:staging:v1:cache:<shape>:<keyHash>              STRING JSON {v,asOf,payload}
mx:staging:v1:proj:<shape>:<key>                   STRING JSON {version,asOf,payload}
mx:staging:v1:lock:<purpose>:<keyHash>             STRING token
mx:staging:v1:route:core:<coreId>                  HASH {capacity,epoch,asOf}   (no socket handles)
mx:staging:v1:route:conn:<matchId>                 ZSET member=<coreId>:<connId> score=seenMs
mx:staging:v1:due:<kind>                           ZSET member=<id>[:<revision>] score=atMs
mx:staging:v1:hint:revoked:<actor>                 STRING generation (advisory only)
mx:staging:v1:bus:match:<matchId>                  PUBSUB channel
mx:staging:v1:bus:queue:{cand}                     PUBSUB channel (wake)
mx:staging:v1:bus:invalidate:<shape>               PUBSUB channel
mx:staging:v1:bus:revoke:<actor>                   PUBSUB channel
```

---

## 3. Primitives: exact commands, TTLs, caps, atomicity

### 3.1 TTL / size matrix

| Primitive | Structure | TTL | Max size / bound | Notes |
|---|---|---|---|---|
| presence all/fg per actor | ZSET | `PEXPIRE 60_000` refreshed on touch | ≤16 members per actor (`ZREMRANGEBYRANK -16 -1`) | Mirrors 45 s read window (`presence()` uses `now-45000` [V]) with 15 s client cadence |
| queue ticket | HASH | `PEXPIRE 45_000` on join/heartbeat (lease) | ≤ maxQueued tickets total across modes | 45 s matches `_clean` staleness [V] |
| queue candidate index | ZSET | none on the ZSET itself; members pruned when their ticket HASH is gone | ≤ maxQueued members | Never unbounded: pruned by `queue.prune` + ticket TTL |
| queue op / idempotency | STRING | `PEXPIRE 60_000` | ≤ maxQueued | Join/cancel idempotency window (current join key was not persisted at all [V]) |
| queue claim lease | HASH | `PEXPIRE claimTtlMs` (≥ 3× PG statement timeout, e.g. 15_000) | ≤ maxQueued | Advisory; must expire before any retry can re-claim |
| queue terminal | STRING | `PEXPIRE 300_000` | ≤ `max(1000, maxQueued*4)` (parity with `terminalAt` cap [V]) | Preserves `expired/declined/cancelled/disconnected` surfaces |
| result cache | STRING | `PEXPIRE 15_000` (queue offer window) then terminal 300 s | ≤ maxQueued | Authority is the committed PG OFFERED match |
| rate counter | STRING | `PEXPIRE (windowEnd - now) + 5_000` | one key per (scope,subject,window); namespace cap enforced by TTL only | Fixed windows identical to `floor(now/1000/seconds)` |
| cache entry | STRING | shape-specific 5..60 s (+ optional `allowStaleMs` for `proj`) | namespace admission counter cap (e.g. 5k keys) | Public/short-TTL shapes only |
| projection | STRING | 300 s..24 h by shape | ≤ 5k keys per shape | Version CAS on write |
| lock (single-flight) | STRING | `SET NX PX 2_000` | one per cache key | Prevents dogpile after wipe/flush |
| route core | HASH | `PEXPIRE 15_000` refreshed by Core heartbeat | ≤ 4 Cores | Enables API→healthy-Core routing |
| route conn | ZSET | `PEXPIRE 90_000`; members pruned by score | ≤ participants per match (2) / room (10) | Socket handles themselves stay in memory |
| due queue | ZSET | member score = deadline; no key TTL, membership bounded by active timers, pruned on claim/rebuild | ≤ active matches+rooms | Rebuildable from PG deadlines |
| revoke hint | STRING | `PEXPIRE 300_000` | ≤ actors revoked in 5 min | Hint only; loss cannot resurrect (PG generation) |

"No unbounded immortal keys" is directly testable: after the V5-06-04 suite, `SCAN` must find zero keys with `TTL == -1` and zero keys lacking the `mx:<env>:<version>:` prefix (assertion L7 below).

### 3.2 Command subset required (this is the V5-06-01 compatibility checklist)

| Primitive | Required commands |
|---|---|
| presence | `ZADD GT`, `ZREMRANGEBYSCORE`, `ZREMRANGEBYRANK`, `ZCARD`, `ZCOUNT`, `EXPIRE`/`PEXPIRE`, `PING` |
| queue | `ZADD`, `ZREM`, `ZSCORE`, `ZCARD`, `ZRANGEBYSCORE` (LIMIT), `HSET`, `HGET`, `HGETALL`, `HDEL`, `HLEN`, `SET NX PX`, `GET`, `GETDEL`, `DEL`, `PTTL` |
| rate | `INCR`, `PEXPIRE`, `PTTL` |
| cache/proj | `GET`, `SET NX PX`, `SET PX`, `GETDEL`, `DEL`, `PTTL` |
| lock | `SET NX PX`, `EVALSHA` compare-and-delete |
| pub/sub | `PUBLISH`, `SUBSCRIBE`, `UNSUBSCRIBE`, `PSUBSCRIBE` (TCP path) |
| route/due | `HSET`, `HGETALL`, `PEXPIRE`, `ZADD GT`, `ZRANGEBYSCORE`, `ZREM` |
| scripting | `EVAL`, `EVALSHA`, `SCRIPT LOAD`, `SCRIPT EXISTS` |
| health/probe | `HELLO`, `INFO server`, `COMMAND INFO`, `CLIENT SETNAME`, `CLIENT GETNAME`, `ACL WHOAMI`, `DBSIZE`, `SCAN` |
| ops (staging wipe only) | `FLUSHDB` (or documented provider wipe equivalent) |

**Explicitly not required and deliberately avoided** [D]: blocking commands (`BLPOP/BRPOP/BZPOPMIN`) — Upstash does not support blocking commands over REST [V-doc https://upstash.com/docs/redis/features/restapi]; keyspace notifications (we publish explicitly, so a provider without them still works); `KEYS`; `CONFIG SET`; `FLUSHALL` in production; Redis Functions/`FCALL` (prefer `EVAL` for portability); cluster commands (hash tags keep the design portable but nothing depends on cluster mode).

### 3.3 Lua scripts (single-flight semantics) and why each must be atomic

| Script | Guarantees | Failure it prevents |
|---|---|---|
| `rate.spend(scope,subject,limit,seconds,nowMs)` → `{hits,limit,ttlMs}` | `INCR`; if result == 1 then `PEXPIRE windowEnd-now+grace`; return hits | Immortal counter if the process dies between `INCR` and `PEXPIRE`; matches existing increment-then-compare semantics (`hits > limit` ⇒ `RATE_LIMITED`) |
| `queue.join(actor,mode,opKey,meta,maxQueued)` | op-key dedupe → same-mode no-op / different-mode `ALREADY_QUEUED`; global `ZCARD(mode1)+ZCARD(mode2) >= maxQueued` ⇒ `QUEUE_FULL`; `ZADD` + `HSET` + `PEXPIRE 45s` | Duplicate joins on two devices; exceeding the operator cap; phantom queued state |
| `queue.heartbeat(actor,mode,seenMs)` | `ZADD GT` on index + `HSET`/`PEXPIRE` on ticket; returns status tuple | Stale ticket outliving the client; extending a lease for a cancelled ticket |
| `queue.cancel(actor,opKey)` | `ZREM` index + `HDEL`/`DEL` ticket + set terminal `cancelled`; idempotent by opKey | Race between cancel and claim producing a stuck claim |
| `queue.claim(claimId,actorA[,actorB],fence,leaseMs)` | Conditional: both actors still in index and ticket `opKey`/`joinedAt` unchanged; then `ZREM` both + `HSET claim:{claimId}` + `PEXPIRE leaseMs` | Two matchers pairing the same actor (double assignment) |
| `queue.release(claimId,requeue)` | Compare-and-delete by `claimId`; `ZADD` back only if the ticket HASH still exists | Requeuing a player who already cancelled; leaving a permanent ghost claim |
| `queue.prune(maxQueued)` | Remove index members with no ticket HASH; enforce cap; drop expired terminals | Unbounded index growth |
| `due.claim(kind,nowMs,limit,leaseMs,fence)` | `ZRANGEBYSCORE 0 now LIMIT 0 K` then `ZADD GT now+leaseMs`; return `{id,revision,deadlineMs,fence}` | Two Cores settling the same timeout revision |
| `due.complete` / `due.release` | `ZREM` on completion (revision-guarded member) / re-arm on failure | Repeated settle loops |
| `presence.touch(actor,sessRef,foreground,seenMs)` | `ZADD GT` + window prune + rank cap + `PEXPIRE 60s`; `foreground=false` moves the member to the bg set | Presence rows accumulating forever (today: deleted after 1 h [V]) |
| `cache.putIfNewer(shape,key,version,asOf,payload,ttlMs)` | Store only when incoming `version > stored.version` | Old projection event overwriting a newer one (A-cache requirement) |
| `lock.release(key,token)` | Compare-and-delete by token | Releasing another worker's single-flight lock |

Scripts are loaded once per process (`SCRIPT LOAD`) with `EVALSHA` + `NOSCRIPT` fallback to `EVAL`; every script validates arity and returns stable codes; scripts never read keys outside their declared `KEYS` array (portability + provider analyzers).

---

## 4. Wipe-survival invariants

**I1 - Assets/results/identity.** Wallet, reservations, ledger, burned totals, ranks, ratings, purchases, entitlements, refund tombstones, bindings, results and history are only in PostgreSQL. Invariant test: take a durable invariant digest before and after `FLUSHDB` while activity is running; it must be byte-identical (A15 evidence: "database before/after invariant report").

**I2 - Assignments are not Redis facts.** A committed `queue:` match exists in PG with `status=OFFERED` (15 s window) or `PLAYING`. Redis only accelerates discovery. After a wipe, a client polling `GET /api/v1/match/:id` or the match status endpoint still sees the committed offer/match from PG, and a client polling queue status gets a rebuildable answer (§5.2).

**I3 - No paid occupancy can be permanently stuck.** Entry is charged only inside the Core transaction that creates the match reservation (today's `accept`/`_offer` semantics, inventory §4.1-2). A wiped claim lease therefore cannot strand funds; escrow is only released by the approved settle/refund path. Test: count reserve/payout/refund journal rows per actor before/after wipe + matcher kill.

[…101ln elided…]
| **AWS ElastiCache (Valkey/Redis)** | AWS account | Full compatibility | us-east-1 aligns with Neon default | TLS + auth token; VPC/security groups | No free tier for ElastiCache (Serverless has minimum cost) | Needs an AWS account and VPC reasoning that this project does not otherwise have | **Account existence unknown [P]**; defer to P24 measured scaling |
| **Self-hosted Valkey container** | Compose | Full | staging private network | Password/ACL via file | $0 | **Allowed for local/CI only**; spec 04 §4 forbids silently using it as the production replacement, and V5-06-01 verification forbids "unclaimed temporary or same-host production replacement" | Explicitly **not** a production answer |

### 7.2 Region pairing

Verified anchor: `packages/db/pg/guards.js` role/schema design and `docs/v5/evidence/phase00-provider-inventory.json` show the Neon region catalog with **default `aws-us-east-1` (N. Virginia)** and other options (`aws-us-east-2`, `azure-eastus2`, `aws-us-west-2`, EU, AP, SA) [V]. Pack guidance: keep Oracle Core, Neon primary, Redis primary and Vercel compute close to IAD/US-East initially, and treat same-named regions across clouds as unproven until RTT is measured [V]. Therefore: prefer the candidate's AWS `us-east-1` presence; measure Core→Redis, Vercel→Redis and Neon→Redis RTT before signing off (cannot be done until a target exists ⇒ [P], V5-06-01 stays open with V5-O006/V5-O009).

### 7.3 TLS / ACL / auth requirements (non-negotiable, enforced in `packages/redis/guards.js`)

Mirroring `packages/db/pg/guards.js` exactly [V]: mandatory TLS (`rediss://` or `tls:true`), explicit root CA (`MEGA_REDIS_CA_FILE`, PEM-validated, never `rejectUnauthorized:false`), refusal of `ssl:false`/`no-verify`, `ENVIRONMENT_MISMATCH` when a `local` label is used outside dev, host/stage allowlist check from the config, `CLIENT SETNAME` = `role/service/revision`, `redactUrl()` (never log a credential-bearing URL), a startup probe (`HELLO`/`INFO server` → engine name/version/uptime/role), a command-support probe (`COMMAND INFO` for the §3.2 list, fail closed with `COMMAND_UNSUPPORTED`), and, where the plan provides ACL, `ACL WHOAMI` to assert the expected user. Credential handling follows `production/config.js` discipline: `MEGA_REDIS_URL` / `MEGA_REDIS_URL_FILE` (ambiguous ⇒ `AMBIGUOUS_*`), never in Git, never in client bundles (extend `tests/v5-client-bundle.test.js` with a scan for `rediss://`/`REDIS_` tokens). No public Redis port; API/Core/worker use separate credentials; staging credentials cannot reach production (and vice versa) — tested (L7).

New config keys [D], validated like existing ones: `MEGA_REDIS_URL|_FILE`, `MEGA_REDIS_CA_FILE`, `MEGA_REDIS_NAMESPACE_ENV` (must equal `MEGA_ENV`), `MEGA_REDIS_MAX_QUEUED` (bounded like `MEGA_MAX_QUEUED`), `MEGA_REDIS_POOL_MAX`, `MEGA_REDIS_COMMAND_TIMEOUT_MS`, `MEGA_REDIS_FAIL_MODE` (`local-budget|pause|conservative`).

### 7.4 Cost guardrails

1. Per-command billing (Upstash-style) means the **client cadence is the cost model**: presence posts every 15 s (`src/community.js:223`), queue poll 1 s while searching, match poll 0.7 s while playing, friends/invitations every 15 s, monetization status every 2 s [V]. Every poll must resolve to ≤2 commands (one status read; batch presence touch into 1 Lua call).
2. **Pipelining does not reduce Upstash command counts** - treat each pipeline element as billable and prefer one Lua script per touch (design already does).
3. Hard namespace admission caps (cache ≤5k keys, projections ≤5k per shape) rather than relying on eviction; choose `noeviction` for coordination keys so a ticket/claim is never silently evicted, and bound the cache namespace by admission instead of LRU (with the honest trade-off that a full DB under `noeviction` starts erroring `OOM` - mitigated by caps + TTLs and by putting the cache keys last in priority).
4. Alarms (P14): commands/day budget, memory %, evicted_keys, latency p95, timeout/error rate; no actor/match IDs as labels [V - specs/06 §metrics].
5. Free-tier viability: Upstash free (256 MB / 500K cmds/month / one DB) and Redis Cloud free (30 MB / 30 conns / 100 ops/s) are **staging/smoke viable at best**; Aiven free is capability-rich but explicitly non-SLA and region-changeable. **Production requires a paid plan or an owner-accepted explicit risk**; that decision plus the actual RTT/capability numbers is what closes V5-06-01. Estimated arithmetic (not measured, [INFERENCE]): 10 concurrently queuing clients poll ≈1/s ⇒ ≈1.2k–3k commands/min even before presence heartbeats, i.e. the free monthly command allowance is consumed by a single modest load test.

### 7.5 VERIFIED_READONLY checks still owed (do not assume any provider exists)

| # | Check | Command / surface | Gate owner action |
|---|---|---|---|
| C1 | Restore Vercel CLI authentication, then list Marketplace resources for the exact team | `vercel login` (owner-operated) or existing token ref; then `vercel integration list --all --scope team_wS9BpnXbYRZahs1DiSueN3SS --json` | Owner auth; **no** terms acceptance, no billing change |
| C2 | Upstash: DB list, region, plan, connection cap, eviction policy, ACL availability on the chosen plan | Console/API read + `INFO server` + `COMMAND INFO` probe from a staging client | Owner supplies console/credential ref |
| C3 | Redis Cloud: subscription/DB list, region, plan, `maxmemory-policy`, persistence, TLS/CA, ops cap | Console read + probe | Owner |
| C4 | Aiven: project/service list, available plans/regions for the org, free-tier eligibility, TLS parameter | `aiven project list` / console | Owner |
| C5 | OCI Cache availability in the Oracle tenancy/region (and whether it is an acceptable separate managed service) | OCI console read | Owner |
| C6 | RTT Core→candidate, Vercel→candidate, Neon→candidate | Requires a provisioned target | After C1-C5 |
| C7 | Command-support probe result recorded per primitive (§3.2 list) as the V5-06-01 verification artefact | Adapter probe, output sanitized (no URL/credential) | Implementable now with a local container; provider run after C2/C3/C4 |
| C8 | Neon region/quota confirmation (V5-O006) - the pairing target | Neon console/CLI read | Parallel P02 owner |

Recommended ledger entries (parent owns the ledger): a new open item "managed Redis/Valkey selection + capability probe" tied to V5-06-01, blocked by V5-O009 (Vercel/marketplace auth) and V5-O006 (Neon region), with C1-C7 as its check list. [D]

---

## 8. Unit-of-work extension: a Redis coordinator that cannot commit economic state

The P01 vocabulary to extend [V - `packages/db/*`]: `ContextError` with bare codes, `contextFor/contextOptions`, `openScope/runInScope/commit/rollback`, `requireScope` ⇒ `TRANSACTION_REQUIRED`, `getRepositories`, `finishScope`, `ASYNC_CALLBACK_UNSUPPORTED`, and durable outcome scopes (`COMMANDS`, `PARTY_COMMANDS`, `SOCIAL_OPERATIONS`, `V35_COMMANDS`).

The Redis side does **not** enter that context. It is a sibling package with the same shape:

```
packages/redis/            (name @mega-xo/redis, v5.0.0, subpath exports like @mega-xo/db)
  index.js                 createRedisCoordinator({url, env, schemaVersion, client, clock, telemetry, failMode})
  guards.js                RedisGuardError; parseRedisUrl; assertTlsConfig; assertEnvironment;
                           buildClientName; probeServer; assertCommandSupport; assertAclUser; redactUrl; assertKey
  primitives/              presence.js queue.js rate.js cache.js proj.js pubsub.js route.js due.js lock.js hints.js
  lua/*.lua                rate.spend, queue.join|heartbeat|cancel|claim|release|prune, due.claim|complete|release,
                           presence.touch, cache.putIfNewer, lock.release
  clients/                 native.js (RESP/TCP + subscriptions, Core/worker) | rest.js (@upstash/redis, Vercel API)
```

Vocabulary mapping [D]:

| packages/db | packages/redis | Rule |
|---|---|---|
| `ContextError` / bare codes | `RedisGuardError` / bare codes (`KEY_NAMESPACE_MISMATCH`, `COMMAND_UNSUPPORTED`, `ENVIRONMENT_MISMATCH`, `COORDINATOR_UNHEALTHY`, `EPHEMERAL_IN_TRANSACTION`) | Same style; stable codes only, no provider text |
| `TRANSACTION_REQUIRED` (writes outside a scope) | `EPHEMERAL_IN_TRANSACTION` (Redis call attempted while a PG scope is open) | Inverted guard; both are "you are in the wrong place" errors |
| `TransactionScope` (one PG transaction) | `EffectBatch` (ordered post-commit ephemeral effects, flushed by the caller after `run` returns) | Redis never participates in the durable commit |
| `repositories` (PG reads/writes on one connection) | primitives (`presence`, `queue`, `rate`, `cache`, `proj`, `bus`, `route`, `due`, `hint`, `lock`) | Same dependency-blocked shape |
| `scopes.js` outcome tables | **absent** - Redis has no outcome scope | Durable idempotency stays PG, so retries survive a wipe |
| `fences`/leases (worker design) | `claim.claimId`/`fence` echoed into PG rows | Advisory Redis lease + durable PG fence |

Invariants (must be asserted by tests):

1. **Direction of dependency.** `packages/db/*` never imports `packages/redis/*` (static test). PG is the only durable authority.
2. **No await inside a durable transaction.** The SQLite UoW is synchronous and `runInScope` throws `ASYNC_CALLBACK_UNSUPPORTED` on a thenable [V]; the future async PG UoW must keep the same rule for Redis: the only legal Redis calls are (a) advisory reads **before** opening the scope, (b) `EffectBatch` flushes **after** commit, (c) outbox-backed deliveries by the worker.
3. **Nothing durable is answered from Redis.** Every `queue.join/cancel`, `purchase`, `convert`, `move`, `signout` retry resolves through the PG outcome row (`COMMANDS`/`V35_COMMANDS`/`SOCIAL_OPERATIONS`/`PARTY_COMMANDS`). Redis op-keys exist only to make the *ephemeral* operation idempotent (join/cancel/heartbeat), never to answer a business retry.
4. **Post-commit effect ordering.** Publish/invalidate/wake effects are recorded in the `EffectBatch` in commit order; on crash between PG commit and flush, the effect is re-derivable (cache TTL, snapshot recovery, due-queue rebuild) or is written to the PG outbox inside the transaction if it must not be lost.
5. **No economic write path.** There is no `redis.run(...)`-style command executor analogous to `DurableStore.run`; the package exposes no method that mutates wallet/match/tournament state, and the role/guard set (`api|core|worker|test`) only gates *ephemeral* scopes.

---

## 9. Consumption contracts

### 9.1 P07 (distributed matchmaking)

```
queue.join({actor, mode, opKey, region, latencyMs})   -> {state:'searching'|'matched', window?}
queue.heartbeat({actor, mode})                        -> {state}
queue.cancel({actor, opKey})                          -> {state:'cancelled'|'matched'|'playing'}
queue.status({actor})                                 -> {state:'idle'|'searching'|'matched'|'disconnected'|terminal}
queue.busy({actor})                                   -> boolean          // replaces matchmaker.busy()
queue.claimBatch({mode, limit, coreId, fence, leaseMs}) -> [{actor, mode, joinedAt, region, latencyMs, claimId}]
queue.releaseClaim({claimId, requeue})                -> boolean
queue.size()                                          -> {ranked, casual, claimed}
queue.rebuildFromPg(occupancyRows)                    -> {adopted}
```

Invariants: `maxQueued` global cap parity with today's `tickets.size >= maxTickets` [V]; ordering by `joinedAt` (ZSCORE) so FIFO fairness is preserved; claim TTL > PG statement timeout; claims are advisory and may be dropped without asset loss; **the pairing decision and the `pair:` commit stay in PG inside one transaction that rechecks eligibility, occupancy, rating/terms and balance** (spec 03 §3); `queue.join` must be callable by the API plane (Vercel) via REST mode while the matcher consumes via TCP mode.

Policy surfaces that must not change (V5-07-01): `CONFIG` windows, `searchWindow`, `compatibility`, placements pool rules, recent-opponent/friend exclusions, region/latency penalties, `selectTournamentRoom` cohort rules, `tournamentSeed` [V - `packages/domain/matchmaking.js`].

### 9.2 P08 (durable realtime Core)

```
bus.publishMatchRevision({matchId, revision, asOf})   // post-commit only
bus.subscribeMatch(matchId, onMessage) / unsubscribe
bus.wake({mode})                                      // queue wake, coalesced
route.registerCore({coreId, capacity, epoch})
route.healthyCores() -> [{coreId, capacity}]
route.registerConnection({coreId, matchId|actor, connId, ttlMs})
route.connections(matchId) -> [{coreId, connId}]
due.add({kind:'expire'|'timeout'|'room', id, revision, atMs})
due.claim({kind, limit, coreId, fence, leaseMs}) -> [{id, revision, fence}]
due.complete({kind, id, revision, fence}) / due.release(...)
hint.sessionRevoked({actor, generation, ttlMs}) / hint.isRevoked({actor, generation})
budget.spend(scope, subject, {limit, seconds})       // socket admission, rate limits
```

Invariants: publish after commit; a dropped message is normal and recovered by snapshot/resume (`realtime/v1` `resume`/`snapshot`/`delta` operations already validated in `packages/contracts/realtime.js` [V]); deadlines come from PG (`deadline`/`expires` columns, absolute ms) — Redis loss never extends a turn; socket objects/subscriptions stay in the process (memory tier); ticket issuance and redemption stay PG (A14) with admission limits applied at the socket and `rate.spend` for connection floods; revocation hints are advisory, PG session generation is authoritative (spec 02 §2).

### 9.3 P12 (read models and cache)

```
classified(routeClass) -> 'strong-current'|'short-ttl'|'event-invalidated'|'public'
cache.getOrBuild({shape, key, ttlMs, singleFlight, builder}) -> {value, version, asOf, hit}
cache.invalidate({shape, key|tag})
proj.putIfNewer({shape, key, version, asOf, payload, ttlMs}) -> {stored, current}
proj.read({shape, key}) -> {version, asOf, payload}|null
bus.subscribeInvalidate({shape}, handler)
```

Invariants: `strong-current` classes (wallet, session, account state, privacy-deletion state, occupancy for spending) are **refused** by the adapter (`CACHE_CLASS_FORBIDDEN`); `proj.putIfNewer` is version-CAS so an old event cannot overwrite a newer projection; clearing every cache/projection leaves correctness intact (A-cache "Cache correctness and privacy" in `acceptance.json`); single-flight lock prevents a wipe/expiry dogpile; presence is **not** cached as truth (it is the Redis primitive itself); `ReadContext`'s per-request reuse is left alone until P12 replaces it with versioned projections.

---

## 10. V5-06-04 test plan (loss and degradation)

Local/CI tier (no provider credentials; containerized Valkey/Redis, run like the existing `node --test` suites; suggested filenames `tests/v5-redis-primitives.test.js`, `tests/v5-redis-loss.test.js`, `tests/v5-redis-guards.test.js`, `tests/v5-redis-queue-races.test.js`):

- **U1 primitives/atomicity** - join idempotency across two clients, mode conflict, `QUEUE_FULL` at cap, heartbeat refresh, 45 s lease expiry, terminal retention 300 s and cap, `queue.prune` growth bound, rate `INCR`+`PEXPIRE` atomicity (simulate crash between the two: assert no `TTL == -1`), `cache.putIfNewer` version ordering, `lock` compare-and-delete.
- **U2 claim races** - cancel-vs-claim, claim-vs-claim (two Cores), claim-vs-direct-invitation, claim-vs-tournament join, duplicate join on two devices, heartbeat expiry exactly at commit; assert at most one assignment/effect (A16 pre-work).
- **U3 guards** - refuse non-TLS URL, refuse missing CA, refuse `MEGA_REDIS_NAMESPACE_ENV != MEGA_ENV`, refuse `COMMAND INFO` missing a required command, refuse a key without the expected prefix, refuse a Redis call inside a PG scope (`EPHEMERAL_IN_TRANSACTION`), bundle scan finds no Redis credential.

Staging tier (requires the provisioned service ⇒ [P] until C1-C7; evidence A15/A14/A16, and the P16 pre-check for dual-Core):

- **L1 full wipe (A15)** - while two pairs are searching, one match is PLAYING near a deadline, one OFFERED offer is open, one tournament lobby is filling, two sessions are present and budgets are partly spent: `FLUSHDB` (staging only, never production). Assert: durable digest (wallet/ledger/burned/receipts/rank/purchases/activeMatch/escrow) unchanged; no stuck paid occupancy (no escrow row without a corresponding committed match state); timers fire within one rebuild interval; presence self-heals ≤60 s; queue requires rejoin with no double charge; 429 still returned after the documented budget is re-reached.
- **L2 dependency down** - connection refused and injected latency (p95 200 ms) with the configured timeouts: assert the §5.2 table row by row, especially "join fails closed", "tick pauses", "match move/settle still correct", "fallback budgets not unlimited".
- **L3 pubsub loss** - kill the subscriber / drop the channel: assert live clients recover by `resume`+`snapshot`/`delta`, no move reapplication (revision CAS), reconnects bounded.
- **L4 reconnect storm** - 100 simultaneous reconnects + subscription restart: assert bounded per-socket queues, slow-client disconnect, no duplicate actor/match, no double effect.
- **L5 environment isolation (L7 above)** - staging credentials against production and vice versa must fail (`NO_CROSS_ENV`), and the startup probe must refuse a namespace/stage mismatch.
- **L6 dual-Core (P16 pre-check)** - two Cores on the same PG+Redis: kill one between claim and commit, wipe Redis immediately after a commit, restart the other during queue sweep: assert one assignment, one financial effect, latest revision recovery.
- **L7 key hygiene** - after the suite: `SCAN` shows zero keys outside `mx:<env>:<version>:` and zero keys with `TTL == -1`; `DBSIZE` returns under the namespace admission caps.

Each of L1-L7 records: task/case IDs (A14/A15/A16 + the P12 cache case), exact SHA, commands, environment IDs (service ID/region/plan - **no credentials**), result and evidence path, per `templates/evidence.template.json`. Until then they are `NOT_RUN` (matching `acceptance.json` today).

---

## 11. Boundary notes and honest residuals

1. Redis may hold candidate indices and claims; a Redis claim is not a monetary lock and never the final authority on occupancy (spec 03 §3).
2. Presence semantics change from "one row per session, read by every process from one file" to "shared ZSET", which makes per-IP/per-actor budgets truly global across replicas (today's `memoryBuckets` are per process, so N replicas effectively multiply a limit by N). This is an intended tightening; it must be called out in the P06 evidence as a behaviour note, not hidden (spec 03 §2 forbids silently changing security behaviour - here it is a documented improvement with the same configured numbers).
3. The one unavoidable weakening on a full wipe is that rate windows reset; the compensating controls are the durable PG attempt counters for security scopes plus conservative local budgets while Redis is down, and a wipe-detected alert. This is stated rather than papered over.
4. `noeviction` for coordination keys vs bounded cache admission is a trade-off: a full DB will error instead of silently evicting a queue ticket. Caps and TTLs keep that unlikely; P14 must alarm on memory and on `OOM` command errors.
5. Two same-host Cores remain process failover only; Redis loss or host loss is not host HA (D12) and this design does not pretend otherwise.

## 12. Verification status of this document

- Source-read and provider-doc-read only. No test, build, container, provider call, credential read, or file modification was performed.
- Provider capability statements marked [V-doc] come from the current public pages cited inline; they prove what the products document, not what this account has. Everything requiring an authenticated read is listed in §7.5 and marked [P].
- Zero claims of a provisioned Redis/Valkey service; the repo's own evidence and open items (V5-O009, V5-O006) are the authoritative statement that selection and provisioning are still open, which is exactly why V5-06-01 cannot be marked complete yet and why V5-06-02's adapter must be buildable and testable against a local container first.

[Showing lines 1-166 and 268-432 of 432; 101 middle lines (13.5KB) elided. Read artifact://765 for full output]
