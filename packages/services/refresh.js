/* packages/services/refresh.js - V5 P05 hashed refresh families, rotation and device revocation.
 *
 * The V5 successor to nothing: V4 had no refresh token at all (design A9). This service implements
 * the FROZEN rotation protocol of docs/v5/designs/p05-session-design.md B3 (risk R1):
 *
 *   const refresh = await createRefreshService(pool, {
 *     now,                 // injected clock (default Date.now)
 *     graceMs,             // same-family grace window for a lost winning response (default 10 s)
 *     maxGraceReuse,       // bounded legitimate retries per family (default 3)
 *     absoluteTtlMs,       // family lifetime = session lifetime (default 14 d)
 *     mintAccess,          // REQUIRED async ({actor, sessionId, generation}) => accessToken
 *   });
 *
 * Invariants:
 *  - The refresh secret is 32 random bytes base64url. Only sha256 hex is stored
 *    (identity.refresh_tokens.token_hash, 64-hex CHECK); the raw secret is never persisted.
 *  - S_{g+1} = HKDF-SHA256(ikm = secret bytes, salt = 'mx:refresh:'+familyId, info = 'successor', 32)
 *    via crypto.hkdfSync. A successor is therefore RE-DERIVABLE from the presented secret, so a
 *    lost winning response is recoverable instead of pretending the client still holds the new
 *    credential.
 *  - Rotation serializes on the family row (SELECT ... FOR UPDATE) inside ONE api_runtime
 *    transaction: normal, bounded-retry and replay are one state machine over that lock.
 *  - A true replay revokes the family, bumps identity.session_generations once and writes an
 *    ops.outbox security notice IN THE SAME TRANSACTION (design C4), then returns SESSION_REVOKED.
 *  - The family generation (refresh lineage) and identity.session_generations (the revocation
 *    version carried in an access token's `gen` claim) are DISTINCT counters and never conflated
 *    (design B3.2).
 *  - Every write is a role-guarded api_runtime transaction; construction rejects any other pool
 *    role and any schema that is not the exact supported chain.
 */
'use strict';
const crypto = require('node:crypto');
const { ContextError } = require('../db/context');
const { verifyRuntimeSchema } = require('../db/pg/readiness');
const { createPgUnitOfWork } = require('../db/pg/uow');

const DAY = 86400000;
const SECRET_BYTES = 32;
/* 32 bytes base64url without padding is exactly 43 characters. */
const SECRET_LENGTH = 43;
const NOTICE_TTL = 30 * DAY;
const SERVICE_ROLE = 'api_runtime';
const DEFAULT_GRACE_MS = 10000;
const DEFAULT_MAX_GRACE_REUSE = 3;
const DEFAULT_ABSOLUTE_TTL_MS = 14 * DAY;
const PLATFORMS = new Set(['android', 'ios', 'browser']);

const fail = (code) => { throw Error(code); };
const iso = (ms) => new Date(ms).toISOString();
const sha256hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

/* A refresh secret is exactly 32 bytes of strict base64url: length, alphabet and a round-trip
 * check, so a lookalike padding/variant string never reaches the database. */
function decodeSecret(value) {
 if (typeof value !== 'string' || value.length !== SECRET_LENGTH) return null;
 if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
 const bytes = Buffer.from(value, 'base64url');
 if (bytes.length !== SECRET_BYTES) return null;
 if (bytes.toString('base64url') !== value) return null;
 return bytes;
}
/* The deterministic, domain-separated successor: HKDF-SHA256 with the family id as salt so the
 * same presented secret can only ever yield the one committed successor for its family. */
function deriveSuccessor(secretBytes, familyId) {
 const out = crypto.hkdfSync('sha256', secretBytes, Buffer.from('mx:refresh:' + familyId), Buffer.from('successor'), SECRET_BYTES);
 return Buffer.from(out).toString('base64url');
}

/* ------------------------------------------------------------------ SQL */
const GEN_ENSURE = 'INSERT INTO identity.session_generations (actor_id, generation, updated_at) VALUES ($1, 1, $2) ON CONFLICT (actor_id) DO NOTHING';
/* One durable bump per logical revocation event. A repeated revoke of an already-revoked family is
 * gated out before this runs, so the counter never advances twice for one event. */
const GEN_BUMP = 'INSERT INTO identity.session_generations (actor_id, generation, updated_at) VALUES ($1, 2, $2)'
 + ' ON CONFLICT (actor_id) DO UPDATE SET generation = identity.session_generations.generation + 1, updated_at = EXCLUDED.updated_at RETURNING generation';
const GEN_READ = 'SELECT generation FROM identity.session_generations WHERE actor_id = $1';

const FAMILY_INSERT = 'INSERT INTO identity.refresh_families (family_id, actor_id, session_id, device_id, created_at, absolute_expires_at, state, generation, reused_in_grace)'
 + " VALUES ($1, $2, $3, $4, $5, $6, 'active', 1, 0)";
