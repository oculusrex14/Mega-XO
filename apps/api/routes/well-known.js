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
const { sendJson, requestIsSecure } = require('./helpers');

// Root public assets directory (repo_root/public)
const PUBLIC_DIR = path.resolve(__dirname, '../../../public');

/* Android App Links default configuration.
 *
 * The package name is the owner-requested permanent id `online.megaxo.xoxo`, matching the signed
 * release AAB (sha256 8c53c5e440aba75f0d5de41e9bc5e2c70d365581da7c0517853274d36b0604b8) and the
 * iOS bundle id. The FINGERPRINT is still a clearly-labelled PLACEHOLDER: the real certificate is
 * the owner-held upload key's, and Play App Signing's app-signing certificate is not known until
 * the app is uploaded, so a statement with a wrong fingerprint would associate nothing. That stays
 * the honest state until the owner supplies it. A statement with a wrong fingerprint associates nothing, which is the honest
 * state until the owner supplies the real package id + upload-certificate fingerprint
 * (owner action: P5 identifier resolution, docs/v5.1/release/NATIVE-AND-PROVIDER-STATE-20261013.md).
 * Callers may replace this whole list through `context.assetlinks`/`context.assetLinks`. */
/* The owner-held Android UPLOAD certificate's SHA-256. This is the certificate the artifacts built
 * on this machine are actually signed with, so App Links associate for a sideloaded or pre-Play
 * build. Play App Signing re-signs the distributed APK with Google's app-signing certificate; once
 * the first AAB is uploaded, that certificate's fingerprint must be ADDED here (both may be listed)
 * or App Links will not associate for store-installed builds. This is a real fingerprint, not a
 * placeholder: it belongs to the key archived at
 * ~/Downloads/Mega-XO-private-evidence/android-release/mega-xo-upload.jks. */
const ASSOCIATION_UPLOAD_CERT_FINGERPRINT =
  '96:1C:C0:54:74:57:0E:60:58:4A:14:14:2B:B0:E3:D6:45:80:4B:CB:4C:16:88:62:A6:94:5E:41:75:32:93:37';

/* The website ships the store-bound release build under `online.megaxo.game` (release contract
 * MEGA_ANDROID_APPLICATION_ID), signed with the same owner-held upload key, while the default
 * Gradle id is `online.megaxo.xoxo`. Both statements must be served or App Links silently fail
 * to associate for whichever build is missing (audit MXA-REL-001, 2026-10-17).
 */
const RELEASE_APPLICATION_ID = 'online.megaxo.game';

const DEFAULT_ASSET_LINKS = Object.freeze([
  Object.freeze({
    relation: Object.freeze(['delegate_permission/common.handle_all_urls']),
    target: Object.freeze({
      namespace: 'android_app',
      package_name: 'online.megaxo.xoxo',
      sha256_cert_fingerprints: Object.freeze([ASSOCIATION_UPLOAD_CERT_FINGERPRINT])
    })
  })
  ,Object.freeze({
    relation: Object.freeze(['delegate_permission/common.handle_all_urls']),
    target: Object.freeze({
      namespace: 'android_app',
      package_name: RELEASE_APPLICATION_ID,
      sha256_cert_fingerprints: Object.freeze([ASSOCIATION_UPLOAD_CERT_FINGERPRINT])
    })
  })
]);

/* D1 (2026-10-20): the RFC 9116 security.txt disclosure, served as plain text at the canonical
 * path. Contact is the parent-company address permitted in product copy (AGENTS.md, 15 Oct);
 * Expires is the mandatory refresh reminder, renewed on each review. */
const SECURITY_TXT = Object.freeze([
  'Contact: mailto:contact@antimatterinnovations.com',
  'Expires: 2027-12-31T00:00:00.000Z',
  'Preferred-Languages: en',
  'Canonical: https://megaxo.online/.well-known/security.txt',
  'Policy: https://megaxo.online/privacy',
].join('\n') + '\n');

