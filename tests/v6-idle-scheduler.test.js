'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'scripts/v51/v5-production-server.cjs'));
const healthPath = path.join(ROOT, 'apps/api/routes/well-known.js');
const health = require(healthPath);
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function fakeClock() {
  let at = 1000000, seq = 0, intervalCount = 0;
  const jobs = new Map();
  const add = (fn, delay, repeat = 0) => { const id = ++seq; jobs.set(id, { fn, at: at + delay, repeat }); return id; };
  return {
    now: () => at,
    get intervalCount() { return intervalCount; },
    get pending() { return jobs.size; },
    timers: {
      setTimeout: (fn, delay) => add(fn, delay), clearTimeout: (id) => jobs.delete(id),
      setInterval: (fn, delay) => { intervalCount++; return add(fn, delay, delay); }, clearInterval: (id) => jobs.delete(id),
    },
    async advance(ms) {
      const until = at + ms;
      for (let guard = 0; guard < 10000; guard++) {
        const next = [...jobs.entries()].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) { at = until; await flush(); return; }
        const [id, job] = next; at = job.at;
        if (job.repeat) job.at += job.repeat; else jobs.delete(id);
        job.fn(); await flush();
      }
      throw Error('timer loop');
    },
  };
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-test-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}
function fixture(t, extra = {}) {
  const dir = temp(t), clock = fakeClock(), calls = [], errors = [];
  let due = null, tickHook = null, maintenance = null;
  const hooks = mod.createWriteWakeHooks({
    wakeWorker: () => maintenance?.wakeWorker(),
    wakeCommerce: () => maintenance?.wakeCommerce(),
    armBackup: () => maintenance?.armBackup(),
  });
  const worker = {
    start() { calls.push(['start', clock.now()]); },
    async tick(options) { calls.push(['worker', clock.now(), options.includeSlow]); if (tickHook) await tickHook(); },
    async nextWakeAt() { calls.push(['deadline', clock.now()]); return due; },
  };
  let emitPoolCommits = false;
  const pool = { async query(sql) { assert.match(sql, /FROM ops\.outbox/); calls.push(['counts', clock.now()]); if (emitPoolCommits) hooks.onCommit(); return { rows: [{ dlq: 0, backlog: 0 }] }; } };
  maintenance = mod.createIdleMaintenance({ worker, pool, hooks, now: clock.now, timers: clock.timers,
    observationFile: path.join(dir, 'worker.json'),
    commerceTasks: Object.fromEntries(['pass', 'finalization', 'intro'].map((name) => [name, async () => calls.push([name, clock.now()])])),
    tournamentTick: async () => calls.push(['tournaments', clock.now()]),
    backup: async () => calls.push(['backup', clock.now()]),
    probeDb: async () => calls.push(['health', clock.now()]), onError: (lane, error) => errors.push([lane, error.message]), ...extra });
  t.after(() => maintenance.stop());
  return { dir, clock, calls, worker, pool, maintenance, hooks, errors,
    setDue(value) { due = value; }, setTick(value) { tickHook = value; },
    setPoolCommits(value) { emitPoolCommits = value; } };
}
test('one interval clusters all idle work; no SQL until the two-hour pulse', async (t) => {
  const f = fixture(t); await f.maintenance.start();
  assert.equal(f.clock.intervalCount, 1);
  const before = f.calls.length;
  await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS - 1);
  assert.equal(f.calls.length, before);
  await f.clock.advance(1);
  assert.equal(f.maintenance.pulseCount, 1);
  const pulse = f.calls.slice(before);
  assert.deepEqual(pulse.filter(([name]) => ['pass', 'finalization', 'intro', 'worker', 'counts', 'health', 'tournaments', 'backup'].includes(name)).map(([name]) => name).sort(), ['backup', 'counts', 'finalization', 'health', 'intro', 'pass', 'tournaments', 'worker']);
  assert.equal(new Set(pulse.map(([, at]) => at)).size, 1);
  assert.equal(pulse.find(([name]) => name === 'worker')[2], true);
  assert.ok(pulse.findIndex(([name]) => name === 'health') > pulse.findIndex(([name]) => name === 'counts'));
  await f.maintenance.stop(); assert.equal(f.clock.pending, 0);
});
function hooksFor(f) {
  return f.hooks;
}
test('commits wake worker and commerce immediately, coalescing a burst into one pass', async (t) => {
  const f = fixture(t); await f.maintenance.start(); const hooks = hooksFor(f), before = f.calls.length;
  for (let i = 0; i < 20; i++) hooks.onCommit();
  assert.equal(f.calls.length, before); await f.clock.advance(0);
  assert.equal(f.calls.slice(before).filter(([name]) => name === 'worker').length, 1);
  assert.equal(f.calls.slice(before).find(([name]) => name === 'worker')[2], false);
  assert.equal(f.calls.slice(before).filter(([name]) => name === 'finalization').length, 1);
  assert.equal(f.calls.slice(before).filter(([name]) => name === 'backup').length, 0);
  const after = f.calls.length; await f.clock.advance(1000); assert.equal(f.calls.length, after);
});
test('commits during the final deadline read remain latched and single-flight', async (t) => {
  const f = fixture(t); await f.maintenance.start(); let release, reads = 0;
  f.worker.nextWakeAt = async () => { if (++reads === 1) await new Promise((r) => { release = r; }); return null; };
  f.maintenance.wakeWorker(); await f.clock.advance(0);
  f.maintenance.wakeWorker(); f.maintenance.wakeWorker(); await f.clock.advance(0);
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 2);
  release(); await flush(); await f.clock.advance(0);
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 3);
});
test('pulse worker-lane commits arm nothing; HTTP commits wake the worker and arm the backup', async (t) => {
  const f = fixture(t), hooks = hooksFor(f); f.setTick(() => hooks.onCommit());
  await f.maintenance.start(); await f.clock.advance(0); const boot = f.clock.now();
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 1, 'lane-owned expiry commits never self-wake the worker');
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 1, 'the boot unit runs without an arming commit');
  await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS);
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 2);
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 2, 'the pulse backstop joins the unit');
  await f.clock.advance(mod.BACKUP_BATCH_MS);
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 2, 'pulse-owned commits never arm a post-pulse probe');
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 2);
  hooks.onCommit(); // an HTTP-context lease: visible work, wakes everything
  await f.clock.advance(0);
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 3);
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 2);
  const armedAt = f.clock.now() + mod.BACKUP_BATCH_MS;
  await f.clock.advance(mod.BACKUP_BATCH_MS);
  assert.deepEqual(f.calls.filter(([name]) => name === 'backup').map(([, at]) => at),
    [boot, boot + mod.DEFAULT_IDLE_PULSE_MS, armedAt]);
});
test('durable deadlines beat pulse; failed deadline reads retry after ten seconds', async (t) => {
  const f = fixture(t); f.setDue(f.clock.now() + 45000); await f.maintenance.start(); f.setDue(null);
  await f.clock.advance(44999); assert.equal(f.calls.filter(([name]) => name === 'worker').length, 1);
  await f.clock.advance(1); assert.equal(f.calls.filter(([name]) => name === 'worker').length, 2);
  let failures = 1; f.worker.nextWakeAt = async () => { if (failures-- > 0) throw Error('deadline unavailable'); return null; };
  f.maintenance.wakeWorker(); await f.clock.advance(0); assert.equal(f.errors.at(-1)[0], 'worker_deadline');
  const before = f.calls.length; await f.clock.advance(9999); assert.equal(f.calls.length, before);
  await f.clock.advance(1); assert.equal(f.calls.filter(([name]) => name === 'worker').length, 4);
  const after = f.calls.length; await f.clock.advance(60000); assert.equal(f.calls.length, after);
});
test('an idle day has twelve clustered pulses and no intervening worker reads', async (t) => {
  const f = fixture(t); await f.maintenance.start(); const before = f.calls.length;
  await f.clock.advance(24 * 60 * 60 * 1000);
  const calls = f.calls.slice(before);
  assert.equal(f.maintenance.pulseCount, 12);
  assert.equal(calls.filter(([name]) => name === 'worker').length, 12);
  assert.equal(calls.filter(([name]) => name === 'counts').length, 12);
  assert.equal(calls.filter(([name]) => name === 'backup').length, 12);
  assert.equal(new Set(calls.map(([, at]) => at)).size, 12);
});
test('fast delivery crossing a pulse cannot lose the due slow sweep', async (t) => {
  const f = fixture(t); await f.maintenance.start();
  await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS - 1500);
  let release;
  f.setTick(() => new Promise((r) => { release = r; }));
  f.maintenance.wakeWorker(); await f.clock.advance(0);
  assert.equal(f.calls.filter(([name]) => name === 'worker').at(-1)[2], false);
  await f.clock.advance(1500); f.setTick(null); release(); await flush(); await f.clock.advance(0);
  assert.equal(f.calls.filter(([name]) => name === 'worker').at(-1)[2], true);
});
test('worker failure still records counts and re-arms; shutdown drains and cancels pending wakes', async (t) => {
  const f = fixture(t); f.setTick(async () => { throw Error('tick failed'); }); await f.maintenance.start();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'worker.json'))), { at: f.clock.now(), dlq: 0, backlog: 0, source: 'worker-tick' });
  assert.equal(f.errors[0][0], 'worker');
  f.maintenance.wakeWorker(); f.maintenance.wakeCommerce(); await f.maintenance.stop();
  const count = f.calls.length; await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS * 2); assert.equal(f.calls.length, count); assert.equal(f.clock.pending, 0);
});
test('backup batching keeps the earliest commit deadline under sustained writes', async (t) => {
  const f = fixture(t); await f.maintenance.start(); const hooks = hooksFor(f), initial = f.clock.now();
  hooks.onCommit(); await f.clock.advance(0);
  for (let i = 0; i < 4; i++) { await f.clock.advance(60000); hooks.onCommit(); await f.clock.advance(0); }
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 1);
  await f.clock.advance(59999); assert.equal(f.calls.filter(([name]) => name === 'backup').length, 1);
  const before = f.calls.length; await f.clock.advance(1);
  assert.deepEqual(f.calls.slice(before), [['backup', initial + 300000]], 'backup must not start another worker/commerce pass');
  hooks.onCommit(); await f.clock.advance(0); await f.clock.advance(300000);
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 3);
});
test('commit during a backup keeps its own bounded, single-flight follow-up', async (t) => {
  let attempts = 0, release;
  const f = fixture(t, { backup: async () => { if (++attempts === 2) await new Promise((r) => { release = r; }); } });
  await f.maintenance.start(); f.maintenance.armBackup(); await f.clock.advance(300000);
  assert.equal(attempts, 2); f.maintenance.armBackup(); await f.clock.advance(300000);
  assert.equal(attempts, 2); release(); await flush(); await f.clock.advance(0); assert.equal(attempts, 3);
});
test('a pulse cannot discard a future commit backup deadline by joining an older unit', async (t) => {
  const f = fixture(t, { intervalMs: 200000 }); await f.maintenance.start(); const at = f.clock.now();
  f.maintenance.armBackup(); await f.clock.advance(200000);
  assert.deepEqual(f.calls.filter(([name]) => name === 'backup').map(([, time]) => time), [at, at + 200000]);
  await f.clock.advance(100000);
  assert.deepEqual(f.calls.filter(([name]) => name === 'backup').map(([, time]) => time), [at, at + 200000, at + 300000]);
});
test('backup failure retries after one minute and is not parked until the pulse', async (t) => {
  let attempts = 0;
  const f = fixture(t, { backup: async () => { if (++attempts === 1) throw Error('unit failed'); } });
  await f.maintenance.start(); assert.equal(f.errors[0][0], 'backup');
  await f.clock.advance(59999); assert.equal(attempts, 1); await f.clock.advance(1); assert.equal(attempts, 2);
});
test('backup lane invokes the exact systemctl argv and captures bounded output', async (t) => {
  const calls = [], logs = [];
  const spawnProcess = (...args) => {
    calls.push(args); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', 'started'); child.stderr.emit('data', '!'); child.emit('close', 0, null); }); return child;
  };
  const f = fixture(t, { backup: () => mod.startBackupService({ spawnProcess, log: (event) => logs.push(event) }) });
  await f.maintenance.start(); f.maintenance.armBackup(); await f.clock.advance(300000);
  assert.equal(calls.length, 2);
  for (const args of calls) assert.deepEqual(args, ['systemctl', ['start', 'mega-xo-v5-backup.service'], { stdio: ['ignore', 'pipe', 'pipe'] }]);
  assert.equal(logs.at(-1).output, 'started!');
  await assert.rejects(mod.startBackupService({ spawnProcess() { throw Error('spawn unavailable'); } }), /spawn unavailable/);
  await assert.rejects(mod.startBackupService({ spawnProcess() {
    const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 1, null)); return child;
  } }), /BACKUP_SERVICE_FAILED/);
});
test('shutdown drains an in-flight tick and clears commit/commerce/backup wakes before pools close', async (t) => {
  const f = fixture(t); await f.maintenance.start(); let release, drained = false;
  f.setTick(() => new Promise((r) => { release = r; }));
  f.maintenance.wakeWorker(); await f.clock.advance(0);
  f.maintenance.wakeWorker(); f.maintenance.wakeCommerce(); f.maintenance.armBackup();
  const stopping = f.maintenance.stop().then(() => { drained = true; });
  await flush(); assert.equal(drained, false); assert.equal(f.clock.pending, 0);
  release(); await stopping; const count = f.calls.length;
  f.maintenance.wakeWorker(); f.maintenance.wakeCommerce();
  await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS); assert.equal(f.calls.length, count); assert.equal(f.clock.pending, 0);
});
test('onCommit calls every advisory hook independently and never rejects the query path', () => {
  const calls = [], hooks = mod.createWriteWakeHooks({
    wakeWorker() { calls.push('worker'); throw Error('wake failed'); },
    wakeCommerce() { calls.push('commerce'); throw Error('wake failed'); },
    armBackup() { calls.push('backup'); throw Error('wake failed'); },
  });
  assert.doesNotThrow(() => hooks.onCommit()); assert.equal(hooks.commitCount, 1);
  assert.deepEqual(calls, ['worker', 'commerce', 'backup']); assert.equal(hooks.onWrite, undefined);
});
function freshHealth() { delete require.cache[require.resolve(healthPath)]; return require(healthPath); }
async function healthRequest(routes, context, url = '/readyz') {
  const res = { writeHead(status) { this.statusCode = status; }, end(body) { this.body = JSON.parse(body); } };
  await routes.getHealth(context, { url }, res); return res;
}
test('ready/health stay cached with honest age; liveness never queries; pulse forces probe', async () => {
  const routes = freshHealth(); let now = 1000000, queries = 0;
  const context = { now: () => now, dbProbeGate: () => false, pool: { async query(sql) { assert.equal(sql, 'SELECT 1'); queries++; } } };
  assert.equal((await healthRequest(routes, context)).statusCode, 200); assert.equal(queries, 1);
  now += 3600000; const cached = await healthRequest(routes, context, '/health'); assert.equal(cached.body.db.ageMs, 3600000); assert.equal(queries, 1);
  await healthRequest(routes, context, '/livez'); assert.equal(queries, 1);
  await routes.probeDbHealth(context); assert.equal(queries, 2);
  assert.equal((await healthRequest(routes, context)).body.db.ageMs, 0);
});
test('readiness preserves default 60-second TTL and retries failed probes after 10 seconds', async () => {
  const routes = freshHealth(); let now = 1000000, queries = 0, broken = false;
  const context = { now: () => now, pool: { query() { queries++; if (broken) throw Error('sync failure'); return Promise.resolve(); } } };
  await healthRequest(routes, context); now += 59999; await healthRequest(routes, context); assert.equal(queries, 1);
  now++; broken = true; assert.equal((await healthRequest(routes, context)).statusCode, 503); assert.equal(queries, 2);
  context.dbProbeGate = () => false; now += 9999; assert.equal((await healthRequest(routes, context)).statusCode, 503); assert.equal(queries, 2);
  now++; broken = false; assert.equal((await healthRequest(routes, context)).statusCode, 200); assert.equal(queries, 3);
});
test('commits unlock healthy TTL probes; pulses probe before TTL and consume the baseline', async () => {
  const routes = freshHealth(); let now = 1000000, pulse = 0, queries = 0;
  const hooks = mod.createWriteWakeHooks();
  const context = { now: () => now, dbProbeGate: mod.createDbProbeGate({ commitCount: () => hooks.commitCount, pulseCount: () => pulse }), pool: { async query() { queries++; } } };
  await healthRequest(routes, context); now += 60001; await healthRequest(routes, context); assert.equal(queries, 1);
  hooks.onCommit(); await healthRequest(routes, context); assert.equal(queries, 2);
  pulse++; now++; await routes.probeDbHealth(context); assert.equal(queries, 3);
  now += 60001; await healthRequest(routes, context); assert.equal(queries, 3);
});
test('createApiHandler threads optional gate without editing its existing spread contract', async () => {
  delete require.cache[require.resolve(healthPath)];
  const apiPath = path.join(ROOT, 'apps/api/index.js'); delete require.cache[require.resolve(apiPath)];
  const { createApiHandler } = require(apiPath); let now = 1000000, queries = 0;
  const handler = createApiHandler({ now: () => now, dbProbeGate: () => false, pool: { async query() { queries++; } }, queue: {}, leaderboard: async () => [] });
  const request = async () => { const res = { setHeader() {}, writeHead() {}, end() {} }; await handler({ url: '/readyz', method: 'GET', headers: {} }, res); };
  await request(); now += 3600000; await request(); assert.equal(queries, 1);
});


