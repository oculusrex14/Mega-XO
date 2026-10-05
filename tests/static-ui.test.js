'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('static shell uses an inline favicon', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('rel="icon"'));
  assert.ok(html.includes('data:image/svg+xml'));
  assert.ok(!html.includes('/favicon.ico'));
});

test('private lobby check happens before online readiness', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const start = app.indexOf('async function onlineInfo()');
  const end = app.indexOf('async function startQueue()');
  const body = app.slice(start, end);
  assert.ok(body.indexOf("mode==='private'") >= 0);
  assert.ok(body.indexOf("mode==='private'") < body.indexOf('!online.ready'));
  assert.ok(app.includes("removeAttribute('data-kind')"));
});

test('Lucide refresh ignores already-rendered svg icons', () => {
  const icons = fs.readFileSync(path.join(ROOT, 'src', 'icons.js'), 'utf8');
  assert.ok(icons.includes("querySelector('i[data-lucide]')"));
});
