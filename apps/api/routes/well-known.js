'use strict';

/**
 * apps/api/routes/well-known.js
 * Phase 11 Task V5-11-05: Website and domain technical foundations.
 *
 * Requirements:
 * - GET /.well-known/assetlinks.json: Android App Links association file (200 application/json).
 * - GET /.well-known/apple-app-site-association: iOS Universal Links association file (200 application/json).
 * - GET /health, /livez, /readyz: edge health and readiness checks (200 application/json).
 * - GET /privacy, /terms, /support, /privacy-choices, /delete-account:
 *   Serves static legal technical HTML from public/ (200 text/html).
 * - GET /legal.css, /public/*: static stylesheet and public assets.
 * - GET /auth/callback/:provider: OAuth callback parameter contract enforcement
 *   (redirects 303 or 400 on error / missing code or state).
 * - Zero new UI invariant: apps/api contains strictly zero frontend views or gameplay UI.
 */

const fs = require('node:fs');
const path = require('node:path');
const { sendJson } = require('./helpers');

// Root public assets directory (repo_root/public)
const PUBLIC_DIR = path.resolve(__dirname, '../../../public');

// Android App Links default configuration
const DEFAULT_ASSET_LINKS = Object.freeze([
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.antimatterinnovations.megaxo',
      sha256_cert_fingerprints: [
        '14:6D:E9:D6:0F:7B:D1:72:3B:86:70:E8:6B:0A:86:B1:24:F2:88:18:C4:0D:02:D0:6A:40:06:50:57:3E:CA:3F'
      ]
    }
  }
]);

// iOS Universal Links default configuration
const DEFAULT_APPLE_ASSOCIATION = Object.freeze({
  applinks: {
    apps: [],
    details: [
      {
        appIDs: ['TEAMID.com.antimatterinnovations.megaxo'],
        components: [
          { '/': '/auth/*' },
          { '/': '/community/*' },
          { '/': '/legal/*' }
        ]
      }
    ]
  },
  webcredentials: {
    apps: ['TEAMID.com.antimatterinnovations.megaxo']
  }
});

// Mapping of route paths to static HTML filenames in public/
const LEGAL_PAGES = Object.freeze({
  '/privacy': 'privacy.html',
  '/privacy.html': 'privacy.html',
  '/terms': 'terms.html',
  '/terms.html': 'terms.html',
  '/support': 'support.html',
  '/support.html': 'support.html',
  '/privacy-choices': 'privacy-choices.html',
  '/privacy-choices.html': 'privacy-choices.html',
  '/delete-account': 'delete-account.html',
  '/delete-account.html': 'delete-account.html',
});

// Cache for loaded static files in memory
const fileCache = new Map();

function readStaticFile(filename) {
  if (fileCache.has(filename)) {
    return fileCache.get(filename);
  }
  const filePath = path.join(PUBLIC_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      fileCache.set(filename, content);
      return content;
    }
  } catch {}
  return null;
}

/**
 * GET /.well-known/assetlinks.json
 * Returns Android Digital Asset Links statement list.
 */
