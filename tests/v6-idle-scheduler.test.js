'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'scripts/v51/v5-production-server.cjs'));
const healthPath = path.join(ROOT, 'apps/api/routes/well-known.js');
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
  let due = null, tickHook = null;
  const worker = {
    start() { calls.push(['start', clock.now()]); },
    async tick(options) { calls.push(['worker', clock.now(), options.includeSlow]); if (tickHook) await tickHook(); },
    async nextWakeAt() { calls.push(['deadline', clock.now()]); return due; },
  };
  const pool = { async query(sql) { assert.match(sql, /FROM ops\.outbox/); calls.push(['counts', clock.now()]); return { rows: [{ dlq: 0, backlog: 0 }] }; } };
  const maintenance = mod.createIdleMaintenance({ worker, pool, now: clock.now, timers: clock.timers,
    observationFile: path.join(dir, 'worker.json'),
    commerceTasks: Object.fromEntries(['pass', 'finalization', 'intro'].map((name) => [name, async () => calls.push([name, clock.now()])])),
    tournamentTick: async () => calls.push(['tournaments', clock.now()]),
    probeDb: async () => calls.push(['health', clock.now()]), onError: (lane, error) => errors.push([lane, error.message]), ...extra });
  t.after(() => maintenance.stop());
  return { dir, clock, calls, worker, pool, maintenance, errors,
    setDue(value) { due = value; }, setTick(value) { tickHook = value; } };
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
  assert.deepEqual(pulse.filter(([name]) => ['pass', 'finalization', 'intro', 'worker', 'counts', 'health', 'tournaments'].includes(name)).map(([name]) => name).sort(), ['counts', 'finalization', 'health', 'intro', 'pass', 'tournaments', 'worker']);
  assert.equal(new Set(pulse.map(([, at]) => at)).size, 1);
  assert.equal(pulse.find(([name]) => name === 'worker')[2], true);
  assert.equal(pulse.at(-1)[0], 'health');
  await f.maintenance.stop(); assert.equal(f.clock.pending, 0);
});
test('insert wakes worker once after one second; commerce coalesces after two', async (t) => {
  const f = fixture(t); await f.maintenance.start();
  const hooks = mod.createWriteWakeHooks({ journalFile: path.join(f.dir, 'journal'), wakeWorker: () => f.maintenance.wakeWorker(), wakeCommerce: () => f.maintenance.wakeCommerce() });
  const before = f.calls.length;
  for (let i = 0; i < 20; i++) { hooks.onWrite('INSERT INTO ops.outbox VALUES ($1)'); hooks.onWrite('UPDATE monetization.store_finalize SET state=$1'); }
  await f.clock.advance(999); assert.equal(f.calls.length, before);
  await f.clock.advance(1);
  assert.equal(f.calls.slice(before).filter(([name]) => name === 'worker').length, 1);
  assert.equal(f.calls.slice(before).find(([name]) => name === 'worker')[2], false); // prompt delivery skips slow housekeeping
  await f.clock.advance(1000);
  assert.equal(f.calls.slice(before).filter(([name]) => name === 'finalization').length, 1);
  await f.clock.advance(10000);
  assert.equal(f.calls.slice(before).filter(([name]) => name === 'worker').length, 1);
});
test('wake during in-flight pass is latched, single-flight and not lost to re-arm', async (t) => {
  const f = fixture(t); await f.maintenance.start();
  let release, active = 0, maxActive = 0;
  f.setTick(async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => { release = r; }); active--; });
  f.maintenance.wakeWorker(); await f.clock.advance(1000);
  f.maintenance.wakeWorker(); f.maintenance.wakeWorker(); await f.clock.advance(1000);
  assert.equal(maxActive, 1);
  f.setTick(null); release(); await flush(); await f.clock.advance(0);
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 3);
  assert.equal(maxActive, 1);
});
test('an earlier deadline cannot consume a delayed pre-send insert wake', async (t) => {
  const f = fixture(t); f.setDue(f.clock.now() + 500); await f.maintenance.start(); f.setDue(null);
  f.maintenance.wakeWorker(); await f.clock.advance(500);
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 2);
  await f.clock.advance(500);
  assert.equal(f.calls.filter(([name]) => name === 'worker').length, 3);
});
test('durable deadline beats pulse; null and failed deadline reads park until pulse', async (t) => {
  const f = fixture(t); f.setDue(f.clock.now() + 45000); await f.maintenance.start(); f.setDue(null);
  await f.clock.advance(44999); assert.equal(f.calls.filter(([name]) => name === 'worker').length, 1);
  await f.clock.advance(1); assert.equal(f.calls.filter(([name]) => name === 'worker').length, 2);
  f.worker.nextWakeAt = async () => { throw Error('deadline unavailable'); };
  f.maintenance.wakeWorker(); await f.clock.advance(1000);
  assert.equal(f.errors.at(-1)[0], 'worker_deadline');
  const count = f.calls.length; await f.clock.advance(60000); assert.equal(f.calls.length, count);
});
test('an idle day has twelve clustered pulses and no intervening worker reads', async (t) => {
  const f = fixture(t); await f.maintenance.start(); const before = f.calls.length;
  await f.clock.advance(24 * 60 * 60 * 1000);
  const calls = f.calls.slice(before);
  assert.equal(f.maintenance.pulseCount, 12);
  assert.equal(calls.filter(([name]) => name === 'worker').length, 12);
  assert.equal(calls.filter(([name]) => name === 'counts').length, 12);
  assert.equal(new Set(calls.map(([, at]) => at)).size, 12);
});
test('fast delivery crossing a pulse cannot lose the due slow sweep', async (t) => {
  const f = fixture(t); await f.maintenance.start();
  await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS - 1500);
  let release;
  f.setTick(() => new Promise((r) => { release = r; }));
  f.maintenance.wakeWorker(); await f.clock.advance(1000);
  assert.equal(f.calls.filter(([name]) => name === 'worker').at(-1)[2], false);
  await f.clock.advance(500); f.setTick(null); release(); await flush(); await f.clock.advance(0);
  assert.equal(f.calls.filter(([name]) => name === 'worker').at(-1)[2], true);
});
test('worker failure still records counts and re-arms; shutdown drains and cancels pending wakes', async (t) => {
  const f = fixture(t); f.setTick(async () => { throw Error('tick failed'); }); await f.maintenance.start();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'worker.json'))), { at: f.clock.now(), dlq: 0, backlog: 0, source: 'worker-tick' });
  assert.equal(f.errors[0][0], 'worker');
  f.maintenance.wakeWorker(); f.maintenance.wakeCommerce(); await f.maintenance.stop();
  const count = f.calls.length; await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS * 2); assert.equal(f.calls.length, count); assert.equal(f.clock.pending, 0);
});
test('commerce sweep writes do not self-wake, but concurrent external writes do latch', async (t) => {
  const dir = temp(t), clock = fakeClock(); let maintenance, hooks, count = 0, release;
  maintenance = mod.createIdleMaintenance({ now: clock.now, timers: clock.timers, observationFile: path.join(dir, 'observation.json'),
    worker: { start() {}, async tick() {}, async nextWakeAt() { return null; } }, pool: { async query() { return { rows: [{ dlq: 0, backlog: 0 }] }; } },
    commerceTasks: { async commerce() { count++; hooks.onWrite('UPDATE monetization.store_finalize SET attempts=1'); if (count === 1) await new Promise((r) => { release = r; }); } } });
  hooks = mod.createWriteWakeHooks({ journalFile: path.join(dir, 'journal'), wakeCommerce: () => maintenance.wakeCommerce() });
  const start = maintenance.start(); await flush();
  hooks.onWrite('INSERT INTO monetization.store_finalize VALUES ($1)'); await clock.advance(2000); release(); await start; await clock.advance(0);
  assert.equal(count, 2); await clock.advance(60000); assert.equal(count, 2); await maintenance.stop();
});
test('shutdown drains an in-flight tick and clears insert/commerce wakes before pools close', async (t) => {
  const f = fixture(t); await f.maintenance.start(); let release, drained = false;
  f.setTick(() => new Promise((r) => { release = r; }));
  f.maintenance.wakeWorker(); await f.clock.advance(1000);
  f.maintenance.wakeWorker(); f.maintenance.wakeCommerce();
  const stopping = f.maintenance.stop().then(() => { drained = true; });
  await flush(); assert.equal(drained, false); assert.equal(f.clock.pending, 0);
  release(); await stopping; const count = f.calls.length;
  f.maintenance.wakeWorker(); f.maintenance.wakeCommerce();
  await f.clock.advance(mod.DEFAULT_IDLE_PULSE_MS); assert.equal(f.calls.length, count); assert.equal(f.clock.pending, 0);
});
test('journal ignores reads, advances per write, pulse/write gate is exception-proof', (t) => {
  const dir = temp(t), journalFile = path.join(dir, 'journal'); let pulse = 0;
  const hooks = mod.createWriteWakeHooks({ journalFile }); const gate = mod.createDbProbeGate({ journalFile, pulseCount: () => pulse });
  assert.equal(gate(), true); assert.equal(gate(), false);
  hooks.onWrite('SELECT 1'); assert.equal(fs.existsSync(journalFile), false); assert.equal(gate(), false);
  hooks.onWrite('UPDATE identity.accounts SET tag=$1'); const first = fs.statSync(journalFile).mtimeMs;
  assert.equal(gate(), true); assert.equal(gate(), false);
  hooks.onWrite('WITH changed AS (DELETE FROM ops.outbox RETURNING 1) SELECT 1'); assert.ok(fs.statSync(journalFile).mtimeMs > first); assert.equal(gate(), true);
  pulse++; assert.equal(gate(), true); assert.equal(gate(), false);
  const broken = mod.createWriteWakeHooks({ journalFile: path.join(journalFile, 'cannot-exist'), wakeWorker() { throw Error('wake'); }, wakeCommerce() { throw Error('wake'); } });
  assert.doesNotThrow(() => broken.onWrite('INSERT INTO ops.outbox SELECT * FROM monetization.store_finalize'));
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
test('journal changes unlock healthy TTL probes; pulses probe before TTL and consume the baseline', async (t) => {
  const routes = freshHealth(), dir = temp(t), journalFile = path.join(dir, 'journal');
  let now = 1000000, pulse = 0, queries = 0;
  const hooks = mod.createWriteWakeHooks({ journalFile });
  const context = { now: () => now, dbProbeGate: mod.createDbProbeGate({ journalFile, pulseCount: () => pulse }), pool: { async query() { queries++; } } };
  await healthRequest(routes, context); now += 60001; await healthRequest(routes, context); assert.equal(queries, 1);
  hooks.onWrite('UPDATE identity.accounts SET tag=$1'); await healthRequest(routes, context); assert.equal(queries, 2);
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
