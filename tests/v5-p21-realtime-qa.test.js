'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MANIFEST } = require('../scripts/p21/build-web.js');
const { parseArgs, verifyArtifact, copySnapshot } = require('../scripts/p21/realtime-qa.cjs');

const SOURCE = 'a'.repeat(40);
const PREVIEW_SEAM = 'explicit P21_READ_API_ORIGIN only; GET /api/v1/leaderboard; no credential forwarding';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, { configured = false, duplicate = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p21-realtime-qa-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(bundle);
  const payload = Buffer.from('synthetic verified bytes\n');
  const file = { path: 'assets/verified.txt', bytes: payload.length, sha256: sha256(payload) };
  fs.mkdirSync(path.join(bundle, 'assets'));
  fs.writeFileSync(path.join(bundle, file.path), payload);
  const files = duplicate ? [file, { ...file }] : [file];
  const rows = files.map(entry => entry.path + '\0' + entry.bytes + '\0' + entry.sha256);
  const manifest = {
    generator: 'scripts/p21/build-web.js',
    source_commit: SOURCE,
    bundle_sha256: sha256(Buffer.from(rows.join('\0'))),
    api: { configured, preview_read_seam: PREVIEW_SEAM },
    files,
  };
  fs.writeFileSync(path.join(bundle, MANIFEST), JSON.stringify(manifest) + '\n');
  return { root, bundle, manifest, payloadPath: path.join(bundle, file.path), payload };
}

function args(bundle) {
  return ['--bundle', bundle, '--expect-source', SOURCE, '--expect-bundle', 'b'.repeat(64)];
}

test('realtime QA arguments require a named bundle and reject unknown options', () => {
  assert.throws(() => parseArgs([]), /P21_REALTIME_QA_REFUSED/);
  assert.throws(() => parseArgs([...args('/fixture'), '--unexpected', 'value']), /P21_REALTIME_QA_REFUSED/);
  assert.equal(parseArgs(args('/fixture')).browser, 'chromium');
});

test('artifact verification binds the expected source and bundle digest', t => {
  const item = fixture(t);
  assert.throws(() => verifyArtifact(item.bundle, 'c'.repeat(40), item.manifest.bundle_sha256), /identity/);
  assert.throws(() => verifyArtifact(item.bundle, SOURCE, 'd'.repeat(64)), /identity/);
  assert.equal(verifyArtifact(item.bundle, SOURCE, item.manifest.bundle_sha256).payloadBytes, item.payload.length);
});

test('artifact verification refuses configured APIs and duplicate inventory paths', t => {
  const configured = fixture(t, { configured: true });
  assert.throws(() => verifyArtifact(configured.bundle, SOURCE, configured.manifest.bundle_sha256), /all account\/game APIs unconfigured/);
  const duplicate = fixture(t, { duplicate: true });
  assert.throws(() => verifyArtifact(duplicate.bundle, SOURCE, duplicate.manifest.bundle_sha256), /duplicate path/);
});

test('artifact verification detects changed bytes and linked payloads', t => {
  const changed = fixture(t);
  fs.writeFileSync(changed.payloadPath, 'altered bytes');
  assert.throws(() => verifyArtifact(changed.bundle, SOURCE, changed.manifest.bundle_sha256), /checksum mismatch/);

  const linked = fixture(t);
  const target = path.join(linked.root, 'outside-payload.txt');
  fs.writeFileSync(target, linked.payload);
  fs.rmSync(linked.payloadPath);
  try { fs.symlinkSync(target, linked.payloadPath); }
  catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) return t.skip('host does not permit temporary symlinks');
    throw error;
  }
  assert.throws(() => verifyArtifact(linked.bundle, SOURCE, linked.manifest.bundle_sha256), /linked/);
});

test('snapshot copies only verified payloads and refuses overwrite', t => {
  const item = fixture(t);
  const verified = verifyArtifact(item.bundle, SOURCE, item.manifest.bundle_sha256);
  fs.writeFileSync(path.join(item.bundle, 'unlisted.txt'), 'extra fixture file');
  const snapshot = fs.mkdtempSync(path.join(item.root, 'snapshot-'));
  copySnapshot(verified, snapshot);
  assert.deepEqual(fs.readFileSync(path.join(snapshot, 'assets/verified.txt')), item.payload);
  assert.equal(fs.existsSync(path.join(snapshot, 'unlisted.txt')), false);
  assert.equal(fs.existsSync(path.join(snapshot, MANIFEST)), true);
  assert.throws(() => copySnapshot(verified, snapshot), error => error.code === 'EEXIST');
  assert.throws(() => verifyArtifact(item.bundle, SOURCE, item.manifest.bundle_sha256), /outside its exact manifest inventory/);
});