const FAMILY_LOCK = 'SELECT family_id, actor_id, session_id, device_id, state, generation, reused_in_grace,'
 + ' (extract(epoch from absolute_expires_at) * 1000)::bigint AS expires_ms'
 + ' FROM identity.refresh_families WHERE family_id = $1 FOR UPDATE';
const FAMILY_INCREMENT = 'UPDATE identity.refresh_families SET generation = generation + 1 WHERE family_id = $1 RETURNING generation';
const FAMILY_REUSE = 'UPDATE identity.refresh_families SET reused_in_grace = reused_in_grace + 1 WHERE family_id = $1';
const FAMILY_EXPIRE = "UPDATE identity.refresh_families SET state = 'expired' WHERE family_id = $1 AND state = 'active'";
const FAMILY_REVOKE = "UPDATE identity.refresh_families SET state = 'revoked', revoked_at = $1, revoke_reason = $2 WHERE %s AND state = 'active' RETURNING family_id, actor_id";

const TOKEN_FIND = 'SELECT token_hash, family_id, generation, state,'
 + ' (extract(epoch from grace_until) * 1000)::bigint AS grace_ms'
 + ' FROM identity.refresh_tokens WHERE token_hash = $1';
const TOKEN_INSERT = 'INSERT INTO identity.refresh_tokens (token_hash, family_id, generation, state, issued_at, valid_until)'
 + " VALUES ($1, $2, $3, 'active', $4, $5)";
const TOKEN_ROTATE = "UPDATE identity.refresh_tokens SET state = 'rotated', rotate_at = $2, grace_until = $3 WHERE token_hash = $1 AND state = 'active'";
const TOKEN_CURRENT_ACTIVE = "SELECT token_hash FROM identity.refresh_tokens WHERE family_id = $1 AND generation = $2 AND state = 'active'";
const TOKENS_REVOKE = "UPDATE identity.refresh_tokens SET state = 'revoked' WHERE family_id = ANY($1::text[]) AND state IN ('active', 'rotated')";

const DEVICE_UPSERT = 'INSERT INTO identity.devices (device_id, actor_id, platform, label, created_at, last_seen_at)'
 + ' VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (device_id) DO UPDATE'
 + ' SET platform = EXCLUDED.platform, label = EXCLUDED.label, last_seen_at = EXCLUDED.last_seen_at'
 + ' WHERE identity.devices.actor_id = EXCLUDED.actor_id';
const DEVICE_OWNER = 'SELECT actor_id FROM identity.devices WHERE device_id = $1';
const DEVICE_REVOKE = 'UPDATE identity.devices SET revoked_at = $3 WHERE device_id = $1 AND actor_id = $2 AND revoked_at IS NULL';

const OUTBOX_INSERT = 'INSERT INTO ops.outbox (outbox_id, payload, kind, state, created_at, expires_at, next_at)'
 + " VALUES ($1, $2, $3, 'queued', $4, $5, $4) ON CONFLICT (outbox_id) DO NOTHING";

/* ------------------------------------------------------------------ factory */

