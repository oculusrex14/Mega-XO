'use strict';
/* P06 API/Core consumer child-process fixture.
 *
 * A REAL second (third, ...) Node process that boots the ACTUAL guarded PostgreSQL runtime factories
 * (packages/services/accounts.js as `api_runtime`, packages/services/core.js as `core_runtime`) and
 * a caller-owned `packages/services/ephemera.js` adapter, then answers IPC commands by driving those
 * real consumer methods. Two API objects inside one process share one event loop, one pool and one
 * GC; they cannot prove that a heartbeat written by one API process is observed by another. This
 * fixture spawns genuine separate OS processes with distinct PIDs, so cross-process presence and the
 * durable-authority invariants are exercised for real.
 *
 * The child owns NO test framework: it is inert when imported (`require.main !== module`), so the
 * runner's own subprocess load of a test file never starts a service. It exits NATURALLY (code 0, no
 * `process.exit`, no watchdog) after `shutdown`, which is itself the proof that close() released
 * every owned pool, ephemera client and subscription: a leaked client or timer would keep the event
 * loop alive and the parent's natural-exit assertion would time out.
 *
 * The ephemera adapter is CALLER-OWNED (contract): the API factory never closes it. Here the caller
 * is this child, so the child closes it after the API/Core service has been closed.
 *
 * Protocol (fd 3, one JSON object per line):
 *   child -> parent  { t:'ready', pid, role, schemaHead, ephemera }
 *                    { t:'reply', id, ok:true, value } | { t:'reply', id, ok:false, error }
 *                    { t:'closed' } | { t:'fatal', error }
 *   parent -> child  { id, cmd, ... }   (commands arrive on the child's stdin / fd 0)
 */
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const ROOT = path.join(__dirname, '..', '..');
const CHANNEL = 3;
/* An unreachable loopback endpoint for the "dependency unavailable" child. */
const DEAD_URL = 'redis://127.0.0.1:59999';

const { createPgPool } = require(path.join(ROOT, 'packages/db/pg/pool.js'));
const { createAccountService } = require(path.join(ROOT, 'packages/services/accounts.js'));
const { createCoreService } = require(path.join(ROOT, 'packages/services/core.js'));
const { createTicketIssuer, redeemRealtimeTicket } = require(path.join(ROOT, 'packages/services/tickets.js'));
const { createRefreshService } = require(path.join(ROOT, 'packages/services/refresh.js'));
const { createEphemeraService } = require(path.join(ROOT, 'packages/services/ephemera.js'));

/* A bounded promise/timeout race that ALWAYS clears its timer, so a successful race leaves no
 * watchdog behind to hold the process open. */
