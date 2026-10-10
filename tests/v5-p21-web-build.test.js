'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { buildWeb, ROOT, MANIFEST, WEB_FILES, GAME_FILES, LEGAL_NAMES, WEBSITE_ROUTES } = require('../scripts/p21/build-web.js');
const { createPreviewServer } = require('../scripts/p21/serve-web.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mega-p21-build-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, bytes) => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  for (const name of WEB_FILES) write('apps/web/' + name, name === 'index.html' ? '<!doctype html><title>Mega XOXO</title><script type="module" src="/app.js"></script>' : '/* synthetic website fixture */');
  const retained = ['index.html', ...GAME_FILES.map(name => 'src/' + name), ...LEGAL_NAMES.map(name => 'public/' + name + '.html'), 'public/legal.css'];
  for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) for (const kind of ['app', 'mark']) retained.push('assets/p21/logos/mega-xoxo-' + theme + '-' + kind + '.webp');
  for (const relative of retained) write(relative, fs.readFileSync(path.join(ROOT, relative)));
  const webp = Buffer.from('5249464610000000574542505650384c00000000', 'hex');
  for (const name of ['header', 'mark', 'hero-landscape']) write('assets/p21/art/' + name + '.webp', webp);
  write('assets/p21/art/huge-master.png', 'must not ship');
  write('assets/p21/reference/private-reference.png', 'must not ship');
  write('assets/p21/fonts/test-latin.woff2', Buffer.from('wOF2'));
  write('assets/p21/fonts/OFL.txt', 'test license');
  for (const relative of ['.env', '.vercel/project.json', 'server/credentials.json', 'src/authority.js', 'native/keystore.jks', 'players.sqlite']) write(relative, 'FORBIDDEN-SENTINEL');
  return { root, write, retained };
}

test('P21-BUILD-01: deterministic positive allowlist excludes authority, secrets, native files and masters', t => {
  const { root } = fixture(t);
  const first = buildWeb({ root });
  const text = fs.readFileSync(path.join(first.output, MANIFEST), 'utf8');
  const second = buildWeb({ root });
  assert.equal(fs.readFileSync(path.join(second.output, MANIFEST), 'utf8'), text);
  assert.equal(first.manifest.bundle_sha256, second.manifest.bundle_sha256);
  assert.equal(first.manifest.api.configured, false);
  assert.deepEqual(fs.readFileSync(path.join(first.output, '404.html')), fs.readFileSync(path.join(first.output, 'index.html')));
  assert.equal(first.manifest.routes['/game/'], 'game/index.html');
  assert.equal(first.manifest.routes['/privacy'], 'index.html');
  assert.equal(first.manifest.routes['/legal/privacy'], 'legal/privacy.html');
  for (const file of second.manifest.files) {
    const bytes = fs.readFileSync(path.join(second.output, file.path));
    assert.equal(hash(bytes), file.sha256, file.path);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.ok(!bytes.includes(Buffer.from('FORBIDDEN-SENTINEL')), file.path);
    assert.ok(!/\.png$|authority|\.env|\.sqlite|\.vercel|keystore/.test(file.path), file.path);
  }
  assert.ok(second.manifest.files.some(file => file.path === 'assets/art/hero-landscape.webp'));
  assert.ok(second.manifest.files.some(file => file.path === 'assets/art/header.webp'));
  assert.ok(!second.manifest.files.some(file => file.path === 'assets/brand/header.webp'));
  assert.ok(second.manifest.files.some(file => file.path === 'assets/fonts/test-latin.woff2'));
});

