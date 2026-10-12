'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { buildWeb, ROOT, MANIFEST, WEB_FILES, ICON_FILES, OPTIONAL_WEB_FILES, GAME_FILES, LEGAL_NAMES, WEBSITE_ROUTES, routeFile } = require('../scripts/p21/build-web.js');
const { createPreviewServer, READ_API_ORIGIN, READ_MAX_BYTES } = require('../scripts/p21/serve-web.js');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mega-p21-build-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, bytes) => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
  for (const name of [...WEB_FILES, ...OPTIONAL_WEB_FILES, 'package.json', 'store-links.json']) {
    const original=path.join(ROOT,'apps/web',name);
    write('apps/web/'+name,fs.existsSync(original)?fs.readFileSync(original):'/* optional synthetic runtime fixture */');
  }
  const retained = ['index.html', ...GAME_FILES.map(name => 'src/' + name), ...LEGAL_NAMES.map(name => 'public/' + name + '.html'), 'public/legal.css', 'scripts/p21/offline-worker.cjs', ...ICON_FILES.map(name=>'assets/p21/icons/'+name)];
  for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) for (const kind of ['app', 'mark']) retained.push('assets/p21/logos/mega-xoxo-' + theme + '-' + kind + '.webp');
  for (const relative of retained) write(relative, fs.readFileSync(path.join(ROOT, relative)));
  const webp = Buffer.from('5249464610000000574542505650384c00000000', 'hex');
  for (const name of ['header', 'mark', 'hero-landscape']) write('assets/p21/art/' + name + '.webp', webp);
  write('assets/p21/ranks/wood.webp', webp);
  write('assets/p21/ranks/archive/diamond.webp', webp);
  write('assets/p21/art/ranks/stone.webp', webp);
  write('assets/p21/art/currency/coin.webp', webp);
  write('assets/p21/ranks/original.png', 'must not ship');
  write('assets/p21/art/huge-master.png', 'must not ship');
  write('assets/p21/reference/private-reference.png', 'must not ship');
  write('assets/p21/icons/not-approved.png', 'must not ship');
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
  assert.equal(first.manifest.routes['/game'], 'pages/game.html');
  assert.equal(first.manifest.routes['/game/'], 'pages/game.html');
  assert.notDeepEqual(fs.readFileSync(path.join(first.output, '404.html')), fs.readFileSync(path.join(first.output, 'index.html')));
  assert.equal(first.manifest.routes['/legacy-game/'], 'legacy-game/index.html');
  assert.equal(first.manifest.routes['/privacy'], 'pages/privacy.html');
  assert.equal(first.manifest.routes['/legal/privacy'], 'pages/legal/privacy.html');
  for (const file of second.manifest.files) {
    const bytes = fs.readFileSync(path.join(second.output, file.path));
    assert.equal(hash(bytes), file.sha256, file.path);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.ok(!bytes.includes(Buffer.from('FORBIDDEN-SENTINEL')), file.path);
    assert.ok(!/authority|\.env|\.sqlite|\.vercel|keystore|master|reference/.test(file.path), file.path);
    if(file.path.endsWith('.png'))assert.ok(ICON_FILES.some(name=>file.path==='assets/icons/'+name),file.path);
  }
  assert.ok(second.manifest.files.some(file => file.path === 'assets/art/hero-landscape.webp'));
  assert.ok(second.manifest.files.some(file => file.path === 'assets/art/header.webp'));
  assert.ok(!second.manifest.files.some(file => file.path === 'assets/brand/header.webp'));
  assert.ok(second.manifest.files.some(file => file.path === 'assets/fonts/test-latin.woff2'));
  for (const file of ['data.js', 'game-runtime.js', 'legal-documents.js', 'assets/art/ranks/wood.webp', 'assets/art/ranks/archive/diamond.webp', 'assets/art/ranks/stone.webp', 'assets/art/currency/coin.webp']) assert.ok(second.manifest.files.some(row => row.path === file), file);
  for(const name of ICON_FILES)assert.ok(second.manifest.files.some(row=>row.path==='assets/icons/'+name));
  assert.ok(!second.manifest.files.some(row=>row.path.endsWith('not-approved.png')));
});

