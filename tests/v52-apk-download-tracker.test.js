'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const { createApkDownloadTracker, COOKIE } = require('../packages/services/apk-download-tracker');
const {streamApkFile, wantsApkMetrics} = require('../scripts/v51/v5-production-server.cjs');

const SECRET = 'test-only-very-long-secret-for-download-tracker-123';
const APK = { path: '/downloads/android/megaxo-1.0.3.apk', versionCode: 4, bytes: 23993495 };

function database() {
  const rows = new Map();
  return {
    rows,
    pool: {
      async withTransaction(fn) {
        const copy = new Map(rows);
        const tx = {
          async query(sql, [key, expiry]) {
            assert.match(sql, /^INSERT INTO ops\.rate_buckets /);
            if (sql.includes('DO NOTHING')) {
              if (copy.has(key)) return { rows: [] };
              copy.set(key, { hits: 1, expiry });
              return { rows: [{ bucket_id: key }] };
            }
            const before = copy.get(key);
            copy.set(key, { hits: (before?.hits || 0) + 1, expiry });
            return { rows: [] };
          }
        };
        const result = await fn(tx);
        rows.clear();
        for (const [key, value] of copy) rows.set(key, value);
        return result;
      }
    },
    count: key => rows.get(key)?.hits || 0,
  };
}

function mockResponse() {
  const headers = {};
  return { headers, setHeader: (key, value) => { headers[key.toLowerCase()] = value; } };
}

async function loopback(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString()}));
    });
    request.on('error', reject);
  });
}