async function raceTimeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(resolve, ms, onTimeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

/* Settles ANY close/pool-end outcome. A service `close()` may be SYNCHRONOUS (returns undefined,
 * e.g. core.close / the ticket issuer's close) or a Promise (accounts.close is async), so `.catch`
 * cannot be chained blindly. This awaits either and swallows ONLY the close error: every close is
 * idempotent and best-effort, and a close failure must never mask the real result nor keep the
 * process alive. */
async function settleClose(thunk) {
  try { await thunk(); } catch { /* best effort; caller-owned pools are ended separately */ }
}

/* ---------------------------------------------------------------- child side */

function childSend(payload) {
  try { fs.writeSync(CHANNEL, JSON.stringify(payload) + '\n'); } catch { /* parent gone */ }
}

/* Parses the loopback database URL the parent passes into the discrete fields createPgPool needs.
 * The runtime login user is always the asserted role (ROLE_USER_MISMATCH otherwise). */
function poolConfigFromUrl(databaseUrl, role, service) {
  const u = new URL(databaseUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: role,
    role,
    label: 'test',
    service,
    revision: 'p06consumer',
    allowLocalNoTls: true,
    pool: { max: 2, idleTimeoutMillis: 5000, connectionTimeoutMillis: 5000, queueLimit: 8 },
    lockTimeoutMs: 20000,
    statementTimeoutMs: 30000,
    idleInTransactionTimeoutMs: 30000,
    budget: { totalConnections: 4, roleConnections: { [role]: 4 } },
  };
}

async function childMain() {
  const payload = JSON.parse(process.env.V5_PRESENCE_PAYLOAD || '{}');
  const role = payload.role === 'core_runtime' ? 'core_runtime' : 'api_runtime';
  const clock = () => Number(payload.clock);
  const otpSecret = payload.otpSecret || 'v5-p06-consumer-test-otp-secret';

  const pool = createPgPool(poolConfigFromUrl(payload.databaseUrl, role, `p06consumer-${role}`));

  /* `redis` null => NO ephemera option at all (the conservative absent default). A `redis.url` of
   * DEAD_URL => a real adapter against an unreachable endpoint (dependency unavailable). The parent
   * may target a MANAGED namespace by setting `keyVersion` (the canonical adapter option) and
   * `environment`, and may pass native `rediss://` (verified TLS is never weakened: no
   * `rejectUnauthorized:false`, no custom identity check). The plaintext opt-in is derived from the
   * URL scheme unless the caller states it explicitly. */
  let ephemera = null;
  if (payload.redis) {
    const { socket, allowPlaintext, ...redisOptions } = payload.redis;
    const url = redisOptions.url || '';
    ephemera = await createEphemeraService({
      environment: 'test',
      allowPlaintext: allowPlaintext !== undefined ? allowPlaintext : !String(url).startsWith('rediss://'),
      ...redisOptions,
      socket: { connectTimeout: 3000, ...(socket || {}) },
    });
  }

  let accounts = null, core = null, issuer = null, refresh = null;
  /* Live `watchMatch` handles opened by the parent and the seq counter for their notifications. The
   * child OWNS these subscriptions (they run on the caller-owned adapter), so it unsubscribes every
   * one of them during shutdown; a leaked subscriber would keep the event loop alive. */
  const watches = new Map();
  /* Deferred-listener gates (one per armed watchId); released at shutdown so a held listener can
   * never block the natural drain. */
  const listGates = new Map();
  let watchSeq = 0;
  try {
    if (role === 'api_runtime') {
      accounts = await createAccountService(pool, {
        now: clock, otpSecret,
        ...(ephemera ? { ephemera } : {}),
      });
      issuer = await createTicketIssuer(pool, { now: clock, environment: payload.environment || 'test' });
      refresh = await createRefreshService(pool, { now: clock, mintAccess: async () => 'synthetic-access-token' });
    } else {
      /* The Core factory BORROWS the caller-owned adapter (never creates/closes it): only when the
       * parent asked for one is `options.ephemera` supplied, so `redis:null` is the true absent
       * default and a dead endpoint is a genuine (present) unavailable dependency. */
      core = await createCoreService(pool, { now: clock, ...(ephemera ? { ephemera } : {}) });
    }
  } catch (error) {
    /* A failed boot must still clean up the pool it opened before reporting fatal. */
    await settleClose(() => pool.end());
    if (ephemera) await settleClose(() => ephemera.close());
    throw error;
  }

  /* Only real consumer methods are callable; there is no echo adapter and no fake Core. */
  const METHODS = {
    issue: (a) => accounts.issue(...(a || [])),
    heartbeat: (a) => accounts.heartbeat(...(a || [])),
    view: (a) => accounts.view(...(a || [])),
    self: (a) => accounts.self(...(a || [])),
    friends: (a) => accounts.friends(...(a || [])),
    edit: (a) => accounts.edit(...(a || [])),
    social: (a) => accounts.social(...(a || [])),
    sessions: (a) => accounts.sessions(...(a || [])),
    revokeSession: (a) => accounts.revokeSession(...(a || [])),
    revokeOtherSessions: (a) => accounts.revokeOtherSessions(...(a || [])),
    logout: (a) => accounts.logout(...(a || [])),
    issueTicket: (a) => issuer.issue(...(a || [])),
    startFamily: (a) => refresh.startFamily(...(a || [])),
    rotateRefresh: (a) => refresh.rotate(...(a || [])),
    revokeFamily: (a) => refresh.revokeFamily(...(a || [])),
    redeemTicket: (a) => redeemRealtimeTicket(pool, { ...((a && a[0]) || {}), now: clock }),
    coreRun: (a) => core.run(...(a || [])),
    /* Real Core match observer surfaces (the P06 changed path). `readMatch` is the durable
     * membership selector and `watchMatch` opens a real subscription on the child's OWN Core
     * service. The child keeps the returned handle and pushes the initial snapshot back to the
     * parent plus every POST-initial notification delivered on the `core-match` channel. */
    readMatch: (a) => core.readMatch(...(a || [])),
    watchMatch: async (a) => {
      const [actor, matchId] = a || [];
      const started = Date.now();
      watchSeq += 1;
      const watchId = `w${watchSeq}`;
      /* A REAL deferred-async listener: the parent can gate the first callback so it blocks until
       * released, letting a test commit several changes while the listener is held and observe that
       * the coalescing pump delivers only ONE follow-up (the latest PG revision) afterwards. The
       * listener still awaits durable truth (the snapshot passed in is a real PostgreSQL read); the
       * gate only delays the child's acknowledgement, exactly like a slow consumer. */
      const handle = await core.watchMatch(actor, matchId, async (snapshot) => {
        const gate = listGates.get(watchId);
        if (gate) { gate.seen += 1; await gate.promise; }
        childSend({ t: 'matchUpdate', watchId, snapshot });
      });
      watches.set(watchId, handle);
      return { watchId, available: handle.available, snapshot: handle.snapshot, openedMs: Date.now() - started };
    },
    /* A strong current PG read through the live handle (never a cached aggregate), independent of
     * whether the subscription/hints are available. */
    watchRefresh: (a) => watches.get((a || [])[0]).refresh(),
    /* Closes ONE owned subscription (the caller's adapter/pool are untouched). Synchronous stop: it
     * suppresses later callbacks immediately, without waiting for a listener already deferred. */
    watchUnsubscribe: (a) => {
      const watchId = (a || [])[0];
      const handle = watches.get(watchId);
      watches.delete(watchId);
      if (handle) handle.unsubscribe();
      return { closed: true };
    },
    /* Arm a deferred gate on the NEXT delivery for watchId (and count deliveries). The gate holds the
     * real listener until releaseGate resolves it, so the parent deterministically controls timing. */
    armDeferredListener: (a) => {
      const watchId = (a || [])[0];
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      listGates.set(watchId, { promise, release, seen: 0 });
      return { armed: true };
    },
    /* Report the current deferred-gate state for a watch so a test can wait until the real listener
     * is actually blocked (seen>=1) before committing further changes. */
    deferredState: (a) => {
      const watchId = (a || [])[0];
      const gate = listGates.get(watchId);
      return { armed: listGates.has(watchId), seen: gate ? gate.seen : null };
    },
    /* Resolve the armed gate (optionally after a short delay) and report how many deliveries occurred
     * while it was held. The delay lets in-flight hint bursts coalesce before the listener releases. */
    releaseDeferredListener: async (a) => {
      const watchId = (a || [])[0];
      const delayMs = Number((a || [])[1] || 0);
      const gate = listGates.get(watchId);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (gate) { listGates.delete(watchId); gate.release(); }
      return { seen: gate ? gate.seen : 0 };
    },
    /* The caller-owned adapter's own bounded operations, used to prove the wipe/rejoin contract at
     * the transport the API/Core uses (never a mock). */
    wipeNamespace: () => ephemera.wipeNamespace(),
    auditUnboundedKeys: () => ephemera.auditUnboundedKeys(),
    presenceRead: (a) => ephemera.presenceRead(...(a || [])),
    /* Raw adapter probes used ONLY to prove the revocation fence: they drive the caller-owned adapter
     * directly (never a mock) so a test can simulate a delayed write and observe the hint set. */
    presenceTouch: (a) => ephemera.presenceTouch(...(a || [])),
    presenceCheckRevoked: (a) => ephemera.presenceCheckRevoked(...(a || [])),
    /* Publishes a RAW string on the match channel through the child's OWN caller-owned adapter, so a
     * test can prove a forged/malformed hint cannot fabricate a snapshot. `args` is [text]. */
    publishRaw: (a) => ephemera.publish('core-match', (a || [])[0], 30000),
    /* Closes ONLY the API service (never the pool or the caller-owned adapter). The follow-up
     * `ephemeraHealthy` proves the adapter survived it: the API must never close caller state. */
    closeApi: async () => { if (accounts) await settleClose(() => accounts.close()); return { closed: true }; },
    ephemeraHealthy: async () => ({ healthy: ephemera ? await ephemera.healthy() : null, present: ephemera !== null }),
    describe: () => {
      const svc = accounts || core || issuer;
      return { role: svc.readiness.role, schemaHead: svc.readiness.schemaHead, ephemera: ephemera !== null };
    },
  };

  const closeAll = async () => {
    /* Order: consumers first, then the CALLER-owned ephemera adapter, then the pool. Every close is
     * idempotent; a SYNCHRONOUS close (core.close / the ticket issuer's close) returns undefined, so
     * each is awaited through settleClose rather than chained with `.catch`, which would throw. */
    /* Release any armed deferred-listener gate BEFORE tearing watches down, so a held listener
     * cannot keep the process from draining. */
    for (const [, gate] of listGates) gate.release();
    listGates.clear();
    /* Release every observer subscription this child opened BEFORE the adapter it runs on is closed:
     * a live subscriber is a real client that would otherwise keep the event loop alive, so the
     * natural-exit assertion is the leak proof for the owned subscriptions too. */
    for (const [, handle] of watches) await settleClose(() => handle.unsubscribe());
    watches.clear();
    if (accounts) await settleClose(() => accounts.close());
    if (issuer) await settleClose(() => issuer.close());
    if (refresh) await settleClose(() => refresh.close());
    if (core) await settleClose(() => core.close());
    if (ephemera) await settleClose(() => ephemera.close());
    await settleClose(() => pool.end());
  };

  const description = METHODS.describe();
  childSend({ t: 'ready', pid: process.pid, role, schemaHead: description.schemaHead, ephemera: description.ephemera });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      if (request.cmd === 'shutdown') {
        try { await closeAll(); childSend({ t: 'reply', id: request.id, ok: true, value: { closed: true } }); }
        catch (error) { childSend({ t: 'reply', id: request.id, ok: false, error: error && error.message ? error.message : String(error) }); }
        childSend({ t: 'closed' });
        break;
      }
      try {
        const fn = METHODS[request.cmd];
        if (!fn) throw Error('UNKNOWN_METHOD:' + request.cmd);
        const value = await fn(request.args);
        childSend({ t: 'reply', id: request.id, ok: true, value });
      } catch (error) {
        childSend({ t: 'reply', id: request.id, ok: false, error: error && error.message ? error.message : String(error) });
      }
    }
  } finally {
    lines.close();
    process.stdin.pause();
    if (typeof process.stdin.unref === 'function') process.stdin.unref();
    /* Runs on an abnormal stdin close too (parent died): a failed parent can never orphan pools. */
    await closeAll();
  }
}

