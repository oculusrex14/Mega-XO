/* packages/services/tickets.js - V5 P05 durable one-use realtime tickets (design B5, TTLs Part F).
 *
 * The transport seam between the API (which mints) and Core (which redeems) for the realtime
 * WebSocket upgrade. Two halves, deliberately on DIFFERENT runtime identities:
 *
 *   const api = await createTicketIssuer(apiPool, { now, environment, audience });
 *   const { ticket, expiresAt } = await api.issue({ actor, sessionId, generation,
 *                                                   matchScope, connectionClass, ipHash });
 *   await api.listOpen(actor);                 // bounded read of still-redeemable tickets
 *   api.close();
 *
 *   const grant = await redeemRealtimeTicket(corePool, { ticket, connectionId, node, now });
 *   // -> { actorId, sessionId, generation, environment, audience, matchScope }
 *
 * DURABILITY CONTRACT. The ticket is a 32-byte random bearer; ONLY sha256 hex lives in
 * identity.realtime_tickets.ticket_hash (CHECK 64-hex). Redemption is the single statement
 * identity.redeem_realtime_ticket (0042, SECURITY DEFINER) inside ONE core_runtime transaction, so
 * the durable row's `redeemed_at IS NULL` predicate is the only authority: two racing nodes get
 * exactly one winner, and the outcome survives process death and total cache loss. No Redis is
 * consulted anywhere, and a replay after a cache wipe is therefore proven by simply redeeming
 * twice (A14/A15).
 *
 * OWNERSHIP. The redeem function returns the STORED fields; this module never compares them against
 * a request envelope. environment/audience/sessionId/generation and match membership are compared
 * by the Core envelope guard (design B5.3/B5.4, A14), which is why `matchScope` is returned rather
 * than enforced here. Core holds EXECUTE + SELECT only - it can never INSERT/UPDATE/DELETE the
 * ticket table - so a caller cannot turn a redemption into a ticket mint or a reset.
 *
 * ADMISSION LIMITS (all fail closed, evaluated in the issue transaction): outstanding unredeemed
 * tickets per actor < 3; concurrently LIVE (redeemed and not yet expired) < 4; a per-IP issuance
 * budget (max 20 issued per ipHash per rolling 60s window, measured on issued_at); and a global
 * outstanding cap of 10000. Any breach throws `TICKET_LIMIT`; nothing is issued.
 */
'use strict';
const crypto = require('node:crypto');
const { ContextError } = require('../db/context');
const { verifyRuntimeSchema } = require('../db/pg/readiness.js');
const { createPgUnitOfWork } = require('../db/pg/uow.js');
const { lockTransactionIdentity } = require('../db/pg/locks.js');

/* Frozen TTLs and admission bounds (design Part F). A caller may tighten, never loosen, them via
 * the `limits` option; each override is validated against a hard ceiling. */
const TICKET_TTL = 10000;
const OUTSTANDING_PER_ACTOR = 3;
const LIVE_PER_ACTOR = 4;
const GLOBAL_OUTSTANDING = 10000;
const IP_WINDOW_MS = 60000;
const IP_ISSUE_MAX = 20;
const OPEN_LIST_CAP = 50;
const MAX_SCOPE = 128;
/* The one runtime identity that may own the ticket writes (api_runtime has INSERT on the table). */
const API_ROLE = 'api_runtime';
/* Redemption is Core's, and Core only ever executes the narrow SECURITY DEFINER function. */
const CORE_ROLE = 'core_runtime';

const fail = (code) => { throw Error(code); };
const hex = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isHex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
/* Epoch ms -> ISO text for every timestamptz parameter (the repository convention; a raw JS number
 * would be parsed by PostgreSQL as an absolute-timestamp literal, not as epoch milliseconds). */
const iso = (value) => new Date(value).toISOString();

/* A redeem caller may supply `now` as a clock function (the service convention) or a fixed epoch-ms
 * timestamp (a one-shot replay/expiry probe). Anything else falls back to Date.now. */
const asClock = (value) => {
 if (typeof value === 'function') return value;
 if (Number.isFinite(value)) return () => value;
 return Date.now;
};

function limitsFrom(overrides) {
 const input = overrides && typeof overrides === 'object' ? overrides : {};
 const pick = (name, fallback, max) => {
  if (input[name] === undefined) return fallback;
  const value = input[name];
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
   throw new ContextError('TICKET_LIMIT_INVALID', { setting: name });
  }
  return value;
 };
 return Object.freeze({
  ttlMs: pick('ttlMs', TICKET_TTL, TICKET_TTL),
  outstandingPerActor: pick('outstandingPerActor', OUTSTANDING_PER_ACTOR, OUTSTANDING_PER_ACTOR),
  livePerActor: pick('livePerActor', LIVE_PER_ACTOR, LIVE_PER_ACTOR),
  globalOutstanding: pick('globalOutstanding', GLOBAL_OUTSTANDING, GLOBAL_OUTSTANDING),
  ipWindowMs: pick('ipWindowMs', IP_WINDOW_MS, IP_WINDOW_MS),
  ipIssueMax: pick('ipIssueMax', IP_ISSUE_MAX, IP_ISSUE_MAX),
 });
}

