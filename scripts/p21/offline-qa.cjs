'use strict';

// Exact-artifact P21 legacy offline opt-in compatibility. The public settings/opt-in UI was removed.
// Preparation and removal below are explicit test-only fixtures, never public app actions.
// This runner never builds or contacts a live host.
// It requires an explicit bundle path, source commit, and bundle digest from the caller.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createPreviewServer } = require('./serve-web.js');
const { createOfflineWorker, OFFLINE_CACHE_PREFIX } = require('./offline-worker.cjs');

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = 'web-build.manifest.json';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const SAFE_ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const REQUIRED_NAVIGATIONS = Object.freeze({ '/game': '/pages/game.html', '/offline': '/pages/offline.html', '/how-to-play': '/pages/how-to-play.html' });
const PRIVATE_PATH = /(?:^|\/)(?:account|accounts|admin|api|auth|callback|callbacks|login|oauth|profile|profiles|private|session|sessions|settings|user|users)(?:\.html)?(?:\/|$)/i;

function fail(message) { throw new Error('P21_OFFLINE_QA_REFUSED: ' + message); }

function parseArgs(argv) {
  const options = {};
  const names = new Set(['--bundle', '--expect-source', '--expect-bundle', '--browser', '--output-root', '--transport']);
  const flags = new Set(['--diagnose-offline-bot']);
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (flags.has(name)) { options[name.slice(2)] = true; continue; }
    if (!names.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('usage: node scripts/p21/offline-qa.cjs --bundle STATIC-ARTIFACT --expect-source COMMIT --expect-bundle SHA256 [--browser chromium|firefox|webkit] [--transport browser-offline|origin-drop] [--output-root PATH] [--diagnose-offline-bot]');
    options[name.slice(2)] = argv[++i];
  }
  for (const required of ['bundle', 'expect-source', 'expect-bundle']) if (!options[required]) fail('explicit --' + required + ' is required; this runner never builds or guesses an artifact');
  options.browser ||= 'chromium';
  if (!SAFE_ENGINES.has(options.browser)) fail('--browser must be chromium, firefox, or webkit');
  options.transport ||= 'browser-offline';
  if (!['browser-offline', 'origin-drop'].includes(options.transport)) fail('--transport must be browser-offline or origin-drop');
  if (!/^[a-f\d]{40}$/i.test(options['expect-source'])) fail('--expect-source must be a full 40-character commit SHA');
  if (!/^[a-f\d]{64}$/i.test(options['expect-bundle'])) fail('--expect-bundle must be a full SHA-256 digest');
  return options;
}

function diagnosticText(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s)]+/g, '[url]').slice(0, 240);
}

function diagnosticLocalPath(value, origin) {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    return PRIVATE_PATH.test(url.pathname) ? '[private-or-api-path]' : url.pathname;
  } catch { return null; }
}

function diagnosticPathSummary(rows, origin) {
  const counts = new Map();
  for (const row of rows) {
    const localPath = diagnosticLocalPath(row.path || row.url, origin);
    if (localPath) counts.set(localPath, (counts.get(localPath) || 0) + 1);
  }
  return [...counts].map(([path, count]) => ({ path, count }));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail('cannot read JSON ' + path.basename(file) + ': ' + error.message); }
}

function within(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) fail('manifest contains an invalid relative path');
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) fail('manifest path escapes the bundle');
  return target;
}