if (require.main === module) {
  childMain().catch((error) => {
    childSend({ t: 'fatal', error: error && error.message ? error.message : String(error) });
    process.exitCode = 1;
  });
}

/* ---------------------------------------------------------------- parent side */

class PresenceChild extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.pid = null;
    this.role = null;
    this.schemaHead = null;
    this.hasEphemera = false;
    this.replies = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.fatal = null;
    this.exited = false;
    /* POST-initial `watchMatch` notifications pushed by the child, keyed by the child's watchId. A
     * test consumes them with `nextMatchUpdate` so it never polls or races a fixed sleep. */
    this.matchUpdates = new Map();
    this.matchWaiters = [];
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => { this.exited = true; resolve({ code, signal }); });
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.#wire();
  }

  #wire() {
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    const protocol = createInterface({ input: this.child.stdio[CHANNEL], crlfDelay: Infinity });
    this.protocol = protocol;
    protocol.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      switch (message.t) {
        case 'ready':
          this.pid = message.pid;
          this.role = message.role;
          this.schemaHead = message.schemaHead;
          this.hasEphemera = message.ephemera === true;
          this.resolveReady(message);
          break;
        case 'fatal':
          this.fatal = message.error;
          this.rejectReady(Error('PRESENCE_CHILD_FATAL:' + message.error));
          break;
        case 'matchUpdate': {
          /* A real post-initial snapshot delivered by the child's `watchMatch` listener. Hand it to
           * the first matching waiter, else queue it for the next `nextMatchUpdate` call. */
          const update = { watchId: message.watchId, snapshot: message.snapshot };
          const idx = this.matchWaiters.findIndex((w) => w.watchId === message.watchId);
          if (idx >= 0) { const w = this.matchWaiters.splice(idx, 1)[0]; clearTimeout(w.timer); w.resolve(update); }
          else { if (!this.matchUpdates.has(message.watchId)) this.matchUpdates.set(message.watchId, []); this.matchUpdates.get(message.watchId).push(update); }
          break;
        }
        case 'reply': {
          const pending = this.replies.get(message.id);
          if (!pending) break;
          this.replies.delete(message.id);
          clearTimeout(pending.timer);
          if (message.ok) pending.resolve(message.value);
          else pending.reject(Object.assign(Error(message.error), { code: message.error }));
          break;
        }
        default:
          break;
      }
    });
    this.child.once('exit', (code) => {
      if (this.pid === null) this.rejectReady(Error(`PRESENCE_CHILD_EARLY_EXIT:${code}:${this.stderr.trim()}`));
      for (const [, pending] of this.replies) { clearTimeout(pending.timer); pending.reject(Error('PRESENCE_CHILD_EXITED')); }
      this.replies.clear();
      for (const w of this.matchWaiters) { clearTimeout(w.timer); w.reject(Error('PRESENCE_CHILD_EXITED')); }
      this.matchWaiters = [];
      this.emit('exit', { code });
    });
  }

  /* Resolve with the next POST-initial `watchMatch` notification for `watchId` (or reject on
   * timeout). A queued update resolves immediately, so no polling or fixed sleep is needed. */
  nextMatchUpdate(watchId, timeout = 8000) {
    const queue = this.matchUpdates.get(watchId);
    if (queue && queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.matchWaiters.findIndex((w) => w.watchId === watchId);
        if (idx >= 0) this.matchWaiters.splice(idx, 1);
        reject(Error(`PRESENCE_CHILD_NO_MATCH_UPDATE:${watchId}`));
      }, timeout);
      this.matchWaiters.push({ watchId, resolve, reject, timer });
    });
  }

  #send(cmd, extra = {}, timeout = 15000) {
    if (this.exited) return Promise.reject(Error('PRESENCE_CHILD_EXITED'));
    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, ...extra }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(id); reject(Error(`PRESENCE_CHILD_TIMEOUT:${cmd}`)); }, timeout);
      this.replies.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(line); } catch (error) { clearTimeout(timer); this.replies.delete(id); reject(error); }
    });
  }

  /* Drive one real consumer method in the child process. `args` is the argument array. */
  call(method, args = [], { timeout } = {}) { return this.#send(method, { args }, timeout); }

  /* Ask the child to close its services and the process to exit on its own; returns the natural
   * exit record so the caller can assert code 0 / signal null. */
  async shutdown(timeout = 15000) {
    await this.#send('shutdown', {}, timeout);
    return this.waitExit(timeout);
  }

  async waitExit(timeout = 15000) {
    const raced = await raceTimeout(this.exit.then((record) => ({ record })), timeout, { timedOut: true });
    if (raced.timedOut) throw Error('PRESENCE_CHILD_NO_NATURAL_EXIT');
    return raced.record;
  }

  kill() { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } }
}