test('explicitly opted-in APK GET records one completed response and one participating browser', async () => {
  const db = database();
  const tracker = createApkDownloadTracker({
    pool: db.pool, secret: SECRET, now: () => Date.UTC(2026, 9, 19),
    randomId: () => 'a'.repeat(32),
  });
  const res = mockResponse(), req = { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 Android Chrome' } };
  const commit = tracker.observe(req, res, APK, {metricsEnabled: true});
  assert.equal(typeof commit, 'function');
  assert.match(res.headers['set-cookie'], /^mx_apk_dl=v1\.[0-9a-f]{32}\.[0-9a-f]{64}; Max-Age=/);
  assert.match(res.headers['set-cookie'], /Path=\/downloads\/android\/; Secure; HttpOnly; SameSite=Lax/);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(db.rows.size, 0, 'before a successful stream finish, nothing is persisted');
  assert.deepEqual(await commit(), { newGlobal: true, newRelease: true });
  assert.equal(db.count('apkdl:total'), 1);
  assert.equal(db.count('apkdl:unique'), 1);
  assert.equal(db.count('apkdl:version:4:total'), 1);
  assert.equal(db.count('apkdl:version:4:unique'), 1);
  assert.equal(db.count('apkdl:day:2026-10-19:total'), 1);
  assert.equal(db.count('apkdl:day:2026-10-19:unique-new'), 1);
  assert.ok([...db.rows.keys()].some(k => /^apkdl:visitor:[0-9a-f]{64}$/.test(k)));
  assert.equal([...db.rows.keys()].some(k => k.includes('a'.repeat(32))), false, 'raw cookie id never goes to DB');

  const signed = res.headers['set-cookie'].split(';')[0];
  const again = mockResponse();
  const repeat = tracker.observe({ method: 'GET', headers: { cookie: signed } }, again, APK, {metricsEnabled: true});
  assert.equal(again.headers['set-cookie'], undefined, 'returning browser does not rotate cookie');
  assert.deepEqual(await repeat(), { newGlobal: false, newRelease: false });
  assert.equal(db.count('apkdl:total'), 2);
  assert.equal(db.count('apkdl:unique'), 1);
  assert.equal(db.count('apkdl:version:4:total'), 2);
  assert.equal(db.count('apkdl:version:4:unique'), 1);

  const changed = tracker.observe({ method: 'GET', headers: { cookie: signed } }, mockResponse(),
    { ...APK, versionCode: 5 }, {metricsEnabled: true});
  assert.deepEqual(await changed(), { newGlobal: false, newRelease: true },
    'one browser downloading a newer APK is unique to that release, not a new global browser');
  assert.equal(db.count('apkdl:unique'), 1);
  assert.equal(db.count('apkdl:version:5:unique'), 1);
});

test('only a single metrics=1 query value enables per-request browser counting', () => {
  assert.equal(wantsApkMetrics(new URLSearchParams('metrics=1')), true);
  for (const query of ['', 'metrics=0', 'metrics=true', 'metrics=1&metrics=1', 'metrics=1&metrics=0']) {
    assert.equal(wantsApkMetrics(new URLSearchParams(query)), false, query || 'missing metrics parameter');
  }
});

test('unchecked APK GET records aggregate totals only and clears a prior download cookie', async () => {
  const db = database();
  let generated = 0;
  const tracker = createApkDownloadTracker({
    pool: db.pool, secret: SECRET, now: () => Date.UTC(2026, 9, 19),
    randomId: () => { generated += 1; return 'c'.repeat(32); },
  });
  const optedInResponse = mockResponse();
  tracker.observe({method: 'GET', headers: {}}, optedInResponse, APK, {metricsEnabled: true});
  const priorCookie = optedInResponse.headers['set-cookie'].split(';')[0];
  const response = mockResponse();
  const commit = tracker.observe({method: 'GET', headers: {cookie: priorCookie}}, response, APK);

  assert.equal(typeof commit, 'function');
  assert.equal(generated, 1, 'unchecked requests do not mint a visitor identifier');
  assert.match(response.headers['set-cookie'], /^mx_apk_dl=; Max-Age=0;/);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(await commit(), {newGlobal: false, newRelease: false});
  assert.equal(db.count('apkdl:total'), 1);
  assert.equal(db.count('apkdl:version:4:total'), 1);
  assert.equal(db.count('apkdl:day:2026-10-19:total'), 1);
  assert.equal(db.count('apkdl:unique'), 0);
  assert.equal(db.count('apkdl:version:4:unique'), 0);
  assert.equal([...db.rows.keys()].some(key => key.includes(':visitor:') || key.includes('unique')), false,
    'no visitor hash or unique counter is persisted without per-request opt-in');

  const clean = mockResponse();
  await tracker.observe({method: 'GET', headers: {}}, clean, APK)();
  assert.equal(clean.headers['set-cookie'], undefined, 'no cookie is set on an unchecked request');
  assert.equal(db.count('apkdl:total'), 2);
  assert.equal(db.count('apkdl:unique'), 0);
});

test('HEAD, bots, prefetch and non-APK requests do not create anonymous identifiers', () => {
  const db = database();
  const tracker = createApkDownloadTracker({pool: db.pool, secret: SECRET});
  for (const req of [
    { method: 'HEAD', headers: {} },
    { method: 'POST', headers: {} },
    { method: 'GET', headers: { 'user-agent': 'Googlebot/2.1' } },
    { method: 'GET', headers: { purpose: 'prefetch' } },
    { method: 'GET', headers: { 'sec-purpose': 'prefetch' } },
  ]) {
    const res = mockResponse();
    assert.equal(tracker.observe(req, res, APK), null);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  assert.equal(tracker.observe({ method: 'GET', headers: {} }, mockResponse(), null), null);
  assert.equal(db.rows.size, 0);
});

test('tampered, duplicate or malformed cookie cannot claim an existing anonymous identity', async () => {
  const db = database();
  const tracker = createApkDownloadTracker({pool: db.pool, secret: SECRET, randomId: () => 'b'.repeat(32)});
  const req = { method: 'GET', headers: {} }, res = mockResponse();
  await tracker.observe(req, res, APK, {metricsEnabled: true})();
  const valid = res.headers['set-cookie'].split(';')[0];
  const variants = [
    valid.replace('v1.', 'v2.'), valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0'),
    valid + '; ' + valid, COOKIE + '=abcd', COOKIE + '=v1.invalid.token',
  ];
  for (const cookie of variants) {
    assert.equal(tracker.checkedCookie(cookie), null);
    const response = mockResponse();
    assert.equal(typeof tracker.observe({ method: 'GET', headers: { cookie } }, response, APK, {metricsEnabled: true}), 'function');
    assert.ok(response.headers['set-cookie']);
  }
  assert.equal(tracker.checkedCookie(valid), 'b'.repeat(32));
});

test('database errors propagate to the caller but never become leaked secrets or fake unique counts', async () => {
  const tracker = createApkDownloadTracker({pool: {withTransaction: async () => {throw Error('PG_CONN_FAIL');}}, secret: SECRET});
  const work = tracker.observe({ method: 'GET', headers: {} }, mockResponse(), APK, {metricsEnabled: true});
  assert.equal(typeof work, 'function');
  await assert.rejects(work(), /PG_CONN_FAIL/);
});

test('real HTTP file stream counts only a completed 200 response', {timeout:5000}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-stream-success-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const absolute = path.join(directory, 'app.apk');
  const bytes = Buffer.from('synthetic APK bytes');
  fs.writeFileSync(absolute, bytes);
  let completed = 0, recordFinished;
  const recorded = new Promise(resolve => { recordFinished = resolve; });
  const origin = await loopback(t, (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Length', String(bytes.length));
    streamApkFile(absolute, res, () => { completed += 1; recordFinished(); });
  });

  const response = await get(origin + '/apk');
  // The client can receive its declared Content-Length before fs emits the final EOF and the
  // server finishes its response. Wait for that actual completion, with the test deadline above.
  await recorded;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, bytes.toString());
  assert.equal(completed, 1);
});

