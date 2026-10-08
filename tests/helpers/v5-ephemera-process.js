'use strict';
/* P06 ephemera child-process fixture.
 *
 * A REAL second (third, ...) Node process that drives the ephemera service against the SAME Redis
 * instance as the test process. Two `createEphemeraService` objects inside one process share one
 * event loop, one client library and one GC; they cannot prove cross-process behaviour. This
 * fixture spawns genuine separate OS processes with distinct PIDs and a private newline-delimited
 * JSON channel on fd 3, so heartbeat/cache/route/pub-sub sharing, the atomic cross-process rate
 * window and lock fencing are exercised against independent processes.
 *
 * The child owns NO test framework: it is inert when imported (`require.main !== module`), so the
 * test runner's own subprocess loading of a test file never starts a second service. It exits
 * NATURALLY (exit code 0, no `process.exit`, no watchdog) after `shutdown`, which is itself the
 * proof that close() released every owned client and subscription: if a reconnect timer or an
 * unclosed subscriber were left behind, the event loop would never drain.
 *
 * Protocol (fd 3, one JSON object per line):
 *   child -> parent  { t:'ready', pid, subscribeAvailable }
 *                    { t:'event', channel, message }
 *                    { t:'reply', id, ok:true, value } | { t:'reply', id, ok:false, error }
 *                    { t:'closed' } | { t:'fatal', error }
 *   parent -> child  { id, cmd, ... }
 */
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

/* Resolves a promise or a timeout, ALWAYS clearing the timer in `finally` so a successful race
 * leaves no watchdog behind to keep the test runner alive. */
