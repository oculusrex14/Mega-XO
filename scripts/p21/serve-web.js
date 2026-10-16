'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { ROOT, GENERATOR, MANIFEST } = require('./build-web.js');
const {createDownloadHandler} = require('../../apps/web/download-config.cjs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest':'application/manifest+json; charset=utf-8', '.ico':'image/x-icon', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.xml':'application/xml; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self' https://unpkg.com https://sdk.cashfree.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://api.cashfree.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://payments.cashfree.com https://sandbox.cashfree.com";
const READ_API_ORIGIN = 'https://megaxo.online';
const LEAGUES = new Set(['all', 'wood', 'stone', 'iron', 'bronze', 'silver', 'gold', 'diamond', 'emerald', 'champion', 'master', 'grandmaster']);
const READ_MAX_BYTES = 262144;
const READ_TIMEOUT_MS = 5000;

function configuredReadOrigin(options) {
  // Test injection is programmatic and loopback-only. CLI/request parameters
  // cannot choose a proxy destination or turn this into a general proxy.
  if (options.testReadApiOrigin) {
    const url = new URL(options.testReadApiOrigin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('P21_SERVE_REFUSED: test read origin must be loopback');
    return url.origin;
  }
  const value = Object.hasOwn(options, 'readApiOrigin') ? options.readApiOrigin : process.env.P21_READ_API_ORIGIN;
  if (!value) return null;
  if (value !== READ_API_ORIGIN) throw new Error('P21_SERVE_REFUSED: P21_READ_API_ORIGIN is not the allowed public-read origin');
  return value;
}

function readQuery(raw) {
  if (raw.length > 1024) throw new Error('invalid filters');
  const input = new URL(raw, 'http://127.0.0.1').searchParams;
  const values = {};
  for (const [key, value] of input) {
    if (!['metric', 'scope', 'league', 'region'].includes(key) || Object.hasOwn(values, key)) throw new Error('invalid filters');
    values[key] = value;
  }
  if (values.metric && !['rating', 'wealth'].includes(values.metric)) throw new Error('invalid metric');
  if (values.scope && !['global', 'local', 'region'].includes(values.scope)) throw new Error('invalid scope');
  if (values.league && !LEAGUES.has(values.league)) throw new Error('invalid league');
  if (values.region && !/^[A-Z]{2}$/.test(values.region)) throw new Error('invalid region');
  if (values.scope === 'region') values.scope = 'local';
  return new URLSearchParams(Object.entries(values)).toString();
}

function publicRows(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('invalid read response');
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid read response');
    const clean = {};
    for (const key of ['id', 'name', 'region', 'tier']) {
      if (row[key] === undefined) continue;
      if (typeof row[key] !== 'string' || row[key].length > (key === 'id' ? 128 : 80)) throw new Error('invalid read response');
      clean[key] = row[key];
    }
    if (clean.tier && !LEAGUES.has(clean.tier)) throw new Error('invalid read response');
    for (const key of ['rating', 'games', 'wealth']) {
      if (row[key] === undefined) continue;
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > Number.MAX_SAFE_INTEGER) throw new Error('invalid read response');
      clean[key] = row[key];
    }
    return clean;
  });
}

async function fetchPublicLeaderboard(origin, query, timeoutMs = READ_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    const upstream = await fetch(origin + '/api/v1/leaderboard' + (query ? '?' + query : ''), {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      if ([401, 403].includes(upstream.status)) return { status: 401, body: { error: 'AUTH_REQUIRED', message: 'The existing service requires sign-in for this leaderboard. No credentials were forwarded.' } };
      return { status: 502, body: { error: 'READ_API_UNAVAILABLE', message: 'The leaderboard service is unavailable.' } };
    }
    if (!/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type') || '') || Number(upstream.headers.get('content-length')) > READ_MAX_BYTES) {
      await upstream.body?.cancel();
      throw new Error('invalid read response');
    }
    const reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > READ_MAX_BYTES) { await reader.cancel(); throw new Error('invalid read response'); }
      chunks.push(Buffer.from(value));
    }
    return { status: 200, body: publicRows(JSON.parse(Buffer.concat(chunks).toString('utf8'))) };
  } catch {
    return controller.signal.aborted
      ? { status: 504, body: { error: 'READ_API_TIMEOUT', message: 'The leaderboard service did not respond in time.' } }
      : { status: 502, body: { error: 'READ_API_UNAVAILABLE', message: 'The leaderboard service is unavailable.' } };
  } finally { clearTimeout(timeout); }
}