test('P21-BUILD-06: offline copy uses only versioned static bytes and guest documents, never private/API responses',t=>{
 const {root,write}=fixture(t);const first=buildWeb({root});
 const manifest=JSON.parse(fs.readFileSync(path.join(first.output,'manifest.webmanifest'),'utf8'));
 assert.equal(manifest.start_url,'/game');assert.equal(manifest.id,'/game');assert.equal(manifest.display,'standalone');
 assert.equal(manifest.icons.find(row=>row.purpose==='maskable').sizes,'512x512');
 const offline=first.manifest.offline;
 assert.deepEqual(offline.navigations,{'/game':'/pages/game.html','/offline':'/pages/offline.html','/how-to-play':'/pages/how-to-play.html'});
 assert.ok(offline.bytes<6*1024*1024);assert.match(offline.version,/^[a-f0-9]{64}$/);
 assert.equal(offline.registration,'explicit user opt-in only');
 const paths=new Set(offline.assets.map(row=>row.url));
 for(const required of ['/app.js','/offline.js','/legal-documents.js','/pages/game.html','/pages/offline.html','/pages/how-to-play.html','/legacy-game/src/game.js'])assert.ok(paths.has(required),required);
 for(const url of paths)assert.ok(!/^\/api(?:\/|$)|^\/auth(?:\/|$)|^\/pages\/(?:account|profile|settings|friends|challenge)\.html$|^\/legacy-game\/index\.html$/.test(url),url);
 for(const row of offline.assets)assert.equal(row.sha256,first.manifest.files.find(file=>'/'+file.path===row.url).sha256);
 const version=offline.version;write('apps/web/styles.css',fs.readFileSync(path.join(root,'apps/web/styles.css'),'utf8')+'\n/* fixture version change */\n');
 const next=buildWeb({root});assert.notEqual(next.manifest.offline.version,version);
});

