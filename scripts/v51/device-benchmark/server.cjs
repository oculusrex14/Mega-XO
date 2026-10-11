'use strict';
/**
 * Safe loopback HTTP server for device and browser benchmarks.
 * - Strictly binds to 127.0.0.1 (never 0.0.0.0 or public interfaces).
 * - Ephemeral port 0 by default to prevent conflicts.
 * - Rejects any requests from non-loopback origins.
 * - Strict allowlist: only serves repository assets from approved source directories.
 * - No arbitrary frontend URLs or remote resources.
 * - Receives structured benchmark telemetry via /api/results.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { REPO_ROOT, getCanonicalCorpus, getArtifactIdentity } = require('./common.cjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream'
};

// Strict allowlist of permitted path prefixes relative to REPO_ROOT
const ALLOWED_PATH_PREFIXES = [
  '/src/',
  '/assets/',
  '/native/',
  '/game/',
  '/.artifacts/v51/',
  '/scripts/v51/device-benchmark/'
];

const ALLOWED_EXACT_FILES = [
  '/',
  '/index.html',
  '/harness.html'
];

function isPathAllowed(pathname) {
  if (ALLOWED_EXACT_FILES.includes(pathname)) return true;
  for (const prefix of ALLOWED_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

function createBenchmarkServer(options = {}) {
  let latestResult = null;
  const resultListeners = [];

  const server = http.createServer((req, res) => {
    // Security check: only allow loopback Host headers
    const host = req.headers.host || '';
    if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:') && host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('FORBIDDEN_FOREIGN_HOST');
      return;
    }

    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsed.pathname;

    // POST /api/results: capture test output
    if (req.method === 'POST' && pathname === '/api/results') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 10 * 1024 * 1024) { // 10MB safety cap
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('PAYLOAD_TOO_LARGE');
          req.destroy();
        }
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          // Attach request metadata
          data.serverReceivedAt = new Date().toISOString();
          data.clientHeaders = {
            userAgent: req.headers['user-agent'] || 'unknown',
            accept: req.headers['accept'] || 'unknown'
          };
          latestResult = data;
          for (const listener of resultListeners) listener(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, receivedAt: data.serverReceivedAt }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON: ' + e.message }));
        }
      });
      return;
    }

    // GET /api/corpus: serve canonical unchanged positions
    if (req.method === 'GET' && pathname === '/api/corpus') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        schemaVersion: 1,
        artifact: getArtifactIdentity(),
        corpus: getCanonicalCorpus()
      }));
      return;
    }

    // GET /api/latest-result
    if (req.method === 'GET' && pathname === '/api/latest-result') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(latestResult || { pending: true }));
      return;
    }

    // Static file serving: strict allowlist and same-origin check
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!isPathAllowed(pathname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('FORBIDDEN_FILE_PATH: Path not in approved allowlist');
        return;
      }

      let safePath;
      if (pathname === '/' || pathname === '/harness.html') {
        safePath = path.join(__dirname, 'harness.html');
      } else {
        const decoded = decodeURIComponent(pathname);
        safePath = path.resolve(REPO_ROOT, '.' + decoded);
        if (!safePath.startsWith(REPO_ROOT + path.sep) && safePath !== REPO_ROOT) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('FORBIDDEN_PATH_TRAVERSAL');
          return;
        }
      }

      fs.stat(safePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('NOT_FOUND: ' + pathname);
          return;
        }

        const ext = path.extname(safePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stats.size,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp'
        });

        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = fs.createReadStream(safePath);
        stream.pipe(res);
      });
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('METHOD_NOT_ALLOWED');
  });

  return {
    server,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.listen(port, host, err => {
          if (err) return reject(err);
          const address = server.address();
          resolve({
            port: address.port,
            host: address.address,
            origin: `http://${address.address}:${address.port}`,
            harnessUrl: `http://${address.address}:${address.port}/harness.html`
          });
        });
      });
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    },
    waitForResult(timeoutMs = 60000, validator = null) {
      if (latestResult && (!validator || validator(latestResult))) {
        return Promise.resolve(latestResult);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('BENCHMARK_TIMEOUT: No valid result received within ' + timeoutMs + 'ms'));
        }, timeoutMs);
        const checkResult = res => {
          if (!validator || validator(res)) {
            clearTimeout(timer);
            resolve(res);
          }
        };
        resultListeners.push(checkResult);
      });
    }
  };
}

module.exports = { createBenchmarkServer };
