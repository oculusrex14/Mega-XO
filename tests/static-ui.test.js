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


test('tournament mode selects before opening', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const party = fs.readFileSync(path.join(ROOT, 'src', 'party-ui.js'), 'utf8');
  assert.ok(app.includes("['tournament','trophy','Tournaments','Ten players. One table. Bigger prizes.']"));
  assert.ok(app.includes("mode==='tournament'?'Browse Tournaments'"));
  assert.ok(app.includes("mode==='tournament'?(window.MegaParties?.tables"));
  assert.ok(!party.includes("dataset.party='tables'"));
});

test('identity loader plays a themed XO win', () => {
  const community = fs.readFileSync(path.join(ROOT, 'src', 'community.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'community.css'), 'utf8');
  assert.ok(community.includes('xo-loader-strike'));
  assert.ok(community.includes('mark-layer x xo-loader-mark'));
  assert.ok(community.includes('mark-layer o xo-loader-mark'));
  assert.ok(css.includes('@keyframes xo-loader-strike'));
  assert.ok(css.includes("[data-theme='paperclub'] .xo-loader-board"));
  assert.ok(css.includes("[data-theme='afterhours'] .xo-loader-board"));
});

test('Midnight selected mode restores icon tile contrast', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.ok(css.includes(':root[data-theme="midnight"] .mode.active .mode-symbol{'));
  assert.ok(css.includes('background:var(--accent)!important'));
  assert.ok(css.includes('color:var(--on-accent)!important'));
});
