/* packages/services/queue.js - V5 P07 distributed candidate queue (V5-07-02/03).
 *
 *   const queue = createQueueService({ ephemera, core, pool, now });
 *   await queue.join({ actor, mode, opKey, region, latencyMs });
 *   await queue.heartbeat({ actor, mode });
 *   await queue.cancel({ actor, opKey });
 *   await queue.status(actor);
 *   await queue.claimCandidates({ mode, limit, matcherId, leaseMs });
 *   await queue.releaseClaim({ mode, actor, requeue });
 *   await queue.matchTick({ mode, matcherId, limit, now, makeId });
 *   await queue.expireAbandoned({ mode, now });
 *   await queue.size();
 *   await queue.close();                       // closes NOTHING borrowed
 *
 * The V5 successor of `server/queue-session.js`: the in-process `tickets` Map becomes a Redis
 * candidate index, the 45 s `seen` staleness becomes a heartbeat lease, the `terminal` Map becomes a
 * bounded operation key. It adds no matching rule: when a pairing is claimed, `searchWindow` and
 * its windows still come from the ONE frozen policy module `packages/domain/matchmaking.js`
 * (V5-07-01) and the pairing decision itself stays in PostgreSQL inside the Core transaction
 * (V5-07-03).
 *
 * DURABLE AUTHORITY. PostgreSQL is the only authority this service reads. `identity.eligibility`
 * decides who may queue, `core.actor_occupancy` decides whether they are already busy, and
 * `match.matches` + `match.participants` decide whether they are already matched. Redis holds three
 * rebuildable facts and nothing else: a candidate index, a heartbeat lease and an operation key. No
 * wallet, reservation, ledger, rating, receipt or ticket is ever written here, and every Redis fact
 * can be dropped without granting a second entry, a second match or a second charge - a wipe makes
 * the system MORE CONSERVATIVE (queued clients rejoin), never more permissive.
 *
 * KEYS (every part goes through `ephemera.key`, i.e. the v2 canonical encoding and the `mx:<env>:`
 * namespace boundary; a part tuple can never collide onto another tuple or another environment):
 *   ephemera.key('queue', <mode>)               ZSET member = ACTOR ID, score = joinedAt ms
 *   ephemera.key('queue', 'ticket', <actor>)   STRING JSON {actor,mode,joinedAt,region,latencyMs,key,games,rating,casualRating}
 *   ephemera.key('queue', 'lease', <actor>)    STRING '1'  (PEXPIRE leaseMs = the liveness fact)
 *   ephemera.key('queue', 'op', <actor>, <k>)  STRING JSON {op,response}   (idempotency, TTL 60 s)
 *   ephemera.key('queue', 'claim', <actor>)    STRING claimId (matcher claim lock, TTL claimTtlMs)
 *   ephemera.key('queue', 'claimed', <mode>)   ZSET member = actor, score = claim expiry ms (gauge)
 *   ephemera.key('queue', 'match', <actor>)    STRING JSON {state:'matched',mode,matchId,termsHash,expires}
 *                                              (the hint `status` polls after a pairing; TTL = the
 *                                              approved offer window, and the durable match row is
 *                                              still what `status` answers with)
 * The index key is EXACTLY the one `ephemera.peekCandidates(mode)` reads (member = actor id), so the
 * bounded candidate index of V5-06-02 and this service are one contract, not two.
 *
 * BOUNDEDNESS. The index is capped at `maxTickets` (default 5000, the legacy `Matchmaker`
 * `maxTickets`; production narrows it to `config.maxQueued`). The LEASE is the legacy 45 s
 * `QueueSession._clean` staleness and is refreshed on every join/heartbeat; the TICKET is the
 * candidate itself and lives `2 x leaseMs`, so liveness is always the SHORTER-lived fact: a client
 * that stops heartbeating loses its lease while its ticket is still readable, which is exactly how
 * `disconnected` is observed and pruned. The op key lives 60 s and the index key itself is refreshed
 * to `2 x leaseMs` on every touch, so an idle queue evaporates instead of accreting. A member whose
 * lease is gone is pruned by `expireAbandoned`, by `heartbeat` (which reports `disconnected`) and by
 * `claimCandidates` (which never returns it).
 *
 * ATOMICITY. Every state transition is ONE Lua script over fully declared KEYS, so two devices
 * joining at once, a cancel racing a claim, and two matchers claiming the same actor cannot
 * interleave: `join` is a create-or-update, `claimCandidates` is a per-actor compare-and-set, and
 * `releaseClaim` compares the claim before it touches the index.
 *
 * FAIL CLOSED. Redis being unreachable must never admit an entrant: `join` refuses with
 * `QUEUE_UNAVAILABLE` (no phantom queued player) and `claimCandidates` refuses too (a matcher must
 * never mistake a dead Redis for an empty queue). Reads degrade instead of throwing: `heartbeat`
 * and `status` report `{state:'disconnected', available:false}` and `expireAbandoned`/`releaseClaim`
 * report `0`/`false`. No Redis call can exceed one 2 s deadline and no timer is left behind.
 *
 * IDEMPOTENCY. `join` and `cancel` take an operation key that is versioned per actor. The response
 * is stored ONCE (SET NX) and every duplicate - the same device retrying, a second device replaying
 * the same intent, a racing pair of identical requests - reads back that stored document, so a
 * duplicate join or cancel is byte-identical and can never create a second entrant or a second
 * paid entry.
 */
'use strict';
const crypto = require('node:crypto');
const D = require('../../src/domain.js');
const P = require('../domain/matchmaking.js');
/* The ONE frozen service principal. It is the durable transaction that commits an assignment, not
 * this service, that decides whether the pairing is legal. */
const { matchmakerPrincipal } = require('../domain/commands.js');

const MODES = Object.freeze(['ranked', 'casual']);
/* Legacy defaults, kept as the defaults of THIS factory: `Matchmaker({maxTickets})` and the 45 s
 * `QueueSession._clean` staleness. */
const DEFAULT_MAX_TICKETS = 5000;
const DEFAULT_LEASE_MS = 45000;
const DEFAULT_CLAIM_TTL_MS = 15000;
/* The ephemeral operation window (a retry/replay of the same op key resolves inside it). */
const OP_TTL_MS = 60000;
/* The index key lives twice as long as the lease it indexes, so a queue that nobody touches
 * evaporates within 90 s while an active one only ever holds lease-backed members. */
const INDEX_TTL_FACTOR = 2;
/* One Redis operation, one deadline: a slow provider fails closed instead of pinning a request. */
const OP_DEADLINE_MS = 2000;
const DEFAULT_CLAIM_LIMIT = 16;
const MAX_CLAIM_LIMIT = 64;
/* A claim scan looks at this multiple of the requested limit so dead members cannot starve a
 * live one out of the returned batch; `expireAbandoned` drains a bounded batch per call. */
