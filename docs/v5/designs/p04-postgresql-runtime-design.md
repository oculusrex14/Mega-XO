# P04 — PostgreSQL runtime design: unit of work, repository set and aggregate persistence

Owner: P04Implementer. Files: `packages/db/pg/uow.js`, `packages/db/pg/repositories.js`,
`tests/v5-p04-repositories.test.js`, and this record. `packages/db/pg/index.js` was extended only
to export the two new factories.

Classification tags: **[V]** verified by reading repository source in this session, **[D]**
design decision, **[F]** executed finding from the P04 suite, **[G]** confirmed grant gap.

---

## 1. Scope and the seam that was ported

`packages/db/{index,context,repositories}.js` remain the frozen SQLite/reference adapter. P04 adds
its PostgreSQL mirror and proves parity against a schema built by the real checksummed chain.

The legacy adapter keeps ONE serialized `state` row (`state(id=1, json TEXT)`, [V]
`server/economy-store.js:20`). Every externally reachable command runs inside a unit of work opened
by `createSqliteUnitOfWork`; `repositories.domain()` hydrates that row once per scope onto
`context.graph`, and `commitDomain()` / `state.write(value)` rewrite it whole [V
`packages/db/repositories.js`, `packages/db/context.js`].

V5 has **no** `state` table and none is invented: 0004–0037 decompose that row into normalized
tables (P02 design §2.2) [V]. P04 therefore ports the *seam*, not the storage:

| Legacy seam | P04 implementation |
|---|---|
| `createSqliteUnitOfWork(db, {now})` → `{run, repositories, close}` | `createPgUnitOfWork(pool, {now, role})` → `{run, runAsync, repositories, close}` [D] |
| `run(fn)` synchronous, one `BEGIN IMMEDIATE` | `run(fn)` asynchronous, one `withTransaction` → one `withIdempotentTransaction` [V `packages/db/pg/pool.js:578-664`] |
| repository call outside a scope → `ContextError('TRANSACTION_REQUIRED')` | identical, for reads **and** writes [D] |
| `domain()` → in-memory `Authority` graph | `domain()` → `Authority` graph assembled from the normalized tables [D] |
| `commitDomain()` → `UPDATE state SET json` | `commitDomain()` → entity-wise diffed INSERT/DELETE per touched table [D] |
| `state.read()` / `state.write(v)` raw seam (`server/rooms.js:38,43`) | same names, backed by the aggregate [D] |

`run` returns a Promise and `runAsync` is an explicit alias: PostgreSQL I/O cannot be synchronous,
so a caller can never mistake the value for a committed one [D].

## 2. Unit of work (`packages/db/pg/uow.js`)

- **One transaction, borrowed and never committed by a repository.** `run` delegates to the pool's
  `withTransaction`, which opens exactly one `withIdempotentTransaction`; a nested `withTransaction`
  on the same client borrows the live scope, increments its depth and commits only when the
  outermost body returns [V `pool.js:578-664`].
- **The facade is a copy, never a mutation.** pool.js freezes its own `tx`; the unit of work passes
  an additional frozen facade exposing `client`, `clock`, `scope`, `query` and the scope-bound
  `repositories`. The repository set is built once per transaction and cached in a `WeakMap` keyed
  on that facade [D].
- **The callback is always awaited** (`Promise.resolve().then(() => fn(facade))`), so a synchronous
  throw and an unawaited rejection are both reported as a failed transaction rather than a COMMIT
  [D].
- **Role propagation.** The role is taken from `options.role` or from `pool.describe().role`; the
  guarded pool knows the identity it logged in as, so a caller cannot forget to declare it and
  silently lose role-aware behaviour [D]. This is what makes §4 possible.
- **`close()` releases this unit of work only.** The pool is caller-owned because it carries a
  cluster-wide connection-budget claim (`pool.js:claimBudget`) that must outlive one request, so the
  unit of work never calls `pool.end()` [D].
- **Closed options.** Only `key` and `expectRole` are forwarded; an unknown option would be a silent
  hole (a typo in `expectRole` would drop the in-BEGIN role re-assertion) [D].

## 3. Repository set (`packages/db/pg/repositories.js`)

Same member names and semantics as the SQLite adapter. Every method requires a live scope.

### 3.1 Per-member SQL shape

All statements are parameterized; no value is ever interpolated. `LIMIT`/caps are literal or a bound
parameter.

