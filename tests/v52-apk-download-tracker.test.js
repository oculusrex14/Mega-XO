'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApkDownloadTracker, COOKIE } = require('../packages/services/apk-download-tracker');

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

test('first real APK GET records one completed response and one unique browser', async () => {
  const db = database();
  const tracker = createApkDownloadTracker({
    pool: db.pool, secret: SECRET, now: () => Date.UTC(2026, 9, 19),
    randomId: () => 'a'.repeat(32),
  });
  const res = mockResponse(), req = { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 Android Chrome' } };
  const commit = tracker.observe(req, res, APK);
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
  const repeat = tracker.observe({ method: 'GET', headers: { cookie: signed } }, again, APK);
  assert.equal(again.headers['set-cookie'], undefined, 'returning browser does not rotate cookie');
  assert.deepEqual(await repeat(), { newGlobal: false, newRelease: false });
  assert.equal(db.count('apkdl:total'), 2);
  assert.equal(db.count('apkdl:unique'), 1);
  assert.equal(db.count('apkdl:version:4:total'), 2);
  assert.equal(db.count('apkdl:version:4:unique'), 1);

  const changed = tracker.observe({ method: 'GET', headers: { cookie: signed } }, mockResponse(),
    { ...APK, versionCode: 5 });
  assert.deepEqual(await changed(), { newGlobal: false, newRelease: true },
    'one browser downloading a newer APK is unique to that release, not a new global browser');
  assert.equal(db.count('apkdl:unique'), 1);
  assert.equal(db.count('apkdl:version:5:unique'), 1);
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
  await tracker.observe(req, res, APK)();
  const valid = res.headers['set-cookie'].split(';')[0];
  const variants = [
    valid.replace('v1.', 'v2.'), valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0'),
    valid + '; ' + valid, COOKIE + '=abcd', COOKIE + '=v1.invalid.token',
  ];
  for (const cookie of variants) {
    assert.equal(tracker.checkedCookie(cookie), null);
    const response = mockResponse();
    assert.equal(typeof tracker.observe({ method: 'GET', headers: { cookie } }, response, APK), 'function');
    assert.ok(response.headers['set-cookie']);
  }
  assert.equal(tracker.checkedCookie(valid), 'b'.repeat(32));
});

test('database errors propagate to the caller but never become leaked secrets or fake unique counts', async () => {
  const tracker = createApkDownloadTracker({pool: {withTransaction: async () => {throw Error('PG_CONN_FAIL');}}, secret: SECRET});
  const work = tracker.observe({ method: 'GET', headers: {} }, mockResponse(), APK);
  assert.equal(typeof work, 'function');
  await assert.rejects(work(), /PG_CONN_FAIL/);
});

test('production integration counts the pinned static artifact, never the redirect or API route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/v51/v5-production-server.cjs'), 'utf8');
  assert.match(source, /webArtifact\.androidApk\.path/);
  assert.match(source, /apkDownloadTracker\.observe\(req, res, webArtifact\.androidApk\)/);
  assert.match(source, /res\.once\('finish', \(\) =>/);
  assert.doesNotMatch(source, /if \(pathname === '\/api\/download'\).*apkDownloadTracker/);
  assert.match(source, /pool: apiPool, secret: otpSecret/);
});