/* Spawn one real API/Core consumer process against `databaseUrl` with an optional caller-owned
 * ephemera adapter. `redis: null` boots with NO adapter (conservative absent default). */
async function startPresenceChild({
  databaseUrl, role = 'api_runtime', clock, otpSecret, environment = 'test',
  redis = null, timeout = 20000,
}) {
  const payload = JSON.stringify({ databaseUrl, role, clock, otpSecret, environment, redis });
  const child = spawn(process.execPath, [__filename], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, V5_PRESENCE_PAYLOAD: payload },
  });
  const proc = new PresenceChild(child);
  const raced = await raceTimeout(proc.ready.then(() => ({ ok: true }), () => ({ ok: false })), timeout, { ok: false });
  if (!raced.ok) {
    const detail = proc.fatal || proc.stderr.trim();
    proc.kill();
    throw Error(detail ? `PRESENCE_CHILD_READY_FAILED:${detail}` : 'PRESENCE_CHILD_READY_TIMEOUT');
  }
  return proc;
}

/* A compact end-to-end presence smoke the parent can call from a throwaway script: two real
 * processes (API + Core) on one database, a real caller-owned adapter, real IPC-driven consumers.
 * It returns a small summary object and closes every process it started. */
async function runPresenceServiceSmoke({ databaseUrl, clock, otpSecret, redis, actor = 'svc_alice', environment = 'test' }) {
  let api, core;
  try {
    api = await startPresenceChild({ databaseUrl, role: 'api_runtime', clock, otpSecret, redis, environment });
    core = await startPresenceChild({ databaseUrl, role: 'core_runtime', clock, otpSecret, environment });
    if (api.pid === core.pid || api.pid === process.pid) throw Error('PRESENCE_SMOKE_SAME_PID');
    const session = await api.call('issue', [actor, clock]);
    const heartbeat = await api.call('heartbeat', [session.token, true]);
    const seen = await api.call('view', [actor, actor]);
    const minted = await api.call('issueTicket', [{ actor, sessionId: 'smoke-session-0000000000', generation: 1, connectionClass: 'game' }]);
    const grant = await core.call('redeemTicket', [{ ticket: minted.ticket, connectionId: 'smoke-conn', node: 'smoke-core' }]);
    const replay = await core.call('redeemTicket', [{ ticket: minted.ticket, connectionId: 'smoke-conn-2', node: 'smoke-core' }]).then(() => 'REDEEMED', (e) => e.message);
    return {
      apiPid: api.pid, corePid: core.pid, apiRole: api.role, coreRole: core.role, ephemera: api.hasEphemera,
      heartbeatState: heartbeat && heartbeat.state, presenceState: seen.presence && seen.presence.state,
      presenceOnline: seen.presence && seen.presence.online, ticketActor: grant.actorId, ticketReplay: replay, naturalExit: true,
    };
  } finally {
    let failed = false;
    for (const child of [api, core]) {
      if (!child) continue;
      try {
        const exit = await child.shutdown();
        if (exit.code !== 0 || exit.signal !== null) throw Error('PRESENCE_SMOKE_NO_NATURAL_EXIT');
      } catch { child.kill(); failed = true; }
    }
    if (failed) throw Error('PRESENCE_SMOKE_NO_NATURAL_EXIT');
  }
}

module.exports = { startPresenceChild, PresenceChild, runPresenceServiceSmoke, DEAD_URL };