test('P21-BUILD-02: preserved legacy game and complete legal wording have checksummed source parity', async t => {
  const { root, retained } = fixture(t);
  const before = new Map(retained.map(relative => [relative, hash(fs.readFileSync(path.join(root, relative)))]));
  const result = buildWeb({ root });
  assert.deepEqual(fs.readFileSync(path.join(result.output, 'legacy-game/index.html')), fs.readFileSync(path.join(root, 'index.html')));
  const html = fs.readFileSync(path.join(result.output, 'legacy-game/index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(src\/[^"?#]+)"/g)) assert.ok(fs.existsSync(path.join(result.output, 'legacy-game', match[1])), match[1]);
  for (const theme of ['vector', 'midnight', 'paperclub', 'afterhours']) assert.ok(fs.existsSync(path.join(result.output, 'legacy-game/assets/p21/logos/mega-xoxo-' + theme + '-mark.webp')));
  for (const [relative, checksum] of before) assert.equal(hash(fs.readFileSync(path.join(root, relative))), checksum, relative);
  assert.ok(fs.readFileSync(path.join(result.output, 'legal/privacy.html'), 'utf8').includes('/legal/legal.css'));
  assert.ok(!fs.readFileSync(path.join(result.output, 'legal/privacy.html'), 'utf8').includes('/public/legal.css'));
  const generated = result.manifest.files.find(file => file.path === 'legal-documents.js');
  const bytes = fs.readFileSync(path.join(result.output, generated.path));
  const { legalDocuments } = await import('data:text/javascript;base64,' + bytes.toString('base64'));
  for (const name of LEGAL_NAMES) {
    const source = fs.readFileSync(path.join(root, 'public/' + name + '.html'), 'utf8');
    assert.equal(legalDocuments[name], source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)[1], name);
    assert.ok(!/<(?:style|script|head|body)\b/i.test(legalDocuments[name]), name);
    assert.equal(generated.sources.find(row => row.source === 'public/' + name + '.html').source_sha256, hash(Buffer.from(source)));
  }
  assert.match(legalDocuments.privacy, /Draft for legal review/);
  assert.match(legalDocuments.terms, /Draft for legal review/);
});

test('P21-BUILD-05: a changed or executable legal source and linked rank exports are refused before replacement', t => {
  const { root, write } = fixture(t);
  const result = buildWeb({ root });
  const prior = fs.readFileSync(path.join(result.output, MANIFEST));
  const source = fs.readFileSync(path.join(root, 'public/privacy.html'), 'utf8');
  write('public/privacy.html', source.replace('</main>', '<script>bad()</script></main>'));
  assert.throws(() => buildWeb({ root }), /document markup only/);
  assert.deepEqual(fs.readFileSync(path.join(result.output, MANIFEST)), prior);
  write('public/privacy.html', source.replace('</main>', '</main><main>second</main>'));
  assert.throws(() => buildWeb({ root }), /exactly one main/);
  write('public/privacy.html', source);
  fs.symlinkSync(path.join(ROOT, 'assets/p21/art/header.webp'), path.join(root, 'assets/p21/ranks/linked.webp'));
  assert.throws(() => buildWeb({ root }), /rank asset must be unlinked/);
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

function rawRequest(port, pathname, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, agent: false }, response => {
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
  const server = createPreviewServer({ directory: build.output, readApiOrigin: null });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  for (const route of WEBSITE_ROUTES) {
    const response = await rawRequest(port, route + '?source=deep-link');
    assert.equal(response.status, route === '/404' ? 404 : 200, route);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.ok(response.body.includes('Mega XOXO'), route);
  }
  for (const name of LEGAL_NAMES) {
    const response = await rawRequest(port, '/legal/' + name);
    assert.equal(response.status, 200, name);
    assert.match(response.headers['content-type'], /^text\/html/);
  }
  const game = await rawRequest(port, '/legacy-game/?mode=practice');
  assert.equal(game.status, 200);
  assert.ok(game.body.includes('src/game.js'));
  const script = await rawRequest(port, '/legacy-game/src/game.js');
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal(script.status, 200);
  assert.equal((await rawRequest(port, '/assets/art/header.webp')).headers['content-type'], 'image/webp');
  assert.equal((await rawRequest(port, '/assets/fonts/test-latin.woff2')).headers['content-type'], 'font/woff2');
  const redirect = await rawRequest(port, '/legacy-game?mode=practice');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/legacy-game/?mode=practice');
  assert.equal((await rawRequest(port, '/game/?mode=practice')).status, 200);
  assert.equal((await rawRequest(port, '/game')).status, 200);
  assert.equal((await rawRequest(port, '/legal-documents.js')).status, 200);
  const head = await rawRequest(port, '/ranked', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['x-content-type-options'], 'nosniff');
  assert.match(head.headers['content-security-policy'], /object-src 'none'/);
});

async function listen(t, server) {
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('P21-READ-01: read proxy is opt-in, exact-origin and fixed-path; credentials and nonpublic fields never propagate', async t => {
  const { root } = fixture(t);
  const build = buildWeb({ root });
  const requests = [];
  const upstream = http.createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, headers: request.headers });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'PRIVATE-COOKIE' });
    response.end(JSON.stringify([{ id: 'synthetic-only', name: 'Synthetic Player', region: 'IN', tier: 'gold', rating: 1534.25, games: 40, wealth: 100, email: 'PRIVATE-EMAIL', wallet: { coins: 100 }, passwordHash: 'PRIVATE-HASH' }]));
  });
  const upstreamPort = await listen(t, upstream);
  const disabled = await listen(t, createPreviewServer({ directory: build.output, readApiOrigin: null }));
  assert.equal((await rawRequest(disabled, '/api/v1/leaderboard')).status, 503);
  assert.equal(requests.length, 0);
  for (const origin of ['https://evil.example', READ_API_ORIGIN + '/private', 'http://play.antimatterinnovations.com']) assert.throws(() => createPreviewServer({ directory: build.output, readApiOrigin: origin }), /allowed public-read origin/);
  assert.throws(() => createPreviewServer({ directory: build.output, testReadApiOrigin: 'http://example.com' }), /loopback/);
  const enabled = await listen(t, createPreviewServer({ directory: build.output, testReadApiOrigin: 'http://127.0.0.1:' + upstreamPort }));
  const result = await rawRequest(enabled, '/api/v1/leaderboard?metric=wealth&scope=region&league=gold&region=IN', 'GET', { Cookie: 'private-session', Authorization: 'Bearer private-token', 'X-Actor-Id': 'private-actor' });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.deepEqual(JSON.parse(result.body), [{ id: 'synthetic-only', name: 'Synthetic Player', region: 'IN', tier: 'gold', rating: 1534.25, games: 40, wealth: 100 }]);
  assert.equal(requests[0].url, '/api/v1/leaderboard?metric=wealth&scope=local&league=gold&region=IN');
  assert.equal(requests[0].method, 'GET');
  for (const key of ['cookie', 'authorization', 'x-actor-id']) assert.equal(requests[0].headers[key], undefined, key);
  for (const query of ['metric=balance', 'scope=friend', 'league=diamond2', 'region=private-data', 'metric=rating&metric=wealth', 'origin=https://evil.example', 'region=' + 'A'.repeat(1100)]) assert.equal((await rawRequest(enabled, '/api/v1/leaderboard?' + query)).status, 400, query.slice(0, 80));
  assert.equal((await rawRequest(enabled, '/api/v1/leaderboard', 'POST')).status, 405);
  assert.equal((await rawRequest(enabled, '/api/v1/leaderboard', 'HEAD')).status, 405);
  for (const route of ['/api/account/session', '/api/v1/profile', '/api/v1/leaderboard/']) assert.equal((await rawRequest(enabled, route)).status, 503, route);
  assert.equal(requests.length, 1);
});