test('P21-BUILD-02: preserved game bytes and relative script, style, logo dependencies resolve', t => {
  const { root, retained } = fixture(t);
  const before = new Map(retained.map(relative => [relative, hash(fs.readFileSync(path.join(root, relative)))]));
  const result = buildWeb({ root });
  assert.deepEqual(fs.readFileSync(path.join(result.output, 'game/index.html')), fs.readFileSync(path.join(root, 'index.html')));
  const html = fs.readFileSync(path.join(result.output, 'game/index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(src\/[^"?#]+)"/g)) assert.ok(fs.existsSync(path.join(result.output, 'game', match[1])), match[1]);
  for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) assert.ok(fs.existsSync(path.join(result.output, 'game/assets/p21/logos/mega-xoxo-' + theme + '-mark.webp')));
  for (const [relative, checksum] of before) assert.equal(hash(fs.readFileSync(path.join(root, relative))), checksum, relative);
  assert.ok(fs.readFileSync(path.join(result.output, 'legal/privacy.html'), 'utf8').includes('/legal/legal.css'));
  assert.ok(!fs.readFileSync(path.join(result.output, 'legal/privacy.html'), 'utf8').includes('/public/legal.css'));
});

test('P21-BUILD-03: failed preflight preserves last build; arbitrary and unowned outputs are refused', t => {
  const { root, write } = fixture(t);
  const first = buildWeb({ root });
  const previous = fs.readFileSync(path.join(first.output, MANIFEST));
  write('assets/p21/art/bad.webp', 'not a WebP');
  assert.throws(() => buildWeb({ root }), /not a WebP export/);
  assert.deepEqual(fs.readFileSync(path.join(first.output, MANIFEST)), previous);
  fs.unlinkSync(path.join(root, 'assets/p21/art/bad.webp'));
  assert.throws(() => buildWeb({ root, output: '.' }), /output must/);
  assert.throws(() => buildWeb({ root, output: '/tmp' }), /output must/);
  write('.artifacts/unowned/important.txt', 'preserve');
  assert.throws(() => buildWeb({ root, output: '.artifacts/unowned' }), /not a recognized generated/);
  assert.equal(fs.readFileSync(path.join(root, '.artifacts/unowned/important.txt'), 'utf8'), 'preserve');
  write('.artifacts/p21-web/manual-notes.txt', 'preserve');
  assert.throws(() => buildWeb({ root }), /unrecognized file/);
  assert.equal(fs.readFileSync(path.join(first.output, 'manual-notes.txt'), 'utf8'), 'preserve');
});

test('P21-BUILD-04: source/output symlink escape and missing optimized brand exports are refused', t => {
  const { root } = fixture(t);
  fs.unlinkSync(path.join(root, 'apps/web/app.js'));
  fs.symlinkSync(path.join(ROOT, 'src/authority.js'), path.join(root, 'apps/web/app.js'));
  assert.throws(() => buildWeb({ root }), /regular, unlinked file/);
  fs.unlinkSync(path.join(root, 'apps/web/app.js'));
  fs.writeFileSync(path.join(root, 'apps/web/app.js'), '// restored fixture');
  fs.mkdirSync(path.join(root, '.artifacts'));
  fs.symlinkSync(os.tmpdir(), path.join(root, '.artifacts/linked'));
  assert.throws(() => buildWeb({ root, output: '.artifacts/linked/build' }), /symlink/);
  fs.unlinkSync(path.join(root, 'assets/p21/art/header.webp'));
  assert.throws(() => buildWeb({ root }), /required optimized brand export is missing/);
});

function rawRequest(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('P21-SERVE-01: clean route deep links, legal pages and game assets serve with correct content types', async t => {
  const { root } = fixture(t);
  const build = buildWeb({ root });
  const server = createPreviewServer({ directory: build.output });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  for (const route of WEBSITE_ROUTES) {
    const response = await rawRequest(port, route + '?source=deep-link');
    assert.equal(response.status, 200, route);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.ok(response.body.includes('Mega XOXO'), route);
  }
  for (const name of LEGAL_NAMES) {
    const response = await rawRequest(port, '/legal/' + name);
    assert.equal(response.status, 200, name);
    assert.match(response.headers['content-type'], /^text\/html/);
  }
  const game = await rawRequest(port, '/game/?mode=practice');
  assert.equal(game.status, 200);
  assert.ok(game.body.includes('src/game.js'));
  const script = await rawRequest(port, '/game/src/game.js');
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal(script.status, 200);
  assert.equal((await rawRequest(port, '/assets/art/header.webp')).headers['content-type'], 'image/webp');
  assert.equal((await rawRequest(port, '/assets/fonts/test-latin.woff2')).headers['content-type'], 'font/woff2');
  const redirect = await rawRequest(port, '/game?mode=practice');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/game/?mode=practice');
  const head = await rawRequest(port, '/ranked', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['x-content-type-options'], 'nosniff');
  assert.match(head.headers['content-security-policy'], /object-src 'none'/);
});

test('P21-SERVE-02: traversal, absent assets and writes fail safely; API is explicitly unconfigured', async t => {
  const { root } = fixture(t);
  const build = buildWeb({ root });
  const server = createPreviewServer({ directory: build.output });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  for (const pathname of ['/../.env', '/%2e%2e/.env', '/assets/%2e%2e/%2e%2e/.env', '/game/%5c..%5c.env', '/bad%00path', '/%zz']) assert.equal((await rawRequest(port, pathname)).status, 400, pathname);
  for (const pathname of ['/assets/missing.webp', '/app-missing.js', '/game/src/authority.js', '/game/nonexistent', '/.env', '/server/credentials.json']) assert.equal((await rawRequest(port, pathname)).status, 404, pathname);
  const unknown = await rawRequest(port, '/not-a-page');
  assert.equal(unknown.status, 404);
  const api = await rawRequest(port, '/api/account/session');
  assert.equal(api.status, 503);
  assert.equal(JSON.parse(api.body).error, 'WEB_API_NOT_CONFIGURED');
  const mutation = await rawRequest(port, '/api/community/presence', 'POST');
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.allow, 'GET, HEAD');
});

test('P21-DELIVERY-01: Vercel routing matches static manifest and automatic deployments stay disabled', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/web/vercel.json'), 'utf8'));
  assert.equal(config.outputDirectory, 'dist');
  assert.equal(config.git.deploymentEnabled, false);
  assert.equal(config.installCommand, 'true');
  for (const route of WEBSITE_ROUTES.filter(route => route !== '/')) assert.ok(config.rewrites.some(rule => rule.source === route && rule.destination === '/index.html'), route);
  for (const name of LEGAL_NAMES) assert.ok(config.rewrites.some(rule => rule.source === '/legal/' + name && rule.destination === '/legal/' + name + '.html'), name);
  assert.ok(!config.rewrites.some(rule => rule.source.includes('/api') || rule.destination.startsWith('http')));
  assert.ok(config.redirects.some(rule => rule.source === '/game' && rule.destination === '/game/'));
});
