/* packages/services/ephemera.js - V5 P06 namespaced bounded Redis ephemera (V5-06-02/03).
 *
 * Design: docs/v5/designs/p05-session-design.md Part D and docs/v5/designs/p06-ephemera-design.md.
 * EVERY fact here is rebuildable and never authoritative: a wipe may only make the system MORE
 * CONSERVATIVE, never resurrect a revoked session, re-enable a redeemed ticket or allow a second
 * starting grant - all three of those decisions are derivable from PostgreSQL alone
 * (identity.*, monetization.*, economy.*).
 *
 * Invariants enforced by this module:
 *  - NAMESPACING. Every key is `mx:<environment>:<keyVersion>:<family>:<encoded parts...>`; the family
 *    is allowlisted and every part is validated against the durable identity grammar and then
 *    canonically percent-encoded (see encodePart), so one environment's client can neither read nor
 *    write another's keys, an unbounded key universe cannot accrete, and two distinct part tuples can
 *    never collide on one key.
 *  - BOUNDEDNESS. Every write carries an explicit positive TTL (or is a sorted set whose whole
 *    key has one, set atomically in the same script as the member add, with entries trimmed by
 *    score). A write without a TTL is refused, not defaulted: there are no immortal keys. Every
 *    operation - including subscribe, wipe and audit - resolves within one deadline and never
 *    hangs a request or schedules leaked reconnect work.
 *  - NO SECRETS. Values are opaque bounded strings (ids, hashes, small JSON). The 4 KiB cap and
 *    the value allowlist keep credentials, tokens and player data out of Redis.
 *  - CONSERVATIVE LOSS. When Redis is unreachable every operation resolves to its documented
 *    conservative fallback (miss/deny/unlock) and reports `available:false`. Losing Redis can
 *    delay or deny; it can never grant, admit or authenticate.
 *  - VERIFIED TLS. `rediss://` (or an explicit request for TLS) uses node-redis TLS with the
 *    provided CA and never weakens verification: `rejectUnauthorized:false`, a `tls:false`
 *    override and a custom `checkServerIdentity` are refused. Plaintext `redis://` is refused
 *    unless the caller explicitly chooses it with `allowPlaintext: true`, so a managed endpoint
 *    can never be contacted in plaintext by accident.
 *  - NO PERMANENT ASSETS. Presence, queues, caches, hints, locks, routes and due registrations are
 *    the only families; wallet/rank/purchase/ticket/revocation truth is never written here. A `due`
 *    registration is a derived, TTL-bounded timer hint rebuilt from committed deadlines, never a
 *    schedule of record.
 */
'use strict';
const crypto = require('node:crypto');
const redis = require('redis');

/* The key schema is `v2`: v1 joined raw parts with structural `:` separators, so two DIFFERENT
 * (family, part...) tuples could render the SAME key - `key('hint','a:b','c')` and
 * `key('hint','a','b:c')` both produced `…:hint:a:b:c` - and a single part could impersonate the
 * namespace/version prefix. v2 encodes every part reversibly (see encodePart), so the tuple is
 * recoverable from the key and collisions are impossible. Nothing durable lives in Redis, so the
 * old v1 ephemera may simply expire and rejoin; `wipeNamespace`/the reconnect paths are version
 * scoped, so a v2 service never touches a v1 key (or another environment's). */
const KEY_VERSION = 'v2';
const MAX_VALUE_BYTES = 4096;
/* Every operation (including subscribe and the scan-based wipe/audit) must resolve within this
 * deadline; the connect phase is allowed the client's own budget before operations start
 * failing fast into their conservative fallback. */
const OP_DEADLINE_MS = 2000;
const CONNECT_DEADLINE_MS = 3000;
/* Upper bound on any reconnect backoff sleep the socket awaits. node-redis keeps the pending
 * `setTimeout` alive after `disconnect()`, so an uncapped (e.g. 60 s) caller backoff would hold
 * the process open well past `close()`; capping bounds how long a pending backoff can delay drain. */
const RECONNECT_CAP_MS = 2000;
/* Worst-case time for one in-flight connect (already in progress or sleeping between retries) to
 * settle after close(): the capped connectTimeout plus one capped retry sleep. Shutdown waits up to
 * this long before flipping the socket's isOpen, because flipping it while the socket is still
 * unassigned is exactly what makes a late-completing socket impossible to destroy. */
const CONNECT_SETTLE_MS = CONNECT_DEADLINE_MS + RECONNECT_CAP_MS;
/* Per-session presence (V5 P06) mirrors the legacy session_presence semantics: a session counts as
 * live for 45 s after its last heartbeat, and at most 16 sessions per actor are tracked. The key
 * TTL (60 s) is refreshed on every touch, so a wiped/expired actor self-heals on the next
 * heartbeat and no presence key is ever immortal. */
