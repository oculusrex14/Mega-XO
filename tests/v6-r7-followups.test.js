'use strict';
/* Sol R7 follow-ups (both P2, non-blocking): F1 - the documented attempt-budget fallback
 * constant is exported so a legacy injected job service never falls back to undefined;
 * F2 - tournament rescheduling cancels the prior timer through the SAME injected timers
 * object that registered it. Zero production-behavior change: production uses globalThis,
 * where the injected and global functions coincide. */
const test = require('node:test');
const assert = require('node:assert/strict');

const jobs = require('../packages/services/jobs.js');

test('R7-F1: DEFAULT_MAX_ATTEMPTS is exported with the documented default', () => {
  assert.equal(typeof jobs.DEFAULT_MAX_ATTEMPTS, 'number');
  assert.equal(jobs.DEFAULT_MAX_ATTEMPTS, 3);
  const workerWorkflows = require('../packages/services/worker-workflows.js');
  assert.ok(workerWorkflows, 'worker-workflows imports the constant at load time');
});

test('R7-F2: tournament rescheduling cancels the prior injected timer id', async () => {
  const { createTournamentTimer } = require('../packages/services/tournament-timer.js');
  const ids = [];
  const cleared = [];
  const timers = {
    setTimeout: (fn, delay) => { const id = setTimeout(fn, delay); ids.push(id); return id; },
    clearTimeout: (id) => { cleared.push(id); clearTimeout(id); },
  };
  let sweeps = 0;
  const tournaments = {
    async sweepTimers() { sweeps += 1; return { scanned: 1, nextDueMs: 0 }; },
  };
  const timer = createTournamentTimer({ tournaments, owner: 'unit', intervalMs: 250,
    activeMaxMs: 250, idleIntervalMs: 30000, timers });
  timer.start();
  await new Promise((resolve) => setTimeout(resolve, 900)); // several 250ms active sweeps
  await timer.stop();
  assert.ok(sweeps >= 2, 'the timer rescheduled at least once');
  assert.ok(cleared.includes(ids[0]), 'the reschedule cancelled the first injected timer id');
  assert.ok(cleared.every((id) => ids.includes(id)), 'every cancellation targeted an injected id');
  await new Promise((resolve) => setTimeout(resolve, 400)); // no post-stop sweeps
  const settled = sweeps;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(sweeps, settled, 'stop() left no timer behind');
});