async function createRefreshService(pool, options = {}) {
 if (!pool || typeof pool.withTransaction !== 'function' || typeof pool.describe !== 'function') throw new ContextError('PG_POOL_REQUIRED');
 const readiness = await verifyRuntimeSchema(pool);
 const role = readiness.role;
 if (role !== SERVICE_ROLE) {
  const error = new ContextError('ROLE_REQUIRED');
  error.detail = `createRefreshService requires ${SERVICE_ROLE}, got ${role}`;
  throw error;
 }
 const clock = typeof options.now === 'function' ? options.now : Date.now;
 const graceMs = Number.isSafeInteger(options.graceMs) && options.graceMs >= 0 ? options.graceMs : DEFAULT_GRACE_MS;
 const maxGraceReuse = Number.isSafeInteger(options.maxGraceReuse) && options.maxGraceReuse >= 0 ? options.maxGraceReuse : DEFAULT_MAX_GRACE_REUSE;
 const absoluteTtlMs = Number.isSafeInteger(options.absoluteTtlMs) && options.absoluteTtlMs > 0 ? options.absoluteTtlMs : DEFAULT_ABSOLUTE_TTL_MS;
 /* mintAccess is REQUIRED: a refresh that returned no access token would be a stub, not a rotation. */
 if (typeof options.mintAccess !== 'function') throw new ContextError('MINT_ACCESS_REQUIRED');
 const mintAccess = options.mintAccess;

 const uow = createPgUnitOfWork(pool, { now: clock, role: SERVICE_ROLE });
 let closed = false;
 const run = (fn) => {
  if (closed) return Promise.reject(new ContextError('UNIT_OF_WORK_CLOSED'));
  return uow.run((tx) => fn(tx));
 };

 /* --- shared transaction internals --- */
 const bump = (tx, actor, at) => tx.query(GEN_BUMP, [actor, iso(at)]);
 const readGeneration = async (tx, actor, at) => {
  const row = (await tx.query(GEN_READ, [actor])).rows[0];
  if (row) return Number(row.generation);
  await tx.query(GEN_ENSURE, [actor, iso(at)]);
  return 1;
 };
 const notice = async (tx, id, kind, payload, at) => {
  await tx.query(OUTBOX_INSERT, [id, JSON.stringify(payload), kind, iso(at), iso(at + NOTICE_TTL)]);
 };
 /* Revoke every matching ACTIVE family as ONE logical event: family + token terminal states, ONE
  * generation bump, ONE security notice - all in the caller's transaction (design C4). A repeat
  * that matches no active family writes nothing and bumps nothing. */
 const revokeWhere = async (tx, where, params, reason, noticeId, kind, at) => {
  const sql = FAMILY_REVOKE.replace('%s', where);
  const rows = (await tx.query(sql, [iso(at), reason, ...params])).rows;
  if (rows.length === 0) return { revoked: 0 };
  const ids = rows.map((r) => r.family_id);
  await tx.query(TOKENS_REVOKE, [ids]);
  const actors = [...new Set(rows.map((r) => r.actor_id))];
  for (const actor of actors) await bump(tx, actor, at);
  await notice(tx, noticeId, kind, { actor: actors[0], families: ids, reason, at }, at);
  return { revoked: rows.length };
 };

 /* ---------------------------------------------------------------- public */

 /* Begin a family: the first token is generation 1 and the family lives as long as the session.
  * The actor's revocation counter is upserted to 1 only if absent - a prior revocation is preserved. */
 async function startFamily({ actor, sessionId, deviceId = null } = {}) {
  if (typeof actor !== 'string' || actor.length === 0) fail('ACTOR_REQUIRED');
  if (typeof sessionId !== 'string' || sessionId.length === 0) fail('SESSION_REQUIRED');
  const familyId = `rf_${crypto.randomUUID()}`;
  const refreshSecret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const tokenHash = sha256hex(refreshSecret);
  const at = clock();
  const expiresAt = at + absoluteTtlMs;
  await run(async (tx) => {
   await tx.query(GEN_ENSURE, [actor, iso(at)]);
   await tx.query(FAMILY_INSERT, [familyId, actor, sessionId, deviceId === null ? null : String(deviceId), iso(at), iso(expiresAt)]);
   await tx.query(TOKEN_INSERT, [tokenHash, familyId, 1, iso(at), iso(expiresAt)]);
  });
  return { familyId, refreshSecret, expiresAt };
 }

 /* Rotate: lock the family, then decide normal / bounded retry / replay from the COMMITTED state.
  * The revocation writes of a replay commit before the SESSION_REVOKED error is raised. */
 async function rotate({ refreshSecret } = {}) {
  const secretBytes = decodeSecret(refreshSecret);
  if (!secretBytes) fail('INVALID_REFRESH');
  const tokenHash = sha256hex(refreshSecret);
  const outcome = await run(async (tx) => {
   const at = clock();
   const located = (await tx.query(TOKEN_FIND, [tokenHash])).rows[0];
   if (!located) return { status: 'unknown' };
   const family = (await tx.query(FAMILY_LOCK, [located.family_id])).rows[0];
   if (!family) return { status: 'unknown' };
   /* Re-read the presented row AFTER the lock: a concurrent winner has committed by now. */
   const token = (await tx.query(TOKEN_FIND, [tokenHash])).rows[0];
   if (!token) return { status: 'unknown' };
   if (family.state === 'revoked') return { status: 'revoked' };
   const expiresMs = Number(family.expires_ms);
   if (family.state === 'expired' || !(expiresMs > at)) {
    await tx.query(FAMILY_EXPIRE, [family.family_id]);
    return { status: 'expired' };
   }
   const familyGen = Number(family.generation);
   const tokenGen = Number(token.generation);
   if (token.state === 'active' && tokenGen === familyGen) {
    const successor = deriveSuccessor(secretBytes, family.family_id);
    await tx.query(TOKEN_INSERT, [sha256hex(successor), family.family_id, familyGen + 1, iso(at), iso(expiresMs)]);
    await tx.query(TOKEN_ROTATE, [tokenHash, iso(at), iso(at + graceMs)]);
    const next = (await tx.query(FAMILY_INCREMENT, [family.family_id])).rows[0];
    return {
     status: 'ok', refreshSecret: successor, familyId: family.family_id, generation: Number(next.generation),
     actor: family.actor_id, sessionId: family.session_id, revocationGeneration: await readGeneration(tx, family.actor_id, at),
    };
   }
   if (token.state === 'rotated') {
    const graceVal = token.grace_ms === null ? null : Number(token.grace_ms);
    const withinGrace = graceVal !== null && at <= graceVal;
    const generationOk = familyGen === tokenGen + 1;
    const capOk = Number(family.reused_in_grace) < maxGraceReuse;
    if (withinGrace && generationOk && capOk) {
     const successor = deriveSuccessor(secretBytes, family.family_id);
     const current = (await tx.query(TOKEN_CURRENT_ACTIVE, [family.family_id, familyGen])).rows[0];
     if (current && current.token_hash === sha256hex(successor)) {
      await tx.query(FAMILY_REUSE, [family.family_id]);
      return {
       status: 'ok', refreshSecret: successor, familyId: family.family_id, generation: familyGen,
       actor: family.actor_id, sessionId: family.session_id, revocationGeneration: await readGeneration(tx, family.actor_id, at),
      };
     }
    }
   }
   await revokeWhere(tx, 'family_id = $3', [family.family_id], 'replay', `security.refresh-replay:${family.family_id}`, 'security.refresh-replay', at);
   return { status: 'replay' };
  });
  if (outcome.status === 'unknown' || outcome.status === 'revoked' || outcome.status === 'replay') fail('SESSION_REVOKED');
  if (outcome.status === 'expired') fail('REFRESH_EXPIRED');
  /* mintAccess runs AFTER the rotation committed; the revocation generation it receives was read
   * inside the same transaction, so the access token's `gen` claim matches the durable counter. */
  const accessToken = await mintAccess({ actor: outcome.actor, sessionId: outcome.sessionId, generation: outcome.revocationGeneration });
  return { refreshSecret: outcome.refreshSecret, accessToken, familyId: outcome.familyId, generation: outcome.generation };
 }

 async function revokeFamily(familyId, reason) {
  if (typeof familyId !== 'string' || familyId.length === 0) fail('FAMILY_REQUIRED');
  const label = typeof reason === 'string' && reason.length > 0 ? reason : 'revoked';
  return run((tx) => revokeWhere(tx, 'family_id = $3', [familyId], label, `security.session-revoked:family:${familyId}`, 'security.session-revoked', clock()));
 }

 async function revokeForActor(actor, reason) {
  if (typeof actor !== 'string' || actor.length === 0) fail('ACTOR_REQUIRED');
  const label = typeof reason === 'string' && reason.length > 0 ? reason : 'revoked';
  return run((tx) => revokeWhere(tx, 'actor_id = $3', [actor], label, `security.session-revoked:actor:${actor}`, 'security.session-revoked', clock()));
 }

 async function revokeForSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) fail('SESSION_REQUIRED');
  return run((tx) => revokeWhere(tx, 'session_id = $3', [sessionId], 'session-revoked', `security.session-revoked:session:${sessionId}`, 'security.session-revoked', clock()));
 }

 async function registerDevice({ actor, platform, label = null, deviceId } = {}) {
  if (typeof actor !== 'string' || actor.length === 0) fail('ACTOR_REQUIRED');
  if (!PLATFORMS.has(platform)) fail('INVALID_PLATFORM');
  if (typeof deviceId !== 'string' || deviceId.length === 0) fail('DEVICE_REQUIRED');
  const at = clock();
  await run(async (tx) => {
   const res = await tx.query(DEVICE_UPSERT, [deviceId, actor, platform, label === undefined ? null : label, iso(at)]);
   if (res.rowCount === 0) {
    /* The upsert's WHERE keeps ownership immutable: a device id already bound to another actor is
      * refused rather than silently stolen. */
    const owner = (await tx.query(DEVICE_OWNER, [deviceId])).rows[0];
    if (owner && owner.actor_id !== actor) fail('DEVICE_CONFLICT');
   }
  });
  return { deviceId };
 }

 async function revokeDevice(actor, deviceId) {
  if (typeof actor !== 'string' || actor.length === 0) fail('ACTOR_REQUIRED');
  if (typeof deviceId !== 'string' || deviceId.length === 0) fail('DEVICE_REQUIRED');
  return run(async (tx) => {
   const at = clock();
   await tx.query(DEVICE_REVOKE, [deviceId, actor, iso(at)]);
   return revokeWhere(tx, 'actor_id = $3 AND device_id = $4', [actor, deviceId], 'device-revoked', `security.session-revoked:device:${deviceId}`, 'security.session-revoked', at);
  });
 }

 /* close() releases only THIS service's unit of work: the pool is caller-owned. */
 async function close() { closed = true; uow.close(); }

 return Object.freeze({
  startFamily, rotate, revokeFamily, revokeForActor, revokeForSession, registerDevice, revokeDevice, close,
 });
}

module.exports = { createRefreshService };
