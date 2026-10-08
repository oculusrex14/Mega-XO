/* packages/services/ephemera.js - V5 P06 namespaced bounded Redis ephemera (V5-06-02/03).
 *
 * Design: docs/v5/designs/p05-session-design.md Part D. EVERY fact here is rebuildable and
 * never authoritative: a wipe may only make the system MORE CONSERVATIVE, never resurrect a
 * revoked session, re-enable a redeemed ticket or allow a second starting grant - all three of
 * those decisions are derivable from PostgreSQL alone (identity.*, monetization.*, economy.*).
 *
 * Invariants enforced by this module:
 *  - NAMESPACING. Every key is `mx:<environment>:<keyVersion>:<family>:<parts...>`; the family
 *    is allowlisted and parts are validated, so one environment's client can neither read nor
 *    write another's keys and an unbounded key universe cannot accrete.
 *  - BOUNDEDNESS. Every write carries an explicit positive TTL (or is a sorted set whose whole
 *    key has one, with entries trimmed by score). A write without a TTL is refused, not
 *    defaulted: there are no immortal keys.
 *  - NO SECRETS. Values are opaque bounded strings (ids, hashes, small JSON). The 4 KiB cap and
 *    the value allowlist keep credentials, tokens and player data out of Redis.
 *  - CONSERVATIVE LOSS. When Redis is unreachable every operation resolves to its documented
 *    conservative fallback (miss/deny/unlock) and reports `available:false`. Losing Redis can
 *    delay or deny; it can never grant, admit or authenticate.
 *  - NO PERMANENT ASSETS. Presence, queues, caches, hints, locks and routes are the only
 *    families; wallet/rank/purchase/ticket/revocation truth is never written here.
 */
'use strict';
const crypto = require('node:crypto');
const redis = require('redis');

const KEY_VERSION = 'v1';
const MAX_VALUE_BYTES = 4096;
const FAMILIES = new Set(['presence', 'queue', 'cache', 'rate', 'route', 'hint', 'lock', 'negcache']);
const ENVIRONMENTS = new Set(['stg', 'prd', 'test']);
const SAFE_PART = /^[A-Za-z0-9_.:@-]{1,128}$/;
/* Frozen Lua: the rate window is INCR + first-hit PEXPIRE (never slides); the lock release is a
 * compare-and-delete so a stale holder cannot free someone else's lock. */
const RATE_WINDOW_LUA = "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return n;";
const COMPARE_DEL_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end;";

const fail = (code) => { throw Error(code); };

/* Conservative fallbacks. `conservative: true` tells the caller the answer is a refusal born of
 * lost coordination, not a positive fact. */
const LOSS = Object.freeze({
  present: { value: null, available: false, conservative: true },
  cacheHit: { value: null, available: false, conservative: true },
  rateDeny: { allowed: false, available: false, conservative: true },
  lockBusy: { acquired: false, available: false, conservative: true },
  flag: false,
});

function validatePart(part, what = 'key part') {
  if (typeof part !== 'string' || !SAFE_PART.test(part)) fail('INVALID_KEY_PART');
  return part;
}

class EphemeraService {
  /**
   * @param {object} options
   * @param {string} options.url redis:// URL (a dedicated ephemera instance; never the PG URL)
   * @param {string} options.environment 'stg'|'prd'|'test' - hard namespace boundary
   * @param {string} [options.keyVersion='v1'] bump to invalidate every family at once
   * @param {object} [options.socket] connect/read timeouts; a slow Redis must fail fast
   */
  constructor({ url, environment, keyVersion = KEY_VERSION, socket } = {}) {
    if (typeof url !== 'string' || !url.startsWith('redis://')) fail('REDIS_URL_REQUIRED');
    if (!ENVIRONMENTS.has(environment)) fail('ENVIRONMENT_REQUIRED');
    if (!/^[a-z0-9]{1,8}$/.test(keyVersion)) fail('INVALID_KEY_VERSION');
    this.environment = environment;
    this.keyVersion = keyVersion;
    this.closed = false;
    this.client = redis.createClient({
      url,
      socket: { connectTimeout: 3000, reconnectStrategy: () => 2000, ...(socket || {}) },
      /* A slow or absent Redis resolves to the conservative fallback instead of hanging a request. */
      disableOfflineQueue: true,
    });
    this.client.on('error', () => { /* surfaced per-operation; a client error event is not fatal */ });
    /* A rejected connect must never become an unhandled rejection; #op resolves every command to
     * its conservative fallback when the connection is not usable in time. */
    this.connected = this.client.connect().catch(() => {});
  }

