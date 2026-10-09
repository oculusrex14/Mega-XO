/* packages/services/core.js - V5 P04 PostgreSQL Core command transaction boundary.
 *
 * The PostgreSQL successor of the transactional half of `server/economy-store.js` (DurableStore.run)
 * and the Core-owned half of `server/monetization-store.js`. It adds no rules: the SAME frozen
 * `packages/contracts` invocation guard validates the invocation, the SAME
 * `packages/domain/commands.js` `executeCommand` dispatches it against the SAME `src/authority.js`
 * domain, and the SAME `packages/db/scopes.js` COMMANDS family carries the idempotency outcome.
 * Nothing in this file re-implements a policy, a price, a cap or a command.
 *
 *   const pool = createPgPool(fromEnvironment(process.env));       // caller-owned, GUARDED
 *   const core = await createCoreService(pool, { now, random, verifyPurchase });
 *   await core.run({ actor, scope: 'player' }, key, { type: 'convert', from: 'coins', amount: 100 });
 *   await core.read((tx) => tx.repositories.wallets.for(actor));
 *   await core.read();                                             // whole exported aggregate
 *   await core.provisionActor(actor);
 *   await core.readMatch(actor, matchId);                          // durable membership + view DTO
 *   const watch = await core.watchMatch(actor, matchId, onSnapshot); // post-commit match hints
 *   await watch.refresh();                                         // always a strong current read
 *   watch.unsubscribe();
 *   core.close();                                                  // closes the UoW, NOT the pool
 *
 * MATCH UPDATES (P06). `run` and `cancelSocialOffers` publish a bounded post-commit hint
 * (`{matchId}` only, channel `core-match`) through the CALLER-OWNED optional `options.ephemera`
 * adapter: a real committed match change nudges other Cores, which then reread PostgreSQL.
 * `readMatch` is the durable-membership selector and `watchMatch` subscribes FIRST, then reads, so
 * no commit can fall between read and subscribe. Hints and the subscription are rebuildable fan-out:
 * without an adapter (or with Redis down) `watchMatch` reports `available:false` yet `refresh()`
 * still returns committed truth, a lost hint only delays, and a rollback publishes nothing. The
 * borrowed adapter is never created, reconfigured or closed here.
 *
 * BOOT CONTRACT (`createCoreService` is async)
 *  - `pool.describe().role` MUST be `core_runtime`. Core is the sole competitive/economic writer
 *    (ARCHITECTURE ownership register), so a pool that logged in as another identity is refused
 *    with `PgGuardError('ROLE_MISMATCH')` BEFORE any statement - there is no privileged fallback
 *    pool and no `SET ROLE` escape hatch.
 *  - `verifyRuntimeSchema(pool)` is awaited next: the exact checksummed migration chain must be
 *    present (a wrong/partial schema fails `SCHEMA_NOT_READY`/`SCHEMA_INCOMPATIBLE`). A constructor
 *    NEVER creates or alters schema, NEVER seeds a singleton and NEVER mints an actor, a wallet or
 *    an opening balance.
 *
 * TRANSACTION CONTRACT (`run`)
 *  - `validateInvocation` throws `AUTH_REQUIRED`/`INVALID_COMMAND` before BEGIN, exactly like the
 *    source boundary. Operation identity is the source grammar verbatim: the outcome id is
 *    `JSON.stringify([actor, key])`, the fingerprint is `sha256(JSON.stringify({principal, cmd}))`
 *    hex, and a replayed key with a different payload fails `IDEMPOTENCY_CONFLICT` - the stored
 *    response is returned unchanged otherwise.
 *  - AFFECTED LOCKS ARE DERIVED FROM THE COMMAND and taken in ONE global order
 *    (design 3.7 / spec 01 section 3, frozen parent decision):
 *    the business aggregate row when the command names one (match.matches / tournament.rooms),
 *    then the affected actors' `identity.eligibility` rows (sorted), then `core.actor_occupancy`
 *    and `economy.wallets` with actor ids sorted ascending (`wallets.lock`), then dependent rows
 *    (ledger / outcome / outbox). The aggregate comes first because `wallets.lock({aggregate})`
 *    enforces that, and because the aggregate row is what decides whether the operation may exist;
 *    eligibility follows because the aggregate diff writes `identity.eligibility` (Core's
 *    suspended/security_hold columns) BEFORE `economy.wallets`. NO path puts eligibility before a
 *    named aggregate, so a named-aggregate command and a pure actor command cannot form a cycle.
 *    The affected actor list is derived from the durable rows (match.participants) for planning;
 *    every decision is re-derived from the aggregate UNDER the locks. The locks are taken BEFORE
 *    hydration, so two same-operation races serialize on the aggregate row and the loser observes
 *    the winner's committed state instead of double-applying. There is no in-process mutex and no
 *    persistent lock: commands on disjoint actors share no row and run concurrently.
 *  - A global command (`snapshot`, `weekly`) locks EVERY actor row, so a payout or snapshot cannot
 *    miss an actor that a per-actor lock plan would have skipped; a state that cannot be covered
 *    within the bounded read cap fails closed (`STATE_TRUNCATED`) rather than paying a subset.
 *  - The business mutation (`commitDomain`), the idempotency outcome and a sanitized durable
 *    `ops.outbox` event are written in the SAME transaction: any failure rolls back all three
 *    (spec 03 section 1). The outbox identity is derived from the business event
 *    (`<actor>:<key>`), never a fresh UUID, so a retry cannot enqueue a second event. A command that
 *    legitimately changed no row (an already-owned cosmetic, an unmet quest, a duplicate purchase)
 *    still records its outcome but enqueues no delivery work.
 *  - `run` dispatches through the frozen `executeCommand`, so its `refund` command uses the
 *    domain's synchronous trusted-notification transition exactly like the source `DurableStore`.
 *    The commands that must await an EXTERNAL verifier before opening an economic transaction are
 *    refused here (purchase -> COMMERCE_OWNED_COMMAND) and served by `commerce.purchase` (see
 *    packages/services/commerce.js), which performs that preflight outside the transaction.
 *
 * LOCK-ORDER NOTE. `identity.eligibility` is written by the aggregate diff (Core's
 * suspended/security_hold columns) and by this service's `provisionActor`/`refund`; every Core path
 * therefore takes the aggregate row (when named), then the eligibility rows, then
 * occupancy/wallets. `cancelSocialOffers` locks each candidate match's aggregate row BEFORE the
 * actor pair, so a same-match accept/void and a social cancellation serialize on the match row and
 * the loser re-reads `OFFERED` under the lock; it also re-reads the durable social graph under the
 * locks and cancels nothing when the pair is still mutually friended and unblocked. A store refund
 * takes the receipt actor's eligibility row then the wallet - no aggregate, exactly like a
 * conversion or a purchase.
 *
 * OWNERSHIP
 *  - Core rejects the commands whose effect belongs to another service instead of pretending to
 *    run them: `preferences`/`friend`/`acceptFriend` mutate `identity.actors` and `social.*`
 *    (api_runtime owns those tables), `provision` mints an actor plus its wallet in one aggregate
 *    commit (replaced by `provisionActor`), and `purchase` needs the external provider preflight
 *    that must run OUTSIDE the economic transaction (replaced by `commerce.purchase`) - so the
 *    direct command fails `COMMERCE_OWNED_COMMAND` with an actionable code. Every remaining command
 *    keeps its exact legacy dispatcher semantics, including the pure synchronous `refund`.
 *  - `cancelSocialOffers(actor, target)` is the Core half of the API's unfriend/block path: the API
 *    owns `social.*`, Core owns `match.matches`, so the API asks Core to cancel the OFFERED matches
 *    between two actors. It never touches a running match.
 *
 * NEVER MINT. The only method that creates an economy row is `provisionActor`, and it derives every
 * value from the pure domain helper (`Authority.addAccount` defaults) rather than cloning a
 * constant here; the deterministic ledger id `opening:<actor>` plus the `economy.wallets` primary
 * key make a replay structurally idempotent.
 */
