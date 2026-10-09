'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoreInstanceLifecycle, STATES } = require('../packages/services/core-instance-lifecycle');

test('starts unavailable; readiness and capacity reject new sessions when saturated', () => {
  const core = createCoreInstanceLifecycle({ capacity: 2 });
  assert.equal(core.snapshot().phase, STATES.BOOTING);
  assert.equal(core.acquire(), null);
  core.markReady();
  const a = core.acquire();
  const b = core.acquire();
  assert.ok(a && b);
  assert.equal(core.snapshot().accepting, false);
  assert.equal(core.acquire(), null);
  assert.equal(a.release(), true);
  assert.equal(a.release(), false);
  assert.equal(core.snapshot().accepting, true);
  assert.ok(core.acquire());
  b.release();
});

test('idempotent drain closes admission without resetting absolute deadline', async () => {
  let clock = 100;
  const core = createCoreInstanceLifecycle({ capacity: 1, drainTimeoutMs: 50, now: () => clock });
  core.markReady();
  const lease = core.acquire();
  core.beginDrain();
  assert.equal(core.acquire(), null);
  assert.equal(core.snapshot().drainRemainingMs, 50);
  clock = 125;
  core.beginDrain();
  assert.equal(core.snapshot().drainRemainingMs, 25);
  assert.equal(core.finishStop(), false);
  const wait = core.awaitDrained();
  lease.release();
  assert.deepEqual(await wait, { drained: true, active: 0, reason: 'idle' });
  assert.equal(core.finishStop(), true);
  assert.equal(core.snapshot().phase, STATES.STOPPED);
  assert.throws(() => core.markReady(), /INVALID_READY_TRANSITION/);
});

test('expired drain reports failure, never pretends an active socket finished', async () => {
  let clock = 10;
  const core = createCoreInstanceLifecycle({ drainTimeoutMs: 10, now: () => clock });
  core.markReady();
  const lease = core.acquire();
  core.beginDrain();
  clock = 21;
  assert.deepEqual(await core.awaitDrained(), { drained: false, active: 1, reason: 'deadline' });
  assert.equal(core.finishStop(), false);
  lease.release();
  assert.equal(core.finishStop(), true);
});

test('aborted waiter does not terminate existing sessions or change lifecycle', async () => {
  const core = createCoreInstanceLifecycle({ drainTimeoutMs: 1000 });
  core.markReady();
  const lease = core.acquire();
  core.beginDrain();
  const ctrl = new AbortController();
  const wait = core.awaitDrained({ signal: ctrl.signal });
  ctrl.abort();
  assert.deepEqual(await wait, { drained: false, active: 1, reason: 'aborted' });
  assert.equal(core.snapshot().phase, STATES.DRAINING);
  lease.release();
  assert.equal((await core.awaitDrained()).drained, true);
});

test('invalid budgets fail closed and active drain cannot transition to READY', () => {
  assert.throws(() => createCoreInstanceLifecycle({ capacity: 0 }), /CAPACITY_INVALID/);
  assert.throws(() => createCoreInstanceLifecycle({ drainTimeoutMs: Infinity }), /DRAIN_TIMEOUT_INVALID/);
  const core = createCoreInstanceLifecycle();
  assert.throws(() => core.awaitDrained(), /DRAIN_NOT_STARTED/);
  core.markReady();
  core.beginDrain();
  assert.throws(() => core.markReady(), /INVALID_READY_TRANSITION/);
});