/* ------------------------------------------------------------------ issuer */

async function createTicketIssuer(apiPool, options = {}) {
 const limits = limitsFrom(options.limits);
 if (typeof options.environment !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(options.environment)) {
  throw new ContextError('ISSUER_ENVIRONMENT_REQUIRED');
 }
 const environment = options.environment;
 const audience = options.audience === undefined ? 'mega-core' : options.audience;
 if (typeof audience !== 'string' || audience.length === 0 || audience.length > 64) {
  throw new ContextError('ISSUER_AUDIENCE_REQUIRED');
 }
 if (!apiPool || typeof apiPool.withTransaction !== 'function') throw new ContextError('PG_POOL_REQUIRED');
 /* Readiness is API's: an issuer that booted against an unmigrated/diverged schema would fail later
  * with a confusing 42P01/42501. Readiness alone permits core/worker, so the role is enforced
  * separately - a core_runtime pool here has no INSERT on the ticket table. */
 const readiness = await verifyRuntimeSchema(apiPool);
 if (readiness.role !== API_ROLE) {
  const error = new ContextError('ROLE_REQUIRED');
  error.detail = `createTicketIssuer requires ${API_ROLE}, got ${readiness.role}`;
  throw error;
 }
 const clock = typeof options.now === 'function' ? options.now : Date.now;
 const uow = createPgUnitOfWork(apiPool, { now: clock, role: readiness.role });
 let closed = false;
 const run = (fn) => {
  if (closed) return Promise.reject(new ContextError('UNIT_OF_WORK_CLOSED'));
  return uow.run(fn);
 };

 /* One transaction per issuance. The per-actor advisory mutex serializes concurrent issuances for
  * the SAME actor so the outstanding/live caps are strict; a missing row cannot be row-locked.
  * Every limit predicate is inside the INSERT's WHERE, so a breach inserts nothing. */
 async function issue(request = {}) {
  const { actor, sessionId, generation, matchScope = null, connectionClass, ipHash = null } = request;
  if (typeof actor !== 'string' || actor.length === 0 || actor.length > 128) fail('TICKET_BINDING_REQUIRED');
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) fail('TICKET_BINDING_REQUIRED');
  if (!Number.isSafeInteger(generation) || generation < 1) fail('TICKET_BINDING_REQUIRED');
  if (typeof connectionClass !== 'string' || connectionClass.length === 0 || connectionClass.length > 32) fail('TICKET_BINDING_REQUIRED');
  if (matchScope !== null && (typeof matchScope !== 'string' || matchScope.length === 0 || matchScope.length > MAX_SCOPE)) fail('TICKET_BINDING_REQUIRED');
  if (ipHash !== null && !isHex(ipHash)) fail('TICKET_BINDING_REQUIRED');
  const at = clock();
  const ticket = crypto.randomBytes(32).toString('base64url');
  const ticketHash = hex(ticket);
  const inserted = await run(async (tx) => {
   await lockTransactionIdentity(tx, 'realtime-ticket-issue', [actor]);
   return tx.query(
    `INSERT INTO identity.realtime_tickets
       (ticket_hash, actor_id, session_id, generation, environment, audience, match_scope,
        connection_class, issued_ip_hash, issued_at, expires_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz
      WHERE (SELECT count(*) FROM identity.realtime_tickets
              WHERE actor_id = $2 AND redeemed_at IS NULL AND expires_at > $10::timestamptz) < $12
        AND (SELECT count(*) FROM identity.realtime_tickets
              WHERE actor_id = $2 AND redeemed_at IS NOT NULL AND expires_at > $10::timestamptz) < $13
        AND (SELECT count(*) FROM identity.realtime_tickets
              WHERE issued_ip_hash = $9 AND issued_at > $10::timestamptz - ($14::bigint * interval '1 millisecond')) < $15
        AND (SELECT count(*) FROM identity.realtime_tickets
              WHERE redeemed_at IS NULL AND expires_at > $10::timestamptz) < $16
     RETURNING issued_at, expires_at`,
    [ticketHash, actor, sessionId, generation, environment, audience, matchScope,
     connectionClass, ipHash, iso(at), iso(at + limits.ttlMs),
     limits.outstandingPerActor, limits.livePerActor, limits.ipWindowMs, limits.ipIssueMax,
     limits.globalOutstanding]);
  });
  if (inserted.rowCount === 0) fail('TICKET_LIMIT');
  return { ticket, expiresAt: inserted.rows[0].expires_at.getTime() };
 }

 /* Bounded read of the tickets the actor could still redeem (unredeemed, unexpired). The stored
  * hash is returned - it is a digest, not redeemable bearer material - never the raw ticket. */
 async function listOpen(actor) {
  if (typeof actor !== 'string' || actor.length === 0 || actor.length > 128) fail('TICKET_BINDING_REQUIRED');
  const at = clock();
  const rows = await run((tx) => tx.query(
   `SELECT ticket_hash, session_id, generation, environment, audience, match_scope,
           connection_class, issued_at, expires_at
      FROM identity.realtime_tickets
     WHERE actor_id = $1 AND redeemed_at IS NULL AND expires_at > $2
     ORDER BY expires_at ASC, ticket_hash ASC
     LIMIT $3`,
   [actor, iso(at), OPEN_LIST_CAP]));
  return rows.rows.map((row) => Object.freeze({
   ticketHash: row.ticket_hash, sessionId: row.session_id, generation: Number(row.generation),
   environment: row.environment, audience: row.audience, matchScope: row.match_scope,
   connectionClass: row.connection_class, issuedAt: row.issued_at.getTime(), expiresAt: row.expires_at.getTime(),
  }));
 }

 function close() { closed = true; uow.close(); }

 return Object.freeze({ issue, listOpen, close });
}