'use strict';
const crypto = require('node:crypto');
const { createPgUnitOfWork } = require('../db/pg/uow.js');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');
const { PgGuardError } = require('../db/pg/guards.js');
const { lockTransactionIdentity } = require('../db/pg/locks.js');
const { COMMANDS } = require('../db/scopes.js');
const { CAP } = require('../db/pg/repositories.js');
const { validateInvocation } = require('../contracts/invocation.js');
const { executeCommand } = require('../domain/commands.js');
const { Authority } = require('../../src/authority.js');

/* The one runtime identity that may own the economic/competitive writes this service performs. */
const CORE_ROLE = 'core_runtime';

/* Command types whose effect belongs to another service (see the header). Refused by name so the
 * failure is actionable instead of a mid-transaction ROLE_CAPABILITY_REQUIRED from the adapter. */
const API_OWNED_COMMANDS = Object.freeze(['preferences', 'friend', 'acceptFriend']);

/* `purchase` AND `refund` are refused on the direct Core boundary: both are store-owned and need the
 * external provider/verification preflight that runs OUTSIDE the economic transaction. A direct
 * `purchase` would rely on the domain's SYNCHRONOUS `verifyPurchase` resolver (absent ->
 * `STORE_UNAVAILABLE`, or a caller's pure fixture that trusts `evidence.valid`); a direct `refund`
 * would mark the receipt and hold the account WITHOUT writing the permanent revocation tombstone.
 * Both are served by `commerce.purchase` / `commerce.refund`, which own that preflight and the
 * tombstone. The pure dispatcher keeps its exact legacy `refund` semantics for reference. */
const COMMERCE_OWNED_COMMANDS = Object.freeze(['purchase', 'refund']);

const DAY = 86400000;
/* Commands whose effect evaluates EVERY account rather than a named participant set, so the
 * per-participant wallet-readiness gate below does not apply to them (they lock, and read, the whole
 * actor table instead - see `lockTargets`). */
const GLOBAL_COMMANDS = Object.freeze(['snapshot', 'weekly']);
/* Outbox events are a durable delivery hint, not the source of truth: a bounded retention window
 * and a sealed-payload-compatible 'queued' row are all the worker needs. */
const OUTBOX_KIND = 'core.command';
const OUTBOX_EXPIRY_MS = 7 * DAY;
const SOCIAL_CANCEL_KIND = 'social.cancel-offers';
const SOCIAL_CANCEL_LIMIT = 200;

/* P06 Core match hints. `core-match` is the ONE match-change channel: a post-commit nudge carrying
 * ONLY the changed match id - never an actor, a session, a token, a wallet or a match document. A
 * hint is rebuildable fan-out coordination, never authority; every observer rereads PostgreSQL. The
 * TTL is the ephemera adapter's required positive value bound for `publish` (a pub/sub message has
 * no TTL of its own; the value is opaque and never interpreted). */
const MATCH_CHANNEL = 'core-match';
const MATCH_HINT_TTL_MS = 30000;

/* --------------------------------------------------------------- value helpers */