function verifyArtifact(bundleArgument, expectedSource, expectedDigest) {
  const bundle = path.resolve(bundleArgument);
  if (!fs.existsSync(bundle) || fs.realpathSync(bundle) !== bundle || !fs.lstatSync(bundle).isDirectory()) fail('--bundle must name an existing, non-symlink static artifact directory');
  const manifest = readJson(path.join(bundle, MANIFEST));
  if (manifest.generator !== 'scripts/p21/build-web.js' || !Array.isArray(manifest.files)) fail('artifact is not a recognized P21 static build');
  if (manifest.source_commit !== expectedSource) fail('manifest source_commit does not match --expect-source');
  if (manifest.bundle_sha256 !== expectedDigest) fail('manifest bundle_sha256 does not match --expect-bundle');
  if (manifest.api?.configured !== false || manifest.api?.preview_read_seam !== 'explicit P21_READ_API_ORIGIN only; GET /api/v1/leaderboard; no credential forwarding') fail('artifact must have its public read seam explicitly disabled');
  if (!manifest.offline || !Array.isArray(manifest.offline.assets)) fail('artifact does not include its offline manifest');

  const seen = new Set();
  const bundleRows = [];
  for (const row of manifest.files) {
    if (!row || typeof row.path !== 'string' || !/^[a-f\d]{64}$/i.test(row.sha256) || !Number.isSafeInteger(row.bytes)) fail('artifact file inventory is malformed');
    if (seen.has(row.path)) fail('artifact lists a duplicate file path');
    seen.add(row.path);
    const target = within(bundle, row.path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) fail('artifact payload contains a missing or linked file: ' + row.path);
    const bytes = fs.readFileSync(target);
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) fail('artifact payload checksum mismatch: ' + row.path);
    bundleRows.push(row.path + '\0' + row.bytes + '\0' + row.sha256);
  }
  if (sha256(Buffer.from(bundleRows.join('\0'))) !== expectedDigest) fail('recomputed build manifest bundle digest does not match');

  const offline = manifest.offline;
  if (JSON.stringify(offline.navigations) !== JSON.stringify(REQUIRED_NAVIGATIONS)) fail('offline guest navigation map differs from the reviewed route contract');
  if (offline.assets.length < 1 || offline.assets.length > 160) fail('offline asset count is outside the worker contract');
  const fileByUrl = new Map(manifest.files.map(row => ['/' + row.path, row]));
  const offlinePaths = new Set();
  for (const asset of offline.assets) {
    if (!asset || typeof asset.url !== 'string' || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+$/.test(asset.url) || PRIVATE_PATH.test(asset.url)) fail('offline allowlist includes an unsafe or private path');
    if (offlinePaths.has(asset.url)) fail('offline allowlist contains a duplicate URL');
    offlinePaths.add(asset.url);
    if (fileByUrl.get(asset.url)?.sha256 !== asset.sha256) fail('offline allowlist digest does not match the packaged file: ' + asset.url);
  }
  for (const documentPath of [...Object.values(REQUIRED_NAVIGATIONS), '/pages/offline.html']) {
    if (!offline.assets.some(asset => asset.url === documentPath)) fail('required offline guest document is absent: ' + documentPath);
  }
  if (offline.private_responses !== 'network-only; never cached' || offline.registration !== 'explicit user opt-in only') fail('offline manifest boundary is missing or unexpected');

  const workerFile = manifest.files.find(row => row.path === 'offline-sw.js');
  if (!workerFile) fail('artifact is missing /offline-sw.js');
  const workerSource = fs.readFileSync(within(bundle, workerFile.path), 'utf8');
  const configMatch = workerSource.match(/const CONFIG = (\{[^\n]+\});\nconst CACHE_NAMESPACE_PREFIX/);
  if (!configMatch) fail('offline worker does not expose the expected embedded normalized CONFIG');
  let config;
  try { config = JSON.parse(configMatch[1]); } catch { fail('offline worker CONFIG is not valid JSON'); }
  if (JSON.stringify(config.assets) !== JSON.stringify(offline.assets) || JSON.stringify(config.navigations) !== JSON.stringify(offline.navigations) || config.version !== offline.version || config.fallback !== '/pages/offline.html') fail('worker CONFIG differs from the build manifest');
  const configDigest = sha256(Buffer.from(JSON.stringify(config)));
  const cacheName = `${OFFLINE_CACHE_PREFIX}${config.version}:${configDigest}:verified`;
  if (!workerSource.includes(JSON.stringify(cacheName))) fail('worker cache namespace does not match the normalized CONFIG digest');
  if (/skipWaiting\s*\(|clients\.claim\s*\(/.test(workerSource)) fail('worker contains an automatic activation takeover');

  const workerInput = workerFile.sources?.find(item => item.source === 'scripts/p21/offline-worker.cjs');
  const localWorker = path.join(ROOT, 'scripts/p21/offline-worker.cjs');
  if (!workerInput || !fs.existsSync(localWorker) || sha256(fs.readFileSync(localWorker)) !== workerInput.source_sha256) fail('local generator source differs from the exact artifact provenance');
  return { bundle, manifest, offline, config, cacheName, workerSource };
}

function copyArtifact(artifact, destination) {
  if (!fs.existsSync(destination)) fs.mkdirSync(destination, { recursive: false });
  else if (!fs.lstatSync(destination).isDirectory() || fs.realpathSync(destination) !== destination || fs.readdirSync(destination).length !== 0) fail('isolated artifact snapshot path is not an empty, unlinked directory');
  for (const row of artifact.manifest.files) {
    const source = within(artifact.bundle, row.path);
    const target = within(destination, row.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  fs.writeFileSync(path.join(destination, MANIFEST), JSON.stringify(artifact.manifest, null, 2) + '\n', { flag: 'wx' });
}

function closeHttpServer(server) {
  if (!server?.listening) return Promise.resolve();
  const closed = new Promise(resolve => server.close(resolve));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  return closed;
}

const MIME = Object.freeze({
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
});

function createProxy(upstream, artifact, events) {
  let mode = { kind: 'normal' };
  const upstreamAgent = new http.Agent({ keepAlive: false });
  const server = http.createServer((request, response) => {
    let parsed;
    try { parsed = new URL(request.url, 'http://127.0.0.1'); }
    catch { response.writeHead(400); return response.end(); }
    const pathname = parsed.pathname;
    events.server.push({ method: request.method, path: pathname });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      events.writes.push({ method: request.method, path: pathname });
      response.writeHead(405, { 'cache-control': 'no-store', allow: 'GET, HEAD' });
      return response.end('Method not allowed');
    }
    if (pathname.startsWith('/__p21_offline_qa__/')) {
      if (pathname === '/__p21_offline_qa__/foreign.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return response.end("'use strict'; self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));\n");
      }
      if (pathname === '/__p21_offline_qa__/blank.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return response.end('<!doctype html><meta charset="utf-8"><title>Local QA worker scope</title>');
      }
      response.writeHead(404, { 'cache-control': 'no-store' });
      return response.end('Not found');
    }
    if (pathname === '/offline-sw.js' && mode.workerSource) {
      response.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store', 'service-worker-allowed': '/' });
      return response.end(mode.workerSource);
    }
    if (mode.updatePath === pathname && mode.updateBytes) {
      response.writeHead(200, { 'content-type': MIME[path.extname(pathname)] || 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return response.end(mode.updateBytes);
    }
    if (mode.tamperPath === pathname) {
      response.writeHead(200, { 'content-type': MIME[path.extname(pathname)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return response.end('P21_OFFLINE_QA_TAMPER_FIXTURE');
    }
    if (mode.networkDisabled) {
      request.socket.destroy();
      return;
    }
    const upstreamRequest = http.request({ hostname: '127.0.0.1', port: upstream.address().port, method: request.method, path: request.url, headers: { host: '127.0.0.1:' + upstream.address().port }, agent: upstreamAgent }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstreamRequest.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'cache-control': 'no-store' });
      response.end('Local QA preview unavailable');
    });
    request.pipe(upstreamRequest);
  });
  return { server, upstreamAgent, setMode(next) { mode = next || { kind: 'normal' }; } };
}

function check(report, id, passed, evidence = {}) {
  const details = { ...evidence };
  if (id.startsWith('offline.')) {
    delete details.offline;
    details.transport_mode = report.transport_mode;
  }
  const result = { id, result: passed ? 'PASS' : 'FAIL', ...details };
  report.checks.push(result);
  if (!passed) report.failures.push(result);
  return passed;
}

async function expect(report, id, callback, evidence = {}) {
  try { return check(report, id, Boolean(await callback()), evidence); }
  catch (error) {
    return check(report, id, false, { ...evidence, error: String(error?.message || error).slice(0, 360) });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let playwright;
  try { playwright = require('playwright'); }
  catch { fail('Playwright is unavailable; set NODE_PATH to the installed runtime node_modules directory'); }
  let playwrightVersion = 'unknown';
  try { playwrightVersion = require('playwright/package.json').version || 'unknown'; } catch {}
  const artifact = verifyArtifact(options.bundle, options['expect-source'], options['expect-bundle']);
  const outputBase = path.resolve(options['output-root'] || path.join(ROOT, 'tests-output/p21-offline'));
  const runStamp = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
  const output = path.join(outputBase, artifact.manifest.bundle_sha256.slice(0, 12), options.browser, runStamp);
  fs.mkdirSync(output, { recursive: true });
  const report = {
    schema_version: 1,
    checked_at: new Date().toISOString(),
    source_commit: artifact.manifest.source_commit,
    bundle_sha256: artifact.manifest.bundle_sha256,
    offline_version: artifact.offline.version,
    browser_engine: options.browser,
    environment: 'Local loopback only; fresh unauthenticated contexts; API/read proxy disabled; guest-local state. Legacy prior-opt-in compatibility is seeded by an explicit test-page offline.js call; no current public opt-in UI is claimed. Fault and version fixtures are synthetic.',
    acceptance_status: 'IN_PROGRESS',
    command: process.execPath + ' scripts/p21/offline-qa.cjs --bundle <exact-artifact> --expect-source ' + options['expect-source'] + ' --expect-bundle ' + options['expect-bundle'] + ' --browser ' + options.browser + ' --transport ' + options.transport + (options['diagnose-offline-bot'] ? ' --diagnose-offline-bot' : ''),
    qa_script_sha256: sha256(fs.readFileSync(__filename)),
    playwright_version: playwrightVersion,
    browser_version: null,
    transport_mode: options.transport,
    transport_description: options.transport === 'browser-offline'
      ? 'Playwright BrowserContext offline emulation; navigator.onLine is controlled by the browser engine'
      : 'Browser remains online; loopback proxy drops origin requests to simulate failed origin transport; not navigator.onLine=false',
    ...(options['diagnose-offline-bot'] ? { diagnostic_mode: 'guest board state, bot worker events, local paths and console errors only' } : {}),
    checks: [], failures: [], screenshots: [],
    requests: { total: [], server: [], writes: [], blocked_external_origins: [] },
    evidence_boundary: 'Automation against the exact supplied static artifact. Synthetic Cache API fault injection and second-version lifecycle are simulations. No physical device, actual screenreader, provider, staging, production or release acceptance is claimed.',
  };
  const snapshot = fs.mkdtempSync(path.join(ROOT, '.artifacts', '.p21-offline-qa-'));
  let upstream, proxy, browser;
  try {
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    copyArtifact(artifact, snapshot);
    upstream = createPreviewServer({ directory: snapshot, readApiOrigin: null });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const eventStore = report.requests;
    const proxyParts = createProxy(upstream, artifact, eventStore);
    proxy = proxyParts;
    proxy.server.listen(0, '127.0.0.1');
    await once(proxy.server, 'listening');
    const origin = 'http://127.0.0.1:' + proxy.server.address().port;
    const engine = playwright[options.browser];
    browser = await engine.launch({ headless: true });
    report.browser_version = browser.version();
    const newContext = async () => {
      const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 1280, height: 900 } });
      const externalOnlyMatcher = url => !['data:', 'blob:'].includes(url.protocol) && url.origin !== origin;
      await context.route(options.transport === 'origin-drop' ? externalOnlyMatcher : '**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        if (!eventStore.blocked_external_origins.includes(url.origin)) eventStore.blocked_external_origins.push(url.origin);
        return route.abort('blockedbyclient');
      });
      return context;
    };
    const contexts = [];
    const context = await newContext();
    contexts.push(context);
    const diagnosticEvents = options['diagnose-offline-bot'] ? { requests: [], request_failures: [], workers: [], console_errors: [], page_errors: [] } : null;
    if (diagnosticEvents) {
      context.on('request', request => {
        const localPath = diagnosticLocalPath(request.url(), origin);
        if (localPath) diagnosticEvents.requests.push({ method: request.method(), resource_type: request.resourceType(), path: localPath });
      });
      context.on('requestfailed', request => {
        const localPath = diagnosticLocalPath(request.url(), origin);
        if (localPath) diagnosticEvents.request_failures.push({ method: request.method(), resource_type: request.resourceType(), path: localPath, reason: diagnosticText(request.failure()?.errorText || 'request failed') });
      });
    }
    const page = await context.newPage();
    if (diagnosticEvents) {
      page.on('worker', worker => {
        const record = { path: '', globals: null, console_errors: [], inspection_error: '' };
        try { record.path = diagnosticLocalPath(worker.url(), origin) || '[nonlocal-worker]'; }
        catch { record.path = '[unknown-worker]'; }
        diagnosticEvents.workers.push(record);
        worker.on('console', message => {
          if (message.type() === 'error') record.console_errors.push(diagnosticText(message.text()));
        });
        worker.on('close', () => { record.closed = true; });
        worker.evaluate(() => ({
          dedicated_worker: typeof document === 'undefined',
          can_import_scripts: typeof importScripts === 'function',
          game_loaded: typeof self.MegaGame === 'object',
          contract_loaded: typeof self.MegaBotContract === 'object',
          message_handler_present: typeof self.onmessage === 'function',
        })).then(globals => { record.globals = globals; }).catch(() => { record.inspection_error = 'worker closed before inspection completed'; });
      });
      page.on('console', message => {
        if (message.type() === 'error') diagnosticEvents.console_errors.push(diagnosticText(message.text()));
      });
    }
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin) eventStore.total.push({ method: request.method(), path: url.pathname });
      else if (!eventStore.blocked_external_origins.includes(url.origin)) eventStore.blocked_external_origins.push(url.origin);
    });
    page.on('pageerror', error => {
      report.failures.push({ id: 'runtime.javascript', result: 'FAIL', error: (diagnosticEvents ? diagnosticText(error.message) : error.message).slice(0, 360) });
      diagnosticEvents?.page_errors.push(diagnosticText(error.message));
    });
    const screenshot = async (targetPage, name) => {
      if (diagnosticEvents) return;
      const target = path.join(output, name + '.png');
      await targetPage.screenshot({ path: target, fullPage: true, animations: 'disabled' });
      report.screenshots.push(path.relative(ROOT, target));
    };
    const getOwnedCaches = async targetPage => targetPage.evaluate(prefix => caches.keys().then(names => names.filter(name => name.startsWith(prefix))), OFFLINE_CACHE_PREFIX);
    const getRegistrations = async targetPage => targetPage.evaluate(() => navigator.serviceWorker.getRegistrations().then(rows => rows.map(row => ({ scope: new URL(row.scope).pathname, active: row.active?.scriptURL || '', installing: row.installing?.scriptURL || '', waiting: row.waiting?.scriptURL || '' }))));
    const renderedMainHeading = async targetPage => {
      // The fallback HTML loads app.js at the original private/unknown URL. Let its initial route render settle before reading the visible heading.
      await targetPage.waitForTimeout(750);
      return targetPage.locator('main h1').first().innerText({ timeout: 1_000 }).catch(() => '');
    };

    // Preparation is a fixture for users who opted in before the public Settings page was removed.
    // The dedicated QA page is outside the product UI and is never in the cache allowlist.
    const legacyOfflineAction = async (targetPage, action) => targetPage.evaluate(async name => {
      const client = await import('/offline.js');
      const state = await client[name]();
      return {status:state.status, canRemove:state.canRemove, version:state.version || '', reloadRequired:state.reloadRequired === true, message:state.message || ''};
    }, action);
    const counter = async targetPage => targetPage.locator('[data-gb-move-total]').textContent().then(value => /^\d+$/.test((value || '').trim()) ? Number(value.trim()) : null);

    // 1. Current public pages expose neither the deleted Settings route nor offline install controls.
    for (const route of ['/', '/game']) {
      await page.goto(origin + route, {waitUntil:'networkidle'});
      await expect(report, 'fresh.no-public-offline-or-settings-controls', async () => await page.locator('[data-offline-action],a[href="/settings"]').count() === 0, {route});
    }
    const removedSettings = await page.goto(origin + '/settings', {waitUntil:'networkidle'});
    await expect(report, 'fresh.removed-settings-is-404', async () => removedSettings?.status() === 404 && await page.locator('[data-offline-action]').count() === 0, {route:'/settings', http_status:removedSettings?.status() ?? null});
    const initialRegistrations = await getRegistrations(page);
    const initialCaches = await page.evaluate(() => caches.keys());
    const workerRequestsBeforeOptIn = eventStore.total.filter(row => row.path === '/offline-sw.js').length;
    await expect(report, 'fresh.no-registration-or-cache-before-legacy-fixture', async () => initialRegistrations.length === 0 && initialCaches.length === 0 && workerRequestsBeforeOptIn === 0, {routes:['/','/game','/settings'], registrations:initialRegistrations.length, cache_count:initialCaches.length, worker_fetches:workerRequestsBeforeOptIn});
    await screenshot(page, '01-removed-settings-no-offline-controls');

    // 2. Test-only prepareOffline seeds a former user's explicit opt-in, with no automatic takeover.
    await page.goto(origin + '/__p21_offline_qa__/blank.html', {waitUntil:'networkidle'});
    const timeOriginBeforeOptIn = await page.evaluate(() => performance.timeOrigin);
    const prepared = await legacyOfflineAction(page, 'prepareOffline');
    const postInstallRegistrations = await getRegistrations(page);
    const postInstallTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const ownedAfterInstall = await getOwnedCaches(page);
    await expect(report, 'legacy-optin-fixture.prepare-reaches-ready-or-waiting-state', async () => ['ready','waiting'].includes(prepared.status) && (prepared.status !== 'waiting' || postInstallRegistrations.some(row => Boolean(row.waiting || row.installing))), {
      route:'/__p21_offline_qa__/blank.html', status:prepared.status,
      registrations:postInstallRegistrations.map(row => ({scope:row.scope,active:Boolean(row.active),installing:Boolean(row.installing),waiting:Boolean(row.waiting)})),
      verified_cache_count:ownedAfterInstall.length,
      classification:'test-only legacy opt-in fixture; no current public install or ready-message UX is claimed',
    });
    if (!['ready','waiting'].includes(prepared.status)) throw new Error('legacy offline opt-in fixture did not reach a ready/waiting result');
    await expect(report, 'legacy-optin-fixture.explicit-root-registration', async () => postInstallRegistrations.some(row => row.scope === '/' && row.active.includes('/offline-sw.js')) && ownedAfterInstall.length === 1, {route:'/__p21_offline_qa__/blank.html',fixture_status:prepared.status,registration_count:postInstallRegistrations.length,owned_cache_count:ownedAfterInstall.length});
    await expect(report, 'legacy-optin-fixture.no-auto-reload-or-takeover', async () => timeOriginBeforeOptIn === postInstallTimeOrigin && !(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))), {route:'/__p21_offline_qa__/blank.html',page_time_origin_unchanged:timeOriginBeforeOptIn === postInstallTimeOrigin,controller_before_manual_navigation:await page.evaluate(() => Boolean(navigator.serviceWorker.controller))});

    // 3. Inspect exact cached bytes and prove private/API material did not enter Cache Storage.
    const cacheAudit = await page.evaluate(async ({ cacheName, assets }) => {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      const expected = new Set(assets.map(asset => new URL(asset.url, location.origin).href));
      const actual = requests.map(request => request.url);
      const rows = [];
      for (const asset of assets) {
        const response = await cache.match(new URL(asset.url, location.origin).href);
        if (!response) { rows.push({ url: asset.url, match: false }); continue; }
        const bytes = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const actualDigest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        rows.push({ url: asset.url, match: true, digest: actualDigest });
      }
      return { actual, expected: [...expected], rows };
    }, { cacheName: ownedAfterInstall[0], assets: artifact.offline.assets });
    const exactCacheKeys = cacheAudit.actual.length === cacheAudit.expected.length && cacheAudit.actual.every(url => cacheAudit.expected.includes(url));
    const exactCacheDigests = cacheAudit.rows.every((row, index) => row.match && row.digest === artifact.offline.assets[index].sha256);
    await expect(report, 'legacy-optin-fixture.exact-static-allowlist-and-digests', async () => exactCacheKeys && exactCacheDigests, { expected_asset_count: artifact.offline.assets.length, cached_key_count: cacheAudit.actual.length, verified_asset_count: cacheAudit.rows.filter(row => row.match && row.digest === artifact.offline.assets.find(asset => asset.url === row.url)?.sha256).length });
    await expect(report, 'legacy-optin-fixture.no-private-api-auth-or-settings-cache-paths', async () => cacheAudit.actual.every(url => !PRIVATE_PATH.test(new URL(url).pathname)) && !cacheAudit.actual.some(url => new URL(url).search), { cached_key_count: cacheAudit.actual.length, private_path_matches: cacheAudit.actual.filter(url => PRIVATE_PATH.test(new URL(url).pathname)).length });

    // 4. Canonical game navigation gives the previously opted-in worker control.
    await page.goto(origin + '/game', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 10_000 });
    await expect(report, 'legacy-optin-fixture.canonical-navigation-gives-worker-control', async () => await page.evaluate(() => Boolean(navigator.serviceWorker.controller)) && (await getOwnedCaches(page)).length === 1, { route: '/game' });
    await page.goto(origin + '/game', { waitUntil: 'networkidle' });
    if (options.transport === 'origin-drop') {
      proxyParts.setMode({ networkDisabled: true });
    } else await context.setOffline(true);
    await page.waitForTimeout(250);
    await expect(report, 'offline.game-shell-available', async () => await page.locator('[data-gb-stage]').count() === 1 && await page.locator('[data-game-mode]').count() === 1, { route: '/game', offline: true });
    const themes = ['cinematic', 'vector', 'midnight', 'paperclub', 'afterhours'];
    for (const theme of themes) {
      await page.locator('[data-gb-setting="theme"]').selectOption(theme);
      await expect(report, 'offline.theme.' + theme, async () => await page.locator('[data-gb-stage]').getAttribute('data-gb-theme') === theme, { route: '/game', offline: true, theme });
    }
    await page.locator('[data-gb-setting="theme"]').selectOption('cinematic');
    await page.locator('[data-game-mode]').selectOption('bot');
    const botDiagnosticStart = diagnosticEvents ? {
      requests: diagnosticEvents.requests.length,
      request_failures: diagnosticEvents.request_failures.length,
      workers: diagnosticEvents.workers.length,
      console_errors: diagnosticEvents.console_errors.length,
      page_errors: diagnosticEvents.page_errors.length,
      server: eventStore.server.length,
    } : null;
    await page.locator('.gb-cell[aria-disabled="false"]').first().click();
    try {
      await page.waitForFunction(() => Number(document.querySelector('[data-gb-move-total]')?.textContent.trim()) >= 2, null, { timeout: 15_000 });
    } catch (error) {
      if (diagnosticEvents) {
        const botEventEnds = {
          requests: diagnosticEvents.requests.length,
          request_failures: diagnosticEvents.request_failures.length,
          server: eventStore.server.length,
        };
        const guestState = await page.evaluate(async prefix => {
          const total = document.querySelector('[data-gb-move-total]')?.textContent.trim() || '';
          const moveCount = /^\d+$/.test(total) ? Number(total) : null;
          const registrations = await navigator.serviceWorker.getRegistrations();
          const ownedCaches = (await caches.keys()).filter(name => name.startsWith(prefix));
          const rootRegistration = registrations.find(registration => new URL(registration.scope).pathname === '/');
          const stage = document.querySelector('[data-gb-stage]');
          const marks = [...document.querySelectorAll('.gb-cell .gb-mark')];
          return {
            path: location.pathname,
            online: navigator.onLine,
            document_hidden: document.hidden,
            visibility_state: document.visibilityState,
            mode: document.querySelector('[data-game-mode]')?.value || '',
            difficulty: document.querySelector('[data-gb-setting="difficulty"]')?.value || '',
            theme: stage?.getAttribute('data-gb-theme') || '',
            move_count: moveCount,
            visible_mark_count: marks.length,
            available_cell_count: document.querySelectorAll('.gb-cell[aria-disabled="false"]').length,
            turn_title: document.querySelector('.gb-turn-strip strong')?.innerText || '',
            turn_detail: document.querySelector('.gb-turn-strip p')?.innerText || '',
            recovery_prompt_visible: document.querySelector('[data-gb-action="bot-recovery"]') !== null,
            turn_note_text: `${moveCount} ${moveCount === 1 ? 'move' : 'moves'} played`,
            root_worker: rootRegistration ? {
              active: rootRegistration.active ? { state: rootRegistration.active.state, path: new URL(rootRegistration.active.scriptURL).pathname } : null,
              installing: rootRegistration.installing ? { state: rootRegistration.installing.state, path: new URL(rootRegistration.installing.scriptURL).pathname } : null,
              waiting: rootRegistration.waiting ? { state: rootRegistration.waiting.state, path: new URL(rootRegistration.waiting.scriptURL).pathname } : null,
            } : null,
            owned_cache_count: ownedCaches.length,
          };
        }, OFFLINE_CACHE_PREFIX);
        const workerAssetProbe = await page.evaluate(async assetPath => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2_000);
          try {
            const response = await fetch(assetPath, { signal: controller.signal, credentials: 'omit' });
            return {
              controller_path: navigator.serviceWorker.controller ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : '',
              status: response.status,
              content_type: response.headers.get('content-type') || '',
            };
          } catch (probeError) {
            return {
              controller_path: navigator.serviceWorker.controller ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : '',
              error_name: probeError?.name || 'Error',
            };
          } finally { clearTimeout(timer); }
        }, '/legacy-game/src/bot/worker.js');
        let offlineNavigationProbe;
        try {
          const response = await page.goto(origin + '/offline', { waitUntil: 'domcontentloaded', timeout: 5_000 });
          offlineNavigationProbe = {
            status: response?.status() ?? null,
            path: diagnosticLocalPath(page.url(), origin),
            heading: diagnosticText(await page.locator('main h1').first().innerText({ timeout: 1_000 }).catch(() => '')),
            controller_path: await page.evaluate(() => navigator.serviceWorker.controller ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : ''),
          };
        } catch (probeError) {
          offlineNavigationProbe = { error: diagnosticText(probeError?.message || probeError) };
        }
        const first = botDiagnosticStart;
        report.offline_bot_diagnostic = {
          capture: 'timeout at offline bot second move; guest-visible state and worker/network diagnostics only',
          guest_state: guestState,
          worker_events: diagnosticEvents.workers.slice(first.workers).map(row => ({ path: row.path, globals: row.globals, closed: Boolean(row.closed), inspection_error: row.inspection_error || '', console_errors: row.console_errors })),
          requested_local_paths: diagnosticPathSummary(diagnosticEvents.requests.slice(first.requests, botEventEnds.requests), origin),
          local_request_failures: diagnosticEvents.request_failures.slice(first.request_failures, botEventEnds.request_failures).map(row => ({ ...row, path: diagnosticLocalPath(row.path, origin) })),
          server_requested_local_paths: diagnosticPathSummary(eventStore.server.slice(first.server, botEventEnds.server), origin),
          offline_page_fetch_of_cached_worker_asset: workerAssetProbe,
          offline_guest_navigation_probe: offlineNavigationProbe,
          console_errors: diagnosticEvents.console_errors.slice(first.console_errors),
          page_errors: diagnosticEvents.page_errors.slice(first.page_errors),
          timeout: diagnosticText(error?.message || error),
        };
      }
      throw error;
    }
    if (diagnosticEvents) {
      const guestState = await page.evaluate(async prefix => {
        const total = document.querySelector('[data-gb-move-total]')?.textContent.trim() || '';
        const moveCount = /^\d+$/.test(total) ? Number(total) : null;
        const registrations = await navigator.serviceWorker.getRegistrations();
        const rootRegistration = registrations.find(registration => new URL(registration.scope).pathname === '/');
        const marks = [...document.querySelectorAll('.gb-cell .gb-mark')];
        return {
          path: location.pathname,
          online: navigator.onLine,
          document_hidden: document.hidden,
          visibility_state: document.visibilityState,
          mode: document.querySelector('[data-game-mode]')?.value || '',
          difficulty: document.querySelector('[data-gb-setting="difficulty"]')?.value || '',
          theme: document.querySelector('[data-gb-stage]')?.getAttribute('data-gb-theme') || '',
          move_count: moveCount,
          visible_mark_count: marks.length,
          turn_title: document.querySelector('.gb-turn-strip strong')?.innerText || '',
          recovery_prompt_visible: document.querySelector('[data-gb-action="bot-recovery"]') !== null,
          turn_note_text: `${moveCount} ${moveCount === 1 ? 'move' : 'moves'} played`,
          root_worker: rootRegistration?.active ? { state: rootRegistration.active.state, path: new URL(rootRegistration.active.scriptURL).pathname } : null,
          owned_cache_count: (await caches.keys()).filter(name => name.startsWith(prefix)).length,
        };
      }, OFFLINE_CACHE_PREFIX);
      const first = botDiagnosticStart;
      report.offline_bot_diagnostic = {
        capture: 'offline bot second move completed; guest-visible state and worker/network diagnostics only',
        guest_state: guestState,
        worker_events: diagnosticEvents.workers.slice(first.workers).map(row => ({ path: row.path, globals: row.globals, closed: Boolean(row.closed), console_errors: row.console_errors })),
        requested_local_paths: diagnosticPathSummary(diagnosticEvents.requests.slice(first.requests), origin),
        local_request_failures: diagnosticEvents.request_failures.slice(first.request_failures).map(row => ({ ...row, path: diagnosticLocalPath(row.path, origin) })),
        server_requested_local_paths: diagnosticPathSummary(eventStore.server.slice(first.server), origin),
        console_errors: diagnosticEvents.console_errors.slice(first.console_errors),
        page_errors: diagnosticEvents.page_errors.slice(first.page_errors),
      };
    }
    await expect(report, 'offline.bot-turn-completes', async () => (await counter(page)) >= 2, { route: '/game', offline: true, expected_local_moves_minimum: 2 });
    await page.locator('[data-gb-action="fresh"]').click();
    await page.locator('[data-game-mode]').selectOption('local');
    await page.locator('.gb-cell[aria-disabled="false"]').first().click();
    await page.locator('.gb-cell[aria-disabled="false"]').first().click();
    const localMoveCount = (await counter(page));
    const localMarksBeforeReload = await page.locator('.gb-cell').evaluateAll(cells => cells.filter(cell => cell.querySelector('.gb-mark')).length);
    await expect(report, 'offline.two-player-same-screen', async () => localMoveCount === 2 && localMarksBeforeReload === 2, { route: '/game', offline: true, local_move_count: localMoveCount, visible_marks: localMarksBeforeReload });
    await page.setViewportSize({ width: 1280, height: 900 });
    const viewportChecks = [];
    for (const viewport of [{ width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 700 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const measure = await page.evaluate(() => ({ width: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, marks: document.querySelectorAll('.gb-cell .gb-mark').length }));
      viewportChecks.push({ viewport, ...measure });
    }
    await expect(report, 'offline.responsive-reflow-preserves-board-without-horizontal-overflow', async () => viewportChecks.every(row => row.marks === 2 && row.client <= row.width && row.scroll <= row.client), { route: '/game', offline: true, viewports: viewportChecks });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Mode selection can leave a query URL; only the canonical navigation is cached.
    await page.goto(origin + '/game', {waitUntil:'domcontentloaded'});
    await page.locator('.gb-help-panel:not([open]) > summary').click();
    await page.locator('[data-gb-action="start-guided"]').click();
    await page.locator('[data-gb-guided="continue"]').click();
    const tutorialMoves = [];
    // Complete one X/O pair, navigate to the canonical cached route, and resume that saved tutorial point.
    await page.locator('.gb-cell--guided-target').click();
    tutorialMoves.push(await counter(page));
    await page.locator('[data-gb-guided="continue"]').click();
    await page.waitForFunction(() => document.querySelector('.gb-guided-progress')?.textContent.includes('Guided move 2 / 6'));
    await page.goto(origin + '/game', {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.querySelector('.gb-guided-progress')?.textContent.includes('Guided move 2 / 6'));
    const resumed = await page.evaluate(() => ({ progress: document.querySelector('.gb-guided-progress')?.innerText || '', moves: document.querySelectorAll('.gb-cell .gb-mark').length }));
    await expect(report, 'offline.guided-tutorial-resumes-after-canonical-navigation', async () => resumed.progress.toLowerCase().includes('guided move 2 / 6') && resumed.moves === 2, { route: '/game', offline: true, progress: resumed.progress, visible_moves: resumed.moves });
    for (let actions = 0; actions < 16 && await page.locator('.gb-guided-panel').count(); actions++) {
      const phase = await page.locator('.gb-guided-panel').getAttribute('data-gb-guided-phase');
      if (phase === 'AWAIT_MOVE') {
        const target = page.locator('.gb-cell--guided-target');
        const cell = await target.getAttribute('data-gb-cell');
        if (!cell) break;
        tutorialMoves.push(cell);
        await target.click();
      } else if (phase === 'PROMPT' || phase === 'AWAIT_CONTINUE') {
        await page.locator('[data-gb-guided="continue"]').click();
      } else break;
    }
    const guidedState = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('mega_v51_practice_save') || 'null');
      return { moves: saved?.state?.moves?.length || 0, lessonPhase: saved?.lesson?.phase || '', progress: document.querySelector('.gb-guided-progress')?.innerText || '' };
    });
    await expect(report, 'offline.guided-tutorial-six-moves-and-resume-save', async () => tutorialMoves.length >= 3 && guidedState.moves === 6 && guidedState.lessonPhase === 'DONE', { route: '/game', offline: true, guided_player_moves_after_resume: tutorialMoves.length, persisted_total_moves: guidedState.moves, lesson_phase: guidedState.lessonPhase, progress: guidedState.progress });
    await screenshot(page, '03-game-guided-complete-offline');

    // 5. Keep private/API paths honest and make sure no network write was sent.
    const offlinePrivate = await page.goto(origin + '/account', { waitUntil: 'domcontentloaded' });
    const privateBody = await page.locator('body').innerText().catch(() => '');
    const privateHeading = await renderedMainHeading(page);
    await expect(report, 'offline.private-route-fallback-survives-app-hydration', async () => offlinePrivate?.status() === 503 && privateHeading.trim() === 'Take the next move offline.' && !privateBody.includes('PRIVATE-SENTINEL'), { route: '/account', offline: true, http_status: offlinePrivate?.status() ?? null, rendered_heading_after_hydration: privateHeading, expected_heading: 'Take the next move offline.', private_sentinel_visible: privateBody.includes('PRIVATE-SENTINEL') });
    const unknownRoute = await page.goto(origin + '/__p21_offline_unknown_route__', { waitUntil: 'domcontentloaded' });
    const unknownHeading = await renderedMainHeading(page);
    await expect(report, 'offline.unknown-route-fallback-survives-app-hydration', async () => unknownRoute?.status() === 503 && unknownHeading.trim() === 'Take the next move offline.', { route: '/__p21_offline_unknown_route__', offline: true, http_status: unknownRoute?.status() ?? null, rendered_heading_after_hydration: unknownHeading, expected_heading: 'Take the next move offline.' });
    await page.goto(origin + '/game', { waitUntil: 'domcontentloaded' });
    const apiOutcome = await page.evaluate(async () => { try { const response = await fetch('/api/v1/profile?qa=1'); return { resolved: true, status: response.status }; } catch { return { resolved: false }; } });
    await expect(report, 'offline.api-remains-network-only', async () => apiOutcome.resolved === false, { route: '/api/v1/profile', offline: true, response_obtained: apiOutcome.resolved, status: apiOutcome.status ?? null });
    const queryRoute = await page.goto(origin + '/game?offline-qa=route', { waitUntil: 'domcontentloaded' });
    const queryHeading = await renderedMainHeading(page);
    await expect(report, 'offline.query-bearing-navigation-bypasses-cache', async () => queryRoute?.status() === 503 && queryHeading === 'Take the next move offline.', { route: '/game?offline-qa=route', offline: true, http_status: queryRoute?.status() ?? null, rendered_heading_after_hydration: queryHeading, expected_heading: 'Take the next move offline.' });
    const postPrivateKeys = await page.evaluate(async ({ cacheName, assets }) => (await (await caches.open(cacheName)).keys()).map(request => request.url).map(url => ({ url, allowed: assets.some(asset => new URL(asset.url, location.origin).href === url) })), { cacheName: ownedAfterInstall[0], assets: artifact.offline.assets });
    await expect(report, 'offline.private-and-query-requests-do-not-add-cache-entries', async () => postPrivateKeys.length === artifact.offline.assets.length && postPrivateKeys.every(row => row.allowed), { cached_key_count_after_private_queries: postPrivateKeys.length, expected_asset_count: artifact.offline.assets.length, private_path_cache_keys: postPrivateKeys.filter(row => PRIVATE_PATH.test(new URL(row.url).pathname)).length });
    await context.setOffline(false);
    if (options.transport === 'origin-drop') proxyParts.setMode({ kind: 'normal' });
    await page.goto(origin + '/how-to-play', { waitUntil: 'networkidle' });
    await expect(report, 'online.guide-restores-from-listed-document', async () => await page.locator('body').innerText().then(text => text.includes('Think one board ahead') || text.includes('How to play')), { route: '/how-to-play', offline: false });
    await expect(report, 'network.no-write-requests', async () => eventStore.writes.length === 0, { write_count: eventStore.writes.length, writes: eventStore.writes });
    await expect(report, 'network.no-external-origins', async () => eventStore.blocked_external_origins.length === 0, { blocked_external_origin_count: eventStore.blocked_external_origins.length });

    // 6. Legacy compatibility removal calls the retained module and deletes only its own state.
    const sentinel = 'p21-offline-qa-unrelated';
    await page.evaluate(async sentinelName => { const cache = await caches.open(sentinelName); await cache.put('/sentinel.txt', new Response('keep')); }, sentinel);
    await page.evaluate(async () => {
      window.__p21OfflineQAForeignRegistration = await navigator.serviceWorker.register('/__p21_offline_qa__/foreign.js', { scope: '/__p21_offline_qa__/' });
    });
    await page.waitForFunction(() => window.__p21OfflineQAForeignRegistration?.active?.state === 'activated', null, { timeout: 10_000 });
    await page.goto(origin + '/__p21_offline_qa__/blank.html', {waitUntil:'networkidle'});
    const removal = await legacyOfflineAction(page, 'removeOffline');
    const cleanup = await page.evaluate(async sentinelName => ({ caches: await caches.keys(), registrations: (await navigator.serviceWorker.getRegistrations()).map(registration => new URL(registration.scope).pathname) }), sentinel);
    await expect(report, 'legacy-optin-fixture.remove-only-owned-worker-and-cache', async () => removal.status === 'absent' && !cleanup.caches.some(name => name.startsWith(OFFLINE_CACHE_PREFIX)) && cleanup.caches.includes(sentinel) && !cleanup.registrations.includes('/') && cleanup.registrations.includes('/__p21_offline_qa__/'), { route: '/__p21_offline_qa__/blank.html', fixture_status:removal.status, unrelated_cache_preserved: cleanup.caches.includes(sentinel), unrelated_worker_preserved: cleanup.registrations.includes('/__p21_offline_qa__/'), owned_cache_remaining: cleanup.caches.filter(name => name.startsWith(OFFLINE_CACHE_PREFIX)).length, root_registration_remaining: cleanup.registrations.includes('/') });
    await screenshot(page, '04-legacy-fixture-after-owned-removal');

    // 7. A real browser context is used, while faults themselves are explicit synthetic injections.
    const runFault = async (faultName, injection) => {
      const faultContext = await newContext(); contexts.push(faultContext);
      const faultPage = await faultContext.newPage();
      const original = artifact.workerSource;
      proxyParts.setMode({ workerSource: injection(original) });
      const oldName = `${OFFLINE_CACHE_PREFIX}previous-fixture:abc:verified`;
      await faultPage.goto(origin + '/__p21_offline_qa__/blank.html', {waitUntil:'networkidle'});
      await faultPage.evaluate(async ({ sentinel, old }) => {
        const unrelated = await caches.open(sentinel);
        await unrelated.put('/sentinel.txt', new Response('keep'));
        await caches.open(old);
      }, { sentinel: 'p21-offline-qa-unrelated-' + faultName, old: oldName });
      const failedPrepare = await legacyOfflineAction(faultPage, 'prepareOffline');
      const errorStatus = failedPrepare.message;
      const owned = await getOwnedCaches(faultPage);
      const cacheNames = await faultPage.evaluate(() => caches.keys());
      const faultRegistrations = await getRegistrations(faultPage);
      await expect(report, 'fault.' + faultName + '.fails-closed-and-cleans-candidate', async () => owned.length === 1 && owned[0] === oldName && failedPrepare.status === 'unavailable' && cacheNames.includes('p21-offline-qa-unrelated-' + faultName) && /could not|failed|unavailable|blocked|storage|integrity/i.test(errorStatus), { route: '/__p21_offline_qa__/blank.html', fixture_status:failedPrepare.status, fault_fixture: faultName, status: errorStatus, registrations: faultRegistrations.map(row => ({ scope: row.scope, active: Boolean(row.active), installing: Boolean(row.installing), waiting: Boolean(row.waiting) })), worker_fetches: eventStore.server.filter(row => row.path === '/offline-sw.js').length, previous_feature_cache_preserved: owned.includes(oldName), unrelated_cache_preserved: cacheNames.includes('p21-offline-qa-unrelated-' + faultName), feature_cache_names: owned, classification: 'synthetic fault injection; not actual browser storage/quota proof' });
      await faultContext.close();
      proxyParts.setMode({ kind: 'normal' });
    };
    const openPrefix = `const __qaOpen = caches.open.bind(caches); caches.open = async name => { if (String(name).startsWith(${JSON.stringify(OFFLINE_CACHE_PREFIX)})) throw new DOMException('QA storage blocked', 'SecurityError'); return __qaOpen(name); };\n`;
    await runFault('cache-open-blocked', source => source.replace("'use strict';", "'use strict';\n" + openPrefix));
    const putPrefix = `const __qaPut = Cache.prototype.put; Cache.prototype.put = async function(...args) { throw new DOMException('QA quota fixture', 'QuotaExceededError'); };\n`;
    await runFault('cache-put-quota-simulation', source => source.replace("'use strict';", "'use strict';\n" + putPrefix));

    const tamperContext = await newContext(); contexts.push(tamperContext);
    const tamperPage = await tamperContext.newPage();
    const tamperPath = artifact.offline.assets.find(asset => asset.url.startsWith('/assets/art/') && asset.url.endsWith('.webp') && !['/assets/art/header.webp', '/assets/art/mark.webp'].includes(asset.url))?.url
      || artifact.offline.assets.find(asset => asset.url.endsWith('.ico'))?.url
      || artifact.offline.assets.find(asset => asset.url.endsWith('.png'))?.url;
    if (!tamperPath) fail('no non-HTML declared static asset available for the integrity fixture');
    proxyParts.setMode({ tamperPath });
    const oldTamperName = `${OFFLINE_CACHE_PREFIX}previous-tamper-fixture:abc:verified`;
    await tamperPage.goto(origin + '/__p21_offline_qa__/blank.html', {waitUntil:'networkidle'});
    await tamperPage.evaluate(async oldName => { await caches.open(oldName); await caches.open('p21-offline-qa-tamper-unrelated'); }, oldTamperName);
    const tamperPrepare = await legacyOfflineAction(tamperPage, 'prepareOffline');
    const tamperStatus = tamperPrepare.message;
    const tamperOwned = await getOwnedCaches(tamperPage);
    const tamperCacheNames = await tamperPage.evaluate(() => caches.keys());
    const tamperRegistrations = await getRegistrations(tamperPage);
    await expect(report, 'fault.tampered-static-digest-fails-closed', async () => tamperOwned.length === 1 && tamperOwned[0] === oldTamperName && tamperPrepare.status === 'unavailable' && tamperCacheNames.includes('p21-offline-qa-tamper-unrelated') && /failed|could not|unavailable|integrity/i.test(tamperStatus), { route: '/__p21_offline_qa__/blank.html', fixture_status:tamperPrepare.status, tampered_path: tamperPath, status: tamperStatus, registrations: tamperRegistrations.map(row => ({ scope: row.scope, active: Boolean(row.active), installing: Boolean(row.installing), waiting: Boolean(row.waiting) })), previous_feature_cache_preserved: tamperOwned.includes(oldTamperName), unrelated_cache_preserved: tamperCacheNames.includes('p21-offline-qa-tamper-unrelated'), feature_cache_names: tamperOwned, classification: 'synthetic modified response; integrity path checked in local browser' });
    await tamperContext.close();
    proxyParts.setMode({ kind: 'normal' });

    // 8. Synthetic second version verifies normal waiting/activation boundaries only.
    const updateContext = await newContext(); contexts.push(updateContext);
    let updatePage = await updateContext.newPage();
    await updatePage.goto(origin + '/__p21_offline_qa__/blank.html', {waitUntil:'networkidle'});
    const updatePrepared = await legacyOfflineAction(updatePage, 'prepareOffline');
    await expect(report, 'legacy-optin-fixture.update-prerequisite', async () => updatePrepared.status === 'ready', {fixture_status:updatePrepared.status});
    if (updatePrepared.status !== 'ready') throw new Error('legacy offline update fixture could not be prepared');
    await updatePage.reload({ waitUntil: 'networkidle' });
    await updatePage.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const oldOfflineAsset = artifact.offline.assets.find(asset => asset.url === '/pages/offline.html');
    const oldOfflineBytes = fs.readFileSync(within(snapshot, 'pages/offline.html'));
    const markedBytes = Buffer.from(oldOfflineBytes.toString('utf8').replace('</body>', '<p data-qa-version="synthetic-next">Synthetic next worker version</p></body>'));
    if (markedBytes.equals(oldOfflineBytes)) fail('offline guest page lacks the closing body marker for a lifecycle fixture');
    const nextConfig = JSON.parse(JSON.stringify(artifact.config));
    nextConfig.version = artifact.config.version + '-qa-next';
    const nextAsset = nextConfig.assets.find(asset => asset.url === oldOfflineAsset.url);
    nextAsset.sha256 = sha256(markedBytes);
    const nextWorker = createOfflineWorker(nextConfig);
    proxyParts.setMode({ workerSource: nextWorker, updatePath: oldOfflineAsset.url, updateBytes: markedBytes });
    await updatePage.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      window.__offlineQARegistration = registration;
      window.__offlineQAUpdateTrace = [{ event: 'before-update', active: registration?.active?.state || '', installing: registration?.installing?.state || '', waiting: registration?.waiting?.state || '' }];
      const watch = worker => {
        if (!worker) return;
        const record = () => window.__offlineQAUpdateTrace.push({ event: 'worker-state', state: worker.state });
        record();
        worker.addEventListener('statechange', record);
      };
      registration?.addEventListener('updatefound', () => {
        window.__offlineQAUpdateTrace.push({ event: 'updatefound' });
        watch(registration.installing);
      });
      await registration.update();
      window.__offlineQAUpdateTrace.push({ event: 'update-resolved', active: registration?.active?.state || '', installing: registration?.installing?.state || '', waiting: registration?.waiting?.state || '' });
    });
    // waitForFunction must receive a synchronous predicate; a returned Promise is itself truthy and can end the poll before install completes.
    await updatePage.waitForFunction(() => Boolean(window.__offlineQARegistration?.waiting), null, { timeout: 20_000 });
    const waitingState = await updatePage.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const names = await caches.keys();
      const oldPage = await (await fetch('/offline')).text();
      window.__offlineQAUpdateTrace.push({ event: 'waiting-observed', active: registration?.active?.state || '', installing: registration?.installing?.state || '', waiting: registration?.waiting?.state || '' });
      return { waiting: Boolean(registration?.waiting), activeState: registration?.active?.state || '', installingState: registration?.installing?.state || '', waitingState: registration?.waiting?.state || '', names, oldPageHasMarker: oldPage.includes('Synthetic next worker version'), trace: window.__offlineQAUpdateTrace };
    });
    await expect(report, 'update.old-client-remains-on-old-worker-until-closed', async () => waitingState.waiting && waitingState.activeState === 'activated' && waitingState.installingState === '' && waitingState.waitingState === 'installed' && waitingState.names.some(name => name.includes(':' + artifact.config.version + ':')) && waitingState.names.some(name => name.includes(':' + nextConfig.version + ':')) && !waitingState.oldPageHasMarker, { route: '/offline', update_fixture: 'synthetic second worker version', waiting: waitingState.waiting, active_state: waitingState.activeState, installing_state: waitingState.installingState, waiting_state: waitingState.waitingState, old_client_served_original_document: !waitingState.oldPageHasMarker, cache_count_before_activation: waitingState.names.length, worker_state_trace: waitingState.trace });
    await updatePage.close();
    updatePage = await updateContext.newPage();
    await updateContext.setOffline(false);
    await updatePage.goto(origin + '/', { waitUntil: 'networkidle' });
    const activationDeadline = Date.now() + 20_000;
    const activationTrace = [];
    let activationState = null;
    do {
      activationState = await updatePage.evaluate(async ({ nextVersion, oldVersion }) => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const names = await caches.keys();
        return { activeState: registration?.active?.state || '', installingState: registration?.installing?.state || '', waiting: Boolean(registration?.waiting), hasNextCache: names.some(name => name.includes(':' + nextVersion + ':')), hasOldCache: names.some(name => name.includes(':' + oldVersion + ':')) };
      }, { nextVersion: nextConfig.version, oldVersion: artifact.config.version });
      const marker = JSON.stringify(activationState);
      if (activationTrace.length === 0 || JSON.stringify(activationTrace[activationTrace.length - 1]) !== marker) activationTrace.push(activationState);
      if (activationState.activeState === 'activated' && activationState.installingState === '' && !activationState.waiting && activationState.hasNextCache && !activationState.hasOldCache) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < activationDeadline);
    await updatePage.reload({ waitUntil: 'networkidle' });
    const newOfflineResponse = await updatePage.goto(origin + '/offline', { waitUntil: 'networkidle' });
    const updateResult = await updatePage.evaluate(async () => ({ marker: document.querySelector('[data-qa-version="synthetic-next"]')?.textContent || '', names: await caches.keys(), registration: await navigator.serviceWorker.getRegistration('/') }));
    await expect(report, 'update.synthetic-new-version-after-old-client-closes', async () => activationState.activeState === 'activated' && activationState.installingState === '' && !activationState.waiting && activationState.hasNextCache && !activationState.hasOldCache && newOfflineResponse?.status() === 200 && updateResult.marker.includes('Synthetic next worker version') && updateResult.names.filter(name => name.startsWith(OFFLINE_CACHE_PREFIX)).length === 1 && !updateResult.names.some(name => name.includes(':' + artifact.config.version + ':')), { route: '/offline', update_fixture: 'synthetic second worker version; not separate release compatibility', http_status: newOfflineResponse?.status() ?? null, marker_visible: updateResult.marker.length > 0, active_state: activationState.activeState, installing_state: activationState.installingState, waiting: activationState.waiting, old_cache_removed: !activationState.hasOldCache, feature_cache_count: updateResult.names.filter(name => name.startsWith(OFFLINE_CACHE_PREFIX)).length, activation_trace: activationTrace });
    await screenshot(updatePage, '05-synthetic-update-offline-page');

    report.acceptance_status = report.failures.length ? 'FAIL' : 'PASS_AUTOMATED_LOCAL_ONLY';
  } catch (error) {
    report.acceptance_status = 'FAIL_OR_INCOMPLETE';
    report.fatal_error = String(error?.stack || error).slice(0, 1800);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await closeHttpServer(proxy?.server);
    proxy?.upstreamAgent?.destroy();
    await closeHttpServer(upstream);
    fs.rmSync(snapshot, { recursive: true, force: true });
    report.completed_at = new Date().toISOString();
    report.report_directory = path.relative(ROOT, output);
    const target = path.join(output, 'offline-qa.json');
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ acceptance_status: report.acceptance_status, source_commit: report.source_commit, bundle_sha256: report.bundle_sha256, checks: report.checks.length, failures: report.failures.length, report: path.relative(ROOT, target) }, null, 2) + '\n');
  }
  if (report.acceptance_status !== 'PASS_AUTOMATED_LOCAL_ONLY') process.exitCode = 1;
}

if (require.main === module) main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });

module.exports = { parseArgs, verifyArtifact };
