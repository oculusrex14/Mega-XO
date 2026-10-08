/* packages/db/pg/repositories.js - V5 P04 PostgreSQL repository set.
 *
 * The asynchronous mirror of `packages/db/repositories.js` (the frozen SQLite/reference
 * adapter). SAME member names, same semantics, one transaction: every method runs on the
 * caller's live `withIdempotentTransaction` scope and none opens, commits or rolls back a
 * transaction of its own. Outside a live scope every method raises the shared
 * `ContextError('TRANSACTION_REQUIRED')`.
 *
 * NO SQLITE IN THIS PATH. This module never requires `node:sqlite`,
 * `packages/db/repositories.js` or `packages/db/index.js`. It does require `src/authority.js`,
 * deliberately: that module's require graph is exactly `node:crypto`, `src/game.js`,
 * `src/domain.js` and `packages/domain/abuse.js` (verified by walking it), so it carries no
 * storage of any kind and is used here PURELY as the in-memory domain model whose constructor
 * accepts the assembled `state` object. It is never given a connection and never persists;
 * `commitDomain()` writes entity rows itself. Hand-assembling a parallel account/match shape
 * would be a second, drifting definition of the domain - the thing this port exists to avoid.
 *
 * STORAGE MODEL. The legacy adapter kept ONE serialized `state` row. V5 has no such table and
 * none is invented here: that row was decomposed into the normalized tables of
 * packages/migrations/migrations/0004-0037 (design 2.2). So:
 *   - `domain()` hydrates the normalized tables into the exact object shape
 *     `new Authority({state})` expects, so `packages/domain/commands.js` (`executeCommand`) and
 *     every existing caller keep working unchanged.
 *   - `state.read()` returns the same aggregate in its RAW export shape (what server/rooms.js
 *     consumes: `accounts` as [id, account] pairs, `journal[]`, `burned[c]`).
 *   - `commitDomain()` / `state.write(value)` diff the aggregate against the snapshot taken at
 *     hydration and emit bounded, parameterized single-row INSERT/DELETE per touched ENTITY
 *     table. There is no whole-graph rewrite and no `state` table.
 *
 * AGGREGATE OWNERSHIP BOUNDARY. The aggregate is authoritative for exactly the columns the
 * domain model owns: actor region/wealth flags, eligibility flags, wallets, ratings, burns,
 * ledger, wallet operations/ledger entries, daily progress, seasons, tournament records, match
 * history, social graph, occupancy, matches/participants/move outcomes, receipts, monetization
 * counters, owned cosmetics, snapshots, league week and weekly payouts. It is NOT authoritative
 * for `identity.profiles`, `identity.identities`, `identity.email_credentials` or
 * `identity.sessions`: those are entity tables written by the API's own statements, and the
 * graph carries only their derived copies (design 5.4 - profiles is canonical). Rewriting them
 * from the graph would clobber the canonical row, so they are deliberately outside the persist
 * set.
 *
 * LOCK ORDER (design 3.7 / spec 01 §3, mirrored from p02-schema-design.md:163): the business
 * aggregate row first (`match.matches` / `tournament.rooms`), then `core.actor_occupancy` and
 * `economy.wallets` with actor ids sorted ascending and taken in that order, then dependent rows
 * (ledger/outcome/outbox). `wallets.lock(actors, options)` is the only member that takes row
 * locks and it enforces exactly that order; the aggregate-then-actors-then-dependent chain for a
 * specific command is the caller's obligation because only the caller knows the target.
 *
 * NEVER MINT, NEVER RE-GRANT. No 150-Coin opening balance, no generated friend code, no
 * regenerated store binding, no fabricated timestamp: a missing actor is `ACCOUNT_REQUIRED`, and
 * every written timestamp comes from `context.clock` (the injected clock) or from the caller's
 * own object.
 */
'use strict';
const { ContextError } = require('../context');
const { currentPgScope } = require('./pool');
const { ROLE_GRANT_SCHEMAS } = require('./guards');
const { lockTransactionIdentity } = require('./locks');
const { Authority } = require('../../../src/authority.js');
const { COMMANDS, PARTY_COMMANDS, SOCIAL_OPERATIONS, V35_COMMANDS } = require('../scopes');

/* Bounded reads. Every hot-path read passes an explicit limit (contract hard requirement 5). The
 * caps sit far above the production shape (a room holds at most 10 players, a match 2) so a
 * pathological table can never be loaded into memory unbounded. */
const CAP = Object.freeze({
 actors: 20000, matches: 5000, rooms: 2000, children: 20000,
 recentLedger: 2000, snapshots: 5000, weeklyPaid: 20000, receipts: 5000, outcomes: 20000,
 /* A per-actor WALLET OPERATION set (`economy.wallet_operations`) is bounded by the number of
  * idempotent conversions an actor performed - it is not global, and it is the ONLY durable copy of
  * an operation fingerprint/result, so under-reading it silently disables conversion deduplication.
  * The bound sits far above the production shape; overflow fails the load closed. */
 operationKeys: 20000,
});

/* ------------------------------------------------------------------ scope */

/* The shared ContextError takes ONE argument - the bare code is its message, exactly like every
 * other error in this vocabulary - so diagnostics travel in `.detail` (the PgGuardError
 * convention) instead of being appended to the message. */
function ctxError(code, detail) {
 const error = new ContextError(code);
 if (detail !== undefined) error.detail = detail;
 return error;
}

function scopeOf(context) {
 const scope = context.client ? currentPgScope(context.client) : null;
 if (!scope) throw new ContextError('TRANSACTION_REQUIRED');
 return scope;
}
function sql(context) { return scopeOf(context).tx.query; }
function clockOf(context) {
 const clock = context.clock || (context.scope && context.scope.tx && context.scope.tx.clock);
 if (typeof clock !== 'function') throw new ContextError('CLOCK_REQUIRED');
 return clock();
}
function roleOf(context) {
 if (typeof context.role === 'string') return context.role;
 const option = context.options && typeof context.options.role === 'string' ? context.options.role : null;
 return option;
}
/* Role capability = the schema USAGE the checksummed grants actually ship (0020-0023 + 0037), read
 * from the same table the pool guard verifies. A context that names no role (a detached repository
 * set, or a test harness driving one client directly) is treated as fully capable; a guarded pool
 * always supplies its role. */
function capabilities(context) {
 const role = roleOf(context);
 if (!role) return null;
 const schemas = ROLE_GRANT_SCHEMAS[role];
 return schemas ? new Set(schemas) : null;
}
const SCHEMA_OF_SQL = /\b(?:FROM|JOIN)\s+([a-z_]+)\./g;
function sqlSchemas(text) {
 const out = new Set();
 let match;
 SCHEMA_OF_SQL.lastIndex = 0;
 while ((match = SCHEMA_OF_SQL.exec(text)) !== null) out.add(match[1]);
 return out;
}
const TABLE_OF_SQL = /\bFROM\s+([a-z_]+\.[a-z_]+)/i;
function primaryTable(text) {
 const match = TABLE_OF_SQL.exec(text);
 return match ? match[1] : null;
}
/* The tables whose ROWS are identity-bound: a create must never replace an existing aggregate and an
 * update must go through the intended path. `match.matches`/`match.participants` (a match id and its
 * seats) and `monetization.receipts` (a store transaction id) are exactly that set. */
const IMMUTABLE_TABLES = Object.freeze(new Set([
 'match.matches', 'match.participants', 'monetization.receipts',
]));
/* The aggregate tables whose reads are GLOBAL histories that NO rule decision consults: the global
 * journal is display-only, and `monetization.receipts` is now read through targeted identity/actor
 * statements for every grant, refund and ownership decision. A read that overflows one of these
 * cannot answer "which row is absent" for the delete pass, so it suppresses deletion for that table
 * alone. EVERY OTHER bounded read is a decision input (accounts, wallets, ratings, season, match
 * history, per-match commands, snapshots, payouts), and an overflow there makes the aggregate
 * unwritable/undecidable rather than silently partial - `state.read()` reports it and the command
 * boundaries fail closed with `STATE_TRUNCATED`. */
const HISTORY_TABLES = Object.freeze(new Set([
 'economy.ledger', 'monetization.receipts',
]));
/* A bounded global-history read suppresses the delete pass for its table; the rest of the diff
 * (upserts of the locked/live entities) stays exact. */
function persistFlags(graph) {
 const skipDelete = new Set(graph.historyTables || []);
 return { truncated: graph.truncated === true, unreadable: graph.unreadable, skipDelete };
}
/* The aggregate lives at most once per transaction, cached on the pool's own scope object, so it
 * dies with the transaction exactly like the legacy `context.graph` cache did. */
function invalidate(context) {
 const scope = context.client ? currentPgScope(context.client) : null;
 if (scope) { scope.aggregate = null; scope.aggregateState = null; }
}

/* The actors this transaction holds FOR UPDATE locks on, recorded on the scope by `wallets.lock`.
 * The maintenance before-image uses it to decide whose normalization may be persisted (see
 * `composeBaseline`). A scope that never locked anything records nobody, so an unlocked whole-graph
 * write persists nothing but a genuine caller delta. */
function recordLocked(context, actors) {
 const scope = context.client ? currentPgScope(context.client) : null;
 if (!scope) return;
 if (!scope.lockedIds) scope.lockedIds = new Set();
 for (const actor of actors) scope.lockedIds.add(String(actor));
}
function isActorLocked(context, actor) {
 const scope = context.client ? currentPgScope(context.client) : null;
 return !!(scope && scope.lockedIds && scope.lockedIds.has(String(actor)));
}

/* ------------------------------------------------------------ value codecs */

function toMs(value) {
 if (value === null || value === undefined) return null;
 if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
 /* A `::bigint` epoch-ms projection comes back from the driver as a decimal STRING, not a Date. */
 if (typeof value === 'number') return Number.isFinite(value) ? value : null;
 const text = String(value);
 if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
 const ms = Date.parse(text);
 return Number.isFinite(ms) ? ms : null;
}
function msColumn(expression, alias) { return `(extract(epoch from ${expression}) * 1000)::bigint AS ${alias}`; }
function msOrNullColumn(value, what) {
 if (value === null || value === undefined) return null;
 const ms = toMs(value);
 if (ms === null) throw ctxError('INVALID_TIMESTAMP', `${what}: ${String(value)}`);
 return ms;
}
/* Epoch ms -> timestamptz text. A missing timestamp is null, never now(). */
function iso(value, what) {
 if (value === null || value === undefined) return null;
 if (!Number.isFinite(value)) throw ctxError('INVALID_TIMESTAMP', `${what}: ${String(value)}`);
 return new Date(value).toISOString();
}
function integer(value, what) {
 const n = Number(value);
 if (!Number.isSafeInteger(n) || n < 0) throw ctxError('INVALID_INTEGER', `${what}: ${String(value)}`);
 return n;
}
function numOrNull(value) { return value === null || value === undefined ? null : Number(value); }
function jsonText(value, what) {
 if (value === undefined) throw ctxError('JSON_VALUE_MISSING', what);
 return value === null ? null : JSON.stringify(value);
}
/* JSON/JSONB columns arrive from the driver ALREADY decoded (pg parses OID 114/3802), so a JSON
 * string scalar comes back as a plain JS string, an object as an object. Re-parsing here would
 * corrupt any legitimate string that is not valid JSON text (a region, a room name). The TEXT
 * columns that hold canonical JSON text (operation keys, wallet-operation fingerprints) are
 * handled by keyIn/family-specific decoding instead, never by this helper. */
function decodeJson(value, fallback) {
 return value === null || value === undefined ? fallback : value;
}
/* The outcome/operation columns are declared `TEXT ... CHECK (x IS JSON)` - a json/jsonb column
 * would have come back decoded, but TEXT does not, so the value arrives as the serialized document
 * and `decodeJson` would pass the raw string through. A parse failure is surfaced with the offending
 * column, never as a silent fallback: a row that is not valid JSON means the schema gate was bypassed
 * and the caller must not be handed a half object. */
function decodeJsonText(value, fallback, what) {
 if (value === null || value === undefined) return fallback;
 if (typeof value !== 'string') return value;
 try { return JSON.parse(value); } catch { throw ctxError('INVALID_JSON', `${what}: ${String(value).slice(0, 48)}`); }
}

/* SESSION TOKEN HASHES. SOURCE TRUTH: the legacy adapter stores sha256(bearer) as base64url
 * (43 chars, server/identity-provider.js:12); the V5 column is 64 lowercase hex with a CHECK
 * (0005). The two are the same digest in different encodings, so the mapping is explicit at this
 * boundary - a re-encode, never a rehash and never a copied byte string. These two functions are
 * the only places that touch the encoding. */
function hashIn(tokenHash) {
 if (typeof tokenHash !== 'string') throw new ContextError('INVALID_SESSION_HASH');
 if (/^[0-9a-f]{64}$/.test(tokenHash)) return tokenHash;
 if (!/^[A-Za-z0-9_-]{43}$/.test(tokenHash)) throw new ContextError('INVALID_SESSION_HASH');
 const digest = Buffer.from(tokenHash, 'base64url');
 if (digest.length !== 32) throw new ContextError('INVALID_SESSION_HASH');
 return digest.toString('hex');
}
function hashOut(tokenHash) {
 if (typeof tokenHash !== 'string') return tokenHash;
 return /^[0-9a-f]{64}$/.test(tokenHash) ? Buffer.from(tokenHash, 'hex').toString('base64url') : tokenHash;
}

/* OPERATION KEYS. 0034 stores the economy and party logical key as the CANONICAL JSON string text
 * of that key, exactly once; the social/monetization/move families keep their verbatim ASCII
 * grammar. `keyOut` encodes for storage, `keyIn` decodes for the caller. */
function keyOut(logicalKey, family) {
 if (typeof logicalKey !== 'string' || logicalKey.length === 0 || logicalKey.length > 160) throw new ContextError('INVALID_OPERATION');
 return family === 'economy' || family === 'tournament' ? JSON.stringify(logicalKey) : logicalKey;
}
function keyIn(storedKey, family) {
 if (typeof storedKey !== 'string') return storedKey;
 if (family !== 'economy' && family !== 'tournament') return storedKey;
 try { return JSON.parse(storedKey); } catch { throw ctxError('INVALID_OPERATION_KEY', String(storedKey).slice(0, 32)); }
}

/* ---------------------------------------------------------------- SQL builders */

function insertSql(table, columns, conflict, updateColumns) {
 const names = columns.map((c) => `"${c}"`).join(', ');
 const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
 const target = conflict.map((c) => `"${c}"`).join(', ');
 const clause = updateColumns.length === 0 ? 'DO NOTHING' : 'DO UPDATE SET ' + updateColumns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
 return `INSERT INTO ${table} (${names}) VALUES (${placeholders}) ON CONFLICT (${target}) ${clause}`;
}
function deleteSql(table, pk) { return `DELETE FROM ${table} WHERE ${pk.map((c, i) => `"${c}" = $${i + 1}`).join(' AND ')}`; }
/* A genuine INSERT: no ON CONFLICT, so a duplicate key raises 23505 and the whole transaction
 * aborts. Used for an IMMUTABLE identity (a new match / receipt) where a silent replace would
 * destroy an existing aggregate while its outcome stayed committed. */