/* iOS Universal Links default configuration.
 *
 * `appIDs` uses the BUILT iOS bundle id (PRODUCT_BUNDLE_IDENTIFIER in
 * native/ios/MegaXO.xcodeproj/project.pbxproj, both configurations) with the literal `TEAMID`
 * placeholder standing in for the owner's Apple Team ID. An association with a placeholder team
 * prefix matches no signed app, which is the honest state until the owner provides the Team ID
 * and enables the associated-domains capability (owner action: Apple membership + App ID). */
const ASSOCIATION_PLACEHOLDER_TEAM = 'TEAMID';
const BUILT_IOS_BUNDLE_ID = 'online.megaxo.xoxo';

/* LR08 (2026-10-16): the owner's Apple Team ID is now known and configured server-side (Apple
 * sign-in works live, which requires APPLE_TEAM_ID), so the placeholder no longer has to be the
 * honest state. When a syntactically valid 10-character Team ID is provided the association is
 * served with the REAL prefix; anything else (missing, malformed) fail-closes to the placeholder
 * rather than guessing. */
function appleTeamPrefixFor(teamId) {
  return typeof teamId === 'string' && /^[A-Z0-9]{10}$/.test(teamId) ? teamId : ASSOCIATION_PLACEHOLDER_TEAM;
}

/* MXA-REL-002 (2026-10-17): the association may need MULTIPLE team prefixes - the
 * device-development team AND the store team (the store build is signed under the current
 * membership, the review device under the legacy one). APPLE_TEAM_ID accepts a comma- or
 * space-separated list; every valid 10-character entry becomes an appID, duplicates collapse,
 * and an empty or fully-invalid list fail-closes to the placeholder. Single-team values behave
 * exactly as before. */
function appleTeamPrefixesFor(teamId) {
  const raw = typeof teamId === 'string' ? teamId : '';
  const valid = raw.split(/[,\s]+/).map((s) => s.trim()).filter((p) => /^[A-Z0-9]{10}$/.test(p));
  if (valid.length === 0) return [ASSOCIATION_PLACEHOLDER_TEAM];
  return [...new Set(valid)];
}

function appleAssociationForTeam(teamId) {
  const appIDs = appleTeamPrefixesFor(teamId).map((prefix) => `${prefix}.${BUILT_IOS_BUNDLE_ID}`);
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs,
          components: DEFAULT_APPLE_ASSOCIATION.applinks.details[0].components,
        }
      ]
    },
    webcredentials: {
      apps: appIDs
    }
  };
}

