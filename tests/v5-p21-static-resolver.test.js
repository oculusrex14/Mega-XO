'use strict';
/* tests/v5-p21-static-resolver.test.js - P1 static routing contract.
 *
 * The staging origin serves the GENERATED P21 bundle through scripts/p21/serve-web.js:resolveStatic.
 * The invariant that keeps a broken deployment visible: a missing sub-resource (script, image,
 * font, worker, stylesheet) is a REAL 404, never the website's visual 404 page and never the SPA
 * shell. Only genuine page routes fall back to the branded 404 document.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStatic } = require('../scripts/p21/serve-web.js');

const files = new Set([
  'index.html', '404.html', 'app.js', 'store-links.js', 'legal-documents.js',
  'legacy-game/index.html', 'legacy-game/src/game.js', 'legacy-game/src/bot/worker.js',
  'assets/art/mark.webp', 'assets/fonts/space-grotesk-latin.woff2', 'legal/privacy.html',
]);
const artifact = {
  files,
  routes: { '/': 'index.html', '/legacy-game/': 'legacy-game/index.html', '/privacy': 'pages/privacy.html', '/404': '404.html' },
};

test('the website shell and the retained-game entry resolve to the bundle', () => {
  assert.deepEqual(resolveStatic(artifact, '/'), { status: 200, file: 'index.html', text: null });
  assert.deepEqual(resolveStatic(artifact, '/legacy-game/'), { status: 200, file: 'legacy-game/index.html', text: null });
  assert.deepEqual(resolveStatic(artifact, '/legacy-game'), { status: 200, file: 'legacy-game/index.html', text: null });
});

test('generated modules, art and fonts are served', () => {
  for (const path of ['/store-links.js', '/legal-documents.js', '/assets/art/mark.webp',
    '/assets/fonts/space-grotesk-latin.woff2', '/legacy-game/src/game.js', '/legacy-game/src/bot/worker.js']) {
    const resolved = resolveStatic(artifact, path);
    assert.equal(resolved.status, 200, path);
    assert.equal(resolved.file, path.slice(1), path);
    assert.equal(resolved.text, null, path);
  }
});

test('a missing sub-resource is a real 404, never the HTML SPA fallback', () => {
  for (const path of ['/legacy-game/src/missing.js', '/assets/art/nope.webp', '/missing.css',
    '/legacy-game/src/bot/nope-worker.js', '/legal/missing.html', '/fonts/nope.woff2']) {
    const resolved = resolveStatic(artifact, path);
    assert.equal(resolved.status, 404, path);
    assert.equal(resolved.file, null, `${path} must not resolve to any file`);
    assert.equal(resolved.text, 'Not found', `${path} must not serve HTML`);
  }
});

test('an unknown page route gets the branded 404 document, not a 200 shell', () => {
  const resolved = resolveStatic(artifact, '/no-such-page');
  assert.equal(resolved.status, 404);
  assert.equal(resolved.file, '404.html');
  assert.equal(resolved.text, null);
});

test('a route not present in the bundle is not rewritten to a source file', () => {
  // '/privacy' maps to pages/privacy.html, which this bundle does not contain: the result must be
  // the branded 404, never a 200 of a non-existent path.
  const resolved = resolveStatic(artifact, '/privacy');
  assert.equal(resolved.status, 404);
  assert.equal(resolved.file, '404.html');
});