function createSql(table, columns) {
 return `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
}
/* The intended UPDATE path for an EXISTING row (same key), by primary key. */
function updateSql(table, columns, pk) {
 const sets = columns.map((c, i) => `"${c}" = $${i + 1}`);
 const where = pk.map((c, i) => `"${c}" = $${columns.length + i + 1}`);
 return `UPDATE ${table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`;
}
/* Which runtime role may WRITE each table, read off the grants the checksummed chain actually
 * ships (0020 api, 0021 core, 0022 worker, 0037 grant gaps). The ownership register is why these
 * are not all-schema grants: the API owns actor/profile/social/rate state, Core owns the economic
 * and competitive aggregates, the worker owns the job/outbox state, and neither may write the
 * other's. `identity.eligibility` is the one table written from both sides with disjoint COLUMN
 * grants, so it is modelled separately (descriptor.roleSplit). */
const WRITE_ROLES = Object.freeze({
 'identity.actors': Object.freeze(['api_runtime']),
 'identity.profiles': Object.freeze(['api_runtime']),
 'identity.eligibility': Object.freeze(['api_runtime', 'core_runtime']),
 'social.friendships': Object.freeze(['api_runtime']),
 'social.friend_requests': Object.freeze(['api_runtime']),
 'social.blocks': Object.freeze(['api_runtime']),
 'ops.outbox': Object.freeze(['worker_runtime']),
 'ops.rate_buckets': Object.freeze(['api_runtime', 'worker_runtime']),
});
const DEFAULT_WRITE_ROLES = Object.freeze({
 economy: Object.freeze(['core_runtime']),
 core: Object.freeze(['core_runtime']),
 match: Object.freeze(['core_runtime']),
 tournament: Object.freeze(['core_runtime']),
 monetization: Object.freeze(['core_runtime']),
 cosmetics: Object.freeze(['core_runtime']),
 season: Object.freeze(['core_runtime']),
});
function mayWrite(role, table) {
 if (!role) return true;
 const explicit = WRITE_ROLES[table];
 if (explicit) return explicit.includes(role);
 const schema = table.slice(0, table.indexOf('.'));
 const roles = DEFAULT_WRITE_ROLES[schema];
 return roles ? roles.includes(role) : false;
}

/* Room statuses a non-terminal room can be in; `tournaments.activeRooms` filters on exactly this
 * set, mirroring the legacy `json_extract(json,'$.status') IN (...)` predicate. */
const ACTIVE_ROOM_STATUS = Object.freeze(new Set(['LOBBY', 'RUNNING', 'PAUSED', 'REVIEW']));
function changed(before, after) { return JSON.stringify(before) !== JSON.stringify(after); }
function byKey(rows, keyOf) {
 const out = new Map();
 for (const row of rows) out.set(keyOf(row), row);
 return out;
}

/* ------------------------------------------------------------------ members */

function pgRepositoriesFor(context) {
 if (!context || typeof context !== 'object') throw new ContextError('CONTEXT_REQUIRED');

 const accounts = {
  async has(actor) {
   const r = await sql(context)('SELECT 1 AS ok FROM identity.actors WHERE actor_id = $1', [actor]);
   return r.rows.length > 0;
  },
 };

 const profiles = {
  /* identity.profiles is canonical for tag/username/display name (design 5.4). Field names are
   * the ones server/community-store.js consumes; `created`/`username_changed` stay epoch-ms. */
  async for(actor) {
   const r = await sql(context)(
    'SELECT actor_id, tag, username, display_name, avatar, stats_visibility, presence_visibility,'
    + ` ${msColumn('created_at', 'created')}, ${msColumn('username_changed', 'username_changed')}, version`
    + ' FROM identity.profiles WHERE actor_id = $1', [actor]);
   const row = r.rows[0];
   if (!row) return null;
   return {
    actor: row.actor_id, tag: row.tag, username: row.username, display_name: row.display_name,
    avatar: row.avatar, stats_visibility: row.stats_visibility, presence_visibility: row.presence_visibility,
    created: msOrNullColumn(row.created, 'profiles.created_at'),
    username_changed: msOrNullColumn(row.username_changed, 'profiles.username_changed') || 0,
    version: Number(row.version),
   };
  },
 };

 const sessions = {
  async live(tokenHash, now) {
   const r = await sql(context)(
    `SELECT token_hash, actor_id, csrf, ${msColumn('created_at', 'created')}, ${msColumn('expires_at', 'expires')}, ${msColumn('auth_at', 'auth_at')}`
    + ' FROM identity.sessions WHERE token_hash = $1 AND expires_at > $2',
    [hashIn(tokenHash), iso(now === undefined ? clockOf(context) : now, 'sessions.live')]);
   const row = r.rows[0];
   if (!row) return null;
   return {
    token: hashOut(row.token_hash), actor: row.actor_id, csrf: row.csrf,
    created: msOrNullColumn(row.created, 'sessions.created_at'),
    expires: msOrNullColumn(row.expires, 'sessions.expires_at'),
    auth_at: msOrNullColumn(row.auth_at, 'sessions.auth_at'),
   };
  },
  /* session_presence is deliberately NOT migrated to PostgreSQL (P02 design 2.x, P06 R6):
   * presence is ephemeral coordination owned by the managed Redis tier. An empty result here
   * would silently render every actor offline, and a fabricated row would be a second source of
   * truth for a disposable fact, so the member refuses explicitly; that dependency is a reported
   * finding (see the design record), not an invented table. */
  async presence() { throw new ContextError('PRESENCE_OWNED_BY_P06'); },
  async revoke(actor, tokenHash) {
   const r = await sql(context)('DELETE FROM identity.sessions WHERE actor_id = $1 AND token_hash = $2', [actor, hashIn(tokenHash)]);
   return r.rowCount;
  },
  /* Single-use bearer rotation deletes by token: an anonymous session has a NULL actor. */
  async rotate(tokenHash) {
   const r = await sql(context)('DELETE FROM identity.sessions WHERE token_hash = $1', [hashIn(tokenHash)]);
   return r.rowCount;
  },
  async revokeOthers(actor, tokenHash) {
   const r = await sql(context)('DELETE FROM identity.sessions WHERE actor_id = $1 AND token_hash <> $2 RETURNING token_hash', [actor, hashIn(tokenHash)]);
   return r.rows.map((row) => ({ token: hashOut(row.token_hash) }));
  },
  async revokeAll(actor) {
   const r = await sql(context)('DELETE FROM identity.sessions WHERE actor_id = $1', [actor]);
   return r.rowCount;
  },
  async clearPresence() { throw new ContextError('PRESENCE_OWNED_BY_P06'); },
  async clearOtherPresence() { throw new ContextError('PRESENCE_OWNED_BY_P06'); },
  async clearActorPresence() { throw new ContextError('PRESENCE_OWNED_BY_P06'); },
 };

 const saves = {
  /* 0033: payload_text is the ONLY authoritative document (the JSONB twin was dropped). The
   * legacy field name `payload` is kept so server/community-store.js parses unchanged. */
  async for(actor) {
   const r = await sql(context)(`SELECT revision, payload_text, ${msColumn('updated_at', 'updated')} FROM profile.profile_saves WHERE actor_id = $1`, [actor]);
   const row = r.rows[0];
   if (!row) return null;
   return { revision: Number(row.revision), updated: msOrNullColumn(row.updated, 'profile_saves.updated_at'), payload: row.payload_text };
  },
  async revisionOf(actor) {
   const r = await sql(context)('SELECT revision FROM profile.profile_saves WHERE actor_id = $1', [actor]);
   return r.rows.length ? Number(r.rows[0].revision) : 0;
  },
 };

 const wallets = {
  /* Same field names the SQLite adapter returns, backed by economy.wallets. A missing row is
   * ACCOUNT_REQUIRED, never a created default. */
  async for(actor) {
   const r = await sql(context)(
    'SELECT coins, crowns, reserved_coins, reserved_crowns, purchased_coins, purchased_crowns, purchase_influenced FROM economy.wallets WHERE actor_id = $1', [actor]);
   const row = r.rows[0];
   if (!row) throw new ContextError('ACCOUNT_REQUIRED');
   return {
    actor, coins: Number(row.coins), crowns: Number(row.crowns),
    purchasedCoins: Number(row.purchased_coins), purchasedCrowns: Number(row.purchased_crowns),
    reservedCoins: Number(row.reserved_coins), reservedCrowns: Number(row.reserved_crowns),
    purchaseInfluenced: row.purchase_influenced === true,
   };
  },
  /* The ONLY member that takes row locks, and it enforces the documented global order itself:
   * optional business aggregate row first, then core.actor_occupancy, then economy.wallets, with
   * actor ids sorted ascending. `actors` is sorted here, never trusted from the caller. */
  async lock(actors, options = {}) {
   const q = sql(context);
   const sorted = [...new Set(actors.map(String))].sort();
   if (sorted.length === 0) return { actors: [], occupancy: 0, wallets: 0 };
   if (options.aggregate) {
    const tournament = options.aggregate.kind === 'tournament';
    await q(`SELECT 1 FROM ${tournament ? 'tournament.rooms' : 'match.matches'} WHERE ${tournament ? 'room_id' : 'match_id'} = $1 FOR UPDATE`, [options.aggregate.id]);
   }
   const occupancy = await q('SELECT actor_id FROM core.actor_occupancy WHERE actor_id = ANY($1::text[]) ORDER BY actor_id FOR UPDATE', [sorted]);
   const locked = await q('SELECT actor_id FROM economy.wallets WHERE actor_id = ANY($1::text[]) ORDER BY actor_id FOR UPDATE', [sorted]);
   recordLocked(context, sorted);
   return { actors: sorted, occupancy: occupancy.rows.length, wallets: locked.rows.length };
  },
 };

 const ledger = {
  /* economy.ledger is append-only and the source journal is ordered. `limit === null` reads every
   * entry for one actor (an explicit caller request); otherwise it returns the LAST `limit`
   * entries in ascending order - exactly the SQLite `entries.slice(-limit)` semantics. */
  async recent(actor, limit = 40) {
   const bounded = limit === null ? null : integer(limit, 'ledger.recent.limit');
   const r = await sql(context)(
    `SELECT entry_id, actor_id, currency, amount, reason, source, ${msColumn('at', 'at')} FROM economy.ledger`
    + ' WHERE actor_id = $1 ORDER BY at DESC, entry_id DESC' + (bounded === null ? '' : ' LIMIT $2'),
    bounded === null ? [actor] : [actor, bounded]);
   return r.rows.reverse().map((row) => ({
    id: row.entry_id, actor: row.actor_id, currency: row.currency, amount: Number(row.amount),
    reason: row.reason, source: row.source, at: msOrNullColumn(row.at, 'ledger.at'),
   }));
  },
  async burned() {
   const r = await sql(context)('SELECT coins, crowns FROM economy.system_burns WHERE id = 1');
   const row = r.rows[0];
   return row ? { coins: Number(row.coins), crowns: Number(row.crowns) } : { coins: 0, crowns: 0 };
  },
 };

 /* `matches.*` and `tournaments.room/rooms/activeRooms/codeExists` read the SAME hydrated
  * aggregate the SQLite adapter used (`hydrate().matches`), so the returned objects are the exact
  * raw/view shapes the callers already handle. */
 const matches = {
  async for(id) { return (await hydrate(context)).matches.get(String(id)) || null; },
  async view(id) {
   const graph = await hydrate(context);
   if (!graph.matches.has(String(id))) throw new ContextError('UNKNOWN_MATCH');
   return graph.authority.view(String(id));
  },
  async forActor(actor, statuses = null) {
   const graph = await hydrate(context);
   const out = [];
   for (const match of graph.matches.values()) {
    if (!match.players.includes(actor)) continue;
    if (statuses && !statuses.includes(match.status)) continue;
    out.push(match);
   }
   return out;
  },
 };

 const tournaments = {
  /* `id` matches the room id OR the join code, exactly like the legacy `WHERE id=? OR code=?`. */
  async room(id) {
   const graph = await hydrate(context);
   return graph.rooms.get(String(id)) || findRoomByCode(graph.rooms.values(), id);
  },
  async rooms() { return [...(await hydrate(context)).rooms.values()]; },
  async activeRooms() {
   const graph = await hydrate(context);
   return [...graph.rooms.values()].filter((room) => ACTIVE_ROOM_STATUS.has(room.status));
  },
  async codeExists(code) { return findRoomByCode((await hydrate(context)).rooms.values(), code) !== null; },
  /* Persist the ENTITY rows: tournament.rooms plus its room_players / escrow_contributions /
   * fixtures. The dependent sets are bounded (at most 10 players, a bounded fixture list), so they
   * are replaced wholesale; 0028's UNIQUE (room_id, ordinal) makes positional updates unsafe, so
   * delete-then-insert is the boring choice. `opts.fixtures === false` skips the fixture set for a
   * caller that only touched room/player state. */
  async save(room, opts = {}) {
   if (!room || typeof room !== 'object' || typeof room.id !== 'string') throw new ContextError('INVALID_ROOM');
   await writeRoom(sql(context), room, opts);
   invalidate(context);
   return room.id;
  },
 };

 /* TARGETED, authoritative reads for the protected store/monetization decision inputs. The whole
 * aggregate hydrates only the first `CAP.receipts` receipts GLOBALLY, so an absence in
 * `graph.receipts` cannot be read as "this receipt does not exist" - the receipt-identity and
 * receipt-set facts a grant/refund/ownership decision depends on must come from these actor- or
 * identity-scoped statements instead. Both are complete-or-fail: a saturated read throws
 * STATE_TRUNCATED rather than returning a partial list a caller could mistake for the whole truth. */
const purchases = {
  async receipt(store, transactionId) {
   const r = await sql(context)(
    `SELECT store, transaction_id, actor_id, product_id, crowns, refunded, ${msColumn('purchased_at', 'at')} FROM monetization.receipts WHERE store = $1 AND transaction_id = $2`,
    [store, transactionId]);
   const row = r.rows[0];
   if (!row) return null;
   return {
    id: `${row.store}:${row.transaction_id}`, store: row.store, transactionId: row.transaction_id,
    actor: row.actor_id, productId: row.product_id, crowns: Number(row.crowns),
    refunded: row.refunded === true, at: msOrNullColumn(row.at, 'receipts.purchased_at'),
   };
  },
  /* Every receipt for ONE actor - the decision input for a `once` product (already-owned /
   * previously-refunded) and for the `owned()` product projection. The actor-scoped set is tiny in
   * production, and the global receipt cap cannot be used to answer it: a saturated actor read
   * fails closed instead of silently dropping an owned-once or refunded product. */
  async forActor(actor) {
   const r = await sql(context)(
    `SELECT store, transaction_id, actor_id, product_id, crowns, refunded, ${msColumn('purchased_at', 'at')} FROM monetization.receipts WHERE actor_id = $1 ORDER BY store, transaction_id LIMIT $2`,
    [actor, CAP.receipts + 1]);
   if (r.rows.length > CAP.receipts) throw ctxError('STATE_TRUNCATED', `receipts for ${actor} reached the bounded-read cap`);
   return r.rows.map((row) => ({
    id: `${row.store}:${row.transaction_id}`, store: row.store, transactionId: row.transaction_id,
    actor: row.actor_id, productId: row.product_id, crowns: Number(row.crowns),
    refunded: row.refunded === true, at: msOrNullColumn(row.at, 'receipts.purchased_at'),
   }));
  },
  /* Permanent refund tombstone (0015); no runtime role receives DELETE here. */
  async revoked(store, transactionId) {
   const r = await sql(context)('SELECT 1 AS ok FROM monetization.store_revocations WHERE store = $1 AND transaction_id = $2', [store, transactionId]);
   return r.rows.length > 0;
  },
 };

 /* Durable operation outcomes: ONE family table per legacy scope, so each keeps its existing
  * key/column layout (design 5.3) instead of an invented shared convention. A scope is recognized
  * by its `find` statement - the stable identity of a family in packages/db/scopes.js - and an
  * unknown scope is refused rather than guessed. */
 const outcomes = {
  async find(scope, ...keys) {
   const family = familyOf(scope);
   const { actor, key } = family.readShape(keys);
   const r = await sql(context)(`SELECT ${family.findColumns} FROM ${family.table} WHERE actor_id = $1 AND "key" = $2`, [actor, keyOut(key, family.name)]);
   const row = r.rows[0];
   return row ? outcomeRow(family, row) : null;
  },
  async save(scope, ...values) {
   const family = familyOf(scope);
   const { actor, key, fingerprint, result } = family.writeShape(values);
   await sql(context)(insertSql(family.table, ['actor_id', 'key', 'fingerprint', family.resultColumn, 'committed_at'], ['actor_id', 'key'], []),
    [actor, keyOut(key, family.name), fingerprint, result, iso(clockOf(context), 'outcomes.committed_at')]);
   return values;
  },
  /* STRICT claim of an operation key: `true` only when this statement actually inserted the row.
   * A caller that already holds the logical operation mutex uses this instead of `save` so a
   * conflict caused by a foreign writer (one that bypassed the mutex) ABORTS its transaction rather
   * than committing a second business effect behind one outcome row. */
  async claim(scope, ...values) {
   const family = familyOf(scope);
   const { actor, key, fingerprint, result } = family.writeShape(values);
   const r = await sql(context)(`INSERT INTO ${family.table} (actor_id, "key", fingerprint, ${family.resultColumn}, committed_at)`
    + ' VALUES ($1, $2, $3, $4, $5) ON CONFLICT (actor_id, "key") DO NOTHING',
    [actor, keyOut(key, family.name), fingerprint, result, iso(clockOf(context), 'outcomes.committed_at')]);
   return r.rowCount === 1;
  },
 };

 /* Durable worker-visible job queue. The queue NAME stays `v4_outbox` for caller compatibility
  * (that is what server/production/mail-outbox.js and the workers use); the table is ops.outbox.
  * The selector and expiry predicate are the exact legacy claim statements
  * (server/production/mail-outbox.js:58-69), so the worker and this repository cannot drift. */
 const OUTBOX_DUE = 'SELECT outbox_id, payload, kind, state, attempts, '
  + `${msColumn('created_at', 'created')}, ${msColumn('expires_at', 'expires')}, ${msColumn('next_at', 'next_at')}, ${msColumn('lease_until', 'lease_until')}`
  + ' FROM ops.outbox WHERE expires_at > $1 AND attempts < 3'
  + " AND ((state = 'queued' AND next_at <= $1) OR (state = 'sending' AND lease_until <= $1))"
  + ' ORDER BY created_at, outbox_id LIMIT $2';
 const jobs = {
  queues() { return ['v4_outbox']; },
  async due(table, now, limit = 1) {
   const bounded = integer(limit === undefined || limit === null ? 1 : limit, 'jobs.due.limit');
   if (bounded < 1) throw new ContextError('INVALID_LIMIT');
   if (table !== 'v4_outbox') throw new ContextError('UNKNOWN_JOB_QUEUE');
   const r = await sql(context)(OUTBOX_DUE, [iso(now, 'jobs.due.now'), bounded]);
   return r.rows.map((row) => ({
    id: row.outbox_id, payload: row.payload, kind: row.kind, state: row.state, attempts: Number(row.attempts),
    created: msOrNullColumn(row.created, 'outbox.created_at'), expires: msOrNullColumn(row.expires, 'outbox.expires_at'),
    next_at: msOrNullColumn(row.next_at, 'outbox.next_at'), lease_until: msOrNullColumn(row.lease_until, 'outbox.lease_until'),
   }));
  },
  /* 0018's ops.outbox_sealed_payload_ck makes "payload is NULL once terminal" structural, so the
   * expire statement must null it in the same UPDATE - exactly what the legacy statement did. */
  async expireDue(table, now) {
   if (table !== 'v4_outbox') throw new ContextError('UNKNOWN_JOB_QUEUE');
   const r = await sql(context)(
    "UPDATE ops.outbox SET state = 'expired', payload = NULL WHERE expires_at <= $1 AND state IN ('queued','sending')",
    [iso(now, 'jobs.expireDue.now')]);
   return r.rowCount;
  },
 };

 const community = {
  /* Durable rate/limit counter: one row per (bucket, subject, window) with an atomic increment
   * returning the new hits; callers map hits>limit to RATE_LIMITED. The window lives in the bucket
   * id exactly as the legacy rate() built it, and the row keeps the legacy non-expiring shape
   * (expires_at NULL) - P06 owns moving rate budgets to Redis. */
  async count(id) {
   const r = await sql(context)(
    'INSERT INTO ops.rate_buckets (bucket_id, hits, expires_at) VALUES ($1, 1, NULL)'
    + ' ON CONFLICT (bucket_id) DO UPDATE SET hits = ops.rate_buckets.hits + 1 RETURNING hits', [id]);
   return Number(r.rows[0].hits);
  },
 };

 /* Raw aggregate read/write - the legacy room seam. `read` performs no Authority construction, so
  * nothing is normalized back into the caller's copy; `write` persists the entity-wise difference
  * and adopts the caller's value as the new in-scope aggregate. */
 const state = {
  async read() { return (await hydrate(context)).authority.export(); },
  /* Whether the in-scope aggregate read was COMPLETE for decision purposes: no bounded
  * decision-input read exceeded its cap. A caller that is about to authorize a whole-graph economic
  * write - `server/rooms.js` reads `state.read()`, mutates it, then calls `state.write` - must ask
  * this before treating an absent entity as absent truth. */
  async complete() { return (await hydrate(context)).complete; },
  async write(value) {
   if (!value || typeof value !== 'object') throw new ContextError('INVALID_STATE');
   const scope = scopeOf(context);
   const graph = scope.aggregate ? await hydrate(context) : null;
   if (graph) {
    if (graph.truncated === true) throw ctxError('STATE_TRUNCATED', 'a decision-input read was truncated; a whole-aggregate write could not prove which rows are absent');
    await graph.writeDocument(value, (id) => isActorLocked(context, id));
    scope.aggregateState = graph;
    scope.aggregate = Promise.resolve(graph);
    return value;
   }
   await persistAggregate(context, value, null, {});
   const next = graphFor(context, value, new Map());
   scope.aggregateState = next;
   scope.aggregate = Promise.resolve(next);
   return value;
  },
 };

 return Object.freeze({
  accounts, profiles, sessions, saves, wallets, ledger, matches, tournaments,
  purchases, outcomes, jobs, community, state,
  domain: () => hydrate(context),
  /* Persist the shared aggregate through the unit of work's connection. Only the entities that
   * changed since hydration (or the last commit) are written, entity-wise - there is no whole-graph
   * row and no `state` table. Timestamps come from context.clock or the caller's object; nothing is
   * minted. Domain normalization is persisted only for the actors this transaction LOCKED. */
  async commitDomain() { return (await hydrate(context)).commit((id) => isActorLocked(context, id)); },
 });
}

/* ------------------------------------------------------------- outcome families */

 const FAMILIES = Object.freeze({
  [COMMANDS.find]: Object.freeze({
   name: 'economy', table: 'economy.command_outcomes', resultColumn: 'response',
   findColumns: 'actor_id, "key", fingerprint, response',
   /* economy: save(scope, id, actor, fingerprint, response), id = JSON.stringify([actor,key]). */
   readShape: (keys) => splitOperationId(keys[0]),
   writeShape: (values) => ({ ...splitOperationId(values[0]), fingerprint: values[2], result: values[3] }),
  }),
  [PARTY_COMMANDS.find]: Object.freeze({
   name: 'tournament', table: 'tournament.command_outcomes', resultColumn: 'response',
   findColumns: 'actor_id, "key", fingerprint, response',
   /* party: save(scope, id, fingerprint, response). */
   readShape: (keys) => splitOperationId(keys[0]),
   writeShape: (values) => ({ ...splitOperationId(values[0]), fingerprint: values[1], result: values[2] }),
  }),
  [SOCIAL_OPERATIONS.find]: Object.freeze({
   name: 'social', table: 'social.command_outcomes', resultColumn: 'result',
   findColumns: 'actor_id, "key", fingerprint, result',
   /* social: save(scope, id, fingerprint, result) with id = actor + ':' + key. */
   readShape: (keys) => splitCombinedId(keys[0]),
   writeShape: (values) => ({ ...splitCombinedId(values[0]), fingerprint: values[1], result: values[2] }),
  }),
  [V35_COMMANDS.find]: Object.freeze({
   name: 'monetization', table: 'monetization.command_outcomes', resultColumn: 'response',
   findColumns: 'actor_id, "key", fingerprint, response',
   readShape: (keys) => ({ actor: keys[0], key: keys[1] }),
   writeShape: (values) => ({ actor: values[0], key: values[1], fingerprint: values[2], result: values[3] }),
  }),
 });
 function familyOf(scope) {
  const family = scope && typeof scope === 'object' ? FAMILIES[scope.find] : null;
  if (!family) throw new ContextError('UNKNOWN_OUTCOME_SCOPE');
  return family;
 }
 /* economy/tournament operation ids are JSON.stringify([actor,key]); social ids are
  * `actor + ':' + key` split on the FIRST colon, mirroring the convention the P03 importer
  * documents and that 0030's legacy-domain index is built over. */
 function splitOperationId(id) {
  let parsed;
  try { parsed = JSON.parse(String(id)); } catch { throw new ContextError('INVALID_OPERATION'); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw new ContextError('INVALID_OPERATION');
  return { actor: parsed[0], key: parsed[1] };
 }
 function splitCombinedId(id) {
  const text = String(id);
  const cut = text.indexOf(':');
  if (cut <= 0) throw new ContextError('INVALID_OPERATION');
  return { actor: text.slice(0, cut), key: text.slice(cut + 1) };
 }
function outcomeRow(family, row) {
  const out = { actor: row.actor_id, key: keyIn(row.key, family.name), fingerprint: row.fingerprint };
  /* The four outcome tables store the response as JSON TEXT (R2), so it must be parsed here exactly
   * as `store.save()` returns it to `executeCommand` (an object, never a serialized string). */
  out[family.resultColumn] = decodeJsonText(row[family.resultColumn], null, `${family.table}.${family.resultColumn}`);
  return out;
}

 /* ------------------------------------------------------- aggregate hydrator */



 async function hydrate(context) {
  const scope = scopeOf(context);
  if (scope.aggregate) return scope.aggregate;
  scope.aggregate = buildAggregate(context, scope);
  try { return await scope.aggregate; } catch (error) { scope.aggregate = null; throw error; }
 }
 function findRoomByCode(rooms, code) {
  for (const room of rooms) if (room.code === code) return room;
  return null;
 }
 /* The domain model is constructed with the SAME injected options the SQLite reference adapter
  * passes (`{...(options || context.options), state}`, packages/db/repositories.js hydrate): `now`
  * is the unit of work's sampled clock and `random`/`verifyPurchase` come from the caller's options.
  * Dropping them would journal with the host clock, pair queue opponents with crypto.randomInt
  * instead of the seeded random, and make `purchase`/`refund` throw STORE_UNAVAILABLE. */
 function authorityFor(context, state) {
  const options = (context && context.options) || {};
  return new Authority({ ...options, now: () => clockOf(context), state });
 }
 /* A snapshot is ALWAYS taken in the exported form. `JSON.stringify(stateValue)` would turn a Map
  * member (a match's `commands`) into `{}`, and the "before" image of the diff would silently lose
  * its entries; `authority.export()` renders `commands` as an entry array, which both sides of the
  * diff can read. */
 function snapshotOf(authority) { return JSON.stringify(authority.export()); }
function graphFor(context, value, rooms) {
 const authority = authorityFor(context, value);
 return new DomainGraph(context, authority, snapshotOf(authority), value, rooms);
}

 class DomainGraph {
  constructor(context, authority, snapshot, stateValue, rooms, rawAccountsJson = null) {
   this.context = context;
   this.authority = authority;
   this.snapshot = snapshot;
   this.stateValue = stateValue;
   this.rooms = rooms;
   /* The RAW durable account projection captured BEFORE the domain model was constructed, so the
    * maintenance before-image can restore it for UNLOCKED actors (see `composeBaseline`). */
   this.rawAccountsJson = rawAccountsJson;
   /* The actors this transaction actually holds a row lock on; normalization is persisted for them
    * and hidden for everyone else. Empty for an unlocked read, which therefore writes nothing but a
    * genuine caller delta. */
   this.lockedIds = new Set();
   this.truncated = false;
   this.historyTables = [];
   this.unreadable = [];
   /* Default: a graph built from a caller-supplied value (state.write) is over a document the
    * caller owns, so it is complete by construction until the hydrator says otherwise. */
   this.complete = true;
  }
  get accounts() { return this.authority.accounts; }
  get matches() {
   const out = new Map();
   for (const [id, match] of this.authority.matches) out.set(String(id), match);
   return out;
  }
  get receipts() { return this.authority.receipts; }
  account(id, required = true) {
   const account = this.authority.accounts.get(id);
   if (!account) {
    if (required) throw new ContextError('ACCOUNT_REQUIRED');
    return null;
   }
   return account;
  }
  export() { return this.authority.export(); }
  /* Entity-wise persist of exactly what changed since the snapshot. `current` IS the exported
   * form, so it is also the representation the next diff's "before" image must carry.
   *
   * SCOPED NORMALIZATION. The baseline is composed from the normalized snapshot and the RAW durable
   * accounts: a LOCKED actor keeps its raw durable account (so `restore()`'s quarter archive, seeded
   * rows and clamps are persisted), and every other actor keeps its normalized account (so its
   * normalization is invisible). A maintenance transaction that locks no actor therefore writes
   * nothing but the delta its caller actually made. */
  async persistDocument(current, isLocked) {
   const normalizedJson = this.snapshot;
   const lockedIds = lockedAccountIds(current, isLocked);
   const baseline = normalizedJson === null ? null : composeBaseline(normalizedJson, this.rawAccountsJson, lockedIds);
   const stats = await persistAggregate(this.context, current, baseline === null ? null : jsonOf(baseline), persistFlags(this));
   this.stateValue = current;
   /* After a commit the durable rows equal `current`, so the next diff's baseline advances too. */
   if (normalizedJson !== null) this.snapshot = jsonOf(current);
   /* Normalization for the locked actors is now DURABLE, so it must not be re-persisted by a later
    * commit of the same transaction: their raw baseline becomes their committed account. */
   const raw = accountMap(this.rawAccountsJson ? JSON.parse(this.rawAccountsJson) : null);
   for (const [id, account] of current.accounts) if (lockedIds.has(id)) raw.set(id, account);
   this.rawAccountsJson = jsonOf([...raw]);
   return stats;
  }
  async commit(isLocked = () => false) {
   return this.persistDocument(this.authority.export(), isLocked);
  }
  /* Adopt a caller-supplied document (the legacy whole-aggregate seam, server/rooms.js). The
    * persisted diff uses the composed baseline, so normalization is written only for the actors this
    * transaction locked. */
  async writeDocument(value, isLocked = () => false) {
   await this.persistDocument(value, isLocked);
   this.stateValue = value;
   this.authority = authorityFor(this.context, value);
  }
 }

 const ACCOUNT_SQL = 'SELECT a.actor_id, a.region, a.wealth_public, a.created_at,'
  + ' e.verified, e.suspended, e.security_hold,'
  + ' p.tag, p.username, p.display_name, p.avatar, p.stats_visibility, p.presence_visibility, p.username_changed,'
  + ' r.rating, r.peak, r.casual_rating, r.games, r.casual_games, r.tier, r.reached_at, r.last_rated_at,'
  + ' w.coins, w.crowns, w.reserved_coins, w.reserved_crowns, w.purchased_coins, w.purchased_crowns,'
  + ' w.purchase_influenced, w.legacy_competition_restricted,'
  + ' o.kind AS occupancy_kind, o.ref_id AS occupancy_ref'
  + ' FROM identity.actors a'
  + ' LEFT JOIN identity.eligibility e ON e.actor_id = a.actor_id'
  + ' LEFT JOIN identity.profiles p ON p.actor_id = a.actor_id'
  + ' LEFT JOIN economy.ratings r ON r.actor_id = a.actor_id'
  + ' LEFT JOIN economy.wallets w ON w.actor_id = a.actor_id'
  + ' LEFT JOIN core.actor_occupancy o ON o.actor_id = a.actor_id'
  + ' ORDER BY a.actor_id LIMIT $1';
 /* Accounts WITHOUT the economy columns - for the API role, whose grants stop at identity. Every
 * other account field still hydrates (the API needs eligibility, profile, occupancy), so callers
 * using the graph for their own authority keep the fields they own. Occupancy lives in core, so
 * the join is added only when the role may read that schema. */
function accountSql({ economy, core }) {
 const columns = ['a.actor_id', 'a.region', 'a.wealth_public', 'a.created_at',
  'e.verified', 'e.suspended', 'e.security_hold'];
 const joins = ['FROM identity.actors a',
  'LEFT JOIN identity.eligibility e ON e.actor_id = a.actor_id'];
 if (core) {
  columns.push('o.kind AS occupancy_kind', 'o.ref_id AS occupancy_ref');
  joins.push('LEFT JOIN core.actor_occupancy o ON o.actor_id = a.actor_id');
 } else {
  columns.push('NULL::text AS occupancy_kind', 'NULL::text AS occupancy_ref');
 }
 if (economy) {
  columns.push('p.tag', 'p.username', 'p.display_name', 'p.avatar', 'p.stats_visibility', 'p.presence_visibility', 'p.username_changed',
   'r.rating', 'r.peak', 'r.casual_rating', 'r.games', 'r.casual_games', 'r.tier', 'r.reached_at', 'r.last_rated_at',
   'w.coins', 'w.crowns', 'w.reserved_coins', 'w.reserved_crowns', 'w.purchased_coins', 'w.purchased_crowns',
   'w.purchase_influenced', 'w.legacy_competition_restricted');
  joins.push('LEFT JOIN identity.profiles p ON p.actor_id = a.actor_id',
   'LEFT JOIN economy.ratings r ON r.actor_id = a.actor_id',
   'LEFT JOIN economy.wallets w ON w.actor_id = a.actor_id');
 } else {
  columns.push('p.tag', 'p.username', 'p.display_name', 'p.avatar', 'p.stats_visibility', 'p.presence_visibility', 'p.username_changed',
   'NULL::numeric AS rating', 'NULL::numeric AS peak', 'NULL::numeric AS casual_rating', '0::integer AS games', '0::integer AS casual_games',
   "'wood'::text AS tier", 'NULL::timestamptz AS reached_at', 'NULL::timestamptz AS last_rated_at',
   '0::bigint AS coins', '0::bigint AS crowns', '0::bigint AS reserved_coins', '0::bigint AS reserved_crowns',
   '0::bigint AS purchased_coins', '0::bigint AS purchased_crowns',
   'false AS purchase_influenced', 'false AS legacy_competition_restricted');
  joins.push('LEFT JOIN identity.profiles p ON p.actor_id = a.actor_id');
 }
 return 'SELECT ' + columns.join(', ') + ' ' + joins.join(' ') + ' ORDER BY a.actor_id LIMIT $1';
}
const MATCH_SQL = 'SELECT match_id, source, mode, kind, rated, amount, currency, turn_seconds, from_tier, to_tier,'
  + ' terms_ratings, terms_json, terms_hash, quote_json, pool, contribution_a, contribution_b, accepted_count,'
  + ' status, created_at, expires_at, state_json, revision, symbol_x, symbol_y, escrow, settled, started_at,'
  + ' last_move_at, deadline, move_timings, pre_ratings, pre_tiers, receipt_json, receipt_at, receipt_reason,'
  + ' receipt_payout, receipt_burn, receipt_bonus, receipt_refunded, risk_flags, risk_actors, extra'
  + ' FROM match.matches ORDER BY created_at DESC, match_id LIMIT $1';
 const ROOM_SQL = 'SELECT room_id, code, owner_id, name, format, table_kind, sequential, quote_json, quote_currency,'
  + ' entry, pool, burn, clock_seconds, increment_seconds, capacity, rules_version, status, created_at, expires_at,'
  + ' started_at, ended_at, deadline, paused_at, reason, draw_game, revision, round_delay_ms, groups_json,'
  + ' final_refs_json, seed_json, ranking, receipt_json, risk_flags, risk_actors, escrow, settled, settled_at,'
  + ' timer_lease_owner, timer_lease_epoch, timer_lease_until, shape_version, extra'
  + ' FROM tournament.rooms ORDER BY created_at, room_id LIMIT $1';
 const FIXTURE_SQL = 'SELECT room_id, fixture_id, label, "round", group_id, decisive, slots_json, players, "ready",'
  + ' status, state_json, mini_json, winner, attempt, opens_at, expires_at, ready_deadline, turn_at, finished_at,'
  + ' banks_json, last_move_at, move_timings, reason, history_json, revision, lease_owner, lease_epoch, lease_until, extra'
  + ' FROM tournament.fixtures WHERE room_id = ANY($1::text[]) ORDER BY room_id, fixture_id LIMIT $2';

 function seasonFromRow(row) {
  return {
   id: row.season_id, startedAt: msOrNullColumn(row.started_at, 'season.started_at'),
   games: Number(row.games), queueGames: Number(row.queue_games), opponents: row.opponents || [],
   wins: Number(row.wins), losses: Number(row.losses), draws: Number(row.draws),
   peakRating: numOrNull(row.peak_rating), lastRatedAt: msOrNullColumn(row.last_rated_at, 'season.last_rated_at'),
   qualifiedAt: msOrNullColumn(row.qualified_at, 'season.qualified_at'),
  };
 }
 function accountFromRow(row) {
  return {
   id: row.actor_id, friendCode: row.tag === null ? undefined : row.tag, name: row.username === null ? undefined : row.username,
   coins: Number(row.coins || 0), crowns: Number(row.crowns || 0),
   purchasedCoins: Number(row.purchased_coins || 0), purchasedCrowns: Number(row.purchased_crowns || 0),
   legacyCompetitionRestricted: row.legacy_competition_restricted === true,
   reservedCoins: Number(row.reserved_coins || 0), reservedCrowns: Number(row.reserved_crowns || 0),
   rating: row.rating === null ? 0 : Number(row.rating), peak: row.peak === null ? 0 : Number(row.peak),
   games: Number(row.games || 0), tier: row.tier === null || row.tier === undefined ? 'wood' : row.tier,
   casualRating: row.casual_rating === null ? 1000 : Number(row.casual_rating),
   casualGames: Number(row.casual_games || 0),
   verified: row.verified === true, suspended: row.suspended === true, hold: row.security_hold === true,
   createdAt: msOrNullColumn(row.created_at, 'actors.created_at'),
   region: decodeJson(row.region, ''), wealthPublic: row.wealth_public === true,
   purchaseInfluenced: row.purchase_influenced === true,
   reachedAt: msOrNullColumn(row.reached_at, 'ratings.reached_at'),
   lastRatedAt: msOrNullColumn(row.last_rated_at, 'ratings.last_rated_at'),
   activeMatch: row.occupancy_kind ? (row.occupancy_kind === 'tournament' ? `tournament:${row.occupancy_ref}` : row.occupancy_ref) : null,
   blocked: [], friends: [], friendRequests: [], history: [], daily: {}, operations: {}, ledger: [], owned: [],
   season: null, seasonHistory: [], tournamentRecord: null,
   monetization: { credits: 0, redeemed: [], equipped: 'classic', boosts: [], daily: {}, lastAdAt: null, lastRewardStart: null },
  };
 }
 function matchFromRow(row) {
  const state = decodeJson(row.state_json, {});
  const symbols = row.symbol_x === null && row.symbol_y === null ? null : { X: row.symbol_x, O: row.symbol_y };
  const receipt = row.receipt_json === null ? undefined : {
   /* `receipt_json` holds the source receipt VERBATIM (the loader and the reconciler both treat it
    * as the authoritative document; 0034 keeps it as `json`). The V4 writers produce different key
    * sets - `_settle` writes winner/reason/currency/payout/burn/bonus/refunded/rating/at, while
    * `voidByOperator` writes only reason/refunded/burn/payout/rating - so the object is returned as
    * stored: a key the source omitted must stay omitted rather than be invented as null/0. */
   ...decodeJson(row.receipt_json, {}),
   rating: null,
  };
  const out = {
   /* `participants` is the hydrate accumulator for match.participants rows; `players`/`accepted`
    * are derived from it once those rows are in, and it is deleted before the object reaches the
    * Authority state, so `Authority.export()`/`restore()` never see it. */
   id: row.match_id, players: [], accepted: [], participants: [],
   terms: decodeJson(row.terms_json, {}), quote: decodeJson(row.quote_json, {}), termsHash: row.terms_hash,
   created: msOrNullColumn(row.created_at, 'matches.created_at'), expires: msOrNullColumn(row.expires_at, 'matches.expires_at'),
   status: row.status, state, symbols, revision: Number(row.revision), commands: new Map(), escrow: Number(row.escrow),
   settled: row.settled === true, riskFlags: row.risk_flags || [], _riskActors: decodeJson(row.risk_actors, {}),
  };
  if (row.started_at !== null) out.started = msOrNullColumn(row.started_at, 'matches.started_at');
  if (row.last_move_at !== null) out._lastMoveAt = msOrNullColumn(row.last_move_at, 'matches.last_move_at');
  if (row.deadline !== null) out.deadline = msOrNullColumn(row.deadline, 'matches.deadline');
  if (row.move_timings !== null) out._moveTimings = decodeJson(row.move_timings, []);
  if (row.pre_ratings !== null) out.preRatings = row.pre_ratings.map(Number);
  if (row.pre_tiers !== null) out.preTiers = row.pre_tiers;
  if (receipt !== undefined) out.receipt = receipt;
  return out;
 }
 function roomFromRow(row) {
  const out = {
   version: row.shape_version === null ? undefined : row.shape_version, id: row.room_id, code: row.code,
   owner: row.owner_id, name: decodeJson(row.name, undefined), format: row.format === undefined ? 'mixed' : row.format,
   table: row.table_kind, sequential: row.sequential === true, quote: decodeJson(row.quote_json, null),
   clock: Number(row.clock_seconds === null ? 0 : row.clock_seconds),
   increment: Number(row.increment_seconds === null ? 0 : row.increment_seconds),
   capacity: row.capacity === null ? 0 : Number(row.capacity),
   rulesVersion: row.rules_version === null ? 1 : Number(row.rules_version), players: [], status: row.status,
   created: msOrNullColumn(row.created_at, 'rooms.created_at'),
   expires: msOrNullColumn(row.expires_at, 'rooms.expires_at'),
   fixtures: [], groups: decodeJson(row.groups_json, []), ranking: row.ranking || [], finalRefs: decodeJson(row.final_refs_json, null),
   started: msOrNullColumn(row.started_at, 'rooms.started_at'), revision: Number(row.revision),
   roundDelay: row.round_delay_ms === null ? 0 : Number(row.round_delay_ms), seed: decodeJson(row.seed_json, null),
   deadline: msOrNullColumn(row.deadline, 'rooms.deadline'), ended: msOrNullColumn(row.ended_at, 'rooms.ended_at'),
   reason: row.reason, pausedAt: msOrNullColumn(row.paused_at, 'rooms.paused_at'), drawGame: row.draw_game,
   escrow: Number(row.escrow), settled: row.settled === true, contributions: [], receipt: decodeJson(row.receipt_json, null),
   riskFlags: row.risk_flags || [], _riskActors: decodeJson(row.risk_actors, {}),
  };
  return out;
 }
 function fixtureFromRow(row) {
  return {
   id: row.fixture_id, slots: decodeJson(row.slots_json, []), label: row.label, round: Number(row.round || 0),
   group: row.group_id, decisive: row.decisive === true, status: row.status, players: row.players || [],
   ready: row.ready || [], state: decodeJson(row.state_json, null), mini: decodeJson(row.mini_json, {}),
   winner: row.winner, attempt: Number(row.attempt || 0), opens: msOrNullColumn(row.opens_at, 'fixtures.opens_at'),
   expires: msOrNullColumn(row.expires_at, 'fixtures.expires_at'),
   readyDeadline: msOrNullColumn(row.ready_deadline, 'fixtures.ready_deadline'),
   turnAt: msOrNullColumn(row.turn_at, 'fixtures.turn_at'),
   finished: msOrNullColumn(row.finished_at, 'fixtures.finished_at'), banks: decodeJson(row.banks_json, {}),
   _lastMoveAt: msOrNullColumn(row.last_move_at, 'fixtures.last_move_at'),
   _moveTimings: decodeJson(row.move_timings, []), reason: row.reason, history: decodeJson(row.history_json, []),
   revision: Number(row.revision), leaseOwner: row.lease_owner, leaseEpoch: numOrNull(row.lease_epoch),
   leaseUntil: msOrNullColumn(row.lease_until, 'fixtures.lease_until'),
  };
 }

async function buildAggregate(context, scope) {
 const q = sql(context);
 const caps = capabilities(context);
 const unreadable = new Set();
 /* A statement whose tables live in a schema this role cannot read is SKIPPED rather than run:
  * the guarded roles genuinely do not share every schema (core has no social.*, api has no
  * economy.*), and issuing the query would raise 42501 and fail an otherwise valid unit of work.
  * The skip is recorded on the graph so the persist pass can refuse to write a schema it was never
  * able to read. */
 let truncated = false;
 const historyTables = new Set();
 const read = async (text, params, cap) => {
  if (caps) {
   let blocked = null;
   for (const schema of sqlSchemas(text)) if (!caps.has(schema)) { blocked = schema; break; }
   if (blocked) { unreadable.add(blocked); return []; }
  }
  const rows = (await q(text, params)).rows;
  /* `rows.length === cap` is NOT evidence of truncation: an exactly-cap-sized population is a
   * complete read. One extra row beyond the cap proves the read missed data, so every bounded read
   * requests `cap + 1` and the extra row is dropped here. An overflow is then classified: a GLOBAL
   * history table (HISTORY_TABLES) merely suppresses the delete pass for that table, while a
   * decision input (accounts, wallets, matches, season, eligibility-scoped history) makes the whole
   * aggregate unwritable - the decision could not be proved from it. */
  if (cap !== undefined && rows.length > cap) {
   const table = primaryTable(text);
   if (table !== null && HISTORY_TABLES.has(table)) historyTables.add(table); else truncated = true;
   rows.length = cap;
  }
  return rows;
 };
 const stateValue = { accounts: [], matches: [], receipts: [], snapshots: [], weeklyPaid: [], burned: { coins: 0, crowns: 0 }, journal: [], leagueWeek: null };
 /* Whether the aggregate read was COMPLETE for DECISION purposes: no bounded decision-input read was
 * truncated. An unreadable schema is a different fact - the ownership register deliberately deprives
 * a role of another role's tables, and the persist pass refuses to write what it could not read - so
 * it never makes an otherwise-complete aggregate undecidable. */
 const complete = () => !truncated;
 const accountRowsRead = await read(accountSql({ economy: !caps || caps.has('economy'), core: !caps || caps.has('core') }), [CAP.actors + 1], CAP.actors);
 const accountsById = new Map();
 for (const row of accountRowsRead) {
  const account = accountFromRow(row);
  accountsById.set(account.id, account);
  stateValue.accounts.push([account.id, account]);
 }
 const ids = [...accountsById.keys()];
 if (ids.length) {
  for (const row of await read(`SELECT actor_id, currency, entry_id, operation_id, amount, reason, ${msColumn('at', 'at')} FROM economy.wallet_ledger_entries WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, at, entry_id LIMIT $2`, [ids, CAP.children + 1], CAP.children)) {
   accountsById.get(row.actor_id).ledger.push({ id: row.entry_id, operation: row.operation_id, currency: row.currency, amount: Number(row.amount), reason: row.reason, at: msOrNullColumn(row.at, 'wallet_ledger.at') });
  }
  for (const row of await read('SELECT actor_id, "key", fingerprint, result FROM economy.wallet_operations WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, "key" LIMIT $2', [ids, CAP.operationKeys + 1], CAP.operationKeys)) {
    /* SOURCE SHAPE (src/domain.js:88-92): `operations[id] = {fingerprint, result}`, where `fingerprint`
     * is the exact quote TEXT (`JSON.stringify(conversion(...))`, compared byte-for-byte by `convert`
     * before it returns `{...result, duplicate:true}`) and `result` is the quote OBJECT. Both columns
     * are JSON TEXT, so the fingerprint is taken VERBATIM and only the result is parsed. Unlike the
     * economy OUTCOME keys, this key keeps its plain grammar: 0034 re-encoded command_outcomes only,
     * as wallet_operations_key_check attests. */
    accountsById.get(row.actor_id).operations[row.key] = { fingerprint: row.fingerprint, result: decodeJsonText(row.result, null, 'wallet_operations.result') };
   }
   /* `day` is DATE: the driver would hand back a LOCAL-midnight Date and `String(...)` would key the
    * bucket by the session TimeZone instead of the source `YYYY-MM-DD` - a claim would then write a
    * SECOND key and the diff's delete pass would zero the pre-existing day row. The render is done
    * in SQL, exactly as the P03 loader does it (tools/v5-migration/ledger.js:92-96). */
   for (const row of await read("SELECT actor_id, to_char(day, 'YYYY-MM-DD') AS day, finished, seconds, boards, casual, friend, ranked, ranked_bonus, claimed FROM economy.daily_progress WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, day LIMIT $2", [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_id).daily[String(row.day)] = {
     finished: Number(row.finished), seconds: Number(row.seconds), boards: Number(row.boards), casual: Number(row.casual),
     friend: Number(row.friend), ranked: Number(row.ranked), rankedBonus: Number(row.ranked_bonus), claimed: row.claimed || [],
    };
   }
   for (const row of await read(`SELECT actor_id, season_id, ${msColumn('started_at', 'started_at')}, games, queue_games, opponents, wins, losses, draws, peak_rating, ${msColumn('last_rated_at', 'last_rated_at')}, ${msColumn('qualified_at', 'qualified_at')} FROM economy.season_state WHERE actor_id = ANY($1::text[]) ORDER BY actor_id LIMIT $2`, [ids, CAP.actors + 1], CAP.actors)) {
    accountsById.get(row.actor_id).season = seasonFromRow(row);
   }
   for (const row of await read(`SELECT actor_id, season_id, ${msColumn('started_at', 'started_at')}, games, queue_games, opponents, wins, losses, draws, peak_rating, ${msColumn('last_rated_at', 'last_rated_at')}, ${msColumn('qualified_at', 'qualified_at')}, finish_rating, finish_tier, ${msColumn('ended_at', 'ended_at')} FROM economy.season_history WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, seq LIMIT $2`, [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_id).seasonHistory.push({ ...seasonFromRow(row), finishRating: numOrNull(row.finish_rating), finishTier: row.finish_tier, endedAt: msOrNullColumn(row.ended_at, 'season_history.ended_at') });
   }
   for (const row of await read('SELECT actor_id, entered, wins, runner_up, top3, top5, best_finish, finish_sum, premium_wins FROM economy.tournament_records WHERE actor_id = ANY($1::text[]) ORDER BY actor_id LIMIT $2', [ids, CAP.actors + 1], CAP.actors)) {
    accountsById.get(row.actor_id).tournamentRecord = {
     entered: Number(row.entered), wins: Number(row.wins), runnerUp: Number(row.runner_up), top3: Number(row.top3),
     top5: Number(row.top5), bestFinish: row.best_finish === null ? null : Number(row.best_finish),
     finishSum: Number(row.finish_sum), premiumWins: Number(row.premium_wins),
    };
   }
   for (const row of await read(`SELECT actor_id, match_id, ${msColumn('at', 'at')}, opponent, mode, queue, symbol, rated, qualified, activity_qualified, result, reason, active_seconds, rating_delta, casual_delta FROM economy.match_history WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, seq LIMIT $2`, [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_id).history.push({
     id: row.match_id, at: msOrNullColumn(row.at, 'match_history.at'), opponent: row.opponent, mode: row.mode,
     queue: row.queue === true, symbol: row.symbol, rated: row.rated === true, qualified: row.qualified === true,
     activityQualified: row.activity_qualified === true, result: row.result, reason: row.reason,
     activeSeconds: numOrNull(row.active_seconds), ratingDelta: numOrNull(row.rating_delta), casualDelta: numOrNull(row.casual_delta),
    });
   }
   for (const row of await read('SELECT actor_a, actor_b FROM social.friendships WHERE actor_a = ANY($1::text[]) OR actor_b = ANY($1::text[]) ORDER BY actor_a, actor_b LIMIT $2', [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_a)?.friends.push(row.actor_b);
    accountsById.get(row.actor_b)?.friends.push(row.actor_a);
   }
   for (const row of await read('SELECT from_id, to_id FROM social.friend_requests WHERE from_id = ANY($1::text[]) OR to_id = ANY($1::text[]) ORDER BY from_id, to_id LIMIT $2', [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.from_id)?.friendRequests.push(row.to_id);
   }
   for (const row of await read('SELECT blocker_id, blocked_id FROM social.blocks WHERE blocker_id = ANY($1::text[]) OR blocked_id = ANY($1::text[]) ORDER BY blocker_id, blocked_id LIMIT $2', [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.blocker_id)?.blocked.push(row.blocked_id);
   }
   for (const row of await read(`SELECT actor_id, credit_balance, equipped_frame, ${msColumn('last_ad_at', 'last_ad_at')}, ${msColumn('last_reward_start', 'last_reward_start')} FROM monetization.credits WHERE actor_id = ANY($1::text[]) ORDER BY actor_id LIMIT $2`, [ids, CAP.actors + 1], CAP.actors)) {
    const account = accountsById.get(row.actor_id);
    account.monetization.credits = Number(row.credit_balance);
    if (row.equipped_frame !== null) account.monetization.equipped = row.equipped_frame;
    account.monetization.lastAdAt = msOrNullColumn(row.last_ad_at, 'credits.last_ad_at');
    account.monetization.lastRewardStart = msOrNullColumn(row.last_reward_start, 'credits.last_reward_start');
   }
   for (const row of await read('SELECT actor_id, frame FROM monetization.redeemed_frames WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, frame LIMIT $2', [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_id).monetization.redeemed.push(row.frame);
   }
   for (const row of await read(`SELECT actor_id, boost_seq, ${msColumn('started_at', 'started_at')}, ${msColumn('ends_at', 'ends_at')} FROM monetization.boosts WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, boost_seq LIMIT $2`, [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_id).monetization.boosts.push({ startedAt: msOrNullColumn(row.started_at, 'boosts.started_at'), endsAt: msOrNullColumn(row.ends_at, 'boosts.ends_at') });
   }
   for (const row of await read("SELECT actor_id, to_char(day, 'YYYY-MM-DD') AS day, base, bonus, automatic FROM monetization.reward_daily WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, day LIMIT $2", [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_id).monetization.daily[String(row.day)] = { base: Number(row.base), bonus: Number(row.bonus), automatic: Number(row.automatic) };
   }
   for (const row of await read('SELECT actor_id, item FROM cosmetics.owned_items WHERE actor_id = ANY($1::text[]) ORDER BY actor_id, item LIMIT $2', [ids, CAP.children + 1], CAP.children)) {
    accountsById.get(row.actor_id).owned.push(row.item);
   }
  }
  const matches = new Map();
  for (const row of await read(MATCH_SQL, [CAP.matches + 1], CAP.matches)) {
   const match = matchFromRow(row);
   matches.set(match.id, match);
   stateValue.matches.push([match.id, match]);
  }
  if (matches.size) {
   const matchIds = [...matches.keys()];
   for (const row of await read('SELECT match_id, seat, actor_id, accepted FROM match.participants WHERE match_id = ANY($1::text[]) ORDER BY match_id, seat LIMIT $2', [matchIds, CAP.children + 1], CAP.children)) {
    matches.get(row.match_id).participants.push(row);
   }
   for (const row of await read('SELECT match_id, "key", fingerprint, result FROM match.move_outcomes WHERE match_id = ANY($1::text[]) ORDER BY match_id, "key" LIMIT $2', [matchIds, CAP.outcomes + 1], CAP.outcomes)) {
    matches.get(row.match_id).commands.set(row.key, { fingerprint: row.fingerprint, result: decodeJsonText(row.result, null, 'move_outcomes.result') });
   }
   for (const match of matches.values()) {
    const seats = match.participants.sort((a, b) => a.seat - b.seat);
    match.players = seats.map((r) => r.actor_id);
    match.accepted = seats.filter((r) => r.accepted === true).map((r) => r.actor_id);
    delete match.participants;
   }
  }
  const rooms = new Map();
  for (const row of await read(ROOM_SQL, [CAP.rooms + 1], CAP.rooms)) rooms.set(row.room_id, roomFromRow(row));
  if (rooms.size) {
   const roomIds = [...rooms.keys()];
   for (const row of await read(`SELECT room_id, actor_id, name, ready, withdrawn, ordinal FROM tournament.room_players WHERE room_id = ANY($1::text[]) ORDER BY room_id, ordinal LIMIT $2`, [roomIds, CAP.children + 1], CAP.children)) {
    rooms.get(row.room_id).players.push({ id: row.actor_id, name: decodeJson(row.name, undefined), ready: row.ready === true, withdrawn: row.withdrawn === true });
   }
   for (const row of await read('SELECT room_id, actor_id, amount FROM tournament.escrow_contributions WHERE room_id = ANY($1::text[]) ORDER BY room_id, actor_id LIMIT $2', [roomIds, CAP.children + 1], CAP.children)) {
    rooms.get(row.room_id).contributions.push({ id: row.actor_id, amount: Number(row.amount) });
   }
   for (const row of await read(FIXTURE_SQL, [roomIds, CAP.outcomes + 1], CAP.outcomes)) rooms.get(row.room_id).fixtures.push(fixtureFromRow(row));
  }
  for (const row of await read(`SELECT store, transaction_id, actor_id, product_id, crowns, refunded, ${msColumn('purchased_at', 'at')} FROM monetization.receipts ORDER BY store, transaction_id LIMIT $1`, [CAP.receipts + 1], CAP.receipts)) {
   stateValue.receipts.push([`${row.store}:${row.transaction_id}`, { actor: row.actor_id, productId: row.product_id, crowns: Number(row.crowns), refunded: row.refunded === true, at: msOrNullColumn(row.at, 'receipts.purchased_at') }]);
  }
  const days = new Map();
  for (const row of await read("SELECT to_char(day, 'YYYY-MM-DD') AS day, actor_id, tier FROM season.day_snapshots ORDER BY day, actor_id LIMIT $1", [CAP.snapshots + 1], CAP.snapshots)) {
   if (!days.has(row.day)) days.set(row.day, {});
   days.get(row.day)[row.actor_id] = row.tier;
  }
  for (const [day, tiers] of days) stateValue.snapshots.push([day, tiers]);
  for (const row of await read("SELECT payout_id, to_char(week, 'YYYY-MM-DD') AS week, actor_id, amount, tier, eligible, days FROM season.weekly_payouts ORDER BY payout_id LIMIT $1", [CAP.weeklyPaid + 1], CAP.weeklyPaid)) {
   stateValue.weeklyPaid.push([row.payout_id, { id: row.payout_id, account: row.actor_id, week: row.week, amount: Number(row.amount), tier: row.tier, eligible: row.eligible === true, days: numOrNull(row.days) }]);
  }
  const burns = (await read('SELECT coins, crowns FROM economy.system_burns WHERE id = 1', []))[0];
  if (burns) stateValue.burned = { coins: Number(burns.coins), crowns: Number(burns.crowns) };
  const league = (await read("SELECT to_char(week, 'YYYY-MM-DD') AS week FROM season.league_week WHERE id = 1", []))[0];
  stateValue.leagueWeek = league ? league.week : null;
  for (const row of await read(`SELECT entry_id, actor_id, currency, amount, reason, source, ${msColumn('at', 'at')} FROM economy.ledger ORDER BY at, entry_id LIMIT $1`, [CAP.recentLedger + 1], CAP.recentLedger)) {
   stateValue.journal.push({ id: row.entry_id, actor: row.actor_id, currency: row.currency, amount: Number(row.amount), reason: row.reason, source: row.source, at: msOrNullColumn(row.at, 'ledger.at') });
  }
  /* The RAW durable account projection, captured BEFORE the domain model is constructed: the
   * maintenance before-image restores it for the actors whose normalization must stay invisible
   * (see `composeBaseline`). It is the exact document `accountFromRow` produced - the same document
   * the persist pass projects - so an unchanged actor contributes no diff. */
  const rawAccountsJson = JSON.stringify(stateValue.accounts);
  const graphAuthority = authorityFor(context, stateValue);
  const graph = new DomainGraph(context, graphAuthority, snapshotOf(graphAuthority), stateValue, rooms, rawAccountsJson);
  graph.truncated = truncated;
  graph.historyTables = [...historyTables].sort();
  graph.complete = complete();
  graph.unreadable = [...unreadable].sort();
  scope.aggregateState = graph;
  return graph;
 }

 /* -------------------------------------------------- entity-wise persistence */

 /* Every table the AGGREGATE is authoritative for (see the header's ownership boundary). A
  * descriptor projects the aggregate into the target table's exact column set, so the diff
  * compares database-ready projections directly. `enabled` short-circuits a table nothing touched;
  * `appendOnly` skips the delete pass for tables whose rows are never removed by the domain;
  * `role` names the runtime role allowed to write the table when the grants are split by column. */
 const ACCOUNT_COLUMNS = ['actor_id', 'region', 'wealth_public', 'created_at'];
 const ELIGIBILITY_COLUMNS = ['actor_id', 'verified', 'suspended', 'security_hold'];
 const WALLET_COLUMNS = ['actor_id', 'coins', 'crowns', 'reserved_coins', 'reserved_crowns', 'purchased_coins', 'purchased_crowns', 'purchase_influenced', 'legacy_competition_restricted'];
 const RATING_COLUMNS = ['actor_id', 'rating', 'peak', 'casual_rating', 'games', 'casual_games', 'tier', 'reached_at', 'last_rated_at'];
 const DAILY_COLUMNS = ['actor_id', 'day', 'finished', 'seconds', 'boards', 'casual', 'friend', 'ranked', 'ranked_bonus', 'claimed'];
 const SEASON_COLUMNS = ['actor_id', 'season_id', 'started_at', 'games', 'queue_games', 'opponents', 'wins', 'losses', 'draws', 'peak_rating', 'last_rated_at', 'qualified_at'];
 const SEASON_HISTORY_COLUMNS = ['actor_id', 'seq', 'season_id', 'started_at', 'games', 'queue_games', 'opponents', 'wins', 'losses', 'draws', 'peak_rating', 'last_rated_at', 'qualified_at', 'finish_rating', 'finish_tier', 'ended_at'];
 const TOURNAMENT_RECORD_COLUMNS = ['actor_id', 'entered', 'wins', 'runner_up', 'top3', 'top5', 'best_finish', 'finish_sum', 'premium_wins'];
 const HISTORY_COLUMNS = ['actor_id', 'seq', 'match_id', 'at', 'opponent', 'mode', 'queue', 'symbol', 'rated', 'qualified', 'activity_qualified', 'result', 'reason', 'active_seconds', 'rating_delta', 'casual_delta'];
 const LEDGER_COLUMNS = ['entry_id', 'actor_id', 'currency', 'amount', 'reason', 'source', 'at'];
 const WALLET_LEDGER_COLUMNS = ['actor_id', 'entry_id', 'operation_id', 'currency', 'amount', 'reason', 'at'];
 const WALLET_OPERATION_COLUMNS = ['actor_id', 'key', 'fingerprint', 'result'];
 const MATCH_COLUMNS = ['match_id', 'source', 'mode', 'kind', 'rated', 'amount', 'currency', 'turn_seconds', 'from_tier', 'to_tier', 'terms_ratings', 'terms_json', 'terms_hash', 'quote_json', 'pool', 'contribution_a', 'contribution_b', 'accepted_count', 'status', 'created_at', 'expires_at', 'state_json', 'revision', 'symbol_x', 'symbol_y', 'escrow', 'settled', 'started_at', 'last_move_at', 'deadline', 'move_timings', 'pre_ratings', 'pre_tiers', 'receipt_json', 'receipt_at', 'receipt_reason', 'receipt_payout', 'receipt_burn', 'receipt_bonus', 'receipt_refunded', 'risk_flags', 'risk_actors', 'extra'];
 const PARTICIPANT_COLUMNS = ['match_id', 'seat', 'actor_id', 'accepted'];
 const MOVE_OUTCOME_COLUMNS = ['match_id', 'key', 'fingerprint', 'result'];
 const RECEIPT_COLUMNS = ['store', 'transaction_id', 'actor_id', 'product_id', 'crowns', 'refunded', 'purchased_at'];
 const CREDITS_COLUMNS = ['actor_id', 'credit_balance', 'equipped_frame', 'last_ad_at', 'last_reward_start'];
 const REDEEMED_COLUMNS = ['actor_id', 'frame'];
 const BOOST_COLUMNS = ['actor_id', 'boost_seq', 'started_at', 'ends_at'];
 const REWARD_DAILY_COLUMNS = ['actor_id', 'day', 'base', 'bonus', 'automatic'];
 const OWNED_COLUMNS = ['actor_id', 'item'];
 const OCCUPANCY_COLUMNS = ['actor_id', 'kind', 'ref_id', 'claimed_at'];

 function accountRows(state) { return state.accounts; }
 function pairsOf(list) { return list || []; }
 function seqKey(actorSeqs) { return `${actorSeqs[0]}\u001f${actorSeqs[1]}`; }
/* A match's `commands` is a Map from the hydrator and an ENTRY ARRAY after `Authority.export()`;
 * both reach the diff, so the write path accepts either. An absent value iterates as empty rather
 * than throwing or inventing an entry. */
function commandEntries(commands) {
 if (!commands) return [];
 return commands instanceof Map ? [...commands] : commands;
}

 const TABLES = [
  {
   table: 'identity.actors', pk: ['actor_id'], columns: ACCOUNT_COLUMNS, update: ['region', 'wealth_public', 'created_at'],
   rows: (state) => accountRows(state).map(([id, a]) => ({ actor_id: id, region: jsonText(String(a.region === undefined || a.region === null ? '' : a.region), 'actors.region'), wealth_public: a.wealthPublic === true, created_at: iso(a.createdAt, 'actors.created_at') })),
   keyOf: (r) => r.actor_id,
  },
  {
   /* verified is API-owned; suspended/security_hold are Core-owned column grants (0021 + 0037), so
    * no single statement can write all three under either runtime role. The row INSERT belongs to
    * api_runtime (0037) and each flag write is issued only by the role that holds it. */
   table: 'identity.eligibility', pk: ['actor_id'], columns: ELIGIBILITY_COLUMNS, update: ['verified', 'suspended', 'security_hold'],
   roleSplit: true,
   rows: (state) => accountRows(state).map(([id, a]) => ({
    actor_id: id, verified: a.verified === true, suspended: a.suspended === true, security_hold: a.hold === true,
    api: { actor_id: id, verified: a.verified === true },
    core: { actor_id: id, suspended: a.suspended === true, security_hold: a.hold === true },
   })),
   keyOf: (r) => r.actor_id,
  },
  {
   table: 'economy.wallets', pk: ['actor_id'], columns: WALLET_COLUMNS,
   update: ['coins', 'crowns', 'reserved_coins', 'reserved_crowns', 'purchased_coins', 'purchased_crowns', 'purchase_influenced', 'legacy_competition_restricted'],
   rows: (state) => accountRows(state).map(([id, a]) => ({
    actor_id: id, coins: integer(a.coins === undefined ? 0 : a.coins, 'wallets.coins'), crowns: integer(a.crowns === undefined ? 0 : a.crowns, 'wallets.crowns'),
    reserved_coins: integer(a.reservedCoins === undefined ? 0 : a.reservedCoins, 'wallets.reserved_coins'), reserved_crowns: integer(a.reservedCrowns === undefined ? 0 : a.reservedCrowns, 'wallets.reserved_crowns'),
    purchased_coins: integer(a.purchasedCoins === undefined ? 0 : a.purchasedCoins, 'wallets.purchased_coins'), purchased_crowns: integer(a.purchasedCrowns === undefined ? 0 : a.purchasedCrowns, 'wallets.purchased_crowns'),
    purchase_influenced: a.purchaseInfluenced === true, legacy_competition_restricted: a.legacyCompetitionRestricted === true,
   })),
   keyOf: (r) => r.actor_id,
  },
  {
   table: 'economy.ratings', pk: ['actor_id'], columns: RATING_COLUMNS, update: RATING_COLUMNS.slice(1),
   rows: (state) => accountRows(state).map(([id, a]) => ({
    actor_id: id, rating: String(a.rating === undefined ? 0 : a.rating), peak: String(a.peak === undefined ? 0 : a.peak),
    casual_rating: String(a.casualRating === undefined || a.casualRating === null ? 1000 : a.casualRating),
    games: integer(a.games === undefined ? 0 : a.games, 'ratings.games'), casual_games: integer(a.casualGames === undefined ? 0 : a.casualGames, 'ratings.casual_games'),
    tier: a.tier === undefined || a.tier === null ? 'wood' : a.tier, reached_at: iso(a.reachedAt, 'ratings.reached_at'),
    last_rated_at: iso(a.lastRatedAt, 'ratings.last_rated_at'),
   })),
   keyOf: (r) => r.actor_id,
  },
  {
   table: 'economy.ledger', pk: ['entry_id'], columns: LEDGER_COLUMNS, update: [], appendOnly: true,
   rows: (state) => pairsOf(state.journal).map((entry) => ({
    entry_id: entry.id, actor_id: entry.actor, currency: entry.currency, amount: integer(Math.abs(entry.amount), 'ledger.amount') * (entry.amount < 0 ? -1 : 1),
    reason: entry.reason, source: entry.source, at: iso(entry.at, 'ledger.at'),
   })),
   keyOf: (r) => r.entry_id,
  },
  {
   table: 'economy.wallet_ledger_entries', pk: ['actor_id', 'entry_id'], columns: WALLET_LEDGER_COLUMNS, update: [], appendOnly: true,
   rows: (state) => accountRows(state).flatMap(([id, a]) => pairsOf(a.ledger).map((entry) => ({
    actor_id: id, entry_id: entry.id, operation_id: entry.operation === undefined ? null : entry.operation,
    currency: entry.currency, amount: Number(entry.amount), reason: entry.reason, at: iso(entry.at, 'wallet_ledger.at'),
   }))),
   keyOf: (r) => seqKey([r.actor_id, r.entry_id]),
  },
  {
   table: 'economy.wallet_operations', pk: ['actor_id', 'key'], columns: WALLET_OPERATION_COLUMNS, update: [], appendOnly: true,
   rows: (state) => accountRows(state).flatMap(([id, a]) => Object.keys(a.operations || {}).map((key) => ({
    actor_id: id, key, fingerprint: a.operations[key].fingerprint, result: jsonText(a.operations[key].result, 'operations.result'),
   }))),
   keyOf: (r) => seqKey([r.actor_id, r.key]),
  },
  {
   table: 'economy.daily_progress', pk: ['actor_id', 'day'], columns: DAILY_COLUMNS, update: DAILY_COLUMNS.slice(2),
   rows: (state) => accountRows(state).flatMap(([id, a]) => Object.keys(a.daily || {}).map((day) => ({
    actor_id: id, day, finished: integer(a.daily[day].finished || 0, 'daily.finished'), seconds: String(a.daily[day].seconds || 0),
    boards: integer(a.daily[day].boards || 0, 'daily.boards'), casual: integer(a.daily[day].casual || 0, 'daily.casual'),
    friend: integer(a.daily[day].friend || 0, 'daily.friend'), ranked: integer(a.daily[day].ranked || 0, 'daily.ranked'),
    ranked_bonus: integer(a.daily[day].rankedBonus || 0, 'daily.ranked_bonus'), claimed: a.daily[day].claimed || [],
   }))),
   keyOf: (r) => seqKey([r.actor_id, r.day]),
  },
  {
   table: 'economy.season_state', pk: ['actor_id'], columns: SEASON_COLUMNS, update: SEASON_COLUMNS.slice(1),
   rows: (state) => accountRows(state).filter(([, a]) => a.season).map(([id, a]) => ({
    actor_id: id, season_id: a.season.id, started_at: iso(a.season.startedAt, 'season.started_at'),
    games: integer(a.season.games || 0, 'season.games'), queue_games: integer(a.season.queueGames || 0, 'season.queue_games'),
    opponents: a.season.opponents || [], wins: integer(a.season.wins || 0, 'season.wins'), losses: integer(a.season.losses || 0, 'season.losses'),
    draws: integer(a.season.draws || 0, 'season.draws'), peak_rating: a.season.peakRating === null || a.season.peakRating === undefined ? null : String(a.season.peakRating),
    last_rated_at: iso(a.season.lastRatedAt, 'season.last_rated_at'), qualified_at: iso(a.season.qualifiedAt, 'season.qualified_at'),
   })),
   keyOf: (r) => r.actor_id,
  },
  {
   table: 'economy.season_history', pk: ['actor_id', 'seq'], columns: SEASON_HISTORY_COLUMNS, update: [], appendOnly: true,
   rows: (state) => accountRows(state).flatMap(([id, a]) => pairsOf(a.seasonHistory).map((entry, seq) => ({
    actor_id: id, seq, season_id: entry.id, started_at: iso(entry.startedAt, 'season_history.started_at'),
    games: integer(entry.games || 0, 'season_history.games'), queue_games: integer(entry.queueGames || 0, 'season_history.queue_games'),
    opponents: entry.opponents || [], wins: integer(entry.wins || 0, 'season_history.wins'), losses: integer(entry.losses || 0, 'season_history.losses'),
    draws: integer(entry.draws || 0, 'season_history.draws'),
    peak_rating: entry.peakRating === null || entry.peakRating === undefined ? null : String(entry.peakRating),
    last_rated_at: iso(entry.lastRatedAt, 'season_history.last_rated_at'), qualified_at: iso(entry.qualifiedAt, 'season_history.qualified_at'),
    finish_rating: entry.finishRating === null || entry.finishRating === undefined ? null : String(entry.finishRating),
    finish_tier: entry.finishTier === undefined ? null : entry.finishTier, ended_at: iso(entry.endedAt, 'season_history.ended_at'),
   }))),
   keyOf: (r) => seqKey([r.actor_id, String(r.seq).padStart(6, '0')]),
  },
  {
   table: 'economy.tournament_records', pk: ['actor_id'], columns: TOURNAMENT_RECORD_COLUMNS, update: TOURNAMENT_RECORD_COLUMNS.slice(1),
   rows: (state) => accountRows(state).filter(([, a]) => a.tournamentRecord).map(([id, a]) => ({
    actor_id: id, entered: integer(a.tournamentRecord.entered || 0, 'tournament.entered'), wins: integer(a.tournamentRecord.wins || 0, 'tournament.wins'),
    runner_up: integer(a.tournamentRecord.runnerUp || 0, 'tournament.runner_up'), top3: integer(a.tournamentRecord.top3 || 0, 'tournament.top3'),
    top5: integer(a.tournamentRecord.top5 || 0, 'tournament.top5'),
    best_finish: a.tournamentRecord.bestFinish === null || a.tournamentRecord.bestFinish === undefined ? null : integer(a.tournamentRecord.bestFinish, 'tournament.best_finish'),
    finish_sum: integer(a.tournamentRecord.finishSum || 0, 'tournament.finish_sum'), premium_wins: integer(a.tournamentRecord.premiumWins || 0, 'tournament.premium_wins'),
   })),
   keyOf: (r) => r.actor_id,
  },
  {
   table: 'economy.match_history', pk: ['actor_id', 'seq'], columns: HISTORY_COLUMNS, update: [], appendOnly: true,
   rows: (state) => accountRows(state).flatMap(([id, a]) => pairsOf(a.history).map((entry, seq) => ({
    actor_id: id, seq, match_id: entry.id, at: iso(entry.at, 'match_history.at'), opponent: entry.opponent, mode: entry.mode,
    queue: entry.queue === true, symbol: entry.symbol, rated: entry.rated === true, qualified: entry.qualified === true,
    activity_qualified: entry.activityQualified === true, result: entry.result, reason: entry.reason === undefined ? null : entry.reason,
    active_seconds: entry.activeSeconds === null || entry.activeSeconds === undefined ? null : integer(entry.activeSeconds, 'match_history.active_seconds'),
    rating_delta: entry.ratingDelta === null || entry.ratingDelta === undefined ? null : String(entry.ratingDelta),
    casual_delta: entry.casualDelta === null || entry.casualDelta === undefined ? null : String(entry.casualDelta),
   }))),
   keyOf: (r) => seqKey([r.actor_id, String(r.seq).padStart(6, '0')]),
  },
  {
   table: 'cosmetics.owned_items', pk: ['actor_id', 'item'], columns: OWNED_COLUMNS, update: [],
   rows: (state) => accountRows(state).flatMap(([id, a]) => pairsOf(a.owned).map((item) => ({ actor_id: id, item: String(item) }))),
   keyOf: (r) => seqKey([r.actor_id, r.item]),
  },
  {
   table: 'monetization.credits', pk: ['actor_id'], columns: CREDITS_COLUMNS, update: ['credit_balance', 'equipped_frame', 'last_ad_at', 'last_reward_start'],
   rows: (state) => accountRows(state).filter(([, a]) => a.monetization).map(([id, a]) => ({
    actor_id: id, credit_balance: integer(a.monetization.credits || 0, 'credits.credit_balance'),
    equipped_frame: typeof a.monetization.equipped === 'string' ? a.monetization.equipped : null,
    last_ad_at: iso(a.monetization.lastAdAt, 'credits.last_ad_at'), last_reward_start: iso(a.monetization.lastRewardStart, 'credits.last_reward_start'),
   })),
   keyOf: (r) => r.actor_id,
  },
  {
   table: 'monetization.redeemed_frames', pk: ['actor_id', 'frame'], columns: REDEEMED_COLUMNS, update: [],
   rows: (state) => accountRows(state).flatMap(([id, a]) => pairsOf(a.monetization && a.monetization.redeemed).map((frame) => ({ actor_id: id, frame: String(frame) }))),
   keyOf: (r) => seqKey([r.actor_id, r.frame]),
  },
  {
   table: 'monetization.boosts', pk: ['actor_id', 'boost_seq'], columns: BOOST_COLUMNS, update: ['started_at', 'ends_at'],
   rows: (state) => accountRows(state).flatMap(([id, a]) => pairsOf(a.monetization && a.monetization.boosts).map((boost, boostSeq) => ({
    actor_id: id, boost_seq: boostSeq, started_at: iso(boost.startedAt, 'boosts.started_at'), ends_at: iso(boost.endsAt, 'boosts.ends_at'),
   }))),
   keyOf: (r) => seqKey([r.actor_id, String(r.boost_seq)]),
  },
  {
   table: 'monetization.reward_daily', pk: ['actor_id', 'day'], columns: REWARD_DAILY_COLUMNS, update: ['base', 'bonus', 'automatic'],
   rows: (state) => accountRows(state).flatMap(([id, a]) => Object.keys((a.monetization && a.monetization.daily) || {}).map((day) => ({
    actor_id: id, day, base: integer(a.monetization.daily[day].base || 0, 'reward_daily.base'),
    bonus: integer(a.monetization.daily[day].bonus || 0, 'reward_daily.bonus'), automatic: integer(a.monetization.daily[day].automatic || 0, 'reward_daily.automatic'),
   }))),
   keyOf: (r) => seqKey([r.actor_id, r.day]),
  },
  {
   table: 'monetization.receipts', pk: ['store', 'transaction_id'], columns: RECEIPT_COLUMNS, update: ['actor_id', 'product_id', 'crowns', 'refunded', 'purchased_at'],
   rows: (state) => pairsOf(state.receipts).map(([key, receipt]) => {
    const cut = String(key).indexOf(':');
    if (cut <= 0) throw ctxError('RECEIPT_KEY_UNSPLITTABLE', String(key));
    return {
     store: String(key).slice(0, cut), transaction_id: String(key).slice(cut + 1), actor_id: receipt.actor,
     product_id: receipt.productId, crowns: integer(receipt.crowns || 0, 'receipts.crowns'), refunded: receipt.refunded === true,
     purchased_at: iso(receipt.at, 'receipts.purchased_at'),
    };
   }),
   keyOf: (r) => seqKey([r.store, r.transaction_id]),
  },
  {
   table: 'core.actor_occupancy', pk: ['actor_id'], columns: OCCUPANCY_COLUMNS, update: ['kind', 'ref_id'],
   /* `claimed_at` records WHEN the claim was taken. The domain does not carry it, so the injected
    * clock (sampled once per transaction) is the only honest source - never a hidden default and
    * never a fabricated historical instant. */
   rows: (state, context) => accountRows(state)
    .filter(([, a]) => typeof a.activeMatch === 'string' && a.activeMatch.length > 0)
    .map(([id, a]) => {
     const tournament = a.activeMatch.startsWith('tournament:');
     return {
      actor_id: id, kind: tournament ? 'tournament' : 'match',
      ref_id: tournament ? a.activeMatch.slice('tournament:'.length) : a.activeMatch,
      claimed_at: iso(typeof a.occupancyClaimedAt === 'number' ? a.occupancyClaimedAt : txClock(context), 'occupancy.claimed_at'),
     };
    }),
   keyOf: (r) => r.actor_id,
  },
  {
   table: 'match.matches', pk: ['match_id'], columns: MATCH_COLUMNS, update: MATCH_COLUMNS.slice(1),
   rows: (state) => pairsOf(state.matches).map(([id, m]) => matchRow(id, m)),
   keyOf: (r) => r.match_id,
  },
  {
   table: 'match.participants', pk: ['match_id', 'seat'], columns: PARTICIPANT_COLUMNS, update: ['actor_id', 'accepted'],
   rows: (state) => pairsOf(state.matches).flatMap(([id, m]) => pairsOf(m.players).map((actor, seat) => ({
    match_id: String(id), seat, actor_id: String(actor), accepted: pairsOf(m.accepted).includes(actor),
   }))),
   keyOf: (r) => seqKey([r.match_id, String(r.seat)]),
  },
  {
   table: 'match.move_outcomes', pk: ['match_id', 'key'], columns: MOVE_OUTCOME_COLUMNS, update: [], appendOnly: true,
   /* `commands` is a Map on a freshly hydrated match and an ENTRY ARRAY after `Authority.export()`
    * (src/authority.js:26 maps each match to `{...m, commands:[...m.commands]}`), and both shapes
    * reach the diff. Iterate either, so a whole-aggregate `state.write` path cannot throw. */
   rows: (state) => pairsOf(state.matches).flatMap(([id, m]) => commandEntries(m.commands).map(([key, entry]) => ({
    match_id: String(id), key, fingerprint: entry.fingerprint, result: jsonText(entry.result, 'move.result'),
   }))),
   keyOf: (r) => seqKey([r.match_id, r.key]),
  },
  {
   table: 'season.league_week', pk: ['id'], columns: ['id', 'week'], update: ['week'],
   rows: (state) => state.leagueWeek === null || state.leagueWeek === undefined ? [] : [{ id: 1, week: state.leagueWeek }],
   keyOf: () => '1',
  },
  {
   table: 'season.day_snapshots', pk: ['day', 'actor_id'], columns: ['day', 'actor_id', 'tier'], update: ['tier'],
   rows: (state) => pairsOf(state.snapshots).flatMap(([day, tiers]) => Object.keys(tiers || {}).map((actor) => ({ day: String(day), actor_id: actor, tier: tiers[actor] }))),
   keyOf: (r) => seqKey([r.day, r.actor_id]),
  },
  {
   table: 'season.weekly_payouts', pk: ['payout_id'], columns: ['payout_id', 'week', 'actor_id', 'amount', 'tier', 'eligible', 'days'], update: ['week', 'actor_id', 'amount', 'tier', 'eligible', 'days'],
   rows: (state) => pairsOf(state.weeklyPaid).map(([key, payment]) => ({
    payout_id: String(key), week: payment.week, actor_id: payment.account,
    amount: integer(payment.amount || 0, 'weekly_payouts.amount'), tier: payment.tier === undefined ? null : payment.tier,
    eligible: payment.eligible === true, days: payment.days === undefined ? null : payment.days,
   })),
   keyOf: (r) => r.payout_id,
  },
  {
   table: 'economy.system_burns', pk: ['id'], columns: ['id', 'coins', 'crowns'], update: ['coins', 'crowns'],
   rows: (state) => state.burned === undefined || state.burned === null ? [] : [{
    id: 1, coins: integer(state.burned.coins || 0, 'burns.coins'), crowns: integer(state.burned.crowns || 0, 'burns.crowns'),
   }],
   keyOf: () => '1',
  },
 ];

 function matchRow(id, m) {
  const terms = m.terms || {};
  const quote = m.quote || {};
  const contributions = quote.contributions || [];
  const receipt = m.receipt === undefined ? null : m.receipt;
  const row = {
   match_id: String(id), source: terms.source, mode: terms.mode, kind: terms.kind === undefined ? null : jsonText(terms.kind, 'matches.kind'),
   rated: terms.rated === true, amount: terms.amount === undefined ? null : integer(terms.amount, 'matches.amount'),
   currency: terms.currency === undefined ? null : terms.currency,
   turn_seconds: terms.turnSeconds === undefined ? null : integer(terms.turnSeconds, 'matches.turn_seconds'),
   from_tier: terms.from === undefined ? null : terms.from, to_tier: terms.to === undefined ? null : terms.to,
   terms_ratings: terms.ratings === undefined || terms.ratings === null ? null : terms.ratings.map(String),
   terms_json: jsonText(terms, 'matches.terms_json'), terms_hash: m.termsHash, quote_json: jsonText(quote, 'matches.quote_json'),
   pool: integer(quote.pool || 0, 'matches.pool'),
   contribution_a: integer(contributions.length ? contributions[0] : 0, 'matches.contribution_a'),
   contribution_b: integer(contributions.length > 1 ? contributions[1] : 0, 'matches.contribution_b'),
   accepted_count: pairsOf(m.accepted).length, status: m.status, created_at: iso(m.created, 'matches.created_at'),
   expires_at: iso(m.expires, 'matches.expires_at'), state_json: jsonText(m.state, 'matches.state_json'),
   revision: integer(m.revision || 0, 'matches.revision'),
   symbol_x: m.symbols ? m.symbols.X : null, symbol_y: m.symbols ? m.symbols.O : null,
   escrow: integer(m.escrow || 0, 'matches.escrow'), settled: m.settled === true,
   started_at: iso(m.started, 'matches.started_at'), last_move_at: iso(m._lastMoveAt, 'matches.last_move_at'),
   deadline: iso(m.deadline, 'matches.deadline'),
   move_timings: m._moveTimings === undefined ? null : jsonText(m._moveTimings, 'matches.move_timings'),
   pre_ratings: m.preRatings === undefined ? null : m.preRatings.map(String), pre_tiers: m.preTiers === undefined ? null : m.preTiers,
   /* `receipt_json` and its side columns are ONE source document: the side columns exist for indexed
    * reporting, and a key the source omitted must stay NULL rather than become `0`/now. `receipt_at`
    * is written from the document itself for the same reason. */
   receipt_json: receipt === null ? null : jsonText(receipt, 'matches.receipt_json'),
   receipt_at: receipt === null || receipt.at === undefined ? null : iso(receipt.at, 'matches.receipt_at'),
   receipt_reason: receipt === null || receipt.reason === undefined ? null : jsonText(receipt.reason, 'matches.receipt_reason'),
   receipt_payout: receipt === null || receipt.payout === undefined ? null : integer(receipt.payout, 'matches.receipt_payout'),
   receipt_burn: receipt === null || receipt.burn === undefined ? null : integer(receipt.burn, 'matches.receipt_burn'),
   receipt_bonus: receipt === null || receipt.bonus === undefined ? null : integer(receipt.bonus, 'matches.receipt_bonus'),
   receipt_refunded: receipt === null || receipt.refunded === undefined ? null : integer(receipt.refunded, 'matches.receipt_refunded'),
   risk_flags: m.riskFlags || [], risk_actors: jsonText(m._riskActors || {}, 'matches.risk_actors'),
   extra: null,
  };
  return row;
 }

/* ---------------------------------------------------- maintenance before-image */

/* The before-image used by EVERY persist: normalization is visible only for the actors this
 * transaction actually LOCKED.
 *
 * `Authority.restore()` mutates the document it hydrates - it rolls a quarter, seeds defaults and
 * clamps counters - so a baseline taken after hydration would make that work look like the caller's
 * change and persist it for EVERY actor the aggregate carries, including actors this transaction
 * never locked. The hydrator therefore captures the RAW durable account projection BEFORE the domain
 * model is constructed (`graph.rawAccountsJson`), and the baseline is composed from both:
 *
 *   - a LOCKED actor takes its raw durable account, so its normalization (the quarter archive, the
 *     seeded season/record rows, the clamp) is part of the diff and IS persisted;
 *   - every other actor keeps the normalized account, so its normalization is invisible and nothing
 *     is written for an actor this transaction never locked.
 *
 * Every non-account member (matches, receipts, journal, burns, snapshots, weekly payouts) is carried
 * verbatim: `restore()` does not normalize any of them. */
function accountMap(accounts) {
 const out = new Map();
 for (const [id, account] of accounts || []) out.set(id, account);
 return out;
}
function composeBaseline(normalizedJson, rawAccountsJson, lockedIds) {
 const merged = JSON.parse(normalizedJson);
 const raw = accountMap(rawAccountsJson ? JSON.parse(rawAccountsJson) : null);
 merged.accounts = merged.accounts.map(([id, account]) => [id, lockedIds.has(id) && raw.has(id) ? raw.get(id) : account]);
 return merged;
}
function jsonOf(document) { return JSON.stringify(document); }
/* The actors whose normalization this transaction may persist: exactly those it holds a row lock on.
 * The lock set is supplied by the caller (it knows which lock plan it ran). */
function lockedAccountIds(current, isLocked) {
 return new Set([...current.accounts].map(([id]) => id).filter((id) => isLocked(id) === true));
}

async function persistAggregate(context, stateValue, beforeJson, flags = {}) {
  const q = sql(context);
  /* A truncated load cannot prove which rows are absent, so a delete pass over it would delete
   * rows the loader never saw. Truncation therefore degrades the persist to upsert-only. A bounded
   * GLOBAL HISTORY read (`flags.skipDelete`, the named history tables) degrades deletion for those
   * tables ALONE: their rows are append-only from the aggregate, and no rule decision reads their
   * absence, so the rest of the diff stays exact.
   *
   * ADDITIVE BURNS. `economy.system_burns` is a shared singleton written by every settlement. A
   * hydrated absolute total is stale the moment a disjoint settlement commits, so the row is
   * persisted as a verified DELTA (row - baseline, floored at 0) applied with `coins = coins + $n`,
   * which the bounded-integer CHECK still rejects atomically on overflow. */
  const deletable = flags.truncated !== true;
  const skipDelete = flags.skipDelete instanceof Set ? flags.skipDelete : new Set();
  const additive = new Set(['economy.system_burns']);
  const immutable = IMMUTABLE_TABLES;
  const unread = Array.isArray(flags.unreadable) ? flags.unreadable : [];
  const before = beforeJson ? JSON.parse(beforeJson) : null;
  const caps = capabilities(context);
  const role = roleOf(context);
  const stats = { tables: 0, upserts: 0, deletes: 0, skipped: [] };
  for (const descriptor of TABLES) {
   const schema = descriptor.table.slice(0, descriptor.table.indexOf('.'));
   if (caps && !caps.has(schema)) {
    /* A schema this role has no USAGE on is another role's state, so it is skipped by design (the
     * ownership register). */
    stats.skipped.push(descriptor.table);
    continue;
   }
   if (caps && descriptor.roleSplit !== true && unread.includes(schema)) {
    throw ctxError('ROLE_CAPABILITY_REQUIRED', `${schema} write grants without read grants; refusing to diff an unread aggregate`);
   }
   if (descriptor.roleSplit) {
    await persistEligibility(context, q, descriptor, stateValue, before, stats);
    continue;
   }
   /* The diff is computed BEFORE any write, so a change this role may not persist fails closed
    * with the exact pending counts instead of silently dropping a committed business effect. */
   const next = byKey(descriptor.rows(stateValue, context), descriptor.keyOf);
   const prior = before ? byKey(descriptor.rows(before, context), descriptor.keyOf) : null;
   const pending = [];
   const removed = [];
   for (const [key, row] of next) {
    if (prior && prior.has(key) && !changed(prior.get(key), row)) continue;
    pending.push(row);
   }
   if (!descriptor.appendOnly && deletable && prior && !skipDelete.has(descriptor.table)) {
    for (const [key, row] of prior) if (!next.has(key)) removed.push(row);
   }
   if (pending.length === 0 && removed.length === 0) continue;
   if (!mayWrite(role, descriptor.table)) {
    throw ctxError('ROLE_CAPABILITY_REQUIRED', `${role || 'unknown role'} may not write ${descriptor.table}; ${pending.length} upsert(s), ${removed.length} delete(s) pending`);
   }
   let touched = false;
   for (const row of pending) {
    if (additive.has(descriptor.table)) {
     /* Shared singleton: only the VERIFIED positive delta moves the durable counter, so two
      * disjoint settlements that both read the same stale total each add their own burn instead of
      * the loser overwriting the winner. A negative delta is a correction that needs a durable
      * baseline this row does not have, so it is refused rather than guessed. */
     const baseline = prior ? prior.get(descriptor.keyOf(row)) : null;
     for (const column of descriptor.update) {
      const delta = Number(row[column] === undefined || row[column] === null ? 0 : row[column])
       - Number(baseline && baseline[column] !== undefined && baseline[column] !== null ? baseline[column] : 0);
      if (!Number.isSafeInteger(delta) || delta < 0) throw ctxError('INVALID_BURN_DELTA', `${descriptor.table}.${column}: ${delta}`);
      if (delta === 0) continue;
      if (baseline) {
       await q(`UPDATE ${descriptor.table} SET "${column}" = "${column}" + $1 WHERE "${descriptor.pk[0]}" = $2`, [delta, row[descriptor.pk[0]]]);
      } else {
       await q(insertSql(descriptor.table, descriptor.columns, descriptor.pk, descriptor.update), descriptor.columns.map((c) => row[c]));
      }
      stats.upserts += 1;
     }
     touched = true;
     continue;
    }
    if (immutable.has(descriptor.table)) {
     /* IMMUTABLE IDENTITY. A genuinely new match/participant row is INSERTed (a duplicate key
      * aborts, it never replaces the existing aggregate); an EXISTING row is written through its
      * intended UPDATE by primary key. The prior row comes from the RAW durable baseline, so an
      * absent key is a real absence. */
     const previous = prior ? prior.get(descriptor.keyOf(row)) : null;
     if (previous) {
      await q(updateSql(descriptor.table, descriptor.update, descriptor.pk), [...descriptor.update.map((c) => row[c]), ...descriptor.pk.map((c) => previous[c])]);
     } else {
      await q(createSql(descriptor.table, descriptor.columns), descriptor.columns.map((c) => row[c]));
     }
     touched = true;
     stats.upserts += 1;
     continue;
    }
    await q(insertSql(descriptor.table, descriptor.columns, descriptor.pk, descriptor.update), descriptor.columns.map((c) => row[c]));
    touched = true;
    stats.upserts += 1;
   }
   for (const row of removed) {
    await q(deleteSql(descriptor.table, descriptor.pk), descriptor.pk.map((c) => row[c]));
    touched = true;
    stats.deletes += 1;
   }
   if (touched) stats.tables += 1;
  }
  return stats;
 }

 /* The injected clock sampled ONCE per transaction: a claim timestamp written by the unit of work
  * is therefore stable across the diff passes of that unit and still comes from the injected clock
  * rather than a hidden default. */
 function txClock(context) {
  const scope = scopeOf(context);
  if (scope.clockSample === undefined) scope.clockSample = clockOf(context);
  return scope.clockSample;
 }

 /* eligibility is the one table whose writable columns are split across runtime roles: api_runtime
  * owns `verified` (and the row INSERT, 0037), core_runtime owns `suspended`/`security_hold`
  * (0021). Issuing one statement that sets all three would be denied for BOTH roles, so each side
  * writes only what its grants allow; an unknown role refuses rather than silently dropping a flag
  * change. */
 async function persistEligibility(context, q, descriptor, stateValue, before, stats) {
  const role = roleOf(context);
  const next = byKey(descriptor.rows(stateValue), descriptor.keyOf);
  const prior = before ? byKey(descriptor.rows(before), descriptor.keyOf) : null;
  let touched = false;
  if (role === 'api_runtime') {
   for (const [key, row] of next) {
    const previous = prior ? prior.get(key) : null;
    if (previous && !changed(previous.api, row.api)) continue;
    if (!previous) {
     await q('INSERT INTO identity.eligibility (actor_id, verified) VALUES ($1, $2) ON CONFLICT (actor_id) DO NOTHING', [row.actor_id, row.verified]);
     touched = true;
     stats.upserts += 1;
    } else if (changed(previous.api, row.api)) {
     await q('UPDATE identity.eligibility SET verified = $2 WHERE actor_id = $1', [row.actor_id, row.verified]);
     touched = true;
     stats.upserts += 1;
    }
   }
  } else if (role === 'core_runtime') {
   for (const [key, row] of next) {
    const previous = prior ? prior.get(key) : null;
    if (previous && !changed(previous.core, row.core)) continue;
    await q('UPDATE identity.eligibility SET suspended = $2, security_hold = $3 WHERE actor_id = $1', [row.actor_id, row.suspended, row.security_hold]);
    touched = true;
    stats.upserts += 1;
   }
  } else {
   throw ctxError('ROLE_CAPABILITY_REQUIRED', 'identity.eligibility is written by api_runtime (verified) and core_runtime (suspended/security_hold) only');
  }
  if (touched) stats.tables += 1;
 }

 /* tournaments.save writes the room entity rows: rooms plus room_players / escrow_contributions /
  * fixtures. Dependents are bounded (<=10 players, bounded fixtures) so they are replaced
  * wholesale; 0028's UNIQUE (room_id, ordinal) makes positional updates unsafe. */
 /* ------------------------------------------------------------ room entity rows */

 /* Column lists for the tournament entity rows (mirrors tools/v5-migration/loader.js ROOM_COLUMNS /
  * FIXTURE_COLUMNS so the runtime projection and the importer agree on the same destination set). */
 const ROOM_COLUMNS = ['room_id', 'code', 'owner_id', 'name', 'format', 'table_kind', 'sequential', 'quote_json',
  'quote_currency', 'entry', 'pool', 'burn', 'clock_seconds', 'increment_seconds', 'capacity', 'rules_version',
  'status', 'created_at', 'expires_at', 'started_at', 'ended_at', 'deadline', 'paused_at', 'reason', 'draw_game',
  'revision', 'round_delay_ms', 'groups_json', 'final_refs_json', 'seed_json', 'ranking', 'receipt_json',
  'risk_flags', 'risk_actors', 'escrow', 'settled', 'settled_at', 'shape_version', 'extra'];
 const FIXTURE_COLUMNS = ['room_id', 'fixture_id', 'label', 'round', 'group_id', 'decisive', 'slots_json', 'players',
  'ready', 'status', 'state_json', 'mini_json', 'winner', 'attempt', 'opens_at', 'expires_at', 'ready_deadline',
  'turn_at', 'finished_at', 'banks_json', 'last_move_at', 'move_timings', 'reason', 'history_json', 'revision', 'extra'];

 function roomValues(room) {
  const quote = room.quote === undefined || room.quote === null ? null : room.quote;
  const name = room.name === undefined || room.name === null ? null : jsonText(String(room.name), 'rooms.name');
  return [
   String(room.id), room.code, String(room.owner), name,
   room.format === undefined ? null : room.format, room.table === undefined ? null : room.table,
   room.sequential === true, quote === null ? null : jsonText(quote, 'rooms.quote_json'),
   quote === null || quote.currency === undefined ? null : quote.currency,
   quote === null || quote.entry === undefined ? null : integer(quote.entry, 'rooms.entry'),
   quote === null || quote.pool === undefined ? null : integer(quote.pool, 'rooms.pool'),
   quote === null || quote.burn === undefined ? null : integer(quote.burn, 'rooms.burn'),
   room.clock === undefined ? null : integer(room.clock, 'rooms.clock_seconds'),
   room.increment === undefined ? null : integer(room.increment, 'rooms.increment_seconds'),
   room.capacity === undefined ? null : integer(room.capacity, 'rooms.capacity'),
   room.rulesVersion === undefined ? null : integer(room.rulesVersion, 'rooms.rules_version'),
   room.status, iso(room.created, 'rooms.created_at'), iso(room.expires, 'rooms.expires_at'),
   iso(room.started, 'rooms.started_at'), iso(room.ended, 'rooms.ended_at'), iso(room.deadline, 'rooms.deadline'),
   iso(room.pausedAt, 'rooms.paused_at'), room.reason === undefined ? null : room.reason,
   room.drawGame === undefined ? null : room.drawGame, integer(room.revision || 0, 'rooms.revision'),
   room.roundDelay === undefined ? null : integer(room.roundDelay, 'rooms.round_delay_ms'),
   jsonText(room.groups === undefined ? [] : room.groups, 'rooms.groups_json'),
   room.finalRefs === undefined || room.finalRefs === null ? null : jsonText(room.finalRefs, 'rooms.final_refs_json'),
   room.seed === undefined || room.seed === null ? null : jsonText(room.seed, 'rooms.seed_json'),
   Array.isArray(room.ranking) ? room.ranking.map(String) : [],
   room.receipt === undefined || room.receipt === null ? null : jsonText(room.receipt, 'rooms.receipt_json'),
   Array.isArray(room.riskFlags) ? room.riskFlags.map(String) : [],
   jsonText(room._riskActors === undefined ? {} : room._riskActors, 'rooms.risk_actors'),
   integer(room.escrow || 0, 'rooms.escrow'), room.settled === true,
   iso(room.settledAt, 'rooms.settled_at'),
   room.version === undefined || room.version === null ? null : String(room.version),
   room.extra === undefined || room.extra === null ? null : jsonText(room.extra, 'rooms.extra'),
  ];
 }

 function fixtureValues(room, fixture) {
  return [
   String(room.id), String(fixture.id), fixture.label === undefined ? null : fixture.label,
   fixture.round === undefined ? null : integer(fixture.round, 'fixtures.round'),
   fixture.group === undefined ? null : fixture.group, fixture.decisive === true,
   fixture.slots === undefined ? null : jsonText(fixture.slots, 'fixtures.slots_json'),
   Array.isArray(fixture.players) ? fixture.players.map(String) : [],
   Array.isArray(fixture.ready) ? fixture.ready.map(String) : [],
   fixture.status, fixture.state === undefined || fixture.state === null ? null : jsonText(fixture.state, 'fixtures.state_json'),
   fixture.mini === undefined || fixture.mini === null ? null : jsonText(fixture.mini, 'fixtures.mini_json'),
   fixture.winner === undefined ? null : fixture.winner,
   fixture.attempt === undefined ? null : integer(fixture.attempt, 'fixtures.attempt'),
   iso(fixture.opens, 'fixtures.opens_at'), iso(fixture.expires, 'fixtures.expires_at'),
   iso(fixture.readyDeadline, 'fixtures.ready_deadline'), iso(fixture.turnAt, 'fixtures.turn_at'),
   iso(fixture.finished, 'fixtures.finished_at'),
   fixture.banks === undefined || fixture.banks === null ? null : jsonText(fixture.banks, 'fixtures.banks_json'),
   iso(fixture._lastMoveAt, 'fixtures.last_move_at'),
   fixture._moveTimings === undefined ? null : jsonText(fixture._moveTimings, 'fixtures.move_timings'),
   fixture.reason === undefined ? null : fixture.reason,
   fixture.history === undefined || fixture.history === null ? null : jsonText(fixture.history, 'fixtures.history_json'),
   integer(fixture.revision || 0, 'fixtures.revision'),
   fixture.extra === undefined || fixture.extra === null ? null : jsonText(fixture.extra, 'fixtures.extra'),
  ];
 }

 async function writeRoom(q, room, opts) {
  await q(insertSql('tournament.rooms', ROOM_COLUMNS, ['room_id'], ROOM_COLUMNS.slice(1)), roomValues(room));
  const players = Array.isArray(room.players) ? room.players : [];
  await q('DELETE FROM tournament.room_players WHERE room_id = $1', [String(room.id)]);
  for (let ordinal = 0; ordinal < players.length; ordinal++) {
   const player = players[ordinal];
   await q('INSERT INTO tournament.room_players (room_id, actor_id, name, ready, withdrawn, ordinal) VALUES ($1, $2, $3, $4, $5, $6)',
    [String(room.id), String(player.id), player.name === undefined || player.name === null ? null : jsonText(String(player.name), 'room_players.name'), player.ready === true, player.withdrawn === true, ordinal]);
  }
  const contributions = Array.isArray(room.contributions) ? room.contributions : [];
  await q('DELETE FROM tournament.escrow_contributions WHERE room_id = $1', [String(room.id)]);
  for (const contribution of contributions) {
   if (!(contribution.amount > 0)) continue;
   await q('INSERT INTO tournament.escrow_contributions (room_id, actor_id, amount) VALUES ($1, $2, $3) ON CONFLICT (room_id, actor_id) DO UPDATE SET amount = EXCLUDED.amount',
    [String(room.id), String(contribution.id), integer(contribution.amount, 'escrow.amount')]);
  }
  if (opts.fixtures === false) return;
  const fixtures = Array.isArray(room.fixtures) ? room.fixtures : [];
  await q('DELETE FROM tournament.fixtures WHERE room_id = $1', [String(room.id)]);
  for (const fixture of fixtures) {
   await q(insertSql('tournament.fixtures', FIXTURE_COLUMNS, ['room_id', 'fixture_id'], FIXTURE_COLUMNS.slice(2)), fixtureValues(room, fixture));
  }
 }

module.exports = { pgRepositoriesFor, insertSql, deleteSql, toMs, iso, hashIn, hashOut, keyIn, keyOut, CAP, ACTIVE_ROOM_STATUS };