test('P21-READ-02: auth, malformed, redirect, oversized and timeout upstream replies remain bounded and sanitized', async t => {
  const { root } = fixture(t);
  const build = buildWeb({ root });
  let mode = 'auth';
  const upstream = http.createServer((request, response) => {
    if (mode === 'timeout') return;
    if (mode === 'auth') { response.writeHead(401); return response.end('PRIVATE-UPSTREAM-DETAIL'); }
    if (mode === 'redirect') { response.writeHead(302, { Location: 'https://evil.example' }); return response.end(); }
    response.setHeader('Content-Type', mode === 'html' ? 'text/html' : 'application/json');
    if (mode === 'oversize') return response.end('x'.repeat(READ_MAX_BYTES + 1));
    if (mode === 'malformed') return response.end('PRIVATE-UPSTREAM-DETAIL');
    if (mode === 'shape') return response.end(JSON.stringify({ password: 'PRIVATE-UPSTREAM-DETAIL' }));
    response.end('[]');
  });
  const upstreamPort = await listen(t, upstream);
  const port = await listen(t, createPreviewServer({ directory: build.output, testReadApiOrigin: 'http://127.0.0.1:' + upstreamPort, testReadTimeoutMs: 100 }));
  for (const [value, status, error] of [['auth', 401, 'AUTH_REQUIRED'], ['redirect', 502, 'READ_API_UNAVAILABLE'], ['html', 502, 'READ_API_UNAVAILABLE'], ['oversize', 502, 'READ_API_UNAVAILABLE'], ['malformed', 502, 'READ_API_UNAVAILABLE'], ['shape', 502, 'READ_API_UNAVAILABLE'], ['timeout', 504, 'READ_API_TIMEOUT']]) {
    mode = value;
    const result = await rawRequest(port, '/api/v1/leaderboard');
    assert.equal(result.status, status, mode);
    assert.equal(JSON.parse(result.body).error, error, mode);
    assert.ok(!result.body.includes('PRIVATE-UPSTREAM-DETAIL'), mode);
  }
});

test('P21-SERVE-02: traversal, absent assets and writes fail safely; API is explicitly unconfigured', async t => {
  const { root } = fixture(t);
  const build = buildWeb({ root });
  const server = createPreviewServer({ directory: build.output, readApiOrigin: null });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  for (const pathname of ['/../.env', '/%2e%2e/.env', '/assets/%2e%2e/%2e%2e/.env', '/game/%5c..%5c.env', '/bad%00path', '/%zz']) assert.equal((await rawRequest(port, pathname)).status, 400, pathname);
  for (const pathname of ['/assets/missing.webp', '/app-missing.js', '/legacy-game/src/authority.js', '/legacy-game/nonexistent', '/.env', '/server/credentials.json']) assert.equal((await rawRequest(port, pathname)).status, 404, pathname);
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
  for (const route of WEBSITE_ROUTES.filter(route => route !== '/')) assert.ok(config.rewrites.some(rule => rule.source === route && rule.destination === '/' + routeFile(route)), route);
  for (const name of LEGAL_NAMES) assert.ok(config.rewrites.some(rule => rule.source === '/legal/' + name && rule.destination === '/' + routeFile('/legal/' + name)), name);
  assert.ok(!config.rewrites.some(rule => rule.source.includes('/api') || rule.destination.startsWith('http')));
  assert.ok(config.redirects.some(rule => rule.source === '/legacy-game' && rule.destination === '/legacy-game/'));
  const robotsAt=source=>config.headers.find(rule=>rule.source===source)?.headers.find(header=>header.key==='X-Robots-Tag')?.value;
  /* The owner release hold REQUIRES a sitewide noindex until the SEO/release owner authorizes
   * indexing, so the blanket header is the expected state, not a defect. */
  assert.match(robotsAt('/(.*)'),/noindex/,'sitewide release-hold noindex retained');
  assert.match(robotsAt('/(.*)'),/nofollow/,'sitewide release-hold nofollow retained');
  for(const source of ['/game','/game/(.*)','/play','/legacy-game/(.*)','/account','/profile','/settings','/api/(.*)','/pages/(.*)','/legal/:name.html'])assert.match(robotsAt(source),/noindex/,source);
  for(const name of LEGAL_NAMES)assert.ok(config.headers.some(rule=>rule.source==='/legal/'+name+'.html'&&rule.headers.some(header=>header.key==='Link'&&header.value==='<https://megaxo.online/'+name+'>; rel="canonical"')),name+' retained legal canonical header');
});