| Member | Table(s) | Statement shape |
|---|---|---|
| `accounts.has(actor)` | `identity.actors` | `SELECT 1 FROM identity.actors WHERE actor_id = $1` |
| `profiles.for(actor)` | `identity.profiles` | `SELECT actor_id, tag, username, display_name, avatar, stats_visibility, presence_visibility, (extract(epoch from created_at)*1000)::bigint, (extract(epoch from username_changed)*1000)::bigint, version … WHERE actor_id = $1` |
| `sessions.live(h, now)` | `identity.sessions` | `SELECT token_hash, actor_id, csrf, (…created_at), (…expires_at), (…auth_at) WHERE token_hash = $1 AND expires_at > $2` |
| `sessions.revoke/rotate/revokeOthers/revokeAll` | `identity.sessions` | `DELETE … WHERE actor_id = $1 AND token_hash = $2` / `WHERE token_hash = $1` / `… AND token_hash <> $2 RETURNING token_hash` / `WHERE actor_id = $1` |
| `sessions.presence` and `clear*Presence` | — | refuses with `PRESENCE_OWNED_BY_P06` (§7) |
| `saves.for(actor)` | `profile.profile_saves` | `SELECT revision, payload_text, (…updated_at) WHERE actor_id = $1` |
| `saves.revisionOf(actor)` | `profile.profile_saves` | `SELECT revision … ` (0 when absent) |
| `wallets.for(actor)` | `economy.wallets` | `SELECT coins, crowns, reserved_coins, reserved_crowns, purchased_coins, purchased_crowns, purchase_influenced WHERE actor_id = $1` |
| `wallets.lock(actors, {aggregate})` | `match.matches`/`tournament.rooms` → `core.actor_occupancy` → `economy.wallets` | optional aggregate `FOR UPDATE`, then `… WHERE actor_id = ANY($1::text[]) ORDER BY actor_id FOR UPDATE` twice, actors **sorted here, not trusted** |
| `ledger.recent(actor, limit=40)` | `economy.ledger` | `… WHERE actor_id = $1 ORDER BY at DESC, entry_id DESC LIMIT $2`, reversed to ascending; `limit === null` omits the LIMIT (explicit caller request) |
| `ledger.burned()` | `economy.system_burns` | `SELECT coins, crowns WHERE id = 1` |
| `matches.for/view/forActor` | hydrated aggregate over `match.matches` + `match.participants` + `match.move_outcomes` | in-memory over the one hydration; `view` throws `UNKNOWN_MATCH` |
| `tournaments.room(id)` | hydrated aggregate over `tournament.rooms` | room id **or** code, the legacy `WHERE id=? OR code=?` |
| `tournaments.rooms/activeRooms/codeExists` | `tournament.rooms` | active set = `LOBBY, RUNNING, PAUSED, REVIEW` |
| `tournaments.save(room)` | `tournament.rooms`, `tournament.room_players`, `tournament.escrow_contributions`, `tournament.fixtures` | room upsert by `room_id`; dependents `DELETE … WHERE room_id = $1` then bounded position-ordered re-insert |
| `purchases.receipt` | `monetization.receipts` | `… WHERE store = $1 AND transaction_id = $2` |
| `purchases.revoked` | `monetization.store_revocations` | `SELECT 1 … WHERE store = $1 AND transaction_id = $2` |
| `outcomes.find(scope, …)` | `economy.`/`tournament.`/`social.`/`monetization.command_outcomes` | one family table per legacy scope, PK lookup |
| `outcomes.save(scope, …)` | same four tables | single-row `INSERT … ON CONFLICT (actor_id, key) DO NOTHING` |
| `jobs.queues/due/expireDue` | `ops.outbox` | claim and expiry statements byte-identical in predicate to `server/production/mail-outbox.js:58-69`; terminal transition NULLs the sealed payload in the same UPDATE |
| `community.count(id)` | `ops.rate_buckets` | `INSERT … VALUES ($1, 1, NULL) ON CONFLICT (bucket_id) DO UPDATE SET hits = ops.rate_buckets.hits + 1 RETURNING hits` |
| `state.read` | aggregate | `authority.export()` |
| `state.write(value)` | aggregate | entity-wise diff, then the value becomes the in-scope aggregate |
| `domain()` | aggregate | hydrate once per scope |
| `commitDomain()` | aggregate | entity-wise diff |