async function raceTimeout(promise, ms, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(resolve, ms, onTimeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

const EPHEMERA = path.join(__dirname, '..', '..', 'packages', 'services', 'ephemera.js');
const CHANNEL = 3;
const DEAD_URL = 'redis://127.0.0.1:59999';
const CALLABLE = new Set([
  'heartbeat', 'lookupPresence', 'dropPresence', 'cacheSet', 'cacheGet', 'cacheDel',
  'rateHit', 'acquireLock', 'releaseLock', 'setHint', 'checkHint', 'registerRoute',
  'locateRoute', 'enqueueCandidate', 'peekCandidates', 'dropCandidate', 'publish',
  'healthy', 'auditUnboundedKeys', 'wipeNamespace',
]);

/* ---------------------------------------------------------------- child side */

function childSend(payload) {
  try { fs.writeSync(CHANNEL, JSON.stringify(payload) + '\n'); } catch { /* parent gone: nothing to report */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function childMain() {
  const payload = JSON.parse(process.env.V5_EPH_PAYLOAD || '{}');
  const { createEphemeraService } = require(EPHEMERA);
  const service = await createEphemeraService({
    url: payload.url,
    environment: payload.environment,
    ...(payload.keyVersion ? { keyVersion: payload.keyVersion } : {}),
    ...(payload.options || {}),
  });
  const subscriptions = new Map();
  const openSubscription = async (channel) => {
    if (subscriptions.has(channel)) return subscriptions.get(channel);
    const sub = await service.subscribe(channel, (message) => childSend({ t: 'event', channel, message }));
    subscriptions.set(channel, sub);
    return sub;
  };

  let readySubscribe = { available: false, conservative: true };
  if (payload.subscribeChannel) readySubscribe = await openSubscription(payload.subscribeChannel);

  const handlers = {
    call: async ({ method, args }) => {
      if (!CALLABLE.has(method)) throw Error('UNKNOWN_METHOD:' + method);
      return service[method](...(args || []));
    },
    subscribe: async ({ channel }) => {
      const sub = await openSubscription(channel);
      return { available: sub.available === true, conservative: sub.conservative === true };
    },
    /* Fire the same bucket's hits from independent processes: `startAt` is a shared wall-clock
     * target so the increments really race across processes, not merely across microtasks. */
    rateConcurrent: async ({ bucket, limit, windowMs, count, startAt }) => {
      await sleep(Math.max(0, Number(startAt) - Date.now()));
      const hits = await Promise.all(Array.from({ length: count }, () => service.rateHit(bucket, limit, windowMs)));
      return {
        allowed: hits.filter((h) => h.allowed === true).length,
        denied: hits.filter((h) => h.available === true && h.allowed === false).length,
        unavailable: hits.filter((h) => h.available !== true).length,
      };
    },
    shutdown: async () => {
      await service.close();
      return { closed: true };
    },
  };

  childSend({ t: 'ready', pid: process.pid, subscribeAvailable: readySubscribe.available === true });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      try {
        const value = await handlers[request.cmd](request);
        childSend({ t: 'reply', id: request.id, ok: true, value });
        if (request.cmd === 'shutdown') {
          childSend({ t: 'closed' });
          /* Drop the only handle the parent owns. The process then exits NATURALLY (code 0, no
           * process.exit, no watchdog) if and only if close() released every socket, subscriber and
           * timer it created: a leaked reconnect timer or un-quit subscriber would keep the event
           * loop alive and the parent's natural-exit assertion would time out. */
          break;
        }
      } catch (error) {
        childSend({ t: 'reply', id: request.id, ok: false, error: error && error.message ? error.message : String(error) });
      }
    }
  } finally {
    lines.close();
    process.stdin.pause();
    if (typeof process.stdin.unref === 'function') process.stdin.unref();
    /* Runs whether the loop ended via `shutdown` or an abnormal stdin close (the parent died):
     * close() is idempotent, so a failed parent can never orphan this child's Redis clients. */
    await service.close().catch(() => {});
  }
}

if (require.main === module) {
  childMain().catch((error) => {
    childSend({ t: 'fatal', error: error && error.message ? error.message : String(error) });
    process.exitCode = 1;
  });
}

/* ---------------------------------------------------------------- parent side */

/* A live child on the shared Redis. One readline interface owns fd 3 for the whole lifetime; the
 * constructor resolves `ready` itself so no line can be consumed before the caller listens. */
class EphemeraProcess extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.pid = null;
    this.subscribeAvailable = false;
    this.events = [];
    this.replies = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.fatal = null;
    this.exited = false;
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
          this.subscribeAvailable = message.subscribeAvailable === true;
          this.resolveReady(message);
          break;
        case 'event':
          this.events.push(message);
          this.emit('event', message);
          break;
        case 'fatal':
          this.fatal = message.error;
          this.rejectReady(Error('EPHEMERA_CHILD_FATAL:' + message.error));
          break;
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
      if (this.pid === null) this.rejectReady(Error(`EPHEMERA_CHILD_EARLY_EXIT:${code}:${this.stderr.trim()}`));
      for (const [, pending] of this.replies) { clearTimeout(pending.timer); pending.reject(Error('EPHEMERA_CHILD_EXITED')); }
      this.replies.clear();
      this.emit('exit', { code });
    });
  }

  #send(cmd, extra = {}, timeout = 8000) {
    if (this.exited) return Promise.reject(Error('EPHEMERA_CHILD_EXITED'));
    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, ...extra }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.replies.delete(id); reject(Error(`EPHEMERA_CHILD_TIMEOUT:${cmd}`)); }, timeout);
      this.replies.set(id, { resolve, reject, timer });
      /* Commands go to the child's stdin (fd 0 there); fd 3 is the child's OUTPUT channel only. */
      try { this.child.stdin.write(line); } catch (error) { clearTimeout(timer); this.replies.delete(id); reject(error); }
    });
  }

  call(method, args = [], { timeout } = {}) { return this.#send('call', { method, args }, timeout); }

  subscribe(channel, { timeout } = {}) { return this.#send('subscribe', { channel }, timeout); }

  rateConcurrent({ bucket, limit, windowMs, count, startAt }) {
    return this.#send('rateConcurrent', { bucket, limit, windowMs, count, startAt }, 15000);
  }

  /* Message-driven wait on the already-parsed IPC stream: no polling, one listener set, and the
   * timeout timer is always cleared on any outcome. A matching event may already be buffered. */
  waitForEvent(predicate, timeout = 5000) {
    const buffered = this.events.find(predicate);
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('event', onEvent); this.off('exit', onExit); };
      const onEvent = (message) => { if (predicate(message)) { cleanup(); resolve(message); } };
      const onExit = () => { cleanup(); reject(Error('EPHEMERA_CHILD_EXITED')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('EPHEMERA_EVENT_TIMEOUT')); }, timeout);
      this.on('event', onEvent);
      this.once('exit', onExit);
    });
  }

  /* Ask the child to close its service and let the process exit on its own. Returns the natural
   * exit record so the caller can assert code 0 / signal null. */
  async shutdown(timeout = 8000) {
    await this.#send('shutdown', {}, timeout);
    return this.waitExit(timeout);
  }

  async waitExit(timeout = 8000) {
    const raced = await raceTimeout(this.exit.then((record) => ({ record })), timeout, { timedOut: true });
    if (raced.timedOut) throw Error('EPHEMERA_CHILD_NO_NATURAL_EXIT');
    return raced.record;
  }

  kill() { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } }
}

/* Spawn one real child process. `url`/`environment`/`keyVersion`/`options` mirror
 * createEphemeraService; a dead endpoint is reachable by passing `url: DEAD_URL`. */
async function launchEphemeraProcess({ url, environment = 'test', keyVersion, options = {}, subscribeChannel, timeout = 15000 }) {
  const payload = JSON.stringify({ url, environment, keyVersion, options, subscribeChannel });
  const child = spawn(process.execPath, [__filename], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, V5_EPH_PAYLOAD: payload },
  });
  const proc = new EphemeraProcess(child);
  const raced = await raceTimeout(proc.ready.then(() => ({ ok: true })), timeout, { ok: false, timeout: true });
  if (!raced.ok) { proc.kill(); throw Error(raced.timeout ? 'EPHEMERA_CHILD_READY_TIMEOUT' : 'EPHEMERA_CHILD_READY_FAILED'); }
  return proc;
}

module.exports = { launchEphemeraProcess, EphemeraProcess, DEAD_URL, EPHEMERA };