function requestPath(raw) {
  if (!raw || !raw.startsWith('/')) throw new Error('invalid path');
  const encoded = raw.split('?')[0];
  const decoded = decodeURIComponent(encoded);
  if (/[\\\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('unsafe path');
  return decoded;
}

/**
 * Resolves a request path against a built P21 artifact to a file + status, WITHOUT ever serving
 * HTML for a missing sub-resource. The website keeps its own visual 404 page for page routes, but
 * a missing asset, script, stylesheet, font, worker or legal document is a REAL 404 - never an SPA
 * fallback - so a broken bundle is visible instead of silently masked.
 *
 * @returns {{status:number, file:(string|null), text:(string|null)}} `file` is an artifact-relative
 *   path to stream (the caller MUST verify it exists and stays inside the artifact root); `text` is
 *   a literal body when the response is not a file.
 */
function resolveStatic(artifact, pathname) {
  const files = artifact.files;
  const route = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  let relative = route === '/legacy-game' ? 'legacy-game/index.html' : (artifact.routes[route] || pathname.replace(/^\//, ''));
  let status = route === '/404' ? 404 : 200;
  if (!files.has(relative)) {
    if (pathname.startsWith('/legacy-game/') || pathname.startsWith('/game/') || pathname.startsWith('/assets/') || pathname.startsWith('/legal/') || (path.extname(pathname) && !pathname.startsWith('/pages/'))) {
      return { status: 404, file: null, text: 'Not found' };
    }
    // The website owns its visual 404. Missing resources never receive HTML.
    relative = '404.html';
    status = 404;
  }
  return { status, file: relative, text: files.has(relative) ? null : 'Not found' };
}

function createPreviewServer(options = {}) {
  const directory = path.resolve(options.directory || path.join(ROOT, '.artifacts/p21-web'));
  if (fs.realpathSync(directory) !== directory) throw new Error('P21_SERVE_REFUSED: root must be unlinked');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), 'utf8'));
  if (manifest.generator !== GENERATOR || !Array.isArray(manifest.files)) throw new Error('P21_SERVE_REFUSED: expected a built P21 static artifact');
  const files = new Set([MANIFEST, ...manifest.files.map(file => file.path)]);
  const readOrigin = configuredReadOrigin(options);
  const downloadHandler=createDownloadHandler({links:options.storeLinks||manifest.store_links});
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Cache-Control', 'no-cache');
    const send = (status, content, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(content) });
      response.end(request.method === 'HEAD' ? undefined : content);
    };
    let pathname;
    try { pathname = requestPath(request.url); }
    catch { return send(400, 'Invalid request path'); }
    if(pathname==='/api/download')return downloadHandler(request,response);
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return send(405, 'Method not allowed'); }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      response.setHeader('Cache-Control', 'no-store');
      if (pathname !== '/api/v1/leaderboard' || !readOrigin) return send(503, JSON.stringify({ error: 'WEB_API_NOT_CONFIGURED', message: 'This preview has no configured account or game service.' }), MIME['.json']);
      if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); return send(405, JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), MIME['.json']); }
      let query;
      try { query = readQuery(request.url); }
      catch { return send(400, JSON.stringify({ error: 'INVALID_FILTER', message: 'Use the supported leaderboard filters.' }), MIME['.json']); }
      const result = await fetchPublicLeaderboard(readOrigin, query, options.testReadTimeoutMs || READ_TIMEOUT_MS);
      return send(result.status, JSON.stringify(result.body), MIME['.json']);
    }
    if (pathname === '/legacy-game') {
      response.writeHead(308, { Location: '/legacy-game/' + (request.url.includes('?') ? '?' + request.url.split('?').slice(1).join('?') : '') });
      return response.end();
    }
    const route = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
    const resolved = resolveStatic({ routes: manifest.routes, files }, pathname);
    let status = resolved.status;
    if (resolved.text !== null) return send(status, resolved.text);
    const relative = resolved.file;
    const meta=manifest.seo?.metadata?.[route];
    if(options.indexable===true&&status===200&&meta?.indexable)response.setHeader('X-Robots-Tag',meta.robots);
    const rawLegal=pathname.match(/^\/legal\/([a-z-]+)\.html$/);
    if(rawLegal&&manifest.seo?.metadata?.['/'+rawLegal[1]])response.setHeader('Link','<'+manifest.seo.metadata['/'+rawLegal[1]].canonical+'>; rel="canonical"');
    const absolute = path.resolve(directory, relative);
    try {
      if (!absolute.startsWith(directory + path.sep) || fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isFile()) return send(404, 'Not found');
      const bytes = fs.readFileSync(absolute);
      return send(status, bytes, MIME[path.extname(relative)] || 'application/octet-stream');
    } catch { return send(404, 'Not found'); }
  });
}

function parseArguments(args) {
  const options = { port: 4173 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!['--port', '--directory'].includes(arg) || !args[index + 1]) throw new Error('usage: node scripts/p21/serve-web.js [--port 4173] [--directory static-artifact]');
    options[arg.slice(2)] = args[++index];
  }
  options.port = Number(options.port);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('port must be an integer from 1 to 65535');
  return options;
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const server = createPreviewServer(options);
    server.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
    server.listen(options.port, '127.0.0.1', () => process.stdout.write('P21 local preview: http://127.0.0.1:' + options.port + ' (leaderboard read: ' + (process.env.P21_READ_API_ORIGIN ? 'explicitly configured; no credentials' : 'disabled') + ')\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { createPreviewServer, resolveStatic, requestPath, readQuery, publicRows, READ_API_ORIGIN, READ_MAX_BYTES, CSP };
