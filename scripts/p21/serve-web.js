'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { ROOT, GENERATOR, MANIFEST } = require('./build-web.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

function requestPath(raw) {
  if (!raw || !raw.startsWith('/')) throw new Error('invalid path');
  const encoded = raw.split('?')[0];
  const decoded = decodeURIComponent(encoded);
  if (/[\\\x00-\x1f\x7f]/.test(decoded) || decoded.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('unsafe path');
  return decoded;
}

function createPreviewServer(options = {}) {
  const directory = path.resolve(options.directory || path.join(ROOT, '.artifacts/p21-web'));
  if (fs.realpathSync(directory) !== directory) throw new Error('P21_SERVE_REFUSED: root must be unlinked');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), 'utf8'));
  if (manifest.generator !== GENERATOR || !Array.isArray(manifest.files)) throw new Error('P21_SERVE_REFUSED: expected a built P21 static artifact');
  const files = new Set([MANIFEST, ...manifest.files.map(file => file.path)]);
  return http.createServer((request, response) => {
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
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return send(405, 'Method not allowed'); }
    let pathname;
    try { pathname = requestPath(request.url); }
    catch { return send(400, 'Invalid request path'); }
    if (pathname === '/api' || pathname.startsWith('/api/')) return send(503, JSON.stringify({ error: 'WEB_API_NOT_CONFIGURED', message: 'This local preview does not connect to an account or game service.' }), MIME['.json']);
    if (pathname === '/game') {
      response.writeHead(308, { Location: '/game/' + (request.url.includes('?') ? '?' + request.url.split('?').slice(1).join('?') : '') });
      return response.end();
    }
    const route = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
    let relative = route === '/game' ? 'game/index.html' : manifest.routes[route] || pathname.replace(/^\//, '');
    let status = 200;
    if (!files.has(relative)) {
      if (pathname.startsWith('/game/') || pathname.startsWith('/assets/') || pathname.startsWith('/legal/') || path.extname(pathname)) return send(404, 'Not found');
      // The website owns its visual 404. Missing resources never receive HTML.
      relative = 'index.html';
      status = 404;
    }
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
    server.listen(options.port, '127.0.0.1', () => process.stdout.write('P21 local preview: http://127.0.0.1:' + options.port + ' (static presentation; API unconfigured)\n'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { createPreviewServer, requestPath, CSP };