/* ---------------------------------------------------------------- redemption */

/* Core-side redemption. ONE core_runtime transaction runs the SECURITY DEFINER function; zero rows
 * is disambiguated by a follow-up SELECT on the same table (Core holds SELECT). The returned fields
 * are the STORED ones - the caller's envelope guard compares them, this module does not. */
async function redeemRealtimeTicket(corePool, options = {}) {
 if (!corePool || typeof corePool.withTransaction !== 'function') throw new ContextError('PG_POOL_REQUIRED');
 const described = typeof corePool.describe === 'function' ? corePool.describe() : null;
 const role = described ? described.role : null;
 if (role !== CORE_ROLE) {
  const error = new ContextError('ROLE_REQUIRED');
  error.detail = `redeemRealtimeTicket requires ${CORE_ROLE}, got ${role}`;
  throw error;
 }
 const connectionId = options.connectionId;
 const node = options.node;
 if (typeof connectionId !== 'string' || connectionId.length === 0 || connectionId.length > 128
  || typeof node !== 'string' || node.length === 0 || node.length > 128) {
  throw new ContextError('REDEEM_ARGUMENT_REQUIRED');
 }
 const ticket = options.ticket;
 if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 128) fail('TICKET_INVALID');
 const clock = asClock(options.now);
 const ticketHash = hex(ticket);
 const at = clock();
 const outcome = await corePool.withTransaction(async (tx) => {
  const redeemed = await tx.query(
   `SELECT actor_id, session_id, generation, environment, audience, match_scope
      FROM identity.redeem_realtime_ticket($1, $2, $3, $4)`,
   [ticketHash, connectionId, node, new Date(at)]);
  if (redeemed.rows.length > 0) return { grant: redeemed.rows[0] };
  const probe = await tx.query(
   `SELECT redeemed_at, expires_at, actor_id, session_id, generation, environment, audience, match_scope
      FROM identity.realtime_tickets WHERE ticket_hash = $1`,
   [ticketHash]);
  if (probe.rows.length === 0) return { code: 'TICKET_INVALID' };
  const row = probe.rows[0];
  /* Redeemed first: a spent ticket stays spent even after its expiry passes (order is frozen by the
   * design, B5.5). */
  if (row.redeemed_at !== null && row.redeemed_at !== undefined) return { code: 'TICKET_REDEEMED' };
  if (row.expires_at.getTime() <= at) return { code: 'TICKET_EXPIRED' };
  /* Zero rows while the durable row is still open and unexpired: the statement could not win it.
   * Fail closed instead of reusing a ticket. */
  return { code: 'TICKET_INVALID' };
 });
 if (outcome.code) fail(outcome.code);
 const grant = outcome.grant;
 return {
  actorId: grant.actor_id, sessionId: grant.session_id, generation: Number(grant.generation),
  environment: grant.environment, audience: grant.audience, matchScope: grant.match_scope,
 };
}

module.exports = { createTicketIssuer, redeemRealtimeTicket, TICKET_TTL, OUTSTANDING_PER_ACTOR, LIVE_PER_ACTOR, GLOBAL_OUTSTANDING, IP_ISSUE_MAX, IP_WINDOW_MS };