test('real file stream error after route stat returns 500 and records no response', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-stream-error-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const absolute = path.join(directory, 'app.apk');
  fs.writeFileSync(absolute, 'present at route stat');
  let completed = 0, routeStatSucceeded = false;
  const origin = await loopback(t, (_req, res) => {
    routeStatSucceeded = fs.statSync(absolute).isFile();
    fs.unlinkSync(absolute); // reproduce disappearance between route stat and stream open
    res.statusCode = 200;
    res.setHeader('Content-Length', '23993495');
    res.setHeader('Content-Disposition', 'attachment; filename="app.apk"');
    streamApkFile(absolute, res, () => { completed += 1; });
  });

  const response = await get(origin + '/apk');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.statusCode, 500);
  assert.equal(response.body, 'File unavailable');
  assert.equal(routeStatSucceeded, true, 'the route stat succeeds before the file disappears');
  assert.equal(response.headers['content-length'], undefined);
  assert.equal(response.headers['content-disposition'], undefined);
  assert.equal(completed, 0, 'finish after an error response is not a completed APK stream');
});

test('real HTTP client abort before stream completion records no response', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-stream-abort-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const absolute = path.join(directory, 'app.apk');
  fs.closeSync(fs.openSync(absolute, 'w'));
  fs.truncateSync(absolute, 32 * 1024 * 1024);
  let completed = 0, responseClosed;
  const closed = new Promise(resolve => { responseClosed = resolve; });
  const origin = await loopback(t, (_req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Length', String(32 * 1024 * 1024));
    res.once('close', responseClosed);
    streamApkFile(absolute, res, () => { completed += 1; });
  });

  await new Promise((resolve, reject) => {
    const request = http.get(origin + '/apk', response => {
      response.once('error', () => {});
      response.once('data', () => { response.destroy(); resolve(); });
    });
    request.once('error', reject);
  });
  await closed;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, 0, 'an aborted response cannot reach the successful finish recorder');
});

test('production integration counts the pinned static artifact, never the redirect or API route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/v51/v5-production-server.cjs'), 'utf8');
  assert.match(source, /webArtifact\.androidApk\.path/);
  assert.match(source, /apkDownloadTracker\.observe\(req, res, webArtifact\.androidApk,/);
  assert.match(source, /metricsEnabled: wantsApkMetrics\(parsedUrl\.searchParams\)/);
  assert.match(source, /function streamApkFile\(absolute, res, recordCompleted = null\)/);
  assert.match(source, /res\.statusCode !== 200 \|\| !streamEnded \|\| streamFailed \|\| responseAborted/);
  assert.match(source, /stream\.bytesRead !== expectedBytes/);
  assert.doesNotMatch(source, /if \(pathname === '\/api\/download'\).*apkDownloadTracker/);
  assert.match(source, /pool: apiPool, secret: apkDownloadSecret/);
});