const PRESENCE_WINDOW_MS = 45000;
const PRESENCE_CAP = 16;
/* The key part for a session-revocation hint (see presenceSetRevoked). */
const PRESENCE_HINT_KIND = 'session-revoked';
/* `due` is the V5 P08 timer registration set (`mx:<env>:<ver>:due:<kind>`, design p06 key matrix):
 * a derived, TTL-bounded sorted set rebuilt from committed deadlines, added here rather than in a
 * second key vocabulary so one allowlist keeps owning the namespace. No other invariant changes. */
const FAMILIES = new Set(['presence', 'queue', 'cache', 'rate', 'route', 'hint', 'lock', 'negcache', 'due']);
const ENVIRONMENTS = new Set(['stg', 'prd', 'test']);
/* A key part is a durable text identifier. Its BOUNDS come from the preserved identity grammar
 * (`[A-Za-z0-9:_-]{1,160}` - `src/authority.js:7` validId, `packages/contracts/http-guards.js`
 * OPERATION_ID/OPERATION_KEY, `identity.actors.actor_id` CHECK in 0004:8-11): a string of at most
 * 160 units. Its CHARSET is deliberately the whole well-formed printable/Unicode space, NOT that
 * ASCII subset, because the durable tier PRESERVES legacy text ids verbatim even when they drift
 * from the grammar (P03: "the exact text is preserved (never recast, never regenerated)" and the
 * drift is only REPORTED, `tools/v5-migration/reader.js` noteGrammar), so refusing punctuation,
 * spaces, slashes, brackets or Unicode here would deny a genuinely valid identity. The only
 * exclusions are non-text: a non-string, an empty string, an over-bound value, a lone surrogate
 * (not well-formed UTF-8 text) and C0/DEL control characters (not identity text, and unsafe as a
 * Redis key / Lua argv). Namespace safety does NOT depend on the charset: every part is
 * canonically encoded (encodePart) so ':' can never appear inside a part. */
const PART_MAX_UNITS = 160;
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
/* The single canonical, REVERSIBLE per-part encoding used to build every key: `[A-Za-z0-9_.~-]` are
 * kept literally and every other byte (structurally: the ':' separator, '%' itself and any control /
 * non-ASCII byte) is percent-escaped as `%XX` over its UTF-8 bytes. It is injective, so distinct
 * part tuples can never render the same key; '%' is always escaped, so no part can spell another
 * part's escape or the `mx:<env>:<version>:` prefix (a literal ':' becomes '%3A', a literal '%'
 * becomes '%25'). Safe for Lua / pub-sub channel names (no space/control) and inert to Redis glob in
 * the wipe prefix match. */