### 3.2 Explicit mappings between two representations

The legacy and target representations differ in three places, and the adapter maps them at the
boundary instead of copying bytes [V 0005:33-40, 0009, 0034]:

1. **Session token hashes.** Legacy stores `sha256(bearer)` as base64url (43 chars,
   `server/identity-provider.js:12`); the target column is 64 lowercase hex with a CHECK. `hashIn`
   decodes and re-encodes to hex, `hashOut` reverses it. It is a re-**encode**, never a re-hash: a
   hash of a hash cannot be recomputed and the same 32-byte digest round-trips exactly. These two
   functions are the only places that touch the encoding.
2. **Operation keys.** 0034 stores the `economy` and `tournament` logical key as the canonical JSON
   string text of that key, exactly once; `keyIn`/`keyOut` encode and decode it and refuse a
   malformed value. The `social`, `monetization` and move families keep their verbatim grammar and
   are passed through unchanged.
3. **Timestamps.** Legacy is epoch milliseconds; the target is `timestamptz`. Reads project
   `(extract(epoch from col)*1000)::bigint` (a decimal string from the driver, decoded by `toMs`);
   writes emit ISO text via `iso(ms)`.

`profile.profile_saves.payload` maps to `payload_text` (0033 dropped the JSONB twin) and keeps the
legacy field name `payload`, because `server/community-store.js:277` parses that name [V].

### 3.3 No minting

There is no opening balance, no generated friend code, no regenerated store binding and no
fabricated timestamp anywhere in the adapter. A missing wallet row is `ACCOUNT_REQUIRED`, never a
created default. Every written timestamp comes from `context.clock` (the injected clock, sampled
once per transaction) or from the caller's own object [D]. The one timestamp the domain does not
carry is `core.actor_occupancy.claimed_at`, and it is the injected clock — documented at the
statement rather than hidden [D].

### 3.4 Idempotent command outcomes

Each legacy family keeps its own table and its own uniqueness domain: `economy.command_outcomes`,
`tournament.command_outcomes`, `social.command_outcomes`, `monetization.command_outcomes`,
`match.move_outcomes` [V 0009/0013/0007/0014/0012]. A scope is recognized by its `find` statement
(the stable identity of a family in `packages/db/scopes.js`); an unknown scope is refused with
`UNKNOWN_OUTCOME_SCOPE` rather than guessed [D]. `outcomes.save` is a single-row upsert that can
never overwrite an existing outcome (`DO NOTHING`), so a replay returns the stored response and
re-applies nothing.

## 4. Aggregate persistence: `domain()` and `commitDomain()`

**What the aggregate is for.** `packages/domain/commands.js` is a *pure* 22-command dispatcher over
an in-memory `Authority` graph (`executeCommand`, [V]). P04 does not change it and does not move
domain rules into SQL. What P04 replaces is the storage behind the seam those commands already use.

**Hydration.** `buildAggregate` reads the normalized tables with bounded, parameterized queries and
assembles the exact object shape `new Authority({state})` expects — `accounts`/`matches`/`receipts`/
`snapshots`/`weeklyPaid` as pair arrays, `burned`, `journal`, `leagueWeek` — then caches the graph on
the pool's own transaction scope, so it lives and dies with the transaction exactly like the legacy
`context.graph` [D]. `hydrate()` is a **one-shot per transaction**; it is deliberately not an
invalidation-based cache, because the diff in `commitDomain()` uses the loaded snapshot as its
"before" image and a second hydration of a mutated database would silently absorb another writer's
change [D]. That snapshot is always taken in the **exported** form (`JSON.stringify(authority.export())`,
never of the raw state value): `Authority.export()` renders a match's `commands` Map as an entry
array, whereas the raw map serializes to `{}`, so a raw-form snapshot would hand the diff an empty
"before" image and re-write every move outcome on every commit [F].

**`src/authority.js` is required, deliberately.** Its require graph is exactly `node:crypto`,
`src/game.js`, `src/domain.js` and `packages/domain/abuse.js` [F, walked by the no-SQLite case], so it
carries no storage of any kind. It is used here purely as the in-memory domain model. A hand-rolled
parallel account/match shape would be a second, drifting definition of the domain — the exact thing
this port exists to avoid. The assertion that matters is unchanged and tested: no `node:sqlite`, no
`packages/db/repositories.js`, no `packages/db/index.js` anywhere in the P04 module graph.