const DEFAULT_APPLE_ASSOCIATION = Object.freeze({
  applinks: {
    apps: [],
    details: [
      {
        appIDs: [`${ASSOCIATION_PLACEHOLDER_TEAM}.${BUILT_IOS_BUNDLE_ID}`],
        components: [
          { '/': '/auth/*' },
          { '/': '/community/*' },
          { '/': '/legal/*' }
        ]
      }
    ]
  },
  webcredentials: {
    apps: [`${ASSOCIATION_PLACEHOLDER_TEAM}.${BUILT_IOS_BUNDLE_ID}`]
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
  const data = context.appleAssociation || context.appleAppSiteAssociation || appleAssociationForTeam(context.appleTeamId);
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
/* Sleep-compatible health (infrastructure brief 2026-10-19, part E). /livez is PROCESS liveness
 * only and never touches the database. /health and /readyz report dependency readiness from a
 * timestamped, single-flight, TTL-cached probe. A composition may gate healthy re-probes on
 * writes/pulses, so external monitors alone cannot keep a scale-to-zero database awake. Failed
 * probes still retry after ten seconds. The response retains an honest db state + age. */
const HEALTH_PROBE_TTL_MS = 60000;
const HEALTH_RETRY_MS = 10000;
const healthProbe = { lastOk: null, at: 0, inFlight: null };
function probeDbHealth(context) {
  if (healthProbe.inFlight) return healthProbe.inFlight;
  const pool = context.pool && typeof context.pool.query === 'function' ? context.pool : null;
  if (!pool) return Promise.resolve(null);
  // Boot, failed-probe retries and composition pulses also consume the journal/pulse baseline.
  try { if (typeof context.dbProbeGate === 'function') context.dbProbeGate(); } catch {}
  healthProbe.inFlight = Promise.resolve().then(async () => {
    try {
      await pool.query('SELECT 1');
      healthProbe.lastOk = true;
    } catch {
      healthProbe.lastOk = false;
    } finally {
      healthProbe.at = (context.now && typeof context.now === 'function' ? context.now() : Date.now());
      healthProbe.inFlight = null;
    }
  });
  return healthProbe.inFlight;
}
async function getHealth(context, req, res) {
  const nowMs = (context.now && typeof context.now === 'function') ? context.now() : Date.now();
  const wantsDb = req.url && String(req.url).startsWith('/livez') ? false : true;
  let dbOk = true;
  let db = null;
  if (wantsDb && context.pool && typeof context.pool.query === 'function') {
    const age = nowMs - healthProbe.at;
    let shouldProbe = healthProbe.at === 0 || (healthProbe.lastOk === false && age >= HEALTH_RETRY_MS);
    if (!shouldProbe && !healthProbe.inFlight && healthProbe.lastOk !== false && age >= HEALTH_PROBE_TTL_MS) {
      // No gate preserves the existing sixty-second policy. A broken optional gate fails open
      // to a real probe rather than hiding dependency failure behind a stale healthy cache.
      try { shouldProbe = typeof context.dbProbeGate !== 'function' || context.dbProbeGate() === true; }
      catch { shouldProbe = true; }
    }
    if (shouldProbe || healthProbe.inFlight) await probeDbHealth(context);
    dbOk = healthProbe.lastOk === true;
    db = { state: dbOk ? 'verified' : 'unavailable', checkedAt: healthProbe.at, ageMs: Math.max(0, nowMs - healthProbe.at), ttlMs: HEALTH_PROBE_TTL_MS };
  } else if (wantsDb) {
    db = { state: 'not_configured' };
  } else {
    db = { state: 'not_probed', reason: 'liveness-does-not-touch-the-database' };
  }
  const status = dbOk ? 'ok' : 'degraded';
  const statusCode = dbOk ? 200 : 503;
  return sendJson(res, statusCode, {
    status,
    live: true,
    ready: dbOk,
    time: (context.now && typeof context.now === 'function') ? context.now() : Date.now(),
    db,
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

  // 3. A well-formed callback is NOT a successful sign-in. The real exchange consumes a one-use,
  //    state/nonce-bound attempt, trades the provider code over TLS, verifies the identity and rotates
  //    the session. That requires a composed provider client, and this deployment entry composes one
  //    only when the account service exposes the web lane; without it, reporting `linked: true` would be
  //    a false success that the client would believe. Fail closed instead, with a distinct reason the
  //    client can surface honestly.
  if (typeof context?.completeWebSignIn !== 'function') {
    const errorReason = 'PROVIDER_SIGNIN_UNAVAILABLE';
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

  // 3b. A composed web lane exists: perform the real exchange and only then report success.
  let outcome;
  try {
    outcome = await context.completeWebSignIn({ provider, state, code, cookie: req.headers?.cookie || null, secure: requestIsSecure(req) });
  } catch (error) {
    outcome = { ok: false, reason: (error && error.code) || 'SIGNIN_FAILED' };
  }
  if (!outcome || outcome.ok !== true) {
    const errorReason = (outcome && outcome.reason) || 'SIGNIN_FAILED';
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
  const headers = {
    Location: '/?account=linked',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
  if (typeof outcome.setCookie === 'string' && outcome.setCookie) headers['Set-Cookie'] = outcome.setCookie;
  res.writeHead(303, headers);
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

  if (pathname === '/.well-known/security.txt' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=604800' });
    res.end(SECURITY_TXT);
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
  probeDbHealth,
  sendLegalHtml,
  sendPublicAsset,
  handleAuthCallback,
  handleWellKnownRoute,
  DEFAULT_ASSET_LINKS,
  DEFAULT_APPLE_ASSOCIATION,
  appleAssociationForTeam,
  appleTeamPrefixFor,
  LEGAL_PAGES,
};
