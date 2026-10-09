#!/usr/bin/env node
'use strict';
// P20: Reject Android/iOS builds which were generated from different approved
// client asset inventories. No provider tokens, signing material or player data.
const fs = require('node:fs');

function fail(message) { throw new Error('NATIVE_BUNDLE_PARITY: ' + message); }

function load(path) {
  let raw;
  try { raw = fs.readFileSync(path, 'utf8'); }
  catch { fail('manifest file unavailable'); }
  let manifest;
  try { manifest = JSON.parse(raw); } catch { fail('manifest JSON invalid'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      typeof manifest.bundle_hash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.bundle_hash) ||
      !Array.isArray(manifest.files) || manifest.files.length < 2) {
    fail('manifest schema invalid');
  }
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('invalid bundle file');
    if (file.path.includes('..') || file.path.startsWith('/') ||
        /^(?:server|docs|tests|deploy)\//.test(file.path) || file.path.includes('authority.js')) {
      fail('forbidden client file');
    }
  }
  return { raw, manifest };
}
function verify(androidPath, iosPath) {
  const a = load(androidPath), b = load(iosPath);
  if (a.raw !== b.raw || a.manifest.bundle_hash !== b.manifest.bundle_hash) {
    fail('platforms contain different approved client inventory or bytes');
  }
  return { bundleHash: a.manifest.bundle_hash, fileCount: a.manifest.files.length };
}
if (require.main === module) {
  if (process.argv.length !== 4) fail('expected Android and iOS manifest paths');
  const found = verify(process.argv[2], process.argv[3]);
  process.stdout.write('Native client parity passed: hash=' + found.bundleHash +
    ' files=' + found.fileCount + '\n');
}
module.exports = { verify };