const CLAIM_OVERSCAN = 4;
const EXPIRE_BATCH = 64;
const MAX_MATCHER_ID = 64;
const PART_MAX_UNITS = 160;
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
/* The match-result hint a paired client polls. `Policy.offerMinutes` is the approved offer window
 * upper bound (a queue offer itself is shorter) and the key's own expiry always ends the hint; the
 * durable `match.matches` row is the authority, and every poll re-confirms the hint against that row
 * before trusting it. */
const MATCH_CACHE_TTL_MS = D.POLICY.offerMinutes * 60000;
/* The bounded history window `P.compatibility` reads: recent matches only, newest first. The
 * frozen policy's own anti-repeat window is 60 s (ranked) / 18 s (casual), so a day of history is
 * far more than the decision needs; a bounded read is what keeps a long-lived account from
 * pulling its whole record set into one matcher tick. */
const MATCH_HISTORY_WINDOW_MS = D.DAY;
const MATCH_HISTORY_LIMIT = 20;

const fail = (code) => { throw Error(code); };

/* A Redis key part must be the same bounded, well-formed text `ephemera.key` accepts, so a bad
 * actor/op key is refused with THIS service's code instead of the adapter's INVALID_KEY_PART. */
function validPart(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= PART_MAX_UNITS
    && !CONTROL_CHAR.test(value) && value.isWellFormed();
}
function requireActor(actor) { if (!validPart(actor)) fail('INVALID_ACTOR'); return actor; }
function requireMode(mode) { if (!MODES.includes(mode)) fail('INVALID_MODE'); return mode; }
function requireOpKey(opKey) { if (!validPart(opKey)) fail('INVALID_OPERATION_KEY'); return opKey; }
function positiveInt(value, code, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(code);
  return value;
}
const parseJson = (text) => {
  if (typeof text !== 'string' || text.length === 0) return null;
  try { return JSON.parse(text); } catch { return null; }
};
/* The unordered pair identity a refused pairing is booked against for one tick. JSON keeps it
 * unambiguous for ids that already contain a separator character; it is never a Redis key. */
const pairKey = (a, b) => JSON.stringify([a, b].sort());
/* The legacy `Matchmaker._context` clamp, verbatim: a non-finite latency is absent, not zero. */
function normalizeLatency(value) {
  const latency = Number(value);
  return Number.isFinite(latency) ? Math.max(0, Math.min(1000, latency)) : null;
}

/* --------------------------------------------------------------- scripts */

/* Create-or-REJOIN exactly ONE candidate. The existing ticket decides the ORIGINAL join time, so a
 * rejoin from another device preserves FIFO position instead of jumping the queue; only the client
 * context (region/latency/op key) is refreshed. Capacity is the legacy global `tickets.size >=
 * maxTickets` test, taken over both mode indices in the same atomic step and only for a NEW entrant.
 * A member of the OTHER mode index with no ticket (`KEYS[2]` absent) is a phantom left by a client
 * that never heartbeated; it is pruned rather than mistaken for a conflicting live entry, because
 * the ticket - not the index - is what the legacy `tickets` Map was. */
const JOIN_LUA = `
local actor = ARGV[1]
local mode = ARGV[2]
local joinedAt = tonumber(ARGV[3])
local createJson = ARGV[4]
local region = ARGV[5]
local latency = nil
if ARGV[6] ~= 'null' then latency = tonumber(ARGV[6]) end
local opKey = ARGV[7]
local maxTickets = tonumber(ARGV[8])
local leaseMs = ARGV[9]
local indexTtlMs = ARGV[10]
local existing = redis.call('GET', KEYS[2])
local created = '0'
local ticket
if existing then
  local t = cjson.decode(existing)
  if t.mode ~= mode then return {'ALREADY_QUEUED'} end
  t.region = region
  t.latencyMs = latency
  t.key = opKey
  joinedAt = tonumber(t.joinedAt)
  ticket = cjson.encode(t)
else
  if (redis.call('ZCARD', KEYS[1]) + redis.call('ZCARD', KEYS[4])) >= maxTickets then return {'QUEUE_FULL'} end
  redis.call('ZREM', KEYS[4], actor)
  ticket = createJson
  created = '1'
end
redis.call('SET', KEYS[2], ticket, 'PX', indexTtlMs)
redis.call('SET', KEYS[3], '1', 'PX', leaseMs)
redis.call('ZADD', KEYS[1], 'NX', joinedAt, actor)
redis.call('PEXPIRE', KEYS[1], indexTtlMs)
return {'OK', ticket, created}
`;

/* The heartbeat/status read. ARGV[5] === '1' refreshes the lease (heartbeat); otherwise the lease is
 * only observed (status). A ticket without a live lease is an abandoned client: the index member is
 * dropped and the ticket deleted, so it can never become a phantom entrant. */
const TOUCH_LUA = `
local actor = ARGV[1]
local leaseMs = ARGV[2]
local indexTtlMs = ARGV[3]
local refresh = ARGV[4]
local ticket = redis.call('GET', KEYS[3])
if not ticket then
  redis.call('ZREM', KEYS[1], actor)
  redis.call('ZREM', KEYS[2], actor)
  return {'IDLE'}
end
if redis.call('EXISTS', KEYS[4]) == 0 then
  redis.call('ZREM', KEYS[1], actor)
  redis.call('ZREM', KEYS[2], actor)
  redis.call('DEL', KEYS[3])
  return {'DISCONNECTED'}
end
local t = cjson.decode(ticket)
if t.mode == 'casual' then
  redis.call('ZREM', KEYS[1], actor)
  redis.call('ZADD', KEYS[2], 'NX', tonumber(t.joinedAt), actor)
else
  redis.call('ZREM', KEYS[2], actor)
  redis.call('ZADD', KEYS[1], 'NX', tonumber(t.joinedAt), actor)
end
if refresh == '1' then
  redis.call('SET', KEYS[4], '1', 'PX', leaseMs)
  redis.call('PEXPIRE', KEYS[3], indexTtlMs)
  redis.call('PEXPIRE', KEYS[1], indexTtlMs)
  redis.call('PEXPIRE', KEYS[2], indexTtlMs)
end
return {'OK', ticket}
`;

/* Remove every trace of a queued candidate (index member, ticket, lease, claim lock). Returns
 * CANCELLED only when a ticket actually existed, so `cancel` can distinguish the legacy
 * `{state:'cancelled'}` from `{state:'idle'}` without a second round trip. */
const CANCEL_LUA = `
local actor = ARGV[1]
local indexTtlMs = ARGV[2]
local ticket = redis.call('GET', KEYS[5])
redis.call('DEL', KEYS[7])
if not ticket then
  redis.call('ZREM', KEYS[1], actor)
  redis.call('ZREM', KEYS[2], actor)
  return {'IDLE'}
end
local t = cjson.decode(ticket)
if t.mode == 'casual' then
  redis.call('ZREM', KEYS[2], actor)
  redis.call('ZREM', KEYS[4], actor)
else
  redis.call('ZREM', KEYS[1], actor)
  redis.call('ZREM', KEYS[3], actor)
end
redis.call('DEL', KEYS[5])
redis.call('DEL', KEYS[6])
redis.call('PEXPIRE', KEYS[1], indexTtlMs)
redis.call('PEXPIRE', KEYS[2], indexTtlMs)
return {'CANCELLED'}
`;

