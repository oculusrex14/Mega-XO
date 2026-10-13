'use strict';
/* scripts/v51/core-edge-proxy.cjs - Core-only public edge for the isolated V5.1 staging stack.
 *
 * WHY THIS EXISTS: the stateless Vercel API must reach the Oracle Game Core over HTTPS, but it
 * cannot join the tailnet, and the staging origin `https://command.tail95c48c.ts.net` is tailnet-only
 * AND serves the website + /api + /auth from the same process. Publishing that origin publicly (e.g.
 * `tailscale funnel` on 443 `/`) would expose the whole staging surface, not just the signed Core
 * ingress.
 *
 * This proxy is a deliberately tiny, loopback-only path filter: it forwards ONLY `/ingress/*` to the
 * existing single Core instance (so matchmaking/realtime continuity is preserved - there is exactly
 * one Core and one Redis queue namespace) and returns a real 404 for every other path. Funnel is then
 * pointed at THIS listener, so the public surface is exactly the signed Core ingress and nothing else.
 *
 * It adds no authority: the Core ingress still enforces its own HMAC service-assertion (signRequest/
 * verifyRequest), timestamp drift, body-size bound and durable operation-outcome idempotency. This
 * layer only decides which paths may traverse. Binds loopback only; no secret is read or logged.
 *
 * Usage: node scripts/v51/core-edge-proxy.cjs [--port 8096] [--upstream-port 8085]
 */
const http = require('node:http');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('--host', '127.0.0.1');
const PORT = Number(arg('--port', '8096'));
const UPSTREAM_HOST = arg('--upstream-host', '127.0.0.1');
const UPSTREAM_PORT = Number(arg('--upstream-port', '8085'));

// The single prefix the signed Core ingress owns. Everything else is refused before it reaches Core.
const ALLOWED_PREFIX = '/ingress/';

// Default is loopback only. A private Docker-bridge bind (e.g. 172.18.0.1, the host side of the
// production `backend` network) is permitted ONLY with the explicit `--allow-private-bind` flag, and
// a wildcard bind is never allowed. This keeps the filter reachable by the co-located Caddy edge
// container and nothing else: never the public interface, never other Docker networks.
const ALLOW_PRIVATE = process.argv.includes('--allow-private-bind');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PRIVATE_BIND = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/;
if (HOST === '0.0.0.0' || HOST === '::') throw new Error('CORE_EDGE_REFUSED_WILDCARD_BIND');
if (!LOOPBACK_HOSTS.has(HOST) && !(ALLOW_PRIVATE && PRIVATE_BIND.test(HOST))) {
  throw new Error('CORE_EDGE_REFUSED_NON_LOOPBACK_BIND');
}

function refuse(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'CORE_EDGE_PATH_FORBIDDEN' }));
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const pathname = url.split('?')[0];
  if (!pathname.startsWith(ALLOWED_PREFIX)) {
    req.resume(); // drain so the socket can be reused/closed cleanly
    refuse(res);
    return;
  }
  const proxyReq = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: url,
    headers: {
      ...req.headers,
      host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      'x-forwarded-proto': 'https',
      'x-forwarded-for': req.socket.remoteAddress || '',
    },
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ error: 'CORE_EDGE_UPSTREAM_UNAVAILABLE' }));
  });
  req.pipe(proxyReq);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`core-edge-proxy ${HOST}:${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} allow=${ALLOWED_PREFIX}`);
});