test('a bare deadline pass arms the backup its commits need; a covered pulse pass never does', async (t) => {
  const f = fixture(t); f.setPoolCommits(true);
  f.setDue(f.clock.now() + 45000);
  await f.maintenance.start(); await f.clock.advance(0);
  const boot = f.clock.now();
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 1, 'the boot unit runs once, without an arming commit');
  f.setDue(null); // the pass consumes the due work; the next deadline read parks to the pulse
  await f.clock.advance(45000); await flush(); // the durable deadline fires a bare, timer-driven pass
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 2, 'the deadline pass ran outside a pulse');
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 1, 'arming is scheduled, not yet running');
  const armedAt = f.clock.now() + mod.BACKUP_BATCH_MS;
  await f.clock.advance(mod.BACKUP_BATCH_MS);
  assert.deepEqual(f.calls.filter(([name]) => name === 'backup').map(([, at]) => at), [boot, armedAt],
    'the bare pass armed a bounded backup for its own observed commits');
  // The next pulse is covered: its own expiry/observation leases arm nothing beyond the backstop.
  await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS - mod.BACKUP_BATCH_MS - 45000);
  await f.clock.advance(1);
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 3, 'the pulse backstop joins the unit');
  await f.clock.advance(mod.BACKUP_BATCH_MS);
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, 3, 'covered pulse commits never arm a post-pulse probe');
});

