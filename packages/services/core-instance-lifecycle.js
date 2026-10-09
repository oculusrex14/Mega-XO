'use strict';

/*
 * P16: process-local Core admission and bounded graceful drain.
 *
 * Only socket/session admission is coordinated here. This is NEVER match,
 * tournament, payment or clock authority. The successor Core must recover
 * durable revisions and deadlines from PostgreSQL, not from this instance.
 *
 * Integration contract:
 * - start BOOTING; markReady only after durable services are ready;
 * - acquire one lease per accepted realtime connection, release on close;
 * - readiness and upgrades reject fresh traffic while DRAINING or at capacity;
 * - beginDrain on termination, ask existing sockets to reconnect, then
 *   awaitDrained; a timeout is a FAILED drain, not a success or an auto-kill;
 * - finishStop only when all leases have released.
 *
 * No network listeners, signals, timers, wallets or credentials are managed.
 * P08/P16 runtime integration and actual failover acceptance remain separate.
 */
const { performance } = require('node:perf_hooks');

const STATES = Object.freeze({
  BOOTING: 'BOOTING',
  READY: 'READY',
  DRAINING: 'DRAINING',
  STOPPED: 'STOPPED',
});

function positiveInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(name + '_INVALID');
  }
  return value;
}

function createCoreInstanceLifecycle({
  capacity = 2000,
  drainTimeoutMs = 30000,
  now = () => performance.now(),
} = {}) {
  positiveInteger(capacity, 'CAPACITY', 100000);
  positiveInteger(drainTimeoutMs, 'DRAIN_TIMEOUT', 60000);
  if (typeof now !== 'function') throw new TypeError('CLOCK_INVALID');

  let phase = STATES.BOOTING;
  let active = 0;
  let deadline = null;
  const idleListeners = new Set();

  function snapshot() {
    return Object.freeze({
      phase,
      accepting: phase === STATES.READY && active < capacity,
      active,
      capacity,
      drainRemainingMs: phase === STATES.DRAINING
        ? Math.max(0, Math.ceil(deadline - now()))
        : null,
    });
  }

  function markReady() {
    if (phase !== STATES.BOOTING) throw new Error('INVALID_READY_TRANSITION');
    phase = STATES.READY;
    return snapshot();
  }

  function acquire() {
    if (phase !== STATES.READY || active >= capacity) return null;
    active += 1;
    let released = false;
    return Object.freeze({
      release() {
        if (released) return false;
        released = true;
        active -= 1;
        if (active === 0) {
          for (const listener of [...idleListeners]) listener();
        }
        return true;
      },
    });
  }

  function beginDrain() {
    if (phase === STATES.STOPPED) return snapshot();
    if (phase !== STATES.DRAINING) {
      phase = STATES.DRAINING;
      deadline = now() + drainTimeoutMs;
    }
    // A repeated SIGTERM must not reset the deadline or admit new traffic.
    return snapshot();
  }

  function awaitDrained({ signal } = {}) {
    if (phase !== STATES.DRAINING && phase !== STATES.STOPPED) {
      throw new Error('DRAIN_NOT_STARTED');
    }
    if (active === 0) return Promise.resolve(Object.freeze({ drained: true, active: 0, reason: 'idle' }));
    if (phase === STATES.STOPPED) {
      return Promise.resolve(Object.freeze({ drained: false, active, reason: 'stopped' }));
    }
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) {
      throw new TypeError('SIGNAL_INVALID');
    }
    if (signal?.aborted) {
      return Promise.resolve(Object.freeze({ drained: false, active, reason: 'aborted' }));
    }
    const remainingMs = Math.max(0, Math.ceil(deadline - now()));
    if (remainingMs === 0) {
      return Promise.resolve(Object.freeze({ drained: false, active, reason: 'deadline' }));
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      const settle = (drained, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        idleListeners.delete(onIdle);
        signal?.removeEventListener('abort', onAbort);
        resolve(Object.freeze({ drained, active, reason }));
      };
      const onIdle = () => {
        if (active === 0) settle(true, 'idle');
      };
      const onAbort = () => settle(false, 'aborted');

      idleListeners.add(onIdle);
      signal?.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => settle(false, 'deadline'), remainingMs);
      // Handle lease release and abort racing with waiter registration.
      onIdle();
      if (signal?.aborted) onAbort();
    });
  }

  function finishStop() {
    if (phase !== STATES.DRAINING || active !== 0) return false;
    phase = STATES.STOPPED;
    return true;
  }

  return Object.freeze({ snapshot, markReady, acquire, beginDrain, awaitDrained, finishStop });
}

module.exports = { STATES, createCoreInstanceLifecycle };
