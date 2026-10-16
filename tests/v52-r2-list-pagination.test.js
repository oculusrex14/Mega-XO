'use strict';

/* Offline regression proof for the V5 R2 listing pagination (LR05, 2026-10-16).
 *
 * PRODUCTION INCIDENT REPRODUCED HERE: the single-page list() silently truncated at 1000
 * objects (500 backups x 2 objects). S3 pages are KEY-ordered and backup keys embed a
 * timestamp, so the page contained only the OLDEST backups; the freshness check then kept
 * reporting a 21:51 manifest as "newest" while the backup pipeline uploaded new ones every
 * 5 minutes, red-lettering /opsz (V5_BACKUP_STALE beyond the 900 s RPO) with healthy backups.
 *
 * No socket, no credential, no provider call: collectPages() is exercised with synthetic
 * XML pages through an injected fetcher. */
const test = require('node:test');
const assert = require('node:assert/strict');

const Client = require('../deploy/v5/v5-r2-client.js');

const PREFIX = 'megaxo/v5/pg16-encrypted/v1/';
const OLD_MANIFEST = PREFIX + 'v5-p15-2026-10-15T21-51-31-220Z-c0e373a287c255f7.manifest.json';
const NEW_MANIFEST = PREFIX + 'v5-p15-2026-10-16T03-18-21-021Z-c19c6a55ef9dcdfc.manifest.json';

function pageXml(entries, opts = {}) {
  return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
    (opts.truncated ? '<IsTruncated>true</IsTruncated><NextContinuationToken>' + opts.token + '</NextContinuationToken>' : '<IsTruncated>false</IsTruncated>') +
    entries.map(({ key, lm, size }) =>
      '<Contents><Key>' + key + '</Key><LastModified>' + lm + '</LastModified><Size>' + size + '</Size></Contents>').join('') +
    '</ListBucketResult>';
}

test('collectPages: follows continuation tokens to the newest manifest across pages', () => {
  /* Page 1: the OLD backup only (as a truncated real-world page would end), newest page last. */
  const pages = [
    pageXml([{ key: OLD_MANIFEST, lm: '2026-10-15T21:51:32.000Z', size: 237530 }],
      { truncated: true, token: 'tok1/a+b==' }),
    pageXml([{ key: NEW_MANIFEST, lm: '2026-10-16T03:18:23.000Z', size: 241727 }]),
  ];
  const queries = [];
  const out = Client.collectPages((query) => { queries.push(query); return pages[queries.length - 1]; }, PREFIX);
  assert.equal(out.length, 2);
  /* S3 key order (oldest first) is preserved; the caller sorts by lastModified. */
  assert.equal(out[0].key, OLD_MANIFEST);
  assert.equal(out[1].key, NEW_MANIFEST);
  assert.equal(out[1].lastModified, '2026-10-16T03:18:23.000Z');
  /* The continuation token is URL-encoded into page 2's query. */
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0], /continuation-token/);
  assert.match(queries[1], /continuation-token=tok1%2Fa%2Bb%3D%3D/);
  assert.match(queries[0], /max-keys=1000/);
});

test('collectPages: truncated page without a token refuses instead of lying silently', () => {
  const bad = '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>';
  assert.throws(() => Client.collectPages(() => bad, PREFIX), /without a continuation token/);
});

test('collectPages: refuses beyond the page safety cap instead of returning partial evidence', () => {
  const endless = pageXml([{ key: OLD_MANIFEST, lm: '2026-10-15T21:51:32.000Z', size: 1 }],
    { truncated: true, token: 'more' });
  assert.throws(() => Client.collectPages(() => endless, PREFIX), /page safety cap/);
});

test('parseListPage: refuses a non-S3 body outright', () => {
  assert.throws(() => Client.parseListPage('<html>oops</html>'), /not an S3 listing/);
});
