'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'scripts/v51/v5-production-server.cjs'));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a4-ops-')); t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const at = 200000000, freshnessFile = path.join(dir, 'freshness.json'), observationFile = path.join(dir, 'observation.json');
  fs.writeFileSync(freshnessFile, JSON.stringify({ state: 'fresh', checkedAtUtc: new Date(at).toISOString() }));
  let calls = 0;
  return { freshnessFile, observationFile, now: () => at, pool: { query() { calls++; throw Error('monitor must never query'); } }, get calls() { return calls; } };
}
test('file fallback retains stale dlq/backlog failures and adds age without SQL', async (t) => {
  const f = fixture(t);
  for (const [dlq, backlog, expected] of [[0, 0, true], [1, 0, false], [0, 101, false]]) {
    fs.writeFileSync(f.observationFile, JSON.stringify({ at: f.now() - 7200000, dlq, backlog, source: 'worker-tick' }));
    const report = await mod.buildOpsReport(f); assert.equal(report.ok, expected); assert.equal(report.worker.ageMs, 7200000);
    assert.deepEqual(Object.keys(report).sort(), ['at', 'backup', 'failures', 'ok', 'worker']);
  }
  assert.equal(f.calls, 0);
});
test('memory cache survives missing file; count failure replaces it with honest unknown', async (t) => {
  const f = fixture(t); let queries = 0;
  await mod.refreshWorkerObservation({ ...f, pool: { async query() { queries++; return { rows: [{ dlq: 3, backlog: 105 }] }; } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.observationFile)), { at: f.now(), dlq: 3, backlog: 105, source: 'worker-tick' });
  fs.unlinkSync(f.observationFile);
  let report = await mod.buildOpsReport(f); assert.equal(report.ok, false); assert.equal(report.failures.length, 2); assert.equal(report.worker.dlq, 3); assert.equal(queries, 1); assert.equal(f.calls, 0);
  await mod.refreshWorkerObservation(f); assert.equal(f.calls, 1);
  report = await mod.buildOpsReport(f); assert.equal(f.calls, 1); assert.equal(report.ok, false); assert.equal(report.worker.dlq, null); assert.match(report.failures[0], /worker queue could not be read/);
});
test('missing/malformed observations and stale backup stay red without SQL', async (t) => {
  const f = fixture(t);
  let report = await mod.buildOpsReport(f); assert.equal(report.ok, false);
  fs.writeFileSync(f.observationFile, '{broken'); report = await mod.buildOpsReport(f); assert.equal(report.ok, false);
  fs.writeFileSync(f.observationFile, JSON.stringify({ at: f.now(), dlq: 0, backlog: 0, source: 'worker-tick' }));
  fs.writeFileSync(f.freshnessFile, JSON.stringify({ state: 'fresh', checkedAtUtc: new Date(0).toISOString() }));
  report = await mod.buildOpsReport(f); assert.equal(report.ok, false); assert.match(report.failures[0], /24h/); assert.equal(f.calls, 0);
});
test('worker observations older than three hours turn red without erasing queue failures or querying SQL', async (t) => {
  const f = fixture(t);
  const write = (age, dlq = 0, backlog = 0) => fs.writeFileSync(f.observationFile,
    JSON.stringify({ at: f.now() - age, dlq, backlog, source: 'worker-tick' }));
  write(mod.OPS_WORKER_MAX_AGE_MS);
  assert.equal((await mod.buildOpsReport(f)).ok, true, 'the exact three-hour boundary is still current');
  write(mod.OPS_WORKER_MAX_AGE_MS + 1);
  let report = await mod.buildOpsReport(f); assert.equal(report.ok, false);
  assert.deepEqual(report.failures, ['worker observation is stale']);
  write(mod.OPS_WORKER_MAX_AGE_MS + 1, 1, 101);
  report = await mod.buildOpsReport(f); assert.equal(report.failures.length, 3);
  assert.ok(report.failures.some((failure) => failure.includes('dead-lettered')));
  assert.ok(report.failures.some((failure) => failure.includes('backlog')));
  assert.ok(report.failures.includes('worker observation is stale'));
  assert.equal(f.calls, 0);
});