**Persistence.** `commitDomain()` and `state.write(value)` compute, for each of 26 descriptors, the
database-ready projection of every row, then:

1. upsert only rows whose projection changed (`INSERT … ON CONFLICT (pk) DO UPDATE SET …`, bounded
   single row);
2. delete only rows that disappeared, and only for tables that are not append-only. No deletion is
   ever inferred from a representation gap: `commandEntries()` accepts a match's `commands` as
   either the hydrator's `Map` or the exported entry array, so a shape difference between the two
   diff sides can never be read as "the outcome disappeared" [F];
3. skip a table when its `appendOnly` flag is set (ledger, wallet ledger entries, wallet operations,
   season history, match history, move outcomes — the domain never removes them);
4. skip a schema the role has no USAGE on, and **fail closed** when a table the role may not write
   has a real pending diff — silently dropping a committed business effect is worse than failing.

No row is ever rewritten unchanged, and there is no whole-graph blob and no `state` table. This is
asserted [F]: after a conversion the touched tables are written; a second commit with no mutation
reports `upserts: 0, deletes: 0, tables: 0`; and `pg_tables` contains no aggregate table (the only
relation named `state` in the whole schema is `runtime.state(key, value)`, the 0018 control
singleton).

**Ownership boundary.** The aggregate is authoritative for the columns the domain model owns
(actors' region/wealth flags, eligibility flags, wallets, ratings, burns, ledger, wallet
operations/ledger entries, daily progress, seasons, tournament records, match history, social graph,
occupancy, matches/participants/move outcomes, receipts, monetization counters, owned cosmetics,
snapshots, league week, weekly payouts). It is **not** authoritative for `identity.profiles`,
`identity.identities`, `identity.email_credentials` or `identity.sessions`, which are entity tables
written by the API's own statements and only *derived* into the graph (design 5.4: profiles is
canonical) [D]. Rewriting them from the graph would clobber the canonical row, so they are outside
the persist set.

## 5. Lock order

Documented once, here, and enforced in code (design 3.7 / spec 01 §3, mirrored from
`docs/v5/designs/p02-schema-design.md:163`):

> business aggregate row → `core.actor_occupancy` → `economy.wallets` → dependent rows
> (ledger / outcome / outbox), with actor ids **sorted ascending**, and never the reverse.

`wallets.lock(actors, {aggregate})` is the only member that takes row locks. It sorts the actor list
itself rather than trusting the caller, optionally takes the business aggregate row
(`match.matches` or `tournament.rooms`) first, then takes `core.actor_occupancy` and
`economy.wallets` with `ORDER BY actor_id FOR UPDATE`. The aggregate-then-actors-then-dependent
chain for a specific command remains the caller's obligation, because only the caller knows which
aggregate the command targets; the member makes the ordering it *can* know non-optional.

The concurrency case exercises it [F]: two overlapping units of work each lock then
read-modify-write one wallet; exactly one reservation commits, the other sees the updated row and
fails `INSUFFICIENT_COINS`; the final row shows no overdraw and no double-reserve. A failing unit of
work rolled back its wallet write and its ledger append completely.

## 6. Role capability discipline

The guarded roles do not share every schema [G, probed against the real roles on the migrated
target]: Core has no `social.*` and no `ops.*`; the API has no `economy.*`, `core.*`, `match.*`,
`tournament.*`, `monetization.*` or `season.*`; the worker has no `economy.*`, no `identity.*` and no
`ops.rate_buckets`. So the adapter:

- **hydrates only what the role can read**: statements whose tables live in an ungranted schema are
  skipped and recorded on the graph (a fallback account query omits the economy columns rather than
  raising 42501 mid-command);
- **persists only what the role may write**, per the grant-driven table in
  `WRITE_ROLES`/`DEFAULT_WRITE_ROLES`, and fails closed with the pending counts when a real change
  belongs to another identity;
- **splits `identity.eligibility`**: `api_runtime` owns `verified` and the row INSERT (0037),
  `core_runtime` owns `suspended`/`security_hold` (0021). One statement setting all three columns
  would be denied for *both* roles, so each side writes only what its grants allow and an unknown
  role refuses.

## 7. Caller inventory — the whole-graph pattern, site by site