/* Claim a batch. Per candidate: the ticket must exist AND its lease must be alive (a dead client is
 * never handed to a matcher), and the per-actor claim lock is taken with SET NX so the same actor
 * can be claimed by exactly ONE matcher. The member is NEVER removed from the index here - the
 * candidate keeps its original `joinedAt` score, keeps heartbeating, and can be requeued verbatim.
 * An index member with no ticket (or no lease) is dropped as a phantom. */
const CLAIM_LUA = `
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local matcherId = ARGV[3]
local claimTtl = tonumber(ARGV[4])
local indexTtl = tonumber(ARGV[5])
local nonce = ARGV[6]
local now = tonumber(ARGV[7])
local out = {}
for i = 1, n do
  local actor = ARGV[7 + i]
  local ticketKey = KEYS[2 + (i - 1) * 3 + 1]
  local leaseKey = KEYS[2 + (i - 1) * 3 + 2]
  local claimKey = KEYS[2 + (i - 1) * 3 + 3]
  local raw = redis.call('GET', ticketKey)
  if raw and redis.call('EXISTS', leaseKey) == 1 then
    if redis.call('GET', claimKey) == false then
      if #out < limit then
        local claimId = matcherId .. ':' .. nonce .. ':' .. i
        redis.call('SET', claimKey, claimId, 'PX', claimTtl)
        redis.call('ZADD', KEYS[2], now + claimTtl, actor)
        local t = cjson.decode(raw)
        t.claimId = claimId
        out[#out + 1] = cjson.encode(t)
      end
    end
  else
    redis.call('ZREM', KEYS[1], actor)
  end
end
redis.call('PEXPIRE', KEYS[1], indexTtl)
redis.call('PEXPIRE', KEYS[2], indexTtl)
return out
`;

/* Claim-owner fencing: a timed-out matcher must never delete/requeue/drop a
 * newly-claimed actor's state. Check the opaque claimId FIRST, then mutate. */
const RELEASE_LUA = `
local actor = ARGV[1]
local requeue = ARGV[2]
local indexTtl = ARGV[3]
local claimId = ARGV[4]
if redis.call('GET', KEYS[3]) ~= claimId then return {'0'} end
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[2], actor)
if requeue == '1' then
  if not redis.call('GET', KEYS[4]) then redis.call('ZREM', KEYS[1], actor) end
else
  redis.call('ZREM', KEYS[1], actor)
  redis.call('DEL', KEYS[4])
  redis.call('DEL', KEYS[5])
end
redis.call('PEXPIRE', KEYS[1], indexTtl)
redis.call('PEXPIRE', KEYS[2], indexTtl)
return {'1'}
`;

/* Drop the batch of candidates whose heartbeat lease is gone (a dead client must not linger as a
 * phantom entrant). Bounded by the batch the caller passed, so one call can never hold the whole
 * queue in a script body; the caller's `now` also prunes this mode's expired claim gauge. */
const EXPIRE_LUA = `
local n = tonumber(ARGV[1])
local indexTtl = tonumber(ARGV[2])
local at = ARGV[3]
local expired = 0
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', at)
for i = 1, n do
  local actor = ARGV[3 + i]
  local ticketKey = KEYS[3 + (i - 1) * 2]
  local leaseKey = KEYS[3 + (i - 1) * 2 + 1]
  if not redis.call('GET', ticketKey) or redis.call('EXISTS', leaseKey) == 0 then
    redis.call('ZREM', KEYS[1], actor)
    redis.call('DEL', ticketKey)
    redis.call('DEL', leaseKey)
    expired = expired + 1
  end
end
redis.call('PEXPIRE', KEYS[1], indexTtl)
return expired
`;

/* Queue gauge. `claimed` is a live count: expired claim entries are pruned by score first. */
const SIZE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[1])
return {redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2]),
  redis.call('ZCARD', KEYS[3]) + redis.call('ZCARD', KEYS[4])}