function sha256hex(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function operationId(actor, key) { return JSON.stringify([actor, key]); }
function commandFingerprint(principal, command) { return sha256hex(JSON.stringify({ principal, cmd: command })); }
function iso(ms) { return new Date(ms).toISOString(); }

/* Which Core-owned field of an account the aggregate diff persists as an ECONOMIC row. The set is
 * deliberately the WALLET/RATING slots the pure helper initializes and nothing else: `restore()`
 * has already given the hydrated skeleton its `season`, `seasonHistory`, `tournamentRecord`, `daily`,
 * `operations`, `ledger`, `owned` and `history` defaults, so copying the helper's empty versions of
 * those would ERASE live rows for an actor that carries assets without a wallet row. Provisioning is
 * therefore strictly additive: it fills the empty economic slots and never removes an entity. */
const PROVISIONED_ECONOMIC_FIELDS = Object.freeze([
 'coins', 'crowns', 'purchasedCoins', 'purchasedCrowns', 'reservedCoins', 'reservedCrowns',
 'rating', 'peak', 'games', 'casualRating', 'casualGames', 'tier',
 'purchaseInfluenced', 'legacyCompetitionRestricted',
]);

/* --------------------------------------------------------------- outbox */

/* A sanitized durable event in the caller's transaction (design: producers write outbox rows in
 * their business transaction). The payload carries routing facts only - never a secret, a token, a
 * provider transaction id or a balance - because the authoritative data already lives in the
 * normalized tables. `ON CONFLICT DO NOTHING` makes a replayed operation structurally idempotent. */
async function emitOutbox(tx, { id, kind, event, now }) {
 await tx.query(
  'INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at, lease_until, attempts)'
  + " VALUES ($1, $2, $3, 'queued', $4, $5, $4, '1970-01-01T00:00:00+00:00', 0)"
  + ' ON CONFLICT (outbox_id) DO NOTHING',
  [id, JSON.stringify(event), kind, iso(now), iso(now + OUTBOX_EXPIRY_MS)]);
 return id;
}

/* --------------------------------------------------------------- match hints */

/* The bounded hint payload: the changed match id and NOTHING else. No actor, session, token, wallet
 * or match document ever reaches Redis - the authoritative document already lives in PostgreSQL, so
 * a hint carries only the routing fact an observer needs to pick the right row to reread. */
function matchHintText(matchId) {
 return JSON.stringify({ matchId: String(matchId) });
}

/* The exact-matchId filter, applied to the RAW string the ephemera subscriber delivers. A malformed,
 * truncated or spoofed payload parses to `null` and is ignored: an observer can only ever reread
 * PostgreSQL for the match it is already watching, so no hint can invent state or redirect a read. */
function matchHintId(text) {
 try {
  const parsed = JSON.parse(text);
  return parsed && typeof parsed.matchId === 'string' ? parsed.matchId : null;
 } catch { return null; }
}

/* --------------------------------------------------------------- lock planning */

/* The ONE lock order every Core-owned transaction in this repo follows (design 3.7 / spec 01
 * section 3, extended by the frozen parent decision):
 *
 *   logical identity mutexes (operation, then every named aggregate/receipt identity, sorted)
 *     -> business aggregate/receipt ROWS (sorted)
 *     -> identity.eligibility rows (sorted)
 *     -> core.actor_occupancy + economy.wallets (`wallets.lock`, actor ids sorted ascending)
 *     -> dependent rows (ledger / outcome / outbox)
 *
 * IDENTITY MUTEX BEFORE ROW LOCK, because a row that does not exist yet cannot be locked: two
 * `offer`s naming the same absent match id would otherwise both see an empty table and both create
 * the match with disjoint actor locks. `lockTransactionIdentity` serializes the LOGICAL identity on
 * the pinned transaction, so an absent aggregate/receipt identity is as safe as a present one.
 * The operation identity is taken first and unconditionally, so two commands that share a
 * service-principal key but touch DISJOINT aggregates still serialize and one of them observes the
 * other's committed outcome instead of both applying their business effect.
 *
 * The affected actor list is derived from the durable rows (match.participants) AFTER the aggregate
 * identity is held - `offer`/`queue` name no participants of their own, and a match that appears
 * after planning must not be accepted against unlocked seats. Every decision is re-derived from the
 * aggregate UNDER the locks. */

/* A sorted `FOR UPDATE` lock over the affected actors' eligibility rows. */
async function lockEligibility(q, actors) {
 if (actors.length === 0) return;
 await q('SELECT actor_id FROM identity.eligibility WHERE actor_id = ANY($1::text[]) ORDER BY actor_id FOR UPDATE', [actors]);
}

/* `FOR UPDATE` on the business aggregate row (match/tournament). The row may not exist yet (an
 * `offer`/`queue` creates it); the caller holds the matching logical IDENTITY mutex, which is what
 * serializes the create, so a missing row is safe to observe here. */
async function lockAggregate(q, kind, id) {
 const tournament = kind === 'tournament';
 await q(`SELECT 1 FROM ${tournament ? 'tournament.rooms' : 'match.matches'} WHERE ${tournament ? 'room_id' : 'match_id'} = $1 FOR UPDATE`, [id]);
}

/* Participants of a match from the durable rows. Read AFTER the aggregate identity mutex is held, so
 * the set cannot change under the plan; the command's decision is still re-derived from the
 * aggregate under the locks. */
async function matchActors(q, matchId) {
 const r = await q('SELECT actor_id FROM match.participants WHERE match_id = $1 ORDER BY seat', [matchId]);
 return r.rows.map((row) => row.actor_id);
}

/* The LOGICAL identities a command must serialize on, in the frozen order: the operation identity
 * (always), then every named aggregate/receipt identity sorted. Namespaces are the shared
 * `lockTransactionIdentity` vocabulary: `operation` + [family, actor, key], `aggregate` + [kind, id],
 * `receipt` + [store, transactionId]. */
const OPERATION_FAMILY = 'economy';
function operationIdentity(principal, key) { return { namespace: 'operation', parts: [OPERATION_FAMILY, principal.actor, key] }; }
const MATCH_COMMANDS = Object.freeze(['accept', 'decline', 'cancel', 'expire', 'timeout', 'void', 'move', 'resign', 'offer', 'queue']);
function aggregateIdentities(command) {
 const out = [];
 if (MATCH_COMMANDS.includes(command.type) && typeof command.id === 'string' && command.id) out.push({ namespace: 'aggregate', parts: ['match', command.id] });
 return out;
}

/* Take one identity mutex in the frozen vocabulary (`lockTransactionIdentity(tx, namespace, parts)`),
 * reusing the SAME namespaces the API's provider-subject locks use. */
async function lockIdentity(tx, namespace, parts) { return lockTransactionIdentity(tx, namespace, parts); }
/* Take the actor-scoped half of the global order: eligibility rows (sorted), then occupancy and
 * wallets (sorted). Used by every path that has no named business aggregate. */
async function lockActors(tx, actors) {
 const sorted = [...new Set(actors)].filter((actor) => typeof actor === 'string' && actor.length > 0).sort();
 await lockEligibility(tx.query, sorted);
 await tx.repositories.wallets.lock(sorted);
 return sorted;
}

/* Derive the affected locks for a command and take them in the global order: logical identities,
 * then aggregate/receipt rows, then eligibility -> occupancy/wallet. Returns BOTH the full lock set
 * (including the principal, which may be a virtual operator/matchmaker/store principal with no
 * account row) and the actual PLAYER participants whose wallet readiness the command's effect
 * requires. A service principal is never a player account, so it is not in the required set. */
async function lockTargets(tx, principal, command, key) {
 const q = tx.query;
 const operation = operationIdentity(principal, key);
 await lockIdentity(tx, operation.namespace, operation.parts);
 for (const identity of aggregateIdentities(command)) await lockIdentity(tx, identity.namespace, identity.parts);
 let aggregate = null;
 /* The actual affected PLAYER participants (a scope='player' principal is one; the virtual
  * operator/matchmaker/store principals are not). */
 const players = [];
 switch (command.type) {
  case 'accept':
  case 'decline':
  case 'cancel':
  case 'expire':
  case 'timeout':
  case 'void':
  case 'move':
  case 'resign': {
   if (typeof command.id === 'string' && command.id) {
    aggregate = { kind: 'match', id: command.id };
    for (const actor of await matchActors(q, command.id)) players.push(actor);
   }
   break;
  }
  case 'offer': {
   /* A pending offer between two actors whose match row is absent: the aggregate identity mutex
    * above is the create's serialization point, so no participant rows can appear before the lock. */
   if (principal.scope === 'player') players.push(principal.actor);
   if (typeof command.opponent === 'string' && command.opponent) players.push(command.opponent);
   break;
  }
  case 'queue': {
   if (principal.scope === 'player') players.push(principal.actor);
   if (typeof command.a === 'string' && command.a) players.push(command.a);
   if (typeof command.b === 'string' && command.b) players.push(command.b);
   break;
  }
  case 'snapshot':
  case 'weekly': {
   /* GLOBAL: a snapshot/payout evaluates every account, so every actor row is part of the
    * operation. A truncated read cannot prove which actor is missing, and paying a subset would
    * fabricate an incomplete week - fail closed instead. */
   const r = await q('SELECT actor_id FROM identity.actors ORDER BY actor_id LIMIT $1', [CAP.actors + 1]);
   if (r.rows.length > CAP.actors) throw Error('STATE_TRUNCATED');
   for (const row of r.rows) players.push(row.actor_id);
   break;
  }
  default: {
   if (principal.scope === 'player') players.push(principal.actor);
   break;
  }
 }
 if (aggregate) await lockAggregate(q, aggregate.kind, aggregate.id);
 const required = [...new Set(players)].filter((actor) => typeof actor === 'string' && actor.length > 0);
 const locked = await lockActors(tx, [principal.actor, ...required]);
 return { locked, required };
}

/* --------------------------------------------------------------- factory */

async function createCoreService(pool, options = {}) {
 if (!pool || typeof pool.describe !== 'function' || typeof pool.withTransaction !== 'function') {
  throw new PgGuardError('PG_POOL_REQUIRED');
 }
 const described = pool.describe();
 if (!described || described.role !== CORE_ROLE) {
  throw new PgGuardError('ROLE_MISMATCH', { expected: CORE_ROLE, observed: described ? described.role : null }, 'the Core service must run on a core_runtime pool');
 }
 if (options.now !== undefined && typeof options.now !== 'function') throw new PgGuardError('CLOCK_REQUIRED');
 if (options.random !== undefined && typeof options.random !== 'function') throw new PgGuardError('RANDOM_REQUIRED');
 if (options.verifyPurchase !== undefined && typeof options.verifyPurchase !== 'function') throw new PgGuardError('VERIFIER_REQUIRED');

 /* The boot-time schema gate: no DDL, no seeding, no default rows - only a read-only comparison of
  * the live chain against the checksummed manifest. */
 const readiness = await verifyRuntimeSchema(pool);

 /* The clock is the injected one and is threaded into the unit of work, so a journal instant, an
  * occupation claim and an outbox timestamp all come from the caller's clock (never the host
  * clock) and are stable across the passes of one unit of work. */
 const uow = createPgUnitOfWork(pool, {
  role: CORE_ROLE,
  now: options.now,
  random: options.random,
  verifyPurchase: options.verifyPurchase,
 });

 /* P06 match hints: a CALLER-OWNED ephemera adapter (packages/services/ephemera.js) used ONLY for
  * the post-commit `core-match` publish and the `watchMatch` subscription. This service NEVER
  * constructs, reconfigures or closes it; without an adapter (or with Redis down) hints are simply
  * unavailable and every observer falls back to a strong PostgreSQL read. The capability check keeps
  * a partial/incompatible object from being mistaken for a working adapter. */
 const ephemera = options.ephemera
  && typeof options.ephemera.publish === 'function'
  && typeof options.ephemera.subscribe === 'function'
  ? options.ephemera : null;

 /* Publishes ONE bounded committed match-change hint. Called ONLY after `uow.run` has RESOLVED, so
  * the change it reports is durably committed; a rollback never reaches this call. Redis is
  * best-effort coordination: a failed/deadline-missed publish is swallowed and can never turn a
  * committed success into a failure, replace PostgreSQL truth or drop the durable outbox. A replayed
  * command may republish harmlessly (observers reread PostgreSQL, never trust a hint). No Redis I/O
  * ever runs inside the transaction. */
 async function publishMatchHint(matchId) {
  if (!ephemera) return { published: false, available: false, conservative: true };
  try {
   const out = await ephemera.publish(MATCH_CHANNEL, matchHintText(matchId), MATCH_HINT_TTL_MS);
   return out && typeof out === 'object' ? out : { published: false, available: false };
  } catch { return { published: false, available: false, conservative: true }; }
 }

 /* Live `watchMatch` teardown handles. `close()` runs each SYNCHRONOUSLY (fire-and-forget) so it can
  * still close the owning UoW immediately and keep its synchronous contract, while a watch stops
  * receiving callbacks at once and its owned subscription is released best-effort. Each handle
  * removes itself. */
 const activeWatches = new Set();

 /* The replay path: the stored response is already the decoded document (the adapter parses the
  * JSON-TEXT outcome column), and the source boundary returned exactly that object. An explicit hit
  * flag keeps a legitimately falsy stored response (an unmet quest claim stores `0`) distinguishable
  * from "no prior outcome". */
 async function replayOrNull(tx, principal, key, fingerprint) {
  const previous = await tx.repositories.outcomes.find(COMMANDS, operationId(principal.actor, key));
  if (!previous) return { hit: false, response: null };
  if (previous.fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT');
  return { hit: true, response: previous.response };
 }

 /* All externally reachable commands pass through this transaction boundary. */
 async function run(principal, key, command) {
  validateInvocation(principal, key, command);
  if (API_OWNED_COMMANDS.includes(command.type)) throw Error('API_OWNED_COMMAND');
  if (COMMERCE_OWNED_COMMANDS.includes(command.type)) throw Error('COMMERCE_OWNED_COMMAND');
  if (command.type === 'provision') throw Error('PROVISION_REQUIRES_PROVISION_ACTOR');
  const fingerprint = commandFingerprint(principal, command);
  const outcome = await uow.run(async (tx) => {
   const repositories = tx.repositories;
   /* LOGICAL IDENTITIES, then the aggregate/receipt ROWS, then eligibility/occupancy/wallets
    * (design 3.7). The operation identity is taken FIRST and unconditionally, so two commands that
    * share a service-principal key but touch disjoint aggregates still serialize on it and the
    * loser re-reads the winner's committed outcome instead of applying a second business effect. */
   const plan = await lockTargets(tx, principal, command, key);
   const replayed = await replayOrNull(tx, principal, key, fingerprint);
   /* A REPLAY commits nothing new: the stored response is returned unchanged and NO hint is
    * published, because no match change happened in this invocation. */
   if (replayed.hit) return { response: replayed.response, hintIds: [] };
   /* WALLET READINESS (P05). `economy.wallets` row existence is the durable readiness fact, and
    * `core.provisionActor` is the only wallet creator. An account the API has handed to Core without
    * a wallet is PENDING: it may not play or claim, because a casual queue finish would otherwise
    * mint a two-Coin wallet and permanently skip the approved 150-Coin opening grant. This is a
    * provisioning-readiness gate, not a new gameplay rule: it applies to the actual PLAYER
    * participants (a scope='player' principal and every opponent/participant the effect touches),
    * never to the virtual operator/matchmaker/store principals, which have no account at all. */
   if (!GLOBAL_COMMANDS.includes(command.type) && plan.required.length) {
    const pending = await tx.query(
     'SELECT a.actor_id FROM identity.actors a LEFT JOIN economy.wallets w ON w.actor_id = a.actor_id'
     + ' WHERE a.actor_id = ANY($1::text[]) AND w.actor_id IS NULL ORDER BY a.actor_id LIMIT 1',
     [plan.required]);
    if (pending.rows.length) throw Error('ACCOUNT_REQUIRED');
   }
   const graph = await repositories.domain();
   /* NO WRITABLE TRUNCATED AGGREGATE: a decision input that could not be read completely cannot
    * prove which row is absent, so the command fails closed instead of applying an upsert-only
    * degraded effect. (A bounded GLOBAL HISTORY overflow is classified separately and only
    * suppresses that table's delete pass; it never sets this flag.) */
   if (graph.complete !== true) throw Error('STATE_TRUNCATED');
   const result = executeCommand(graph.authority, principal, key, command);
   /* `executeCommand` already applies the legacy nullish semantics (an undefined result becomes
    * {ok:true}); the null check is a belt-and-braces guard on the frozen dispatcher. */
   const response = result === undefined || result === null ? { ok: true } : result;
   /* The outbox event exists for a real business change; a command that legitimately changed nothing
    * (an already-owned cosmetic, an unmet quest) still records its outcome but does not enqueue
    * delivery work. The insert is idempotent on the derived `<actor>:<key>` identity. */
   const stats = await repositories.commitDomain();
   /* The outcome key was CLAIMED under the operation identity mutex above, so this insert cannot
    * legitimately conflict. If it does, a foreign writer inserted the key without the mutex: the
    * whole transaction (business effect included) aborts rather than committing a second effect
    * behind one outcome row. */
   const claimed = await repositories.outcomes.claim(COMMANDS, operationId(principal.actor, key), principal.actor, fingerprint, JSON.stringify(response));
   if (!claimed) throw Error('IDEMPOTENCY_CONFLICT');
   if (stats.upserts + stats.deletes > 0) {
    await emitOutbox(tx, {
     id: `core.command:${principal.actor}:${key}`,
     kind: OUTBOX_KIND,
     event: { actor: principal.actor, type: command.type, key, matchId: typeof command.id === 'string' ? command.id : null, changes: stats.upserts + stats.deletes },
     now: tx.clock(),
    });
   }
   /* The hint is reported to the CALLER, not published here: the publish happens after this
    * transaction has COMMITTED (see `run`), so a rollback cannot publish a change that never landed.
    * Only a named MATCH command that actually changed a row AND carries a match id is reportable;
    * the flag is computed per invocation, never from a shared global. */
   const hintIds = stats.upserts + stats.deletes > 0
    && MATCH_COMMANDS.includes(command.type)
    && typeof command.id === 'string' && command.id
    ? [command.id] : [];
   return { response, hintIds };
  });
  /* POST-COMMIT, BEST-EFFORT. Every reported id is a real committed match change; the hint is
    * rebuildable fan-out and a failure here never alters the committed response. */
  for (const matchId of outcome.hintIds) await publishMatchHint(matchId);
  return outcome.response;
 }

 /* Strong current read. `read(fn)` evaluates the caller's selector inside ONE read-only transaction,
  * so it sees committed truth and cannot be answered from a stale cache. `read()` with no selector
  * resolves the WHOLE exported aggregate (the shape `Authority.export()` produces and the legacy
  * `state` row carried) - the strong-current read of Core state. */
 async function read(selector) {
  if (selector !== undefined && typeof selector !== 'function') throw Error('READ_SELECTOR_REQUIRED');
  return uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   if (selector !== undefined) return selector(tx);
   return tx.repositories.state.read();
  });
 }

 /* The Core half of the P05 provisioning handshake. The API owns the actor, its eligibility row and
  * its profile; Core owns the wallet/rating/season/records/credits and the opening ledger entry. A
  * wallet row is the durable readiness fact, so an existing wallet returns ready WITHOUT a second
  * grant - and WITHOUT minting anything else either; the deterministic ledger id `opening:<actor>`
  * plus the wallet primary key make a replay structurally idempotent.
  *
  * FULL ATOMIC INITIAL STATE. A brand-new wallet is written together with the approved initial
  * `economic.season_state`, `monetization.credits` and `economy.tournament_records` rows, because a
  * ready wallet whose `season` row is missing reads back as `season: null` (the parent's actual PG16
  * smoke failure) and a settlement would then roll the quarter without a prior archive. All four
  * rows come from ONE `Authority.addAccount` call and commit in ONE transaction; an existing row is
  * never overwritten (the aggregate diff sees it already present) and a rerun with an existing wallet
  * mints nothing. */
 async function provisionActor(actor) {
  if (typeof actor !== 'string' || !actor) throw Error('INVALID_ACTOR');
  return uow.run(async (tx) => {
   const repositories = tx.repositories;
   const actorRow = await tx.query('SELECT 1 AS ok FROM identity.actors WHERE actor_id = $1', [actor]);
   if (actorRow.rows.length === 0) throw Error('ACCOUNT_REQUIRED');
   /* Serialize on the existing eligibility row first (the Core column UPDATE grant on
    * suspended/security_hold permits the row lock): it is the rendezvous between this provisioning
    * pass and an entry/deletion transition for the same actor. Then occupancy and wallet. No
    * business aggregate is named, so this is the actor-scoped half of the global order (eligibility
    * -> occupancy -> wallet), exactly like a conversion or a purchase. The locked wallet count is
    * the readiness answer. */
   const eligibility = await tx.query('SELECT actor_id FROM identity.eligibility WHERE actor_id = $1 FOR UPDATE', [actor]);
   if (eligibility.rows.length === 0) throw Error('ACCOUNT_REQUIRED');
   const locked = await repositories.wallets.lock([actor]);
   const graph = await repositories.domain();
   const skeleton = graph.account(actor);
   if (locked.wallets > 0) {
    return { actor, ready: true, created: false, coins: skeleton.coins, crowns: skeleton.crowns, rating: skeleton.rating };
   }
   /* A participant row for this actor that no match row can explain is a torn aggregate, not a new
    * account: refuse rather than provisioning on top of it. */
   const orphan = await tx.query(
    'SELECT p.match_id FROM match.participants p LEFT JOIN match.matches m ON m.match_id = p.match_id'
    + ' WHERE p.actor_id = $1 AND m.match_id IS NULL LIMIT 1', [actor]);
   if (orphan.rows.length) throw Error('INVALID_AGGREGATE');
   /* The approved initial shape comes from the PURE domain helper (its own defaults), never from a
    * constant cloned into this service. `createdAt` is echoed only so the in-memory shape is
    * faithful; identity.actors.created_at stays the API's value and is never rewritten here. */
   const seed = new Authority({ now: () => tx.clock() });
   const approved = seed.addAccount(actor, { createdAt: skeleton.createdAt === null || skeleton.createdAt === undefined ? tx.clock() : skeleton.createdAt, verified: true });
   /* Only fields the helper actually produces are copied: the approved economic shape must not
    * erase a hydrated value with `undefined` (an unset `reachedAt` stays the hydrated null). The
    * helper owns the AMOUNTS; every non-economic field stays exactly as the live graph has it. */
   for (const field of PROVISIONED_ECONOMIC_FIELDS) if (approved[field] !== undefined) skeleton[field] = approved[field];
   /* The approved `season_state` / `tournament_records` rows are materialized by the aggregate diff
    * itself: the hydrator gives the skeleton the `Authority.restore()` defaults, the composed
    * before-image carries this LOCKED actor's RAW durable account (whose `season` was NULL), and the
    * difference is persisted in this same commit - so the wallet is never ready without its season.
    * A row that already exists is not overwritten (the baseline already carries it).
    *
    * `monetization.credits` cannot ride the aggregate (the hydrated account always carries the
    * default sub-record, so "row absent" is inexpressible), so it is inserted here explicitly,
    * inside this same transaction, ON CONFLICT DO NOTHING so an existing row is never overwritten. */
   await tx.query("INSERT INTO monetization.credits (actor_id, credit_balance, equipped_frame) VALUES ($1, 0, 'classic') ON CONFLICT (actor_id) DO NOTHING", [actor]);
   /* The opening balance is a journal entry (`opening:<actor>`), exactly as the source helper
    * writes it; it is appended to the live journal so the aggregate diff persists it once. */
   for (const entry of seed.journal) if (entry.actor === actor) graph.authority.journal.push(entry);
   await repositories.commitDomain();
   return { actor, ready: true, created: true, coins: approved.coins, crowns: approved.crowns, rating: approved.rating };
  });
 }

 /* Core half of the API's unfriend/block path. `social.*` is api-owned, `match.matches` is
  * core-owned, so the API asks Core to cancel the still-open offers between two actors. Only
  * OFFERED matches are cancelled (an approved CANCELLED behaviour); a running match is never
  * touched. The cancellation, its outbox event and the (absent) outcome are one transaction.
  *
  * DURABLE GRAPH RECHECK. The API's outbox row can be delivered late, so this method NEVER cancels
  * on the strength of the request alone: it re-reads the committed `social.friendships` /
  * `social.blocks` rows UNDER the locks and does nothing when the pair is still mutually friended
  * and neither blocks the other (a stale block/remove callback after a re-friend must be a no-op).
  * Social removal is what authorizes the cancel; the current durable truth decides. */
 async function cancelSocialOffers(actor, target) {
  if (typeof actor !== 'string' || !actor || typeof target !== 'string' || !target || actor === target) throw Error('INVALID_SOCIAL_PAIR');
  const outcome = await uow.run(async (tx) => {
   const repositories = tx.repositories;
   const candidates = await tx.query(
    "SELECT m.match_id FROM match.matches m WHERE m.status = 'OFFERED'"
    + ' AND EXISTS (SELECT 1 FROM match.participants p WHERE p.match_id = m.match_id AND p.actor_id = $1)'
    + ' AND EXISTS (SELECT 1 FROM match.participants p WHERE p.match_id = m.match_id AND p.actor_id = $2)'
    + ' ORDER BY m.match_id LIMIT $3',
    [actor, target, SOCIAL_CANCEL_LIMIT]);
   const ids = candidates.rows.map((row) => row.match_id);
   if (ids.length === 0) return { result: { ok: true, cancelled: [] }, hintIds: [] };
   /* A saturated candidate read cannot prove which offers remain; cancelling the first 200 and
    * reporting completion would leave live offers behind while claiming the pair's offers are
    * settled. The bounded-read convention applies: fail closed instead. */
   if (ids.length >= SOCIAL_CANCEL_LIMIT) throw Error('STATE_TRUNCATED');
   /* LOGICAL aggregate identities FIRST (sorted; the candidate read ordered by match_id, so the order
    * is deterministic), then the rows - the same identity-before-row order a named-aggregate command
    * takes, so an `offer` racing this cancellation cannot both insert and be cancelled. */
   for (const id of ids) await lockIdentity(tx, 'aggregate', ['match', id]);
   for (const id of ids) await lockAggregate(tx.query, 'match', id);
   const pair = [...new Set([actor, target])].sort();
   await lockActors(tx, pair);
   /* Durable social truth UNDER the locks: still mutually friended and neither blocks the other
    * means the social removal this callback reports has been undone, so nothing is cancelled. */
   const friendship = await tx.query('SELECT 1 FROM social.friendships WHERE actor_a = $1 AND actor_b = $2', [pair[0], pair[1]]);
   const blockFrom = await tx.query('SELECT 1 FROM social.blocks WHERE blocker_id = $1 AND blocked_id = $2', [actor, target]);
   const blockTo = await tx.query('SELECT 1 FROM social.blocks WHERE blocker_id = $1 AND blocked_id = $2', [target, actor]);
   const stillConnected = friendship.rows.length > 0 && blockFrom.rows.length === 0 && blockTo.rows.length === 0;
   if (stillConnected) return { result: { ok: true, cancelled: [] }, hintIds: [] };
   /* Re-read the aggregate UNDER the locks: the cancel decision is made on committed truth, not on
    * the pre-lock candidate list. */
   const graph = await repositories.domain();
   const cancelled = [];
   for (const id of ids) {
    const match = graph.matches.get(id);
    if (match && match.status === 'OFFERED') { match.status = 'CANCELLED'; cancelled.push(id); }
   }
   if (cancelled.length === 0) return { result: { ok: true, cancelled: [] }, hintIds: [] };
   await repositories.commitDomain();
   for (const id of cancelled) {
    await emitOutbox(tx, {
     id: `social.cancel-offers:${id}`,
     kind: SOCIAL_CANCEL_KIND,
     event: { matchId: id, actors: pair, reason: 'social-removal' },
     now: tx.clock(),
    });
   }
   /* Each reported id is a match whose status ACTUALLY changed to CANCELLED and committed in this
    * transaction; the hint is published by the caller AFTER the commit. */
   return { result: { ok: true, cancelled }, hintIds: cancelled };
  });
  for (const matchId of outcome.hintIds) await publishMatchHint(matchId);
  return outcome.result;
 }

 /* The DURABLE membership selector an internal authenticated gateway uses to resolve one match.
  * Same approved `Authority.view` DTO as `read(selector => tx.repositories.matches.view(id))` - no
  * cached aggregate, no second view shape - but membership is enforced on EVERY read from the
  * committed `match.participants` rows: an absent match is `UNKNOWN_MATCH` and a caller that is not
  * one of the seated players is `NOT_PARTICIPANT`. It adds no gameplay/auth gate. A truncated
  * aggregate read cannot prove a match absent, so it fails closed (`STATE_TRUNCATED`) rather than
  * reporting a false `UNKNOWN_MATCH`. */
 async function readMatch(actor, matchId) {
  if (typeof actor !== 'string' || !actor) throw Error('INVALID_ACTOR');
  if (typeof matchId !== 'string' || !matchId) throw Error('UNKNOWN_MATCH');
  return uow.run(async (tx) => {
   await tx.query('SET TRANSACTION READ ONLY');
   const graph = await tx.repositories.domain();
   if (graph.complete !== true) throw Error('STATE_TRUNCATED');
   const view = graph.authority.view(matchId); /* UNKNOWN_MATCH when the row is absent */
   if (!Array.isArray(view.players) || !view.players.includes(actor)) throw Error('NOT_PARTICIPANT');
   return view;
  });
 }

 /* Structural facts that END a watch rather than being retried: the match does not exist, this
  * actor is not a participant, or the owning unit of work is closed. Every other read fault is
  * transient and simply leaves the last delivered/returned snapshot in force until the next hint. */
 const TERMINAL_WATCH_CODES = Object.freeze(['UNKNOWN_MATCH', 'NOT_PARTICIPANT', 'UNIT_OF_WORK_CLOSED']);
 const isTerminalWatchError = (error) => TERMINAL_WATCH_CODES.includes(error && typeof error.message === 'string' ? error.message : '');

 /* Subscribe to committed match-change hints for ONE match, then read durable truth.
  *
  * Subscription OPENS FIRST and the initial durable read follows, so a commit that lands between
  * the two is still observed (a hint arriving before the initial read completes is coalesced into
  * exactly one follow-up reread). The result is:
  *   - `available`: whether live hints could be opened. Without a caller adapter, or with Redis
  *     down, it is `false` - the conservative shape - and `refresh` is still a strong PostgreSQL read.
  *   - `snapshot`: the initial durable DTO (membership enforced; the same errors `readMatch` raises).
  *   - `refresh()`: ALWAYS a fresh strong-current read, independent of the hint channel.
  *   - `unsubscribe()`: stops callbacks IMMEDIATELY and releases the owned subscription (never the
  *     caller's adapter or pool).
  * `onSnapshot` fires ONLY for post-initial notifications, and only after a hint whose exact matchId
  * matches AND a successful durable reread re-establishes membership. A malformed/spoofed hint
  * parses to null and is ignored. Hint bursts coalesce into at most one in-flight plus one pending
  * reread, so there is no unbounded queue; the listener is AWAITED one delivery at a time and a
  * listener fault (sync or async) is swallowed, never an unhandled rejection. */
 async function watchMatch(actor, matchId, onSnapshot) {
  if (typeof actor !== 'string' || !actor) throw Error('INVALID_ACTOR');
  if (typeof matchId !== 'string' || !matchId) throw Error('UNKNOWN_MATCH');
  if (typeof onSnapshot !== 'function') throw Error('LISTENER_REQUIRED');

  let closed = false;        /* set the instant unsubscribe()/terminal cleanup runs */
  let ready = false;         /* the initial durable read completed */
  let inFlight = false;      /* one PostgreSQL reread in flight at a time */
  let pending = false;       /* at most one queued reread while in flight */
  let subscription = null;   /* the owned adapter subscription, if one could be opened */

  /* Releases the OWNED subscription (never the caller's adapter/pool) and stops callbacks at once.
   * Idempotent and bounded; a failing unsubscribe is swallowed. Deregisters from the close-time
   * teardown registry so a closed service holds no live watch. */
  function stop() {
   closed = true;
   activeWatches.delete(handle);
   const sub = subscription;
   subscription = null;
   if (!sub) return Promise.resolve();
   try {
    const result = typeof sub.unsubscribe === 'function' ? sub.unsubscribe() : undefined;
    if (result && typeof result.then === 'function') return result.then(() => {}, () => {});
   } catch { /* releasing an owned subscription is best-effort */ }
   return Promise.resolve();
  }
  const handle = { stop };
  /* Registered BEFORE the subscription opens so a `close()` racing the initial read tears the watch
    * down too (stop() deregisters it again). */
  activeWatches.add(handle);

  /* The bounded reread loop. A hint while a reread is running sets `pending` (one slot, no queue);
  * the running loop drains it before finishing. */
  async function drain() {
   if (inFlight || closed || !ready) return;
   inFlight = true;
   try {
    do {
     pending = false;
     if (closed || !ready) break;
     let snapshot;
     try { snapshot = await readMatch(actor, matchId); }
     catch (error) {
      /* A structural denial ends the watch (releasing the subscription); a transient fault keeps
       * the watch alive for the next hint. Either way nothing is thrown into an unhandled context. */
      if (isTerminalWatchError(error)) { await stop(); break; }
      break;
     }
     if (closed) break;
     /* ONE in-flight listener delivery. The pump AWAITS the listener's (possibly async) work with a
      * rejection handler before it considers the next pending reread, so slow listeners cannot accrete
      * unbounded outstanding delivery work: at most one listener call is outstanding at a time. A
      * listener fault - synchronous throw or rejected thenable - is swallowed and never escapes. */
     try { await Promise.resolve(onSnapshot(snapshot)); } catch { /* listener fault is not fatal */ }
    } while (pending && !closed);
   } finally { inFlight = false; }
  }

  /* The raw hint text is filtered by EXACT matchId; before the initial read completes a matching
  * hint only records that a reread is owed, so no callback can precede the returned snapshot. A
  * matching hint ALWAYS sets the one-slot `pending` flag first, so a burst that arrives while a
  * reread is already running coalesces into exactly one further reread instead of being lost. */
  const listener = (text) => {
   if (closed) return;
   if (matchHintId(text) !== matchId) return;
   pending = true;
   if (ready) drain();
  };

  /* Open hints first. A subscribe fault (or an absent adapter) degrades to `available:false` while
  * the durable initial read below still runs. */
  let available = false;
  if (ephemera) {
   try {
    const opened = await ephemera.subscribe(MATCH_CHANNEL, listener);
    if (opened && opened.available === true) { subscription = opened; available = true; }
    else if (opened && typeof opened === 'object') subscription = opened; /* conservative no-op handle */
   } catch { subscription = null; available = false; }
  }

  let snapshot;
  try {
   snapshot = await readMatch(actor, matchId);
  } catch (error) {
   /* A failed initial membership read (unknown match, wrong participant, closed UoW) must not leak
    * an opened subscription. */
   await stop();
   throw error;
  }
  if (closed) { await stop(); return Object.freeze({ available: false, snapshot, refresh: () => readMatch(actor, matchId), unsubscribe: stop }); }
  ready = true;
  /* A hint that matched while the initial read was running now triggers the deferred post-initial
    * notification (never a callback for the initial snapshot itself). */
  if (pending) drain();

  return Object.freeze({
   available,
   snapshot,
   /* Always strong current PostgreSQL truth; unaffected by Redis state or by unsubscribe. */
   refresh: () => readMatch(actor, matchId),
   unsubscribe: stop,
  });
 }

 return Object.freeze({
  role: CORE_ROLE,
  readiness,
  run,
  read,
  readMatch,
  watchMatch,
  provisionActor,
  cancelSocialOffers,
  /* Releases this service's unit-of-work state only. The pool is caller-owned (it carries a
    * cluster-wide connection-budget claim) and is NEVER closed here. Every live `watchMatch` is torn
    * down FIRST (callbacks stop, owned subscriptions release best-effort, the borrowed ephemera
    * adapter and the pool are never touched); closing the UoW then makes further reads fail fast
    * with UNIT_OF_WORK_CLOSED. The close call itself remains synchronous. */
  close() {
   for (const watch of [...activeWatches]) { try { watch.stop(); } catch { /* best-effort teardown */ } }
   activeWatches.clear();
   uow.close();
  },
 });
}

module.exports = {
 createCoreService,
 lockEligibility,
 lockActors,
 CORE_ROLE,
 API_OWNED_COMMANDS,
 COMMERCE_OWNED_COMMANDS,
 PROVISIONED_ECONOMIC_FIELDS,
};