Every `server/**` site that relied on the whole-graph `state.read/write` + `commitDomain()` pattern
is now served by the entity-wise boundary above, with **no caller rewrite**. Inventory (file:line,
what it mutates, replacement); the enclosing transaction boundary is named once per store.

| # | Site | Mutates | Served by |
|---|---|---|---|
| 1 | `server/economy-store.js:35,38` `repositories.domain()` + `commitDomain()` in `uow.run` (`:31`) | command-dependent via `executeCommand`: wallets, ratings, history, daily, owned, monetization, activeMatch, social arrays, burned, journal, matches, receipts, snapshots, weeklyPaid, leagueWeek | entity-wise diff of every table above |
| 2 | `server/rooms.js:77` `state.read()` in `uow.run` (`:70`) | via `reserve`/`settle`/`journal` (`:47,60-67`): `wallets.coins/crowns/reserved_*`, `activeMatch`, `tournamentRecord`, `burned`, `journal[]` | `economy.wallets`, `economy.tournament_records`, `economy.system_burns`, `economy.ledger`, `core.actor_occupancy` |
| 3 | `server/rooms.js:101` `state.read()` then `writeEconomy` | same as #2 (table rooms only) | same as #2 + `tournament.rooms` |
| 4 | `server/rooms.js:107-108` tick `state.read()` / `writeEconomy` | same as #2 for settling rooms | same as #2 |
| 5 | `server/rooms.js:114-115` recover `state.read()` / `writeEconomy` | same as #2, plus room status/reason | same as #2 + `tournament.rooms` |
| 6 | `server/rooms.js:43` `state.write(e)` | whole serialized row | entity-wise diff (adopts the caller's value as the new snapshot) |
| 7 | `server/rooms.js:82` `state.read()` (join eligibility) | reads only; `e` stays null, nothing persisted | read-only aggregate |
| 8 | `server/monetization-store.js:25` `domain()` + `commitDomain()` in `uow.run` | `.monetization.daily/day`, `.credits`, `.redeemed[]`, `.equipped`, `.crowns`, `.purchaseInfluenced`, `.lastRewardStart`, `.lastAdAt`, `.boosts[]`, receipts, journal | `monetization.credits/reward_daily/redeemed_frames/boosts/receipts`, `economy.wallets`, `economy.ledger` |
| 9 | `server/monetization-store.js:49` refund `domain()` + `commitDomain()` | `receipts['store:tx'].refunded`, `accounts[r.actor].hold` | `monetization.receipts` UPDATE, `identity.eligibility.security_hold` (core column grant) |
| 10 | `server/community-store.js:127` signup `addAccount`+`write(authority)` | new account, opening journal entry, profile row | API-side: `identity.actors`/`eligibility`/`profiles`; wallet + opening ledger are a Core-owned follow-up |
| 11 | `server/community-store.js:171` finishVerified `write(authority)` | account (if new), profile, identities, session rotate | as #10 plus the entity `identity.identities`/`sessions` statements |
| 12 | `server/community-store.js:182` edit `write(a)` | `accounts[actor].name` + `identity.profiles` UPDATE | `identity.profiles` is canonical; the derived copy is not rewritten |
| 13 | `server/community-store.js:218` social `write(a)` | `friends`/`friendRequests`/`blocked` both sides, offered matches cancelled | `social.friendships`/`friend_requests`/`blocks`, `match.matches`, `social.command_outcomes` (api role) |
| 14 | `server/community-store.js:259` deleteAccount `write(authority)` | every account's graph fields, matches, receipts, snapshots, weeklyPaid, journal, then deletes the account | entity-wise across the tables; `identity.actors` DELETE cascades the account-owned rows |
| 15 | `server/production/email-auth.js:112` signup `this.c.write(authority)` in `uow()` (`:79`) | as #10 | as #10 |

Pure reads that needed no persistence (they keep working through the same read path):
`server/jobs.js:7`, `server/matchmaking.js:14,16,17`, `server/queue-session.js:13,18,28`,
`server/http.js:20,31,32`, `server/community-http.js:43,46,47,49,52,109`,
`server/apple-store-notifications.js:17`, `server/party-http.js:19`,
`server/production/main.js:30`, `server/production/read-context.js`.

**The one structural finding this inventory exposes [F]:** sites #10, #11 and #15 create an actor
*and* its wallet from one whole-aggregate commit. In V5 those are two different owners — the API owns
`identity.actors`/`eligibility`/`profiles`, Core owns `economy.wallets` — so a single commit cannot
span them. The adapter refuses rather than dropping half of it: driving `provision` on
`core_runtime` fails closed with `ROLE_CAPABILITY_REQUIRED` naming `identity.actors`, and the refused
unit of work leaves no partial actor, no wallet and no ledger row (asserted [F]). The replacement is
the P05 §B1.1 provisioning handshake: the API creates actor + eligibility + a `provision-wallet`
outbox row in one transaction, and a Core command with the deterministic operation id
`provision:<actor_id>` creates the wallet and the `opening:<actor_id>` ledger entry, whose primary
keys make a replay structurally idempotent. That is the smallest entity-specific replacement; it
needs no privileged connection and no widened grant.

## 8. Findings reported (not worked around)

1. **[G] `api_runtime` could not write the row it owns.** `identity.eligibility` shipped with
   `SELECT` only, so the signup path could not insert the verified row, and no other runtime role
   could either (Core holds column-UPDATE on the safety flags only). Closed by 0037 with
   `GRANT INSERT ON identity.eligibility` + `GRANT UPDATE (verified)` — column-level, so the API
   still cannot clear `suspended`/`security_hold`.
2. **[G] `api_runtime` could not stamp the credential version.** `identity.email_credential_versions`
   shipped read-only, so the stale-credential protection (the `v4_email_versions` stamp written at
   challenge creation) had no writer. Closed by 0037 with `INSERT, DELETE`.
3. **[G] `worker_runtime` could not increment the durable mail budget.** `ops.rate_buckets` was
   ungranted to the worker, though P02 keeps `mail-budget:*` rows durable precisely so a crash
   cannot reset the allowance. Closed by 0037 with `INSERT, UPDATE` (DELETE deliberately withheld).
4. **[F] `session_presence` has no PostgreSQL table by design**, so `sessions.presence` and the three
   `clear*Presence` members refuse with `PRESENCE_OWNED_BY_P06` instead of returning an empty result
   (which would render every actor offline) or inventing a table. `server/community-store.js:187`
   consumes `rows.length` and `rows[].foreground`; P06 owns that member.
5. **[F] The provisioning split** of §7: three caller sites need the two-role handshake rather than
   one whole-aggregate commit.
6. **[D] `profile.profile_saves` keeps the legacy `payload` name over `payload_text`**, and
   `tournaments.save` replaces the bounded dependent sets wholesale because 0028's
   `UNIQUE (room_id, ordinal)` makes positional updates unsafe.
7. **[F] The first version of this adapter threw `TypeError: … (reading 'push')` on any database
   that actually held a match aggregate.** `buildAggregate` pushed participant rows onto
   `match.participants`, but `matchFromRow` never produced that accumulator — it produced
   `players`/`accepted`. The suite could not see it because its harness seeded no match rows; the
   realistic target has two. Closed by creating the accumulator in `matchFromRow` and deleting it
   once `players`/`accepted` are derived, so it can never reach `Authority.export()`. The regression
   case seeds a match with participants and drives `domain()` over it.
8. **[F] The hydrated `Authority` was built with `state` alone**, dropping the caller's injected
   `now`/`random`/`verifyPurchase` that the SQLite reference threads through
   (`new Authority({...(options || context.options), state})`). Effect: journal instants fell back to
   the host clock, symbol draws to `crypto.randomInt`, and `purchase` threw `STORE_UNAVAILABLE`.
   Closed by `authorityFor()`, which passes `context.options` through and binds `now` to the unit of
   work's sampled clock. Two regression cases assert the clock on a journal instant and the verifier
   on a real purchase.
9. **[F] DATE columns were read as `String(row.day)`.** The driver returns a LOCAL-midnight `Date`,
   so the bucket key became a TimeZone-shifted locale string; a claim then wrote a second, correctly
   formatted key and the diff's delete pass zeroed the pre-existing day row. Closed by rendering
   `to_char(day,'YYYY-MM-DD')` in SQL, exactly as the P03 loader does.
10. **[F] The JSON-TEXT outcome columns were never parsed.** `economy.command_outcomes.response` and
    its three siblings, `economy.wallet_operations.result`/`fingerprint`, and
    `match.move_outcomes.result` are `TEXT … CHECK (x IS JSON)`, not `json`/`jsonb`: the driver hands
    them back as serialized documents, so `find()` returned a string where the V4 reference returns
    the object, and a domain-level replay diverged. Closed by `decodeJsonText()`, which parses and
    surfaces a malformed row as `INVALID_JSON` rather than passing the raw text through.
11. **[F] `matchFromRow` rebuilt a WIDER receipt than the source wrote.** The V4 writers produce
    different key sets (`_settle` writes winner/reason/currency/payout/burn/bonus/refunded/rating/at;
    `voidByOperator` writes only reason/refunded/burn/payout/rating), so a key the source omitted
    must stay absent rather than be invented as `null`/`0`. Closed by returning `receipt_json`
    verbatim (filling only `rating`) and writing the side columns as NULL when the document omits
    them.
12. **[F] `economy.wallet_operations` is not part of 0034's canonical-key set.** Its `fingerprint`
    column holds the source's quote TEXT verbatim and must never be re-rendered, and its `"key"`
    keeps the plain grammar — 0034 re-encoded `command_outcomes` only
    (`wallet_operations_key_check` attests). Closed by taking the fingerprint verbatim and writing
    the key unchanged.
13. **[F] The derived `account.name` was taken from `identity.profiles.display_name`.** The source
    sets it from the **username** (`server/community-store.js:79` `account.name = username`; `:182`
    `name` is the new username), and `identity.profiles` is canonical, so the derived copy must read
    the username and is not persisted back.

## 9. Evidence

Executed against an owned PostgreSQL 16.15 cluster (loopback, `V5_PG_URL` + `V5_PG_DISPOSABLE=1` +
`V5_PG_REQUIRED=1`), on a fresh uniquely-named owned database migrated by the real runner to the full
checksummed chain:

```
V5_PG_URL=postgres://postgres@127.0.0.1:50709/postgres V5_PG_DISPOSABLE=1 V5_PG_REQUIRED=1 \
  node --test tests/v5-p04-repositories.test.js
  ✔ P04 parity: every repository member answers over the migrated normalized schema
  ✔ P04 aggregate seam: the unchanged production dispatcher runs over the normalized tables
  ✔ P04 regression: a seeded match hydrates, a DATE day keys by its source text, and the injected
      clock/random reach the domain
  ✔ P04 regression: the caller-supplied random and purchase verifier are threaded into the hydrated domain
  ✔ P04 concurrency: two scopes cannot overdraw or double-reserve, and a failed unit rolls back
  ✔ P04 idempotency: a replayed command key returns the stored response and re-applies nothing
  ✔ P04 no-SQLite: this module graph never reaches node:sqlite, src/authority storage or the SQLite repositories
  ℹ tests 7  ℹ pass 7  ℹ fail 0

V5_PG_REQUIRED=1 node --test tests/v5-p04-differential.test.js
  ✔ differential: identical clock, seed and command script give identical observable state on both adapters
  ✔ contention: two separate scopes racing one wallet produce exactly one winner and never overdraw
  ✔ contention: reward claim, refund and match void cannot double-apply across scopes, and a failed unit rolls back
  ✔ differential idempotency: the same key replays the stored response and applies once on both adapters
  ✔ differential: the existing product suites that exercise this behaviour still pass, unmodified
  ℹ tests 5  ℹ pass 5  ℹ fail 0
```

**The already-imported realistic target.** `postgres://postgres@127.0.0.1:50709/v5_e2e` (read-only, run
`e2e-run`) hydrates without error under `core_runtime`: 2 accounts, 2 matches, 1 room, 4 journal rows,
36 move outcomes on the finished match, `daily` keys rendered as `2026-10-08`. That is the case the
first suite could not see — a match aggregate with real participant and outcome rows.

```
node -e "…createPgPool({database:'v5_e2e'…}); uow.run(tx => tx.repositories.domain())"
  {"accounts":[2],"matches":["75972568-…","queue:91ba4017-…"],"journal":4,
   "rooms":["4946086c-…"],"outcomes":36,"daily":[["2026-10-08"]]}
```

Regression checks run in the same session: `tests/v5-uow.test.js` 11/11 (the SQLite reference
adapter is untouched) and `tests/v5-pg-guards.test.js` 25/25 (guards and pool untouched).