const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.~-';
const KEEP_BYTE = new Uint8Array(256);
for (let i = 0; i < UNRESERVED.length; i += 1) KEEP_BYTE[UNRESERVED.charCodeAt(i)] = 1;
const HEX = '0123456789ABCDEF';
function encodePart(part) {
  const bytes = Buffer.from(part, 'utf8');
  let out = '';
  for (const byte of bytes) {
    if (KEEP_BYTE[byte]) { out += String.fromCharCode(byte); continue; }
    out += '%' + HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/* One key part: bounded (string, 1..160 units, well-formed text without control bytes). This is the
 * VALIDATION half, used both for key parts and for raw member values (session refs, ticket ids,
 * candidate ids) that are stored as sorted-set members or Lua argv and never encoded. */
function assertPart(part) {
  if (typeof part !== 'string' || part.length < 1 || part.length > PART_MAX_UNITS) fail('INVALID_KEY_PART');
  if (CONTROL_CHAR.test(part) || !part.isWellFormed()) fail('INVALID_KEY_PART');
  return part;
}
/* The KEY-PART half: validate, then canonically encode. Only key construction uses this; a raw
 * member value must never be encoded (that would store a different id than the caller wrote). */
function validatePart(part) {
  return encodePart(assertPart(part));
}
/* Frozen Lua: the rate window is INCR + first-hit PEXPIRE (never slides); the lock release is a
 * compare-and-delete so a stale holder cannot free someone else's lock. */
const RATE_WINDOW_LUA = "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return n;";
const COMPARE_DEL_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end;";
/* Queue add + score trim + key TTL in ONE script. A crash between the member add and the TTL is
 * impossible when they are the same atomic unit, so a queue key can never become an immortal
 * sorted set. PEXPIRE keeps exact milliseconds. */
const QUEUE_ENQUEUE_LUA = "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]); redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3]); redis.call('PEXPIRE', KEYS[1], ARGV[4]); return 1;";
/* One presence touch in ONE script. The previous shape issued eight sequential commands under a
 * single operation deadline, which both paid eight network round trips and left a real crash window:
 * a Core/API process dying after the member ZADD but before the key PEXPIREs could persist a
 * member-carrying sorted set with NO expiry, and nothing would ever revisit it. A single atomic
 * script has no such boundary - the client's timeout or a process death can only leave the key
 * entirely untouched or fully written with its TTL. Each key's PEXPIRE immediately follows the
 * command that can create it (so a later error such as a wrong-type refusal cannot strand a
 * freshly created key), and the trims stay ordered score-prune-then-rank-cap exactly as before.
 * KEYS: 1 presence:all:<actor>, 2 presence:fg:<actor>.
 * ARGV: 1 now ms, 2 session ref, 3 window floor ms, 4 foreground '1'/'0', 5 ttlMs, 6 negative rank
 * stop. Frozen and never derived from caller input, so the EVAL cache cannot be polluted. */
const PRESENCE_TOUCH_LUA = "redis.call('ZADD', KEYS[1], 'GT', ARGV[1], ARGV[2]); "
  + "redis.call('PEXPIRE', KEYS[1], ARGV[5]); "
  + "if ARGV[4] == '1' then redis.call('ZADD', KEYS[2], 'GT', ARGV[1], ARGV[2]) else redis.call('ZREM', KEYS[2], ARGV[2]) end; "
  + "redis.call('PEXPIRE', KEYS[2], ARGV[5]); "
  + "redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[3]); "
  + "redis.call('ZREMRANGEBYRANK', KEYS[1], 0, ARGV[6]); "
  + "redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, ARGV[3]); "
  + "redis.call('ZREMRANGEBYRANK', KEYS[2], 0, ARGV[6]); "
  + "return 1;";

const fail = (code) => { throw Error(code); };

/* Conservative fallbacks. `conservative: true` tells the caller the answer is a refusal born of
 * lost coordination, not a positive fact. */
const LOSS = Object.freeze({
  cacheHit: { value: null, available: false, conservative: true },
  rateDeny: { allowed: false, available: false, conservative: true },
  lockBusy: { acquired: false, available: false, conservative: true },
});

/* Resolves `fn`/promise outcome or a timeout within `ms`, always clearing the deadline timer so a
 * completed operation leaves no leftover timer behind. Attaches rejection handlers immediately,
 * so a late rejection after the deadline wins is inert rather than unhandled. When `token` is
 * given, it is marked `cancelled` the instant the deadline fires so cooperative work (the scan
 * loops) can stop before issuing another command. */
async function within(promise, ms, token) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { if (token) token.cancelled = true; resolve({ ok: false, timeout: true }); }, ms);
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class EphemeraService {
  /**
   * @param {object} options
   * @param {string} options.url `rediss://` (verified TLS) or `redis://` (plaintext, opt-in only)
   * @param {string} options.environment 'stg'|'prd'|'test' - hard namespace boundary
   * @param {string} [options.keyVersion='v2'] bump to invalidate every family at once (v1 keys are
   *   never read/wiped by a v2 service: the schemaVersion is a strict part of the prefix)
   * @param {object} [options.socket] connect/read timeouts; a slow Redis must fail fast
   * @param {string|Buffer|Array} [options.ca] PEM root CA for verified TLS (never a bypass)
   * @param {boolean} [options.tls] force TLS on a `redis://` URL
   * @param {boolean} [options.allowPlaintext=false] explicitly opt into a plaintext `redis://`
   *
   * RECONNECT POLICY. `socket.reconnectStrategy` may be a number, a function, `false`, or omitted;
   * all of those keep working (a function still receives `(retries, cause)` and may itself return
   * `false`/an `Error` to stop). Two bounds are always enforced on top of the caller's strategy:
   *   1. No new reconnect attempt is ever made once `close()` has run: the strategy returns `false`
   *      when `this.closed`, so a closed service cannot auto-rejoin and cannot keep the event loop
   *      alive. (Auto-rejoin while OPEN is unchanged.)
   *   2. Every numeric sleep the socket awaits is capped at RECONNECT_CAP_MS (2000). node-redis
   *      awaits `promiseTimeout(retryIn)` and `disconnect()` only flips an `isOpen` flag, so an
   *      outstanding 60 s backoff timer cannot be cancelled - it would hold the process open for up
   *      to 60 s after `close()`. Capping bounds that delay while still allowing healthy reconnects.
   *      Shorter caller values are kept.
   * `socket.connectTimeout` is likewise capped at CONNECT_DEADLINE_MS (3000) so a caller's blackhole
   * timeout cannot hold an in-flight connect past close(); shorter valid values are preserved.
   *
   * `close()` therefore drains BEFORE it flips the socket's `isOpen`: node-redis assigns its awaited
   * socket only after the connect promise settles, and `socket.disconnect()` refuses once `isOpen`
   * is false, so clearing `isOpen` while the socket is still unassigned would make a late-completing
   * socket impossible to destroy. Bounded network drain is at most CONNECT_SETTLE_MS (5000) when a
   * connect is in flight; a healthy idle client closes immediately.
   */
  constructor({ url, environment, keyVersion = KEY_VERSION, socket, ca, tls, allowPlaintext = false } = {}) {
    if (typeof url !== 'string') fail('REDIS_URL_REQUIRED');
    let parsed;
    try { parsed = new URL(url); } catch { fail('REDIS_URL_REQUIRED'); }
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') fail('REDIS_URL_REQUIRED');
    if (!ENVIRONMENTS.has(environment)) fail('ENVIRONMENT_REQUIRED');
    if (!/^[a-z0-9]{1,8}$/.test(keyVersion)) fail('INVALID_KEY_VERSION');
    if (ca !== undefined && ca !== null && !(typeof ca === 'string' || Buffer.isBuffer(ca) || Array.isArray(ca))) fail('INVALID_CA');
    const secure = parsed.protocol === 'rediss:' || tls === true || (socket && socket.tls === true);
    if (!secure && allowPlaintext !== true) fail('INSECURE_REDIS_URL');
    const socketOptions = { connectTimeout: 3000, reconnectStrategy: () => 2000, ...(socket || {}) };
    /* Verification can never be weakened through the socket options. */
    if (socketOptions.rejectUnauthorized === false) fail('INSECURE_TLS_OPTION');
    if (typeof socketOptions.checkServerIdentity === 'function') fail('INSECURE_TLS_OPTION');
    if (secure && socketOptions.tls === false) fail('INSECURE_TLS_OPTION');
    socketOptions.tls = secure;
    if (secure && ca !== undefined && ca !== null && socketOptions.ca === undefined) socketOptions.ca = ca;
    this.environment = environment;
    this.keyVersion = keyVersion;
    /* Set before createClient so the wrapped reconnect strategy can consult it from the first beat. */
    this.closed = false;
    this.lastError = null;
    this.subscriptions = new Set();
    /* Cap the connect attempt too: a caller's blackhole connectTimeout (e.g. 60 s) would otherwise
     * keep an in-flight TCP connect holding the event loop past close(). Shorter valid values kept. */
    const rawConnectTimeout = socketOptions.connectTimeout;
    socketOptions.connectTimeout = (typeof rawConnectTimeout === 'number' && rawConnectTimeout > 0)
      ? Math.min(rawConnectTimeout, CONNECT_DEADLINE_MS)
      : CONNECT_DEADLINE_MS;
    /* Cap the caller's backoff. Preserve false/Error/number returns exactly; only clamp numbers. */
    const rawStrategy = socketOptions.reconnectStrategy;
    socketOptions.reconnectStrategy = (retries, cause) => {
      if (this.closed) return false;
      const decision = rawStrategy === false ? false
        : typeof rawStrategy === 'function' ? rawStrategy(retries, cause)
          : typeof rawStrategy === 'number' ? rawStrategy
            : undefined; /* undefined -> node-redis default (min(retries*50,500), always <= cap) */
      if (decision === false || decision instanceof Error) return decision;
      const ms = typeof decision === 'number' ? decision : Math.min(retries * 50, 500);
      return Math.min(ms, RECONNECT_CAP_MS);
    };
    this.client = redis.createClient({
      url,
      socket: socketOptions,
      /* A slow or absent Redis resolves to the conservative fallback instead of hanging a request. */
      disableOfflineQueue: true,
    });
    this.client.on('error', () => { /* surfaced per-operation; a client error event is not fatal */ });
    /* A rejected connect must never become an unhandled rejection; the connect phase is itself
     * deadline-bounded so operations never wait on a reconnect backoff forever. */
    const rawConnect = this.client.connect().catch(() => {});
    /* Late-completion guard: node-redis assigns its awaited socket AFTER disconnect() has already
     * cleared isOpen, so a TCP connect that completes after close() can become ready with no owner.
     * Re-check on the ACTUAL connect promise (not `within`) and hard-disconnect it so it cannot leak. */
    const guardLateConnect = () => { if (this.closed) Promise.resolve().then(() => this.client.disconnect()).catch(() => {}); };
    rawConnect.then(guardLateConnect, guardLateConnect);
    this.connected = within(rawConnect, CONNECT_DEADLINE_MS).then(() => {});
  }

  /* ---- naming ---- */
  /* `mx:<env>:<keyVersion>:<family>:<encoded parts...>`. Every part is validated against the durable
   * identity grammar and then canonically percent-encoded, so the ':' joiner is unambiguous: two
   * different (family, parts...) tuples always yield distinct keys and no part can inject a separator
   * or impersonate the fixed prefix. A simple ASCII id such as `actor_1` still renders unchanged. */
  key(family, ...parts) {
    if (!FAMILIES.has(family)) fail('UNKNOWN_FAMILY');
    return ['mx', this.environment, this.keyVersion, family, ...parts.map((p) => validatePart(p))].join(':');
  }

  async #op(fn, loss) {
    if (this.closed) return loss;
    /* The in-flight work must never become an unhandled rejection - neither when its deadline wins
     * the race (client closed underneath it) nor when it rejects outright: both resolve to the
     * documented conservative fallback. `within` clears the deadline timer either way. */
    const work = this.connected.then(() => {
      if (this.closed) throw Error('EPHEMERA_CLOSED');
      return fn(this.client);
    });
    const outcome = await within(work, OP_DEADLINE_MS);
    if (!outcome.ok) { this.lastError = outcome.timeout ? 'DEADLINE' : (outcome.error && outcome.error.message); return loss; }
    this.lastError = null;
    return outcome.value;
  }

  static #bounded(value, ttlMs, what) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('TTL_REQUIRED');
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_VALUE_BYTES) fail('VALUE_TOO_LARGE');
    return text;
  }

  /* ---- per-session presence (V5 P06 API consumer). Two bounded ZSETs per actor: every tracked
   * session in `all`, the foreground subset in `fg`. The score is the last `seen` ms, so the read
   * window (45 s) is the same one the legacy session_presence row used and a member that stops
   * heartbeating simply ages out of the window and then off the key. `sessionRef` is a NON-secret
   * derived id (the public 24-hex session id), never the bearer, so the value allowlist and the
   * 4 KiB bound are respected and no credential reaches Redis. ---- */
  async presenceTouch(actor, sessionRef, foreground, ttlMs = 60000) {
    const ref = assertPart(sessionRef);
    if (typeof foreground !== 'boolean') fail('INVALID_PRESENCE');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('TTL_REQUIRED');
    const all = this.key('presence', 'all', actor);
    const fg = this.key('presence', 'fg', actor);
    const now = Date.now();
    const floor = now - PRESENCE_WINDOW_MS;
    return this.#op(async (c) => {
      /* ONE atomic script: member GT add, key TTL refresh and both bounded trims. The client can
       * time out or the process can die, but the whole mutation either happened with a TTL already in
       * place or did not happen - a member-carrying key can never be left immortal. `GT` still means
       * a stale/earlier heartbeat can never move a session backwards in time; the rank stop is the
       * same -(PRESENCE_CAP + 1) the sequential version used, so at most PRESENCE_CAP members survive. */
      await c.sendCommand(['EVAL', PRESENCE_TOUCH_LUA, '2', all, fg,
        String(now), ref, String(floor), foreground ? '1' : '0', String(ttlMs), String(-(PRESENCE_CAP + 1))]);
      return { stored: true, available: true };
    }, { stored: false, available: false, conservative: true });
  }
  /* Read every still-live session for one actor. A member outside the 45 s window is filtered out
   * (it ages off the key entirely on the next touch) so a stale score is never reported live. An
   * unavailable Redis is the conservative empty result with `available:false`; the caller then
   * renders the actor offline, never online. */
  async presenceRead(actor) {
    const all = this.key('presence', 'all', actor);
    const fg = this.key('presence', 'fg', actor);
    const now = Date.now();
    const floor = now - PRESENCE_WINDOW_MS;
    return this.#op(async (c) => {
      const [allRows, fgRows] = await Promise.all([
        c.zRangeByScoreWithScores(all, floor, '+inf'),
        c.zRangeByScoreWithScores(fg, floor, '+inf'),
      ]);
      const foreground = new Set(fgRows.map((r) => r.value));
      return { sessions: allRows.map((r) => ({ ref: r.value, foreground: foreground.has(r.value), seen: Number(r.score) })), available: true };
    }, { sessions: [], available: false, conservative: true });
  }
  async presenceDrop(actor, sessionRef) {
    const ref = assertPart(sessionRef);
    const all = this.key('presence', 'all', actor);
    const fg = this.key('presence', 'fg', actor);
    return this.#op(async (c) => {
      await c.zRem(all, ref);
      await c.zRem(fg, ref);
      return { dropped: true, available: true };
    }, { dropped: false, available: false, conservative: true });
  }
  async presenceDropActor(actor) {
    const all = this.key('presence', 'all', actor);
    const fg = this.key('presence', 'fg', actor);
    return this.#op((c) => c.del([all, fg]).then(() => ({ dropped: true, available: true })), { dropped: false, available: false, conservative: true });
  }
  /* Revocation hints: ONE bounded key per revoked session ref, whose TTL outlives any in-flight
  * heartbeat. The API writes them post-commit so a delayed heartbeat can fence itself, and reads
  * them so a stale member is never projected online. Advisory only - the durable session row decides;
  * a lost hint can only make behaviour MORE conservative. */
  async presenceSetRevoked(refs, ttlMs = 300000) {
    if (!Array.isArray(refs)) fail('INVALID_PRESENCE');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('TTL_REQUIRED');
    const list = [...new Set(refs.filter((r) => typeof r === 'string' && r))].slice(0, 256);
    if (!list.length) return { stored: true, available: true };
    return this.#op(async (c) => {
      const pipeline = c.multi();
      for (const ref of list) pipeline.set(this.key('hint', PRESENCE_HINT_KIND, assertPart(ref)), '1', { PX: ttlMs });
      await pipeline.exec(true);
      return { stored: true, available: true };
    }, { stored: false, available: false, conservative: true });
  }
  async presenceCheckRevoked(refs) {
    const list = [...new Set((Array.isArray(refs) ? refs : []).filter((r) => typeof r === 'string' && r))].slice(0, 512);
    if (!list.length) return { revoked: [], available: true };
    return this.#op(async (c) => {
      const pipeline = c.multi();
      for (const ref of list) pipeline.get(this.key('hint', PRESENCE_HINT_KIND, assertPart(ref)));
      const replies = await pipeline.exec(true);
      const revoked = list.filter((_, i) => replies[i] !== null && replies[i] !== undefined);
      return { revoked, available: true };
    }, { revoked: [], available: false, conservative: true });
  }
  /* Bounded multi-actor read for a LIST projection (friends). ONE pipelined round trip instead of N
   * sequential reads, with `max` capping the fan-out; a caller that lists more actors than the cap
   * gets the conservative empty per-actor result for the overflow, never an unbounded pipeline. */
  async presenceReadMany(actors, { max = 512 } = {}) {
    if (!Number.isSafeInteger(max) || max <= 0) fail('INVALID_LIMIT');
    const list = [...new Set(actors.filter((a) => a !== undefined && a !== null).map(String))].slice(0, max);
    if (!list.length) return { presence: [], available: true };
    const floor = Date.now() - PRESENCE_WINDOW_MS;
    return this.#op(async (c) => {
      const pipeline = c.multi();
      for (const actor of list) {
        pipeline.zRangeByScoreWithScores(this.key('presence', 'all', actor), floor, '+inf');
        pipeline.zRangeByScoreWithScores(this.key('presence', 'fg', actor), floor, '+inf');
      }
      const replies = await pipeline.exec(true);
      const presence = list.map((actor, i) => {
        const allRows = replies[i * 2] || [];
        const fgRows = replies[i * 2 + 1] || [];
        const foreground = new Set(fgRows.map((r) => r.value));
        return { actor, foreground: fgRows.length > 0, sessions: allRows.map((r) => ({ ref: r.value, foreground: foreground.has(r.value), seen: Number(r.score) })) };
      });
      return { presence, available: true };
    }, { presence: [], available: false, conservative: true });
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
    assertPart(bucket);
    if (!Number.isSafeInteger(limit) || limit <= 0) fail('INVALID_LIMIT');
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) fail('INVALID_WINDOW');
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
    assertPart(name);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('TTL_REQUIRED');
    const token = crypto.randomBytes(16).toString('base64url');
    const k = this.key('lock', name);
    return this.#op((c) => c.set(k, token, { NX: true, PX: ttlMs }).then((ok) => (ok
      ? { acquired: true, token, available: true }
      : { acquired: false, available: true })), LOSS.lockBusy);
  }
  async releaseLock(name, token) {
    assertPart(name);
    if (typeof token !== 'string') return { released: false };
    const k = this.key('lock', name);
    return this.#op(async (c) => {
      const n = await c.sendCommand(['EVAL', COMPARE_DEL_LUA, '1', k, token]);
      return { released: Number(n) === 1, available: true };
    }, { released: false, available: false, conservative: true });
  }

  /* ---- revocation/limit HINTS. Hints only make the system more conservative; PostgreSQL decides. ---- */
  async setHint(kind, id, ttlMs) {
    assertPart(kind);
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
    assertPart(connectionId);
    const value = EphemeraService.#bounded(payload, ttlMs, 'route');
    const k = this.key('route', connectionId);
    return this.#op((c) => c.set(k, value, { PX: ttlMs }).then(() => ({ stored: true, available: true })), { stored: false, available: false, conservative: true });
  }
  async locateRoute(connectionId) {
    const k = this.key('route', connectionId);
    return this.#op(async (c) => ({ value: await c.get(k), available: true }), LOSS.cacheHit);
  }

  /* ---- candidate queue index: a sorted set whose members age out by score and whose KEY has a
   * TTL set atomically with the add (see QUEUE_ENQUEUE_LUA). ---- */
  async enqueueCandidate(mode, ticketId, weight = 0, { windowMs = 300000, keyTtlMs = 3600000 } = {}) {
    assertPart(mode); assertPart(ticketId);
    if (!Number.isFinite(Number(weight))) fail('INVALID_WEIGHT');
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) fail('INVALID_WINDOW');
    if (!Number.isSafeInteger(keyTtlMs) || keyTtlMs <= 0) fail('TTL_REQUIRED');
    const key = this.key('queue', mode);
    return this.#op(async (c) => {
      const at = Date.now();
      /* ZADD + score trim + PEXPIRE are one atomic script: a crash cannot strand an immortal set. */
      await c.sendCommand(['EVAL', QUEUE_ENQUEUE_LUA, '1', key,
        String(at + Number(weight)), ticketId, String(at - windowMs), String(keyTtlMs)]);
      return { queued: true, available: true };
    }, { queued: false, available: false, conservative: true });
  }
  async peekCandidates(mode, { max = 16, windowMs = 300000 } = {}) {
    assertPart(mode);
    if (!Number.isSafeInteger(max) || max <= 0) fail('INVALID_LIMIT');
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) fail('INVALID_WINDOW');
    const key = this.key('queue', mode);
    return this.#op(async (c) => {
      const rows = await c.zRangeWithScores(key, 0, max - 1);
      const floor = Date.now() - windowMs;
      return { candidates: rows.filter((r) => r.score >= floor).map((r) => r.value), available: true };
    }, { candidates: [], available: false, conservative: true });
  }
  async dropCandidate(mode, ticketId) {
    assertPart(mode); assertPart(ticketId);
    const key = this.key('queue', mode);
    return this.#op((c) => c.zRem(key, ticketId).then(() => ({ dropped: true, available: true })), { dropped: false, available: false, conservative: true });
  }

  /* ---- pub/sub notifications (rebuildable fan-out; durable notices live in ops.outbox) ---- */
  async publish(channel, message, ttlMs = 30000) {
    assertPart(channel);
    const text = EphemeraService.#bounded(message, ttlMs, 'pubsub');
    const key = this.key('cache', 'ch', channel);
    return this.#op((c) => c.publish(key, text).then(() => ({ published: true, available: true })), { published: false, available: false, conservative: true });
  }
  /* Opens a dedicated, service-owned subscriber. Connect and subscribe share ONE bounded deadline
   * (never 2s + 2s); on failure the client is released (bounded, with any pending connect allowed to
   * settle first) - its duplicate has reconnect disabled, so no reconnect work is ever leaked - and a
   * conservative `available:false` result is returned. The listener ignores messages once closed. */
  async subscribe(channel, onMessage) {
    assertPart(channel);
    if (typeof onMessage !== 'function') fail('LISTENER_REQUIRED');
    if (this.closed) return { available: false, conservative: true, unsubscribe: () => {} };
    const key = this.key('cache', 'ch', channel);
    const sub = this.client.duplicate({
      socket: { ...this.client.options.socket, reconnectStrategy: false },
    });
    sub.on('error', () => { /* surfaced per-operation */ });
    this.subscriptions.add(sub);
    const listener = (text) => { if (this.closed) return; try { onMessage(text); } catch { /* listener fault is not fatal */ } };
    /* One operation, one deadline with a cancel token: connect and subscribe race the same timer.
     * The token is checked between the two steps so a timeout can never let a late SUBSCRIBE run.
     * The raw connect promise gets its own guard: if the TCP socket completes only after the
     * deadline or after close, the client is released again (node-redis assigns the awaited socket
     * after disconnect() has cleared isOpen, so that late completion is the only leak window). */
    const token = { cancelled: false };
    const run = (async () => {
      const rawConnect = sub.connect();
      const guard = () => { if (this.closed || token.cancelled) this.#releaseClient(sub).catch(() => {}); };
      rawConnect.then(guard, guard);
      await rawConnect;
      if (this.closed || token.cancelled) throw Error(this.closed ? 'EPHEMERA_CLOSED' : 'EPHEMERA_DEADLINE');
      await sub.subscribe(key, listener);
      return true;
    })();
    const outcome = await within(run, OP_DEADLINE_MS, token);
    if (!outcome.ok) {
      /* Release in the background so an unresponsive socket cannot delay this return; #releaseClient
       * is bounded and idempotent, and the token still blocks any late SUBSCRIBE. */
      this.#releaseClient(sub).catch(() => {});
      return { available: false, conservative: true, unsubscribe: () => {} };
    }
    return { available: true, unsubscribe: () => this.#releaseClient(sub, key) };
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
   * construction, and durable PostgreSQL truth is never touched. The whole scan is deadline-bounded
   * so a slow or dead Redis reports the conservative result instead of hanging. */
  async wipeNamespace() {
    if (this.closed) return { deleted: 0, available: false };
    const token = { cancelled: false };
    const outcome = await within(this.#wipe(token), OP_DEADLINE_MS, token);
    if (!outcome.ok) return { deleted: 0, available: false };
    return outcome.value;
  }
  async #wipe(token) {
    await this.connected;
    const pattern = `mx:${this.environment}:${this.keyVersion}:*`;
    let deleted = 0, cursor = '0';
    do {
      if (this.closed || token.cancelled) return { deleted, available: false };
      const { cursor: next, keys } = EphemeraService.#scanReply(await this.client.scan(cursor, { MATCH: pattern, COUNT: 200 }));
      cursor = next;
      if (this.closed || token.cancelled) return { deleted, available: false };
      if (keys.length) deleted += await this.client.del(keys);
    } while (cursor !== '0' && !token.cancelled);
    return { deleted, available: true };
  }
  /* The bounded-key audit: every mx: key in this namespace must carry a positive TTL or be a
   * sorted set key with one. Proof for 'no unbounded immortal keys'. Deadline-bounded like the wipe. */
  async auditUnboundedKeys() {
    if (this.closed) return { unbounded: [], available: false };
    const token = { cancelled: false };
    const outcome = await within(this.#audit(token), OP_DEADLINE_MS, token);
    if (!outcome.ok) return { unbounded: [], available: false };
    return outcome.value;
  }
  async #audit(token) {
    await this.connected;
    const pattern = `mx:${this.environment}:${this.keyVersion}:*`;
    const unbounded = [];
    let cursor = '0';
    do {
      if (this.closed || token.cancelled) return { unbounded, available: false };
      const { cursor: next, keys } = EphemeraService.#scanReply(await this.client.scan(cursor, { MATCH: pattern, COUNT: 200 }));
      cursor = next;
      for (const key of keys) {
        if (this.closed || token.cancelled) return { unbounded, available: false };
        const ttl = await this.client.pTTL(key);
        if (ttl === -1) unbounded.push(key);
      }
    } while (cursor !== '0' && !token.cancelled);
    return { unbounded, available: true };
  }

  /* Releases one owned client: drop its channel(s) politely (bounded, best-effort), then hard
   * disconnect so the socket and its reconnect scheduler are always gone. disconnect() is the
   * supported hard close on this client version and is used instead of a graceful quit(): quit()
   * waits on the command queue and, when Redis is unreachable, never resolves, which would leak the
   * socket (and the process) forever. Every step is bounded; the entry leaves the owned set whether
   * or not this call is the one that closes it. */
  async #releaseClient(client, channel) {
    if (channel) await within(client.unsubscribe(channel).catch(() => {}), OP_DEADLINE_MS);
    /* A pending connect must be allowed to settle before isOpen is flipped, or a late socket could
     * never be destroyed (see #hardDisconnect). */
    await this.#hardDisconnect(client);
    this.subscriptions.delete(client);
  }

  /* Hard-disconnects `client` only once it is safe: node-redis's socket.disconnect() refuses (throws)
   * when its isOpen is already false, and isOpen is cleared by an EARLIER disconnect that ran while
   * the connect socket was still unassigned - in which case this late call cannot destroy the socket.
   * So if the client is open but not ready, wait (bounded) for readiness or failure, then retry the
   * disconnect; a still-pending connect is bounded by connectTimeout plus the capped backoff. */
  async #hardDisconnect(client) {
    const attempt = () => Promise.resolve().then(() => client.disconnect()).catch(() => {});
    if (client.isOpen && !client.isReady) {
      await within((async () => {
        await new Promise((resolve) => {
          const done = () => { client.off('ready', done); client.off('error', done); resolve(); };
          client.once('ready', done);
          client.once('error', done);
        });
      })(), CONNECT_SETTLE_MS);
    }
    await attempt();
    /* A connect that settles just after the wait can still assign its socket; give it one more try. */
    await attempt();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    /* Release every owned subscriber first, even one that never connected or was already
     * unsubscribed, so nothing can schedule work after close. The closed flag already makes the
     * reconnect strategy refuse new attempts; draining before the hard disconnect avoids flipping
     * isOpen while a socket is still unassigned. */
    const owned = [...this.subscriptions];
    this.subscriptions.clear();
    await Promise.all(owned.map((sub) => this.#releaseClient(sub)));
    await this.#releaseClient(this.client);
  }
}

async function createEphemeraService(options) {
  const service = new EphemeraService(options);
  return service;
}

module.exports = { createEphemeraService, FAMILIES, KEY_VERSION, MAX_VALUE_BYTES };