`;

/* --------------------------------------------------------------- factory */

function createQueueService(options = {}) {
  const ephemera = options.ephemera;
  const core = options.core;
  const pool = options.pool;
  /* The borrowed adapter must be able to NAME a key and RUN a command; anything less cannot store
   * the index this service owns, so it is refused before a single candidate is accepted. */
  if (!ephemera || typeof ephemera.key !== 'function' || typeof ephemera.client !== 'object') fail('EPHEMERA_REQUIRED');
  /* Core owns the OFFERED/DECLINED transition of a match; the queue never mutates match state. */
  if (!core || typeof core.run !== 'function') fail('CORE_REQUIRED');
  /* PostgreSQL is the eligibility/occupancy/match authority. */
  if (!pool || typeof pool.withTransaction !== 'function') fail('PG_POOL_REQUIRED');
  if (options.now !== undefined && typeof options.now !== 'function') fail('CLOCK_REQUIRED');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxTickets = options.maxTickets === undefined ? DEFAULT_MAX_TICKETS : positiveInt(options.maxTickets, 'INVALID_MAX_TICKETS');
  const leaseMs = options.leaseMs === undefined ? DEFAULT_LEASE_MS : positiveInt(options.leaseMs, 'INVALID_LEASE');
  const claimTtlMs = options.claimTtlMs === undefined ? DEFAULT_CLAIM_TTL_MS : positiveInt(options.claimTtlMs, 'INVALID_CLAIM_TTL');
  const indexTtlMs = leaseMs * INDEX_TTL_FACTOR;

  let closed = false;

  /* ---- naming: every key is namespaced and v2-encoded by the borrowed adapter ---- */
  const indexKey = (mode) => ephemera.key('queue', mode);
  const ticketKey = (actor) => ephemera.key('queue', 'ticket', actor);
  const leaseKey = (actor) => ephemera.key('queue', 'lease', actor);
  const opKeyFor = (actor, opKey) => ephemera.key('queue', 'op', actor, opKey);
  const claimKey = (actor) => ephemera.key('queue', 'claim', actor);
  const claimedKey = (mode) => ephemera.key('queue', 'claimed', mode);
  const otherMode = (mode) => (mode === 'ranked' ? 'casual' : 'ranked');

  /* One Redis operation, one deadline. `{ok:false}` is the ONLY failure shape: an unreachable Redis
   * is never a business verdict, and the caller decides which conservative answer it means. A
   * rejection (offline queue disabled, socket gone) resolves identically to a timeout. */
  async function callRedis(fn) {
    if (closed) fail('QUEUE_CLOSED');
    const client = ephemera.client;
    const work = (async () => {
      /* The adapter's own bounded connect promise: a command issued during the connect window waits
       * for it instead of failing on a spurious "offline queue disabled" rejection. */
      const connected = ephemera.connected;
      if (connected && typeof connected.then === 'function') await connected;
      return fn(client);
    })();
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false }), OP_DEADLINE_MS); });
    try {
      return await Promise.race([work.then((value) => ({ ok: true, value }), () => ({ ok: false })), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- the operation key: the ONLY cross-device deduplication ---- */
  /* The response is stored ONCE (SET NX) and every duplicate reads that stored document back, so a
   * replay is byte-identical even when two devices race the same op key. */
  async function cacheOperation(cacheKey, op, response) {
    const payload = JSON.stringify({ op, response });
    const result = await callRedis(async (client) => {
      await client.sendCommand(['SET', cacheKey, payload, 'PX', String(OP_TTL_MS), 'NX']);
      return client.get(cacheKey);
    });
    if (!result.ok) return response;
    const row = parseJson(result.value);
    return row && row.op === op ? row.response : response;
  }
  async function readOperation(cacheKey, op) {
    const result = await callRedis((client) => client.get(cacheKey));
    if (!result.ok) return null;
    const row = parseJson(result.value);
    return row && row.op === op ? row.response : null;
  }

  /* ---- the response shape (exactly the legacy `Matchmaker.status` for a waiting ticket) ---- */
  function searching(ticket) {
    const wait = P.sec(ticket, now());
    return {
      state: 'searching',
      mode: ticket.mode,
      joinedAt: ticket.joinedAt,
      waitSeconds: Math.floor(wait),
      window: P.searchWindow(ticket.mode, wait, {
        games: ticket.games ?? 0,
        rating: ticket.rating ?? 0,
        casualRating: ticket.casualRating ?? 1000,
      }),
    };
  }
  /* The claim gauge carries a score per actor, so the adapter's no-immortal-keys audit can see it -
   * it is written only inside the claim script and pruned by score in `size`/`expireAbandoned`. */

  /* ---- PostgreSQL: eligibility, occupancy and the live match ---- */
  const ACCOUNT_SQL = 'SELECT e.verified, e.suspended, e.security_hold,'
    + ' r.rating, r.games, r.casual_rating, o.kind AS occupancy_kind'
    + ' FROM identity.actors a'
    + ' LEFT JOIN identity.eligibility e ON e.actor_id = a.actor_id'
    + ' LEFT JOIN economy.ratings r ON r.actor_id = a.actor_id'
    + ' LEFT JOIN core.actor_occupancy o ON o.actor_id = a.actor_id'
    + ' WHERE a.actor_id = $1';
  /* The legacy admission test, unchanged: verified, not suspended, not held, not already occupied. */
  async function readAdmission(actor) {
    return pool.withTransaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const result = await tx.query(ACCOUNT_SQL, [actor]);
      const row = result.rows[0];
      if (!row) fail('INELIGIBLE');
      if (row.verified !== true || row.suspended === true || row.security_hold === true || row.occupancy_kind !== null) fail('INELIGIBLE');
      return {
        games: Number(row.games || 0),
        rating: row.rating === null || row.rating === undefined ? 0 : Number(row.rating),
        casualRating: row.casual_rating === null || row.casual_rating === undefined ? 1000 : Number(row.casual_rating),
      };
    });
  }
  /* An actor is occupied by at most one match (core.actor_occupancy is the single-active-aggregate
   * row), so the newest live match is THE match. */
  const LIVE_MATCH_SQL = 'SELECT m.match_id, m.status, m.source, m.mode, m.kind, m.terms_hash, m.expires_at'
    + ' FROM match.matches m JOIN match.participants p ON p.match_id = m.match_id'
    + " WHERE p.actor_id = $1 AND m.status IN ('OFFERED', 'PLAYING')"
    + ' ORDER BY m.created_at DESC, m.match_id LIMIT 1';
  async function readLiveMatch(actor) {
    return pool.withTransaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const result = await tx.query(LIVE_MATCH_SQL, [actor]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        matchId: row.match_id,
        status: row.status,
        /* The queue mode an OFFERED/PLAYING queue match carries is its `kind` ('ranked'|'casual');
         * a direct/party match carries the queue mode as 'direct'. */
        mode: row.source === 'queue' ? row.kind : row.mode,
        termsHash: row.terms_hash,
        expires: row.expires_at === null ? null : new Date(row.expires_at).getTime(),
      };
    });
  }

  /* ---- PostgreSQL: the matcher hydration (V5-07-03) ---- */

  /* One row per claimed actor, carrying exactly what the frozen policy and the ranked quote read
   * through `Authority.account`: eligibility flags, rating, wallet and the active aggregate. There
   * is no wallet JOIN, so a wallet-less account hydrates as zero coins - the truth - instead of
   * `ACCOUNT_REQUIRED`, which belongs to the Core transaction's readiness gate and not to a
   * matchmaker's read. */
  const HYDRATE_SQL = 'SELECT a.actor_id, e.verified, e.suspended, e.security_hold,'
    + ' r.rating, r.games, r.casual_rating, r.casual_games, r.tier,'
    + ' w.coins, w.crowns, o.kind AS occupancy_kind, o.ref_id AS occupancy_ref'
    + ' FROM identity.actors a'
    + ' LEFT JOIN identity.eligibility e ON e.actor_id = a.actor_id'
    + ' LEFT JOIN economy.ratings r ON r.actor_id = a.actor_id'
    + ' LEFT JOIN economy.wallets w ON w.actor_id = a.actor_id'
    + ' LEFT JOIN core.actor_occupancy o ON o.actor_id = a.actor_id'
    + ' WHERE a.actor_id = ANY($1::text[])';
  const FRIENDSHIP_SQL = 'SELECT actor_a, actor_b FROM social.friendships'
    + ' WHERE actor_a = ANY($1::text[]) OR actor_b = ANY($1::text[])';
  const BLOCK_SQL = 'SELECT blocker_id, blocked_id FROM social.blocks'
    + ' WHERE blocker_id = ANY($1::text[]) OR blocked_id = ANY($1::text[])';
  /* RECENT matches only, newest first, bounded PER ACTOR by a window function: the ONE read
   * `P.compatibility` needs (`history` for its `recentPair` anti-repeat rule), never the whole record
   * set. A single global LIMIT would starve most of the batch, so the bound is applied inside each
   * actor's partition. */
  const RECENT_HISTORY_SQL = 'SELECT actor_id, match_id, at, opponent, mode, queue, rated FROM ('
    + ' SELECT actor_id, match_id, (extract(epoch from at) * 1000)::bigint AS at, opponent, mode, queue,'
    + ' rated, row_number() OVER (PARTITION BY actor_id ORDER BY at DESC, match_id) AS rn'
    + ' FROM economy.match_history WHERE actor_id = ANY($1::text[]) AND at >= $2'
    + ') ranked WHERE ranked.rn <= $3 ORDER BY ranked.actor_id, ranked.rn LIMIT $4';
  /* The active aggregate for ONE actor, re-read by the failure path: `occupied` is a match accepted
   * elsewhere or a tournament claim, `refused` a permanent eligibility flag, `missing` a deleted
   * actor row. */
  const ADMISSION_STATE_SQL = 'SELECT e.verified, e.suspended, e.security_hold, o.kind AS occupancy_kind'
    + ' FROM identity.actors a'
    + ' LEFT JOIN identity.eligibility e ON e.actor_id = a.actor_id'
    + ' LEFT JOIN core.actor_occupancy o ON o.actor_id = a.actor_id'
    + ' WHERE a.actor_id = $1';

  const numberOr = (value, fallback) => (value === null || value === undefined ? fallback : Number(value));
  const msOr = (value) => (value === null || value === undefined ? null : new Date(value).getTime());

  /* The `Authority.account` shape, projected from durable rows: the fields the frozen policy reads
   * (id/rating/casualRating/games/verified/suspended/hold/activeMatch/friends/blocked/history) plus
   * the wallet the ranked quote charges. */
  function hydrateAccount(row, friends, blocked, history) {
    const rating = numberOr(row.rating, 0);
    return {
      id: row.actor_id,
      rating,
      casualRating: numberOr(row.casual_rating, 1000),
      casualGames: numberOr(row.casual_games, 0),
      games: numberOr(row.games, 0),
      /* Never read by the policy or the quote (both derive the tier from the rating through the
       * pure domain); the persisted column is carried for shape fidelity. */
      tier: row.tier === null || row.tier === undefined ? D.basicTier(rating).id : row.tier,
      verified: row.verified === true,
      suspended: row.suspended === true,
      hold: row.security_hold === true,
      /* The legacy `activeMatch` string: the aggregate family, then its reference. */
      activeMatch: row.occupancy_kind
        ? (row.occupancy_kind === 'tournament' ? `tournament:${row.occupancy_ref}` : row.occupancy_ref)
        : null,
      friends, blocked, history,
      coins: numberOr(row.coins, 0), crowns: numberOr(row.crowns, 0),
    };
  }

  /* Hydrate every claimed actor in ONE bounded read-only transaction. A claimed actor whose row is
   * gone is simply absent from the map - the caller pairs around it and keeps its FIFO seat. A read
   * failure is NOT swallowed: without durable truth a matcher must not pair, and the caller releases
   * its claims rather than pairing blind. `at` is the tick's own clock, so the recent-history window
   * is computed from one instant for the whole tick. */
  async function readAccounts(actors, at) {
    const ids = [...new Set(actors)].filter(validPart);
    if (ids.length === 0) return new Map();
    return pool.withTransaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const rows = (await tx.query(HYDRATE_SQL, [ids])).rows;
      const friends = new Map(ids.map((id) => [id, []]));
      const blocked = new Map(ids.map((id) => [id, []]));
      const history = new Map(ids.map((id) => [id, []]));
      for (const row of (await tx.query(FRIENDSHIP_SQL, [ids])).rows) {
        friends.get(row.actor_a)?.push(row.actor_b);
        friends.get(row.actor_b)?.push(row.actor_a);
      }
      for (const row of (await tx.query(BLOCK_SQL, [ids])).rows) blocked.get(row.blocker_id)?.push(row.blocked_id);
      const since = new Date(at - MATCH_HISTORY_WINDOW_MS);
      const historyCap = MATCH_HISTORY_LIMIT * ids.length + 1;
      for (const row of (await tx.query(RECENT_HISTORY_SQL, [ids, since, MATCH_HISTORY_LIMIT, historyCap])).rows) {
        history.get(row.actor_id)?.push({
          id: row.match_id, at: Number(row.at), opponent: row.opponent, mode: row.mode,
          queue: row.queue === true, rated: row.rated === true,
        });
      }
      const accounts = new Map();
      for (const row of rows) {
        accounts.set(row.actor_id, hydrateAccount(
          row, friends.get(row.actor_id) || [], blocked.get(row.actor_id) || [], history.get(row.actor_id) || [],
        ));
      }
      return accounts;
    });
  }

  async function readAdmissionState(actor) {
    return pool.withTransaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const row = (await tx.query(ADMISSION_STATE_SQL, [actor])).rows[0];
      if (!row) return { missing: true, occupied: false, refused: false };
      return {
        missing: false,
        occupied: row.occupancy_kind !== null,
        refused: row.verified !== true || row.suspended === true || row.security_hold === true,
      };
    });
  }

  /* ---- the match-result hint (Redis, rebuildable) ---- */
  const matchKey = (actor) => ephemera.key('queue', 'match', actor);
  /* A paired client's poll is answered from this hint instead of a participant lookup, but the
   * DURABLE match row stays the authority: a hint naming a match the durable store does not (or no
   * longer) reports live is DISCARDED and the hint re-confirmed once against `match_id`. */
  async function readMatchHint(actor) {
    const result = await callRedis((client) => client.get(matchKey(actor)));
    if (!result.ok) return null;
    const row = parseJson(result.value);
    if (!row || row.state !== 'matched' || typeof row.matchId !== 'string' || !row.matchId) return null;
    return row;
  }
  const clearMatchHint = (actor) => callRedis((client) => client.del(matchKey(actor)));
  /* Redis hints are not authorization. A client can only resolve a hinted
   * match if PostgreSQL confirms the requesting actor occupies one of its
   * durable participant seats. Checking match_id alone leaks an unrelated
   * live match when Redis contains a stale or malformed actor hint. */
  const MATCH_BY_ID_SQL = 'SELECT m.status, m.source, m.mode, m.kind, m.terms_hash, m.expires_at'
    + ' FROM match.matches m JOIN match.participants p ON p.match_id = m.match_id'
    + ' WHERE m.match_id = $1 AND p.actor_id = $2';
  async function readMatchById(matchId, actor) {
    return pool.withTransaction(async (tx) => {
      await tx.query('SET TRANSACTION READ ONLY');
      const row = (await tx.query(MATCH_BY_ID_SQL, [matchId, actor])).rows[0];
      if (!row) return null;
      return {
        matchId,
        status: row.status,
        mode: row.source === 'queue' ? row.kind : row.mode,
        termsHash: row.terms_hash,
        expires: msOr(row.expires_at),
      };
    });
  }
  /* Best-effort AFTER the durable commit: a paired client that misses the hint still reads the
   * committed match, so a failed write costs one extra durable read and nothing else. */
  async function cacheMatch(pairing) {
    const payload = JSON.stringify({
      state: 'matched', mode: pairing.mode, matchId: pairing.matchId,
      termsHash: pairing.termsHash, expires: pairing.expires,
    });
    await Promise.all([pairing.a, pairing.b].map((actor) => callRedis((client) => client.set(
      matchKey(actor), payload, { PX: MATCH_CACHE_TTL_MS },
    ))));
  }

  /* ---- V5-07-03: the matcher tick ---- */

  /* Every durable refusal a pairing can answer with WITHOUT a committed effect. ALREADY_IN_MATCH is
   * the race this method exists for: an actor accepted another match (or a direct invite, or a
   * tournament entry) between hydration and the commit. RATED_PAIR_LIMIT is the frozen daily
   * queue-pair budget; INELIGIBLE is a flag that changed under us. PENDING_INVITATION is a LIVE
   * OFFER already linking the pair and DUPLICATE_OR_INVALID_MATCH is the same match id already
   * committed - both are what two matchers paired on the same two actors see when they race. Each is
   * a verdict about a participant or a pair, not a service fault: each rolls back whole, each is
   * handled, none is ever rethrown. A code outside this set is a genuine fault and DOES propagate. */
  const PAIR_REFUSALS = Object.freeze([
    'ALREADY_IN_MATCH', 'RATED_PAIR_LIMIT', 'INELIGIBLE', 'PENDING_INVITATION', 'DUPLICATE_OR_INVALID_MATCH',
  ]);
  const TURN_SECONDS = Object.freeze({ ranked: 30, casual: 60 });

  /* Decide from DURABLE truth whether a seat may be destroyed. `requeue: false` (the candidate
   * leaves the index for good) is justified ONLY for an actor that is now occupied, is permanently
   * refused, or no longer exists. Anything else - including a state that could not be re-read - is
   * given back with its ORIGINAL FIFO score: an actor must never be dropped from the queue on a
   * guess, because a destroyed seat is not recoverable. */
  async function faultedActors(actors) {
    const faulted = new Set();
    await Promise.all(actors.map(async (actor) => {
      let state;
      try { state = await readAdmissionState(actor); } catch { return; }
      if (state.missing || state.occupied || state.refused) faulted.add(actor);
    }));
    return faulted;
  }

  /* The best compatible partner for `ta` among the still-unpaired claims. Pure search over the
   * hydrated accounts: the frozen policy decides eligibility and quality, the ranked quote decides
   * whether the pair could ever be paid for, and the oldest candidate wins a score tie. */
  function bestPartnerFor(ta, A, at, mode, remaining, accounts, refusedPairs) {
    let best = null;
    for (const tb of remaining) {
      if (tb.actor === ta.actor || refusedPairs.has(pairKey(ta.actor, tb.actor))) continue;
      const B = accounts.get(tb.actor);
      if (!B) continue;
      const compatibility = P.compatibility(A, B, ta, tb, mode, at);
      if (!compatibility.ok) continue;
      /* The ranked entry fee, quoted by the pure domain and charged by Core on acceptance. A player
       * who cannot pay is not a partner at all: the pair is never offered, so an illegal match can
       * never be created and nothing is ever charged here. */
      if (mode === 'ranked') {
        const fee = D.quote({ mode: 'ranked', from: D.basicTier(A.rating).id, to: D.basicTier(B.rating).id }).fee;
        if (A.coins < fee || B.coins < fee) continue;
      }
      if (best === null
        || compatibility.score < best.compatibility.score
        || (compatibility.score === best.compatibility.score && tb.joinedAt < best.candidate.joinedAt)) {
        best = { candidate: tb, compatibility };
      }
    }
    return best;
  }

  /* ONE matcher tick: claim, hydrate, pair, commit. A pairing IS a durable Core transaction (the
   * `queue` command under the frozen service principal), so two matchers racing the same actors can
   * commit AT MOST ONE assignment - the loser serializes on the aggregate identity / occupancy
   * locks inside its own transaction, sees the winner's committed state and rolls back whole with
   * ALREADY_IN_MATCH, leaving no match row, no participant, no journal entry and no outbox row. This
   * method adds no matching rule: the frozen policy decides compatibility and the ranked quote, Core
   * decides legality, and Redis only decides which matcher is handed which candidate.
   *
   * FIFO: the claim already took the oldest `limit` candidates from the index, the oldest unpaired
   * candidate picks first, score ties go to the older candidate, and every unpaired claim is
   * returned with `requeue: true` so its original index score - its place in the queue - survives
   * the tick untouched. A refused pairing costs the pair ONE attempt and then the older candidate
   * carries on with its next-best partner, so a single bad seat cannot waste an older client's turn.
   */
  async function matchTick(input = {}) {
    const mode = requireMode(input.mode);
    const limit = input.limit === undefined ? DEFAULT_CLAIM_LIMIT : positiveInt(input.limit, 'INVALID_LIMIT', MAX_CLAIM_LIMIT);
    const matcherId = input.matcherId;
    if (!validPart(matcherId) || matcherId.length > MAX_MATCHER_ID) fail('INVALID_MATCHER');
    const clock = input.now === undefined ? now : input.now;
    if (typeof clock !== 'function') fail('CLOCK_REQUIRED');
    const makeId = input.makeId === undefined ? () => crypto.randomUUID() : input.makeId;
    if (typeof makeId !== 'function') fail('ID_FACTORY_REQUIRED');

    const claimed = (await claimCandidates({ mode, limit, matcherId }))
      .sort((x, y) => x.joinedAt - y.joinedAt || String(x.actor).localeCompare(String(y.actor)));

    /* A claim locks exactly ONE candidate, so a batch that cannot pair is handed straight back
     * instead of being held across ticks. */
    if (claimed.length < 2) {
      for (const candidate of claimed) await releaseClaim({
        mode, actor: candidate.actor, claimId: candidate.claimId, requeue: true,
      });
      return { matched: 0, pairings: [] };
    }

    /* Durable truth BEFORE any pairing decision. `remaining` starts as a superset of the actors that
     * still have a durable account, so an actor hydrated from neither this read nor the failure
     * re-read keeps its seat instead of being destroyed on an absence of evidence. */
    const remaining = claimed.slice();
    const at = clock();
    let accounts;
    try {
      accounts = await readAccounts(claimed.map((candidate) => candidate.actor), at);
    } catch (error) {
      /* No Core command was sent yet. Return the still-owned claims immediately
       * instead of needlessly holding live entrants until the claim TTL if the
       * database read fails. A stale claimId cannot affect a new matcher. */
      await Promise.allSettled(claimed.map((candidate) => releaseClaim({
        mode, actor: candidate.actor, claimId: candidate.claimId, requeue: true,
      })));
      throw error;
    }
    const pairings = [];
    const refusedPairs = new Set();

    for (const ta of claimed) {
      if (!remaining.includes(ta)) continue;
      const A = accounts.get(ta.actor);
      if (!A) continue;
      /* At most one attempt per possible partner: a refusal is booked against THIS pair, so a
       * persistent verdict (a live offer between these two, a spent rated-pair budget) is never
       * re-litigated in a loop. */
      for (let attempt = 0; attempt < remaining.length; attempt += 1) {
        const best = bestPartnerFor(ta, A, at, mode, remaining, accounts, refusedPairs);
        /* No compatible partner left: this candidate keeps its FIFO seat for a later tick. */
        if (best === null) break;
        const tb = best.candidate;
        const matchId = `queue:${makeId()}`;
        let match;
        try {
          match = await core.run(matchmakerPrincipal(), `pair:${matchId}`, {
            type: 'queue', id: matchId, a: ta.actor, b: tb.actor, mode, turnSeconds: TURN_SECONDS[mode],
          });
        } catch (error) {
          const code = error && error.message;
          if (typeof code !== 'string' || !PAIR_REFUSALS.includes(code)) throw error;
          /* Nothing committed: Core rolled the whole transaction back. Destroy only the seats
           * durable truth justifies and give every other seat back with its original score. */
          refusedPairs.add(pairKey(ta.actor, tb.actor));
          const faulted = await faultedActors([ta.actor, tb.actor]);
          for (const actor of faulted) {
            const owned = claimed.find((candidate) => candidate.actor === actor);
            if (owned) await releaseClaim({ mode, actor, claimId: owned.claimId, requeue: false });
            accounts.delete(actor);
            const index = remaining.findIndex((candidate) => candidate.actor === actor);
            if (index >= 0) remaining.splice(index, 1);
          }
          /* The older candidate itself was the faulty seat: it is gone, nothing left to pair. */
          if (!remaining.includes(ta)) break;
          continue;
        }
        await releaseClaim({ mode, actor: ta.actor, claimId: ta.claimId, requeue: false });
        await releaseClaim({ mode, actor: tb.actor, claimId: tb.claimId, requeue: false });
        const pairing = { a: ta.actor, b: tb.actor, matchId, mode, termsHash: match.termsHash, expires: match.expires };
        pairings.push(pairing);
        await cacheMatch(pairing);
        remaining.splice(remaining.indexOf(ta), 1);
        remaining.splice(remaining.indexOf(tb), 1);
        break;
      }
    }

    /* Everything claimed but not paired keeps its queue position. */
    for (const candidate of remaining) await releaseClaim({
      mode, actor: candidate.actor, claimId: candidate.claimId, requeue: true,
    });
    return { matched: pairings.length, pairings };
  }

  /* The one place this service asks Core to change durable match state: an OFFERED offer is
   * DECLINED through the frozen command dispatcher. The op key is derived from the match, so a
   * concurrent cancel of the same match is a replay (and a match already declined by the opponent
   * is a no-op, not an error). */
  const DECLINE_RACES = Object.freeze(['CANNOT_DECLINE', 'NOT_OPEN', 'UNKNOWN_MATCH', 'NOT_PARTICIPANT']);
  async function declineOffer(actor, matchId) {
    try {
      await core.run({ actor, scope: 'player' }, `decline:${matchId}`.slice(0, PART_MAX_UNITS), { type: 'decline', id: matchId });
    } catch (error) {
      const code = error && error.message;
      if (typeof code === 'string' && DECLINE_RACES.includes(code)) return;
      throw error;
    }
  }

  /* ---- Redis state ---- */

  /* Create or rejoin the candidate. `opKey` doubles as the ticket's context key so a claim can be
   * tied back to the intent that produced it. */
  async function join(input = {}) {
    const actor = requireActor(input.actor);
    const mode = requireMode(input.mode);
    const opKey = requireOpKey(input.opKey);
    const region = P.normalizedRegion(input.region);
    const latencyMs = normalizeLatency(input.latencyMs);
    const cacheKey = opKeyFor(actor, opKey);
    /* A duplicate join (same device retry, second device, racing pair) never reaches PostgreSQL or
     * the index twice: the stored response IS the answer. */
    const cached = await readOperation(cacheKey, 'join');
    if (cached !== null) return cached;
    const admission = await readAdmission(actor);
    const joinedAt = now();
    const ticket = {
      actor, mode, joinedAt, region, latencyMs, key: opKey,
      games: admission.games, rating: admission.rating, casualRating: admission.casualRating,
    };
    const result = await callRedis((client) => client.sendCommand(['EVAL', JOIN_LUA, '4',
      indexKey(mode), ticketKey(actor), leaseKey(actor), indexKey(otherMode(mode)),
      actor, mode, String(joinedAt), JSON.stringify(ticket), region,
      latencyMs === null ? 'null' : String(latencyMs),
      opKey, String(maxTickets), String(leaseMs), String(indexTtlMs)]));
    /* Redis unreachable: refuse rather than admit a player the index cannot hold. */
    if (!result.ok) fail('QUEUE_UNAVAILABLE');
    const reply = result.value;
    const code = String(reply[0]);
    if (code === 'ALREADY_QUEUED') fail('ALREADY_QUEUED');
    if (code === 'QUEUE_FULL') fail('QUEUE_FULL');
    const stored = parseJson(reply[1]);
    if (!stored) fail('QUEUE_UNAVAILABLE');
    return cacheOperation(cacheKey, 'join', searching(stored));
  }

  /* The client is alive: refresh the lease. A candidate whose lease is already gone is reported as
   * `disconnected` and purged, which is exactly the legacy 45 s `_clean` staleness. */
  async function heartbeat(input = {}) {
    const actor = requireActor(input.actor);
    if (input.mode !== undefined && input.mode !== null) requireMode(input.mode);
    const result = await callRedis((client) => client.sendCommand(['EVAL', TOUCH_LUA, '4',
      indexKey('ranked'), indexKey('casual'), ticketKey(actor), leaseKey(actor),
      actor, String(leaseMs), String(indexTtlMs), '1']));
    if (!result.ok) return { state: 'disconnected', available: false };
    const code = String(result.value[0]);
    if (code === 'IDLE') return { state: 'idle' };
    if (code === 'DISCONNECTED') return { state: 'disconnected' };
    const ticket = parseJson(result.value[1]);
    if (!ticket) return { state: 'disconnected' };
    return searching(ticket);
  }

  /* Leave the queue, or decline the OFFERED offer that replaced the queue entry. Idempotent on the
   * operation key when one is supplied. */
  async function cancel(input = {}) {
    const actor = requireActor(input.actor);
    const opKey = input.opKey === undefined || input.opKey === null ? null : requireOpKey(input.opKey);
    const cacheKey = opKey === null ? null : opKeyFor(actor, opKey);
    if (cacheKey !== null) {
      const cached = await readOperation(cacheKey, 'cancel');
      if (cached !== null) return cached;
    }
    /* Durable truth first: a committed match outranks any ephemeral queue entry. */
    const live = await readLiveMatch(actor);
    let response;
    if (live !== null && live.status === 'PLAYING') {
      response = { state: 'playing', matchId: live.matchId };
    } else if (live !== null) {
      await declineOffer(actor, live.matchId);
      await clearQueued(actor);
      response = { state: 'cancelled' };
    } else {
      const cleared = await clearQueued(actor);
      /* A cancel that could not be proved (Redis unreachable) must not claim success. */
      if (!cleared.ok) return { state: 'disconnected', available: false };
      response = { state: cleared.value ? 'cancelled' : 'idle' };
    }
    /* An unchanged `idle` is not a state transition, so it is reported as-is rather than cached. */
    if (response.state === 'idle' || cacheKey === null) return response;
    return cacheOperation(cacheKey, 'cancel', response);
  }

  /* Drop every ephemeral trace of `actor`. Returns `{ok}` (whether Redis answered) and
   * `{value}` (whether a queued candidate was actually removed). */
  async function clearQueued(actor) {
    const result = await callRedis((client) => client.sendCommand(['EVAL', CANCEL_LUA, '8',
      indexKey('ranked'), indexKey('casual'), claimedKey('ranked'), claimedKey('casual'),
      ticketKey(actor), leaseKey(actor), claimKey(actor), matchKey(actor), actor, String(indexTtlMs)]));
    if (!result.ok) return { ok: false, value: false };
    return { ok: true, value: String(result.value[0]) === 'CANCELLED' };
  }

  /* The one read a client polls: a durable match first, then the ephemeral queue entry. */
  async function status(actor) {
    const id = requireActor(typeof actor === 'string' ? actor : actor && actor.actor);
    /* A match hint from a just-committed pairing shortens the poll path. It is a HINT: the durable
     * match row is still confirmed (one targeted read, narrower than the participant read) and a
     * hint the durable store does not confirm as live is discarded. */
    const hint = await readMatchHint(id);
    if (hint !== null) {
      const confirmed = await readMatchById(hint.matchId, id);
      if (confirmed !== null && (confirmed.status === 'OFFERED' || confirmed.status === 'PLAYING')) {
        return { state: 'matched', mode: confirmed.mode, matchId: confirmed.matchId, termsHash: confirmed.termsHash, expires: confirmed.expires };
      }
      await clearMatchHint(id);
    }
    const live = await readLiveMatch(id);
    if (live !== null) {
      await clearMatchHint(id);
      return { state: 'matched', mode: live.mode, matchId: live.matchId, termsHash: live.termsHash, expires: live.expires };
    }
    const result = await callRedis((client) => client.sendCommand(['EVAL', TOUCH_LUA, '4',
      indexKey('ranked'), indexKey('casual'), ticketKey(id), leaseKey(id),
      id, String(leaseMs), String(indexTtlMs), '0']));
    if (!result.ok) return { state: 'disconnected', available: false };
    const code = String(result.value[0]);
    if (code === 'IDLE') return { state: 'idle' };
    if (code === 'DISCONNECTED') return { state: 'disconnected' };
    const ticket = parseJson(result.value[1]);
    if (!ticket) return { state: 'disconnected' };
    return searching(ticket);
  }

  /* Hand a matcher a batch of live, unclaimed candidates. The claim is a per-actor SET NX inside one
   * atomic script, so two matchers can never receive the same actor and a dead candidate is never
   * handed out at all. */
  async function claimCandidates(input = {}) {
    const mode = requireMode(input.mode);
    const limit = input.limit === undefined ? DEFAULT_CLAIM_LIMIT : positiveInt(input.limit, 'INVALID_LIMIT', MAX_CLAIM_LIMIT);
    const matcherId = input.matcherId;
    if (!validPart(matcherId) || matcherId.length > MAX_MATCHER_ID) fail('INVALID_MATCHER');
    const lease = input.leaseMs === undefined ? claimTtlMs : positiveInt(input.leaseMs, 'INVALID_LEASE');
    const scan = await callRedis((client) => client.sendCommand(['ZRANGE', indexKey(mode), '0', String(limit * CLAIM_OVERSCAN - 1)]));
    /* A matcher must never read a dead Redis as an empty queue and conclude there is nobody to
     * match, so this fails closed exactly like `join`. */
    if (!scan.ok) fail('QUEUE_UNAVAILABLE');
    const actors = (scan.value || []).map(String).filter(validPart);
    if (actors.length === 0) return [];
    const nonce = crypto.randomUUID();
    const keys = [indexKey(mode), claimedKey(mode)];
    for (const actor of actors) keys.push(ticketKey(actor), leaseKey(actor), claimKey(actor));
    const args = ['EVAL', CLAIM_LUA, String(keys.length), ...keys,
      String(actors.length), String(limit), matcherId, String(lease), String(indexTtlMs), nonce, String(now()), ...actors];
    const result = await callRedis((client) => client.sendCommand(args));
    if (!result.ok) fail('QUEUE_UNAVAILABLE');
    return (result.value || []).map((text) => {
      const ticket = parseJson(text);
      if (!ticket) return null;
      return {
        actor: ticket.actor, mode, joinedAt: ticket.joinedAt,
        region: ticket.region, latencyMs: ticket.latencyMs ?? null, claimId: ticket.claimId,
      };
    }).filter((candidate) => candidate !== null);
  }

  /* Release requires the exact opaque token claimCandidates returned. An old
   * worker, expired lease, or unauthenticated caller has no delete authority. */
  async function releaseClaim(input = {}) {
    const mode = requireMode(input.mode);
    const actor = requireActor(input.actor);
    const claimId = input.claimId;
    if (!validPart(claimId)) fail('INVALID_CLAIM_ID');
    const requeue = input.requeue === undefined ? true : input.requeue;
    if (typeof requeue !== 'boolean') fail('INVALID_REQUEUE');
    const result = await callRedis((client) => client.sendCommand(['EVAL', RELEASE_LUA, '5',
      indexKey(mode), claimedKey(mode), claimKey(actor), ticketKey(actor), leaseKey(actor),
      actor, requeue ? '1' : '0', String(indexTtlMs), claimId]));
    if (!result.ok) return false;
    return String(result.value[0]) === '1';
  }

  /* Reap abandoned clients: index members whose heartbeat lease is gone. One bounded batch per
   * call, so a matcher tick never blocks on a large backlog. */
  async function expireAbandoned(input = {}) {
    const mode = requireMode(input.mode);
    const at = input.now === undefined ? now() : input.now;
    if (typeof at !== 'number' || !Number.isFinite(at)) fail('INVALID_CLOCK');
    const scan = await callRedis((client) => client.sendCommand(['ZRANGE', indexKey(mode), '0', String(EXPIRE_BATCH - 1)]));
    if (!scan.ok) return 0;
    const actors = (scan.value || []).map(String).filter(validPart);
    if (actors.length === 0) return 0;
    const keys = [indexKey(mode), claimedKey(mode)];
    for (const actor of actors) keys.push(ticketKey(actor), leaseKey(actor));
    const result = await callRedis((client) => client.sendCommand(['EVAL', EXPIRE_LUA, String(keys.length), ...keys,
      String(actors.length), String(indexTtlMs), String(at), ...actors]));
    if (!result.ok) return 0;
    return Number(result.value) || 0;
  }

  /* The bounded queue gauge. `claimed` counts claims whose lease has not yet expired. */
  async function size() {
    const result = await callRedis((client) => client.sendCommand(['EVAL', SIZE_LUA, '4',
      indexKey('ranked'), indexKey('casual'), claimedKey('ranked'), claimedKey('casual'), String(now())]));
    if (!result.ok) return { ranked: 0, casual: 0, claimed: 0, available: false };
    return { ranked: Number(result.value[0]) || 0, casual: Number(result.value[1]) || 0, claimed: Number(result.value[2]) || 0, available: true };
  }

  return Object.freeze({
    join,
    heartbeat,
    cancel,
    status,
    claimCandidates,
    releaseClaim,
    matchTick,
    expireAbandoned,
    size,
    /* Releases THIS service's own state only. Every Redis key the candidates live in is owned by the
     * borrowed adapter (its TTLs drain them) and every connection is owned by the caller's pool, so
     * neither is closed here - a caller may share both with other services. No timer is left behind
     * by any method above. */
    async close() { closed = true; },
  });
}

module.exports = {
  createQueueService,
  CONFIG: P.CONFIG,
  searchWindow: P.searchWindow,
};
