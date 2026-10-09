'use strict';

/*
 * P16: per-process transport-neutral Core realtime connection drain registry.
 *
 * P08 owns auth, socket protocol, durable match/revision state and clock rules.
 * This registry owns ONLY transport admission and shutdown bookkeeping.
 * No Redis key, PostgreSQL row, timer, account or economic mutation is made.
 *
 * Runtime must call register() after validating the upgrade/authentication
 * and call handle.release() on every socket close/error path. notifyDrain
 * should synchronously queue the approved reconnect hint (no ack is assumed).
 * forceClose requests socket closure after the real monotonic drain deadline;
 * a requested closure NEVER counts as a released connection.
 */

function createCoreConnectionDrain(lifecycle) {
  if (!lifecycle || ['snapshot', 'acquire', 'beginDrain', 'awaitDrained', 'finishStop']
    .some((name) => typeof lifecycle[name] !== 'function')) {
    throw new TypeError('CORE_LIFECYCLE_REQUIRED');
  }

  const registered = new WeakMap();
  const entries = new Set();

  function status() {
    return Object.freeze({ ...lifecycle.snapshot(), trackedConnections: entries.size });
  }

  function register({ socket, notifyDrain, forceClose } = {}) {
    if (!socket || typeof socket !== 'object') throw new TypeError('SOCKET_INVALID');
    if (typeof notifyDrain !== 'function' || typeof forceClose !== 'function') {
      throw new TypeError('SOCKET_CALLBACKS_REQUIRED');
    }
    if (registered.has(socket)) throw new Error('SOCKET_ALREADY_REGISTERED');
    const lease = lifecycle.acquire();
    if (!lease) return null;

    const entry = { socket, notifyDrain, forceClose, lease, notified: false, forced: false };
    entries.add(entry);
    registered.set(socket, entry);

    let released = false;
    return Object.freeze({
      release() {
        if (released) return false;
        released = true;
        entries.delete(entry);
        registered.delete(socket);
        return lease.release();
      },
    });
  }

  function beginDrain() {
    lifecycle.beginDrain(); // change admission state BEFORE any user callback is run
    let notified = 0;
    let failed = 0;
    for (const entry of [...entries]) {
      if (entry.notified || !entries.has(entry)) continue;
      entry.notified = true; // repeated termination signals cannot flood clients
      try {
        if (entry.notifyDrain() === false) failed += 1;
        else notified += 1;
      } catch {
        failed += 1; // caller may privately log only a sanitized counter
      }
    }
    return Object.freeze({ ...status(), noticesQueued: notified, noticeFailures: failed });
  }

  // Called by the owner only AFTER the bounded graceful-drain deadline.
  // This is a transport close request, not a forced business rollback.
  function forceCloseExpired() {
    const state = lifecycle.snapshot();
    if (state.phase !== 'DRAINING' || state.drainRemainingMs !== 0) {
      throw new Error('GRACEFUL_DRAIN_STILL_ACTIVE');
    }

    let requested = 0;
    let failed = 0;
    for (const entry of [...entries]) {
      if (entry.forced || !entries.has(entry)) continue;
      try {
        if (entry.forceClose() === false) failed += 1;
        else {
          entry.forced = true;
          requested += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ ...status(), closureRequests: requested, closureFailures: failed });
  }

  return Object.freeze({
    status,
    register,
    beginDrain,
    awaitDrained: (options) => lifecycle.awaitDrained(options),
    forceCloseExpired,
    finishStop: () => lifecycle.finishStop(),
  });
}

module.exports = { createCoreConnectionDrain };