test('a readiness probe observes without dirtying its own gate, waking lanes, or arming a backup', async (t) => {
  const f = fixture(t); const hooks = hooksFor(f);
  await f.maintenance.start(); await f.clock.advance(0);
  const bootBackups = f.calls.filter(([name]) => name === 'backup').length;
  const gate = mod.createDbProbeGate({ commitCount: () => hooks.commitCount, pulseCount: () => f.maintenance.pulseCount });
  const context = {
    pool: { query: async (sql) => { assert.match(sql, /SELECT 1/); hooks.onCommit(); } },
    dbProbeGate: gate, runObservation: hooks.runObservation, now: f.clock.now,
  };
  assert.equal(gate(), true, 'the first gate read consumes the boot baseline');
  await health.probeDbHealth(context);
  assert.equal(hooks.commitCount, 0, 'the observation lease never counts as application activity');
  assert.equal(gate(), false, 'the probe left its own gate clean');
  await f.clock.advance(mod.BACKUP_BATCH_MS);
  assert.equal(f.calls.filter(([name]) => name === 'backup').length, bootBackups, 'a probe never arms a delayed backup by itself');
  hooks.onCommit(); // concurrent REAL activity, outside the observation context
  assert.equal(hooks.commitCount, 1);
  assert.equal(gate(), true, 'real commits still open the gate');
});
