'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoreInstanceLifecycle, STATES } = require('../packages/services/core-instance-lifecycle');
const { createCoreConnectionDrain } = require('../packages/services/core-drain-connections');

test('socket identity cannot hold two admission leases and rejection does not create state', () => {
  const core = createCoreInstanceLifecycle({ capacity: 1 });
  const sockets = createCoreConnectionDrain(core);
  assert.equal(sockets.register({ socket: {}, notifyDrain() {}, forceClose() {} }), null);
  core.markReady();
  const identity = {};
  const handle = sockets.register({ socket: identity, notifyDrain() {}, forceClose() {} });
  assert.ok(handle);
  assert.equal(sockets.status().trackedConnections, 1);
  assert.throws(() => sockets.register({ socket: identity, notifyDrain() {}, forceClose() {} }), /SOCKET_ALREADY_REGISTERED/);
  assert.equal(sockets.register({ socket: {}, notifyDrain() {}, forceClose() {} }), null);
  assert.equal(sockets.status().active, 1);
  assert.equal(handle.release(), true);
  assert.equal(handle.release(), false);
  assert.equal(sockets.status().trackedConnections, 0);
  assert.ok(sockets.register({ socket: identity, notifyDrain() {}, forceClose() {} }));
});

test('drain denies callback-time re-entrancy, queues a single reconnect and awaits actual close', async () => {
  const core = createCoreInstanceLifecycle({ drainTimeoutMs: 100 });
  core.markReady();
  const sockets = createCoreConnectionDrain(core);
  let tries = 0;
  const active = sockets.register({
    socket: {},
    notifyDrain() {
      tries += 1;
      assert.equal(sockets.register({ socket: {}, notifyDrain() {}, forceClose() {} }), null);
      return true;
    },
    forceClose() {},
  });
  const first = sockets.beginDrain();
  assert.equal(first.noticesQueued, 1);
  assert.equal(first.noticeFailures, 0);
  assert.equal(first.accepting, false);
  assert.equal(first.phase, STATES.DRAINING);
  assert.equal(sockets.beginDrain().noticesQueued, 0);
  assert.equal(tries, 1);
  assert.throws(() => sockets.forceCloseExpired(), /GRACEFUL_DRAIN_STILL_ACTIVE/);
  assert.equal(sockets.finishStop(), false);
  const waiting = sockets.awaitDrained();
  active.release();
  assert.deepEqual(await waiting, { drained: true, active: 0, reason: 'idle' });
  assert.equal(sockets.finishStop(), true);
  assert.equal(sockets.status().phase, STATES.STOPPED);
});

test('notice errors are sanitized, force-close requests do not invent releases', async () => {
  let clock = 0;
  const core = createCoreInstanceLifecycle({ drainTimeoutMs: 10, now: () => clock });
  core.markReady();
  const sockets = createCoreConnectionDrain(core);
  const active = sockets.register({
    socket: {},
    notifyDrain() { throw new Error('SECRET SHOULD NEVER APPEAR IN COUNTER'); },
    forceClose() { return true; },
  });
  assert.equal(sockets.beginDrain().noticeFailures, 1);
  clock = 11;
  assert.equal(sockets.forceCloseExpired().closureRequests, 1);
  assert.equal(sockets.forceCloseExpired().closureRequests, 0);
  assert.equal(sockets.status().active, 1);
  assert.equal(sockets.finishStop(), false);
  assert.deepEqual(await sockets.awaitDrained(), { drained: false, active: 1, reason: 'deadline' });
  active.release();
  assert.equal(sockets.finishStop(), true);
});

test('failed transport close can retry while preserving the original drain deadline', () => {
  let clock = 0, calls = 0;
  const core = createCoreInstanceLifecycle({ drainTimeoutMs: 10, now: () => clock });
  core.markReady();
  const sockets = createCoreConnectionDrain(core);
  const handle = sockets.register({
    socket: {},
    notifyDrain() { return false; },
    forceClose() { calls += 1; if (calls === 1) return false; },
  });
  sockets.beginDrain();
  clock = 10;
  assert.equal(sockets.forceCloseExpired().closureFailures, 1);
  assert.equal(sockets.forceCloseExpired().closureRequests, 1);
  assert.equal(calls, 2);
  assert.equal(sockets.finishStop(), false);
  handle.release();
  assert.equal(sockets.finishStop(), true);
});

test('invalid socket callbacks and lifecycle shape fail before admission', () => {
  assert.throws(() => createCoreConnectionDrain({}), /CORE_LIFECYCLE_REQUIRED/);
  const core = createCoreInstanceLifecycle();
  core.markReady();
  const sockets = createCoreConnectionDrain(core);
  assert.throws(() => sockets.register({ socket: null, notifyDrain() {}, forceClose() {} }), /SOCKET_INVALID/);
  assert.throws(() => sockets.register({ socket: {}, notifyDrain() {} }), /SOCKET_CALLBACKS_REQUIRED/);
  assert.equal(sockets.status().active, 0);
});


test('promise-valued transport callbacks fail closed and never count pending work as drained', async () => {
  let now = 0;
  const lifecycle = createCoreInstanceLifecycle({ drainTimeoutMs: 10, now: () => now });
  lifecycle.markReady();
  const registry = createCoreConnectionDrain(lifecycle);
  const errors = [];
  const onUnhandled = (error) => errors.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const handle = registry.register({
      socket: {},
      notifyDrain: () => Promise.reject(new Error('private notification failure')),
      forceClose: () => Promise.reject(new Error('private socket close failure')),
    });
    assert.equal(registry.beginDrain().noticeFailures, 1);
    assert.equal(registry.status().active, 1);
    now = 11;
    assert.equal(registry.forceCloseExpired().closureFailures, 1);
    assert.equal(registry.finishStop(), false, 'a rejected async close never releases the lease');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, [], 'handled callback rejections never escape to Node');
    assert.equal(handle.release(), true);
    assert.equal(registry.finishStop(), true);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
