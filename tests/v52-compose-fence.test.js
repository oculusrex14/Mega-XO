'use strict';

/* Offline render proof for the V5 edge-only compose surface and the V4 fence (LR03A).
 *
 * 2026-10-16 host evidence: the live mega-xo-production compose project was still loaded from the
 * V4-era deploy/compose.yaml (SQLite app with restart: unless-stopped + edge depends_on), so any
 * routine docker compose up for a Caddy change could have recreated the fenced V4 writer. This
 * suite renders BOTH files with docker compose config (no daemon needed) and asserts that the V5
 * edge file is edge-only and that the V4 file selects zero services without an explicit profile.
 * Skips when docker compose is unavailable. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EDGE = path.join(ROOT, 'deploy', 'compose-v5-edge.yaml');
const FENCED = path.join(ROOT, 'deploy', 'legacy-v4-recovery', 'compose.yaml.fenced');
const CADDY = path.join(ROOT, 'deploy', 'Caddyfile');
const ENV = Object.assign({}, process.env, {
  MEGA_ROOT: '/opt/mega-xo',
  MEGA_IMAGE: 'test@sha256:0000000000000000000000000000000000000000000000000000000000000000',
  MEGA_HOSTNAME: 'megaxo.online',
});

let hasCompose = false;
try { execFileSync('docker', ['compose', 'version'], { stdio: 'pipe' }); hasCompose = true; } catch (err) { hasCompose = false; }

function composeArgs(file, extraArgs, mode) {
  const args = ['compose'].concat(extraArgs, ['-f', file, 'config']);
  if (mode) args.push(mode);
  return execFileSync('docker', args, {
    env: ENV, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
}

test('the V4 compose file is fenced away from deploy/', () => {
  assert.ok(fs.existsSync(FENCED), 'fenced artifact present');
  assert.ok(!fs.existsSync(path.join(ROOT, 'deploy', 'compose.yaml')), 'deploy/compose.yaml must not exist');
  const raw = fs.readFileSync(FENCED, 'utf8');
  assert.match(raw, /v4-fenced-do-not-run/, 'every service is profile-gated');
  assert.match(raw, /MEGA_DB:\s*\/data\/mega\.sqlite/, 'the fenced artifact documents the SQLite writer it fences');
});

test('the V5 edge file renders edge-only with no database and no depends_on', (t) => {
  if (!hasCompose) return t.skip('docker compose unavailable');
  const services = composeArgs(EDGE, [], '--services').split('\n').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(services, ['edge']);
  const rendered = composeArgs(EDGE, [], '');
  assert.doesNotMatch(rendered, /mega\.sqlite/i, 'no SQLite path anywhere in the V5 edge');
  assert.doesNotMatch(rendered, /depends_on/, 'no depends_on in the V5 edge');
  assert.match(rendered, /caddy@sha256:[0-9a-f]{64}/, 'pinned immutable caddy digest preserved');
});

test('the fenced V4 project selects zero services without the explicit recovery profile', (t) => {
  if (!hasCompose) return t.skip('docker compose unavailable');
  const none = composeArgs(FENCED, [], '--services').split('\n').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(none, [], 'no service is selected by default');
  const gated = composeArgs(FENCED, ['--profile', 'v4-fenced-do-not-run'], '--services').split('\n').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(gated, ['app', 'backup', 'edge'], 'deliberate recovery profile exposes exactly the V4 services');
});

test('the V5 edge mounts the canonical repo Caddyfile', () => {
  const caddyfile = fs.readFileSync(CADDY, 'utf8');
  assert.match(caddyfile, /megaxo\.online \{/, 'canonical apex site block present');
  assert.match(caddyfile, /core\.megaxo\.online \{/, 'core ingress block present');
});