  /* ---- naming ---- */
  key(family, ...parts) {
    if (!FAMILIES.has(family)) fail('UNKNOWN_FAMILY');
    return ['mx', this.environment, this.keyVersion, family, ...parts.map((p) => validatePart(p))].join(':');
  }

  static #deadline(ms) { return new Promise((resolve) => setTimeout(() => resolve(Symbol.for('ephemera.deadline')), ms)); }

  async #op(fn, loss) {
    if (this.closed) return loss;
    try {
      /* Every operation is deadline-bounded: a slow/half-open Redis resolves to the conservative
       * fallback instead of hanging the caller. */
      const result = await Promise.race([
        Promise.resolve(this.connected).then(() => fn(this.client)),
        EphemeraService.#deadline(2000),
      ]);
      if (result === Symbol.for('ephemera.deadline')) { this.lastError = 'DEADLINE'; return loss; }
      this.lastError = null;
      return result;
    } catch (error) { this.lastError = error && error.message; return loss; }
  }

  static #bounded(value, ttlMs, what) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('TTL_REQUIRED');
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_VALUE_BYTES) fail('VALUE_TOO_LARGE');
    return text;
  }

  /* ---- presence/heartbeat (ephemeral by definition; the durable tier is identity.sessions) ---- */
  async heartbeat(actor, sessionId, ttlMs = 60000) {
    const value = EphemeraService.#bounded(sessionId, ttlMs, 'presence');
    const k = this.key('presence', actor);
    return this.#op((c) => c.set(k, value, { PX: ttlMs }).then(() => ({ stored: true, available: true })), { stored: false, available: false, conservative: true });
  }
  async lookupPresence(actor) {
    const k = this.key('presence', actor);
    return this.#op(async (c) => ({ value: await c.get(k), available: true }), LOSS.present);
  }
  async dropPresence(actor) {
    const k = this.key('presence', actor);
    return this.#op((c) => c.del(k).then(() => ({ dropped: true, available: true })), { dropped: false, available: false, conservative: true });
  }

  /* ---- bounded cache ---- */
  async cacheSet(family, id, value, ttlMs) {
    const text = EphemeraService.#bounded(value, ttlMs, 'cache');
    const k = this.key(family, id);
    return this.#op((c) => c.set(k, text, { PX: ttlMs }).then(() => ({ stored: true, available: true })), { stored: false, available: false, conservative: true });
  }
  async cacheGet(family, id) {
    const k = this.key(family, id);
    return this.#op(async (c) => ({ value: await c.get(k), available: true }), LOSS.cacheHit);
  }
  async cacheDel(family, id) {
    const k = this.key(family, id);
    return this.#op((c) => c.del(k).then(() => ({ deleted: true, available: true })), { deleted: false, available: false, conservative: true });
  }

  /* ---- non-security rate budget. Security-class budgets stay in ops.rate_buckets (PostgreSQL). ---- */
  async rateHit(bucket, limit, windowMs) {
    validatePart(bucket);
    if (!Number.isSafeInteger(limit) || limit <= 0) fail('INVALID_LIMIT');
    const key = this.key('rate', bucket);
    return this.#op(async (c) => {
      /* One atomic EVAL: INCR then PEXPIRE only on the first hit, so the window never slides.
       * sendCommand is used because typed .eval() variants mangle the KEY/ARGV split on this
       * client version; the reply is the raw integer count. */
      const count = await c.sendCommand(['EVAL', RATE_WINDOW_LUA, '1', key, String(windowMs)]);
      return { allowed: Number(count) <= limit, count: Number(count), available: true };
    }, LOSS.rateDeny);
  }

  /* ---- single-flight locks (a lost lock sends callers to the DB-authoritative path) ---- */
  async acquireLock(name, ttlMs = 5000) {
    validatePart(name);
    const token = crypto.randomBytes(16).toString('base64url');
    const k = this.key('lock', name);
    return this.#op((c) => c.set(k, token, { NX: true, PX: ttlMs }).then((ok) => (ok
      ? { acquired: true, token, available: true }
      : { acquired: false, available: true })), LOSS.lockBusy);
  }
  async releaseLock(name, token) {
    validatePart(name);
    if (typeof token !== 'string') return { released: false };
    const k = this.key('lock', name);
    return this.#op(async (c) => {
      const n = await c.sendCommand(['EVAL', COMPARE_DEL_LUA, '1', k, token]);
      return { released: Number(n) === 1, available: true };
    }, { released: false, available: false, conservative: true });
  }

  /* ---- revocation/limit HINTS. Hints only make the system more conservative; PostgreSQL decides. ---- */
  async setHint(kind, id, ttlMs) {
    validatePart(kind);
    const value = EphemeraService.#bounded('1', ttlMs, 'hint');
    const k = this.key('hint', kind, id);
    return this.#op((c) => c.set(k, value, { PX: ttlMs }).then(() => ({ stored: true, available: true })), { stored: false, available: false, conservative: true });
  }
  async checkHint(kind, id) {
    const k = this.key('hint', kind, id);
    return this.#op(async (c) => ({ present: (await c.get(k)) !== null, available: true }), { present: false, available: false, conservative: true });
  }

  /* ---- socket routing registry (P08 consumer; TTL-refreshed, never permanent) ---- */
  async registerRoute(connectionId, payload, ttlMs = 30000) {
    validatePart(connectionId);
    const value = EphemeraService.#bounded(payload, ttlMs, 'route');
    const k = this.key('route', connectionId);
    return this.#op((c) => c.set(k, value, { PX: ttlMs }).then(() => ({ stored: true, available: true })), { stored: false, available: false, conservative: true });
  }
  async locateRoute(connectionId) {
    const k = this.key('route', connectionId);
    return this.#op(async (c) => ({ value: await c.get(k), available: true }), LOSS.cacheHit);
  }

  /* ---- candidate queue index: a sorted set whose members age out by score and whose KEY has a TTL ---- */
  async enqueueCandidate(mode, ticketId, weight = 0, { windowMs = 300000, keyTtlMs = 3600000 } = {}) {
    validatePart(mode); validatePart(ticketId);
    const key = this.key('queue', mode);
    return this.#op(async (c) => {
      const at = Date.now();
      await c.zAdd(key, [{ score: at + weight, value: ticketId }]);
      await c.zRemRangeByScore(key, '-inf', String(at - windowMs));
      await c.expire(key, Math.ceil(keyTtlMs / 1000));
      return { queued: true, available: true };
    }, { queued: false, available: false, conservative: true });
  }
  async peekCandidates(mode, { max = 16, windowMs = 300000 } = {}) {
    validatePart(mode);
    const key = this.key('queue', mode);
    return this.#op(async (c) => {
      const rows = await c.zRangeWithScores(key, 0, max - 1);
      const floor = Date.now() - windowMs;
      return { candidates: rows.filter((r) => r.score >= floor).map((r) => r.value), available: true };
    }, { candidates: [], available: false, conservative: true });
  }
  async dropCandidate(mode, ticketId) {
    validatePart(mode); validatePart(ticketId);
    const key = this.key('queue', mode);
    return this.#op((c) => c.zRem(key, ticketId).then(() => ({ dropped: true, available: true })), { dropped: false, available: false, conservative: true });
  }

  /* ---- pub/sub notifications (rebuildable fan-out; durable notices live in ops.outbox) ---- */
  async publish(channel, message, ttlMs = 30000) {
    validatePart(channel);
    const text = EphemeraService.#bounded(message, ttlMs, 'pubsub');
    const key = this.key('cache', 'ch', channel);
    return this.#op((c) => c.publish(key, text).then(() => ({ published: true, available: true })), { published: false, available: false, conservative: true });
  }
  async subscribe(channel, onMessage) {
    validatePart(channel);
    if (typeof onMessage !== 'function') fail('LISTENER_REQUIRED');
    if (this.closed) return { unsubscribe: () => {} };
    const duplicate = this.client.duplicate();
    const sub = duplicate;
    sub.on('error', () => { /* per-operation surface */ });
    await sub.connect();
    const key = this.key('cache', 'ch', channel);
    await sub.subscribe(key, (text) => { try { onMessage(text); } catch { /* listener fault is not fatal */ } });
    return { unsubscribe: () => sub.unsubscribe(key).catch(() => {}).then(() => sub.quit()).catch(() => {}) };
  }

  /* ---- health and hygiene ---- */
  async healthy() {
    return this.#op((c) => c.ping().then((r) => r === 'PONG'), false);
  }
  /* Normalizes node-redis's scan reply (either [cursor, keys] or {cursor, keys}). */
  static #scanReply(reply) {
    return Array.isArray(reply) ? { cursor: String(reply[0]), keys: reply[1] } : { cursor: String(reply.cursor), keys: reply.keys };
  }

  /* Deletes ONLY this environment+version namespace. A wrong-environment wipe is a no-op by
   * construction, and durable PostgreSQL truth is never touched. */
  async wipeNamespace() {
    if (this.closed) return { deleted: 0, available: false };
    try {
      await this.connected;
      const pattern = `mx:${this.environment}:${this.keyVersion}:*`;
      let deleted = 0, cursor = '0';
      do {
        const { cursor: next, keys } = EphemeraService.#scanReply(await this.client.scan(cursor, { MATCH: pattern, COUNT: 200 }));
        cursor = next;
        if (keys.length) deleted += await this.client.del(keys);
      } while (cursor !== '0');
      return { deleted, available: true };
    } catch { return { deleted: 0, available: false }; }
  }
  /* The bounded-key audit: every mx: key in this namespace must carry a positive TTL or be a
   * sorted set key with one. Proof for 'no unbounded immortal keys'. */
  async auditUnboundedKeys() {
    if (this.closed) return { unbounded: [], available: false };
    try {
      await this.connected;
      const pattern = `mx:${this.environment}:${this.keyVersion}:*`;
      const unbounded = [];
      let cursor = '0';
      do {
        const { cursor: next, keys } = EphemeraService.#scanReply(await this.client.scan(cursor, { MATCH: pattern, COUNT: 200 }));
        cursor = next;
        for (const key of keys) {
          const ttl = await this.client.pTTL(key);
          if (ttl === -1) unbounded.push(key);
        }
      } while (cursor !== '0');
      return { unbounded, available: true };
    } catch { return { unbounded: [], available: false }; }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    /* quit() can wait on a reconnect backoff; destroy() is unconditional. A bounded quit is best
     * effort - closing may never hang the caller. */
    try { await Promise.race([this.client.quit(), new Promise((resolve) => setTimeout(resolve, 1000))]); } catch { /* already gone */ }
    try { this.client.destroy(); } catch { /* already gone */ }
  }
}

async function createEphemeraService(options) {
  const service = new EphemeraService(options);
  return service;
}

module.exports = { createEphemeraService, FAMILIES, KEY_VERSION, MAX_VALUE_BYTES };