function getAssetLinks(context, req, res) {
  const data = context.assetlinks || context.assetLinks || DEFAULT_ASSET_LINKS;
  const body = JSON.stringify(data, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

/**
 * GET /.well-known/apple-app-site-association
 * Returns iOS Universal Links association specification.
 */
function getAppleAppSiteAssociation(context, req, res) {
  const data = context.appleAssociation || context.appleAppSiteAssociation || DEFAULT_APPLE_ASSOCIATION;
  const body = JSON.stringify(data, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

/**
 * GET /health, /livez, /readyz
 * Edge health and readiness check.
 */
async function getHealth(context, req, res) {
  let dbOk = true;
  if (context.pool && typeof context.pool.query === 'function') {
    try {
      await context.pool.query('SELECT 1');
    } catch {
      dbOk = false;
    }
  }
  const status = dbOk ? 'ok' : 'degraded';
  const statusCode = dbOk ? 200 : 503;
  return sendJson(res, statusCode, {
    status,
    live: true,
    ready: dbOk,
    time: (context.now && typeof context.now === 'function') ? context.now() : Date.now(),
  });
}

/**
 * Serves a static legal HTML resource from public/.
 */
function sendLegalHtml(res, filename) {
  const content = readStaticFile(filename);
  if (!content) {
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'Content-Length': Buffer.byteLength(content, 'utf8'),
  });
  res.end(content);
}

/**
 * Serves static stylesheet or other public asset.
 */
function sendPublicAsset(res, relPath) {
  const safePath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
  const content = readStaticFile(safePath);
  if (!content) {
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }
  const ext = path.extname(safePath).toLowerCase();
  const contentType = ext === '.css'
    ? 'text/css; charset=utf-8'
    : ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.json'
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
    'Content-Length': Buffer.byteLength(content, 'utf8'),
  });
  res.end(content);
}

/**
 * GET /auth/callback/:provider
 * Enforces OAuth callback parameter contracts for Google and Apple.
 * Redirects 303 (matching route contract note) or returns error JSON.
 */
async function handleAuthCallback(context, req, res, provider, url) {
  const supported = new Set(['google', 'apple']);
  if (!supported.has(provider)) {
    return sendJson(res, 400, { error: 'INVALID_PROVIDER' });
  }

  const q = url.searchParams;

  // 1. Check for provider-reported error in query params
  if (q.has('error')) {
    const errorReason = q.get('error') || 'SIGNIN_CANCELLED';
    const location = `/?authError=${encodeURIComponent(errorReason)}`;
    res.writeHead(303, {
      Location: location,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(JSON.stringify({ error: errorReason, location }));
    return true;
  }

  // 2. Validate required code and state parameters
  const state = q.get('state');
  const code = q.get('code');
  if (!state || !code) {
    const errorReason = 'INVALID_CALLBACK_PARAMS';
    const location = `/?authError=${encodeURIComponent(errorReason)}`;
    res.writeHead(303, {
      Location: location,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(JSON.stringify({ error: errorReason, location }));
    return true;
  }

  // 3. Valid parameters: in full OAuth exchange this consumes attempt and sets session cookie.
  // In the foundation contract, acknowledge successful parameter validation and redirect.
  res.writeHead(303, {
    Location: '/?account=linked',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify({ ok: true, linked: true, provider, location: '/?account=linked' }));
  return true;
}

/**
 * Main dispatcher for well-known, technical, legal, and callback routes.
 * @param {Object} context Application context
 * @param {Object} req Incoming request
 * @param {Object} res Server response
 * @returns {Promise<boolean>} True if handled, false otherwise
 */
async function handleWellKnownRoute(context, req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  const method = req.method;

  // 1. Association files
  if (pathname === '/.well-known/assetlinks.json' && method === 'GET') {
    getAssetLinks(context, req, res);
    return true;
  }

  if (pathname === '/.well-known/apple-app-site-association' && method === 'GET') {
    getAppleAppSiteAssociation(context, req, res);
    return true;
  }

  // 2. Health and readiness endpoints
  if ((pathname === '/health' || pathname === '/livez' || pathname === '/readyz') && method === 'GET') {
    await getHealth(context, req, res);
    return true;
  }

  // 3. Static legal HTML pages
  if (LEGAL_PAGES[pathname] && method === 'GET') {
    sendLegalHtml(res, LEGAL_PAGES[pathname]);
    return true;
  }

  // 4. Static legal assets (legal.css, /public/*)
  if ((pathname === '/legal.css' || pathname === '/public/legal.css') && method === 'GET') {
    sendPublicAsset(res, 'legal.css');
    return true;
  }
  if (pathname.startsWith('/public/') && method === 'GET') {
    const rel = pathname.slice('/public/'.length);
    sendPublicAsset(res, rel);
    return true;
  }

  // 5. Auth callback contract endpoints
  if (pathname.startsWith('/auth/callback/') && method === 'GET') {
    const provider = pathname.slice('/auth/callback/'.length);
    await handleAuthCallback(context, req, res, provider, url);
    return true;
  }

  return false;
}

module.exports = {
  getAssetLinks,
  getAppleAppSiteAssociation,
  getHealth,
  sendLegalHtml,
  sendPublicAsset,
  handleAuthCallback,
  handleWellKnownRoute,
  DEFAULT_ASSET_LINKS,
  DEFAULT_APPLE_ASSOCIATION,
  LEGAL_PAGES,
};
